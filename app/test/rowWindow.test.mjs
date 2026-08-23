// Progressive rendering budget for the Favourites list (src/js/rowWindow.mjs).
//
// The invariant under test is not "fewer rows render" — it is that windowing
// never LOSES a row and never strands one. Whatever the budget, growing it far
// enough must reproduce the unwindowed list exactly, and `hasMore` must be true
// for exactly as long as something is still held back. A window that quietly
// dropped the last group would look identical on screen to a short list.

import assert from 'node:assert/strict';

import {
    windowRows,
    windowGroups,
    INITIAL_ROW_BUDGET,
    ROW_BUDGET_STEP,
} from '../src/js/rowWindow.mjs';

const rows = n => Array.from({ length: n }, (_, i) => ({ settingID: String(i) }));
const group = (key, n, collapsed = false) => ({ key, rows: rows(n), collapsed });

let passed = 0;
function check(label, fn) {
    fn();
    passed++;
    void label;
}

// ---- flat lists -----------------------------------------------------------

check('a list shorter than the budget is returned untouched', () => {
    const out = windowRows(rows(5), 24);
    assert.equal(out.shown, 5);
    assert.equal(out.total, 5);
    assert.equal(out.hasMore, false);
});

check('a long list is cut to the budget and reports more', () => {
    const out = windowRows(rows(300), 24);
    assert.equal(out.rows.length, 24);
    assert.equal(out.total, 300);
    assert.equal(out.hasMore, true);
});

check('growing the budget eventually yields the whole list, in order', () => {
    const all = rows(100);
    let budget = INITIAL_ROW_BUDGET;
    let out = windowRows(all, budget);
    while (out.hasMore) {
        budget += ROW_BUDGET_STEP;
        out = windowRows(all, budget);
    }
    assert.deepEqual(out.rows.map(r => r.settingID), all.map(r => r.settingID));
});

check('an infinite budget disables windowing entirely', () => {
    const all = rows(300);
    const out = windowRows(all, Infinity);
    assert.equal(out.rows, all, 'must be the same array, not a copy');
    assert.equal(out.hasMore, false);
});

check('an empty list is not "has more"', () => {
    const out = windowRows([], 24);
    assert.equal(out.hasMore, false);
    assert.equal(out.total, 0);
});

// ---- grouped lists --------------------------------------------------------

check('the budget is spent across groups in order', () => {
    const out = windowGroups([group('a', 10), group('b', 10), group('c', 10)], 15);
    assert.equal(out.groups.length, 2, 'the third group is dropped, not shown empty');
    assert.equal(out.groups[0].rows.length, 10);
    assert.equal(out.groups[1].rows.length, 5);
    assert.equal(out.shown, 15);
    assert.equal(out.total, 30);
    assert.equal(out.hasMore, true);
});

check('a group that fits is passed through by identity', () => {
    const a = group('a', 4);
    const out = windowGroups([a, group('b', 40)], 24);
    assert.equal(out.groups[0], a, 'an untrimmed group must not be reallocated');
});

check('trimming a group leaves the original untouched', () => {
    const a = group('a', 40);
    windowGroups([a], 5);
    assert.equal(a.rows.length, 40, 'the source group must not be mutated');
});

// A collapsed group renders nothing, so charging it budget would leave the
// groups below it stuck empty — collapse the top group and the rest of the list
// would disappear.
check('a collapsed group costs no budget but keeps its rows', () => {
    const out = windowGroups([group('a', 100, true), group('b', 10)], 10);
    assert.equal(out.groups.length, 2);
    assert.equal(out.groups[0].rows.length, 100, 'header count and group-select still need them');
    assert.equal(out.groups[1].rows.length, 10);
    assert.equal(out.hasMore, false);
});

check('everything collapsed is never "has more"', () => {
    const out = windowGroups([group('a', 100, true), group('b', 100, true)], 1);
    assert.equal(out.hasMore, false);
    assert.equal(out.shown, 0);
});

check('growing the budget reproduces the ungrouped whole', () => {
    const source = [group('a', 30), group('b', 5), group('c', 40)];
    let budget = INITIAL_ROW_BUDGET;
    let out = windowGroups(source, budget);
    while (out.hasMore) {
        budget += ROW_BUDGET_STEP;
        out = windowGroups(source, budget);
    }
    assert.equal(out.groups.length, 3);
    assert.deepEqual(out.groups.map(g => g.rows.length), [30, 5, 40]);
});

check('an infinite budget passes groups through untouched', () => {
    const source = [group('a', 30), group('b', 40)];
    const out = windowGroups(source, Infinity);
    assert.equal(out.groups, source);
    assert.equal(out.hasMore, false);
});

check('a zero budget shows nothing but still reports more', () => {
    const out = windowGroups([group('a', 3)], 0);
    assert.equal(out.groups.length, 0);
    assert.equal(out.hasMore, true);
});

console.log(`rowWindow: ${passed} tests passed`);
