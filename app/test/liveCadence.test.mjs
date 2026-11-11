// The pure timing rules of the live analysis loop: when the first query runs,
// how the step adapts to the device, and which partial windows count.
// The loop's use of them is covered in liveSessions.test.mjs.
//
// Run with:  node app/test/liveCadence.test.mjs

import assert from 'node:assert/strict';
import {
    firstQueryDelaySeconds, updateLatencyEstimate, effectiveStepSeconds,
    isPartialWindow, partialWindowUsable,
    EARLY_FIRST_QUERY_SECONDS, MIN_ADAPTIVE_STEP_SECONDS,
} from '../src/js/liveCadence.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e && e.message}`); }
}

console.log('liveCadence');

test('the first query waits 5 s at the 10 s default, and never longer than the window', () => {
    // Pinned concretely: the relative form below would hide a change to it.
    assert.equal(EARLY_FIRST_QUERY_SECONDS, 5);
    assert.equal(firstQueryDelaySeconds(10), 5);
    assert.equal(firstQueryDelaySeconds(30), 5);
    assert.equal(firstQueryDelaySeconds(3), 3);
    assert.equal(firstQueryDelaySeconds(0.02), 0.02);
});

test('with no latency estimate the configured step is used unchanged', () => {
    assert.equal(effectiveStepSeconds(5, null), 5);
    assert.equal(effectiveStepSeconds(5, undefined), 5);
    assert.equal(effectiveStepSeconds(5, NaN), 5);
});

test('a fast device steps at twice its analysis time, floored at 2 s', () => {
    assert.equal(MIN_ADAPTIVE_STEP_SECONDS, 2);
    assert.equal(effectiveStepSeconds(5, 1500), 3);
    assert.equal(effectiveStepSeconds(5, 300), 2);
    assert.equal(effectiveStepSeconds(5, 0), 2);
});

test('the step is never longer than configured, however slow the device', () => {
    assert.equal(effectiveStepSeconds(5, 4000), 5);
    assert.equal(effectiveStepSeconds(5, 60000), 5);
});

test('a configured step below the floor is honoured as given', () => {
    assert.equal(effectiveStepSeconds(1, 100), 1);
    assert.equal(effectiveStepSeconds(0.02, 1), 0.02);
});

test('the latency estimate is smoothed, so one slow cycle does not double the step', () => {
    assert.equal(updateLatencyEstimate(null, 1000), 1000);
    const afterSpike = updateLatencyEstimate(1000, 5000);
    assert.ok(afterSpike > 1000 && afterSpike < 2500, `got ${afterSpike}`);
    assert.equal(updateLatencyEstimate(1000, NaN), 1000);
    assert.equal(updateLatencyEstimate(1000, -5), 1000);
});

test('a window is partial only when clearly shorter than configured', () => {
    assert.equal(isPartialWindow(5 * 44100, 44100, 10), true);
    assert.equal(isPartialWindow(10 * 44100 - 1024, 44100, 10), false, 'a chunk short is still full');
    assert.equal(isPartialWindow(10 * 44100, 44100, 10), false);
    assert.equal(isPartialWindow(100, 0, 10), false, 'an unknown rate is not judged');
});

test('a partial window needs a contour of minContourLength notes', () => {
    assert.equal(partialWindowUsable({ contour: 'a'.repeat(12) }, 12), true);
    assert.equal(partialWindowUsable({ contour: 'a'.repeat(11) }, 12), false);
    assert.equal(partialWindowUsable({ results: [] }, 12), false, 'no contour reported is not enough');
    assert.equal(partialWindowUsable(null, 12), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
