import assert from 'node:assert/strict';
import { setsForTune } from '../src/js/setMembership.mjs';
const entry = (tuneID, settingID, mode) => ({ id: settingID, result: { settingID, setting: { tune_id: tuneID, mode } } });
const sets = [
    { id: 'a', name: 'A', entries: [entry('1', '10', 'Dmajor'), entry('2', '20', 'Gmajor'), entry('1', '11', 'Eminor')] },
    { id: 'b', name: 'B', entries: [entry('2', '20', 'Gmajor')] },
    { id: 'c', name: 'C', entries: [entry('1', '10', 'Dmajor')] },
    { id: 'deleted', deleted: true },
];
const memberships = setsForTune(sets, 1);
assert.deepEqual(memberships.map(s => s.id), ['a', 'c']);
assert.deepEqual(memberships[0].entries.map(e => e.result.settingID), ['10', '11']);
assert.deepEqual(setsForTune(sets, 'unknown'), []);
console.log('Tune membership includes all containing sets and preserves their chosen settings.');
