import micService from './mic.js';
import ffBackend from './backend.js';
import geoService from './geo.js';
import store from './store.js';
import { normaliseQueryResults, clusterDetections } from '@/js/sessionAnalysis.js';
import { biasResultsTowardPrevious } from '@/js/biasResults.mjs';
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
    // Bias toward the most recently confirmed tune: if it appears in the raw
    // results within this score gap of the current top, promote it to first.
    // Suppresses brief one-window outliers without blocking real transitions.
    previousTuneBiasDelta: 0.15,
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
        // Promise that resolves when an in-flight stop() completes. start() awaits
        // this so a quick stop→start cycle cannot create overlapping AudioContexts.
        this._stopPromise = null;
        // Last tuneId written to the sightings log — see _recordSighting().
        this._lastSightingTuneId = null;
    }

    async start(windowSeconds, stepSeconds) {
        if (this._stopPromise) await this._stopPromise;
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
        this._lastSightingTuneId = null;

        // Warms one location fix for the whole session. Not awaited: the
        // session must start on the microphone, never on the radio. By the time
        // the first tune is recognised (a window later, at least) the fix is
        // normally already there.
        geoService.beginSession();

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

    // Drops the underlying window matches that produced a given detection cluster,
    // then re-clusters and emits. Without this, the next analysis cycle would
    // re-cluster the same matches and the row would pop back.
    removeDetection(id) {
        const target = this.detections.find(d => d.id === id);
        if (!target) return;
        const epsilon = 1e-6;
        this._windowMatches = this._windowMatches.filter(match => !(
            match.tuneId === target.tuneId &&
            match.startSeconds >= target.startSeconds - epsilon &&
            match.startSeconds <= target.endSeconds + epsilon
        ));
        this.detections = collapseConsecutiveSameTune(
            clusterDetections(this._windowMatches, this.options)
        );
        eventBus.$emit('liveAnalysisUpdate', this.detections);
    }

    async stop() {
        if (!this.isRunning) return this._stopPromise || Promise.resolve();
        this.isRunning = false;
        this.isPaused = false;
        this._stopTimer();
        if (this._cancelSleep) { this._cancelSleep(); this._cancelSleep = null; }
        this._stopPromise = (async () => {
            try {
                await micService.stopContinuous();
            } finally {
                eventBus.$emit('liveAnalysisStopped');
                this._stopPromise = null;
            }
        })();
        return this._stopPromise;
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
            // Capture can die under us mid-session: the AudioContext suspends
            // (backgrounded tab, or a browser power-saving heuristic), or the
            // OS hands the microphone to another app and our track ends or
            // goes permanently muted. Either way the ring buffer silently
            // freezes and we keep re-analysing the same stale seconds. Check
            // every cycle so the session recovers on its own rather than
            // needing the user to notice and restart it. See mic.js.
            await micService.ensureMicHealthy();
            const pcm = micService.getContinuousAudio();

            if (pcm.length > 0) {
                // Guard against a hung worker — generous ceiling well beyond
                // any healthy backend latency (~3s), so a real backend never
                // hits this and a stuck cycle still recovers on the next step.
                const analysisCeilingMs = Math.max(15_000, options.windowSeconds * 4 * 1000);
                let response;
                try {
                    response = await Promise.race([
                        ffBackend.transcribeAndQueryPCMSignal(pcm),
                        new Promise((_, reject) => setTimeout(
                            () => reject(new Error('analysis timeout')),
                            analysisCeilingMs,
                        )),
                    ]);
                } catch (e) {
                    console.warn('Live analysis cycle skipped:', e && e.message);
                    response = { error: e && e.message, results: [] };
                }

                if (this.isRunning && !this.isPaused && !response.error && response.results && response.results.length > 0) {
                    const previousTuneId = this.detections.length > 0
                        ? this.detections[this.detections.length - 1].tuneId
                        : null;
                    const biasedResults = biasResultsTowardPrevious(
                        response.results,
                        previousTuneId,
                        options.previousTuneBiasDelta,
                    );
                    const normalized = normaliseQueryResults(biasedResults, options);
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
                        this._recordSighting();
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

    // Logs "this tune was heard here" when the recognised tune changes.
    //
    // The edge, not the state: this loop runs every few seconds for hours, so
    // recording per cycle would log one reel forty times. collapseConsecutive-
    // SameTune() has already merged a continuing tune into a single tail entry,
    // which makes "the tail's tuneId is not the one we last logged" exactly the
    // musical event wanted — and it correctly logs A, B, A as three sightings
    // when a set comes back round, which is the case this feature exists for.
    //
    // Fire-and-forget. A sighting must never delay or break the analysis loop,
    // so the promise is not awaited and every failure is swallowed.
    _recordSighting() {
        if (!store.userSettings || !store.userSettings.geoTagDetections) return;
        const latest = this.detections[this.detections.length - 1];
        if (!latest || latest.tuneId == null) return;
        if (String(latest.tuneId) === String(this._lastSightingTuneId)) return;
        this._lastSightingTuneId = latest.tuneId;

        (async () => {
            // A fix already cached from the start of the session costs nothing
            // here; only the first tune of an evening can wait on the radio.
            const fix = await geoService.getFix();
            await store.addSighting({
                tuneID: latest.tuneId,
                settingID: latest.settingId,
                displayName: latest.title,
                fix,
                source: 'live',
            });
        })().catch(e => console.warn('Could not record sighting:', e && e.message));
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
