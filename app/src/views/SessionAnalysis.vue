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
                Analyses a rolling window of audio from your microphone every {{ analysisSettings.stepSeconds }}s.
                Detected tune starts appear in the table below as they are found.
            </p>
        </v-card>

        <v-card class="pa-5 my-3">
            <div class="d-flex flex-wrap align-center" style="gap: 12px;">
                <v-btn
                    color="secondary"
                    :disabled="!canAnalyze"
                    @click="runAnalysis"
                >
                    {{ liveMode ? 'Start Live Analysis' : 'Analyze Recording' }}
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
    </v-container>
</template>

<script>
import store from '@/services/store.js';
import eventBus from '@/eventBus.js';
import { mdiOpenInNew, mdiMicrophone } from '@mdi/js';
import liveAnalysisService from '@/services/liveAnalysis.js';
import fileSessionAnalysisService from '@/services/fileSessionAnalysis.js';
import {
    buildTuneListText,
    buildUpdatedXsc,
    formatSecondsAsClock,
    formatSecondsAsDuration,
    parseClockTime,
    parseXscMetadata,
} from '@/js/sessionAnalysis.js';

const SESSION_ANALYSIS_STATE_VERSION = 3;

export default {
    name: 'SessionAnalysisView',
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
            liveMode: false,
            liveMicActive: false,
            liveIsPaused: false,
            liveMicError: '',
            liveElapsedSeconds: 0,
            icons: {
                openInNew: mdiOpenInNew,
                microphone: mdiMicrophone,
            },
        };
    },
    watch: {
        liveMode(newVal) {
            if (!newVal && liveAnalysisService.isRunning) {
                liveAnalysisService.stop();
            }
            this.resetResults();
        },
    },
    computed: {
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

        // Index
        this._onIndexLoaded = () => { this.indexLoaded = true; };

        // Live analysis events
        this._onLiveUpdate = (detections) => {
            this.detections = detections.map(d => this._buildDetectionRow(d));
            this.analysisSummary.acceptedWindows = liveAnalysisService._windowMatches.length;
        };
        this._onLiveTimerTick = (secs) => { this.liveElapsedSeconds = secs; };
        this._onLiveStopped = () => {
            this.liveMicActive = false;
            this.liveIsPaused = false;
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
            });
        } else if (this.$route && this.$route.query.live === '1') {
            this.liveMode = true;
        } else {
            this.restoreSavedState();
        }

        eventBus.$emit('parentViewActivated');
    },
    beforeDestroy() {
        this._pcm = null;
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
        cancelAnalysis() {
            if (this.liveMode) {
                liveAnalysisService.stop();
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
            const tuneOptions = this.buildTuneOptions(detection);
            const selectedTuneKey = this.tuneOptionValue({
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
        async startLiveAnalysis() {
            this.liveMicError = '';
            this.detections = [];
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
            this.detections = this.detections.filter(detection => detection.id !== id);
            this.persistState();
        },
        tuneOptionValue(option) {
            return `${option.settingId || 'none'}::${option.tuneId || 'unknown'}::${option.title}`;
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
        buildTuneOptions(detection) {
            const options = [];
            const seen = new Set();
            const candidates = [
                {
                    tuneId: detection.tuneId,
                    settingId: detection.settingId,
                    sourceUrl: detection.sourceUrl || '',
                    title: detection.title,
                    score: detection.bestScore,
                },
                ...(detection.alternatives || []),
            ];

            for (const candidate of candidates) {
                const value = this.tuneOptionValue(candidate);
                if (seen.has(value)) continue;
                seen.add(value);
                options.push({
                    value,
                    tuneId: candidate.tuneId,
                    settingId: candidate.settingId ? String(candidate.settingId) : '',
                    sourceUrl: candidate.sourceUrl || '',
                    title: candidate.title,
                    score: candidate.score,
                    text: `${candidate.title} (${candidate.score.toFixed(2)})`,
                });
            }

            return options;
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
