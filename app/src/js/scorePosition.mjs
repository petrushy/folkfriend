// Where in the tune is the room? The rules behind the follow view's
// auto-centre, kept pure so they can be tested without a score or a clock.
//
// Each analysed window's transcribed contour is aligned against the stored
// contour of the setting ON SCREEN (`matchSpans`). Not against whatever the
// query ranked first: results are one per tune, carrying that window's
// best-scoring setting, which for a tune with many settings (Drowsy Maggie has
// dozens) is almost never the one being displayed — the first version did
// that, and on a device it said "position n/a" nearly all the time. Aligning
// here costs query × stored cells (~60 × 600), well under a millisecond, and
// works for any setting shown, a manual pick included.
//
// A stored contour is one character per quaver with repeats PLAYED OUT, so a
// span's end divided by the contour's length is how far through the played-out
// tune the music is. That fraction is mapped onto the rendered score through
// ABCJS's own playback timeline, which is also played out — so repeats, first
// and second endings and pickups all line up without this module knowing what
// any of them are.
//
// A fraction, not a quaver count, on purpose. The stored contour is not an
// exact clock: grace notes are stripped, sub-quaver notes are rounded up or
// dropped, dotted notes are rounded (see the contour pipeline notes in
// CLAUDE.md). Those errors accumulate along the tune, and a fraction of the
// whole spreads them out rather than letting them pile up at the end.
//
// The target is a staff LINE, never a note. A line is usually four bars, which
// is coarse enough to absorb that drift and is what a player actually needs:
// the music they are playing somewhere near the middle of the screen.

// Below this match score the position is noise; hold where we are. Positions
// are judged per window, so this is a bar on the window's own match.
export const POSITION_MIN_SCORE = 0.6;
// Spans scoring within this of the best are treated as equally likely.
export const POSITION_TIE_MARGIN = 0.05;
// How far past the window's end the position may be projected. Beyond this the
// estimate is a guess about music nobody has heard; it holds instead.
export const MAX_EXTRAPOLATE_SECONDS = 8;
// Moving BACK needs this many consecutive windows agreeing on the same line.
// Forward is the normal direction of music; backward is either the top of the
// tune coming round again (real, and confirmed within a window or two) or one
// misplaced window (not real, and not worth a jump).
export const BACKWARD_CONFIRMATIONS = 2;

// Fewer notes than this say nothing about where in a tune they are: a
// partial window early in a run, or a few notes over conversation.
export const MIN_QUERY_LENGTH = 12;
// How many candidate places matchSpans reports: enough for AABB plus a
// competing part.
export const MAX_SPANS = 4;

// What the follow view needs from one analysed window: its transcribed
// contour and when it ended.
export function windowPosition(contour, { readAt, windowSeconds }) {
    if (typeof contour !== 'string' || contour.length < MIN_QUERY_LENGTH) return null;
    return { contour, readAt, windowSeconds };
}

// Scoring, normalisation and boundaries exactly as the Rust second pass
// (rust/src/query/nw.rs): match +2, mismatch -2, gap -1, zero top and left
// boundary, best cell anywhere, score = 0.5 × raw / len(query). So the best
// span's score is the match score the tune itself would get for this setting.
const MATCH = 2;
const MISMATCH = -2;
const GAP = -1;

// The best few NON-OVERLAPPING places `query` aligns within `stored`, best
// first: { start, end (exclusive), score }, offsets into `stored`.
//
// More than one on purpose. A tune played AABB is stored with its repeats
// played out, so its two A parts are an exact tie — harmless, they are the same
// written bars. Two DIFFERENT parts sharing a phrase are also a tie, and are
// not. Only the caller, which knows where each span lands on the score, can
// tell the two apart.
//
// One previous row is kept, plus the row of `stored` each cell's alignment
// began on, so memory is O(len(query)). Empty when the query is longer than
// the tune — a position "in the tune" would mean nothing.
export function matchSpans(query, stored, maxSpans = MAX_SPANS) {
    if (!query || !stored || query.length > stored.length || maxSpans <= 0) return [];
    const n = query.length;
    let prevH = new Int32Array(n + 1);
    let prevS = new Int32Array(n + 1);
    let curH = new Int32Array(n + 1);
    let curS = new Int32Array(n + 1);
    const rowBest = new Int32Array(stored.length);
    const rowStart = new Int32Array(stored.length);

    for (let row = 0; row < stored.length; row++) {
        const b = stored.charCodeAt(row);
        curH[0] = 0;
        curS[0] = row;
        let best = -Infinity;
        let bestStart = row;
        for (let col = 1; col <= n; col++) {
            // A predecessor on the boundary means the alignment starts on
            // this row; anything else carries its own start forward.
            const diag = prevH[col - 1] + (query.charCodeAt(col - 1) === b ? MATCH : MISMATCH);
            const left = curH[col - 1] + GAP;
            const up = prevH[col] + GAP;
            let h;
            let start;
            if (diag >= left && diag >= up) {
                h = diag;
                start = (row === 0 || col === 1) ? row : prevS[col - 1];
            } else if (left >= up) {
                h = left;
                start = curS[col - 1];
            } else {
                h = up;
                start = row === 0 ? row : prevS[col];
            }
            curH[col] = h;
            curS[col] = start;
            if (h > best) { best = h; bestStart = start; }
        }
        rowBest[row] = best;
        rowStart[row] = bestStart;
        [prevH, curH] = [curH, prevH];
        [prevS, curS] = [curS, prevS];
    }

    // Highest-scoring ending row first, earliest on a tie (so the first of two
    // identical repeats wins, deterministically), skipping overlaps.
    const order = Array.from(rowBest.keys())
        .sort((x, y) => (rowBest[y] - rowBest[x]) || (x - y));
    const spans = [];
    for (const row of order) {
        const raw = rowBest[row];
        if (raw <= 0) break;
        const start = rowStart[row];
        const end = row + 1;
        if (spans.some(s => start < s.end && s.start < end)) continue;
        spans.push({ start, end, score: (0.5 * raw) / n });
        if (spans.length >= maxSpans) break;
    }
    return spans;
}

