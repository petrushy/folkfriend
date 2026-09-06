<template>
    <v-container class="viewContainerWrapper session-analysis">
        <h1 class="my-2">
            Session Analysis
        </h1>

        <!-- Three modes do not fit on one phone row, and v-btn-toggle does not
             wrap on its own — it just overflows the viewport. -->
        <v-btn-toggle
            :value="viewMode === 'file' ? 'file' : 'session'"
            @change="viewMode = $event === 'file' ? 'file' : lastSessionView"
            mandatory
            dense
            rounded
            class="mb-4 mode-toggle"
        >
            <v-btn value="file" small>
                File recording
            </v-btn>
            <v-btn value="session" small>
                <v-icon left small>{{ icons.microphone }}</v-icon>
                Sessions
            </v-btn>
        </v-btn-toggle>
        <v-btn text color="primary" class="mb-4" @click="openSessionPicker">Past sessions</v-btn>
        <v-btn text color="primary" class="mb-4" :disabled="workspaceBusy || !indexLoaded || live.starting" @click="newSession">New session</v-btn>

        <v-dialog v-model="sessionPicker" max-width="640">
            <v-card class="pa-5">
                <h2 class="text-h6 mb-3">Open a session</h2>
                <v-autocomplete v-if="sessionPicker"
                    :items="pastSessions" item-value="id" :item-text="sessionLabel" :filter="filterSession"
                    label="Search by name, date or place" clearable autofocus
                    :loading="pickerLoading" :menu-props="{ maxHeight: 320 }"
                    no-data-text="No saved sessions" @change="selectSession"
                />
                <p class="caption text--secondary">Opening a saved session keeps current listening running.</p>
                <v-btn text @click="sessionPicker = false">Close</v-btn>
            </v-card>
        </v-dialog>

        <v-card v-if="viewMode !== 'file' && activeSession" class="pa-5 my-3">
            <v-text-field :value="activeSession.name || sessionLabel(activeSession)" label="Session name"
                maxlength="160" hide-details class="mb-3" :disabled="workspaceBusy" @change="renameSession" />
            <p class="caption text--secondary">
                {{ formatSessionDate(activeSession.startedAt) }} · {{ formatSecondsAsDuration(activeListenedSeconds) }} listened.
                Changes are saved automatically.
            </p>
            <div class="d-flex flex-wrap" style="gap: 8px;">
                <v-btn v-if="viewMode === 'history' && live.hasSession" text color="primary" @click="viewMode = 'live'">Current session</v-btn>
                <v-menu offset-y>
                    <template #activator="{ on, attrs }">
                        <v-btn text small v-bind="attrs" v-on="on">Session actions</v-btn>
                    </template>
                    <v-list dense>
                        <v-list-item role="menuitem" :disabled="!activeDetections.length || workspaceBusy" @click="clearSessionTunes">
                            <v-list-item-title>Clear tune list</v-list-item-title>
                        </v-list-item>
                        <v-list-item role="menuitem" :disabled="workspaceBusy" @click="deleteSelectedSession">
                            <v-list-item-title class="error--text">Delete session</v-list-item-title>
                        </v-list-item>
                    </v-list>
                </v-menu>
            </div>
        </v-card>
        <v-alert v-if="workspaceError" type="error" dense text>
            {{ workspaceError }}
            <v-btn v-if="pendingSessionPatch" small text @click="retrySessionEdit">Retry save</v-btn>
        </v-alert>

        <!--
            The session's own status and controls live in SessionStatusBar,
            rendered by App.vue so they follow the user off this page. What
            stays here is the detail that only makes sense beside the tune
            list — the restore notice and the reduced-capability warning.
        -->
        <v-alert
            v-if="live.restoreError"
            type="warning"
            dense
            text
            class="my-3"
        >
            {{ live.restoreError }}
        </v-alert>

        <v-alert
            v-if="live.hasSession && !live.canResume"
            type="info"
            dense
            text
            class="my-3"
        >
            This session was restored after the app was reopened. Its tune list is complete and can be
            viewed and edited. Use New session to start another recording.
        </v-alert>

        <v-alert v-if="live.micError && viewMode === 'live'" type="error" dense text>{{ live.micError }}</v-alert>

        <v-card v-if="viewMode === 'file'" class="pa-5 my-3">
            <h2 class="text-h6 mb-3">
                Import
            </h2>
            <p class="mb-4">
                Drop a long recording to detect tune starts. Add a Transcribe! <code>.xsc</code> file if you also want to export updated markers.
            </p>

            <div
                class="drop-zone mb-4"
                :class="{ 'drop-zone--active': dragActive }"
                @dragenter.prevent="dragActive = true"
                @dragover.prevent="dragActive = true"
                @dragleave.prevent="dragActive = false"
                @drop.prevent="handleDrop"
            >
                <p class="mb-2">
                    Drag and drop files here
                </p>
                <div class="d-flex flex-wrap" style="gap: 12px;">
                    <v-btn color="primary" @click="$refs.audioInput.click()">
                        Choose Audio
                    </v-btn>
                    <v-btn text color="primary" @click="$refs.xscInput.click()">
                        Choose .xsc
                    </v-btn>
                </div>
                <input
                    ref="audioInput"
                    type="file"
                    accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg"
                    style="display:none"
                    @change="handleAudioInput"
                >
                <input
                    ref="xscInput"
                    type="file"
                    accept=".xsc,text/plain"
                    style="display:none"
                    @change="handleXscInput"
                >
            </div>

            <v-row>
                <v-col cols="12" md="6">
                    <div class="file-summary">
                        <div class="summary-label">
                            Audio
                        </div>
                        <div v-if="audioFile">
                            <strong>{{ audioFile.name }}</strong><br>
                            {{ formatFileSize(audioFile.size) }}
                        </div>
                        <div v-else class="text--secondary">
                            No audio file selected yet.
                        </div>
                    </div>
                </v-col>
                <v-col cols="12" md="6">
                    <div class="file-summary">
                        <div class="summary-label">
                            Transcribe! File
                        </div>
                        <div v-if="xscFile">
                            <strong>{{ xscFile.name }}</strong><br>
                            <span v-if="xscMetadata.linkedAudioFileName">
                                Links to: {{ xscMetadata.linkedAudioFileName }}
                            </span>
                            <span v-else class="text--secondary">
                                No linked audio filename found.
                            </span>
                        </div>
                        <div v-else class="text--secondary">
                            Optional.
                        </div>
                    </div>
                </v-col>
            </v-row>

            <v-alert
                v-if="fileWarning"
                type="warning"
                dense
                text
                class="mt-3 mb-0"
            >
                {{ fileWarning }}
            </v-alert>

            <v-alert
                type="info"
                dense
                text
                class="mt-3 mb-0"
            >
                This MVP decodes the uploaded audio inside the browser. Very large recordings can still be memory-heavy, especially compressed files such as big MP3 session captures.
            </v-alert>
        </v-card>

        <v-card v-else-if="viewMode === 'live' && !live.hasSession" class="pa-5 my-3">
            <h2 class="text-h6 mb-3">
                Live Microphone
            </h2>
            <p class="mb-0">
                <strong>Listen &amp; Follow</strong> starts listening and puts the score of whatever is being
                played on screen, switching as the session moves from tune to tune.
                Detected tunes are also listed in the table below as they are found.
            </p>
            <p class="mb-0 mt-2 text--secondary">
                A tune heard for less than {{ minPastDetectionSeconds }}s drops off the list once the next
                tune starts — brief mis-matches aren't kept. In Follow Score, the thumbs-down button
                removes the tune on screen and goes back to the previous detection.
            </p>
            <p class="mb-0 mt-2 text--secondary">
                <strong>Pause</strong> releases the microphone and keeps the session; <strong>Resume</strong>
                picks it up where it left off. Everything is saved automatically. <strong>New session</strong>
                starts a separate tune list. Listening carries on while you browse past sessions or other pages.
            </p>
        </v-card>

        <v-card v-if="viewMode === 'live' && live.capturing" class="pa-5 my-3">
            <div class="d-flex flex-wrap align-center" style="gap: 12px;">
                <v-btn color="primary" @click="followMode = true">
                    <v-icon left small>{{ icons.clef }}</v-icon>
                    Follow Score
                </v-btn>
                <VolumeMeter :active="live.micHealthy" />
                <span class="text--secondary">
                    Pause and Resume are in the session bar at the top of the screen — they stay
                    there wherever you navigate.
                </span>
            </div>
        </v-card>

        <!-- Live controls: only the ones that START a session. Everything for
             a session already open lives in the app-level session bar. -->
        <v-card v-if="viewMode === 'live' && !live.hasSession" class="pa-5 my-3">
            <div class="d-flex flex-wrap align-center" style="gap: 12px;">
                <v-btn
                    color="primary"
                    :disabled="!canStartLive"
                    :loading="live.starting"
                    @click="startListeningAndFollow"
                >
                    <v-icon left small>{{ icons.clef }}</v-icon>
                    Listen &amp; Follow
                </v-btn>
                <v-btn
                    color="grey darken-1"
                    text
                    :disabled="!canStartLive"
                    @click="startLiveAnalysis"
                >
                    Listen without score
                </v-btn>
                <div class="text--secondary">
                    Tune index: {{ indexStatusText }}
                </div>
            </div>



            <v-divider class="my-4" />

            <div class="d-flex flex-wrap align-center" style="gap: 16px;">
                <v-switch
                    v-model="customAnalysisSettings"
                    inset
                    hide-details
                    class="mt-0 pt-0"
                    label="Custom analysis settings"
                />
                <v-text-field
                    v-model.number="analysisSettings.windowSeconds"
                    :disabled="!customAnalysisSettings"
                    type="number"
                    min="3"
                    step="1"
                    dense
                    hide-details
                    label="Window (sec)"
                    style="max-width: 150px;"
                />
                <v-text-field
                    v-model.number="analysisSettings.stepSeconds"
                    :disabled="!customAnalysisSettings"
                    type="number"
                    min="1"
                    step="1"
                    dense
                    hide-details
                    label="Step (sec)"
                    style="max-width: 150px;"
                />
            </div>

            <p class="mt-2 mb-0 text--secondary">
                Leave this off for automatic defaults. Turn it on when you want finer or coarser scanning,
                including sparse non-continuous sampling.
            </p>
        </v-card>

        <!-- File controls, entirely independent of the live session. -->
        <v-card v-if="viewMode === 'file'" class="pa-5 my-3">
            <div class="d-flex flex-wrap align-center" style="gap: 12px;">
                <v-btn
                    color="secondary"
                    :disabled="!canAnalyzeFile"
                    @click="runFileAnalysis"
                >
                    Analyze Recording
                </v-btn>
                <v-btn
                    v-if="isFileAnalyzing"
                    text
                    color="secondary"
                    @click="cancelFileAnalysis"
                >
                    Stop
                </v-btn>
                <div class="text--secondary">
                    Tune index: {{ indexStatusText }}
                </div>
            </div>

            <v-divider class="my-4" />

            <div class="d-flex flex-wrap align-center" style="gap: 16px;">
                <v-switch
                    v-model="customAnalysisSettings"
                    inset
                    hide-details
                    class="mt-0 pt-0"
                    label="Custom analysis settings"
                />
                <v-text-field
                    v-model.number="analysisSettings.windowSeconds"
                    :disabled="!customAnalysisSettings"
                    type="number"
                    min="3"
                    step="1"
                    dense
                    hide-details
                    label="Window (sec)"
                    style="max-width: 150px;"
                />
                <v-text-field
                    v-model.number="analysisSettings.stepSeconds"
                    :disabled="!customAnalysisSettings"
                    type="number"
                    min="1"
                    step="1"
                    dense
                    hide-details
                    label="Step (sec)"
                    style="max-width: 150px;"
                />
            </div>

            <div v-if="file.stage !== 'idle'" class="mt-4">
                <div class="mb-2">
                    <strong>{{ fileStageLabel }}</strong>
                    <span v-if="file.progress.total > 0">
                        &middot; {{ file.progress.current }}/{{ file.progress.total }}
                    </span>
                </div>
                <v-progress-linear
                    :indeterminate="file.stage === 'decoding'"
                    :value="fileProgressPercent"
                    rounded
                />
                <p v-if="fileProgressLabel" class="mt-2 mb-0 text--secondary">
                    {{ fileProgressLabel }}
                </p>
            </div>

            <v-alert
                v-if="file.error"
                type="error"
                dense
                text
                class="mt-4 mb-0"
            >
                {{ file.error }}
            </v-alert>
        </v-card>

        <!-- Results. One table, but the two modes keep their own list. -->
        <v-card v-if="activeDetections.length" class="pa-5 my-3">
            <div class="d-flex flex-wrap justify-space-between align-center" style="gap: 12px;">
                <div>
                    <h2 class="text-h6 mb-1">
                        Detected Tune Starts
                    </h2>
                    <p class="mb-0 text--secondary">
                        {{ activeDetections.length }} tunes<span v-if="activeAcceptedWindows"> from {{ activeAcceptedWindows }} matched windows</span>.
                    </p>
                </div>
                <div class="d-flex flex-wrap" style="gap: 12px;">
                    <v-btn text color="primary" @click="downloadTuneList">
                        Download Tune List
                    </v-btn>
                    <v-btn
                        v-if="xscFile && viewMode === 'file'"
                        color="primary"
                        @click="downloadUpdatedXsc"
                    >
                        Export Updated .xsc
                    </v-btn>
                </div>
            </div>

            <v-simple-table class="mt-4 session-results">
                <template #default>
                    <thead>
                        <tr>
                            <th v-if="viewMode === 'file'" class="text-left">
                                Start
                            </th>
                            <th class="text-left">
                                Tune
                            </th>
                            <th class="text-left">
                                Duration
                            </th>
                            <th class="text-left">
                                Actions
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="detection in activeDetections" :key="detection.id">
                            <td v-if="viewMode === 'file'" class="start-cell">
                                <v-text-field
                                    v-model="detection.editableTime"
                                    aria-label="Tune start time"
                                    dense
                                    hide-details
                                    solo
                                />
                            </td>
                            <td>
                                <v-select
                                    v-model="detection.selectedTuneKey"
                                    aria-label="Tune"
                                    :items="detection.tuneOptions"
                                    item-text="text"
                                    item-value="value"
                                    dense
                                    hide-details
                                    solo
                                    :disabled="workspaceBusy"
                                    @change="onTuneChange(detection)"
                                />
                            </td>
                            <td class="duration-cell">
                                {{ formatSecondsAsDuration(detection.endSeconds - detection.startSeconds) }}
                            </td>
                            <td>
                                <div class="d-flex align-center" style="gap: 8px;">
                                    <v-btn icon small :aria-label="isTuneFavourited(detection) ? 'Remove favourite' : 'Add favourite'"
                                        @click="toggleFavourite(detection)">
                                        <v-icon small :color="isTuneFavourited(detection) ? 'amber darken-2' : 'grey'">
                                            {{ isTuneFavourited(detection) ? icons.star : icons.starOutline }}
                                        </v-icon>
                                    </v-btn>
                                    <v-btn
                                        icon
                                        small
                                        :to="tuneLinkForDetection(detection)"
                                        aria-label="Open tune"
                                    >
                                        <v-icon small>
                                            {{ icons.openInNew }}
                                        </v-icon>
                                    </v-btn>
                                    <v-btn text small color="secondary" :disabled="workspaceBusy" @click="removeDetection(detection.id)">
                                        Remove
                                    </v-btn>
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </template>
            </v-simple-table>

            <v-alert
                v-if="file.exportError && viewMode === 'file'"
                type="error"
                dense
                text
                class="mt-4 mb-0"
            >
                {{ file.exportError }}
            </v-alert>
        </v-card>

        <v-card
            v-else-if="viewMode === 'file' && file.stage === 'done'"
            class="pa-5 my-3"
        >
            <h2 class="text-h6 mb-2">
                No tune starts detected
            </h2>
            <p class="mb-0">
                The recording was analyzed, but no window produced a stable enough match to keep. This can happen with noisy starts, low melody prominence, or thresholds that are still too strict for the material.
            </p>
        </v-card>

        <v-card v-if="viewMode !== 'file' && activeSession && !activeDetections.length" class="pa-5 my-3">
            <h2 class="text-h6">No tunes in this session yet</h2>
            <p class="mb-0 text--secondary">{{ viewMode === 'live' ? 'The session is saved. Recognised tunes will appear here while listening.' : 'The session is saved with an empty tune list.' }}</p>
        </v-card>

        <LiveScoreFollow
            v-if="followMode"
            :detections="live.detections"
            @close="followMode = false"
        />
    </v-container>
