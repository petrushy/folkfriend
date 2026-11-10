// "Played in sets with…" ordering (src/js/setPartners.mjs).
//
// The rule asked for: starred tunes come first, but ONLY when they are
// commonly played with the tune in focus. A favourite that turned up together
// once must not push the tunes people actually play next off the top.

import assert from 'node:assert/strict';

import {
    COMMON_MIN,
    commonThreshold,
    describeCounts,
    partnerDirection,
    rankSetPartners,
} from '../src/js/setPartners.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}\n      ${e.message}`);
    }
}

const p = (tuneID, inSets, onRecordings = 0, followedBy = 0, precededBy = 0) =>
    ({ tuneID, name: `t${tuneID}`, inSets, onRecordings, followedBy, precededBy });

const WHALLEY = [
    p('9196', 106, 2, 13, 73), p('93', 82, 0, 23, 50), p('52', 53, 0, 9, 25),
    p('750', 44, 1), p('48', 38, 3), p('953', 39, 2), p('500', 2), p('600', 1),
];

test('without favourites, the order is how often they are played together', () => {
    const ids = rankSetPartners(WHALLEY).map(x => x.tuneID);
    assert.deepEqual(ids, ['9196', '93', '52', '750', '48', '953', '500', '600']);
});

test('a starred tune that is commonly played goes to the top', () => {
    const ids = rankSetPartners(WHALLEY, new Set(['953'])).map(x => x.tuneID);
    assert.equal(ids[0], '953');
    assert.deepEqual(ids.slice(1, 3), ['9196', '93'], 'the rest keep their order');
});

test('a starred tune that is rarely played together is NOT promoted', () => {
    const ranked = rankSetPartners(WHALLEY, new Set(['600']));
    assert.equal(ranked[0].tuneID, '9196');
    const rare = ranked.find(x => x.tuneID === '600');
    assert.equal(rare.starred, true, 'it is still marked as starred');
    assert.equal(rare.common, false);
});

test('several starred common tunes keep their own order among themselves', () => {
    const ids = rankSetPartners(WHALLEY, new Set(['48', '93'])).map(x => x.tuneID);
    assert.deepEqual(ids.slice(0, 2), ['93', '48']);
});

test('"commonly" is relative to the strongest partner, with a floor', () => {
    assert.equal(commonThreshold(WHALLEY), Math.ceil(108 * 0.15));
    assert.equal(commonThreshold([p('1', 2), p('2', 1)]), COMMON_MIN,
        'a tune with only stray pairs has no common partners');
    assert.equal(rankSetPartners([p('1', 2)])[0].common, false);
});

test('recordings count towards how often', () => {
    const ids = rankSetPartners([p('1', 5, 0), p('2', 2, 4)]).map(x => x.tuneID);
    assert.deepEqual(ids, ['2', '1']);
});

test('ties are broken by tune id, numerically, so the list never shuffles', () => {
    const a = rankSetPartners([p('10', 4), p('9', 4)]).map(x => x.tuneID);
    const b = rankSetPartners([p('9', 4), p('10', 4)]).map(x => x.tuneID);
    assert.deepEqual(a, ['9', '10']);
    assert.deepEqual(b, a);
});

test('direction is claimed only when clear and seen often enough', () => {
    assert.equal(partnerDirection(p('1', 0, 0, 13, 73)), 'before');
    assert.equal(partnerDirection(p('1', 0, 0, 23, 2)), 'after');
    assert.equal(partnerDirection(p('1', 0, 0, 5, 4)), '', 'either order');
    assert.equal(partnerDirection(p('1', 0, 0, 2, 0)), '', 'too few to say');
});

test('bad input is an empty list, not a throw', () => {
    assert.deepEqual(rankSetPartners(undefined), []);
    assert.deepEqual(rankSetPartners(null, null), []);
});

test('counts are described in words', () => {
    assert.equal(describeCounts(p('1', 106, 2)), 'in 106 sets · 2 recordings');
    assert.equal(describeCounts(p('1', 1, 0)), 'in 1 set');
    assert.equal(describeCounts(p('1', 0, 1)), '1 recording');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
