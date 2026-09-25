// Saving an analysed recording file as a Past Session.
//
// Run with:  node app/test/sessionImport.test.mjs
//
// Two layers. js/sessionImport.mjs is pure and loaded as it is: what an
// imported session looks like, where its start time comes from, and how the
// user's corrections in the tune table reach the stored list.
// services/sessionImport.js is the orchestration, loaded with its imports
// rewritten to fakes, and the property it exists for is ORDER: the tune list
// is saved first and survives a failure to keep the audio.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadSessionAnalysisModule, sessionAnalysisTmpDir } from './helpers/loadSessionAnalysis.mjs';
import {
    defaultImportStart, fromDateTimeLocal, importedSessionRecord, importedTunes,
    nameFromFileName, newImportedSessionId, toDateTimeLocal,
} from '../src/js/sessionImport.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-session-import');

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n      ') : e}`);
    }
}

const { parseClockTime } = await loadSessionAnalysisModule();

console.log('\nsessionImport — the record');

await test('the start is the file date minus its length, since a recorder writes as it goes', () => {
    const now = Date.UTC(2026, 8, 25, 12);
    const modified = Date.UTC(2026, 8, 20, 23);
    assert.equal(defaultImportStart({ lastModified: modified }, 3600, now), modified - 3600 * 1000);
});

await test('an implausible file date falls back to now', () => {
    const now = Date.UTC(2026, 8, 25, 12);
    assert.equal(defaultImportStart({ lastModified: 0 }, 60, now), now - 60000, 'unset clock');
    assert.equal(defaultImportStart({ lastModified: now + 86400000 }, 60, now), now - 60000, 'future');
    assert.equal(defaultImportStart({}, 60, now), now - 60000, 'no date at all');
});

await test('the date field round-trips in LOCAL time, and rejects what is not a date', () => {
    const at = new Date(2026, 2, 14, 21, 5).getTime();
    assert.equal(toDateTimeLocal(at), '2026-03-14T21:05');
    assert.equal(fromDateTimeLocal('2026-03-14T21:05'), at);
    assert.ok(Number.isNaN(fromDateTimeLocal('')));
    assert.ok(Number.isNaN(fromDateTimeLocal('2026-02-31T10:00')), '31 February is not rolled into March');
    assert.ok(Number.isNaN(fromDateTimeLocal('yesterday')));
});

await test('a name comes from the file, without its extension', () => {
    assert.equal(nameFromFileName('Tuesday at the Cobblestone.m4a'), 'Tuesday at the Cobblestone');
    assert.equal(nameFromFileName('no-extension'), 'no-extension');
});

await test('an imported session is finished, sourced, and named only when a name was given', () => {
    const named = importedSessionRecord({ id: 'session-1-a', name: '  Pub  ', startedAt: 1000,
        durationSeconds: 90.4, fileName: 'x.mp3', tunes: [], now: 5 });
    assert.equal(named.endedAt, 1000 + 90400);
    assert.equal(named.listenedSeconds, 90);
    assert.equal(named.name, 'Pub');
    assert.equal(named.customName, true);
    assert.equal(named.source, 'import');
    assert.equal(named.sourceFileName, 'x.mp3');
    assert.deepEqual([named.lat, named.lon, named.accuracy], [null, null, null]);
    // No name: leave naming to the store, which labels by date and place as it
    // does for every live session. A customName here would freeze an empty one.
    const unnamed = importedSessionRecord({ id: 'session-1-b', name: ' ', startedAt: 1000, durationSeconds: 1 });
    assert.equal(unnamed.customName, false);
});

await test('the session id has the form the Dropbox layer accepts', () => {
    assert.match(newImportedSessionId(), /^[a-zA-Z0-9_-]{1,200}$/);
});

console.log('\nsessionImport — the tune list');

const row = (over = {}) => ({
    id: 'r', tuneId: '1', settingId: '10', title: 'Detected', sourceUrl: 'u', dataset: 'thesession',
    startSeconds: 60, endSeconds: 150, bestScore: 0.8, alternatives: [{ tuneId: '2' }],
    audioStartSeconds: 70, audioEndSeconds: 150, audioAnchorSeconds: 65,
    editableTime: '1:00', ...over,
});

await test('the tune the user CHOSE is saved, not the one detected', () => {
    const [tune] = importedTunes([row({ selectedTuneId: '2', selectedSettingId: '20',
        selectedTitle: 'Corrected', selectedSourceUrl: 'v' })], parseClockTime);
    assert.deepEqual([tune.tuneId, tune.settingId, tune.title, tune.sourceUrl], ['2', '20', 'Corrected', 'v']);
    assert.deepEqual(tune.alternatives, [{ tuneId: '2' }], 'the dropdown survives the save');
});

await test('an edited start moves the tune and keeps its length; the audio offsets stay put', () => {
    const [tune] = importedTunes([row({ editableTime: '2:30' })], parseClockTime);
    assert.equal(tune.startSeconds, 150);
    assert.equal(tune.endSeconds, 240);
    // Where the tune was HEARD in the file, which editing the list does not
    // change — the ▶ must still land on it.
    assert.deepEqual([tune.audioStartSeconds, tune.audioAnchorSeconds, tune.audioEndSeconds], [70, 65, 150]);
});

