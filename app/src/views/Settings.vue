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
            <v-row>
                <v-switch
                    v-model="userSettings.useMlTranscriber"
                    inset
                    label="Experimental: ML transcription (better for polyphonic/percussive audio, e.g. banjo sessions)"
                    class="my-0 pl-2"
                    @change="onMlTranscriberChanged"
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
            <v-row>
                <v-switch
                    v-model="userSettings.autoGainControl"
                    inset
                    label="Auto gain control (let the device boost quiet recordings; may cause level pumping on sustained notes)"
                    class="my-0 pl-2"
                    @change="settingsChanged"
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
                AI Tune Summaries
            </h1>
            <p>
                Adds an <strong>(i)</strong> button to each tune that writes a short
                background note — origin, earliest documented date, the story attached to
                it — suitable as a program note. Each note is generated once and then
                saved, so opening the same tune again costs nothing and works offline.
            </p>
            <p class="caption text--secondary">
                This uses <em>your</em> Anthropic API key and is billed to your own
                account. A key kept in a browser can be read by anyone with access to this
                device, so use a dedicated key with a spend limit rather than your main
                one. It is stored only on this device and is deliberately left out of
                exported backups.
            </p>
            <v-row>
                <v-switch
                    v-model="userSettings.aiSummariesEnabled"
                    inset
                    label="Show tune background notes"
                    hint="Nothing is ever generated automatically — you tap to generate."
                    persistent-hint
                    class="my-0 pl-2"
                    @change="settingsChanged"
                />
            </v-row>
            <v-text-field
                v-model="apiKeyInput"
                label="Anthropic API key"
                placeholder="sk-ant-..."
                :type="showApiKey ? 'text' : 'password'"
                :append-icon="showApiKey ? icons.eyeOff : icons.eye"
                autocomplete="off"
                spellcheck="false"
                class="mt-4"
                hint="Create one at console.anthropic.com. Stored on this device only."
                persistent-hint
                @click:append="showApiKey = !showApiKey"
                @change="onApiKeyChanged"
            />
            <v-select
                v-model="userSettings.aiSummaryModel"
                :items="aiModelItems"
                label="Model"
                class="mt-4"
                :hint="aiModelHint"
                persistent-hint
                @change="settingsChanged"
            />
            <v-simple-table dense class="mt-5 mb-2">
                <tbody>
                    <tr>
                        <td class="text--secondary pr-4">Notes saved</td>
                        <td>{{ aiSummaryCount === null ? 'checking…' : aiSummaryCount }}</td>
                    </tr>
                    <tr>
                        <td class="text--secondary pr-4">API calls made</td>
                        <td>{{ aiUsage.calls }}</td>
                    </tr>
                    <tr>
                        <td class="text--secondary pr-4">Tokens used</td>
                        <td>
                            {{ aiUsage.inputTokens.toLocaleString() }} in,
                            {{ aiUsage.outputTokens.toLocaleString() }} out
                        </td>
                    </tr>
                    <tr>
                        <td class="text--secondary pr-4">Approximate spend</td>
                        <td>{{ formatUsd(aiUsage.costUsd) }}</td>
                    </tr>
                </tbody>
            </v-simple-table>
            <p class="caption text--secondary">
                Spend is estimated from token counts at list prices, so treat it as a
                guide — your Anthropic console is the real figure.
            </p>
            <v-row class="px-2">
                <v-btn class="mr-3 mb-2" :disabled="!aiSummaryCount" @click="confirmClearAiSummaries">
                    Clear saved notes
                </v-btn>
                <v-btn class="mb-2" text :disabled="!aiUsage.calls" @click="resetAiUsage">
                    Reset counters
                </v-btn>
            </v-row>
            <p v-if="aiMessage" class="mt-2 mb-0">
                {{ aiMessage }}
            </p>
        </v-card>

        <v-dialog v-model="clearAiDialog" max-width="360">
            <v-card>
                <v-card-title>Clear saved notes?</v-card-title>
                <v-card-text>
                    This deletes all {{ aiSummaryCount }} saved background notes on this
                    device and removes them from your synced favourites. Generating them
                    again will cost money again.
                </v-card-text>
                <v-card-actions>
                    <v-spacer />
                    <v-btn text @click="clearAiDialog = false">Cancel</v-btn>
                    <v-btn text color="red" @click="clearAiSummaries">Delete</v-btn>
                </v-card-actions>
            </v-card>
        </v-dialog>

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

        <v-card class="pa-5 my-2">
            <h1 class="pb-3">
                Offline Tune Database
            </h1>

            <v-alert v-if="offlineReady === false" dense text type="warning" class="mb-4">
                No offline copy is saved on this device. Tune search will not
                work without a connection. Tap <strong>Save offline copy</strong>
                below while you have Wi-Fi.
            </v-alert>
            <v-alert v-else-if="offlineReady === true" dense text type="success" class="mb-4">
                Ready to use offline{{ offlineSavedLabel }}.
            </v-alert>

            <v-simple-table dense class="mb-4">
                <tbody>
                    <tr>
                        <td class="text--secondary pr-4">Offline copy</td>
                        <td>
                            <span v-if="offlineStatus === null">checking…</span>
                            <span v-else-if="offlineReady" class="success--text">
                                saved ({{ offlineSizeLabel }})
                            </span>
                            <span v-else class="warning--text">not saved</span>
                        </td>
                    </tr>
                    <tr>
                        <td class="text--secondary pr-4">Saved version</td>
                        <td>{{ localTuneDataLabel }}</td>
                    </tr>
                    <tr>
                        <td class="text--secondary pr-4">Latest version</td>
                        <td>{{ remoteTuneDataLabel }}</td>
                    </tr>
                    <tr>
                        <td class="text--secondary pr-4">Storage</td>
                        <td>
                            <span v-if="storageIsPersistent === null">checking…</span>
                            <span v-else-if="storageIsPersistent" class="success--text">protected from clearing</span>
                            <span v-else class="warning--text">may be cleared by browser</span>
                            <span v-if="storageUsageLabel" class="text--secondary">
                                · {{ storageUsageLabel }}
                            </span>
                        </td>
                    </tr>
                    <tr>
                        <td class="text--secondary pr-4">In-memory index</td>
                        <td>
                            <span v-if="indexStatus === 'ready'" class="success--text">loaded</span>
                            <span v-else-if="indexStatus === 'downloading'">
                                downloading{{ downloadPercentLabel }}…
                            </span>
                            <span v-else-if="indexStatus === 'unavailable'" class="warning--text">unavailable</span>
                            <span v-else>loading…</span>
                        </td>
                    </tr>
                    <tr v-if="offlineStatusMessage">
                        <td class="text--secondary pr-4">Note</td>
                        <td class="warning--text">{{ offlineStatusMessage }}</td>
                    </tr>
                </tbody>
            </v-simple-table>

            <p v-if="storageIsPersistent === false" class="mt-0 mb-4 caption">
                The browser may clear tune data under storage pressure.
                Add FolkFriend to your Home Screen to make offline storage
                permanent.
            </p>

            <v-switch
                v-model="userSettings.autoUpdateTuneData"
                label="Check for new tune data automatically"
                hint="Off means the saved copy is only ever replaced when you tap the button below. It is never modified in the background."
                persistent-hint
                class="mt-0 mb-4"
                @change="settingsChanged"
            />

            <v-btn
                :loading="refreshingTuneData"
                :disabled="refreshingTuneData"
                color="primary"
                @click="saveOfflineCopy"
            >
                <v-icon left>{{ icons.download }}</v-icon>
                {{ offlineReady ? 'Update offline copy' : 'Save offline copy' }}
            </v-btn>
            <v-progress-linear
                v-if="refreshingTuneData || indexStatus === 'downloading'"
                :indeterminate="downloadPercent === null"
                :value="downloadPercent || 0"
                class="mt-3"
                height="6"
                rounded
            />
            <p v-if="refreshMessage" class="mt-3 mb-0">
                {{ refreshMessage }}
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
import { fetchTuneIndexMetadata } from '@/services/tuneIndexNetwork.js';
import {
    MODELS as AI_MODELS,
    DEFAULT_MODEL as DEFAULT_AI_MODEL,
    estimateCostPerNoteUsd,
} from '@/services/aiSummary.js';
import {
    // mdiCellphoneArrowDownVariant,
    mdiAccountCircle,
    mdiCellphoneArrowDown,
    mdiCheckCircleOutline,
    mdiDotsVertical,
    mdiDownload,
    mdiExportVariant,
    mdiEye,
    mdiEyeOff,
    mdiGoogle,
    mdiImport,
    mdiLogout,
    // mdiMonitorArrowDownVariant,
    mdiPlusBoxOutline,
    mdiRefresh,
    mdiUpload,
} from '@mdi/js';

