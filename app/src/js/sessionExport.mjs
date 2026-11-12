// Whole-session export: every stored part of a recording, in order, as ONE
// audio file.
//
// Why this has to re-encode. A recording is stored as one or more TRACKS, one
// per continuous MediaRecorder run (Pause/Resume, a reacquired microphone),
// and a "tunes only" recording also has holes inside a track. Each run carries
// its own container header and its own timestamps, so the native export can
// only hand out one file per contiguous part — 23 files for one evening in the
// field. Joining containers byte-wise is not a file any player accepts, and
// rewriting fMP4/WebM timestamps per browser is fragile. Decoding each part to
// PCM and encoding the result once is the one route that works for every
// container a browser can record, and it is what lets the output be a format
// every player opens (MP3).
//
// Pure apart from what is injected (`buildClip`, `decode`, `encoder`), so the
// whole pipeline runs in node against the real MP3 encoder.
//
// Three decisions worth knowing:
//
// 1. Parts are joined BACK TO BACK, with a short fade either side of each
//    join, not padded with silence. The gaps are pauses and breaks between
//    sets the user chose not to keep; reproducing them as silence would make a
//    file longer than the music in it, and a pause can last hours. The cost is
//    that a position in the file is not the session clock — say so in the UI.
//
// 2. Decoding is done in WINDOWS of a few minutes, never a whole part at once.
//    A part can be the whole evening (a session that was never paused), and
//    three hours of float PCM is ~2 GB — more than a phone tab survives. A
//    window is [track header, ...its chunks], the same shape playback loads.
//    If a browser refuses to decode a mid-track window, the part is decoded
//    whole instead, but only when that is small enough to be safe.
//
// 3. The output is MONO, mixed per window: a channel that is exactly dead is
//    dropped rather than averaged in. iOS writes mono audio into two-channel
//    AAC with a silent right channel, and averaging that would export the
//    session at half level — the same one-sided recording the player corrects,
//    now corrected in the file too.

export const EXPORT_SAMPLE_RATE = 44100;
// Five minutes of decoded audio is ~53 MB per channel of float PCM at 44.1 kHz.
export const EXPORT_WINDOW_SECONDS = 300;
// A whole part is decoded at once only as a fallback, and only up to this.
export const FALLBACK_MAX_PART_SECONDS = 40 * 60;
// Either side of a join between parts. Long enough to take the click out of a
// hard cut, short enough not to be heard as a fade.
export const JOIN_FADE_SECONDS = 0.03;
// Same order of magnitude as the player's SILENT_CHANNEL_RMS: a channel
// carrying real audio sits far above it; a dead one is exact zeroes.
const SILENT_CHANNEL_RMS = 1e-5;
// Segment ends are wall-clock measurements that meet within microseconds.
const JOIN_TOLERANCE_SECONDS = 0.25;

const MP3_BITRATES = [64, 80, 96, 112, 128];

// The MP3 bitrate for a recording made at `bitsPerSecond`. Never above 128,
// which is transparent for mono speech-and-fiddle audio, and never below the
// recording's own rate, which would throw away what was kept.
export function mp3KbpsFor(bitsPerSecond) {
    const kbps = Number(bitsPerSecond) / 1000;
    if (!Number.isFinite(kbps) || kbps <= 0) return 96;
    return MP3_BITRATES.find(rate => rate >= kbps) || MP3_BITRATES[MP3_BITRATES.length - 1];
}

// Whether a manifest has anything this export can make one file of. An
// imported file is already one file — and decoding a 300 MB import whole is
// exactly the memory ceiling note 2 avoids — so it keeps its native export.
export function canExportWholeSession(manifest, parts) {
    if (!manifest || !parts || !parts.length) return false;
    return (manifest.tracks || []).some(t => !t.wholeFile);
}

