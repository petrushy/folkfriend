import ffBackend from '@/services/backend.js';
import eventBus from '@/eventBus.js';
import store from './store';

// Build getUserMedia constraints.
//
// All three of these are the browser's VOICE processing chain, tuned for
// speech on a call, and this app is feeding music to a pitch tracker:
//
//  - echoCancellation mangles music outright.
//  - noiseSuppression is a speech-band gate. It attacks exactly what a tune is
//    made of — sustained tones, room reverb, the other instruments — and it is
//    also the one plausible way a WORKING capture reaches digital silence, so
//    it interacts badly with the silence watchdog below.
//  - autoGainControl is opt-in via settings: it lets the OS boost quiet input
//    at capture time (better than post-capture digital gain, which cannot
//    improve SNR), at the risk of level "pumping" on sustained notes.
//
// Bare values are IDEAL constraints per the spec, not required ones, so a
// browser that does not support one ignores it rather than failing
// getUserMedia. Asking is therefore free; what actually gets applied is
// recorded in appliedAudioSettings, because browsers differ and iOS in
// particular decides much of this from its own audio session.
function audioConstraints() {
    return {
        audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: !!store.userSettings.autoGainControl,
        }
    };
}

// How often to check that audio is still flowing while a capture is open. Only
// runs while the tab is in the foreground, and does nothing at all unless
// something is actually wrong.
const HEALTH_CHECK_INTERVAL_MS = 2000;

// No audio chunk for this long, while the context claims to be running and the
// tab is visible, means the capture has silently died.
const AUDIO_STALL_MS = 1500;

// A capture can also die WITHOUT the buffers stopping. When another app takes
// the microphone — a call, a video, anything that grabs the input — the OS
// commonly hands back a track that is still 'live', still unmuted, feeding an
// AudioContext that is still 'running', and every buffer is digital silence,
// for ever. Every other check here passes: chunks arrive on schedule, so the
// stall test is happy, and `track.muted` is the flag browsers set least
// reliably. The session simply stops hearing anything and says it is listening.
//
// Anything above this RMS counts as signal. It is a "is this literally dead"
// threshold, not a "is this quiet" one: a live microphone in a silent room
// still has a noise floor two or three orders of magnitude above it, while a
// dead capture is exact zeroes.
const SILENT_RMS = 1e-6;

// How long that has to persist before the capture is rebuilt, escalating each
// time a rebuild fails to bring the sound back. Without the escalation, a
// genuinely silent input (a muted external interface, an aggressive noise gate
// in a quiet room) would be reacquired every ten seconds for ever. Any real
// audio resets it.
const SILENT_WINDOWS_MS = [10_000, 30_000, 60_000];

// After resuming a suspended context, how long to wait for the first buffer
// before concluding it is never coming. One ScriptProcessor buffer at 48 kHz is
// ~21 ms, so this is very generous.
const AUDIO_RESUME_GRACE_MS = 750;

// Backoff between re-acquisition attempts after a failure, so a permanently
// revoked microphone doesn't spin getUserMedia every couple of seconds.
const RECOVERY_BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];

