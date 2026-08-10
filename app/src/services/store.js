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
        const items = await this.getFavourites();
        let touched = false;
        for (const item of items) {
            if (item.aiSummary) {
                delete item.aiSummary;
                touched = true;
            }
        }
        if (touched) {
            await this._dbSet('favouriteItems', items);
            if (this.currentUser) pushFavourites(this.currentUser.uid, items);
        }
    }

    // An inbound Firestore snapshot replaces the whole favourites array, so any
    // summary a remote device does not know about would be destroyed. Harvest
    // incoming summaries into the local cache, and keep the newer of the two
    // where both sides have one — the local cache, not the synced document, is
    // the durable copy.
    async _harvestAiSummaries(items) {
        if (!Array.isArray(items) || !items.length) return;
        const summaries = await this._loadAiSummaries();
        let changed = false;

        for (const item of items) {
            const incoming = item && item.aiSummary;
            const tuneID = item && item.result && item.result.setting && item.result.setting.tune_id;
            if (!incoming || !incoming.text || tuneID == null) continue;

            const key = String(tuneID);
            const existing = summaries[key];
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
        let changed = false;

        for (const item of items) {
            const tuneID = item && item.result && item.result.setting && item.result.setting.tune_id;
            if (tuneID == null) continue;
            const cached = summaries[String(tuneID)];
            if (!cached) continue;
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
