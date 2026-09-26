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

console.log(`favouriteFacets: ${passed} passed`);
