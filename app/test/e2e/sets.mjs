// Exercises set persistence, arrangement editing and offline score rendering.
// FF_REAL_SEARCH=1 also checks the real WASM name-search/settings path.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHROME, BASE_ARGS } from './chrome.mjs';

const TEST_FOLLOW = process.env.FF_FOLLOW_TEST !== '0';
const APP = process.env.APP_URL || 'http://localhost:3000';
const profile = mkdtempSync(path.join(tmpdir(), 'ff-sets-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
    ...BASE_ARGS, '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    ...(TEST_FOLLOW ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] : []),
    '--remote-debugging-port=9712', `--user-data-dir=${profile}`,
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
    if (process.env.FF_REAL_SEARCH) {
        await evaluate(`window.findVM = name => {
            const find = vm => vm.$options.name === name ? vm : vm.$children.map(find).find(Boolean);
            return find(document.querySelector('#app').__vue__);
        };`);
        await evaluate(`(async () => {
            const vm = window.setsVM;
            vm.create(); vm.draft.name = 'Partner draft regression'; vm.query = 'cooley';
            await vm.search(); vm.add(vm.results[0]); await vm.$nextTick();
            window.findVM('SetPartnersButton').openPartners();
        })()`);
        await waitFor(`window.findVM('SetPartnersDialog').partners.length > 0`, 15000, 'partner suggestions');
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, session);
        await evaluate(`document.querySelector('.partnerRow button').click()`);
        await waitFor(`window.findVM('AddToSetDialog').open && !window.findVM('AddToSetDialog').loading`, 15000, 'add-to-set settings');
        check('partner setting picker fits a phone screen', await evaluate('document.documentElement.scrollWidth <= 390'));
        const pickerShot = await send('Page.captureScreenshot', { format: 'png' }, session);
        const fs = await import('node:fs');
        fs.writeFileSync('/tmp/ff-addset-mobile.png', Buffer.from(pickerShot.data, 'base64'));
        const draftAdd = await evaluate(`(async () => {
            const dialog = window.findVM('AddToSetDialog');
            const wasDraft = dialog.destination === 'draft';
            dialog.selectedID = dialog.settingOptions[0].value;
            const id = dialog.selectedID;
            await dialog.add();
            return { error: dialog.error, wasDraft, path: location.pathname,
                count: window.setsVM.draft.entries.length, id: String(window.setsVM.draft.entries[1]?.result.settingID), selected: id };
        })()`);
        check('partner row adds chosen setting to the current draft without navigation',
            !draftAdd.error && draftAdd.wasDraft && draftAdd.path === '/sets' && draftAdd.count === 2 && draftAdd.id === draftAdd.selected,
            JSON.stringify(draftAdd));
        const savedAdd = await evaluate(`(async () => {
            const vm = window.setsVM;
            await vm.save();
            const set = vm.sets.find(s => s.name === 'Partner draft regression');
            const partners = window.findVM('SetPartnersDialog');
            const dialog = window.findVM('AddToSetDialog');
            await dialog.show({ tuneID: partners.partners[0].tuneID, title: partners.partners[0].name });
            dialog.destination = set.id; dialog.selectedID = dialog.settingOptions[0].value;
            await dialog.add(); await vm.refresh();
            const count = vm.sets.find(s => s.id === set.id).entries.length;
            const error = dialog.error;
            window.confirm = () => true;
            vm.edit(vm.sets.find(s => s.id === set.id)); await vm.remove();
            await dialog.show({ tuneID: partners.partners[0].tuneID, title: partners.partners[0].name });
            dialog.destination = 'new'; dialog.name = 'New partner set'; dialog.selectedID = dialog.settingOptions[0].value;
            await dialog.add(); await vm.refresh();
            const created = vm.sets.find(s => s.name === 'New partner set');
            const newCount = created?.entries.length;
            if (created) { vm.edit(created); await vm.remove(); }
            partners.open = false;
            return { error: error || dialog.error, count, newCount };
        })()`);
        check('partner setting can be saved to an existing or newly created set',
            !savedAdd.error && savedAdd.count === 3 && savedAdd.newCount === 1, JSON.stringify(savedAdd));
    }
    const state = await evaluate(`(async () => {
        const vm = window.setsVM;
        vm.create(); vm.draft.name = 'Browser reels'; vm.draft.tags = ['Tuesday'];
        for (const [id, mode, dance] of [['420', 'Dmajor', 'reel'], ['430', 'Gmajor', 'jig']]) {
            vm.add({ setting_id: id, display_name: 'Tune ' + id,
                setting: { tune_id: '987654321' + id, abc: 'X:1\\nT:Test\\nM:4/4\\nL:1/8\\nK:D\\nDEFG ABcd|', mode, dance } });
        }
        vm.move(1, -1); await vm.save(); await vm.showList();
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
    await evaluate(`window.findVM = name => {
        const find = vm => vm.$options.name === name ? vm : vm.$children.map(find).find(Boolean);
        return find(document.querySelector('#app').__vue__);
    };`);
    await evaluate(`(async () => {
        const entries = window.setsVM.draft.entries;
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('keyval-store');
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
            const tx = db.transaction('keyval', 'readwrite');
            tx.objectStore('keyval').put(entries.map((e, i) => ({ result: e.result, timestamp: Date.now() + i, tags: [] })), 'favouriteItems');
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        }); db.close();
        await document.querySelector('#app').__vue__.$router.push('/favourites');
    })()`);
    await waitFor(`window.findVM('FavouritesView')?.favouriteItems.length === 2`, 15000, 'favorite tunes');
    await waitFor(`!!document.querySelector('.favourite-row-wrapper [aria-label="Sets containing this setting"] .v-chip')`, 10000, 'favorite setting membership');
    check('Favorite Tunes shows clickable exact-setting set names', await evaluate(`!!document.querySelector('.favourite-row-wrapper [aria-label="Sets containing this setting"] a[href*="setID="]')`));
    await evaluate(`document.querySelector('.favourite-row-wrapper button[title="Add to set"]').click()`);
    await waitFor(`window.findVM('AddToSetDialog').open && !window.findVM('AddToSetDialog').loading`, 10000, 'favorite destination picker');
    const oneFavorite = await evaluate(`(async () => {
        const dialog = window.findVM('AddToSetDialog');
        const exact = dialog.batch.length === 1 && !!dialog.batch[0].setting_id && !!dialog.batch[0].setting.abc;
        dialog.destination = 'new'; dialog.name = 'Favorite row regression'; await dialog.add();
        await new Promise(r => setTimeout(r, 300));
        const openSet = [...document.querySelectorAll('.v-snack__action a')].some(a => a.textContent.trim() === 'Open set' && a.href.includes(dialog.noticeSetID));
        return { exact, error: dialog.error, path: location.pathname, openSet };
    })()`);
    check('favorite row icon saves its exact setting offline without navigation, offering Open set',
        oneFavorite.exact && !oneFavorite.error && oneFavorite.path === '/favourites' && oneFavorite.openSet, JSON.stringify(oneFavorite));
    await evaluate(`window.findVM('FavouritesView').selectedIDs = new Set(window.findVM('FavouritesView').favouriteItems.map(f => f.result.settingID));`);
    await sleep(100);
    await evaluate(`document.querySelector('[title="Add selected tunes to a set"]').click()`);
    await waitFor(`window.findVM('AddToSetDialog').open && !window.findVM('AddToSetDialog').loading`, 10000, 'bulk favorite picker');
    const bulkFavorite = await evaluate(`(async () => {
        const dialog = window.findVM('AddToSetDialog');
        const original = dialog.batch.map(e => String(e.setting_id));
        dialog.move(1, -1);
        dialog.destination = dialog.sets.find(s => s.name === 'Favorite row regression').id;
        await dialog.add();
        const error = dialog.error;
        const favoriteCount = window.findVM('FavouritesView').favouriteItems.length;
        await document.querySelector('#app').__vue__.$router.push('/sets');
        return { original, error, favoriteCount };
    })()`);
    await waitFor(`window.findVM('SetsView')?.sets.some(s => s.name === 'Favorite row regression')`, 10000, 'bulk saved set');
    const bulkIDs = await evaluate(`window.findVM('SetsView').sets.find(s => s.name === 'Favorite row regression').entries.map(e => String(e.result.settingID))`);
    check('selected favorites append together in chosen order and remain starred',
        !bulkFavorite.error && bulkFavorite.favoriteCount === 2 && bulkIDs.length === 3 &&
        bulkIDs.slice(1).join(',') === [...bulkFavorite.original].reverse().join(','), JSON.stringify({ ...bulkFavorite, bulkIDs }));
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, session);
    await waitFor(`!!document.querySelector('.set-score-preview svg')`, 10000, 'first tune thumbnail');
    check('set rows show compact first-tune score previews on wide screens', true);
    const quickTags = await evaluate(`(async () => {
        const row = window.findVM('SetRow');
        window.taggedSetID = row.set.id;
        row.addTag('Session test');
        return row.set.id;
    })()`);
    await waitFor(`window.findVM('SetsView').sets.find(s => s.id === window.taggedSetID)?.tags.includes('Session test')`, 10000, 'quick set tag');
    const tagFilter = await evaluate(`(() => {
        const vm = window.findVM('SetsView');
        vm.toggleTagFilter('Session test');
        return { count: vm.visibleSets.length, id: vm.visibleSets[0].id };
    })()`);
    check('quick tagging and tag filters work for sets', tagFilter.count === 1 && tagFilter.id === quickTags);
    await evaluate(`window.findVM('SetsView').activeTags = [];`);
    check('duplicate/delete are kept out of the compact row', await evaluate(`![...document.querySelectorAll('.set-row')].some(e => /Duplicate|Delete/.test(e.innerText))`));
    const listShot = await send('Page.captureScreenshot', { format: 'png' }, session);
    const layoutFS = await import('node:fs');
    layoutFS.writeFileSync('/tmp/ff-sets-list.png', Buffer.from(listShot.data, 'base64'));
    await evaluate(`document.querySelector('.set-summary').click()`);
    await waitFor(`!!window.findVM('SetsView').viewedSet && !window.findVM('SetsView').draft && [...document.querySelectorAll('.set-score')].every(e => e.querySelector('.abcSheetMusic svg'))`, 10000, 'all scores in set view');
    const viewShot = await send('Page.captureScreenshot', { format: 'png' }, session);
    layoutFS.writeFileSync('/tmp/ff-sets-score-view.png', Buffer.from(viewShot.data, 'base64'));
    const viewed = await evaluate(`({ count: document.querySelectorAll('.set-score').length, expected: window.findVM('SetsView').viewedSet.entries.length, id: window.findVM('SetsView').viewedSet.id })`);
    check('View displays every score in order without entering Edit', viewed.count === viewed.expected && viewed.count > 0);
    await evaluate(`window.findVM('SetsView').edit(window.findVM('SetsView').viewedSet)`);
    check('Edit opens the arrangement editor separately', await evaluate(`!!window.findVM('SetsView').draft && !document.querySelector('.set-score')`));
    const backFlow = await evaluate(`(async () => {
        const vm = window.findVM('SetsView');
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const setID = vm.viewedSet.id;
        const editURL = location.search;
        history.back(); await wait(400);                       // unedited: no prompt
        const backToView = !vm.draft && vm.viewID === setID && !location.search.includes('edit');
        vm.edit(vm.viewedSet); await wait(200);
        vm.draft.name += ' x'; window.confirm = () => false;
        history.back(); await wait(400);                       // dirty, declined
        const kept = !!vm.draft && vm.draft.name.endsWith(' x');
        window.confirm = () => true; vm.close(); await wait(400);
        const cancelled = !vm.draft && vm.viewID === setID;
        const before = history.length;
        vm.create(); await wait(200); vm.draft.name = 'Back flow new set';
        await vm.save(); await wait(400);
        const created = vm.sets.find(s => s.name === 'Back flow new set');
        const landed = !vm.draft && vm.viewID === created?.id && !location.search.includes('edit');
        history.back(); await wait(400);                       // not back into the editor
        const notEditor = !vm.draft && !location.search.includes('edit');
        await vm.deleteSet(created); await vm.openSet(vm.sets.find(s => s.id === setID)); await wait(300);
        vm.edit(vm.viewedSet); await wait(200);
        return { editURL, backToView, kept, cancelled, landed, notEditor, historyGrew: history.length - before };
    })()`);
    check('Back from the editor returns to the set, protects edits, and saving a new set lands on it',
        backFlow.editURL.includes('edit=1') && backFlow.backToView && backFlow.kept && backFlow.cancelled
        && backFlow.landed && backFlow.notEditor, JSON.stringify(backFlow));
    const guarded = await evaluate(`(async () => {
        const vm = window.findVM('SetsView');
        vm.draft.name += ' unsaved';
        const id = vm.draft.id;
        window.confirm = () => false;
        await vm.$router.push({ name: 'sets' }).catch(() => {});
        const preserved = vm.draft?.id === id && vm.draft.name.endsWith(' unsaved');
        window.confirm = () => true; vm.close();
        return preserved && !vm.viewedSet.name.endsWith(' unsaved');
    })()`);
    check('changing set URLs protects unsaved edits and viewing leaves the saved name intact', guarded);
    await evaluate(`document.querySelector('.set-score a').click()`);
    await waitFor(`!!document.querySelector('button[title="In sets"]')`, 30000, 'tune set membership');
    const exactMembership = await evaluate(`(async () => {
        const vm = window.findVM('TuneView');
        const sid = vm.settings[0].setting_id;
        const expected = vm.setsForSetting(sid).map(s => s.name);
        vm.expandedIndex = []; await vm.$nextTick();
        const collapsedButton = !!document.querySelector('button[title="In sets"]');
        document.querySelector('button[title="In sets"]').click();
        await new Promise(r => setTimeout(r, 400));
        const items = [...document.querySelectorAll('.menuable__content__active .v-list-item__title')].map(e => e.innerText.trim());
        const add = [...document.querySelectorAll('.menuable__content__active .v-list-item')].find(e => e.innerText.includes('Add to a set'));
        add.click();
        await new Promise(r => setTimeout(r, 400));
        const dialog = window.findVM('AddToSetDialog');
        const exact = dialog.open && dialog.batch.length === 1 && String(dialog.batch[0].setting_id) === String(sid);
        const noDefault = dialog.destination === null;
        const warnsAfterChoosing = (() => { dialog.destination = dialog.sets.find(s => s.entries.some(e => String(e.result.settingID) === String(sid)))?.id; return dialog.duplicateInDestination; })();
        dialog.open = false; vm.expandedIndex = [0]; await vm.$nextTick();
        return { items, expected, collapsedButton, exact, noDefault, warnsAfterChoosing };
    })()`);
    check('one set button lists exact-setting sets and adds that exact setting with no preselected set',
        exactMembership.collapsedButton && exactMembership.expected.length > 0
        && exactMembership.expected.every(name => exactMembership.items.includes(name))
        && exactMembership.items.includes('Add to a set…') && exactMembership.exact && exactMembership.noDefault
        && exactMembership.warnsAfterChoosing, JSON.stringify(exactMembership));
    const setOnly = await evaluate(`(async () => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('keyval-store');
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
            const tx = db.transaction('keyval', 'readwrite');
            tx.objectStore('keyval').put([], 'favouriteItems');
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        }); db.close();
        const fallback = await window.findVM('TuneView')._settingsFromFavourites();
        return !!fallback?.settings.length && fallback.settings.every(s => !!s.abc);
    })()`);
    check('a tune saved only in sets has an offline tune-page fallback', setOnly);
    await evaluate(`(async () => {
        document.querySelector('button[title="In sets"]').click();
        await new Promise(r => setTimeout(r, 400));
        document.querySelector('.menuable__content__active a.v-list-item').click();
    })()`);
    await waitFor(`!!window.findVM('SetsView')?.viewedSet && !!document.querySelector('.set-score')`, 10000, 'membership opens set scores');
    check('a set in the tune page set menu opens the full set score view', true);
    if (TEST_FOLLOW) {
        const makeContour = (seed, alphabet) => {
            let x = seed;
            return Array.from({ length: 160 }, () => { x = (x * 1664525 + 1013904223) >>> 0; return alphabet[x % alphabet.length]; }).join('');
        };
        const contours = [makeContour(17, 'opqrstuvwxyz'), makeContour(43, 'abcdefghijk')];
        const fixture = contours.map((contour, i) => ({ setting_id: String(8000 + i), display_name: 'Follow tune ' + (i + 1), setting: {
            tune_id: String(8000 + i), contour, mode: 'Dmajor', dance: 'reel', meter: '4/4',
            abc: ['X:1', 'T:Follow tune ' + (i + 1), 'M:4/4', 'L:1/8', 'K:D',
                'DEFG ABcd|efga bgfe|dcBA GFED|DEFG ABcd|', 'efga bgfe|dcBA GFED|DEFG ABcd|efga bgfe|',
                'DEFG ABcd|efga bgfe|dcBA GFED|DEFG ABcd|', 'efga bgfe|dcBA GFED|DEFG ABcd|efga bgfe|'].join('\n'),
        } }));
        await evaluate(`(async () => {
            const vm = window.findVM('SetsView'); vm.create(); vm.draft.name = 'Follow regression';
            for (const result of ${JSON.stringify(fixture)}) vm.add(result);
            await vm.save();
            window.followFixtureState = { error: vm.error, draft: !!vm.draft, viewed: vm.viewedSet?.name, names: vm.sets.map(s => s.name) };
            window.followTracks = [];
            window.realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            window.captureFakeMedia = async options => {
                const stream = await window.realGetUserMedia(options); window.followTracks.push(...stream.getTracks()); return stream;
            };
            navigator.mediaDevices.getUserMedia = window.captureFakeMedia;
            window.scrollCalls = 0;
            const reveal = Element.prototype.scrollIntoView;
            Element.prototype.scrollIntoView = function(options) { window.scrollCalls++; return reveal.call(this, options); };
        })()`);
        await waitFor(`window.findVM('SetScoreView')?.set.name === 'Follow regression' && !!document.querySelector('.set-score .abcSheetMusic svg')`, 10000, 'follow score fixture');
        const started = await evaluate(`(async () => { const vm = window.findVM('SetScoreView'); await vm.startFollow(0); return { running: vm.running, error: vm.error }; })()`);
        check('set Follow starts with the fake microphone', started.running && !started.error, JSON.stringify(started));
        const followed = await evaluate(`(async () => {
            const vm = window.findVM('SetScoreView'); const contours = ${JSON.stringify(contours)}; const at = Date.now(); window.scrollCalls = 0;
            vm.updateFollow({ contour: contours[0].slice(20, 52), readAt: at, windowSeconds: 4 }, at);
            await vm.$nextTick();
            const firstLine = vm.line;
            vm.updateFollow({ contour: contours[1].slice(0, 32), readAt: at + 100, windowSeconds: 4 }, at + 100);
            const movedOnFirst = vm.activeIndex === 1;
            vm.updateFollow({ contour: contours[1].slice(16, 48), readAt: at + 200, windowSeconds: 4 }, at + 200);
            await vm.$nextTick();
            return { firstLine, movedOnFirst, index: vm.activeIndex, band: !!document.querySelector('.set-score-active .followBand'), scrolled: window.scrollCalls > 0 };
        })()`);
        check('set Follow highlights a row and moves to the next tune by itself on the first clear window',
            Number.isInteger(followed.firstLine) && followed.movedOnFirst && followed.index === 1 && followed.band && followed.scrolled, JSON.stringify(followed));
        await sleep(400);
        check('auto-scroll brings the active staff row into view', await evaluate(`(() => { const r = document.querySelector('.set-score-active .followBand')?.getBoundingClientRect(); return !!r && r.top >= 0 && r.bottom <= innerHeight; })()`));
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, session);
        await sleep(800);
        check('set Follow controls fit a phone screen', await evaluate('document.documentElement.scrollWidth <= 390'));
        const rowGeometry = await evaluate(`(() => {
            const vm = window.findVM('SetScoreView');
            const ref = vm.$refs['score-' + vm.set.entries[vm.activeIndex].id];
            const display = Array.isArray(ref) ? ref[0] : ref;
            const event = display.followTimeline()?.events.find(e => e.line === vm.line && e.elements?.length);
            const element = event?.elements.flat().find(e => e?.getBoundingClientRect && e.getBoundingClientRect().height > 0);
            const note = element?.getBoundingClientRect();
            const band = document.querySelector('.set-score-active .followBand')?.getBoundingClientRect();
            return { line: vm.line, fresh: display.lineClientRect(vm.line), geometry: display.followTimeline().lines[vm.line], cached: display.followBand, svgCount: display.$refs.abcTarget.querySelectorAll('svg').length, note: note && { top: note.top, bottom: note.bottom }, band: band && { top: band.top, bottom: band.bottom } };
        })()`);
        check('follow band covers the matching rendered staff row after resizing',
            rowGeometry.note && rowGeometry.band && rowGeometry.note.bottom >= rowGeometry.band.top - 8 && rowGeometry.note.top <= rowGeometry.band.bottom + 8, JSON.stringify(rowGeometry));
        const followShot = await send('Page.captureScreenshot', { format: 'png' }, session);
        layoutFS.writeFileSync('/tmp/ff-set-follow-mobile.png', Buffer.from(followShot.data, 'base64'));
        const autoOff = await evaluate(`(async () => {
            const vm = window.findVM('SetScoreView'); vm.autoScroll = false; await vm.$nextTick();
            const before = window.scrollCalls; vm.revealEntry(); await vm.$nextTick();
            const stayed = vm.running && window.scrollCalls === before; vm.autoScroll = true; await vm.$nextTick(); return stayed;
        })()`);
        check('auto-scroll can be disabled while listening continues', autoOff);
        const manual = await evaluate(`(async () => {
            const vm = window.findVM('SetScoreView'); window.dispatchEvent(new WheelEvent('wheel', { deltaY: 50 })); await vm.$nextTick();
            const held = vm.held; const before = window.scrollCalls;
            vm.revealEntry(); await vm.$nextTick();
            const stayed = window.scrollCalls === before;
            vm.resumeScroll(); await vm.$nextTick();
            return held && stayed && !vm.held;
        })()`);
        check('manual scrolling holds auto-scroll until resumed', manual);
        const cue = await evaluate(`(async () => {
            const vm = window.findVM('SetScoreView'); const tracks = window.followTracks.length;
            vm.selectEntry(0); await vm.$nextTick();
            [...document.querySelectorAll('.set-follow-bar button')].find(b => /next tune/i.test(b.innerText)).click();
            return vm.running && vm.activeIndex === 1 && window.followTracks.length === tracks;
        })()`);
        check('Next tune cues another entry without reopening the microphone', cue);
        await evaluate(`window.findVM('SetScoreView').stopFollow()`);
        await waitFor(`window.followTracks.length > 0 && window.followTracks.every(t => t.readyState === 'ended')`, 5000, 'microphone released after stop');
        check('stopping set Follow clears highlighting and releases its microphone', await evaluate(`!window.findVM('SetScoreView').running && !document.querySelector('.followBand')`));
        const denied = await evaluate(`(async () => {
            navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Test microphone refusal', 'NotAllowedError'); };
            const vm = window.findVM('SetScoreView'); await vm.startFollow(0);
            navigator.mediaDevices.getUserMedia = window.captureFakeMedia;
            return !vm.running && /Test microphone refusal/.test(vm.error);
        })()`);
        check('microphone refusal leaves Follow off and shows the reason', denied);
        await evaluate(`(async () => { const vm = window.findVM('SetScoreView'); await vm.startFollow(1); window.findVM('SetsView').edit(window.findVM('SetsView').viewedSet); })()`);
        await waitFor(`!window.findVM('SetScoreView') && window.followTracks.every(t => t.readyState === 'ended')`, 5000, 'microphone released when editing');
        check('entering Edit ends set Follow and releases its microphone', true);
    }
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, session);
    await evaluate(`(async () => {
        const vm = window.findVM('SetsView');
        if (vm.draft) { window.confirm = () => true; vm.close(); }
        vm.create(); vm.draft.name = 'MIDI repetition regression';
        for (const [id, body] of [['99001', '|: C D :|'], ['99002', 'E F|']]) vm.add({
            setting_id: id, display_name: 'MIDI ' + id,
            setting: { tune_id: '98765' + id, mode: 'Cmajor', meter: '4/4', dance: 'reel', abc: 'X:1\\nM:4/4\\nL:1/4\\nQ:1/4=600\\nK:C\\n' + body },
        });
        vm.draft.entries[0].repetitions = 3;
        await vm.save();
        window.midiStarts = []; window.midiEnds = []; window.midiDurations = [];
        const scoreView = window.findVM('SetScoreView');
        for (let index = 0; index < scoreView.set.entries.length; index++) {
            const ref = scoreView.$refs['score-' + scoreView.set.entries[index].id]; const display = Array.isArray(ref) ? ref[0] : ref;
            const prepare = display.prepareSetPlayback.bind(display);
            display.prepareSetPlayback = async (...args) => {
                const handle = await prepare(...args); const start = handle.start;
                handle.start = ended => { window.midiStarts.push(index); start(() => { window.midiEnds.push(index); ended(); }); };
                return handle;
            };
        }
        scoreView._midiContext = new AudioContext();
        const create = scoreView._midiContext.createBufferSource.bind(scoreView._midiContext);
        scoreView._midiContext.createBufferSource = () => {
            const source = create(); const start = source.start.bind(source);
            source.start = (...args) => { if (source.buffer) window.midiDurations.push(source.buffer.duration); return start(...args); };
            return source;
        };
        await scoreView.playSet();
    })()`);
    await waitFor(`window.findVM('SetScoreView').midiStatus === 'complete' || !!window.findVM('SetScoreView').error`, 20000, 'whole set MIDI playback');
    const midi = await evaluate(`({ error: window.findVM('SetScoreView').error, starts: window.midiStarts, ends: window.midiEnds, durations: window.midiDurations, reps: window.findVM('SetScoreView').set.entries.map(e => e.repetitions) })`);
    check('native synth plays complete tunes the configured number of times in order',
        !midi.error && midi.starts.join(',') === '0,0,0,1,1' && midi.ends.join(',') === midi.starts.join(',') && midi.reps.join(',') === '3,2', JSON.stringify(midi));
    check('written ABC repeats are included in each complete playback', midi.durations.length === 5 && Math.abs(midi.durations[0] - 2 * midi.durations[3]) < 0.04);
    await evaluate(`(async () => { const vm = window.findVM('SetScoreView'); vm.midiTempo = 25; await vm.playSet(); })()`);
    await waitFor(`!!document.querySelector('.set-score-active .followBand') && !!document.querySelector('.set-score-active .abcjs-current-note')`, 10000, 'MIDI score position');
    check('synthesized set playback marks the current note and staff row', true);
    const midiPause = await evaluate(`(() => {
        const vm = window.findVM('SetScoreView'); vm.toggleMidiPause();
        return { status: vm.midiStatus, starts: window.midiStarts.length };
    })()`);
    await sleep(250);
    check('pausing whole-set playback holds its place', midiPause.status === 'paused' && await evaluate(`window.findVM('SetScoreView').midiStatus === 'paused' && window.midiStarts.length === ${midiPause.starts}`));
    const stoppedMidi = await evaluate(`(async () => {
        const vm = window.findVM('SetScoreView'); vm.toggleMidiPause();
        const resumed = vm.midiStatus === 'playing'; vm.stopSetPlayback();
        const count = window.midiStarts.length;
        const starting = vm.playSet(); vm.stopSetPlayback(); await starting;
        return { resumed, stopped: vm.midiStatus === 'idle', count, now: window.midiStarts.length };
    })()`);
    check('resume, stop and cancellation cannot start a late tune', stoppedMidi.resumed && stoppedMidi.stopped && stoppedMidi.count === stoppedMidi.now, JSON.stringify(stoppedMidi));
    check('set view has one Follow control and linked tune names', await evaluate(`![...document.querySelectorAll('.set-score button')].some(b => /follow from here|open tune/i.test(b.innerText)) && document.querySelectorAll('.set-score .set-tune-title').length === 2`));
    await evaluate(`(async () => { const vm = window.findVM('SetScoreView'); await vm.playSet(); window.savedMidiContext = vm._midiContext; window.findVM('SetsView').edit(window.findVM('SetsView').viewedSet); })()`);
    await waitFor(`window.savedMidiContext.state === 'closed'`, 5000, 'playlist context closed on edit');
    check('entering Edit stops synthesized set playback and closes its shared context', true);
    // Clearable search must accept Vuetify's null clear value.
    const clearSearch = await evaluate(`(async () => { const vm = window.findVM('SetsView'); vm.query = null; await vm.search(); return !vm.searching; })()`);
    check('clearing the set editor search is safe', clearSearch);
    if (process.env.FF_REAL_SEARCH) {
        await evaluate(`window.confirm = () => true; window.findVM('SetsView').close(); document.querySelector('#app').__vue__.$router.push({ name: 'search' }).then(() => true)`);
        await waitFor(`!!window.findVM('SearchView')`, 10000, 'main search');
        await evaluate(`window.findVM('SearchView').textQuery = 'cooley'; window.findVM('SearchView').nameQuery()`);
        await waitFor(`!!document.querySelector('.result-row-wrapper button[title="Add to set"]')`, 15000, 'search result add action');
        await evaluate(`document.querySelector('.result-row-wrapper button[title="Add to set"]').click()`);
        await waitFor(`window.findVM('AddToSetDialog').open && !window.findVM('AddToSetDialog').loading`, 10000, 'result setting picker');
        check('search results offer Add to set with selectable full settings', await evaluate(`window.findVM('AddToSetDialog').settings.length > 0 || window.findVM('AddToSetDialog').batch.length > 0`));
        await evaluate(`window.findVM('AddToSetDialog').destination = window.findVM('AddToSetDialog').sets[0].id`);
        await sleep(100);
        await evaluate(`document.querySelector('.v-select__selections a[href*="setID="]').click()`);
        await waitFor(`!!window.findVM('SetsView')?.viewedSet`, 10000, 'selected set link');
        check('the selected set name in Add to set opens its score view', true);
    }
    const vueWarnings = warnings.filter(w => /\[Vue warn\]|EXC/.test(w));
    check('no Vue warnings or runtime exceptions', vueWarnings.length === 0, vueWarnings.slice(0, 3).join(' // '));
} catch (e) {
    console.error('\nFATAL:', e.message);
    try { console.error('Browser state:', await evaluate('JSON.stringify({ text: document.body.innerText.slice(-2500), fixture: window.followFixtureState })')); console.error('Warnings:', warnings.slice(-5)); } catch (_) { /* browser gone */ }
    results.push({ name: 'harness', ok: false, detail: e.message });
} finally {
    chrome.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* exiting */ }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
process.exit(failed.length ? 1 : 0);
