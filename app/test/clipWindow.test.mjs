// Unit tests for how much of a recording one playback clip carries.
//
// Run with:  node app/test/clipWindow.test.mjs
//
// Every clip boundary is a reload of the <audio> element, audible as a short
// skip. These pin the three things that may end a clip early — a new track, a
// hole, and the byte budget — and that nothing else does.

import assert from 'node:assert/strict';
import {
    clipWindow, segmentAfter, CLIP_WINDOW_BYTES, CLIP_WINDOW_MAX_SEGMENTS,
} from '../src/js/clipWindow.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`);
    }
}

const MB = 1024 * 1024;
// n three-minute segments of one track, 2 MB each, starting at `from`.
function run(n, { track = 0, from = 0, firstIndex = 0, bytes = 2 * MB } = {}) {
    return Array.from({ length: n }, (_, i) => ({
        index: firstIndex + i, trackIndex: track,
        startSeconds: from + i * 180, durationSeconds: 180, bytes,
    }));
}

console.log('\nclipWindow — how far one clip reaches');

test('joins consecutive segments of one track up to the byte budget', () => {
    const segments = run(20);                      // 40 MB in all
    const w = clipWindow(segments, segments[0]);
    assert.equal(w.count, Math.floor(CLIP_WINDOW_BYTES / (2 * MB)));
    assert.equal(w.fromSeconds, 0);
    assert.equal(w.toSeconds, w.count * 180);
});

test('never crosses into another track', () => {
    // Two MediaRecorder runs each carry their own header and cannot be joined.
    const segments = [...run(2), ...run(2, { track: 1, from: 400, firstIndex: 2 })];
    assert.deepEqual(clipWindow(segments, segments[0]), { fromSeconds: 0, toSeconds: 360, count: 2 });
});

test('never spans a hole', () => {
    const segments = [...run(2), ...run(2, { from: 540, firstIndex: 3 })];
    assert.equal(clipWindow(segments, segments[0]).toSeconds, 360);
});

test('segment ends that meet within a fraction of a second still join', () => {
    const segments = run(3);
    segments[1].startSeconds += 0.1;
    assert.equal(clipWindow(segments, segments[0]).count, 3);
});

test('an oversized first segment is still one clip, never none', () => {
    const segments = run(3, { bytes: CLIP_WINDOW_BYTES + 1 });
    assert.deepEqual(clipWindow(segments, segments[1]), { fromSeconds: 180, toSeconds: 360, count: 1 });
});

test('unknown sizes are bounded by a segment count, not unbounded', () => {
    // An older manifest without byte counts must not make the whole evening
    // one clip in memory.
    const segments = run(50, { bytes: null });
    assert.equal(clipWindow(segments, segments[0]).count, CLIP_WINDOW_MAX_SEGMENTS);
});

test('starts from the segment asked for, whatever order the manifest lists them in', () => {
    const segments = run(4).reverse();
    assert.deepEqual(clipWindow(segments, segments[1]), { fromSeconds: 360, toSeconds: 720, count: 2 });
});

console.log('\nsegmentAfter — what follows a clip');

test('is the first segment at or after the clip\'s end, not the next index', () => {
    // A clip spanning segments 0–2 is followed by 3, not 1.
    const segments = run(5);
    assert.equal(segmentAfter(segments, 0, 540).index, 3);
});

test('is null at the end of what is recorded', () => {
    assert.equal(segmentAfter(run(2), 0, 360), null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
