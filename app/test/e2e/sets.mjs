// Exercises set persistence, arrangement editing and offline score rendering.
// FF_REAL_SEARCH=1 also checks the real WASM name-search/settings path.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHROME, BASE_ARGS } from './chrome.mjs';

const APP = process.env.APP_URL || 'http://localhost:3000';
const profile = mkdtempSync(path.join(tmpdir(), 'ff-sets-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
    ...BASE_ARGS, '--remote-debugging-port=9712', `--user-data-dir=${profile}`,
    'about:blank',
], { stdio: 'ignore' });

let msgId = 0;
const pending = new Map();
const warnings = [];
let ws, session;
const send = (m, p = {}, s) => {
    const id = ++msgId;
    return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s })); });
};

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function getJSON(url) {
    for (let i = 0; i < 80; i++) {
        try { const r = await fetch(url); if (r.ok) return r.json(); } catch (e) { /* waiting */ }
        await sleep(250);
    }
    throw new Error('CDP not reachable');
}

async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
}

async function waitFor(expr, ms, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { if (await evaluate(`(() => { try { return ${expr}; } catch(e) { return false; } })()`)) return Date.now() - t0; }
        catch (e) { /* navigating */ }
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
}

try {
    const v = await getJSON('http://localhost:9712/json/version');
    console.log(`\nChrome: ${v.Browser}\n`);
    ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            const { res, rej } = pending.get(m.id);
            pending.delete(m.id);
            m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
            return;
        }
        // Vue 2 reports a missing handler as a console warning, not an exception.
        if (m.method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(m.params.type)) {
            warnings.push(m.params.args.map(a => a.value ?? a.description).join(' '));
        }
        if (m.method === 'Runtime.exceptionThrown') {
            warnings.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
        }
    };
    const { targetInfos } = await send('Target.getTargets');
    ({ sessionId: session } = await send('Target.attachToTarget', {
        targetId: targetInfos.find(t => t.type === 'page').targetId, flatten: true,
    }));
    await send('Page.enable', {}, session);
    await send('Runtime.enable', {}, session);
    await send('Target.setDiscoverTargets', { discover: true }, session);

    await send('Page.navigate', { url: APP }, session);
    await waitFor(`!!document.querySelector('#app')?.__vue__?.$router`, 60000, 'app router');
    await evaluate("document.querySelector('#app').__vue__.$router.push('/sets').then(() => true)");
    await waitFor(`/new set/i.test(document.body.innerText)`, 60000, 'sets page');
    await evaluate(`window.setsVM = (() => {
        const find = vm => vm.$options.name === 'SetsView' ? vm : vm.$children.map(find).find(Boolean);
        return find(document.querySelector('#app').__vue__);
    })(); true`);
    if (process.env.FF_REAL_SEARCH) {
        const realSearch = await evaluate(`(async () => {
            const vm = window.setsVM;
            vm.create(); vm.draft.name = 'Real search regression'; vm.query = 'cooley';
            await vm.search();
            const results = vm.results;
            if (vm.error || results.length < 2) return { error: vm.error || 'No settings found' };
            // Seed a saved favourite in this isolated browser profile, then
            // verify the real search places that exact setting first.
            const starred = results[1];
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('keyval-store');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            await new Promise((resolve, reject) => {
                const tx = db.transaction('keyval', 'readwrite');
                tx.objectStore('keyval').put([{ timestamp: Date.now(), tags: [], result: {
                    settingID: starred.setting_id, setting: starred.setting, displayName: starred.display_name,
                } }], 'favouriteItems');
                tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
            });
            db.close();
            await vm.search();
            const favouriteFirst = vm.results[0].favourite && vm.results[0].setting_id === starred.setting_id;
            vm.add(vm.results[0]); vm.add(vm.results[1]); await vm.save();
            const saved = vm.sets.find(s => s.name === 'Real search regression');
            const detail = { error: vm.error, favouriteFirst, ids: saved?.entries.map(e => e.result.settingID),
                scores: saved?.entries.every(e => !!e.result.setting.abc) };
            if (saved) { window.confirm = () => true; vm.edit(saved); await vm.remove(); }
            return detail;
        })()`);
        check('real search puts the favorite setting first and saves IDs and scores',
            !realSearch.error && realSearch.favouriteFirst && realSearch.ids?.length === 2 && realSearch.ids.every(Boolean) && realSearch.scores,
            JSON.stringify(realSearch));
    }
    const state = await evaluate(`(async () => {
        const vm = window.setsVM;
        vm.create(); vm.draft.name = 'Browser reels'; vm.draft.tags = ['Tuesday'];
        for (const [id, mode, dance] of [['420', 'Dmajor', 'reel'], ['430', 'Gmajor', 'jig']]) {
            vm.add({ setting_id: id, display_name: 'Tune ' + id,
                setting: { tune_id: id, abc: 'X:1\\nT:Test\\nM:4/4\\nL:1/8\\nK:D\\nDEFG ABcd|', mode, dance } });
        }
        vm.move(1, -1); await vm.save();
        return { error: vm.error, order: vm.sets[0]?.entries.map(e => e.result.settingID) };
    })()`);
    check('browser saves reordered full settings', !state.error && state.order.join(',') === '430,420', JSON.stringify(state));
    const text = await evaluate('document.body.innerText');
    check('overview shows key and tune type', text.includes('G major, Jig') && text.includes('D major, Reel'));
    await evaluate(`(async () => {
        const vm = window.setsVM; vm.duplicate(vm.sets[0]); await vm.save();
    })()`);
    check('duplicate is a separate saved set', await evaluate('window.setsVM.sets.length === 2'));
    await send('Page.navigate', { url: APP }, session);
    await waitFor(`!!document.querySelector('#app')?.__vue__?.$router`, 30000, 'reloaded router');
    await evaluate("document.querySelector('#app').__vue__.$router.push('/sets').then(() => true)");
    await waitFor(`document.body.innerText.includes('Browser reels (copy)')`, 30000, 'saved sets after reload');
    check('sets survive page reload', true);
    await evaluate(`window.setsVM = (() => {
        const find = vm => vm.$options.name === 'SetsView' ? vm : vm.$children.map(find).find(Boolean);
        return find(document.querySelector('#app').__vue__);
    })(); window.confirm = () => true; window.setsVM.edit(window.setsVM.sets[0]);`);
    await evaluate('window.setsVM.remove()');
    check('delete leaves the other set intact', await evaluate('window.setsVM.sets.length === 1'));
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, session);
    await evaluate('window.setsVM.edit(window.setsVM.sets[0])');
    await sleep(300);
    check('mobile editor fits viewport', await evaluate('document.documentElement.scrollWidth <= 390'));
    const screenshot = await send('Page.captureScreenshot', { format: 'png' }, session);
    const { writeFileSync } = await import('node:fs');
    writeFileSync('/tmp/folkfriend-sets-mobile.png', Buffer.from(screenshot.data, 'base64'));
    await send('Network.enable', {}, session);
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, session);
    await evaluate("window.setsVM.$set(window.setsVM.expanded, window.setsVM.draft.entries[0].id, true)");
    await waitFor(`!!document.querySelector('.abcSheetMusic svg')`, 10000, 'offline saved score');
    check('saved setting renders its score offline', true);
    const vueWarnings = warnings.filter(w => /\[Vue warn\]|EXC/.test(w));
    check('no Vue warnings or runtime exceptions', vueWarnings.length === 0, vueWarnings.slice(0, 3).join(' // '));
} catch (e) {
    console.error('\nFATAL:', e.message);
    results.push({ name: 'harness', ok: false, detail: e.message });
} finally {
    chrome.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* exiting */ }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
process.exit(failed.length ? 1 : 0);