function formatBytes(bytes) {
    if (!bytes) return '0 MB';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb.toFixed(0)} MB`;
}

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
        refreshingTuneData: false,
        refreshMessage: null,
        remoteMetadata: null,
        storageIsPersistent: null,
        // What is actually on disk (read from IndexedDB, not inferred from
        // in-memory state) plus a storage quota estimate. This is the pre-flight
        // check: if "Offline copy: saved" is green before you board, tune search
        // works on the plane.
        offlineStatus: null,
        indexStatus: store.state.indexStatus,
        indexStatusDetail: store.state.indexStatusDetail,
        downloadProgress: null,
        localVersion: store.state.tuneIndexVersion,
        localDate: store.state.tuneIndexDate,
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
            eye: mdiEye,
            eyeOff: mdiEyeOff,
            refresh: mdiRefresh,
            upload: mdiUpload,
        },
        settingsLoaded: false,
        userSettings: store.userSettings,
        isPWA: utils.checkStandalone(),
        restoreMessage: null,
        // AI tune summaries. The key is read out of its own localStorage slot,
        // never out of userSettings — see store.js.
        apiKeyInput: store.getApiKey(),
        showApiKey: false,
        aiUsage: store.getAiUsage(),
        aiSummaryCount: null,
        aiMessage: null,
        clearAiDialog: false,
    }),
    computed: {
        aiModelItems() {
            return Object.entries(AI_MODELS).map(([value, spec]) => ({
                value,
                text: spec.label,
            }));
        },
        aiModelHint() {
            const model = this.userSettings.aiSummaryModel || DEFAULT_AI_MODEL;
            const spec = AI_MODELS[model] || AI_MODELS[DEFAULT_AI_MODEL];
            return `$${spec.inputPerMTok.toFixed(2)} per million input tokens, ` +
                `$${spec.outputPerMTok.toFixed(2)} per million output — up to about ` +
                `${this.formatUsd(estimateCostPerNoteUsd(model))} per note, once per tune.`;
        },
        offlineReady() {
            if (this.offlineStatus === null) return null;
            return !!this.offlineStatus.manifest;
        },
        offlineSizeLabel() {
            const m = this.offlineStatus && this.offlineStatus.manifest;
            if (!m || !m.bytes) return 'size unknown';
            return formatBytes(m.bytes);
        },
        offlineSavedLabel() {
            const m = this.offlineStatus && this.offlineStatus.manifest;
            if (!m || !m.savedAt) return '';
            return ` — saved ${new Date(m.savedAt).toLocaleString()}`;
        },
        storageUsageLabel() {
            const st = this.offlineStatus && this.offlineStatus.storage;
            if (!st || !st.quota) return '';
            // Spell out which number is which. Usage is typically MB and quota
            // GB, so "45 MB of 38.4 GB used" reads as though the allowance were
            // the smaller of the two.
            return `${formatBytes(st.usage)} used · ${formatBytes(st.quota)} available`;
        },
        downloadPercent() {
            // Pushed in from _onIndexStatus — store.state is not reactive.
            const p = this.downloadProgress;
            if (!p || !p.total) return null;
            return Math.min(100, Math.round((p.received / p.total) * 100));
        },
        downloadPercentLabel() {
            return this.downloadPercent === null ? '' : ` ${this.downloadPercent}%`;
        },
        offlineStatusMessage() {
            const d = this.indexStatusDetail || {};
            if (d.persistError) {
                return `Could not save the offline copy: ${d.persistError}. Free up space on your device and try again.`;
            }
            if (d.legacy) {
                return 'Saved in an older storage format — tap "Update offline copy" to re-save it in the more robust format.';
            }
            if (this.indexStatus === 'unavailable') {
                return d.offline
                    ? 'Offline, and no copy is saved on this device.'
                    : 'Could not reach the tune database.';
            }
            return null;
        },
        localTuneDataLabel() {
            if (!this.localVersion) return this.offlineReady === false ? 'none' : 'loading…';
            const dateStr = this.localDate
                ? new Date(this.localDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
                : `v${this.localVersion}`;
            return `v${this.localVersion} · ${dateStr}`;
        },
        remoteTuneDataLabel() {
            if (!this.remoteMetadata) return 'checking…';
            if (this.remoteMetadata.unavailable) return 'unavailable (offline)';
            const { v, date } = this.remoteMetadata;
            const dateStr = date
                ? new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
                : `v${v}`;
            return `v${v} · ${dateStr}`;
        },
    },
    created: function() {
        this.ua = utils.checkUserAgent();
        this.currentUser = store.currentUser;
        this._onAuthStateChanged = user => { this.currentUser = user; };
        eventBus.$on('authStateChanged', this._onAuthStateChanged);
        this._onTuneIndexReady = () => {
            this.localVersion = store.state.tuneIndexVersion;
            this.localDate = store.state.tuneIndexDate;
        };
        eventBus.$on('tuneIndexReady', this._onTuneIndexReady);
        this._onIndexStatus = (detail) => {
            this.indexStatus = detail.status;
            this.indexStatusDetail = detail;
            this.downloadProgress = detail.status === 'downloading'
                ? { received: detail.received || 0, total: detail.total || 0 }
                : null;
            this.localVersion = store.state.tuneIndexVersion;
            this.localDate = store.state.tuneIndexDate;
            if (detail.status === 'ready' || detail.status === 'unavailable') {
                this._refreshOfflineStatus();
            }
        };
        eventBus.$on('indexStatusChanged', this._onIndexStatus);
        this._fetchRemoteMetadata();
        this._refreshOfflineStatus();
        this._refreshAiSummaryCount();
        // Ask for durable storage from a user-visible screen: some browsers
        // only grant it in response to engagement, and this is the page where
        // the user is explicitly thinking about offline use.
        if (navigator.storage && navigator.storage.persisted) {
            navigator.storage.persisted().then(async persisted => {
                if (!persisted && navigator.storage.persist) {
                    persisted = await navigator.storage.persist().catch(() => false);
                }
                this.storageIsPersistent = persisted;
            });
        } else {
            this.storageIsPersistent = false;
        }
    },
    beforeDestroy() {
        eventBus.$off('authStateChanged', this._onAuthStateChanged);
        eventBus.$off('tuneIndexReady', this._onTuneIndexReady);
        eventBus.$off('indexStatusChanged', this._onIndexStatus);
    },
    methods: {
        async _refreshOfflineStatus() {
            try {
                this.offlineStatus = await ffBackend.getOfflineStatus();
                const m = this.offlineStatus.manifest;
                if (m && m.v && !this.localVersion) {
                    this.localVersion = m.v;
                    this.localDate = m.date;
                }
            } catch (e) {
                console.warn('Could not read offline tune index status', e);
                this.offlineStatus = { manifest: null, storage: null };
            }
        },
        async _fetchRemoteMetadata() {
            // Bounded: an unbounded probe here would spin "checking…" forever
            // behind a captive portal.
            try {
                this.remoteMetadata = await fetchTuneIndexMetadata();
            } catch (e) {
                this.remoteMetadata = { unavailable: true };
            }
        },
        async saveOfflineCopy() {
            this.refreshingTuneData = true;
            this.refreshMessage = null;
            try {
                const result = await ffBackend.refreshTuneIndex();
                if (!result.ok) {
                    this.refreshMessage = result.error === 'You are offline.'
                        ? 'You are offline — the saved copy is unchanged.'
                        : `Could not download tune data: ${result.error}`;
                    return;
                }
                if (result.persistError) {
                    this.refreshMessage =
                        `Downloaded, but could not save it for offline use (${result.persistError}). ` +
                        'Free up space on your device and try again.';
                } else {
                    this.refreshMessage = `Offline copy saved (v${result.v}).`;
                }
                this.localVersion = result.v;
                this.localDate = result.date;
                await this._refreshOfflineStatus();
                await this._fetchRemoteMetadata();
            } catch (e) {
                this.refreshMessage = `Could not download tune data: ${e.message}`;
            } finally {
                this.refreshingTuneData = false;
            }
        },
        settingsChanged() {
            store.updateUserSettings(this.userSettings);
        },
        formatUsd(amount) {
            const value = Number(amount) || 0;
            if (value > 0 && value < 0.01) return '<$0.01';
            return `$${value.toFixed(2)}`;
        },
        async _refreshAiSummaryCount() {
            this.aiSummaryCount = await store.countAiSummaries();
        },
        onApiKeyChanged() {
            store.setApiKey(this.apiKeyInput);
            this.apiKeyInput = store.getApiKey();
            this.aiMessage = this.apiKeyInput
                ? 'API key saved on this device.'
                : 'API key removed.';
        },
        confirmClearAiSummaries() {
            this.clearAiDialog = true;
        },
        async clearAiSummaries() {
            this.clearAiDialog = false;
            await store.clearAiSummaries();
            await this._refreshAiSummaryCount();
            this.aiMessage = 'Saved background notes deleted.';
        },
        resetAiUsage() {
            store.resetAiUsage();
            this.aiUsage = store.getAiUsage();
            this.aiMessage = 'Usage counters reset.';
        },
        onMlTranscriberChanged() {
            store.updateUserSettings(this.userSettings);
            // Push to the worker/WASM now (and pre-build the model) so the next
            // recording uses the selected transcriber.
            ffBackend.setUseMlTranscriber(this.userSettings.useMlTranscriber)
                .catch(e => console.warn('Could not switch transcriber', e));
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

                // Wait for the WASM index to be ready before processing.
                // Resolves false (rather than hanging) when there is no index.
                if (!(await ffBackend.indexReady())) {
                    this.importError = true;
                    this.importStatus = 'The tune database is not available — connect to the internet and try again.';
                    return;
                }

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