</template>

<script>
import store from '@/services/store.js';
import eventBus from '@/eventBus.js';
import {
    mdiOpenInNew, mdiMicrophone, mdiMusicClefTreble, mdiStar, mdiStarOutline,
} from '@mdi/js';
import ffBackend from '@/services/backend.js';
import liveAnalysisService from '@/services/liveAnalysis.js';
import fileSessionAnalysisService from '@/services/fileSessionAnalysis.js';
import VolumeMeter from '@/components/VolumeMeter.vue';
import LiveScoreFollow from '@/components/LiveScoreFollow.vue';
import { clearLastShown } from '@/js/liveScoreFollow.mjs';
import {
    buildTuneListText,
    buildTuneOptions,
    buildUpdatedXsc,
    formatSecondsAsClock,
    formatSecondsAsDuration,
    parseClockTime,
    parseXscMetadata,
    tuneOptionValue,
    MIN_PAST_DETECTION_SECONDS,
} from '@/js/sessionAnalysis.js';

const SESSION_ANALYSIS_STATE_VERSION = 3;

const emptyFileState = () => ({
    detections: [],
    stage: 'idle',
    error: '',
    exportError: '',
    summary: { acceptedWindows: 0, durationSeconds: 0, options: null },
    progress: { current: 0, total: 0, currentTimeSeconds: 0 },
});

