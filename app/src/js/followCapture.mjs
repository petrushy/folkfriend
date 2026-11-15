// A diagnostic recording of one Follow run: the microphone audio plus a log of
// every analysed window and of what Follow showed, both on ONE clock — seconds
// of audio captured — so a later replay can line the log up with the sound.
//
// Why it exists: every follow threshold so far was tuned on synthetic audio
// (rust/examples/detect_sim.rs). Real playing — a whistle's cuts and rolls,
// breaths, a room — has never been measured. One shared capture is enough to
// replay through test/bench/replayFollowCapture.mjs, and the WAV can be
// re-transcribed by detect_sim (`--wav`) when the transcriber changes.
//
// Pure: no DOM, no microphone. The caller feeds it chunks and events.

export const CAPTURE_VERSION = 1;
// Kept at roughly 16-22 kHz: whistle fundamentals reach ~2.5 kHz, and the
// transcriber needs the low harmonics, not the air.
export const CAPTURE_TARGET_RATE = 16000;
// About 20 minutes at 16 kHz, 15 at 22 kHz. Beyond it the AUDIO stops (and
// says so) but the log carries on — the log is the small, valuable half.
export const CAPTURE_MAX_BYTES = 40 * 1024 * 1024;

export class FollowCapture {
    constructor({ meta = {}, maxBytes = CAPTURE_MAX_BYTES, now = () => Date.now() } = {}) {
        this.meta = meta;
        this.maxBytes = maxBytes;
        this.now = now;
        this.startedAt = now();
        this.events = [];
        this._chunks = [];
        this._bytes = 0;
        this._samples = 0; // at the OUTPUT rate
        this.inputRate = null;
        this.rate = null;
        this._factor = 1;
        this._carry = null; // input samples left over from a partial decimation step
        this.truncatedAt = null;
    }

    // Seconds of audio captured so far: the clock every event is stamped with.
    get audioSeconds() { return this.rate ? this._samples / this.rate : 0; }

    addAudio(chunk, inputRate) {
        if (!chunk || !chunk.length || !(inputRate > 0)) return;
        if (this.inputRate === null) {
            this.inputRate = inputRate;
            this._factor = Math.max(1, Math.floor(inputRate / CAPTURE_TARGET_RATE));
            this.rate = inputRate / this._factor;
        } else if (inputRate !== this.inputRate) {
            // A recovered microphone on another rate: a WAV has one rate, so
            // say where it happened and stop the audio; the log continues.
            this._truncate('sample rate changed');
            return;
        }
        if (this.truncatedAt !== null) return;
        let input = chunk;
        if (this._carry) {
            input = new Float32Array(this._carry.length + chunk.length);
            input.set(this._carry); input.set(chunk, this._carry.length);
            this._carry = null;
        }
        const f = this._factor;
        const whole = Math.floor(input.length / f);
        if (input.length % f) this._carry = input.slice(whole * f);
        if (!whole) return;
        if (this._bytes + whole * 2 > this.maxBytes) { this._truncate('size limit'); return; }
        const out = new Int16Array(whole);
        for (let i = 0; i < whole; i++) {
            // Averaging f samples is a crude low-pass, enough against aliasing
            // at these rates for a pitch tracker.
            let sum = 0;
            for (let k = 0; k < f; k++) sum += input[i * f + k];
            const s = Math.max(-1, Math.min(1, sum / f));
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this._chunks.push(out);
        this._bytes += whole * 2;
        this._samples += whole;
    }

    _truncate(reason) {
        if (this.truncatedAt !== null) return;
        this.truncatedAt = this.audioSeconds;
        this.event('audio-stopped', { reason });
    }

    // `type` is free-form; the replay understands 'window', 'shown', 'cue',
    // 'hold', 'start' and 'stop'.
    event(type, data = {}) {
        this.events.push({ type, audioSeconds: Number(this.audioSeconds.toFixed(3)), wallMs: this.now() - this.startedAt, ...data });
    }

    log() {
        return {
            version: CAPTURE_VERSION,
            startedAt: new Date(this.startedAt).toISOString(),
            sampleRate: this.rate,
            audioSeconds: this.audioSeconds,
            truncatedAt: this.truncatedAt,
            ...this.meta,
            events: this.events,
        };
    }

    // One Int16 array of everything captured.
    pcm() {
        const out = new Int16Array(this._samples);
        let offset = 0;
        for (const c of this._chunks) { out.set(c, offset); offset += c.length; }
        return out;
    }
}

// 16-bit mono WAV from Int16 samples.
export function encodeWavInt16(int16, sampleRate) {
    const dataSize = int16.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, dataSize, true);
    new Int16Array(buffer, 44).set(int16);
    return buffer;
}
