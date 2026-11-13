// The pure rules behind the follow view's auto-centre: turning a window's
// match spans into a staff line, and holding still when that is unclear.
// The view's use of them is covered in liveScoreFollowComponent.test.mjs.
//
// Run with:  node app/test/scorePosition.test.mjs

import assert from 'node:assert/strict';
import {
    windowPosition, matchSpans, lineAtFraction, nextFollowLine, MIN_QUERY_LENGTH,
    positionCandidates, trackPosition, followPoint, COAST_SECONDS,
} from '../src/js/scorePosition.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e && e.message}`); }
}

// An AABB tune drawn on four lines — A, A-repeat (same written lines 0-1
// played twice), B, B-repeat — as ABCJS would time it played out: lines
// 0,1,0,1,2,3,2,3, each two seconds.
function aabbTimeline() {
    const order = [0, 1, 0, 1, 2, 3, 2, 3];
    const events = [];
    order.forEach((line, i) => {
        for (let k = 0; k < 4; k++) events.push({ milliseconds: i * 2000 + k * 500, line });
    });
    return { events, totalMs: 16000, lines: [{}, {}, {}, {}], lineCount: 4 };
}

// A deterministic pseudo-random contour, so slices of it are unique.
function contour(length, seed = 1, alphabet = 'opqrstuvwxyz') {
    let x = seed;
    let out = '';
    for (let i = 0; i < length; i++) {
        x = (x * 1103515245 + 12345) % 2147483648;
        out += alphabet[x % alphabet.length];
    }
    return out;
}

// The second pass's score as Rust computes it (rust/src/query/nw.rs): the best
// cell of the same lattice. matchSpans must report exactly this as its best.
function needlemanWunsch(a, b) {
    if (!a.length || !b.length) return 0;
    if (a.length > b.length) [a, b] = [b, a];
    let best = 0;
    let prev = new Array(a.length + 1).fill(0);
    for (let r = 0; r < b.length; r++) {
        const cur = [0];
        for (let c = 1; c <= a.length; c++) {
            cur[c] = Math.max(prev[c - 1] + (a[c - 1] === b[r] ? 2 : -2), cur[c - 1] - 1, prev[c] - 1);
            best = Math.max(best, cur[c]);
        }
        prev = cur;
    }
    return 0.5 * best / a.length;
}

const POS = (contourText, readAt = 1000, windowSeconds = 10) => ({ contour: contourText, readAt, windowSeconds });

// A performance of `stored`, built segment by segment, one note every
// 1/pace seconds. Each note carries where in the played-out tune (unwrapped
// quavers) the music truly is after it, so the tracker can be checked
// against the truth at any moment.
function performance(stored, pace = 6) {
    const notes = [];
    const truth = [];
    let at = 0;
    let rnd = 12345;
    const random = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd; };
    const p = {
        // Play `count` notes of the tune starting from quaver `from`.
        play(from, count) {
            for (let k = 0; k < count; k++) {
                notes.push(stored[(from + k) % stored.length]);
                truth.push(from + k + 1);
            }
            at = from + count;
            return p;
        },
        // Carry on from where the music is.
        cont(count) { return p.play(at, count); },
        // Notes that are not the tune, while the structure keeps time.
        improvise(count) {
            for (let k = 0; k < count; k++) {
                notes.push('ABCDEFGHIJ'[random() % 10]);
                truth.push(at + k + 1);
            }
            at += count;
            return p;
        },
        // The window ending at second `t`, as the service publishes it.
        windowAt(t, windowSeconds = 10) {
            const end = Math.min(notes.length, Math.floor(t * pace));
            const start = Math.max(0, Math.floor((t - windowSeconds) * pace));
            return {
                position: { contour: notes.slice(start, end).join(''), readAt: t * 1000, windowSeconds },
                truth: truth[end - 1],
            };
        },
        get seconds() { return notes.length / pace; },
    };
    return p;
}

// Feed every window from `from` to `to` seconds, `step` apart, through the
// tracker; returns the final state and each window's error in quavers.
function follow(perf, stored, { from = 10, to = perf.seconds, step = 3, state = null, lineOf = null } = {}) {
    const errors = [];
    const reasons = [];
    for (let t = from; t <= to + 1e-9; t += step) {
        const { position, truth } = perf.windowAt(t);
        state = trackPosition(state, position, { storedContour: stored, lineOf });
        reasons.push(state.reason);
        const point = followPoint(state, t * 1000, stored.length);
        if (point) {
            const at = point.fraction * stored.length;
            const want = ((truth % stored.length) + stored.length) % stored.length;
            errors.push(Math.min(Math.abs(at - want), stored.length - Math.abs(at - want)));
        } else {
            errors.push(null);
        }
    }
    return { state, errors, reasons };
}

console.log('scorePosition');