const emptyLiveState = () => ({
    detections: [],
    summary: { acceptedWindows: 0 },
    elapsedSeconds: 0,
    // A session exists (running or paused). Mirrors liveAnalysisService.sessionId.
    hasSession: false,
    sessionId: null,
    sessionName: '',
    startedAt: null,
    // The microphone is open and the loop is running.
    capturing: false,
    // A restored session with no stored analysis options can be read and
    // finished but not extended — see liveAnalysisService.canResume().
    canResume: true,
    micHealthy: true,
    micMessage: '',
    micError: '',
    restoreError: '',
    saveState: 'idle',
    saveError: null,
    starting: false,
    retryingMic: false,
    retryingSave: false,
});

export default {
    name: 'SessionAnalysisView',
    components: { VolumeMeter, LiveScoreFollow },
    data() {
        return {
            dragActive: false,
            indexLoaded: store.state.indexLoaded,
            audioFile: null,
            xscFile: null,
            xscText: '',
            xscMetadata: {
                linkedAudioFileName: '',
            },
            fileWarning: '',
            customAnalysisSettings: false,
            analysisSettings: {
                windowSeconds: 10,
                stepSeconds: 5,
            },
            // Live microphone is the default: the overwhelmingly common use is
            // pointing the phone at a session that is happening now. Importing a
            // file is the deliberate, occasional case, and restoreSavedState()
            // below switches back to it when there are saved file results.
            viewMode: 'live', // 'file' | 'live' | 'history'
            lastSessionView: 'live',
            // The two analyses keep their own results, progress and errors.
            // They used to share one set of fields, so starting one wiped the
            // other's results and the "stage" of whichever ran last decided
            // what BOTH panels displayed.
            file: emptyFileState(),
            live: emptyLiveState(),
            followMode: false,
            pastSessions: [],
            selectedSession: null,
            savedDetections: [],
            sessionPicker: false,
            pickerLoading: false,
            workspaceBusy: false,
            workspaceError: '',
            pendingSessionPatch: null,
            // settingIDs of favourited tunes, for the stars in Past Sessions.
            favouriteSettingIDs: [],
            icons: {
                openInNew: mdiOpenInNew,
                microphone: mdiMicrophone,
                clef: mdiMusicClefTreble,
                star: mdiStar,
                starOutline: mdiStarOutline,
            },
        };
    },
    watch: {
        // Switching tabs is navigation, not a lifecycle event. It never stops
        // the microphone and never touches either set of results — the live
        // session carries on exactly as it does when the user navigates to a
        // different route entirely.
        '$route.query.live'(value) {
            if (value === '1') this.viewMode = 'live';
        },
        viewMode(newVal) {
            if (newVal !== 'file') this.lastSessionView = newVal;
            if (newVal !== 'live') this.followMode = false;
            if (newVal === 'history') this.refreshPastSessions();
        },
    },
    computed: {
        minPastDetectionSeconds() {
            return MIN_PAST_DETECTION_SECONDS;
        },
        activeDetections() {
            if (this.viewMode === 'history') return this.savedDetections;
            return this.viewMode === 'file' ? this.file.detections : this.live.detections;
        },
        activeSession() {
            if (this.viewMode === 'history') return this.selectedSession;
            if (!this.live.hasSession) return null;
            return {
                id: this.live.sessionId, name: this.live.sessionName,
                startedAt: this.live.startedAt, listenedSeconds: this.live.elapsedSeconds,
            };
        },
        activeListenedSeconds() {
            return this.activeSession ? this.listenedSeconds(this.activeSession) : 0;
        },
        activeAcceptedWindows() {
            if (this.viewMode === 'history') return 0;
            return this.viewMode === 'file'
                ? this.file.summary.acceptedWindows
                : this.live.summary.acceptedWindows;
        },
        canStartLive() {
            return !this.live.hasSession && !this.live.starting && this.indexLoaded;
        },
        canAnalyzeFile() {
            return !!this.audioFile && !this.isFileAnalyzing && this.indexLoaded;
        },
        isFileAnalyzing() {
            return this.file.stage === 'decoding' || this.file.stage === 'analyzing';
        },
        indexStatusText() {
            return this.indexLoaded ? 'ready' : 'loading…';
        },
        fileStageLabel() {
            if (this.file.stage === 'decoding') return 'Decoding audio';
            if (this.file.stage === 'analyzing') return 'Scanning windows';
            if (this.file.stage === 'done') return 'Analysis complete';
            return '';
        },
        fileProgressPercent() {
            if (!this.file.progress.total) return 0;
            return (this.file.progress.current / this.file.progress.total) * 100;
        },
        fileProgressLabel() {
            if (this.file.stage === 'analyzing') {
                return `Around ${formatSecondsAsClock(this.file.progress.currentTimeSeconds)} of the recording`;
            }
            if (this.file.stage === 'decoding' && this.audioFile) {
                return `Preparing ${this.audioFile.name}`;
            }
            return '';
        },
    },
    created() {
        this._pcm = null;
        // Set by beforeDestroy so an in-flight restore cannot act on a view
        // the user has already left.
        this._destroyed = false;
        // Set when ?follow=1 asked for a session that could not be started yet
        // because the tune index was still loading. Non-reactive: nothing
        // renders it.
        this._autoFollowPending = false;

        // Index
        // The auto-start below cannot run before the tune index is usable
        // (canStartLive is false), and arriving from a cold start it usually is
        // not — so this is also the retry point, not just a flag flip.
        this._onOpenCurrent = () => { this.viewMode = 'live'; this._syncLiveFromService(); };
        eventBus.$on('openCurrentSession', this._onOpenCurrent);
        this._onIndexLoaded = () => {
            this.indexLoaded = true;
            this._runPendingAutoFollow();
        };

        // Live analysis events
        this._onLiveUpdate = (detections) => {
            this.live.detections = detections.map(d => this._buildDetectionRow(d));
            this.live.summary.acceptedWindows = liveAnalysisService._windowMatches.length;
        };
        this._onLiveTimerTick = (secs) => { this.live.elapsedSeconds = secs; };
        this._onLiveStopped = () => {
            this.live.capturing = false;
            this.followMode = false;
            this.live.hasSession = !!liveAnalysisService.sessionId;
        };
        this._onLiveFinished = () => {
            this.live = emptyLiveState();
        };
        this._onLiveRestored = (detections) => {
            this._syncLiveFromService();
            this.live.detections = detections.map(d => this._buildDetectionRow(d));
        };
        this._onLiveMicState = ({ healthy, reason }) => {
            this.live.micHealthy = healthy;
            this.live.micMessage = healthy ? '' : (reason || this.live.micMessage);
        };
        this._onLiveSaveState = ({ state, error }) => {
            this.live.sessionName = liveAnalysisService.sessionName;
            this.live.saveState = state;
            this.live.saveError = error;
        };
        // Past Sessions
        this._onLiveSessionsChanged = () => {
            if (this.viewMode === 'history') this.refreshPastSessions();
        };

        // File analysis events
        this._onFileStage = (stage) => {
            this.file.stage = stage;
            if (stage === 'done' || stage === 'idle') this.persistState();
        };
        this._onFileOptions = ({ windowSeconds, stepSeconds, durationSeconds }) => {
            this.analysisSettings.windowSeconds = windowSeconds;
            this.analysisSettings.stepSeconds = stepSeconds;
            this.file.summary.durationSeconds = durationSeconds;
        };
        this._onFileProgress = ({ current, total, currentTimeSeconds, acceptedWindows }) => {
            this.file.progress = { current, total, currentTimeSeconds };
            this.file.summary.acceptedWindows = acceptedWindows;
        };
        this._onFileUpdate = (detections, acceptedWindows) => {
            this.file.detections = detections.map(d => this._buildDetectionRow(d));
            this.file.summary.acceptedWindows = acceptedWindows;
        };
        this._onFileError = (message) => { this.file.error = message; };

        eventBus.$on('indexLoaded', this._onIndexLoaded);
        eventBus.$on('liveAnalysisUpdate', this._onLiveUpdate);
        eventBus.$on('liveAnalysisTimerTick', this._onLiveTimerTick);
        eventBus.$on('liveAnalysisStopped', this._onLiveStopped);
        eventBus.$on('liveAnalysisFinished', this._onLiveFinished);
        eventBus.$on('liveAnalysisRestored', this._onLiveRestored);
        eventBus.$on('liveAnalysisMicState', this._onLiveMicState);
        eventBus.$on('liveAnalysisSaveState', this._onLiveSaveState);
        eventBus.$on('liveSessionsChanged', this._onLiveSessionsChanged);
        eventBus.$on('fileAnalysisStage', this._onFileStage);
        eventBus.$on('fileAnalysisOptions', this._onFileOptions);
        eventBus.$on('fileAnalysisProgress', this._onFileProgress);
        eventBus.$on('fileAnalysisUpdate', this._onFileUpdate);
        eventBus.$on('fileAnalysisError', this._onFileError);

        if (store.state.sessionWorkspace) {
            const saved = store.state.sessionWorkspace;
            this.selectedSession = saved.session;
            this.savedDetections = saved.detections;
            this.pendingSessionPatch = saved.pending;
        }
        this.refreshPastSessions();
        this._initialise();
        eventBus.$emit('parentViewActivated');
    },
    beforeDestroy() {
        this._pcm = null;
        this._destroyed = true;
        store.state.sessionWorkspace = this.selectedSession && (this.viewMode === 'history' || this.pendingSessionPatch) ? {
            session: this.selectedSession, detections: this.savedDetections,
            pending: this.pendingSessionPatch,
        } : null;
        // Withdraws a ?follow=1 auto-start that has not fired yet. The
        // eventBus unsubscribe below covers a late indexLoaded, but not the
        // $nextTick callback created() already queued — that one holds its own
        // reference and would open a microphone for a view that is gone.
        this._autoFollowPending = false;
        // File analysis is cancelled on navigation (unlike live, which continues in background)
        if (fileSessionAnalysisService.isRunning) {
            fileSessionAnalysisService.cancel();
        }
        eventBus.$off('openCurrentSession', this._onOpenCurrent);
        eventBus.$off('indexLoaded', this._onIndexLoaded);
        eventBus.$off('liveAnalysisUpdate', this._onLiveUpdate);
        eventBus.$off('liveAnalysisTimerTick', this._onLiveTimerTick);
        eventBus.$off('liveAnalysisStopped', this._onLiveStopped);
        eventBus.$off('liveAnalysisFinished', this._onLiveFinished);
        eventBus.$off('liveAnalysisRestored', this._onLiveRestored);
        eventBus.$off('liveAnalysisMicState', this._onLiveMicState);
        eventBus.$off('liveAnalysisSaveState', this._onLiveSaveState);
        eventBus.$off('liveSessionsChanged', this._onLiveSessionsChanged);
        eventBus.$off('fileAnalysisStage', this._onFileStage);
        eventBus.$off('fileAnalysisOptions', this._onFileOptions);
        eventBus.$off('fileAnalysisProgress', this._onFileProgress);
        eventBus.$off('fileAnalysisUpdate', this._onFileUpdate);
        eventBus.$off('fileAnalysisError', this._onFileError);
        this.persistState();
    },
    methods: {
        // Decides what the view opens on, in priority order: a live session
        // that is already running, an explicit ?live/?follow request, a session
        // left unfinished by a previous run of the app, then saved file work.
        async _initialise() {
            if (this.selectedSession && !this._routeWantsLive()) {
                this.viewMode = 'history';
                this._syncLiveFromService();
                return;
            }
            if (liveAnalysisService.sessionId) {
                this.viewMode = 'live';
                this._syncLiveFromService();
                if (this._routeWantsFollow() && this.live.capturing) this.followMode = true;
                return;
            }

            // RESTORE FIRST, including on the one-tap entry points.
            //
            // ?live=1 / ?follow=1 is the shortcut people actually use to start
            // listening, so resolving it before looking for an unfinished
            // session is precisely the path that would silently orphan last
            // night's — a new session would open beside it and the old one
            // would sit in Past Sessions labelled Unfinished for ever. Recovery
            // has to be offered on every route into the view or it may as well
            // not exist.
            let restored = false;
            try {
                restored = await liveAnalysisService.restoreOpenSession();
            } catch (e) {
                // A failed read is not "no session" — say so rather than
                // starting a second session on top of one we cannot see.
                console.warn('Could not check for an unfinished session:', e && e.message);
                this.live.restoreError =
                    'Could not check for an unfinished session. Starting a new one may leave it behind.';
            }

            // The view may have been left, or a session started, while that
            // read was in flight.
            if (this._destroyed) return;
            if (restored) {
                this.viewMode = 'live';
                this._syncLiveFromService();
                // An unfinished session is NOT resumed automatically, even by
                // ?follow=1: continuing last night's evening is a decision, not
                // something a deep link should make. The bar offers Resume and
                // New session, and ?follow=1 waits for that answer.
                if (this._routeWantsLive()) this._autoFollowPending = false;
                return;
            }

            if (this._routeWantsLive()) {
                // ?follow=1 is the one-tap "show me what is playing" entry
                // point: start listening and open the score, with no further
                // taps. Deferred one tick so the view is on screen before the
                // microphone is opened — a permission refusal has to land on a
                // rendered page, not on one that has not mounted yet.
                this.viewMode = 'live';
                if (this._routeWantsFollow()) {
                    this._autoFollowPending = true;
                    this.$nextTick(() => this._runPendingAutoFollow());
                }
                return;
            }

            // Saved file results outrank the live default — landing on an empty
            // microphone panel having previously analysed a recording reads as
            // the results having been lost.
            const saved = store.state.sessionAnalysis;
            if (saved && (saved.audioFile || (saved.detections && saved.detections.length))) {
                this.viewMode = 'file';
                this.restoreSavedState();
            }
        },
        // Mirrors liveAnalysisService's state into this component. Called on
        // mount and after any lifecycle change that the events do not fully
        // describe.
        _syncLiveFromService() {
            const svc = liveAnalysisService;
            this.live.hasSession = !!svc.sessionId;
            this.live.sessionId = svc.sessionId;
            this.live.sessionName = svc.sessionName;
            this.live.startedAt = svc._sessionStartedAt;
            if (!svc.sessionId) return;
            this.live.capturing = svc.isRunning;
            this.live.canResume = svc.canResume();
            this.live.elapsedSeconds = svc.elapsedSeconds;
            this.live.micHealthy = svc.micHealthy;
            this.live.saveState = svc.saveState;
            this.live.saveError = svc.saveError;
            this.live.detections = svc.detections.map(d => this._buildDetectionRow(d));
            this.live.summary.acceptedWindows = svc._windowMatches.length;
        },
        restoreSavedState() {
            const saved = store.state.sessionAnalysis;
            if (!saved) return;
            if (saved.version !== SESSION_ANALYSIS_STATE_VERSION) {
                store.clearSessionAnalysisState();
                this.file.error = 'Saved Session Analysis results were from an older format and have been cleared. Please run the analysis again.';
                return;
            }

            this.audioFile = saved.audioFile || null;
            this.xscFile = saved.xscFile || null;
            this.xscText = saved.xscText || '';
            this.xscMetadata = saved.xscMetadata || { linkedAudioFileName: '' };
            this.fileWarning = saved.fileWarning || '';
            this.customAnalysisSettings = !!saved.customAnalysisSettings;
            this.analysisSettings = saved.analysisSettings || {
                windowSeconds: 10,
                stepSeconds: 5,
            };
            this.file.stage = saved.analysisStage || 'idle';
            this.file.error = saved.analysisError || '';
            this.file.exportError = saved.exportError || '';
            this.file.detections = saved.detections || [];
            this.file.summary = saved.analysisSummary || {
                acceptedWindows: 0,
                durationSeconds: 0,
                options: null,
            };
            this.file.progress = saved.progress || {
                current: 0,
                total: 0,
                currentTimeSeconds: 0,
            };

            if (this.file.stage === 'decoding' || this.file.stage === 'analyzing') {
                this.file.stage = this.file.detections.length ? 'done' : 'idle';
                if (!this.file.error && !this.file.detections.length) {
                    this.file.error = 'Analysis was interrupted. Please run it again if needed.';
                }
            }
        },
        persistState() {
            store.setSessionAnalysisState({
                version: SESSION_ANALYSIS_STATE_VERSION,
                audioFile: this.audioFile,
                xscFile: this.xscFile,
                xscText: this.xscText,
                xscMetadata: this.xscMetadata,
                fileWarning: this.fileWarning,
                analysisStage: this.file.stage,
                analysisError: this.file.error,
                exportError: this.file.exportError,
                customAnalysisSettings: this.customAnalysisSettings,
                analysisSettings: { ...this.analysisSettings },
                detections: this.file.detections.map(detection => ({ ...detection })),
                analysisSummary: { ...this.file.summary },
                progress: { ...this.file.progress },
            });
        },
        formatFileSize(bytes) {
            if (!bytes) return '0 MB';
            const mb = bytes / (1024 * 1024);
            return `${mb.toFixed(1)} MB`;
        },
        handleAudioInput(event) {
            const [file] = event.target.files || [];
            if (file) {
                this.setAudioFile(file);
            }
            event.target.value = '';
        },
        async handleXscInput(event) {
            const [file] = event.target.files || [];
            if (file) {
                await this.setXscFile(file);
            }
            event.target.value = '';
        },
        async handleDrop(event) {
            this.dragActive = false;
            const files = Array.from(event.dataTransfer.files || []);
            const audioFile = files.find(file => this.isAudioFile(file));
            const xscFile = files.find(file => /\.xsc$/i.test(file.name));

            if (audioFile) {
                this.setAudioFile(audioFile);
            }
            if (xscFile) {
                await this.setXscFile(xscFile);
            }
        },
        isAudioFile(file) {
            return !!file && (
                (file.type && file.type.startsWith('audio/')) ||
                /\.(mp3|wav|m4a|aac|ogg)$/i.test(file.name)
            );
        },
        setAudioFile(file) {
            if (fileSessionAnalysisService.isRunning) fileSessionAnalysisService.cancel();
            this.audioFile = file;
            this.resetFileResults();
            this.updateFileWarning();
            this.persistState();
        },
        async setXscFile(file) {
            this.xscFile = file;
            this.xscText = await file.text();
            this.xscMetadata = parseXscMetadata(this.xscText);
            this.resetFileResults();
            this.updateFileWarning();
            this.persistState();
        },
        updateFileWarning() {
            if (this.audioFile && this.xscMetadata.linkedAudioFileName && this.audioFile.name !== this.xscMetadata.linkedAudioFileName) {
                this.fileWarning = `The .xsc links to ${this.xscMetadata.linkedAudioFileName}, but the selected audio file is ${this.audioFile.name}. You can still analyze, but marker export may target the wrong recording.`;
                return;
            }
            this.fileWarning = '';
        },
        resetFileResults() {
            this.file = emptyFileState();
        },

        // ---- live session controls ----------------------------------------

        async startLiveAnalysis() {
            this.live.micError = '';
            const resuming = !!liveAnalysisService.sessionId;
            if (!resuming) {
                // A fresh session's first detection can coincidentally share a
                // tuneId with whatever the follow overlay last showed, which
                // would otherwise read as "same tune, no reload needed" and
                // could also resurrect a stale manual override.
                clearLastShown();
                this.live = emptyLiveState();
            }
            this.live.starting = true;

            const windowSeconds = Number(this.analysisSettings.windowSeconds) || 10;
            const stepSeconds = Number(this.analysisSettings.stepSeconds) || 10;

            try {
                await liveAnalysisService.start(windowSeconds, stepSeconds);
            } catch (e) {
                this.live.micError = `Could not access microphone: ${e.message || 'please check permissions'}. Your session is kept; use Resume to retry.`;
            } finally {
                this.live.starting = false;
                this._syncLiveFromService();
            }
        },
        // Start listening and put the score on screen in one action.
        async startListeningAndFollow() {
            await this.startLiveAnalysis();
            // Only on success: opening a full-screen overlay over a microphone
            // that never opened would hide the error explaining why.
            if (this.live.capturing) this.followMode = true;
        },
        resumeLive() {
            return this.startLiveAnalysis();
        },
        async pauseLive() {
            await liveAnalysisService.pause();
            this._syncLiveFromService();
        },
        async retryMicrophone() {
            this.live.retryingMic = true;
            try {
                await liveAnalysisService.retryMicrophone();
            } finally {
                this.live.retryingMic = false;
                this._syncLiveFromService();
            }
        },
        async retrySave() {
            this.live.retryingSave = true;
            try {
                await liveAnalysisService._persistSession();
            } finally {
                this.live.retryingSave = false;
                this._syncLiveFromService();
            }
        },

        // ---- file analysis controls ---------------------------------------

        async runFileAnalysis() {
            if (!this.audioFile) return;
            this.file.error = '';
            this.file.exportError = '';
            this.file.detections = [];
            this.file.summary.acceptedWindows = 0;
            this.file.progress = { current: 0, total: 0, currentTimeSeconds: 0 };
            await fileSessionAnalysisService.start(this.audioFile, {
                customAnalysisSettings: this.customAnalysisSettings,
                windowSeconds: this.analysisSettings.windowSeconds,
                stepSeconds: this.analysisSettings.stepSeconds,
            });
        },
        cancelFileAnalysis() {
            fileSessionAnalysisService.cancel();
        },

        // ---- shared detection table ---------------------------------------

        _buildDetectionRow(detection) {
            const tuneOptions = buildTuneOptions(detection);
            const selectedTuneKey = tuneOptionValue({
                tuneId: detection.tuneId,
                settingId: detection.settingId,
                sourceUrl: detection.sourceUrl,
                title: detection.title,
            });
            const selected = tuneOptions.find(o => o.value === selectedTuneKey) || tuneOptions[0] || null;
            return {
                ...detection,
                editableTime: formatSecondsAsClock(detection.startSeconds),
                selectedTuneKey,
                tuneOptions,
                selectedTuneId: selected ? selected.tuneId : detection.tuneId,
                selectedSettingId: selected ? selected.settingId : (detection.settingId ? String(detection.settingId) : ''),
                selectedSourceUrl: selected ? (selected.sourceUrl || '') : (detection.sourceUrl || ''),
                selectedTitle: selected ? selected.title : (detection.title || ''),
            };
        },
        _routeWantsLive() {
            if (!this.$route) return false;
            return this.$route.query.live === '1' || this.$route.query.follow === '1';
        },
        _routeWantsFollow() {
            return !!this.$route && this.$route.query.follow === '1';
        },
        // Runs the ?follow=1 auto-start, or remembers it for the moment the
        // index becomes usable. Called again from the indexLoaded handler.
        _runPendingAutoFollow() {
            if (!this._autoFollowPending || this._destroyed) return;
            // A session may have been restored, or started by hand, while this
            // was waiting for the tune index.
            if (liveAnalysisService.sessionId) {
                this._autoFollowPending = false;
                this._syncLiveFromService();
                return;
            }
            if (!this.canStartLive) return;
            this._autoFollowPending = false;
            this.startListeningAndFollow();
        },
        removeDetection(id) {
            // Route through the service so the underlying window matches are
            // dropped — otherwise the next re-cluster (live every stepSeconds,
            // file during a still-running analysis) brings the row back.
            if (this.viewMode === 'file') {
                fileSessionAnalysisService.removeDetection(id);
                this.file.detections = this.file.detections.filter(d => d.id !== id);
                this.persistState();
                return;
            }
            if (this.viewMode === 'history') {
                this.savedDetections = this.savedDetections.filter(d => d.id !== id);
                return this.saveSessionEdit({ tunes: this.savedTunes() });
            }
            liveAnalysisService.removeDetection(id);
            this._syncLiveFromService();
        },
        selectedOptionForDetection(detection) {
            return detection.tuneOptions.find(option => option.value === detection.selectedTuneKey) || detection.tuneOptions[0] || null;
        },
        tuneLinkForDetection(detection) {
            const selected = this.selectedOptionForDetection(detection);
            return {
                name: 'tune',
                query: {
                    tuneID: String((selected && selected.tuneId) || detection.tuneId || ''),
                    settingID: String((selected && selected.settingId) || detection.settingId || ''),
                    displayName: (selected && selected.title) || detection.title,
                },
            };
        },
        syncSelectedTune(detection) {
            const selected = this.selectedOptionForDetection(detection);
            if (!selected) return;
            detection.selectedTuneId = selected.tuneId;
            detection.selectedSettingId = selected.settingId;
            detection.selectedSourceUrl = selected.sourceUrl || '';
            detection.selectedTitle = selected.title;
        },
        onTuneChange(detection) {
            this.syncSelectedTune(detection);
            if (this.viewMode === 'file') {
                this.persistState();
                return;
            }
            if (this.viewMode === 'history') {
                return this.saveSessionEdit({ tunes: this.savedTunes() });
            }
            // A live correction has to reach the SERVICE, which owns the list
            // that gets saved. Left in the component it was overwritten by the
            // next detection update and never reached Past Sessions at all.
            liveAnalysisService.applyCorrection(detection.id, {
                tuneId: detection.selectedTuneId,
                settingId: detection.selectedSettingId,
                title: detection.selectedTitle,
                sourceUrl: detection.selectedSourceUrl,
                dataset: detection.dataset,
            });
        },

        sessionLabel(session) {
            const date = this.formatSessionDate(session.startedAt);
            return session.name || (session.placeName ? `${date} · ${session.placeName}` : date);
        },
        filterSession(session, query) {
            return [this.sessionLabel(session), this.formatSessionDate(session.startedAt), session.placeName || '']
                .join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase());
        },
        async openSessionPicker() {
            this.sessionPicker = true;
            this.pickerLoading = true;
            try { await this.refreshPastSessions(); }
            finally { this.pickerLoading = false; }
        },
        selectSession(id) {
            if (!id || this.workspaceBusy) return;
            if (this.pendingSessionPatch) {
                this.workspaceError = 'Save your pending changes before opening another session.';
                return;
            }
            const session = this.pastSessions.find(s => s.id === id);
            if (!session) return;
            this.sessionPicker = false;
            this.workspaceError = '';
            if (this.isOpenSession(session)) {
                this.viewMode = 'live';
                this._syncLiveFromService();
                return;
            }
            this.selectedSession = { ...session };
            this.savedDetections = (session.tunes || []).map((tune, index) =>
                this._buildDetectionRow({ ...tune, id: `saved-${index}` }));
            this.viewMode = 'history';
        },
        savedTunes() {
            return this.savedDetections.map(d => ({
                tuneId: d.selectedTuneId, settingId: d.selectedSettingId,
                title: d.selectedTitle, sourceUrl: d.selectedSourceUrl,
                dataset: d.dataset || '', startSeconds: d.startSeconds,
                endSeconds: d.endSeconds, bestScore: d.bestScore || 0,
                alternatives: d.alternatives || [],
            }));
        },
        async saveSessionEdit(patch) {
            const id = this.selectedSession.id;
            this.pendingSessionPatch = { id, patch: { ...(this.pendingSessionPatch ? this.pendingSessionPatch.patch : {}), ...patch } };
            return this.retrySessionEdit();
        },
        async retrySessionEdit() {
            if (!this.pendingSessionPatch || this.workspaceBusy) return;
            this.workspaceBusy = true;
            this.workspaceError = '';
            const pending = this.pendingSessionPatch;
            try {
                const saved = await store.updateLiveSession(pending.id, pending.patch);
                if (this.selectedSession && this.selectedSession.id === pending.id) this.selectedSession = saved;
                if (this.pendingSessionPatch === pending) this.pendingSessionPatch = null;
                if (store.state.sessionWorkspace && store.state.sessionWorkspace.session.id === pending.id) {
                    store.state.sessionWorkspace.session = saved;
                    store.state.sessionWorkspace.pending = this.pendingSessionPatch;
                }
                await this.refreshPastSessions();
            } catch (e) {
                this.workspaceError = `Changes have not been saved: ${e.message}`;
            } finally { this.workspaceBusy = false; }
            if (!this.workspaceError && this.pendingSessionPatch) return this.retrySessionEdit();
        },
        async renameSession(name) {
            if (this.viewMode === 'history') {
                const value = name.trim() || this.sessionLabel({ ...this.selectedSession, name: '' });
                this.selectedSession = { ...this.selectedSession, name: value };
                return this.saveSessionEdit({ name: value, customName: !!name.trim() });
            }
            await liveAnalysisService.rename(name);
            this._syncLiveFromService();
        },
        async clearSessionTunes() {
            if (!window.confirm('Remove all tunes from this session? The session and its name will be kept.')) return;
            if (this.viewMode === 'history') {
                this.savedDetections = [];
                return this.saveSessionEdit({ tunes: [] });
            }
            await liveAnalysisService.clearTunes();
            this._syncLiveFromService();
        },
        async deleteSelectedSession() {
            if (this.workspaceBusy) return;
            if (!this.activeSession || !window.confirm('Delete this session and its tune list? This cannot be undone.')) return;
            this.workspaceBusy = true;
            try {
                if (this.viewMode === 'history') await store.deleteLiveSession(this.selectedSession.id);
                else await liveAnalysisService.deleteSession();
                this.selectedSession = null;
                store.state.sessionWorkspace = null;
                this.savedDetections = [];
                this.pendingSessionPatch = null;
                this.workspaceError = '';
                this.viewMode = 'live';
                this._syncLiveFromService();
                await this.refreshPastSessions();
            } catch (e) { this.workspaceError = `Could not delete session: ${e.message}`; }
            finally { this.workspaceBusy = false; }
        },
        async newSession() {
            if (this.pendingSessionPatch) {
                this.workspaceError = 'Save your pending changes before starting a new session.';
                return;
            }
            this.workspaceBusy = true;
            try {
                const result = await liveAnalysisService.finish();
                if (!result.ok) return;
                this.selectedSession = null;
                this.viewMode = 'live';
                this._syncLiveFromService();
                await this.startLiveAnalysis();
            } catch (e) { this.workspaceError = `Could not start a new session: ${e.message}`; }
            finally { this.workspaceBusy = false; }
        },

        // ---- Past Sessions --------------------------------------------------

        async refreshPastSessions() {
            try {
                const [sessions, favourites] = await Promise.all([
                    store.getNamedLiveSessions(),
                    store.getFavourites(),
                ]);
                this.pastSessions = sessions.slice().sort((a, b) => b.startedAt - a.startedAt);
                this.favouriteSettingIDs = favourites.map(f => String(f.result.settingID));
            } catch (e) { this.workspaceError = `Could not load sessions: ${e.message}`; }
        },
        isOpenSession(session) {
            return !!liveAnalysisService.sessionId && session.id === liveAnalysisService.sessionId;
        },
        // How long the microphone was actually listening. Older records have no
        // listenedSeconds, so fall back to where the last tune ended — which is
        // the same clock the tune times are on, unlike endedAt - startedAt,
        // which also counts the time a session spent paused.
        listenedSeconds(session) {
            if (typeof session.listenedSeconds === 'number') return session.listenedSeconds;
            const last = session.tunes[session.tunes.length - 1];
            return last ? Math.round(last.endSeconds) : 0;
        },
        sessionTimeRange(session) {
            const start = this.formatSessionTime(session.startedAt);
            if (!session.endedAt) return `Started ${start}`;
            return `${start} – ${this.formatSessionTime(session.endedAt)}`;
        },
        formatSessionDate(ms) {
            return new Date(ms).toLocaleString(undefined, {
                year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            });
        },
        formatSessionTime(ms) {
            return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        },
        tuneLinkForSessionTune(tune) {
            return {
                name: 'tune',
                query: {
                    tuneID: String(tune.tuneId || ''),
                    settingID: String(tune.settingId || ''),
                    displayName: tune.title,
                },
            };
        },
        isTuneFavourited(tune) {
            const id = tune.selectedSettingId || tune.settingId;
            return !!id && this.favouriteSettingIDs.includes(String(id));
        },
        async toggleFavourite(tune) {
            tune = { ...tune,
                tuneId: tune.selectedTuneId || tune.tuneId,
                settingId: tune.selectedSettingId || tune.settingId,
                title: tune.selectedTitle || tune.title,
            };
            if (!tune.settingId) return;
            const settingID = String(tune.settingId);
            if (this.isTuneFavourited(tune)) {
                await store.removeFavourite(settingID);
            } else {
                // Same shape as every other star in the app: fetch the full
                // setting so the favourite carries its ABC and renders a score
                // preview, rather than a title-only stub.
                let setting = null;
                try {
                    const settings = await ffBackend.settingsFromTuneID(tune.tuneId);
                    setting = (settings || []).find(s => String(s.setting_id) === settingID) || null;
                } catch (e) {
                    console.warn('Could not fetch full setting, starring with what we have', e);
                }
                await store.addFavourite({
                    settingID,
                    setting: setting || {
                        setting_id: settingID,
                        tune_id: tune.tuneId,
                        name: tune.title,
                        dataset: tune.dataset || '',
                        source_url: tune.sourceUrl || '',
                    },
                    displayName: tune.title,
                });
            }
            const favourites = await store.getFavourites();
            this.favouriteSettingIDs = favourites.map(f => String(f.result.settingID));
        },
        // ---- file export ----------------------------------------------------

        normalisedDetectionsForExport() {
            this.file.exportError = '';

            const normalised = this.activeDetections.map(detection => {
                const startSeconds = parseClockTime(detection.editableTime);
                if (Number.isNaN(startSeconds)) {
                    throw new Error(`Invalid time: ${detection.editableTime}`);
                }
                return {
                    ...detection,
                    title: detection.selectedTitle || detection.title,
                    tuneId: detection.selectedTuneId || detection.tuneId,
                    settingId: detection.selectedSettingId || detection.settingId,
                    sourceUrl: detection.selectedSourceUrl || detection.sourceUrl || '',
                    // Preserve cluster duration from original endSeconds - startSeconds;
                    // the user's editable time only changes startSeconds, not the span.
                    durationSeconds: detection.endSeconds - detection.startSeconds,
                    startSeconds,
                };
            });

            return normalised.sort((a, b) => a.startSeconds - b.startSeconds);
        },
        downloadText(filename, text) {
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            link.click();
            URL.revokeObjectURL(url);
        },
        downloadTuneList() {
            try {
                const detections = this.normalisedDetectionsForExport();
                const title = this.viewMode === 'file'
                    ? (this.audioFile ? this.audioFile.name.replace(/\.[^.]+$/, '') : 'session-analysis')
                    : (this.activeSession ? this.sessionLabel(this.activeSession) : 'session');
                const stem = title.replace(/[\\/:*?"<>|]/g, '-');
                this.downloadText(`${stem}-tunes.txt`, buildTuneListText(detections));
            } catch (e) {
                if (this.viewMode === 'file') this.file.exportError = e.message;
                else this.workspaceError = e.message;
            }
        },
        downloadUpdatedXsc() {
            if (!this.xscText || !this.xscFile) return;
            try {
                const detections = this.normalisedDetectionsForExport();
                const updated = buildUpdatedXsc(this.xscText, detections);
                const stem = this.xscFile.name.replace(/\.xsc$/i, '');
                this.downloadText(`${stem}-session-analysis.xsc`, updated);
            } catch (e) {
                if (this.viewMode === 'file') this.file.exportError = e.message;
                else this.workspaceError = e.message;
            }
        },
        formatSecondsAsDuration,
        formatSecondsAsClock,
    },
};
</script>

<style scoped>
@media (max-width: 599px) {
    .session-results ::v-deep table,
    .session-results ::v-deep tbody,
    .session-results ::v-deep tr,
    .session-results ::v-deep td { display: block; width: 100%; }
    .session-results ::v-deep thead { display: none; }
    .session-results ::v-deep tr { padding: 12px 0; border-bottom: 1px solid #ddd; }
    .session-results ::v-deep td { height: auto !important; padding: 5px 0 !important; border: 0 !important; }
    .session-results .duration-cell::before { content: 'Duration: '; color: #666; }
}

.drop-zone {
    border: 2px dashed rgba(5, 85, 129, 0.35);
    border-radius: 14px;
    padding: 28px;
    background: linear-gradient(180deg, rgba(5, 85, 129, 0.04), rgba(255, 255, 255, 0.9));
}

.drop-zone--active {
    border-color: var(--v-primary-base);
    background: linear-gradient(180deg, rgba(5, 85, 129, 0.1), rgba(255, 255, 255, 0.95));
}

.file-summary {
    border-radius: 12px;
    background: #f5f7fa;
    padding: 16px;
    min-height: 96px;
}

.summary-label {
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #5f6b77;
    margin-bottom: 8px;
}

.start-cell {
    min-width: 120px;
}

.mode-toggle {
    flex-wrap: wrap;
    height: auto;
}

@media (max-width: 959px) {
    .drop-zone {
        padding: 20px;
    }
}

</style>
