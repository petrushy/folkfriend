// Verifies that every interactive control on the Settings page is actually
// wired to a method — the failure mode being a Vue 2 template that references a
// handler which no longer exists, where clicking silently does nothing.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHROME, BASE_ARGS } from './chrome.mjs';

const APP = 'http://localhost:3000';
const profile = mkdtempSync(path.join(tmpdir(), 'ff-settings-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
    ...BASE_ARGS, '--remote-debugging-port=9700', `--user-data-dir=${profile}`,
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
    const v = await getJSON('http://localhost:9700/json/version');
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

    await send('Page.navigate', { url: `${APP}/settings` }, session);
    await waitFor(`document.body.innerText.includes('Offline Tune Database')`, 60000, 'settings page');
    await sleep(1500);

    // Every handler the template names must resolve on the component instance.
    const wiring = await evaluate(`
    (() => {
        const root = document.querySelector('#app').__vue__;
        const find = (vm) => {
            if (vm.$options.name === 'SettingsView') return vm;
            for (const c of vm.$children) { const f = find(c); if (f) return f; }
            return null;
        };
        const vm = find(root);
        if (!vm) return { error: 'SettingsView not mounted' };
        const names = ['signIn','signOut','settingsChanged','onMlTranscriberChanged',
                       'onRecordingLimitChanged','saveOfflineCopy','downloadUserData',
                       'restoreUserData','importFromTheSession','onApiKeyChanged',
                       'confirmClearAiSummaries','clearAiSummaries','resetAiUsage',
                       'formatUsd',
                       // Dataset selection. saveOfflineCopy keeps its name
                       // deliberately — renaming it would break this check
                       // silently for everyone reading the old name.
                       'onDatasetToggled','confirmRemoveDataset','removeDataset',
                       // Importing a dataset the app does not host.
                       'closeAddDialog','pickDatasetFile','onDatasetFileChosen',
                       'addDatasetFromUrl'];
        const missing = names.filter(n => typeof vm[n] !== 'function');
        return { missing, total: names.length, hasStore: !!vm.$data };
    })()`);
    check('SettingsView is mounted', !wiring.error, wiring.error || '');
    check('every handler named in the template exists',
        wiring.missing && wiring.missing.length === 0,
        wiring.missing && wiring.missing.length
            ? `missing: ${wiring.missing.join(', ')}`
            : `all ${wiring.total} present`);

    // Clicking "Sign in with Google" must actually run the handler. The bug was
    // a template referencing a method that no longer existed, so the click was
    // silently dropped — indistinguishable from "nothing happened".
    //
    // signIn() sets this.signingIn = true synchronously before awaiting
    // store.signIn(), so observing that flag is direct proof the handler ran,
    // independent of whether the OAuth popup can complete in headless Chrome.
    const clicked = await evaluate(`
    (() => {
        const root = document.querySelector('#app').__vue__;
        const find = (vm) => {
            if (vm.$options.name === 'SettingsView') return vm;
            for (const c of vm.$children) { const f = find(c); if (f) return f; }
            return null;
        };
        const vm = find(root);
        const btn = [...document.querySelectorAll('button')]
            .find(b => /sign in with google/i.test(b.innerText));
        if (!btn) return { error: 'sign-in button not found' };
        const before = vm.signingIn;
        btn.click();
        return { before, after: vm.signingIn };
    })()`);
    check('sign-in button exists', !clicked.error, clicked.error || '');
    check('clicking it runs signIn() — not silently dropped',
        clicked.before === false && clicked.after === true,
        `signingIn ${clicked.before} -> ${clicked.after}`);

    await sleep(2500);
    const authTargets = (await send('Target.getTargets')).targetInfos
        .filter(t => /accounts\.google|firebaseapp\.com|__\/auth/.test(t.url));
    check('Firebase opened a Google auth popup', authTargets.length > 0,
        authTargets.map(t => t.url.slice(0, 70)).join(' | ') || 'no auth target');

    const vueWarnings = warnings.filter(w => /\[Vue warn\]/.test(w));
    check('no Vue warnings about missing handlers/properties',
        vueWarnings.length === 0, vueWarnings.slice(0, 3).join(' // ') || 'none');
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
