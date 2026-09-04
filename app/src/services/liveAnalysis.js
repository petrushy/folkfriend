import micService from './mic.js';
import ffBackend from './backend.js';
import geoService from './geo.js';
import store from './store.js';
import { normaliseQueryResults, clusterDetections, filterShortPastDetections } from '@/js/sessionAnalysis.js';
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
                prev.dataset = det.dataset;
                prev.title = det.title;
                prev.alternatives = det.alternatives;
            }
        } else {
            result.push({ ...det });
        }
    }
    return result;
}

// How long a tune the user has rejected stays suppressed. Without a cooldown
// the button is useless: the same seconds of audio are still in the ring buffer
// and still match, so the rejected tune reappears on the very next cycle. It is
// deliberately not permanent — a tune genuinely played later in the evening must
// still be findable — and not refreshed on each suppressed match either, so the
// rule stays "two minutes", which is something a user can predict.
const REJECT_COOLDOWN_SECONDS = 120;

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
        // tuneId (as a string) -> elapsedSeconds at which the user rejected it.
        this._rejectedTunes = new Map();

        // Non-null while a session is open — i.e. resumable, whether currently
        // running or stopped-but-not-cleared. The single source of truth for
        // whether start() means "begin fresh" or "resume", and for whether the
        // UI should offer Resume/Clear. See start()/stop()/clear().
        this.sessionId = null;
        this._sessionStartedAt = null;
        // First location fix obtained during the session, reused by
        // _persistSession() so a session records where it happened without a
        // second fix per save. Stays null when geoTagDetections is off — see
        // _recordSighting().
        this._sessionFix = null;
        // Edge-tracker for saving the session to IndexedDB, deliberately
        // SEPARATE from _lastSightingTuneId: _recordSighting() returns early
        // when geoTagDetections is off, but session history must be saved
        // regardless of that setting. See _maybeSaveSessionSnapshot().
        this._lastSavedTuneId = null;
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

        if (!this.sessionId) {
            // Fresh session — no open session to resume. Reset everything and
            // start a new session record; see _persistSession()/clear().
            this.detections = [];
            this._windowMatches = [];
            this.elapsedSeconds = 0;
            this._lastSightingTuneId = null;
            this._lastSavedTuneId = null;
            this._rejectedTunes.clear();
            this._sessionFix = null;
            this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            this._sessionStartedAt = Date.now();
        }
        // else: resuming — detections, _windowMatches, elapsedSeconds and the
        // rest are left exactly as stop() left them, so the list keeps
        // appending instead of restarting. See clear() for the only way to end
        // a session and force the next start() down the fresh-session branch.

        this.isRunning = true;
        this.isPaused = false;

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
        this._recluster();
        eventBus.$emit('liveAnalysisUpdate', this.detections);
    }

    // "That is not the tune I am playing." Drops the detection currently on
    // screen and stops it coming straight back, so the display falls back to
    // whatever was detected before it.
    //
    // Rejection targets the LATEST cluster of that tune, not every appearance
    // of it: an earlier, correct hearing of the same tune is a different claim
    // and must survive. removeDetection() already has exactly that semantics,
    // because a collapsed row's startSeconds/endSeconds span only its most
    // recent cluster.
    rejectTune(tuneId) {
        if (tuneId == null) return;
        const key = String(tuneId);
        this._rejectedTunes.set(key, this.elapsedSeconds);

        // Removing one cluster is not enough on its own. A tune heard earlier
        // and then again now is two clusters that collapseConsecutiveSameTune
        // has *not* merged (there was another tune between them, or a gap), so
        // dropping the latest can leave the one before it as the new tail — and
        // the overlay would sit on the same wrong tune, looking as though the
        // button did nothing. Keep going while the tail is still this tune.
        // Anything further back stays: an earlier hearing is a separate claim.
        let removedAny = false;
        while (this.detections.length) {
            const tail = this.detections[this.detections.length - 1];
            if (String(tail.tuneId) !== key) break;
            const before = this._windowMatches.length;
            this.removeDetection(tail.id);
            removedAny = true;
            // Defensive: if a removal ever failed to drop a match the loop
            // would not terminate. Better a stuck row than a hung session.
            if (this._windowMatches.length === before) break;
        }

        // Nothing was on the list for a tune that never became a detection, but
        // the suppression above is still wanted, so tell the view either way.
        if (!removedAny) eventBus.$emit('liveAnalysisUpdate', this.detections);
    }

    // Results for tunes the user has rejected, while the rejection still holds.
    // Filtering at the *results* level rather than after normalisation means the
    // next-best candidate is promoted to the top instead of the whole window
    // being thrown away — a window that only matched the rejected tune still
    // yields nothing, which is the same as before.
    _withoutRejectedTunes(results) {
        if (!this._rejectedTunes.size) return results;
        return results.filter(result => {
            const tuneId = result.setting ? result.setting.tune_id : null;
            if (tuneId == null) return true;
            const rejectedAt = this._rejectedTunes.get(String(tuneId));
            if (rejectedAt == null) return true;
            if (this.elapsedSeconds - rejectedAt >= REJECT_COOLDOWN_SECONDS) {
                this._rejectedTunes.delete(String(tuneId));
                return true;
            }
            return false;
        });
    }

    // Clustering, the short-detection filter and the same-tune collapse always
    // run together and always in this order. The filter goes BEFORE the collapse
    // so that a dropped one-window blip in the middle of a tune lets the two
    // halves either side of it merge into one row rather than reading as the
    // same tune twice.
    _recluster() {
        this.detections = collapseConsecutiveSameTune(
            filterShortPastDetections(clusterDetections(this._windowMatches, this.options))
        );
    }

    async stop() {
        if (!this.isRunning) return this._stopPromise || Promise.resolve();
        this.isRunning = false;
        this.isPaused = false;
        this._stopTimer();
        if (this._cancelSleep) { this._cancelSleep(); this._cancelSleep = null; }
        this._stopPromise = (async () => {
            try {
                // Flushes the tail tune's up-to-date endSeconds —
                // _maybeSaveSessionSnapshot() only saves on a tune CHANGE, so
                // without this the last tune's duration in IndexedDB could be
                // stale by however long it kept playing since that edge.
                // sessionId is deliberately left untouched, which is what makes
                // this session resumable rather than finished — see clear().
                //
                // Awaited (unlike _maybeSaveSessionSnapshot's fire-and-forget
                // calls) so it is ORDERED before clear()'s own finalizing write
                // to the same record: clear() calls stop() first, and without
                // this await the two writes could land out of order, with this
                // one's endedAt:null overwriting clear()'s endedAt:Date.now()
                // and silently un-finalizing the session.
                await this._persistSession();
                await micService.stopContinuous();
            } finally {
                eventBus.$emit('liveAnalysisStopped');
                this._stopPromise = null;
            }
        })();
        return this._stopPromise;
    }

    // Finalizes the open session (auto-saving it, so nothing is lost even if
    // the user never taps Clear — see stop()'s own flush) and resets everything
    // so the next start() is unambiguously fresh rather than a resume.
    async clear() {
        if (this.isRunning) await this.stop();
        // endedAt set — this is what marks the record non-resumable and final.
        await this._persistSession(Date.now());

        this.sessionId = null;
        this._sessionStartedAt = null;
        this._sessionFix = null;
        this._lastSavedTuneId = null;
        this.detections = [];
        this._windowMatches = [];
        this.elapsedSeconds = 0;
        this._lastSightingTuneId = null;
        this._rejectedTunes.clear();

        eventBus.$emit('liveAnalysisCleared');
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

                const usableResults = response.results
                    ? this._withoutRejectedTunes(response.results)
                    : [];

                if (this.isRunning && !this.isPaused && !response.error && usableResults.length > 0) {
                    const previousTuneId = this.detections.length > 0
                        ? this.detections[this.detections.length - 1].tuneId
                        : null;
                    const biasedResults = biasResultsTowardPrevious(
                        usableResults,
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
                            dataset: normalized.dataset,
                            displayName: normalized.displayName,
                            score: normalized.score,
                            alternatives: normalized.alternatives,
                        });
                        this._recluster();
                        this._recordSighting();
                        this._maybeSaveSessionSnapshot();
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
            // First fix of the session, reused by _persistSession() so a saved
            // session records where it happened without a second fix per save.
            // Only ever set here, so it stays null whenever geoTagDetections is
            // off (this whole method returns early above) — no separate gating
            // needed in _persistSession().
            if (this._sessionFix === null) this._sessionFix = fix;
            await store.addSighting({
                tuneID: latest.tuneId,
                settingID: latest.settingId,
                displayName: latest.title,
                fix,
                source: 'live',
            });
        })().catch(e => console.warn('Could not record sighting:', e && e.message));
    }

    // Edge-triggered on tail-tune-change, same rule as _recordSighting — but
    // tracked separately (_lastSavedTuneId, not _lastSightingTuneId) because
    // _recordSighting() returns early when geoTagDetections is off, and session
    // history must be saved regardless of that setting.
    _maybeSaveSessionSnapshot() {
        const latest = this.detections[this.detections.length - 1];
        if (!latest || latest.tuneId == null) return;
        if (String(latest.tuneId) === String(this._lastSavedTuneId)) return;
        this._lastSavedTuneId = latest.tuneId;
        this._persistSession();
    }

    // Serialises the current detections into the session record and writes it.
    // Called both fire-and-forget (from the edge-triggered
    // _maybeSaveSessionSnapshot(), so a slow write never stalls the analysis
    // loop) and awaited (from stop() and clear(), so the two writes a Clear
    // during a running session produces — stop()'s flush and clear()'s own
    // finalizing write — land in the right order; see stop()). No-ops before
    // the first tune is recognised, so a session that never matched anything
    // never clutters Past Sessions with an empty entry.
    _persistSession(endedAt = null) {
        if (!this.sessionId || !this.detections.length) return Promise.resolve();
        const record = {
            id: this.sessionId,
            startedAt: this._sessionStartedAt,
            endedAt,
            tunes: this.detections.map(d => ({
                tuneId: d.tuneId,
                settingId: d.settingId,
                sourceUrl: d.sourceUrl,
                dataset: d.dataset,
                title: d.title,
                startSeconds: d.startSeconds,
                endSeconds: d.endSeconds,
                bestScore: d.bestScore,
            })),
            lat: this._sessionFix ? this._sessionFix.lat : null,
            lon: this._sessionFix ? this._sessionFix.lon : null,
            accuracy: this._sessionFix ? (this._sessionFix.accuracy ?? null) : null,
        };
        return store.upsertLiveSession(record)
            .catch(e => console.warn('Could not save live session:', e && e.message));
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
