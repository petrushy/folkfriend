// End-to-end check of FolkFriend's offline tune-index behaviour, driven over
// the Chrome DevTools Protocol (no extra npm deps).
//
// Requires the PRODUCTION build served at http://localhost:3000 (it needs the
// service worker):   cd app && npx serve dist -s -l 3000
//
// Covers the case where an offline copy EXISTS. The "no offline copy + host
// unreachable" and recovery cases live in e2e-unreachable.mjs and
// e2e-recovery.mjs — page-scoped CDP network emulation does not reach the Web
// Worker that fetches the index, so those use host remapping instead.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const APP = 'http://localhost:3000';
const profile = mkdtempSync(path.join(tmpdir(), 'ff-cdp-'));

const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu',
    // Chrome's HTTP disk cache would otherwise serve the 40 MB index even when
    // offline, masking the very path under test.
    '--disk-cache-size=1',
    'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url) {
    for (let i = 0; i < 80; i++) {
        try {
            const r = await fetch(url);
            if (r.ok) return r.json();
        } catch (e) { /* not up yet */ }
        await sleep(250);
    }
    throw new Error(`CDP not reachable: ${url}`);
}

// --- CDP client with browser-level auto-attach ---------------------------

let msgId = 0;
const pending = new Map();
const sessions = new Set();
let offline = false;
let ws;

function send(method, params = {}, sessionId) {
    const id = ++msgId;
    return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
}

async function applyNetworkState(sessionId) {
    await send('Network.enable', {}, sessionId).catch(() => {});
    await send('Network.emulateNetworkConditions', {
        offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }, sessionId).catch(() => {});
}

async function setOffline(value) {
    offline = value;
    await Promise.all([...sessions].map(applyNetworkState));
}

async function connectBrowser() {
    const version = await getJSON(`http://localhost:${PORT}/json/version`);
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = async ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { res, rej } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
            return;
        }
        if (msg.method === 'Target.attachedToTarget') {
            const sid = msg.params.sessionId;
            sessions.add(sid);
            // New page/worker/service-worker: inherit the current network state
            // before it gets a chance to issue any request.
            await applyNetworkState(sid);
            await send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
        }
        if (msg.method === 'Target.detachedFromTarget') {
            sessions.delete(msg.params.sessionId);
        }
    };
    await send('Target.setDiscoverTargets', { discover: true });
    await send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    });
    return version;
}

let pageSession = null;
async function attachToPage() {
    const { targetInfos } = await send('Target.getTargets');
    const page = targetInfos.find(t => t.type === 'page');
    const { sessionId } = await send('Target.attachToTarget', {
        targetId: page.targetId, flatten: true,
    });
    sessions.add(sessionId);
    pageSession = sessionId;
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await applyNetworkState(sessionId);
}

async function evaluate(expression) {
    const r = await send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
    }, pageSession);
    if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    }
    return r.result.value;
}

