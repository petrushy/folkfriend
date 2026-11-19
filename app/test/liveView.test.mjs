// The app-wide live view: services/liveView.js (opening it from anywhere) and
// components/LiveViewHost.vue (the one overlay, mounted in App.vue).
//
// Run with:  node app/test/liveView.test.mjs
//
// What matters is what the old route-based entry point already guaranteed,
// now reachable without a route change:
//
//   1. It always ends on the score when it can, and never over a microphone
//      that did not open — a full-screen score would hide the reason.
//   2. An unfinished session from a previous run is restored BEFORE anything
//      starts, and a failed read refuses rather than starting a second one.
//   3. A double tap opens one microphone.
//   4. Pause closes the overlay, and opening it shows the list as it is now.
//
// Same approach as sessionAnalysisView.test.mjs: rewrite imports to fakes and
// drive the module / the component's options object with no Vue runtime.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadSessionAnalysisModule, sessionAnalysisTmpDir } from './helpers/loadSessionAnalysis.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-live-view');

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

const FAKE_VUE = `export default { observable(o) { return o; } };`;

const FAKE_LIVE = `
export const __calls = [];
export const __next = { restoreThrows: false, restorable: null, startThrows: false, startResult: { ok: true }, startGate: null };
const service = {
    isRunning: false,
    sessionId: null,
    options: null,
    detections: [],
    async restoreOpenSession() {
        __calls.push('restore');
        if (__next.restoreThrows) throw new Error('read failed');
        if (__next.restorable) { Object.assign(this, __next.restorable); return true; }
        return false;
    },
    async startForFollow(w, s) {
        __calls.push(['startForFollow', w, s]);
        if (__next.startGate) await __next.startGate;
        if (__next.startThrows) throw new Error('NotAllowedError');
        if (!__next.startResult.ok) return __next.startResult;
        if (!this.sessionId) this.sessionId = 'session-new';
        this.isRunning = true;
        return { ok: true };
    },
};
export function __reset() {
    __calls.length = 0;
    Object.assign(__next, { restoreThrows: false, restorable: null, startThrows: false, startResult: { ok: true }, startGate: null });
    Object.assign(service, { isRunning: false, sessionId: null, options: null, detections: [] });
}
export default service;
`;

const FAKE_BACKEND = `
export const __state = { ready: true };
export default { async indexReady() { return __state.ready; } };
`;

const FAKE_FOLLOW = `
export const __state = { cleared: 0 };
export function clearLastShown() { __state.cleared++; }
`;

const FAKE_EVENTBUS = `
export const __handlers = {};
export default {
    $on(name, fn) { (__handlers[name] = __handlers[name] || []).push(fn); },
    $off(name, fn) { __handlers[name] = (__handlers[name] || []).filter(h => h !== fn); },
};
export function __fire(name, ...args) { for (const fn of (__handlers[name] || []).slice()) fn(...args); }
`;