test('matchSpans reports the alignment that produces the match score', () => {
    // The span is only worth trusting if it is the alignment that scored the
    // tune — not a different one that happens to be nearby.
    for (let i = 0; i < 300; i++) {
        const q = contour(1 + (i % 40), i + 7, 'stuvwx');
        const s = contour(q.length + (i * 7) % 200, i + 1000, 'stuvwx');
        const spans = matchSpans(q, s, 3);
        const best = spans.length ? spans[0].score : 0;
        assert.ok(Math.abs(best - needlemanWunsch(q, s)) < 1e-9, `q=${q} s=${s}`);
    }
});

test('matchSpans finds a slice exactly where it was cut', () => {
    const stored = contour(400, 42);
    for (const [start, len] of [[0, 20], [37, 33], [200, 50], [350, 50]]) {
        const spans = matchSpans(stored.slice(start, start + len), stored, 1);
        assert.equal(spans[0].start, start);
        assert.equal(spans[0].end, start + len);
        assert.equal(spans[0].score, 1);
    }
});

test('a repeated part is reported at both places, earliest first, and spans never overlap', () => {
    const a = 'stuvwxwvutsrstuvwxyx';
    const b = 'xyzyxwvwxyzyxwvutsrq';
    const spans = matchSpans(a, a + a + b + b, 4);
    assert.equal(spans[0].start, 0);
    assert.equal(spans[1].start, a.length);
    assert.equal(spans[0].score, spans[1].score);
    for (let i = 0; i < spans.length; i++) {
        for (const other of spans.slice(i + 1)) {
            assert.ok(spans[i].end <= other.start || other.end <= spans[i].start);
            assert.ok(spans[i].score >= other.score);
        }
    }
});

test('no position from a query longer than the tune, or too short to place', () => {
    assert.deepEqual(matchSpans('stuvwxyz', 'stu'), []);
    assert.equal(windowPosition('s'.repeat(MIN_QUERY_LENGTH - 1), { readAt: 0, windowSeconds: 10 }), null);
    assert.deepEqual(windowPosition('s'.repeat(MIN_QUERY_LENGTH), { readAt: 5, windowSeconds: 10 }),
        { contour: 's'.repeat(MIN_QUERY_LENGTH), readAt: 5, windowSeconds: 10 });
});

test('a fit alignment ends on the window\'s last note, even a wrong one', () => {
    // The match score's alignment may drop badly fitting last notes, which
    // reports where the music was a few notes ago. For a position the end of
    // the window is the point.
    const stored = contour(200, 21);
    const query = stored.slice(40, 67) + 'ABC';
    assert.ok(matchSpans(query, stored, 1)[0].end < 70);
    assert.equal(matchSpans(query, stored, 1, { fit: true })[0].end, 70);
});

test('a window across the end of one time through and the start of the next is placed', () => {
    const stored = contour(200, 22);
    const query = stored.slice(190) + stored.slice(0, 15);
    const [best] = positionCandidates(query, stored);
    assert.equal(best.end, 15);
    assert.equal(best.covered, 25);
    assert.equal(best.score, 1);
});

test('lineAtFraction follows the played-out order, repeats included', () => {
    const t = aabbTimeline();
    assert.equal(lineAtFraction(t, 0), 0);
    assert.equal(lineAtFraction(t, 0.2), 1);   // 3.2 s: first A, second line
    assert.equal(lineAtFraction(t, 0.3), 0);   // 4.8 s: the A repeat, back on line 0
    assert.equal(lineAtFraction(t, 0.55), 2);  // 8.8 s: B
    assert.equal(lineAtFraction(t, 1), 3);
    assert.equal(lineAtFraction(null, 0.5), null);
    assert.equal(lineAtFraction({ events: [], totalMs: 0 }, 0.5), null);
});

test('a steady performance is followed to within a couple of quavers, round the top included', () => {
    const stored = contour(240, 31);
    const perf = performance(stored, 6).play(0, 240 * 3);
    const { errors, state, reasons } = follow(perf, stored);
    assert.ok(errors.every(e => e !== null && e <= 2), `errors ${errors}`);
    assert.ok(reasons.every(r => r === 'ok'), `reasons ${reasons}`);
    assert.equal(state.epoch, 0, 'never needed to re-align');
    // Three times through: the projection is on its third lap.
    assert.equal(followPoint(state, (perf.seconds - 1) * 1000, 240).lap, 2);
});

test('the A part and its repeat (same written line) lock at once', () => {
    // An AABB tune of 160 quavers: A = 0..40, repeated 40..80; B 80..160.
    const A = contour(40, 3);
    const B = contour(40, 4);
    const stored = A + A + B + B;
    const timeline = aabbTimeline();
    const lineOf = (end) => lineAtFraction(timeline, end / stored.length);
    // A phrase from A ends at 25/160 and again at 65/160: both line 1.
    const s = trackPosition(null, POS(A.slice(5, 25)), { storedContour: stored, lineOf });
    assert.equal(s.reason, 'ok');
    assert.equal(lineAtFraction(timeline, followPoint(s, 1000, 160).fraction), 1);
});

