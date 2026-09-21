// The detection "LED": is what the app is showing still true right now?
//
// Reported from the field: in a session it is hard to tell whether the tune on
// screen is being played at this moment or was recognised five minutes ago.
// The session bar already says "Listening" and shows a tune count, and both
// stay exactly the same through twenty minutes of conversation — so the app
// looks equally confident whether the room is playing or in the pub garden.
//
// The parameter that matters most is TIME SINCE THE LAST ACCEPTED MATCH, not
// the score. A weak match a second ago means the app is hearing something and
// guessing; no match for two minutes means the tune ended, whatever score the
// last one had. So age decides the level and the score can only hold it back
// from green — it can never, on its own, turn the light red. That asymmetry is
// deliberate: ML-transcribed scores run systematically lower than DSP ones
// (see the transcriber notes in CLAUDE.md), so a score-driven red would be
// permanently on for anyone using the experimental transcriber, while the
// age-driven one means the same thing under both.
//
// Pure: no Vue, no service, no clock of its own. The caller passes the
// session's own elapsed seconds, which is listening time — it stops while
// paused, so a paused session does not silently age into red.

// A match at or above this is "the app is sure". Below it the light is held at
// amber however recent the match is: something matched, but not well enough to
// say the tune on screen is definitely the tune in the room.
export const GOOD_SCORE = 0.55;

/**
 * How long a match stays green / amber, in seconds, derived from the analysis
 * options rather than hard-coded — the window and step are user-visible
 * settings, and a fixed 20 s would mean something different at a 30 s window.
 *
 * At the live defaults (10 s window, 5 s step) this is 20 s green and 40 s
 * amber: two missed cycles is ordinary (a bar of unison, someone shouting an
 * order), six in a row is not. 40 s rather than 50 because the point of the
 * red is to tell the user the tune has probably ended, and by three quarters
 * of a minute of nothing that is already the likelier reading — a light that
 * is late saying so is no more use than one that never does.
 */
export function freshnessLimits(options) {
    const windowSeconds = Number(options && options.windowSeconds) || 10;
    const stepSeconds = Number(options && options.stepSeconds) || 5;
    return {
        freshSeconds: windowSeconds + 2 * stepSeconds,
        staleSeconds: windowSeconds + 6 * stepSeconds,
    };
}

const LEVELS = {
    off: { level: 'off', colour: 'grey darken-1', label: 'Idle' },
    idle: { level: 'idle', colour: 'grey darken-1', label: 'Listening…' },
    green: { level: 'green', colour: 'green darken-1', label: 'Following' },
    amber: { level: 'amber', colour: 'amber darken-3', label: 'Uncertain' },
    red: { level: 'red', colour: 'red darken-2', label: 'Tune over?' },
};

function ageText(seconds) {
    const safe = Math.max(0, Math.round(seconds));
    if (safe < 60) return `${safe}s ago`;
    const minutes = Math.floor(safe / 60);
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}

/**
 * @param {object} input
 * @param {boolean} input.listening   - a capture is open and the loop running
 * @param {boolean} input.micHealthy  - the microphone is actually delivering audio
 * @param {number}  input.elapsedSeconds  - the session's listening clock
 * @param {?number} input.lastMatchSeconds - elapsedSeconds of the last accepted
 *                                           window match, or null if none yet
 * @param {?number} input.lastMatchScore
 * @param {object}  [input.options]   - the analysis options ({windowSeconds, stepSeconds})
 * @returns {{level: string, colour: string, label: string, detail: string,
 *            ageSeconds: ?number, score: ?number}}
 */
export function detectionFreshness({
    listening,
    micHealthy = true,
    elapsedSeconds = 0,
    lastMatchSeconds = null,
    lastMatchScore = null,
    options = null,
} = {}) {
    const score = Number.isFinite(lastMatchScore) ? lastMatchScore : null;
    const ageSeconds = Number.isFinite(lastMatchSeconds)
        // Clamped at zero: a restored session can carry a match stamped at the
        // clock's current value, and a negative age would read as the future.
        ? Math.max(0, elapsedSeconds - lastMatchSeconds)
        : null;

    // Not listening at all. The light is off rather than red — red is a claim
    // about the ROOM ("the tune has probably ended"), and a paused session has
    // no business making it.
    if (!listening) {
        return {
            ...LEVELS.off,
            detail: 'Not listening',
            ageSeconds,
            score,
        };
    }

    // Hearing nothing is the one non-age route to red: the app cannot possibly
    // be following a tune, and saying so is the whole point of the light.
    if (!micHealthy) {
        return {
            ...LEVELS.red,
            label: 'No audio',
            detail: 'The microphone is not delivering audio',
            ageSeconds,
            score,
        };
    }

    if (ageSeconds === null) {
        return {
            ...LEVELS.idle,
            detail: 'Nothing recognised yet',
            ageSeconds: null,
            score,
        };
    }

    const { freshSeconds, staleSeconds } = freshnessLimits(options);

    let state;
    if (ageSeconds > staleSeconds) {
        state = LEVELS.red;
    } else if (ageSeconds > freshSeconds) {
        state = LEVELS.amber;
    } else if (score !== null && score < GOOD_SCORE) {
        // Recent but not convincing: amber, and say which of the two it is, so
        // the user is not left looking for a gap in the playing that is not
        // there.
        state = { ...LEVELS.amber, label: 'Weak match' };
    } else {
        state = LEVELS.green;
    }

    const scoreText = score === null ? '' : ` · match ${score.toFixed(2)}`;
    return {
        ...state,
        detail: `Last match ${ageText(ageSeconds)}${scoreText}`,
        ageSeconds,
        score,
    };
}
