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

// Below this match score a place the music is not expected to be is noise.
export const POSITION_MIN_SCORE = 0.6;
// Spans scoring within this of the best are treated as equally likely.
export const POSITION_TIE_MARGIN = 0.05;
// Moving the shown line BACK without a re-alignment needs this many
// consecutive windows agreeing on it (see nextFollowLine).
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
//
// `fit: true` scores each row by the alignment that consumes the WHOLE query,
// i.e. that ends on the window's last note. The default (best cell anywhere)
// is what the Rust match score uses, and it is free to drop the last few notes
// of the window when they fit badly — which reports where the music was a few
// notes ago, not where it is. For a position, the end is the point. Trailing
// window notes the alignment treats as extra (gaps against the tune, which
// are cheaper than wrong notes) still took time to play, so a fit span's end
// is moved on by that many quavers: a few wrong last notes must not put the
// position behind the music.
export function matchSpans(query, stored, maxSpans = MAX_SPANS, { fit = false } = {}) {
    if (!query || !stored || query.length > stored.length || maxSpans <= 0) return [];
    const n = query.length;
    let prevH = new Int32Array(n + 1);
    let prevS = new Int32Array(n + 1);
    let curH = new Int32Array(n + 1);
    let curS = new Int32Array(n + 1);
    // Fit only: how many query notes at the end of each cell's alignment are
    // gaps against the tune.
    let prevT = new Int32Array(n + 1);
    let curT = new Int32Array(n + 1);
    const rowTrail = new Int32Array(stored.length);
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
            let trail;
            if (diag >= left && diag >= up) {
                h = diag;
                start = (row === 0 || col === 1) ? row : prevS[col - 1];
                trail = 0;
            } else if (left >= up) {
                h = left;
                start = curS[col - 1];
                trail = curT[col - 1] + 1;
            } else {
                h = up;
                start = row === 0 ? row : prevS[col];
                trail = prevT[col];
            }
            curH[col] = h;
            curS[col] = start;
            curT[col] = trail;
            if (h > best) { best = h; bestStart = start; }
        }
        rowBest[row] = fit ? curH[n] : best;
        rowStart[row] = fit ? curS[n] : bestStart;
        rowTrail[row] = fit ? curT[n] : 0;
        [prevH, curH] = [curH, prevH];
        [prevS, curS] = [curS, prevS];
        [prevT, curT] = [curT, prevT];
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
        if (spans.some(s => start < s.matchedEnd && s.start < end)) continue;
        spans.push({
            start,
            end: Math.min(stored.length, end + rowTrail[row]),
            matchedEnd: end,
            score: (0.5 * raw) / n,
        });
        if (spans.length >= maxSpans) break;
    }
    return spans.map(({ matchedEnd, ...span }) => span);
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

// ---------------------------------------------------------------------------
// Tracking: the music flows in time.
//
// Judging every window on its own (the first version) threw away the one
// thing known for certain: where the music was a few seconds ago, and how
// fast it was going. Fiddle tunes repeat phrases constantly, and an A and a B
// part often share a bar or two, so a window on its own is regularly
// ambiguous — and one misplaced window moved the view.
//
// So the position is a small set of HYPOTHESES, each a place in the
// played-out tune plus a tempo, projected forward between windows. A new
// window is first asked "does it agree with where we expect to be?", with a
// lower bar for that than for a place out of nowhere: a 0.45 match exactly
// where the music should be is good evidence, the same score elsewhere is
// noise. The tune wraps — the end of the contour leads to its start, because
// a tune is played two or three times through.
//
// It must also RE-ALIGN when it is wrong or the room went somewhere else
// (improvisation, a skipped repeat, someone starting the B part again):
//   - a strong match elsewhere is kept as an alternative hypothesis, and if
//     the next window agrees with it, it takes over: two windows, not one;
//   - an alternative that keeps agreeing BETTER than the main one takes over
//     too, which is what corrects "followed the wrong one of two repeats";
//   - after a couple of windows matching nothing where expected, the main
//     hypothesis counts as lost and a single clear match anywhere re-locks.
// Through a few unmatched windows (variations, a bar of improvisation) the
// main hypothesis keeps time on its own for up to COAST_SECONDS, since
// improvisation usually follows the tune's structure; then it holds.
//
// Positions are in quavers of the stored contour, UNWRAPPED (they keep
// growing across laps), so "how far apart" and "how fast" are plain
// arithmetic; the score position is taken modulo the contour's length.

