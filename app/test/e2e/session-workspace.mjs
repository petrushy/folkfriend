// Real rendered session workspace, isolated from the user's browser and data.
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
const chrome = spawn(CHROME, [...BASE_ARGS, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
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
    await evaluate(`(async () => {
        localStorage.setItem('userSettings', JSON.stringify({ tuneDatasets: [], geoTagDetections: false }));
        const sessions = Array.from({ length: 240 }, (_, i) => ({
            id: 'session-' + i, name: 'Sunday session ' + i, customName: true,
            startedAt: 1757000000000 + i * 86400000, listenedSeconds: 240, endedAt: null,
            tunes: Array.from({ length: 4 }, (_, n) => ({ tuneId: n + 1, settingId: String(n + 10), title: 'Fixture tune ' + n, startSeconds: n * 60, endSeconds: n * 60 + 60, bestScore: 0.9 })),
        }));
        await new Promise((resolve, reject) => {
            const r = indexedDB.open('keyval-store');
            r.onupgradeneeded = () => r.result.createObjectStore('keyval');
            r.onsuccess = () => { const db = r.result; const tx = db.transaction('keyval', 'readwrite'); tx.objectStore('keyval').put(sessions, 'liveSessions'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = reject; };
            r.onerror = reject;
        });
    })()`);
    await send('Page.navigate', { url: `${origin}/session-analysis` });
    await until(() => evaluate(`document.body && document.body.textContent.includes('Past sessions')`), 'workspace');
    await openSaved('Sunday session 239');
    assert.equal(await evaluate(`document.querySelectorAll('tbody tr').length`), 4, 'Only the selected session is rendered');
    console.log('✓ Search 240 sessions and open one shared editor');
    await click('File recording');
    await until(() => evaluate(`!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Choose Audio')`), 'file view');
    await click('Sessions');
    await until(() => evaluate(`document.querySelector('input[maxlength="160"]')?.value === 'Sunday session 239'`), 'return to selected session');
    assert.equal(await evaluate(`document.querySelectorAll('tbody tr').length`), 4);
    console.log('✓ Switching to file analysis and back preserves the selected session');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), 'No horizontal page overflow at mobile width');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(tmpdir(), 'folkfriend-session-workspace-mobile.png'), Buffer.from(shot.data, 'base64'));
    await evaluate(`(() => { const input = document.querySelector('input[maxlength="160"]'); input.focus(); input.select(); })()`);
    await send('Input.insertText', { text: 'Renamed evening' });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await until(async () => (await records()).find(s => s.id === 'session-239').name === 'Renamed evening', 'rename persisted');
    console.log('✓ Rename persists in IndexedDB');
    await click('Download Tune List');
    await until(async () => readdirSync(work).some(n => n.endsWith('-tunes.txt')), 'download');
    const exported = readFileSync(path.join(work, readdirSync(work).find(n => n.endsWith('-tunes.txt'))), 'utf8');
    assert.ok(exported.includes('Fixture tune 0') && exported.includes('Fixture tune 3'));
    console.log('✓ Export contains the selected historical tune list');
    await click('Remove');
    await until(async () => (await records()).find(s => s.id === 'session-239').tunes.length === 3, 'row removal');
    await click('Session actions');
    await click('Clear tune list');
    await until(async () => (await records()).find(s => s.id === 'session-239').tunes.length === 0, 'clear list');
    assert.equal((await records()).length, 240);
    console.log('✓ Remove and Clear persist while keeping the session');
    await send('Page.reload');
    await until(() => evaluate(`document.body && document.body.textContent.includes('Past sessions')`), 'reload');
    await openSaved('Renamed evening');
    assert.ok(await evaluate(`document.body.textContent.includes('No tunes in this session yet')`));
    await click('Session actions');
    await click('Delete session');
    await until(async () => !(await records()).some(s => s.id === 'session-239'), 'delete session');
    assert.equal((await records()).length, 239);
    console.log('✓ Reload preserves edits; Delete removes only the selected session');
    // A cloud-only session with an expired token still plays previously cached
    // audio. Seed a real WAV so this exercises browser decoding, not a fake URL.
    await evaluate(`(async () => {
        const id = 'dropbox-offline';
        const session = { id, name: 'Offline Dropbox evening', customName: true, startedAt: 1757000000000,
            listenedSeconds: 1, tunes: [] };
        const buffer = new ArrayBuffer(16044), view = new DataView(buffer);
        const text = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
        text(0, 'RIFF'); view.setUint32(4, 16036, true); text(8, 'WAVE'); text(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true);
        view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, 16000, true);
        const blob = new Blob([buffer], { type: 'audio/wav' });
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await crypto.subtle.digest('SHA-256', buffer)))].map(b => b.toString(16).padStart(2, '0')).join('');
        const segment = { index: 0, trackIndex: 0, startSeconds: 0, durationSeconds: 1, bytes: blob.size,
            chunks: [{ startSeconds: 0, bytes: blob.size, init: true }], file: 'segments/000000.bin', contentHash: hash };
        const manifest = { schema: 1, cloudSchema: 1, sessionId: id, totalSeconds: 1, bytes: blob.size,
            tracks: [{ index: 0, startSeconds: 0, durationSeconds: 1, mimeType: 'audio/wav', initBase64: '' }], segments: [segment] };
        localStorage.setItem('folkfriend.dropbox.enabled', 'true');
        localStorage.setItem('folkfriend.dropbox.account', 'fixture-account');
        localStorage.setItem('folkfriend.dropbox.auth', JSON.stringify({ accessToken: 'expired-fixture', expiresAt: 0 }));
        await new Promise((resolve, reject) => {
            const r = indexedDB.open('keyval-store');
            r.onsuccess = () => { const db = r.result; const tx = db.transaction('keyval', 'readwrite'); const s = tx.objectStore('keyval');
                s.put([session], 'liveSessions');
                s.put(manifest, 'dropbox:fixture-account:manifest:' + id);
                s.put({ segment: { ...segment, sessionId: id, blob }, used: Date.now() }, 'dropboxCache:fixture-account:' + id + ':' + hash);
                tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = reject;
            }; r.onerror = reject;
        });
    })()`);
    await send('Page.reload');
    await until(() => evaluate(`document.body && document.body.textContent.includes('Past sessions')`), 'Dropbox reload');
    await openSaved('Offline Dropbox evening');
    await until(() => evaluate(`!!document.querySelector('.sessionAudioPlayer audio')`), 'remote manifest player');
    assert.ok(await evaluate(`document.body.textContent.includes('Reconnect required')`));
    await evaluate(`document.querySelector('button[aria-label="Play recording"]').click()`);
    await until(() => evaluate(`document.querySelector('.sessionAudioPlayer audio')?.src.startsWith('blob:')`), 'cached cloud audio loaded');
    await until(() => evaluate(`document.querySelector('.sessionAudioPlayer audio')?.duration === 1`), 'cached WAV decoded');
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), 'Dropbox controls fit mobile width');
    console.log('✓ Cached Dropbox recording decodes in the existing player with expired authorization');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (url, options) => {
            if (!String(url).includes('.dropboxapi.com/')) return originalFetch(url, options);
            const endpoint = new URL(url).pathname;
            if (endpoint === '/2/files/list_folder') return Response.json({ entries: [
                { '.tag': 'file', path_lower: '/sessions/recording', size: 1610612736 }
            ], has_more: false });
            if (endpoint === '/2/users/get_space_usage') return window.__spaceAllowed
                ? Response.json({ used: 8589934592, allocation: { '.tag': 'individual', allocated: 10737418240 } })
                : Response.json({ error: { '.tag': 'missing_scope', required_scope: 'account_info.read' } }, { status: 401 });
            return Response.json({ error_summary: 'path/not_found/' }, { status: 409 });
        };
    ` });
    await evaluate(`localStorage.setItem('folkfriend.dropbox.auth', JSON.stringify({ accessToken: 'fixture', expiresAt: Date.now() + 3600000 }))`);
    await send('Page.navigate', { url: origin + '/settings' });
    await until(() => evaluate(`document.body.textContent.includes('1.50 GB stored by FolkFriend on Dropbox')`), 'Dropbox stored size in Settings');
    assert.ok(await evaluate(`document.body.textContent.includes('Show available space')`), 'Optional quota authorization is offered');
    await evaluate('window.__spaceAllowed = true');
    await click('Refresh storage usage');
    await until(() => evaluate(`document.body.textContent.includes('2.00 GB available in your Dropbox account')`), 'Dropbox available space');
    await evaluate(`document.querySelector('.dropboxBackup').scrollIntoView()`);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), 'Storage display fits mobile width');
    const storageShot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(tmpdir(), 'folkfriend-dropbox-storage-mobile.png'), Buffer.from(storageShot.data, 'base64'));
    console.log('✓ Settings shows Dropbox stored bytes and optional available space without disconnecting backup');
    assert.deepEqual(errors, [], 'No Vue warnings or uncaught browser errors');
    console.log('Session workspace browser checks passed.');
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
