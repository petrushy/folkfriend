// Unit tests for the offline tune-index cache and its network layer.
//
// Run with:  node app/test/tune-index-cache.test.mjs
//
// These two modules are the whole reason the app works on a plane, so they are
// tested directly rather than through the browser. The modules are loaded from
// source with their imports rewritten to in-memory fakes, so no browser, no
// IndexedDB and no network are required.
//
// The index is stored as one payload per dataset. The invariant these tests
// exist to defend is therefore stronger than it used to be:
//
//   P1 — PER DATASET. If a usable offline copy of dataset D existed before an
//   operation, one exists after it, wherever the operation died and whatever
//   the operation was ABOUT. In particular an operation concerning dataset E
//   must not touch D at all.
//
// The unscoped delete is the bug class the split introduces, and the
// fault-injection walk below is aimed squarely at it.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src', 'services');
const tmpDir = path.join(here, '.tmp-tune-index-cache');

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

// --- in-memory idb-keyval -------------------------------------------------

const fakeIdbSource = `
export const __db = new Map();
export const __state = {
    failOn: null, throwOn: null, failAtOp: null, ops: 0,
    // How many times failOn/throwOn actually matched a key. Fault injection
    // here targets keys BY NAME, and the keys are now namespaced per dataset
    // ('ffIndexRaw:thesession'). A test that names a key which no longer
    // exists injects nothing and then passes while testing nothing, which is
    // worse than failing — so every fault-injection test asserts it fired.
    failOnHits: 0, throwOnHits: 0,
};

// Every mutating operation is counted, so a test can fail the Nth one and walk
// the failure point across the whole write sequence. IndexedDB set() is a
// single transaction — it commits or aborts — so a simulated failure leaves the
// store exactly as it was, matching the real thing.
function tick() {
    __state.ops += 1;
    if (__state.failAtOp !== null && __state.ops === __state.failAtOp) {
        const e = new Error('simulated interruption at op ' + __state.ops);
        e.simulated = true;
        throw e;
    }
}
export async function get(key) {
    if (__state.throwOn === key) {
        __state.throwOnHits += 1;
        throw new Error('simulated read failure');
    }
    return __db.get(key);
}
export async function set(key, value) {
    if (__state.failOn === key) {
        __state.failOnHits += 1;
        throw new Error('QuotaExceededError (simulated)');
    }
    tick();
    __db.set(key, value);
}
export async function del(key) { tick(); __db.delete(key); }
`;

