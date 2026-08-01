// Unit tests for the offline tune-index cache and its network layer.
//
// Run with:  node app/test/tune-index-cache.test.mjs
//
// These two modules are the whole reason the app works on a plane, so they are
// tested directly rather than through the browser. The modules are loaded from
// source with their imports rewritten to in-memory fakes, so no browser, no
// IndexedDB and no network are required.

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
export const __state = { failOn: null, throwOn: null, failAtOp: null, ops: 0 };

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
    if (__state.throwOn === key) throw new Error('simulated read failure');
    return __db.get(key);
}
export async function set(key, value) {
    if (__state.failOn === key) throw new Error('QuotaExceededError (simulated)');
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
    return { store, idb };
}

async function loadNetwork() {
    return loadModule('tuneIndexNetwork.js', [
        ['process.env.NODE_ENV', "'test'"],
    ]);
}

// A minimal but structurally faithful index payload.
const SAMPLE = JSON.stringify({
    settings: {
        '101': { tune_id: '7', abc: 'ABC-ONE', contour: 'tttt', source_url: 'https://x/1' },
        '102': { tune_id: '7', abc: 'ABC-TWO', contour: 'vvvv' },
    },
    aliases: { '7': ['The Kesh'] },
});

console.log('\ntuneIndexStore');

await mkdir(tmpDir, { recursive: true });

await test('splitIndexPayload strips abc + source_url out of the WASM payload', async () => {
    const { store } = await loadStore();
    const { indexData, abcStrings, sourceUrls } = store.splitIndexPayload(JSON.parse(SAMPLE));
    assert.equal(abcStrings['101'], 'ABC-ONE');
    assert.equal(abcStrings['102'], 'ABC-TWO');
    assert.equal(sourceUrls['101'], 'https://x/1');
    assert.equal(sourceUrls['102'], undefined);
    assert.equal(indexData.settings['101'].abc, '');
    assert.ok(!('source_url' in indexData.settings['101']));
    assert.deepEqual(indexData.aliases['7'], ['The Kesh']);
});

await test('write then read round-trips the index and its version', async () => {
    const { store } = await loadStore();
    const manifest = await store.writeIndex(SAMPLE, { v: 2345, date: '2026-07-01' });
    assert.equal(manifest.v, 2345);
    assert.equal(manifest.bytes, SAMPLE.length);

    const result = await store.readIndex();
    assert.ok(result, 'expected an offline copy');
    assert.equal(result.manifest.v, 2345);
    assert.equal(result.index.abcStrings['101'], 'ABC-ONE');
    assert.equal(result.index.indexData.settings['101'].abc, '');
});

// THE important property: an update that fails must never cost the user the
// copy they already had. They discover the loss next time they are offline,
// which is precisely when they cannot recover it.
await test('a failed update PRESERVES the existing offline copy', async () => {
    const { store, idb } = await loadStore();
    await store.writeIndex(SAMPLE, { v: 100, date: '2026-01-01' });

    idb.__state.failOn = 'ffIndexRaw';
    await assert.rejects(() => store.writeIndex('{"settings":{},"aliases":{}}',
        { v: 101, date: null }));

    const still = await store.readIndex();
    assert.ok(still, 'the previous copy must survive a failed update');
    assert.equal(still.manifest.v, 100, 'and keep its version');
    assert.equal(still.index.abcStrings['101'], 'ABC-ONE');
});

await test('an interrupted update (payload written, manifest not) keeps the data', async () => {
    const { store, idb } = await loadStore();
    await store.writeIndex(SAMPLE, { v: 100, date: null });

    // Payload commits, then the process dies before the manifest is written.
    idb.__state.failOn = 'ffIndexManifest';
    await assert.rejects(() => store.writeIndex(SAMPLE, { v: 101, date: null }));

    const after = await store.readIndex();
    assert.ok(after, 'data must remain usable after an interrupted write');
    assert.equal(after.index.abcStrings['101'], 'ABC-ONE');
});

await test('a payload with no manifest at all is used, not deleted', async () => {
    const { store, idb } = await loadStore();
    await store.writeIndex(SAMPLE, { v: 7, date: null });
    idb.__db.delete('ffIndexManifest');   // e.g. selective eviction

    const result = await store.readIndex();
    assert.ok(result, 'a parseable payload is usable even with no manifest');
    assert.equal(result.manifest.versionUnknown, true,
        'version reported unknown so an update is attempted when online');
    assert.equal(idb.__db.has('ffIndexRaw'), true, 'payload must NOT be deleted');
});