test('which of two repeats it is gets sorted out when the parts diverge', () => {
    const A = contour(40, 3);
    const B = contour(40, 4);
    const stored = A + A + B + B;
    const timeline = aabbTimeline();
    const lineOf = (end) => lineAtFraction(timeline, end / stored.length);
    // Start in the SECOND A: the first window cannot tell the two apart.
    const perf = performance(stored, 4).play(45, 300);
    const { errors } = follow(perf, stored, { from: 5, step: 2.5, lineOf });
    // Once B arrives (≈9 s in) it must be right, and stay right.
    const late = errors.slice(5);
    assert.ok(late.every(e => e !== null && e <= 3), `errors ${errors}`);
});

test('a phrase shared by two parts is ambiguous from cold, and settled by the next window', () => {
    const shared = contour(30, 9);
    const stored = shared + contour(90, 10) + shared + contour(90, 11);
    let s = trackPosition(null, POS(shared, 1000), { storedContour: stored });
    assert.equal(s.reason, 'ambiguous');
    assert.equal(s.main, null);
    // The music carries on from the SECOND occurrence.
    const next = stored.slice(120 + 30 - 20, 120 + 30 + 15);
    s = trackPosition(s, POS(next, 6000), { storedContour: stored });
    assert.ok(s.main, s.reason);
    const at = followPoint(s, 6000, stored.length).fraction * stored.length;
    assert.ok(Math.abs(at - 165) <= 2, `at ${at}`);
});

test('while following, a shared phrase does not pull it into the other part', () => {
    const shared = contour(30, 9);
    const stored = shared + contour(90, 10) + shared + contour(90, 11);
    // Play the first part through, shared phrase included.
    const perf = performance(stored, 6).play(0, 240 * 2);
    const { errors, state } = follow(perf, stored);
    assert.ok(errors.every(e => e !== null && e <= 2), `errors ${errors}`);
    assert.equal(state.epoch, 0);
});

test('one stray window elsewhere does not move it; a real jump re-aligns within two', () => {
    const stored = contour(300, 41);
    // Play 40 s from the top, then jump to quaver 200 (someone went to the
    // B part early) and carry on.
    const perf = performance(stored, 6).play(0, 240).play(200, 200);
    const { errors, reasons } = follow(perf, stored, { from: 10, step: 3 });
    // Windows at 43 s and 46 s straddle the jump; by 52 s two windows lie
    // wholly after it and must agree.
    const at52 = (52 - 10) / 3;
    assert.ok(reasons.includes('realigned'), `reasons ${reasons}`);
    assert.ok(errors.slice(at52).every(e => e !== null && e <= 3), `errors ${errors}`);
    // And a single misleading window in the middle of steady playing:
    let state = follow(performance(stored, 6).play(0, 200), stored, { to: 30 }).state;
    const epoch = state.epoch;
    state = trackPosition(state, POS(stored.slice(220, 260), 33000), { storedContour: stored });
    assert.equal(state.epoch, epoch, 'one window is not a jump');
    const at = followPoint(state, 33000, 300).fraction * 300;
    assert.ok(Math.abs(at - 198) <= 3, `stayed with the music, at ${at}`);
});

test('through improvisation it keeps time, and picks the tune up where it comes back', () => {
    const stored = contour(300, 51);
    // 30 s of the tune, 15 s of something else over the same structure,
    // then the tune again where it would have been.
    const perf = performance(stored, 6).play(0, 180).improvise(90).cont(240);
    const { errors, reasons, state } = follow(perf, stored, { step: 3 });
    assert.ok(reasons.includes('coasting'), `reasons ${reasons}`);
    assert.equal(state.epoch, 0, 'came back on the place it was keeping');
    const back = Math.ceil((45 + 10 - 10) / 3) + 1;
    assert.ok(errors.slice(back).every(e => e !== null && e <= 3), `errors ${errors}`);
});

test('if the tune comes back somewhere else after improvising, it re-aligns', () => {
    const stored = contour(300, 61);
    const perf = performance(stored, 6).play(0, 180).improvise(90).play(30, 240);
    const { errors, reasons } = follow(perf, stored, { step: 3 });
    assert.ok(reasons.includes('realigned'), `reasons ${reasons}`);
    assert.ok(errors.slice(-6).every(e => e !== null && e <= 3), `errors ${errors}`);
});

