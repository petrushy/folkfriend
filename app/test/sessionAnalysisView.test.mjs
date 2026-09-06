// Component-level tests for the Session Analysis view.
//
// Run with:  node app/test/sessionAnalysisView.test.mjs
//
// The properties worth pinning here are the ones that fail silently:
//
//   1. Live microphone is the default mode, but saved file results win.
//   2. ?follow=1 starts listening AND opens the score with no further taps,
//      and is retried when the tune index arrives rather than dropped.
//   3. LISTENING IS NOT A MODE. Switching tabs — to a file analysis, to Past
//      Sessions — must never stop the microphone or disturb the session. The
//      two analyses keep entirely separate results, so neither can wipe or
//      relabel the other's.
//   4. A session that cannot be saved is not thrown away, and says so.
//   5. The open session cannot be deleted from Past Sessions, because the next
//      autosave would write it straight back.
//
// The component is a plain Options-API object, so its data()/created()/methods
// can be driven against a fake `this` with no Vue runtime — same approach as
// tuneBackgroundDialog.test.mjs and liveScoreFollowComponent.test.mjs.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-session-analysis-view');

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

const FAKE_STORE = `
export const state = { indexLoaded: false, sessionAnalysis: null };
export const __liveSessions = [];
export const __favourites = [];
export const __calls = [];
export let __failEdit = false;
export function __setFailEdit(value) { __failEdit = value; }
export default {
    state,
    setSessionAnalysisState(s) { state.sessionAnalysis = s; },
    clearSessionAnalysisState() { state.sessionAnalysis = null; },
    async getLiveSessions() { return __liveSessions.slice(); },
    async getNamedLiveSessions() { return __liveSessions.slice(); },
    async getFavourites() { return __favourites.slice(); },
    async upsertLiveSession(session) {
        __calls.push({ op: 'upsert', session });
        const i = __liveSessions.findIndex(s => s.id === session.id);
        if (i === -1) __liveSessions.push(session); else __liveSessions[i] = session;
        return session;
    },
    async updateLiveSession(id, patch) {
        if (__failEdit) throw new Error('disk full');
        const i = __liveSessions.findIndex(s => s.id === id);
        if (i < 0) throw new Error('deleted');
        __liveSessions[i] = { ...__liveSessions[i], ...patch };
        __calls.push({ op: 'edit', id, patch });
        return __liveSessions[i];
    },
    async deleteLiveSession(id) {
        __calls.push({ op: 'delete', id });
        const i = __liveSessions.findIndex(s => s.id === id);
        if (i !== -1) __liveSessions.splice(i, 1);
    },
    async addFavourite(result) { __calls.push({ op: 'favourite', result }); __favourites.push({ result }); },
    async removeFavourite(id) {
        __calls.push({ op: 'unfavourite', id });
        const i = __favourites.findIndex(f => String(f.result.settingID) === String(id));
        if (i !== -1) __favourites.splice(i, 1);
    },
};
export function __reset() {
    __liveSessions.length = 0;
    __favourites.length = 0;
    __calls.length = 0;
    state.sessionAnalysis = null;
    state.sessionWorkspace = null;
    __failEdit = false;
}
`;

const FAKE_EVENTBUS = `
export const __handlers = {};
export default {
    $emit() {},
    $on(name, fn) { (__handlers[name] = __handlers[name] || []).push(fn); },
    $off(name, fn) {
        if (!__handlers[name]) return;
        __handlers[name] = __handlers[name].filter(h => h !== fn);
    },
};
export function __fire(name, ...args) {
    // Varargs, because eventBus.$emit passes several — fileAnalysisUpdate
    // sends (detections, acceptedWindows), and a single-argument fake made the
    // second one silently undefined.
    for (const fn of (__handlers[name] || []).slice()) fn(...args);
}
export function __reset() { for (const k of Object.keys(__handlers)) delete __handlers[k]; }
`;

