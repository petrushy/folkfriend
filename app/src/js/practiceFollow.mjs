// Listening for the Tune view's practice follow: the microphone, a window of
// what was just played every few seconds, transcribed to a contour and
// published for the view to align against the ONE setting being practised
// (js/scoreFollower.mjs). Dependencies are injected so this runs in node;
// services/practiceFollow.js wires the real ones.
//
// What it deliberately does not do, because practising is not a session:
// no search over the tune index (the setting is known — that is also why it
// works with no index loaded), no session record, no history, no sightings,
// no recording.
//
// It shares the microphone with a live session rather than fighting it:
//   - while a session is LISTENING, its windows are used (it already
//     publishes each one's contour) and nothing is transcribed twice;
//   - a session started while practising simply finds the microphone open
//     (micService.startContinuous returns early) and uses it, and stop()
//     then leaves it open, since it is the session's now;
//   - a session that pauses releases the microphone, and practice reopens it
//     on its next cycle.

import { windowPosition } from './scorePosition.mjs';
import { updateLatencyEstimate, effectiveStepSeconds } from './liveCadence.mjs';

export const PRACTICE_WINDOW_SECONDS = 10;
// The first window is analysed this soon, on what has been heard so far, so
// the band appears a few seconds into playing rather than after a whole
// window. windowPosition() refuses a contour too short to place.
export const PRACTICE_FIRST_QUERY_SECONDS = 4;
// The step on a slow device; a fast one steps sooner (js/liveCadence.mjs).
export const PRACTICE_STEP_SECONDS = 4;

export class PracticeFollow {
    // deps: { mic, backend, live, emit, now, sleep }
    //   mic     — startContinuous(s), stopContinuous(), ensureMicHealthy(),
    //             getContinuousAudio(), sampleRate, isListening()
    //   backend — transcribePCMSignal(pcm, rate) → { error, contour }
    //   live    — the live session service: isRunning, isPaused, scorePosition
    //   emit    — (event, payload) for 'practiceFollowState' and
    //             'practiceFollowPosition'
    constructor(deps) {
        this.deps = deps;
        this.active = false;
        this.settingId = null;
        this.position = null;
        this.error = '';
        this._generation = 0;
        this._ownsMic = false;
    }

    state() {
        return { active: this.active, settingId: this.settingId, error: this.error };
    }

    _sessionListening() {
        const live = this.deps.live;
        return !!(live && live.isRunning && !live.isPaused);
    }

    // Starts listening for `settingId`, replacing any setting being followed.
    // Rejects when the microphone cannot be opened, with nothing left running.
    async start(settingId) {
        await this.stop({ quiet: true });
        const generation = ++this._generation;
        this.active = true;
        this.settingId = settingId;
        this.position = null;
        this.error = '';
        try {
            await this._ensureMic();
        } catch (e) {
            if (generation === this._generation) {
                this.active = false;
                this.settingId = null;
                this.error = (e && e.message) || 'The microphone could not be opened.';
                this.deps.emit('practiceFollowState', this.state());
            }
            throw e;
        }
        if (generation !== this._generation) return;
        this.deps.emit('practiceFollowState', this.state());
        this._loop(generation);
    }

    async stop({ quiet = false } = {}) {
        const wasActive = this.active;
        this._generation++;
        this.active = false;
        this.settingId = null;
        this.position = null;
        const owned = this._ownsMic;
        this._ownsMic = false;
        // A session that started while practising is using this microphone.
        // A PAUSED one is not: it released the microphone and reopens it
        // itself on Resume.
        if (owned && !this._sessionListening()) {
            try { await this.deps.mic.stopContinuous(); } catch (_) { /* already closed */ }
        }
        if (wasActive && !quiet) this.deps.emit('practiceFollowState', this.state());
    }

    async _ensureMic() {
        if (this._sessionListening()) {
            this._ownsMic = false;
            return;
        }
        if (this.deps.mic.isListening()) return;
        await this.deps.mic.startContinuous(PRACTICE_WINDOW_SECONDS);
        this._ownsMic = true;
    }

    _publish(position) {
        if (!position) return;
        this.position = position;
        this.deps.emit('practiceFollowPosition', position);
    }

    async _loop(generation) {
        const current = () => generation === this._generation;
        let latencyMs = null;
        await this.deps.sleep(PRACTICE_FIRST_QUERY_SECONDS * 1000);
        while (current()) {
            const cycleStart = this.deps.now();
            if (this._sessionListening()) {
                // The session already analyses every window; take its latest.
                this._ownsMic = false;
                const position = this.deps.live.scorePosition;
                if (position && (!this.position || position.readAt !== this.position.readAt)) {
                    this._publish(position);
                }
            } else {
                try {
                    await this._ensureMic();
                } catch (e) {
                    console.warn('Practice follow: microphone unavailable:', e && e.message);
                }
                if (!current()) break;
                const healthy = await this.deps.mic.ensureMicHealthy();
                if (!current()) break;
                // A capture that could not be reacquired holds stale audio;
                // following it would claim the player is somewhere they are not.
                const pcm = healthy ? this.deps.mic.getContinuousAudio() : new Float32Array(0);
                // The window ends now, not when its transcription returns.
                const readAt = this.deps.now();
                const sampleRate = this.deps.mic.sampleRate || 48000;
                if (pcm.length > 0) {
                    const started = this.deps.now();
                    let response;
                    try {
                        response = await this.deps.backend.transcribePCMSignal(pcm, sampleRate);
                    } catch (e) {
                        response = { error: (e && e.message) || 'transcription failed', contour: '' };
                    }
                    if (!current()) break;
                    if (!response.error) {
                        latencyMs = updateLatencyEstimate(latencyMs, this.deps.now() - started);
                        this._publish(windowPosition(response.contour, {
                            readAt, windowSeconds: pcm.length / sampleRate,
                        }));
                    }
                }
            }
            const stepMs = effectiveStepSeconds(PRACTICE_STEP_SECONDS, latencyMs) * 1000;
            await this.deps.sleep(Math.max(0, stepMs - (this.deps.now() - cycleStart)));
        }
    }
}
