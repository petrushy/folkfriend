import ffBackend from '@/services/backend.js';
import store from './store';

// Build getUserMedia constraints. Echo cancellation stays off (it mangles
// music). Auto gain control is opt-in via settings — it lets the OS boost quiet
// input at capture time (better than post-capture digital gain, which can't
// improve SNR), at the risk of level "pumping" on sustained notes.
function audioConstraints() {
    return {
        audio: {
            echoCancellation: false,
            autoGainControl: !!store.userSettings.autoGainControl,
        }
    };
}

class MicService {
    constructor() {
        this.micProcessor = null;
        this.audioCtx = null;
        this.opening = Promise.resolve();
        this.finishOpening = null;
        this.bufferSize = 1024;

        this.recordingTimer = null;

        // Running RMS accumulator. Both startRecording() and startContinuous()
        // feed every chunk through _accumulateRms(); UI components call
        // getRmsLevel() at their poll rate (e.g. once per second) to get the
        // integrated level since the last read.
        this._rmsSquaredSum = 0;
        this._rmsSampleCount = 0;

        // Retained PCM of the current manual recording, for optional WAV export
        // (building a personal test-clip collection). Ring-bounded for safety.
        this._recordingPcm = [];
        this._recordingSampleRate = null;
        // Cap retained audio at ~120 s to bound memory (advancedMode removes the
        // recording time limit). Older chunks are dropped beyond this.
        this._recordingMaxChunks = Math.ceil((120 * 48000) / this.bufferSize);
    }

    _accumulateRms(samples) {
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i];
        }
        this._rmsSquaredSum += sum;
        this._rmsSampleCount += samples.length;
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


        // This is the case on ios/chrome, when clicking links from within ios/slack (sometimes), etc.
        if (!navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('Missing support for navigator.mediaDevices.getUserMedia');
            throw 'Missing support for navigator.mediaDevices.getUserMedia';
        }

        try {
            this.micStream = await navigator.mediaDevices.getUserMedia(audioConstraints());
            // sampleRate = this.micStream.getTracks()[0].getSettings().sampleRate;
        } catch (e) {
            this.finishOpening();
            console.warn(e);
            await this.stopRecording();
            store.setSearchState(store.searchStates.READY);
            throw e;
        }

        // IMPORTANT NODE: we can simply set
        //  { sampleRate: FFConfig.SAMPLE_RATE }
        //  as a config for this constructor and Chrome magically resamples
        //  everything into our desired sample rate. Unfortunately I don't
        //  trust that this works in Safari etc so we allow arbitrary
        //  sampleRates (within reason), which we detect after getUserMedia.
        //  The WebAssembly DSP functions can handle arbitrary sample rates.
        this.audioCtx = new AudioContext();

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
        const self = this;
        this.micProcessor.onaudioprocess = function(audioProcessingEvent) {
            let channelData = audioProcessingEvent.inputBuffer.getChannelData(0);
            self._accumulateRms(channelData);
            self._recordingPcm.push(new Float32Array(channelData)); // copy for export
            if (self._recordingPcm.length > self._recordingMaxChunks) {
                self._recordingPcm.shift();
            }
            ffBackend.feedSinglePCMWindow(channelData);
        };

        // Connect things up
        this.micSource = this.audioCtx.createMediaStreamSource(this.micStream);
        this.micSource.connect(this.micProcessor);
        this.micProcessor.connect(this.audioCtx.destination);

        try {
            // On Chrome, Safari, we can use MediaTrackSettings.sampleRate to
            //  get the sample rate and then initialise the AudioContext with
            //  that. Firefox doesn't let you know the sample rate until after
            //  you've connected it up to the audio context.
            let sampleRate = this.audioCtx.sampleRate;
            this._recordingSampleRate = sampleRate;
            console.debug(`Using microphone sample rate ${sampleRate}`);
            await ffBackend.setSampleRate(sampleRate);
        } catch (e) {
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

        this._continuousTransition = (async () => {
            store.setSearchState(store.searchStates.LISTENING);
            this._ringBuffer = [];

            if (!navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                alert('Missing support for navigator.mediaDevices.getUserMedia');
                throw 'Missing support for navigator.mediaDevices.getUserMedia';
            }

            try {
                this.micStream = await navigator.mediaDevices.getUserMedia(audioConstraints());
            } catch (e) {
                store.setSearchState(store.searchStates.READY);
                throw e;
            }

            this.audioCtx = new AudioContext();
            this.micProcessor = this.audioCtx.createScriptProcessor(this.bufferSize, 1, 1);

            const sampleRate = this.audioCtx.sampleRate;
            this._ringBufferMaxChunks = Math.ceil(
                (durationSecs || store.userSettings.recordingTimeLimitSecs || 10) * sampleRate / this.bufferSize
            );

            this.micProcessor.onaudioprocess = (audioProcessingEvent) => {
                const channelData = audioProcessingEvent.inputBuffer.getChannelData(0);
                this._accumulateRms(channelData);
                this._ringBuffer.push(new Float32Array(channelData)); // copy
                if (this._ringBuffer.length > this._ringBufferMaxChunks) {
                    this._ringBuffer.shift();
                }
            };

            this.micSource = this.audioCtx.createMediaStreamSource(this.micStream);
            this.micSource.connect(this.micProcessor);
            this.micProcessor.connect(this.audioCtx.destination);

            console.debug(`Continuous mode: sample rate ${sampleRate}, max chunks ${this._ringBufferMaxChunks}`);
            await ffBackend.setSampleRate(sampleRate);
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
        this._ringBuffer = [];
        this._rmsSquaredSum = 0;
        this._rmsSampleCount = 0;
        if (this.micProcessor) {
            this.micProcessor.disconnect();
            this.micProcessor = null;
        }
        if (this.micStream) {
            this.micStream.getTracks().forEach(t => t.stop());
            this.micStream = null;
        }
        if (this.audioCtx) {
            await this.audioCtx.close();
            this.audioCtx = null;
        }
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

        if (this.micProcessor) {
            this.micProcessor.disconnect();
            this.micProcessor = null;
        }

        if (this.micStream) {
            this.micStream.getTracks().forEach((track) => track.stop());
            this.micStream = null;
        }

        if (this.audioCtx) {
            await this.audioCtx.close();
            this.audioCtx = null;
        }
    }
}

const micService = new MicService();
export default micService;