// The decode windows, part by part. `parts` is recordingParts(manifest).
// Each window is a run of whole segments inside one part, at most
// `maxWindowSeconds` long but always at least one segment.
export function exportPlan(manifest, parts, { maxWindowSeconds = EXPORT_WINDOW_SECONDS } = {}) {
    const tracks = new Map(((manifest && manifest.tracks) || []).map(t => [t.index, t]));
    const segments = (((manifest && manifest.segments) || []).slice())
        .sort((a, b) => a.index - b.index);
    return parts.map(part => {
        const track = tracks.get(part.trackIndex) || {};
        const base = { partIndex: part.index, trackIndex: part.trackIndex };
        if (track.wholeFile) {
            return { ...part, windows: [{ ...base, fromSeconds: part.startSeconds, toSeconds: part.endSeconds }] };
        }
        const mine = segments.filter(s => s.trackIndex === part.trackIndex &&
            s.startSeconds >= part.startSeconds - JOIN_TOLERANCE_SECONDS &&
            s.startSeconds < part.endSeconds - JOIN_TOLERANCE_SECONDS / 2);
        const windows = [];
        let current = null;
        for (const s of mine) {
            const end = s.startSeconds + s.durationSeconds;
            if (current && end - current.fromSeconds <= maxWindowSeconds + JOIN_TOLERANCE_SECONDS) {
                current.toSeconds = end;
                continue;
            }
            current = { ...base, fromSeconds: s.startSeconds, toSeconds: end };
            windows.push(current);
        }
        if (!windows.length) {
            windows.push({ ...base, fromSeconds: part.startSeconds, toSeconds: part.endSeconds });
        }
        return { ...part, windows };
    });
}

function rms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

// One mono channel from a decoded buffer's channels (always a copy, so the
// result can be transferred to a worker). See note 3.
export function mixToMono(channels) {
    if (!channels.length) return new Float32Array(0);
    if (channels.length === 1) return Float32Array.from(channels[0]);
    const levels = channels.map(rms);
    const live = channels.filter((_, i) => levels[i] > SILENT_CHANNEL_RMS);
    if (live.length === 1) return Float32Array.from(live[0]);
    const n = Math.min(...channels.map(c => c.length));
    const out = new Float32Array(n);
    for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i];
    for (let i = 0; i < n; i++) out[i] /= channels.length;
    return out;
}

// Seconds to drop from the front of a decoded window. A decoder is free to
// honour the container's timestamps and pad a mid-track window with silence
// back to the track's origin; when the decoded length says it did, that
// padding is cut. Otherwise nothing is: manifest seconds are wall-clock
// measurements and routinely differ from the decoded length by more than any
// tolerance worth trusting for a trim.
export function leadingPaddingSeconds(decodedSeconds, window, trackStartSeconds) {
    const span = window.toSeconds - window.fromSeconds;
    const fromOrigin = window.toSeconds - (trackStartSeconds || 0);
    const offset = window.fromSeconds - (trackStartSeconds || 0);
    if (offset < 1 || !(span > 0)) return 0;
    const padded = Math.abs(decodedSeconds - fromOrigin) <= Math.max(1, fromOrigin * 0.1);
    const plain = Math.abs(decodedSeconds - span) <= Math.max(1, span * 0.1);
    if (!padded || plain) return 0;
    return Math.max(0, decodedSeconds - span);
}

// In place: a linear fade at either end.
export function applyFades(samples, sampleRate, { fadeIn = false, fadeOut = false } = {}) {
    const n = Math.min(samples.length >> 1, Math.round(JOIN_FADE_SECONDS * sampleRate));
    if (n <= 0) return samples;
    for (let i = 0; i < n; i++) {
        const g = i / n;
        if (fadeIn) samples[i] *= g;
        if (fadeOut) samples[samples.length - 1 - i] *= g;
    }
    return samples;
}

function channelsOf(buffer) {
    const out = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) out.push(buffer.getChannelData(i));
    return out;
}

export class ExportCancelled extends Error {
    constructor() { super('Export cancelled'); this.name = 'ExportCancelled'; }
}

