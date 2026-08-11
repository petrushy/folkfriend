// Decides which tune's score the live-follow overlay should be showing.
//
// The live analysis pipeline already answers "what is being played right now":
// collapseConsecutiveSameTune() in services/liveAnalysis.js guarantees the last
// clustered detection is the current tune, and that its tuneId stays put while
// that tune continues. So a tune change is exactly a change of that tuneId.
//
// A target therefore carries two ids: `detectedTuneId` (what the analysis said,
// the thing we watch for changes) and `tuneId` (what is actually on screen).
// They differ only after a manual override, where the user may have picked an
// alternative belonging to a different tune — comparing against `tuneId` there
// would see a mismatch on the very next update and snap the override away.
//
// Kept free of Vue and the DOM so it can be unit tested directly.

function optionsOf(detection) {
    return Array.isArray(detection.tuneOptions) ? detection.tuneOptions : [];
}

function targetFromDetection(detection) {
    return {
        detectedTuneId: detection.tuneId,
        tuneId: detection.tuneId,
        settingId: detection.settingId ? String(detection.settingId) : '',
        title: detection.title || '',
        score: detection.bestScore || 0,
        tuneOptions: optionsOf(detection),
        overridden: false,
    };
}

/**
 * @param {Array} detections - clustered detection rows, oldest first
 * @param {Object|null} previous - the target currently on screen
 * @returns {{target: Object|null, changed: boolean}} `changed` is true only when
 *          the displayed score needs reloading.
 */
export function resolveFollowTarget(detections, previous) {
    const latest = detections && detections.length
        ? detections[detections.length - 1]
        : null;

    if (!latest || !latest.tuneId) {
        return { target: null, changed: !!previous };
    }

    if (!previous || previous.detectedTuneId !== latest.tuneId) {
        return { target: targetFromDetection(latest), changed: true };
    }

    // Same tune still playing. collapseConsecutiveSameTune() upgrades settingId
    // and title mid-tune whenever a higher-scoring window arrives; re-rendering
    // the score under the player's eyes is worse than showing a slightly
    // sub-optimal setting, so the displayed setting is sticky per tuneId.
    // Only the readouts refresh.
    return {
        target: {
            ...previous,
            score: previous.overridden ? previous.score : (latest.bestScore || 0),
            tuneOptions: optionsOf(latest),
        },
        changed: false,
    };
}

/**
 * Manual correction from the overlay's dropdown. Holds until the next real tune
 * change, which resolveFollowTarget() clears by building a fresh target.
 */
export function applyOverride(previous, option) {
    if (!option || !previous) return { target: previous, changed: false };
    return {
        target: {
            ...previous,
            tuneId: option.tuneId,
            settingId: option.settingId ? String(option.settingId) : '',
            title: option.title || '',
            score: option.score || 0,
            overridden: true,
        },
        changed: true,
    };
}

/**
 * Identifies which (tune, setting) a loaded/loading score is *for*. Keyed on
 * the target that was requested, not on whatever settingsFromTuneID actually
 * returned — loadScore() falls back to settings[0] when target.settingId
 * isn't found, which is a deliberate, pre-existing choice and not something
 * to treat as a mismatch here.
 */
export function targetScoreKey(target) {
    if (!target) return null;
    return `${target.tuneId}::${target.settingId || ''}`;
}

/**
 * Whether the overlay needs to (re)fetch a score for `target`, given which
 * target's score is currently displayed (`abcTargetKey`) and which target's
 * score is currently being fetched (`loadingTargetKey`, or null/undefined if
 * nothing is in flight).
 *
 * This exists because loadScore() deliberately leaves the previous score
 * visible while a new one loads (see its comment), so `target` and the
 * on-screen score can be legitimately out of sync for the duration of a
 * fetch — including across a close/reopen if the user is fast enough, and
 * including every detections tick that arrives *during* that fetch (live
 * analysis ticks several times a second). Comparing against
 * `loadingTargetKey` as well as `abcTargetKey` is what stops each of those
 * ticks from starting a duplicate fetch and invalidating the one already in
 * flight via loadScore()'s token guard — which would mean the score can
 * never finish loading while ticks keep arriving faster than the fetch does.
 */
export function needsScoreLoad(target, abcTargetKey, loadingTargetKey) {
    const key = targetScoreKey(target);
    if (key === abcTargetKey) return false;
    if (key === loadingTargetKey) return false;
    return true;
}

// The overlay component is destroyed on close (v-if) and recreated on reopen,
// which would otherwise lose `target`/`abcSetting` and make resolveFollowTarget()
// see `previous: null` — forcing a full reload indistinguishable from a genuine
// tune change, even when the same tune is still playing. That reload can sit
// behind the live-analysis worker queue until the next detection cycle, so
// reopening looked like it was "waiting for a new detection". This module-level
// cache survives remounts (there is only ever one overlay instance at a time) so
// the component can seed itself with what was already on screen.
let lastShown = { target: null, abcSetting: null, abcTargetKey: null, favourited: false };

export function getLastShown() {
    return lastShown;
}

export function setLastShown(state) {
    lastShown = { ...lastShown, ...state };
}

export function clearLastShown() {
    lastShown = { target: null, abcSetting: null, abcTargetKey: null, favourited: false };
}
