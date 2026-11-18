// The shared Add-to-set dialog, for a batch named by TUNE — a session's tune
// list — rather than by setting.
//
// Run with:  node app/test/addToSetDialog.test.mjs
//
// Same harness as tuneBackgroundDialog.test.mjs: the SFC's <script> block is
// lifted out, its imports rewritten to fakes (store, backend, event bus) or to
// the real pure modules, and its methods driven against a fake `this`.
//
// What is pinned:
//   - each tune resolves to a setting, a STARRED one first, not whichever
//     setting the detection happened to score best;
//   - a tune with no score anywhere is left out and named, never added as a
//     stub the set validator would refuse;
//   - each row's setting can be changed in the dialog, and the change is what
//     is saved;
//   - the session's name and notes reach the new set, in played order.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, `.tmp-add-to-set-dialog-${process.pid}`);

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`);
    }
}

const FAKE_STORE = `
export const __state = { favourites: [], sets: [], saved: [] };
export function __reset() { __state.favourites = []; __state.sets = []; __state.saved = []; }
export default {
    getFavourites: async () => JSON.parse(JSON.stringify(__state.favourites)),
    getTuneSets: async () => JSON.parse(JSON.stringify(__state.sets)),
    saveTuneSet: async (draft, version) => {
        __state.saved.push({ draft: JSON.parse(JSON.stringify(draft)), version });
        return { ...draft, updatedAt: 1 };
    },
};
`;

// settingsFromTuneID answers from a per-tune table; a tune missing from it
// behaves like one whose dataset is not loaded.
const FAKE_BACKEND = `
export const __settings = {};
export default { settingsFromTuneID: async tuneID => __settings[String(tuneID)] || [] };
`;

const FAKE_EVENTBUS = 'export default { $emit() {}, $on() {}, $off() {} };\n';
const FAKE_MDI = 'export const mdiArrowUp = "up"; export const mdiArrowDown = "down";\n';
const FAKE_UTILS = 'export default { parseDisplayableName: n => n };\n';

async function loadDialog() {
    await writeFile(path.join(tmpDir, 'fake-store.mjs'), FAKE_STORE);
    await writeFile(path.join(tmpDir, 'fake-backend.mjs'), FAKE_BACKEND);
    await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);
    await writeFile(path.join(tmpDir, 'fake-mdi.mjs'), FAKE_MDI);
    await writeFile(path.join(tmpDir, 'fake-utils.mjs'), FAKE_UTILS);

    const sfc = await readFile(path.join(srcDir, 'components', 'AddToSetDialog.vue'), 'utf8');
    const open = sfc.indexOf('<script>');
    const close = sfc.indexOf('</script>');
    assert.ok(open !== -1 && close > open, 'expected a <script> block in the SFC');
    let source = sfc.slice(open + '<script>'.length, close);
    const replacements = [
        ["from '@mdi/js'", "from './fake-mdi.mjs'"],
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from '@/services/store.js'", "from './fake-store.mjs'"],
        ["from '@/services/backend.js'", "from './fake-backend.mjs'"],
        ["from '@/js/utils.js'", "from './fake-utils.mjs'"],
        ["from '@/services/setSearch.mjs'", `from '${path.join(srcDir, 'services', 'setSearch.mjs')}'`],
        ["from '@/js/favouriteFacets.mjs'", `from '${path.join(srcDir, 'js', 'favouriteFacets.mjs')}'`],
        ["from '@/js/setMembership.mjs'", `from '${path.join(srcDir, 'js', 'setMembership.mjs')}'`],
        ["from '@/js/sessionSets.mjs'", `from '${path.join(srcDir, 'js', 'sessionSets.mjs')}'`],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in the SFC`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'dialog.mjs'), source);

    const store = await import(path.join(tmpDir, 'fake-store.mjs'));
    const backend = await import(path.join(tmpDir, 'fake-backend.mjs'));
    store.__reset();
    for (const k of Object.keys(backend.__settings)) delete backend.__settings[k];

    const mod = await import(`${path.join(tmpDir, 'dialog.mjs')}?v=${Math.random()}`);
    const component = mod.default;
    const vm = Object.assign({}, component.data());
    for (const [name, fn] of Object.entries(component.methods)) vm[name] = fn.bind(vm);
    for (const [name, fn] of Object.entries(component.computed || {})) {
        Object.defineProperty(vm, name, { get: fn.bind(vm), configurable: true });
    }
    return { vm, store, backend: backend.__settings };
}

globalThis.crypto ??= (await import('node:crypto')).webcrypto;

const setting = (tune_id, setting_id, mode = 'Dmajor') =>
    ({ tune_id, setting_id, mode, dance: 'reel', abc: `X:${setting_id}\nK:D\nABcd|` });
