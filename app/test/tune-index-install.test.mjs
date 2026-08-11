// Tests for the INSTALL path: what happens to a known-good offline copy when
// an update goes wrong.
//
// Run with:  node app/test/tune-index-install.test.mjs
//
// tune-index-cache.test.mjs already walks a simulated interruption across every
// storage operation and proves that a failed WRITE cannot destroy the offline
// copy. It cannot catch the failure this file is about, because it always
// writes valid data: the hole was a write that SUCCEEDED while carrying a
// payload nobody had established was a usable tune index.
//
// The invariant, stated once:
//
//     IF A USABLE OFFLINE COPY EXISTED BEFORE AN UPDATE, THE SAME COPY IS
//     STILL THERE AND STILL USABLE AFTER THE UPDATE FAILS — however it failed.
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

const FAKE_IDB = `
export const __db = new Map();
export async function get(key) { return __db.get(key); }
export async function set(key, value) { __db.set(key, value); }
export async function del(key) { __db.delete(key); }
`;

const FAKE_COMLINK = `
export function expose() {}
export function proxy(fn) { return fn; }
export function wrap(x) { return x; }
`;

const FAKE_FFCONFIG = `export default { SPEC_WINDOW_SIZE: 1024 };`;

// Stands in for tuneIndexNetwork.js. Every knob a bad connection can turn.
const FAKE_NETWORK = `
export class NetworkUnavailableError extends Error {
    constructor(m) { super(m); this.name = 'NetworkUnavailableError'; }
}
export const __net = {
    offline: false,
    meta: { v: 1, date: '2026-01-01' },
    metaError: null,
    body: null,
    bodyError: null,
    requests: [],
};
export function isDefinitelyOffline() { return !!__net.offline; }
export async function fetchTuneIndexMetadata() {
    if (__net.offline) throw new NetworkUnavailableError('Device is offline');
    if (__net.metaError) throw new NetworkUnavailableError(__net.metaError);
    return __net.meta;
}
export async function fetchTuneIndexText(bypassCacheVersion = null, onProgress = null) {
    __net.requests.push(bypassCacheVersion);
    if (__net.offline) throw new NetworkUnavailableError('Device is offline');
    if (__net.bodyError) throw new NetworkUnavailableError(__net.bodyError);
    if (onProgress) onProgress({ received: __net.body.length, total: __net.body.length });
    return __net.body;
}
`;

// Stands in for the WASM module. rejectLoad simulates the Rust side refusing
// every payload (memory pressure, a broken build); rejectDance refuses only one
// dataset, which is what an incompatible cached payload actually looks like.
// Note the ABC strings are already stripped by splitIndexPayload before this
// sees them, so the fixture tag has to ride on a field the Rust side keeps.
const FAKE_WASM = `
export const __wasm = { rejectLoad: null, rejectDance: null, loaded: null, loadCalls: 0 };
export class FolkFriendWASM {
    version() { return 'test'; }
    async load_index_from_json_obj(indexData) {
        __wasm.loadCalls += 1;
        if (__wasm.rejectLoad) throw new Error(__wasm.rejectLoad);
        const first = Object.values(indexData.settings || {})[0];
        if (__wasm.rejectDance && first && first.dance === __wasm.rejectDance) {
            throw new Error('unreachable executed (incompatible index)');
        }
        __wasm.loaded = indexData;
    }
    set_sample_rate() { return true; }
    set_use_ml() {}
    async run_name_query() {
        return JSON.stringify(Object.keys((__wasm.loaded || {}).aliases || {})
            .slice(0, 3).map(id => ({ tune_id: id })));
    }
}
`;

// --- index fixtures -------------------------------------------------------

// Shaped exactly like the real thing (rust/src/index/schema.rs): tune_id and
// contour are deliberately strings on both sides.
function makeIndex(tag, n = 150) {
    const settings = {};
    const aliases = {};
    for (let i = 0; i < n; i++) {
        settings[String(1000 + i)] = {
            tune_id: String(i),
            meter: '4/4',
            mode: 'Dmajor',
            abc: `abc-${tag}-${i}`,
            dance: tag,
            contour: 'vtvtvtvt',
            origin: '',
            composer: '',
        };
        aliases[String(i)] = [`Tune ${tag} ${i}`];
    }
    return JSON.stringify({ settings, aliases });
}

const RAW_V1 = makeIndex('v1');
const RAW_V2 = makeIndex('v2');

