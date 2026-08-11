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
 * Whether `abcSetting` (as returned by settingsFromTuneID, carrying its own
 * `tune_id`) is actually the score for `target`, rather than a previous
 * tune's score that's still on screen while a newer load is in flight.
 * loadScore() deliberately leaves the old abcSetting visible during a load
 * (see its comment) so target and abcSetting can be legitimately out of sync
 * for the duration of a fetch — including across a close/reopen if the user
 * is fast enough. Only tune_id is compared, not setting_id: falling back to
 * settings[0] when a specific settingId isn't found is an intentional,
 * pre-existing choice in loadScore(), not a mismatch to correct here.
 */
export function cachedScoreMatchesTarget(abcSetting, target) {
    if (!target) return true;
    if (!abcSetting) return false;
    return String(abcSetting.tune_id) === String(target.tuneId);
}

// The overlay component is destroyed on close (v-if) and recreated on reopen,
// which would otherwise lose `target`/`abcSetting` and make resolveFollowTarget()
// see `previous: null` — forcing a full reload indistinguishable from a genuine
// tune change, even when the same tune is still playing. That reload can sit
// behind the live-analysis worker queue until the next detection cycle, so
// reopening looked like it was "waiting for a new detection". This module-level
// cache survives remounts (there is only ever one overlay instance at a time) so
// the component can seed itself with what was already on screen.
let lastShown = { target: null, abcSetting: null, favourited: false };

export function getLastShown() {
    return lastShown;
}

export function setLastShown(state) {
    lastShown = { ...lastShown, ...state };
}

export function clearLastShown() {
    lastShown = { target: null, abcSetting: null, favourited: false };
}
