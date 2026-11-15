import assert from 'node:assert/strict';
import { searchSetSettings } from '../src/services/setSearch.mjs';

// Matches rust/src/query/mod.rs NameQueryRecord: no setting_id and no ABC.
const nameResults = [{ display_name: "Cooley's", setting: {
    tune_id: '1', mode: 'Eminor', dance: 'reel', contour: 'abc',
} }];
const settings = [
    { setting_id: '10', tune_id: '1', mode: 'Eminor', dance: 'reel', abc: 'K:Em\nEFGA|' },
    { setting_id: '11', tune_id: '1', mode: 'Dminor', dance: 'reel', abc: 'K:Dm\nDEFG|' },
];
let calls = 0;
const backend = {
    async runNameQuery(query) { assert.equal(query, 'cooley'); return nameResults; },
    async settingsFromTuneID(id) { calls++; assert.equal(id, '1'); return settings; },
};
const resolved = await searchSetSettings(backend, 'cooley');
assert.equal(calls, 1);
assert.deepEqual(resolved.map(r => r.setting_id), ['10', '11']);
assert.deepEqual(resolved.map(r => r.setting.mode), ['Eminor', 'Dminor']);
assert.ok(resolved.every(r => r.setting.abc && r.display_name === "Cooley's"));
assert.deepEqual(await searchSetSettings({ async runNameQuery() { return []; } }, 'missing'), []);
await assert.rejects(searchSetSettings({ ...backend, async settingsFromTuneID() { throw new Error('unavailable'); } }, 'cooley'), /unavailable/);
console.log('Set search resolves ID-less name matches into selectable settings with scores.');
