// Native MediaRecorder regression with generated audio; no microphone access.
// Run after building the app: npm run test:session-workspace
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, BASE_ARGS } from './chrome.mjs';

const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
assert.ok(existsSync(path.join(dist, 'index.html')), 'Build the app first');
const work = mkdtempSync(path.join(tmpdir(), 'ff-session-workspace-'));
const profile = path.join(work, 'profile');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const types = { '.js': 'application/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
    if (req.url === '/__seed') { res.end('<html><body>Test setup</body></html>'); return; }
    let file = path.join(dist, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(dist) || !existsSync(file) || path.extname(file) === '') file = path.join(dist, 'index.html');
    res.setHeader('Content-Type', types[path.extname(file)] || 'text/html');
    res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(CHROME, [...BASE_ARGS, '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let ws, session, seq = 0;
const pending = new Map();
const errors = [];
function send(method, params = {}, sessionId = session) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
}
async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
}
async function until(fn, label, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await fn()) return; await sleep(100); }
    throw new Error(`Timed out: ${label}`);
}
async function click(text) {
    assert.ok(await evaluate(`(() => { const b = [...document.querySelectorAll('button,a.v-btn,[role=menuitem]')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`), `Button exists: ${text}`);
}
const readSessions = `new Promise((resolve, reject) => { const r = indexedDB.open('keyval-store'); r.onsuccess = () => { const db = r.result; const q = db.transaction('keyval').objectStore('keyval').get('liveSessions'); q.onsuccess = () => { resolve(q.result); db.close(); }; q.onerror = reject; }; r.onerror = reject; })`;
async function records() { return evaluate(readSessions); }
async function openSaved(name) {
    await click('Past sessions');
    await until(() => evaluate(`!!document.querySelector('.v-dialog .v-autocomplete input')`), 'session picker');
    await evaluate(`document.querySelector('.v-dialog .v-autocomplete input').focus()`);
    await send('Input.insertText', { text: name });
    await until(() => evaluate(`!![...document.querySelectorAll('.v-menu__content .v-list-item')].find(e => e.textContent.includes(${JSON.stringify(name)}))`), 'search result');
    await evaluate(`[...document.querySelectorAll('.v-menu__content .v-list-item')].find(e => e.textContent.includes(${JSON.stringify(name)})).click()`);
    await until(() => evaluate(`!!document.querySelector('input[maxlength="160"]')`), 'session editor');
}
try {
    await until(async () => existsSync(path.join(profile, 'DevToolsActivePort')), 'Chrome startup');
    const port = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = ({ data }) => {
        const m = JSON.parse(data);
        if (m.id && pending.has(m.id)) {
            const p = pending.get(m.id); pending.delete(m.id);
            if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
        }
        if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
        if (m.method === 'Runtime.consoleAPICalled') {
            const text = m.params.args.map(a => a.value || '').join(' ');
            if (text.includes('[Vue warn]')) errors.push(text);
        }
    };
    const { targetInfos } = await send('Target.getTargets', {}, undefined);
    ({ sessionId: session } = await send('Target.attachToTarget', { targetId: targetInfos.find(t => t.type === 'page').targetId, flatten: true }, undefined));
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: work }, undefined);
    await send('Page.navigate', { url: `${origin}/__seed` });
    await until(() => evaluate(`location.pathname === '/__seed'`), 'seed origin');
    const source = readFileSync(new URL('../../src/services/sessionRecorder.js', import.meta.url), 'utf8');
    const start = source.indexOf('_onChunk(event, trackIndex) {');
    const chunkHandler = source.slice(start, source.indexOf('\n    // Writes the accumulated', start)).trim();
    const result = await evaluate(`(async () => {
const TIMESLICE_MS=1000,SEGMENT_SECONDS=180,now=()=>performance.now();
const state={${chunkHandler}, _chunkCursorSeconds:0,_lastChunkPerf:performance.now(),_trackIndexActive:0,_initBlob:null,_pending:[],_pendingBytes:0,_pendingStartSeconds:0};
const context=new AudioContext();await context.resume();const oscillator=context.createOscillator(),dest=context.createMediaStreamDestination();oscillator.connect(dest);oscillator.start();
const recorder=new MediaRecorder(dest.stream);const chunks=[],events=[];
recorder.ondataavailable=e=>{state._onChunk(e,0);chunks.push(e.data);events.push({clock:state._chunkCursorSeconds,bytes:e.data.size});};
state._lastChunkPerf=performance.now();recorder.start(1000);
await new Promise(r=>setTimeout(r,1200));const until=performance.now()+6000;while(performance.now()<until){}
await new Promise(r=>setTimeout(r,1500));await new Promise(r=>{recorder.onstop=r;recorder.stop();});
const decoded=await context.decodeAudioData(await new Blob(chunks).arrayBuffer());oscillator.stop();await context.close();return{manifestSeconds:state._chunkCursorSeconds,decodedSeconds:decoded.duration,events};
})()`);
    assert.ok(Math.abs(result.manifestSeconds - result.decodedSeconds) < 0.5,
        JSON.stringify(result));
    assert.ok(result.decodedSeconds > 8, 'the encoder continued during blocked event delivery');
    console.log('Delayed recorder delivery preserves duration:', JSON.stringify(result));

} catch (error) {
    if (ws && session) {
        console.error(await evaluate('document.body ? document.body.innerText.slice(0, 4000) : "No body"').catch(() => 'Page unavailable'));
        console.error(errors);
    }
    throw error;
} finally {
    if (ws) ws.close();
    chrome.kill();
    server.close();
    await sleep(300);
    rmSync(work, { recursive: true, force: true });
}
