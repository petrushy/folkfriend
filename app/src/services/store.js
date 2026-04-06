/* https://vuejs.org/v2/guide/state-management.html#Simple-State-Management-from-Scratch */
// Vuex is overkill for out needs. Use a very simple global object store for
//  very basic state management.
import eventBus from '@/eventBus.js';
import {get, set} from 'idb-keyval';
import {FavouriteItem} from '@/js/schema';
import { GoogleAuthProvider, signInWithPopup, signOut as firebaseSignOut } from 'firebase/auth';
import * as sync from './sync.js';
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

        this._favouriteIDs = null;
        this.analytics = null;
        this.analyticsLoaded = new Promise(resolve => {
            this.setAnalyticsLoaded = resolve;
        });
        this.currentUser = null;
        this.auth = null;
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

    async _loadFavouriteIDs() {
        if (this._favouriteIDs === null) {
            const items = await this.getFavourites();
            this._favouriteIDs = new Set(items.map(f => f.result.settingID));
        }
        return this._favouriteIDs;
    }

    async addFavourite(result) {
        const ids = await this._loadFavouriteIDs();
        if (!ids.has(result.settingID)) {
            const items = await this.getFavourites();
            items.unshift(new FavouriteItem(result));
            await set('favouriteItems', items);
            ids.add(result.settingID);
            if (this.currentUser) sync.pushFavourites(this.currentUser.uid, items);
        }
    }

    async removeFavourite(settingID) {
        const items = (await this.getFavourites()).filter(f => f.result.settingID !== settingID);
        await set('favouriteItems', items);
        if (this._favouriteIDs !== null) {
            this._favouriteIDs.delete(settingID);
        }
        if (this.currentUser) sync.pushFavourites(this.currentUser.uid, items);
    }

    async isFavourite(settingID) {
        const ids = await this._loadFavouriteIDs();
        return ids.has(settingID);
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
        if (this.currentUser) sync.pushHistory(this.currentUser.uid, historyItems);
    }

    async exportUserData() {
        const payload = {
            version: 1,
            exportedAt: Date.now(),
            userSettings: this.userSettings,
            historyItems: await this.getHistoryItems(),
            favouriteItems: await this.getFavourites(),
        };
        return JSON.stringify(payload, null, 2);
    }

    async importUserData(jsonString) {
        const payload = JSON.parse(jsonString);
        if (payload.version !== 1) {
            throw new Error(`Unsupported data version: ${payload.version}`);
        }
        await set('historyItems', payload.historyItems || []);
        await set('favouriteItems', payload.favouriteItems || []);
        await this.updateUserSettings(payload.userSettings || this.userSettings);
        this._favouriteIDs = null;
    }

    loadAuth(auth) {
        this.auth = auth;
    }

    async onSignedIn(user) {
        this.currentUser = user;
        eventBus.$emit('authStateChanged', user);
        const [localFavs, localHistory] = await Promise.all([
            this.getFavourites(),
            this.getHistoryItems(),
        ]);
        try {
            const result = await sync.pullOrSeed(user.uid, localFavs, localHistory);
            await Promise.all([
                set('favouriteItems', result.favourites),
                set('historyItems', result.history),
            ]);
            this._favouriteIDs = null;
            if (result.seeded) {
                sync.pushFavourites(user.uid, result.favourites);
                sync.pushHistory(user.uid, result.history);
            }
            eventBus.$emit('syncComplete');
        } catch (e) {
            console.error('Sync pull failed', e);
        }
    }

    onSignedOut() {
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