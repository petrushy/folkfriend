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

// How long an edit or a still-playing tune waits before the session is written
// again. Long enough that a burst of corrections costs one write, short enough
// that closing the tab loses at most a few seconds of the list.
const CHECKPOINT_DEBOUNCE_MS = 10_000;

// However often updates arrive, a checkpoint lands at least this often. A pure
// debounce is reset by every update, and the analysis loop produces one every
// few seconds all evening — so the "debounced" save would never actually fire
// during exactly the long unbroken session it exists for.
const CHECKPOINT_MAX_WAIT_MS = 60_000;

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

        // Whether the microphone is actually delivering audio right now.
        // ensureMicHealthy() returns false when a capture has died and could
        // not be reacquired, and the loop must not go on analysing the stale
        // seconds still sitting in the ring buffer — a session that silently
        // stops hearing anything while claiming to listen is the exact failure
        // this whole health-check path exists to end. See _runLoop().
        this.micHealthy = true;
        this.micIssue = '';

        // 'idle' | 'saving' | 'saved' | 'error', plus the last failure. A save
        // that fails has to be visible: the session lives in memory until it is
        // written, so a silent failure is the one way an evening can still be
        // lost. See _persistSession().
        this.saveState = 'idle';
        this.saveError = null;
        // Serialises session writes. Two saves racing (a checkpoint and a
        // finish, say) can otherwise land out of order and leave the older
        // snapshot as the stored one.
        this._saveChain = Promise.resolve();
        // Set once the session has a record on disk. Until then an empty tune
        // list means "nothing recognised yet" and is not worth storing; after
        // it, an empty list is a real edit (the user removed the last row) and
        // MUST be written, or the removal silently un-happens on reload.
        this._hasPersisted = false;
        this._checkpointTimer = null;
        // Latest time a checkpoint actually reached storage, so a stream of
        // updates cannot postpone one indefinitely — see _scheduleCheckpoint().
        this._lastCheckpointAt = 0;

        // Bumped by every lifecycle transition (start, stop, finish, abandon).
        // The analysis loop captures it and re-checks after every await: a
        // transcription in flight when the user pauses resolves into a loop
        // that no longer owns the microphone, and without this it sees
        // isRunning true again after a quick Resume, appends its stale result
        // and carries on running ALONGSIDE the new loop.
        this._generation = 0;

        // mic.js knows capture has died before the next analysis cycle asks,
        // so adopt its verdict directly rather than waiting up to a full step
        // to notice. This keeps micHealthy the SINGLE source of truth — the UI
        // reads the service, never the microphone, so the two cannot disagree.
        eventBus.$on('micLost', ({ reason } = {}) => {
            if (!this.isRunning) return;
            this.micHealthy = false;
            this.micIssue = reason || '';
            eventBus.$emit('liveAnalysisMicState', { healthy: false, reason: this.micIssue });
        });
        eventBus.$on('micRecovered', () => {
            if (!this.isRunning) return;
            this.micHealthy = true;
            this.micIssue = '';
            eventBus.$emit('liveAnalysisMicState', { healthy: true, reason: '' });
        });
    }

    // True when a session exists but the microphone is released — the state
    // Pause leaves behind, and the one a reloaded app restores into.
    get isPausedSession() {
        return !!this.sessionId && !this.isRunning;
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
            this._hasPersisted = false;
            this.saveState = 'idle';
            this.saveError = null;
            this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            this._sessionStartedAt = Date.now();
        }
        // else: resuming — detections, _windowMatches, elapsedSeconds and the
        // rest are left exactly as stop() left them, so the list keeps
        // appending instead of restarting. See clear() for the only way to end
        // a session and force the next start() down the fresh-session branch.

        this.isRunning = true;
        this.isPaused = false;
        this.micHealthy = true;

        // Warms one location fix for the whole session. Not awaited: the
        // session must start on the microphone, never on the radio. By the time
        // the first tune is recognised (a window later, at least) the fix is
        // normally already there.
        geoService.beginSession();

        try {
            await micService.startContinuous(windowSeconds);
        } catch (e) {
            this.isRunning = false;
            // The session itself survives a microphone that would not open —
            // resuming is exactly what the user will try next, and throwing
            // away their tune list for a failed getUserMedia would be the
            // worst possible answer to it.
            this.micHealthy = false;
            eventBus.$emit('liveAnalysisMicState', { healthy: false });
            throw e;
        }

        this._sampleRate = micService.audioCtx ? micService.audioCtx.sampleRate : 48000;

        this._startTimer();

        const generation = ++this._generation;
        // Fire-and-forget: loop runs independently of any Vue component
        this._runLoop(options, false, generation).catch(e => {
            console.error('Live analysis loop error:', e);
            if (generation === this._generation) this.stop();
        });
    }

    // Releases the microphone and keeps the session open. Resuming is just
    // start() again, which finds sessionId set and continues appending.
    //
    // There used to be a SECOND pause that stopped only the analysis loop and
    // left the capture open. Two pause-shaped controls, one of which quietly
    // held the microphone, is not a distinction a user in a pub can be asked
    // to make — and the one that kept recording was the surprising default.
    // Pause now means what it says.
    pause() {
        return this.stop();
    }

    // Ends the session for good: a final save, then the state reset that makes
    // the next start() a fresh session.
    //
    // Returns { ok, error }. The session is NOT closed when the save fails —
    // the in-memory copy is the only remaining copy at that point, and
    // throwing it away to honour a button press would be the one unrecoverable
    // thing this code can do. The caller shows the error and offers a retry.
    async finish() {
        if (!this.sessionId) return { ok: true };
        if (this.isRunning) await this.stop();
        this._generation++;

        const result = await this._persistSession({ endedAt: Date.now() });
        if (!result.ok) {
            eventBus.$emit('liveAnalysisSaveState', this._saveSnapshot());
            return result;
        }

        await this._clearResumeState();
        this._resetSessionState();
        eventBus.$emit('liveAnalysisFinished');
        return result;
    }

    // Drops the open session WITHOUT saving. Only for a session the user has
    // deleted from their history: finishing it would write the record straight
    // back, which is what makes a delete look like it silently failed.
    async abandon() {
        if (this.isRunning) await this.stop({ flush: false });
        this._generation++;
        this._cancelCheckpoint();
        await this._clearResumeState();
        this._resetSessionState();
        eventBus.$emit('liveAnalysisFinished');
    }

    _resetSessionState() {
        this.sessionId = null;
        this._sessionStartedAt = null;
        this._sessionFix = null;
        this._lastSavedTuneId = null;
        this._hasPersisted = false;
        this.detections = [];
        this._windowMatches = [];
        this.elapsedSeconds = 0;
        this._lastSightingTuneId = null;
        this._rejectedTunes.clear();
        this.saveState = 'idle';
        this.saveError = null;
    }

    // Reacquires the microphone for a session that is running but has lost
    // capture, without touching the session or its tune list.
    // An explicit tap must actually try. ensureMicHealthy() honours the
    // automatic retry backoff, which is right for the once-a-second watchdog
    // and wrong here — during a backoff window the button would do nothing at
    // all, which reads as broken.
    async retryMicrophone() {
        if (!this.isRunning) return false;
        const healthy = await micService.ensureMicHealthy({ force: true });
        this.micHealthy = healthy;
        eventBus.$emit('liveAnalysisMicState', { healthy });
        return healthy;
    }

    // The user picked a different tune for a row than the one detected.
    //
    // The correction is written into the underlying WINDOW MATCHES, not onto
    // the detection object, and that is the whole trick. Detections are
    // rebuilt from those matches every cycle and their ids are not stable
    // across a re-cluster (the id carries the cluster's index, which shifts as
    // clusters merge or get filtered), so anything recorded against a
    // detection is lost within seconds. Rewriting the matches means the very
    // next re-cluster reproduces the correction on its own — and it stays
    // consistent with removeDetection(), which finds matches by tuneId.
    applyCorrection(id, selection) {
        const target = this.detections.find(d => d.id === id);
        if (!target || !selection || selection.tuneId == null) return;

        const epsilon = 1e-6;
        for (const match of this._windowMatches) {
            const withinRow = match.tuneId === target.tuneId &&
                match.startSeconds >= target.startSeconds - epsilon &&
                match.startSeconds <= target.endSeconds + epsilon;
            if (!withinRow) continue;
            match.tuneId = selection.tuneId;
            match.settingId = selection.settingId;
            match.displayName = selection.title;
            match.sourceUrl = selection.sourceUrl || '';
            match.dataset = selection.dataset || '';
        }

        this._recluster();
        this._scheduleCheckpoint();
        eventBus.$emit('liveAnalysisUpdate', this.detections);
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
        // A removal changes the list without changing the tail tune, so the
        // edge trigger will not fire and the stored copy would keep the row
        // the user just deleted until some later tune change happened to save.
        this._scheduleCheckpoint();
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
        else this._scheduleCheckpoint();
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

    // `flush` is false only for abandon(), which is tearing down a session the
    // user has just deleted — flushing there writes the deleted record
    // straight back, and the delete looks like it silently failed.
    async stop({ flush = true } = {}) {
        if (!this.isRunning) return this._stopPromise || Promise.resolve();
        this.isRunning = false;
        this.isPaused = false;
        this._stopTimer();
        this._cancelCheckpoint();
        // Ends the run: any transcription still in flight resolves into a loop
        // that no longer owns the microphone and must not touch anything.
        this._generation++;
        if (this._cancelSleep) { this._cancelSleep(); this._cancelSleep = null; }
        this._stopPromise = (async () => {
            try {
                // The microphone is released FIRST. Pause is a direct response
                // to a tap — often "stop listening to me" — and making it wait
                // on a storage write means slow or failing storage holds the
                // microphone open for as long as it takes.
                await micService.stopContinuous();
                // Flushes the tail tune's up-to-date endSeconds —
                // _maybeSaveSessionSnapshot() only saves on a tune CHANGE, so
                // without this the last tune's duration in IndexedDB could be
                // stale by however long it kept playing since that edge.
                // sessionId is deliberately left untouched, which is what makes
                // this session resumable rather than finished — see clear().
                //
                // Awaited (unlike _maybeSaveSessionSnapshot's fire-and-forget
                // calls) so it is ORDERED before finish()'s own finalizing
                // write to the same record: finish() pauses first, and without
                // this await the two writes could land out of order, with this
                // one's endedAt:null overwriting finish()'s endedAt and
                // silently un-finalizing the session.
                if (flush) await this._persistSession();
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

    // `generation` is the run this loop belongs to. Anything that ends a run —
    // pause, finish, abandon, a restart — bumps it, and every await below is
    // followed by a check, so a loop whose run is over stops touching state
    // that now belongs to a different one.
    async _runLoop(options, skipInitialWait, generation) {
        const current = () => generation === this._generation;

        if (!skipInitialWait) {
            await this._sleepCancellable(options.windowSeconds * 1000);
        }

        while (this.isRunning && !this.isPaused && current()) {
            const cycleStart = Date.now();
            // Capture can die under us mid-session: the AudioContext suspends
            // (backgrounded tab, or a browser power-saving heuristic), or the
            // OS hands the microphone to another app and our track ends or
            // goes permanently muted. Either way the ring buffer silently
            // freezes and we keep re-analysing the same stale seconds. Check
            // every cycle so the session recovers on its own rather than
            // needing the user to notice and restart it. See mic.js.
            const healthy = await micService.ensureMicHealthy();
            if (!current()) break;
            if (healthy !== this.micHealthy) {
                this.micHealthy = healthy;
                eventBus.$emit('liveAnalysisMicState', { healthy });
            }

            // A capture that could not be reacquired leaves the ring buffer
            // frozen on the last seconds it managed to record. Analysing those
            // again produces confident detections of audio from minutes ago —
            // worse than no detection, because the list then claims tunes were
            // played that were not. Skip the cycle and try again next time;
            // mic.js is backing off and retrying underneath.
            const pcm = healthy ? micService.getContinuousAudio() : new Float32Array(0);

            if (pcm.length > 0) {
                // Guard against a hung worker — generous ceiling well beyond
                // any healthy backend latency (~3s), so a real backend never
                // hits this and a stuck cycle still recovers on the next step.
                const analysisCeilingMs = Math.max(15_000, options.windowSeconds * 4 * 1000);
                let response;
                try {
                    response = await Promise.race([
                        // Re-read rather than using the rate captured at
                        // start(): a recovery reopens the pipeline and can come
                        // back on a different rate.
                        ffBackend.transcribeAndQueryPCMSignal(
                            pcm, micService.sampleRate || this._sampleRate),
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

                // The transcription above is the long await, and the one a
                // pause is most likely to land inside.
                if (!current()) break;

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
                        // Even when the tail tune has not changed, the tune's
                        // duration, the elapsed time and the resume state have
                        // — so a tune played for twenty minutes would
                        // otherwise store nothing after its first cycle.
                        this._scheduleCheckpoint();
                        eventBus.$emit('liveAnalysisUpdate', this.detections);
                    }
                }
            }

            if (!this.isRunning || this.isPaused || !current()) break;
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
    // Returns the write so a caller that needs it settled can await it. The
    // analysis loop deliberately does not — a slow disk must never stall
    // detection — but everything else, tests included, should.
    _maybeSaveSessionSnapshot() {
        const latest = this.detections[this.detections.length - 1];
        if (!latest || latest.tuneId == null) return Promise.resolve({ ok: true });
        if (String(latest.tuneId) === String(this._lastSavedTuneId)) {
            return Promise.resolve({ ok: true });
        }
        this._lastSavedTuneId = latest.tuneId;
        return this._persistSession();
    }

    // A save that is not tied to the tail tune changing.
    //
    // The edge trigger alone leaves real gaps: one long tune played for twenty
    // minutes writes nothing after its first cycle, and an edit — a removal, a
    // rejection, a corrected tune — changes the list without changing the tail
    // at all. Debounced rather than immediate so a burst of corrections costs
    // one write, and because these arrive from the UI thread while the loop is
    // also saving.
    _scheduleCheckpoint(delayMs = CHECKPOINT_DEBOUNCE_MS) {
        if (!this.sessionId) return;

        // Overdue: save now rather than pushing the deadline out again.
        const since = Date.now() - (this._lastCheckpointAt || 0);
        if (this._lastCheckpointAt && since >= CHECKPOINT_MAX_WAIT_MS) {
            this._cancelCheckpoint();
            this._persistSession();
            return;
        }

        // Otherwise debounce, but never past the ceiling.
        const remaining = this._lastCheckpointAt
            ? Math.max(0, CHECKPOINT_MAX_WAIT_MS - since)
            : CHECKPOINT_MAX_WAIT_MS;
        this._cancelCheckpoint();
        this._checkpointTimer = setTimeout(() => {
            this._checkpointTimer = null;
            this._persistSession();
        }, Math.min(delayMs, remaining));
    }

    _cancelCheckpoint() {
        if (this._checkpointTimer) {
            clearTimeout(this._checkpointTimer);
            this._checkpointTimer = null;
        }
    }

    _saveSnapshot() {
        return { state: this.saveState, error: this.saveError };
    }

    _setSaveState(state, error = null) {
        if (this.saveState === state && this.saveError === error) return;
        this.saveState = state;
        this.saveError = error;
        eventBus.$emit('liveAnalysisSaveState', this._saveSnapshot());
    }

    // Serialises the current detections into the session record and writes it,
    // reporting { ok, error } rather than swallowing a failure — the in-memory
    // list is the only copy until this succeeds, so a silent failure here is
    // the one remaining way to lose an evening.
    //
    // Every write goes through _saveChain, so a checkpoint and a finish cannot
    // land out of order and leave the older snapshot stored.
    //
    // Before the first successful write an empty tune list is "nothing has
    // been recognised yet" and is not worth a record. Afterwards it is an edit
    // — the user removed the last row — and must be written, or the removal
    // un-happens on the next reload.
    _persistSession({ endedAt = null } = {}) {
        if (!this.sessionId) return Promise.resolve({ ok: true });
        if (!this.detections.length && !this._hasPersisted) {
            return Promise.resolve({ ok: true });
        }

        this._cancelCheckpoint();
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
            // How long the microphone was actually listening, which is not the
            // same as endedAt - startedAt once a session has been paused.
            listenedSeconds: Math.round(this.elapsedSeconds),
            lat: this._sessionFix ? this._sessionFix.lat : null,
            lon: this._sessionFix ? this._sessionFix.lon : null,
            accuracy: this._sessionFix ? (this._sessionFix.accuracy ?? null) : null,
        };

        this._setSaveState('saving');
        this._saveChain = this._saveChain.then(async () => {
            try {
                await store.upsertLiveSession(record);
                this._hasPersisted = true;
                this._lastCheckpointAt = Date.now();
                // Reported, not swallowed: resume state that failed to save is
                // a session that cannot be recovered after a reload, and the
                // user has no way to know unless we say so.
                await this._saveResumeState();
                this._setSaveState('saved');
                return { ok: true };
            } catch (e) {
                const message = (e && e.message) || String(e);
                console.warn('Could not save live session:', message);
                this._setSaveState('error', message);
                return { ok: false, error: message };
            }
        });
        return this._saveChain;
    }

    // Enough state to carry an unfinished session across a reload.
    //
    // Local-only and separate from the session record: it holds the raw window
    // matches, which are what clustering needs to keep producing the SAME list
    // rather than starting a second one beside it. They are also several times
    // the size of the record itself and of no interest to another device, so
    // they have no business on the synced document.
    _saveResumeState() {
        if (!this.sessionId) return Promise.resolve();
        return store.setOpenLiveSession({
            sessionId: this.sessionId,
            startedAt: this._sessionStartedAt,
            elapsedSeconds: this.elapsedSeconds,
            options: this.options,
            windowMatches: this._windowMatches,
            lastSightingTuneId: this._lastSightingTuneId,
            lastSavedTuneId: this._lastSavedTuneId,
            fix: this._sessionFix,
        });
    }

    _clearResumeState() {
        return store.clearOpenLiveSession()
            .catch(e => console.warn('Could not clear session resume state:', e && e.message));
    }

    // Restores an unfinished session left behind by a reload, WITHOUT opening
    // the microphone. The user is offered Resume and Finish; listening again
    // is always a deliberate act, never something a page load does on its own.
    async restoreOpenSession() {
        if (this.sessionId) return !!this.sessionId;
        const saved = await store.getOpenLiveSession();
        if (!saved || !saved.sessionId) return false;

        // Strict: a read that FAILED must not be read as "the record is gone",
        // because the next line would then throw away recoverable state over a
        // transient disk error.
        const record = (await store.getLiveSessionsStrict())
            .find(s => s.id === saved.sessionId);

        // The resume state outlived the session record — the user deleted it
        // from their history in another tab, or a save never landed. Either
        // way there is nothing to resume into.
        //
        // A record with endedAt is FINISHED, and resuming it would reopen a
        // session the user has already closed — appending tonight's tunes to
        // last night's evening.
        if (!record || record.endedAt) {
            await this._clearResumeState();
            return false;
        }

        this.sessionId = saved.sessionId;
        this._sessionStartedAt = saved.startedAt || record.startedAt || Date.now();
        this.elapsedSeconds = saved.elapsedSeconds || 0;
        this.options = saved.options || null;
        this._windowMatches = saved.windowMatches || [];
        this._lastSightingTuneId = saved.lastSightingTuneId ?? null;
        this._lastSavedTuneId = saved.lastSavedTuneId ?? null;
        this._sessionFix = saved.fix || null;
        this._hasPersisted = true;
        this.isRunning = false;
        this.isPaused = true;

        // Re-cluster from the matches where possible so a resumed session
        // keeps appending to the same rows. With no options (a session saved
        // by an older build) the stored tune list is still shown, but it can
        // only be finished, not extended — clustering needs the window and
        // step it was recorded with.
        if (this.options && this._windowMatches.length) {
            this._recluster();
        } else {
            this.detections = (record.tunes || []).map((tune, index) => ({
                ...tune,
                id: `restored-${index}`,
                averageScore: tune.bestScore,
                hits: 1,
                alternatives: [],
            }));
        }

        eventBus.$emit('liveAnalysisRestored', this.detections);
        return true;
    }

    // Whether a restored session can actually keep clustering, or can only be
    // read and finished.
    canResume() {
        return !!this.sessionId && !!this.options;
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
