/* https://vuejs.org/v2/guide/state-management.html#Simple-State-Management-from-Scratch */
// Vuex is overkill for out needs. Use a very simple global object store for
//  very basic state management.
import eventBus from '@/eventBus.js';
import {get, set} from 'idb-keyval';
import {FavouriteItem} from '@/js/schema';
import {estimateCostUsd, DEFAULT_MODEL as DEFAULT_AI_MODEL} from './aiSummary.js';
import { GoogleAuthProvider, signInWithPopup, browserPopupRedirectResolver, signOut as firebaseSignOut } from 'firebase/auth';
import { subscribe as syncSubscribe, pushFavourites } from './sync.js';
import {
    logEvent
} from 'firebase/analytics';

// TODO load from local storage or similar
const USER_SETTING_DEFAULTS = {
    advancedMode: false,
    preferFileUpload: false,
    showAbcText: false,
    microphoneChoice: null,
    recordingTimeLimitSecs: 10,
    useMlTranscriber: false, // opt-in experimental basic-pitch ML transcription
    autoGainControl: false, // let the OS auto-boost quiet mic input at capture
    autoUpdateTuneData: true, // check for a newer tune index on startup
    aiSummariesEnabled: false, // show the (i) tune-background button; needs an API key
    aiSummaryModel: DEFAULT_AI_MODEL, // which Claude model writes the background note
};

// The Anthropic API key lives under its own localStorage key, NOT in
// userSettings. exportUserData() serialises userSettings wholesale into a
// downloadable backup that users share; a key placed there would leak into that
// file. Kept out of both export and import for the same reason.
const API_KEY_STORAGE_KEY = 'anthropicApiKey';

// Running total of what the AI summary feature has cost, so the number in
// Settings is measured rather than guessed. localStorage, not IndexedDB: it is
// tiny, non-critical, and read synchronously when the panel renders.
const AI_USAGE_STORAGE_KEY = 'aiSummaryUsage';

// When this device last cleared its saved notes, so a stale inbound snapshot
// cannot resurrect them. Local-only and never synced — see
// _getAiSummariesClearedAt for why the synced tombstone is not enough.
const AI_CLEARED_AT_STORAGE_KEY = 'aiSummariesClearedAt';

// One record per tuneID: { text, model, generatedAt, sourceUrl }. Kept in its
// own IndexedDB key rather than only on favourites so that summaries survive
// un-favouriting and are available for tunes the user never starred.
const KEY_AI_SUMMARIES = 'aiTuneSummaries';

// Favourites are pushed to Firestore as one document containing the whole
// array, so summary text mirrored onto them is the field most able to bloat it.
const AI_SUMMARY_MAX_CHARS = 1200;

class Store {
    constructor() {
        this.state = {
            // Single source of truth for tune-index availability, mirrored from
            // the worker's state machine by backend._onIndexStatus:
            //   'loading' | 'downloading' | 'ready' | 'unavailable'
            // It always reaches a terminal state, so no view ever has to guess
            // with a timeout.
            indexStatus: 'loading',
            indexStatusDetail: {},
            // { received, total } while downloading, else null.
            indexDownloadProgress: null,
            // Convenience mirrors of indexStatus, kept for existing views.
            indexLoaded: false,
            tuneIndexError: false,
            lastResults: [],
            lastContour: '',
            lastTimer: null,
            backendVersion: 'not loaded',
            tuneIndexVersion: null,
            tuneIndexDate: null,
            sessionAnalysis: null,
            // Raw PCM of the most recent manual recording, retained so the
            // Results view can export it as a WAV test clip. Cleared lazily.
            lastRecordedPcm: null,
            lastRecordedSampleRate: null,
        };

        this.searchStates = {
            READY: 'ready',
            RECORDING: 'recording',
            WORKING: 'working',
            LISTENING: 'listening',
        };

        // Spread over the defaults rather than `stored || DEFAULTS`. With the
        // old `||`, any user who had ever saved settings read every
        // newly-added key as undefined, because their stored blob simply did
        // not contain it — which is why so many call sites coalesce with
        // `|| false`. Merging means a new default actually reaches existing
        // installs.
        this.userSettings = {
            ...USER_SETTING_DEFAULTS,
            ...(JSON.parse(localStorage.getItem('userSettings')) || {}),
        };
        this.searchState = this.searchStates.READY;

        this._favouriteIDs = null;
        this._favouriteTuneIDs = null;
        this._settingTagsCache = null;  // Map<settingID string, string[]>
        this._tuneTagsCache = null;     // Map<tuneID string, string[]> — union across all settings
        this._favouriteTempoCache = null; // Map<settingID string, number|null>
        this._aiSummariesCache = null;    // object, tuneID string -> summary record
        this.analytics = null;
        this.analyticsLoaded = new Promise(resolve => {
            this.setAnalyticsLoaded = resolve;
        });
        this.currentUser = null;
        this.auth = null;
        this._unsubscribeSync = null;
    }

