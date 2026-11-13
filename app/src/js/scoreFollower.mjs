// Following one score: the tracker (js/scorePosition.mjs) plus the line
// hysteresis and the readout, as one object. The live view and the Tune
// view's practice follow both drive one of these, so they behave the same.
//
// Pure: no clock of its own, no DOM. Feed it the latest analysed window, the
// contour of the setting on screen and that score's played-out timeline;
// call it again every second to re-project between windows.

import {
    trackPosition, followPoint, positionCandidates, lineAtFraction, nextFollowLine,
} from './scorePosition.mjs';

export class ScoreFollower {
    constructor() {
        this.reset();
    }

    // A different score, or following switched off and on again.
    reset() {
        this.track = null;
        this._lines = null;
        this._mark = null;
    }

    // Returns { line, readout }. `line` is the staff line to show (0-based)
    // or null; `readout` says what the follower thinks, for the user.
    update({ position, storedContour, timeline, nowMs }) {
        if (!storedContour || !timeline) return { line: null, readout: 'position n/a' };
        const length = storedContour.length;
        // Each window is folded in once; later calls only re-project.
        if (position && (!this.track || this.track.window !== position.readAt)) {
            this.track = trackPosition(this.track, position, {
                storedContour,
                candidates: positionCandidates(position.contour, storedContour),
                lineOf: (end) => lineAtFraction(timeline, end / length),
            });
        }
        const point = followPoint(this.track, nowMs, length);
        const line = point ? lineAtFraction(timeline, point.fraction) : null;
        // A re-alignment or the tune coming round to the top moves the line
        // at once, backwards included; only small corrections of the
        // projection are held back.
        const mark = point ? `${point.epoch}:${point.lap}` : null;
        const force = !!point && this._mark !== null && mark !== this._mark;
        this._mark = mark;
        this._lines = nextFollowLine(this._lines, line, position ? position.readAt : null, { force });
        const shown = this._lines.line;
        return { line: shown, readout: positionReadout(this.track, point, shown, timeline.lineCount || 0) };
    }
}

export function positionReadout(track, point, line, count) {
    if (!track) return '';
    const here = line !== null ? `line ${line + 1}/${count}` : '';
    const pct = point ? ` · ${Math.round(point.fraction * 100)}%` : '';
    if (point && point.held) return `${here}, lost the place`;
    switch (track.reason) {
    case 'ok': return here ? `${here}${pct}` : '';
    case 'realigned': return `${here}${pct} · realigned`;
    case 'coasting': return `${here} · keeping time`;
    case 'ambiguous': return here ? `${here}, which part?` : 'which part?';
    case 'weak': {
        const unclear = `position unclear (${(track.score || 0).toFixed(2)})`;
        return here ? `${here}, ${unclear}` : unclear;
    }
    default: return here;
    }
}
