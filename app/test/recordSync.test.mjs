// Tests for syncing places, sightings and live sessions — the record-per-
// document collections added when Past Sessions and geo-tagging stopped being
// device-local.
//
// Run with:  node app/test/recordSync.test.mjs
//
// Favourites sync by replacing local with remote, and that is safe there
// because a favourite is a deliberate act the user can redo. These three are
// observation logs of what was played and where, which CANNOT be recreated
// after the fact, so almost every property worth pinning here is about not
// losing one:
//
//   - Seeding is a UNION. A device that recorded sessions before signing in
//     must keep them AND push them up; replacing local with remote would wipe
//     an evening's log the moment its owner signed in.
//   - Local pruning is not a deletion. A device at its cap drops its oldest
//     records to stay under it, and must never propagate that as a delete —
//     the other device is not at the cap and still has them.
//   - Deleting a PLACE keeps its sightings. They are updated remotely (their
//     placeID goes null), never removed, matching what the local store does.
//   - A clear reads the ids before wiping, or the remote copies outlive it and
//     the next snapshot puts everything straight back.
//
// sync.js and store.js are both loaded from source with their imports
// rewritten to fakes: a fake Firestore whose snapshots the test drives by
// hand, and (for the store half) a fake sync layer that records every push.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-record-sync');

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
        console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`);
    }
}

// --- fakes shared by both halves -------------------------------------------

const FAKE_EVENTBUS = `
export const __events = [];
export default { $emit: (name, payload) => __events.push({ name, payload }), $on() {}, $off() {} };
export function __reset() { __events.length = 0; }
`;

// A Firestore stand-in whose listeners the test drives directly. Batches record
// their operations rather than applying them, so a test can assert on how the
// writes were grouped as well as on what they were.
const FAKE_FIRESTORE = `
export const __listeners = [];
export const __writes = [];
export const __batches = [];

export function doc(db, ...segments) { return { path: segments.join('/') }; }
export function collection(db, ...segments) { return { path: segments.join('/') }; }
export function serverTimestamp() { return '__ts__'; }

export function setDoc(ref, data) {
    __writes.push({ op: 'set', path: ref.path, data });
    return Promise.resolve();
}
export function deleteDoc(ref) {
    __writes.push({ op: 'delete', path: ref.path });
    return Promise.resolve();
}
export function writeBatch() {
    const ops = [];
    __batches.push(ops);
    return {
        set(ref, data) { ops.push({ op: 'set', path: ref.path, data }); },
        delete(ref) { ops.push({ op: 'delete', path: ref.path }); },
        commit() { for (const o of ops) __writes.push(o); return Promise.resolve(); },
    };
}
export function onSnapshot(ref, onNext, onError) {
    const listener = { path: ref.path, onNext, onError, active: true };
    __listeners.push(listener);
    return () => { listener.active = false; };
}
export function __reset() {
    __listeners.length = 0;
    __writes.length = 0;
    __batches.length = 0;
}
`;

const FAKE_FIREBASE_APP = `export const firestore = { __fake: true };\nexport default { __fake: true };`;

async function writeSharedFakes() {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);
    await writeFile(path.join(tmpDir, 'fake-firestore.mjs'), FAKE_FIRESTORE);
    await writeFile(path.join(tmpDir, 'fake-firebase.mjs'), FAKE_FIREBASE_APP);
}

// --- half 1: sync.js, against the fake Firestore ---------------------------

async function loadSync() {
    await writeSharedFakes();

    let source = await readFile(path.join(srcDir, 'services', 'sync.js'), 'utf8');
    const replacements = [
        ["from 'firebase/firestore'", "from './fake-firestore.mjs'"],
        ["from './firebase.js'", "from './fake-firebase.mjs'"],
        ["from '@/eventBus'", "from './fake-eventbus.mjs'"],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in sync.js`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'sync.mjs'), source);

    globalThis.localStorage = {
        _m: new Map(),
        getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
        setItem(k, v) { this._m.set(k, String(v)); },
        removeItem(k) { this._m.delete(k); },
    };

    const firestore = await import(path.join(tmpDir, 'fake-firestore.mjs'));
    firestore.__reset();
    const sync = await import(`${path.join(tmpDir, 'sync.mjs')}?v=${Math.random()}`);
    return { sync, firestore };
}