// Runs the export. Injected:
//   buildClip(from, to)  -> { blob } for that stretch of one track (complete)
//   decode(blob)         -> an AudioBuffer-like { sampleRate, numberOfChannels, getChannelData }
//   encoder              -> { encode(Float32Array mono), finish() -> result }, both may be async
// Resolves { result, seconds, parts } where `result` is whatever finish() gave.
export async function exportSession({
    manifest, parts, buildClip, decode, encoder,
    onProgress = null, isCancelled = () => false,
    maxWindowSeconds = EXPORT_WINDOW_SECONDS,
    fallbackMaxPartSeconds = FALLBACK_MAX_PART_SECONDS,
}) {
    const plan = exportPlan(manifest, parts, { maxWindowSeconds });
    if (!plan.length) throw new Error('nothing recorded to export');
    const tracks = new Map((manifest.tracks || []).map(t => [t.index, t]));
    const totalSeconds = plan.reduce((n, p) => n + p.windows.reduce(
        (m, w) => m + (w.toSeconds - w.fromSeconds), 0), 0);
    let doneSeconds = 0;
    let samplesOut = 0;
    let sampleRate = null;
    const report = () => { if (onProgress) onProgress(Math.min(doneSeconds, totalSeconds), totalSeconds); };
    const check = () => { if (isCancelled()) throw new ExportCancelled(); };
    report();

    const emit = async (samples, rate, { first, last }) => {
        if (sampleRate === null) sampleRate = rate;
        else if (rate !== sampleRate) throw new Error(`decoded audio changed sample rate (${sampleRate} → ${rate} Hz)`);
        applyFades(samples, rate, { fadeIn: first, fadeOut: last });
        samplesOut += samples.length;
        await encoder.encode(samples);
    };

    for (let p = 0; p < plan.length; p++) {
        const part = plan[p];
        const track = tracks.get(part.trackIndex) || {};
        const joinBefore = p > 0;
        const joinAfter = p < plan.length - 1;
        for (let w = 0; w < part.windows.length; w++) {
            check();
            const window = part.windows[w];
            const span = window.toSeconds - window.fromSeconds;
            let buffer = null;
            let failure = null;
            try {
                const clip = await buildClip(window.fromSeconds, window.toSeconds);
                if (!clip || !clip.blob) throw new Error('that part of the recording is missing');
                check();
                buffer = await decode(clip.blob);
            } catch (e) {
                if (e instanceof ExportCancelled) throw e;
                failure = e;
            }
            check();
            if (failure) {
                // A browser that will not decode a window cut from mid-track
                // may still decode the part whole — which is what the
                // per-part export hands out and is known to play. Decode it,
                // skip what is already encoded, and finish the part from it.
                const partSeconds = part.endSeconds - part.startSeconds;
                if (part.windows.length < 2 || partSeconds > fallbackMaxPartSeconds) {
                    throw new Error(`part ${p + 1} could not be decoded: ${(failure && failure.message) || failure}`);
                }
                let whole;
                try {
                    const clip = await buildClip(part.startSeconds, part.endSeconds);
                    whole = await decode(clip.blob);
                } catch (e) {
                    throw new Error(`part ${p + 1} could not be decoded: ${(e && e.message) || e}`);
                }
                check();
                const fraction = partSeconds > 0 ? (window.fromSeconds - part.startSeconds) / partSeconds : 0;
                const mono = mixToMono(channelsOf(whole));
                const from = Math.min(mono.length, Math.round(fraction * mono.length));
                await emit(mono.slice(from), whole.sampleRate, { first: joinBefore && w === 0, last: joinAfter });
                doneSeconds += part.windows.slice(w).reduce((n, x) => n + (x.toSeconds - x.fromSeconds), 0);
                report();
                break;
            }
            let mono = mixToMono(channelsOf(buffer));
            const decodedSeconds = mono.length / buffer.sampleRate;
            const pad = leadingPaddingSeconds(decodedSeconds, window, track.startSeconds);
            if (pad > 0) mono = mono.slice(Math.round(pad * buffer.sampleRate));
            await emit(mono, buffer.sampleRate, {
                first: joinBefore && w === 0,
                last: joinAfter && w === part.windows.length - 1,
            });
            doneSeconds += span;
            report();
        }
    }
    check();
    const result = await encoder.finish();
    return { result, seconds: sampleRate ? samplesOut / sampleRate : 0, parts: plan.length };
}
