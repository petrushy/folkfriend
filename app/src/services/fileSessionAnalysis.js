import audioService from './audio.js';
import ffBackend from './backend.js';
import {
    buildSessionDetections,
    getAnalysisOptions,
    normaliseQueryResults,
} from '@/js/sessionAnalysis.js';
import { biasResultsTowardPrevious } from '@/js/biasResults.mjs';
import eventBus from '@/eventBus.js';

class FileSessionAnalysisService {
    constructor() {
        this.isRunning = false;
        this.detections = [];   // raw clustered detections from clusterDetections()
        this.progress = { current: 0, total: 0, currentTimeSeconds: 0 };
        this.durationSeconds = 0;
        this._cancelled = false;
        this._pcm = null;
        this._windowMatches = [];
        this._options = null;
        // Whether the whole file has been scanned — decides whether the last
        // detection is still exempt from the short-detection filter.
        this._done = false;
    }

    async start(file, { customAnalysisSettings, windowSeconds, stepSeconds }) {
        if (this.isRunning) return;
        this.isRunning = true;
        this._cancelled = false;
        this.detections = [];
        this._windowMatches = [];
        this._options = null;
        this._done = false;
        this.progress = { current: 0, total: 0, currentTimeSeconds: 0 };
        this.durationSeconds = 0;

        try {
            eventBus.$emit('fileAnalysisStage', 'decoding');

            // Yield so any previous large PCM buffer can be GC'd before the new decode
            this._pcm = null;
            await new Promise(resolve => setTimeout(resolve, 0));

            this._pcm = await audioService.fileToTimeDomainData(file);
            const pcm = this._pcm;
            const sampleRate = audioService.sampleRate;
            this.durationSeconds = pcm.length / sampleRate;

            // Resolve analysis options (auto or custom)
            let options;
            if (!customAnalysisSettings) {
                options = getAnalysisOptions(this.durationSeconds);
            } else {
                const wSecs = Number(windowSeconds);
                const sSecs = Number(stepSeconds);
                if (!Number.isFinite(wSecs) || wSecs < 3) {
                    throw new Error('Window size must be at least 3 seconds.');
                }
                if (!Number.isFinite(sSecs) || sSecs < 1) {
                    throw new Error('Step size must be at least 1 second.');
                }
                options = {
                    ...getAnalysisOptions(this.durationSeconds),
                    windowSeconds: wSecs,
                    stepSeconds: sSecs,
                    mergeGapSeconds: wSecs,
                };
            }

            this._options = options;

            // Emit resolved options so component can update its settings display
            eventBus.$emit('fileAnalysisOptions', {
                windowSeconds: options.windowSeconds,
                stepSeconds: options.stepSeconds,
                durationSeconds: this.durationSeconds,
            });

            // Build list of window start positions
            const maxStart = Math.max(0, this.durationSeconds - options.windowSeconds);
            const starts = [];
            for (let start = 0; start <= maxStart; start += options.stepSeconds) {
                starts.push(start);
            }
            if (!starts.length || starts[starts.length - 1] < maxStart) {
                starts.push(maxStart);
            }

            eventBus.$emit('fileAnalysisStage', 'analyzing');
            eventBus.$emit('fileAnalysisProgress', {
                current: 0,
                total: starts.length,
                currentTimeSeconds: 0,
                acceptedWindows: 0,
            });

            for (let i = 0; i < starts.length; i++) {
                if (this._cancelled) {
                    eventBus.$emit('fileAnalysisStage', 'idle');
                    eventBus.$emit('fileAnalysisError', 'Analysis cancelled.');
                    return;
                }

                const startSeconds = starts[i];
                this.progress = { current: i + 1, total: starts.length, currentTimeSeconds: startSeconds };
                eventBus.$emit('fileAnalysisProgress', {
                    ...this.progress,
                    acceptedWindows: this._windowMatches.length,
                });

                const startSample = Math.floor(startSeconds * sampleRate);
                const endSample = Math.min(
                    pcm.length,
                    startSample + Math.floor(options.windowSeconds * sampleRate)
                );
                const segment = pcm.subarray(startSample, endSample);

                // Decoding is fixed at audioService.sampleRate; say so, rather
                // than relying on a global a live capture may have changed.
                const response = await ffBackend.transcribeAndQueryPCMSignal(segment, sampleRate);
                if (response.error || !response.contour || response.contour.length < options.minContourLength) continue;

                // Same bias toward the tune just detected as live listening.
                const previousTuneId = this.detections.length > 0
                    ? this.detections[this.detections.length - 1].tuneId
                    : null;
                const biasedResults = biasResultsTowardPrevious(
                    response.results || [],
                    previousTuneId,
                    options.previousTuneBiasDelta,
                );
                const normalized = normaliseQueryResults(biasedResults, options);
                if (!normalized) continue;

                this._windowMatches.push({
                    startSeconds,
                    tuneId: normalized.tuneId,
                    settingId: normalized.settingId,
                    sourceUrl: normalized.sourceUrl,
                    dataset: normalized.dataset,
                    displayName: normalized.displayName,
                    score: normalized.score,
                    alternatives: normalized.alternatives,
                    // Where this window ENDS in the file — the same stamp a
                    // live window gets from the recorder's clock, so the
                    // detections carry the audio offsets the player seeks by
                    // if the recording is saved as a session. For a file the
                    // two clocks are one: time in the file.
                    audioSeconds: endSample / sampleRate,
                });

                this.detections = buildSessionDetections(this._windowMatches, options);
                eventBus.$emit('fileAnalysisUpdate', this.detections, this._windowMatches.length);

                // Yield every 5 windows to keep the event loop responsive
                if ((i + 1) % 5 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            this._done = true;
            this.detections = buildSessionDetections(this._windowMatches, options, { final: true });
            eventBus.$emit('fileAnalysisUpdate', this.detections, this._windowMatches.length);
            eventBus.$emit('fileAnalysisStage', 'done');
        } catch (e) {
            console.error(e);
            eventBus.$emit('fileAnalysisStage', 'idle');
            eventBus.$emit('fileAnalysisError', e && e.message ? e.message : 'Could not analyze the recording.');
        } finally {
            this._pcm = null;
            this.isRunning = false;
        }
    }

    cancel() {
        this._cancelled = true;
        this._pcm = null;
    }

    // Drops the window matches that produced a given detection row. During a
    // still-running analysis it re-clusters and emits, so a removed row isn't
    // recreated by the next re-cluster. Once the analysis is done nothing will
    // re-cluster again, so the row is simply dropped WITHOUT emitting: an emit
    // rebuilds every row in the view and would throw away the tune choices and
    // start times the user has edited since.
    removeDetection(id) {
        if (!this._options) return;
        const target = this.detections.find(d => d.id === id);
        if (!target) return;
        const epsilon = 1e-6;
        this._windowMatches = this._windowMatches.filter(match => !(
            match.tuneId === target.tuneId &&
            match.startSeconds >= target.startSeconds - epsilon &&
            match.startSeconds <= target.endSeconds + epsilon
        ));
        if (this._done) {
            this.detections = this.detections.filter(d => d.id !== id);
            return;
        }
        this.detections = buildSessionDetections(this._windowMatches, this._options);
        eventBus.$emit('fileAnalysisUpdate', this.detections, this._windowMatches.length);
    }
}

export default new FileSessionAnalysisService();
