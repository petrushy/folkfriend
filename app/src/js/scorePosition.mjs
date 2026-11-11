// Where in the tune is the room? The rules behind the follow view's
// auto-centre, kept pure so they can be tested without a score or a clock.
//
// The Rust query reports, for each result, where in that setting's stored
// contour the last window matched (`match_spans`, see rust/src/query/nw.rs).
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

// From one analysed window's query results, everything the follow view needs
// about position, per tune. Results without spans (older WASM, or beyond the
// first few results) are simply absent.
export function windowPositions(results, { readAt, windowSeconds }) {
    const byTune = {};
    for (const result of results || []) {
        const setting = result && result.setting;
        const spans = result && result.match_spans;
        if (!setting || !setting.tune_id || !Array.isArray(spans) || spans.length === 0) continue;
        const contourLength = typeof setting.contour === 'string' ? setting.contour.length : 0;
        if (!contourLength) continue;
        const tuneId = String(setting.tune_id);
        if (byTune[tuneId]) continue; // results are best first
        byTune[tuneId] = {
            settingId: result.setting_id != null ? String(result.setting_id) : '',
            contourLength,
            spans: spans.map(s => ({ start: s.start, end: s.end, score: s.score })),
        };
    }
    return { readAt, windowSeconds, byTune };
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
//   position  — windowPositions() of the latest window
//   tuneId / settingId — what the view is SHOWING. A span is a position in one
//               setting's contour; against another setting it means nothing,
//               so a manual pick or a fallback to settings[0] gets no position.
//   nowMs     — the clock, for projecting past the window's end
//
// Several spans can tie. Two repeats of the A part are the same written bars,
// so if every near-best span lands on the same LINE the answer is that line.
// If they land on different lines (an A and a B part sharing a phrase) the
// answer is "ambiguous" — and the view holds rather than guessing.
export function decideLine(position, { tuneId, settingId, nowMs, timeline }) {
    if (!position || !position.byTune) return { line: null, reason: 'none' };
    const entry = position.byTune[String(tuneId)];
    if (!entry) return { line: null, reason: 'none' };
    if (String(entry.settingId) !== String(settingId || '')) return { line: null, reason: 'other-setting' };
    const best = entry.spans[0];
    if (!best || best.score < POSITION_MIN_SCORE) return { line: null, reason: 'weak' };

    const elapsed = Math.max(0, (nowMs - position.readAt) / 1000);
    if (elapsed > MAX_EXTRAPOLATE_SECONDS + (position.windowSeconds || 0)) {
        return { line: null, reason: 'stale' };
    }

    const candidates = entry.spans.filter(s => s.score >= best.score - POSITION_TIE_MARGIN);
    const fractions = candidates.map(s =>
        spanFraction(s, entry.contourLength, position.windowSeconds, elapsed));
    const lines = fractions.map(f => lineAtFraction(timeline, f));
    if (lines.some(l => l === null)) return { line: null, reason: 'no-timeline' };
    if (lines.some(l => l !== lines[0])) return { line: null, reason: 'ambiguous' };
    return { line: lines[0], fraction: fractions[0], reason: 'ok' };
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