// A candidate where the music is expected needs only this match score.
export const TRACK_MIN_SCORE = 0.4;
// A place the music is NOT expected to be needs this, as before.
export const RELOCK_MIN_SCORE = POSITION_MIN_SCORE;
// How far from the projection a candidate may land and still agree with it:
// a fixed slack, plus a share of the distance projected since the last match
// (tempo error accumulates).
export const TOLERANCE_QUAVERS = 6;
export const TOLERANCE_GROWTH = 0.15;
// How long the main hypothesis keeps time with nothing confirming it.
export const COAST_SECONDS = 20;
// Unmatched windows after which a single clear match anywhere re-locks.
export const MISSES_BEFORE_LOST = 2;
// An alternative must beat the main hypothesis's running score by this to
// take over while the main one is still matching.
export const SWITCH_MARGIN = 0.08;
export const MAX_HYPOTHESES = 4;
// How far a new measurement moves the projection (1 = jump to it).
const BLEND = 0.7;
// How quickly the tempo follows what successive windows measure.
const PACE_SMOOTHING = 0.3;
// Among candidates that agree, a small preference for the nearer one.
const DISTANCE_PENALTY = 0.1;
// Candidates closer than this are the same place.
const SAME_PLACE_QUAVERS = 2;

function circularDistance(a, b, length) {
    const d = Math.abs(a - b) % length;
    return Math.min(d, length - d);
}

// `end` (0..length) as the unwrapped position nearest `near`.
function unwrapNear(end, near, length) {
    return end + length * Math.round((near - end) / length);
}

// Where in the tune the window could END: fit alignments (the whole window,
// up to its last note) against the stored contour looped once, so a window
// spanning the end of one time through and the start of the next is found
// too. Best first, distinct places only: { end, covered, score }.
export function positionCandidates(query, stored, maxSpans = MAX_SPANS) {
    if (!query || !stored || query.length < MIN_QUERY_LENGTH || query.length > stored.length) return [];
    const length = stored.length;
    const looped = stored + stored.slice(0, query.length);
    const spans = matchSpans(query, looped, maxSpans * 2, { fit: true });
    const out = [];
    for (const s of spans) {
        const end = s.end > length ? s.end - length : s.end;
        if (out.some(c => circularDistance(c.end, end, length) <= SAME_PLACE_QUAVERS)) continue;
        out.push({ end, covered: s.end - s.start, score: s.score });
        if (out.length >= maxSpans) break;
    }
    return out;
}

function projected(h, t) {
    return h.pos + Math.max(0, (t - h.at) / 1000) * h.pace;
}

function tolerance(h, t) {
    return TOLERANCE_QUAVERS + TOLERANCE_GROWTH * h.pace * Math.max(0, (t - h.lastHit) / 1000);
}

// The candidate that best agrees with hypothesis `h` at time `t`, or null.
function agreeing(h, candidates, t, length) {
    const pred = projected(h, t);
    const tol = tolerance(h, t);
    let best = null;
    for (const c of candidates) {
        if (c.score < TRACK_MIN_SCORE) continue;
        const u = unwrapNear(c.end, pred, length);
        const d = Math.abs(u - pred);
        if (d > tol) continue;
        const merit = c.score - DISTANCE_PENALTY * (d / tol);
        if (!best || merit > best.merit) best = { candidate: c, u, merit };
    }
    return best;
}

function advance(h, match, t) {
    const pred = projected(h, t);
    let pace = h.pace;
    const dt = (t - h.measuredAt) / 1000;
    if (dt >= 1) {
        const measured = (match.u - h.measured) / dt;
        // A measurement far off the running tempo is a misalignment, not a
        // tempo change; tempo changes are gradual.
        if (measured > 0.6 * pace && measured < 1.6 * pace) pace += PACE_SMOOTHING * (measured - pace);
    }
    return {
        pos: pred + BLEND * (match.u - pred),
        at: t,
        pace,
        lastHit: t,
        hits: h.hits + 1,
        misses: 0,
        score: 0.6 * h.score + 0.4 * match.candidate.score,
        measured: match.u,
        measuredAt: t,
    };
}

function seed(candidate, t, windowSeconds, length, near) {
    // The fit span covers the whole window, so its length over the window's
    // is the tempo actually being played, in quavers per second.
    const pace = windowSeconds > 0 && candidate.covered > 0 ? candidate.covered / windowSeconds : 4;
    const pos = near === null || near === undefined ? candidate.end : unwrapNear(candidate.end, near, length);
    return { pos, at: t, pace, lastHit: t, hits: 1, misses: 0, score: candidate.score, measured: pos, measuredAt: t };
}

const EMPTY_TRACK = Object.freeze({ main: null, alts: [], epoch: 0, reason: 'none', score: 0, window: null });