// Everything a broken 200 response can plausibly be. Each of these previously
// replaced the user's working offline copy.
const BAD_BODIES = {
    'truncated JSON': RAW_V1.slice(0, RAW_V1.length / 2),
    'an HTML error page served as 200': '<!doctype html><html><body>Sign in to the Wi-Fi</body></html>',
    'a JSON error document': '{"error":"not found","status":404}',
    'nud-meta.json from the wrong path': '{"v":2,"date":"2026-02-01"}',
    'an empty object': '{}',
    'a JSON array': '[]',
    'the string "null"': 'null',
    'an index with no aliases': JSON.stringify({ settings: JSON.parse(RAW_V1).settings, aliases: {} }),
    'a half-built dataset': JSON.stringify({
        settings: Object.fromEntries(Object.entries(JSON.parse(RAW_V1).settings).slice(0, 5)),
        aliases: JSON.parse(RAW_V1).aliases,
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
async function newWorker({ autoUpdate = false } = {}) {
    const mod = await import(`${path.join(tmpDir, 'worker.mjs')}?v=${Math.random()}`);
    const wrapper = mod.__wrapper;
    await wrapper.loadedWASM;
    wrapper.autoUpdateEnabled = autoUpdate;
    return wrapper;
}

function resetFakes() {
    idbMod.__db.clear();
    Object.assign(netMod.__net, {
        offline: false,
        meta: { v: 1, date: '2026-01-01' },
        metaError: null,
        body: RAW_V2,
        bodyError: null,
        requests: [],
    });
    Object.assign(wasmMod.__wasm,
        { rejectLoad: null, rejectDance: null, loaded: null, loadCalls: 0 });
}

async function seedGoodCopy() {
    await storeMod.writeIndex(RAW_V1, { v: 1, date: '2026-01-01' });
}

// The whole point of the exercise: read what is actually on disk and confirm it
// is a complete, parseable, loadable tune index at the expected version.
async function assertOfflineCopyIs(tag, version, context) {
    const cached = await storeMod.readIndex();
    assert.ok(cached, `${context}: there is no offline copy at all`);
    assert.equal(cached.manifest.v, version, `${context}: wrong version on disk`);
    assert.equal(storeMod.indexPayloadProblem(cached.index.indexData), null,
        `${context}: the payload on disk is not a usable tune index`);
    const anyAbc = Object.values(cached.index.abcStrings)[0];
    assert.ok(anyAbc.includes(tag), `${context}: expected the ${tag} payload, got ${anyAbc}`);
}

async function run() {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFakes();

    // --- the structural check itself --------------------------------------

    console.log('\nindexPayloadProblem');

    await test('accepts a real index', () => {
        assert.equal(storeMod.indexPayloadProblem(JSON.parse(RAW_V1)), null);
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

    await test('writeIndex refuses an empty payload', async () => {
        resetFakes();
        await assert.rejects(() => storeMod.writeIndex('', { v: 9 }));
        await assert.rejects(() => storeMod.writeIndex(undefined, { v: 9 }));
    });

    // --- the invariant, one bad body at a time ----------------------------

    console.log('\nA failed update never replaces the offline copy');

    for (const [label, body] of Object.entries(BAD_BODIES)) {
        await test(`background update serving ${label}`, async () => {
            resetFakes();
            await seedGoodCopy();

            const wrapper = await newWorker();
            await new Promise(r => wrapper.setupTuneIndex(r));
            assert.equal(wrapper.indexStatus, 'ready', 'should start ready from the cache');

            // Now a v2 appears, and the download is rubbish.
            netMod.__net.meta = { v: 2, date: '2026-02-01' };
            netMod.__net.body = body;
            wrapper.autoUpdateEnabled = true;
            await wrapper._checkForUpdateInBackground(await storeMod.readManifest());

            await assertOfflineCopyIs('v1', 1, label);
            assert.equal(wrapper.indexUsable, true, 'the loaded index must survive too');
            assert.equal(wrapper.indexStatus, 'ready',
                'a failed background update must not leave the app looking broken');
            assert.ok(wrapper.indexDetail.updateError, 'the failure should be recorded');
        });
    }

    await test('a download the WASM side refuses does not replace the copy', async () => {
        resetFakes();
        await seedGoodCopy();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        // Structurally perfect, but Rust will not have it.
        netMod.__net.meta = { v: 2, date: '2026-02-01' };
        netMod.__net.body = RAW_V2;
        wasmMod.__wasm.rejectLoad = 'unreachable executed';
        wrapper.autoUpdateEnabled = true;
        await wrapper._checkForUpdateInBackground(await storeMod.readManifest());

        await assertOfflineCopyIs('v1', 1, 'WASM-rejected update');
        assert.equal(wrapper.indexStatus, 'ready');
        assert.equal(wrapper.indexUsable, true);
    });

    await test('a stalled download does not replace the copy', async () => {
        resetFakes();
        await seedGoodCopy();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        netMod.__net.meta = { v: 2, date: '2026-02-01' };
        netMod.__net.bodyError = 'Tune index download stalled and was aborted';
        wrapper.autoUpdateEnabled = true;
        await wrapper._checkForUpdateInBackground(await storeMod.readManifest());

        await assertOfflineCopyIs('v1', 1, 'stalled update');
        assert.equal(wrapper.indexStatus, 'ready');
    });

    await test('a manual refresh serving rubbish does not replace the copy', async () => {
        resetFakes();
        await seedGoodCopy();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        netMod.__net.body = BAD_BODIES['a JSON error document'];
        const result = await new Promise(r => wrapper.refreshTuneIndex(r));

        assert.equal(result.ok, false);
        await assertOfflineCopyIs('v1', 1, 'manual refresh');
    });

    await test('a good update DOES replace the copy', async () => {
        resetFakes();
        await seedGoodCopy();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        netMod.__net.meta = { v: 2, date: '2026-02-01' };
        netMod.__net.body = RAW_V2;
        wrapper.autoUpdateEnabled = true;
        await wrapper._checkForUpdateInBackground(await storeMod.readManifest());

        await assertOfflineCopyIs('v2', 2, 'successful update');
        assert.equal(wrapper.indexStatus, 'ready');
        assert.equal(wrapper.indexDetail.v, 2);
        assert.ok(!wrapper.indexDetail.updateError);
    });

    // --- failing to LOAD data is not proof the data is bad ----------------

    console.log('\nA cached copy survives a load failure');

    await test('a copy the WASM side refuses at startup is kept, not deleted', async () => {
        resetFakes();
        await seedGoodCopy();
        wasmMod.__wasm.rejectLoad = 'out of memory';
        netMod.__net.bodyError = 'no network either';

        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        assert.equal(wrapper.indexStatus, 'unavailable', 'nothing is loaded this session');
        await assertOfflineCopyIs('v1', 1, 'after a failed load');
    });

    await test('...and works again on the next launch', async () => {
        // Same database, a launch where the load succeeds. This is the whole
        // reason not to delete: transient failures are transient.
        wasmMod.__wasm.rejectLoad = null;
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));
        assert.equal(wrapper.indexStatus, 'ready');
        assert.equal(wrapper.indexUsable, true);
    });

    await test('a copy that fails to load offline is kept for the next launch', async () => {
        resetFakes();
        await seedGoodCopy();
        wasmMod.__wasm.rejectLoad = 'out of memory';
        netMod.__net.offline = true;

        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        assert.equal(wrapper.indexStatus, 'unavailable');
        assert.equal(wrapper.indexDetail.reason, 'offline');
        await assertOfflineCopyIs('v1', 1, 'offline after a failed load');
    });

    await test('a genuinely incompatible cached copy is replaced by a download', async () => {
        // Keeping an unloadable copy must not mean being stuck with it. Here
        // WASM refuses the v1 dataset specifically — a real schema change — and
        // accepts v2, so the same launch recovers on its own.
        resetFakes();
        await seedGoodCopy();
        wasmMod.__wasm.rejectDance = 'v1';
        netMod.__net.meta = { v: 2, date: '2026-02-01' };
        netMod.__net.body = RAW_V2;

        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        assert.equal(wrapper.indexStatus, 'ready');
        assert.equal(wrapper.indexUsable, true);
        await assertOfflineCopyIs('v2', 2, 'download after a refused cache');
    });

    await test('a payload that is no longer a tune index IS cleared on read', async () => {
        // The other half of keeping unloadable copies: something written by an
        // older build that never validated must not stick around forever.
        resetFakes();
        await storeMod.writeIndex('{"error":"not found"}', { v: 1, date: '2026-01-01' });
        assert.equal(await storeMod.readIndex(), null);
        assert.equal(idbMod.__db.has('ffIndexRaw'), false, 'the bad payload should be gone');
        assert.equal(idbMod.__db.has('ffIndexManifest'), false);
    });

    // --- the status the UI reads ------------------------------------------

    console.log('\nStatus never contradicts usability');

    await test('a failed manual refresh keeps status ready when an index is loaded', async () => {
        resetFakes();
        await seedGoodCopy();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        netMod.__net.bodyError = 'connection reset';
        const result = await new Promise(r => wrapper.refreshTuneIndex(r));

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
        netMod.__net.bodyError = 'connection reset';

        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));
        assert.equal(wrapper.indexStatus, 'unavailable');

        const result = await new Promise(r => wrapper.refreshTuneIndex(r));
        assert.equal(result.ok, false);
        assert.equal(wrapper.indexUsable, false);
        assert.equal(wrapper.indexStatus, 'unavailable');
    });

    await test('queries still work while an update is downloading', async () => {
        resetFakes();
        await seedGoodCopy();
        const wrapper = await newWorker();
        await new Promise(r => wrapper.setupTuneIndex(r));

        // Park the state machine in 'downloading' exactly as an update does.
        wrapper._setIndexStatus('downloading', { received: 1, total: 100 });
        assert.equal(wrapper.indexDetail.usable, true,
            'usability travels with the status so the UI can tell busy from broken');

        const results = await new Promise(r => wrapper.runNameQuery('kesh', r));
        assert.ok(results.length > 0, 'a background download must not empty every query');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    await rm(tmpDir, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
