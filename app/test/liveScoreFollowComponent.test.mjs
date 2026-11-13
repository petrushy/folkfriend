// Component-level tests for the freeze button in the live-follow overlay.
//
// Run with:  node app/test/liveScoreFollowComponent.test.mjs
//
// liveScoreFollow.test.mjs covers the pure resolver. What it cannot cover is the
// wiring that the freeze button actually depends on:
//
//   1. `frozen` is passed to resolveFollowTarget() on every detections tick —
//      not read once, and not forgotten by a later refactor of the watcher.
//   2. toggleFrozen() re-resolves against the current detections when it turns
//      freeze OFF. Nothing else will: the detections watcher only fires when the
//      array changes, and every tick that arrived while frozen was discarded, so
//      without that call the view sits on the frozen tune until the next tune
//      change and unfreeze looks broken.
//
// Same approach as tuneBackgroundDialog.test.mjs and for the same reason: the
// component is a plain Options-API object, so its data()/methods can be driven
// against a fake `this` with no Vue runtime. liveScoreFollow.mjs is used for
// real — it is the thing under test on the other side of the wiring.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-live-score-follow');

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

// Counts settingsFromTuneID calls, so a test can assert that a frozen overlay
// does not refetch a score — the observable cost of the freeze leaking.
const FAKE_BACKEND = `
export const __calls = [];
// When set, settingsFromTuneID parks its answer here instead of resolving, so
// a test can play the part of a worker that is busy or stuck.
export const __held = { on: false, pending: [] };
export function __reset() { __calls.length = 0; __held.on = false; __held.pending.length = 0; }
export default {
    async settingsFromTuneID(tuneId) {
        __calls.push(tuneId);
        const answer = [{ tune_id: tuneId, setting_id: Number(String(tuneId)) * 10, abc: 'X:1\\n' }];
        if (__held.on) return new Promise(resolve => __held.pending.push(() => resolve(answer)));
        return answer;
    },
    indexUnavailableMessage: () => 'index unavailable',
};
`;

const FAKE_STORE = `
export default {
    _isValidSettingID: (id) => Number.isInteger(Number(id)) && Number(id) > 0,
    isFavourite: async () => false,
    addFavourite: async () => {},
    removeFavourite: async () => {},
    __savedSettings: [],
    async updateUserSettings(settings) { this.__savedSettings.push({ ...settings }); this.userSettings = settings; },
    userSettings: {},
};
`;

const FAKE_EVENTBUS = `export default { $emit() {}, $on() {}, $off() {} };`;
// Records rejections and lets a test script what the service's own detections
// list looks like afterwards — rejectTune() reads it directly, because the
// `detections` prop only catches up on the next render.
const FAKE_LIVE_ANALYSIS = `
export const __rejected = [];
const service = {
    elapsedSeconds: 0,
    detections: [],
    // Where the last window matched (js/scorePosition.mjs windowPositions()).
    scorePosition: null,
    rejectTune(tuneId) { __rejected.push(tuneId); },
    // "Record this tune". __captureResult scripts what captureTune() answers.
    isRunning: true,
    tuneCapture: null,
    __recording: false,
    tuneCaptureAvailability() {
        if (!this.isRunning) return 'not-listening';
        if (this.tuneCapture) return 'capturing';
        return this.__recording ? 'recording' : 'available';
    },
    __captureResult: { ok: true },
    __captureCalls: 0,
    async captureTune() {
        this.__captureCalls++;
        if (this.__captureResult.ok) this.tuneCapture = { tuneId: '1' };
        return this.__captureResult;
    },
    async cancelTuneCapture() { this.tuneCapture = null; },
    __level: null,
    recordingLevel() { return this.__level; },
    // The detection LED, scriptable so the overlay's wiring can be checked
    // without the real service. Its levels are pinned in
    // detectionFreshness.test.mjs.
    __freshness: { level: 'green', colour: 'green darken-1', label: 'Following', detail: '' },
    detectionFreshness() { return this.__freshness; },
};
export default service;
`;
const FAKE_MDI = `
export const mdiStar = 'star';
export const mdiStarOutline = 'star-outline';
export const mdiPin = 'pin';
export const mdiPinOutline = 'pin-outline';
export const mdiThumbDownOutline = 'thumb-down-outline';
export const mdiRecordCircleOutline = 'record-outline';
export const mdiRecordRec = 'record-rec';
export const mdiCrosshairsGps = 'crosshairs';
`;
const FAKE_SESSION_ANALYSIS = `export function formatSecondsAsClock(s) { return String(s); }`;
// The overlay renders these; nothing here touches them.
const FAKE_VUE_COMPONENT = `export default { name: 'stub' };`;

