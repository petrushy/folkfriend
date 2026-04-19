<template>
    <v-container class="viewContainerWrapper session-analysis">
        <h1 class="my-2">
            Session Analysis
        </h1>

        <v-card class="pa-5 my-3">
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

        <v-card class="pa-5 my-3">
            <div class="d-flex flex-wrap align-center" style="gap: 12px;">
                <v-btn
                    color="secondary"
                    :disabled="!canAnalyze"
                    @click="runAnalysis"
                >
                    Analyze Recording
                </v-btn>
                <v-btn
                    v-if="isAnalyzing"
                    text
                    color="secondary"
                    @click="cancelAnalysis"
                >
                    Cancel
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
                Leave this off for automatic defaults. Turn it on when you want finer or coarser scanning of a session recording, including sparse non-continuous sampling.
            </p>

            <div v-if="analysisStage !== 'idle'" class="mt-4">
                <div class="mb-2">
                    <strong>{{ stageLabel }}</strong>
                    <span v-if="progress.total > 0">
                        · {{ progress.current }}/{{ progress.total }}
                    </span>
                </div>
                <v-progress-linear
                    :indeterminate="analysisStage === 'decoding'"
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
                            <th class="text-left">
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
                            <td class="start-cell">
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
                                    @change="syncSelectedTune(detection)"
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
import audioService from '@/services/audio.js';
import ffBackend from '@/services/backend.js';
import store from '@/services/store.js';
import eventBus from '@/eventBus.js';
import { mdiOpenInNew } from '@mdi/js';
import {
    buildTuneListText,
    buildUpdatedXsc,
    clusterDetections,
    formatSecondsAsClock,
    formatSecondsAsDuration,
    getAnalysisOptions,
    normaliseQueryResults,
    parseClockTime,
    parseXscMetadata,
    rmsOfSignal,
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
            cancelRequested: false,
            customAnalysisSettings: false,
            analysisSettings: {
                windowSeconds: 10,
                stepSeconds: 10,
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
            icons: {
                openInNew: mdiOpenInNew,
            },
        };
    },
    computed: {
        canAnalyze() {
            return !!this.audioFile && !this.isAnalyzing && this.indexLoaded;
        },
        isAnalyzing() {
            return this.analysisStage === 'decoding' || this.analysisStage === 'analyzing';
        },
        indexStatusText() {
            return this.indexLoaded ? 'ready' : 'loading…';
        },
        stageLabel() {
            if (this.analysisStage === 'decoding') return 'Decoding audio';
            if (this.analysisStage === 'analyzing') return 'Scanning windows';
            if (this.analysisStage === 'done') return 'Analysis complete';
            return '';
        },
        progressPercent() {
            if (!this.progress.total) return 0;
            return (this.progress.current / this.progress.total) * 100;
        },
        progressLabel() {
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
        this._onIndexLoaded = () => {
            this.indexLoaded = true;
        };
        eventBus.$on('indexLoaded', this._onIndexLoaded);
        this.restoreSavedState();
        eventBus.$emit('parentViewActivated');
    },
    beforeDestroy() {
        this.persistState();
        eventBus.$off('indexLoaded', this._onIndexLoaded);
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
                stepSeconds: 10,
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
            this.progress = {
                current: 0,
                total: 0,
                currentTimeSeconds: 0,
            };
            this.analysisSummary = {
                acceptedWindows: 0,
                durationSeconds: 0,
                options: null,
            };
            this.persistState();
        },
        resolveAnalysisOptions(durationSeconds) {
            const defaults = getAnalysisOptions(durationSeconds);
            if (!this.customAnalysisSettings) {
                this.analysisSettings.windowSeconds = defaults.windowSeconds;
                this.analysisSettings.stepSeconds = defaults.stepSeconds;
                return defaults;
            }

            const windowSeconds = Number(this.analysisSettings.windowSeconds);
            const stepSeconds = Number(this.analysisSettings.stepSeconds);

            if (!Number.isFinite(windowSeconds) || windowSeconds < 3) {
                throw new Error('Window size must be at least 3 seconds.');
            }
            if (!Number.isFinite(stepSeconds) || stepSeconds < 1) {
                throw new Error('Step size must be at least 1 second.');
            }

            return {
                ...defaults,
                windowSeconds,
                stepSeconds,
                mergeGapSeconds: windowSeconds,
            };
        },
        cancelAnalysis() {
            this.cancelRequested = true;
        },
        async runAnalysis() {
            if (!this.audioFile) return;

            this.cancelRequested = false;
            this.analysisError = '';
            this.exportError = '';
            this.detections = [];
            this.analysisStage = 'decoding';
            this.progress = {
                current: 0,
                total: 0,
                currentTimeSeconds: 0,
            };
            this.persistState();

            try {
                const pcm = await audioService.fileToTimeDomainData(this.audioFile);
                const sampleRate = audioService.sampleRate;
                const durationSeconds = pcm.length / sampleRate;
                const options = this.resolveAnalysisOptions(durationSeconds);
                const maxStart = Math.max(0, durationSeconds - options.windowSeconds);
                const starts = [];

                for (let start = 0; start <= maxStart; start += options.stepSeconds) {
                    starts.push(start);
                }
                if (!starts.length || starts[starts.length - 1] < maxStart) {
                    starts.push(maxStart);
                }

                this.analysisStage = 'analyzing';
                this.progress.total = starts.length;
                this.analysisSummary.durationSeconds = durationSeconds;
                this.analysisSummary.options = options;
                this.persistState();

                const windowMatches = [];

                for (let i = 0; i < starts.length; i++) {
                    if (this.cancelRequested) {
                        this.analysisStage = 'idle';
                        this.analysisError = 'Analysis cancelled.';
                        this.persistState();
                        return;
                    }

                    const startSeconds = starts[i];
                    this.progress.current = i + 1;
                    this.progress.currentTimeSeconds = startSeconds;

                    const startSample = Math.floor(startSeconds * sampleRate);
                    const endSample = Math.min(pcm.length, startSample + Math.floor(options.windowSeconds * sampleRate));
                    const segment = pcm.subarray(startSample, endSample);

                    if (rmsOfSignal(segment) < options.minRms) {
                        continue;
                    }

                    const response = await ffBackend.transcribeAndQueryPCMSignal(segment);
                    if (response.error || !response.contour || response.contour.length < options.minContourLength) {
                        continue;
                    }

                    const normalized = normaliseQueryResults(response.results, options);
                    if (!normalized) {
                        continue;
                    }

                    windowMatches.push({
                        startSeconds,
                        tuneId: normalized.tuneId,
                        settingId: normalized.settingId,
                        sourceUrl: normalized.sourceUrl,
                        displayName: normalized.displayName,
                        score: normalized.score,
                        alternatives: normalized.alternatives,
                    });

                    if ((i + 1) % 5 === 0) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }

                const clustered = clusterDetections(windowMatches, options);
                this.analysisSummary.acceptedWindows = windowMatches.length;
                this.detections = clustered.map(detection => ({
                    ...detection,
                    editableTime: formatSecondsAsClock(detection.startSeconds),
                    selectedTuneKey: this.tuneOptionValue({
                        tuneId: detection.tuneId,
                        settingId: detection.settingId,
                        sourceUrl: detection.sourceUrl,
                        title: detection.title,
                    }),
                    tuneOptions: this.buildTuneOptions(detection),
                }));
                this.detections.forEach(detection => this.syncSelectedTune(detection));
                this.analysisStage = 'done';
                this.persistState();
            } catch (e) {
                console.error(e);
                this.analysisStage = 'idle';
                this.analysisError = e && e.message ? e.message : 'Could not analyze the recording.';
                this.persistState();
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
            this.persistState();
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
