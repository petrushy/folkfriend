/* https://vuejs.org/v2/guide/state-management.html#Simple-State-Management-from-Scratch */
// Vuex is overkill for out needs. Use a very simple global object store for
//  very basic state management.
import eventBus from '@/eventBus.js';
import {get,
    set
} from 'idb-keyval';
import {FavouriteItem} from '@/js/schema';
import {
    logEvent
} from 'firebase/analytics';

// TODO load from local storage or similar
const USER_SETTING_DEFAULTS = {
    advancedMode: false,
    preferFileUpload: false,
    showAbcText: false,
    microphoneChoice: null
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
            WORKING: 'working'
        };

        this.userSettings = JSON.parse(localStorage.getItem('userSettings')) || USER_SETTING_DEFAULTS;
        this.searchState = this.searchStates.READY;

        // Lazily-built set of favourited settingIDs, so the star toggle on
        // result/tune rows can be drawn without re-reading IndexedDB each time.
        // Invalidated on any favourites write.
        this._favouriteIDs = null; // Set<settingID string>

        this.analytics = null;
        this.analyticsLoaded = new Promise(resolve => {
            this.setAnalyticsLoaded = resolve;
        });
    }

    async updateUserSettings(userSettings) {
        // Usable immediately and synchronously by the entire application.
        this.userSettings = userSettings;

        // Save for later so that when we reload the settings page / restart
        //  app, the settings are maintained.
        localStorage.setItem('userSettings', JSON.stringify(userSettings));
    }

    async getHistoryItems() {
        return await get('historyItems') || [];
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

        await set('historyItems', historyItems);
    }

    // --- Favourites ---------------------------------------------------------
    // Favourites are stored locally in IndexedDB under 'favouriteItems' as an
    // array of FavouriteItem objects. settingID is always a string. Each item
    // carries a `tags` array of user-defined labels.

    async getFavourites() {
        return await get('favouriteItems') || [];
    }

    _isValidSettingID(settingID) {
        const s = String(settingID);
        return settingID != null && s !== 'undefined' && s !== 'null' && s !== '';
    }

    async _loadFavouriteIDs() {
        if (this._favouriteIDs === null) {
            const items = await this.getFavourites();
            this._favouriteIDs = new Set(items.map(f => String(f.result.settingID)));
        }
        return this._favouriteIDs;
    }

    async _saveFavourites(items) {
        await set('favouriteItems', items);
        this._favouriteIDs = null; // invalidate cache
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
            await this._saveFavourites(items);
        }
    }

    async removeFavourite(settingID) {
        settingID = String(settingID);
        const items = (await this.getFavourites()).filter(f => String(f.result.settingID) !== settingID);
        await this._saveFavourites(items);
    }

    async isFavourite(settingID) {
        if (!this._isValidSettingID(settingID)) return false;
        const ids = await this._loadFavouriteIDs();
        return ids.has(String(settingID));
    }

    // --- Tags ---------------------------------------------------------------

    async addTagToFavourite(settingID, tag) {
        settingID = String(settingID);
        tag = tag.trim();
        if (!tag) return;
        const items = await this.getFavourites();
        const item = items.find(f => String(f.result.settingID) === settingID);
        if (item) {
            if (!item.tags) item.tags = [];
            if (!item.tags.includes(tag)) item.tags.push(tag);
            await this._saveFavourites(items);
        }
    }

    async removeTagFromFavourite(settingID, tag) {
        settingID = String(settingID);
        const items = await this.getFavourites();
        const item = items.find(f => String(f.result.settingID) === settingID);
        if (item && item.tags) {
            item.tags = item.tags.filter(t => t !== tag);
            await this._saveFavourites(items);
        }
    }

    async renameTag(oldName, newName) {
        newName = newName.trim();
        if (!newName || oldName === newName) return;
        const items = await this.getFavourites();
        items.forEach(item => {
            if (item.tags && item.tags.includes(oldName)) {
                item.tags = item.tags.map(t => (t === oldName ? newName : t));
            }
        });
        await this._saveFavourites(items);
    }

    async deleteTag(name) {
        const items = await this.getFavourites();
        items.forEach(item => {
            if (item.tags) item.tags = item.tags.filter(t => t !== name);
        });
        await this._saveFavourites(items);
    }

    // --- Import / export ----------------------------------------------------
    // A simple, self-describing JSON document for favourites only, so users can
    // back up and move their favourites between devices/browsers without a
    // server. Import merges (it never clears existing favourites), unioning tags
    // for settings that are already favourited.

    async exportFavourites() {
        const payload = {
            type: 'folkfriend-favourites',
            version: 1,
            exportedAt: Date.now(),
            favouriteItems: await this.getFavourites(),
        };
        return JSON.stringify(payload, null, 2);
    }

    async importFavourites(jsonString) {
        let payload;
        try {
            payload = JSON.parse(jsonString);
        } catch (e) {
            throw new Error('Could not read file: it is not valid JSON.');
        }
        const incoming = Array.isArray(payload) ? payload : payload.favouriteItems;
        if (!Array.isArray(incoming)) {
            throw new Error('This file does not contain any favourites.');
        }

        const items = await this.getFavourites();
        const bySettingID = new Map(items.map(f => [String(f.result.settingID), f]));
        let added = 0;
        let updated = 0;

        for (const raw of incoming) {
            if (!raw || !raw.result || !this._isValidSettingID(raw.result.settingID)) continue;
            const settingID = String(raw.result.settingID);
            const tags = Array.isArray(raw.tags) ? raw.tags.filter(t => typeof t === 'string') : [];
            const existing = bySettingID.get(settingID);
            if (existing) {
                // Union tags onto the favourite we already have.
                if (!existing.tags) existing.tags = [];
                let changed = false;
                tags.forEach(t => { if (!existing.tags.includes(t)) { existing.tags.push(t); changed = true; } });
                if (changed) updated++;
            } else {
                const item = new FavouriteItem({ ...raw.result, settingID });
                if (typeof raw.timestamp === 'number') item.timestamp = raw.timestamp;
                item.tags = tags;
                items.push(item);
                bySettingID.set(settingID, item);
                added++;
            }
        }

        await this._saveFavourites(items);
        return { added, updated };
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

    setSearchState(state) {
        this.searchState = state;
        if (!(this.isReady() || this.isRecording() || this.isWorking())) {
            this.searchState = this.searchStates.READY;
            console.error(`Invalid state ${state}`);
        }
        eventBus.$emit('setSearchState');
    }
}

const store = new Store();
export default store;