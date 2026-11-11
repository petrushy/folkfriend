// The pure rules behind the follow view's auto-centre: turning a window's
// match spans into a staff line, and holding still when that is unclear.
// The view's use of them is covered in liveScoreFollowComponent.test.mjs.
//
// Run with:  node app/test/scorePosition.test.mjs

import assert from 'node:assert/strict';
import {
    windowPosition, matchSpans, spanFraction, lineAtFraction, decideLine, nextFollowLine,
    MAX_EXTRAPOLATE_SECONDS, MIN_QUERY_LENGTH,
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

test('spanFraction projects forward at the pace the span itself was played', () => {
    const span = { start: 60, end: 80, score: 1 };
    assert.equal(spanFraction(span, 160, 10, 0), 0.5);
    // 20 quavers in 10 s is 2/s: 5 s later the music is 10 quavers on.
    assert.equal(spanFraction(span, 160, 10, 5), 90 / 160);
    // Never further than the cap, and never past the end of the tune.
    assert.equal(spanFraction(span, 160, 10, 100), (80 + 2 * MAX_EXTRAPOLATE_SECONDS) / 160);
    assert.equal(spanFraction({ start: 140, end: 158, score: 1 }, 160, 10, 8), 1);
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

test('the A part and its repeat (same written line) give that line', () => {
    // An AABB tune of 160 quavers: A = 0..40, repeated 40..80; B 80..160.
    const A = contour(40, 3);
    const B = contour(40, 4);
    const stored = A + A + B + B;
    // A phrase from A, which therefore ends at 25/160 (2.5 s) and again at
    // 65/160 (6.5 s): both on written line 1 in aabbTimeline().
    const query = A.slice(5, 25);
    const d = decideLine(POS(query), { storedContour: stored, nowMs: 1000, timeline: aabbTimeline() });
    assert.equal(d.reason, 'ok');
    assert.equal(d.line, 1);
});

test('the same phrase in two different parts holds rather than guesses', () => {
    const shared = contour(20, 9);
    // The phrase ends at 20/160 (line 1) and at 100/160 (10 s: line 2).
    const stored = shared + contour(60, 10) + shared + contour(60, 11);
    const d = decideLine(POS(shared), { storedContour: stored, nowMs: 1000, timeline: aabbTimeline() });
    assert.equal(d.reason, 'ambiguous');
    assert.equal(d.line, null);
});

test('a clearly weaker runner-up does not make it ambiguous', () => {
    const phrase = contour(20, 9);
    const altered = phrase.slice(0, 10) + contour(10, 99);
    const stored = phrase + contour(60, 10) + altered + contour(60, 11);
    const d = decideLine(POS(phrase), { storedContour: stored, nowMs: 1000, timeline: aabbTimeline() });
    assert.equal(d.reason, 'ok');
    assert.equal(d.line, 1);
});

test('no position for audio that does not match, no contour, a stale window or no timeline', () => {
    const t = aabbTimeline();
    const stored = contour(160, 1);
    const unrelated = contour(30, 77, 'ABCDEF');
    const weak = decideLine(POS(unrelated), { storedContour: stored, nowMs: 1000, timeline: t });
    assert.equal(weak.reason, 'weak');
    const good = POS(stored.slice(20, 50));
    assert.equal(decideLine(good, { storedContour: '', nowMs: 1000, timeline: t }).reason, 'no-contour');
    assert.equal(decideLine(null, { storedContour: stored, nowMs: 1000, timeline: t }).reason, 'none');
    const late = 1000 + (MAX_EXTRAPOLATE_SECONDS + 10 + 1) * 1000;
    assert.equal(decideLine(good, { storedContour: stored, nowMs: late, timeline: t }).reason, 'stale');
    assert.equal(decideLine(good, { storedContour: stored, nowMs: 1000, timeline: null }).reason, 'no-timeline');
    assert.equal(decideLine(good, { storedContour: stored, nowMs: 1000, timeline: t }).reason, 'ok');
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

test('no answer leaves the line where it was', () => {
    const s = nextFollowLine(nextFollowLine(null, 2, 'w1'), null, 'w2');
    assert.equal(s.line, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