async function loadModule(filename, replacements) {
    let source = await readFile(path.join(srcDir, filename), 'utf8');
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in ${filename}`);
        source = source.split(from).join(to);
    }
    const out = path.join(tmpDir, filename.replace('.js', '.mjs'));
    await writeFile(out, source);
    // Cache-bust so each test can load a fresh module graph.
    return import(`${out}?v=${Math.random()}`);
}

async function loadStore() {
    await writeFile(path.join(tmpDir, 'fake-idb.mjs'), fakeIdbSource);
    const store = await loadModule('tuneIndexStore.js', [
        ["from 'idb-keyval'", "from './fake-idb.mjs'"],
    ]);
    const idb = await import(path.join(tmpDir, 'fake-idb.mjs'));
    // fake-idb is a singleton across loads — reset it so tests are independent.
    idb.__db.clear();
    idb.__state.failOn = null;
    idb.__state.throwOn = null;
    idb.__state.failAtOp = null;
    idb.__state.ops = 0;
    idb.__state.failOnHits = 0;
    idb.__state.throwOnHits = 0;
    return { store, idb };
}

async function loadNetwork() {
    return loadModule('tuneIndexNetwork.js', [
        ['process.env.NODE_ENV', "'test'"],
    ]);
}

// Pad a payload out past MIN_PLAUSIBLE_SETTINGS.
//
// readDataset refuses a payload that is not plausibly a tune index at all (see
// indexPayloadProblem in tuneIndexStore.js), because "parses as JSON" does not
// distinguish the dataset from an error document or a captive portal's reply —
// and accepting one of those overwrote the user's only working copy. A
// two-entry object is indistinguishable from those; a real dataset carries
// thousands of settings. The identifying entries below are what the assertions
// use; the filler only makes the payload plausible.
function padded(settings, aliases, idBase) {
    for (let i = 0; i < 150; i++) {
        settings[String(idBase + i)] = {
            tune_id: String(idBase + i), abc: `FILLER-${i}`, contour: 'vtvt',
        };
        aliases[String(idBase + i)] = [`Filler ${i}`];
    }
    return JSON.stringify({ settings, aliases });
}

// One payload per dataset, each with its own identifying setting so a test can
// tell which dataset a read actually returned.
const PAYLOAD = {
    thesession: padded({
        '101': { tune_id: '7', abc: 'ABC-ONE', contour: 'tttt' },
        '102': { tune_id: '7', abc: 'ABC-TWO', contour: 'vvvv' },
    }, { '7': ['The Kesh'] }, 1000),
    folkwiki: padded({
        '2000101': { tune_id: '1000101', abc: 'FW-ABC', contour: 'qqqq',
            source_url: 'http://folkwiki/1' },
    }, { '1000101': ['Polska'] }, 2_100_000),
    norbeck: padded({
        '8001472672': { tune_id: '3001472672', abc: 'HN-ABC', contour: 'wwww',
            source_url: 'https://www.norbeck.nu/abc/display.asp?rhythm=reel&ref=1' },
    }, { '3001472672': ['Flogging Reel, The'] }, 8_100_000),
};

const MARKER = {
    thesession: ['101', 'ABC-ONE'],
    folkwiki: ['2000101', 'FW-ABC'],
    norbeck: ['8001472672', 'HN-ABC'],
};

const ALL = ['thesession', 'folkwiki', 'norbeck'];

async function seedAll(store, v = 1) {
    for (const id of ALL) {
        await store.writeDataset(id, PAYLOAD[id], { v, date: '2026-01-01' });
    }
}

// Read dataset `id` back off disk and assert it is complete and is really that
// dataset, not another one that happened to land under the same key.
async function assertIntact(store, id, context) {
    const part = await store.readDataset(id);
    assert.ok(part, `${context}: ${id} lost its offline copy`);
    const [settingID, abc] = MARKER[id];
    assert.equal(part.index.abcStrings[settingID], abc,
        `${context}: ${id}'s payload is incomplete or is a different dataset`);
    return part;
}

console.log('\ntuneIndexStore — per-dataset storage');

await mkdir(tmpDir, { recursive: true });

await test('splitIndexPayload strips abc + source_url and collects tune ids', async () => {
    const { store } = await loadStore();
    const { indexData, abcStrings, sourceUrls, tuneIDs } =
        store.splitIndexPayload(JSON.parse(PAYLOAD.folkwiki));
    assert.equal(abcStrings['2000101'], 'FW-ABC');
    assert.equal(sourceUrls['2000101'], 'http://folkwiki/1');
    assert.equal(indexData.settings['2000101'].abc, '');
    assert.ok(!('source_url' in indexData.settings['2000101']));
    // tuneIDs is what lets the worker label each tune with its dataset, which
    // replaced inferring the source from the numeric ID range.
    assert.ok(tuneIDs instanceof Set);
    assert.ok(tuneIDs.has('1000101'));
});

await test('write then read round-trips a dataset and its version', async () => {
    const { store } = await loadStore();
    const manifest = await store.writeDataset(
        'thesession', PAYLOAD.thesession, { v: 2345, date: '2026-07-01' });
    assert.equal(manifest.v, 2345);
    assert.equal(manifest.dataset, 'thesession');
    assert.equal(manifest.schema, 3);
    assert.equal(manifest.bytes, PAYLOAD.thesession.length);

    const result = await store.readDataset('thesession');
    assert.ok(result, 'expected an offline copy');
    assert.equal(result.id, 'thesession');
    assert.equal(result.manifest.v, 2345);
    assert.equal(result.index.abcStrings['101'], 'ABC-ONE');
    assert.equal(result.index.indexData.settings['101'].abc, '');
});