async function waitFor(expression, timeoutMs, label) {
    const t0 = Date.now();
    let lastError = null;
    while (Date.now() - t0 < timeoutMs) {
        try {
            const v = await evaluate(`(() => { try { return ${expression}; } catch(e) { return false; } })()`);
            if (v) return Date.now() - t0;
        } catch (e) { lastError = e; }
        await sleep(100);
    }
    throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

// Navigate and wait for the NEW document — the old DOM lingers briefly and
// would otherwise satisfy the readiness selectors.
async function navigate(url) {
    await evaluate('window.__stale = true').catch(() => {});
    await send('Page.navigate', { url }, pageSession);
    await waitFor('window.__stale === undefined && !!document.querySelector("#app")',
        30000, 'new document');
}

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const IDB_STATE = `
(async () => {
    const req = indexedDB.open('keyval-store');
    const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    if (!db.objectStoreNames.contains('keyval')) return { keys: [] };
    const tx = db.transaction('keyval', 'readonly').objectStore('keyval');
    const keys = await new Promise(res => { const r = tx.getAllKeys(); r.onsuccess = () => res(r.result); });
    const manifest = await new Promise(res => { const r = tx.get('ffIndexManifest'); r.onsuccess = () => res(r.result); });
    const rawLength = await new Promise(res => { const r = tx.get('ffIndexRaw'); r.onsuccess = () => res(r.result ? r.result.length : 0); });
    return { keys, manifest, rawLength };
})()`;

const WIPE_INDEX = `
(async () => {
    const req = indexedDB.open('keyval-store');
    const db = await new Promise(res => { req.onsuccess = () => res(req.result); });
    const tx = db.transaction('keyval', 'readwrite');
    const st = tx.objectStore('keyval');
    st.delete('ffIndexManifest'); st.delete('ffIndexRaw'); st.delete('tuneIndex');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    const t2 = db.transaction('keyval', 'readonly').objectStore('keyval');
    return await new Promise(res => { const r = t2.getAllKeys(); r.onsuccess = () => res(r.result); });
})()`;

// Search view markers: the progress bar gains "Transparent" when the index is
// ready; .indexErrorMsg appears when it is definitively unavailable.
const INDEX_READY = `!!document.querySelector('.tuneProgress .Transparent')`;
const INDEX_UNAVAILABLE = `!!document.querySelector('.indexErrorMsg')`;
const OPEN_TUNE = `(() => { window.history.pushState({}, '', '/tune?tuneID=15326'); window.dispatchEvent(new PopStateEvent('popstate')); return true; })()`;
const TUNE_SETTLED = `!!document.querySelector('.expansionPanel') || /saved for offline use|Could not load tune|No tune loaded/.test(document.body.innerText)`;

try {
    const version = await connectBrowser();
    console.log(`\nChrome: ${version.Browser}\n`);
    await attachToPage();

    // ---- 1. Cold start, online ------------------------------------------
    console.log('1. First run, online');
    await send('Page.navigate', { url: APP }, pageSession);
    await waitFor('!!document.querySelector("#app")', 30000, 'app booted');
    let ms = await waitFor(INDEX_READY, 300000, 'index ready');
    check('index becomes ready on first run', true, `${(ms / 1000).toFixed(1)} s (incl. 40 MB download)`);

    const idb = await evaluate(IDB_STATE);
    check('offline copy written to IndexedDB',
        !!idb.manifest && idb.rawLength > 1000000,
        idb.manifest ? `v${idb.manifest.v}, ${(idb.rawLength / 1048576).toFixed(1)} MB` : 'no manifest');
    check('no duplicate legacy copy left behind',
        !idb.keys.includes('tuneIndex'),
        `keys: ${idb.keys.join(', ')}`);

    // A freshly installed service worker only takes control on the next load.
    await waitFor(`navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))`,
        30000, 'service worker active');
    await navigate(APP);
    await waitFor(`navigator.serviceWorker.controller !== null`, 30000, 'sw controlling');
    await waitFor(INDEX_READY, 60000, 'index ready on second load');
    check('service worker controls the page', true);

    const swCaches = await evaluate(`caches.keys()`);
    check('42 MB duplicate service-worker cache is gone',
        !swCaches.includes('folkfriend-tune-data'),
        `caches: ${swCaches.join(', ')}`);

    // ---- 2. Reload fully offline (the aeroplane case) --------------------
    console.log('\n2. Reload with the network fully offline');
    await setOffline(true);
    await navigate(APP);
    ms = await waitFor(INDEX_READY, 60000, 'index ready from cache while offline');
    check('index loads from the offline copy with no network', true, `${ms} ms`);

    // ---- 3. Opening tunes offline ---------------------------------------
    console.log('\n3. Open a tune while offline (offline copy present)');
    let t0 = Date.now();
    await evaluate(OPEN_TUNE);
    await waitFor(`!!document.querySelector('.expansionPanel')`, 20000, 'tune rendered');
    check('tune renders promptly', Date.now() - t0 < 3000, `${Date.now() - t0} ms`);


    // ---- 4. Upgrading from the pre-schema-2 layout -----------------------
    // Existing installs hold the index as one structured-cloned object under
    // 'tuneIndex'. Upgrading must NOT strand them with a 40 MB re-download they
    // can only do online.
    const SEED_LEGACY = v => `
    (async () => {
        const req = indexedDB.open('keyval-store');
        const db = await new Promise(res => { req.onsuccess = () => res(req.result); });
        const raw = await new Promise(res => {
            const r = db.transaction('keyval', 'readonly').objectStore('keyval').get('ffIndexRaw');
            r.onsuccess = () => res(r.result);
        });
        if (!raw) return 'no raw payload to convert';
        const parsed = JSON.parse(raw);
        const abcStrings = {}, sourceUrls = {};
        for (const id in parsed.settings) {
            const st = parsed.settings[id];
            abcStrings[id] = st.abc; st.abc = '';
            if (st.source_url) { sourceUrls[id] = st.source_url; delete st.source_url; }
        }
        const tx = db.transaction('keyval', 'readwrite');
        const store = tx.objectStore('keyval');
        store.put({ indexData: parsed, abcStrings, sourceUrls }, 'tuneIndex');
        store.put({ v: ${v}, date: '2020-01-01' }, 'tuneIndexMetadata');
        store.delete('ffIndexManifest');
        store.delete('ffIndexRaw');
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
        return 'ok';
    })()`;

    console.log('\n4. Existing install with the old (schema 1) offline copy, offline');
    await setOffline(false);
    const currentVersion = (await evaluate(IDB_STATE)).manifest.v;
    // Seed at the CURRENT version so no background update fires — this isolates
    // "can the legacy copy be read" from "does an update replace it".
    check('seeded a schema-1 offline copy', await evaluate(SEED_LEGACY(currentVersion)) === 'ok');

    await setOffline(true);
    await navigate(APP);
    ms = await waitFor(INDEX_READY, 60000, 'index ready from the legacy copy');
    check('legacy offline copy loads — no forced re-download', true, `${ms} ms`);

    t0 = Date.now();
    await evaluate(OPEN_TUNE);
    await waitFor(`!!document.querySelector('.expansionPanel')`, 20000, 'tune rendered');
    check('tunes and their ABC come from the legacy copy', Date.now() - t0 < 3000,
        `${Date.now() - t0} ms`);
    const stillLegacy = await evaluate(IDB_STATE);
    check('legacy copy is not discarded', stillLegacy.keys.includes('tuneIndex'),
        `keys: ${stillLegacy.keys.join(', ')}`);

    // ---- 5. Legacy copy is migrated on the next version bump -------------
    console.log('\n5. Legacy copy migrates to the new format when an update lands');
    await setOffline(false);
    // The legacy copy from scenario 4 is still in place; just age its version.
    check('aged the schema-1 copy so an update is due', await evaluate(`
    (async () => {
        const req = indexedDB.open('keyval-store');
        const db = await new Promise(res => { req.onsuccess = () => res(req.result); });
        const tx = db.transaction('keyval', 'readwrite');
        tx.objectStore('keyval').put({ v: 1, date: '2020-01-01' }, 'tuneIndexMetadata');
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
        return 'ok';
    })()`) === 'ok');
    await navigate(APP);
    await waitFor(INDEX_READY, 60000, 'index ready');
    ms = await waitFor(`(async () => {
        const req = indexedDB.open('keyval-store');
        const db = await new Promise(res => { req.onsuccess = () => res(req.result); });
        const st = db.transaction('keyval', 'readonly').objectStore('keyval');
        const keys = await new Promise(res => { const r = st.getAllKeys(); r.onsuccess = () => res(r.result); });
        return keys.includes('ffIndexManifest') && !keys.includes('tuneIndex');
    })()`, 300000, 'migration to schema 2');
    check('40 MB legacy duplicate is reclaimed after the update', true, `${(ms / 1000).toFixed(1)} s`);

} catch (e) {
    console.error('\nFATAL:', e.message);
    results.push({ name: 'harness', ok: false, detail: e.message });
} finally {
    chrome.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* chrome exiting */ }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
process.exit(failed.length ? 1 : 0);