// Builds a snapshot in the shape onSnapshot delivers. `changes` defaults to
// every doc arriving as 'added', which is what a first snapshot looks like.
function snapshot(records, { fromCache = false, changes = null } = {}) {
    const docs = records.map(r => ({ id: String(r.id), data: () => r }));
    return {
        docs,
        metadata: { fromCache },
        docChanges: () => changes || docs.map(doc => ({ type: 'added', doc })),
    };
}

function removal(id) {
    return { type: 'removed', doc: { id: String(id), data: () => ({ id }) } };
}

async function run() {
    await rm(tmpDir, { recursive: true, force: true });

    console.log('\nsync.js — seeding a record collection');

    await test('a first snapshot pushes up records only this device has', async () => {
        const { sync, firestore } = await loadSync();
        const applied = [];
        sync.subscribeCollection('u1', 'liveSessions', {
            applyRemote: (upserts, removals) => { applied.push({ upserts, removals }); },
            getLocal: async () => [
                { id: 'local-only', startedAt: 2 },
                { id: 'shared', startedAt: 1 },
            ],
        });

        await firestore.__listeners[0].onNext(snapshot([{ id: 'shared', startedAt: 1 }]));

        const paths = firestore.__writes.map(w => w.path);
        assert.deepEqual(paths, ['users/u1/liveSessions/local-only'],
            'exactly the record Firestore did not have goes up');
        assert.deepEqual(applied[0].upserts.map(r => r.id), ['shared'],
            'and the one it did have comes down');
    });

    await test('seeding never deletes a local record Firestore has not seen', async () => {
        const { sync, firestore } = await loadSync();
        const applied = [];
        sync.subscribeCollection('u1', 'sightings', {
            applyRemote: (upserts, removals) => { applied.push({ upserts, removals }); },
            getLocal: async () => [{ id: 'recorded-before-signing-in', timestamp: 1 }],
        });

        // Firestore has nothing at all — the case of signing in for the first
        // time on a device that has been recording for months.
        await firestore.__listeners[0].onNext(snapshot([]));

        assert.deepEqual(applied, [], 'an empty remote collection is not a deletion');
        assert.deepEqual(firestore.__writes.map(w => w.path),
            ['users/u1/sightings/recorded-before-signing-in']);
    });

    await test('a cache-only snapshot does not seed', async () => {
        const { sync, firestore } = await loadSync();
        sync.subscribeCollection('u1', 'sightings', {
            applyRemote: () => {},
            getLocal: async () => [{ id: 'a', timestamp: 1 }],
        });

        // The local cache answers before the server does. Seeding from it would
        // push up everything the cache happens not to hold yet.
        await firestore.__listeners[0].onNext(snapshot([], { fromCache: true }));
        assert.deepEqual(firestore.__writes, [], 'nothing is pushed from a cached snapshot');

        await firestore.__listeners[0].onNext(snapshot([{ id: 'a', timestamp: 1 }]));
        assert.deepEqual(firestore.__writes, [], 'and the server snapshot has it after all');
    });

    await test('seeding runs once, not on every later snapshot', async () => {
        const { sync, firestore } = await loadSync();
        let localReads = 0;
        sync.subscribeCollection('u1', 'places', {
            applyRemote: () => {},
            getLocal: async () => { localReads++; return []; },
        });

        await firestore.__listeners[0].onNext(snapshot([]));
        await firestore.__listeners[0].onNext(snapshot([{ id: 'p1', name: 'A' }]));
        await firestore.__listeners[0].onNext(snapshot([{ id: 'p2', name: 'B' }]));

        assert.equal(localReads, 1);
    });

    await test('a removal is reported as a removal, not as a missing record', async () => {
        const { sync, firestore } = await loadSync();
        const applied = [];
        sync.subscribeCollection('u1', 'sightings', {
            applyRemote: (upserts, removals) => { applied.push({ upserts, removals }); },
            getLocal: async () => [],
        });

        await firestore.__listeners[0].onNext(snapshot([{ id: 'a', timestamp: 1 }]));
        await firestore.__listeners[0].onNext(
            snapshot([], { changes: [removal('a')] }));

        assert.deepEqual(applied[1], { upserts: [], removals: ['a'] });
    });

    await test('a large push is split into batches Firestore will accept', async () => {
        const { sync, firestore } = await loadSync();
        const records = Array.from({ length: 900 }, (_, i) => ({ id: `s${i}`, timestamp: i }));

        await sync.pushRecords('u1', 'sightings', records);

        assert.equal(firestore.__writes.length, 900, 'every record is written');
        assert.ok(firestore.__batches.length > 1, 'and not in one oversized batch');
        for (const batch of firestore.__batches) {
            assert.ok(batch.length <= 500, `batch of ${batch.length} exceeds the Firestore limit`);
        }
    });

    await test('a record with no id is never written to an undefined path', async () => {
        const { sync, firestore } = await loadSync();
        await sync.pushRecord('u1', 'sightings', { timestamp: 1 });
        await sync.pushRecords('u1', 'sightings', [{ timestamp: 1 }, null]);
        await sync.deleteRecord('u1', 'sightings', null);
        assert.deepEqual(firestore.__writes, []);
    });

    // --- half 2: store.js, against a fake sync layer ------------------------

    console.log('\nstore.js — what each change pushes');

    await test('a sighting is pushed as its own document', async () => {
        const { store, sync } = await signedInStore();
        await store.addSighting({ tuneID: '42', displayName: 'The Kesh', fix: COBBLESTONE });

        const pushes = sync.__records.filter(r => r.name === 'sightings' && r.op === 'push');
        assert.equal(pushes.length, 1);
        assert.equal(pushes[0].record.tuneID, '42');
    });

    await test('nothing is pushed while signed out', async () => {
        const { store, sync } = await loadStore();
        await store.addSighting({ tuneID: '42', fix: COBBLESTONE });
        await store.upsertLiveSession({ id: 's1', startedAt: 1, tunes: [] });
        assert.deepEqual(sync.__records, []);
    });

    await test('naming a place pushes the place AND the sightings it adopted', async () => {
        const { store, sync } = await signedInStore();
        await store.addSighting({ tuneID: '1', fix: NEARBY, timestamp: 1000 });
        await store.addSighting({ tuneID: '2', fix: STOCKHOLM, timestamp: 2000 });
        sync.__reset();

        await store.namePlace({ name: 'The Cobblestone', ...COBBLESTONE });

        const places = sync.__records.filter(r => r.name === 'places');
        assert.equal(places.length, 1, 'the place itself');
        const sightings = sync.__records.filter(r => r.name === 'sightings');
        assert.equal(sightings.length, 1,
            'and only the sighting whose placeID actually changed');
        assert.equal(sightings[0].record.tuneID, '1');
        assert.ok(sightings[0].record.placeID, 'carrying its new place');
    });

    await test('deleting a place updates its sightings remotely rather than deleting them', async () => {
        const { store, sync } = await signedInStore();
        const place = await store.namePlace({ name: 'The Cobblestone', ...COBBLESTONE });
        await store.addSighting({ tuneID: '42', fix: COBBLESTONE });
        sync.__reset();

        await store.deletePlace(place.id);

        assert.deepEqual(
            sync.__records.filter(r => r.name === 'places').map(r => r.op),
            ['delete'],
        );
        const sightings = sync.__records.filter(r => r.name === 'sightings');
        assert.deepEqual(sightings.map(r => r.op), ['push'],
            'an observation survives its label being deleted, here as much as locally');
        assert.equal(sightings[0].record.placeID, null);
    });

    await test('un-tagging a tune from a place deletes exactly those sightings', async () => {
        const { store, sync } = await signedInStore();
        const place = await store.namePlace({ name: 'The Cobblestone', ...COBBLESTONE });
        await store.addSighting({ tuneID: '42', fix: COBBLESTONE, timestamp: 1000 });
        await store.addSighting({ tuneID: '42', fix: COBBLESTONE, timestamp: 500_000 });
        await store.addSighting({ tuneID: '77', fix: COBBLESTONE, timestamp: 900_000 });
        sync.__reset();

        const removed = await store.removeTuneFromPlace('42', place.id);

        const deletes = sync.__records.filter(r => r.op === 'delete' && r.name === 'sightings');
        assert.equal(deletes.length, 2);
        assert.deepEqual(
            new Set(deletes.map(d => d.id)),
            new Set(removed.map(r => r.id)),
        );
    });

    await test('undo pushes the restored hearings back up', async () => {
        const { store, sync } = await signedInStore();
        const place = await store.namePlace({ name: 'The Cobblestone', ...COBBLESTONE });
        await store.addSighting({ tuneID: '42', fix: COBBLESTONE, timestamp: 1000 });
        const removed = await store.removeTuneFromPlace('42', place.id);
        sync.__reset();

        await store.restoreSightings(removed);

        const pushes = sync.__records.filter(r => r.op === 'push' && r.name === 'sightings');
        assert.equal(pushes.length, 1);
        assert.equal(pushes[0].record.id, removed[0].id);
    });

    await test('clearing reads the ids before wiping, so the remote copies go too', async () => {
        const { store, sync } = await signedInStore();
        await store.namePlace({ name: 'The Cobblestone', ...COBBLESTONE });
        await store.addSighting({ tuneID: '42', fix: COBBLESTONE, timestamp: 1000 });
        await store.addSighting({ tuneID: '77', fix: COBBLESTONE, timestamp: 900_000 });
        sync.__reset();

        await store.clearSightings();

        assert.equal(
            sync.__records.filter(r => r.op === 'delete' && r.name === 'sightings').length, 2);
        assert.equal(
            sync.__records.filter(r => r.op === 'delete' && r.name === 'places').length, 1);
    });

    await test('a live session is pushed on every save and deleted on delete', async () => {
        const { store, sync } = await signedInStore();
        await store.upsertLiveSession({ id: 's1', startedAt: 10, tunes: [{ tuneId: 1 }] });
        await store.upsertLiveSession({ id: 's1', startedAt: 10, tunes: [{ tuneId: 1 }, { tuneId: 2 }] });
        assert.equal(sync.__records.filter(r => r.op === 'push').length, 2,
            'each save pushes the one document, not the whole history');

        sync.__reset();
        await store.deleteLiveSession('s1');
        assert.deepEqual(sync.__records, [{ op: 'delete', name: 'liveSessions', id: 's1' }]);
    });

    await test('clearing sessions deletes each of them remotely', async () => {
        const { store, sync } = await signedInStore();
        await store.upsertLiveSession({ id: 's1', startedAt: 1, tunes: [] });
        await store.upsertLiveSession({ id: 's2', startedAt: 2, tunes: [] });
        sync.__reset();

        await store.clearLiveSessions();
        assert.deepEqual(
            new Set(sync.__records.map(r => r.id)),
            new Set(['s1', 's2']),
        );
    });

    await test('a restored backup is pushed up rather than left on this device', async () => {
        const { store, sync } = await signedInStore();
        await store.importUserData(JSON.stringify({
            version: 5,
            historyItems: [],
            favouriteItems: [],
            tuneSightings: [{ id: 'sight-1', tuneID: '42', timestamp: 1 }],
            places: [{ id: 'place-1', name: 'A', lat: 1, lon: 2 }],
            liveSessions: [{ id: 'sess-1', startedAt: 1, tunes: [] }],
        }));

        for (const name of ['sightings', 'places', 'liveSessions']) {
            assert.equal(
                sync.__records.filter(r => r.op === 'push' && r.name === name).length, 1,
                `${name} reached the other devices`);
        }
    });

    console.log('\nstore.js — merging what arrives from another device');

    await test('a remote record is merged into the local log', async () => {
        const { store, sync } = await signedInStore();
        await store.addSighting({ tuneID: 'local', fix: COBBLESTONE, timestamp: 1000 });

        await applyRemote(sync, 'sightings', [
            { id: 'remote-1', tuneID: 'remote', timestamp: 2000, placeID: null },
        ], []);

        const ids = (await store.getSightings()).map(s => s.tuneID);
        assert.deepEqual(new Set(ids), new Set(['local', 'remote']),
            'the other device adds to this one rather than replacing it');
    });

    await test('a remote removal removes the local copy', async () => {
        const { store, sync } = await signedInStore();
        const sighting = await store.addSighting({ tuneID: '42', fix: COBBLESTONE, timestamp: 1000 });

        await applyRemote(sync, 'sightings', [], [sighting.id]);

        assert.deepEqual(await store.getSightings(), []);
    });

    await test('a remote update replaces the record with the same id', async () => {
        const { store, sync } = await signedInStore();
        const sighting = await store.addSighting({ tuneID: '42', fix: COBBLESTONE, timestamp: 1000 });

        await applyRemote(sync, 'sightings', [
            { ...sighting, placeID: 'place-from-the-other-device' },
        ], []);

        const stored = await store.getSightings();
        assert.equal(stored.length, 1, 'merged by id rather than appended');
        assert.equal(stored[0].placeID, 'place-from-the-other-device');
    });

    await test('merging applies the local cap without deleting anything remotely', async () => {
        const { store, sync } = await signedInStore();
        // 5001 records arriving at a store capped at 5000. The oldest falls off
        // THIS device's copy; nothing is deleted for the other device, which
        // may be showing them right now.
        const incoming = Array.from({ length: 5001 }, (_, i) => ({
            id: `s${i}`, tuneID: '1', timestamp: i,
        }));
        sync.__reset();
        await applyRemote(sync, 'sightings', incoming, []);

        const stored = await store.getSightings();
        assert.equal(stored.length, 5000, 'the local cap still holds');
        assert.equal(stored[0].id, 's5000', 'newest first');
        assert.equal(sync.__records.length, 0,
            'pruning is a local storage decision and must never propagate as a delete');
    });

    await test('places are never capped away, since sightings point at them', async () => {
        const { store, sync } = await signedInStore();
        const incoming = Array.from({ length: 400 }, (_, i) => ({
            id: `p${i}`, name: `Place ${i}`, lat: 1, lon: 2, createdAt: i,
        }));
        await applyRemote(sync, 'places', incoming, []);
        assert.equal((await store.getPlaces()).length, 400);
    });

    await test('sessions arriving from the phone show up in Past Sessions', async () => {
        const { store, sync } = await signedInStore();
        await applyRemote(sync, 'liveSessions', [
            { id: 'from-phone', startedAt: 5000, endedAt: 6000, tunes: [{ tuneId: 1, title: 'The Kesh' }] },
        ], []);

        const sessions = await store.getLiveSessions();
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].tunes[0].title, 'The Kesh');
    });

    console.log('\nstore.js — overlapping writes to one collection');

    await test('two saves at the same moment do not lose one', async () => {
        const { store } = await signedInStore();

        // read → modify → write is not atomic against IndexedDB. Unserialised,
        // both of these read the same array before either writes, and whichever
        // commits second silently discards the other. The analysis loop
        // checkpointing while a remote snapshot merges is exactly this.
        await Promise.all([
            store.upsertLiveSession({ id: 'A', startedAt: 1, tunes: [] }),
            store.upsertLiveSession({ id: 'B', startedAt: 2, tunes: [] }),
        ]);

        assert.deepEqual(
            new Set((await store.getLiveSessions()).map(s => s.id)),
            new Set(['A', 'B']),
            'the later write must not be built on a copy that predates the earlier one',
        );
    });

    await test('signing out stops the collection listeners', async () => {
        const { store, sync } = await signedInStore();
        assert.equal(sync.__subs.length, 3, 'places, sightings and sessions');
        store.onSignedOut();
        await store.addSighting({ tuneID: '42', fix: COBBLESTONE });
        assert.deepEqual(sync.__records, [], 'and nothing is pushed after');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    await rm(tmpDir, { recursive: true, force: true });
    if (failed) process.exit(1);
}

// --- store harness ----------------------------------------------------------

const FAKE_SYNC = `
export const __pushes = [];
export const __records = [];
export const __subs = [];
export function pushFavourites(uid, items) { __pushes.push(items); }
export function subscribe() { return () => {}; }
export function subscribeCollection(uid, name, handlers) {
    const sub = { uid, name, handlers, active: true };
    __subs.push(sub);
    return () => { sub.active = false; };
}
export function pushRecord(uid, name, record) { __records.push({ op: 'push', name, record }); }
export function pushRecords(uid, name, records) {
    for (const record of records) __records.push({ op: 'push', name, record });
}
export function deleteRecord(uid, name, id) { __records.push({ op: 'delete', name, id }); }
export function deleteRecords(uid, name, ids) {
    for (const id of ids) __records.push({ op: 'delete', name, id });
}
export function __reset() { __pushes.length = 0; __records.length = 0; }
`;

const STORE_FAKES = {
    // Yields before reading and before committing, as a real IndexedDB
    // transaction does. Without that gap two overlapping read-modify-writes
    // never actually interleave and a serialisation test passes against
    // unserialised code.
    'fake-idb.mjs': `
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
export const __db = new Map();
export async function get(key) { await tick(); return __db.get(key); }
export async function set(key, value) { await tick(); __db.set(key, value); }
export async function del(key) { await tick(); __db.delete(key); }
`,
    'fake-sync.mjs': FAKE_SYNC,
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
    'fake-firebase-analytics.mjs': `export function logEvent() {}`,
};

class FakeLocalStorage {
    constructor() { this.map = new Map(); }
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
    setItem(key, value) { this.map.set(key, String(value)); }
    removeItem(key) { this.map.delete(key); }
}

async function loadStore() {
    await writeSharedFakes();
    for (const [name, source] of Object.entries(STORE_FAKES)) {
        await writeFile(path.join(tmpDir, name), source);
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
    globalThis.localStorage.setItem('userSettings', JSON.stringify({ geoTagDetections: true }));

    const idb = await import(path.join(tmpDir, 'fake-idb.mjs'));
    idb.__db.clear();
    const sync = await import(path.join(tmpDir, 'fake-sync.mjs'));
    sync.__reset();
    sync.__subs.length = 0;

    const mod = await import(`${path.join(tmpDir, 'store.mjs')}?v=${Math.random()}`);
    return { store: mod.default, sync, idb };
}

async function signedInStore() {
    const { store, sync, idb } = await loadStore();
    await store.onSignedIn({ uid: 'u1' });
    sync.__reset();
    return { store, sync, idb };
}

// Drives the handler the store registered for one collection, as a snapshot
// from another device would.
function applyRemote(sync, name, upserts, removals) {
    const sub = sync.__subs.find(s => s.name === name && s.active);
    assert.ok(sub, `no active listener for ${name}`);
    return sub.handlers.applyRemote(upserts, removals);
}

const COBBLESTONE = { lat: 53.3489, lon: -6.2795 };
const NEARBY = { lat: 53.3494, lon: -6.2795 };
const STOCKHOLM = { lat: 59.3293, lon: 18.0686 };

run().catch(e => {
    console.error(e);
    process.exit(1);
});
