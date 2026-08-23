// The ABC preview in a favourites row must not be engraved until the row is
// actually near the viewport.
//
// Run with:  node app/test/favouriteRow.test.mjs
//
// This is the expensive half of "the Favourites view takes seconds to appear on
// an older iPad": ABCJS.renderAbc is a full music-layout pass producing several
// hundred SVG nodes, and it used to run synchronously for every row in the list
// during the render that was supposed to put the view on screen.
//
// The property is easy to state and easy to break by accident, because the
// engraving lives in a computed and computeds evaluate whenever something reads
// them — so anything that reads `abcSvg` outside the `v-if` puts the cost right
// back. The test therefore counts real calls into a faked ABCJS rather than
// asserting on the shape of `showAbcPreview`.
//
// Same harness as liveScoreFollowComponent.test.mjs: the component is a plain
// Options-API object, so its data()/computed can be driven against a fake `this`
// with no Vue runtime.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-favourite-row');

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

const FAKE_ABCJS = `
export const __renders = [];
export default {
    renderAbc(div, abc) {
        __renders.push(abc);
        div.__html = '<svg/>';
    },
};
`;

const FAKE_UTILS = `export default { utcToString: (t) => 'at ' + t };`;
const FAKE_MDI = `
export const mdiStar = 'star';
export const mdiTagPlusOutline = 'tag-plus';
`;
const FAKE_COMPONENT = `export default { name: 'stub' };`;

const SETTING = {
    abc: 'G3 GAB|dBG GAB|d2d def|gfe dBA|',
    mode: 'Gmajor',
    meter: '6/8',
    tune_id: 42,
};

async function loadRow() {
    await writeFile(path.join(tmpDir, 'fake-abcjs.mjs'), FAKE_ABCJS);
    await writeFile(path.join(tmpDir, 'fake-utils.mjs'), FAKE_UTILS);
    await writeFile(path.join(tmpDir, 'fake-mdi.mjs'), FAKE_MDI);
    await writeFile(path.join(tmpDir, 'fake-component.mjs'), FAKE_COMPONENT);

    const sfc = await readFile(path.join(srcDir, 'components', 'FavouriteRow.vue'), 'utf8');
    const open = sfc.indexOf('<script>');
    const close = sfc.indexOf('</script>');
    assert.ok(open !== -1 && close > open, 'expected a <script> block in the SFC');
    let source = sfc.slice(open + '<script>'.length, close);

    const replacements = [
        ["from '@mdi/js'", "from './fake-mdi.mjs'"],
        ["from 'abcjs'", "from './fake-abcjs.mjs'"],
        ["from '@/js/utils'", "from './fake-utils.mjs'"],
        ["from '@/components/TuneBackgroundButton.vue'", "from './fake-component.mjs'"],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in the SFC`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'row.mjs'), source);

    const abcjs = await import(path.join(tmpDir, 'fake-abcjs.mjs'));
    abcjs.__renders.length = 0;

    const mod = await import(`${path.join(tmpDir, 'row.mjs')}?v=${Math.random()}`);
    return { component: mod.default, abcjs };
}

// Builds a fake `this` for the component at a given row width and visibility.
// `document.createElement` is the only DOM the engraving path touches.
function makeVm(component, { rowWidth, inView, setting = SETTING }) {
    const vm = {
        setting,
        tags: [],
        allTags: [],
        timestamp: 0,
    };
    Object.assign(vm, component.data.call(vm));
    vm.rowWidth = rowWidth;
    vm.inView = inView;
    for (const [name, fn] of Object.entries(component.computed || {})) {
        Object.defineProperty(vm, name, { get: fn.bind(vm), configurable: true });
    }
    return vm;
}

// The `v-if="showAbcPreview"` short-circuits `v-html="abcSvg"`, so this is what
// Vue does: read the gate, and only read the engraving when it is open.
function render(vm) {
    return vm.showAbcPreview ? vm.abcSvg : null;
}

globalThis.document = {
    createElement: () => ({ __html: '', get innerHTML() { return this.__html; } }),
};

async function main() {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    const { component, abcjs } = await loadRow();

    await test('a wide row that is off screen does not engrave', async () => {
        abcjs.__renders.length = 0;
        const vm = makeVm(component, { rowWidth: 900, inView: false });
        assert.equal(render(vm), null);
        assert.equal(abcjs.__renders.length, 0,
            'ABCJS ran for a row the user cannot see');
    });

    await test('the same row engraves once it comes into view', async () => {
        abcjs.__renders.length = 0;
        const vm = makeVm(component, { rowWidth: 900, inView: false });
        render(vm);
        vm.inView = true;
        assert.ok(render(vm), 'expected preview markup');
        assert.equal(abcjs.__renders.length, 1);
    });

    await test('a narrow row never engraves, in view or not', async () => {
        abcjs.__renders.length = 0;
        const vm = makeVm(component, { rowWidth: 320, inView: true });
        assert.equal(render(vm), null);
        assert.equal(abcjs.__renders.length, 0);
    });

    await test('a row with no ABC never engraves', async () => {
        abcjs.__renders.length = 0;
        const vm = makeVm(component, { rowWidth: 900, inView: true, setting: { tune_id: 7 } });
        assert.equal(render(vm), null);
        assert.equal(abcjs.__renders.length, 0);
    });

    // Without an IntersectionObserver there is no way to learn that a row has
    // been scrolled onto, so the row must start visible — a browser too old for
    // the optimisation gets the old, slow behaviour, never a blank list.
    await test('with no IntersectionObserver the row starts in view', async () => {
        const saved = globalThis.IntersectionObserver;
        delete globalThis.IntersectionObserver;
        try {
            const { component: c2 } = await loadRow();
            const data = c2.data.call({});
            assert.equal(data.inView, true);
        } finally {
            if (saved) globalThis.IntersectionObserver = saved;
        }
    });

    await test('with an IntersectionObserver the row starts out of view', async () => {
        globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
        try {
            const { component: c2 } = await loadRow();
            const data = c2.data.call({});
            assert.equal(data.inView, false);
        } finally {
            delete globalThis.IntersectionObserver;
        }
    });

    await rm(tmpDir, { recursive: true, force: true });

    console.log(`\nfavouriteRow: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main();
