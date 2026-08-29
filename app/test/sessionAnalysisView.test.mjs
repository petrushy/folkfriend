// Component-level tests for how the Session Analysis view starts up.
//
// Run with:  node app/test/sessionAnalysisView.test.mjs
//
// Three behaviours live entirely in created() and its ordering, and all three
// fail silently rather than loudly if they regress:
//
//   1. Live microphone is the default mode, but saved file results win — and
//      the restore has to outlive the liveMode watcher's resetResults().
//   2. ?follow=1 starts listening AND opens the score with no further taps.
//   3. That auto-start usually arrives before the tune index is usable, so it
//      has to be retried from the indexLoaded event rather than dropped.
//
// Same approach as tuneBackgroundDialog.test.mjs and liveScoreFollowComponent:
// the component is a plain Options-API object, so its data()/created()/methods
// can be driven against a fake `this` with no Vue runtime.

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
export default {
    state,
    setSessionAnalysisState(s) { state.sessionAnalysis = s; },
    clearSessionAnalysisState() { state.sessionAnalysis = null; },
};
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
export function __fire(name, payload) {
    for (const fn of (__handlers[name] || []).slice()) fn(payload);
}
export function __reset() { for (const k of Object.keys(__handlers)) delete __handlers[k]; }
`;

// Scriptable: __failNextStart makes the microphone refuse, which is the case
// where an auto-opened full-screen score would hide the error explaining why.
const FAKE_LIVE_ANALYSIS = `
export const __starts = [];
export let __failNextStart = false;
export function __setFailNextStart(v) { __failNextStart = v; }
const service = {
    isRunning: false,
    isPaused: false,
    detections: [],
    elapsedSeconds: 0,
    _windowMatches: [],
    async start(windowSeconds, stepSeconds) {
        __starts.push({ windowSeconds, stepSeconds });
        if (__failNextStart) { __failNextStart = false; throw new Error('denied'); }
        this.isRunning = true;
    },
    async stop() { this.isRunning = false; },
    pause() {}, resume() {}, removeDetection() {}, rejectTune() {},
};
export function __reset() { __starts.length = 0; __failNextStart = false; service.isRunning = false; service.detections = []; }
export default service;
`;

const FAKE_FILE_ANALYSIS = `
export default { isRunning: false, async start() {}, cancel() {}, removeDetection() {} };
`;

const FAKE_MDI = `
export const mdiOpenInNew = 'open-in-new';
export const mdiMicrophone = 'microphone';
export const mdiMusicClefTreble = 'clef';
`;

const FAKE_SESSION_ANALYSIS = `
export function buildTuneListText() { return ''; }
export function buildTuneOptions() { return []; }
export function buildUpdatedXsc() { return ''; }
export function formatSecondsAsClock(s) { return String(s); }
export function formatSecondsAsDuration(s) { return String(s); }
export function parseClockTime() { return 0; }
export function parseXscMetadata() { return { linkedAudioFileName: '' }; }
export function tuneOptionValue() { return ''; }
export const MIN_PAST_DETECTION_SECONDS = 15;
`;

const FAKE_FOLLOW = `export function clearLastShown() {}`;
const FAKE_VUE_COMPONENT = `export default { name: 'stub' };`;

async function writeFakes() {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'fake-store.mjs'), FAKE_STORE);
    await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);
    await writeFile(path.join(tmpDir, 'fake-live-analysis.mjs'), FAKE_LIVE_ANALYSIS);
    await writeFile(path.join(tmpDir, 'fake-file-analysis.mjs'), FAKE_FILE_ANALYSIS);
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

// Builds a vm and runs created(). `query` is the route query; `indexLoaded` and
// `saved` set the store state the view reads on the way in.
async function mountView({ query = {}, indexLoaded = false, saved = null, running = false } = {}) {
    const store = await import(path.join(tmpDir, 'fake-store.mjs'));
    const bus = await import(path.join(tmpDir, 'fake-eventbus.mjs'));
    const live = await import(path.join(tmpDir, 'fake-live-analysis.mjs'));

    bus.__reset();
    live.__reset();
    store.state.indexLoaded = indexLoaded;
    store.state.sessionAnalysis = saved;
    live.default.isRunning = running;

    const mod = await import(`${path.join(tmpDir, 'view.mjs')}?v=${Math.random()}`);
    const component = mod.default;

    // $nextTick callbacks are collected rather than run, so a test can assert
    // on the state both before and after the tick — which is the whole point
    // for the restore-vs-resetResults ordering.
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

    // Runs the queued $nextTick callbacks, then the liveMode watcher if the
    // test says liveMode changed — Vue flushes watchers before nextTick
    // callbacks registered after them, which is what created() relies on.
    const flush = async (watcherRan = null) => {
        if (watcherRan !== null) {
            component.watch.liveMode.call(vm, watcherRan);
        }
        const queued = ticks.splice(0, ticks.length);
        for (const fn of queued) await fn();
        await Promise.resolve();
        await Promise.resolve();
    };

    return { vm, component, flush, bus, live, store, ticks };
}

await writeFakes();

console.log('\ndefault mode');

await test('opens on the live microphone with nothing saved', async () => {
    const { vm } = await mountView();
    assert.equal(vm.liveMode, true);
});

await test('saved file results switch it back to file mode, and survive the watcher', async () => {
    const saved = {
        version: 3,
        audioFile: { name: 'session.mp3', size: 1 },
        detections: [{ id: 'a', tuneId: 1 }],
        analysisStage: 'done',
    };
    const { vm, flush } = await mountView({ saved });

    assert.equal(vm.liveMode, false, 'saved file work outranks the live default');
    // The watcher Vue would run for that liveMode change wipes the results;
    // the restore is queued after it precisely so it lands on top.
    await flush(false);
    assert.equal(vm.detections.length, 1, 'the restore must outlive resetResults()');
    assert.equal(vm.audioFile.name, 'session.mp3');
});

await test('a saved state with no file and no detections leaves live mode alone', async () => {
    const { vm } = await mountView({ saved: { version: 3, detections: [] } });
    assert.equal(vm.liveMode, true);
});

console.log('\n?follow=1 — one tap to "show me what is playing"');

await test('starts listening and opens the score, with no further taps', async () => {
    const { vm, flush, live } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: true,
    });

    assert.equal(vm.liveMode, true);
    assert.equal(live.__starts.length, 0, 'not before the view is on screen');

    await flush();
    assert.equal(live.__starts.length, 1, 'listening starts on its own');
    assert.equal(vm.liveMicActive, true);
    assert.equal(vm.followMode, true, 'and the score opens on its own');
});

await test('waits for the tune index rather than dropping the request', async () => {
    const { vm, flush, bus, live } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: false,
    });

    await flush();
    assert.equal(live.__starts.length, 0, 'cannot start against an unusable index');
    assert.equal(vm.followMode, false);

    bus.__fire('indexLoaded');
    await flush();
    assert.equal(live.__starts.length, 1, 'the request is retried when the index arrives');
    assert.equal(vm.followMode, true);
});

await test('the index arriving twice does not open two microphones', async () => {
    const { flush, bus, live } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: false,
    });

    await flush();
    bus.__fire('indexLoaded');
    await flush();
    bus.__fire('indexLoaded');
    await flush();
    assert.equal(live.__starts.length, 1);
});

await test('leaving the view withdraws a pending auto-start', async () => {
    const { vm, component, flush, bus, live } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: false,
    });

    await flush();
    component.beforeDestroy.call(vm);
    bus.__fire('indexLoaded');
    await flush();
    assert.equal(live.__starts.length, 0,
        'a late index must not open a microphone for a screen nobody is looking at');
});

await test('navigating away before the deferred start runs cancels it', async () => {
    // The auto-start is queued on $nextTick so the view is painted first, and
    // the user can leave inside that gap — a fast back-tap, or a redirect. The
    // eventBus unsubscribe in beforeDestroy does not cover this one: the
    // callback is already queued and holds its own reference to the vm.
    const { vm, component, flush, live } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: true,
    });

    component.beforeDestroy.call(vm);
    await flush();
    assert.equal(live.__starts.length, 0, 'no microphone for a view that is gone');
    assert.equal(vm.followMode, false);
});

await test('a refused microphone shows the error instead of an empty score', async () => {
    const liveMod = await import(path.join(tmpDir, 'fake-live-analysis.mjs'));
    const { vm, flush } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: true,
    });
    liveMod.__setFailNextStart(true);

    await flush();
    assert.equal(vm.liveMicActive, false);
    assert.equal(vm.followMode, false,
        'a full-screen score over a microphone that never opened hides the reason');
    assert.ok(vm.liveMicError, 'and the reason is shown');
});

await test('an already-running session just opens the score', async () => {
    const { vm, flush, live } = await mountView({
        query: { live: '1', follow: '1' }, indexLoaded: true, running: true,
    });

    await flush();
    assert.equal(live.__starts.length, 0, 'nothing to start');
    assert.equal(vm.followMode, true);
    assert.equal(vm.liveMicActive, true);
});

await test('?live=1 alone still lands on the screen without starting anything', async () => {
    const { vm, flush, live } = await mountView({ query: { live: '1' }, indexLoaded: true });
    await flush();
    assert.equal(live.__starts.length, 0);
    assert.equal(vm.followMode, false);
    assert.equal(vm.liveMode, true);
});

await test('?follow=1 outranks saved file results', async () => {
    const saved = { version: 3, audioFile: { name: 'session.mp3', size: 1 }, detections: [] };
    const { vm, flush } = await mountView({
        query: { follow: '1' }, indexLoaded: true, saved,
    });
    await flush();
    assert.equal(vm.liveMode, true, 'an explicit request beats a restore');
    assert.equal(vm.followMode, true);
});

console.log('\nthe Listen & Follow button');

await test('starts listening and opens the score', async () => {
    const { vm, live } = await mountView({ indexLoaded: true });
    await vm.startListeningAndFollow();
    assert.equal(live.__starts.length, 1);
    assert.equal(vm.followMode, true);
});

await test('does not open the score when the microphone is refused', async () => {
    const liveMod = await import(path.join(tmpDir, 'fake-live-analysis.mjs'));
    const { vm } = await mountView({ indexLoaded: true });
    liveMod.__setFailNextStart(true);
    await vm.startListeningAndFollow();
    assert.equal(vm.followMode, false);
    assert.ok(vm.liveMicError);
});

await rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
