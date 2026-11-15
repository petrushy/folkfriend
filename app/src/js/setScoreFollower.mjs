// Follow any saved tune in an arrangement, without searching the whole tune index.
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
        this._candidate = null; this._hits = 0;
        this._lineFollower = new ScoreFollower();
    }

    select(index, readAt = null) {
        if (!Number.isInteger(index) || index < 0 || index >= this.entries.length) return false;
        this.index = index;
        this._minimumReadAt = readAt == null ? -Infinity : readAt;
        this._window = readAt;
        this._candidate = null; this._hits = 0;
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
            const groups = new Map();
            this.entries.forEach((entry, index) => {
                if (!entry.contour || entry.contour.length < MIN_QUERY_LENGTH) return;
                if (!groups.has(entry.contour)) groups.set(entry.contour, { contour: entry.contour, indices: [] });
                groups.get(entry.contour).indices.push(index);
            });
            const length = Math.min(SET_SWITCH_TAIL, ...[...groups.values()].map(g => g.contour.length));
            const query = typeof position.contour === 'string' ? position.contour.slice(-length) : '';
            const ranked = length >= MIN_QUERY_LENGTH && query.length >= MIN_QUERY_LENGTH
                ? [...groups.values()].map(group => ({ ...group, score: positionCandidates(query, group.contour, 1)[0]?.score || 0 }))
                    .sort((a, b) => b.score - a.score) : [];
            const best = ranked[0];
            const runnerScore = ranked[1]?.score || 0;
            const target = !best || best.indices.includes(this.index) ? this.index
                : best.indices.find(index => index > this.index) ?? best.indices[0];
            if (best && target !== this.index && best.score >= SET_SWITCH_SCORE && best.score >= runnerScore + SET_SWITCH_MARGIN) {
                this._hits = this._candidate === target ? this._hits + 1 : 1;
                this._candidate = target;
            } else { this._candidate = null; this._hits = 0; }
            // Compare every tune, but require distinct windows and an
            // unambiguous winner. Identical occurrences use their set order;
            // audio alone cannot distinguish a repeat from a new occurrence.
            if (this._hits >= SET_SWITCH_WINDOWS) {
                this.index = target;
                this._candidate = null; this._hits = 0;
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
