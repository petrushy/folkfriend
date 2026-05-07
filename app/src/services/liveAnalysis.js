import micService from './mic.js';
import ffBackend from './backend.js';
import { normaliseQueryResults, clusterDetections } from '@/js/sessionAnalysis.js';
import eventBus from '@/eventBus.js';

// Merge consecutive rows with the same tuneId into one row.
// The displayed startSeconds advances to the most recent cluster so the
// time column visibly increments as the same tune is repeatedly detected.
function collapseConsecutiveSameTune(detections) {
    const result = [];
    for (const det of detections) {
        const prev = result[result.length - 1];
        if (prev && prev.tuneId === det.tuneId) {
            prev.startSeconds = det.startSeconds;
            prev.endSeconds = det.endSeconds;
            if (det.bestScore > prev.bestScore) {
                prev.bestScore = det.bestScore;
                prev.settingId = det.settingId;
                prev.sourceUrl = det.sourceUrl;
                prev.title = det.title;
                prev.alternatives = det.alternatives;
            }
        } else {
            result.push({ ...det });
        }
    }
    return result;
}

const DEFAULT_OPTIONS = {
    minTopScore: 0.4,
    minClusterHits: 2,
    minContourLength: 12,
    maxAlternatives: 3,
};

class LiveAnalysisService {
    constructor() {
        this.isRunning = false;
        this.isPaused = false;
        this.detections = [];   // raw clustered detections from clusterDetections()
        this.elapsedSeconds = 0;
        this.options = null;
        this._windowMatches = [];
        this._cancelSleep = null;
        this._timerInterval = null;
        this._sampleRate = 48000;
    }

    async start(windowSeconds, stepSeconds) {
        if (this.isRunning) return;

        const options = {
            ...DEFAULT_OPTIONS,
            windowSeconds,
            stepSeconds,
            mergeGapSeconds: windowSeconds,
        };
        this.options = options;
        this.detections = [];
        this._windowMatches = [];
        this.elapsedSeconds = 0;
        this.isRunning = true;
        this.isPaused = false;

        try {
            await micService.startContinuous(windowSeconds);
        } catch (e) {
            this.isRunning = false;
            throw e;
        }

        this._sampleRate = micService.audioCtx ? micService.audioCtx.sampleRate : 48000;

        this._startTimer();

        // Fire-and-forget: loop runs independently of any Vue component
        this._runLoop(options, false).catch(e => {
            console.error('Live analysis loop error:', e);
            this.stop();
        });
    }

    pause() {
        if (!this.isRunning || this.isPaused) return;
        this.isPaused = true;
        this._stopTimer();
        if (this._cancelSleep) { this._cancelSleep(); this._cancelSleep = null; }
        eventBus.$emit('liveAnalysisPaused');
    }

    resume() {
        if (!this.isRunning || !this.isPaused) return;
        this.isPaused = false;
        this._startTimer();
        // Ring buffer has been accumulating — skip the initial fill wait
        this._runLoop(this.options, true).catch(e => {
            console.error('Live analysis loop error:', e);
            this.stop();
        });
        eventBus.$emit('liveAnalysisResumed');
    }

    async stop() {
        if (!this.isRunning) return;
        this.isRunning = false;
        this.isPaused = false;
        this._stopTimer();
        if (this._cancelSleep) { this._cancelSleep(); this._cancelSleep = null; }
        await micService.stopContinuous();
        eventBus.$emit('liveAnalysisStopped');
    }

    _startTimer() {
        if (this._timerInterval) return;
        this._timerInterval = setInterval(() => {
            this.elapsedSeconds++;
            eventBus.$emit('liveAnalysisTimerTick', this.elapsedSeconds);
        }, 1000);
    }

    _stopTimer() {
        if (this._timerInterval) {
            clearInterval(this._timerInterval);
            this._timerInterval = null;
        }
    }

    async _runLoop(options, skipInitialWait) {
        if (!skipInitialWait) {
            await this._sleepCancellable(options.windowSeconds * 1000);
        }

        while (this.isRunning && !this.isPaused) {
            const cycleStart = Date.now();
            const pcm = micService.getContinuousAudio();

            if (pcm.length > 0) {
                const response = await ffBackend.transcribeAndQueryPCMSignal(pcm);

                if (this.isRunning && !this.isPaused && !response.error && response.results && response.results.length > 0) {
                    const normalized = normaliseQueryResults(response.results, options);
                    if (normalized) {
                        this._windowMatches.push({
                            startSeconds: this.elapsedSeconds,
                            tuneId: normalized.tuneId,
                            settingId: normalized.settingId,
                            sourceUrl: normalized.sourceUrl,
                            displayName: normalized.displayName,
                            score: normalized.score,
                            alternatives: normalized.alternatives,
                        });
                        this.detections = collapseConsecutiveSameTune(
                            clusterDetections(this._windowMatches, options)
                        );
                        eventBus.$emit('liveAnalysisUpdate', this.detections);
                    }
                }
            }

            if (!this.isRunning || this.isPaused) break;
            // Subtract the time already spent analysing so the effective step
            // stays close to stepSeconds regardless of backend latency.
            const analysisMs = Date.now() - cycleStart;
            const remainingMs = Math.max(0, options.stepSeconds * 1000 - analysisMs);
            await this._sleepCancellable(remainingMs);
        }
    }

    _sleepCancellable(ms) {
        return new Promise(resolve => {
            const id = setTimeout(resolve, ms);
            this._cancelSleep = () => {
                clearTimeout(id);
                this._cancelSleep = null;
                resolve();
            };
        });
    }
}

export default new LiveAnalysisService();