async function rewrite(file, replacements, out) {
    let source = await readFile(file, 'utf8');
    if (file.endsWith('.vue')) {
        source = source.slice(source.indexOf('<script>') + '<script>'.length, source.indexOf('</script>'));
    }
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected ${JSON.stringify(from)} in ${path.basename(file)}`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, out), source);
}

await mkdir(tmpDir, { recursive: true });
await loadSessionAnalysisModule();
await writeFile(path.join(tmpDir, 'fake-vue.mjs'), FAKE_VUE);
await writeFile(path.join(tmpDir, 'fake-live.mjs'), FAKE_LIVE);
await writeFile(path.join(tmpDir, 'fake-backend.mjs'), FAKE_BACKEND);
await writeFile(path.join(tmpDir, 'fake-follow.mjs'), FAKE_FOLLOW);
await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);
await writeFile(path.join(tmpDir, 'fake-component.mjs'), `export default { name: 'stub' };`);
await rewrite(path.join(srcDir, 'services', 'liveView.js'), [
    ["from 'vue'", "from './fake-vue.mjs'"],
    ["from './liveAnalysis.js'", "from './fake-live.mjs'"],
    ["from './backend.js'", "from './fake-backend.mjs'"],
    ["from '@/js/liveScoreFollow.mjs'", "from './fake-follow.mjs'"],
], 'liveView.mjs');
await rewrite(path.join(srcDir, 'components', 'LiveViewHost.vue'), [
    ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
    ["from '@/services/liveAnalysis.js'", "from './fake-live.mjs'"],
    ["from '@/components/LiveScoreFollow.vue'", "from './fake-component.mjs'"],
    ["from '@/services/liveView.js'", "from './liveView.mjs'"],
    // Real: the host must build the same rows the Session Tools table does.
    ["from '@/js/sessionAnalysis.js'", `from '${path.join(sessionAnalysisTmpDir, 'sessionAnalysis.mjs')}'`],
], 'host.mjs');

const view = await import(path.join(tmpDir, 'liveView.mjs'));
const live = await import(path.join(tmpDir, 'fake-live.mjs'));
const backend = await import(path.join(tmpDir, 'fake-backend.mjs'));
const follow = await import(path.join(tmpDir, 'fake-follow.mjs'));
const bus = await import(path.join(tmpDir, 'fake-eventbus.mjs'));

function reset() {
    live.__reset();
    backend.__state.ready = true;
    follow.__state.cleared = 0;
    Object.assign(view.liveView, { open: false, starting: false, error: '' });
}
const starts = () => live.__calls.filter(c => Array.isArray(c) && c[0] === 'startForFollow');

console.log('\nstartLiveView — one tap from anywhere');

await test('nothing open: starts listening and opens the score', async () => {
    reset();
    await view.startLiveView();
    assert.equal(starts().length, 1);
    assert.deepEqual(starts()[0], ['startForFollow', 10, 5]);
    assert.equal(view.liveView.open, true);
    assert.equal(view.liveView.starting, false);
    assert.equal(follow.__state.cleared, 1, 'a fresh session forgets what the overlay last showed');
});

await test('already listening: just opens the score', async () => {
    reset();
    live.default.isRunning = true;
    live.default.sessionId = 'session-running';
    await view.startLiveView();
    assert.equal(starts().length, 0);
    assert.ok(!live.__calls.includes('restore'));
    assert.equal(view.liveView.open, true);
});

await test('an unfinished session is restored before anything starts', async () => {
    reset();
    live.__next.restorable = { sessionId: 'session-last-night', options: { windowSeconds: 12, stepSeconds: 4 } };
    await view.startLiveView();
    assert.deepEqual(live.__calls[0], 'restore');
    assert.deepEqual(starts()[0], ['startForFollow', 12, 4], 'resumed with the window it was recorded with');
    assert.equal(live.default.sessionId, 'session-last-night', 'continued, not replaced');
    assert.equal(follow.__state.cleared, 0, 'a resumed session keeps its overlay state');
    assert.equal(view.liveView.open, true);
});

await test('a failed restore read refuses rather than starting a second session', async () => {
    reset();
    live.__next.restoreThrows = true;
    await view.startLiveView();
    assert.equal(starts().length, 0);
    assert.equal(view.liveView.open, false);
    assert.ok(view.liveView.error);
});

await test('no usable tune index: says so, starts nothing', async () => {
    reset();
    backend.__state.ready = false;
    await view.startLiveView();
    assert.equal(starts().length, 0);
    assert.equal(view.liveView.open, false);
    assert.ok(view.liveView.error);
});

await test('a refused microphone shows the error instead of an empty score', async () => {
    reset();
    live.__next.startThrows = true;
    await view.startLiveView();
    assert.equal(view.liveView.open, false);
    assert.match(view.liveView.error, /microphone/i);
    assert.equal(view.liveView.starting, false);
});

await test('a stale session that cannot be saved blocks the new one', async () => {
    reset();
    live.__next.startResult = { ok: false, error: 'quota exceeded' };
    await view.startLiveView();
    assert.equal(view.liveView.open, false);
    assert.match(view.liveView.error, /quota exceeded/);
});

await test('a double tap opens one microphone', async () => {
    reset();
    let release;
    live.__next.startGate = new Promise(r => { release = r; });
    const first = view.startLiveView();
    const second = view.startLiveView();
    await new Promise(r => setTimeout(r, 0));
    release();
    await Promise.all([first, second]);
    assert.equal(starts().length, 1);
    assert.equal(view.liveView.open, true);
});

await test('opening clears an earlier error', async () => {
    reset();
    view.liveView.error = 'old';
    view.openLiveView();
    assert.equal(view.liveView.error, '');
    assert.equal(view.liveView.open, true);
});

console.log('\nLiveViewHost — the one overlay');

async function mountHost() {
    for (const k of Object.keys(bus.__handlers)) delete bus.__handlers[k];
    const component = (await import(`${path.join(tmpDir, 'host.mjs')}?v=${Math.random()}`)).default;
    const vm = { $route: { name: 'search' }, pushed: [] };
    vm.$router = { push: (to) => { vm.pushed.push(to); return Promise.resolve(); } };
    Object.assign(vm, component.data.call(vm));
    for (const [name, fn] of Object.entries(component.methods)) vm[name] = fn.bind(vm);
    component.created.call(vm);
    return { vm, component };
}

const DETECTION = { id: 'd1', tuneId: 7, settingId: 70, title: 'The Kesh', startSeconds: 12, bestScore: 0.8, alternatives: [] };

await test('updates become rows with selectable options, as in the tune table', async () => {
    reset();
    const { vm } = await mountHost();
    bus.__fire('liveAnalysisUpdate', [DETECTION]);
    assert.equal(vm.detections.length, 1);
    assert.equal(vm.detections[0].tuneOptions.length, 1, 'the follow view reads tuneOptions');
    assert.equal(vm.detections[0].selectedTuneId, 7);
});

await test('opening reads the list as it is now, not the last update it saw', async () => {
    reset();
    const { vm, component } = await mountHost();
    live.default.detections = [DETECTION];
    component.watch['liveView.open'].call(vm, true);
    assert.equal(vm.detections.length, 1);
});

await test('Pause closes the overlay', async () => {
    reset();
    await mountHost();
    view.openLiveView();
    bus.__fire('liveAnalysisStopped');
    assert.equal(view.liveView.open, false);
});

await test('closing does not stop listening', async () => {
    reset();
    live.default.isRunning = true;
    const { vm } = await mountHost();
    view.openLiveView();
    vm.close();
    assert.equal(view.liveView.open, false);
    assert.equal(live.default.isRunning, true);
});

await test('leaving the app unsubscribes', async () => {
    reset();
    const { vm, component } = await mountHost();
    component.beforeDestroy.call(vm);
    for (const name of ['liveAnalysisUpdate', 'liveAnalysisRestored', 'liveAnalysisStopped', 'liveAnalysisFinished']) {
        assert.equal((bus.__handlers[name] || []).length, 0, name);
    }
});

await test('the error snackbar leads to Session Tools', async () => {
    reset();
    const { vm } = await mountHost();
    view.liveView.error = 'Could not access the microphone.';
    vm.openSessionTools();
    assert.equal(view.liveView.error, '');
    assert.equal(vm.pushed[0].name, 'session-analysis');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
