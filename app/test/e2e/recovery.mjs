// Recovery scenario: the tune-data host is unreachable at startup, then comes
// back while the app is still running. The app must install the index and save
// the offline copy without the user restarting anything.
//
// The real CDN is replaced by a local origin whose reachability we can flip at
// will. A copy of the production build has its data URL rewritten to point at
// it — host remapping with a self-signed cert does not work here because .app
// is HSTS-preloaded, and CDP network emulation does not reach the Web Worker
// that actually fetches the index.
//
// No setup: this builds that copy and serves it itself, so it runs from
// `npm run test:e2e` like the others. It needs two things to exist —
// `app/dist` (run `npm run build`) and a copy of the tune index, taken from
// $FF_INDEX_JSON or app/public/res/. CI moves the index aside before building
// rather than deleting it, precisely so this test can still find it.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, cpSync, readdirSync,
         statSync, writeFileSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { CHROME, BASE_ARGS } from './chrome.mjs';

const APP_PORT = 3001;
const APP = `http://localhost:${APP_PORT}`;  // CDN URL repointed at the local stand-in
const DATA_PORT = 8444;
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_DIR = path.join(APP_DIR, 'dist');
// CI moves the tune data out of public/res/ before building, so that it does
// not bloat the deployed bundle, and points $FF_RES_DIR at where it went.
const RES_DIR = process.env.FF_RES_DIR || path.join(APP_DIR, 'public', 'res');
const CDN_ORIGIN = 'https://folkfriend-data.web.app/';
const work = mkdtempSync(path.join(tmpdir(), 'ff-rec-'));
const profile = path.join(work, 'profile');
const appRoot = path.join(work, 'dist-test');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- controllable stand-in for folkfriend-data.web.app -------------------

if (!existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.error(`missing ${DIST_DIR}/index.html — run \`npm run build\` first`);
    process.exit(1);
}

// The app fetches datasets.json and then one file per dataset. Serve the real
// per-dataset files when they are on disk; otherwise fall back to the legacy
// merged file served as a single 'thesession' dataset, so this test still runs
// against a checkout that has only fetched that.
function findDataset(id) {
    for (const dir of [RES_DIR, path.join(DIST_DIR, 'res')]) {
        const p = path.join(dir, `${id}.json`);
        if (existsSync(p)) return p;
    }
    return null;
}

const DATASET_IDS = ['thesession', 'folkwiki', 'norbeck'];
const bodies = {};          // filename -> Buffer
const datasetEntries = [];  // datasets.json entries

for (const id of DATASET_IDS) {
    const file = findDataset(id);
    if (!file) continue;
    const body = readFileSync(file);
    bodies[`${id}.json`] = body;
    datasetEntries.push({ id, filename: `${id}.json`, v: 1, date: '2026-01-01',
        size: body.length });
}

if (datasetEntries.length === 0) {
    const fallback = process.env.FF_INDEX_JSON
        || path.join(RES_DIR, 'folkfriend-non-user-data.json');
    if (!existsSync(fallback)) {
        console.error(`no dataset files and no ${fallback} — run `
            + 'app/download_tune_data.sh, or point $FF_INDEX_JSON at a copy');
        process.exit(1);
    }
    const body = readFileSync(fallback);
    bodies['thesession.json'] = body;
    datasetEntries.push({ id: 'thesession', filename: 'thesession.json', v: 1,
        date: '2026-01-01', size: body.length });
    console.log('   [server] no per-dataset files; serving the merged index '
        + 'as a single thesession dataset');
}

// The dataset every assertion is made about — the largest one served, which is
// the one the app downloads first.
const PRIMARY = datasetEntries
    .slice()
    .sort((a, b) => b.size - a.size)[0].id;

const manifestBody = () => Buffer.from(JSON.stringify({
    manifestVersion: 1, generated: '2026-01-01', datasets: datasetEntries,
}));

// --- the app under test: dist with its data origin repointed here ---------

// Rewriting file CONTENT only, never file names: the service worker's precache
// manifest keys on the hashed filenames webpack emitted, so the app still finds
// every asset it was built expecting.
function repointDataOrigin(dir) {
    let rewritten = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            rewritten += repointDataOrigin(full);
        } else if (entry.name.endsWith('.js')) {
            const before = readFileSync(full, 'utf8');
            if (!before.includes(CDN_ORIGIN)) continue;
            writeFileSync(full, before.split(CDN_ORIGIN).join(`http://127.0.0.1:${DATA_PORT}/`));
            rewritten++;
        }
    }
    return rewritten;
}