    async _dbSet(key, value) {
        try {
            await set(key, value);
        } catch (e) {
            console.error(`IndexedDB write error (${key})`, e);
        }
    }

    async updateUserSettings(userSettings) {
        // Fill in any key the incoming object lacks. This matters on the import
        // path: a backup written by an older version has no entry for a setting
        // added since, and without this every consumer would read undefined.
        // Mutated in place rather than merged into a copy, because several views
        // hold a reference to this object and rely on it staying the same one.
        for (const [key, value] of Object.entries(USER_SETTING_DEFAULTS)) {
            if (userSettings[key] === undefined) userSettings[key] = value;
        }

        // Usable immediately and synchronously by the entire application.
        this.userSettings = userSettings;

        // Save for later so that when we reload the settings page / restart
        //  app, the settings are maintained.
        localStorage.setItem('userSettings', JSON.stringify(userSettings));
    }

    async getHistoryItems() {
        try {
            return await get('historyItems') || [];
        } catch (e) {
            console.error('IndexedDB read error (historyItems)', e);
            return [];
        }
    }

    async getFavourites() {
        let items;
        try {
            items = await get('favouriteItems') || [];
        } catch (e) {
            console.error('IndexedDB read error (favouriteItems)', e);
            return [];
        }
        // Migrate items that still use the old folderId model → convert folder name to tag
        const needsMigration = items.some(item => item.folderId !== undefined);
        if (needsMigration) {
            const folders = await get('favouriteFolders') || [];
            const folderNameById = new Map(folders.map(f => [f.id, f.name]));
            items = items.map(item => {
                if (item.folderId !== undefined) {
                    const tag = item.folderId ? folderNameById.get(item.folderId) : null;
                    const tags = tag ? [tag] : [];
                    const { folderId: _removed, ...rest } = item;
                    return { ...rest, tags };
                }
                return item;
            });
            await this._dbSet('favouriteItems', items);
            await this._dbSet('favouriteFolders', []);
            if (this.currentUser) pushFavourites(this.currentUser.uid, items);
        }
        return items;
    }

    async addTagToFavourite(settingID, tag) {
        settingID = String(settingID);
        tag = tag.trim();
        if (!tag) return;
        this._invalidateFavouriteCache();
        const items = await this.getFavourites();
        const item = items.find(f => String(f.result.settingID) === settingID);
        if (item) {
            if (!item.tags) item.tags = [];
            if (!item.tags.includes(tag)) item.tags.push(tag);
            await this._dbSet('favouriteItems', items);
            if (this.currentUser) pushFavourites(this.currentUser.uid, items);
        }
    }

    async getAllTags() {
        await this._loadFavouriteIDs();
        const all = new Set();
        for (const tags of this._settingTagsCache.values()) tags.forEach(t => all.add(t));
        return [...all].sort();
    }

