<template>
    <v-container 
        class="viewContainerWrapper"
    >
        <v-card
            class="pa-5 my-2"
        >
            <h1 class="pb-3">
                Settings
            </h1>
            <v-row>
                <v-switch
                    v-model="userSettings.preferFileUpload"
                    inset
                    label="Upload file instead of using device microphone"
                    class="my-0 pl-2"
                    @change="settingsChanged"
                />
            </v-row>
            <v-row>
                <v-switch
                    v-model="userSettings.advancedMode"
                    inset
                    label="Removes time limit on microphone and generates sheet music without searching database"
                    class="my-0 pl-2"
                    @change="settingsChanged"
                />
            </v-row>
            <v-row>
                <v-switch
                    v-model="userSettings.showAbcText"
                    inset
                    label="Show ABC as text alongside sheet music"
                    class="my-0 pl-2"
                    @change="settingsChanged"
                />
            </v-row>
            <v-row align="center" class="pl-2 pr-4 mt-2">
                <v-text-field
                    v-model.number="userSettings.recordingTimeLimitSecs"
                    label="Max recording length (seconds)"
                    type="number"
                    min="5"
                    max="60"
                    style="max-width: 220px"
                    hint="Default 10s is recommended — longer recordings can reduce search accuracy"
                    persistent-hint
                    @change="onRecordingLimitChanged"
                />
            </v-row>
        </v-card>
        <v-card class="pa-5 my-2">
            <h1 class="pb-3">
                Sync
            </h1>
            <p>Sign in to keep your favourites and history in sync across devices.</p>
            <div v-if="currentUser">
                <v-row align="center" class="px-2 mb-2">
                    <v-icon left color="success">{{ icons.account }}</v-icon>
                    <span>Signed in as <strong>{{ currentUser.email }}</strong></span>
                </v-row>
                <v-btn :loading="signingOut" @click="signOut">
                    <v-icon left>{{ icons.logout }}</v-icon>
                    Sign out
                </v-btn>
            </div>
            <div v-else>
                <v-btn :loading="signingIn" @click="signIn">
                    <v-icon left>{{ icons.google }}</v-icon>
                    Sign in with Google
                </v-btn>
                <p v-if="authError" class="mt-3 mb-0 error--text">
                    {{ authError }}
                </p>
            </div>
        </v-card>
        <v-card class="pa-5 my-2">
            <h1 class="pb-3">
                Import from The Session
            </h1>
            <p>
                Enter your bookmarks URL from thesession.org to import them as favourites.
                Find it at: thesession.org/members/<em>your-id</em>/bookmarks
            </p>
            <v-text-field
                v-model="bookmarkUrl"
                label="Bookmarks URL"
                placeholder="https://thesession.org/members/12345/bookmarks"
                hide-details
                class="mb-3"
            />
            <v-btn :loading="importing" :disabled="!bookmarkUrl" @click="importFromTheSession">
                <v-icon left>{{ icons.import }}</v-icon>
                Import bookmarks
            </v-btn>
            <p v-if="importStatus" class="mt-3 mb-0" :class="importError ? 'error--text' : ''">
                {{ importStatus }}
            </p>
        </v-card>
        <v-card class="pa-5 my-2">
            <h1 class="pb-3">
                Transfer Data
            </h1>
            <p>
                Export your favourites, history and settings to a file, then
                restore them on another device.
            </p>
            <v-row class="px-2">
                <v-btn class="mr-3 mb-2" @click="downloadUserData">
                    <v-icon left>{{ icons.download }}</v-icon>
                    Download User Data
                </v-btn>
                <v-btn class="mb-2" @click="$refs.restoreInput.click()">
                    <v-icon left>{{ icons.upload }}</v-icon>
                    Restore User Data
                </v-btn>
                <input
                    ref="restoreInput"
                    type="file"
                    accept="application/json,.json"
                    style="display: none"
                    @change="restoreUserData"
                >
            </v-row>
            <p v-if="restoreMessage" class="mt-2 mb-0">
                {{ restoreMessage }}
            </p>
        </v-card>

        <v-card
            class="pa-5 my-2"
        >
            <h1>Download</h1>
            <p>
                FolkFriend is a "Web App", which means it installs onto your
                Home Screen just like any other app.
            </p>
            <p
                v-if="isPWA"
                align="center"
            >
                FolkFriend is installed <v-icon class="pb-1 Installed">
                    {{ icons.checkCircle }}
                </v-icon>
            </p>
            <div v-else-if="ua.isSafari && ua.isMobile">
                <p class="mb-1">On iOS Safari,</p>
                <ul>
                    <li>
                        Tap <v-icon class="pb-2">
                            {{ icons.iosShare }}
                        </v-icon> "share"
                    </li>
                    <li>Scroll down</li>
                    <li>
                        Tap <v-icon class="pb-1">
                            {{ icons.iosAddToHomeScreen }}
                        </v-icon> "add to home screen"
                    </li>
                </ul>
            </div>
            <div v-else-if="ua.isChrome && ua.isMobile">
                <p class="mb-1">On Chrome mobile,</p>
                <ul>
                    <li>
                        Tap <v-icon class="pb-1">
                            {{ icons.dotsVertical }}
                        </v-icon> "Customise"
                    </li>
                    <li>
                        Tap <v-icon class="pb-1">
                            {{ icons.installMobile }}
                        </v-icon> "Install FolkFriend"
                    </li>
                </ul>
            </div>
            <div v-else-if="ua.isChrome && !ua.isMobile">
                <p class="mb-1">On Chrome desktop,</p>
                <ul>
                    <li>
                        Tap <v-icon class="pb-1">
                            {{ icons.installDesktop }}
                        </v-icon> "install app"
                    </li>
                </ul>
            </div>
            <p v-else>
                To install FolkFriend, navigate to the settings of your browser
                and select "Add to Home Screen" or "Install App".
            </p>
        </v-card>
    </v-container>
