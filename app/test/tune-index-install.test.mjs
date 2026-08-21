// Tests for the INSTALL path: what happens to known-good offline copies when
// an update goes wrong.
//
// Run with:  node app/test/tune-index-install.test.mjs
//
// tune-index-cache.test.mjs already walks a simulated interruption across every
// storage operation and proves that a failed WRITE cannot destroy an offline
// copy. It cannot catch the failure this file is about, because it always
// writes valid data: the hole was a write that SUCCEEDED while carrying a
// payload nobody had established was a usable tune index.
//
// The index is stored one payload per dataset, so the invariants are:
//
//   P1 — PER DATASET. If a usable offline copy of dataset D existed before an
//   operation, one exists after it, wherever the operation died and whatever
//   the operation was about. An operation concerning E must not touch D.
//
//   P2 — COVERAGE. indexUsable is false only when EVERY selected dataset
//   genuinely has no usable copy, or the selection is empty. The searchable set
//   never collapses to empty while a usable copy of any selected dataset exists.
//
//   P3 — MIGRATION. The pre-multi-dataset merged blob is present until every
//   dataset it covers has a committed per-dataset copy that has loaded into
//   WASM, and absent afterwards. There is no state in which both are missing.
//
// This drives the real worker.js (imports rewritten to in-memory fakes) rather
// than a reimplementation of it, because the bug lived entirely in the ORDER of
// four statements. A test that re-stated that order would have passed against
// the broken code.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src', 'services');
const tmpDir = path.join(here, '.tmp-tune-index-install');

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

// --- fakes ----------------------------------------------------------------

// Writes yield before committing, as a real IndexedDB transaction does. Without
// that gap two overlapping installs would appear to interleave safely here and
// the concurrency test would pass against racy code.
const FAKE_IDB = `
const yieldTick = () => new Promise(r => setImmediate(r));
export const __db = new Map();
export async function get(key) { await yieldTick(); return __db.get(key); }
export async function set(key, value) { await yieldTick(); __db.set(key, value); }
export async function del(key) { await yieldTick(); __db.delete(key); }
export async function keys() { return [...__db.keys()]; }
`;

const FAKE_COMLINK = `
export function expose() {}
export function proxy(fn) { return fn; }
export function wrap(x) { return x; }
`;

const FAKE_FFCONFIG = `export default { SPEC_WINDOW_SIZE: 1024 };`;

// Stands in for tuneIndexNetwork.js. Every knob a bad connection can turn,
// now per dataset file.
const FAKE_NETWORK = `
export class NetworkUnavailableError extends Error {
    constructor(m) { super(m); this.name = 'NetworkUnavailableError'; }
}
export const __net = {
    offline: false,
    manifest: null,
    manifestError: null,
    // filename -> body string
    bodies: {},
    // filename -> error message
    bodyErrors: {},
    // When set, a download parks here until the test releases it. Lets a second
    // install be started while the first is provably still in flight.
    gate: null,
    requests: [],
    manifestRequests: 0,
};
export function isDefinitelyOffline() { return !!__net.offline; }
export async function fetchDatasetsManifest(bypassCacheVersion = null) {
    __net.manifestRequests += 1;
    if (__net.offline) throw new NetworkUnavailableError('Device is offline');
    if (__net.manifestError) throw new NetworkUnavailableError(__net.manifestError);
    const byId = new Map();
    const order = [];
    for (const entry of __net.manifest.datasets) {
        byId.set(entry.id, entry);
        order.push(entry.id);
    }
    return { byId, order };
}
export async function fetchUserDatasetText(url, onProgress = null) {
    __net.requests.push({ filename: url, userSupplied: true });
    if (__net.offline) throw new NetworkUnavailableError('Device is offline');
    const body = __net.bodies[url];
    if (__net.gate) await __net.gate;
    if (__net.bodyErrors[url]) {
        throw new NetworkUnavailableError(__net.bodyErrors[url]);
    }
    if (body === undefined) throw new NetworkUnavailableError('HTTP 404');
    if (onProgress) onProgress({ received: body.length, total: body.length });
    return body;
}
export async function fetchDatasetText(filename, bypassCacheVersion = null, onProgress = null) {
    __net.requests.push({ filename, bypassCacheVersion });
    if (__net.offline) throw new NetworkUnavailableError('Device is offline');
    // Captured when the request is made, not when it completes — a response
    // body is decided by the server at the start of the transfer, so a download
    // parked at the gate must not pick up a payload the test set afterwards.
    const body = __net.bodies[filename];
    if (__net.gate) await __net.gate;
    // Read AFTER the gate, deliberately: the response body is decided by the
    // server when the transfer starts, but a connection reset happens partway
    // through — a test must be able to inject one into a parked download.
    if (__net.bodyErrors[filename]) {
        throw new NetworkUnavailableError(__net.bodyErrors[filename]);
    }
    if (body === undefined) throw new NetworkUnavailableError('HTTP 404');
    if (onProgress) onProgress({ received: body.length, total: body.length });
    return body;
}
`;

// Stands in for the WASM module. rejectLoad simulates the Rust side refusing
// every payload (memory pressure, a broken build); rejectDance refuses any
// payload CONTAINING a given tag, which is what an incompatible cached payload
// actually looks like.
//
// It checks every setting rather than just the first: with datasets merged,
// "the first setting" depends on which part was assigned first, so keying off
// it would make this flaky. Note the ABC strings are already stripped by
// splitIndexPayload before this sees them, so the fixture tag has to ride on a
// field the Rust side keeps.
const FAKE_WASM = `
export const __wasm = { rejectLoad: null, rejectDance: null, loaded: null, loadCalls: 0 };
export class FolkFriendWASM {
    version() { return 'test'; }
    async load_index_from_json_obj(indexData) {
        __wasm.loadCalls += 1;
        if (__wasm.rejectLoad) throw new Error(__wasm.rejectLoad);
        if (__wasm.rejectDance) {
            for (const setting of Object.values(indexData.settings || {})) {
                if (setting.dance === __wasm.rejectDance) {
                    throw new Error('unreachable executed (incompatible index)');
                }
            }
        }
        __wasm.loaded = indexData;
    }
    set_sample_rate() { return true; }
    set_use_ml() {}
    async run_name_query() {
        return JSON.stringify(Object.keys((__wasm.loaded || {}).aliases || {})
            .slice(0, 3).map(id => ({ tune_id: id })));
    }
    async run_transcription_query() {
        const settings = (__wasm.loaded || {}).settings || {};
        return JSON.stringify(Object.entries(settings).slice(0, 3)
            .map(([setting_id, setting]) => ({ setting_id, setting })));
    }
    async settings_from_tune_id(tuneID) {
        const settings = (__wasm.loaded || {}).settings || {};
        return JSON.stringify(Object.entries(settings)
            .filter(([, s]) => s.tune_id === String(tuneID)));
    }
}
`;

// --- index fixtures -------------------------------------------------------

// Shaped exactly like the real thing (rust/src/index/schema.rs): tune_id and
// contour are deliberately strings on both sides. Each dataset occupies its own
// ID range, as the real builders guarantee, so a merge is lossless.
const ID_BASE = { thesession: 1000, folkwiki: 2_000_000, norbeck: 8_000_000 };
const TUNE_BASE = { thesession: 0, folkwiki: 1_000_000, norbeck: 3_000_000 };

function makeIndex(dataset, tag, n = 150) {
    const settings = {};
    const aliases = {};
    for (let i = 0; i < n; i++) {
        const tuneID = String(TUNE_BASE[dataset] + i);
        settings[String(ID_BASE[dataset] + i)] = {
            tune_id: tuneID,
            meter: '4/4',
            mode: 'Dmajor',
            abc: `abc-${dataset}-${tag}-${i}`,
            dance: tag,
            contour: 'vtvtvtvt',
            origin: '',
            composer: '',
        };
        aliases[tuneID] = [`Tune ${dataset} ${tag} ${i}`];
    }
    return JSON.stringify({ settings, aliases });
}

const ALL = ['thesession', 'folkwiki', 'norbeck'];
const FILENAME = {
    thesession: 'thesession.json',
    folkwiki: 'folkwiki.json',
    norbeck: 'norbeck.json',
};

const RAW = {};
for (const id of ALL) {
    RAW[id] = { v1: makeIndex(id, 'v1'), v2: makeIndex(id, 'v2'), v3: makeIndex(id, 'v3') };
}