    async removeTagFromFavourite(settingID, tag) {
        settingID = String(settingID);
        this._invalidateFavouriteCache();
        const items = await this.getFavourites();
        const item = items.find(f => String(f.result.settingID) === settingID);
        if (item && item.tags) {
            item.tags = item.tags.filter(t => t !== tag);
            await this._dbSet('favouriteItems', items);
            if (this.currentUser) pushFavourites(this.currentUser.uid, items);
        }
    }

    async renameTag(oldName, newName) {
        newName = newName.trim();
        if (!newName || oldName === newName) return;
        this._invalidateFavouriteCache();
        const items = await this.getFavourites();
        items.forEach(item => {
            if (item.tags && item.tags.includes(oldName)) {
                item.tags = item.tags.map(t => (t === oldName ? newName : t));
            }
        });
        await this._dbSet('favouriteItems', items);
        if (this.currentUser) pushFavourites(this.currentUser.uid, items);
    }

    async deleteTag(name) {
        this._invalidateFavouriteCache();
        const items = await this.getFavourites();
        items.forEach(item => {
            if (item.tags) item.tags = item.tags.filter(t => t !== name);
        });
        await this._dbSet('favouriteItems', items);
        if (this.currentUser) pushFavourites(this.currentUser.uid, items);
    }

    _isValidSettingID(settingID) {
        const s = String(settingID);
        return settingID != null && s !== 'undefined' && s !== 'null' && s !== '';
    }

    async _loadFavouriteIDs() {
        if (this._favouriteIDs === null) {
            let items = await this.getFavourites();
            // Clean up any items with invalid settingIDs (stored from a previous bug)
            const clean = items.filter(f => this._isValidSettingID(f.result.settingID));
            if (clean.length !== items.length) {
                await this._dbSet('favouriteItems', clean);
                items = clean;
            }
            this._favouriteIDs = new Set(items.map(f => String(f.result.settingID)));
            this._favouriteTuneIDs = new Set(
                items.filter(f => f.result.setting && f.result.setting.tune_id)
                     .map(f => String(f.result.setting.tune_id))
            );
            this._settingTagsCache = new Map(items.map(f => [String(f.result.settingID), f.tags || []]));
            this._favouriteTempoCache = new Map(items.map(f => [String(f.result.settingID), f.tempo ?? null]));
            this._tuneTagsCache = new Map();
            items.forEach(f => {
                if (f.result.setting && f.result.setting.tune_id) {
                    const tid = String(f.result.setting.tune_id);
                    const existing = this._tuneTagsCache.get(tid) || [];
                    (f.tags || []).forEach(t => { if (!existing.includes(t)) existing.push(t); });
                    this._tuneTagsCache.set(tid, existing);
                }
            });
        }
        return this._favouriteIDs;
    }

    async _loadFavouriteTuneIDs() {
        await this._loadFavouriteIDs(); // ensures _favouriteTuneIDs is also populated
        return this._favouriteTuneIDs;
    }

    _invalidateFavouriteCache() {
        this._favouriteIDs = null;
        this._favouriteTuneIDs = null;
        this._settingTagsCache = null;
        this._tuneTagsCache = null;
        this._favouriteTempoCache = null;
    }

    async addFavourite(result) {
        if (!this._isValidSettingID(result.settingID)) {
            console.warn('addFavourite: invalid settingID, ignoring', result.settingID);
            return;
        }
        result = { ...result, settingID: String(result.settingID) };
        const ids = await this._loadFavouriteIDs();
        if (!ids.has(result.settingID)) {
            const items = await this.getFavourites();
            items.unshift(new FavouriteItem(result));
            await this._dbSet('favouriteItems', items);
            ids.add(result.settingID);
            if (this._favouriteTuneIDs && result.setting && result.setting.tune_id) {
                this._favouriteTuneIDs.add(String(result.setting.tune_id));
            }
            if (this.currentUser) pushFavourites(this.currentUser.uid, items);
        }
    }

