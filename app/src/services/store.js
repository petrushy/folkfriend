/* https://vuejs.org/v2/guide/state-management.html#Simple-State-Management-from-Scratch */
// Vuex is overkill for out needs. Use a very simple global object store for
//  very basic state management.
import eventBus from '@/eventBus.js';
import {get, set} from 'idb-keyval';
import {FavouriteItem, FavouriteFolder} from '@/js/schema';
import { GoogleAuthProvider, signInWithPopup, signOut as firebaseSignOut } from 'firebase/auth';
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
        this.analytics = null;
        this.analyticsLoaded = new Promise(resolve => {
            this.setAnalyticsLoaded = resolve;
        });
        this.currentUser = null;
        this.auth = null;
        this._unsubscribeSync = null;
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

    async getFavourites() {
        return await get('favouriteItems') || [];
    }

    async getFolders() {
        return await get('favouriteFolders') || [];
    }

    async _getOrCreateTodayFolder() {
        const today = new Date().toISOString().slice(0, 10);
        const folders = await this.getFolders();
        let folder = folders.find(f => f.name === today);
        if (!folder) {
            folder = new FavouriteFolder({ name: today });
            folders.push(folder);
            await set('favouriteFolders', folders);
            const items = await this.getFavourites();
            if (this.currentUser) pushFavourites(this.currentUser.uid, items, folders);
        }
        return folder;
    }

    async addFolder(name) {
        const folders = await this.getFolders();
        const folder = new FavouriteFolder({ name });
        folders.push(folder);
        await set('favouriteFolders', folders);
        const items = await this.getFavourites();
        if (this.currentUser) pushFavourites(this.currentUser.uid, items, folders);
        return folder;
    }

    async renameFolder(folderId, newName) {
        const folders = await this.getFolders();
        const folder = folders.find(f => f.id === folderId);
        if (folder) folder.name = newName;
        await set('favouriteFolders', folders);
        const items = await this.getFavourites();
        if (this.currentUser) pushFavourites(this.currentUser.uid, items, folders);
    }

    async deleteFolder(folderId) {
        const folders = (await this.getFolders()).filter(f => f.id !== folderId);
        // Move items from deleted folder to null (unfiled)
        const items = await this.getFavourites();
        items.forEach(item => { if (item.folderId === folderId) item.folderId = null; });
        await set('favouriteFolders', folders);
        await set('favouriteItems', items);
        if (this.currentUser) pushFavourites(this.currentUser.uid, items, folders);
    }

    async moveFavouriteToFolder(settingID, folderId) {
        settingID = String(settingID);
        const items = await this.getFavourites();
        const item = items.find(f => String(f.result.settingID) === settingID);
        if (item) item.folderId = folderId;
        await set('favouriteItems', items);
        const folders = await this.getFolders();
        if (this.currentUser) pushFavourites(this.currentUser.uid, items, folders);
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
                await set('favouriteItems', clean);
                items = clean;
            }
            this._favouriteIDs = new Set(items.map(f => String(f.result.settingID)));
            this._favouriteTuneIDs = new Set(
                items.filter(f => f.result.setting && f.result.setting.tune_id)
                     .map(f => String(f.result.setting.tune_id))
            );
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
    }

    async addFavourite(result) {
        if (!this._isValidSettingID(result.settingID)) {
            console.warn('addFavourite: invalid settingID, ignoring', result.settingID);
            return;
        }
        result = { ...result, settingID: String(result.settingID) };
        const ids = await this._loadFavouriteIDs();
        if (!ids.has(result.settingID)) {
            const folder = await this._getOrCreateTodayFolder();
            const items = await this.getFavourites();
            items.unshift(new FavouriteItem(result, folder.id));
            await set('favouriteItems', items);
            ids.add(result.settingID);
            if (this._favouriteTuneIDs && result.setting && result.setting.tune_id) {
                this._favouriteTuneIDs.add(String(result.setting.tune_id));
            }
            const folders = await this.getFolders();
            if (this.currentUser) pushFavourites(this.currentUser.uid, items, folders);
        }
    }

    async removeFavourite(settingID) {
        settingID = String(settingID);
        const items = (await this.getFavourites()).filter(f => String(f.result.settingID) !== settingID);
        await set('favouriteItems', items);
        // Invalidate both caches — tune may still be favourited via another setting
        this._invalidateFavouriteCache();
        const folders = await this.getFolders();
        if (this.currentUser) pushFavourites(this.currentUser.uid, items, folders);
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

    async clearHistory() {
        await set('historyItems', []);
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

    async exportUserData() {
        const payload = {
            version: 2,
            exportedAt: Date.now(),
            userSettings: this.userSettings,
            historyItems: await this.getHistoryItems(),
            favouriteItems: await this.getFavourites(),
            favouriteFolders: await this.getFolders(),
        };
        return JSON.stringify(payload, null, 2);
    }

    async importUserData(jsonString) {
        const payload = JSON.parse(jsonString);
        if (payload.version !== 1 && payload.version !== 2) {
            throw new Error(`Unsupported data version: ${payload.version}`);
        }
        await set('historyItems', payload.historyItems || []);
        await set('favouriteItems', payload.favouriteItems || []);
        await set('favouriteFolders', payload.favouriteFolders || []);
        await this.updateUserSettings(payload.userSettings || this.userSettings);
        this._invalidateFavouriteCache();
    }

    loadAuth(auth) {
        this.auth = auth;
    }

    async onSignedIn(user) {
        this.currentUser = user;
        eventBus.$emit('authStateChanged', user);
        const [localFavs, localFolders] = await Promise.all([this.getFavourites(), this.getFolders()]);
        this._unsubscribeSync = syncSubscribe(user.uid, localFavs, localFolders, async (type, items, folders) => {
            if (type === 'favourites') {
                await set('favouriteItems', items);
                await set('favouriteFolders', folders || []);
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
        await signInWithPopup(this.auth, provider);
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