// A dataset file as the data repo stamps it: self-describing, because an
// imported file has no datasets.json entry to describe it.
function makeSelfDescribing(dataset, tag, extra = {}) {
    const payload = JSON.parse(makeIndex(dataset, tag));
    return JSON.stringify({
        ...payload,
        id: dataset,
        label: dataset === 'norbeck' ? 'Norbeck' : dataset,
        v: 42,
        date: '2026-08-21',
        ...extra,
    });
}

// The pre-multi-dataset merged blob: thesession + folkwiki in one document.
function makeMerged(tag) {
    const a = JSON.parse(makeIndex('thesession', tag));
    const b = JSON.parse(makeIndex('folkwiki', tag));
    return JSON.stringify({
        settings: { ...a.settings, ...b.settings },
        aliases: { ...a.aliases, ...b.aliases },
    });
}

// Everything a broken 200 response can plausibly be. Each of these previously
// replaced the user's working offline copy.
const BAD_BODIES = {
    'truncated JSON': RAW.folkwiki.v1.slice(0, RAW.folkwiki.v1.length / 2),
    'an HTML error page served as 200': '<!doctype html><html><body>Sign in to the Wi-Fi</body></html>',
    'a JSON error document': '{"error":"not found","status":404}',
    'nud-meta.json from the wrong path': '{"v":2,"date":"2026-02-01"}',
    'an empty object': '{}',
    'a JSON array': '[]',
    'the string "null"': 'null',
    'an index with no aliases': JSON.stringify({ settings: JSON.parse(RAW.folkwiki.v1).settings, aliases: {} }),
    'a half-built dataset': JSON.stringify({
        settings: Object.fromEntries(Object.entries(JSON.parse(RAW.folkwiki.v1).settings).slice(0, 5)),
        aliases: JSON.parse(RAW.folkwiki.v1).aliases,
    }),
};

// --- module loading -------------------------------------------------------

let storeMod, netMod, wasmMod, idbMod;

async function writeFakes() {
    await writeFile(path.join(tmpDir, 'fake-idb.mjs'), FAKE_IDB);
    await writeFile(path.join(tmpDir, 'fake-comlink.mjs'), FAKE_COMLINK);
    await writeFile(path.join(tmpDir, 'fake-ffconfig.mjs'), FAKE_FFCONFIG);
    await writeFile(path.join(tmpDir, 'fake-network.mjs'), FAKE_NETWORK);
    await writeFile(path.join(tmpDir, 'fake-wasm.mjs'), FAKE_WASM);

    let store = await readFile(path.join(srcDir, 'tuneIndexStore.js'), 'utf8');
    store = replace(store, "from 'idb-keyval'", "from './fake-idb.mjs'");
    await writeFile(path.join(tmpDir, 'tuneIndexStore.mjs'), store);

    let worker = await readFile(path.join(srcDir, 'worker.js'), 'utf8');
    worker = replace(worker, "from '@/js/comlink'", "from './fake-comlink.mjs'");
    worker = replace(worker, "from '@/ffConfig'", "from './fake-ffconfig.mjs'");
    worker = replace(worker, "from '@/services/tuneIndexStore'", "from './tuneIndexStore.mjs'");
    worker = replace(worker, "from '@/services/tuneIndexNetwork'", "from './fake-network.mjs'");
    worker = replace(worker, "import ('@/wasm/folkfriend.js')", "import('./fake-wasm.mjs')");
    // The module ends by handing the instance to Comlink; the test needs it too.
    worker = replace(worker, 'Comlink.expose(folkfriendWASMWrapper);',
        'Comlink.expose(folkfriendWASMWrapper);\nexport const __wrapper = folkfriendWASMWrapper;');
    await writeFile(path.join(tmpDir, 'worker.mjs'), worker);

    // Imported without a cache-buster so the test and the worker share one
    // instance of each fake — otherwise the worker would write into a different
    // in-memory database than the one we assert against.
    idbMod = await import(path.join(tmpDir, 'fake-idb.mjs'));
    netMod = await import(path.join(tmpDir, 'fake-network.mjs'));
    wasmMod = await import(path.join(tmpDir, 'fake-wasm.mjs'));
    storeMod = await import(path.join(tmpDir, 'tuneIndexStore.mjs'));
}

function replace(source, from, to) {
    assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in the source`);
    return source.split(from).join(to);
}

// A fresh worker each time — the state machine is per-instance.
async function newWorker({ autoUpdate = false, datasets = ALL } = {}) {
    const mod = await import(`${path.join(tmpDir, 'worker.mjs')}?v=${Math.random()}`);
    const wrapper = mod.__wrapper;
    await wrapper.loadedWASM;
    wrapper.autoUpdateEnabled = autoUpdate;
    wrapper.selectedDatasets = [...datasets];
    return wrapper;
}

function manifestFor(versions, sizes = {}) {
    return {
        manifestVersion: 1,
        datasets: Object.entries(versions).map(([id, v]) => ({
            id,
            filename: FILENAME[id],
            v,
            date: `2026-0${v}-01`,
            size: sizes[id] !== undefined ? sizes[id] : 1000,
        })),
    };
}

function serve(bodies) {
    for (const [id, body] of Object.entries(bodies)) {
        netMod.__net.bodies[FILENAME[id]] = body;
    }
}

function resetFakes() {
    idbMod.__db.clear();
    Object.assign(netMod.__net, {
        offline: false,
        manifest: manifestFor({ thesession: 1, folkwiki: 1, norbeck: 1 }),
        manifestError: null,
        bodies: {},
        bodyErrors: {},
        gate: null,
        requests: [],
        manifestRequests: 0,
    });
    serve({ thesession: RAW.thesession.v1, folkwiki: RAW.folkwiki.v1, norbeck: RAW.norbeck.v1 });
    Object.assign(wasmMod.__wasm,
        { rejectLoad: null, rejectDance: null, loaded: null, loadCalls: 0 });
}

async function seedGoodCopies(ids = ALL, tag = 'v1', v = 1) {
    for (const id of ids) {
        await storeMod.writeDataset(id, RAW[id][tag], { v, date: '2026-01-01' });
    }
}

// The whole point of the exercise: read what is actually on disk and confirm it
// is a complete, parseable, loadable dataset at the expected version.
async function assertOfflineCopyIs(id, tag, version, context) {
    const cached = await storeMod.readDataset(id);
    assert.ok(cached, `${context}: ${id} has no offline copy at all`);
    assert.equal(cached.manifest.v, version, `${context}: ${id} wrong version on disk`);
    assert.equal(storeMod.indexPayloadProblem(cached.index.indexData), null,
        `${context}: ${id}'s payload on disk is not a usable tune index`);
    const anyAbc = Object.values(cached.index.abcStrings)[0];
    assert.ok(anyAbc.includes(`${id}-${tag}`),
        `${context}: expected the ${id} ${tag} payload, got ${anyAbc}`);
}

async function assertAllIntact(tag, version, context, ids = ALL) {
    for (const id of ids) {
        await assertOfflineCopyIs(id, tag, version, context);
    }
}