await test('datasets are stored under their own namespaced keys', async () => {
    const { store, idb } = await loadStore();
    await seedAll(store);
    for (const id of ALL) {
        assert.ok(idb.__db.has(`ffIndexRaw:${id}`), `no payload key for ${id}`);
        assert.ok(idb.__db.has(`ffIndexManifest:${id}`), `no manifest key for ${id}`);
    }
    // The schema-2 merged keys must not be touched by per-dataset writes.
    assert.equal(idb.__db.has('ffIndexRaw'), false);
    assert.equal(idb.__db.has('ffIndexManifest'), false);
});

await test('readDatasets reports what is present and what is missing', async () => {
    const { store } = await loadStore();
    await store.writeDataset('thesession', PAYLOAD.thesession, { v: 1 });
    await store.writeDataset('norbeck', PAYLOAD.norbeck, { v: 1 });

    const { parts, missing } = await store.readDatasets(ALL);
    assert.deepEqual(parts.map(p => p.id), ['thesession', 'norbeck']);
    assert.deepEqual(missing, ['folkwiki']);
});

// THE important property: an update that fails must never cost the user the
// copy they already had. They discover the loss next time they are offline,
// which is precisely when they cannot recover it.
await test('a failed update PRESERVES that dataset\'s existing copy', async () => {
    const { store, idb } = await loadStore();
    await store.writeDataset('thesession', PAYLOAD.thesession, { v: 100 });

    idb.__state.failOn = 'ffIndexRaw:thesession';
    await assert.rejects(() => store.writeDataset(
        'thesession', '{"settings":{},"aliases":{}}', { v: 101 }));
    assert.ok(idb.__state.failOnHits > 0, 'the injected fault never fired');
    idb.__state.failOn = null;

    const still = await store.readDataset('thesession');
    assert.ok(still, 'the previous copy must survive a failed update');
    assert.equal(still.manifest.v, 100, 'and keep its version');
    assert.equal(still.index.abcStrings['101'], 'ABC-ONE');
});

await test('an interrupted update (payload written, manifest not) keeps the data', async () => {
    const { store, idb } = await loadStore();
    await store.writeDataset('thesession', PAYLOAD.thesession, { v: 100 });

    // Payload commits, then the process dies before the manifest is written.
    idb.__state.failOn = 'ffIndexManifest:thesession';
    await assert.rejects(() => store.writeDataset(
        'thesession', PAYLOAD.thesession, { v: 101 }));
    assert.ok(idb.__state.failOnHits > 0, 'the injected fault never fired');
    idb.__state.failOn = null;

    const after = await store.readDataset('thesession');
    assert.ok(after, 'data must remain usable after an interrupted write');
    assert.equal(after.index.abcStrings['101'], 'ABC-ONE');
});

await test('a payload with no manifest at all is used, not deleted', async () => {
    const { store, idb } = await loadStore();
    await store.writeDataset('folkwiki', PAYLOAD.folkwiki, { v: 7 });
    idb.__db.delete('ffIndexManifest:folkwiki');   // e.g. selective eviction

    const result = await store.readDataset('folkwiki');
    assert.ok(result, 'a parseable payload is usable even with no manifest');
    assert.equal(result.manifest.versionUnknown, true,
        'version reported unknown so an update is attempted when online');
    assert.equal(idb.__db.has('ffIndexRaw:folkwiki'), true,
        'payload must NOT be deleted');
});

await test('a manifest describing a different payload still yields the data', async () => {
    const { store, idb } = await loadStore();
    await store.writeDataset('folkwiki', PAYLOAD.folkwiki, { v: 7 });
    idb.__db.set('ffIndexManifest:folkwiki',
        { schema: 3, dataset: 'folkwiki', v: 6, savedAt: 1, bytes: 999999 });

    const result = await store.readDataset('folkwiki');
    assert.ok(result, 'mismatched bookkeeping must not discard good data');
    assert.equal(result.manifest.versionUnknown, true);
    assert.equal(result.index.abcStrings['2000101'], 'FW-ABC');
});

