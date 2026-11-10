// The shared "Played in sets with…" dialog (components/SetPartnersDialog.vue).
//
// Same harness as tuneBackgroundDialog.test.mjs: lift the SFC's <script>,
// rewrite its imports to fakes, drive it against a fake `this`. The hazard
// worth pinning is the one every shared dialog has: reopened for tune B while
// tune A's lookup is in flight, A's partners must never appear under B.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-set-partners-dialog');

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`);
    }
}

const FAKE_BACKEND = `
export const __partners = {};
export const __held = {};
export function __hold(tuneID) {
    let release;
    __held[tuneID] = new Promise(r => { release = r; });
    return release;
}
export default {
    async setPartnersFromTuneID(tuneID) {
        if (__held[tuneID]) await __held[tuneID];
        return __partners[tuneID] || [];
    },
};
`;
const FAKE_STORE = `
export const __starred = new Set();
export default { async _loadFavouriteTuneIDs() { return __starred; } };
`;
const FAKE_EVENTBUS = `export default { $emit() {}, $on() {}, $off() {} };`;
const FAKE_UTILS = `export default { parseDisplayableName: s => s.toUpperCase() };`;

async function loadDialog() {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'fake-backend.mjs'), FAKE_BACKEND);
    await writeFile(path.join(tmpDir, 'fake-store.mjs'), FAKE_STORE);
    await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);
    await writeFile(path.join(tmpDir, 'fake-utils.mjs'), FAKE_UTILS);
    await writeFile(path.join(tmpDir, 'fake-mdi.mjs'), `export const mdiStar = 'star';`);

    const sfc = await readFile(path.join(srcDir, 'components', 'SetPartnersDialog.vue'), 'utf8');
    const open = sfc.indexOf('<script>');
    const close = sfc.indexOf('</script>');
    assert.ok(open !== -1 && close > open, 'expected a <script> block in the SFC');
    let source = sfc.slice(open + '<script>'.length, close);
    for (const [from, to] of [
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from '@/services/backend.js'", "from './fake-backend.mjs'"],
        ["from '@/services/store.js'", "from './fake-store.mjs'"],
        ["from '@/js/utils.js'", "from './fake-utils.mjs'"],
        ["from '@/js/setPartners.mjs'", `from '${path.join(srcDir, 'js', 'setPartners.mjs')}'`],
        ["from '@mdi/js'", "from './fake-mdi.mjs'"],
    ]) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in the SFC`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'dialog.mjs'), source);
    const backend = await import(path.join(tmpDir, 'fake-backend.mjs'));
    const store = await import(path.join(tmpDir, 'fake-store.mjs'));
    for (const k of Object.keys(backend.__partners)) delete backend.__partners[k];
    for (const k of Object.keys(backend.__held)) delete backend.__held[k];
    store.__starred.clear();

    const mod = await import(`${path.join(tmpDir, 'dialog.mjs')}?v=${Math.random()}`);
    const component = mod.default;
    const vm = Object.assign({}, component.data());
    for (const [name, fn] of Object.entries(component.methods)) vm[name] = fn.bind(vm);
    for (const [name, fn] of Object.entries(component.computed || {})) {
        Object.defineProperty(vm, name, { get: fn.bind(vm), configurable: true });
    }
    vm.$router = { pushed: [], push(to) { this.pushed.push(to); return Promise.resolve(); } };
    return { vm, backend, store };
}

const partner = (tuneID, inSets) => ({ tuneID, name: `tune ${tuneID}`, dance: 'reel',
    inSets, onRecordings: 0, followedBy: 0, precededBy: 0 });

await test('opens, ranks, and puts a commonly played favourite first', async () => {
    const { vm, backend, store } = await loadDialog();
    backend.__partners['1'] = [partner('2', 40), partner('3', 20), partner('4', 1)];
    store.__starred.add('3');
    store.__starred.add('4');
    await vm.show({ tuneID: 1, title: 'one' });
    assert.equal(vm.open, true);
    assert.equal(vm.loading, false);
    assert.deepEqual(vm.partners.map(p => p.tuneID), ['3', '2', '4']);
    assert.equal(vm.hasStarredCommon, true);
});

await test('a slow answer for the previous tune is not shown under the next', async () => {
    const { vm, backend } = await loadDialog();
    backend.__partners['1'] = [partner('2', 40)];
    backend.__partners['5'] = [partner('6', 10)];
    const release = backend.__hold('1');
    const first = vm.show({ tuneID: '1', title: 'one' });
    await vm.show({ tuneID: '5', title: 'five' });
    release();
    await first;
    assert.equal(vm.tuneID, '5');
    assert.deepEqual(vm.partners.map(p => p.tuneID), ['6']);
});

await test('reopening for another tune clears the previous list at once', async () => {
    const { vm, backend } = await loadDialog();
    backend.__partners['1'] = [partner('2', 40)];
    await vm.show({ tuneID: '1' });
    const release = backend.__hold('5');
    const pending = vm.show({ tuneID: '5' });
    assert.deepEqual(vm.partners, [], 'tune 1\'s partners were still on screen');
    release();
    await pending;
});

await test('tapping a partner opens it by its primary alias and closes', async () => {
    const { vm, backend } = await loadDialog();
    backend.__partners['1'] = [partner('2', 40)];
    await vm.show({ tuneID: '1' });
    vm.openTune(vm.partners[0]);
    assert.equal(vm.open, false);
    assert.deepEqual(vm.$router.pushed[0],
        { name: 'tune', query: { tuneID: '2', displayName: 'tune 2' } });
});

await rm(tmpDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
