// The playback speed control, in real Chrome with the real Vue and Vuetify.
//
// Run with:  node test/e2e/playback-speed.mjs
//
// The unit harness drives the player's methods with no Vue runtime, so it can
// only check the MODEL. The bug this exists for lived in the gap between the
// model and the widget: a refused speed set and reset playbackRate within one
// update, so from 100% the bound value never changed, Vuetify never re-read
// it, and the thumb stayed on the speed that had been refused while the label
// and the audio said 100%. Only a real VSlider can show that.
//
// The refusal is injected on the element (Chrome itself accepts 40%), and the
// slider is driven with real key events over CDP, not by calling the handler.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, BASE_ARGS } from './chrome.mjs';

const app = fileURLToPath(new URL('../../', import.meta.url));
const read = name => readFileSync(path.join(app, name), 'utf8');
const sfc = read('src/components/SessionAudioPlayer.vue');
const template = sfc.slice(sfc.indexOf('<template>') + 10, sfc.lastIndexOf('</template>'));
let player = sfc.split('<script>')[1].split('</script>')[0]
    .replace(/import \{[^}]+\} from '@mdi\/js';/, "const mdiPlay='',mdiPause='',mdiRewind15='',mdiFastForward15='';")
    .replace("import eventBus from '@/eventBus.js';", 'const eventBus = window.testBus;')
    .replace("import { formatSecondsAsDuration } from '@/js/sessionAnalysis.js';", 'const formatSecondsAsDuration = s => String(Math.round(s));')
    .replace("from '@/services/sessionAudioStore.js'", "from '/store.js'")
    .replace('export default {', 'const component = {');
player += `\ncomponent.template = ${JSON.stringify(template)}; export default component;`;
// Enough of the store for the player to render its controls. No audio is ever
// loaded: the speed is applied to the element whether or not it holds a clip.
const store = `
export async function playbackReadManifest(id) {
    return { sessionId: id, totalSeconds: 600, bytes: 1000, mimeType: 'audio/mp4',
        tracks: [{ index: 0, startSeconds: 0, durationSeconds: 600 }],
        segments: [{ index: 0, trackIndex: 0, startSeconds: 0, durationSeconds: 600 }] };
}
export async function buildClip() { return null; }
export function trackRanges() { return []; }
export function formatBytes(n) { return String(n); }
export function fileExtensionFor() { return 'm4a'; }`;
const routes = new Map([
    ['/store.js', store], ['/player.js', player],
    ['/vue.js', read('node_modules/vue/dist/vue.js')],
    ['/vuetify.js', read('node_modules/vuetify/dist/vuetify.js')],
]);
const work = mkdtempSync(path.join(tmpdir(), 'ff-playback-speed-'));
const profile = path.join(work, 'profile');
const server = createServer((req, res) => {
    const body = routes.get(req.url.split('?')[0]);
    res.setHeader('Content-Type', body ? 'application/javascript' : 'text/html');
    res.end(body || '<!doctype html><html><body><div id="app"></div>' +
        '<script src="/vue.js"></script><script src="/vuetify.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(CHROME, [...BASE_ARGS, '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let ws, session, sequence = 0;
const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, what = 'condition') {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await fn()) return; await sleep(100); }
    throw new Error(`Timed out waiting for ${what}`);
}
function send(method, params = {}, sessionId = session) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
}
async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
}
// A real key press on whatever has focus. Vuetify's slider reads keyCode,
// which a synthetic KeyboardEvent does not reliably carry.
async function press(key, code) {
    for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code });
    }
}
// Focus the slider's thumb afresh each time: a refusal remounts the slider,
// so the element focused before it no longer exists.
const focusThumb = () => evaluate(`(() => {
    const thumb = document.querySelector('.playerSpeed [role="slider"]');
    thumb.focus(); return document.activeElement === thumb;
})()`);
const state = () => evaluate(`(() => {
    const vm = window.player;
    return {
        thumb: document.querySelector('.playerSpeed [role="slider"]').getAttribute('aria-valuenow'),
        label: document.querySelector('.playerSpeedLabel').textContent.trim(),
        audio: vm.$refs.audio.playbackRate,
        preservesPitch: vm.$refs.audio.preservesPitch,
        error: vm.error,
        errorShown: [...document.querySelectorAll('.v-alert')].map(a => a.textContent.trim()).join(' | '),
    };
})()`);

try {
    await until(() => existsSync(path.join(profile, 'DevToolsActivePort')), 'Chrome to start');
    const port = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = ({ data }) => {
        const message = JSON.parse(data), waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
    };
    const { targetInfos } = await send('Target.getTargets', {}, undefined);
    ({ sessionId: session } = await send('Target.attachToTarget', {
        targetId: targetInfos.find(t => t.type === 'page').targetId, flatten: true,
    }, undefined));
    await send('Page.navigate', { url: origin });
    await until(() => evaluate('!!(window.Vue && window.Vuetify)'), 'Vue and Vuetify');

    await evaluate(`(async () => {
        window.testBus = new Vue();
        if (!Vue.prototype.$vuetify) Vue.use(Vuetify);
        const component = (await import('/player.js')).default;
        const root = new Vue({
            vuetify: new Vuetify(),
            render(h) { return h('v-app', [h(component, { ref: 'player', props: { sessionId: 's1' } })]); },
        }).$mount('#app');
        window.player = root.$refs.player;
        // The one speed this "engine" will not play. Chrome accepts 40%, so
        // the refusal is put on the element; the widget is what is under test.
        const audio = window.player.$refs.audio;
        const proto = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
        Object.defineProperty(audio, 'playbackRate', {
            configurable: true,
            get() { return proto.get.call(this); },
            set(v) {
                if (Math.abs(v - 0.4) < 1e-9) throw new DOMException('The operation is not supported.', 'NotSupportedError');
                proto.set.call(this, v);
            },
        });
    })()`);
    await until(() => evaluate(`!!document.querySelector('.playerSpeed [role="slider"]')`), 'the speed slider');

    const initial = await state();
    assert.equal(initial.thumb, '100');
    assert.equal(initial.label, 'Speed 100%');

    // 1. Home takes the slider to its minimum, 40%, which is refused.
    assert.ok(await focusThumb(), 'the slider thumb can take focus');
    await press('Home', 36);
    await until(async () => (await state()).error !== '', 'the refusal to be reported');
    const refused = await state();
    assert.equal(refused.audio, 1, 'nothing plays at the refused speed');
    assert.equal(refused.label, 'Speed 100%');
    assert.equal(refused.thumb, '100',
        `the thumb must not sit on a speed nothing is playing (${JSON.stringify(refused)})`);
    assert.match(refused.errorShown, /cannot play at 40% speed/);

    // 2. A speed that works takes the refusal message down.
    assert.ok(await focusThumb(), 'the remounted thumb can take focus');
    await press('ArrowLeft', 37);
    await until(async () => (await state()).audio !== 1, 'the new speed to apply');
    const recovered = await state();
    assert.equal(recovered.audio, 0.95);
    assert.equal(recovered.thumb, '95');
    assert.equal(recovered.label, 'Speed 95%');
    assert.equal(recovered.preservesPitch, true);
    assert.equal(recovered.error, '');
    assert.doesNotMatch(recovered.errorShown, /cannot play/);

    console.log('Playback speed control passed:', JSON.stringify({ initial, refused, recovered }));
} finally {
    if (ws) ws.close();
    chrome.kill(); server.close();
    await sleep(300); rmSync(work, { recursive: true, force: true });
}
