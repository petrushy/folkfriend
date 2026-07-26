// Recovery scenario: the tune-data host is unreachable at startup, then comes
// back while the app is still running. The app must install the index and save
// the offline copy without the user restarting anything.
//
// The real CDN is replaced by a local origin whose reachability we can flip at
// will. A copy of the production build (dist-test) has its data URL rewritten to
// point at it — host remapping with a self-signed cert does not work here
// because .app is HSTS-preloaded, and CDP network emulation does not reach the
// Web Worker that actually fetches the index.
//
// Setup:
//   cp -R app/dist dist-test && sed -i '' 's|https://folkfriend-data.web.app/|http://127.0.0.1:8444/|' dist-test/js/*.js
//   npx serve dist-test -s -l 3001
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { CHROME, BASE_ARGS } from './chrome.mjs';

const APP = 'http://localhost:3001';  // dist-test: CDN URL repointed at the local stand-in
const DATA_PORT = 8444;
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RES_DIR = path.join(APP_DIR, 'public', 'res');
const work = mkdtempSync(path.join(tmpdir(), 'ff-rec-'));
const profile = path.join(work, 'profile');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- controllable stand-in for folkfriend-data.web.app -------------------

if (!existsSync(path.join(RES_DIR, 'folkfriend-non-user-data.json'))) {
    console.error(`missing ${RES_DIR}/folkfriend-non-user-data.json — run app/download_tune_data.sh`);
    process.exit(1);
}

const meta = readFileSync(path.join(RES_DIR, 'nud-meta.json'));
const index = readFileSync(path.join(RES_DIR, 'folkfriend-non-user-data.json'));

// Plain HTTP on purpose: the real host is folkfriend-data.web.app, and .app is
// HSTS-preloaded, so Chrome refuses a self-signed stand-in for it no matter
// what flags you pass. The test build has its data URL repointed here instead.
let mode = 'hang'; // 'hang' | 'serve'
let requests = 0;
const sockets = new Set();
const dataServer = http.createServer((req, res) => {
    requests++;
    console.log(`   [server] ${mode} <- ${req.url}`);
    if (mode === 'hang') return; // accept, then answer never — captive portal
    const body = req.url.startsWith('/nud-meta.json') ? meta : index;
    res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': body.length,
        'cache-control': 'no-store',
        // The real CDN serves these cross-origin; without this the fetch fails
        // with an opaque "Failed to fetch" that looks just like a dead network.
        'access-control-allow-origin': '*',
    });
    res.end(body);
});
dataServer.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
});
// A socket left over from 'hang' mode still has an unanswered request on it.
// HTTP/1.1 responses are ordered, so anything written for a later request on
// that same connection would sit queued behind the response that never came —
// the client would see a "recovered" server as still dead. Force fresh
// connections whenever the mode changes.
function setMode(next) {
    mode = next;
    for (const s of sockets) s.destroy();
    sockets.clear();
}
await new Promise(r => dataServer.listen(DATA_PORT, '127.0.0.1', r));

// --- CDP ------------------------------------------------------------------

let msgId = 0;
const pending = new Map();
let ws, pageSession;
const send = (method, params = {}, sessionId) => {
    const id = ++msgId;
    return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
};

const chrome = spawn(CHROME, [
    ...BASE_ARGS,
    '--remote-debugging-port=9600',
    `--user-data-dir=${profile}`,
    'about:blank',
], { stdio: 'ignore' });

async function getJSON(url) {
    for (let i = 0; i < 80; i++) {
        try {
            const r = await fetch(url);
            if (r.ok) return r.json();
        } catch (e) { /* not up yet */ }
        await sleep(250);
    }
    throw new Error('CDP not reachable');
}

async function evaluate(expression) {
    const r = await send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
    }, pageSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
}

async function waitFor(expression, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const v = await evaluate(`(() => { try { return ${expression}; } catch(e) { return false; } })()`);
            if (v) return Date.now() - t0;
        } catch (e) { /* navigating */ }
        await sleep(100);
    }
    throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
}

async function navigate(url) {
    await evaluate('window.__stale = true').catch(() => {});
    await send('Page.navigate', { url }, pageSession);
    await waitFor('window.__stale === undefined && !!document.querySelector("#app")', 30000, 'new document');
}

