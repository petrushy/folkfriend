// "This is a great tune — record it!": a recording that turns itself on for
// one tune and off again when that tune is over.
//
// Session recording is otherwise all-or-nothing for an evening. Most evenings
// are not worth three hours of audio, but one tune in them often is, and by the
// time someone has found the session page's switch, the tune is half over and
// they then have to remember to turn it off again. This is the rule that does
// the remembering.
//
// Pure: no Vue, no service, no clock of its own. The service passes the
// session's listening clock and what the detector currently believes.
//
// The one judgement in it is what counts as "the tune is over". Two things do,
// and both are deliberately conservative in the direction of KEEPING audio —
// cutting a tune short loses the thing the user asked for, while recording
// twenty seconds of the next one costs a few hundred kilobytes:
//
//   1. Another tune has CONFIRMED itself. A single stray window naming some
//      other tune is the commonest fluke there is, and the live list already
//      ignores a detection shorter than MIN_PAST_DETECTION_SECONDS for exactly
//      that reason — so the same bar is used here. The next tune in a set is
//      confirmed within a couple of windows, which is the right moment.
//   2. Nothing has matched the captured tune for as long as the detection LED
//      takes to go red ("Tune over?") — see detectionFreshness.mjs, whose
//      limits this reuses so that the light going red and the recording
//      stopping are the same event, not two near-misses.
//
// And one safety net: MAX_CAPTURE_SECONDS. A capture is a promise to stop by
// itself, and a detector stuck on one tune must not turn it into recording the
// rest of the evening.

import { freshnessLimits } from './detectionFreshness.mjs';

export const MAX_CAPTURE_SECONDS = 20 * 60;
// A detection must span at least this long before it counts as a different
// tune having started. Same value as sessionAnalysis.js's
// MIN_PAST_DETECTION_SECONDS; repeated rather than imported because that module
// pulls in the app's aliased imports and this one must stay loadable on its own.
export const CONFIRM_OTHER_TUNE_SECONDS = 15;

/**
 * Starts a capture.
 *
 * The tune on screen is adopted only when it is CURRENT. Pressing the button
 * at the start of a new tune, while the detector still shows the previous one
 * (it needs a window or two to catch up), must not bind the capture to the
 * tune that just ended — it would then stop the moment the new one is
 * recognised, which is precisely the tune the user wanted. A stale tail leaves
 * the capture unbound, and the first tune recognised after the tap is adopted.
 */
export function beginCapture({ tailTuneId = null, lastMatchSeconds = null, elapsedSeconds = 0, options } = {}) {
    const { freshSeconds } = freshnessLimits(options);
    const current = tailTuneId != null && lastMatchSeconds != null &&
        (elapsedSeconds - lastMatchSeconds) <= freshSeconds;
    return {
        tuneId: current ? String(tailTuneId) : null,
        startedSeconds: elapsedSeconds,
        // Where "nothing heard yet" is measured from. Moved forward when the
        // capture is re-bound (a rejected tune), so a rejection does not leave
        // the capture with no time left to find the right one.
        sinceSeconds: elapsedSeconds,
    };
}

/**
 * What to do with a running capture, given the state of the session now.
 *
 * @param {object} input
 * @param {object} input.capture          - from beginCapture()
 * @param {?object} input.tail            - the last detection ({tuneId, startSeconds, endSeconds}) or null
 * @param {?number} input.lastCapturedMatchSeconds - elapsedSeconds of the last
 *                                          window match for the captured tune
 * @param {?object} input.lastMatch       - the last window match of any tune ({tuneId, startSeconds})
 * @param {number}  input.elapsedSeconds
 * @param {object}  [input.options]       - {windowSeconds, stepSeconds}
 * @returns {{action: 'keep'|'adopt'|'end', tuneId?: string, reason?: string}}
 */
export function captureVerdict({
    capture,
    tail = null,
    lastCapturedMatchSeconds = null,
    lastMatch = null,
    elapsedSeconds = 0,
    options,
} = {}) {
    if (!capture) return { action: 'keep' };
    const { staleSeconds } = freshnessLimits(options);

    if (elapsedSeconds - capture.startedSeconds >= MAX_CAPTURE_SECONDS) {
        return { action: 'end', reason: 'limit' };
    }

    if (capture.tuneId == null) {
        // Adopt the first tune heard AFTER the tap. A match from before it is
        // the tune that was on screen, which beginCapture() already judged
        // stale.
        if (tail && tail.tuneId != null && lastMatch &&
            lastMatch.startSeconds > capture.sinceSeconds &&
            String(lastMatch.tuneId) === String(tail.tuneId)) {
            return { action: 'adopt', tuneId: String(tail.tuneId) };
        }
        // Nothing recognised at all. Twice the usual allowance: the tap often
        // comes in the first bars, and the detector needs a full window before
        // it can say anything — but a capture must still give up eventually,
        // or an unrecognised tune would record for the full twenty minutes.
        if (elapsedSeconds - capture.sinceSeconds >= 2 * staleSeconds) {
            return { action: 'end', reason: 'not-recognised' };
        }
        return { action: 'keep' };
    }

    if (tail && tail.tuneId != null && String(tail.tuneId) !== capture.tuneId &&
        (tail.endSeconds - tail.startSeconds) >= CONFIRM_OTHER_TUNE_SECONDS) {
        return { action: 'end', reason: 'next-tune' };
    }

    const lastHeard = Math.max(
        capture.sinceSeconds,
        lastCapturedMatchSeconds == null ? -Infinity : lastCapturedMatchSeconds,
    );
    if (elapsedSeconds - lastHeard >= staleSeconds) {
        return { action: 'end', reason: 'tune-ended' };
    }
    return { action: 'keep' };
}

export function captureEndMessage(reason) {
    switch (reason) {
        case 'next-tune': return 'Tune recorded — stopped when the next tune started.';
        case 'tune-ended': return 'Tune recorded — stopped when the playing did.';
        case 'limit': return `Tune recorded — stopped after ${MAX_CAPTURE_SECONDS / 60} minutes.`;
        case 'not-recognised': return 'Recording stopped — no tune was recognised.';
        default: return 'Tune recording stopped.';
    }
}
