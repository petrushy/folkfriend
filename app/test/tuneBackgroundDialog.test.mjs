// Unit tests for the shared tune-background dialog.
//
// Run with:  node app/test/tuneBackgroundDialog.test.mjs
//
// The dialog is mounted once in App.vue and opened from four different buttons,
// which buys a lot of saved DOM and introduces exactly two hazards worth pinning:
//
//   1. Opening it for tune B must never show tune A's note.
//   2. A generation already in flight for tune A must be built entirely from
//      tune A's inputs. The dialog can be dismissed by tapping outside it and
//      reopened for another tune while the fetches are running, so anything read
//      off `this` after the first await belongs to whichever tune is on screen
//      *now* — not the one being generated. The tune-ID guards around the
//      display cannot help here: by then the wrong record is already saved.
//
// There is no Vue runtime involved. The component is a plain Options-API object,
// so its `data()` and `methods` can be exercised directly against a fake `this`
// — which is the whole point of keeping the network layer out of the component.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-tune-background-dialog');

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

// Records every call so a test can assert what the request was actually built
// from, and lets a test hold `fetchSessionComments` open to create the race.
const FAKE_AI = `
export const __calls = [];
export let __holdComments = null;
export function __reset() { __calls.length = 0; __holdComments = null; }
export function __holdNextComments() {
    let release;
    __holdComments = new Promise(resolve => { release = resolve; });
    return release;
}
export const DEFAULT_MODEL = 'claude-haiku-4-5';
export function describeAiSummaryError(e) { return \`described:\${e && e.kind}\`; }
export async function fetchSessionTuneFacts(tuneID) {
    __calls.push({ fn: 'facts', tuneID });
    return { name: \`Tune \${tuneID}\` };
}
export async function fetchSessionComments(tuneID) {
    __calls.push({ fn: 'comments', tuneID });
    if (__holdComments) await __holdComments;
    return { text: \`comments for \${tuneID}\`, count: 3, source: 'json' };
}
export async function generateTuneSummary(args) {
    __calls.push({ fn: 'generate', ...args });
    return {
        text: \`note for \${args.tuneID}\`,
        model: args.model,
        generatedAt: 1000,
        sourceUrl: args.sourceUrl,
        grounding: 'comments',
        commentCount: 3,
        usage: { input_tokens: 10, output_tokens: 20 },
    };
}
`;

const FAKE_STORE = `
export const __saved = {};
export const __usage = [];
export let __apiKey = 'sk-ant-test';
export function __reset() {
    for (const k of Object.keys(__saved)) delete __saved[k];
    __usage.length = 0;
    __apiKey = 'sk-ant-test';
}
export function __setApiKey(v) { __apiKey = v; }
export default {
    userSettings: { aiSummaryModel: 'claude-haiku-4-5' },
    getApiKey: () => __apiKey,
    recordAiUsage: (usage, model) => __usage.push({ usage, model }),
    setAiSummary: async (tuneID, record) => { __saved[String(tuneID)] = record; },
    getAiSummary: async (tuneID) => __saved[String(tuneID)] || null,
};
`;

const FAKE_EVENTBUS = `
export default { $emit() {}, $on() {}, $off() {} };
`;

