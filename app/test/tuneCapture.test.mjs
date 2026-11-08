// The "record this tune" rule: when a one-tune recording binds to a tune, and
// when it decides that tune is over. See src/js/tuneCapture.mjs.
//
// Run with:  node app/test/tuneCapture.test.mjs

import assert from 'node:assert/strict';
import {
    beginCapture, captureVerdict, MAX_CAPTURE_SECONDS, CONFIRM_OTHER_TUNE_SECONDS,
} from '../src/js/tuneCapture.mjs';
import { freshnessLimits } from '../src/js/detectionFreshness.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) {
        failed++; console.error(`  ✗ ${name}\n      ${e && e.message}`);
    }
}

const options = { windowSeconds: 10, stepSeconds: 5 };
const { freshSeconds, staleSeconds } = freshnessLimits(options);
const det = (tuneId, startSeconds, endSeconds) => ({ tuneId, startSeconds, endSeconds });

console.log('\nbinding a capture');

test('binds to the tune on screen when it is current', () => {
    const c = beginCapture({ tailTuneId: 7, lastMatchSeconds: 95, elapsedSeconds: 100, options });
    assert.equal(c.tuneId, '7');
    assert.equal(c.startedSeconds, 100);
});

test('a stale tune on screen is NOT adopted — the tap is for the tune just starting', () => {
    const c = beginCapture({ tailTuneId: 7, lastMatchSeconds: 100 - freshSeconds - 1, elapsedSeconds: 100, options });
    assert.equal(c.tuneId, null);
});

test('an unbound capture adopts the first tune heard after the tap', () => {
    const capture = beginCapture({ elapsedSeconds: 100, options });
    assert.deepEqual(captureVerdict({ capture, tail: det(7, 0, 50), lastMatch: { tuneId: 7, startSeconds: 40 }, elapsedSeconds: 105, options }),
        { action: 'keep' }, 'a match from before the tap does not count');
    assert.deepEqual(captureVerdict({ capture, tail: det(8, 110, 120), lastMatch: { tuneId: 8, startSeconds: 110 }, elapsedSeconds: 110, options }),
        { action: 'adopt', tuneId: '8' });
});

test('an unbound capture gives up if nothing is ever recognised', () => {
    const capture = beginCapture({ elapsedSeconds: 100, options });
    assert.equal(captureVerdict({ capture, elapsedSeconds: 100 + 2 * staleSeconds - 1, options }).action, 'keep');
    assert.deepEqual(captureVerdict({ capture, elapsedSeconds: 100 + 2 * staleSeconds, options }),
        { action: 'end', reason: 'not-recognised' });
});

console.log('\nending a capture');

const bound = { tuneId: '7', startedSeconds: 100, sinceSeconds: 100 };

test('keeps going while the tune is still being matched', () => {
    assert.equal(captureVerdict({ capture: bound, tail: det(7, 90, 300), lastCapturedMatchSeconds: 290, elapsedSeconds: 300, options }).action, 'keep');
});

test('one stray window of another tune does not end it', () => {
    const v = captureVerdict({ capture: bound, tail: det(8, 300, 310), lastCapturedMatchSeconds: 295, elapsedSeconds: 300, options });
    assert.equal(v.action, 'keep');
});

test('ends once the next tune has confirmed itself', () => {
    const v = captureVerdict({ capture: bound, tail: det(8, 300, 300 + CONFIRM_OTHER_TUNE_SECONDS), lastCapturedMatchSeconds: 295, elapsedSeconds: 305, options });
    assert.deepEqual(v, { action: 'end', reason: 'next-tune' });
});

test('ends when the LED would go red: nothing matched the tune for the stale limit', () => {
    assert.equal(captureVerdict({ capture: bound, tail: det(7, 90, 210), lastCapturedMatchSeconds: 200, elapsedSeconds: 200 + staleSeconds - 1, options }).action, 'keep');
    assert.deepEqual(captureVerdict({ capture: bound, tail: det(7, 90, 210), lastCapturedMatchSeconds: 200, elapsedSeconds: 200 + staleSeconds, options }),
        { action: 'end', reason: 'tune-ended' });
});

test('never runs past the safety limit, even on a detector stuck on one tune', () => {
    const v = captureVerdict({ capture: bound, tail: det(7, 90, 2000), lastCapturedMatchSeconds: 100 + MAX_CAPTURE_SECONDS, elapsedSeconds: 100 + MAX_CAPTURE_SECONDS, options });
    assert.deepEqual(v, { action: 'end', reason: 'limit' });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
