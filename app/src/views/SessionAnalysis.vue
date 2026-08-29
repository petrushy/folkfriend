<template>
    <v-container class="viewContainerWrapper session-analysis">
        <h1 class="my-2">
            Session Analysis
        </h1>

        <v-btn-toggle
            v-model="liveMode"
            mandatory
            dense
            rounded
            class="mb-4"
        >
            <v-btn :value="false" small>
                File recording
            </v-btn>
            <v-btn :value="true" small>
                <v-icon left small>{{ icons.microphone }}</v-icon>
                Live microphone
            </v-btn>
        </v-btn-toggle>

        <v-card v-if="!liveMode" class="pa-5 my-3">
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

        <v-card v-else class="pa-5 my-3">
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
        </v-card>

        <v-card class="pa-5 my-3">
            <div class="d-flex flex-wrap align-center" style="gap: 12px;">
                <v-btn
                    v-if="liveMode && !liveMicActive"
                    color="primary"
                    :disabled="!canAnalyze"
                    @click="startListeningAndFollow"
                >
                    <v-icon left small>{{ icons.clef }}</v-icon>
                    Listen &amp; Follow
                </v-btn>
                <v-btn
                    :color="liveMode && !liveMicActive ? 'grey darken-1' : 'secondary'"
                    :text="liveMode && !liveMicActive"
                    :disabled="!canAnalyze"
                    @click="runAnalysis"
                >
                    {{ liveMode ? 'Listen without score' : 'Analyze Recording' }}
                </v-btn>
                <v-btn
                    v-if="liveMode && liveMicActive"
                    text
                    color="secondary"
                    @click="togglePauseLive"
                >
                    {{ liveIsPaused ? 'Resume' : 'Pause' }}
                </v-btn>
                <v-btn
                    v-if="isAnalyzing || (liveMode && liveMicActive)"
                    text
                    color="secondary"
                    @click="cancelAnalysis"
                >
                    Stop
                </v-btn>
                <v-btn
                    v-if="liveMode && liveMicActive"
                    color="primary"
                    @click="followMode = true"
                >
                    <v-icon left small>{{ icons.clef }}</v-icon>
                    Follow Score
                </v-btn>
                <VolumeMeter
                    v-if="liveMode && liveMicActive && !liveIsPaused"
                    :active="liveMode && liveMicActive && !liveIsPaused"
                />
                <div class="text--secondary">
                    Tune index: {{ indexStatusText }}
                </div>
            </div>

            <v-alert
                v-if="liveMicError"
                type="error"
                dense
                text
                class="mt-3 mb-0"
            >
                {{ liveMicError }}
            </v-alert>

            <v-divider class="my-4" />

            <div class="d-flex flex-wrap align-center" style="gap: 16px;">
                <v-switch
                    v-model="customAnalysisSettings"
                    :disabled="liveMicActive"
                    inset
                    hide-details
                    class="mt-0 pt-0"
                    label="Custom analysis settings"
                />
                <v-text-field
                    v-model.number="analysisSettings.windowSeconds"
                    :disabled="!customAnalysisSettings || liveMicActive"
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
                    :disabled="!customAnalysisSettings || liveMicActive"
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
                Leave this off for automatic defaults. Turn it on when you want finer or coarser scanning of a session recording, including sparse non-continuous sampling.
            </p>

            <div v-if="analysisStage !== 'idle'" class="mt-4">
                <div class="mb-2">
                    <strong>{{ stageLabel }}</strong>
                    <span v-if="!liveMode && progress.total > 0">
                        · {{ progress.current }}/{{ progress.total }}
                    </span>
                </div>
                <v-progress-linear
                    :indeterminate="analysisStage === 'decoding' || (liveMode && analysisStage === 'analyzing' && !liveIsPaused)"
                    :value="progressPercent"
                    rounded
                />
                <p v-if="progressLabel" class="mt-2 mb-0 text--secondary">
                    {{ progressLabel }}
                </p>
            </div>

            <v-alert
                v-if="analysisError"
                type="error"
                dense
                text
                class="mt-4 mb-0"
            >
                {{ analysisError }}
            </v-alert>
        </v-card>

        <v-card v-if="detections.length" class="pa-5 my-3">
            <div class="d-flex flex-wrap justify-space-between align-center" style="gap: 12px;">
                <div>
                    <h2 class="text-h6 mb-1">
                        Detected Tune Starts
                    </h2>
                    <p class="mb-0 text--secondary">
                        {{ detections.length }} detections from {{ analysisSummary.acceptedWindows }} matched windows.
                    </p>
                </div>
                <div class="d-flex flex-wrap" style="gap: 12px;">
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
                            <th v-if="!liveMode" class="text-left">
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
                        <tr v-for="detection in detections" :key="detection.id">
                            <td v-if="!liveMode" class="start-cell">
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
                v-if="exportError"
                type="error"
                dense
                text
                class="mt-4 mb-0"
            >
                {{ exportError }}
            </v-alert>
        </v-card>

        <v-card v-else-if="analysisStage === 'done'" class="pa-5 my-3">
            <h2 class="text-h6 mb-2">
                No tune starts detected
            </h2>
            <p class="mb-0">
                The recording was analyzed, but no window produced a stable enough match to keep. This can happen with noisy starts, low melody prominence, or thresholds that are still too strict for the material.
            </p>
        </v-card>

        <LiveScoreFollow
            v-if="followMode"
            :detections="detections"
            @close="followMode = false"
        />
    </v-container>