// Scriptable stand-in for the live service. __failNextStart makes the
// microphone refuse; __failNextFinish makes the final save fail, which is the
// case where the session must NOT be thrown away.
const FAKE_LIVE_ANALYSIS = `
export const __starts = [];
export const __calls = [];
export let __failNextStart = false;
export let __failNextFinish = false;
export let __restorable = null;
export let __restoreThrows = false;
export function __setRestoreThrows(v) { __restoreThrows = v; }
export let __recentEnough = true;
export function __setRecentEnough(v) { __recentEnough = v; }
export function __setFailNextStart(v) { __failNextStart = v; }
export function __setFailNextFinish(v) { __failNextFinish = v; }
export function __setRestorable(v) { __restorable = v; }
const service = {
    isRunning: false,
    isPaused: false,
    sessionId: null,
    detections: [],
    elapsedSeconds: 0,
    micHealthy: true,
    saveState: 'idle',
    saveError: null,
    _windowMatches: [],
    _options: null,
    canResume() { return !!this.sessionId && this._options !== null; },
    async start(windowSeconds, stepSeconds) {
        __starts.push({ windowSeconds, stepSeconds });
        // Mirrors the real service: sessionId is assigned before the
        // microphone is touched, so a failure still leaves an open session.
        if (!this.sessionId) { this.sessionId = 'session-' + __starts.length; this._options = {}; }
        if (__failNextStart) { __failNextStart = false; throw new Error('denied'); }
        this.isRunning = true;
    },
    isRecentEnoughToResume() { return !!this.sessionId && (this.isRunning || __recentEnough); },
    async startForFollow(w, sec) {
        __calls.push('startForFollow');
        if (this.isRunning) return { ok: true };
        if (this.sessionId && !this.isRecentEnoughToResume()) {
            const result = await this.finish();
            if (!result.ok) return result;
        }
        await this.start(w, sec);
        return { ok: true };
    },
    async stop() { __calls.push('stop'); this.isRunning = false; },
    async pause() { __calls.push('pause'); this.isRunning = false; },
    async finish() {
        __calls.push('finish');
        this.isRunning = false;
        if (__failNextFinish) {
            __failNextFinish = false;
            this.saveState = 'error';
            this.saveError = 'quota exceeded';
            return { ok: false, error: 'quota exceeded' };
        }
        this.sessionId = null;
        this._options = null;
        this.detections = [];
        return { ok: true };
    },
    async abandon() { __calls.push('abandon'); this.sessionId = null; this.detections = []; },
    async retryMicrophone() { __calls.push('retryMicrophone'); this.micHealthy = true; return true; },
    async restoreOpenSession() {
        __calls.push('restoreOpenSession');
        if (__restoreThrows) { __restoreThrows = false; throw new Error('read failed'); }
        if (!__restorable) return false;
        Object.assign(this, __restorable);
        return true;
    },
    async _persistSession() { __calls.push('persist'); return { ok: true }; },
    applyCorrection(id, selection) { __calls.push({ op: 'applyCorrection', id, selection }); },
    removeDetection(id) {
        __calls.push({ op: 'removeDetection', id });
        this.detections = this.detections.filter(d => d.id !== id);
    },
    rejectTune() {},
};
export function __reset() {
    __starts.length = 0;
    __calls.length = 0;
    __failNextStart = false;
    __failNextFinish = false;
    __restorable = null;
    __restoreThrows = false;
    __recentEnough = true;
    service.isRunning = false;
    service.sessionId = null;
    service.detections = [];
    service._windowMatches = [];
    service._options = null;
    service.micHealthy = true;
    service.saveState = 'idle';
    service.saveError = null;
    service.elapsedSeconds = 0;
}
export default service;
`;

const FAKE_FILE_ANALYSIS = `
export const __calls = [];
const service = {
    isRunning: false,
    async start() { __calls.push('start'); },
    cancel() { __calls.push('cancel'); },
    removeDetection(id) { __calls.push({ op: 'removeDetection', id }); },
};
export function __reset() { __calls.length = 0; service.isRunning = false; }
export default service;
`;

const FAKE_BACKEND = `
export default { async settingsFromTuneID() { return []; } };
`;

const FAKE_MDI = `
export const mdiOpenInNew = 'open-in-new';
export const mdiMicrophone = 'microphone';
export const mdiMusicClefTreble = 'clef';
export const mdiStar = 'star';
export const mdiStarOutline = 'star-outline';
export const mdiPause = 'pause';
export const mdiRecordCircleOutline = 'record';
export const mdiAlertCircleOutline = 'alert';
`;

const FAKE_SESSION_ANALYSIS = `
export function buildTuneListText(rows) { return rows.map(r => r.title).join(' / '); }
export function buildTuneOptions() { return []; }
export function buildUpdatedXsc() { return ''; }
export function formatSecondsAsClock(s) { return String(s); }
export function formatSecondsAsDuration(s) { return String(s); }
export function parseClockTime() { return 0; }
export function parseXscMetadata() { return { linkedAudioFileName: '' }; }
export function tuneOptionValue() { return ''; }
export const MIN_PAST_DETECTION_SECONDS = 15;
`;