await test('a manifest describing a different payload still yields the data', async () => {
    const { store, idb } = await loadStore();
    await store.writeIndex(SAMPLE, { v: 7, date: null });
    idb.__db.set('ffIndexManifest',
        { schema: 2, v: 6, date: null, savedAt: 1, bytes: 999999 });

    const result = await store.readIndex();
    assert.ok(result, 'mismatched bookkeeping must not discard good data');
    assert.equal(result.manifest.versionUnknown, true);
    assert.equal(result.index.abcStrings['101'], 'ABC-ONE');
});

await test('a manifest without its payload drops only the dangling record', async () => {
    const { store, idb } = await loadStore();
    await store.writeIndex(SAMPLE, { v: 7, date: null });
    idb.__db.delete('ffIndexRaw');
    assert.equal(await store.readIndex(), null);
    assert.equal(idb.__db.has('ffIndexManifest'), false);
});

await test('unparseable payload is discarded rather than thrown', async () => {
    const { store, idb } = await loadStore();
    await store.writeIndex(SAMPLE, { v: 7, date: null });
    idb.__db.set('ffIndexRaw', '{ this is not json');
    assert.equal(await store.readIndex(), null);
    assert.equal(idb.__db.has('ffIndexRaw'), false);
});

await test('reads never throw, even when IndexedDB itself fails', async () => {
    const { store, idb } = await loadStore();
    idb.__state.throwOn = 'ffIndexManifest';
    assert.equal(await store.readIndex(), null);
    assert.equal(await store.readManifest(), null);
});

await test('legacy (schema 1) cache is still readable — no forced re-download', async () => {
    const { store, idb } = await loadStore();
    idb.__db.set('tuneIndex', {
        indexData: { settings: { '101': { tune_id: '7', abc: '' } }, aliases: {} },
        abcStrings: { '101': 'LEGACY-ABC' },
        sourceUrls: {},
    });
    idb.__db.set('tuneIndexMetadata', { v: 999, date: '2025-01-01' });

    const result = await store.readIndex();
    assert.ok(result, 'legacy cache must still load');
    assert.equal(result.manifest.legacy, true);
    assert.equal(result.manifest.v, 999);
    assert.equal(result.index.abcStrings['101'], 'LEGACY-ABC');

    const manifest = await store.readManifest();
    assert.equal(manifest.legacy, true);
});

await test('a successful schema-2 write reclaims the legacy 42 MB copy', async () => {
    const { store, idb } = await loadStore();
    idb.__db.set('tuneIndex', { indexData: {}, abcStrings: {} });
    idb.__db.set('tuneIndexMetadata', { v: 1, date: null });
    await store.writeIndex(SAMPLE, { v: 2, date: null });
    assert.equal(idb.__db.has('tuneIndex'), false);
    assert.equal(idb.__db.has('tuneIndexMetadata'), false);
});

await test('an orphaned payload is adopted rather than binned', async () => {
    const { store, idb } = await loadStore();
    idb.__db.set('ffIndexRaw', SAMPLE); // write that died before the manifest
    const result = await store.readIndex();
    assert.ok(result, 'orphaned but valid data is still the user\'s offline copy');
    assert.equal(idb.__db.has('ffIndexRaw'), true);
});

console.log('\ntuneIndexStore — exhaustive fault injection');

// The bug that stranded a user in a pub with no signal was not caught by any
// hand-written test, because the tests asserted the implementation's behaviour
// rather than the property that matters. These walk a failure across EVERY
// storage operation in an update and assert the invariant directly:
//
//   if a usable offline copy existed before an update, one exists after it,
//   no matter where the update died.
//
// That holds regardless of how writeIndex is implemented, so it survives a
// future rewrite that reintroduces the same mistake in a different shape.

const NEWER = JSON.stringify({
    settings: { '201': { tune_id: '9', abc: 'NEW-ABC', contour: 'qqqq' } },
    aliases: { '9': ['A Newer Tune'] },
});

