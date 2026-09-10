// Unit tests for exporting and restoring the user's own data.
//
// Run with:  node app/test/userDataBackup.test.mjs
//
// This file exists because the backup is the ONLY true snapshot the app has.
// Firebase holds one live copy, so a mistaken "clear" propagates everywhere,
// and Dropbox holds the audio and nothing else. If the export is wrong the
// user finds out while restoring it, which is precisely the moment they can no
// longer do anything about it.
//
// Everything here is about the file, not about any one feature riding in it.
// The feature-specific paths (AI summaries surviving a restore, the dataset
// selection in an old backup, the sightings round trip) are covered where those
// features live; what was missing was any test of the backup's own robustness.
//
// Two rules, and both were broken:
//
//   1. A read that feeds a backup, and a write that feeds a restore, must be
//      STRICT. Every getter answers a failed read with [], which is right for
//      rendering a list and catastrophic here: the file is written, looks
//      whole, and has silently lost a category.
//
//   2. ABSENCE IS NOT AN INSTRUCTION TO DELETE. A file missing favouriteItems
//      used to wipe every favourite.
//
// store.js is loaded from source with its imports rewritten to in-memory fakes,
// following the loader in liveSessions.test.mjs.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-user-data-backup');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  \u2713 ${name}`);
    } catch (e) {
        failed++;
        console.error(`  \u2717 ${name}`);
        console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`);
    }
}

const STORE_FAKES = {
    // Failures are injected at the IndexedDB boundary, which is where they
    // actually happen (quota, a closed connection). Faking a rejecting
    // store.upsertLiveSession() instead tests a layer that cannot fail in
    // production — store._dbSet used to swallow the error, so the real code
    // never saw one and the whole save-error path was dead.
    'fake-idb.mjs': `
export const __db = new Map();
export let __failWrites = new Set();
export let __failReads = new Set();
export function __failWritesTo(key) { __failWrites.add(key); }
export function __failReadsOf(key) { __failReads.add(key); }
export function __allowAll() { __failWrites.clear(); __failReads.clear(); }
export async function get(key) {
    if (__failReads.has(key)) throw new Error('read failed');
    return __db.get(key);
}
export async function set(key, value) {
    if (__failWrites.has(key)) throw new Error('QuotaExceededError');
    __db.set(key, value);
}
export async function del(key) { __db.delete(key); }
`,
    'fake-eventbus.mjs': `
export const __events = [];
export default { $emit: (name, payload) => __events.push({ name, payload }), $on() {}, $off() {} };
`,
    'fake-sync.mjs': `
export const __records = [];
export const __subs = [];
export function pushFavourites() {}
export function subscribe() { return () => {}; }
export function subscribeCollection(uid, name, handlers) {
    __subs.push({ uid, name, handlers });
    return () => {};
}
export function pushRecord(uid, name, record) { __records.push({ op: 'push', name, record }); }
export function pushRecords(uid, name, records) {
    for (const record of records) __records.push({ op: 'push', name, record });
}
export function deleteRecord(uid, name, id) { __records.push({ op: 'delete', name, id }); }
export function deleteRecords(uid, name, ids) {
    for (const id of ids) __records.push({ op: 'delete', name, id });
}
export function __reset() { __records.length = 0; __subs.length = 0; }
`,
    'fake-ai.mjs': `
export const DEFAULT_MODEL = 'claude-haiku-4-5';
export function estimateCostUsd() { return 0; }
`,
    'fake-firebase-auth.mjs': `
export class GoogleAuthProvider {}
export const browserPopupRedirectResolver = {};
export async function signInWithPopup() {}
export async function signOut() {}
`,
    'fake-firebase-analytics.mjs': `
export function logEvent() {}
`,
};

class FakeLocalStorage {
    constructor() { this.map = new Map(); }
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
    setItem(key, value) { this.map.set(key, String(value)); }
    removeItem(key) { this.map.delete(key); }
}

async function loadStore() {
    await mkdir(tmpDir, { recursive: true });
    for (const [name, source] of Object.entries(STORE_FAKES)) {
        await writeFile(path.join(tmpDir, name), source);
    await writeFile(path.join(tmpDir, 'fake-audio-store.mjs'), `
// store.js deletes a session's recording alongside the record. That path is
// covered against the real store in sessionAudio.test.mjs; here it only has to
// resolve.
export async function deleteSessionAudio() {}
export const __reclaimCalls = [];
// The cloud copy goes with an explicit session delete, so the fake records it:
// "delete session" leaving three hours of a room in the user's Dropbox, with
// the record that pointed at it gone, is the failure this covers.
export const __cloudDeleted = [];
export async function deleteCloudAudio(id) { __cloudDeleted.push(id); return true; }
export async function reclaimAudioForMissingSessions(ids) {
    __reclaimCalls.push([...(ids || [])]);
    return 0;
}
`);
    }
    for (const name of ['schema.js', 'places.mjs']) {
        await writeFile(
            path.join(tmpDir, name.replace('.js', '.mjs')),
            await readFile(path.join(srcDir, 'js', name), 'utf8'),
        );
    }

    let source = await readFile(path.join(srcDir, 'services', 'store.js'), 'utf8');
    const replacements = [
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from 'idb-keyval'", "from './fake-idb.mjs'"],
        ["from '@/js/schema'", "from './schema.mjs'"],
        ["from '@/js/places.mjs'", "from './places.mjs'"],
        ["from './aiSummary.js'", "from './fake-ai.mjs'"],
        ["from './sessionAudioStore.js'", "from './fake-audio-store.mjs'"],
        ["from 'firebase/auth'", "from './fake-firebase-auth.mjs'"],
        ["from './sync.js'", "from './fake-sync.mjs'"],
        ["from 'firebase/analytics'", "from './fake-firebase-analytics.mjs'"],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in store.js`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'store.mjs'), source);

    globalThis.localStorage = new FakeLocalStorage();

    const idb = await import(path.join(tmpDir, 'fake-idb.mjs'));
    idb.__db.clear();
    idb.__allowAll();
    const bus = await import(path.join(tmpDir, 'fake-eventbus.mjs'));
    bus.__events.length = 0;

    const mod = await import(`${path.join(tmpDir, 'store.mjs')}?v=${Math.random()}`);
    const audio = await import(path.join(tmpDir, 'fake-audio-store.mjs'));
    audio.__cloudDeleted.length = 0;
    return { store: mod.default, bus, idb, audio };
}