// Lift the <script> block out of the SFC and rewrite its imports. Asserting on
// each marker means a restructured component fails loudly rather than silently
// testing nothing.
async function loadOverlay({ initialDetections = null } = {}) {
    await writeFile(path.join(tmpDir, 'fake-backend.mjs'), FAKE_BACKEND);
    await writeFile(path.join(tmpDir, 'fake-store.mjs'), FAKE_STORE);
    await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);
    await writeFile(path.join(tmpDir, 'fake-live-analysis.mjs'), FAKE_LIVE_ANALYSIS);
    await writeFile(path.join(tmpDir, 'fake-mdi.mjs'), FAKE_MDI);
    await writeFile(path.join(tmpDir, 'fake-session-analysis.mjs'), FAKE_SESSION_ANALYSIS);
    await writeFile(path.join(tmpDir, 'fake-component.mjs'), FAKE_VUE_COMPONENT);

    const sfc = await readFile(
        path.join(srcDir, 'components', 'LiveScoreFollow.vue'), 'utf8');
    const open = sfc.indexOf('<script>');
    const close = sfc.indexOf('</script>');
    assert.ok(open !== -1 && close > open, 'expected a <script> block in the SFC');
    let source = sfc.slice(open + '<script>'.length, close);

    const followModule = path.join(srcDir, 'js', 'liveScoreFollow.mjs');
    const replacements = [
        ["from '@mdi/js'", "from './fake-mdi.mjs'"],
        ["from '@/services/backend.js'", "from './fake-backend.mjs'"],
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from '@/services/store.js'", "from './fake-store.mjs'"],
        ["from '@/services/liveAnalysis.js'", "from './fake-live-analysis.mjs'"],
        ["from '@/components/AbcDisplay.vue'", "from './fake-component.mjs'"],
        ["from '@/components/TuneBackgroundButton.vue'", "from './fake-component.mjs'"],
        ["from '@/components/SetPartnersButton.vue'", "from './fake-component.mjs'"],
        ["from '@/js/sessionAnalysis.js'", "from './fake-session-analysis.mjs'"],
        // Deliberately the real module.
        ["from '@/js/liveScoreFollow.mjs'", `from '${followModule}'`],
        ["from '@/js/scorePosition.mjs'", `from '${path.join(srcDir, 'js', 'scorePosition.mjs')}'`],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in the SFC`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'overlay.mjs'), source);

    const backend = await import(path.join(tmpDir, 'fake-backend.mjs'));
    const follow = await import(followModule);
    const live = await import(path.join(tmpDir, 'fake-live-analysis.mjs'));
    backend.__reset();
    live.__rejected.length = 0;
    live.default.detections = [];
    live.default.scorePosition = null;
    live.default.isRunning = true;
    live.default.tuneCapture = null;
    live.default.__recording = false;
    live.default.__level = null;
    live.default.__captureResult = { ok: true };
    live.default.__captureCalls = 0;
    (await import(path.join(tmpDir, 'fake-store.mjs'))).default.userSettings = {};
    follow.clearLastShown();

    const mod = await import(`${path.join(tmpDir, 'overlay.mjs')}?v=${Math.random()}`);
    const component = mod.default;

    // A fake `this`. data() calls _optionKeyFor and stashes non-reactive fields
    // on `this`, so the methods have to be bound before data() runs — which is
    // also the order Vue itself uses.
    const vm = { detections: [], $emit() {} };
    for (const [name, fn] of Object.entries(component.methods)) vm[name] = fn.bind(vm);
    Object.assign(vm, component.data.call(vm));
    for (const [name, fn] of Object.entries(component.computed || {})) {
        Object.defineProperty(vm, name, { get: fn.bind(vm), configurable: true });
    }
    // Vue 2's real order: data(), then any `immediate` watcher, then
    // created(). The harness used to call created() first, which is exactly
    // what hid the overlay initialising its load token in created().
    const handler = component.watch.detections.handler.bind(vm);
    if (initialDetections) {
        vm.detections = initialDetections;
        handler(initialDetections);
    }
    if (component.created) component.created.call(vm);

    const push = async (detections) => {
        vm.detections = detections;
        handler(detections);
        // Let the loadScore() it may have started settle.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    };

    return { vm, push, backend, follow, live, component };
}

function opt(tuneId, settingId, title, score) {
    return { value: `${settingId}::${tuneId}`, tuneId, settingId: String(settingId), title, score };
}

function det(tuneId, settingId, title, bestScore, alternatives = []) {
    return {
        tuneId,
        settingId: String(settingId),
        title,
        bestScore,
        tuneOptions: [opt(tuneId, settingId, title, bestScore), ...alternatives],
    };
}

await mkdir(tmpDir, { recursive: true });

console.log('\nfreezing the live-follow overlay');

await test('freezing holds the tune, the score and the loaded ABC', async () => {
    const { vm, push, backend } = await loadOverlay();

    await push([det(1, 10, 'The Kesh', 0.71)]);
    assert.equal(vm.target.tuneId, 1);
    assert.equal(vm.abcSetting.setting_id, 10);
    const callsBefore = backend.__calls.length;

    vm.toggleFrozen();
    assert.equal(vm.frozen, true);

    await push([det(2, 20, 'The Butterfly', 0.93)]);
    assert.equal(vm.target.tuneId, 1, 'a different tune must not displace a frozen one');
    assert.equal(vm.target.score, 0.71, 'the match readout is frozen too');
    assert.equal(vm.abcSetting.setting_id, 10, 'the score on screen must not change');
    assert.equal(backend.__calls.length, callsBefore, 'a frozen overlay must not refetch');
});

await test('a frozen tune survives the detections list clearing', async () => {
    const { vm, push } = await loadOverlay();

    await push([det(1, 10, 'The Kesh', 0.71)]);
    vm.toggleFrozen();
    await push([]);

    assert.equal(vm.target.tuneId, 1, 'the pinned tune must not vanish when the room goes quiet');
    assert.equal(vm.abcSetting.setting_id, 10);
});

await test('unfreezing rejoins the current tune with no further detections tick', async () => {
    const { vm, push, backend } = await loadOverlay();

    await push([det(1, 10, 'The Kesh', 0.71)]);
    vm.toggleFrozen();
    await push([det(2, 20, 'The Butterfly', 0.93)]);
    assert.equal(vm.target.tuneId, 1);

    // No push() after this: the whole point is that toggleFrozen() itself
    // re-resolves. The detections watcher will not fire again until the array
    // changes, which may be a whole tune away.
    vm.toggleFrozen();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(vm.frozen, false);
    assert.equal(vm.target.tuneId, 2, 'unfreezing must rejoin what is being played now');
    assert.equal(vm.target.score, 0.93);
    assert.equal(vm.abcSetting.setting_id, 20, 'and must load that tune\'s score');
    assert.deepEqual(backend.__calls, [1, 2]);
});

await test('unfreezing on the same tune that was frozen loads nothing new', async () => {
    const { vm, push, backend } = await loadOverlay();

    await push([det(1, 10, 'The Kesh', 0.71)]);
    vm.toggleFrozen();
    await push([det(1, 10, 'The Kesh', 0.80)]);
    vm.toggleFrozen();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(vm.target.tuneId, 1);
    assert.equal(vm.target.score, 0.80, 'the readout catches up on unfreeze');
    assert.deepEqual(backend.__calls, [1], 'the score is already the right one');
});

await test('a manual override while frozen holds until unfrozen', async () => {
    const { vm, push, backend } = await loadOverlay();

    const alternative = opt(3, 30, 'Cooley\'s', 0.66);
    await push([det(1, 10, 'The Kesh', 0.71, [alternative])]);
    vm.toggleFrozen();
    vm.onOverrideChange(alternative.value);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(vm.target.tuneId, 3, 'the user picking a tune still works while frozen');
    assert.equal(vm.target.overridden, true);
    assert.equal(vm.abcSetting.setting_id, 30);

    // ...and the override is not then washed away by the next tick.
    await push([det(1, 10, 'The Kesh', 0.75)]);
    assert.equal(vm.target.tuneId, 3);
    assert.deepEqual(backend.__calls, [1, 3]);
});

console.log('\nrejecting the tune on screen');

await test('rejecting hands the tune to the service and falls back to the previous one', async () => {
    const { vm, push, live, backend } = await loadOverlay();

    await push([det(1, 10, 'The Kesh', 0.71)]);
    await push([det(1, 10, 'The Kesh', 0.71), det(2, 20, 'The Butterfly', 0.93)]);
    assert.equal(vm.target.tuneId, 2);

    // What the real service leaves behind once the rejected tune is dropped.
    live.default.detections = [det(1, 10, 'The Kesh', 0.71)];
    vm.rejectTune();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(live.__rejected, [2], 'the rejection has to reach the service, or the row stays');
    assert.equal(vm.target.tuneId, 1, 'and the view reverts to the previous detection at once');
    assert.equal(vm.abcSetting.setting_id, 10, 'with that tune\'s score reloaded');
    assert.deepEqual(backend.__calls, [1, 2, 1]);
});

await test('rejecting rejects what the ANALYSIS said, not a manual override', async () => {
    const { vm, push, live } = await loadOverlay();

    const alternative = opt(3, 30, 'Cooley\'s', 0.66);
    await push([det(1, 10, 'The Kesh', 0.71, [alternative])]);
    vm.onOverrideChange(alternative.value);
    await Promise.resolve();
    assert.equal(vm.target.tuneId, 3);

    vm.rejectTune();
    assert.deepEqual(live.__rejected, [1],
        'the detection to drop is the one the analysis made, whatever the user then picked');
});

await test('rejecting a frozen tune unfreezes, or nothing could move', async () => {
    const { vm, push, live } = await loadOverlay();

    await push([det(1, 10, 'The Kesh', 0.71)]);
    await push([det(1, 10, 'The Kesh', 0.71), det(2, 20, 'The Butterfly', 0.93)]);
    vm.toggleFrozen();
    assert.equal(vm.frozen, true);

    live.default.detections = [det(1, 10, 'The Kesh', 0.71)];
    vm.rejectTune();
    await Promise.resolve();

    assert.equal(vm.frozen, false);
    assert.equal(vm.target.tuneId, 1, 'the resolver ignores everything while frozen');
});

await test('rejecting with nothing on screen does nothing', async () => {
    const { vm, live } = await loadOverlay();
    assert.equal(vm.target, null);
    vm.rejectTune();
    assert.deepEqual(live.__rejected, []);
});

await test('freeze is not carried across a close and reopen', async () => {
    const { vm, push, follow } = await loadOverlay();

    await push([det(1, 10, 'The Kesh', 0.71)]);
    vm.toggleFrozen();

    // What beforeDestroy() hands to the next instance. Freezing lasts "until
    // unfrozen or closed", so `frozen` must not be among it — a reopened view
    // silently pinned to a tune that stopped playing has nothing on screen to
    // explain itself.
    follow.setLastShown({
        target: vm.target,
        abcSetting: vm.abcSetting,
        abcTargetKey: vm._abcTargetKey,
        favourited: vm.favourited,
    });
    assert.equal('frozen' in follow.getLastShown(), false);

    const reopened = { detections: [], $emit() {} };
    const { component } = await loadOverlayInto(reopened);
    assert.equal(reopened.frozen, false, 'a reopened overlay follows again');
    assert.equal(reopened.target.tuneId, 1, 'but still seeds from what was on screen');
    void component;
});

// Rebuilds a vm from the component definition without clearing the module-level
// lastShown cache — which is exactly what a remount does.
async function loadOverlayInto(vm) {
    const mod = await import(`${path.join(tmpDir, 'overlay.mjs')}?v=${Math.random()}`);
    const component = mod.default;
    for (const [name, fn] of Object.entries(component.methods)) vm[name] = fn.bind(vm);
    Object.assign(vm, component.data.call(vm));
    if (component.created) component.created.call(vm);
    return { component };
}

console.log('\nopening the overlay mid-tune');

await test('opening while a tune is already detected loads its score', async () => {
    const { vm } = await loadOverlay({ initialDetections: [det(1, 10, 'The Kesh', 0.71)] });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(vm.target.tuneId, 1);
    assert.equal(vm.loading, false, 'the spinner must stop once the score has arrived');
    assert.ok(vm.abcSetting, 'the score loaded at open must not be discarded as stale');
    assert.equal(vm.abcSetting.setting_id, 10);
});

console.log('\na score that is slow to load');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

await test('a stuck score load stops spinning and says so', async () => {
    const { vm, push, backend } = await loadOverlay();
    vm._scoreLoadTimeoutMs = 20;
    backend.__held.on = true;

    await push([det(1, 10, 'The Kesh', 0.71)]);
    assert.equal(vm.loading, true);
    await sleep(40);
    assert.equal(vm.loading, false, 'the spinner must not run for ever');
    assert.match(vm.loadError, /unusually long/);
});

await test('a late answer after the deadline is still shown', async () => {
    const { vm, push, backend } = await loadOverlay();
    vm._scoreLoadTimeoutMs = 20;
    backend.__held.on = true;

    await push([det(1, 10, 'The Kesh', 0.71)]);
    await sleep(40);
    backend.__held.pending.shift()();
    await settle();
    assert.equal(vm.abcSetting.setting_id, 10);
    assert.equal(vm.loadError, '', 'the slow-load warning comes down once the score is there');
});

await test('after the deadline the next tick retries rather than waiting on the stuck call', async () => {
    const { vm, push, backend } = await loadOverlay();
    vm._scoreLoadTimeoutMs = 20;
    backend.__held.on = true;

    await push([det(1, 10, 'The Kesh', 0.71)]);
    await push([det(1, 10, 'The Kesh', 0.72)]);
    assert.equal(backend.__calls.length, 1, 'inside the deadline, ticks join the call in flight');
    await sleep(40);
    await push([det(1, 10, 'The Kesh', 0.73)]);
    assert.equal(backend.__calls.length, 2, 'past it, a tick may try again');
});

await test('a load that answers in time leaves no timer to fire later', async () => {
    const { vm, push } = await loadOverlay();
    vm._scoreLoadTimeoutMs = 20;
    await push([det(1, 10, 'The Kesh', 0.71)]);
    await sleep(40);
    assert.equal(vm.loadError, '');
    assert.equal(vm.loading, false);
});

await test('the LED keeps moving while frozen — it is about the room, not the tune', async () => {
    // A deliberate exception to "the freeze is total". Everything else in this
    // header is a readout ABOUT THE PINNED TUNE, and freezing exists so those
    // can be read without them moving. The LED is not one of those: it says
    // whether the room is still playing, and a frozen view whose light has
    // gone red is exactly the state the user needs to be able to see.
    const { vm, push, live } = await loadOverlay();

    await push([det(1, 10, 'The Kesh', 0.71)]);
    vm.toggleFrozen();
    assert.equal(vm.frozen, true);

    live.default.__freshness = { level: 'red', colour: 'red darken-2', label: 'Tune over?', detail: '' };
    await push([]);

    assert.equal(vm.target.tuneId, 1, 'the frozen tune must not move');
    assert.equal(vm.freshness.level, 'red');
});

console.log('\nrecord this tune');

await test('the record button starts a capture and reads the result back', async () => {
    const { vm, live } = await loadOverlay();
    assert.equal(vm.captureState, 'available', 'offered while listening');
    assert.equal(vm.capturing, false);
    await vm.toggleCapture();
    assert.equal(live.default.__captureCalls, 1);
    assert.equal(vm.capturing, true);
    await vm.toggleCapture();
    assert.equal(vm.capturing, false, 'a second tap stops it');
});

await test('a capture that could not start says why and does not claim to record', async () => {
    const { vm, live } = await loadOverlay();
    live.default.__captureResult = { ok: false, error: 'Not enough free storage to record audio.' };
    await vm.toggleCapture();
    assert.equal(vm.capturing, false);
    assert.match(vm.captureNote, /Not enough free storage/);
});

await test('not clickable while audio is already recorded; not shown while nothing is listening', async () => {
    const { live, component } = await loadOverlay();
    // A second instance over the same, now re-scripted, fakes.
    const fresh = () => {
        const vm = { detections: [], $emit() {} };
        for (const [name, fn] of Object.entries(component.methods)) vm[name] = fn.bind(vm);
        Object.assign(vm, component.data.call(vm));
        return vm;
    };
    live.default.__recording = true;
    assert.equal(fresh().captureState, 'recording', 'already on — the button is disabled');
    live.default.__recording = false;
    live.default.isRunning = false;
    assert.equal(fresh().captureState, 'not-listening', 'no tune to follow while not listening');
});

await test('a whole-session recording lights the button although it cannot be pressed', async () => {
    // From the field: the switch on the session page was recording, and the
    // button sat pale grey with no sign of it.
    const { live, component } = await loadOverlay();
    live.default.__recording = true;
    live.default.__level = 0.6;
    const vm = { detections: [], $emit() {} };
    for (const [name, fn] of Object.entries(component.methods)) vm[name] = fn.bind(vm);
    Object.assign(vm, component.data.call(vm));
    for (const [name, fn] of Object.entries(component.computed || {})) {
        Object.defineProperty(vm, name, { get: fn.bind(vm), configurable: true });
    }
    assert.equal(vm.captureState, 'recording', 'still not clickable');
    assert.equal(vm.recordingNow, true, 'but shown as recording');
    assert.match(vm.captureLevelStyle.boxShadow, /rgba/);
    live.default.__level = null;
    assert.equal(component.data.call(vm).captureLevel, null, 'and dark when nothing is recorded');
});


console.log('\nauto-centre on the line being played');

// Four staff lines of four one-second events each; line n sits at 100n px.
function fakeScoreRefs(vm) {
    const events = [];
    for (let i = 0; i < 16; i++) events.push({ milliseconds: i * 1000, line: Math.floor(i / 4) });
    const timeline = { events, totalMs: 16000, lines: [{}, {}, {}, {}], lineCount: 4 };
    const scrolls = [];
    const body = {
        scrollTop: 0,
        getBoundingClientRect: () => ({ top: 0, height: 300 }),
        scrollTo(opts) { scrolls.push(opts.top); this.scrollTop = opts.top; },
    };
    vm.$refs = {
        scoreBody: body,
        abcDisplay: {
            followTimeline: () => timeline,
            lineClientRect: (line) => ({ top: 100 * line - body.scrollTop, bottom: 100 * line + 80 - body.scrollTop }),
        },
    };
    return scrolls;
}

// A deterministic contour for the setting on screen, 160 quavers, so a slice
// ending at 90 is 56% through: event 9, line 2 (0-based).
const STORED = (() => {
    let x = 5;
    let out = '';
    for (let i = 0; i < 160; i++) { x = (x * 1103515245 + 12345) % 2147483648; out += 'opqrstuvwxyz'[x % 12]; }
    return out;
})();

// What the service publishes after a window: the transcribed contour. Here,
// the 20 quavers of the stored setting ending at `end`.
function positionFor(end = 90, stored = STORED) {
    return { contour: stored.slice(end - 20, end), readAt: Date.now(), windowSeconds: 10 };
}

await test('auto-centre is off by default and then moves nothing', async () => {
    const { vm, push, live } = await loadOverlay();
    await push([det(1, 10, 'The Kesh', 0.8)]);
    vm.abcSetting.contour = STORED;
    const scrolls = fakeScoreRefs(vm);
    live.default.scorePosition = positionFor();
    vm._updateFollowPosition();
    assert.equal(vm.autoCenter, false);
    assert.deepEqual(scrolls, []);
    assert.equal(vm.positionReadout, '');
});

await test('turned on, it is remembered and centres the line being played', async () => {
    const { vm, push, live } = await loadOverlay();
    const store = (await import(path.join(tmpDir, 'fake-store.mjs'))).default;
    await push([det(1, 10, 'The Kesh', 0.8)]);
    vm.abcSetting.contour = STORED;
    const scrolls = fakeScoreRefs(vm);
    live.default.scorePosition = positionFor();
    vm.toggleAutoCenter();
    assert.equal(store.userSettings.liveAutoCenter, true, 'saved to settings');
    // Line 2 is 200..280 px; centred in a 300 px body means scrolling to 90.
    assert.deepEqual(scrolls, [90]);
    assert.match(vm.positionReadout, /^line 3\/4/);
    assert.deepEqual(vm.followBand, { top: 200, height: 80 });

    // The same line again does not scroll again.
    vm._updateFollowPosition();
    assert.deepEqual(scrolls, [90]);
});

await test('frozen, it does not move', async () => {
    const { vm, push, live } = await loadOverlay();
    await push([det(1, 10, 'The Kesh', 0.8)]);
    vm.abcSetting.contour = STORED;
    const scrolls = fakeScoreRefs(vm);
    vm.toggleFrozen();
    live.default.scorePosition = positionFor();
    vm.toggleAutoCenter();
    assert.deepEqual(scrolls, []);
});

await test('a manual scroll holds the page, though the band still follows', async () => {
    const { vm, push, live } = await loadOverlay();
    await push([det(1, 10, 'The Kesh', 0.8)]);
    vm.abcSetting.contour = STORED;
    const scrolls = fakeScoreRefs(vm);
    vm.toggleAutoCenter();
    vm.onManualScroll();
    live.default.scorePosition = positionFor();
    vm._updateFollowPosition();
    assert.deepEqual(scrolls, [], 'the page stays where the user put it');
    assert.deepEqual(vm.followBand, { top: 200, height: 80 });
});

await test('the position is found in whichever setting is on screen', async () => {
    // The device bug: the query's results carry one setting per tune, rarely
    // the displayed one, so a position taken from them was nearly always
    // "n/a". The window is aligned against the shown setting instead.
    const { vm, push, live } = await loadOverlay();
    await push([det(1, 10, 'The Kesh', 0.8)]);
    // A different setting's contour (another seed), not periodic: a periodic
    // one really would contain the phrase everywhere, and holding is right.
    let other = '';
    let x = 91;
    for (let i = 0; i < 160; i++) { x = (x * 1103515245 + 12345) % 2147483648; other += 'opqrstuvwxyz'[x % 12]; }
    assert.notEqual(other, STORED);
    vm.abcSetting.contour = other;
    const scrolls = fakeScoreRefs(vm);
    live.default.scorePosition = positionFor(90, other);
    vm.toggleAutoCenter();
    assert.deepEqual(scrolls, [90]);
    assert.match(vm.positionReadout, /^line 3\/4/);
});

await test('audio that does not match the setting on screen moves nothing and says so', async () => {
    const { vm, push, live } = await loadOverlay();
    await push([det(1, 10, 'The Kesh', 0.8)]);
    vm.abcSetting.contour = STORED;
    const scrolls = fakeScoreRefs(vm);
    live.default.scorePosition = { contour: 'ABCDEFABCDEFABCDEF', readAt: Date.now(), windowSeconds: 10 };
    vm.toggleAutoCenter();
    assert.deepEqual(scrolls, []);
    assert.match(vm.positionReadout, /^position unclear/);
});

await test('coming round to the top of the tune moves back at once', async () => {
    // The tracker follows the music across the end of the tune; the view
    // must not then hold the band on the last line waiting for a second
    // window, which is what made the first version sit there for seconds
    // at every time through.
    const { vm, push, live } = await loadOverlay();
    await push([det(1, 10, 'The Kesh', 0.8)]);
    vm.abcSetting.contour = STORED;
    const scrolls = fakeScoreRefs(vm);
    // The second window is stamped ten seconds after the first (20 quavers
    // in 10 s is 2 a second, so the music has gone 150 -> 170 = 10 on the
    // next time through); the view's clock is the real one, and a window
    // stamped ahead of it is simply not projected further.
    const now = Date.now();
    live.default.scorePosition = { contour: STORED.slice(130, 150), readAt: now, windowSeconds: 10 };
    vm.toggleAutoCenter();
    assert.match(vm.positionReadout, /^line 4\/4/);
    live.default.scorePosition = {
        contour: STORED.slice(150) + STORED.slice(0, 10), readAt: now + 10000, windowSeconds: 10,
    };
    vm._updateFollowPosition();
    assert.match(vm.positionReadout, /^line 1\/4/);
    assert.equal(scrolls[scrolls.length - 1], 0);
});

await rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
// Explicit: the overlay's level poll is a live interval on each instance
// built here, and no test runs its beforeDestroy().
process.exit(failed ? 1 : 0);