    async removeFavourite(settingID) {
        settingID = String(settingID);
        const items = (await this.getFavourites()).filter(f => String(f.result.settingID) !== settingID);
        await this._dbSet('favouriteItems', items);
        // Invalidate both caches — tune may still be favourited via another setting
        this._invalidateFavouriteCache();
        if (this.currentUser) pushFavourites(this.currentUser.uid, items);
    }

    async isFavourite(settingID) {
        if (!this._isValidSettingID(settingID)) return false;
        const ids = await this._loadFavouriteIDs();
        return ids.has(String(settingID));
    }

    async isTuneFavourite(tuneID) {
        if (!tuneID) return false;
        const ids = await this._loadFavouriteTuneIDs();
        return ids.has(String(tuneID));
    }

    async getTagsForSetting(settingID) {
        if (!this._isValidSettingID(settingID)) return [];
        if (this._settingTagsCache === null) await this._loadFavouriteIDs();
        return this._settingTagsCache.get(String(settingID)) || [];
    }

    async getTagsForTune(tuneID) {
        if (!tuneID) return [];
        if (this._tuneTagsCache === null) await this._loadFavouriteIDs();
        return this._tuneTagsCache.get(String(tuneID)) || [];
    }

    async getFavouriteTempo(settingID) {
        if (!this._isValidSettingID(settingID)) return null;
        if (this._favouriteTempoCache === null) await this._loadFavouriteIDs();
        return this._favouriteTempoCache.get(String(settingID)) ?? null;
    }

    async setFavouriteTempo(settingID, tempoPercent) {
        settingID = String(settingID);
        const items = await this.getFavourites();
        const item = items.find(f => String(f.result.settingID) === settingID);
        if (!item) return; // not a favourite — nothing to save
        item.tempo = tempoPercent;
        if (this._favouriteTempoCache) this._favouriteTempoCache.set(settingID, tempoPercent);
        await this._dbSet('favouriteItems', items);
        if (this.currentUser) pushFavourites(this.currentUser.uid, items);
    }

    // ---- Anthropic API key -------------------------------------------------
    // Deliberately not part of userSettings; see API_KEY_STORAGE_KEY above.

    getApiKey() {
        try {
            return localStorage.getItem(API_KEY_STORAGE_KEY) || '';
        } catch (e) {
            return '';
        }
    }

    hasApiKey() {
        return this.getApiKey().length > 0;
    }

    setApiKey(key) {
        const trimmed = (key || '').trim();
        if (!trimmed) {
            this.clearApiKey();
            return;
        }
        localStorage.setItem(API_KEY_STORAGE_KEY, trimmed);
    }

    clearApiKey() {
        localStorage.removeItem(API_KEY_STORAGE_KEY);
    }

    // ---- AI summary spend tracking -----------------------------------------

    getAiUsage() {
        let stored = null;
        try {
            stored = JSON.parse(localStorage.getItem(AI_USAGE_STORAGE_KEY));
        } catch (e) {
            stored = null;
        }
        return {
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            ...(stored && typeof stored === 'object' ? stored : {}),
        };
    }

    // Called once per successful generation. The cost is an estimate at list
    // prices — see estimateCostUsd — but a measured token count beats an
    // unknowable one.
    recordAiUsage(usage, model) {
        const total = this.getAiUsage();
        total.calls += 1;
        total.inputTokens += Number(usage && usage.input_tokens) || 0;
        total.outputTokens += Number(usage && usage.output_tokens) || 0;
        total.costUsd += estimateCostUsd(usage, model);
        localStorage.setItem(AI_USAGE_STORAGE_KEY, JSON.stringify(total));
        return total;
    }

    resetAiUsage() {
        localStorage.removeItem(AI_USAGE_STORAGE_KEY);
    }

