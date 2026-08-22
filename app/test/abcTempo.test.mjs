// The tempo the app hands ABCJS for playback.
//
// ABCJS's default tempo is counted in the METER'S OWN beat unit, so identical
// notes play at different speeds depending only on how the meter is written.
// A reel written M:C| played at exactly double the speed of the same reel
// written M:4/4 — which is why Norbeck tunes (1,487 of them in cut time)
// sounded frantic while the same tune from thesession sounded right.
//
// The pulse is applied to the SYNTH, never written into the ABC as a Q: line.
// The first version of this fix did inject one, which drew an editorial
// "♩= 180" above every stave and put it in the raw ABC text view — presenting
// a tempo the source never stated as though it came from the tune.
//
// The component's own functions are lifted straight out of the SFC and run
// against the real ABCJS parser, so this measures what the app actually does
// rather than a restatement of it. Same trick as tuneBackgroundDialog.test.mjs.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import abcjs from 'abcjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sfc = await readFile(
    path.join(here, '..', 'src', 'components', 'AbcDisplay.vue'), 'utf8');

function lift(signature) {
    const rx = new RegExp(
        `${signature}\\s*\\{([\\s\\S]*?)\\n {8}\\},`);
    const match = sfc.match(rx);
    assert.ok(match, `could not find ${signature} in AbcDisplay.vue`);
    return new Function(`return function(){${match[1]}}`)();
}

const abcText = lift('abcText: function \\(\\)');
const defaultQpm = lift('defaultQpm: function \\(\\)');
const msPerMeasure = lift('_msPerMeasure\\(\\)');

// A stand-in for the component: the same fields the three functions read.
function vm(meter, abc = 'BEBE cAcA |', tempoPercent = 100) {
    const self = { mode: 'Gmajor', meter, abc, tempoPercent };
    self.abcText = abcText.call(self);
    self.defaultQpm = defaultQpm.call(self);
    self.abcVisual = abcjs.parseOnly(self.abcText)[0];
    return self;
}

const build = (meter, abc) => vm(meter, abc).abcText;
// What the synth is actually given.
const msPerBar = (meter, abc, tempoPercent) => {
    const self = vm(meter, abc, tempoPercent);
    return Math.round(msPerMeasure.call(self));
};
// What ABCJS would have chosen on its own, i.e. the old behaviour.
const abcjsDefault = (meter, abc) =>
    Math.round(vm(meter, abc).abcVisual.millisecondsPerMeasure());

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
    // Guard the guard: confirm ABCJS really would have differed here, so this
    // cannot pass because the meters coincidentally agree.
    assert.notEqual(abcjsDefault('C|'), abcjsDefault('4/4'));
});

test('no tempo marking is written into the ABC', () => {
    // A Q: here is drawn on the stave and shown in the raw ABC text view.
    for (const meter of ['C|', '4/4', '6/8', '3/4', '9/8', '2/4']) {
        assert.doesNotMatch(build(meter), /^Q:/m, meter);
    }
});

test('meters that already sounded right are untouched', () => {
    // Pinned so a future tempo change cannot quietly alter thesession.
    for (const [meter, expected] of [
        ['4/4', 1333], ['C', 1333], ['6/8', 1000],
        ['9/8', 1500], ['12/8', 2000], ['3/4', 1000],
    ]) {
        assert.equal(msPerBar(meter), expected, meter);
        // ...and each is exactly what ABCJS chose before the change.
        assert.equal(abcjsDefault(meter), expected, `${meter} (was)`);
    }
});

test('polkas keep their slower pulse', () => {
    // 2/4 at the default pulse is too fast; this predates the cut-time fix.
    assert.equal(vm('2/4').defaultQpm, 120);
    assert.equal(msPerBar('2/4'), 1000);
});

test("a tune's own tempo always wins", () => {
    // An explicit Q: is the transcriber's instruction, not our default.
    const abc = 'Q:1/4=90\nBEBE cAcA |';
    assert.equal(msPerBar('C|', abc), 2667);
    // 4 quarters at 90 qpm.
    assert.equal(msPerBar('4/4', abc), 2667);
});

test('the tempo slider scales the pulse', () => {
    assert.equal(msPerBar('4/4', undefined, 200), 667);
    assert.equal(msPerBar('4/4', undefined, 50), 2667);
});

test("a tune's own L: always wins", () => {
    // Norbeck and folkwiki bodies can carry their own unit note length.
    const out = build('2/4', 'L:1/16\nBEBEcAcA |');
    assert.equal((out.match(/^L:/gm) || []).length, 1);
    assert.match(out, /L:1\/16/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