await test('a manifest without its payload drops only the dangling record', async () => {
    const { store, idb } = await loadStore();
    await seedAll(store);
    idb.__db.delete('ffIndexRaw:folkwiki');
    assert.equal(await store.readDataset('folkwiki'), null);
    assert.equal(idb.__db.has('ffIndexManifest:folkwiki'), false);
    // ...and the other datasets are untouched.
    await assertIntact(store, 'thesession', 'dangling folkwiki manifest');
    await assertIntact(store, 'norbeck', 'dangling folkwiki manifest');
});

await test('unparseable payload is discarded rather than thrown', async () => {
    const { store, idb } = await loadStore();
    await seedAll(store);
    idb.__db.set('ffIndexRaw:folkwiki', '{ this is not json');
    assert.equal(await store.readDataset('folkwiki'), null);
    assert.equal(idb.__db.has('ffIndexRaw:folkwiki'), false);
    await assertIntact(store, 'thesession', 'corrupt folkwiki payload');
    await assertIntact(store, 'norbeck', 'corrupt folkwiki payload');
});

await test('reads never throw, even when IndexedDB itself fails', async () => {
    const { store, idb } = await loadStore();
    idb.__state.throwOn = 'ffIndexManifest:thesession';
    assert.equal(await store.readDataset('thesession'), null);
    assert.ok(idb.__state.throwOnHits > 0, 'the injected fault never fired');
    const inventory = await store.readOfflineInventory(ALL);
    assert.equal(inventory.datasets.thesession, null);
});

await test('a payload that is not a tune index is deleted only when it is ours', async () => {
    // Provenance gate: we delete a structurally-wrong payload only when the
    // manifest says this build's schema wrote it AND that it is this dataset.
    // Anything else may be a NEWER format a later release wrote.
    const notAnIndex = JSON.stringify({ error: 'nope' });

    const ours = await loadStore();
    await ours.store.writeDataset('folkwiki', PAYLOAD.folkwiki, { v: 1 });
    ours.idb.__db.set('ffIndexRaw:folkwiki', notAnIndex);
    assert.equal(await ours.store.readDataset('folkwiki'), null);
    assert.equal(ours.idb.__db.has('ffIndexRaw:folkwiki'), false,
        'a bad payload written by our own schema should be cleaned up');

    const theirs = await loadStore();
    theirs.idb.__db.set('ffIndexRaw:folkwiki', notAnIndex);
    theirs.idb.__db.set('ffIndexManifest:folkwiki',
        { schema: 99, dataset: 'folkwiki', v: 1 });
    assert.equal(await theirs.store.readDataset('folkwiki'), null);
    assert.equal(theirs.idb.__db.has('ffIndexRaw:folkwiki'), true,
        'a payload from an unknown schema is not ours to destroy');

    const mislabelled = await loadStore();
    mislabelled.idb.__db.set('ffIndexRaw:folkwiki', notAnIndex);
    mislabelled.idb.__db.set('ffIndexManifest:folkwiki',
        { schema: 3, dataset: 'something-else', v: 1 });
    assert.equal(await mislabelled.store.readDataset('folkwiki'), null);
    assert.equal(mislabelled.idb.__db.has('ffIndexRaw:folkwiki'), true,
        'a key claimed by another dataset is not ours to destroy');
});

await test('an orphaned payload is adopted rather than binned', async () => {
    const { store, idb } = await loadStore();
    idb.__db.set('ffIndexRaw:norbeck', PAYLOAD.norbeck); // write that died early
    const result = await store.readDataset('norbeck');
    assert.ok(result, "orphaned but valid data is still the user's offline copy");
    assert.equal(idb.__db.has('ffIndexRaw:norbeck'), true);
});