    // ---- AI summary cache --------------------------------------------------

    // When this device last cleared its notes. Deliberately **not** synced: it
    // is this device's own defence against being told to un-delete, and it is
    // read on every inbound snapshot.
    //
    // The synced `FavouriteItem.aiSummaryDeletedAt` tombstone tells *other*
    // devices about the deletion, but it cannot protect this one. Favourites
    // sync is whole-document last-writer-wins, arbitrated by a document-level
    // `Date.now()`: a device that has not yet processed the clear can touch an
    // unrelated favourite and push its whole array, still carrying the note and
    // no tombstone, and that write is legitimately newer at the document level.
    // Reconciliation only ever sees the incoming array, so the tombstone this
    // device wrote is simply not in the conversation. The watermark is.
    //
    // A single timestamp rather than a per-tune tombstone map, because "Clear
    // saved notes" is inherently clear-*all* — and because per-tune markers
    // cannot cover the case where the other device holds a note this one never
    // had: there would be no local tombstone to consult for that tune, and the
    // stale write carries none either.
    _getAiSummariesClearedAt() {
        return Number(localStorage.getItem(AI_CLEARED_AT_STORAGE_KEY) || 0) || 0;
    }

    async _loadAiSummaries() {
        if (this._aiSummariesCache === null) {
            let stored;
            try {
                stored = await get(KEY_AI_SUMMARIES);
            } catch (e) {
                console.error(`IndexedDB read error (${KEY_AI_SUMMARIES})`, e);
                stored = null;
            }
            this._aiSummariesCache = (stored && typeof stored === 'object') ? stored : {};
        }
        return this._aiSummariesCache;
    }

    async getAiSummary(tuneID) {
        if (!tuneID) return null;
        const summaries = await this._loadAiSummaries();
        return summaries[String(tuneID)] || null;
    }

    async countAiSummaries() {
        const summaries = await this._loadAiSummaries();
        return Object.keys(summaries).length;
    }

    async setAiSummary(tuneID, record) {
        if (!tuneID || !record || !record.text) return;
        tuneID = String(tuneID);

        const stored = {
            text: String(record.text).slice(0, AI_SUMMARY_MAX_CHARS),
            model: record.model || null,
            generatedAt: record.generatedAt || Date.now(),
            sourceUrl: record.sourceUrl || '',
        };

        const summaries = await this._loadAiSummaries();
        summaries[tuneID] = stored;
        await this._dbSet(KEY_AI_SUMMARIES, summaries);

        // Mirror onto any favourited setting of this tune. That is the only
        // channel that syncs — sync.js knows about the favourites document and
        // nothing else — so a summary generated on the phone reaches the laptop
        // for tunes the user cares enough to have starred.
        const items = await this.getFavourites();
        let touched = false;
        for (const item of items) {
            const itemTuneID = item.result && item.result.setting && item.result.setting.tune_id;
            if (itemTuneID != null && String(itemTuneID) === tuneID) {
                item.aiSummary = stored;
                // Regenerating after a clear must win. The tombstone is only
                // meaningful against an older summary, and this one is newer by
                // construction, so drop it rather than leave a stale marker for
                // the comparison in _harvestAiSummaries to reason about.
                delete item.aiSummaryDeletedAt;
                touched = true;
            }
        }
        if (touched) {
            await this._dbSet('favouriteItems', items);
            if (this.currentUser) pushFavourites(this.currentUser.uid, items);
        }
    }