test('a damaged window is believed where the music is expected, not out of nowhere', () => {
    const stored = contour(300, 81);
    const { state } = follow(performance(stored, 6).play(0, 180), stored, { to: 30 });
    // The next 10 s, every fourth note wrong: a match score of about 0.5.
    const damaged = stored.slice(138, 198).split('').map((c, i) => (i % 4 === 3 ? 'A' : c)).join('');
    const tracked = trackPosition(state, POS(damaged, 33000), { storedContour: stored });
    assert.equal(tracked.reason, 'ok');
    assert.ok(tracked.score < 0.6, `score ${tracked.score}`);
    assert.equal(trackPosition(null, POS(damaged, 33000), { storedContour: stored }).reason, 'weak');
});

test('wrong last notes in a window do not put the position behind the music', () => {
    const stored = contour(200, 23);
    const [best] = positionCandidates(stored.slice(40, 67) + 'ABC', stored);
    assert.equal(best.end, 70);
    // And they count against the match: 27 right (+54), 3 extra (-3), of 30.
    assert.ok(Math.abs(best.score - 51 / 60) < 1e-9, `score ${best.score}`);
});

test('once the place is lost, one clear window anywhere re-locks', () => {
    const stored = contour(300, 91);
    let { state } = follow(performance(stored, 6).play(0, 180), stored, { to: 30 });
    state = trackPosition(state, POS(contour(60, 5, 'ABCDEF'), 33000), { storedContour: stored });
    state = trackPosition(state, POS(contour(60, 6, 'ABCDEF'), 36000), { storedContour: stored });
    assert.equal(state.reason, 'weak');
    state = trackPosition(state, POS(stored.slice(20, 80), 39000), { storedContour: stored });
    assert.equal(state.reason, 'realigned');
    const at = followPoint(state, 39000, 300).fraction * 300;
    assert.ok(Math.abs(at - 80) <= 2, `at ${at}`);
});

test('the projection holds once nothing has confirmed it for a while', () => {
    const stored = contour(300, 71);
    const { state } = follow(performance(stored, 6).play(0, 120), stored, { to: 20 });
    const soon = followPoint(state, 25000, 300);
    const late = followPoint(state, (20 + COAST_SECONDS + 30) * 1000, 300);
    const later = followPoint(state, (20 + COAST_SECONDS + 60) * 1000, 300);
    assert.equal(soon.held, false);
    assert.equal(late.held, true);
    assert.equal(late.fraction, later.fraction, 'held means not moving');
});

test('audio that does not match, or no contour, places nothing', () => {
    const stored = contour(160, 1);
    const s = trackPosition(null, POS(contour(30, 77, 'ABCDEF')), { storedContour: stored });
    assert.equal(s.reason, 'weak');
    assert.equal(followPoint(s, 1000, 160), null);
    assert.equal(trackPosition(null, POS(stored.slice(20, 50)), { storedContour: '' }).main, null);
    assert.equal(trackPosition(null, null, { storedContour: stored }).main, null);
    // The same window twice is folded in once.
    const a = trackPosition(null, POS(stored.slice(20, 50), 5000), { storedContour: stored });
    assert.equal(trackPosition(a, POS(stored.slice(20, 50), 5000), { storedContour: stored }), a);
});

test('forward moves at once; backward only once two windows agree', () => {
    let s = nextFollowLine(null, 2, 'w1');
    assert.equal(s.line, 2);
    s = nextFollowLine(s, 3, 'w2');
    assert.equal(s.line, 3);
    // One window says line 0: held.
    s = nextFollowLine(s, 0, 'w3');
    assert.equal(s.line, 3);
    // Re-deciding from the SAME window (the per-second projection) is not a
    // second opinion.
    s = nextFollowLine(s, 0, 'w3');
    assert.equal(s.line, 3);
    // A second window agrees: the tune has come round to the top.
    s = nextFollowLine(s, 0, 'w4');
    assert.equal(s.line, 0);
});

test('a backward blip is forgotten when the next window disagrees with it', () => {
    let s = nextFollowLine(null, 3, 'w1');
    s = nextFollowLine(s, 0, 'w2');
    s = nextFollowLine(s, 1, 'w3');   // a different backward line: starts over
    assert.equal(s.line, 3);
    s = nextFollowLine(s, 3, 'w4');
    assert.equal(s.line, 3);
    assert.equal(s.pendingLine, null);
    s = nextFollowLine(s, 0, 'w5');
    assert.equal(s.line, 3, 'one window is never enough');
});

test('a forced move goes back at once', () => {
    let s = nextFollowLine(null, 3, 'w1');
    s = nextFollowLine(s, 0, 'w2', { force: true });
    assert.equal(s.line, 0);
});

test('no answer leaves the line where it was', () => {
    const s = nextFollowLine(nextFollowLine(null, 2, 'w1'), null, 'w2');
    assert.equal(s.line, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
