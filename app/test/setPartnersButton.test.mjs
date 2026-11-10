// The "Played in sets with" button (components/SetPartnersButton.vue).
//
// Same harness as setPartnersDialog.test.mjs: lift the SFC's <script>,
// rewrite its imports to fakes, drive it against a fake `this` with no Vue
// runtime. What is pinned here is that the button tracks what the index
// HOLDS, not just whether it is usable: a Tune view opened on a cached v2489
// copy (no set data) must show the button once the background update to the
// release that carries `sets` lands — which emits `indexStatusChanged` but no
// new `indexLoaded`, since the index never stopped being usable.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-set-partners-button');

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
export const __held = [];
export default {
    async setPartnersFromTuneID(tuneID) {
        const answer = (__partners[tuneID] || []).slice();
        if (__held.length) await __held.shift();
        return answer;
    },
};
`;
const FAKE_EVENTBUS = `
const handlers = {};
export default {
    $on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
    $off(name, fn) { handlers[name] = (handlers[name] || []).filter(f => f !== fn); },
    $emit(name, payload) { for (const fn of handlers[name] || []) fn(payload); },
    __count(name) { return (handlers[name] || []).length; },
};
`;

async function loadButton() {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'fake-backend.mjs'), FAKE_BACKEND);
    await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);
    await writeFile(path.join(tmpDir, 'fake-mdi.mjs'), `export const mdiPlaylistMusic = 'icon';`);

    const sfc = await readFile(path.join(srcDir, 'components', 'SetPartnersButton.vue'), 'utf8');
    const open = sfc.indexOf('<script>');
    const close = sfc.indexOf('</script>');
    assert.ok(open !== -1 && close > open, 'expected a <script> block in the SFC');
    let source = sfc.slice(open + '<script>'.length, close);
    for (const [from, to] of [
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from '@/services/backend.js'", "from './fake-backend.mjs'"],
        ["from '@mdi/js'", "from './fake-mdi.mjs'"],
    ]) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in the SFC`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'button.mjs'), source);
    const component = (await import(path.join(tmpDir, 'button.mjs'))).default;
    const backend = await import(path.join(tmpDir, 'fake-backend.mjs'));
    const eventBus = (await import(path.join(tmpDir, 'fake-eventbus.mjs'))).default;
    return { component, backend, eventBus };
}

// Mount in Vue 2's order: data, then the IMMEDIATE watcher, then created().
async function mount(component, tuneID) {
    const vm = { ...component.data(), tuneID, title: '' };
    for (const [k, fn] of Object.entries(component.methods)) vm[k] = fn.bind(vm);
    const watchFirst = vm[component.watch.tuneID.handler]();
    component.created.call(vm);
    await watchFirst;
    return vm;
}

const tick = () => new Promise(r => setTimeout(r, 0));

async function run() {
    const { component, backend, eventBus } = await loadButton();
    const reset = () => {
        for (const k of Object.keys(backend.__partners)) delete backend.__partners[k];
        backend.__held.length = 0;
    };

    await test('the first answer is applied, though the watcher runs before created()', async () => {
        reset();
        backend.__partners['2410'] = [{ tuneID: '9196' }];
        const vm = await mount(component, '2410');
        assert.equal(vm.available, true, 'the first check was thrown away');
    });

    await test('a background update that brings set data shows the button', async () => {
        reset();
        const vm = await mount(component, '2410');          // cached v2489: nothing
        assert.equal(vm.available, false);
        backend.__partners['2410'] = [{ tuneID: '9196' }];   // v2505 lands
        eventBus.$emit('indexStatusChanged', { status: 'downloading', usable: true });
        await tick();
        assert.equal(vm.available, false, 'mid-download is not the moment to ask');
        eventBus.$emit('indexStatusChanged', { status: 'ready', usable: true });
        await tick();
        assert.equal(vm.available, true, 'stayed hidden after the update');
        component.beforeDestroy.call(vm);
    });

    await test('removing the dataset hides it again', async () => {
        reset();
        backend.__partners['2410'] = [{ tuneID: '9196' }];
        const vm = await mount(component, '2410');
        assert.equal(vm.available, true);
        delete backend.__partners['2410'];
        eventBus.$emit('indexStatusChanged', { status: 'unavailable', usable: false });
        await tick();
        assert.equal(vm.available, false);
        component.beforeDestroy.call(vm);
    });

    await test('a slow answer for the SAME tune cannot overrule a newer one', async () => {
        reset();
        const vm = await mount(component, '2410');
        let releaseOld;
        backend.__held.push(new Promise(r => { releaseOld = r; }));
        const older = vm.checkAvailable();                   // asked before the update: []
        backend.__partners['2410'] = [{ tuneID: '9196' }];
        await vm.checkAvailable();                           // asked after it
        assert.equal(vm.available, true);
        releaseOld();
        await older;
        assert.equal(vm.available, true, 'the stale empty answer hid the button');
        component.beforeDestroy.call(vm);
    });

    await test('destroying it removes both listeners', async () => {
        reset();
        const before = [eventBus.__count('indexLoaded'), eventBus.__count('indexStatusChanged')];
        const vm = await mount(component, '2410');
        component.beforeDestroy.call(vm);
        assert.deepEqual(
            [eventBus.__count('indexLoaded'), eventBus.__count('indexStatusChanged')], before);
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    await rm(tmpDir, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
