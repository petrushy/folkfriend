// Actual MediaRecorder -> recorder -> IndexedDB -> clips -> Vue player.
// Generated tones only. Shorten the segment interval, not container chunks.
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
    .replace("from '@/js/recordingCheck.mjs'", "from '/recordingCheck.js'")
    .replace("from '@/js/mediaSession.mjs'", "from '/mediaSession.js'")
    .replace("import ffConfig from '@/ffConfig.js';", "const ffConfig = { FRONTEND_VERSION: 'e2e' };")
    .replace('export default {', 'const component = {');
player += `\ncomponent.template = ${JSON.stringify(template)}; export default component;`;
const store = read('src/services/sessionAudioStore.js')
    .replace("from 'idb-keyval'", "from '/idb.js'")
    .replace('SEGMENT_SECONDS = 180', 'SEGMENT_SECONDS = 3');
const recorder = read('src/services/sessionRecorder.js')
    .replace("from './sessionAudioStore.js'", "from '/store.js'")
    .replace("import eventBus from '@/eventBus.js';", 'const eventBus = window.testBus;')
    .replace("import micService from './mic.js';", `const micService = {
        get recordingStream() { return window.testStream; }, streamGeneration: 1,
        recordingChannelCount: 2, recordingMuted: false, recordingMuteSupported: false,
        setRecordingMuted() { return false; },
    };`);
const routes = new Map([
    ['/store.js', store], ['/recorder.js', recorder], ['/player.js', player],
    ['/recordingCheck.js', read('src/js/recordingCheck.mjs')],
    ['/mediaSession.js', read('src/js/mediaSession.mjs')],
    ['/vue.js', read('node_modules/vue/dist/vue.js')],
    ['/idb.js', read('node_modules/idb-keyval/dist/index.js')],
]);
const work = mkdtempSync(path.join(tmpdir(), 'ff-audio-chain-'));
const profile = path.join(work, 'profile');
const server = createServer((req, res) => {
    const body = routes.get(req.url.split('?')[0]);
    res.setHeader('Content-Type', body ? 'application/javascript' : 'text/html');
    res.end(body || '<!doctype html><html><body><script src="/vue.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(CHROME, [...BASE_ARGS, '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let ws, session, sequence = 0;
const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await fn()) return; await sleep(100); }
    throw new Error('Browser startup timed out');
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
try {
    await until(() => existsSync(path.join(profile, 'DevToolsActivePort')));
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
    await until(() => evaluate('!!window.Vue'));
    const results = await evaluate(`(async () => {
        Vue.config.ignoredElements = [/^v-/];
        window.testBus = new Vue();
        const store = await import('/store.js');
        const reports = [];
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        const waitFor = async fn => {
            for (let i = 0; i < 100; i++) { if (fn()) return; await delay(30); }
            throw new Error('Player did not reach expected state');
        };
        for (const mime of ['audio/webm;codecs=opus', 'audio/mp4']) {
            if (!MediaRecorder.isTypeSupported(mime)) continue;
            const id = mime.includes('webm') ? 'webm' : 'mp4';
            const ctx = new AudioContext(); await ctx.resume();
            const oscillator = ctx.createOscillator(), merger = ctx.createChannelMerger(2);
            const destination = ctx.createMediaStreamDestination();
            oscillator.connect(merger, 0, 0); merger.connect(destination); oscillator.start();
            window.testStream = destination.stream;
            const recording = (await import('/recorder.js?format=' + id)).default;
            await recording.begin(id); recording.mimeType = mime; await recording.ensureRecording();
            const original = [], handler = recording._recorder.ondataavailable;
            recording._recorder.ondataavailable = event => { original.push(event.data); handler(event); };
            await delay(7300); await recording.end(); oscillator.stop(); await ctx.close();
            const manifest = await store.readManifest(id);
            const clipReports = [];
            const decoder = new OfflineAudioContext(2, 1, 44100);
            for (const segment of manifest.segments) {
                const clip = await store.buildClip(id, segment.startSeconds,
                    segment.startSeconds + segment.durationSeconds, manifest);
                const pcm = await decoder.decodeAudioData(await clip.blob.arrayBuffer());
                clipReports.push({ bytes: clip.blob.size, seconds: pcm.duration });
            }
            const full = await store.buildClip(id, 0, manifest.totalSeconds, manifest, { requireComplete: true });
            const sourceBytes = new Uint8Array(await new Blob(original).arrayBuffer());
            const exportBytes = new Uint8Array(await full.blob.arrayBuffer());
            const identical = sourceBytes.length === exportBytes.length && sourceBytes.every((b,i) => b === exportBytes[i]);
            reports.push({ id, segments: manifest.segments.length, finalized: !!manifest.finalizedAt, identical, clipReports });
        }
        const component = (await import('/player.js')).default;
        const root = new Vue({ data: { id: reports[0].id }, render(h) {
            return h(component, { ref: 'player', props: { sessionId: this.id } });
        } }).$mount(); document.body.append(root.$el);
        const vm = root.$refs.player;
        await waitFor(() => vm.channelProbe?.oneSided);
        vm._prepareAudioGraph(); const element = vm.$refs.audio;
        const oldId = root.id, newId = oldId + '-copy';
        const first = await store.readManifest(oldId);
        await store.putManifest(newId, store.createManifest({ sessionId: newId, mimeType: first.mimeType }));
        for (const segment of first.segments) {
            await store.appendSegment(newId, await store.readSegment(oldId, segment.index), first.tracks[0]);
        }
        root.id = newId;
        await waitFor(() => vm.manifest?.sessionId === newId && vm.channelProbe?.oneSided);
        vm._prepareAudioGraph();
        const graph = { sameElement: element === vm.$refs.audio,
            attached: vm._sourceNode.mediaElement === vm.$refs.audio, corrected: vm.channelRepair };
        root.$destroy(); return { reports, graph };
    })()`);
    assert.ok(results.reports.length, 'at least one native container supported');
    for (const report of results.reports) {
        assert.ok(report.segments >= 2, JSON.stringify(report));
        assert.ok(report.finalized && report.identical, JSON.stringify(report));
        assert.ok(report.clipReports.every(c => c.seconds > 0), JSON.stringify(report));
    }
    assert.deepEqual(results.graph, { sameElement: true, attached: true, corrected: true });
    console.log('Native recording/storage/export and Vue graph lifecycle passed:', JSON.stringify(results));
} finally {
    if (ws) ws.close();
    chrome.kill(); server.close();
    await sleep(300); rmSync(work, { recursive: true, force: true });
}
