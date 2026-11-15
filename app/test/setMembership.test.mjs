import assert from 'node:assert/strict';
import { indexSetsBySetting } from '../src/js/setMembership.mjs';
const entry = (tuneID, settingID) => ({ id: settingID, result: { settingID, setting: { tune_id: tuneID } } });
const sets = [
    { id: 'a', name: 'A', entries: [entry('1', '10'), entry('1', '11'), entry('1', '10')] },
    { id: 'b', name: 'B', entries: [entry('2', '20')] },
    { id: 'c', name: 'C', entries: [entry('1', '12')] },
    { id: 'd', name: 'D', entries: [entry('1', 10)] },
    { id: 'deleted', deleted: true },
];
const index = indexSetsBySetting(sets);
assert.deepEqual(index['10'], [{ id: 'a', name: 'A' }, { id: 'd', name: 'D' }]);
assert.deepEqual(index['11'], [{ id: 'a', name: 'A' }]);
assert.deepEqual(index['12'], [{ id: 'c', name: 'C' }]);
assert.equal(index['unknown'], undefined);
assert.equal(index['10'].some(s => s.id === 'c'), false, 'another setting of the same tune is not membership');
console.log('Set membership is exact to settingID, deduplicated and contains names only.');
