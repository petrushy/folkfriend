// Tune-type and key filters for Favourites (src/js/favouriteFacets.mjs).
//
// The rule worth pinning is the combination: OR within a facet (a setting has
// one type and one key, so AND there filters to nothing on the second chip),
// AND across facets, and an empty selection filters nothing.

import assert from 'node:assert/strict';

import {
    tuneTypeOf,
    tuneKeyOf,
    parseKey,
    keyLabel,
    typeLabel,
    compareKeys,
    typeOptions,
    keyOptions,
    matchesFacets,
    scopedOptions,
    shuffleKey,
} from '../src/js/favouriteFacets.mjs';

const fav = (dance, mode) => ({ result: { settingID: Math.random(), setting: { dance, mode } } });

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        console.error(`FAIL ${name}`);
        throw e;
    }
}

test('reads type and key off the setting, treating blanks as absent', () => {
    assert.equal(tuneTypeOf(fav('reel', 'Dmajor')), 'reel');
    assert.equal(tuneKeyOf(fav('reel', 'Dmajor')), 'Dmajor');
    assert.equal(tuneTypeOf(fav('', 'Dmajor')), null);
    assert.equal(tuneKeyOf({ result: {} }), null);
    assert.equal(tuneTypeOf(null), null);
});

test('parses and labels keys, including accidentals', () => {
    assert.deepEqual(parseKey('F#minor'), { tonic: 'F#', mode: 'minor' });
    assert.deepEqual(parseKey('Bbmajor'), { tonic: 'Bb', mode: 'major' });
    assert.equal(keyLabel('Dmixolydian'), 'D mixolydian');
    assert.equal(keyLabel('Bbmajor'), 'B♭ major');
    assert.equal(keyLabel('F#dorian'), 'F♯ dorian');
    assert.equal(keyLabel('weird'), 'weird');
    assert.equal(typeLabel('slip jig'), 'Slip jig');
});

test('keys sort musically: by letter from C, flats before naturals, major first', () => {
    const sorted = ['Adorian', 'Dminor', 'Cmajor', 'Bbmajor', 'Dmajor', 'Amajor', 'F#minor', 'Fmajor']
        .sort(compareKeys);
    assert.deepEqual(sorted, ['Cmajor', 'Dmajor', 'Dminor', 'Fmajor', 'F#minor', 'Amajor', 'Adorian', 'Bbmajor']);
});

test('options list only values present, with counts; types by count', () => {
    const items = [fav('reel', 'Dmajor'), fav('reel', 'Gmajor'), fav('jig', 'Dmajor'), fav('', '')];
    assert.deepEqual(typeOptions(items), [
        { value: 'reel', label: 'Reel', count: 2 },
        { value: 'jig', label: 'Jig', count: 1 },
    ]);
    assert.deepEqual(keyOptions(items).map(o => [o.value, o.count]), [['Dmajor', 2], ['Gmajor', 1]]);
});

test('empty selections filter nothing, including items with no type or key', () => {
    assert.equal(matchesFacets(fav('', ''), [], []), true);
    assert.equal(matchesFacets(fav('reel', 'Dmajor'), undefined, undefined), true);
});

test('OR within types: reel + jig keeps both', () => {
    assert.equal(matchesFacets(fav('reel', 'Dmajor'), ['reel', 'jig'], []), true);
    assert.equal(matchesFacets(fav('jig', 'Dmajor'), ['reel', 'jig'], []), true);
    assert.equal(matchesFacets(fav('polka', 'Dmajor'), ['reel', 'jig'], []), false);
});

test('OR within keys', () => {
    assert.equal(matchesFacets(fav('reel', 'Gmajor'), [], ['Dmajor', 'Gmajor']), true);
    assert.equal(matchesFacets(fav('reel', 'Adorian'), [], ['Dmajor', 'Gmajor']), false);
});

test('AND across type and key', () => {
    assert.equal(matchesFacets(fav('jig', 'Dmajor'), ['jig'], ['Dmajor']), true);
    assert.equal(matchesFacets(fav('reel', 'Dmajor'), ['jig'], ['Dmajor']), false);
    assert.equal(matchesFacets(fav('jig', 'Gmajor'), ['jig'], ['Dmajor']), false);
});

test('an item with no type is excluded once a type is chosen', () => {
    assert.equal(matchesFacets(fav('', 'Dmajor'), ['reel'], []), false);
});


test('scopedOptions counts the given view and keeps a selected zero-count value', () => {
    const all = [fav('jig', 'Gmajor'), fav('jig', 'Dmajor'), fav('reel', 'Gmajor')];
    const view = [all[0], all[2]];
    const opts = scopedOptions(view, typeOptions, ['jig'], all);
    assert.equal(opts.find(o => o.value === 'jig').count, 1);
    const none = scopedOptions([all[2]], typeOptions, ['jig'], all);
    assert.equal(none.find(o => o.value === 'jig').count, 0);
    assert.equal(scopedOptions([all[2]], typeOptions, [], all).some(o => o.value === 'jig'), false);
});

test('shuffleKey is stable per seed, varies across seeds, stays in [0,1)', () => {
    assert.equal(shuffleKey(42, 7), shuffleKey(42, 7));
    assert.notEqual(shuffleKey(42, 7), shuffleKey(42, 8));
    for (let i = 0; i < 200; i++) { const k = shuffleKey(i, 3); assert.ok(k >= 0 && k < 1); }
    const order = seed => [...Array(20).keys()].sort((a, b) => shuffleKey(a, seed) - shuffleKey(b, seed)).join();
    assert.notEqual(order(1), order(2));
});
console.log(`favouriteFacets: ${passed} passed`);