    async clearAiSummaries() {
        this._aiSummariesCache = {};
        await this._dbSet(KEY_AI_SUMMARIES, {});

        // Strip the mirrors too, otherwise the next inbound snapshot (or the
        // next harvest) would quietly restore everything the user just cleared.
        //
        // Stripping alone is not enough, because absence is ambiguous: a
        // favourite with no `aiSummary` is exactly what a device that never
        // generated one looks like, and _reapplyAiSummaries is *supposed* to
        // restore those from its durable cache. Without a tombstone, a second
        // device would read this deletion as ignorance, put its own copy back
        // and push it — undoing the clear the confirm dialog promised would
        // reach the user's synced favourites. So record *when* the deletion
        // happened and let the timestamps decide.
        //
        // The marker goes on every favourite, not only the ones that currently
        // carry a mirror: another device may hold a note this one has never
        // seen, and "clear all" has to reach that too.
        const deletedAt = Date.now();
        localStorage.setItem(AI_CLEARED_AT_STORAGE_KEY, String(deletedAt));

        const items = await this.getFavourites();
        for (const item of items) {
            delete item.aiSummary;
            item.aiSummaryDeletedAt = deletedAt;
        }
        if (items.length) {
            await this._dbSet('favouriteItems', items);
            if (this.currentUser) pushFavourites(this.currentUser.uid, items);
        }
    }

    // Adopt the newest clear-all this snapshot tells us about, and return the
    // effective watermark for reconciling it.
    //
    // Deletion protection has to be **transitive**. Without this, a device that
    // merely *hears* about a clear deletes its copy and is then defenceless: it
    // has no cached note left to compare against and no watermark of its own, so
    // a third device that never saw the clear resurrects the note there. Only
    // the device where the user pressed Clear was protected.
    //
    // Adopted before reconciling rather than during it, so a tombstone and a
    // stale note arriving in the *same* snapshot are judged against the clear
    // too — the ordering of items in the array must not decide the outcome.
    //
    // ⚠️ This promotes a per-favourite marker into a global watermark, which is
    // only sound because `aiSummaryDeletedAt` is written in exactly two places
    // and both mean clear-*all*: clearAiSummaries, and the re-stamp in
    // _reapplyAiSummaries (which derives from this same watermark). **A per-tune
    // delete must not reuse this field** — it would read as "clear everything
    // older than this" and take out unrelated notes.
    _adoptIncomingClear(items) {
        let incomingClear = 0;
        for (const item of items) {
            const deletedAt = (item && item.aiSummaryDeletedAt) || 0;
            if (deletedAt > incomingClear) incomingClear = deletedAt;
        }

        const local = this._getAiSummariesClearedAt();
        if (incomingClear > local) {
            localStorage.setItem(AI_CLEARED_AT_STORAGE_KEY, String(incomingClear));
            return incomingClear;
        }
        return local;
    }

    // An inbound Firestore snapshot replaces the whole favourites array, so any
    // summary a remote device does not know about would be destroyed. Harvest
    // incoming summaries into the local cache, and keep the newer of the two
    // where both sides have one — the local cache, not the synced document, is
    // the durable copy.
    async _harvestAiSummaries(items) {
        if (!Array.isArray(items) || !items.length) return;
        const summaries = await this._loadAiSummaries();
        const clearedAt = this._adoptIncomingClear(items);
        let changed = false;

        for (const item of items) {
            const incoming = item && item.aiSummary;
            const tuneID = item && item.result && item.result.setting && item.result.setting.tune_id;
            if (tuneID == null) continue;

            const key = String(tuneID);
            const existing = summaries[key];
            const deletedAt = (item && item.aiSummaryDeletedAt) || 0;

            if (!incoming || !incoming.text) {
                // A tombstone is a deliberate deletion on another device, which
                // is a different thing from a device that simply never had the
                // note. Honour it, but only against a copy older than it — a
                // note regenerated since the clear must not be undone by the
                // old marker.
                //
                // Equality deletes, matching _reapplyAiSummaries below. A clear
                // and a generate in the same millisecond is unresolvable either
                // way; what matters is that the two functions agree, or the pair
                // could delete here and restore there on the same snapshot.
                if (deletedAt && existing && deletedAt >= (existing.generatedAt || 0)) {
                    delete summaries[key];
                    changed = true;
                }
                continue;
            }

            // A note this device deleted must not come back just because another
            // device still had it. `!existing` below cannot tell "never had it"
            // from "deleted it", so the watermark is the only thing standing
            // between a clear and a stale device undoing it.
            //
            // This is wall-clock across devices, so a badly skewed clock can
            // still slip a note through. Every other conflict decision in
            // favourites sync has the same exposure, and losing this one costs a
            // resurrected note rather than a lost one.
            if (clearedAt && (incoming.generatedAt || 0) <= clearedAt) continue;

            if (!existing || (incoming.generatedAt || 0) > (existing.generatedAt || 0)) {
                summaries[key] = incoming;
                changed = true;
            }
        }

        if (changed) await this._dbSet(KEY_AI_SUMMARIES, summaries);
    }

