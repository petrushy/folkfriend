// The loudness rules behind the session player's volume slider and Normalize.
// Pure, so tested directly; the wiring is in sessionAudioPlayer.test.mjs.
import assert from 'node:assert/strict';
import {
    VOLUME_MAX, NORMALIZE_TARGET_RMS, NORMALIZE_MAX_GAIN, NORMALIZE_MIN_GAIN, LEVEL_GATE_RMS,
    LEVEL_ATTACK_SECONDS, LEVEL_RELEASE_SECONDS,
    clampVolume, rmsOf, nextLevel, normalizeGainFor, levelStageGain,
} from '../src/js/playbackLevel.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.stack}`); }
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

console.log('\nplaybackLevel');

test('volume is clamped, stepped and free of float noise', () => {
    assert.equal(clampVolume(3), VOLUME_MAX);
    assert.equal(clampVolume(-0.5), 0);
    assert.equal(clampVolume(1.15), 1.15);
    assert.equal(clampVolume(1.17), 1.15);
    assert.equal(clampVolume('x'), null);
});

test('rms of a constant is the constant; of nothing, zero', () => {
    near(rmsOf([0.5, -0.5, 0.5, -0.5]), 0.5);
    assert.equal(rmsOf([]), 0);
});

test('the first reading above the gate IS the level', () => {
    assert.equal(nextLevel(null, 0.03, 0.1), 0.03);
});

test('below the gate nothing changes — silence must not wind the gain up', () => {
    assert.equal(nextLevel(0.05, LEVEL_GATE_RMS / 2, 10), 0.05);
    assert.equal(nextLevel(null, 0, 0.1), null);
});

test('a louder passage is followed fast, a quieter one slowly', () => {
    const up = nextLevel(0.01, 0.1, LEVEL_ATTACK_SECONDS);
    near(up, 0.01 + 0.09 * (1 - Math.exp(-1)));
    const down = nextLevel(0.1, 0.01, LEVEL_ATTACK_SECONDS);
    assert.ok(down > 0.099, `one attack-time of quiet barely moves it (${down})`);
    const later = nextLevel(0.1, 0.01, LEVEL_RELEASE_SECONDS);
    near(later, 0.1 - 0.09 * (1 - Math.exp(-1)));
});

test('the normalize gain aims for the target and stays within its bounds', () => {
    assert.equal(normalizeGainFor(null), 1, 'no guess before anything is heard');
    near(normalizeGainFor(NORMALIZE_TARGET_RMS / 4), 4);
    assert.equal(normalizeGainFor(1e-4), NORMALIZE_MAX_GAIN);
    assert.equal(normalizeGainFor(0.9), NORMALIZE_MIN_GAIN);
});

test('the level stage is volume, times the normalize gain only when on', () => {
    assert.equal(levelStageGain({ volume: 1.5 }), 1.5);
    assert.equal(levelStageGain({ volume: 1.5, normalize: false, level: 0.01 }), 1.5);
    near(levelStageGain({ volume: 1.5, normalize: true, level: 0.025 }), 6);
    assert.equal(levelStageGain({ volume: 0, normalize: true, level: 0.01 }), 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
