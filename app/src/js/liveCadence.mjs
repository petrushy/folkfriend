// When the live analysis loop queries, and on how much audio. Pure, so the
// rules can be tested without a microphone, a worker or a clock.
//
// Two changes to how fast a tune appears, both from the same measurement of
// where the time went (November 2026): with a 10 s window and a 5 s step, the
// first tune of a session could not show before ~12–14 s, and a tune change
// took ~13–18 s.
//
// 1. The FIRST query does not wait for a full window. It runs as soon as
//    EARLY_FIRST_QUERY_SECONDS of audio exist, on whatever the ring buffer
//    holds, and the window then grows to its full length over the following
//    cycles. A partial window has to produce a contour of at least
//    minContourLength notes before its result counts, the same bar file
//    analysis applies to every window — on five seconds of audio, a near-empty
//    contour is the one way an early query is more likely to be wrong than a
//    full one. Full windows are judged exactly as before.
//
// 2. The step SHRINKS when the device is fast enough. The configured step is
//    an upper bound, never exceeded; below it the step follows the measured
//    analysis time × ADAPTIVE_STEP_FACTOR, floored at MIN_ADAPTIVE_STEP_SECONDS.
//    A factor of 2 keeps the transcription worker idle at least half the time,
//    which matters on a phone running for three hours — a factor near 1 would
//    run it back to back, for a second or two of latency at most.
//
//    The configured step stays in `options.stepSeconds`, and everything that
//    reads it — the detection LED's limits, the cluster continuity rule, the
//    sparse-scan exception — keeps the meaning it had. A shorter real step
//    only ever makes consecutive windows closer together than those rules
//    assume, which is the safe direction for all three.

export const EARLY_FIRST_QUERY_SECONDS = 5;
export const MIN_ADAPTIVE_STEP_SECONDS = 2;
export const ADAPTIVE_STEP_FACTOR = 2;
// Smoothing for the analysis-time estimate: one slow cycle (garbage
// collection, a background tab) must not double the step, nor one fast one
// halve it.
export const LATENCY_SMOOTHING = 0.3;
// A window this much shorter than configured counts as partial. Chunk
// boundaries make a full ring buffer a few milliseconds short or long, so
// equality would misclassify full windows.
const PARTIAL_WINDOW_TOLERANCE_SECONDS = 0.5;

/** Seconds to wait before the first query of a run. */
export function firstQueryDelaySeconds(windowSeconds) {
    const w = Number(windowSeconds);
    if (!(w > 0)) return EARLY_FIRST_QUERY_SECONDS;
    return Math.min(w, EARLY_FIRST_QUERY_SECONDS);
}

/** Exponentially smoothed analysis time, in ms. `previous` null = no estimate. */
export function updateLatencyEstimate(previous, sampleMs) {
    if (!(sampleMs >= 0) || !Number.isFinite(sampleMs)) return previous;
    if (previous === null || previous === undefined) return sampleMs;
    return previous + LATENCY_SMOOTHING * (sampleMs - previous);
}

/**
 * The step to use for the next cycle, in seconds. Never longer than the
 * configured step; with no estimate yet, exactly the configured step. A
 * configured step below the floor is honoured as given.
 */
export function effectiveStepSeconds(configuredStepSeconds, latencyMs) {
    const configured = Number(configuredStepSeconds);
    if (!(configured > 0)) return configured;
    if (latencyMs === null || latencyMs === undefined || !Number.isFinite(latencyMs)) {
        return configured;
    }
    const adaptive = Math.max(MIN_ADAPTIVE_STEP_SECONDS,
        ADAPTIVE_STEP_FACTOR * latencyMs / 1000);
    return Math.min(configured, adaptive);
}

/** Whether `sampleCount` samples are clearly less than a full window. */
export function isPartialWindow(sampleCount, sampleRate, windowSeconds) {
    if (!(sampleRate > 0) || !(windowSeconds > 0)) return false;
    return sampleCount / sampleRate < windowSeconds - PARTIAL_WINDOW_TOLERANCE_SECONDS;
}

/**
 * Whether a query on a partial window produced enough of a contour to be
 * believed. Full windows are not judged here.
 */
export function partialWindowUsable(response, minContourLength) {
    const contour = response && typeof response.contour === 'string' ? response.contour : '';
    return contour.length >= (Number(minContourLength) || 0);
}