    // Re-apply locally cached summaries onto a favourites array that arrived
    // without them, so the next outbound push carries them rather than
    // propagating the deletion.
    async _reapplyAiSummaries(items) {
        if (!Array.isArray(items) || !items.length) return false;
        const summaries = await this._loadAiSummaries();
        const clearedAt = this._getAiSummariesClearedAt();
        let changed = false;

        for (const item of items) {
            const tuneID = item && item.result && item.result.setting && item.result.setting.tune_id;
            if (tuneID == null) continue;
            const cached = summaries[String(tuneID)];

            // Re-state a deletion the sending device had not heard about yet.
            // Without this the two devices trade the note back and forth: it
            // strips nothing, so the next push carries the note straight back
            // out, and the device that actually knows it was deleted never says
            // so. Stamping the tombstone is what ends the loop.
            if (clearedAt && item.aiSummary && (item.aiSummary.generatedAt || 0) <= clearedAt) {
                delete item.aiSummary;
                item.aiSummaryDeletedAt = Math.max(item.aiSummaryDeletedAt || 0, clearedAt);
                changed = true;
                continue;
            }

            if (!cached) continue;
            // Never re-apply over a deletion that is newer than what we hold —
            // that is the case this device is being *told* about, not one it
            // knows better than.
            const deletedAt = item.aiSummaryDeletedAt || 0;
            if (deletedAt >= (cached.generatedAt || 0)) continue;
            const current = item.aiSummary;
            if (!current || (cached.generatedAt || 0) > (current.generatedAt || 0)) {
                item.aiSummary = cached;
                changed = true;
            }
        }

        return changed;
    }

    async clearHistory() {
        await this._dbSet('historyItems', []);
    }

    async addToHistory(tuneHistoryItem) {
        let historyItems;
        try {
            historyItems = await get('historyItems') || [];
        } catch (e) {
            console.error('IndexedDB read error (historyItems)', e);
            historyItems = [];
        }

        if (tuneHistoryItem.result.setting && tuneHistoryItem.result.setting.tune_id) {
            let newTuneID = tuneHistoryItem.result.setting.tune_id;
            for (let [i, oldHistoryItem] of historyItems.entries()) {
                if (oldHistoryItem.result.setting && oldHistoryItem.result.setting.tune_id === newTuneID) {
                    historyItems.splice(i, 1);
                    break;
                }
            }
        }

        historyItems.unshift(tuneHistoryItem);
        historyItems = historyItems.slice(0, 100);

        await this._dbSet('historyItems', historyItems);
    }

    async exportUserData() {
        const payload = {
            version: 3,
            exportedAt: Date.now(),
            userSettings: this.userSettings,
            historyItems: await this.getHistoryItems(),
            favouriteItems: await this.getFavourites(),
        };
        return JSON.stringify(payload, null, 2);
    }