// Fold one analysed window into the tracking state. Call once per window
// (`position.readAt` identifies it; a repeat is ignored).
//
//   position      — windowPosition() of the window
//   storedContour — the contour of the setting ON SCREEN
//   candidates    — optional, positionCandidates() already computed
//   lineOf        — optional (end in quavers) → staff line; lets a fresh lock
//                   accept a tie between places on the SAME line (the two A
//                   parts of AABB), as the per-window rule did
//
// `reason`: 'ok' (the window agreed), 'realigned' (moved somewhere else),
// 'coasting' (the window did not agree; keeping time), 'ambiguous',
// 'weak' (nothing clear enough), 'none'.
export function trackPosition(state, position, { storedContour, candidates = null, lineOf = null } = {}) {
    const prev = state || EMPTY_TRACK;
    if (!position || !storedContour) return prev;
    const t = position.readAt;
    if (prev.window === t) return prev;
    const length = storedContour.length;
    const found = candidates || positionCandidates(position.contour, storedContour);
    const bestScore = found.length ? found[0].score : 0;
    const windowSeconds = position.windowSeconds || 0;

    const claimed = [];
    const claim = (m) => { if (m) claimed.push(m.candidate); return m; };
    const mainMatch = prev.main ? claim(agreeing(prev.main, found, t, length)) : null;
    let main = prev.main
        ? (mainMatch ? advance(prev.main, mainMatch, t) : { ...prev.main, misses: prev.main.misses + 1 })
        : null;
    let alts = [];
    for (const h of prev.alts) {
        const m = claim(agreeing(h, found, t, length));
        if (m) alts.push(advance(h, m, t));
    }
    let epoch = prev.epoch;
    let reason;

    // Strong places this window that no hypothesis accounts for.
    const isClaimed = (c) => claimed.some(k => circularDistance(k.end, c.end, length) <= SAME_PLACE_QUAVERS);
    const fresh = found.filter(c => c.score >= RELOCK_MIN_SCORE && !isClaimed(c));

    const confirmed = alts.filter(h => h.hits >= 2).sort((x, y) => y.score - x.score)[0];
    const lost = !main || main.misses >= MISSES_BEFORE_LOST || (t - main.lastHit) / 1000 > COAST_SECONDS;

    if (confirmed && (!mainMatch || confirmed.score > main.score + SWITCH_MARGIN)) {
        // Two windows agree on somewhere else, or keep agreeing better.
        alts = alts.filter(h => h !== confirmed);
        if (mainMatch) alts.push(main);
        main = confirmed;
        epoch++;
        reason = 'realigned';
    } else if (mainMatch) {
        reason = 'ok';
    } else if (lost) {
        const strong = fresh.filter(c => c.score >= bestScore - POSITION_TIE_MARGIN);
        const oneLine = strong.length > 1 && typeof lineOf === 'function' &&
            strong.every(c => lineOf(c.end) === lineOf(strong[0].end));
        if (strong.length === 1 || oneLine) {
            const near = main ? projected(main, t) : null;
            const hadMain = !!main;
            main = seed(strong[0], t, windowSeconds, length, near);
            alts = alts.concat(strong.slice(1).map(c => seed(c, t, windowSeconds, length, near)));
            fresh.splice(0, fresh.length);
            if (hadMain) epoch++;
            reason = hadMain ? 'realigned' : 'ok';
        } else {
            reason = strong.length > 1 ? 'ambiguous' : 'weak';
        }
    } else {
        reason = 'coasting';
    }

    // Anything strong nobody explains becomes an alternative, so the NEXT
    // window can confirm it.
    const near = main ? projected(main, t) : null;
    for (const c of fresh) alts.push(seed(c, t, windowSeconds, length, near));
    // An alternative that has converged on the main hypothesis is the same.
    if (main) {
        const mainNow = projected(main, t);
        alts = alts.filter(h => circularDistance(projected(h, t), mainNow, length) > TOLERANCE_QUAVERS);
    }
    alts.sort((x, y) => y.score - x.score);
    alts = alts.slice(0, MAX_HYPOTHESES);

    return { main, alts, epoch, reason, score: bestScore, window: t };
}

// Where the main hypothesis puts the music at `nowMs`: the fraction of the
// played-out tune, which lap of it, and whether the projection has run out
// (more than COAST_SECONDS since anything confirmed it), in which case it
// holds where it got to. Null with no hypothesis.
export function followPoint(state, nowMs, contourLength) {
    if (!state || !state.main || !(contourLength > 0)) return null;
    const h = state.main;
    const limit = h.lastHit + COAST_SECONDS * 1000;
    const until = Math.min(nowMs, limit);
    const pos = h.pos + Math.max(0, (until - h.at) / 1000) * h.pace;
    const wrapped = ((pos % contourLength) + contourLength) % contourLength;
    return {
        fraction: wrapped / contourLength,
        lap: Math.floor(pos / contourLength),
        epoch: state.epoch,
        held: nowMs > limit,
    };
}

// Hysteresis on the LINE shown, so a small backward correction of the
// projection does not flick the band back and forth. `windowKey` identifies
// the window an answer came from (its readAt): the view re-decides every
// second to project forward, and only a NEW window counts as a confirmation.
// `force` moves at once in either direction: the tracker re-aligned, or the
// tune came round to the top again — both already confirmed upstream.
export function nextFollowLine(state, line, windowKey, { force = false } = {}) {
    const current = state || { line: null, pendingLine: null, pendingCount: 0, pendingKey: null };
    if (line === null || line === undefined) return current;
    if (force || current.line === null || line >= current.line) {
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