</template>

<script>
import store from '@/services/store.js';
import ffBackend from '@/services/backend.js';
import eventBus from '@/eventBus.js';
import utils from '@/js/utils.js';
import {
    // mdiCellphoneArrowDownVariant,
    mdiAccountCircle,
    mdiCellphoneArrowDown,
    mdiCheckCircleOutline,
    mdiDotsVertical,
    mdiDownload,
    mdiExportVariant,
    mdiGoogle,
    mdiImport,
    mdiLogout,
    // mdiMonitorArrowDownVariant,
    mdiPlusBoxOutline,
    mdiUpload,
} from '@mdi/js';

export default {
    name: 'SettingsView',
    beforeRouteEnter(_, from, next) {
        // This becomes a parent view, unless it's come from the search,
        //  in which case the hamburger state isn't changed. This enables
        //  it to stay as a parent view if the settings were opened through
        //  the navigation drawer, or to become a child view if the top-right
        //  settings shortcut was clicked from the search page.
        if(from.name !== 'search') {
            eventBus.$emit('parentViewActivated');
        }        
        next();
    },
    data: () => ({
        currentUser: null,
        signingIn: false,
        signingOut: false,
        authError: null,
        bookmarkUrl: '',
        importing: false,
        importStatus: null,
        importError: false,
        icons: {
            account: mdiAccountCircle,
            google: mdiGoogle,
            import: mdiImport,
            logout: mdiLogout,
            iosShare: mdiExportVariant,
            iosAddToHomeScreen: mdiPlusBoxOutline,
            checkCircle: mdiCheckCircleOutline,
            // TODO waiting on these icons being pushed to the npm version
            // installDesktop: mdiMonitorArrowDownVariant,
            // installMobile: mdiCellphoneArrowDownVariant,
            installDesktop: mdiCellphoneArrowDown,
            installMobile: mdiCellphoneArrowDown,
            dotsVertical: mdiDotsVertical,
            download: mdiDownload,
            upload: mdiUpload,
        },
        settingsLoaded: false,
        userSettings: store.userSettings,
        isPWA: utils.checkStandalone(),
        restoreMessage: null,
    }),
    created: function() {
        this.ua = utils.checkUserAgent();
        // Read current value immediately in case authStateChanged already fired before mount.
        this.currentUser = store.currentUser;
        this._onAuthStateChanged = user => { this.currentUser = user; };
        eventBus.$on('authStateChanged', this._onAuthStateChanged);
    },
    beforeDestroy() {
        eventBus.$off('authStateChanged', this._onAuthStateChanged);
    },
    methods: {
        settingsChanged() {
            store.updateUserSettings(this.userSettings);
        },
        onRecordingLimitChanged() {
            const v = Math.round(this.userSettings.recordingTimeLimitSecs);
            this.userSettings.recordingTimeLimitSecs = Math.min(60, Math.max(5, v || 10));
            store.updateUserSettings(this.userSettings);
        },
        async signIn() {
            this.authError = null;
            this.signingIn = true;
            try {
                await store.signIn();
            } catch (err) {
                const messages = {
                    'auth/unauthorized-domain': 'This domain is not authorised in Firebase. Add it under Authentication → Authorized domains in the Firebase console.',
                    'auth/popup-blocked': 'The sign-in popup was blocked. Allow popups for this site and try again.',
                    'auth/popup-closed-by-user': 'Sign-in cancelled.',
                };
                this.authError = messages[err.code] || `Sign-in failed: ${err.message}`;
            } finally {
                this.signingIn = false;
            }
        },
        async signOut() {
            this.signingOut = true;
            try {
                await store.signOut();
            } finally {
                this.signingOut = false;
            }
        },
        async fetchAllBookmarks(baseUrl) {
            const items = [];
            let page = 1;
            while (true) {
                this.importStatus = `Fetching bookmarks… page ${page}`;
                const res = await fetch(`${baseUrl}?format=json&page=${page}`);
                if (!res.ok) throw new Error(`HTTP ${res.status} from thesession.org`);
                const data = await res.json();
                if (!data.items || data.items.length === 0) break;
                items.push(...data.items);
                if (data.items.length < 10) break;
                page++;
            }
            return items;
        },
        async importFromTheSession() {
            this.importStatus = null;
            this.importError = false;
            this.importing = true;
            try {
                const bookmarks = await this.fetchAllBookmarks(
                    this.bookmarkUrl.trim().replace(/\?.*$/, '')
                );
                if (bookmarks.length === 0) {
                    this.importStatus = 'No bookmarks found at that URL.';
                    return;
                }
                this.importStatus = `Found ${bookmarks.length} bookmarks. Waiting for tune index…`;

                // Wait for the WASM index to be ready before processing
                await new Promise(resolve => {
                    if (store.state.indexLoaded) return resolve();
                    eventBus.$once('indexLoaded', resolve);
                });

                const withTimeout = (promise, ms) => Promise.race([
                    promise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
                ]);

                let imported = 0, skipped = 0, notFound = 0;
                for (const [i, item] of bookmarks.entries()) {
                    this.importStatus = `Processing ${i + 1} / ${bookmarks.length}…`;
                    const tuneID = item.target.id.split(':')[2]; // must be string — WASM expects String
                    const settingID = item.object.id.split(':')[2]; // string, consistent with WASM setting_id
                    const displayName = item.object.displayName;
                    if (await store.isFavourite(settingID)) {
                        skipped++;
                        continue;
                    }
                    let settings;
                    try {
                        settings = await withTimeout(ffBackend.settingsFromTuneID(tuneID), 3000);
                    } catch (e) {
                        console.warn(`settingsFromTuneID failed for tuneID ${tuneID}:`, e.message);
                        notFound++;
                        continue;
                    }
                    const setting = settings.find(s => s.setting_id === settingID);
                    if (!setting) {
                        notFound++;
                        continue;
                    }
                    await store.addFavourite({ settingID, setting, displayName });
                    imported++;
                }
                const parts = [];
                if (imported) parts.push(`${imported} imported`);
                if (skipped) parts.push(`${skipped} already saved`);
                if (notFound) parts.push(`${notFound} not found in tune index`);
                this.importStatus = `Done: ${parts.join(', ')}.`;
            } catch (err) {
                this.importError = true;
                this.importStatus = `Import failed: ${err.message}`;
                console.error('Bookmark import error', err);
            } finally {
                this.importing = false;
            }
        },
        async downloadUserData() {
            const json = await store.exportUserData();
            const blob = new Blob([json], {type: 'application/json'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'folkfriend-data.json';
            a.click();
            URL.revokeObjectURL(url);
        },
        restoreUserData(e) {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    await store.importUserData(event.target.result);
                    this.userSettings = store.userSettings;
                    this.restoreMessage = '✓ Data restored successfully.';
                } catch (err) {
                    this.restoreMessage = `Failed to restore: ${err.message}`;
                }
                // Reset file input so the same file can be re-selected if needed
                this.$refs.restoreInput.value = '';
            };
            reader.readAsText(file);
        },
    },
};
</script>

<style scoped>
</style>