const FAKE_FOLLOW = `
export let __clearLastShownCalls = 0;
export function clearLastShown() { __clearLastShownCalls++; }
export function __reset() { __clearLastShownCalls = 0; }
`;
const FAKE_VUE_COMPONENT = `export default { name: 'stub' };`;

async function writeFakes() {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'fake-store.mjs'), FAKE_STORE);
    await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);
    await writeFile(path.join(tmpDir, 'fake-live-analysis.mjs'), FAKE_LIVE_ANALYSIS);
    await writeFile(path.join(tmpDir, 'fake-file-analysis.mjs'), FAKE_FILE_ANALYSIS);
    await writeFile(path.join(tmpDir, 'fake-backend.mjs'), FAKE_BACKEND);
    await writeFile(path.join(tmpDir, 'fake-mdi.mjs'), FAKE_MDI);
    await writeFile(path.join(tmpDir, 'fake-session-analysis.mjs'), FAKE_SESSION_ANALYSIS);
    await writeFile(path.join(tmpDir, 'fake-follow.mjs'), FAKE_FOLLOW);
    await writeFile(path.join(tmpDir, 'fake-component.mjs'), FAKE_VUE_COMPONENT);

    const sfc = await readFile(path.join(srcDir, 'views', 'SessionAnalysis.vue'), 'utf8');
    const open = sfc.indexOf('<script>');
    const close = sfc.indexOf('</script>');
    assert.ok(open !== -1 && close > open, 'expected a <script> block in the SFC');
    let source = sfc.slice(open + '<script>'.length, close);

    const replacements = [
        ["from '@/services/store.js'", "from './fake-store.mjs'"],
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from '@mdi/js'", "from './fake-mdi.mjs'"],
        ["from '@/services/backend.js'", "from './fake-backend.mjs'"],
        ["from '@/services/liveAnalysis.js'", "from './fake-live-analysis.mjs'"],
        ["from '@/services/fileSessionAnalysis.js'", "from './fake-file-analysis.mjs'"],
        ["from '@/components/VolumeMeter.vue'", "from './fake-component.mjs'"],
        ["from '@/components/LiveScoreFollow.vue'", "from './fake-component.mjs'"],
        ["from '@/js/liveScoreFollow.mjs'", "from './fake-follow.mjs'"],
        ["from '@/js/sessionAnalysis.js'", "from './fake-session-analysis.mjs'"],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in the SFC`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'view.mjs'), source);
}

// Builds a vm and runs created(). `created()` kicks off an async _initialise(),
// so callers await `settle()` before asserting on what mode it landed in.
async function mountView({
    query = {}, indexLoaded = false, saved = null,
    running = false, sessionId = undefined, detections = [], restorable = null,
    restoreThrows = false,
} = {}) {
    const store = await import(path.join(tmpDir, 'fake-store.mjs'));
    const bus = await import(path.join(tmpDir, 'fake-eventbus.mjs'));
    const live = await import(path.join(tmpDir, 'fake-live-analysis.mjs'));
    const file = await import(path.join(tmpDir, 'fake-file-analysis.mjs'));

    bus.__reset();
    live.__reset();
    file.__reset();
    store.__reset();
    store.state.indexLoaded = indexLoaded;
    store.state.sessionAnalysis = saved;
    live.default.isRunning = running;
    live.default.sessionId = sessionId !== undefined ? sessionId : (running ? 'session-preexisting' : null);
    if (live.default.sessionId) live.default._options = {};
    live.default.detections = detections;
    if (restorable) live.__setRestorable(restorable);
    // Set before created() runs: _initialise() calls restoreOpenSession()
    // synchronously on its first tick, so a flag set afterwards is too late.
    if (restoreThrows) live.__setRestoreThrows(true);

    const mod = await import(`${path.join(tmpDir, 'view.mjs')}?v=${Math.random()}`);
    const component = mod.default;

    const ticks = [];
    const vm = {
        $route: { query },
        $nextTick: (fn) => { ticks.push(fn); },
    };
    for (const [name, fn] of Object.entries(component.methods)) vm[name] = fn.bind(vm);
    Object.assign(vm, component.data.call(vm));
    for (const [name, fn] of Object.entries(component.computed || {})) {
        Object.defineProperty(vm, name, { get: fn.bind(vm), configurable: true });
    }
    component.created.call(vm);

    const settle = async () => {
        for (let i = 0; i < 5; i++) {
            const queued = ticks.splice(0, ticks.length);
            for (const fn of queued) await fn();
            await Promise.resolve();
            await new Promise(r => setTimeout(r, 0));
        }
    };

    return { vm, component, settle, bus, live, file, store };
}

await writeFakes();

console.log('\ndefault mode');

await test('opens on the live microphone with nothing saved', async () => {
    const { vm, settle } = await mountView();
    await settle();
    assert.equal(vm.viewMode, 'live');
});

await test('saved file results switch it back to file mode', async () => {
    const saved = {
        version: 3,
        audioFile: { name: 'session.mp3', size: 1 },
        detections: [{ id: 'a', tuneId: 1 }],
        analysisStage: 'done',
    };
    const { vm, settle } = await mountView({ saved });
    await settle();

    assert.equal(vm.viewMode, 'file', 'saved file work outranks the live default');
    assert.equal(vm.file.detections.length, 1, 'and its results are restored');
    assert.equal(vm.audioFile.name, 'session.mp3');
});

await test('a saved state with no file and no detections leaves live mode alone', async () => {
    const { vm, settle } = await mountView({ saved: { version: 3, detections: [] } });
    await settle();
    assert.equal(vm.viewMode, 'live');
});

console.log('\n?follow=1 — one tap to "show me what is playing"');

await test('starts listening and opens the score, with no further taps', async () => {
    const { vm, settle, live } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: true,
    });
    assert.equal(live.__starts.length, 0, 'not before the view is on screen');

    await settle();
    assert.equal(live.__starts.length, 1, 'listening starts on its own');
    assert.equal(vm.live.capturing, true);
    assert.equal(vm.followMode, true, 'and the score opens on its own');
});

await test('waits for the tune index rather than dropping the request', async () => {
    const { vm, settle, bus, live } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: false,
    });

    await settle();
    assert.equal(live.__starts.length, 0, 'cannot start against an unusable index');
    assert.equal(vm.followMode, false);

    bus.__fire('indexLoaded');
    await settle();
    assert.equal(live.__starts.length, 1, 'the request is retried when the index arrives');
    assert.equal(vm.followMode, true);
});

await test('the index arriving twice does not open two microphones', async () => {
    const { settle, bus, live } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: false,
    });
    await settle();
    bus.__fire('indexLoaded');
    await settle();
    bus.__fire('indexLoaded');
    await settle();
    assert.equal(live.__starts.length, 1);
});

await test('leaving the view withdraws a pending auto-start', async () => {
    const { vm, component, settle, bus, live } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: false,
    });
    await settle();
    component.beforeDestroy.call(vm);
    bus.__fire('indexLoaded');
    await settle();
    assert.equal(live.__starts.length, 0,
        'a late index must not open a microphone for a screen nobody is looking at');
});

await test('a refused microphone shows the error instead of an empty score', async () => {
    const liveMod = await import(path.join(tmpDir, 'fake-live-analysis.mjs'));
    const { vm, settle } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: true,
    });
    liveMod.__setFailNextStart(true);

    await settle();
    assert.equal(vm.live.capturing, false);
    assert.equal(vm.followMode, false,
        'a full-screen score over a microphone that never opened hides the reason');
    assert.ok(vm.live.micError, 'and the reason is shown');
});

await test('an already-running session just opens the score', async () => {
    const { vm, settle, live } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: true, running: true,
    });
    await settle();
    assert.equal(live.__starts.length, 0, 'nothing to start');
    assert.equal(vm.followMode, true);
    assert.equal(vm.live.capturing, true);
});

console.log('\nlistening is not a mode');

await test('switching to Past Sessions does not stop the microphone', async () => {
    const { vm, component, live } = await mountView({ indexLoaded: true, running: true });
    vm.viewMode = 'history';
    await component.watch.viewMode.call(vm, 'history', 'live');

    assert.ok(!live.__calls.includes('stop'), 'the session carries on while you look at it');
    assert.ok(!live.__calls.includes('pause'));
    assert.equal(live.default.isRunning, true);
});

await test('switching to file analysis does not stop the microphone either', async () => {
    // This used to stop listening, and only when coming DIRECTLY from live —
    // going live → history → file left it running. Two behaviours for the same
    // destination is worse than either one of them.
    const { vm, component, live } = await mountView({ indexLoaded: true, running: true });
    vm.viewMode = 'file';
    await component.watch.viewMode.call(vm, 'file', 'live');

    assert.ok(!live.__calls.includes('stop'));
    assert.equal(live.default.isRunning, true);
});

await test('the live tune list survives a round trip through another tab', async () => {
    const detections = [{ id: 'a', tuneId: 1, settingId: 2, sourceUrl: '', dataset: '', title: 'Tune A', startSeconds: 0, endSeconds: 5, bestScore: 0.9 }];
    const { vm, component, settle } = await mountView({
        indexLoaded: true, running: true, detections,
    });
    await settle();
    assert.equal(vm.live.detections.length, 1);

    vm.viewMode = 'history';
    await component.watch.viewMode.call(vm, 'history', 'live');
    vm.viewMode = 'live';
    await component.watch.viewMode.call(vm, 'live', 'history');

    assert.equal(vm.live.detections.length, 1, 'nothing about the session was reset');
});

await test('live and file results do not overwrite each other', async () => {
    const { vm, settle, bus } = await mountView({ indexLoaded: true, running: true });
    await settle();

    bus.__fire('liveAnalysisUpdate', [
        { id: 'live-1', tuneId: 1, settingId: '10', title: 'Live tune', startSeconds: 0, endSeconds: 5, bestScore: 0.9 },
    ]);
    bus.__fire('fileAnalysisUpdate', [
        { id: 'file-1', tuneId: 2, settingId: '20', title: 'File tune', startSeconds: 0, endSeconds: 5, bestScore: 0.8 },
    ], 7);

    assert.equal(vm.live.detections.length, 1);
    assert.equal(vm.live.detections[0].title, 'Live tune');
    assert.equal(vm.file.detections.length, 1);
    assert.equal(vm.file.detections[0].title, 'File tune');
    assert.equal(vm.file.summary.acceptedWindows, 7);
});

await test('a file analysis stage does not relabel the live session', async () => {
    const { vm, settle, bus } = await mountView({ indexLoaded: true, running: true });
    await settle();
    bus.__fire('fileAnalysisStage', 'analyzing');

    assert.equal(vm.file.stage, 'analyzing');
    assert.equal(vm.live.capturing, true, 'the live session is untouched by it');
});

console.log('\nthe microphone tells the truth');

await test('a lost microphone is reported, and a retry reacquires it', async () => {
    const { vm, settle, bus, live } = await mountView({ indexLoaded: true, running: true });
    await settle();

    bus.__fire('liveAnalysisMicState', { healthy: false, reason: 'track ended' });
    assert.equal(vm.live.micHealthy, false);
    assert.equal(vm.live.micMessage, 'track ended');

    await vm.retryMicrophone();
    assert.ok(live.__calls.includes('retryMicrophone'));
    assert.equal(vm.live.micHealthy, true);
});

await test('recovery clears the warning on its own', async () => {
    const { vm, settle, bus } = await mountView({ indexLoaded: true, running: true });
    await settle();
    bus.__fire('liveAnalysisMicState', { healthy: false, reason: 'track ended' });
    bus.__fire('liveAnalysisMicState', { healthy: true, reason: '' });
    assert.equal(vm.live.micHealthy, true);
    assert.equal(vm.live.micMessage, '');
});

await test('pausing releases capture but keeps the session', async () => {
    const { vm, settle } = await mountView({ indexLoaded: true, running: true });
    await settle();
    assert.equal(vm.live.capturing, true);

    await vm.pauseLive();
    assert.equal(vm.live.capturing, false);
    assert.equal(vm.live.hasSession, true, 'pausing keeps the session');
});

console.log('\nsaving, finishing and deleting');

await test('a save failure is surfaced and can be retried', async () => {
    const { vm, settle, bus, live } = await mountView({ indexLoaded: true, running: true });
    await settle();

    bus.__fire('liveAnalysisSaveState', { state: 'error', error: 'quota exceeded' });
    assert.equal(vm.live.saveState, 'error');
    assert.equal(vm.live.saveError, 'quota exceeded');

    await vm.retrySave();
    assert.ok(live.__calls.includes('persist'), 'retrying actually writes again');
});

await test('New session preserves the previous session if saving it fails', async () => {
    const { vm, settle, live } = await mountView({ indexLoaded: true, running: true });
    await settle();
    live.__setFailNextFinish(true);
    await vm.newSession();
    assert.equal(live.__starts.length, 0, 'no new session may replace an unsaved one');
});

await test('a selected historical session deletes independently', async () => {
    const { vm, settle, store } = await mountView({ indexLoaded: true });
    await settle();
    store.__liveSessions.push({ id: 'old-session', startedAt: 1, tunes: [] });
    await vm.refreshPastSessions();
    vm.selectSession('old-session');
    globalThis.window = { confirm: () => true };
    try { await vm.deleteSelectedSession(); } finally { delete globalThis.window; }
    assert.ok(store.__calls.some(c => c.op === 'delete' && c.id === 'old-session'));
    assert.equal(store.__liveSessions.length, 0);
});

console.log('\ncorrections and reload recovery');

await test('correcting a live row goes to the service, not just the view', async () => {
    const { vm, settle, live } = await mountView({ indexLoaded: true, running: true });
    await settle();
    const detection = {
        id: 'row-1', tuneId: 1, dataset: 'thesession',
        tuneOptions: [{ value: 'k', tuneId: 99, settingId: '990', title: 'Corrected', sourceUrl: '' }],
        selectedTuneKey: 'k',
    };

    vm.onTuneChange(detection);

    const correction = live.__calls.find(c => c.op === 'applyCorrection');
    assert.ok(correction, 'the service owns the list that gets saved');
    assert.equal(correction.selection.tuneId, 99);
    assert.equal(correction.selection.title, 'Corrected');
});

await test('correcting a file row persists locally instead', async () => {
    const { vm, settle, live } = await mountView({ indexLoaded: true, saved: null });
    await settle();
    vm.viewMode = 'file';
    const detection = {
        id: 'row-1', tuneId: 1,
        tuneOptions: [{ value: 'k', tuneId: 99, settingId: '990', title: 'Corrected', sourceUrl: '' }],
        selectedTuneKey: 'k',
    };

    vm.onTuneChange(detection);
    assert.ok(!live.__calls.some(c => c.op === 'applyCorrection'),
        'file analysis has nothing to do with the live service');
});

console.log('\nFollow session always ends on the score');

await test('a paused session is resumed rather than left for the user to start', async () => {
    const detections = [{ id: 'a', tuneId: 1, settingId: '10', title: 'Earlier', startSeconds: 0, endSeconds: 30, bestScore: 0.9 }];
    const { vm, settle, live } = await mountView({
        query: { live: '1', follow: '1' },
        indexLoaded: true,
        running: false,
        sessionId: 'session-paused',
        detections,
    });
    await settle();

    assert.ok(live.__calls.includes('startForFollow'));
    assert.equal(live.default.sessionId, 'session-paused', 'the same session, continued');
    assert.equal(vm.live.capturing, true);
    assert.equal(vm.followMode, true, 'and the score is on screen without another tap');
    assert.ok(!live.__calls.includes('finish'), 'a recent session is not filed away');
});

await test('a session already listening just shows the score', async () => {
    const { vm, settle, live } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: true, running: true,
    });
    await settle();

    assert.equal(live.__starts.length, 0, 'nothing to start');
    assert.equal(vm.followMode, true);
});

await test('a session from another day is filed away and a fresh one started', async () => {
    const liveMod = await import(path.join(tmpDir, 'fake-live-analysis.mjs'));
    const detections = [{ id: 'a', tuneId: 1, settingId: '10', title: 'Tuesday', startSeconds: 0, endSeconds: 30, bestScore: 0.9 }];
    const { vm, settle, live } = await mountView({
        query: { live: '1', follow: '1' },
        indexLoaded: true,
        running: false,
        sessionId: 'session-tuesday',
        detections,
    });
    liveMod.__setRecentEnough(false);
    await settle();

    assert.ok(live.__calls.includes('finish'),
        'Wednesday must not be appended to a record named and placed as Tuesday');
    assert.notEqual(live.default.sessionId, 'session-tuesday');
    assert.ok(live.default.sessionId, 'a separate session is listening now');
    assert.equal(vm.followMode, true, 'and it still ends on the score');
});

await test('a stale session that cannot be saved blocks the new one', async () => {
    const liveMod = await import(path.join(tmpDir, 'fake-live-analysis.mjs'));
    const { vm, settle, live } = await mountView({
        query: { live: '1', follow: '1' },
        indexLoaded: true,
        running: false,
        sessionId: 'session-tuesday',
        detections: [{ id: 'a', tuneId: 1, settingId: '10', title: 'Tuesday', startSeconds: 0, endSeconds: 30, bestScore: 0.9 }],
    });
    liveMod.__setRecentEnough(false);
    liveMod.__setFailNextFinish(true);
    await settle();

    // Starting a replacement on top of a session that failed to save is the
    // one way to actually lose it.
    assert.equal(live.default.sessionId, 'session-tuesday', 'the unsaved session is still here');
    assert.equal(live.__starts.length, 0, 'and nothing replaced it');
    assert.equal(vm.followMode, false);
});

await test('a recent session restored after a reload is resumed by ?follow=1', async () => {
    const { vm, settle, live } = await mountView({
        query: { live: '1', follow: '1' },
        indexLoaded: true,
        restorable: {
            sessionId: 'restored-follow',
            isRunning: false,
            _options: {},
            detections: [{ id: 'r1', tuneId: 1, settingId: '10', title: 'Earlier tonight', startSeconds: 0, endSeconds: 30, bestScore: 0.9 }],
            elapsedSeconds: 120,
        },
    });
    await settle();

    // Reopening the app mid-evening and tapping Follow is the same intent as
    // tapping Resume: carry on. It must not land on a paused screen needing
    // another tap.
    assert.equal(live.default.sessionId, 'restored-follow', 'the same session, continued');
    assert.equal(vm.live.capturing, true);
    assert.equal(vm.followMode, true);
    assert.ok(!live.__calls.includes('finish'));
});

await test('a stale session restored after a reload is not continued', async () => {
    const liveMod = await import(path.join(tmpDir, 'fake-live-analysis.mjs'));
    const { vm, settle, live } = await mountView({
        query: { live: '1', follow: '1' },
        indexLoaded: true,
        restorable: {
            sessionId: 'restored-tuesday',
            isRunning: false,
            _options: {},
            detections: [{ id: 'r1', tuneId: 1, settingId: '10', title: 'Tuesday', startSeconds: 0, endSeconds: 30, bestScore: 0.9 }],
            elapsedSeconds: 120,
        },
    });
    liveMod.__setRecentEnough(false);
    await settle();

    assert.ok(live.__calls.includes('finish'), 'last week\'s session is filed away, not extended');
    assert.notEqual(live.default.sessionId, 'restored-tuesday');
    assert.equal(vm.followMode, true, 'and Follow still ends on the score');
});

await test('a restore that fails does not silently start a new session', async () => {
    const { vm, settle, live } = await mountView({ indexLoaded: true, restoreThrows: true });
    await settle();

    assert.ok(vm.live.restoreError, 'a read that failed is not "there is no session"');
    assert.equal(live.__starts.length, 0);
});

await test('an unfinished session is restored on load without opening the mic', async () => {
    const { vm, settle, live } = await mountView({
        indexLoaded: true,
        restorable: {
            sessionId: 'restored-1',
            isRunning: false,
            _options: {},
            detections: [{ id: 'r1', tuneId: 1, settingId: '10', title: 'From last night', startSeconds: 0, endSeconds: 30, bestScore: 0.9 }],
            elapsedSeconds: 120,
        },
    });
    await settle();

    assert.ok(live.__calls.includes('restoreOpenSession'));
    assert.equal(vm.viewMode, 'live');
    assert.equal(vm.live.hasSession, true);
    assert.equal(vm.live.capturing, false, 'a page load never opens a microphone on its own');
    assert.equal(vm.live.detections.length, 1);
    assert.equal(live.__starts.length, 0);
});

await test('a restored session with no analysis options offers Finish but not Resume', async () => {
    const { vm, settle } = await mountView({
        indexLoaded: true,
        restorable: {
            sessionId: 'restored-2',
            isRunning: false,
            _options: null, // saved by an older build — the matches are gone
            detections: [{ id: 'r1', tuneId: 1, settingId: '10', title: 'Old', startSeconds: 0, endSeconds: 30, bestScore: 0.9 }],
            elapsedSeconds: 60,
        },
    });
    await settle();

    assert.equal(vm.live.hasSession, true);
    assert.equal(vm.live.canResume, false,
        'clustering cannot continue without the window and step it was recorded with');
});

console.log('\nPast Sessions');

await test('listening time is preferred over wall-clock, with a fallback', async () => {
    const { vm, settle } = await mountView({ indexLoaded: true });
    await settle();

    assert.equal(vm.listenedSeconds({ listenedSeconds: 3600, tunes: [] }), 3600);
    // Older records predate listenedSeconds; the last tune's end is on the same
    // clock as the tune times, unlike endedAt - startedAt which also counts
    // however long the session spent paused.
    assert.equal(vm.listenedSeconds({ tunes: [{ endSeconds: 240 }] }), 240);
    assert.equal(vm.listenedSeconds({ tunes: [] }), 0);
});

await test('starring a tune from a past session uses the real favourites path', async () => {
    const { vm, settle, store } = await mountView({ indexLoaded: true });
    await settle();

    await vm.toggleFavourite({ tuneId: 42, settingId: '420', title: 'The Kesh' });
    const added = store.__calls.find(c => c.op === 'favourite');
    assert.ok(added);
    assert.equal(added.result.settingID, '420');
    assert.equal(added.result.displayName, 'The Kesh');
    assert.equal(vm.isTuneFavourited({ settingId: '420' }), true);

    await vm.toggleFavourite({ tuneId: 42, settingId: '420', title: 'The Kesh' });
    assert.ok(store.__calls.some(c => c.op === 'unfavourite' && c.id === '420'));
    assert.equal(vm.isTuneFavourited({ settingId: '420' }), false);
});

await test('saved sessions use the shared table and export without disturbing capture', async () => {
    const { vm, settle, store, live, bus } = await mountView({ running: true, detections: [{ id: 'live', tuneId: 1, title: 'Current tune' }] });
    await settle();
    store.__liveSessions.push({ id: 'old', name: 'Last Sunday', startedAt: 1000, tunes: [
        { tuneId: 2, settingId: '20', title: 'Old tune', startSeconds: 0, endSeconds: 60 },
    ] });
    await vm.openSessionPicker();
    vm.selectSession('old');
    assert.equal(vm.viewMode, 'history');
    assert.equal(vm.activeDetections[0].title, 'Old tune');
    bus.__fire('liveAnalysisUpdate', [{ id: 'new-live', tuneId: 3, title: 'Another current tune' }]);
    assert.equal(vm.activeDetections[0].title, 'Old tune', 'background updates cannot replace the selected session');
    let exported;
    vm.downloadText = (name, text) => { exported = { name, text }; };
    vm.downloadTuneList();
    assert.equal(exported.text, 'Old tune');
    assert.equal(exported.name, 'Last Sunday-tunes.txt');
    assert.equal(live.default.isRunning, true);
    assert.ok(!live.__calls.includes('stop'));
});

await test('removing and renaming a saved session persist without changing live results', async () => {
    const { vm, settle, store, live } = await mountView({ running: true });
    await settle();
    store.__liveSessions.push({ id: 'old', startedAt: 1000, tunes: [
        { tuneId: 2, settingId: '20', title: 'Old tune', startSeconds: 0, endSeconds: 60 },
    ] });
    await vm.refreshPastSessions();
    vm.selectSession('old');
    await vm.renameSession('Our favourite evening');
    await vm.removeDetection(vm.activeDetections[0].id);
    assert.equal(store.__liveSessions[0].name, 'Our favourite evening');
    assert.equal(store.__liveSessions[0].customName, true);
    assert.deepEqual(store.__liveSessions[0].tunes, []);
    assert.equal(live.default.isRunning, true);
});

await test('a failed historical edit keeps the edited list for retry', async () => {
    const { vm, settle, store } = await mountView();
    await settle();
    store.__liveSessions.push({ id: 'old', startedAt: 1000, tunes: [
        { tuneId: 2, title: 'Old tune', startSeconds: 0, endSeconds: 60 },
    ] });
    await vm.refreshPastSessions();
    vm.selectSession('old');
    store.__setFailEdit(true);
    await vm.removeDetection(vm.activeDetections[0].id);
    assert.deepEqual(vm.activeDetections, []);
    assert.equal(store.__liveSessions[0].tunes.length, 1);
    assert.match(vm.workspaceError, /not been saved/);
    assert.ok(vm.pendingSessionPatch);
    store.__setFailEdit(false);
    await vm.retrySessionEdit();
    assert.deepEqual(store.__liveSessions[0].tunes, []);
    assert.equal(vm.pendingSessionPatch, null);
});

await rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
