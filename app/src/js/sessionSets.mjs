// Making tune sets out of a session's tune list. Pure: no Vue, no store.
//
// A session already falls into the sets it was played in — tunes back to back,
// separated by breaks — so the list is split into RUNS wherever the gap
// between one tune and the next is long enough to be a break. A run is only a
// suggestion: an unrecognised tune in the middle of a set leaves a gap just
// like a break does, and the user can always tick rows across runs instead.

// How long a gap between two tunes counts as a break between sets. Inside a
// set the next tune is recognised within a window or so of the last one ending
// (the gap measured below is about zero); a pub break is minutes. A tune the
// search does not know is also minutes, and will split a run — that is the
// cost of not guessing, and ticking across runs is the way round it.
export const SET_BREAK_SECONDS = 45;

// A row's identity for SELECTION, which has to survive a live re-cluster. The
// detection id carries the row's position in the list, so it changes whenever
// an earlier row is filtered or merged; the tune also changes on a
// correction. Where the row starts does neither: a merged row keeps its
// earliest start.
export function selectionKey(row) {
    return String(Math.round(Number(row.startSeconds) || 0));
}

// The gap, in seconds, between the end of `previous` and the start of `next`,
// counting time the session spent paused.
//
// startSeconds/endSeconds are the LISTENING clock, which stops while paused —
// and pausing through the break between sets is exactly what people do. The
// wall-clock stamps (startedAtMs/endedAtMs, the read time of the first and
// last matching window) see the pause. endSeconds is a window past the last
// read, so the wall-clock gap is measured read to read and the window taken
// off, which puts both on the same footing.
export function gapSeconds(previous, next, { windowSeconds = 10 } = {}) {
    const listening = Number(next.startSeconds) - Number(previous.endSeconds);
    if (typeof previous.endedAtMs === 'number' && typeof next.startedAtMs === 'number') {
        const wall = (next.startedAtMs - previous.endedAtMs) / 1000 - windowSeconds;
        return Math.max(listening, wall);
    }
    return listening;
}

// Splits rows (in played order) into runs: [{ start, end }] with `end`
// inclusive, covering every row exactly once.
export function groupIntoRuns(rows, { breakSeconds = SET_BREAK_SECONDS, windowSeconds = 10 } = {}) {
    const runs = [];
    rows.forEach((row, index) => {
        const run = runs[runs.length - 1];
        if (run && gapSeconds(rows[index - 1], row, { windowSeconds }) < breakSeconds) run.end = index;
        else runs.push({ start: index, end: index });
    });
    return runs;
}

// Which setting of a tune goes into a set. `candidates` is what
// settingsForSetTune returns: favourites flagged `favourite`. The setting a
// detection carries is whichever one scored best in that window — for a tune
// with dozens of settings close to arbitrary — so a starred setting, which is
// the one the user actually plays, wins over it. Among several starred
// settings the detected one is preferred if it is one of them.
export function pickSetting(candidates, detectedSettingID) {
    if (!candidates || !candidates.length) return null;
    const detected = detectedSettingID == null ? null : String(detectedSettingID);
    const isDetected = c => detected !== null && String(c.setting_id) === detected;
    const favourites = candidates.filter(c => c.favourite);
    if (favourites.length) return favourites.find(isDetected) || favourites[0];
    return candidates.find(isDetected) || candidates[0];
}

// The default name of a set made from a session: the session's own label,
// plus which set of the evening it was when it came from a run.
export function setNameFromSession(sessionLabel, runNumber = null) {
    const label = String(sessionLabel || '').trim() || 'Session';
    const name = runNumber ? `${label} · set ${runNumber}` : label;
    return name.slice(0, 200);
}
