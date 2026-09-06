/* https://vuejs.org/v2/guide/state-management.html#Simple-State-Management-from-Scratch */
// Vuex is overkill for out needs. Use a very simple global object store for
//  very basic state management.
import eventBus from '@/eventBus.js';
import {get, set} from 'idb-keyval';
import {FavouriteItem} from '@/js/schema';
import {estimateCostUsd, DEFAULT_MODEL as DEFAULT_AI_MODEL} from './aiSummary.js';
import {matchPlace, sightingsToAdopt, isValidFix, DEFAULT_PLACE_RADIUS_M} from '@/js/places.mjs';
import { GoogleAuthProvider, signInWithPopup, browserPopupRedirectResolver, signOut as firebaseSignOut } from 'firebase/auth';
import {
    subscribe as syncSubscribe, pushFavourites,
    subscribeCollection, pushRecord, pushRecords, deleteRecord, deleteRecords,
} from './sync.js';
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
    geoTagDetections: false, // record where each tune was heard; needs location permission
    // Which tune databases are downloaded, stored offline and searched.
    //
    // A FRESH install gets thesession only. folkwiki's detections are still
    // unreliable enough that having it on out of the box makes the app look
    // worse than it is to someone trying it for the first time; it is one tap
    // away in Settings → Offline Tune Database, exactly as before.
    //
    // This default must never reach a user who was already searching folkwiki
    // — see LEGACY_TUNE_DATASETS.
    tuneDatasets: ['thesession'],
};

// What someone was searching BEFORE this setting existed: the app fetched both
// files unconditionally. An install that has saved settings but no
// `tuneDatasets` key is exactly that user, and narrowing what they can find
// without asking is a regression, not a default change — they would search for
// a Swedish tune they have found before, get nothing, and have no way to tell
// why. So they keep both, and the new default applies only to installs that
// have never saved anything.
//
// Also used for a backup restored from before the setting existed, for the
// same reason.
const LEGACY_TUNE_DATASETS = ['thesession', 'folkwiki'];

// The pre-multi-dataset offline copies, read only to detect an upgrading
// install — see resolveDatasetSelection(). Owned by tuneIndexStore.js, which is
// worker-side; duplicated as literals rather than imported so that this
// main-thread module does not pull in the whole index-storage layer.
const LEGACY_INDEX_KEY = 'tuneIndex';    // schema 1
const MERGED_INDEX_KEY = 'ffIndexRaw';   // schema 2, both datasets in one blob

// The datasets the app OFFERS by default — the ones it can fetch for you.
//
// Norbeck is deliberately absent: it is built but not published (his terms
// forbid making the ABC files available for download), so offering a checkbox
// for it would be offering something that cannot be fetched. It reaches the
// app through Settings → "Add a database" instead, and appears in the list
// once it is stored, under the name in DATASET_LABELS.
//
// This is NOT the list of ids the app understands — an imported dataset can
// have any id. See sanitiseDatasets and datasetForTuneID.
export const KNOWN_DATASETS = ['thesession', 'folkwiki'];

// Which selection a settings object implies, before sanitising.
//
// `stored` is what was actually on disk (or in a backup), NOT the object already
// merged over the defaults — the whole question is whether the key was there.
// Present (even as an empty array) means the user has answered; absent from an
// otherwise-populated object means they predate the question and were searching
// both. A completely absent settings object is a fresh install and takes
// `fallback`, which is the current default.
function _datasetsFor(stored, fallback) {
    if (!stored || typeof stored !== 'object') return fallback;
    if (stored.tuneDatasets !== undefined) return stored.tuneDatasets;
    return [...LEGACY_TUNE_DATASETS];
}

