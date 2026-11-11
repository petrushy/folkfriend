// The pure rules behind the follow view's auto-centre: turning a window's
// match spans into a staff line, and holding still when that is unclear.
// The view's use of them is covered in liveScoreFollowComponent.test.mjs.
//
// Run with:  node app/test/scorePosition.test.mjs

import assert from 'node:assert/strict';
import {
    windowPositions, spanFraction, lineAtFraction, decideLine, nextFollowLine,
    POSITION_MIN_SCORE, MAX_EXTRAPOLATE_SECONDS,
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

function position(spans, { readAt = 1000, windowSeconds = 10, settingId = '10', contourLength = 160 } = {}) {
    return { readAt, windowSeconds, byTune: { 7: { settingId, contourLength, spans } } };
}

console.log('scorePosition');

test('windowPositions keeps the best setting per tune and skips results without spans', () => {
    const p = windowPositions([
        { setting_id: 10, setting: { tune_id: 7, contour: 'x'.repeat(160) }, match_spans: [{ start: 1, end: 5, score: 0.8 }] },
        { setting_id: 11, setting: { tune_id: 7, contour: 'x'.repeat(90) }, match_spans: [{ start: 1, end: 5, score: 0.7 }] },
        { setting_id: 20, setting: { tune_id: 8, contour: 'xx' }, match_spans: [] },
        { setting_id: 30, setting: { tune_id: 9, contour: 'xx' } },
    ], { readAt: 5, windowSeconds: 10 });
    assert.deepEqual(Object.keys(p.byTune), ['7']);
    assert.equal(p.byTune[7].settingId, '10');
    assert.equal(p.byTune[7].contourLength, 160);
    assert.equal(p.readAt, 5);
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

test('two tied spans on the SAME written line (an A part and its repeat) give that line', () => {
    // Ends at 20/160 of the way through (2 s: line 1 of the first A) and at
    // 60/160 (6 s: line 1 again, in the repeat).
    const p = position([{ start: 0, end: 20, score: 0.9 }, { start: 40, end: 60, score: 0.9 }]);
    const d = decideLine(p, { tuneId: 7, settingId: 10, nowMs: 1000, timeline: aabbTimeline() });
    assert.equal(d.reason, 'ok');
    assert.equal(d.line, 1);
});

test('tied spans on DIFFERENT lines (A and B share a phrase) hold rather than guess', () => {
    const p = position([{ start: 0, end: 20, score: 0.9 }, { start: 80, end: 100, score: 0.88 }]);
    const d = decideLine(p, { tuneId: 7, settingId: 10, nowMs: 1000, timeline: aabbTimeline() });
    assert.equal(d.reason, 'ambiguous');
    assert.equal(d.line, null);
});

test('a clearly weaker runner-up does not make it ambiguous', () => {
    const p = position([{ start: 0, end: 20, score: 0.9 }, { start: 80, end: 100, score: 0.7 }]);
    const d = decideLine(p, { tuneId: 7, settingId: 10, nowMs: 1000, timeline: aabbTimeline() });
    assert.equal(d.reason, 'ok');
    assert.equal(d.line, 1);
});

test('no position for a weak match, another setting, another tune or a stale window', () => {
    const t = aabbTimeline();
    const weak = position([{ start: 0, end: 20, score: POSITION_MIN_SCORE - 0.01 }]);
    assert.equal(decideLine(weak, { tuneId: 7, settingId: 10, nowMs: 1000, timeline: t }).reason, 'weak');
    const good = position([{ start: 0, end: 20, score: 0.9 }]);
    assert.equal(decideLine(good, { tuneId: 7, settingId: 11, nowMs: 1000, timeline: t }).reason, 'other-setting');
    assert.equal(decideLine(good, { tuneId: 8, settingId: 10, nowMs: 1000, timeline: t }).reason, 'none');
    assert.equal(decideLine(null, { tuneId: 7, settingId: 10, nowMs: 1000, timeline: t }).reason, 'none');
    const late = 1000 + (MAX_EXTRAPOLATE_SECONDS + 10 + 1) * 1000;
    assert.equal(decideLine(good, { tuneId: 7, settingId: 10, nowMs: late, timeline: t }).reason, 'stale');
    assert.equal(decideLine(good, { tuneId: 7, settingId: 10, nowMs: 1000, timeline: null }).reason, 'no-timeline');
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
