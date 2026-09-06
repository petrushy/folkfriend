// Unit tests for saved live-listening sessions ("Past Sessions"): the
// store.js CRUD/cap/export-import safety, and the liveAnalysis.js
// orchestration that decides when a session is fresh vs resumed, when it gets
// saved, and how Stop/Clear finalize it.
//
// Run with:  node app/test/liveSessions.test.mjs
//
// The properties worth pinning here are not "does it save a record". They are
// the ones that make Resume/Clear actually work as described to the user:
//
//   - History is recorded UNCONDITIONALLY, never gated by geoTagDetections —
//     that setting controls only whether a location gets attached.
//   - A session is saved on the EDGE (the tail tune changes), not every
//     analysis cycle, so an hours-long session doesn't hammer IndexedDB.
//   - start() called a second time on an already-open session RESUMES rather
//     than resets — the whole point of Stop no longer being destructive.
//   - stop() flushes the tail tune's current endSeconds even when the edge
//     tracker itself has gone quiet, so the stored copy is never stale by
//     however long the last tune kept playing.
//   - clear() is the only thing that finalizes (endedAt) and resets state so
//     the next start() is unambiguously fresh.
//
// store.js is loaded from source with its imports rewritten to in-memory
// fakes, following sightings.test.mjs's loadStore(). liveAnalysis.js is
// loaded from source the same way, following liveAnalysisReject.test.mjs's
// loadService() — real clustering/collapse, fake microphone/backend/geo/store.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import { loadSessionAnalysisModule, sessionAnalysisTmpDir } from './helpers/loadSessionAnalysis.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const storeTmpDir = path.join(here, '.tmp-live-sessions-store');
const serviceTmpDir = path.join(here, '.tmp-live-sessions-service');

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

