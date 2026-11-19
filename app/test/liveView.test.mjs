// The app-wide live view: services/liveView.js (opening it from anywhere) and
// components/LiveViewHost.vue (the one overlay, mounted in App.vue).
//
// Run with:  node app/test/liveView.test.mjs
//
// The live view is independent of the session: it only LISTENS. What matters:
//
//   1. Opening it never creates, resumes or saves a session.
//   2. It opens only over a microphone that opened — a full-screen score
//      would hide the reason — and a double tap opens one microphone.
//   3. Closing it hands the microphone back (the service keeps it if a
//      Session Capture is running).
//   4. It shows the LISTENER's list, and opening shows that list as it is now.
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
export const __next = { activateThrows: false, gate: null };
const service = {
    isListening: false,
    isRunning: false,
    sessionId: null,
    liveDetections: [],
    detections: [],
    async setLiveViewActive(active) {
        __calls.push(['setLiveViewActive', active]);
        if (!active) { if (!this.isRunning) this.isListening = false; return; }
        if (__next.gate) await __next.gate;
        if (__next.activateThrows) throw new Error('NotAllowedError');
        this.isListening = true;
    },
};
export function __reset() {
    __calls.length = 0;
    Object.assign(__next, { activateThrows: false, gate: null });
    Object.assign(service, { isListening: false, isRunning: false, sessionId: null, liveDetections: [], detections: [] });
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
    for (const k of Object.keys(bus.__handlers)) delete bus.__handlers[k];
    backend.__state.ready = true;
    follow.__state.cleared = 0;
    Object.assign(view.liveView, { open: false, starting: false, error: '' });
}
const starts = () => live.__calls.filter(c => Array.isArray(c) && c[0] === 'startForFollow');

console.log('\nopenLiveView — one tap from anywhere, listening only');

const activations = () => live.__calls.filter(c => c[0] === 'setLiveViewActive' && c[1] === true);

await test('opens the score over a listener, and never touches a session', async () => {
    reset();
    await view.openLiveView();
    assert.equal(activations().length, 1);
    assert.equal(view.liveView.open, true);
    assert.equal(view.liveView.starting, false);
    assert.equal(live.default.sessionId, null, 'no session was created');
    assert.equal(follow.__state.cleared, 1, 'a fresh listening run forgets what the overlay last showed');
});

await test('joining a listener that is already running keeps the overlay state', async () => {
    reset();
    live.default.isListening = true;
    live.default.isRunning = true;
    live.default.sessionId = 'session-capturing';
    await view.openLiveView();
    assert.equal(view.liveView.open, true);
    assert.equal(follow.__state.cleared, 0);
    assert.equal(live.default.sessionId, 'session-capturing', 'the capture is left exactly as it was');
});

await test('no usable tune index: says so, listens to nothing', async () => {
    reset();
    backend.__state.ready = false;
    await view.openLiveView();
    assert.equal(activations().length, 0);
    assert.equal(view.liveView.open, false);
    assert.ok(view.liveView.error);
});

await test('a refused microphone shows the error instead of an empty score', async () => {
    reset();
    live.__next.activateThrows = true;
    await view.openLiveView();
    assert.equal(view.liveView.open, false);
    assert.match(view.liveView.error, /microphone/i);
    assert.equal(view.liveView.starting, false);
});

await test('a double tap opens one microphone', async () => {
    reset();
    let release;
    live.__next.gate = new Promise(r => { release = r; });
    const first = view.openLiveView();
    const second = view.openLiveView();
    await new Promise(r => setTimeout(r, 0));
    release();
    await Promise.all([first, second]);
    assert.equal(activations().length, 1);
    assert.equal(view.liveView.open, true);
});

await test('closing hands the microphone back', async () => {
    reset();
    await view.openLiveView();
    await view.closeLiveView();
    assert.equal(view.liveView.open, false);
    assert.deepEqual(live.__calls[live.__calls.length - 1], ['setLiveViewActive', false]);
    assert.equal(live.default.isListening, false);
});

await test('opening clears an earlier error', async () => {
    reset();
    view.liveView.error = 'old';
    await view.openLiveView();
    assert.equal(view.liveView.error, '');
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
    bus.__fire('liveViewUpdate', [DETECTION]);
    assert.equal(vm.detections.length, 1);
    assert.equal(vm.detections[0].tuneOptions.length, 1, 'the follow view reads tuneOptions');
    assert.equal(vm.detections[0].selectedTuneId, 7);
});

await test('opening reads the list as it is now, not the last update it saw', async () => {
    reset();
    const { vm, component } = await mountHost();
    live.default.liveDetections = [DETECTION];
    live.default.detections = [];
    component.watch['liveView.open'].call(vm, true);
    assert.equal(vm.detections.length, 1, 'the listener\'s list, not the session\'s');
    assert.equal(vm.detections.length, 1);
});

await test('the listener stopping under it closes the overlay', async () => {
    reset();
    await mountHost();
    view.liveView.open = true;
    bus.__fire('liveListeningStopped');
    assert.equal(view.liveView.open, false);
});

await test('a session Pause does not close it', async () => {
    reset();
    await mountHost();
    view.liveView.open = true;
    bus.__fire('liveAnalysisStopped');
    assert.equal(view.liveView.open, true, 'the live view is independent of the capture');
});

await test('the close button releases the listener', async () => {
    reset();
    const { vm } = await mountHost();
    await view.openLiveView();
    await vm.close();
    assert.equal(view.liveView.open, false);
    assert.equal(live.default.isListening, false);
});

await test('leaving the app unsubscribes', async () => {
    reset();
    const { vm, component } = await mountHost();
    component.beforeDestroy.call(vm);
    for (const name of ['liveViewUpdate', 'liveListeningStopped']) {
        assert.equal((bus.__handlers[name] || []).length, 0, name);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
