// The one-line score previews in lists (src/js/abcPreview.mjs).
//
// Run with:  node app/test/abcPreview.test.mjs

import assert from 'node:assert/strict';
import { previewAbc, meterLabel } from '../src/js/abcPreview.mjs';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('\nlist previews');

const musicOf = abc => abc.split('\n').filter(l => !/^[A-Za-z]:/.test(l));

test('the opening bars are ONE line, whatever line breaks the tune has', () => {
    // A break in ABC starts a new staff: this drew two staves.
    const setting = { mode: 'Gmajor', meter: 'C|', abc: '(3Bcb AcB GEF|\nG2 BG dGBG|\\\nA2 cA eAcA|BAGF GABc|\nd2 Bd gdBd|e2 ce gece|' };
    const music = musicOf(previewAbc(setting, 4));
    assert.equal(music.length, 1, music.join(' / '));
    assert.ok(!music[0].includes('\\'), 'line continuation removed');
    assert.equal((music[0].match(/\|/g) || []).length, 5, 'four bars plus one');
});

test('a field between music lines becomes inline, or goes', () => {
    const setting = { mode: 'Dmajor', meter: '4/4', abc: 'A2FA DAFA|\nK:G\nB2GB DGBG|\nw: la la\nc2 c2|' };
    const music = musicOf(previewAbc(setting, 4));
    assert.equal(music.length, 1);
    assert.ok(music[0].includes('[K:G]'));
    assert.ok(!music[0].includes('la la'));
});

test('C and C| read as time signatures', () => {
    assert.equal(meterLabel('C|'), '2/2');
    assert.equal(meterLabel('C'), '4/4');
    assert.equal(meterLabel('6/8'), '6/8');
});

console.log(`\n${passed} passed`);
