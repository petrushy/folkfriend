// When the score view re-flows a tune's lines instead of keeping the source's.
//
// folkwiki Musik/2906 writes sixteen bars on one line; abcjs drew it as one
// staff squeezed across the screen while folkwiki's own renderer wrapped it.
// Wrapping everything would discard the deliberate four- and eight-bar layouts
// nearly every other tune has, so only an overlong line turns it on.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    barsPerLine, longestMusicLine, layoutOptionsFor, WRAP_OPTIONS, MAX_BARS_PER_LINE,
} from '../src/js/abcLayout.mjs';

let passed = 0;
async function test(name, fn) {
    await fn();
    passed++;
    console.log(`  ok ${name}`);
}

// Musik/2906 as published, header and all.
const POLSKA_2906 = `X:1
T:Polska från Dorotea
R:Polska
O:Dorotea, Lappland
M:3/4
L:1/16
N: Efter Johan August Andersson, upptecknad av [[Personer/Sören Johansson]]
Z: Eva Zwahlen 2013-02-18
K:G
|: {D}G3F A2G2 B2A2 |c3B g2d2 B2G2 |  B2AB c3A B2G2 |  FA3 D8 | {D}G3F A2G2 B2A2 |c3B g2d2 B2G2 |  B2AB c3A B2G2 | FD3 G8  :||: B2AB c3A _B2G2 | A3G F2DF G4 | (3_B2A2B2 (3c2B2c2 (3d2B2G2 | (3G2A2G2 (3F2A2F2 D4 | (3B2A2B2 (3c2B2A2 d4 | (3B2A2G2 (3A2G2F2 D4 | (3C2E2G2 (3B,2D2G2 (3A,2D2F2 | G4 G,8 :|`;

// thesession 480: deliberate eight-bar lines with pickups and endings.
const EIGHT_BAR_LINES = `X:1
M:3/4
L:1/8
K:D
|:de|f2 fe dc|d4 FG|A2 G2 E2|A,2 C2 E2|g2 f2 e2|d2 c2 B2|A2 AB AG|F2 G2 A2|
cB|:A2 fe f2|A2 fe f2|A2 fe f2|ag ba fd|A2 ed e2|A2 ed e2|1 A2 ed e2|ab ag fe:|2 ab ag fe|d4||`;

await test('counts bars, not bar lines', () => {
    assert.equal(barsPerLine('|: A2 | B2 | C2 | D2 :|'), 4);
    assert.equal(barsPerLine('A2 | B2 | C2 | D2 |'), 4);
    assert.equal(barsPerLine('A2 | B2 :|: C2 | D2 |]'), 4);
});

await test('ignores bar-like characters in chords, decorations and inline fields', () => {
    assert.equal(barsPerLine('"A|B" A2 !trill|x! B2 [M:3/4] C2 |'), 1);
    assert.equal(barsPerLine('A2 | B2 | % | | | comment'), 2);
});

await test('header lines are not music', () => {
    assert.equal(longestMusicLine('X:1\nT:a | b | c | d | e | f | g | h | i | j | k | l | m | n\nK:D\nA2|B2|'), 2);
});

await test('the one-line folkwiki polska is re-flowed', () => {
    assert.equal(longestMusicLine(POLSKA_2906), 16);
    assert.deepEqual(layoutOptionsFor(POLSKA_2906), WRAP_OPTIONS);
});

await test('deliberate eight-bar lines keep their layout', () => {
    assert.ok(longestMusicLine(EIGHT_BAR_LINES) <= MAX_BARS_PER_LINE);
    assert.deepEqual(layoutOptionsFor(EIGHT_BAR_LINES), {});
});

await test('no ABC at all is left alone', () => {
    assert.deepEqual(layoutOptionsFor(''), {});
    assert.deepEqual(layoutOptionsFor(undefined), {});
});

await test('the wrap options carry the staff width abcjs needs to wrap at all', () => {
    assert.ok(WRAP_OPTIONS.staffwidth > 0);
    assert.ok(WRAP_OPTIONS.wrap.preferredMeasuresPerLine > 0);
});

await test('AbcDisplay passes the layout options to renderAbc', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sfc = await readFile(
        path.join(here, '..', 'src', 'components', 'AbcDisplay.vue'), 'utf8');
    const call = sfc.match(/ABCJS\.renderAbc\(target,[\s\S]*?\}\)\[0\]/);
    assert.ok(call, 'renderAbc call not found');
    assert.match(call[0], /\.\.\.layoutOptionsFor\(this\.abcText\)/);
});

console.log(`abcLayout: ${passed} passed`);
