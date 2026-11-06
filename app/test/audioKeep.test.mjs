// Unit tests for the "tunes only" rule: which stored audio is a break.
//
// Run with:  node app/test/audioKeep.test.mjs
//
// Every case here is about the asymmetry the rule is built on: keeping three
// minutes of conversation costs a megabyte, deleting a tune's opening costs
// the tune. So the interesting cases are the ones where it must KEEP.

import assert from 'node:assert/strict';
import {
    addRange, noteWindow, settledBefore, prunableSegments,
    KEEP_BEFORE_SECONDS, KEEP_AFTER_SECONDS, ANALYSED_JOIN_SECONDS, SETTLE_SLACK_SECONDS,
} from '../src/js/audioKeep.mjs';
import { recordingParts } from '../src/js/clipWindow.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`);
    }
}

const SEG = 180;
const WINDOW = 10;
const STEP = 5;
const seg = (index, start, duration = SEG, trackIndex = 0) =>
    ({ index, trackIndex, startSeconds: start, durationSeconds: duration, bytes: 1000 });

// Analyses [from, to) every STEP seconds; `music(stamp)` says which windows
// sounded like a tune.
function analyse(state, from, to, music = () => false) {
    for (let stamp = from + WINDOW; stamp <= to; stamp += STEP) {
        state = noteWindow(state, stamp, { music: music(stamp), windowSeconds: WINDOW });
    }
    return state;
}
const prune = (segments, state, analysedTo) => prunableSegments(segments, {
    ...state, settledBeforeSeconds: settledBefore(analysedTo, WINDOW),
});

console.log('\naudioKeep — ranges');

test('touching or overlapping ranges merge; distant ones do not', () => {
    let r = addRange([], 10, 20);
    r = addRange(r, 50, 60);
    r = addRange(r, 18, 30);
    assert.deepEqual(r, [{ from: 10, to: 30 }, { from: 50, to: 60 }]);
    assert.deepEqual(addRange(r, 31, 49, 1), [{ from: 10, to: 60 }]);
});

test('a window sounding like a tune keeps a margin either side of it', () => {
    const s = noteWindow({}, 300, { music: true, windowSeconds: WINDOW });
    assert.deepEqual(s.keepRanges, [{ from: 300 - WINDOW - KEEP_BEFORE_SECONDS, to: 300 + KEEP_AFTER_SECONDS }]);
    assert.deepEqual(s.analysedRanges, [{ from: 290, to: 300 }]);
});

test('ordinary analysis is one continuous analysed range', () => {
    const s = analyse({}, 0, 900);
    assert.equal(s.analysedRanges.length, 1);
    assert.deepEqual(s.analysedRanges[0], { from: 0, to: 900 });
});

console.log('\naudioKeep — what is deleted');

test('a break that was fully analysed and settled is deleted', () => {
    // Tune 0–150, conversation 150–900, tune from 900.
    const segments = [seg(0, 0), seg(1, 180), seg(2, 360), seg(3, 540), seg(4, 720)];
    const state = analyse({}, 0, 1000, t => t < 150 || t > 900);
    assert.deepEqual(prune(segments, state, 1000), [1, 2, 3]);
});

test('the segment before a tune is KEPT as its lead-in', () => {
    // The tune is first matched at 905 s, i.e. it started a little before, and
    // segment 4 (720–900) holds those opening bars.
    const segments = [seg(3, 540), seg(4, 720), seg(5, 900)];
    const state = analyse({}, 540, 1000, t => t >= 905);
    const pruned = prune(segments, state, 1000);
    assert.ok(!pruned.includes(4), 'the lead-in segment survives');
    assert.deepEqual(pruned, [3]);
});

test('a segment is not judged until no later window can reach back into it', () => {
    // Analysed only up to just past the segment's end: a tune recognised in the
    // next few windows would want this segment's tail.
    const segments = [seg(0, 0)];
    const justAfter = 180 + WINDOW;
    const state = analyse({}, 0, justAfter);
    assert.deepEqual(prune(segments, state, justAfter), []);
    const settled = 180 + WINDOW + KEEP_BEFORE_SECONDS + SETTLE_SLACK_SECONDS;
    assert.deepEqual(prune(segments, analyse(state, justAfter - WINDOW, settled), settled), [0]);
});

test('audio that was never analysed is kept, however quiet', () => {
    // The analysis stopped (index loading, backend errors) from 200 to 700.
    const segments = [seg(0, 0), seg(1, 180), seg(2, 360), seg(3, 540), seg(4, 720)];
    let state = analyse({}, 0, 200);
    state = analyse(state, 700, 1100);
    assert.ok(state.analysedRanges.length === 2, 'the gap is longer than ANALYSED_JOIN_SECONDS');
    assert.deepEqual(prune(segments, state, 1100), [0, 4]);
});

test('a short hiccup in the analysis still counts as continuous', () => {
    const segments = [seg(0, 0)];
    let state = analyse({}, 0, 90);
    state = analyse(state, 90 + ANALYSED_JOIN_SECONDS - WINDOW, 400);
    assert.deepEqual(prune(segments, state, 400), [0]);
});

test('the end of a session settles everything that was analysed', () => {
    const segments = [seg(0, 0), seg(1, 180)];
    const state = analyse({}, 0, 360);
    assert.deepEqual(prunableSegments(segments, { ...state, settledBeforeSeconds: Infinity }), [0, 1]);
});

test('nothing analysed means nothing deleted', () => {
    assert.deepEqual(prunableSegments([seg(0, 0)], { settledBeforeSeconds: Infinity }), []);
    assert.equal(settledBefore(null, WINDOW), -Infinity);
});

console.log('\nrecordingParts — exports after a break is removed');

test('an ordinary recording is one part per track', () => {
    const parts = recordingParts({ tracks: [{ index: 0 }, { index: 1 }],
        segments: [seg(0, 0), seg(1, 180), seg(2, 360, 60, 1)] });
    assert.deepEqual(parts.map(p => [p.trackIndex, p.startSeconds, p.endSeconds, p.wholeTrack]),
        [[0, 0, 360, true], [1, 360, 420, true]]);
});

test('a hole inside a track splits it into two parts', () => {
    const parts = recordingParts({ tracks: [{ index: 0 }],
        segments: [seg(0, 0), seg(3, 540), seg(4, 720)] });
    assert.deepEqual(parts.map(p => [p.index, p.firstSegmentIndex, p.startSeconds, p.endSeconds, p.wholeTrack]),
        [[0, 0, 0, 180, false], [1, 3, 540, 900, false]]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