</template>

<script>
import store from '@/services/store.js';
import eventBus from '@/eventBus.js';
import { mdiOpenInNew, mdiMicrophone, mdiMusicClefTreble } from '@mdi/js';
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
            analysisStage: 'idle',
            analysisError: '',
            exportError: '',
            customAnalysisSettings: false,
            analysisSettings: {
                windowSeconds: 10,
                stepSeconds: 5,
            },
            detections: [],
            analysisSummary: {
                acceptedWindows: 0,
                durationSeconds: 0,
                options: null,
            },
            progress: {
                current: 0,
                total: 0,
                currentTimeSeconds: 0,
            },
            // Live microphone is the default: the overwhelmingly common use is
            // pointing the phone at a session that is happening now. Importing a
            // file is the deliberate, occasional case, and restoreSavedState()
            // below switches back to it when there are saved file results.
            liveMode: true,
            liveMicActive: false,
            liveIsPaused: false,
            liveMicError: '',
            liveElapsedSeconds: 0,
            followMode: false,
            icons: {
                openInNew: mdiOpenInNew,
                microphone: mdiMicrophone,
                clef: mdiMusicClefTreble,
            },
        };
    },
    watch: {
        liveMode(newVal) {
            if (!newVal && liveAnalysisService.isRunning) {
                liveAnalysisService.stop();
            }
            this.followMode = false;
            this.resetResults();
        },
    },
    computed: {
        minPastDetectionSeconds() {
            return MIN_PAST_DETECTION_SECONDS;
        },
        canAnalyze() {
            if (this.liveMode) return !this.isAnalyzing && this.indexLoaded;
            return !!this.audioFile && !this.isAnalyzing && this.indexLoaded;
        },
        isAnalyzing() {
            return this.analysisStage === 'decoding' || this.analysisStage === 'analyzing';
        },
        indexStatusText() {
            return this.indexLoaded ? 'ready' : 'loading…';
        },
        stageLabel() {
            if (this.liveMode) {
                if (this.analysisStage === 'analyzing') return this.liveIsPaused ? 'Paused' : 'Listening…';
                if (this.analysisStage === 'done') return 'Analysis stopped';
                return '';
            }
            if (this.analysisStage === 'decoding') return 'Decoding audio';
            if (this.analysisStage === 'analyzing') return 'Scanning windows';
            if (this.analysisStage === 'done') return 'Analysis complete';
            return '';
        },
        progressPercent() {
            if (this.liveMode) return 0;
            if (!this.progress.total) return 0;
            return (this.progress.current / this.progress.total) * 100;
        },
        progressLabel() {
            if (this.liveMode && this.analysisStage === 'analyzing') {
                return `Elapsed: ${formatSecondsAsClock(this.liveElapsedSeconds)}`;
            }
            if (this.analysisStage === 'analyzing') {
                return `Around ${formatSecondsAsClock(this.progress.currentTimeSeconds)} of the recording`;
            }
            if (this.analysisStage === 'decoding' && this.audioFile) {
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
        // (canAnalyze is false), and arriving from a cold start it usually is
        // not — so this is also the retry point, not just a flag flip.
        this._onIndexLoaded = () => {
            this.indexLoaded = true;
            this._runPendingAutoFollow();
        };

        // Live analysis events
        this._onLiveUpdate = (detections) => {
            this.detections = detections.map(d => this._buildDetectionRow(d));
            this.analysisSummary.acceptedWindows = liveAnalysisService._windowMatches.length;
        };
        this._onLiveTimerTick = (secs) => { this.liveElapsedSeconds = secs; };
        this._onLiveStopped = () => {
            this.liveMicActive = false;
            this.liveIsPaused = false;
            this.followMode = false;
            this.analysisStage = this.detections.length ? 'done' : 'idle';
        };
        this._onLivePaused = () => { this.liveIsPaused = true; };
        this._onLiveResumed = () => { this.liveIsPaused = false; };

        // File analysis events
        this._onFileStage = (stage) => {
            this.analysisStage = stage;
            if (stage === 'done' || stage === 'idle') this.persistState();
        };
        this._onFileOptions = ({ windowSeconds, stepSeconds, durationSeconds }) => {
            this.analysisSettings.windowSeconds = windowSeconds;
            this.analysisSettings.stepSeconds = stepSeconds;
            this.analysisSummary.durationSeconds = durationSeconds;
        };
        this._onFileProgress = ({ current, total, currentTimeSeconds, acceptedWindows }) => {
            this.progress = { current, total, currentTimeSeconds };
            this.analysisSummary.acceptedWindows = acceptedWindows;
        };
        this._onFileUpdate = (detections, acceptedWindows) => {
            this.detections = detections.map(d => this._buildDetectionRow(d));
            this.analysisSummary.acceptedWindows = acceptedWindows;
        };
        this._onFileError = (message) => { this.analysisError = message; };

        eventBus.$on('indexLoaded', this._onIndexLoaded);
        eventBus.$on('liveAnalysisUpdate', this._onLiveUpdate);
        eventBus.$on('liveAnalysisTimerTick', this._onLiveTimerTick);
        eventBus.$on('liveAnalysisStopped', this._onLiveStopped);
        eventBus.$on('liveAnalysisPaused', this._onLivePaused);
        eventBus.$on('liveAnalysisResumed', this._onLiveResumed);
        eventBus.$on('fileAnalysisStage', this._onFileStage);
        eventBus.$on('fileAnalysisOptions', this._onFileOptions);
        eventBus.$on('fileAnalysisProgress', this._onFileProgress);
        eventBus.$on('fileAnalysisUpdate', this._onFileUpdate);
        eventBus.$on('fileAnalysisError', this._onFileError);

        if (liveAnalysisService.isRunning) {
            // Setting liveMode queues the watcher which calls resetResults() asynchronously.
            // Use $nextTick to restore the actual live state after that watcher has run.
            this.liveMode = true;
            this.$nextTick(() => {
                if (!liveAnalysisService.isRunning) return;
                this.liveMicActive = true;
                this.liveIsPaused = liveAnalysisService.isPaused;
                this.analysisStage = 'analyzing';
                this.liveElapsedSeconds = liveAnalysisService.elapsedSeconds;
                this.detections = liveAnalysisService.detections.map(d => this._buildDetectionRow(d));
                this.analysisSummary.acceptedWindows = liveAnalysisService._windowMatches.length;
                // Already listening — the one-tap entry point has nothing to
                // start, so it just opens the score.
                if (this._routeWantsFollow()) this.followMode = true;
            });
        } else if (this._routeWantsLive()) {
            // ?follow=1 is the one-tap "show me what is playing" entry point:
            // start listening and open the score, with no further taps. It is
            // deliberately not merely a deep link to this screen — the whole
            // point is that the two actions it replaces are the two taps.
            // Deferred one tick so the view is on screen before the microphone
            // is opened — a permission refusal has to land on a rendered page,
            // not on one that has not mounted yet.
            if (this._routeWantsFollow()) {
                this._autoFollowPending = true;
                this.$nextTick(() => this._runPendingAutoFollow());
            }
        } else {
            // Saved file results outrank the live default — landing on an empty
            // microphone panel having previously analysed a recording reads as
            // the results having been lost.
            const saved = store.state.sessionAnalysis;
            if (saved && (saved.audioFile || (saved.detections && saved.detections.length))) {
                this.liveMode = false;
                // The liveMode watcher is queued now and calls resetResults();
                // restoring synchronously here would be wiped by it. $nextTick
                // callbacks run after the scheduler flush, so this lands after.
                this.$nextTick(() => { this.restoreSavedState(); });
            }
        }

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
        eventBus.$off('liveAnalysisPaused', this._onLivePaused);
        eventBus.$off('liveAnalysisResumed', this._onLiveResumed);
        eventBus.$off('fileAnalysisStage', this._onFileStage);
        eventBus.$off('fileAnalysisOptions', this._onFileOptions);
        eventBus.$off('fileAnalysisProgress', this._onFileProgress);
        eventBus.$off('fileAnalysisUpdate', this._onFileUpdate);
        eventBus.$off('fileAnalysisError', this._onFileError);
        if (!this.liveMode) {
            this.persistState();
        }
    },
    methods: {
        restoreSavedState() {
            const saved = store.state.sessionAnalysis;
            if (!saved) return;
            if (saved.version !== SESSION_ANALYSIS_STATE_VERSION) {
                store.clearSessionAnalysisState();
                this.analysisError = 'Saved Session Analysis results were from an older format and have been cleared. Please run the analysis again.';
                return;
            }

            this.audioFile = saved.audioFile || null;
            this.xscFile = saved.xscFile || null;
            this.xscText = saved.xscText || '';
            this.xscMetadata = saved.xscMetadata || { linkedAudioFileName: '' };
            this.fileWarning = saved.fileWarning || '';
            this.analysisStage = saved.analysisStage || 'idle';
            this.analysisError = saved.analysisError || '';
            this.exportError = saved.exportError || '';
            this.customAnalysisSettings = !!saved.customAnalysisSettings;
            this.analysisSettings = saved.analysisSettings || {
                windowSeconds: 10,
                stepSeconds: 5,
            };
            this.detections = saved.detections || [];
            this.analysisSummary = saved.analysisSummary || {
                acceptedWindows: 0,
                durationSeconds: 0,
                options: null,
            };
            this.progress = saved.progress || {
                current: 0,
                total: 0,
                currentTimeSeconds: 0,
            };

            if (this.analysisStage === 'decoding' || this.analysisStage === 'analyzing') {
                this.analysisStage = this.detections.length ? 'done' : 'idle';
                if (!this.analysisError && !this.detections.length) {
                    this.analysisError = 'Analysis was interrupted. Please run it again if needed.';
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
                analysisStage: this.analysisStage,
                analysisError: this.analysisError,
                exportError: this.exportError,
                customAnalysisSettings: this.customAnalysisSettings,
                analysisSettings: { ...this.analysisSettings },
                detections: this.detections.map(detection => ({ ...detection })),
                analysisSummary: { ...this.analysisSummary },
                progress: { ...this.progress },
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
            this.resetResults();
            this.updateFileWarning();
            this.persistState();
        },
        async setXscFile(file) {
            this.xscFile = file;
            this.xscText = await file.text();
            this.xscMetadata = parseXscMetadata(this.xscText);
            this.resetResults();
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
        resetResults() {
            this.analysisStage = 'idle';
            this.analysisError = '';
            this.exportError = '';
            this.detections = [];
            this.progress = { current: 0, total: 0, currentTimeSeconds: 0 };
            this.analysisSummary = { acceptedWindows: 0, durationSeconds: 0, options: null };
        },
        async cancelAnalysis() {
            if (this.liveMode) {
                await liveAnalysisService.stop();
            } else {
                fileSessionAnalysisService.cancel();
            }
        },
        togglePauseLive() {
            if (this.liveIsPaused) {
                liveAnalysisService.resume();
            } else {
                liveAnalysisService.pause();
            }
        },
        async runAnalysis() {
            if (this.liveMode) {
                await this.startLiveAnalysis();
                return;
            }
            if (!this.audioFile) return;
            this.analysisError = '';
            this.exportError = '';
            this.detections = [];
            this.analysisSummary.acceptedWindows = 0;
            this.progress = { current: 0, total: 0, currentTimeSeconds: 0 };
            await fileSessionAnalysisService.start(this.audioFile, {
                customAnalysisSettings: this.customAnalysisSettings,
                windowSeconds: this.analysisSettings.windowSeconds,
                stepSeconds: this.analysisSettings.stepSeconds,
            });
        },
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
        // Start listening and put the score on screen in one action.
        async startListeningAndFollow() {
            await this.startLiveAnalysis();
            // Only on success: opening a full-screen overlay over a microphone
            // that never opened would hide the error explaining why.
            if (this.liveMicActive) this.followMode = true;
        },
        // Runs the ?follow=1 auto-start, or remembers it for the moment the
        // index becomes usable. Called again from the indexLoaded handler.
        _runPendingAutoFollow() {
            if (!this._autoFollowPending) return;
            if (!this.canAnalyze) return;
            this._autoFollowPending = false;
            this.startListeningAndFollow();
        },
        async startLiveAnalysis() {
            this.liveMicError = '';
            this.detections = [];
            // A fresh session's first detection can coincidentally share a
            // tuneId with whatever the follow overlay last showed, which would
            // otherwise read as "same tune, no reload needed" and could also
            // resurrect a stale manual override from the previous session.
            clearLastShown();
            this.analysisSummary.acceptedWindows = 0;
            this.analysisStage = 'analyzing';
            this.analysisError = '';
            this.liveElapsedSeconds = 0;
            this.liveIsPaused = false;

            const windowSeconds = Number(this.analysisSettings.windowSeconds) || 10;
            const stepSeconds = Number(this.analysisSettings.stepSeconds) || 10;

            try {
                await liveAnalysisService.start(windowSeconds, stepSeconds);
                this.liveMicActive = true;
            } catch (e) {
                this.liveMicError = 'Could not access microphone. Please check permissions.';
                this.analysisStage = 'idle';
            }
        },
        removeDetection(id) {
            // Route through the service so the underlying window matches are
            // dropped — otherwise the next re-cluster (live every stepSeconds,
            // file during a still-running analysis) brings the row back.
            if (this.liveMode) {
                liveAnalysisService.removeDetection(id);
            } else {
                fileSessionAnalysisService.removeDetection(id);
            }
            // Mirror locally in case the service is idle (file analysis 'done')
            // and so the persisted state reflects the removal immediately.
            this.detections = this.detections.filter(detection => detection.id !== id);
            if (!this.liveMode) this.persistState();
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
            if (!this.liveMode) this.persistState();
        },
        normalisedDetectionsForExport() {
            this.exportError = '';

            const normalised = this.detections.map(detection => {
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
                this.exportError = e.message;
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
                this.exportError = e.message;
            }
        },
        formatSecondsAsDuration,
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

.alternative-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.875rem;
}

.alternative-item {
    color: #5f6b77;
}

@media (max-width: 959px) {
    .drop-zone {
        padding: 20px;
    }
}
</style>