const INDEX_READY = `!!document.querySelector('.tuneProgress .Transparent')`;
const INDEX_UNAVAILABLE = `!!document.querySelector('.indexErrorMsg')`;
const IDB_MANIFEST = `
(async () => {
    const req = indexedDB.open('keyval-store');
    const db = await new Promise(res => { req.onsuccess = () => res(req.result); });
    if (!db.objectStoreNames.contains('keyval')) return null;
    const st = db.transaction('keyval', 'readonly').objectStore('keyval');
    return await new Promise(res => { const r = st.get('ffIndexManifest'); r.onsuccess = () => res(r.result || null); });
})()`;

try {
    const version = await getJSON('http://localhost:9600/json/version');
    console.log(`\nChrome: ${version.Browser}`);
    console.log(`Tune-data origin: local stand-in on :${DATA_PORT} (starts unreachable)\n`);
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = async ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            const { res, rej } = pending.get(m.id);
            pending.delete(m.id);
            m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
            return;
        }
        if (m.method === 'Target.attachedToTarget') {
            const sid = m.params.sessionId;
            const t = m.params.targetInfo;
            if (process.env.FF_VERBOSE) console.log(`   [attach] ${t.type} ${t.url.slice(0, 70)}`);
            await send('Runtime.enable', {}, sid).catch(() => {});
            // Dedicated workers only surface via auto-attach from their page.
            await send('Target.setAutoAttach',
                { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid).catch(() => {});
            await send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
            return;
        }
        if (process.env.FF_VERBOSE) {
            if (m.method === 'Runtime.consoleAPICalled') {
                console.log('   [c]', m.params.type, m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 220));
            }
            if (m.method === 'Runtime.exceptionThrown') {
                console.log('   [X]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 400));
            }
        }
    };
    await send('Target.setDiscoverTargets', { discover: true });
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { targetInfos } = await send('Target.getTargets');
    const page = targetInfos.find(t => t.type === 'page');
    ({ sessionId: pageSession } = await send('Target.attachToTarget', {
        targetId: page.targetId, flatten: true,
    }));
    await send('Page.enable', {}, pageSession);
    await send('Runtime.enable', {}, pageSession);
    await send('Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, pageSession);

    console.log('1. Start with the tune-data host hanging (captive portal)');
    await send('Page.navigate', { url: APP }, pageSession);
    await waitFor('!!document.querySelector("#app")', 30000, 'app booted');
    let ms = await waitFor(INDEX_UNAVAILABLE, 60000, 'unavailable');
    check('app gives up on the stalled host quickly', ms < 15000, `${ms} ms`);
    check('nothing bogus was persisted', (await evaluate(IDB_MANIFEST)) === null);
    check('the app did try to reach the host', requests > 0, `${requests} request(s) received`);

    console.log('\n2. Host becomes reachable, app is still open');
    setMode('serve');
    // The browser's own online/offline state never changed here (it was a
    // captive portal, not a disconnection), so this mirrors the user tapping
    // "Save offline copy" or the next 'online' event firing.
    await evaluate(`(() => { window.dispatchEvent(new Event('online')); return true; })()`);
    try {
        ms = await waitFor(INDEX_READY, 45000, 'index ready after recovery');
    } finally {
        console.log(`   [server] total requests: ${requests}`);
    }
    check('index installs automatically once the host answers', true, `${(ms / 1000).toFixed(1)} s`);

    const manifest = await evaluate(IDB_MANIFEST);
    check('offline copy saved during recovery', !!manifest && manifest.bytes > 1000000,
        manifest ? `v${manifest.v}, ${(manifest.bytes / 1048576).toFixed(1)} MB` : 'no manifest');

    console.log('\n3. Host goes away again; restart the app');
    setMode('hang');
    await navigate(APP);
    ms = await waitFor(INDEX_READY, 60000, 'index ready from the saved copy');
    check('saved copy is used, host is never needed', true, `${ms} ms`);
} catch (e) {
    console.error('\nFATAL:', e.message);
    results.push({ name: 'harness', ok: false, detail: e.message });
} finally {
    chrome.kill();
    dataServer.close();
    await sleep(500);
    try { rmSync(work, { recursive: true, force: true }); } catch (e) { /* exiting */ }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
process.exit(failed.length ? 1 : 0);