    async importUserData(jsonString) {
        let payload;
        try {
            payload = JSON.parse(jsonString);
        } catch (e) {
            throw new Error('Could not parse import file: invalid JSON.');
        }
        if (payload.version !== 1 && payload.version !== 2 && payload.version !== 3) {
            throw new Error(`Unsupported data version: ${payload.version}`);
        }
        await this._dbSet('historyItems', payload.historyItems || []);
        // v1/v2 exports may have folderId on items; getFavourites() will migrate them on next load
        await this._dbSet('favouriteItems', payload.favouriteItems || []);
        // Backups made after 3.9.0 carry AI summaries on favourited settings.
        // Restoring a backup is an explicit request for its contents, so it
        // outranks an earlier clear on this device — drop the watermark first,
        // or notes older than that clear would be silently dropped from the
        // import.
        localStorage.removeItem(AI_CLEARED_AT_STORAGE_KEY);
        await this._harvestAiSummaries(payload.favouriteItems || []);
        if (payload.favouriteFolders) await this._dbSet('favouriteFolders', payload.favouriteFolders);
        await this.updateUserSettings(payload.userSettings || this.userSettings);
        this._invalidateFavouriteCache();
    }

    loadAuth(auth) {
        this.auth = auth;
    }

    async onSignedIn(user) {
        // Defensively clear any existing sync listener before creating a new one.
        if (this._unsubscribeSync) {
            this._unsubscribeSync();
            this._unsubscribeSync = null;
        }
        this.currentUser = user;
        eventBus.$emit('authStateChanged', user);
        this._unsubscribeSync = syncSubscribe(user.uid, () => this.getFavourites(), async (type, items) => {
            if (type === 'favourites') {
                // The incoming array replaces the local one wholesale, so AI
                // summaries have to be reconciled around that write: harvest
                // anything new the remote device knows, then re-apply anything
                // it does not, so a device that has never generated a summary
                // cannot silently delete them.
                await this._harvestAiSummaries(items);
                const restored = await this._reapplyAiSummaries(items);
                await this._dbSet('favouriteItems', items);
                this._invalidateFavouriteCache();
                if (restored && this.currentUser) pushFavourites(this.currentUser.uid, items);
                eventBus.$emit('syncComplete');
            }
        });
    }

    onSignedOut() {
        if (this._unsubscribeSync) {
            this._unsubscribeSync();
            this._unsubscribeSync = null;
        }
        this.currentUser = null;
        eventBus.$emit('authStateChanged', null);
    }

    async signIn() {
        const provider = new GoogleAuthProvider();
        // Pass browserPopupRedirectResolver explicitly — WKWebView (iOS PWA) cannot
        // auto-detect it, causing "null is not an object (t_popupRedirectResolver)".
        await signInWithPopup(this.auth, provider, browserPopupRedirectResolver);
    }

    async signOut() {
        await firebaseSignOut(this.auth);
    }

    loadAnalytics(analytics) {
        this.analytics = analytics;
        this.setAnalyticsLoaded();
    }

    async logAnalyticsEvent(eventLabel, eventData) {
        await this.analyticsLoaded;
        if (process.env.NODE_ENV === 'production') {
            console.debug('EVENT LOGGED', eventLabel);
            logEvent(this.analytics, eventLabel, eventData);
        }
    }

    isReady() {
        return this.searchState === this.searchStates.READY;
    }

    isRecording() {
        return this.searchState === this.searchStates.RECORDING;
    }

    isWorking() {
        return this.searchState === this.searchStates.WORKING;
    }

    isListening() {
        return this.searchState === this.searchStates.LISTENING;
    }

    setSearchState(state) {
        this.searchState = state;
        if (!(this.isReady() || this.isRecording() || this.isWorking() || this.isListening())) {
            this.searchState = this.searchStates.READY;
            console.error(`Invalid state ${state}`);
        }
        eventBus.$emit('setSearchState');
    }

    setSessionAnalysisState(sessionAnalysisState) {
        this.state.sessionAnalysis = sessionAnalysisState;
    }

    clearSessionAnalysisState() {
        this.state.sessionAnalysis = null;
    }
}

const store = new Store();
export default store;