// The SFC cannot be imported directly, so lift its <script> block out and rewrite
// the three imports. Deliberately not a regex over the whole file: the template
// contains no <script>, so the first block is the right one, and asserting on the
// markers means a restructured component fails loudly rather than silently
// testing nothing.
async function loadDialog() {
    await writeFile(path.join(tmpDir, 'fake-ai.mjs'), FAKE_AI);
    await writeFile(path.join(tmpDir, 'fake-store.mjs'), FAKE_STORE);
    await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);

    const sfc = await readFile(
        path.join(srcDir, 'components', 'TuneBackgroundDialog.vue'), 'utf8');
    const open = sfc.indexOf('<script>');
    const close = sfc.indexOf('</script>');
    assert.ok(open !== -1 && close > open, 'expected a <script> block in the SFC');
    let source = sfc.slice(open + '<script>'.length, close);

    const replacements = [
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from '@/services/store.js'", "from './fake-store.mjs'"],
        ["from '@/services/aiSummary.js'", "from './fake-ai.mjs'"],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in the SFC`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'dialog.mjs'), source);

    // Fakes are singletons across loads (imported by the same bare specifier the
    // component resolves), so reset rather than cache-bust them.
    const ai = await import(path.join(tmpDir, 'fake-ai.mjs'));
    const store = await import(path.join(tmpDir, 'fake-store.mjs'));
    ai.__reset();
    store.__reset();

    const mod = await import(`${path.join(tmpDir, 'dialog.mjs')}?v=${Math.random()}`);
    const component = mod.default;

    // A fake `this`: the component's own data, plus the two Vue affordances it
    // touches. No reactivity is needed — the assertions read the fields directly.
    const vm = Object.assign({}, component.data());
    for (const [name, fn] of Object.entries(component.methods)) vm[name] = fn.bind(vm);
    for (const [name, fn] of Object.entries(component.computed || {})) {
        Object.defineProperty(vm, name, { get: fn.bind(vm), configurable: true });
    }
    return { vm, ai, store };
}

await mkdir(tmpDir, { recursive: true });

console.log('\nopening the shared dialog');

await test('opening for a different tune clears the previous note', async () => {
    const { vm, store } = await loadDialog();
    store.__saved['7'] = { text: 'Note for 7.', generatedAt: 1 };

    await vm.show({ tuneID: '7', displayName: 'The Kesh' });
    assert.equal(vm.summary.text, 'Note for 7.');

    // Tune 9 has no saved note. With a single shared dialog, failing to reset
    // here is how tune 9 ends up displaying tune 7's history.
    await vm.show({ tuneID: '9', displayName: 'The Butterfly' });
    assert.equal(vm.summary, null, 'a different tune must not inherit the note');
    assert.equal(vm.tuneID, '9');
    assert.equal(vm.title, 'The Butterfly');
});

await test('reopening the same tune keeps its note and makes no second read', async () => {
    const { vm, store } = await loadDialog();
    store.__saved['7'] = { text: 'Note for 7.', generatedAt: 1 };

    await vm.show({ tuneID: '7', displayName: 'The Kesh' });
    vm.open = false;
    store.__saved['7'] = { text: 'MUTATED', generatedAt: 2 };
    await vm.show({ tuneID: '7', displayName: 'The Kesh' });

    assert.equal(vm.summary.text, 'Note for 7.', 'the held note must be reused');
    assert.equal(vm.open, true);
});

await test('opening never generates — a cache miss waits for a tap', async () => {
    const { vm, ai } = await loadDialog();
    await vm.show({ tuneID: '7', displayName: 'The Kesh' });

    assert.equal(vm.summary, null);
    assert.equal(ai.__calls.length, 0, 'opening the dialog must not spend money');
});

console.log('\ngenerating');

await test('the request is built entirely from the tune it started for', async () => {
    const { vm, ai, store } = await loadDialog();

    const release = ai.__holdNextComments();
    await vm.show({ tuneID: '7', displayName: 'The Kesh', sourceUrl: 'https://example.test/7' });
    const generating = vm.generateSummary();

    // The user dismisses the dialog (tapping outside is not disabled) and opens
    // it for another tune while tune 7's fetches are still in flight.
    await vm.show({ tuneID: '9', displayName: 'The Butterfly', sourceUrl: 'https://example.test/9' });
    release();
    await generating;

    const generate = ai.__calls.find(c => c.fn === 'generate');
    assert.ok(generate, 'generateTuneSummary must have been called');
    assert.equal(generate.tuneID, '7');
    assert.equal(generate.displayName, 'The Kesh',
        "tune 7's note must not be written with tune 9's title");
    assert.equal(generate.sourceUrl, 'https://example.test/7',
        "tune 7's note must not be grounded in tune 9's page");

    // sourceUrl also derives allowed_domains, so a crossed request is not merely
    // mislabelled — it is pointed at the wrong page.
    assert.equal(store.__saved['7'].sourceUrl, 'https://example.test/7');
    assert.equal(store.__saved['9'], undefined, 'nothing may be saved for tune 9');
});

await test('a result that arrives after the tune changed is saved but not shown', async () => {
    const { vm, ai, store } = await loadDialog();

    const release = ai.__holdNextComments();
    await vm.show({ tuneID: '7', displayName: 'The Kesh' });
    const generating = vm.generateSummary();
    await vm.show({ tuneID: '9', displayName: 'The Butterfly' });
    release();
    await generating;

    assert.ok(store.__saved['7'], 'the note is paid for, so it must be kept');
    assert.equal(vm.summary, null, "tune 9 must not display tune 7's note");
    assert.equal(vm.summaryGrounding, null);
    assert.equal(vm.summaryLoading, false);
});

await test('a successful generation shows its note and records the spend', async () => {
    const { vm, ai, store } = await loadDialog();
    await vm.show({ tuneID: '7', displayName: 'The Kesh', sourceUrl: 'https://example.test/7' });
    await vm.generateSummary();

    assert.equal(vm.summary.text, 'note for 7');
    assert.equal(vm.summaryGrounding, 'comments');
    assert.equal(vm.summaryCommentCount, 3);
    assert.ok(vm.groundingNote.includes('3'), 'the grounding note names the post count');
    assert.equal(store.__usage.length, 1, 'spend must be recorded once');
    assert.equal(ai.__calls.filter(c => c.fn === 'generate').length, 1);
});

await test('no key short-circuits without spending a request', async () => {
    const { vm, ai, store } = await loadDialog();
    store.__setApiKey('');

    await vm.show({ tuneID: '7', displayName: 'The Kesh' });
    await vm.generateSummary();

    assert.equal(vm.summaryError, 'described:no-key');
    assert.equal(ai.__calls.length, 0, 'a missing key must not reach the network');
    assert.equal(vm.summaryLoading, false);
});

await test('a second tap while in flight does not make a second paid call', async () => {
    const { vm, ai } = await loadDialog();

    const release = ai.__holdNextComments();
    await vm.show({ tuneID: '7', displayName: 'The Kesh' });
    const first = vm.generateSummary();
    const second = vm.generateSummary();
    release();
    await Promise.all([first, second]);

    assert.equal(ai.__calls.filter(c => c.fn === 'generate').length, 1,
        'the in-flight guard must collapse a double tap');
});

await rm(tmpDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