console.log('\ntuneIndexStore — migration from the merged blob');

await test('the schema-2 merged blob is readable and names its datasets', async () => {
    const { store, idb } = await loadStore();
    idb.__db.set('ffIndexRaw', PAYLOAD.thesession);
    idb.__db.set('ffIndexManifest',
        { schema: 2, v: 2299, date: '2026-04-17', bytes: PAYLOAD.thesession.length });

    const merged = await store.readMergedLegacyIndex();
    assert.ok(merged, 'the merged blob must keep working while migration runs');
    assert.equal(merged.manifest.v, 2299);
    assert.equal(merged.manifest.merged, true);
    assert.deepEqual(merged.datasets, ['thesession', 'folkwiki']);
    assert.equal(merged.index.abcStrings['101'], 'ABC-ONE');
    assert.ok(merged.index.tuneIDs.has('7'));
});

await test('the schema-1 legacy blob is still readable — no forced re-download', async () => {
    const { store, idb } = await loadStore();
    idb.__db.set('tuneIndex', {
        indexData: { settings: { '101': { tune_id: '7', abc: '' } }, aliases: {} },
        abcStrings: { '101': 'LEGACY-ABC' },
        sourceUrls: {},
    });
    idb.__db.set('tuneIndexMetadata', { v: 999, date: '2025-01-01' });

    const result = await store.readMergedLegacyIndex();
    assert.ok(result, 'legacy cache must still load');
    assert.equal(result.manifest.legacy, true);
    assert.equal(result.manifest.v, 999);
    assert.equal(result.index.abcStrings['101'], 'LEGACY-ABC');
    // Schema 1 never persisted tuneIDs; they are derived so a legacy blob
    // labels its tunes the same way a fresh dataset does.
    assert.ok(result.index.tuneIDs.has('7'));

    const inventory = await store.readOfflineInventory(ALL);
    assert.equal(inventory.legacy.legacy, true);
});

// This test INVERTS the old "a successful schema-2 write reclaims the legacy
// copy" rule, and the inversion is the point. The merged blob covers two
// datasets; one per-dataset write covers one. Dropping it on the first write
// would delete data nothing has replaced yet.
await test('a per-dataset write does NOT reclaim the merged copy', async () => {
    const { store, idb } = await loadStore();
    idb.__db.set('ffIndexRaw', PAYLOAD.thesession);
    idb.__db.set('ffIndexManifest', { schema: 2, v: 1 });

    await store.writeDataset('thesession', PAYLOAD.thesession, { v: 2 });
    assert.equal(idb.__db.has('ffIndexRaw'), true,
        'folkwiki still lives only in the merged blob; it must not be deleted');
});

await test('the merged copy is reclaimed only once its datasets are covered', async () => {
    const { store, idb } = await loadStore();
    idb.__db.set('ffIndexRaw', PAYLOAD.thesession);
    idb.__db.set('ffIndexManifest', { schema: 2, v: 1 });
    idb.__db.set('tuneIndex', { indexData: {}, abcStrings: {} });
    idb.__db.set('tuneIndexMetadata', { v: 1 });

    assert.equal(await store.clearSupersededMergedCopies(['thesession']), false,
        'partial coverage must not reclaim the merged blob');
    assert.equal(idb.__db.has('ffIndexRaw'), true);

    assert.equal(
        await store.clearSupersededMergedCopies(['thesession', 'folkwiki']), true);
    assert.equal(idb.__db.has('ffIndexRaw'), false);
    assert.equal(idb.__db.has('ffIndexManifest'), false);
    assert.equal(idb.__db.has('tuneIndex'), false);
    assert.equal(idb.__db.has('tuneIndexMetadata'), false);
});

await test('reclaiming the merged copy never touches per-dataset copies', async () => {
    const { store } = await loadStore();
    await seedAll(store);
    await store.clearSupersededMergedCopies(ALL);
    for (const id of ALL) {
        await assertIntact(store, id, 'after reclaiming the merged blob');
    }
});