async function run() {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFakes();

    // --- the structural check itself --------------------------------------

    console.log('\nindexPayloadProblem');

    await test('accepts a real index', () => {
        assert.equal(storeMod.indexPayloadProblem(JSON.parse(RAW.thesession.v1)), null);
    });

    for (const [label, body] of Object.entries(BAD_BODIES)) {
        await test(`rejects ${label}`, () => {
            let parsed;
            try {
                parsed = JSON.parse(body);
            } catch (e) {
                return; // JSON.parse is the first gate; that is a pass too.
            }
            assert.notEqual(storeMod.indexPayloadProblem(parsed), null,
                `${label} was accepted as a tune index`);
        });
    }

    await test('writeDataset refuses an empty payload', async () => {
        resetFakes();
        await assert.rejects(() => storeMod.writeDataset('folkwiki', '', { v: 9 }));
        await assert.rejects(() => storeMod.writeDataset('folkwiki', undefined, { v: 9 }));
    });

    // --- merging ----------------------------------------------------------

    console.log('\nMerging datasets');

    await test('merging combines settings, aliases and sidebands', async () => {
        const mod = await import(`${path.join(tmpDir, 'worker.mjs')}?v=${Math.random()}`);
        const parts = ALL.map(id => ({
            id, index: storeMod.splitIndexPayload(JSON.parse(RAW[id].v1)),
        }));
        const merged = mod.mergeIndexParts(parts);
        assert.equal(Object.keys(merged.indexData.settings).length, 450);
        assert.equal(merged.collisions, 0);
        assert.deepEqual(merged.empty, []);
        // Every tune is labelled with the dataset it came from — this is what
        // replaced inferring the source from the numeric ID range.
        assert.equal(merged.datasetByTune['0'], 'thesession');
        assert.equal(merged.datasetByTune['1000000'], 'folkwiki');
        assert.equal(merged.datasetByTune['3000000'], 'norbeck');
        assert.ok(merged.abcStrings['1000'].includes('thesession'));
        assert.ok(merged.abcStrings['8000000'].includes('norbeck'));
    });

    await test('a single part skips the merge copy but still labels its tunes', async () => {
        const mod = await import(`${path.join(tmpDir, 'worker.mjs')}?v=${Math.random()}`);
        const merged = mod.mergeIndexParts([{
            id: 'norbeck',
            index: storeMod.splitIndexPayload(JSON.parse(RAW.norbeck.v1)),
        }]);
        assert.equal(merged.datasetByTune['3000000'], 'norbeck');
        assert.equal(merged.collisions, 0);
    });

    await test('a part contributing nothing new is reported as a duplicate', async () => {
        // datasets.json pointing two entries at the same file: both documents
        // pass indexPayloadProblem perfectly, and without this guard the
        // failure presents as "folkwiki is missing" with no error anywhere.
        const mod = await import(`${path.join(tmpDir, 'worker.mjs')}?v=${Math.random()}`);
        const merged = mod.mergeIndexParts([
            { id: 'thesession', index: storeMod.splitIndexPayload(JSON.parse(RAW.thesession.v1)) },
            { id: 'folkwiki', index: storeMod.splitIndexPayload(JSON.parse(RAW.thesession.v1)) },
        ]);
        assert.deepEqual(merged.empty, ['folkwiki']);
        assert.ok(merged.collisions > 0);
    });

    // --- the invariant, one bad body at a time ----------------------------

    console.log('\nA failed update never replaces any offline copy');

    for (const [label, body] of Object.entries(BAD_BODIES)) {
        await test(`background update serving ${label}`, async () => {
            resetFakes();
            await seedGoodCopies();

            const wrapper = await newWorker();
            await new Promise(r => wrapper.setupTuneIndex(r));
            assert.equal(wrapper.indexStatus, 'ready', 'should start ready from the cache');

            // Now a v2 of folkwiki appears, and the download is rubbish.
            netMod.__net.manifest = manifestFor(
                { thesession: 1, folkwiki: 2, norbeck: 1 });
            serve({ folkwiki: body });
            wrapper.autoUpdateEnabled = true;
            const { parts } = await storeMod.readDatasets(ALL);
            await wrapper._checkForUpdatesInBackground(parts);

            // P1: every dataset still has its copy, including the one the
            // failed update was about.
            await assertAllIntact('v1', 1, label);
            assert.equal(wrapper.indexUsable, true, 'the loaded index must survive too');
            assert.equal(wrapper.indexStatus, 'ready',
                'a failed background update must not leave the app looking broken');
            assert.ok(wrapper.indexDetail.updateError, 'the failure should be recorded');
        });
    }

    await test('a download the WASM side refuses does not replace any copy', async () => {
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        // Structurally perfect, but Rust will not have it.
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 2, norbeck: 1 });
        serve({ folkwiki: RAW.folkwiki.v2 });
        wasmMod.__wasm.rejectLoad = 'unreachable executed';
        wrapper.autoUpdateEnabled = true;
        const { parts } = await storeMod.readDatasets(ALL);
        await wrapper._checkForUpdatesInBackground(parts);

        await assertAllIntact('v1', 1, 'WASM-rejected update');
        assert.equal(wrapper.indexStatus, 'ready');
        assert.equal(wrapper.indexUsable, true);
    });

    await test('a stalled download does not replace any copy', async () => {
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 2, norbeck: 1 });
        netMod.__net.bodyErrors[FILENAME.folkwiki] =
            'Tune index download stalled and was aborted';
        wrapper.autoUpdateEnabled = true;
        const { parts } = await storeMod.readDatasets(ALL);
        await wrapper._checkForUpdatesInBackground(parts);

        await assertAllIntact('v1', 1, 'stalled update');
        assert.equal(wrapper.indexStatus, 'ready');
    });

    await test('a manual refresh serving rubbish does not replace any copy', async () => {
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        serve({
            thesession: BAD_BODIES['a JSON error document'],
            folkwiki: BAD_BODIES['an empty object'],
            norbeck: BAD_BODIES['a JSON array'],
        });
        const result = await new Promise(r => wrapper.refreshTuneIndex(null, r));

        assert.equal(result.ok, false);
        await assertAllIntact('v1', 1, 'manual refresh');
    });

    await test('a good update DOES replace that dataset, and only that one', async () => {
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 2, norbeck: 1 });
        serve({ folkwiki: RAW.folkwiki.v2 });
        wrapper.autoUpdateEnabled = true;
        const { parts } = await storeMod.readDatasets(ALL);
        await wrapper._checkForUpdatesInBackground(parts);

        await assertOfflineCopyIs('folkwiki', 'v2', 2, 'successful update');
        // The point of per-dataset versions: an unchanged 35 MB file is NOT
        // re-downloaded because a sibling moved.
        await assertOfflineCopyIs('thesession', 'v1', 1, 'unchanged sibling');
        await assertOfflineCopyIs('norbeck', 'v1', 1, 'unchanged sibling');
        assert.equal(netMod.__net.requests.length, 1,
            'only the dataset whose version moved should be downloaded');
        assert.equal(wrapper.indexStatus, 'ready');
        assert.ok(!wrapper.indexDetail.updateError);
    });

    // --- partial success ---------------------------------------------------

    console.log('\nPartial success is success');

    await test('one dataset failing does not stop the others installing', async () => {
        resetFakes();
        netMod.__net.bodyErrors[FILENAME.norbeck] = 'HTTP 404';

        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        // P2: the app is READY with two of three, because queries work and
        // return real tunes. Reporting unavailable would push every view into
        // favourites-only mode over one missing file.
        assert.equal(wrapper.indexStatus, 'ready');
        assert.equal(wrapper.indexUsable, true);
        assert.deepEqual(wrapper.indexDetail.datasetsLoaded.sort(),
            ['folkwiki', 'thesession']);
        assert.deepEqual(wrapper.indexDetail.datasetsMissing, ['norbeck']);
        assert.ok(wrapper.indexDetail.datasetErrors.norbeck,
            'the failure must be reported, not swallowed — a silent gap looks '
            + 'to the user like the app simply does not have the tune');
        await assertOfflineCopyIs('thesession', 'v1', 1, 'partial install');
        await assertOfflineCopyIs('folkwiki', 'v1', 1, 'partial install');
    });

    await test('a partial install keeps the failed dataset\'s previous copy', async () => {
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        netMod.__net.manifest = manifestFor({ thesession: 2, folkwiki: 2, norbeck: 2 });
        serve({ thesession: RAW.thesession.v2, folkwiki: RAW.folkwiki.v2 });
        netMod.__net.bodyErrors[FILENAME.norbeck] = 'connection reset';

        const result = await new Promise(r => wrapper.refreshTuneIndex(null, r));
        assert.equal(result.ok, true);
        assert.equal(result.partial, true);
        await assertOfflineCopyIs('thesession', 'v2', 2, 'partial refresh');
        await assertOfflineCopyIs('folkwiki', 'v2', 2, 'partial refresh');
        await assertOfflineCopyIs('norbeck', 'v1', 1,
            'the dataset that failed keeps its old copy');
    });

    await test('every dataset failing is a real failure', async () => {
        resetFakes();
        for (const id of ALL) netMod.__net.bodyErrors[FILENAME[id]] = 'HTTP 500';

        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));
        assert.equal(wrapper.indexStatus, 'unavailable');
        assert.equal(wrapper.indexUsable, false);
    });

    await test('a dataset missing from the manifest is skipped, not fatal', async () => {
        resetFakes();
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });

        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));
        assert.equal(wrapper.indexStatus, 'ready');
        assert.equal(wrapper.indexDetail.datasetErrors.norbeck, 'not published');
    });

    // --- failing to LOAD data is not proof the data is bad ----------------

    console.log('\nA cached copy survives a load failure');

    await test('copies the WASM side refuses at startup are kept, not deleted', async () => {
        resetFakes();
        await seedGoodCopies();
        wasmMod.__wasm.rejectLoad = 'out of memory';
        for (const id of ALL) netMod.__net.bodyErrors[FILENAME[id]] = 'no network either';

        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        assert.equal(wrapper.indexStatus, 'unavailable', 'nothing is loaded this session');
        await assertAllIntact('v1', 1, 'after a failed load');
    });

    await test('...and they work again on the next launch', async () => {
        // Same database, a launch where the load succeeds. This is the whole
        // reason not to delete: transient failures are transient.
        wasmMod.__wasm.rejectLoad = null;
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));
        assert.equal(wrapper.indexStatus, 'ready');
        assert.equal(wrapper.indexUsable, true);
    });

    await test('copies that fail to load offline are kept for the next launch', async () => {
        resetFakes();
        await seedGoodCopies();
        wasmMod.__wasm.rejectLoad = 'out of memory';
        netMod.__net.offline = true;

        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        assert.equal(wrapper.indexStatus, 'unavailable');
        assert.equal(wrapper.indexDetail.reason, 'offline');
        await assertAllIntact('v1', 1, 'offline after a failed load');
    });

    await test('a genuinely incompatible cached copy is replaced by a download', async () => {
        // Keeping an unloadable copy must not mean being stuck with it. Here
        // WASM refuses the v1 datasets specifically — a real schema change —
        // and accepts v2, so the same launch recovers on its own.
        resetFakes();
        await seedGoodCopies();
        wasmMod.__wasm.rejectDance = 'v1';
        netMod.__net.manifest = manifestFor({ thesession: 2, folkwiki: 2, norbeck: 2 });
        serve({ thesession: RAW.thesession.v2, folkwiki: RAW.folkwiki.v2, norbeck: RAW.norbeck.v2 });

        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        assert.equal(wrapper.indexStatus, 'ready');
        assert.equal(wrapper.indexUsable, true);
        await assertAllIntact('v2', 2, 'download after a refused cache');
    });

    await test('junk written by this schema IS cleared on read', async () => {
        // The other half of keeping unloadable copies: something committed by a
        // pre-validation release of THIS schema must not stick around forever.
        resetFakes();
        await storeMod.writeDataset('folkwiki', '{"error":"not found"}',
            { v: 1, date: '2026-01-01' });
        assert.equal(await storeMod.readDataset('folkwiki'), null);
        assert.equal(idbMod.__db.has('ffIndexRaw:folkwiki'), false,
            'the bad payload should be gone');
        assert.equal(idbMod.__db.has('ffIndexManifest:folkwiki'), false);
    });

    await test('a payload from a NEWER schema is not deleted by this build', async () => {
        // An older client must not destroy a database a later release wrote.
        // "I cannot recognise this" is not "this is junk" — the same reasoning
        // that used to delete a good copy whenever WASM refused to load it.
        resetFakes();
        idbMod.__db.set('ffIndexRaw:folkwiki', '{"tunes":[],"format":"schema-9"}');
        idbMod.__db.set('ffIndexManifest:folkwiki', {
            schema: storeMod.SCHEMA_VERSION + 1, dataset: 'folkwiki',
            v: 99, date: '2027-01-01', bytes: 33,
        });

        assert.equal(await storeMod.readDataset('folkwiki'), null, 'it must not be used');
        assert.equal(idbMod.__db.has('ffIndexRaw:folkwiki'), true,
            'but it must not be deleted either');
    });

    await test('an unrecognisable payload with no manifest is not deleted', async () => {
        resetFakes();
        idbMod.__db.set('ffIndexRaw:norbeck', '{"something":"else"}');
        assert.equal(await storeMod.readDataset('norbeck'), null);
        assert.equal(idbMod.__db.has('ffIndexRaw:norbeck'), true);
    });

    await test('...and a validated download still replaces it', async () => {
        // Retaining junk costs nothing: writeDataset targets the same keys.
        netMod.__net.manifest = manifestFor({ thesession: 5, folkwiki: 5, norbeck: 5 });
        serve({ thesession: RAW.thesession.v2, folkwiki: RAW.folkwiki.v2, norbeck: RAW.norbeck.v2 });
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));
        await assertOfflineCopyIs('norbeck', 'v2', 5, 'download over retained junk');
    });

    // --- migration from the merged blob ------------------------------------

    console.log('\nMigration from the pre-multi-dataset merged copy');

    await test('an upgrading install is READY from the merged blob immediately', async () => {
        resetFakes();
        idbMod.__db.set('ffIndexRaw', makeMerged('old'));
        idbMod.__db.set('ffIndexManifest',
            { schema: 2, v: 2299, date: '2026-04-17', bytes: makeMerged('old').length });
        // No network at all: the whole point is that the user is not stranded.
        netMod.__net.offline = true;

        const wrapper = await newWorker({ datasets: ['thesession', 'folkwiki'] });
        await new Promise(r => wrapper.setupTuneIndex(r));

        assert.equal(wrapper.indexStatus, 'ready',
            'an upgrading user must not lose their tunes while migrating');
        assert.equal(wrapper.indexUsable, true);
        assert.equal(wrapper.indexDetail.migrationPending, true);
        assert.equal(idbMod.__db.has('ffIndexRaw'), true,
            'the merged blob must survive until per-dataset copies exist');
    });

    await test('migration replaces the merged blob only once coverage is complete', async () => {
        resetFakes();
        const merged = makeMerged('old');
        idbMod.__db.set('ffIndexRaw', merged);
        idbMod.__db.set('ffIndexManifest',
            { schema: 2, v: 1, date: '2026-04-17', bytes: merged.length });

        const wrapper = await newWorker({
            autoUpdate: true, datasets: ['thesession', 'folkwiki'],
        });
        await new Promise(r => wrapper.setupTuneIndex(r));
        // Migration is fire-and-forget; let it finish.
        for (let i = 0; i < 200 && idbMod.__db.has('ffIndexRaw'); i++) {
            await new Promise(r => setImmediate(r));
        }

        // P3: the merged blob is gone, and both datasets it covered are on disk.
        assert.equal(idbMod.__db.has('ffIndexRaw'), false,
            'the merged blob should be reclaimed once superseded');
        await assertOfflineCopyIs('thesession', 'v1', 1, 'after migration');
        await assertOfflineCopyIs('folkwiki', 'v1', 1, 'after migration');
    });

    await test('a migration that fails part-way keeps the merged blob', async () => {
        // P3's other half: there must be no state in which both are missing.
        resetFakes();
        const merged = makeMerged('old');
        idbMod.__db.set('ffIndexRaw', merged);
        idbMod.__db.set('ffIndexManifest',
            { schema: 2, v: 1, date: '2026-04-17', bytes: merged.length });
        // thesession lands, folkwiki dies mid-transfer.
        netMod.__net.bodyErrors[FILENAME.folkwiki] = 'connection reset';

        const wrapper = await newWorker({
            autoUpdate: true, datasets: ['thesession', 'folkwiki'],
        });
        await new Promise(r => wrapper.setupTuneIndex(r));
        for (let i = 0; i < 200; i++) await new Promise(r => setImmediate(r));

        assert.equal(idbMod.__db.has('ffIndexRaw'), true,
            'folkwiki still lives only in the merged blob; it must not be deleted');
        assert.equal(wrapper.indexUsable, true);
    });

    // The review finding: during migration the first per-dataset load replaces
    // WASM with ONLY that dataset, because the others still live in the merged
    // blob and _partsToKeep reads per-dataset copies from disk. If a later
    // download then fails, the un-migrated source silently vanishes from search
    // for the rest of the session — while _afterInstall still reports it loaded,
    // because it inherits the 'merged' entry. Nothing is lost on disk, but the
    // app quietly stops finding half its tunes and says everything is fine.
    await test('a half-finished migration never drops a source from search', async () => {
        resetFakes();
        const merged = makeMerged('old');
        idbMod.__db.set('ffIndexRaw', merged);
        idbMod.__db.set('ffIndexManifest',
            { schema: 2, v: 1, date: '2026-04-17', bytes: merged.length });
        // thesession migrates cleanly; folkwiki dies mid-transfer.
        netMod.__net.bodyErrors[FILENAME.folkwiki] = 'connection reset';

        const wrapper = await newWorker({
            autoUpdate: true, datasets: ['thesession', 'folkwiki'],
        });
        await new Promise(r => wrapper.setupTuneIndex(r));
        for (let i = 0; i < 300; i++) await new Promise(r => setImmediate(r));

        // Whatever the pipeline did, folkwiki tunes must still be findable —
        // they are on disk in the merged blob, so there is no excuse.
        const loaded = wasmMod.__wasm.loaded || { settings: {} };
        assert.ok(loaded.settings['2000000'],
            'folkwiki disappeared from the loaded index mid-migration');
        assert.ok(loaded.settings['1000'],
            'thesession disappeared from the loaded index mid-migration');

        // ...and the reported state must match what is actually searchable.
        const reported = wrapper.indexDetail.datasetsLoaded || [];
        for (const id of reported) {
            const probe = id === 'folkwiki' ? '2000000' : '1000';
            assert.ok(loaded.settings[probe],
                `${id} is reported loaded but is not in the index`);
        }
    });

    await test('migration is deferred when automatic updates are off', async () => {
        // ~42 MB for zero new content is exactly the download a user who turned
        // auto-update off has asked not to be given.
        resetFakes();
        const merged = makeMerged('old');
        idbMod.__db.set('ffIndexRaw', merged);
        idbMod.__db.set('ffIndexManifest',
            { schema: 2, v: 1, date: '2026-04-17', bytes: merged.length });

        const wrapper = await newWorker({
            autoUpdate: false, datasets: ['thesession', 'folkwiki'],
        });
        await new Promise(r => wrapper.setupTuneIndex(r));
        for (let i = 0; i < 100; i++) await new Promise(r => setImmediate(r));

        assert.equal(netMod.__net.requests.length, 0,
            'no download may start when the user has turned updates off');
        assert.equal(idbMod.__db.has('ffIndexRaw'), true);
        assert.equal(wrapper.indexUsable, true);
    });

    // --- changing the selection --------------------------------------------

    console.log('\nChanging the dataset selection');

    await test('turning a dataset off keeps its payload on disk', async () => {
        // A toggle must NEVER delete a payload — worse than deleting on
        // failure, because the user may flip it back in thirty seconds and now
        // needs 35 MB of signal they may not have.
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        await new Promise(r => wrapper.setSelectedDatasets(['thesession', 'folkwiki'], r));

        assert.equal(wrapper.indexStatus, 'ready');
        assert.equal(idbMod.__db.has('ffIndexRaw:norbeck'), true,
            'a deselected dataset keeps its offline copy');
        assert.equal(wrapper.datasetByTune['3000000'], undefined,
            'but its tunes are no longer labelled as loaded');
    });

    await test('turning it back on needs no network when the copy is on disk', async () => {
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));
        await new Promise(r => wrapper.setSelectedDatasets(['thesession'], r));

        const before = netMod.__net.requests.length;
        await new Promise(r => wrapper.setSelectedDatasets(ALL, r));

        assert.equal(netMod.__net.requests.length, before,
            'a dataset already on disk must not be re-downloaded');
        assert.equal(wrapper.datasetByTune['3000000'], 'norbeck');
        assert.equal(wrapper.indexStatus, 'ready');
    });

    await test('turning off the last dataset unloads rather than loading nothing', async () => {
        // Loading an empty index would have Rust happily return nothing with no
        // explanation, and indexPayloadProblem would reject it anyway.
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        await new Promise(r => wrapper.setSelectedDatasets([], r));

        assert.equal(wrapper.indexUsable, false);
        assert.equal(wrapper.indexStatus, 'unavailable');
        assert.equal(wrapper.indexDetail.reason, 'no-datasets-selected');
        // ...and nothing was deleted.
        await assertAllIntact('v1', 1, 'after deselecting everything');
    });

    await test('an empty selection at startup is a choice, not a failure', async () => {
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker({ datasets: [] });
        await new Promise(r => wrapper.setupTuneIndex(r));

        assert.equal(wrapper.indexStatus, 'unavailable');
        assert.equal(wrapper.indexDetail.reason, 'no-datasets-selected');
        assert.equal(netMod.__net.manifestRequests, 0,
            'nothing should be fetched when nothing is selected');
    });

    await test('a failed toggle-on lands in a terminal state, not stuck downloading', async () => {
        // The status used to be left on 'downloading' forever, and the worker
        // resolved {ok:false} rather than throwing — so the UI showed a
        // database downloading indefinitely and never told the user why.
        resetFakes();
        await seedGoodCopies(['thesession', 'folkwiki']);
        const wrapper = await newWorker({ datasets: ['thesession', 'folkwiki'] });
        await new Promise(r => wrapper.setupTuneIndex(r));
        assert.equal(wrapper.indexStatus, 'ready');

        // norbeck has no saved copy and the download will fail.
        netMod.__net.bodyErrors[FILENAME.norbeck] = 'connection reset';
        const result = await new Promise(r => wrapper.setSelectedDatasets(ALL, r));

        assert.equal(result.ok, false, 'the caller must be told it failed');
        assert.ok(result.error, 'and given a reason to show');
        assert.notEqual(wrapper.indexStatus, 'downloading',
            'a failed toggle must not leave the status stuck on downloading');
        assert.equal(wrapper.indexStatus, 'ready',
            'the previously loaded index is still answering queries');
        assert.equal(wrapper.indexUsable, true);
        // The selection stands — it is the user's intent and retries later.
        assert.deepEqual(wrapper.selectedDatasets, ALL);
        await assertAllIntact('v1', 1, 'after a failed toggle-on',
            ['thesession', 'folkwiki']);
    });

    await test('removeDataset is the only path that deletes a copy', async () => {
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        await new Promise(r => wrapper.removeDataset('norbeck', r));
        assert.equal(idbMod.__db.has('ffIndexRaw:norbeck'), false);
        assert.equal(idbMod.__db.has('ffIndexManifest:norbeck'), false);
        // The others are untouched.
        await assertAllIntact('v1', 1, 'after removing norbeck',
            ['thesession', 'folkwiki']);
    });

    // --- only one install at a time ---------------------------------------

    console.log('\nUpdates never run concurrently');

    // Park a download and hand back the release lever.
    function parkDownloads() {
        let release, fail;
        netMod.__net.gate = new Promise((res, rej) => { release = res; fail = rej; });
        return { release: () => { netMod.__net.gate = null; release(); }, fail };
    }

    async function waitForDownloadsToStart(n) {
        for (let i = 0; i < 500 && netMod.__net.requests.length < n; i++) {
            await new Promise(r => setImmediate(r));
        }
        assert.equal(netMod.__net.requests.length, n,
            `expected ${n} download(s) to have started`);
    }

    await test('a manual refresh joins a running update that covers it', async () => {
        // setupTuneIndex fires the background check WITHOUT awaiting it and then
        // clears _setupInFlight, so this is reachable simply by tapping "Update
        // offline copy" while the startup update is still downloading.
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker({ datasets: ['folkwiki'] });
        await new Promise(r => wrapper.setupTuneIndex(r));

        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 2, norbeck: 1 });
        serve({ folkwiki: RAW.folkwiki.v2 });
        const gate = parkDownloads();

        wrapper.autoUpdateEnabled = true;
        const { parts } = await storeMod.readDatasets(['folkwiki']);
        const background = wrapper._checkForUpdatesInBackground(parts);
        await waitForDownloadsToStart(1);

        // The host has moved on by the time the user taps Update, so an
        // unguarded second install would carry a DIFFERENT payload — which is
        // what makes a crossed manifest/payload pair possible at all.
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 3, norbeck: 1 });
        serve({ folkwiki: RAW.folkwiki.v3 });
        const manual = new Promise(r => wrapper.refreshTuneIndex(['folkwiki'], r));
        await new Promise(r => setImmediate(r));

        gate.release();
        const result = await manual;
        await background;

        assert.equal(netMod.__net.requests.length, 1,
            'the second caller must join the running install, not start another '
            + '35 MB transfer');
        assert.equal(result.ok, true);
        await assertOfflineCopyIs('folkwiki', 'v2', 2, 'joined install');

        // Payload and manifest are separate transactions, so two overlapping
        // installs could commit a manifest from one and a payload from the
        // other — undetectable at read time when they happen to be the same
        // length. Serialising is what rules it out; assert the pairing directly.
        const raw = idbMod.__db.get('ffIndexRaw:folkwiki');
        const manifest = idbMod.__db.get('ffIndexManifest:folkwiki');
        assert.equal(manifest.bytes, raw.length,
            'the manifest must describe the payload sitting next to it');
        assert.equal(JSON.parse(raw).settings['2000000'].dance, 'v2');
    });

    await test('a DISJOINT install is serialised, not joined', async () => {
        // Joining unconditionally is wrong once requests can be disjoint: an
        // install of thesession would hand a caller asking for norbeck a result
        // with no norbeck in it, and the caller would report success.
        resetFakes();
        const wrapper = await newWorker({ datasets: ALL });
        wrapper.selectedDatasets = ALL;

        const gate = parkDownloads();
        const first = wrapper._installExclusively({ ids: ['thesession'] });
        await waitForDownloadsToStart(1);
        const second = wrapper._installExclusively({ ids: ['norbeck'] });
        await new Promise(r => setImmediate(r));

        assert.equal(netMod.__net.requests.length, 1,
            'the disjoint request must wait, not run concurrently');

        gate.release();
        const [a, b] = await Promise.all([first, second]);

        assert.ok(a.installed.thesession, 'the first request must be honoured');
        assert.ok(b.installed.norbeck,
            'and so must the second — joining would have dropped it');
        await assertOfflineCopyIs('thesession', 'v1', 1, 'disjoint installs');
        await assertOfflineCopyIs('norbeck', 'v1', 1, 'disjoint installs');
    });

    await test('a joined install that fails restores the previous version, not undefined',
        async () => {
            // The snapshot is taken while the pipeline reads 'downloading',
            // which carries no version — reading it from indexDetail would
            // restore READY with v=undefined and blank the Settings/About
            // version display.
            resetFakes();
            await seedGoodCopies(['folkwiki']);
            const wrapper = await newWorker({ datasets: ['folkwiki'] });
            await new Promise(r => wrapper.setupTuneIndex(r));

            netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 2, norbeck: 1 });
            serve({ folkwiki: RAW.folkwiki.v2 });
            const gate = parkDownloads();

            wrapper.autoUpdateEnabled = true;
            const { parts } = await storeMod.readDatasets(['folkwiki']);
            const background = wrapper._checkForUpdatesInBackground(parts);
            await waitForDownloadsToStart(1);
            const manual = new Promise(r => wrapper.refreshTuneIndex(['folkwiki'], r));
            await new Promise(r => setImmediate(r));

            netMod.__net.bodyErrors[FILENAME.folkwiki] = 'connection reset mid-transfer';
            gate.release();
            const result = await manual;
            await background;

            assert.equal(result.ok, false);
            assert.equal(wrapper.indexStatus, 'ready');
            assert.equal(wrapper.indexDetail.v, 1, 'the old version must still be reported');
            assert.equal(wrapper.indexDetail.date, '2026-01-01');
            assert.ok(wrapper.indexDetail.updateError);
            await assertOfflineCopyIs('folkwiki', 'v1', 1, 'failed joined install');
        });

    await test('a second refresh after the first finished starts a new install', async () => {
        // The guard must not latch: once an install completes, the next one runs.
        resetFakes();
        await seedGoodCopies(['folkwiki']);
        const wrapper = await newWorker({ datasets: ['folkwiki'] });
        await new Promise(r => wrapper.setupTuneIndex(r));

        await new Promise(r => wrapper.refreshTuneIndex(null, r));
        await new Promise(r => wrapper.refreshTuneIndex(null, r));
        assert.equal(netMod.__net.requests.length, 2);
        assert.equal(wrapper._indexUpdateInFlight, null, 'the guard must be released');
    });

    console.log('\nStatus never contradicts usability');

    await test('a failed manual refresh keeps status ready when an index is loaded', async () => {
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        for (const id of ALL) netMod.__net.bodyErrors[FILENAME[id]] = 'connection reset';
        const result = await new Promise(r => wrapper.refreshTuneIndex(null, r));

        assert.equal(result.ok, false);
        assert.equal(wrapper.indexUsable, true);
        assert.equal(wrapper.indexStatus, 'ready',
            'status must not say unavailable while the index is answering queries');
        assert.equal(wrapper.indexDetail.usable, true);
        assert.equal(wrapper.indexDetail.v, 1, 'the old version should still be reported');
        assert.ok(wrapper.indexDetail.updateError);
    });

    await test('a failed manual refresh reports unavailable when nothing is loaded', async () => {
        resetFakes();
        for (const id of ALL) netMod.__net.bodyErrors[FILENAME[id]] = 'connection reset';

        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));
        assert.equal(wrapper.indexStatus, 'unavailable');

        const result = await new Promise(r => wrapper.refreshTuneIndex(null, r));
        assert.equal(result.ok, false);
        assert.equal(wrapper.indexUsable, false);
        assert.equal(wrapper.indexStatus, 'unavailable');
    });

    await test('queries still work while an update is downloading', async () => {
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        // Park the state machine in 'downloading' exactly as an update does.
        wrapper._setIndexStatus('downloading', { received: 1, total: 100 });
        assert.equal(wrapper.indexDetail.usable, true,
            'usability travels with the status so the UI can tell busy from broken');

        const results = await new Promise(r => wrapper.runNameQuery('kesh', r));
        assert.ok(results.length > 0, 'a background download must not empty every query');
    });

    await test('download progress is aggregated across datasets', async () => {
        resetFakes();
        netMod.__net.manifest = manifestFor(
            { thesession: 1, folkwiki: 1, norbeck: 1 },
            { thesession: 3000, folkwiki: 2000, norbeck: 1000 });

        const wrapper = await newWorker();
        const seen = [];
        wrapper._statusSubscribers.push(detail => {
            if (detail.status === 'downloading' && detail.total) seen.push(detail);
        });
        await new Promise(r => wrapper.setupTuneIndex(r));

        assert.ok(seen.length > 0, 'progress should be reported');
        for (const detail of seen) {
            assert.equal(detail.total, 6000,
                'total must be the whole install, not one dataset');
            assert.ok(detail.received <= detail.total,
                'received must never exceed the planned total');
        }
        // Monotonic: a bar that goes backwards looks broken.
        for (let i = 1; i < seen.length; i++) {
            assert.ok(seen[i].received >= seen[i - 1].received,
                'aggregate progress must never go backwards');
        }
    });

    // --- the dataset label reaches the UI ---------------------------------

    console.log('\nQuery results carry the dataset they came from');

    // This is what the source chip and the thesession.org guards read. It has
    // to be asserted at the worker boundary: the label is a sideband, so
    // dropping it does not throw — every Norbeck tune just quietly claims to be
    // a folkwiki one, because that is what the legacy ID-range fallback says
    // about any id above 1e6. Which is exactly what shipped for an afternoon.
    await test('settingsFromTuneID labels each setting with its dataset', async () => {
        resetFakes();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        for (const [id, tuneID] of [['thesession', '0'],
                                    ['folkwiki', '1000000'],
                                    ['norbeck', '3000000']]) {
            const settings = await new Promise(
                r => wrapper.settingsFromTuneID(tuneID, r));
            assert.ok(settings.length > 0, `${id}: no settings for tune ${tuneID}`);
            for (const setting of settings) {
                assert.equal(setting.dataset, id,
                    `tune ${tuneID} should be labelled ${id}, got `
                    + `${JSON.stringify(setting.dataset)}`);
            }
        }
    });

    await test('transcription results carry the dataset too', async () => {
        resetFakes();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        const results = await new Promise(
            r => wrapper.runTranscriptionQuery('vtvtvtvt', r));
        assert.ok(results.length > 0, 'expected some results');
        for (const result of results) {
            assert.ok(['thesession', 'folkwiki', 'norbeck'].includes(result.setting.dataset),
                `result carries no dataset label: ${JSON.stringify(result.setting.dataset)}`);
        }
    });

    await test('a legacy merged blob leaves tunes unlabelled, not mislabelled', async () => {
        // The merged blob cannot say which tune came from which source, so
        // source.mjs must fall back to the ID range. An empty label is the
        // signal for that; a WRONG label would defeat it.
        resetFakes();
        const merged = makeMerged('old');
        idbMod.__db.set('ffIndexRaw', merged);
        idbMod.__db.set('ffIndexManifest',
            { schema: 2, v: 1, date: '2026-04-17', bytes: merged.length });
        netMod.__net.offline = true;

        const wrapper = await newWorker({ datasets: ['thesession', 'folkwiki'] });
        await new Promise(r => wrapper.setupTuneIndex(r));

        const settings = await new Promise(r => wrapper.settingsFromTuneID('0', r));
        assert.ok(settings.length > 0);
        assert.equal(settings[0].dataset, '',
            'tunes from a merged blob must be unlabelled so the ID-range '
            + 'fallback applies');
    });

    // --- datasets the user supplies ---------------------------------------

    console.log('\nImporting a dataset the app does not host');

    // FolkFriend does not host every dataset it can search: Norbeck's terms
    // forbid making the ABC available for download on a web page, so it is
    // built but never served and the user imports the file themselves.

    await test('a self-describing file is installed and becomes searchable', async () => {
        resetFakes();
        // An imported dataset is by definition not in the published manifest.
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });
        await seedGoodCopies(['thesession']);
        const wrapper = await newWorker({ datasets: ['thesession'] });
        await new Promise(r => wrapper.setupTuneIndex(r));

        const result = await new Promise(r => wrapper.addUserDataset(
            { text: makeSelfDescribing('norbeck', 'v1') }, r));

        assert.equal(result.ok, true, result.error);
        assert.equal(result.id, 'norbeck');
        assert.equal(result.label, 'Norbeck');
        assert.ok(wrapper.selectedDatasets.includes('norbeck'),
            'an imported dataset must be selected, or it is invisible');
        await assertOfflineCopyIs('norbeck', 'v1', 42, 'imported dataset');
        // ...and the datasets it was merged with are still there.
        await assertOfflineCopyIs('thesession', 'v1', 1, 'imported alongside');
        assert.ok((wasmMod.__wasm.loaded.settings || {})['8000000'],
            'the imported dataset is not in the loaded index');
        assert.ok((wasmMod.__wasm.loaded.settings || {})['1000'],
            'importing dropped the dataset that was already loaded');
    });

    await test('an imported dataset is labelled with its own id', async () => {
        resetFakes();
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });
        const wrapper = await newWorker({ datasets: [] });
        await new Promise(r => wrapper.addUserDataset(
            { text: makeSelfDescribing('norbeck', 'v1') }, r));
        const settings = await new Promise(
            r => wrapper.settingsFromTuneID('3000000', r));
        assert.ok(settings.length > 0);
        assert.equal(settings[0].dataset, 'norbeck');
    });

    await test('a file that is not a tune database is refused', async () => {
        resetFakes();
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });
        await seedGoodCopies();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        for (const [label, body] of Object.entries(BAD_BODIES)) {
            const result = await new Promise(
                r => wrapper.addUserDataset({ text: body }, r));
            assert.equal(result.ok, false, `${label} was accepted`);
            assert.ok(result.error, `${label} gave no reason`);
        }
        // Nothing was disturbed by any of them.
        await assertAllIntact('v1', 1, 'after refusing bad imports');
        assert.equal(wrapper.indexStatus, 'ready');
    });

    await test('a file that does not say which database it is, is refused', async () => {
        // (manifest left as-is; the id check fires before any manifest lookup)
        // Published datasets are described by datasets.json. An imported file
        // has no entry, so without a self-description there is no id to store
        // it under and no name to show.
        resetFakes();
        const wrapper = await newWorker({ datasets: [] });
        const anonymous = makeIndex('norbeck', 'v1');   // no id/label/v
        const result = await new Promise(
            r => wrapper.addUserDataset({ text: anonymous }, r));
        assert.equal(result.ok, false);
        assert.match(result.error, /which database/i);
    });

    await test('importing from a URL fetches it in the worker', async () => {
        resetFakes();
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });
        const url = 'https://example.invalid/private/norbeck.json';
        netMod.__net.bodies[url] = makeSelfDescribing('norbeck', 'v1');

        const wrapper = await newWorker({ datasets: [] });
        const result = await new Promise(
            r => wrapper.addUserDataset({ url }, r));

        assert.equal(result.ok, true, result.error);
        await assertOfflineCopyIs('norbeck', 'v1', 42, 'imported from a URL');
        assert.ok(netMod.__net.requests.some(r => r.userSupplied),
            'the URL should have been fetched by the worker');
    });

    await test('a URL that fails leaves the previous state intact', async () => {
        resetFakes();
        await seedGoodCopies();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        const url = 'https://example.invalid/gone.json';
        netMod.__net.bodyErrors[url] = 'connection reset';
        const result = await new Promise(
            r => wrapper.addUserDataset({ url }, r));

        assert.equal(result.ok, false);
        assert.notEqual(wrapper.indexStatus, 'downloading',
            'a failed import must not leave the status stuck on downloading');
        assert.equal(wrapper.indexStatus, 'ready');
        await assertAllIntact('v1', 1, 'after a failed URL import');
    });

    await test('an imported dataset is never reported as "not published"', async () => {
        // It is not in datasets.json by definition. Saying so on every update
        // check would surface a permanent error the user cannot act on.
        resetFakes();
        // norbeck is deliberately absent from the published manifest.
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });
        const wrapper = await newWorker({ datasets: ['thesession'] });
        await new Promise(r => wrapper.setupTuneIndex(r));
        await new Promise(r => wrapper.addUserDataset(
            { text: makeSelfDescribing('norbeck', 'v1') }, r));

        const refresh = await new Promise(
            r => wrapper.refreshTuneIndex(null, r));
        const why = (refresh.failed || {}).norbeck || '';
        assert.ok(!/not published/.test(why),
            `an imported dataset was reported as not published: ${why}`);
        await assertOfflineCopyIs('norbeck', 'v1', 42, 'after a refresh');
    });

    await test('an imported dataset remembered its URL and can be refreshed', async () => {
        resetFakes();
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });
        const url = 'https://example.invalid/private/norbeck.json';
        netMod.__net.bodies[url] = makeSelfDescribing('norbeck', 'v1');
        const wrapper = await newWorker({ datasets: [] });
        await new Promise(r => wrapper.addUserDataset({ url }, r));

        netMod.__net.bodies[url] = makeSelfDescribing('norbeck', 'v2', { v: 43 });
        const refresh = await new Promise(
            r => wrapper.refreshTuneIndex(['norbeck'], r));
        assert.equal(refresh.ok, true, JSON.stringify(refresh.failed));
        await assertOfflineCopyIs('norbeck', 'v2', 43, 'refreshed from its URL');
    });

    await test('an import cannot impersonate a published dataset', async () => {
        // Storing under `thesession` would put an unvetted file behind a name
        // the app manages, and the next CDN update would overwrite it — or
        // not, depending on ordering.
        resetFakes();
        const wrapper = await newWorker({ datasets: ['thesession'] });
        await new Promise(r => wrapper.setupTuneIndex(r));

        const result = await new Promise(r => wrapper.addUserDataset(
            { text: makeSelfDescribing('thesession', 'evil') }, r));
        assert.equal(result.ok, false);
        assert.match(result.error, /own databases/i);
        await assertOfflineCopyIs('thesession', 'v1', 1, 'after a refused import');
    });

    await test('an import that reuses another dataset\'s TUNE ids is refused', async () => {
        // Fresh setting ids but recycled tune ids used to pass every check.
        // The damage is worse than a setting clash: the later dataset's
        // aliases overwrite the earlier tune's NAME, datasetByTune relabels
        // its source, and Rust groups both datasets' settings under one tune.
        resetFakes();
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });
        const wrapper = await newWorker({ datasets: ['thesession'] });
        await new Promise(r => wrapper.setupTuneIndex(r));

        const base = JSON.parse(makeIndex('thesession', 'clash'));
        const settings = {};
        for (const [sid, setting] of Object.entries(base.settings)) {
            // Move every setting id well clear of thesession's, but keep the
            // tune ids exactly as they are.
            settings[String(9_900_000 + Number(sid))] = setting;
        }
        const tuneClash = JSON.stringify({
            settings, aliases: base.aliases,
            id: 'tuneclash', label: 'Tune Clash', v: 1, date: '2026-01-01',
        });

        const loadsBefore = wasmMod.__wasm.loadCalls;
        const result = await new Promise(
            r => wrapper.addUserDataset({ text: tuneClash }, r));
        assert.equal(result.ok, false,
            'a dataset recycling tune ids must be refused');
        assert.match(result.error, /tune IDs/i);
        // Vetted BEFORE the load, so it never reaches WASM at all — rather
        // than being loaded and then undone, which left a window where the app
        // searched data it had just refused to save.
        assert.equal(wasmMod.__wasm.loadCalls, loadsBefore,
            'a rejected payload must never be loaded into WASM');

        // The real dataset is intact and still owns its tunes.
        const found = await new Promise(r => wrapper.settingsFromTuneID('0', r));
        assert.ok(found.length > 0);
        assert.equal(found[0].dataset, 'thesession');
    });

    await test('a refresh that starts colliding is refused too', async () => {
        // The URL is remembered and is not under our control: a payload that
        // was clean when it was added can start colliding later, and the
        // refresh path used to merely log it and persist anyway.
        resetFakes();
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });
        const url = 'https://example.invalid/mine.json';
        netMod.__net.bodies[url] = makeSelfDescribing('norbeck', 'v1');
        const wrapper = await newWorker({ datasets: ['thesession'] });
        await new Promise(r => wrapper.setupTuneIndex(r));
        await new Promise(r => wrapper.addUserDataset({ url }, r));
        await assertOfflineCopyIs('norbeck', 'v1', 42, 'imported');

        // Same id, but now it claims thesession's setting ids.
        netMod.__net.bodies[url] = JSON.stringify({
            ...JSON.parse(makeIndex('thesession', 'stolen')),
            id: 'norbeck', label: 'Norbeck', v: 99, date: '2026-09-01',
        });
        const loadsBefore = wasmMod.__wasm.loadCalls;
        const refresh = await new Promise(
            r => wrapper.refreshTuneIndex(['norbeck'], r));
        const why = (refresh.failed || {}).norbeck || refresh.error || '';
        assert.match(why, /reuses/i, `expected a collision refusal, got: ${why}`);
        assert.equal(wasmMod.__wasm.loadCalls, loadsBefore,
            'a rejected refresh must never be loaded into WASM');
        await assertOfflineCopyIs('norbeck', 'v1', 42,
            'the previous copy must survive a colliding refresh');
        await assertOfflineCopyIs('thesession', 'v1', 1, 'the victim dataset');

        // ...and the rejected payload is not left loaded in WASM.
        const found = await new Promise(r => wrapper.settingsFromTuneID('0', r));
        assert.ok(found.length > 0);
        assert.equal(found[0].dataset, 'thesession',
            'the refused payload is still loaded in WASM');
    });

    await test('a refresh whose payload has no id at all is refused', async () => {
        // Imported datasets are REQUIRED to be self-describing, so "says
        // nothing" is not a lenient case — it is a file that cannot prove it
        // is still the same collection.
        resetFakes();
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });
        const url = 'https://example.invalid/anon.json';
        netMod.__net.bodies[url] = makeSelfDescribing('norbeck', 'v1');
        const wrapper = await newWorker({ datasets: [] });
        await new Promise(r => wrapper.addUserDataset({ url }, r));

        netMod.__net.bodies[url] = makeIndex('norbeck', 'anonymous'); // no id
        const refresh = await new Promise(
            r => wrapper.refreshTuneIndex(['norbeck'], r));
        const why = (refresh.failed || {}).norbeck || refresh.error || '';
        assert.match(why, /no id/i, `expected an identity refusal, got: ${why}`);
        await assertOfflineCopyIs('norbeck', 'v1', 42, 'after an anonymous refresh');
    });

    await test('an import that reuses another dataset\'s IDs is refused', async () => {
        // IDs are global and a collision does not fail loudly — one record
        // shadows the other. Favourites are keyed by setting id alone, so a
        // colliding import can make a favourite open the wrong tune.
        resetFakes();
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });
        const wrapper = await newWorker({ datasets: ['thesession'] });
        await new Promise(r => wrapper.setupTuneIndex(r));

        // Same setting IDs as thesession, but calling itself something else.
        const clashing = JSON.stringify({
            ...JSON.parse(makeIndex('thesession', 'clash')),
            id: 'impostor', label: 'Impostor', v: 1, date: '2026-01-01',
        });
        const result = await new Promise(
            r => wrapper.addUserDataset({ text: clashing }, r));

        assert.equal(result.ok, false, 'a colliding import must be refused');
        assert.match(result.error, /reuses/i);
        // The index the user had is back, intact.
        assert.equal(wrapper.indexUsable, true);
        const settings = await new Promise(
            r => wrapper.settingsFromTuneID('0', r));
        assert.ok(settings.length > 0);
        assert.equal(settings[0].dataset, 'thesession',
            'the rejected import must not have shadowed the real dataset');
    });

    await test('a URL that starts serving a different dataset is refused', async () => {
        resetFakes();
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });
        const url = 'https://example.invalid/mine.json';
        netMod.__net.bodies[url] = makeSelfDescribing('norbeck', 'v1');
        const wrapper = await newWorker({ datasets: [] });
        await new Promise(r => wrapper.addUserDataset({ url }, r));
        await assertOfflineCopyIs('norbeck', 'v1', 42, 'imported');

        // The link now serves something else entirely.
        netMod.__net.bodies[url] = JSON.stringify({
            ...JSON.parse(makeIndex('folkwiki', 'swapped')),
            id: 'somethingelse', label: 'Something Else', v: 99,
        });
        const refresh = await new Promise(
            r => wrapper.refreshTuneIndex(['norbeck'], r));
        // When the only requested dataset fails, the install throws and the
        // reason surfaces as `error` rather than in `failed`.
        const why = (refresh.failed || {}).norbeck || refresh.error || '';
        assert.match(why, /now serves/i,
            `a swapped dataset should be refused, got: ${why}`);
        await assertOfflineCopyIs('norbeck', 'v1', 42,
            'the original must survive a swapped link');
    });

    await test('an import is serialised with other installs', async () => {
        // Without the install lock an import merges from its own view of what
        // is loaded, so WASM can end up holding one operation's merge while
        // loadedDatasets claims both.
        resetFakes();
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });
        const wrapper = await newWorker({ datasets: ['thesession', 'folkwiki'] });

        const gate = parkDownloads();
        const install = wrapper._installExclusively({ ids: ['thesession'] });
        await waitForDownloadsToStart(1);

        const importing = new Promise(r => wrapper.addUserDataset(
            { text: makeSelfDescribing('norbeck', 'v1') }, r));
        await new Promise(r => setImmediate(r));

        gate.release();
        await install;
        const result = await importing;
        assert.equal(result.ok, true, result.error);

        // Everything that should be loaded, is.
        const loaded = wasmMod.__wasm.loaded || { settings: {} };
        for (const [id, probe] of [['thesession', '1000'], ['norbeck', '8000000']]) {
            assert.ok(loaded.settings[probe],
                `${id} is missing from the loaded index after a raced import`);
        }
        for (const id of wrapper.indexDetail.datasetsLoaded || []) {
            const probe = { thesession: '1000', folkwiki: '2000000',
                norbeck: '8000000' }[id];
            assert.ok(loaded.settings[probe],
                `${id} is reported loaded but is not in the index`);
        }
    });

    await test('a stored dataset is discoverable even when deselected', async () => {
        // Settings has to be able to offer it back, or 3 MB sits on disk that
        // cannot be re-enabled or removed.
        resetFakes();
        netMod.__net.manifest = manifestFor({ thesession: 1, folkwiki: 1 });
        const wrapper = await newWorker({ datasets: ['thesession'] });
        await new Promise(r => wrapper.setupTuneIndex(r));
        await new Promise(r => wrapper.addUserDataset(
            { text: makeSelfDescribing('norbeck', 'v1') }, r));

        await new Promise(r => wrapper.setSelectedDatasets(['thesession'], r));
        const inventory = await new Promise(
            r => wrapper.getDatasetInventory(['thesession'], r));
        assert.ok(inventory.datasets.norbeck,
            'a deselected imported dataset vanished from the inventory');
        assert.equal(inventory.datasets.norbeck.label, 'Norbeck');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    await rm(tmpDir, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