class MicService {
    constructor() {
        this.micProcessor = null;
        this.micSource = null;
        this.micStream = null;
        this.audioCtx = null;
        this.opening = Promise.resolve();
        this.finishOpening = null;
        this.bufferSize = 1024;

        this.recordingTimer = null;

        // Which capture pipeline is meant to be open: 'recording',
        // 'continuous', or null for none. Recovery needs to know what to
        // rebuild, and it doubles as "should the mic be running at all" — every
        // health check is a no-op while it is null.
        this._mode = null;
        this._continuousDurationSecs = null;
        // Bumped by every stop, so a recovery that was in flight when the user
        // stopped can tell that its result is no longer wanted.
        this._captureGeneration = 0;
        this._recovering = null;
        this._healthCheck = null;
        this._healthInterval = null;
        this._recoveryFailures = 0;
        this._nextRecoveryAt = 0;

        // Monotonic count of audio chunks delivered by the ScriptProcessorNode,
        // and when the last one arrived. Never reset — what matters for health
        // is whether the count *advances*, not its value.
        this._chunkCount = 0;
        this._lastChunkAt = 0;
        // Last time a chunk contained anything at all, and how many times a
        // rebuild has failed to change that. See SILENT_RMS.
        this._lastSoundAt = 0;
        this._silenceStrikes = 0;
        this._silenceReported = false;

        // What the device ACTUALLY applied, from the track itself — asking for
        // a constraint and getting it are different things, and on an iPhone
        // PWA there is no console to check without a Mac and a cable. Surfaced
        // in Settings so it can be read on the device that matters.
        this.appliedAudioSettings = null;

        // Running RMS accumulator. Both startRecording() and startContinuous()
        // feed every chunk through _accumulateRms(); UI components call
        // getRmsLevel() at their poll rate (e.g. once per second) to get the
        // integrated level since the last read.
        this._rmsSquaredSum = 0;
        this._rmsSampleCount = 0;

        this._ringBuffer = [];
        this._ringBufferMaxChunks = 0;

        // Retained PCM of the current manual recording, for optional WAV export
        // (building a personal test-clip collection). Ring-bounded for safety.
        this._recordingPcm = [];
        this._recordingSampleRate = null;
        // Cap retained audio at ~120 s to bound memory (advancedMode removes the
        // recording time limit). Older chunks are dropped beyond this.
        this._recordingMaxChunks = Math.ceil((120 * 48000) / this.bufferSize);

        // Coming back from another app is where capture dies, and there are two
        // distinct failures behind the one symptom of "it stopped hearing me":
        //
        //  - The AudioContext is suspended. Browsers suspend a context that
        //    isn't producing audible output (ours never does — the
        //    ScriptProcessorNode is wired to destination only to keep
        //    onaudioprocess firing, and never writes to the output buffer)
        //    after a period of inactivity, and unconditionally whenever the tab
        //    is backgrounded. resume() fixes this one.
        //  - The MediaStreamTrack itself is gone. iOS hands the microphone to
        //    whatever the user switched to, and our track ends, or comes back
        //    permanently muted. Resuming the context achieves nothing here:
        //    onaudioprocess fires again and delivers silence forever. The only
        //    fix is a fresh getUserMedia and a rebuilt graph.
        //
        // Either way a live session silently stops seeing new audio — the ring
        // buffer keeps re-serving its last few seconds, and the follow view
        // looks "stuck" on whatever was last detected. ensureMicHealthy()
        // handles both, and is called whenever we return to the foreground, on
        // a track 'ended' event, from the watchdog below, and once per cycle by
        // the live analysis loop.
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState !== 'visible') return;
                // Returning to the foreground is exactly when a backed-off
                // retry deserves a fresh chance.
                this._nextRecoveryAt = 0;
                this.ensureMicHealthy();
            });
        }
    }

    // The rate the currently open capture is delivering. Analysis jobs declare
    // this so a concurrent file analysis cannot change how their samples are
    // interpreted — see backend._applySampleRateForJob.
    get sampleRate() {
        return (this.audioCtx && this.audioCtx.sampleRate) || this._recordingSampleRate || null;
    }

    async resumeIfSuspended() {
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            try {
                await this.audioCtx.resume();
            } catch (e) {
                // Nothing to do — will retry on the next check.
            }
        }
    }

    // ---- capture health ---------------------------------------------------

    _isHidden() {
        return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    }

    _micTrack() {
        if (!this.micStream) return null;
        const tracks = this.micStream.getAudioTracks
            ? this.micStream.getAudioTracks()
            : this.micStream.getTracks();
        return tracks && tracks.length ? tracks[0] : null;
    }

    // Why the current capture is unusable, or null if it looks healthy.
    // Records what the browser actually gave us. Safari reports a narrower set
    // than Chrome, and a key that is simply absent means "this browser will not
    // say" — which is different from "off" and must not be shown as off.
    _recordAppliedSettings() {
        const track = this._micTrack();
        if (!track || typeof track.getSettings !== 'function') {
            this.appliedAudioSettings = null;
            return;
        }
        try {
            const settings = track.getSettings() || {};
            this.appliedAudioSettings = {
                echoCancellation: settings.echoCancellation,
                noiseSuppression: settings.noiseSuppression,
                autoGainControl: settings.autoGainControl,
                sampleRate: settings.sampleRate,
            };
            console.debug('Microphone audio processing applied:', this.appliedAudioSettings);
        } catch (e) {
            this.appliedAudioSettings = null;
        }
    }

    _captureFault() {
        if (!this.micStream) return 'no stream';
        const track = this._micTrack();
        if (!track) return 'no audio track';
        // 'ended' is terminal — the OS gave the microphone to another app.
        if (track.readyState && track.readyState !== 'live') return `track ${track.readyState}`;
        // iOS mutes the track when another app takes the microphone (a call,
        // Siri, Voice Memos) and does not reliably unmute it on return.
        if (track.muted) return 'track muted';
        if (!this.audioCtx || this.audioCtx.state === 'closed') return 'audio context closed';
        return null;
    }

    _audioStalled() {
        return this._lastChunkAt > 0 && Date.now() - this._lastChunkAt > AUDIO_STALL_MS;
    }

    _silenceWindowMs() {
        return SILENT_WINDOWS_MS[Math.min(this._silenceStrikes, SILENT_WINDOWS_MS.length - 1)];
    }

    // Buffers are arriving, and every one of them is empty.
    //
    // Not checked while backgrounded: a hidden tab may legitimately deliver
    // nothing, and re-acquiring there would either fail or snatch the
    // microphone back from whatever the user switched to.
    _audioSilent() {
        if (!this._mode || !this._lastSoundAt || this._isHidden()) return false;
        if (this._audioStalled()) return false;   // that is the other fault
        return Date.now() - this._lastSoundAt > this._silenceWindowMs();
    }

    // Resolves true as soon as a new audio chunk arrives, false if none does
    // within ms (or the capture is stopped while waiting).
    _waitForAudio(ms) {
        const start = this._chunkCount;
        const deadline = Date.now() + ms;
        return new Promise(resolve => {
            const check = () => {
                if (this._chunkCount > start) return resolve(true);
                if (!this._mode || Date.now() >= deadline) return resolve(false);
                setTimeout(check, 25);
            };
            setTimeout(check, 25);
        });
    }

    // Verify the capture is actually alive and rebuild it if it isn't. Safe to
    // call at any time: a no-op when no capture is open, and serialised so
    // concurrent callers share a single check. Resolves true if the mic is (or
    // has been made) healthy.
    //
    // The serialisation matters: returning to the foreground fires the
    // visibility handler, the watchdog and the live-analysis loop at nearly the
    // same moment, and each one racing its own getUserMedia would leave
    // orphaned microphones open. `_healthCheck` is assigned before the first
    // await, so concurrent callers always join the one in flight.
    // `force` is for an explicit user action ("Retry microphone"). The
    // automatic backoff below exists to stop the watchdog spinning
    // getUserMedia against a permanently denied microphone; applying it to a
    // deliberate tap means the button silently does nothing for up to thirty
    // seconds, which reads as broken. A tap is also new information — the user
    // has probably just hung up the call that took the microphone.
    ensureMicHealthy({ force = false } = {}) {
        if (!this._mode) return Promise.resolve(true);
        if (this._recovering) return this._recovering;
        if (force) {
            this._nextRecoveryAt = 0;
            this._recoveryFailures = 0;
            // Never join an in-flight passive check: it may already have
            // decided to back off, and returning its answer would make the tap
            // look ignored.
            this._healthCheck = null;
        } else if (this._healthCheck) {
            return this._healthCheck;
        }

        this._healthCheck = this._runHealthCheck(force)
            .finally(() => { this._healthCheck = null; });
        return this._healthCheck;
    }

    async _runHealthCheck(force = false) {
        await this.resumeIfSuspended();
        if (!this._mode) return true;

        let fault = this._captureFault();

        if (!fault && this._audioStalled()) {
            // The track says it is live and the context says it is running, but
            // nothing is coming out. A context that has just resumed takes a
            // few milliseconds to deliver its first buffer, so give it a
            // moment before writing the capture off.
            const flowing = await this._waitForAudio(AUDIO_RESUME_GRACE_MS);
            if (!this._mode) return true;
            fault = flowing ? this._captureFault() : 'no audio delivered';
        }

        if (!fault && this._audioSilent()) {
            // Count the attempt before making it, so a rebuild that does not
            // restore the sound waits longer before the next one.
            this._silenceStrikes++;
            fault = 'no signal';

            // Rebuilding usually fixes this and the user never needs to know.
            // Once a rebuild has already failed to bring the sound back, it is
            // not going to fix itself, and an app sitting there claiming to
            // listen while it hears nothing is the failure this whole path
            // exists to end — so say so.
            if (this._silenceStrikes > 1 && !this._silenceReported) {
                this._silenceReported = true;
                eventBus.$emit('micLost', { reason: 'no signal from the microphone' });
            }
        }

        if (!fault) {
            this._recoveryFailures = 0;
            this._nextRecoveryAt = 0;
            return true;
        }
        // Honour the backoff here rather than only in the watchdog, so the
        // live-analysis loop's per-cycle check can't turn a permanently denied
        // microphone into a getUserMedia call every few seconds. A forced
        // check has already cleared it.
        if (!force && Date.now() < this._nextRecoveryAt) return false;
        return this._recoverCapture(fault);
    }

    _recoverCapture(reason) {
        const mode = this._mode;
        const durationSecs = this._continuousDurationSecs;
        const generation = this._captureGeneration;

        this._recovering = (async () => {
            console.warn(`Microphone capture lost (${reason}) — reacquiring`);
            try {
                await this._teardownPipeline();
                if (this._captureGeneration !== generation) return false;

                await this._openPipeline(mode, durationSecs);
                if (this._captureGeneration !== generation) {
                    // Stopped while we were re-opening — throw the new pipeline
                    // away rather than leaving an orphaned microphone open.
                    await this._teardownPipeline();
                    this._mode = null;
                    return false;
                }

                this._recoveryFailures = 0;
                this._nextRecoveryAt = 0;
                console.debug('Microphone capture reacquired');
                eventBus.$emit('micRecovered');
                return true;
            } catch (e) {
                // getUserMedia may have succeeded before a later step failed —
                // don't leave a half-built pipeline (or an open mic) behind.
                try { await this._teardownPipeline(); } catch (_) { /* swallow */ }

                const attempt = this._recoveryFailures++;
                const backoff = RECOVERY_BACKOFF_MS[
                    Math.min(attempt, RECOVERY_BACKOFF_MS.length - 1)
                ];
                this._nextRecoveryAt = Date.now() + backoff;
                console.warn('Microphone recovery failed', e);
                // Only shout about the first failure of a streak — the watchdog
                // keeps retrying behind the scenes, and the mic often comes
                // back on its own once the other app lets go of it.
                if (attempt === 0) {
                    eventBus.$emit('micLost', {
                        reason,
                        message: (e && e.message) || String(e),
                    });
                }
                return false;
            } finally {
                this._recovering = null;
            }
        })();

        return this._recovering;
    }

    _startHealthWatchdog() {
        if (this._healthInterval || typeof setInterval !== 'function') return;
        this._healthInterval = setInterval(() => {
            if (!this._mode || this._recovering) return;
            // Nothing is expected to flow while backgrounded, and re-acquiring
            // there would either fail or snatch the microphone from whatever
            // the user switched to. The visibilitychange handler covers the
            // return trip.
            if (this._isHidden()) return;
            if (Date.now() < this._nextRecoveryAt) return;
            this.ensureMicHealthy();
        }, HEALTH_CHECK_INTERVAL_MS);
    }

    _stopHealthWatchdog() {
        if (this._healthInterval) {
            clearInterval(this._healthInterval);
            this._healthInterval = null;
        }
    }

    // ---- capture pipeline -------------------------------------------------

    // `mode` is bound at wiring time rather than read from this._mode, so a
    // buffer that lands during setup can't be routed to the wrong sink.
    _onAudioChunk(audioProcessingEvent, mode) {
        const channelData = audioProcessingEvent.inputBuffer.getChannelData(0);
        this._chunkCount++;
        this._lastChunkAt = Date.now();
        const sumSquares = this._accumulateRms(channelData);

        // Real audio: the capture is alive, and any escalated silence window is
        // forgotten.
        if (sumSquares > channelData.length * SILENT_RMS * SILENT_RMS) {
            this._lastSoundAt = Date.now();
            this._silenceStrikes = 0;
            if (this._silenceReported) {
                this._silenceReported = false;
                eventBus.$emit('micRecovered');
            }
        }

        if (mode === 'continuous') {
            this._ringBuffer.push(new Float32Array(channelData)); // copy
            if (this._ringBuffer.length > this._ringBufferMaxChunks) {
                this._ringBuffer.shift();
            }
        } else {
            this._recordingPcm.push(new Float32Array(channelData)); // copy for export
            if (this._recordingPcm.length > this._recordingMaxChunks) {
                this._recordingPcm.shift();
            }
            ffBackend.feedSinglePCMWindow(channelData);
        }
    }

    _watchMicTrack() {
        const track = this._micTrack();
        if (!track || typeof track.addEventListener !== 'function') return;

        track.addEventListener('ended', () => {
            // Fires when the OS hands the microphone to another app. The track
            // never comes back to life, so a fresh getUserMedia is the only
            // fix — but not while we're in the background, where it would fail
            // or take the mic away from whatever the user switched to.
            if (this._mode && !this._isHidden()) this.ensureMicHealthy();
        });
        track.addEventListener('mute', () => console.debug('Microphone track muted'));
        track.addEventListener('unmute', () => console.debug('Microphone track unmuted'));
    }

    async _openPipeline(mode, durationSecs) {
        // This is the case on ios/chrome, when clicking links from within ios/slack (sometimes), etc.
        if (!navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('Missing support for navigator.mediaDevices.getUserMedia');
            throw new Error('Missing support for navigator.mediaDevices.getUserMedia');
        }

        this.micStream = await navigator.mediaDevices.getUserMedia(audioConstraints());
        this._recordAppliedSettings();
        this._watchMicTrack();
        // A fresh capture gets a full window before anything judges it silent —
        // otherwise the very first health check condemns a pipeline that has
        // not had time to deliver a single buffer.
        this._lastSoundAt = Date.now();

        // IMPORTANT NOTE: we can simply set
        //  { sampleRate: FFConfig.SAMPLE_RATE }
        //  as a config for this constructor and Chrome magically resamples
        //  everything into our desired sample rate. Unfortunately I don't
        //  trust that this works in Safari etc so we allow arbitrary
        //  sampleRates (within reason), which we detect after getUserMedia.
        //  The WebAssembly DSP functions can handle arbitrary sample rates.
        this.audioCtx = new AudioContext();

        // On Chrome, Safari, we can use MediaTrackSettings.sampleRate to
        //  get the sample rate and then initialise the AudioContext with
        //  that. Firefox doesn't let you know the sample rate until after
        //  you've connected it up to the audio context.
        // Sized before the processor is wired, so the very first buffer is
        // already governed by the right ring-buffer bound.
        const sampleRate = this.audioCtx.sampleRate;
        this._recordingSampleRate = sampleRate;
        if (mode === 'continuous') {
            this._continuousDurationSecs = durationSecs;
            this._ringBufferMaxChunks = Math.ceil(
                (durationSecs || store.userSettings.recordingTimeLimitSecs || 10) * sampleRate / this.bufferSize
            );
        }

        // TODO this needs investigated further and confirmed the value is high
        //  enough for different devices.
        // Ideally we would set fftSize to FFConfig.SPEC_WINDOW_SIZE but on
        //  some devices (confirmed on Tom's old Samsung Galaxy S6) this
        //  introduces glitches where WebAudio can't update itself fast
        //  enough, so each frame is duplicated three or four times without
        //  changing (disastrously bad for audio quality). We choose a longer
        //  size which introduces more latency (which doesn't really matter)
        //  which reduces glitches. The latency doesn't matter because we're
        //  not doing any real-time processing of audio that is *sent back* to
        //  to the user.

        // Yes yes, ScriptProcessorNode is deprecated. But there isn't enough
        //  widespread support for anything else (e.g. AudioWorklet) to replace
        //  it yet. But the cognoscente (rtoy) reckon it's not going anywhere
        //  anytime soon; https://github.com/WebAudio/web-audio-api/issues/2391.
        this.micProcessor = this.audioCtx.createScriptProcessor(this.bufferSize, 1, 1);
        this.micProcessor.onaudioprocess = (event) => this._onAudioChunk(event, mode);

        // Connect things up
        this.micSource = this.audioCtx.createMediaStreamSource(this.micStream);
        this.micSource.connect(this.micProcessor);
        this.micProcessor.connect(this.audioCtx.destination);

        // Only now is the pipeline live enough to be worth health-checking.
        this._mode = mode;
        // Don't let the watchdog declare a stall before the first buffer has
        // had a chance to arrive.
        this._lastChunkAt = Date.now();
        this._startHealthWatchdog();

        console.debug(`Microphone open (${mode}): sample rate ${sampleRate}`);
        // set_sample_rate is a no-op in WASM when the rate is unchanged, so
        // re-opening the pipeline mid-session doesn't disturb buffered audio.
        await ffBackend.setSampleRate(sampleRate);
    }

    async _teardownPipeline() {
        this._stopHealthWatchdog();
        // Nothing is expected to arrive with no capture open, so a closed
        // pipeline must not read as a silent one.
        this._lastSoundAt = 0;

        if (this.micProcessor) {
            this.micProcessor.onaudioprocess = null;
            this.micProcessor.disconnect();
            this.micProcessor = null;
        }
        if (this.micSource) {
            this.micSource.disconnect();
            this.micSource = null;
        }
        if (this.micStream) {
            this.micStream.getTracks().forEach((track) => track.stop());
            this.micStream = null;
        }
        if (this.audioCtx) {
            try {
                await this.audioCtx.close();
            } catch (e) {
                // Already closed, or closing twice — nothing to do.
            }
            this.audioCtx = null;
        }
    }

    // Returns this chunk's sum of squares, which _onAudioChunk uses to tell
    // signal from digital silence without a second pass over the buffer.
    _accumulateRms(samples) {
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i];
        }
        this._rmsSquaredSum += sum;
        this._rmsSampleCount += samples.length;
        return sum;
    }

    // Returns the integrated RMS level since the last call (linear amplitude,
    // 0..1). Resets the accumulator. If no audio has flowed since the last
    // read, returns 0. Designed for a single consumer at a time — concurrent
    // consumers would each see partial readings.
    getRmsLevel() {
        if (this._rmsSampleCount === 0) return 0;
        const rms = Math.sqrt(this._rmsSquaredSum / this._rmsSampleCount);
        this._rmsSquaredSum = 0;
        this._rmsSampleCount = 0;
        return rms;
    }

    async startRecording() {
        if (store.isRecording()) {
            return;
        }
        store.setSearchState(store.searchStates.RECORDING);
        this._recordingPcm = [];
        store.state.lastRecordedPcm = null; // repopulated when this recording stops

        // It's possible for a call to stopRecording to come in whilst we are
        //  still running startRecording (if the button is pushed very quickly).
        //  Track how we're doing setting up the audio pipeline so we can
        //  block stopRecording until this is finished.
        this.opening = new Promise((resolve) => {
            this.finishOpening = resolve;
        });

        try {
            await this._openPipeline('recording');
        } catch (e) {
            // finishOpening must run before stopRecording, which awaits it.
            this.finishOpening();
            console.warn(e);
            await this.stopRecording();
            store.setSearchState(store.searchStates.READY);
            throw e;
        }

        this.finishOpening();
    }

    async startContinuous(durationSecs) {
        // Serialise against any in-flight startContinuous/stopContinuous so a
        // rapid toggle cannot leave two AudioContexts alive at once.
        if (this._continuousTransition) await this._continuousTransition;
        if (store.isListening()) return;

        // A one-shot recording holds its own pipeline. Opening a second one on
        // top leaves two live AudioContexts on the same microphone, so the
        // recording is torn down first — "Follow session" is reachable from the
        // Search screen while a recording is running, and must not have to be
        // disabled to stay safe.
        if (this._mode === 'recording') {
            await this._teardownPipeline();
        }

        this._continuousTransition = (async () => {
            store.setSearchState(store.searchStates.LISTENING);
            this._ringBuffer = [];

            try {
                await this._openPipeline('continuous', durationSecs);
            } catch (e) {
                store.setSearchState(store.searchStates.READY);
                throw e;
            }
            console.debug(`Continuous mode: max chunks ${this._ringBufferMaxChunks}`);
        })();

        try {
            await this._continuousTransition;
        } catch (e) {
            this._continuousTransition = null;
            await this.stopContinuous();
            throw e;
        }
        this._continuousTransition = null;
    }

    getContinuousAudio() {
        const chunks = this._ringBuffer || [];
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Float32Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }

    async stopContinuous() {
        if (this._continuousTransition) {
            // Wait for any in-flight start before tearing down — otherwise we
            // may try to disconnect resources that haven't been wired up yet.
            try { await this._continuousTransition; } catch (_) { /* swallow */ }
        }
        await this._endCapture();

        this._ringBuffer = [];
        this._rmsSquaredSum = 0;
        this._rmsSampleCount = 0;
        store.setSearchState(store.searchStates.READY);
    }

    async stopRecording() {
        // There is never a use case where we don't want this to be in working state
        //  Even if the mic has failed to open we might still have to wait a second
        //  before the audio context closes.
        store.setSearchState(store.searchStates.WORKING);

        // Make sure we don't try to close whilst in the process
        //  of opening.
        await this.opening;

        await this._endCapture();

        // Finalise the retained recording into the store so Results can export
        // it as a WAV test clip.
        if (this._recordingPcm && this._recordingPcm.length) {
            const total = this._recordingPcm.reduce((n, c) => n + c.length, 0);
            const out = new Float32Array(total);
            let offset = 0;
            for (const chunk of this._recordingPcm) {
                out.set(chunk, offset);
                offset += chunk.length;
            }
            store.state.lastRecordedPcm = out;
            store.state.lastRecordedSampleRate = this._recordingSampleRate || 48000;
        }
        this._recordingPcm = [];

        this._rmsSquaredSum = 0;
        this._rmsSampleCount = 0;
    }

    // Shared stop path: mark the capture as no longer wanted, let any in-flight
    // recovery notice (via the generation bump) and finish, then tear down.
    async _endCapture() {
        this._captureGeneration++;
        this._mode = null;
        this._continuousDurationSecs = null;
        this._recoveryFailures = 0;
        this._nextRecoveryAt = 0;

        // Let any in-flight check or recovery run to completion first — with
        // _mode cleared and the generation bumped they will bail out on their
        // own, but tearing down underneath them would leave a half-built
        // pipeline (and possibly an open microphone) behind.
        if (this._healthCheck) {
            try { await this._healthCheck; } catch (_) { /* swallow */ }
        }
        if (this._recovering) {
            try { await this._recovering; } catch (_) { /* swallow */ }
        }
        // A recovery that got as far as re-opening will have set _mode again
        // before it noticed the generation bump.
        this._mode = null;

        await this._teardownPipeline();
    }
}

const micService = new MicService();
export default micService;