console.log('\ntuneIndexStore — exhaustive fault injection');

// The bug that stranded a user in a pub with no signal was not caught by any
// hand-written test, because the tests asserted the implementation's behaviour
// rather than the property that matters. These walk a failure across EVERY
// storage operation in an update and assert P1 directly — including that the
// OTHER datasets, which the update was not about, are untouched.

const NEWER = padded(
    { '201': { tune_id: '9', abc: 'NEW-ABC', contour: 'qqqq' } },
    { '9': ['A Newer Tune'] }, 5000);

await test('every dataset survives an interruption at EVERY step of an update', async () => {
    // Discover how many operations a successful update takes.
    const probe = await loadStore();
    await probe.store.writeDataset('folkwiki', PAYLOAD.folkwiki, { v: 1 });
    probe.idb.__state.ops = 0;
    await probe.store.writeDataset('folkwiki', NEWER, { v: 2 });
    const totalOps = probe.idb.__state.ops;
    assert.ok(totalOps >= 2, `expected several ops, saw ${totalOps}`);

    for (let failAt = 1; failAt <= totalOps; failAt++) {
        const { store, idb } = await loadStore();
        await seedAll(store);

        idb.__state.ops = 0;
        idb.__state.failAtOp = failAt;
        try {
            await store.writeDataset('folkwiki', NEWER, { v: 2 });
        } catch (e) {
            if (!e.simulated) throw e;   // a real bug, not our injected fault
        }
        idb.__state.failAtOp = null;

        // The dataset being updated must still have a complete copy — either
        // the old one or the new one, but never half of either.
        const fw = await store.readDataset('folkwiki');
        assert.ok(fw,
            `interrupting at op ${failAt}/${totalOps} destroyed folkwiki`);
        assert.ok(fw.index.abcStrings['2000101'] || fw.index.abcStrings['201'],
            `interrupting at op ${failAt} left an incomplete folkwiki payload`);

        // ...and the datasets the update was not about must be untouched.
        await assertIntact(store, 'thesession', `interrupted at op ${failAt}`);
        await assertIntact(store, 'norbeck', `interrupted at op ${failAt}`);
    }
    console.log(`      ${totalOps} interruption points, all datasets survived each`);
});

await test('a quota failure on any single key costs no dataset its copy', async () => {
    for (const key of ['ffIndexRaw:folkwiki', 'ffIndexManifest:folkwiki']) {
        const { store, idb } = await loadStore();
        await seedAll(store);

        idb.__state.failOn = key;
        await assert.rejects(() => store.writeDataset('folkwiki', NEWER, { v: 2 }));
        assert.ok(idb.__state.failOnHits > 0,
            `the injected fault on ${key} never fired — is the key name still right?`);
        idb.__state.failOn = null;

        const fw = await store.readDataset('folkwiki');
        assert.ok(fw, `a quota failure on ${key} destroyed folkwiki`);
        assert.ok(fw.index.abcStrings['2000101'] || fw.index.abcStrings['201'],
            `a quota failure on ${key} left an incomplete payload`);
        await assertIntact(store, 'thesession', `quota failure on ${key}`);
        await assertIntact(store, 'norbeck', `quota failure on ${key}`);
    }
});

await test('repeated failed updates never erode any copy', async () => {
    const { store, idb } = await loadStore();
    await seedAll(store);
    for (let i = 0; i < 25; i++) {
        idb.__state.failAtOp = (i % 3) + 1;
        try { await store.writeDataset('folkwiki', NEWER, { v: 2 + i }); }
        catch (e) { if (!e.simulated) throw e; }
        idb.__state.failAtOp = null;
        assert.ok(await store.readDataset('folkwiki'),
            `folkwiki lost after ${i + 1} failed updates`);
        await assertIntact(store, 'thesession', `after ${i + 1} failed updates`);
        await assertIntact(store, 'norbeck', `after ${i + 1} failed updates`);
    }
});