cpSync(DIST_DIR, appRoot, { recursive: true });
const rewritten = repointDataOrigin(appRoot);
if (rewritten === 0) {
    console.error(`no file under ${DIST_DIR} references ${CDN_ORIGIN} — this test would `
        + 'silently exercise the real CDN instead of the stand-in');
    process.exit(1);
}

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject', '.map': 'application/json',
    '.txt': 'text/plain', '.webmanifest': 'application/manifest+json',
};

// Mirrors Firebase Hosting: static file if it exists, index.html otherwise.
const appServer = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    let file = path.join(appRoot, rel);
    if (!file.startsWith(appRoot) || !existsSync(file) || statSync(file).isDirectory()) {
        file = path.join(appRoot, 'index.html');
    }
    res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        // The service worker must be re-evaluated on each load, and a stale
        // 304 for the app shell would hide exactly the behaviour under test.
        'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
});
await new Promise(r => appServer.listen(APP_PORT, '127.0.0.1', r));

// Plain HTTP on purpose: the real host is folkfriend-data.web.app, and .app is
// HSTS-preloaded, so Chrome refuses a self-signed stand-in for it no matter
// what flags you pass. The test build has its data URL repointed here instead.
// 'hang'    — accepts the connection and never answers (captive portal)
// 'serve'   — the real dataset
// 'garbage' — announces a NEWER version and then serves a truncated body. This
//             is the update that must never be allowed to replace a working
//             offline copy; before the install path validated before writing,
//             it did exactly that and the damage only showed up at the next
//             cold start, offline.
let mode = 'hang';
let requests = 0;
const NEXT_VERSION = 2;
const sockets = new Set();

// In 'garbage' mode the manifest announces a newer version of every dataset and
// the bodies are truncated — valid-looking 200s that are not tune indexes. In
// 'partial' mode only ONE dataset is poisoned, which is the more realistic and
// more dangerous case: the install half-succeeds, so the app looks fine.
const POISONED = datasetEntries.length > 1 ? datasetEntries[1].id : PRIMARY;