// --- store.js half ----------------------------------------------------------

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
    await mkdir(storeTmpDir, { recursive: true });
    for (const [name, source] of Object.entries(STORE_FAKES)) {
        await writeFile(path.join(storeTmpDir, name), source);
    }
    for (const name of ['schema.js', 'places.mjs']) {
        await writeFile(
            path.join(storeTmpDir, name.replace('.js', '.mjs')),
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
    await writeFile(path.join(storeTmpDir, 'store.mjs'), source);

    globalThis.localStorage = new FakeLocalStorage();

    const idb = await import(path.join(storeTmpDir, 'fake-idb.mjs'));
    idb.__db.clear();
    idb.__allowAll();
    const bus = await import(path.join(storeTmpDir, 'fake-eventbus.mjs'));
    bus.__events.length = 0;

    const mod = await import(`${path.join(storeTmpDir, 'store.mjs')}?v=${Math.random()}`);
    return { store: mod.default, bus, idb };
}

// --- liveAnalysis.js half ----------------------------------------------------

const FAKE_MIC = `
export let __healthy = true;
export let __startCalls = 0;
export function __setHealthy(v) { __healthy = v; }
export function __resetCalls() { __startCalls = 0; }
export function __reset() { __healthy = true; __startCalls = 0; __pcm = new Float32Array(0); }
export let __pcm = new Float32Array(0);
export function __setPcm(n) { __pcm = new Float32Array(n); }
export default {
    audioCtx: null,
    sampleRate: 44100,
    async startContinuous() { __startCalls++; },
    async stopContinuous() {},
    async ensureMicHealthy() { return __healthy; },
    getContinuousAudio() { return __pcm; },
};`;
// Controllable: a test can hold a transcription open across a Pause, which is
// the window in which a stale loop does its damage.
const FAKE_BACKEND = `
export const __calls = [];
export let __pending = null;
export function __holdNext() {
    let release;
    __pending = { promise: new Promise(r => { release = r; }), release };
    return __pending;
}
export function __reset() { __calls.length = 0; __pending = null; }
export default {
    async transcribeAndQueryPCMSignal(pcm, sampleRate) {
        __calls.push({ length: pcm.length, sampleRate });
        if (__pending) {
            const held = __pending;
            __pending = null;
            return held.promise;
        }
        return { results: [] };
    },
};`;
const FAKE_GEO = `
export let __fix = null;
export function __setFix(f) { __fix = f; }
export function __reset() { __fix = null; }
export default { beginSession() {}, async getFix() { return __fix; } };
`;
const FAKE_STORE = `
export const __sessions = [];
export let __upsertCalls = 0;
// A queue of per-call delays (ms), consumed in call order, so a test can make
// an EARLIER write finish LATER than a write made after it — the only way to
// actually exercise a write-ordering race rather than coincidentally passing
// because two equal delays preserve call order.
export let __delays = [];
export function __setDelays(ds) { __delays = ds.slice(); }
// Makes the next N writes reject, for the save-failure paths.
export let __failUpserts = 0;
export function __failNextUpserts(n) { __failUpserts = n; }
export const userSettings = { geoTagDetections: false };
export default {
    userSettings,
    async addSighting() {},
    async upsertLiveSession(session) {
        __upsertCalls++;
        const delay = __delays.length ? __delays.shift() : 0;
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (__failUpserts > 0) { __failUpserts--; throw new Error('quota exceeded'); }
        const record = { ...session };
        const i = __sessions.findIndex(s => s.id === record.id);
        if (i === -1) __sessions.unshift(record); else __sessions[i] = record;
        return record;
    },
    async deleteLiveSession(id) {
        const index = __sessions.findIndex(s => s.id === id);
        if (index >= 0) __sessions.splice(index, 1);
    },
    async getLiveSessions() { return __sessions.slice(); },
    async getLiveSessionsStrict() { return __sessions.slice(); },
    async setOpenLiveSession(state) { __openSession = state; },
    async getOpenLiveSession() { return __openSession; },
    async clearOpenLiveSession() { __openSession = null; },
};
export let __openSession = null;
export function __setOpenSession(s) { __openSession = s; }
export function __reset() {
    __sessions.length = 0;
    __upsertCalls = 0;
    __delays = [];
    __failUpserts = 0;
    __openSession = null;
    userSettings.geoTagDetections = false;
}
`;
const FAKE_EVENTBUS = `
export const __emits = [];
export default { $emit(name, payload) { __emits.push({ name, payload }); }, $on() {}, $off() {} };
`;

async function loadService({ keepStore = false } = {}) {
    await mkdir(serviceTmpDir, { recursive: true });
    await loadSessionAnalysisModule();

    await writeFile(path.join(serviceTmpDir, 'fake-mic.mjs'), FAKE_MIC);
    await writeFile(path.join(serviceTmpDir, 'fake-backend.mjs'), FAKE_BACKEND);
    await writeFile(path.join(serviceTmpDir, 'fake-geo.mjs'), FAKE_GEO);
    await writeFile(path.join(serviceTmpDir, 'fake-store.mjs'), FAKE_STORE);
    await writeFile(path.join(serviceTmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);

    let source = await readFile(path.join(srcDir, 'services', 'liveAnalysis.js'), 'utf8');
    const sessionAnalysisCopy = path.join(sessionAnalysisTmpDir, 'sessionAnalysis.mjs');
    const biasModule = path.join(srcDir, 'js', 'biasResults.mjs');
    const replacements = [
        ["from './mic.js'", "from './fake-mic.mjs'"],
        ["from './backend.js'", "from './fake-backend.mjs'"],
        ["from './geo.js'", "from './fake-geo.mjs'"],
        ["from './store.js'", "from './fake-store.mjs'"],
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from '@/js/sessionAnalysis.js'", `from '${sessionAnalysisCopy}'`],
        ["from '@/js/biasResults.mjs'", `from '${biasModule}'`],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in liveAnalysis.js`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(serviceTmpDir, 'liveAnalysis.mjs'), source);

    const store = await import(path.join(serviceTmpDir, 'fake-store.mjs'));
    const geo = await import(path.join(serviceTmpDir, 'fake-geo.mjs'));
    const bus = await import(path.join(serviceTmpDir, 'fake-eventbus.mjs'));
    const mic = await import(path.join(serviceTmpDir, 'fake-mic.mjs'));
    const backend = await import(path.join(serviceTmpDir, 'fake-backend.mjs'));
    backend.__reset();
    // keepStore models a RELOAD: a brand new service instance over storage
    // that still holds what the previous one wrote.
    if (!keepStore) store.__reset();
    geo.__reset();
    mic.__reset();
    bus.__emits.length = 0;

    const mod = await import(`${path.join(serviceTmpDir, 'liveAnalysis.mjs')}?v=${Math.random()}`);
    const service = mod.default;

    return { service, store, geo, bus, mic, backend };
}

// One window match, as _runLoop would push it.
function match(tuneId, startSeconds, score = 0.7) {
    return {
        startSeconds,
        tuneId,
        settingId: String(tuneId * 10),
        sourceUrl: '',
        dataset: '',
        displayName: `tune-${tuneId}`,
        score,
        alternatives: [],
    };
}

// Feeds a run of consecutive windows for one tune, at the service's step, and
// re-clusters — what _runLoop would do on each accepted cycle.
function play(service, tuneId, fromSeconds, windowCount, score = 0.7) {
    for (let i = 0; i < windowCount; i++) {
        service._windowMatches.push(
            match(tuneId, fromSeconds + i * service.options.stepSeconds, score));
    }
    service.elapsedSeconds =
        fromSeconds + (windowCount - 1) * service.options.stepSeconds;
    service._recluster();
}

async function run() {
    await rm(storeTmpDir, { recursive: true, force: true });
    await rm(serviceTmpDir, { recursive: true, force: true });

    console.log('\nstore — saved live sessions (Past Sessions)');

    await test('upsertLiveSession creates then updates by id, not duplicates', async () => {
        const { store } = await loadStore();
        await store.upsertLiveSession({ id: 's1', startedAt: 1000, endedAt: null, tunes: [{ tuneId: 1 }] });
        await store.upsertLiveSession({ id: 's1', startedAt: 1000, endedAt: 2000, tunes: [{ tuneId: 1 }, { tuneId: 2 }] });
        const sessions = await store.getLiveSessions();
        assert.equal(sessions.length, 1, 'the second call updates in place rather than duplicating');
        assert.equal(sessions[0].tunes.length, 2);
        assert.equal(sessions[0].endedAt, 2000);
    });

    await test('saved sessions are retained beyond the former 300-session limit', async () => {
        const { store } = await loadStore();
        for (let i = 0; i < 301; i++) {
            await store.upsertLiveSession({ id: `s${i}`, startedAt: i, endedAt: i, tunes: [] });
        }
        const sessions = await store.getLiveSessions();
        assert.equal(sessions.length, 301);
        assert.ok(sessions.some(s => s.id === 's0'), 'the oldest session is still saved');
        assert.ok(sessions.some(s => s.id === 's300'), 'the most recent session survives');
    });

    await test('deleteLiveSession removes exactly one record and emits an event', async () => {
        const { store, bus } = await loadStore();
        await store.upsertLiveSession({ id: 's1', startedAt: 1, tunes: [] });
        await store.upsertLiveSession({ id: 's2', startedAt: 2, tunes: [] });
        bus.__events.length = 0;
        await store.deleteLiveSession('s1');
        const sessions = await store.getLiveSessions();
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].id, 's2');
        assert.ok(bus.__events.some(e => e.name === 'liveSessionsChanged'));
    });

    await test('clearLiveSessions empties the list and emits an event', async () => {
        const { store, bus } = await loadStore();
        await store.upsertLiveSession({ id: 's1', startedAt: 1, tunes: [] });
        bus.__events.length = 0;
        await store.clearLiveSessions();
        assert.equal((await store.getLiveSessions()).length, 0);
        assert.ok(bus.__events.some(e => e.name === 'liveSessionsChanged'));
    });

    await test('exportUserData reports version 5 and includes liveSessions', async () => {
        const { store } = await loadStore();
        await store.upsertLiveSession({ id: 's1', startedAt: 1, tunes: [{ tuneId: 1 }] });
        const exported = JSON.parse(await store.exportUserData());
        assert.equal(exported.version, 5);
        assert.equal(exported.liveSessions.length, 1);
    });

    await test('an older backup without liveSessions does not wipe existing sessions', async () => {
        const { store } = await loadStore();
        await store.upsertLiveSession({ id: 's1', startedAt: 1, tunes: [] });
        await store.importUserData(JSON.stringify({ version: 4, historyItems: [], favouriteItems: [] }));
        assert.equal((await store.getLiveSessions()).length, 1, 'an older backup must not delete sessions');
    });

    console.log('\nstore — a failed write is a failure, not a success');

    await test('a failed session write rejects instead of reporting success', async () => {
        const { store, idb } = await loadStore();
        idb.__failWritesTo('liveSessions');

        await assert.rejects(
            () => store.upsertLiveSession({ id: 's1', startedAt: 1, tunes: [] }),
            // store._dbSet swallows write errors, which is right for data that
            // can be re-fetched and catastrophically wrong here: the session
            // lives in memory until this write lands, so a swallowed failure
            // means the UI is told it saved and Finish then discards the only
            // copy. Session persistence uses the strict path.
            /Quota/,
        );
    });

    await test('a failed read never presents as an empty collection', async () => {
        const { store, idb } = await loadStore();
        await store.upsertLiveSession({ id: 'keep-me', startedAt: 1, tunes: [{ tuneId: 1 }] });
        idb.__failReadsOf('liveSessions');

        await assert.rejects(() => store.upsertLiveSession({ id: 's2', startedAt: 2, tunes: [] }));

        // The mutation reads the current list, changes it and writes it back.
        // Substituting [] for a failed read would write that empty array over
        // a history we simply could not see — one unreadable read becoming a
        // wiped log.
        idb.__allowAll();
        const kept = await store.getLiveSessions();
        assert.equal(kept.length, 1, 'the stored history is untouched by a failed read');
        assert.equal(kept[0].id, 'keep-me');
    });

    await test('a failed resume-state write is reported too', async () => {
        const { store, idb } = await loadStore();
        idb.__failWritesTo('openLiveSession');
        await assert.rejects(() => store.setOpenLiveSession({ sessionId: 's1' }),
            'resume state that silently failed to save is a session that cannot be recovered');
    });

    await test('names include the matching place only when enabled, and manual names survive', async () => {
        const { store } = await loadStore();
        store.getPlaces = async () => [{ id: 'pub', name: 'The Cobblestone', lat: 53.35, lon: -6.28 }];
        const record = { id: 'named', startedAt: 1757000000000, tunes: [], lat: 53.35, lon: -6.28 };
        store.userSettings.geoTagDetections = false;
        const plain = await store.upsertLiveSession(record);
        assert.ok(plain.name);
        assert.ok(!plain.name.includes('Cobblestone'));
        store.userSettings.geoTagDetections = true;
        const placed = await store.upsertLiveSession(record);
        assert.ok(placed.name.includes('The Cobblestone'));
        const renamed = await store.upsertLiveSession({ ...placed, name: 'Sunday reels', customName: true });
        assert.equal(renamed.name, 'Sunday reels');
    });

    await test('editing stored tunes preserves metadata and cannot resurrect a deleted session', async () => {
        const { store } = await loadStore();
        await store.upsertLiveSession({ id: 'edited', startedAt: 1000, name: 'Evening', customName: true, tunes: [{ tuneId: 1 }] });
        await Promise.all([
            store.updateLiveSession('edited', { name: 'Renamed' }),
            store.updateLiveSession('edited', { tunes: [] }),
        ]);
        const [saved] = await store.getLiveSessions();
        assert.equal(saved.name, 'Renamed');
        assert.equal(saved.startedAt, 1000);
        assert.deepEqual(saved.tunes, []);
        await store.deleteLiveSession('edited');
        await assert.rejects(store.updateLiveSession('edited', { tunes: [{ tuneId: 2 }] }));
        assert.deepEqual(await store.getLiveSessions(), []);
    });

    console.log('\nliveAnalysis.js — fresh vs resume, and when a session is saved');

    await test('fresh start() saves the empty session before any detection', async () => {
        const { service, store } = await loadService();
        assert.equal(service.sessionId, null);
        await service.start(10, 5);
        assert.ok(service.sessionId, 'a fresh session gets an id');
        await service._saveChain;
        assert.equal(store.__sessions.length, 1, 'the session is saved without a Finish action');
        await service.stop();
    });

    await test('the session saves on each tune change, not on a repeat of the same tail tune', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);

        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        assert.equal(store.__upsertCalls, 2);
        assert.equal(store.__sessions[0].tunes.length, 1);

        // Re-clustering again while the SAME tune is still the tail must not
        // trigger a second save — that is the whole point of the edge tracker.
        play(service, 1, 30, 2);
        await service._maybeSaveSessionSnapshot();
        assert.equal(store.__upsertCalls, 2, 'no save fires while the tail tune has not changed');

        play(service, 2, 60, 6);
        await service._maybeSaveSessionSnapshot();
        assert.equal(store.__upsertCalls, 3, 'a genuine tune change triggers a save');
        assert.equal(store.__sessions[0].tunes.length, 2);

        await service.stop();
    });

    await test('start() twice while a session is open resumes rather than resets', async () => {
        const { service } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        const detectionsBefore = service.detections.length;
        const windowMatchesBefore = service._windowMatches.length;
        const elapsedBefore = service.elapsedSeconds;
        const sessionIdBefore = service.sessionId;

        await service.stop();
        assert.equal(service.sessionId, sessionIdBefore, 'stop must not end the session');

        await service.start(10, 5); // "Resume"
        assert.equal(service.sessionId, sessionIdBefore, 'resuming keeps the same session id');
        assert.equal(service.detections.length, detectionsBefore, 'the list is not wiped');
        assert.equal(service._windowMatches.length, windowMatchesBefore);
        assert.equal(service.elapsedSeconds, elapsedBefore, 'elapsed time is not reset to 0');

        await service.finish();
        assert.equal(service.sessionId, null, 'finish() is what actually ends it');
    });

    await test('clear() during an active session ends up finalized despite stop()\'s own flush racing it', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();

        // finish() while still running calls stop() internally first (flush #1,
        // endedAt: null) and then makes its own finalizing write (flush #2,
        // endedAt: set). Real IndexedDB writes are not instant, and nothing
        // guarantees #1 finishes before #2 starts — so make #1 the SLOWER of
        // the two: if the writes are not correctly ordered, #1 lands last and
        // silently reverts the session to "open".
        store.__setDelays([50, 0]);
        assert.equal(service.isRunning, true);
        await service.finish();

        // Give a wrongly-unordered flush #1 time to land and clobber flush #2
        // before checking — the bug is only visible once that slow write
        // actually resolves, not at the instant clear() returns.
        await new Promise(resolve => setTimeout(resolve, 80));

        assert.ok(store.__sessions[0].endedAt,
            'the session must end up finalized, not reverted to open by a late-landing flush');
    });

    await test("stop() flushes the tail tune's current endSeconds even without a new edge", async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        assert.equal(store.__upsertCalls, 2);
        const savedEndBefore = store.__sessions[0].tunes[0].endSeconds;

        // The tune keeps playing — the live detection's endSeconds advances,
        // but the tail tune has not CHANGED, so the edge tracker stays quiet.
        service.detections[service.detections.length - 1].endSeconds = savedEndBefore + 100;
        await service._maybeSaveSessionSnapshot();
        assert.equal(store.__upsertCalls, 2, 'no new edge fires while the same tune keeps playing');
        assert.equal(store.__sessions[0].tunes[0].endSeconds, savedEndBefore,
            'the stored copy is stale until something forces a re-serialize');

        await service.stop();
        assert.equal(store.__sessions[0].tunes[0].endSeconds, savedEndBefore + 100,
            "stop() re-serializes the CURRENT detections regardless of the edge tracker");
    });

    await test('finish() finalizes the session and resets service state', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        const sessionId = service.sessionId;

        await service.finish();

        assert.equal(service.sessionId, null);
        assert.deepEqual(service.detections, []);
        assert.deepEqual(service._windowMatches, []);
        assert.equal(service.elapsedSeconds, 0);
        assert.equal(store.__sessions[0].id, sessionId);
        assert.ok(store.__sessions[0].endedAt, 'the finalized record carries an end time');
    });

    console.log('\nliveAnalysis.js — edits reach the saved list');

    await test('a corrected tune survives the next re-cluster', async () => {
        const { service } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        const row = service.detections[service.detections.length - 1];

        service.applyCorrection(row.id, {
            tuneId: 99, settingId: '990', title: 'What it really was',
            sourceUrl: '', dataset: 'thesession',
        });
        assert.equal(service.detections[0].tuneId, 99);

        // The correction lives in the window matches, so clustering — which
        // rebuilds detections from scratch every cycle — reproduces it rather
        // than overwriting it. Recording it on the detection object could not
        // survive this, because the ids are not stable across a re-cluster.
        service._recluster();
        assert.equal(service.detections[0].tuneId, 99, 'the detector does not win it back');
        assert.equal(service.detections[0].title, 'What it really was');

        await service.stop();
    });

    await test('a correction reaches the saved record', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();

        service.applyCorrection(service.detections[0].id, {
            tuneId: 99, settingId: '990', title: 'What it really was',
            sourceUrl: '', dataset: 'thesession',
        });
        await service._persistSession();

        assert.equal(store.__sessions[0].tunes[0].tuneId, 99);
        assert.equal(store.__sessions[0].tunes[0].title, 'What it really was');
        await service.stop();
    });

    await test('removing the last detection is saved, not silently kept', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        assert.equal(store.__sessions[0].tunes.length, 1);

        service.removeDetection(service.detections[0].id);
        assert.deepEqual(service.detections, []);
        await service._persistSession();

        // An empty list is a real edit once the session has a record. Treating
        // it as "nothing to save" left the removed tune in Past Sessions.
        assert.equal(store.__sessions[0].tunes.length, 0,
            'the removal has to reach the stored copy');
        await service.stop();
    });

    await test('a session with no recognised tunes remains saved', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        await service._persistSession();
        assert.equal(store.__sessions.length, 1,
            'empty sessions are saved automatically too');
        await service.stop();
    });

    await test('Clear keeps the named session and microphone, and persists an empty list', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        const id = service.sessionId;
        await service.rename('Sunday session');
        await service.clearTunes();
        assert.equal(service.sessionId, id);
        assert.equal(service.isRunning, true);
        assert.equal(store.__sessions[0].name, 'Sunday session');
        assert.deepEqual(store.__sessions[0].tunes, []);
        assert.deepEqual(service._windowMatches, []);
        await service.stop();
    });

    await test('deleting a session waits for queued saves and never recreates it', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        await service._saveChain;
        play(service, 1, 0, 6);
        store.__setDelays([30]);
        service._persistSession();
        await service.deleteSession();
        assert.equal(service.sessionId, null);
        assert.equal(service.isRunning, false);
        assert.deepEqual(store.__sessions, []);
        await service._persistSession();
        assert.deepEqual(store.__sessions, []);
    });

    console.log('\nliveAnalysis.js — failures stay recoverable');

    await test('a failed final save keeps the session rather than dropping it', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        // Paused first, so the only write finish() makes is its own finalizing
        // one — otherwise the injected failure lands on stop()'s flush instead.
        await service.pause();

        store.__failNextUpserts(1);
        const result = await service.finish();

        assert.equal(result.ok, false, 'the caller is told');
        assert.ok(service.sessionId, 'and the only remaining copy is still here');
        assert.equal(service.detections.length, 1);
        assert.equal(service.saveState, 'error');

        // Retrying is all that should be needed.
        const retry = await service._persistSession({ endedAt: Date.now() });
        assert.equal(retry.ok, true);
        assert.equal(service.saveState, 'saved');
    });

    await test('a save failure is reported and cleared again on success', async () => {
        const { service, store, bus } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);

        store.__failNextUpserts(1);
        const failed = await service._persistSession();
        assert.equal(failed.ok, false);
        assert.ok(bus.__emits.some(e => e.name === 'liveAnalysisSaveState' && e.payload.state === 'error'));

        const ok = await service._persistSession();
        assert.equal(ok.ok, true);
        assert.equal(service.saveError, null);
        await service.stop();
    });

    await test('a microphone that cannot be reacquired stops analysis rather than repeating stale audio', async () => {
        const { service, mic } = await loadService();
        await service.start(10, 5);
        mic.__setHealthy(false);

        const healthy = await service.retryMicrophone();
        assert.equal(healthy, false);
        assert.equal(service.micHealthy, false, 'and the state says so, so the UI can too');

        mic.__setHealthy(true);
        assert.equal(await service.retryMicrophone(), true);
        assert.equal(service.micHealthy, true);
        await service.stop();
    });

    console.log('\nliveAnalysis.js — checkpoints and stale loops');

    await test('a continuing tune is checkpointed without any explicit save', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        const writesAfterEdge = store.__upsertCalls;

        // The tail tune has not changed, so the edge trigger stays silent — but
        // the tune's duration and the elapsed time have moved on, and before
        // the checkpoint was wired into the loop a twenty-minute tune stored
        // nothing after its first cycle.
        service.detections[0].endSeconds += 600;
        service.elapsedSeconds += 600;
        service._scheduleCheckpoint(1);
        await new Promise(resolve => setTimeout(resolve, 40));

        assert.ok(store.__upsertCalls > writesAfterEdge, 'the checkpoint fired on its own');
        assert.equal(store.__sessions[0].listenedSeconds, service.elapsedSeconds,
            'and it recorded the listening time, not just the tunes');
        await service.stop();
    });

    await test('a stream of updates cannot postpone a checkpoint for ever', async () => {
        const { service } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._persistSession();

        // A pure debounce is reset by every update, and the loop produces one
        // every few seconds — so during exactly the long unbroken session the
        // checkpoint exists for, it would never fire.
        service._lastCheckpointAt = Date.now() - 10 * 60 * 1000;
        service._scheduleCheckpoint();
        assert.equal(service._checkpointTimer, null,
            'an overdue checkpoint saves now rather than pushing the deadline out again');
        await service.stop();
    });

    await test('a transcription in flight across Pause then Resume is discarded', async () => {
        const { service, mic, backend } = await loadService();
        mic.__setPcm(4096);
        const held = backend.__holdNext();

        // Very short window/step so the loop reaches its transcription quickly.
        await service.start(0.02, 0.02);
        for (let i = 0; i < 50 && backend.__calls.length === 0; i++) {
            await new Promise(r => setTimeout(r, 10));
        }
        assert.equal(backend.__calls.length, 1, 'the loop is waiting on a transcription');

        await service.pause();
        const detectionsAtPause = service.detections.length;
        // Resume BEFORE the held transcription resolves. This is the reported
        // sequence: isRunning is true again, so the old loop's own isRunning
        // check waves its stale result through, appends it, and carries on
        // looping alongside the new one. Only the generation token separates
        // them.
        mic.__setPcm(0);
        await service.start(0.02, 0.02);
        const callsAfterResume = backend.__calls.length;

        held.release({
            results: [{ setting: { tune_id: 7, dataset: 'thesession' }, setting_id: 70, score: 0.9, display_name: 'Ghost tune' }],
        });
        await new Promise(r => setTimeout(r, 60));

        assert.equal(service.detections.length, detectionsAtPause,
            'a result from a run that has ended must not reach the session');
        // The new loop is entitled to keep calling; the OLD one is not, so the
        // count must not have jumped by the two loops both running.
        assert.ok(backend.__calls.length - callsAfterResume <= 1,
            'the old loop must not still be cycling beside the new one');
        await service.stop();
    });

    await test('a transcription pending across Finish cannot reach the next session', async () => {
        const { service, mic, backend } = await loadService();
        mic.__setPcm(4096);
        const held = backend.__holdNext();

        await service.start(0.02, 0.02);
        for (let i = 0; i < 50 && backend.__calls.length === 0; i++) {
            await new Promise(r => setTimeout(r, 10));
        }
        await service.finish();

        mic.__setPcm(0); // the new session hears nothing, so nothing else can add rows
        await service.start(0.02, 0.02);
        const newSessionId = service.sessionId;

        held.release({
            results: [{ setting: { tune_id: 7, dataset: 'thesession' }, setting_id: 70, score: 0.9, display_name: 'Ghost tune' }],
        });
        await new Promise(r => setTimeout(r, 60));

        assert.equal(service.sessionId, newSessionId);
        assert.deepEqual(service.detections, [],
            'last session\'s audio must not appear in this one');
        await service.stop();
    });

    await test('pause and finish each invalidate the run they end', async () => {
        const { service } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        const before = service.detections.length;

        // The generation is what the loop checks after every await. Pausing
        // ends the run, so an in-flight transcription resolving afterwards
        // belongs to nobody.
        const staleGeneration = service._generation;
        await service.pause();
        assert.notEqual(service._generation, staleGeneration,
            'pausing invalidates the run the old loop belongs to');

        await service.start(10, 5);
        assert.notEqual(service._generation, staleGeneration,
            'and resuming does not hand the old loop its run back');
        assert.equal(service.detections.length, before);
        await service.stop();
    });

    await test('finishing and starting again invalidates the old run', async () => {
        const { service } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        const staleGeneration = service._generation;

        await service.finish();
        assert.notEqual(service._generation, staleGeneration);

        await service.start(10, 5);
        assert.notEqual(service._generation, staleGeneration,
            'a previous session\'s result must not reach a newly started one');
        assert.deepEqual(service.detections, [], 'and the new session starts empty');
        await service.stop();
    });

    await test('pause releases the microphone before waiting on storage', async () => {
        const { service, store, mic } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();

        // Storage is slow. Pause is a direct response to a tap — often "stop
        // listening to me" — so the microphone must not be held open for it.
        store.__setDelays([200]);
        const order = [];
        const originalStop = mic.default.stopContinuous;
        mic.default.stopContinuous = async () => { order.push('mic released'); };
        const originalUpsert = store.default.upsertLiveSession;

        await service.pause();
        assert.deepEqual(order, ['mic released']);
        mic.default.stopContinuous = originalStop;
        void originalUpsert;
    });

    await test('each analysis job declares its own sample rate', async () => {
        const { service, mic, backend } = await loadService();
        mic.__setPcm(4096);
        mic.default.sampleRate = 44100;

        await service.start(0.02, 0.02);
        for (let i = 0; i < 50 && backend.__calls.length === 0; i++) {
            await new Promise(r => setTimeout(r, 10));
        }
        await service.stop();

        // The rate is a single global on the WASM side and capture does not
        // share it with file decoding (44.1 kHz mic, 48 kHz decode). Setting it
        // outside the lock let a file analysis change how these samples were
        // interpreted — every pitch and duration out by the ratio, showing up
        // as detections quietly getting worse rather than as an error.
        assert.ok(backend.__calls.length >= 1);
        assert.equal(backend.__calls[0].sampleRate, 44100,
            'the microphone job carries the microphone rate');
    });

    await test('a microphone recovery onto a different rate is picked up', async () => {
        const { service, mic, backend } = await loadService();
        mic.__setPcm(4096);
        mic.default.sampleRate = 44100;
        await service.start(0.02, 0.02);
        for (let i = 0; i < 50 && backend.__calls.length === 0; i++) {
            await new Promise(r => setTimeout(r, 10));
        }

        // Recovery reopens the pipeline and can come back on another rate, so
        // the rate captured at start() is not good enough.
        mic.default.sampleRate = 48000;
        const before = backend.__calls.length;
        for (let i = 0; i < 50 && backend.__calls.length === before; i++) {
            await new Promise(r => setTimeout(r, 10));
        }
        await service.stop();

        assert.equal(backend.__calls[backend.__calls.length - 1].sampleRate, 48000,
            'the rate is re-read each cycle, not captured once');
    });

    console.log('\nliveAnalysis.js — the one-tap Follow entry point');

    await test('Follow resumes a session paused a few minutes ago', async () => {
        const { service } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        const sessionId = service.sessionId;
        await service.pause();

        const result = await service.startForFollow(10, 5);

        assert.equal(result.ok, true);
        assert.equal(service.sessionId, sessionId, 'the same session, continued');
        assert.equal(service.isRunning, true);
        assert.equal(service.detections.length, 1, 'with its tunes');
        await service.stop();
    });

    await test('Follow starts a separate session when the open one is from another day', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        const tuesday = service.sessionId;
        await service.pause();

        // A session stays open until a new one is started, so the open session
        // on Wednesday is still Tuesday's. Continuing it would append
        // Wednesday's tunes to a record named and placed as Tuesday, which the
        // user can only unpick row by row.
        service._lastActiveAt = Date.now() - 30 * 60 * 60 * 1000;
        assert.equal(service.isRecentEnoughToResume(), false);

        const result = await service.startForFollow(10, 5);

        assert.equal(result.ok, true);
        assert.notEqual(service.sessionId, tuesday, 'a separate session is listening now');
        assert.deepEqual(service.detections, [], 'and it starts empty');
        const stored = store.__sessions.find(s => s.id === tuesday);
        assert.ok(stored.endedAt, 'the old one is closed, not abandoned');
        assert.equal(stored.tunes.length, 1, 'and keeps its tunes');
        await service.stop();
    });

    await test('Follow does not replace a stale session it could not save', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        const tuesday = service.sessionId;
        await service.pause();
        service._lastActiveAt = Date.now() - 30 * 60 * 60 * 1000;

        store.__failNextUpserts(1);
        const result = await service.startForFollow(10, 5);

        // Starting a replacement on top of a session that failed to save is
        // the one way to actually lose it.
        assert.equal(result.ok, false);
        assert.equal(service.sessionId, tuesday, 'the unsaved session is still here');
        assert.equal(service.isRunning, false, 'and nothing replaced it');
    });

    await test('Follow on an already-running session changes nothing', async () => {
        const { service } = await loadService();
        await service.start(10, 5);
        const sessionId = service.sessionId;

        const result = await service.startForFollow(10, 5);

        assert.equal(result.ok, true);
        assert.equal(service.sessionId, sessionId);
        assert.equal(service.isRunning, true);
        await service.stop();
    });

    console.log('\nliveAnalysis.js — surviving a reload');

    await test('an unfinished session is restored without opening the microphone', async () => {
        const { service, store, mic } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        const sessionId = service.sessionId;
        await service.stop();

        // A reload: a brand new service instance over the same storage.
        const fresh = await loadService({ keepStore: true });
        mic.__resetCalls();
        assert.equal(fresh.service.sessionId, null, 'nothing is open until it is restored');

        const restored = await fresh.service.restoreOpenSession();
        assert.equal(restored, true);
        assert.equal(fresh.service.sessionId, sessionId, 'the same session, not a new one');
        assert.equal(fresh.service.detections.length, 1, 'with its tune list');
        assert.equal(fresh.service.isRunning, false);
        assert.equal(mic.__startCalls, 0,
            'a page load must never open a microphone on its own');
        assert.equal(fresh.service.canResume(), true,
            'and it can carry on clustering, because the window matches were kept');
        assert.equal(store.__sessions.length, 1, 'still one session, not a second one');
    });

    await test('resuming a restored session appends to it rather than starting a second', async () => {
        const { service } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        const sessionId = service.sessionId;
        await service.stop();

        const fresh = await loadService({ keepStore: true });
        await fresh.service.restoreOpenSession();
        await fresh.service.start(10, 5);

        assert.equal(fresh.service.sessionId, sessionId);
        assert.equal(fresh.service.detections.length, 1, 'the previous list is still there');
        play(fresh.service, 2, 60, 6);
        assert.deepEqual(fresh.service.detections.map(d => d.tuneId), [1, 2],
            'and the new tune joins it');
        await fresh.service.stop();
    });

    await test('a finished session leaves nothing to restore', async () => {
        const { service } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        await service.finish();

        const fresh = await loadService({ keepStore: true });
        assert.equal(await fresh.service.restoreOpenSession(), false);
    });

    await test('a deleted session is not restored, and cannot be resurrected', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        await service.stop();

        // The user deleted it from Past Sessions while it was paused.
        store.__sessions.length = 0;

        const fresh = await loadService({ keepStore: true });
        assert.equal(await fresh.service.restoreOpenSession(), false,
            'resume state pointing at a record that is gone is not a session');
        assert.equal(store.__sessions.length, 0, 'and nothing writes it back');
    });

    await test('abandon() drops an open session without saving it again', async () => {
        const { service, store } = await loadService();
        await service.start(10, 5);
        play(service, 1, 0, 6);
        await service._maybeSaveSessionSnapshot();
        store.__sessions.length = 0;
        const writesBefore = store.__upsertCalls;

        await service.abandon();

        assert.equal(service.sessionId, null);
        assert.equal(store.__upsertCalls, writesBefore,
            'a session the user deleted must not be written back by its own teardown');
        assert.equal(store.__sessions.length, 0);
    });

    console.log('\nliveAnalysis.js — history is unconditional, location is not');

    await test('history saves regardless of geoTagDetections, but location does not', async () => {
        const { service, store } = await loadService();
        store.userSettings.geoTagDetections = false;
        await service.start(10, 5);
        play(service, 1, 0, 6);
        service._recordSighting();
        await service._maybeSaveSessionSnapshot();

        assert.equal(store.__sessions.length, 1, 'history is recorded regardless of the geo setting');
        assert.equal(store.__sessions[0].lat, null);
        assert.equal(store.__sessions[0].lon, null);
        await service.stop();
    });

    await test('with geoTagDetections on, a location eventually lands on the record', async () => {
        const { service, store, geo } = await loadService();
        store.userSettings.geoTagDetections = true;
        geo.__setFix({ lat: 53.34, lon: -6.27, accuracy: 10 });

        await service.start(10, 5);
        play(service, 1, 0, 6);
        service._recordSighting(); // fire-and-forget; awaits the fake fix internally
        await new Promise(resolve => setTimeout(resolve, 0));
        await service._maybeSaveSessionSnapshot();

        // The first edge-triggered save can race the async fix — stop()'s
        // unconditional flush is the documented backstop that always picks it
        // up by the end of the session.
        await service.stop();
        assert.equal(store.__sessions[0].lat, 53.34);
        assert.equal(store.__sessions[0].lon, -6.27);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    await rm(storeTmpDir, { recursive: true, force: true });
    await rm(serviceTmpDir, { recursive: true, force: true });
    await rm(sessionAnalysisTmpDir, { recursive: true, force: true });
    if (failed) process.exit(1);
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