await test('a fresh install never reports a partial copy as usable', async () => {
    // With no prior copy the invariant is weaker but still absolute: readDataset
    // must return either nothing or something complete — never half a payload.
    for (let failAt = 1; failAt <= 4; failAt++) {
        const { store, idb } = await loadStore();
        idb.__state.failAtOp = failAt;
        try { await store.writeDataset('thesession', PAYLOAD.thesession, { v: 1 }); }
        catch (e) { if (!e.simulated) throw e; }
        idb.__state.failAtOp = null;

        const after = await store.readDataset('thesession');
        if (after) {
            assert.ok(after.index.abcStrings['101'],
                `install interrupted at op ${failAt} was reported usable but is incomplete`);
        }
    }
});

console.log('\ntuneIndexNetwork');

function stubEnv({ onLine = true, fetchImpl }) {
    // navigator is a read-only getter in recent Node versions.
    Object.defineProperty(globalThis, 'navigator', {
        value: { onLine },
        configurable: true,
        writable: true,
    });
    globalThis.fetch = fetchImpl;
}

const MANIFEST_BODY = {
    manifestVersion: 1,
    generated: '2026-08-20',
    datasets: [
        { id: 'thesession', filename: 'thesession.json', v: 2423, size: 34793949 },
        { id: 'folkwiki', filename: 'folkwiki.json', v: 2423, size: 7334194 },
        { id: 'norbeck', filename: 'norbeck.json', v: 2423, size: 3148033 },
    ],
};

function jsonResponse(body) {
    return async () => ({ ok: true, json: async () => body });
}

await test('offline is detected without touching the network', async () => {
    const net = await loadNetwork();
    let called = false;
    stubEnv({ onLine: false, fetchImpl: async () => { called = true; } });
    await assert.rejects(() => net.fetchDatasetsManifest(), /offline/i);
    await assert.rejects(() => net.fetchDatasetText('thesession.json'), /offline/i);
    assert.equal(called, false, 'must not issue a request when known offline');
});

await test('the datasets manifest is parsed into id -> entry', async () => {
    const net = await loadNetwork();
    stubEnv({ onLine: true, fetchImpl: jsonResponse(MANIFEST_BODY) });
    const { byId, order } = await net.fetchDatasetsManifest();
    assert.deepEqual(order, ['thesession', 'folkwiki', 'norbeck']);
    assert.equal(byId.get('folkwiki').filename, 'folkwiki.json');
    assert.equal(byId.get('folkwiki').size, 7334194);
});

await test('a malformed manifest fails loudly rather than meaning "no datasets"', async () => {
    // "We could not find out what to install" and "the CDN publishes nothing"
    // are completely different states; conflating them would silently install
    // nothing and report success.
    const net = await loadNetwork();
    for (const body of [{}, { datasets: [] }, { datasets: 'nope' }, null]) {
        stubEnv({ onLine: true, fetchImpl: jsonResponse(body) });
        await assert.rejects(() => net.fetchDatasetsManifest());
    }
    stubEnv({ onLine: true, fetchImpl: async () => ({ ok: false, status: 404 }) });
    await assert.rejects(() => net.fetchDatasetsManifest(), /404/);
});

await test('entries with unsafe filenames are dropped, not fetched', async () => {
    // The filename comes from the manifest and goes straight into a URL. A
    // garbled or hostile manifest must not be able to repoint a 35 MB download
    // at another origin or walk out of the hosting root.
    const net = await loadNetwork();
    assert.equal(net.safeDatasetFilename('thesession.json'), true);
    assert.equal(net.safeDatasetFilename('../../etc/passwd.json'), false);
    assert.equal(net.safeDatasetFilename('https://evil.example/x.json'), false);
    assert.equal(net.safeDatasetFilename('a/b.json'), false);
    assert.equal(net.safeDatasetFilename('thesession.js'), false);
    assert.equal(net.safeDatasetFilename(''), false);
    assert.equal(net.safeDatasetFilename(null), false);

    stubEnv({
        onLine: true,
        fetchImpl: jsonResponse({
            datasets: [
                { id: 'evil', filename: 'https://evil.example/x.json' },
                { id: 'folkwiki', filename: 'folkwiki.json' },
            ],
        }),
    });
    const { byId } = await net.fetchDatasetsManifest();
    assert.equal(byId.has('evil'), false);
    assert.equal(byId.has('folkwiki'), true);

    assert.throws(() => net.datasetDataUrl('../secret.json'));
});