await test('a good copy survives an interruption at EVERY step of an update', async () => {
    // Discover how many operations a successful update takes.
    const probe = await loadStore();
    await probe.store.writeIndex(SAMPLE, { v: 1, date: null });
    probe.idb.__state.ops = 0;
    await probe.store.writeIndex(NEWER, { v: 2, date: null });
    const totalOps = probe.idb.__state.ops;
    assert.ok(totalOps >= 2, `expected several ops, saw ${totalOps}`);

    const survived = [];
    for (let failAt = 1; failAt <= totalOps; failAt++) {
        const { store, idb } = await loadStore();
        await store.writeIndex(SAMPLE, { v: 1, date: '2026-01-01' });

        idb.__state.ops = 0;
        idb.__state.failAtOp = failAt;
        try {
            await store.writeIndex(NEWER, { v: 2, date: '2026-02-02' });
        } catch (e) {
            if (!e.simulated) throw e;   // a real bug, not our injected fault
        }
        idb.__state.failAtOp = null;

        const after = await store.readIndex();
        assert.ok(after,
            `interrupting at op ${failAt}/${totalOps} destroyed the offline copy`);
        // Whichever version survived, it must be complete and readable.
        const abc = after.index.abcStrings['101'] || after.index.abcStrings['201'];
        assert.ok(abc, `interrupting at op ${failAt} left an incomplete payload`);
        survived.push(after.manifest.v);
    }
    console.log(`      ${totalOps} interruption points, all survived (versions seen: ${[...new Set(survived)].join(', ')})`);
});

await test('a good copy survives a quota failure on any single key', async () => {
    for (const key of ['ffIndexRaw', 'ffIndexManifest']) {
        const { store, idb } = await loadStore();
        await store.writeIndex(SAMPLE, { v: 1, date: null });

        idb.__state.failOn = key;
        await assert.rejects(() => store.writeIndex(NEWER, { v: 2, date: null }));
        idb.__state.failOn = null;

        const after = await store.readIndex();
        assert.ok(after, `a quota failure on ${key} destroyed the offline copy`);
        assert.ok(after.index.abcStrings['101'] || after.index.abcStrings['201'],
            `a quota failure on ${key} left an incomplete payload`);
    }
});

await test('repeated failed updates never erode the copy', async () => {
    const { store, idb } = await loadStore();
    await store.writeIndex(SAMPLE, { v: 1, date: null });
    for (let i = 0; i < 25; i++) {
        idb.__state.failAtOp = (i % 3) + 1;
        try { await store.writeIndex(NEWER, { v: 2 + i, date: null }); }
        catch (e) { if (!e.simulated) throw e; }
        idb.__state.failAtOp = null;
        const still = await store.readIndex();
        assert.ok(still, `copy lost after ${i + 1} failed updates`);
    }
});

await test('a fresh install never reports a partial copy as usable', async () => {
    // With no prior copy the invariant is weaker but still absolute: readIndex
    // must return either nothing or something complete — never half a payload.
    for (let failAt = 1; failAt <= 4; failAt++) {
        const { store, idb } = await loadStore();
        idb.__state.failAtOp = failAt;
        try { await store.writeIndex(SAMPLE, { v: 1, date: null }); }
        catch (e) { if (!e.simulated) throw e; }
        idb.__state.failAtOp = null;

        const after = await store.readIndex();
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

await test('offline is detected without touching the network', async () => {
    const net = await loadNetwork();
    let called = false;
    stubEnv({ onLine: false, fetchImpl: async () => { called = true; } });
    await assert.rejects(() => net.fetchTuneIndexMetadata(), /offline/i);
    await assert.rejects(() => net.fetchTuneIndexText(), /offline/i);
    assert.equal(called, false, 'must not issue a request when known offline');
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
    await assert.rejects(() => net.fetchTuneIndexMetadata(), /timed out/i);
    assert.equal(aborted, true);
    assert.ok(Date.now() - started < 2000, 'must not wait on the platform default');
});

await test('index download aborts when the stream stalls mid-transfer', async () => {
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
    await assert.rejects(() => net.fetchTuneIndexText(), /stalled/i);
    assert.equal(aborted, true);
    assert.ok(Date.now() - started < 2000);
});

await test('a healthy streamed download is reassembled and reports progress', async () => {
    const net = await loadNetwork();
    const encoder = new TextEncoder();
    const chunks = [SAMPLE.slice(0, 20), SAMPLE.slice(20)].map(c => encoder.encode(c));
    stubEnv({
        onLine: true,
        fetchImpl: async () => ({
            ok: true,
            headers: { get: () => String(encoder.encode(SAMPLE).length) },
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
        }),
    });
    const progress = [];
    const text = await net.fetchTuneIndexText(null, p => progress.push(p));
    assert.equal(text, SAMPLE);
    assert.equal(progress.length, 2);
    assert.equal(progress.at(-1).received, encoder.encode(SAMPLE).length);
    assert.ok(progress.at(-1).total > 0);
});

await test('cache-busting version is appended only when asked for', async () => {
    const net = await loadNetwork();
    assert.ok(!net.tuneIndexDataUrl().includes('?v='));
    assert.ok(net.tuneIndexDataUrl(1234).endsWith('?v=1234'));
});

await rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