await test('an unreadable edited time keeps the analysed one, and the list is in time order', () => {
    const tunes = importedTunes([
        row({ tuneId: 'b', startSeconds: 300, endSeconds: 400, editableTime: 'soon' }),
        row({ tuneId: 'a', editableTime: '1:00' }),
    ], parseClockTime);
    assert.deepEqual(tunes.map(t => [t.tuneId, t.startSeconds]), [['a', 60], ['b', 300]]);
});

await test('rows with no audio offsets store nulls, never undefined', () => {
    const [tune] = importedTunes([row({ audioStartSeconds: undefined, audioEndSeconds: null,
        audioAnchorSeconds: Number.NaN })], parseClockTime);
    assert.deepEqual([tune.audioStartSeconds, tune.audioEndSeconds, tune.audioAnchorSeconds], [null, null, null]);
});

// --- the service ------------------------------------------------------------

async function loadService() {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'fake-store.mjs'), `
export const __calls = [];
export let __fail = null;
export function __setFail(e) { __fail = e; }
export default {
    async upsertLiveSession(record) {
        __calls.push(['upsert', record]);
        if (__fail) throw __fail;
        return { ...record, name: record.name || 'Sep 20, 2026, 21:00' };
    },
};`);
    await writeFile(path.join(tmpDir, 'fake-audio-store.mjs'), `
export const __calls = [];
export let __fail = null;
export function __setFail(e) { __fail = e; }
export async function importAudioFile(id, file, options) {
    __calls.push(['import', id, file.name, options.durationSeconds]);
    if (__fail) throw __fail;
    return { sessionId: id };
}`);
    await writeFile(path.join(tmpDir, 'fake-dropbox.mjs'), `
export const __calls = [];
export function syncDropbox() { __calls.push('sync'); return Promise.resolve(); }`);

    let source = await readFile(path.join(srcDir, 'services', 'sessionImport.js'), 'utf8');
    const replacements = [
        ["from './store.js'", "from './fake-store.mjs'"],
        ["from './sessionAudioStore.js'", "from './fake-audio-store.mjs'"],
        ["from './dropbox.js'", "from './fake-dropbox.mjs'"],
        ["from '@/js/sessionAnalysis.js'", `from '${path.join(sessionAnalysisTmpDir, 'sessionAnalysis.mjs')}'`],
        ["from '@/js/sessionImport.mjs'", `from '${path.join(srcDir, 'js', 'sessionImport.mjs')}'`],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected ${from} in sessionImport.js`);
        source = source.split(from).join(to);
    }
    const target = path.join(tmpDir, 'sessionImport.mjs');
    await writeFile(target, source);
    const v = Math.random();
    return {
        service: await import(`${target}?v=${v}`),
        store: await import(path.join(tmpDir, 'fake-store.mjs')),
        audio: await import(path.join(tmpDir, 'fake-audio-store.mjs')),
        dropbox: await import(path.join(tmpDir, 'fake-dropbox.mjs')),
    };
}

const { service, store, audio, dropbox } = await loadService();
const reset = () => {
    store.__calls.length = 0; audio.__calls.length = 0; dropbox.__calls.length = 0;
    store.__setFail(null); audio.__setFail(null);
};
const file = { name: 'Tuesday.mp3', size: 1000 };
const args = (over = {}) => ({ file, rows: [row()], durationSeconds: 600, startedAt: 1000, name: '', keepAudio: true, ...over });

console.log('\nsessionImport — saving');

await test('the session is saved first, then its audio under the same id, then backup is nudged', async () => {
    reset();
    const result = await service.saveImportedSession(args());
    assert.equal(store.__calls.length, 1);
    const record = store.__calls[0][1];
    assert.deepEqual(audio.__calls, [['import', record.id, 'Tuesday.mp3', 600]]);
    assert.equal(result.session.id, record.id);
    assert.equal(result.session.name, 'Sep 20, 2026, 21:00', 'the name the store gave it');
    assert.equal(result.audio.kept, true);
    assert.deepEqual(dropbox.__calls, ['sync']);
    assert.equal(record.tunes.length, 1);
});

await test('a failure to keep the audio still leaves the session saved, and says why', async () => {
    reset();
    audio.__setFail(Object.assign(new Error('Not enough free storage to keep this recording.'), { code: 'storage' }));
    const result = await service.saveImportedSession(args());
    assert.equal(store.__calls.length, 1, 'the tune list is kept');
    assert.equal(result.audio.kept, false);
    assert.equal(result.audio.code, 'storage');
    assert.match(result.audio.error, /free storage/);
    assert.deepEqual(dropbox.__calls, [], 'nothing to back up');
});

await test('a session that could not be saved stores no audio for it', async () => {
    // Audio no record points at is the largest orphan the app can produce.
    reset();
    store.__setFail(new Error('disk full'));
    await assert.rejects(service.saveImportedSession(args()), /disk full/);
    assert.deepEqual(audio.__calls, []);
});

await test('keeping the audio is optional', async () => {
    reset();
    const result = await service.saveImportedSession(args({ keepAudio: false }));
    assert.equal(store.__calls.length, 1);
    assert.deepEqual(audio.__calls, []);
    assert.equal(result.audio.kept, false);
    assert.equal(result.audio.error, '');
});

await test('nothing is saved without a length or a valid start', async () => {
    reset();
    await assert.rejects(service.saveImportedSession(args({ durationSeconds: 0 })), /Analyse/);
    await assert.rejects(service.saveImportedSession(args({ startedAt: Number.NaN })), /recorded/);
    assert.equal(store.__calls.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
