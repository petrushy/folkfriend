// Making sets from a session's tune list: the pure rules (src/js/sessionSets.mjs).
//
// Run with:  node app/test/sessionSets.test.mjs

import assert from 'node:assert/strict';
import {
    SET_BREAK_SECONDS, selectionKey, gapSeconds, groupIntoRuns, pickSetting, setNameFromSession,
} from '../src/js/sessionSets.mjs';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

// A row as the tune table holds it. endSeconds is a window (10 s) past the
// last matching window's read time, as clusterDetections makes it.
const row = (startSeconds, endSeconds, extra = {}) => ({ startSeconds, endSeconds, ...extra });

console.log('\nsplitting a session into the sets it was played in');

test('tunes played back to back are one run; a break starts the next', () => {
    const rows = [
        row(0, 120), row(118, 240), row(242, 360),
        row(360 + SET_BREAK_SECONDS + 60, 600), row(598, 700),
    ];
    assert.deepEqual(groupIntoRuns(rows), [{ start: 0, end: 2 }, { start: 3, end: 4 }]);
});

test('every row is in exactly one run, including a lone tune', () => {
    const rows = [row(0, 100), row(400, 500), row(900, 1000), row(1001, 1100)];
    const runs = groupIntoRuns(rows);
    assert.deepEqual(runs, [{ start: 0, end: 0 }, { start: 1, end: 1 }, { start: 2, end: 3 }]);
    assert.deepEqual(groupIntoRuns([]), []);
});

test('a break the session was PAUSED through still splits the runs', () => {
    // The listening clock stopped during the pause, so on it the second set
    // follows straight on. The wall clock shows the ten minutes.
    const T = 1_700_000_000_000;
    const a = row(0, 130, { startedAtMs: T, endedAtMs: T + 120000 });
    const b = row(131, 260, { startedAtMs: T + 120000 + 600000, endedAtMs: T + 850000 });
    assert.ok(gapSeconds(a, b) > SET_BREAK_SECONDS);
    assert.deepEqual(groupIntoRuns([a, b]), [{ start: 0, end: 0 }, { start: 1, end: 1 }]);
});

test('the wall clock does not invent a break inside a set', () => {
    // Read to read is about a window apart inside a set; the window is taken
    // off, so it compares like the listening clock does.
    const T = 1_700_000_000_000;
    const a = row(0, 130, { startedAtMs: T, endedAtMs: T + 120000 });
    const b = row(131, 260, { startedAtMs: T + 131000, endedAtMs: T + 250000 });
    assert.ok(Math.abs(gapSeconds(a, b)) < 5);
    assert.deepEqual(groupIntoRuns([a, b]), [{ start: 0, end: 1 }]);
});

test('a row with no wall-clock stamps falls back to the listening clock', () => {
    const T = 1_700_000_000_000;
    const a = row(0, 130, { startedAtMs: T, endedAtMs: T + 120000 });
    const b = row(131, 260);
    assert.equal(gapSeconds(a, b), 1);
});

console.log('\nselection');

test('the selection key survives a re-cluster that renumbers the row', () => {
    // A detection id carries its position; filtering an earlier blip changes it.
    const before = { id: '12-3-240', tuneId: 12, startSeconds: 240.2 };
    const after = { id: '12-2-240-m', tuneId: 12, startSeconds: 240.2 };
    assert.equal(selectionKey(before), selectionKey(after));
    // ...and a correction to another tune.
    assert.equal(selectionKey({ ...before, tuneId: 99 }), selectionKey(before));
    assert.notEqual(selectionKey(row(240, 300)), selectionKey(row(250, 300)));
});

console.log('\nwhich setting goes into the set');

const s = (id, favourite = false) => ({ setting_id: id, setting: { abc: 'X:1' }, favourite });

test('a starred setting wins over the one the detection happened to score best', () => {
    assert.equal(pickSetting([s('7', true), s('3'), s('5')], '5').setting_id, '7');
});

test('among several starred settings, the detected one if it is starred', () => {
    assert.equal(pickSetting([s('7', true), s('8', true), s('5')], '8').setting_id, '8');
    assert.equal(pickSetting([s('7', true), s('8', true), s('5')], '5').setting_id, '7');
});

test('with nothing starred, the detected setting, else the first', () => {
    assert.equal(pickSetting([s('3'), s('5')], 5).setting_id, '5', 'ids compare as strings');
    assert.equal(pickSetting([s('3'), s('5')], '9').setting_id, '3');
    assert.equal(pickSetting([s('3'), s('5')], null).setting_id, '3');
    assert.equal(pickSetting([], '3'), null);
    assert.equal(pickSetting(null, '3'), null);
});

console.log('\nnaming');

test('a set is named after its session, numbered when it came from a run', () => {
    assert.equal(setNameFromSession('12 Nov · The Cobblestone', 2), '12 Nov · The Cobblestone · set 2');
    assert.equal(setNameFromSession('12 Nov · The Cobblestone'), '12 Nov · The Cobblestone');
    assert.equal(setNameFromSession('  '), 'Session');
    assert.equal(setNameFromSession('x'.repeat(300), 1).length, 200, 'within the set-name limit');
});

console.log(`\nsessionSets.test.mjs: ${passed} passed`);
