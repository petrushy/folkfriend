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
            <v-row
                align="center"
                class="pl-2 pr-4 mt-2"
            >
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
            <!-- Asking for a constraint and getting it are different things,
                 and on an installed iPhone app there is no console to check
                 without a Mac and a cable. -->
            <p class="caption text--secondary mb-0 pl-2">
                <strong>Audio processing actually applied:</strong>
                <span v-if="!appliedAudioSettings">
                    unknown — record or listen once, then come back.
                </span>
                <span v-else>
                    echo cancellation {{ describeAudioSetting(appliedAudioSettings.echoCancellation) }},
                    noise suppression {{ describeAudioSetting(appliedAudioSettings.noiseSuppression) }},
                    auto gain {{ describeAudioSetting(appliedAudioSettings.autoGainControl) }}<span
                        v-if="appliedAudioSettings.sampleRate"
                    >, {{ appliedAudioSettings.sampleRate }} Hz</span>.
                </span>
                The app asks for echo cancellation and noise suppression to be off — they are
                speech processing, and they damage music — but the device decides.
            </p>
        </v-card>
        <v-card class="pa-5 my-2">
            <h1 class="pb-3">
                Sync
            </h1>
            <p>Sign in to keep your favourites and history in sync across devices.</p>
            <div v-if="currentUser">
                <v-row
                    align="center"
                    class="px-2 mb-2"
                >
                    <v-icon
                        left
                        color="success"
                    >
                        {{ icons.account }}
                    </v-icon>
                    <span>Signed in as <strong>{{ currentUser.email }}</strong></span>
                </v-row>
                <v-btn
                    :loading="signingOut"
                    @click="signOut"
                >
                    <v-icon left>
                        {{ icons.logout }}
                    </v-icon>
                    Sign out
                </v-btn>
            </div>
            <div v-else>
                <v-btn
                    :loading="signingIn"
                    @click="signIn"
                >
                    <v-icon left>
                        {{ icons.google }}
                    </v-icon>
                    Sign in with Google
                </v-btn>
                <p
                    v-if="authError"
                    class="mt-3 mb-0 error--text"
                >
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
            <v-btn
                :loading="importing"
                :disabled="!bookmarkUrl"
                @click="importFromTheSession"
            >
                <v-icon left>
                    {{ icons.import }}
                </v-icon>
                Import bookmarks
            </v-btn>
            <p
                v-if="importStatus"
                class="mt-3 mb-0"
                :class="importError ? 'error--text' : ''"
            >
                {{ importStatus }}
            </p>
        </v-card>
        <v-card class="pa-5 my-2">
            <h1 class="pb-3">
                Places
            </h1>
            <p>
                Records roughly where each tune was recognised, so you can see which session
                you first heard something at. The same tune is kept for every place you hear
                it, and you name a spot once — every hearing already logged nearby takes that
                name too.
            </p>
            <p class="caption text--secondary">
                One location fix is taken when a listening session starts, not a continuous
                track, so the battery cost is negligible beside running the microphone. While
                you are signed in these records sync to <strong>your own account</strong>, so
                an evening recorded on your phone is there on your other devices. They are
                also included in exported backups, so a backup file discloses where you have
                played.
            </p>
            <v-row>
                <v-switch
                    v-model="userSettings.geoTagDetections"
                    inset
                    label="Record where tunes are heard"
                    hint="Asks for location permission the first time you switch this on."
                    persistent-hint
                    class="my-0 pl-2"
                    @change="onGeoTaggingChanged"
                />
            </v-row>
            <p
                v-if="geoStatus"
                class="mt-3 mb-0"
                :class="geoError ? 'error--text' : 'text--secondary'"
            >
                {{ geoStatus }}
            </p>
            <v-row
                v-if="userSettings.geoTagDetections"
                class="mt-3 pl-2"
            >
                <v-btn
                    small
                    :loading="geoChecking"
                    @click="checkLocation"
                >
                    Test location
                </v-btn>
                <v-btn
                    small
                    text
                    to="/places"
                    class="ml-2"
                >
                    View places
                </v-btn>
            </v-row>
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
            <v-simple-table
                dense
                class="mt-5 mb-2"
            >
                <tbody>
                    <tr>
                        <td class="text--secondary pr-4">
                            Notes saved
                        </td>
                        <td>{{ aiSummaryCount === null ? 'checking…' : aiSummaryCount }}</td>
                    </tr>
                    <tr>
                        <td class="text--secondary pr-4">
                            API calls made
                        </td>
                        <td>{{ aiUsage.calls }}</td>
                    </tr>
                    <tr>
                        <td class="text--secondary pr-4">
                            Tokens used
                        </td>
                        <td>
                            {{ aiUsage.inputTokens.toLocaleString() }} in,
                            {{ aiUsage.outputTokens.toLocaleString() }} out
                        </td>
                    </tr>
                    <tr>
                        <td class="text--secondary pr-4">
                            Approximate spend
                        </td>
                        <td>{{ formatUsd(aiUsage.costUsd) }}</td>
                    </tr>
                </tbody>
            </v-simple-table>
            <p class="caption text--secondary">
                Spend is estimated from token counts at list prices, so treat it as a
                guide — your Anthropic console is the real figure.
            </p>
            <v-row class="px-2">
                <v-btn
                    class="mr-3 mb-2"
                    :disabled="!aiSummaryCount"
                    @click="confirmClearAiSummaries"
                >
                    Clear saved notes
                </v-btn>
                <v-btn
                    class="mb-2"
                    text
                    :disabled="!aiUsage.calls"
                    @click="resetAiUsage"
                >
                    Reset counters
                </v-btn>
            </v-row>
            <p
                v-if="aiMessage"
                class="mt-2 mb-0"
            >
                {{ aiMessage }}
            </p>
        </v-card>

        <v-dialog
            v-model="clearAiDialog"
            max-width="360"
        >
            <v-card>
                <v-card-title>Clear saved notes?</v-card-title>
                <v-card-text>
                    This deletes all {{ aiSummaryCount }} saved background notes on this
                    device and removes them from your synced favourites. Generating them
                    again will cost money again.
                </v-card-text>
                <v-card-actions>
                    <v-spacer />
                    <v-btn
                        text
                        @click="clearAiDialog = false"
                    >
                        Cancel
                    </v-btn>
                    <v-btn
                        text
                        color="red"
                        @click="clearAiSummaries"
                    >
                        Delete
                    </v-btn>
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
                <v-btn
                    class="mr-3 mb-2"
                    @click="downloadUserData"
                >
                    <v-icon left>
                        {{ icons.download }}
                    </v-icon>
                    Download User Data
                </v-btn>
                <v-btn
                    class="mb-2"
                    @click="$refs.restoreInput.click()"
                >
                    <v-icon left>
                        {{ icons.upload }}
                    </v-icon>
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
            <p
                v-if="restoreMessage"
                class="mt-2 mb-0"
            >
                {{ restoreMessage }}
            </p>
        </v-card>

        <v-card class="pa-5 my-2">
            <h1 class="pb-3">
                Offline Tune Database
            </h1>

            <v-alert
                v-if="offlineReady === false"
                dense
                text
                type="warning"
                class="mb-4"
            >
                {{ offlineSummary }}. Tune search will not work without a
                connection. Tap <strong>Save offline copy</strong> below while
                you have Wi-Fi.
            </v-alert>
            <v-alert
                v-else-if="offlineReady === true"
                dense
                text
                type="success"
                class="mb-4"
            >
                Ready to use offline — {{ offlineSummary }}{{ offlineSavedLabel }}.
            </v-alert>

            <p class="mb-2 text--secondary caption">
                Choose which tune databases are downloaded and searched. Turning
                one off does not delete its saved copy.
            </p>

            <div
                v-for="row in datasetRows"
                :key="row.id"
                class="datasetRow"
            >
                <v-checkbox
                    v-model="selectedDatasets"
                    :value="row.id"
                    :label="row.label"
                    :disabled="datasetBusy[row.id]"
                    dense
                    hide-details
                    class="mt-0 pt-0 datasetCheckbox"
                    @change="onDatasetToggled"
                />
                <div class="datasetMeta">
                    <span :class="row.statusClass">{{ row.statusText }}</span>
                    <v-btn
                        v-if="row.canRemove"
                        x-small
                        text
                        class="ml-1"
                        @click="confirmRemoveDataset(row)"
                    >
                        Remove
                    </v-btn>
                    <div class="caption text--secondary">
                        {{ row.description }}
                    </div>
                    <v-progress-linear
                        v-if="row.downloading"
                        :indeterminate="downloadPercent === null"
                        :value="downloadPercent || 0"
                        class="mt-1"
                        height="4"
                        rounded
                    />
                </div>
            </div>

            <div class="mb-3">
                <v-btn
                    small
                    text
                    @click="addDialog = true"
                >
                    <v-icon
                        left
                        small
                    >
                        {{ icons.plus }}
                    </v-icon>
                    Add a database
                </v-btn>
                <span class="caption text--secondary">
                    from a file or a link
                </span>
            </div>

            <v-simple-table
                dense
                class="mb-4 mt-3"
            >
                <tbody>
                    <tr>
                        <td class="text--secondary pr-4">
                            Storage
                        </td>
                        <td>
                            <span v-if="storageIsPersistent === null">checking…</span>
                            <span
                                v-else-if="storageIsPersistent"
                                class="success--text"
                            >protected from clearing</span>
                            <span
                                v-else
                                class="warning--text"
                            >may be cleared by browser</span>
                            <span
                                v-if="storageUsageLabel"
                                class="text--secondary"
                            >
                                · {{ storageUsageLabel }}
                            </span>
                        </td>
                    </tr>
                    <tr>
                        <td class="text--secondary pr-4">
                            In-memory index
                        </td>
                        <td>
                            <span
                                v-if="indexStatus === 'ready'"
                                class="success--text"
                            >
                                {{ inMemoryLabel }}
                            </span>
                            <span v-else-if="indexStatus === 'downloading'">
                                downloading{{ downloadPercentLabel }}…
                            </span>
                            <span
                                v-else-if="indexStatus === 'unavailable'"
                                class="warning--text"
                            >unavailable</span>
                            <span v-else>loading…</span>
                        </td>
                    </tr>
                    <tr v-if="offlineStatusMessage">
                        <td class="text--secondary pr-4">
                            Note
                        </td>
                        <td class="warning--text">
                            {{ offlineStatusMessage }}
                        </td>
                    </tr>
                </tbody>
            </v-simple-table>

            <p
                v-if="storageIsPersistent === false"
                class="mt-0 mb-4 caption"
            >
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
                <v-icon left>
                    {{ icons.download }}
                </v-icon>
                {{ offlineReady ? 'Update offline copies' : 'Save offline copy' }}
            </v-btn>
            <v-progress-linear
                v-if="refreshingTuneData || indexStatus === 'downloading'"
                :indeterminate="downloadPercent === null"
                :value="downloadPercent || 0"
                class="mt-3"
                height="6"
                rounded
            />
            <p
                v-if="refreshMessage"
                class="mt-3 mb-0"
            >
                {{ refreshMessage }}
            </p>

            <v-dialog
                v-model="addDialog"
                max-width="520"
            >
                <v-card>
                    <v-card-title class="text-h6">
                        Add a tune database
                    </v-card-title>
                    <v-card-text>
                        <p class="mb-4">
                            Not every database can be hosted by FolkFriend —
                            some collections may not be redistributed. If you
                            have a database file, or a link to one, you can add
                            it here.
                        </p>

                        <v-btn
                            small
                            outlined
                            class="mb-2"
                            @click="pickDatasetFile"
                        >
                            <v-icon
                                left
                                small
                            >
                                {{ icons.upload }}
                            </v-icon>
                            Choose a file…
                        </v-btn>
                        <input
                            ref="datasetFileInput"
                            type="file"
                            accept="application/json,.json"
                            class="hiddenFileInput"
                            @change="onDatasetFileChosen"
                        >

                        <p class="caption text--secondary mb-4">
                            A .json database file on this device.
                        </p>

                        <v-text-field
                            v-model="addDatasetUrl"
                            label="…or paste a link"
                            placeholder="https://example.com/my-tunes.json"
                            dense
                            :disabled="addingDataset"
                            hide-details="auto"
                        />
                        <p class="caption text--secondary mt-1 mb-0">
                            The link is saved so the database can be updated
                            from it later.
                        </p>

                        <v-alert
                            v-if="addDatasetError"
                            dense
                            text
                            type="warning"
                            class="mt-4 mb-0"
                        >
                            {{ addDatasetError }}
                        </v-alert>
                    </v-card-text>
                    <v-card-actions>
                        <v-spacer />
                        <v-btn
                            text
                            :disabled="addingDataset"
                            @click="closeAddDialog"
                        >
                            Cancel
                        </v-btn>
                        <v-btn
                            color="primary"
                            text
                            :loading="addingDataset"
                            :disabled="addingDataset || !addDatasetUrl"
                            @click="addDatasetFromUrl"
                        >
                            Add from link
                        </v-btn>
                    </v-card-actions>
                </v-card>
            </v-dialog>

            <v-dialog
                v-model="removeDialog"
                max-width="420"
            >
                <v-card v-if="removeTarget">
                    <v-card-title class="text-h6">
                        Remove {{ removeTarget.label }}?
                    </v-card-title>
                    <v-card-text>
                        This deletes its saved copy ({{ removeTarget.sizeLabel }})
                        from this device. You can download it again later, but
                        you will need a connection to do so.
                    </v-card-text>
                    <v-card-actions>
                        <v-spacer />
                        <v-btn
                            text
                            @click="removeDialog = false"
                        >
                            Cancel
                        </v-btn>
                        <v-btn
                            color="error"
                            text
                            @click="removeDataset"
                        >
                            Remove
                        </v-btn>
                    </v-card-actions>
                </v-card>
            </v-dialog>
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
                <p class="mb-1">
                    On iOS Safari,
                </p>
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
                <p class="mb-1">
                    On Chrome mobile,
                </p>
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
                <p class="mb-1">
                    On Chrome desktop,
                </p>
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
import store, { KNOWN_DATASETS } from '@/services/store.js';
import { DATASET_LABELS, DATASET_DESCRIPTIONS } from '@/js/source.mjs';
import ffBackend from '@/services/backend.js';
import geoService from '@/services/geo.js';
import micService from '@/services/mic.js';
import eventBus from '@/eventBus.js';
import utils from '@/js/utils.js';
import { fetchDatasetsManifest } from '@/services/tuneIndexNetwork.js';
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
    mdiPlus,
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
        // What the device actually applied the last time capture opened.
        // Read once: it only changes when a capture opens, and this panel is
        // not on screen then.
        appliedAudioSettings: micService.appliedAudioSettings,
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
        geoStatus: null,
        geoError: false,
        geoChecking: false,
        // datasets.json, or null while it is being fetched.
        datasetsRemote: null,
        // Bound to the checkbox column; kept in sync with userSettings.
        selectedDatasets: [...store.selectedDatasets()],
        // Manifests for EVERY known dataset, including deselected ones, so a
        // copy that is on disk but not in use can still be shown and removed.
        datasetInventory: null,
        datasetBusy: {},
        removeDialog: false,
        removeTarget: null,
        // Vue 2 only makes properties declared HERE reactive. Assigning them
        // for the first time in a method leaves the template bound to nothing,
        // so the dialog silently never opens.
        addDialog: false,
        addDatasetUrl: '',
        addDatasetError: null,
        addingDataset: false,
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
            plus: mdiPlus,
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
        // Human labels live in the app, keyed by dataset id — but a dataset
        // datasets.json lists and this build does not know about is still
        // rendered, selectable and installable, shown under its raw id with no
        // description. So a fourth source can be added without an app release,
        // provided its settings carry `source_url` (nothing else can derive a
        // link for it). Shipping a release adds the label and description.
        datasetRows() {
            const manifests = (this.datasetInventory && this.datasetInventory.datasets) || {};
            const detail = this.indexStatusDetail || {};
            const errors = detail.datasetErrors || {};

            const ids = [...KNOWN_DATASETS];
            for (const entry of (this.datasetsRemote || [])) {
                if (!ids.includes(entry.id)) ids.push(entry.id);
            }
            // An imported dataset is in neither list — that is what makes it
            // imported — so pick it up from what is actually saved and from
            // what the user has selected.
            for (const id of Object.keys(manifests)) {
                if (!ids.includes(id)) ids.push(id);
            }
            for (const id of this.selectedDatasets) {
                if (!ids.includes(id)) ids.push(id);
            }

            return ids.map(id => {
                const manifest = manifests[id] || null;
                // An imported dataset carries its own name in its manifest —
                // it has no datasets.json entry and this build may know nothing
                // about it. Falling straight through to the raw id showed the
                // user an opaque machine name moments after telling them
                // "Norbeck is ready".
                const label = DATASET_LABELS[id]
                    || (manifest && manifest.label)
                    || id;
                const description = DATASET_DESCRIPTIONS[id]
                    || ((manifest && manifest.origin === 'user')
                        ? `Added by you from a ${manifest.url ? 'link' : 'file'}`
                        : '');
                const remote = (this.datasetsRemote || []).find(e => e.id === id) || null;
                const selected = this.selectedDatasets.includes(id);
                const downloading = this.indexStatus === 'downloading'
                    && detail.dataset === id;
                const sizeLabel = manifest && manifest.bytes
                    ? formatBytes(manifest.bytes)
                    : (remote && remote.size ? formatBytes(remote.size) : '');

                let statusText;
                let statusClass = 'text--secondary';
                if (downloading) {
                    statusText = `downloading${this.downloadPercentLabel}`;
                } else if (!selected && manifest) {
                    statusText = `saved but not in use · ${sizeLabel}`;
                } else if (!selected) {
                    statusText = sizeLabel || '';
                } else if (manifest && remote && remote.v > manifest.v) {
                    statusText = `saved · v${manifest.v} — v${remote.v} available`;
                    statusClass = 'warning--text';
                } else if (manifest) {
                    statusText = `saved · v${manifest.v}${sizeLabel ? ` · ${sizeLabel}` : ''}`;
                    statusClass = 'success--text';
                } else if (errors[id]) {
                    statusText = `couldn't download: ${errors[id]}`;
                    statusClass = 'warning--text';
                } else if (this.datasetInventory === null) {
                    statusText = 'checking…';
                } else if (!navigator.onLine) {
                    statusText = 'not saved — will download when you\u2019re online';
                } else {
                    statusText = 'not saved';
                    statusClass = 'warning--text';
                }

                return {
                    id,
                    label,
                    description,
                    selected,
                    statusText,
                    statusClass,
                    sizeLabel,
                    downloading,
                    canRemove: !selected && !!manifest,
                };
            });
        },
        // Counts only the SELECTED datasets: a saved copy of something the user
        // has turned off does not make the app more usable offline.
        offlineReady() {
            if (this.datasetInventory === null) return null;
            const manifests = this.datasetInventory.datasets || {};
            const selected = this.selectedDatasets;
            if (selected.length === 0) return false;
            return selected.every(id => !!manifests[id]);
        },
        offlineSummary() {
            if (this.selectedDatasets.length === 0) {
                return 'No tune databases are selected';
            }
            if (this.datasetInventory === null) return 'checking…';
            const manifests = this.datasetInventory.datasets || {};
            const saved = this.selectedDatasets.filter(id => manifests[id]).length;
            return `${saved} of ${this.selectedDatasets.length} selected `
                + `database${this.selectedDatasets.length === 1 ? '' : 's'} saved`;
        },
        offlineSavedLabel() {
            const manifests = (this.datasetInventory && this.datasetInventory.datasets) || {};
            const times = this.selectedDatasets
                .map(id => manifests[id] && manifests[id].savedAt)
                .filter(Boolean);
            if (!times.length) return '';
            return ` — saved ${new Date(Math.max(...times)).toLocaleString()}`;
        },
        inMemoryLabel() {
            const loaded = ((this.indexStatusDetail || {}).datasetsLoaded || []).length;
            if (!loaded) return 'loaded';
            return `loaded (${loaded} database${loaded === 1 ? '' : 's'})`;
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
            if (d.migrationPending || d.legacy) {
                return 'Saved in an older storage format — it still works. '
                    + 'Tap "Update offline copies" to re-save it per database.';
            }
            const missing = (d.datasetsMissing || []).length;
            if (d.usable && missing) {
                return `${missing} selected database${missing === 1 ? ' is' : 's are'} `
                    + 'not saved yet, so some tunes will not be found.';
            }
            if (this.indexStatus === 'unavailable') {
                return d.offline
                    ? 'Offline, and no copy is saved on this device.'
                    : 'Could not reach the tune database.';
            }
            return null;
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
        // An absent key means the browser will not say, which is different
        // from "off" and must not be shown as off.
        describeAudioSetting(value) {
            if (value === undefined || value === null) return 'not reported';
            return value ? 'on' : 'off';
        },
        async _refreshOfflineStatus() {
            try {
                this.offlineStatus = await ffBackend.getOfflineStatus();
                // Read manifests for EVERY known dataset, not just the selected
                // ones, so a copy that is saved but turned off can still be
                // shown and removed.
                this.datasetInventory =
                    await ffBackend.getDatasetInventory(this._allDatasetIds());
            } catch (e) {
                console.warn('Could not read offline tune index status', e);
                this.offlineStatus = { datasets: {}, storage: null };
                this.datasetInventory = { datasets: {}, storage: null };
            }
        },
        // The permission prompt belongs here, on a deliberate tap in Settings —
        // never mid-session, over a tune, where the user cannot answer it and
        // the interruption costs them the recording.
        async onGeoTaggingChanged(enabled) {
            this.settingsChanged();
            this.geoStatus = null;
            this.geoError = false;
            if (!enabled) return;
            await this.checkLocation();
        },
        async checkLocation() {
            this.geoChecking = true;
            this.geoStatus = 'Checking location…';
            this.geoError = false;
            try {
                const result = await geoService.requestPermission();
                if (result.ok) {
                    const accuracy = result.fix.accuracy;
                    this.geoStatus = accuracy
                        ? `Location available, accurate to about ${accuracy} m.`
                        : 'Location available.';
                    this.geoError = false;
                } else {
                    // Deliberately not switched back off: the setting is the
                    // user's intent, and permission can be granted later in
                    // OS settings without them having to find this toggle again.
                    this.geoStatus = `${result.error} Tunes will still be logged, without a place.`;
                    this.geoError = true;
                }
            } finally {
                this.geoChecking = false;
            }
        },
        _allDatasetIds() {
            // The inventory ALSO reports anything else it finds stored, so a
            // dataset the user imported and then deselected still appears here
            // and can be re-enabled or removed. Without that it would vanish
            // from the UI while its 3 MB stayed on disk.
            const ids = [...KNOWN_DATASETS];
            for (const entry of (this.datasetsRemote || [])) {
                if (!ids.includes(entry.id)) ids.push(entry.id);
            }
            for (const id of this.selectedDatasets) {
                if (!ids.includes(id)) ids.push(id);
            }
            for (const id of Object.keys(
                (this.datasetInventory && this.datasetInventory.datasets) || {})) {
                if (!ids.includes(id)) ids.push(id);
            }
            return ids;
        },
        async _fetchRemoteMetadata() {
            // Bounded: an unbounded probe here would spin "checking…" forever
            // behind a captive portal.
            try {
                const { byId, order } = await fetchDatasetsManifest();
                this.datasetsRemote = order.map(id => byId.get(id));
            } catch (e) {
                this.datasetsRemote = [];
            }
        },
        // A dataset toggle must PUSH to the worker, not merely write
        // localStorage and wait for the next launch — the autoUpdateTuneData
        // switch does that and the worker only notices on the next setup. The
        // user has just asked for different tunes and expects them now.
        async onDatasetToggled() {
            const ids = [...this.selectedDatasets];
            this.userSettings.tuneDatasets = ids;
            await store.updateUserSettings(this.userSettings);
            this.refreshMessage = null;
            this.$set(this.datasetBusy, 'any', true);
            try {
                // The worker RESOLVES with {ok:false} rather than throwing, so
                // a bare try/catch here reported success on every failure and
                // the user got no message at all.
                const result = await ffBackend.setSelectedDatasets(ids);
                if (result && result.ok === false) {
                    this.refreshMessage =
                        `Could not load that database: ${result.error}. `
                        + 'It stays selected and will be retried.';
                }
            } catch (e) {
                // Deliberately NOT reverting the checkbox: the setting is the
                // user's intent, and it retries on the next launch or when the
                // connection comes back.
                console.warn('Could not apply the dataset selection', e);
                this.refreshMessage = `Could not load that database: ${e.message}`;
            } finally {
                this.$set(this.datasetBusy, 'any', false);
            }
            await this._refreshOfflineStatus();
        },
        closeAddDialog() {
            this.addDialog = false;
            this.addDatasetUrl = '';
            this.addDatasetError = null;
        },
        pickDatasetFile() {
            this.addDatasetError = null;
            this.$refs.datasetFileInput.click();
        },
        async onDatasetFileChosen(event) {
            const file = event.target.files && event.target.files[0];
            // Cleared immediately so picking the same file twice still fires.
            event.target.value = '';
            if (!file) return;
            await this._addDataset({ text: await file.text() },
                                   `Added ${file.name}`);
        },
        async addDatasetFromUrl() {
            if (!this.addDatasetUrl) return;
            await this._addDataset({ url: this.addDatasetUrl.trim() },
                                   'Added from the link');
        },
        async _addDataset(source, successPrefix) {
            this.addingDataset = true;
            this.addDatasetError = null;
            try {
                const result = await ffBackend.addUserDataset(source);
                if (!result.ok) {
                    this.addDatasetError = result.error;
                    return;
                }
                // The worker selected it; persist that so it survives a restart.
                if (!this.selectedDatasets.includes(result.id)) {
                    this.selectedDatasets = [...this.selectedDatasets, result.id];
                }
                this.userSettings.tuneDatasets = [...this.selectedDatasets];
                await store.updateUserSettings(this.userSettings);

                this.refreshMessage = result.persistError
                    ? `${successPrefix} (${result.label}), but it could not be `
                        + `saved for offline use: ${result.persistError}`
                    : `${successPrefix} — ${result.label} is ready.`;
                this.closeAddDialog();
                await this._refreshOfflineStatus();
            } catch (e) {
                this.addDatasetError = (e && e.message) || String(e);
            } finally {
                this.addingDataset = false;
            }
        },
        confirmRemoveDataset(row) {
            this.removeTarget = row;
            this.removeDialog = true;
        },
        async removeDataset() {
            const row = this.removeTarget;
            this.removeDialog = false;
            if (!row) return;
            this.$set(this.datasetBusy, row.id, true);
            try {
                await ffBackend.removeDataset(row.id);
                this.refreshMessage = `Removed the saved copy of ${row.label}.`;
            } catch (e) {
                this.refreshMessage = `Could not remove it: ${e.message}`;
            } finally {
                this.$set(this.datasetBusy, row.id, false);
                this.removeTarget = null;
                await this._refreshOfflineStatus();
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
                } else if (result.partial) {
                    const failed = Object.keys(result.failed || {}).join(', ');
                    const saved = Object.keys(result.installed || {}).length;
                    this.refreshMessage =
                        `Saved ${saved} database${saved === 1 ? '' : 's'}, but `
                        + `${failed} could not be downloaded.`;
                } else {
                    const saved = Object.keys(result.installed || {}).length;
                    this.refreshMessage =
                        `Offline cop${saved === 1 ? 'y' : 'ies'} saved (${saved}).`;
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
/* The real file input is driven by a styled button, so it must not be
   `display: none` — Safari will not open the picker for a hidden input. */
.hiddenFileInput {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
}

/* One dataset per row: checkbox on the left, status and description stacked
   beside it. Target is three readable lines, not a wall of table rows — the
   per-dataset status replaces what used to be separate "Saved version" and
   "Latest version" rows. */
.datasetRow {
    display: flex;
    align-items: flex-start;
    gap: 0.25rem;
    margin-bottom: 0.6rem;
}

.datasetCheckbox {
    flex: 0 0 auto;
    min-width: 10.5rem;
}

.datasetMeta {
    flex: 1 1 auto;
    min-width: 0;
    padding-top: 0.35rem;
    font-size: 0.85rem;
    /* Long error strings ("couldn't download: …") must wrap rather than push
       the row wider than the card. */
    overflow-wrap: anywhere;
}
</style>