await test('metadata request aborts on the deadline instead of hanging', async () => {
    const net = await loadNetwork();
    let aborted = false;
    stubEnv({
        onLine: true,
        // A connection that opens and never answers — captive-portal Wi-Fi.
        fetchImpl: (url, opts) => new Promise((_, reject) => {
            opts.signal.addEventListener('abort', () => {
                aborted = true;
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
            });
        }),
    });
    net.TIMEOUTS.METADATA_MS = 60;
    const started = Date.now();
    await assert.rejects(() => net.fetchDatasetsManifest(), /timed out/i);
    assert.equal(aborted, true);
    assert.ok(Date.now() - started < 2000, 'must not wait on the platform default');
});

await test('a dataset download aborts when the stream stalls mid-transfer', async () => {
    const net = await loadNetwork();
    const encoder = new TextEncoder();
    let aborted = false;
    stubEnv({
        onLine: true,
        fetchImpl: async (url, opts) => ({
            ok: true,
            headers: { get: () => '999999' },
            body: {
                getReader() {
                    let sent = false;
                    return {
                        read: () => new Promise((resolve, reject) => {
                            if (!sent) {
                                sent = true;
                                resolve({ done: false, value: encoder.encode('{"settings":') });
                                return;
                            }
                            // ...and then nothing, ever.
                            opts.signal.addEventListener('abort', () => {
                                aborted = true;
                                const err = new Error('aborted');
                                err.name = 'AbortError';
                                reject(err);
                            });
                        }),
                    };
                },
            },
        }),
    });
    net.TIMEOUTS.INDEX_STALL_MS = 80;
    const started = Date.now();
    await assert.rejects(() => net.fetchDatasetText('thesession.json'), /stalled/i);
    assert.equal(aborted, true);
    assert.ok(Date.now() - started < 2000);
});

await test('a healthy streamed download is reassembled and reports progress', async () => {
    const net = await loadNetwork();
    const encoder = new TextEncoder();
    const body = PAYLOAD.thesession;
    const chunks = [body.slice(0, 20), body.slice(20)].map(c => encoder.encode(c));
    let requestedUrl = null;
    stubEnv({
        onLine: true,
        fetchImpl: async (url) => {
            requestedUrl = url;
            return {
                ok: true,
                headers: { get: () => String(encoder.encode(body).length) },
                body: {
                    getReader() {
                        let i = 0;
                        return {
                            read: async () => (i < chunks.length
                                ? { done: false, value: chunks[i++] }
                                : { done: true, value: undefined }),
                        };
                    },
                },
            };
        },
    });
    const progress = [];
    const text = await net.fetchDatasetText('folkwiki.json', null, p => progress.push(p));
    assert.equal(text, body);
    assert.ok(requestedUrl.endsWith('/folkwiki.json'), requestedUrl);
    assert.equal(progress.length, 2);
    assert.equal(progress.at(-1).received, encoder.encode(body).length);
    assert.ok(progress.at(-1).total > 0);
});

await test('cache-busting version is appended only when asked for', async () => {
    const net = await loadNetwork();
    assert.ok(!net.datasetDataUrl('folkwiki.json').includes('?v='));
    assert.ok(net.datasetDataUrl('folkwiki.json', 1234).endsWith('?v=1234'));
    assert.ok(!net.datasetsManifestUrl().includes('?v='));
    assert.ok(net.datasetsManifestUrl(99).endsWith('?v=99'));
});

await rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
