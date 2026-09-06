<template>
    <v-container class="viewContainerWrapper session-analysis">
        <h1 class="my-2">
            Session Analysis
        </h1>

        <!-- Three modes do not fit on one phone row, and v-btn-toggle does not
             wrap on its own — it just overflows the viewport. -->
        <v-btn-toggle
            v-model="viewMode"
            mandatory
            dense
            rounded
            class="mb-4 mode-toggle"
        >
            <v-btn value="file" small>
                File recording
            </v-btn>
            <v-btn value="live" small>
                <v-icon left small>{{ icons.microphone }}</v-icon>
                Live microphone
            </v-btn>
            <v-btn value="history" small>
                Past Sessions
            </v-btn>
        </v-btn-toggle>

        <!--
            The session bar is shown on EVERY tab while a session is open.
            Listening is a background activity, not a mode: browsing past
            sessions or analysing a file must never make the microphone
            invisible, or the only way to find out whether the app is still
            recording is to go looking for it.
        -->
        <v-card v-if="live.hasSession" class="pa-4 my-3 session-bar" :class="sessionBarClass">
            <div class="d-flex flex-wrap align-center" style="gap: 12px;">
                <v-chip small :color="liveStatus.color" text-color="white">
                    <v-icon left x-small>{{ liveStatus.icon }}</v-icon>
                    {{ liveStatus.label }}
                </v-chip>

                <span class="text--secondary">
                    {{ formatSecondsAsClock(live.elapsedSeconds) }} listened
                    &middot;
                    {{ live.detections.length }} {{ live.detections.length === 1 ? 'tune' : 'tunes' }}
                </span>

                <VolumeMeter v-if="live.capturing && live.micHealthy" :active="true" />

                <v-spacer />

                <v-btn
                    v-if="live.capturing"
                    small
                    text
                    color="secondary"
                    @click="pauseLive"
                >
                    Pause
                </v-btn>
                <v-btn
                    v-else-if="live.canResume"
                    small
                    color="primary"
                    :disabled="!indexLoaded || live.starting"
                    :loading="live.starting"
                    @click="resumeLive"
                >
                    Resume
                </v-btn>

                <v-btn
                    v-if="live.capturing"
                    small
                    color="primary"
                    @click="followMode = true"
                >
                    <v-icon left x-small>{{ icons.clef }}</v-icon>
                    Follow Score
                </v-btn>

                <v-btn
                    small
                    text
                    color="secondary"
                    :loading="live.finishing"
                    @click="finishLiveSession"
                >
                    Finish session
                </v-btn>
            </div>

            <!--
                A microphone that has died mid-session used to be invisible:
                the list simply stopped growing. It is now stated, and the
                retry reacquires capture without touching the session.
            -->
            <v-alert
                v-if="live.capturing && !live.micHealthy"
                type="warning"
                dense
                text
                class="mt-3 mb-0"
            >
                <div class="d-flex flex-wrap align-center" style="gap: 12px;">
                    <span>
                        The microphone stopped delivering audio{{ live.micMessage ? ` (${live.micMessage})` : '' }}.
                        Nothing is being detected until it comes back — your tune list is safe.
                    </span>
                    <v-btn small :loading="live.retryingMic" @click="retryMicrophone">
                        Retry microphone
                    </v-btn>
                </div>
            </v-alert>

            <v-alert
                v-if="live.saveState === 'error'"
                type="error"
                dense
                text
                class="mt-3 mb-0"
            >
                <div class="d-flex flex-wrap align-center" style="gap: 12px;">
                    <span>
                        This session could not be saved{{ live.saveError ? `: ${live.saveError}` : '' }}.
                        It is still here — nothing has been lost yet — but it will not survive closing the app.
                    </span>
                    <v-btn small :loading="live.retryingSave" @click="retrySave">
                        Retry save
                    </v-btn>
                </div>
            </v-alert>

            <p v-if="!live.canResume" class="mt-3 mb-0 caption text--secondary">
                This session was restored after the app was reopened. Its tune list is complete and can be
                finished, but listening again would start a new session rather than continuing this one.
            </p>
        </v-card>

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

        <v-card v-else-if="viewMode === 'live'" class="pa-5 my-3">
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
                picks it up where it left off. <strong>Finish session</strong> closes it and files it under
                Past Sessions. Listening carries on while you look at other tabs.
            </p>
        </v-card>

        <v-card v-else-if="viewMode === 'history'" class="pa-5 my-3">
            <h2 class="text-h6 mb-3">
                Past Sessions
            </h2>
            <p class="mb-0 text--secondary">
                Live sessions are saved automatically as tunes are recognised, so you can look back at what was
                played on a given evening. They are kept on this device, synced to your account while you are
                signed in, and included in the backup file from Settings &rarr; Export.
            </p>
        </v-card>

        <!-- Live controls: only the ones that START a session. Everything for
             a session already open lives in the persistent bar above. -->
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

            <v-alert
                v-if="live.micError"
                type="error"
                dense
                text
                class="mt-3 mb-0"
            >
                {{ live.micError }}
            </v-alert>

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
        <v-card v-if="activeDetections.length && viewMode !== 'history'" class="pa-5 my-3">
            <div class="d-flex flex-wrap justify-space-between align-center" style="gap: 12px;">
                <div>
                    <h2 class="text-h6 mb-1">
                        Detected Tune Starts
                    </h2>
                    <p class="mb-0 text--secondary">
                        {{ activeDetections.length }} detections from {{ activeAcceptedWindows }} matched windows.
                    </p>
                </div>
                <div v-if="viewMode === 'file'" class="d-flex flex-wrap" style="gap: 12px;">
                    <v-btn text color="primary" @click="downloadTuneList">
                        Download Tune List
                    </v-btn>
                    <v-btn
                        v-if="xscFile"
                        color="primary"
                        @click="downloadUpdatedXsc"
                    >
                        Export Updated .xsc
                    </v-btn>
                </div>
            </div>

            <v-simple-table class="mt-4">
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
                                    dense
                                    hide-details
                                    solo
                                />
                            </td>
                            <td>
                                <v-select
                                    v-model="detection.selectedTuneKey"
                                    :items="detection.tuneOptions"
                                    item-text="text"
                                    item-value="value"
                                    dense
                                    hide-details
                                    solo
                                    @change="onTuneChange(detection)"
                                />
                            </td>
                            <td>
                                {{ formatSecondsAsDuration(detection.endSeconds - detection.startSeconds) }}
                            </td>
                            <td>
                                <div class="d-flex align-center" style="gap: 8px;">
                                    <v-btn
                                        icon
                                        small
                                        :to="tuneLinkForDetection(detection)"
                                    >
                                        <v-icon small>
                                            {{ icons.openInNew }}
                                        </v-icon>
                                    </v-btn>
                                    <v-btn text small color="secondary" @click="removeDetection(detection.id)">
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

        <v-card v-if="viewMode === 'history'" class="pa-5 my-3">
            <p v-if="!pastSessions.length" class="text--secondary mb-0">
                Nothing saved yet. Live sessions are recorded automatically as tunes are recognised.
            </p>
            <v-expansion-panels v-else flat>
                <v-expansion-panel v-for="session in pastSessions" :key="session.id">
                    <v-expansion-panel-header>
                        <div class="d-flex flex-wrap align-center" style="gap: 8px;">
                            <strong>{{ formatSessionDate(session.startedAt) }}</strong>
                            <span class="text--secondary">
                                {{ session.tunes.length }} {{ session.tunes.length === 1 ? 'tune' : 'tunes' }}
                                &middot; {{ formatSecondsAsDuration(listenedSeconds(session)) }} listened
                            </span>
                            <v-chip v-if="isOpenSession(session)" x-small color="primary" text-color="white">
                                In progress
                            </v-chip>
                            <v-chip v-else-if="!session.endedAt" x-small outlined>
                                Unfinished
                            </v-chip>
                        </div>
                    </v-expansion-panel-header>
                    <v-expansion-panel-content>
                        <p class="caption text--secondary mb-2">
                            {{ sessionTimeRange(session) }}
                        </p>

                        <v-simple-table dense>
                            <template #default>
                                <thead>
                                    <tr>
                                        <th class="text-left" style="width: 48px;" />
                                        <th class="text-left">
                                            Tune
                                        </th>
                                        <th class="text-left">
                                            Heard at
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="(tune, i) in session.tunes" :key="i">
                                        <td>
                                            <v-btn
                                                icon
                                                small
                                                :disabled="!tune.settingId"
                                                :aria-label="isTuneFavourited(tune) ? 'Remove from favourites' : 'Add to favourites'"
                                                @click="toggleFavourite(tune)"
                                            >
                                                <v-icon
                                                    small
                                                    :color="isTuneFavourited(tune) ? 'amber darken-2' : 'grey'"
                                                >
                                                    {{ isTuneFavourited(tune) ? icons.star : icons.starOutline }}
                                                </v-icon>
                                            </v-btn>
                                        </td>
                                        <td>
                                            <router-link :to="tuneLinkForSessionTune(tune)">
                                                {{ tune.title }}
                                            </router-link>
                                        </td>
                                        <td>
                                            {{ formatSecondsAsClock(tune.startSeconds) }}
                                        </td>
                                    </tr>
                                </tbody>
                            </template>
                        </v-simple-table>

                        <div class="d-flex flex-wrap align-center mt-3" style="gap: 12px;">
                            <v-btn
                                v-if="!session.endedAt && !isOpenSession(session)"
                                text
                                small
                                color="primary"
                                @click="finishStoredSession(session)"
                            >
                                Mark as finished
                            </v-btn>
                            <v-btn
                                text
                                small
                                color="error"
                                :disabled="isOpenSession(session)"
                                @click="deleteSession(session)"
                            >
                                Delete session
                            </v-btn>
                            <span v-if="isOpenSession(session)" class="caption text--secondary">
                                This is the session you are recording now — finish it before deleting it.
                            </span>
                        </div>
                    </v-expansion-panel-content>
                </v-expansion-panel>
            </v-expansion-panels>
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
    mdiPause, mdiRecordCircleOutline, mdiAlertCircleOutline,
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
    // The microphone is open and the loop is running.
    capturing: false,
    // A restored session with no stored analysis options can be read and
    // finished but not extended — see liveAnalysisService.canResume().
    canResume: true,
    micHealthy: true,
    micMessage: '',
    micError: '',
    saveState: 'idle',
    saveError: null,
    starting: false,
    finishing: false,
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
            // The two analyses keep their own results, progress and errors.
            // They used to share one set of fields, so starting one wiped the
            // other's results and the "stage" of whichever ran last decided
            // what BOTH panels displayed.
            file: emptyFileState(),
            live: emptyLiveState(),
            followMode: false,
            pastSessions: [],
            // settingIDs of favourited tunes, for the stars in Past Sessions.
            favouriteSettingIDs: [],
            icons: {
                openInNew: mdiOpenInNew,
                microphone: mdiMicrophone,
                clef: mdiMusicClefTreble,
                star: mdiStar,
                starOutline: mdiStarOutline,
                pause: mdiPause,
                recording: mdiRecordCircleOutline,
                alert: mdiAlertCircleOutline,
            },
        };
    },
    watch: {
        // Switching tabs is navigation, not a lifecycle event. It never stops
        // the microphone and never touches either set of results — the live
        // session carries on exactly as it does when the user navigates to a
        // different route entirely.
        viewMode(newVal) {
            if (newVal !== 'live') this.followMode = false;
            if (newVal === 'history') this.refreshPastSessions();
        },
    },
    computed: {
        minPastDetectionSeconds() {
            return MIN_PAST_DETECTION_SECONDS;
        },
        activeDetections() {
            return this.viewMode === 'file' ? this.file.detections : this.live.detections;
        },
        activeAcceptedWindows() {
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
        liveStatus() {
            if (this.live.capturing && !this.live.micHealthy) {
                return { label: 'Microphone unavailable', color: 'warning', icon: this.icons.alert };
            }
            if (this.live.capturing) {
                return { label: 'Listening', color: 'red darken-1', icon: this.icons.recording };
            }
            return { label: 'Paused', color: 'grey darken-1', icon: this.icons.pause };
        },
        sessionBarClass() {
            if (this.live.capturing && !this.live.micHealthy) return 'session-bar--warning';
            return this.live.capturing ? 'session-bar--live' : 'session-bar--paused';
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
        // Set when ?follow=1 asked for a session that could not be started yet
        // because the tune index was still loading. Non-reactive: nothing
        // renders it.
        this._autoFollowPending = false;

        // Index
        // The auto-start below cannot run before the tune index is usable
        // (canStartLive is false), and arriving from a cold start it usually is
        // not — so this is also the retry point, not just a flag flip.
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
        this._onLiveMicState = ({ healthy }) => {
            this.live.micHealthy = healthy;
            if (healthy) this.live.micMessage = '';
        };
        this._onLiveSaveState = ({ state, error }) => {
            this.live.saveState = state;
            this.live.saveError = error;
        };
        this._onMicLost = (detail) => {
            this.live.micHealthy = false;
            this.live.micMessage = (detail && detail.reason) || '';
        };
        this._onMicRecovered = () => {
            this.live.micHealthy = true;
            this.live.micMessage = '';
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
        eventBus.$on('micLost', this._onMicLost);
        eventBus.$on('micRecovered', this._onMicRecovered);
        eventBus.$on('liveSessionsChanged', this._onLiveSessionsChanged);
        eventBus.$on('fileAnalysisStage', this._onFileStage);
        eventBus.$on('fileAnalysisOptions', this._onFileOptions);
        eventBus.$on('fileAnalysisProgress', this._onFileProgress);
        eventBus.$on('fileAnalysisUpdate', this._onFileUpdate);
        eventBus.$on('fileAnalysisError', this._onFileError);

        this._initialise();
        eventBus.$emit('parentViewActivated');
    },
    beforeDestroy() {
        this._pcm = null;
        // Withdraws a ?follow=1 auto-start that has not fired yet. The
        // eventBus unsubscribe below covers a late indexLoaded, but not the
        // $nextTick callback created() already queued — that one holds its own
        // reference and would open a microphone for a view that is gone.
        this._autoFollowPending = false;
        // File analysis is cancelled on navigation (unlike live, which continues in background)
        if (fileSessionAnalysisService.isRunning) {
            fileSessionAnalysisService.cancel();
        }
        eventBus.$off('indexLoaded', this._onIndexLoaded);
        eventBus.$off('liveAnalysisUpdate', this._onLiveUpdate);
        eventBus.$off('liveAnalysisTimerTick', this._onLiveTimerTick);
        eventBus.$off('liveAnalysisStopped', this._onLiveStopped);
        eventBus.$off('liveAnalysisFinished', this._onLiveFinished);
        eventBus.$off('liveAnalysisRestored', this._onLiveRestored);
        eventBus.$off('liveAnalysisMicState', this._onLiveMicState);
        eventBus.$off('liveAnalysisSaveState', this._onLiveSaveState);
        eventBus.$off('micLost', this._onMicLost);
        eventBus.$off('micRecovered', this._onMicRecovered);
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
            if (liveAnalysisService.sessionId) {
                this.viewMode = 'live';
                this._syncLiveFromService();
                if (this._routeWantsFollow() && this.live.capturing) this.followMode = true;
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

            // A session the app was recording when it was last closed. It is
            // restored WITHOUT opening the microphone — listening again is
            // always a deliberate act — and offered Resume and Finish.
            const restored = await liveAnalysisService.restoreOpenSession();
            if (restored) {
                this.viewMode = 'live';
                this._syncLiveFromService();
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
                this.live.micError = 'Could not access microphone. Please check permissions.';
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
        // Ends the session: a final save, then it moves to Past Sessions.
        async finishLiveSession() {
            this.live.finishing = true;
            try {
                const result = await liveAnalysisService.finish();
                if (!result.ok) {
                    // The session is deliberately still here. Saying so is the
                    // whole point — silently keeping it would look like the
                    // button did nothing.
                    this._syncLiveFromService();
                    return;
                }
                if (this.viewMode === 'history') await this.refreshPastSessions();
            } finally {
                this.live.finishing = false;
            }
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
            if (!this._autoFollowPending) return;
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

        // ---- Past Sessions --------------------------------------------------

        async refreshPastSessions() {
            const [sessions, favourites] = await Promise.all([
                store.getLiveSessions(),
                store.getFavourites(),
            ]);
            this.pastSessions = sessions.slice().sort((a, b) => b.startedAt - a.startedAt);
            this.favouriteSettingIDs = favourites.map(f => String(f.result.settingID));
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
            return !!tune.settingId && this.favouriteSettingIDs.includes(String(tune.settingId));
        },
        async toggleFavourite(tune) {
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
        // Closes out a session left unfinished by a previous run of the app, so
        // it does not sit in the list labelled "Unfinished" with nothing that
        // can be done about it.
        async finishStoredSession(session) {
            await store.upsertLiveSession({
                ...session,
                endedAt: session.startedAt + this.listenedSeconds(session) * 1000,
            });
            await this.refreshPastSessions();
        },
        async deleteSession(session) {
            // The open session is not deletable: the next autosave would write
            // it straight back, so the delete would look like it silently
            // failed. Finish it first — the button is disabled and says so.
            if (this.isOpenSession(session)) return;
            if (!window.confirm(`Delete this saved session (${session.tunes.length} tunes)? This cannot be undone.`)) return;
            await store.deleteLiveSession(session.id);
            await this.refreshPastSessions();
        },

        // ---- file export ----------------------------------------------------

        normalisedDetectionsForExport() {
            this.file.exportError = '';

            const normalised = this.file.detections.map(detection => {
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
                const stem = this.audioFile ? this.audioFile.name.replace(/\.[^.]+$/, '') : 'session-analysis';
                this.downloadText(`${stem}-tunes.txt`, buildTuneListText(detections));
            } catch (e) {
                this.file.exportError = e.message;
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
                this.file.exportError = e.message;
            }
        },
        formatSecondsAsDuration,
        formatSecondsAsClock,
    },
};
</script>

<style scoped>
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

.session-bar {
    border-left: 4px solid transparent;
}

.session-bar--live {
    border-left-color: #c62828;
}

.session-bar--paused {
    border-left-color: #9e9e9e;
}

.session-bar--warning {
    border-left-color: #f9a825;
}

@media (max-width: 959px) {
    .drop-zone {
        padding: 20px;
    }
}

/* On a phone the session bar is the control surface for the whole feature, so
   its buttons get a full-width row of their own rather than being squeezed
   beside the status text. */
@media (max-width: 599px) {
    .session-bar .v-btn {
        flex: 1 1 auto;
    }
}
</style>
