/* https://vuejs.org/v2/guide/state-management.html#Simple-State-Management-from-Scratch */
// Vuex is overkill for out needs. Use a very simple global object store for
//  very basic state management.
import eventBus from '@/eventBus.js';
import {get, set} from 'idb-keyval';
import {FavouriteItem} from '@/js/schema';
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
};

class Store {
    constructor() {
        this.state = {
            indexLoaded: false,
            lastResults: [],
            lastContour: '',
            lastTimer: null,
            backendVersion: 'not loaded'
        };

        this.searchStates = {
            READY: 'ready',
            RECORDING: 'recording',
            WORKING: 'working',
            LISTENING: 'listening',
        };

        this.userSettings = JSON.parse(localStorage.getItem('userSettings')) || USER_SETTING_DEFAULTS;
        this.searchState = this.searchStates.READY;

        this._favouriteIDs = null;
        this._favouriteTuneIDs = null;
        this._settingTagsCache = null; // Map<settingID string, string[]>
        this._tuneTagsCache = null;    // Map<tuneID string, string[]> — union across all settings
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

    async clearHistory() {
        await this._dbSet('historyItems', []);
    }

    async addToHistory(tuneHistoryItem) {
        let historyItems = await get('historyItems') || [];

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
        const payload = JSON.parse(jsonString);
        if (payload.version !== 1 && payload.version !== 2 && payload.version !== 3) {
            throw new Error(`Unsupported data version: ${payload.version}`);
        }
        await this._dbSet('historyItems', payload.historyItems || []);
        // v1/v2 exports may have folderId on items; getFavourites() will migrate them on next load
        await this._dbSet('favouriteItems', payload.favouriteItems || []);
        if (payload.favouriteFolders) await this._dbSet('favouriteFolders', payload.favouriteFolders);
        await this.updateUserSettings(payload.userSettings || this.userSettings);
        this._invalidateFavouriteCache();
    }

    loadAuth(auth) {
        this.auth = auth;
    }

    async onSignedIn(user) {
        this.currentUser = user;
        eventBus.$emit('authStateChanged', user);
        const localFavs = await this.getFavourites();
        this._unsubscribeSync = syncSubscribe(user.uid, localFavs, async (type, items) => {
            if (type === 'favourites') {
                await this._dbSet('favouriteItems', items);
                this._invalidateFavouriteCache();
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
}

const store = new Store();
export default store;
