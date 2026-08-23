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
export function __reset() { __calls.length = 0; }
export default {
    async settingsFromTuneID(tuneId) {
        __calls.push(tuneId);
        return [{ tune_id: tuneId, setting_id: Number(String(tuneId)) * 10, abc: 'X:1\\n' }];
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
};
`;

const FAKE_EVENTBUS = `export default { $emit() {}, $on() {}, $off() {} };`;
const FAKE_LIVE_ANALYSIS = `export default { elapsedSeconds: 0 };`;
const FAKE_MDI = `
export const mdiStar = 'star';
export const mdiStarOutline = 'star-outline';
export const mdiPin = 'pin';
export const mdiPinOutline = 'pin-outline';
`;
const FAKE_SESSION_ANALYSIS = `export function formatSecondsAsClock(s) { return String(s); }`;
// The overlay renders these; nothing here touches them.
const FAKE_VUE_COMPONENT = `export default { name: 'stub' };`;

// Lift the <script> block out of the SFC and rewrite its imports. Asserting on
// each marker means a restructured component fails loudly rather than silently
// testing nothing.
async function loadOverlay() {
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
        ["from '@/js/sessionAnalysis.js'", "from './fake-session-analysis.mjs'"],
        // Deliberately the real module.
        ["from '@/js/liveScoreFollow.mjs'", `from '${followModule}'`],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in the SFC`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'overlay.mjs'), source);

    const backend = await import(path.join(tmpDir, 'fake-backend.mjs'));
    const follow = await import(followModule);
    backend.__reset();
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
    component.created.call(vm);

    // Stands in for the detections watcher, which is what Vue would call.
    const handler = component.watch.detections.handler.bind(vm);
    const push = async (detections) => {
        vm.detections = detections;
        handler(detections);
        // Let the loadScore() it may have started settle.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    };

    return { vm, push, backend, follow, component };
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
    component.created.call(vm);
    return { component };
}

await rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
