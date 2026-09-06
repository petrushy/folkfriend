// Tests for the app-level session status bar.
//
// Run with:  node app/test/sessionStatusBar.test.mjs
//
// This component exists because a session outlives the page that started it.
// It is rendered by App.vue, so the properties worth pinning are that it
// reflects the service wherever the user has navigated to, and that its
// controls act on the session rather than on the microphone directly:
//
//   - It shows nothing at all when no session is open.
//   - Listening / Paused / Mic unavailable follow the service's actual state,
//     not the route.
//   - Pause and Finish go through the session lifecycle, so the session and
//     the capture can never disagree about whether it is listening.
//
// Same harness as the other component tests: the SFC's <script> is lifted out
// and driven against a fake `this` with no Vue runtime.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-session-status-bar');

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
    for (const fn of (__handlers[name] || []).slice()) fn(...args);
}
export function __reset() { for (const k of Object.keys(__handlers)) delete __handlers[k]; }
`;

const FAKE_STORE = `export default { state: { indexLoaded: true } };`;

const FAKE_LIVE = `
export const __calls = [];
const service = {
    sessionId: null,
    isRunning: false,
    elapsedSeconds: 0,
    detections: [],
    micHealthy: true,
    saveState: 'idle',
    saveError: null,
    options: { windowSeconds: 10, stepSeconds: 5 },
    canResume() { return !!this.sessionId; },
    async start(w, s) { __calls.push({ op: 'start', w, s }); this.isRunning = true; },
    async pause() { __calls.push({ op: 'pause' }); this.isRunning = false; },
    async finish() { __calls.push({ op: 'finish' }); this.sessionId = null; this.isRunning = false; return { ok: true }; },
    async retryMicrophone() { __calls.push({ op: 'retryMicrophone' }); this.micHealthy = true; return true; },
    async _persistSession() { __calls.push({ op: 'persist' }); return { ok: true }; },
};
export function __reset() {
    __calls.length = 0;
    service.sessionId = null;
    service.isRunning = false;
    service.elapsedSeconds = 0;
    service.detections = [];
    service.micHealthy = true;
    service.saveState = 'idle';
    service.saveError = null;
}
export default service;
`;

const FAKE_MDI = `
export const mdiPause = 'pause';
export const mdiRecordCircleOutline = 'record';
export const mdiAlertCircleOutline = 'alert';
`;

const FAKE_SESSION_ANALYSIS = `export function formatSecondsAsClock(s) { return String(s); }`;

async function loadComponent({ route = { name: 'search' } } = {}) {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);
    await writeFile(path.join(tmpDir, 'fake-store.mjs'), FAKE_STORE);
    await writeFile(path.join(tmpDir, 'fake-live.mjs'), FAKE_LIVE);
    await writeFile(path.join(tmpDir, 'fake-mdi.mjs'), FAKE_MDI);
    await writeFile(path.join(tmpDir, 'fake-session-analysis.mjs'), FAKE_SESSION_ANALYSIS);

    const sfc = await readFile(path.join(srcDir, 'components', 'SessionStatusBar.vue'), 'utf8');
    const open = sfc.indexOf('<script>');
    const close = sfc.indexOf('</script>');
    let source = sfc.slice(open + '<script>'.length, close);
    for (const [from, to] of [
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from '@/services/store.js'", "from './fake-store.mjs'"],
        ["from '@/services/liveAnalysis.js'", "from './fake-live.mjs'"],
        ["from '@mdi/js'", "from './fake-mdi.mjs'"],
        ["from '@/js/sessionAnalysis.js'", "from './fake-session-analysis.mjs'"],
    ]) {
        assert.ok(source.includes(from), `expected ${JSON.stringify(from)} in the SFC`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'bar.mjs'), source);

    const bus = await import(path.join(tmpDir, 'fake-eventbus.mjs'));
    const live = await import(path.join(tmpDir, 'fake-live.mjs'));
    bus.__reset();
    live.__reset();

    const mod = await import(`${path.join(tmpDir, 'bar.mjs')}?v=${Math.random()}`);
    const component = mod.default;

    const vm = { $route: route };
    for (const [name, fn] of Object.entries(component.methods)) vm[name] = fn.bind(vm);
    Object.assign(vm, component.data.call(vm));
    for (const [name, fn] of Object.entries(component.computed || {})) {
        Object.defineProperty(vm, name, { get: fn.bind(vm), configurable: true });
    }
    return { vm, component, bus, live };
}

async function run() {
    await rm(tmpDir, { recursive: true, force: true });

    console.log('\nthe session bar follows the session, not the route');

    await test('nothing is shown when no session is open', async () => {
        const { vm, component } = await loadComponent();
        component.created.call(vm);
        assert.equal(vm.hasSession, false);
    });

    await test('a session opened elsewhere is picked up on any route', async () => {
        const { vm, component, live } = await loadComponent({ route: { name: 'tune' } });
        live.default.sessionId = 'session-1';
        live.default.isRunning = true;
        live.default.detections = [{ id: 'a' }, { id: 'b' }];
        live.default.elapsedSeconds = 300;

        component.created.call(vm);

        assert.equal(vm.hasSession, true, 'the bar is not a Session Analysis feature');
        assert.equal(vm.capturing, true);
        assert.equal(vm.tuneCount, 2);
        assert.equal(vm.elapsedSeconds, 300);
        assert.equal(vm.status.label, 'Listening');
    });

    await test('the status distinguishes listening, paused and a dead microphone', async () => {
        const { vm, component, live } = await loadComponent();
        live.default.sessionId = 'session-1';
        live.default.isRunning = true;
        component.created.call(vm);
        assert.equal(vm.status.label, 'Listening');

        live.default.micHealthy = false;
        vm._sync();
        assert.equal(vm.status.label, 'Mic unavailable',
            'a session that has stopped hearing anything must not still say Listening');

        live.default.micHealthy = true;
        live.default.isRunning = false;
        vm._sync();
        assert.equal(vm.status.label, 'Paused');
    });

    await test('it keeps up with the session while the user is on another page', async () => {
        const { vm, component, bus, live } = await loadComponent({ route: { name: 'favourites' } });
        live.default.sessionId = 'session-1';
        live.default.isRunning = true;
        component.created.call(vm);

        bus.__fire('liveAnalysisTimerTick', 42);
        bus.__fire('liveAnalysisUpdate', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
        assert.equal(vm.elapsedSeconds, 42);
        assert.equal(vm.tuneCount, 3);

        live.default.micHealthy = false;
        bus.__fire('liveAnalysisMicState', { healthy: false, reason: 'track ended' });
        assert.equal(vm.status.label, 'Mic unavailable');
    });

    await test('a save failure is visible from anywhere, and retryable', async () => {
        const { vm, component, bus, live } = await loadComponent({ route: { name: 'tune' } });
        live.default.sessionId = 'session-1';
        live.default.isRunning = true;
        component.created.call(vm);

        live.default.saveState = 'error';
        live.default.saveError = 'quota exceeded';
        bus.__fire('liveAnalysisSaveState', { state: 'error', error: 'quota exceeded' });
        assert.equal(vm.saveState, 'error');
        assert.equal(vm.saveError, 'quota exceeded');

        await vm.retrySave();
        assert.ok(live.__calls.some(c => c.op === 'persist'));
    });

    console.log('\nits controls act on the session, not the microphone');

    await test('Pause goes through the session lifecycle', async () => {
        const { vm, component, live } = await loadComponent();
        live.default.sessionId = 'session-1';
        live.default.isRunning = true;
        component.created.call(vm);

        await vm.pause();

        assert.deepEqual(live.__calls.map(c => c.op), ['pause'],
            'never micService.stopContinuous() directly — the session would still think it was listening');
        assert.equal(vm.capturing, false);
    });

    await test('Resume restarts with the session\'s own analysis options', async () => {
        const { vm, component, live } = await loadComponent();
        live.default.sessionId = 'session-1';
        live.default.isRunning = false;
        live.default.options = { windowSeconds: 8, stepSeconds: 4 };
        component.created.call(vm);

        await vm.resume();

        const start = live.__calls.find(c => c.op === 'start');
        assert.ok(start);
        assert.equal(start.w, 8, 'not the defaults — the session was recorded at its own settings');
        assert.equal(start.s, 4);
        assert.equal(vm.capturing, true);
    });

    await test('Finish clears the bar', async () => {
        const { vm, component, live } = await loadComponent();
        live.default.sessionId = 'session-1';
        live.default.isRunning = true;
        component.created.call(vm);

        await vm.finish();

        assert.ok(live.__calls.some(c => c.op === 'finish'));
        assert.equal(vm.hasSession, false);
    });

    await test('an explicit retry asks the service to reacquire', async () => {
        const { vm, component, live } = await loadComponent();
        live.default.sessionId = 'session-1';
        live.default.isRunning = true;
        live.default.micHealthy = false;
        component.created.call(vm);

        await vm.retryMicrophone();
        assert.ok(live.__calls.some(c => c.op === 'retryMicrophone'));
        assert.equal(vm.micHealthy, true);
    });

    await test('unsubscribing on destroy stops it reacting to a later session', async () => {
        const { vm, component, bus, live } = await loadComponent();
        live.default.sessionId = 'session-1';
        live.default.isRunning = true;
        component.created.call(vm);
        component.beforeDestroy.call(vm);

        bus.__fire('liveAnalysisTimerTick', 999);
        assert.notEqual(vm.elapsedSeconds, 999);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    await rm(tmpDir, { recursive: true, force: true });
    if (failed) process.exit(1);
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
