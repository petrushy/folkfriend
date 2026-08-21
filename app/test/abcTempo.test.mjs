// The tempo the app hands ABCJS for playback.
//
// ABCJS's default tempo is counted in the METER'S OWN beat unit, so identical
// notes play at different speeds depending only on how the meter is written.
// A reel written M:C| played at exactly double the speed of the same reel
// written M:4/4 — which is why Norbeck tunes (1,487 of them in cut time)
// sounded frantic while the same tune from thesession sounded right.
//
// The component's abcText is lifted straight out of the SFC and exercised
// against the real ABCJS parser, so this measures what the app actually
// builds rather than a restatement of it. Same trick as
// tuneBackgroundDialog.test.mjs.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import abcjs from 'abcjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sfc = await readFile(
    path.join(here, '..', 'src', 'components', 'AbcDisplay.vue'), 'utf8');

const match = sfc.match(/abcText: function \(\) \{([\s\S]*?)\n {8}\},/);
assert.ok(match, 'could not find abcText in AbcDisplay.vue');
const abcText = new Function(`return function(){${match[1]}}`)();

const build = (meter, abc = 'BEBE cAcA |') =>
    abcText.call({ mode: 'Gmajor', meter, abc });
const msPerBar = (meter, abc) =>
    Math.round(abcjs.parseOnly(build(meter, abc))[0].millisecondsPerMeasure());

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}\n      ${e.message}`);
    }
}

console.log('\nabcTempo');

test('cut time plays at the same speed as 4/4', () => {
    // THE bug: same notes, same note length, double the speed.
    assert.equal(msPerBar('C|'), msPerBar('4/4'));
    assert.equal(msPerBar('2/2'), msPerBar('4/4'));
});

test('a quarter-note pulse is always named', () => {
    // Leaving it to ABCJS is what let the meter decide the speed.
    for (const meter of ['C|', '4/4', '6/8', '3/4', '9/8']) {
        assert.match(build(meter), /^Q:1\/4=\d+$/m, meter);
    }
});

test('meters that already sounded right are untouched', () => {
    // Pinned so a future tempo change cannot quietly alter thesession.
    for (const [meter, expected] of [
        ['4/4', 1333], ['C', 1333], ['6/8', 1000],
        ['9/8', 1500], ['12/8', 2000], ['3/4', 1000],
    ]) {
        assert.equal(msPerBar(meter), expected, meter);
    }
});

test('polkas keep their slower pulse', () => {
    // 2/4 at the default pulse is too fast; this predates the cut-time fix.
    assert.match(build('2/4'), /Q:1\/4=120/);
    assert.equal(msPerBar('2/4'), 1000);
});

test("a tune's own tempo always wins", () => {
    const out = build('C|', 'Q:1/4=90\nBEBE cAcA |');
    assert.equal((out.match(/^Q:/gm) || []).length, 1,
        'must not add a second tempo alongside the tune\'s own');
    assert.match(out, /Q:1\/4=90/);
});

test("a tune's own L: always wins", () => {
    // Norbeck and folkwiki bodies can carry their own unit note length.
    const out = build('2/4', 'L:1/16\nBEBEcAcA |');
    assert.equal((out.match(/^L:/gm) || []).length, 1);
    assert.match(out, /L:1\/16/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
