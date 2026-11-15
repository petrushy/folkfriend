// Follow a known ordered arrangement, without searching the whole tune index.
// Staff-line tracking is the same ScoreFollower used by the Tune view.
import { ScoreFollower } from './scoreFollower.mjs';
import { positionCandidates, MIN_QUERY_LENGTH } from './scorePosition.mjs';

export const SET_SWITCH_SCORE = 0.8;
export const SET_SWITCH_MARGIN = 0.15;
export const SET_SWITCH_WINDOWS = 2;
export const SET_SWITCH_TAIL = 32;
export const SET_WINDOW_MAX_AGE_MS = 15000;

export class SetScoreFollower {
    constructor(entries) {
        this.entries = entries;
        this.index = 0;
        this._window = null;
        this._minimumReadAt = -Infinity;
        this._nextHits = 0;
        this._lineFollower = new ScoreFollower();
    }

    select(index, readAt = null) {
        if (!Number.isInteger(index) || index < 0 || index >= this.entries.length) return false;
        this.index = index;
        this._minimumReadAt = readAt == null ? -Infinity : readAt;
        this._window = readAt;
        this._nextHits = 0;
        this._lineFollower.reset();
        return true;
    }

    update({ position, timeline, nowMs }) {
        let changed = false;
        const fresh = position && Number.isFinite(position.readAt) &&
            (this._window === null || position.readAt > this._window) &&
            nowMs - position.readAt <= SET_WINDOW_MAX_AGE_MS;
        if (fresh) {
            this._window = position.readAt;
            const current = this.entries[this.index]?.contour || '';
            const next = this.entries[this.index + 1]?.contour || '';
            // Compare the SAME recent phrase in both tunes. A whole ten-second
            // window can still contain the end of the previous tune.
            const length = Math.min(SET_SWITCH_TAIL, current.length, next.length);
            const query = typeof position.contour === 'string' ? position.contour.slice(-length) : '';
            if (length >= MIN_QUERY_LENGTH && query.length >= MIN_QUERY_LENGTH) {
                const a = positionCandidates(query, current, 1)[0]?.score || 0;
                const b = positionCandidates(query, next, 1)[0]?.score || 0;
                this._nextHits = b >= SET_SWITCH_SCORE && b >= a + SET_SWITCH_MARGIN ? this._nextHits + 1 : 0;
            } else this._nextHits = 0;
            // Repeats and shared phrases stay in the current tune. Identical
            // adjacent settings need an explicit Next cue; audio cannot tell
            // those occurrences apart.
            if (this._nextHits >= SET_SWITCH_WINDOWS) {
                this.index++;
                this._nextHits = 0;
                this._lineFollower.reset();
                this._minimumReadAt = position.readAt - 1;
                changed = true;
            }
        }
        const storedContour = this.entries[this.index]?.contour || '';
        const usable = position && position.readAt === this._window && position.readAt > this._minimumReadAt &&
            nowMs - position.readAt <= SET_WINDOW_MAX_AGE_MS;
        // Only an analysed fresh-enough window can seed or move the tracker.
        // Null still lets an existing track project between windows.
        const result = this._lineFollower.update({
            position: usable ? position : null,
            storedContour,
            timeline: timeline(this.index),
            nowMs,
        });
        return { ...result, index: this.index, changed };
    }
}
