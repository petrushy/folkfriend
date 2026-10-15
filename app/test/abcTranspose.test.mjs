// Transposing a score: what is drawn AND what is heard must move together.
//
// abcjs's visualTranspose changes only the notation — the sequencer
// deliberately subtracts it back out so the SOUND stays at the original pitch.
// Playing what is shown therefore needs midiTranspose passed to the synth as
// well; forgetting it gives a score in one key played in another, which is
// exactly the failure this test exists to catch. It runs against the real
// abcjs parser/sequencer and lifts _synthOptions straight out of the SFC.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import abcjs from 'abcjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sfc = await readFile(
    path.join(here, '..', 'src', 'components', 'AbcDisplay.vue'), 'utf8');
const match = sfc.match(/_synthOptions\(onEnded\)\s*\{([\s\S]*?)\n {8}\},/);
assert.ok(match, 'could not find _synthOptions in AbcDisplay.vue');
const synthOptions = new Function('onEnded', match[1]);

const ABC = 'X:1\nM:4/4\nL:1/8\nK:C\nCDEF GABc|\n';

// MIDI pitches the synth would actually be given.
function soundingPitches(transpose) {
    const visual = abcjs.parseOnly(ABC, { visualTranspose: transpose })[0];
    const options = synthOptions.call({ transpose }, () => {});
    const flattened = visual.setUpAudio(options);
    return flattened.tracks[0].filter(e => e.cmd === 'note').map(e => e.pitch);
}

let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`ok   ${name}`); } catch (e) {
        failed++; console.error(`FAIL ${name}\n  ${e.message}`);
    }
}

const base = soundingPitches(0);

test('untransposed plays the written pitches', () => {
    assert.equal(base.length, 8);
    assert.equal(base[0], 60);
});

test('+2 sounds two semitones up', () => {
    assert.deepEqual(soundingPitches(2), base.map(p => p + 2));
});

test('-5 sounds five semitones down', () => {
    assert.deepEqual(soundingPitches(-5), base.map(p => p - 5));
});

test('the extremes of the range are reachable', () => {
    assert.deepEqual(soundingPitches(12), base.map(p => p + 12));
    assert.deepEqual(soundingPitches(-12), base.map(p => p - 12));
});

test('the synth is told the transposition (the half abcjs omits)', () => {
    assert.equal(synthOptions.call({ transpose: 7 }, () => {}).midiTranspose, 7);
    assert.equal(synthOptions.call({ transpose: 0 }, () => {}).midiTranspose, 0);
});

if (failed) process.exit(1);