// Substitute the default ONLY when the key is absent or is not an array.
//
// An explicit empty array is an honest "I deselected everything" and must be
// honoured — quietly replacing it with the default would override the user on
// every launch, and they would have no way to tell why.
function sanitiseDatasets(value) {
    if (!Array.isArray(value)) {
        return [...USER_SETTING_DEFAULTS.tuneDatasets];
    }
    // Any non-empty string id is kept, not just the ones this build knows.
    // Filtering to KNOWN_DATASETS meant a dataset added to the published
    // manifest after this release could be selected but would be dropped from
    // the saved preferences on the next launch — so it silently un-selected
    // itself. An id the manifest does not offer simply fails to install and is
    // dropped from the effective selection there instead.
    return [...new Set(value.filter(
        id => typeof id === 'string' && id !== ''))];
}

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

// Where tunes have been heard. An append-only log, NOT a field on history or
// favourites, for two reasons:
//
//  - The same tune is legitimately heard in many places, and that is the whole
//    point of the feature. addToHistory() deliberately removes the previous
//    entry for a tune (see its dedup loop), so a location there would only ever
//    answer "where did I last hear this" — and starring happens on the sofa
//    days later, where the location is not merely absent but wrong.
//  - It is its own key rather than a field on the favourites document, which
//    is what lets it sync as one document per record. These are also a log of
//    the user's physical movements, which is a materially different class of
//    data from a list of tune IDs — it was deliberately never synced at first
//    for that reason, and now syncs to the signed-in user's own account
//    because the log is worth little on the one device that recorded it. See
//    _subscribeRecordCollections.
const KEY_SIGHTINGS = 'tuneSightings';

// Named locations, matched to sightings by proximity rather than by any
// geocoding service. See src/js/places.mjs for why.
const KEY_PLACES = 'places';

// Sightings are the data that cannot be recovered after the fact — an evening
// that was not logged is gone — so the cap is far higher than history's 100.
// At roughly 30 tunes an evening this is several years of playing.
const MAX_SIGHTINGS = 5000;

// Guards against one detection being logged twice by two capture paths (the
// live loop and a result-row tap for the same tune), and against double taps.
// Deliberately short: within one session the semantic rule is "the recognised
// tune changed", which lives in liveAnalysis.js, and a genuine A-B-A set must
// still record two sightings of A.
const SIGHTING_DEDUP_MS = 60 * 1000;

// Saved live-listening sessions ("Past Sessions"). Recorded unconditionally —
// unlike tuneSightings, this is NOT gated by geoTagDetections; that setting
// only controls whether lat/lon get attached to the record (see
// liveAnalysis.js _recordSighting / _sessionFix). Kept as its own key rather
// than folded into tuneSightings because the shapes are different: sightings
// are one flat row per hearing, a live session is one record per evening
// holding an ORDERED tune list with durations.
const KEY_LIVE_SESSIONS = 'liveSessions';