function bodyFor(url) {
    const name = url.split('?')[0].replace(/^\//, '');

    if (name === 'datasets.json') {
        if (mode === 'garbage' || mode === 'partial') {
            return Buffer.from(JSON.stringify({
                manifestVersion: 1,
                generated: '2099-01-01',
                datasets: datasetEntries.map(e => ({
                    ...e, v: NEXT_VERSION, date: '2099-01-01',
                })),
            }));
        }
        return manifestBody();
    }

    const real = bodies[name];
    if (!real) return null;

    const poison = mode === 'garbage'
        || (mode === 'partial' && name === `${POISONED}.json`);
    return poison ? real.subarray(0, Math.floor(real.length / 2)) : real;
}

const dataServer = http.createServer((req, res) => {
    requests++;
    console.log(`   [server] ${mode} <- ${req.url}`);
    if (mode === 'hang') return; // accept, then answer never — captive portal
    const body = bodyFor(req.url);
    if (!body) {
        res.writeHead(404, { 'access-control-allow-origin': '*' });
        res.end();
        return;
    }
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

// waitFor wraps its expression in a SYNCHRONOUS arrow for the try/catch, which
// does not await a promise the expression returns. Anything async — every
// IndexedDB probe here — must use this instead.
async function waitForAsync(expression, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            if (await evaluate(expression)) return Date.now() - t0;
        } catch (e) { /* navigating */ }
        await sleep(200);
    }
    throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
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
// The manifest for one dataset. Keys are namespaced per dataset now.
const idbManifest = id => `
(async () => {
    const req = indexedDB.open('keyval-store');
    const db = await new Promise(res => { req.onsuccess = () => res(req.result); });
    if (!db.objectStoreNames.contains('keyval')) return null;
    const st = db.transaction('keyval', 'readonly').objectStore('keyval');
    return await new Promise(res => {
        const r = st.get('ffIndexManifest:${id}');
        r.onsuccess = () => res(r.result || null);
    });
})()`;
const IDB_MANIFEST = idbManifest(PRIMARY);

// INDEX_READY is not "the install finished". The app becomes usable as soon as
// the FIRST dataset loads into WASM — that is the whole point of partial
// success — so waiting on it and then reloading would kill the remaining
// downloads. Wait for the copies to actually be on disk.
const idbHasDatasets = ids => `
(async () => {
    const req = indexedDB.open('keyval-store');
    const db = await new Promise(res => { req.onsuccess = () => res(req.result); });
    if (!db.objectStoreNames.contains('keyval')) return false;
    const st = db.transaction('keyval', 'readonly').objectStore('keyval');
    const keys = await new Promise(res => { const r = st.getAllKeys(); r.onsuccess = () => res(r.result); });
    return ${JSON.stringify(ids)}.every(id => keys.includes('ffIndexManifest:' + id));
})()`;
const INSTALLED_IDS = datasetEntries
    .filter(e => e.id === 'thesession' || e.id === 'folkwiki')
    .map(e => e.id);

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
    // Let every selected dataset finish before reloading the page.
    await waitForAsync(idbHasDatasets(INSTALLED_IDS), 120000,
        `all of ${INSTALLED_IDS.join(', ')} saved`);
    check('every selected dataset is saved, not just the first', true,
        INSTALLED_IDS.join(', '));

    const manifest = await evaluate(IDB_MANIFEST);
    check('offline copy saved during recovery', !!manifest && manifest.bytes > 1000000,
        manifest ? `v${manifest.v}, ${(manifest.bytes / 1048576).toFixed(1)} MB` : 'no manifest');
    // This is the known-good copy every later step is measured against.
    const savedVersion = manifest && manifest.v;
    const savedBytes = manifest && manifest.bytes;

    console.log('\n3. A newer version is announced, and the download is rubbish');
    // The field failure this guards: the update is committed to IndexedDB
    // before anything establishes it is a usable index, the old index stays
    // loaded so the session looks perfectly healthy, and the user finds out at
    // the next cold start — in a pub, offline, with no way to recover.
    setMode('garbage');
    const before = requests;
    await navigate(APP);
    await waitFor(INDEX_READY, 60000, 'index ready from the saved copy');
    // Wait for the update check to have asked for both files and given up.
    for (let i = 0; i < 100 && requests < before + 2; i++) await sleep(200);
    await sleep(2000);

    const afterBad = await evaluate(IDB_MANIFEST);
    check('a bad update does not replace the saved copy',
        !!afterBad && afterBad.v === savedVersion && afterBad.bytes === savedBytes,
        afterBad ? `v${afterBad.v}, ${(afterBad.bytes / 1048576).toFixed(1)} MB` : 'NO OFFLINE COPY');
    check('the app stays usable after the bad update', await evaluate(INDEX_READY));

    // The failure mode the multi-dataset split introduces: an install where
    // SOME datasets succeed. The ones that failed must keep their previous
    // copies, and the app must stay usable rather than reporting itself broken.
    if (datasetEntries.length > 1) {
        console.log(`\n3b. A partial update: ${PRIMARY} is fine, ${POISONED} is rubbish`);
        const goodBefore = await evaluate(idbManifest(PRIMARY));
        const poisonedBefore = await evaluate(idbManifest(POISONED));
        setMode('partial');
        const beforeReqs = requests;
        await navigate(APP);
        await waitFor(INDEX_READY, 60000, 'index ready from the saved copies');
        for (let i = 0; i < 100 && requests < beforeReqs + 2; i++) await sleep(200);
        await sleep(3000);

        const poisonedAfter = await evaluate(idbManifest(POISONED));
        check(`${POISONED} keeps its previous copy after a bad download`,
            !!poisonedAfter && !!poisonedBefore
                && poisonedAfter.bytes === poisonedBefore.bytes,
            poisonedAfter ? `v${poisonedAfter.v}, ${poisonedAfter.bytes} chars`
                : 'NO OFFLINE COPY');
        const goodAfter = await evaluate(idbManifest(PRIMARY));
        check(`${PRIMARY} is unaffected by its sibling failing`,
            !!goodAfter && !!goodBefore,
            goodAfter ? `v${goodAfter.v}` : 'NO OFFLINE COPY');
        check('the app stays usable through a partial failure',
            await evaluate(INDEX_READY));
    }

    console.log('\n4. Host goes away entirely; cold start offline');
    // Whatever survived step 3b is the known-good copy now. Step 3b serves a
    // GOOD primary at v2, so this is deliberately read here rather than
    // compared against step 2's version.
    const expected = await evaluate(IDB_MANIFEST);
    setMode('hang');
    await navigate(APP);
    ms = await waitFor(INDEX_READY, 60000, 'index ready from the saved copy');
    check('saved copy is used, host is never needed', true, `${ms} ms`);
    const finalManifest = await evaluate(IDB_MANIFEST);
    check('the offline copy is intact and unchanged by the dead host',
        !!finalManifest && !!expected
            && finalManifest.v === expected.v
            && finalManifest.bytes === expected.bytes,
        finalManifest ? `v${finalManifest.v}, ${finalManifest.bytes} chars` : 'none');
} catch (e) {
    console.error('\nFATAL:', e.message);
    results.push({ name: 'harness', ok: false, detail: e.message });
} finally {
    chrome.kill();
    dataServer.close();
    appServer.close();
    await sleep(500);
    try { rmSync(work, { recursive: true, force: true }); } catch (e) { /* exiting */ }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
process.exit(failed.length ? 1 : 0);