const favourite = (tuneID, settingID, name) =>
    ({ result: { settingID, displayName: name, setting: setting(tuneID, settingID) } });

await mkdir(tmpDir, { recursive: true });

console.log('\na batch of tunes from a session');

await test('each tune gets its starred setting, not the detected one', async () => {
    const { vm, store, backend } = await loadDialog();
    backend['1'] = [setting(1, 10), setting(1, 11), setting(1, 12)];
    backend['2'] = [setting(2, 20), setting(2, 21)];
    store.__state.favourites = [favourite(1, 12, 'Kesh, The')];
    await vm.show({ title: '2 tunes', tunes: [
        { tuneID: 1, title: 'Kesh, The', settingID: '10' },
        { tuneID: 2, title: 'Silver Spear, The', settingID: '21' },
    ] });
    assert.deepEqual(vm.batch.map(e => String(e.setting_id)), ['12', '21'],
        'starred 12 beats detected 10; with nothing starred the detected 21 is kept');
    assert.equal(vm.batch[0].options.length, 3, 'the row carries every setting to choose from');
    assert.equal(vm.batchOptions(vm.batch[0])[0].text.startsWith('★'), true, 'the starred one is marked');
    assert.deepEqual(vm.skipped, []);
});

await test('a tune with no score anywhere is left out and named', async () => {
    const { vm, backend } = await loadDialog();
    backend['1'] = [setting(1, 10)];
    // Tune 2: index not loaded for it, nothing starred.
    await vm.show({ title: '2 tunes', tunes: [
        { tuneID: 1, title: 'Kesh, The', settingID: '10' },
        { tuneID: 2, title: 'Mystery Reel', settingID: '20' },
    ] });
    assert.deepEqual(vm.batch.map(e => String(e.setting_id)), ['10']);
    assert.deepEqual(vm.skipped, ['Mystery Reel']);
});

await test('a starred setting stands in when the index does not have the tune', async () => {
    const { vm, store } = await loadDialog();
    store.__state.favourites = [favourite(3, 30, 'Butterfly, The')];
    await vm.show({ title: '1 tune', tunes: [{ tuneID: 3, title: 'Butterfly, The', settingID: '31' }] });
    assert.deepEqual(vm.batch.map(e => String(e.setting_id)), ['30']);
});

await test('changing a row\'s setting is what gets saved, with the session name and notes, in order', async () => {
    const { vm, store, backend } = await loadDialog();
    backend['1'] = [setting(1, 10), setting(1, 11, 'Gmajor')];
    backend['2'] = [setting(2, 20)];
    store.__state.sets = [{ id: 'old', name: 'Old set', entries: [], updatedAt: 5 }];
    await vm.show({ title: '2 tunes', name: '12 Nov · set 1', notes: 'From the session 12 Nov.', tunes: [
        { tuneID: 1, title: 'Kesh, The', settingID: '10' },
        { tuneID: 2, title: 'Silver Spear, The', settingID: '20' },
    ] });
    assert.equal(vm.destination, 'new', 'a suggested name preselects a new set, even with sets existing');
    assert.equal(vm.name, '12 Nov · set 1');
    vm.chooseBatchSetting(0, '11');
    assert.equal(vm.batch[0].setting.mode, 'Gmajor');
    await vm.add();
    assert.equal(vm.error, '');
    const { draft, version } = store.__state.saved[0];
    assert.equal(version, null);
    assert.equal(draft.name, '12 Nov · set 1');
    assert.equal(draft.notes, 'From the session 12 Nov.');
    assert.deepEqual(draft.entries.map(e => String(e.result.settingID)), ['11', '20']);
    assert.equal(draft.entries[0].result.setting.abc.includes('X:11'), true, 'the entry carries its score');
    assert.equal('options' in draft.entries[0].result, false, 'the choices are not saved');
});

await test('without a suggested name, existing sets still force a choice', async () => {
    const { vm, store, backend } = await loadDialog();
    backend['1'] = [setting(1, 10)];
    store.__state.sets = [{ id: 'old', name: 'Old set', entries: [], updatedAt: 5 }];
    await vm.show({ title: '1 tune', tunes: [{ tuneID: 1, title: 'Kesh, The', settingID: '10' }] });
    assert.equal(vm.destination, null);
});

await test('a favourites batch is unchanged: exact settings, no picker', async () => {
    const { vm } = await loadDialog();
    const entry = { setting_id: 12, setting: setting(1, 12), display_name: 'Kesh, The' };
    await vm.show({ title: '1 tune', entries: [entry] });
    assert.deepEqual(vm.batch.map(e => e.setting_id), [12]);
    assert.deepEqual(vm.batchOptions(vm.batch[0]), []);
});

await rm(tmpDir, { recursive: true, force: true });
console.log(`\naddToSetDialog.test.mjs: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