// A live session is a much heavier object than a sighting — up to ~30 tune
// entries, each carrying a title/ids/score. The cap is far lower than
// sightings' 5000 for that reason. At roughly one evening per record, 300 is
// several years of regular playing — the same order of magnitude MAX_SIGHTINGS
// represents at its own (per-hearing) granularity.
const MAX_LIVE_SESSIONS = 300;

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
            // { loaded: [ids], missing: [ids], errors: {id: message},
            //   migrationPending: bool } — populated by backend._onIndexStatus.
            indexDatasets: { loaded: [], missing: [], errors: {}, migrationPending: false },
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
        const storedSettings = JSON.parse(localStorage.getItem('userSettings'));
        this.userSettings = {
            ...USER_SETTING_DEFAULTS,
            ...(storedSettings || {}),
        };
        // Whether the user has ever answered the question. Only an unanswered
        // one may be revised by resolveDatasetSelection() below.
        this._datasetSelectionIsExplicit =
            !!storedSettings && storedSettings.tuneDatasets !== undefined;
        this.userSettings.tuneDatasets = sanitiseDatasets(
            _datasetsFor(storedSettings, this.userSettings.tuneDatasets));
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
        this._unsubscribeRecordSync = null;
    }

    // The datasets the user wants searched. Always an array of known ids.
    selectedDatasets() {
        return sanitiseDatasets(this.userSettings.tuneDatasets);
    }

    // Settles what an install that never answered the dataset question should
    // search. Awaited once, before the worker reads anything off disk.
    //
    // The presence of a pre-multi-dataset offline copy is the evidence, and it
    // is better evidence than the localStorage heuristic above: userSettings is
    // written only when a setting is CHANGED, so a long-standing install whose
    // owner never opened Settings has no stored blob at all and would otherwise
    // be mistaken for a fresh one. Those copies cover thesession and folkwiki
    // by construction, so what they hold is exactly what this install was
    // searching.
    //
    // Getting this wrong costs twice over: the user silently stops finding
    // Swedish tunes, AND clearSupersededMergedCopies never reclaims the ~42 MB
    // blob, because it will not drop a copy until every dataset it covers has
    // a committed per-dataset replacement. That combination is permanent.
    //
    // The answer is persisted, so it is derived once and Settings shows what is
    // actually being searched rather than disagreeing with it.
    async resolveDatasetSelection() {
        if (this._datasetSelectionIsExplicit) return this.selectedDatasets();
        let hasMergedCopy = false;
        try {
            hasMergedCopy = (await get(LEGACY_INDEX_KEY)) !== undefined
                || (await get(MERGED_INDEX_KEY)) !== undefined;
        } catch (e) {
            // A read failure is not evidence of a fresh install, but it is not
            // evidence of an upgrade either. Leave the default alone rather
            // than guessing; the user can still turn folkwiki on.
            console.warn('Could not check for a pre-multi-dataset tune index', e);
            return this.selectedDatasets();
        }
        if (!hasMergedCopy) return this.selectedDatasets();
        this.userSettings.tuneDatasets = [...LEGACY_TUNE_DATASETS];
        await this.updateUserSettings(this.userSettings);
        return this.selectedDatasets();
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
        const incomingDatasets = _datasetsFor(userSettings, undefined);
        for (const [key, value] of Object.entries(USER_SETTING_DEFAULTS)) {
            if (userSettings[key] === undefined) userSettings[key] = value;
        }
        userSettings.tuneDatasets = sanitiseDatasets(
            incomingDatasets === undefined ? userSettings.tuneDatasets : incomingDatasets);
        // Saving settings answers the question, whether or not the user was
        // thinking about datasets at the time.
        this._datasetSelectionIsExplicit = true;

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

    // ---- Tune sightings (where a tune was heard) ---------------------------

    async getSightings() {
        try {
            return await get(KEY_SIGHTINGS) || [];
        } catch (e) {
            console.error(`IndexedDB read error (${KEY_SIGHTINGS})`, e);
            return [];
        }
    }

    async getPlaces() {
        try {
            return await get(KEY_PLACES) || [];
        } catch (e) {
            console.error(`IndexedDB read error (${KEY_PLACES})`, e);
            return [];
        }
    }

    // Records that `tuneID` was heard, optionally at `fix`. Returns the stored
    // sighting, or null if it was suppressed as a duplicate.
    //
    // A sighting is recorded even with no fix at all. Location is the bonus;
    // "I heard this tune on the 3rd of March" is still worth keeping, and
    // making the log conditional on a successful fix would mean an evening
    // indoors with no signal vanishes entirely.
    async addSighting({
        tuneID, settingID = null, displayName = '',
        fix = null, source = 'live', timestamp = null,
        // Set by the manual path, which names a place directly rather than
        // deriving one from coordinates: the user is recording "we played this
        // at the Cobblestone last Tuesday" from their sofa, where a fix would be
        // both unavailable and wrong.
        placeID = null,
    } = {}) {
        if (tuneID == null || tuneID === '') return null;

        const sightings = await this.getSightings();
        const places = await this.getPlaces();
        const at = timestamp || Date.now();

        const explicitPlace = placeID ? places.find(p => p.id === placeID) || null : null;
        // An explicit placeID that names nothing is a caller bug, not a reason
        // to silently record an unplaced sighting the user cannot see.
        if (placeID && !explicitPlace) return null;

        // Resolved before the duplicate check, not after: a manual add made
        // with a fix ("here now") still lands at whichever named place contains
        // that fix, and must be compared against sightings at THAT place rather
        // than against the unplaced bucket.
        const place = explicitPlace || (isValidFix(fix) ? matchPlace(fix, places) : null);

        if (source === 'manual') {
            // Deliberate acts are not deduplicated by time — the whole point is
            // that the user is adding something the detector missed, possibly
            // long after the fact. They ARE deduplicated by (tune, place): the
            // UI says "this tune was heard here", which is a fact that is either
            // true or not, so recording it twice adds nothing. The existing
            // record is returned so the caller still sees success.
            const already = sightings.find(s =>
                String(s.tuneID) === String(tuneID) &&
                (s.placeID || null) === (place ? place.id : null)
            );
            if (already) return already;
        } else {
            const duplicate = sightings.some(s =>
                String(s.tuneID) === String(tuneID) &&
                Math.abs((s.timestamp || 0) - at) < SIGHTING_DEDUP_MS
            );
            if (duplicate) return null;
        }

        const sighting = {
            id: `${at}-${tuneID}-${Math.random().toString(36).slice(2, 8)}`,
            tuneID: String(tuneID),
            settingID: settingID == null ? null : String(settingID),
            displayName: displayName || '',
            timestamp: at,
            source, // 'live' | 'search' | 'manual' — how it came to be recorded
            lat: isValidFix(fix) ? fix.lat : (explicitPlace ? explicitPlace.lat : null),
            lon: isValidFix(fix) ? fix.lon : (explicitPlace ? explicitPlace.lon : null),
            accuracy: isValidFix(fix) ? (fix.accuracy ?? null) : null,
            placeID: place ? place.id : null,
        };

        sightings.unshift(sighting);
        await this._dbSet(KEY_SIGHTINGS, sightings.slice(0, MAX_SIGHTINGS));
        this._syncPush('sightings', sighting);
        eventBus.$emit('sightingsChanged');
        return sighting;
    }

    // Un-tags a tune from a place: "we never actually played this here".
    //
    // Works at tune-at-place granularity rather than per hearing, because that
    // is the claim the UI makes ("Heard at The Cobblestone ×3") and therefore
    // the claim the user is disagreeing with. Removing one of three hearings
    // would leave the chip in place and look like nothing happened.
    //
    // `placeID` of null targets the unnamed bucket, which is what the "an
    // unnamed place" chip refers to.
    //
    // Returns the removed records so the caller can offer an undo — these are
    // observations that cannot be recreated, and a mis-tap on a small screen
    // must not be final.
    async removeTuneFromPlace(tuneID, placeID = null) {
        if (tuneID == null || tuneID === '') return [];
        const target = placeID || null;
        const sightings = await this.getSightings();
        const removed = sightings.filter(s =>
            String(s.tuneID) === String(tuneID) && (s.placeID || null) === target
        );
        if (!removed.length) return [];

        const removedIDs = new Set(removed.map(s => s.id));
        await this._dbSet(KEY_SIGHTINGS, sightings.filter(s => !removedIDs.has(s.id)));
        this._syncDeleteMany('sightings', [...removedIDs]);
        eventBus.$emit('sightingsChanged');
        return removed;
    }

    // Puts back records removed by removeTuneFromPlace. Restoring by whole
    // record rather than re-adding keeps the original timestamps, so an undone
    // removal does not quietly rewrite when the tune was heard.
    async restoreSightings(records) {
        if (!Array.isArray(records) || !records.length) return;
        const sightings = await this.getSightings();
        const known = new Set(sightings.map(s => s.id));
        const missing = records.filter(r => r && r.id && !known.has(r.id));
        if (!missing.length) return;
        const merged = [...missing, ...sightings]
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(0, MAX_SIGHTINGS);
        await this._dbSet(KEY_SIGHTINGS, merged);
        this._syncPushMany('sightings', missing);
        eventBus.$emit('sightingsChanged');
    }

    // Names a location. `fix` is the centre — normally the leader of an unnamed
    // cluster the user tapped. Every unplaced sighting within the radius adopts
    // it, which is what makes naming retroactive: play somewhere six times,
    // name it once, and all six evenings are labelled.
    async namePlace({ name, lat, lon, radiusM = DEFAULT_PLACE_RADIUS_M, id = null }) {
        const trimmed = (name || '').trim();
        if (!trimmed) return null;
        const centre = { lat: Number(lat), lon: Number(lon) };
        if (!isValidFix(centre)) return null;

        const places = await this.getPlaces();
        let place = id ? places.find(p => p.id === id) : null;

        if (place) {
            place.name = trimmed;
            place.lat = centre.lat;
            place.lon = centre.lon;
            place.radiusM = radiusM;
        } else {
            place = {
                id: `place-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: trimmed,
                lat: centre.lat,
                lon: centre.lon,
                radiusM,
                createdAt: Date.now(),
            };
            places.push(place);
        }
        await this._dbSet(KEY_PLACES, places);

        const sightings = await this.getSightings();
        const adopting = new Set(sightingsToAdopt(place, sightings).map(s => s.id));
        if (adopting.size) {
            for (const sighting of sightings) {
                if (adopting.has(sighting.id)) sighting.placeID = place.id;
            }
            await this._dbSet(KEY_SIGHTINGS, sightings);
        }

        this._syncPush('places', place);
        // Naming is retroactive, so it rewrites the placeID of every sighting
        // it adopted — those have to go up too, or the other device keeps
        // showing them as unplaced under a name it can already see.
        this._syncPushMany('sightings', sightings.filter(s => adopting.has(s.id)));
        eventBus.$emit('sightingsChanged');
        return place;
    }

    // Deletes a place. Its sightings are kept and returned to unplaced — they
    // are observations, and the name was only ever a label over them. Losing an
    // evening's log because a name was tidied up would be the same class of
    // mistake as deleting the offline index on a failed update.
    async deletePlace(placeID) {
        const places = (await this.getPlaces()).filter(p => p.id !== placeID);
        await this._dbSet(KEY_PLACES, places);

        const sightings = await this.getSightings();
        const orphaned = [];
        for (const sighting of sightings) {
            if (sighting.placeID === placeID) {
                sighting.placeID = null;
                orphaned.push(sighting);
            }
        }
        if (orphaned.length) await this._dbSet(KEY_SIGHTINGS, sightings);

        this._syncDelete('places', placeID);
        // The sightings survive the name being deleted, so they are UPDATED
        // remotely, never removed — the other device has to learn they are
        // unplaced now, not that they never happened.
        this._syncPushMany('sightings', orphaned);
        eventBus.$emit('sightingsChanged');
    }

    async deleteSighting(sightingID) {
        const sightings = (await this.getSightings()).filter(s => s.id !== sightingID);
        await this._dbSet(KEY_SIGHTINGS, sightings);
        this._syncDelete('sightings', sightingID);
        eventBus.$emit('sightingsChanged');
    }

    async clearSightings() {
        // Read before wiping: the remote copies are addressed by id, so the
        // ids have to be collected while they still exist locally. Without
        // this the local log is cleared and the synced one is not, and the
        // next snapshot puts every record straight back.
        const sightingIDs = (await this.getSightings()).map(s => s.id);
        const placeIDs = (await this.getPlaces()).map(p => p.id);
        await this._dbSet(KEY_SIGHTINGS, []);
        await this._dbSet(KEY_PLACES, []);
        this._syncDeleteMany('sightings', sightingIDs);
        this._syncDeleteMany('places', placeIDs);
        eventBus.$emit('sightingsChanged');
    }

    // ---- Live listening sessions (Past Sessions) ---------------------------

    async getLiveSessions() {
        try {
            return await get(KEY_LIVE_SESSIONS) || [];
        } catch (e) {
            console.error(`IndexedDB read error (${KEY_LIVE_SESSIONS})`, e);
            return [];
        }
    }

    // Creates or updates a session record by id. liveAnalysis.js calls this
    // repeatedly while a session is open (on each tune change, on Stop, and on
    // Clear), so lookup is always by id rather than by list position.
    async upsertLiveSession(session) {
        if (!session || !session.id) return null;
        const sessions = await this.getLiveSessions();
        const index = sessions.findIndex(s => s.id === session.id);
        const record = { ...session };
        if (index === -1) sessions.unshift(record);
        else sessions[index] = record;
        sessions.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
        await this._dbSet(KEY_LIVE_SESSIONS, sessions.slice(0, MAX_LIVE_SESSIONS));
        this._syncPush('liveSessions', record);
        eventBus.$emit('liveSessionsChanged');
        return record;
    }

    async deleteLiveSession(sessionID) {
        const sessions = (await this.getLiveSessions()).filter(s => s.id !== sessionID);
        await this._dbSet(KEY_LIVE_SESSIONS, sessions);
        this._syncDelete('liveSessions', sessionID);
        eventBus.$emit('liveSessionsChanged');
    }

    async clearLiveSessions() {
        // Ids collected before the wipe, for the same reason as clearSightings.
        const sessionIDs = (await this.getLiveSessions()).map(s => s.id);
        await this._dbSet(KEY_LIVE_SESSIONS, []);
        this._syncDeleteMany('liveSessions', sessionIDs);
        eventBus.$emit('liveSessionsChanged');
    }

    // ---- Syncing places, sightings and live sessions -----------------------
    //
    // These three are the user's own record of what they played and where, and
    // they are the one thing in the app that CANNOT be regenerated — an evening
    // that was not logged is gone. They are also recorded on a phone in a pub
    // and read back later on a computer, so a device-local log answers the
    // question for the wrong device.
    //
    // Every push is fire-and-forget. The Firestore SDK queues writes made
    // offline and replays them, and a sync failure must never break the local
    // write that has already happened — IndexedDB is the source of truth for
    // everything the app displays, and Firestore is only the transport.

    _syncPush(name, record) {
        if (!this.currentUser || !record) return;
        pushRecord(this.currentUser.uid, name, record);
    }

    _syncPushMany(name, records) {
        if (!this.currentUser || !records || !records.length) return;
        pushRecords(this.currentUser.uid, name, records);
    }

    _syncDelete(name, id) {
        if (!this.currentUser || id == null) return;
        deleteRecord(this.currentUser.uid, name, id);
    }

    _syncDeleteMany(name, ids) {
        if (!this.currentUser || !ids || !ids.length) return;
        deleteRecords(this.currentUser.uid, name, ids);
    }

    // Merges inbound records into a stored array, by id.
    //
    // Local pruning is NOT a deletion. A device at its cap drops the oldest
    // records to stay within it, and pushing that as authoritative would delete
    // another device's history — so only ids Firestore actually reported as
    // removed are removed here, and the cap is applied afterwards, locally.
    async _mergeRemoteRecords(key, upserts, removals, { sortBy, cap, event }) {
        let records;
        try {
            records = await get(key) || [];
        } catch (e) {
            console.error(`IndexedDB read error (${key})`, e);
            records = [];
        }

        const byID = new Map(records.map(r => [String(r.id), r]));
        for (const record of upserts || []) {
            if (record && record.id != null) byID.set(String(record.id), record);
        }
        for (const id of removals || []) byID.delete(String(id));

        const merged = [...byID.values()]
            .sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0))
            .slice(0, cap);

        await this._dbSet(key, merged);
        eventBus.$emit(event);
    }

    _subscribeRecordCollections(uid) {
        const subs = [
            subscribeCollection(uid, 'places', {
                getLocal: () => this.getPlaces(),
                applyRemote: (upserts, removals) => this._mergeRemoteRecords(
                    KEY_PLACES, upserts, removals,
                    // Places have no natural recency and are few, so the cap is
                    // effectively absent — capping them would silently drop the
                    // names that every sighting's placeID points at.
                    { sortBy: 'createdAt', cap: Infinity, event: 'sightingsChanged' },
                ),
            }),
            subscribeCollection(uid, 'sightings', {
                getLocal: () => this.getSightings(),
                applyRemote: (upserts, removals) => this._mergeRemoteRecords(
                    KEY_SIGHTINGS, upserts, removals,
                    { sortBy: 'timestamp', cap: MAX_SIGHTINGS, event: 'sightingsChanged' },
                ),
            }),
            subscribeCollection(uid, 'liveSessions', {
                getLocal: () => this.getLiveSessions(),
                applyRemote: (upserts, removals) => this._mergeRemoteRecords(
                    KEY_LIVE_SESSIONS, upserts, removals,
                    { sortBy: 'startedAt', cap: MAX_LIVE_SESSIONS, event: 'liveSessionsChanged' },
                ),
            }),
        ];
        return () => { for (const unsub of subs) unsub(); };
    }

    async exportUserData() {
        const payload = {
            version: 5,
            exportedAt: Date.now(),
            userSettings: this.userSettings,
            historyItems: await this.getHistoryItems(),
            favouriteItems: await this.getFavourites(),
            // Sightings carry coordinates, so a shared backup file discloses
            // where the user has played. They are included regardless: a backup
            // that silently drops the one dataset that cannot be regenerated is
            // not a backup, and while these are synced to the signed-in user's
            // own account now, that is a convenience and not an archive — it
            // holds one live copy, which a mistaken "clear" removes everywhere.
            // The Settings panel warns before the file is written.
            tuneSightings: await this.getSightings(),
            places: await this.getPlaces(),
            // Same reasoning as tuneSightings, and it may carry coordinates too
            // when geoTagDetections is on.
            liveSessions: await this.getLiveSessions(),
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
        if (![1, 2, 3, 4, 5].includes(payload.version)) {
            throw new Error(`Unsupported data version: ${payload.version}`);
        }
        await this._dbSet('historyItems', payload.historyItems || []);
        // Absent in older backups. Only written when the key is present, so
        // restoring an older backup does not wipe data recorded since.
        //
        // Restored records are pushed up rather than left for the seeding pass,
        // which only runs when a listener is first attached — an import made
        // while already signed in would otherwise stay on this device until the
        // next launch, looking as though half the restore had failed.
        if (payload.tuneSightings) {
            await this._dbSet(KEY_SIGHTINGS, payload.tuneSightings);
            this._syncPushMany('sightings', payload.tuneSightings);
        }
        if (payload.places) {
            await this._dbSet(KEY_PLACES, payload.places);
            this._syncPushMany('places', payload.places);
        }
        if (payload.liveSessions) {
            await this._dbSet(KEY_LIVE_SESSIONS, payload.liveSessions);
            this._syncPushMany('liveSessions', payload.liveSessions);
        }
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
        if (this._unsubscribeRecordSync) {
            this._unsubscribeRecordSync();
            this._unsubscribeRecordSync = null;
        }
        this.currentUser = user;
        eventBus.$emit('authStateChanged', user);
        // Set before the listeners, since seeding pushes local-only records and
        // every push reads this.currentUser to address them.
        this._unsubscribeRecordSync = this._subscribeRecordCollections(user.uid);
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
        if (this._unsubscribeRecordSync) {
            this._unsubscribeRecordSync();
            this._unsubscribeRecordSync = null;
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
