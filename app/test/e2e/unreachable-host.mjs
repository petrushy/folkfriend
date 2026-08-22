// Scenario: no offline copy AND the tune-data host is unreachable, while the
// device still believes it is online. This is aeroplane / hotel / captive-portal
// Wi-Fi, and it is the case that used to leave the app spinning forever with
// every tune view paying its own 15 s timeout.
//
// Chrome's --host-resolver-rules blackholes the host at the network stack, so
// it applies to Web Worker requests too (CDP network emulation does not).
//
//   127.0.0.1:9      → connection refused, fails immediately
//   198.51.100.1     → TEST-NET-2, unroutable: connects never, SYN times out
//
// Requires the production build served at http://localhost:3000.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHROME, BASE_ARGS } from './chrome.mjs';

const APP = 'http://localhost:3000';
const profile = mkdtempSync(path.join(tmpdir(), 'ff-unreach-'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

let port = 9400;

async function withChrome(extraArgs, fn) {
    const p = ++port;
    const chrome = spawn(CHROME, [
        ...BASE_ARGS,
        `--remote-debugging-port=${p}`,
        `--user-data-dir=${profile}`,
        ...extraArgs,
        'about:blank',
    ], { stdio: 'ignore' });

    let msgId = 0;
    const pending = new Map();
    let ws;
    const send = (method, params = {}, sessionId) => {
        const id = ++msgId;
        return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params, sessionId }));
        });
    };

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

    try {
        const version = await getJSON(`http://localhost:${p}/json/version`);
        ws = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = ev => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) {
                const { res, rej } = pending.get(m.id);
                pending.delete(m.id);
                m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
            }
        };
        const { targetInfos } = await send('Target.getTargets');
        const page = targetInfos.find(t => t.type === 'page');
        const { sessionId } = await send('Target.attachToTarget', {
            targetId: page.targetId, flatten: true,
        });
        await send('Page.enable', {}, sessionId);
        await send('Runtime.enable', {}, sessionId);

        const evaluate = async expression => {
            const r = await send('Runtime.evaluate', {
                expression, awaitPromise: true, returnByValue: true,
            }, sessionId);
            if (r.exceptionDetails) {
                throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
            }
            return r.result.value;
        };
        const waitFor = async (expression, timeoutMs, label) => {
            const t0 = Date.now();
            while (Date.now() - t0 < timeoutMs) {
                try {
                    const v = await evaluate(`(() => { try { return ${expression}; } catch(e) { return false; } })()`);
                    if (v) return Date.now() - t0;
                } catch (e) { /* navigating */ }
                await sleep(100);
            }
            throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
        };
        const navigate = async url => {
            await evaluate('window.__stale = true').catch(() => {});
            await send('Page.navigate', { url }, sessionId);
            await waitFor('window.__stale === undefined && !!document.querySelector("#app")',
                30000, 'new document');
        };

        return await fn({ evaluate, waitFor, navigate, send, sessionId });
    } finally {
        chrome.kill();
        await sleep(800);
    }
}

const INDEX_READY = `!!document.querySelector('.tuneProgress .Transparent')`;
const INDEX_UNAVAILABLE = `!!document.querySelector('.indexErrorMsg')`;
const OPEN_TUNE = `(() => { window.history.pushState({}, '', '/tune?tuneID=15326'); window.dispatchEvent(new PopStateEvent('popstate')); return true; })()`;
const TUNE_SETTLED = `!!document.querySelector('.expansionPanel') || /saved for offline use|Could not load tune|No tune loaded/.test(document.body.innerText)`;
const WIPE_INDEX = `
(async () => {
    const req = indexedDB.open('keyval-store');
    const db = await new Promise(res => { req.onsuccess = () => res(req.result); });
    const tx = db.transaction('keyval', 'readwrite');
    const st = tx.objectStore('keyval');
    const all = await new Promise(res => { const r = st.getAllKeys(); r.onsuccess = () => res(r.result); });
    for (const key of all) {
        if (String(key).startsWith('ffIndexRaw') || String(key).startsWith('ffIndexManifest')) {
            st.delete(key);
        }
    }
    st.delete('tuneIndex'); st.delete('tuneIndexMetadata');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    const t2 = db.transaction('keyval', 'readonly').objectStore('keyval');
    return await new Promise(res => { const r = t2.getAllKeys(); r.onsuccess = () => res(r.result); });
})()`;

try {
    // --- Prime: install the app + service worker while online, then remove the
    //     offline copy to simulate eviction.
    console.log('\nPriming (online)');
    await withChrome([], async ({ evaluate, waitFor, navigate }) => {
        await navigate(APP);
        await waitFor(INDEX_READY, 300000, 'index ready');
        await waitFor(`navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))`,
            30000, 'sw active');
        await navigate(APP);
        await waitFor(`navigator.serviceWorker.controller !== null`, 30000, 'sw controlling');
        const keys = await evaluate(WIPE_INDEX);
        check('primed: app cached, offline copy evicted',
            !keys.some(k => String(k).startsWith('ffIndexManifest')),
            `keys: ${keys.join(', ') || '(none)'}`);
    });

    // --- Case A: host refuses connections (fails immediately).
    console.log('\nA. Tune-data host refuses connections (navigator.onLine === true)');
    await withChrome(['--host-resolver-rules=MAP folkfriend-data.web.app 127.0.0.1:9'],
        async ({ evaluate, waitFor, navigate }) => {
            await navigate(APP);
            check('device still reports itself online', await evaluate('navigator.onLine'));
            const ms = await waitFor(INDEX_UNAVAILABLE, 30000, 'unavailable');
            check('app reports "unavailable" quickly', ms < 10000, `${ms} ms`);
            console.log(`     message: ${JSON.stringify(await evaluate(`document.querySelector('.indexErrorMsg').innerText`))}`);

            const t0 = Date.now();
            await evaluate(OPEN_TUNE);
            await waitFor(TUNE_SETTLED, 25000, 'tune view resolved');
            check('tune view resolves without the old 15 s stall', Date.now() - t0 < 3000,
                `${Date.now() - t0} ms`);
        });

    // --- Case B: host blackholed — connections hang, never refused. This is
    //     the aeroplane/captive-portal case that used to hang forever.
    console.log('\nB. Tune-data host blackholed — connections hang (captive portal)');
    await withChrome(['--host-resolver-rules=MAP folkfriend-data.web.app 198.51.100.1'],
        async ({ evaluate, waitFor, navigate }) => {
            await navigate(APP);
            check('device still reports itself online', await evaluate('navigator.onLine'));
            const ms = await waitFor(INDEX_UNAVAILABLE, 60000, 'unavailable');
            check('stalled connection is abandoned, not waited on', ms < 15000,
                `${ms} ms (8 s metadata deadline + startup)`);

            const t0 = Date.now();
            await evaluate(OPEN_TUNE);
            await waitFor(TUNE_SETTLED, 25000, 'tune view resolved');
            check('tune view resolves without the old 15 s stall', Date.now() - t0 < 3000,
                `${Date.now() - t0} ms`);
        });
} catch (e) {
    console.error('\nFATAL:', e.message);
    results.push({ name: 'harness', ok: false, detail: e.message });
} finally {
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* exiting */ }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
process.exit(failed.length ? 1 : 0);
