import assert from 'node:assert/strict';
import { matchSets, indexFavouriteTags, foldText } from '../src/js/setFilter.mjs';

const entry = (name, tuneID, settingID) => ({ id: 'e' + settingID, result: { settingID, displayName: name, setting: { tune_id: tuneID } } });
const sets = [
    { id: 'tagged', name: 'Tuesday', tags: ['reels'], entries: [entry('The Kesh', '1', 10)] },
    { id: 'tune', name: 'Jigs', tags: [], entries: [entry('Drowsy Maggie', '2', 20)] },
    { id: 'name', name: 'Maggie set', tags: [], entries: [entry('Silver Spear', '3', 30)] },
    { id: 'tunetag', name: 'Polskas', tags: [], entries: [entry('Gärdebylåten', '4', 40)] },
    { id: 'none', name: 'Other', tags: [], entries: [entry('Butterfly', '5', 50)] },
];
const favourites = [
    { tags: ['maggie-practice'], result: { settingID: 99, setting: { tune_id: '4' } } }, // another setting, same tune
    { tags: ['swedish'], result: { settingID: 40, setting: { tune_id: '4' } } },
    { tags: [], result: { settingID: 50, setting: { tune_id: '5' } } },
];
const tagIndex = indexFavouriteTags(favourites);
const ids = (q, opts = {}) => matchSets(sets, q, { tagIndex, ...opts }).map(m => m.set.id);

assert.deepEqual(ids(''), sets.map(s => s.id), 'no query lists every set in order');
assert.deepEqual(ids('maggie'), ['name', 'tune', 'tunetag'], 'set name, then tune name, then tune tag');
assert.deepEqual(ids('reels'), ['tagged'], 'set tags still match');
assert.deepEqual(ids('swedish'), ['tunetag'], 'a favourite tag on the exact setting matches');
assert.deepEqual(ids('gardebylaten'), ['tunetag'], 'accents are folded');
assert.deepEqual(ids('KESH'), ['tagged'], 'case-insensitive tune name');
assert.deepEqual(ids('nothing here'), []);
assert.deepEqual(ids('maggie', { activeTags: ['reels'] }), [], 'tag chips still narrow the list');
assert.deepEqual(matchSets(sets, 'maggie', { tagIndex: null }).map(m => m.set.id), ['name', 'tune'],
    'without favourites only names are searched');

const hit = matchSets(sets, 'maggie', { tagIndex }).find(m => m.set.id === 'tune');
assert.deepEqual(hit.tunes, ['Drowsy Maggie']);
const tagHit = matchSets(sets, 'practice', { tagIndex })[0];
assert.deepEqual(tagHit.tags, ['maggie-practice'], 'reports which tune tag matched');
assert.equal(foldText('Å'), 'a');
console.log('Set filter: name, then tune, then tag; accent-folded; tune tags from favourites.');
