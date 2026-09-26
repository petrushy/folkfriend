// Which saved sessions offer a favourite's ▶ (src/js/tuneRecordings.mjs).
//
// Run with:  node app/test/tuneRecordings.test.mjs

import assert from 'node:assert/strict';
import { indexRecordingsByTune, sessionDetections } from '../src/js/tuneRecordings.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`); }
}

const tune = (tuneId, audioStartSeconds, extra = {}) => ({ tuneId, title: `Tune ${tuneId}`, audioStartSeconds, ...extra });

test('matches by tune, whatever setting the session recognised', () => {
    const index = indexRecordingsByTune([
        { id: 's1', startedAt: 1, tunes: [tune('42', 30, { settingId: '999' })] },
    ]);
    assert.equal(index.get('42').length, 1);
    assert.equal(index.get('42')[0].detectionId, 'saved-0');
});

test('numeric and string tune ids are the same tune', () => {
    const index = indexRecordingsByTune([{ id: 's1', startedAt: 1, tunes: [tune(42, 30)] }]);
    assert.ok(index.get('42'));
});

test('a tune heard with no recording running offers nothing', () => {
    const index = indexRecordingsByTune([
        { id: 's1', startedAt: 1, tunes: [tune('42', null), { tuneId: '7', title: 'x' }] },
    ]);
    assert.equal(index.size, 0);
});

test('a session this device cannot play offers nothing', () => {
    const index = indexRecordingsByTune(
        [{ id: 'gone', startedAt: 1, tunes: [tune('42', 30)] }, { id: 'here', startedAt: 2, tunes: [tune('42', 30)] }],
        id => id === 'here');
    assert.deepEqual(index.get('42').map(e => e.sessionId), ['here']);
});

test('several sessions are listed newest first', () => {
    const index = indexRecordingsByTune([
        { id: 'old', startedAt: 100, tunes: [tune('42', 30)] },
        { id: 'new', startedAt: 300, tunes: [tune('42', 30)] },
        { id: 'mid', startedAt: 200, tunes: [tune('42', 30)] },
    ]);
    assert.deepEqual(index.get('42').map(e => e.sessionId), ['new', 'mid', 'old']);
});

test('a tune heard twice in one session is one entry, for its longest hearing', () => {
    const index = indexRecordingsByTune([{ id: 's1', startedAt: 1, tunes: [
        tune('42', 30, { audioAnchorSeconds: 25, audioEndSeconds: 40 }),
        tune('7', 100),
        tune('42', 300, { audioAnchorSeconds: 295, audioEndSeconds: 420 }),
    ] }]);
    assert.equal(index.get('42').length, 1);
    assert.equal(index.get('42')[0].detectionId, 'saved-2');
});

test('the session name is used, else date and place', () => {
    const index = indexRecordingsByTune([
        { id: 'a', name: 'Tuesday at Hughes', startedAt: 2, tunes: [tune('1', 5)] },
        { id: 'b', placeName: 'The Cobblestone', startedAt: 1, tunes: [tune('1', 5)] },
    ]);
    const [a, b] = index.get('1');
    assert.equal(a.sessionName, 'Tuesday at Hughes');
    assert.match(b.sessionName, /· The Cobblestone$/);
});

test('player rows carry the ids the index points at', () => {
    const session = { id: 's1', startedAt: 1, tunes: [tune('7', 5), tune('42', 30)] };
    const entry = indexRecordingsByTune([session]).get('42')[0];
    const row = sessionDetections(session).find(d => d.id === entry.detectionId);
    assert.equal(row.tuneId, '42');
    assert.equal(row.audioStartSeconds, 30);
});

test('malformed sessions are skipped, not fatal', () => {
    const index = indexRecordingsByTune([null, { id: 'x' }, { tunes: [tune('1', 5)] }]);
    assert.equal(index.size, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
