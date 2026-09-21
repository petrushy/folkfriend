// The detection LED (src/js/detectionFreshness.mjs).
//
// Run with:  node app/test/detectionFreshness.test.mjs
//
// The property worth pinning is not "it returns a colour" — it is WHICH of the
// two inputs is allowed to make it red. Age must, because that is the question
// the user asked for ("when chitchatting for a while it should go red, the
// tune is likely ended"); the score must not, because scores are not
// comparable across transcribers and a score-driven red would be permanently
// on under the ML one while meaning nothing about the room.
//
// The other half is that the red is a claim about the ROOM, so a session that
// is not listening at all must not make it.

import assert from 'node:assert/strict';

import {
    detectionFreshness,
    freshnessLimits,
    GOOD_SCORE,
} from '../src/js/detectionFreshness.mjs';

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

const OPTIONS = { windowSeconds: 10, stepSeconds: 5 };
const { freshSeconds, staleSeconds } = freshnessLimits(OPTIONS);

// A listening session whose last accepted match was `age` seconds ago.
function afterSilence(age, score = 0.8, extra = {}) {
    return detectionFreshness({
        listening: true,
        elapsedSeconds: 1000,
        lastMatchSeconds: 1000 - age,
        lastMatchScore: score,
        options: OPTIONS,
        ...extra,
    });
}

console.log('\nthe LED ages with the clock');

test('a confident match seconds ago is green', () => {
    assert.equal(afterSilence(3).level, 'green');
});

test('a gap of a couple of cycles is still green', () => {
    // One missed window is ordinary: a bar of unison, someone ordering a
    // drink over the melody. Going amber there would make the light flicker
    // through a set that is going perfectly well, and a light that flickers
    // for no reason is one nobody reads.
    assert.equal(afterSilence(freshSeconds).level, 'green');
});

test('a longer gap goes amber', () => {
    assert.equal(afterSilence(freshSeconds + 1).level, 'amber');
    assert.equal(afterSilence(staleSeconds).level, 'amber');
});

test('chitchat goes red — the whole point of the indicator', () => {
    const led = afterSilence(staleSeconds + 1);
    assert.equal(led.level, 'red');
    assert.equal(afterSilence(20 * 60).level, 'red');
    void led;
});

test('the detail says how long ago, in units a person reads', () => {
    assert.match(afterSilence(8).detail, /8s ago/);
    assert.match(afterSilence(180).detail, /3 min ago/);
    assert.match(afterSilence(3 * 3600 + 120).detail, /3 h 2 min ago/);
});

console.log('\nthe score can hold the light back, but never turn it red');

test('a weak but recent match is amber, not green', () => {
    const led = afterSilence(2, GOOD_SCORE - 0.05);
    assert.equal(led.level, 'amber');
    // And it says WHICH of the two it is, so the user is not left listening
    // for a gap in the playing that is not there.
    assert.equal(led.label, 'Weak match');
});

test('a very weak match is still only amber, however bad the score', () => {
    // ML-transcribed scores run systematically lower than DSP ones. A
    // score-driven red would be permanently on for those users while saying
    // nothing at all about whether the tune is still being played.
    assert.equal(afterSilence(2, 0.01).level, 'amber');
});

test('an old match is red even when the score was excellent', () => {
    assert.equal(afterSilence(staleSeconds + 1, 0.99).level, 'red');
});

console.log('\nred is a claim about the room, so only the room may make it');

test('a paused session shows the light off, never red', () => {
    const led = detectionFreshness({
        listening: false,
        elapsedSeconds: 1000,
        lastMatchSeconds: 0,
        lastMatchScore: 0.9,
        options: OPTIONS,
    });
    assert.equal(led.level, 'off');
});

test('a dead microphone is red — the app certainly is not following anything', () => {
    const led = afterSilence(1, 0.99, { micHealthy: false });
    assert.equal(led.level, 'red');
    assert.equal(led.label, 'No audio');
});

test('listening with nothing recognised yet is idle, not red', () => {
    // A session that has just started has not failed at anything.
    const led = detectionFreshness({
        listening: true, elapsedSeconds: 4, lastMatchSeconds: null, options: OPTIONS,
    });
    assert.equal(led.level, 'idle');
    assert.equal(led.ageSeconds, null);
});

console.log('\nthe thresholds follow the analysis window');

test('a longer window stretches both thresholds', () => {
    const long = freshnessLimits({ windowSeconds: 30, stepSeconds: 15 });
    assert.ok(long.freshSeconds > freshSeconds);
    assert.ok(long.staleSeconds > staleSeconds);
    // A 25 s gap is amber at the live defaults and green at a 30 s window,
    // because at that window one missed cycle IS 45 s.
    assert.equal(afterSilence(25).level, 'amber');
    assert.equal(detectionFreshness({
        listening: true,
        elapsedSeconds: 1000,
        lastMatchSeconds: 975,
        lastMatchScore: 0.8,
        options: { windowSeconds: 30, stepSeconds: 15 },
    }).level, 'green');
});

test('missing options fall back to the live defaults rather than throwing', () => {
    assert.deepEqual(freshnessLimits(null), freshnessLimits(OPTIONS));
});

test('a match stamped in the future reads as age zero, not as a negative', () => {
    // A restored session brings its window matches back alongside a clock that
    // is restored separately; the two can be a tick apart.
    const led = detectionFreshness({
        listening: true, elapsedSeconds: 10, lastMatchSeconds: 12,
        lastMatchScore: 0.9, options: OPTIONS,
    });
    assert.equal(led.ageSeconds, 0);
    assert.equal(led.level, 'green');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