// How far through the played-out tune `span` puts the music, `elapsedSeconds`
// after the window ended. The pace comes from the span itself: it covers the
// window, so its length over the window's length is quavers per second at the
// tempo actually being played.
export function spanFraction(span, contourLength, windowSeconds, elapsedSeconds = 0) {
    if (!contourLength) return 0;
    const covered = Math.max(0, span.end - span.start);
    const pace = windowSeconds > 0 ? covered / windowSeconds : 0;
    const ahead = Math.min(Math.max(0, elapsedSeconds), MAX_EXTRAPOLATE_SECONDS) * pace;
    const position = Math.min(contourLength, span.end + ahead);
    return Math.max(0, Math.min(1, position / contourLength));
}

// The played-out timeline of a rendered score: `events` sorted by
// `milliseconds`, each carrying the staff `line` it is drawn on, and the
// timeline's total length. Built by AbcDisplay from ABCJS's TimingCallbacks.
export function lineAtFraction(timeline, fraction) {
    if (!timeline || !timeline.events || timeline.events.length === 0 || !(timeline.totalMs > 0)) {
        return null;
    }
    const target = Math.max(0, Math.min(1, fraction)) * timeline.totalMs;
    const events = timeline.events;
    let lo = 0;
    let hi = events.length - 1;
    // Last event starting at or before the target.
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (events[mid].milliseconds <= target) lo = mid;
        else hi = mid - 1;
    }
    const line = events[lo].line;
    return typeof line === 'number' ? line : null;
}

// Which line the music is on now, or why that cannot be said.
//
//   position       — windowPosition() of the latest window
//   storedContour  — the contour of the setting ON SCREEN
//   nowMs          — the clock, for projecting past the window's end
//   spans          — optional, matchSpans() already computed for this
//                    position and contour (the view re-decides every second
//                    and need not re-align each time)
//
// If every span within the tie margin of the best lands on the same LINE the
// answer is that line. If they land on different lines (an A and a B part
// sharing a phrase) the answer is "ambiguous" — and the view holds rather than
// guessing.
export function decideLine(position, { storedContour, nowMs, timeline, spans = null }) {
    if (!position || !position.contour) return { line: null, reason: 'none' };
    if (!storedContour) return { line: null, reason: 'no-contour' };
    const elapsed = Math.max(0, (nowMs - position.readAt) / 1000);
    if (elapsed > MAX_EXTRAPOLATE_SECONDS + (position.windowSeconds || 0)) {
        return { line: null, reason: 'stale' };
    }
    const found = spans || matchSpans(position.contour, storedContour);
    const best = found[0];
    if (!best || best.score < POSITION_MIN_SCORE) {
        return { line: null, reason: 'weak', score: best ? best.score : 0 };
    }

    const candidates = found.filter(s => s.score >= best.score - POSITION_TIE_MARGIN);
    const fractions = candidates.map(s =>
        spanFraction(s, storedContour.length, position.windowSeconds, elapsed));
    const lines = fractions.map(f => lineAtFraction(timeline, f));
    if (lines.some(l => l === null)) return { line: null, reason: 'no-timeline' };
    if (lines.some(l => l !== lines[0])) return { line: null, reason: 'ambiguous', score: best.score };
    return { line: lines[0], fraction: fractions[0], score: best.score, reason: 'ok' };
}

// Hysteresis over decideLine()'s answers, so one stray window does not throw
// the view backwards. `windowKey` identifies the window an answer came from
// (its readAt): the view re-decides every second to project forward, and only
// a NEW window counts as a confirmation.
export function nextFollowLine(state, line, windowKey) {
    const current = state || { line: null, pendingLine: null, pendingCount: 0, pendingKey: null };
    if (line === null || line === undefined) return current;
    if (current.line === null || line >= current.line) {
        return { line, pendingLine: null, pendingCount: 0, pendingKey: null };
    }
    // Behind where we are.
    if (current.pendingLine === line) {
        if (current.pendingKey === windowKey) return current;
        const pendingCount = current.pendingCount + 1;
        if (pendingCount >= BACKWARD_CONFIRMATIONS) {
            return { line, pendingLine: null, pendingCount: 0, pendingKey: null };
        }
        return { ...current, pendingCount, pendingKey: windowKey };
    }
    return { ...current, pendingLine: line, pendingCount: 1, pendingKey: windowKey };
}
