// Playback loudness for the session player: the volume slider and "Normalize".
//
// Pure — no Web Audio, no Vue, no clock of its own — so the rules can be
// tested without a browser. SessionAudioPlayer.vue measures, this decides.
//
// Why a VOLUME control needs any of this: an <audio> element's volume stops
// at 1, and on iOS a page cannot set it at all (it is read-only, always 1).
// So anything louder than the file, and anything quieter on an iPhone, has to
// be a GainNode, i.e. the element routed through Web Audio.
//
// Why normalizing is measured while PLAYING rather than computed up front: a
// static "peak to 0 dB" gain needs the whole recording decoded, which is a
// three-hour evening in PCM (~2 GB at 48 kHz) — and for a recording that lives
// in Dropbox, a download of all of it before a note sounds. Measuring the
// signal on its way to the speakers costs nothing extra and works identically
// for live recordings, imported files and cloud copies. It also answers the
// question that actually matters in a pub recording: the level changes over
// the evening with who is sitting nearest the phone.

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 2;
export const VOLUME_STEP = 0.05;

// The loud-passage level normalizing aims for: −20 dBFS RMS. Music has a crest
// factor of roughly 12–15 dB, so this puts its peaks near −6 dBFS, leaving the
// limiter behind it very little to do.
export const NORMALIZE_TARGET_RMS = 0.1;

// Below −60 dBFS is a room with nobody playing, a muted stretch, or digital
// silence. Letting that pull the level down would wind the gain up to its
// maximum in every pause, and the next tune would arrive at full blast.
export const LEVEL_GATE_RMS = 0.001;

// How far normalizing may move a recording. +18 dB is enough to rescue a phone
// left at the far end of the table; beyond it the noise floor is what gets
// amplified. It may also bring a hot recording DOWN, a little.
export const NORMALIZE_MAX_GAIN = 8;
export const NORMALIZE_MIN_GAIN = 0.5;

// The level follows a louder passage quickly (so a tune starting after a quiet
// stretch is pulled down within a fraction of a second) and a quieter one
// slowly (so the gain does not pump up between phrases, or in the chat
// between two tunes). That asymmetry is what makes this sound like a fixed
// gain per recording rather than like a compressor.
export const LEVEL_ATTACK_SECONDS = 0.3;
export const LEVEL_RELEASE_SECONDS = 30;

export function clampVolume(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const stepped = Math.round(n / VOLUME_STEP) * VOLUME_STEP;
    // Hundredths: 0.05 steps in floating point otherwise give 1.1500000000000001.
    return Math.round(Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, stepped)) * 100) / 100;
}

export function rmsOf(samples) {
    if (!samples || !samples.length) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
}

// The next estimate of the recording's loud-passage level, given the previous
// one (null when nothing has been heard yet), a new RMS reading and the time
// since the last one. A reading below the gate changes nothing.
export function nextLevel(previous, rms, dtSeconds) {
    if (!Number.isFinite(rms) || rms < LEVEL_GATE_RMS) return previous;
    if (previous == null || !Number.isFinite(previous) || previous <= 0) return rms;
    const dt = Math.max(0, Number(dtSeconds) || 0);
    const tau = rms > previous ? LEVEL_ATTACK_SECONDS : LEVEL_RELEASE_SECONDS;
    const k = 1 - Math.exp(-dt / tau);
    return previous + (rms - previous) * k;
}

// The gain normalizing applies for a measured level. 1 until anything has
// been measured: guessing high on a recording nobody has heard yet is how a
// loud one would start at +18 dB.
export function normalizeGainFor(level) {
    if (level == null || !Number.isFinite(level) || level <= 0) return 1;
    return Math.min(NORMALIZE_MAX_GAIN, Math.max(NORMALIZE_MIN_GAIN, NORMALIZE_TARGET_RMS / level));
}

// What the level stage should be set to. The one-channel correction is a
// separate node and is not part of this.
export function levelStageGain({ volume = 1, normalize = false, level = null } = {}) {
    const v = Number.isFinite(volume) ? volume : 1;
    return v * (normalize ? normalizeGainFor(level) : 1);
}