// A store holding one of everything, so a round trip has something to lose.
async function populated() {
    const { store, idb } = await loadStore();
    idb.__db.set('historyItems', [{ name: 'The Kesh', descriptor: 'jig', timestamp: 1 }]);
    idb.__db.set('favouriteItems', [{ result: { settingID: 1, displayName: 'The Kesh' }, timestamp: 1 }]);
    idb.__db.set('tuneSightings', [{ id: 's1', tuneID: '1', timestamp: 1 }]);
    idb.__db.set('places', [{ id: 'p1', name: 'The Cobblestone', lat: 53.3, lon: -6.2 }]);
    idb.__db.set('liveSessions', [{ id: 'l1', startedAt: 1, tunes: [{ tuneId: 1, title: 'The Kesh' }] }]);
    return { store, idb };
}

const CATEGORIES = ['historyItems', 'favouriteItems', 'tuneSightings', 'places', 'liveSessions'];

async function run() {
    await rm(tmpDir, { recursive: true, force: true });

    console.log('\nexport — a backup is whole or it is not written');

    await test('a full round trip restores every category', async () => {
        const { store } = await populated();
        const json = await store.exportUserData();

        const { store: fresh, idb } = await loadStore();
        await fresh.importUserData(json);
        for (const key of CATEGORIES) {
            assert.equal((idb.__db.get(key) || []).length, 1, `${key} came back`);
        }
    });

    await test('a failed read refuses the backup rather than writing a partial one', async () => {
        // Each category in turn: every one of them is read through a getter
        // that answers a failure with [], so any single one could have gone
        // missing from a file that looked complete.
        for (const key of CATEGORIES) {
            const { store, idb } = await populated();
            idb.__failReadsOf(key);
            await assert.rejects(() => store.exportUserData(), undefined,
                `a failed ${key} read must not produce a file`);
            idb.__allowAll();
        }
    });

    await test('the API key never reaches the file', async () => {
        const { store } = await populated();
        store.setApiKey('sk-ant-secret');
        const json = await store.exportUserData();
        assert.ok(!json.includes('sk-ant-secret'));
    });

    console.log('\nimport — absence is not an instruction to delete');

    await test('a file missing a category leaves that category alone', async () => {
        // favouriteItems and historyItems used to be written as `payload.x ||
        // []`, so a hand-edited or truncated file silently destroyed every
        // favourite. The other three were already guarded; now all five are.
        for (const missing of CATEGORIES) {
            const { store, idb } = await populated();
            const payload = JSON.parse(await store.exportUserData());
            delete payload[missing];

            await store.importUserData(JSON.stringify(payload));
            assert.equal((idb.__db.get(missing) || []).length, 1,
                `${missing} survived a file that did not mention it`);
        }
    });

    await test('an empty category in the file DOES restore as empty', async () => {
        // The other half of the rule: an export with nothing in it writes an
        // empty array, which is present, and must still be honoured — or
        // restoring a deliberately cleared backup would put the data back.
        const { store, idb } = await populated();
        const payload = JSON.parse(await store.exportUserData());
        payload.favouriteItems = [];
        await store.importUserData(JSON.stringify(payload));
        assert.deepEqual(idb.__db.get('favouriteItems'), []);
    });

    console.log('\nimport — a damaged file is refused, not written');

    await test('invalid JSON is refused', async () => {
        const { store } = await loadStore();
        await assert.rejects(() => store.importUserData('{ not json'), /invalid JSON/);
    });

    await test('an unsupported version is refused', async () => {
        const { store } = await loadStore();
        await assert.rejects(
            () => store.importUserData(JSON.stringify({ version: 99, favouriteItems: [] })),
            /unsupported data version/);
    });

    await test('a file whose collections are not lists is refused', async () => {
        // A truncated or half-written file can still parse and still carry the
        // right version. Only the version was ever checked, so anything after
        // it went straight into IndexedDB.
        const { store, idb } = await populated();
        for (const value of ['', 0, {}, 'lots of favourites']) {
            await assert.rejects(
                () => store.importUserData(JSON.stringify({ version: 5, favouriteItems: value })),
                /looks damaged|no favourites/);
        }
        assert.equal(idb.__db.get('favouriteItems').length, 1, 'and nothing was touched');
    });

    await test('a file carrying none of the user\'s data is refused', async () => {
        const { store } = await loadStore();
        await assert.rejects(
            () => store.importUserData(JSON.stringify({ version: 5, exportedAt: 1 })),
            /contains no favourites/);
    });

    await test('damaged settings are refused rather than replacing good ones', async () => {
        const { store } = await loadStore();
        await assert.rejects(
            () => store.importUserData(JSON.stringify({
                version: 5, favouriteItems: [], userSettings: 'corrupted',
            })), /settings in this file look damaged/);
    });

    console.log('\nimport — a failed restore puts everything back');

    await test('a write that fails mid-restore rolls the others back', async () => {
        // Five sequential lenient writes meant a failure at the third left the
        // user half-restored, with the old data already overwritten — and the
        // error was swallowed, so Settings said "restored successfully" over
        // the top of it.
        const { store, idb } = await populated();
        const before = Object.fromEntries(CATEGORIES.map(k => [k, idb.__db.get(k)]));

        const incoming = JSON.parse(await store.exportUserData());
        for (const key of CATEGORIES) incoming[key] = [{ id: 'replacement' }];
        incoming.historyItems = [{ name: 'replacement' }];

        idb.__failWritesTo('places');
        await assert.rejects(() => store.importUserData(JSON.stringify(incoming)),
            /put back unchanged/);
        idb.__allowAll();

        for (const key of CATEGORIES) {
            assert.deepEqual(idb.__db.get(key), before[key],
                `${key} is exactly as it was before the failed restore`);
        }
    });

    await test('a failed restore says so rather than reporting success', async () => {
        const { store, idb } = await populated();
        const json = await store.exportUserData();
        idb.__failWritesTo('favouriteItems');
        await assert.rejects(() => store.importUserData(json), /Restore failed/);
        idb.__allowAll();
    });

    await test('an unreadable store refuses the restore before touching anything', async () => {
        const { store, idb } = await populated();
        const json = await store.exportUserData();
        const before = idb.__db.get('favouriteItems');
        idb.__failReadsOf('places');
        await assert.rejects(() => store.importUserData(json), /nothing was changed/);
        idb.__allowAll();
        assert.deepEqual(idb.__db.get('favouriteItems'), before);
    });

    console.log('\nolder backups');

    await test('a v1 backup restores without wiping anything added since', async () => {
        const { store, idb } = await populated();
        await store.importUserData(JSON.stringify({
            version: 1,
            historyItems: [{ name: 'Old' }],
            favouriteItems: [{ result: { settingID: 9, displayName: 'Old' }, timestamp: 1 }],
        }));
        assert.equal(idb.__db.get('favouriteItems')[0].result.settingID, 9, 'restored');
        for (const key of ['tuneSightings', 'places', 'liveSessions']) {
            assert.equal(idb.__db.get(key).length, 1, `${key} was not in the file and survived`);
        }
    });

    await rm(tmpDir, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
