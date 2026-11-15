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

const favourite = (id, name = "Cooley's", tuneID = '1') => ({ result: {
    settingID: id, displayName: name,
    setting: { setting_id: id, tune_id: tuneID, mode: 'Dminor', dance: 'reel', abc: 'K:Dm\nDEFG|' },
} });
const ranked = await searchSetSettings(backend, 'cooley', { favourites: [favourite(11)] });
assert.deepEqual(ranked.map(r => String(r.setting_id)), ['11', '10']);
assert.equal(ranked[0].favourite, true);
assert.equal(ranked.length, 2, 'numeric and string setting IDs are deduplicated');
const localOnly = await searchSetSettings(backend, 'cooley', { favourites: [favourite('99')] });
assert.equal(localOnly[0].setting_id, '99', 'saved settings outside the current index are included');
const offline = await searchSetSettings({}, 'cooley', { indexReady: false,
    favourites: [favourite('99'), favourite('100', 'Unrelated tune', '2')] });
assert.deepEqual(offline.map(r => r.setting_id), ['99']);
const aliasMatch = await searchSetSettings(backend, 'cooley', { favourites: [favourite('99', 'Different alias')] });
assert.equal(aliasMatch[0].setting_id, '99', 'a database alias can match the saved tune');
const empty = await searchSetSettings({}, 'cooley', { indexReady: false, favourites: [] });
assert.deepEqual(empty, []);
const moreTunes = { ...backend, async runNameQuery() { return [
    { display_name: 'Other match', setting: { tune_id: '2' } }, ...nameResults,
]; }, async settingsFromTuneID(id) { return id === '1' ? settings : [
    { setting_id: '20', tune_id: '2', mode: 'Gmajor', dance: 'reel', abc: 'K:G\nGABc|' },
]; } };
const tuneRanked = await searchSetSettings(moreTunes, 'cooley', { favourites: [favourite('11')] });
assert.deepEqual(tuneRanked.map(r => r.setting_id), ['11', '10', '20']);
console.log('Favourite settings rank first, followed by their other settings; saved favourites work offline.');
