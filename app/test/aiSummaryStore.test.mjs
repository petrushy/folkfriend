// Unit tests for how AI tune summaries are stored and synced.
//
// Run with:  node app/test/aiSummaryStore.test.mjs
//
// The summary cache has one property that matters more than any detail of its
// implementation: a user who paid for a note must not lose it. The ways that
// could happen are not obvious from reading the code —
//
//   - favourites sync replaces the whole local array with the remote one, so a
//     second device that has never generated a summary would delete every
//     summary the first device made
//   - the API key sits next to userSettings, which is serialised wholesale into
//     a shareable backup file
//   - a newly added default setting is invisible to anyone who ever saved
//     settings, if the load path picks one object or the other instead of
//     merging them
//
// so those are asserted directly. store.js is loaded from source with its
// imports rewritten to in-memory fakes; no browser, IndexedDB or Firebase.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-ai-summary-store');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`);
    }
}

const FAKES = {
    'fake-idb.mjs': `
export const __db = new Map();
export async function get(key) { return __db.get(key); }
export async function set(key, value) { __db.set(key, value); }
export async function del(key) { __db.delete(key); }
`,
    'fake-eventbus.mjs': `
export const __events = [];
export default { $emit: (name, payload) => __events.push({ name, payload }), $on() {}, $off() {} };
`,
    // Records every outbound push so tests can assert that a restored summary is
    // propagated rather than silently kept local.
    'fake-sync.mjs': `
export const __pushes = [];
export let __onChange = null;
export function pushFavourites(uid, items) {
    __pushes.push(JSON.parse(JSON.stringify(items)));
}
export function subscribe(uid, getLocal, onChange) {
    __onChange = onChange;
    return () => { __onChange = null; };
}
export function __reset() { __pushes.length = 0; __onChange = null; }
`,
    'fake-ai.mjs': `
export const DEFAULT_MODEL = 'claude-haiku-4-5';
export function estimateCostUsd(usage, model) {
    const input = (usage && usage.input_tokens) || 0;
    const output = (usage && usage.output_tokens) || 0;
    return input * 1e-6 + output * 5e-6;
}
`,
    'fake-firebase-auth.mjs': `
export class GoogleAuthProvider {}
export const browserPopupRedirectResolver = {};
export async function signInWithPopup() {}
export async function signOut() {}
`,
    'fake-firebase-analytics.mjs': `
export function logEvent() {}
`,
};

class FakeLocalStorage {
    constructor() { this.map = new Map(); }
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
    setItem(key, value) { this.map.set(key, String(value)); }
    removeItem(key) { this.map.delete(key); }
}

// store.js reads localStorage in its constructor, so the fake has to be in place
// before the module is imported.
async function loadStore({ storedSettings = null } = {}) {
    for (const [name, source] of Object.entries(FAKES)) {
        await writeFile(path.join(tmpDir, name), source);
    }
    await writeFile(
        path.join(tmpDir, 'schema.mjs'),
        await readFile(path.join(srcDir, 'js', 'schema.js'), 'utf8'),
    );
    // Real, not a fake: places.mjs is pure geometry with no browser surface, so
    // there is nothing to stub and stubbing it would weaken the store tests
    // that depend on proximity matching.
    await writeFile(
        path.join(tmpDir, 'places.mjs'),
        await readFile(path.join(srcDir, 'js', 'places.mjs'), 'utf8'),
    );

    let source = await readFile(path.join(srcDir, 'services', 'store.js'), 'utf8');
    const replacements = [
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from 'idb-keyval'", "from './fake-idb.mjs'"],
        ["from '@/js/schema'", "from './schema.mjs'"],
        ["from '@/js/places.mjs'", "from './places.mjs'"],
        ["from './aiSummary.js'", "from './fake-ai.mjs'"],
        ["from 'firebase/auth'", "from './fake-firebase-auth.mjs'"],
        ["from './sync.js'", "from './fake-sync.mjs'"],
        ["from 'firebase/analytics'", "from './fake-firebase-analytics.mjs'"],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in store.js`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'store.mjs'), source);

    globalThis.localStorage = new FakeLocalStorage();
    if (storedSettings) {
        globalThis.localStorage.setItem('userSettings', JSON.stringify(storedSettings));
    }

    // The fakes must be imported by their bare path — exactly the specifier
    // store.mjs resolves — or we get a second copy of each module and the store
    // writes into a different Map than the one the test inspects. They are
    // therefore singletons across loads, so reset their state here instead.
    const idb = await import(path.join(tmpDir, 'fake-idb.mjs'));
    const sync = await import(path.join(tmpDir, 'fake-sync.mjs'));
    idb.__db.clear();
    sync.__reset();

    // Only store.mjs is cache-busted, so each test gets a fresh Store instance
    // (and therefore a fresh constructor read of localStorage).
    const mod = await import(`${path.join(tmpDir, 'store.mjs')}?v=${Math.random()}`);
    return { store: mod.default, idb, sync };
}

function favourite(settingID, tuneID) {
    return {
        result: { settingID: String(settingID), setting: { tune_id: tuneID }, displayName: 'A Tune' },
        timestamp: 1,
        tags: [],
        tempo: null,
    };
}

await mkdir(tmpDir, { recursive: true });

console.log('\nuserSettings defaults');

await test('a newly added default reaches a user who already saved settings', async () => {
    // The old load path was `stored || DEFAULTS`, so every key added after a
    // user first opened Settings read as undefined for them forever.
    const { store } = await loadStore({ storedSettings: { advancedMode: true } });
    assert.equal(store.userSettings.advancedMode, true, 'stored value must win');
    assert.equal(store.userSettings.aiSummariesEnabled, false);
    assert.equal(store.userSettings.aiSummaryModel, 'claude-haiku-4-5');
    assert.equal(store.userSettings.recordingTimeLimitSecs, 10);
});

await test('a restored backup written before a setting existed still gets it', async () => {
    const { store } = await loadStore();
    await store.importUserData(JSON.stringify({
        version: 1,
        userSettings: { advancedMode: true },
        favouriteItems: [],
        historyItems: [],
    }));
    assert.equal(store.userSettings.advancedMode, true);
    assert.equal(store.userSettings.aiSummaryModel, 'claude-haiku-4-5',
        'an old backup must not leave new settings undefined');
});

console.log('\nwhich tune databases are selected');

await test('a fresh install searches thesession only', async () => {
    // folkwiki's detections are unreliable enough that having it on out of the
    // box makes the app look worse than it is to a first-time user.
    const { store } = await loadStore();
    assert.deepEqual(store.selectedDatasets(), ['thesession']);
});

await test('an install from before the setting existed keeps folkwiki', async () => {
    // It fetched both files unconditionally, so this user has been searching
    // folkwiki all along. Narrowing that silently is a regression, not a
    // default change: they would search for a Swedish tune they have found
    // before, get nothing, and have no way to tell why.
    const { store } = await loadStore({ storedSettings: { advancedMode: true } });
    assert.deepEqual(store.selectedDatasets(), ['thesession', 'folkwiki']);
});

await test('an explicit selection always wins, in both directions', async () => {
    const off = await loadStore({ storedSettings: { tuneDatasets: ['thesession'] } });
    assert.deepEqual(off.store.selectedDatasets(), ['thesession'],
        'a user who turned folkwiki off must not have it handed back');

    const on = await loadStore({ storedSettings: { tuneDatasets: ['thesession', 'folkwiki'] } });
    assert.deepEqual(on.store.selectedDatasets(), ['thesession', 'folkwiki']);

    const none = await loadStore({ storedSettings: { tuneDatasets: [] } });
    assert.deepEqual(none.store.selectedDatasets(), [],
        'an explicit empty selection is an honest answer and is honoured');
});

await test('turning folkwiki back on sticks across a reload', async () => {
    const { store } = await loadStore();
    store.userSettings.tuneDatasets = ['thesession', 'folkwiki'];
    await store.updateUserSettings(store.userSettings);

    const reloaded = await loadStore({
        storedSettings: JSON.parse(globalThis.localStorage.getItem('userSettings')),
    });
    assert.deepEqual(reloaded.store.selectedDatasets(), ['thesession', 'folkwiki']);
});

await test('a backup from before the setting existed restores both', async () => {
    const { store } = await loadStore();
    await store.importUserData(JSON.stringify({
        version: 1,
        userSettings: { advancedMode: true },
        favouriteItems: [],
        historyItems: [],
    }));
    assert.deepEqual(store.selectedDatasets(), ['thesession', 'folkwiki'],
        'restoring a backup must not narrow what its owner could find');
});

await test('a backup that names a selection restores exactly that', async () => {
    const { store } = await loadStore();
    await store.importUserData(JSON.stringify({
        version: 4,
        userSettings: { tuneDatasets: ['thesession'] },
        favouriteItems: [],
        historyItems: [],
    }));
    assert.deepEqual(store.selectedDatasets(), ['thesession']);
});

console.log('\nAPI key storage');

await test('the API key is never included in an exported backup', async () => {
    const { store } = await loadStore();
    store.setApiKey('sk-ant-secret');
    assert.equal(store.getApiKey(), 'sk-ant-secret');
    assert.equal(store.hasApiKey(), true);

    // Exports are files users email to themselves and share between devices.
    const exported = await store.exportUserData();
    assert.ok(!exported.includes('sk-ant-secret'), 'the key must not leak into the backup');

    store.clearApiKey();
    assert.equal(store.getApiKey(), '');
    assert.equal(store.hasApiKey(), false);
});

await test('a blank key clears rather than storing whitespace', async () => {
    const { store } = await loadStore();
    store.setApiKey('  sk-ant-padded  ');
    assert.equal(store.getApiKey(), 'sk-ant-padded');
    store.setApiKey('   ');
    assert.equal(store.hasApiKey(), false);
});

console.log('\nsummary cache');

await test('a summary round-trips and is capped in length', async () => {
    const { store } = await loadStore();
    await store.setAiSummary('7', { text: 'The Kesh is a jig.', model: 'claude-haiku-4-5', generatedAt: 1000 });

    const got = await store.getAiSummary('7');
    assert.equal(got.text, 'The Kesh is a jig.');
    assert.equal(got.model, 'claude-haiku-4-5');
    assert.equal(await store.countAiSummaries(), 1);
    // Numeric and string tune IDs must hit the same record.
    assert.ok(await store.getAiSummary(7));
    assert.equal(await store.getAiSummary('999'), null);

    // Favourites sync pushes the whole array as one document, so an unbounded
    // note is the field most able to bloat it.
    await store.setAiSummary('8', { text: 'x'.repeat(5000) });
    const long = await store.getAiSummary('8');
    assert.ok(long.text.length <= 1200, `expected <=1200 chars, got ${long.text.length}`);
});

await test('an empty summary is not stored', async () => {
    const { store } = await loadStore();
    await store.setAiSummary('7', { text: '' });
    await store.setAiSummary('7', null);
    await store.setAiSummary('', { text: 'orphan' });
    assert.equal(await store.countAiSummaries(), 0);
});

await test('the summary is mirrored onto matching favourites only', async () => {
    const { store, idb } = await loadStore();
    idb.__db.set('favouriteItems', [
        favourite(101, '7'),
        favourite(102, '7'),
        favourite(201, '9'),
    ]);

    await store.setAiSummary('7', { text: 'Note for tune 7.', generatedAt: 5 });

    const items = idb.__db.get('favouriteItems');
    assert.equal(items[0].aiSummary.text, 'Note for tune 7.');
    assert.equal(items[1].aiSummary.text, 'Note for tune 7.');
    assert.equal(items[2].aiSummary, undefined, 'an unrelated tune must not be touched');
});

await test('clearing removes the cache and the mirrors', async () => {
    const { store, idb } = await loadStore();
    idb.__db.set('favouriteItems', [favourite(101, '7')]);
    await store.setAiSummary('7', { text: 'Note.', generatedAt: 5 });

    await store.clearAiSummaries();

    assert.equal(await store.countAiSummaries(), 0);
    // Leaving the mirror behind would let the next sync or import restore
    // exactly what the user just asked to delete.
    assert.equal(idb.__db.get('favouriteItems')[0].aiSummary, undefined);
    // Absence is ambiguous, so the deletion has to be recorded positively.
    assert.ok(idb.__db.get('favouriteItems')[0].aiSummaryDeletedAt > 0,
        'a cleared favourite must carry a tombstone, not just a missing field');
});

await test('a clear on one device is not undone by a second device', async () => {
    // The confirm dialog promises the clear "removes them from your synced
    // favourites". Encoding the deletion as a missing `aiSummary` cannot deliver
    // that: to the receiving device it is indistinguishable from a device that
    // never generated the note, which _reapplyAiSummaries is *supposed* to
    // repair from its durable cache. It would restore the note and push it back.
    const { store, idb, sync } = await loadStore();

    // This device is the phone: it holds the note in its own durable cache.
    idb.__db.set('favouriteItems', [favourite(101, '7')]);
    await store.setAiSummary('7', { text: 'Note on the phone.', generatedAt: 1000 });
    await store.onSignedIn({ uid: 'user-1' });
    sync.__pushes.length = 0;

    // The laptop clears, and its favourites arrive here.
    const cleared = favourite(101, '7');
    cleared.aiSummaryDeletedAt = 2000;
    await sync.__onChange('favourites', [cleared]);

    assert.equal(await store.getAiSummary('7'), null,
        'a deletion newer than the local copy must be honoured');
    assert.equal(idb.__db.get('favouriteItems')[0].aiSummary, undefined,
        'the mirror must not be put back');
    assert.ok(
        !sync.__pushes.some(items => items[0] && items[0].aiSummary),
        'the deleted note must not be pushed back to Firestore',
    );
});

await test('a clear survives a stale note pushed by a device that missed it', async () => {
    // Favourites sync is whole-document last-writer-wins, and sync.js decides
    // which side is newer by a document-level Date.now(). So a device that had
    // not yet processed the clear can touch an unrelated favourite, push its
    // whole array — still carrying the note, and with no tombstone, because it
    // never saw one — and that write is legitimately newer at the document
    // level. The incoming array is then the only thing reconciliation looks at,
    // so a tombstone that lives only on the outgoing favourites is gone.
    const { store, idb, sync } = await loadStore();
    idb.__db.set('favouriteItems', [favourite(101, '7')]);
    await store.setAiSummary('7', { text: 'Note.', generatedAt: 1000 });
    await store.onSignedIn({ uid: 'user-1' });

    await store.clearAiSummaries();
    assert.equal(await store.getAiSummary('7'), null);
    sync.__pushes.length = 0;

    // The stale device's whole-document write arrives.
    const stale = favourite(101, '7');
    stale.aiSummary = { text: 'Note.', generatedAt: 1000 };
    await sync.__onChange('favourites', [stale]);

    assert.equal(await store.getAiSummary('7'), null,
        'a note older than the clear must not be resurrected');
    assert.equal(idb.__db.get('favouriteItems')[0].aiSummary, undefined,
        'the stale mirror must be stripped, not adopted');
    // Otherwise the two devices flip the note back and forth forever; the
    // device that knows about the deletion has to state it again.
    assert.ok(
        sync.__pushes.some(items => items[0] && items[0].aiSummaryDeletedAt),
        'the tombstone must be re-pushed so the stale device learns of it',
    );
});

await test('a device that only hears about a clear defends against it too', async () => {
    // Three devices. The watermark protects the device that pressed Clear, but
    // deletion protection has to be transitive: a device that merely *receives*
    // the tombstone deletes its copy and is then defenceless, because it has
    // neither a cached note to compare against nor a watermark of its own. A
    // third device that never saw the clear resurrects the note there.
    const { store, idb, sync } = await loadStore();

    // This device is B: it holds the note, and did not perform the clear.
    idb.__db.set('favouriteItems', [favourite(101, '7')]);
    await store.setAiSummary('7', { text: 'Note.', generatedAt: 1000 });
    await store.onSignedIn({ uid: 'user-1' });

    // A cleared at t=2000; its tombstone arrives here.
    const cleared = favourite(101, '7');
    cleared.aiSummaryDeletedAt = 2000;
    await sync.__onChange('favourites', [cleared]);
    assert.equal(await store.getAiSummary('7'), null, 'the tombstone must be honoured');
    sync.__pushes.length = 0;

    // C was offline through all of that and now pushes its stale whole document.
    const stale = favourite(101, '7');
    stale.aiSummary = { text: 'Note.', generatedAt: 1000 };
    await sync.__onChange('favourites', [stale]);

    assert.equal(await store.getAiSummary('7'), null,
        'hearing about a clear must confer the same protection as performing one');
    assert.equal(idb.__db.get('favouriteItems')[0].aiSummary, undefined);
    assert.ok(
        sync.__pushes.some(items => items[0] && items[0].aiSummaryDeletedAt),
        'the deletion must be re-stated so the stale device learns of it',
    );
});

await test('an adopted clear still admits a note generated after it', async () => {
    // The promotion must not turn into a permanent embargo on the device that
    // merely heard about the clear.
    const { store, idb, sync } = await loadStore();
    idb.__db.set('favouriteItems', [favourite(101, '7')]);
    await store.setAiSummary('7', { text: 'Note.', generatedAt: 1000 });
    await store.onSignedIn({ uid: 'user-1' });

    const cleared = favourite(101, '7');
    cleared.aiSummaryDeletedAt = 2000;
    await sync.__onChange('favourites', [cleared]);

    const fresh = favourite(101, '7');
    fresh.aiSummary = { text: 'Regenerated on a third device.', generatedAt: 3000 };
    await sync.__onChange('favourites', [fresh]);

    assert.equal((await store.getAiSummary('7')).text, 'Regenerated on a third device.');
});

await test('a clear also blocks a stale note this device never held', async () => {
    // This is why the guard is a single watermark and not a per-tune tombstone
    // map: there is no local marker for a tune this device never had a note for,
    // and the stale write carries none either, so a per-tune design has nothing
    // to consult and adopts the note.
    const { store, idb, sync } = await loadStore();
    idb.__db.set('favouriteItems', [favourite(101, '7'), favourite(201, '9')]);
    await store.setAiSummary('7', { text: 'Only tune 7 here.', generatedAt: 1000 });
    await store.onSignedIn({ uid: 'user-1' });

    await store.clearAiSummaries();

    // The other device holds a note for tune 9, which this one never generated.
    const stale = [favourite(101, '7'), favourite(201, '9')];
    stale[1].aiSummary = { text: 'Note for 9, made elsewhere.', generatedAt: 1500 };
    await sync.__onChange('favourites', stale);

    assert.equal(await store.getAiSummary('9'), null,
        'a note predating the clear must not arrive as a novelty');
    assert.equal(await store.countAiSummaries(), 0);
});

await test('a note generated elsewhere after the clear is still accepted', async () => {
    // The watermark must not become a permanent embargo on syncing.
    const { store, idb, sync } = await loadStore();
    idb.__db.set('favouriteItems', [favourite(101, '7')]);
    await store.setAiSummary('7', { text: 'Old note.', generatedAt: 1000 });
    await store.onSignedIn({ uid: 'user-1' });
    await store.clearAiSummaries();

    const fresh = favourite(101, '7');
    fresh.aiSummary = { text: 'Generated on the phone after the clear.', generatedAt: Date.now() + 1000 };
    await sync.__onChange('favourites', [fresh]);

    assert.equal((await store.getAiSummary('7')).text, 'Generated on the phone after the clear.');
});

await test('regenerating on this device after a real clear sticks', async () => {
    const { store, idb, sync } = await loadStore();
    idb.__db.set('favouriteItems', [favourite(101, '7')]);
    await store.setAiSummary('7', { text: 'Old note.', generatedAt: 1000 });
    await store.onSignedIn({ uid: 'user-1' });
    await store.clearAiSummaries();

    await store.setAiSummary('7', { text: 'Paid for again.', generatedAt: Date.now() + 1000 });

    // The echo of our own push comes back; it must not be read as stale.
    const echoed = JSON.parse(JSON.stringify(idb.__db.get('favouriteItems')));
    await sync.__onChange('favourites', echoed);

    assert.equal((await store.getAiSummary('7')).text, 'Paid for again.',
        'the watermark must not eat a note generated after it');
});

await test('restoring a backup outranks an earlier clear', async () => {
    const { store, idb } = await loadStore();
    idb.__db.set('favouriteItems', [favourite(101, '7')]);
    await store.setAiSummary('7', { text: 'Note.', generatedAt: 1000 });
    await store.clearAiSummaries();

    // Importing is an explicit request for the file's contents, so its notes
    // must not be silently filtered by a clear that happened afterwards.
    const item = favourite(101, '7');
    item.aiSummary = { text: 'Note from the backup.', generatedAt: 1000 };
    await store.importUserData(JSON.stringify({
        version: 3, favouriteItems: [item], historyItems: [], userSettings: {},
    }));

    assert.equal((await store.getAiSummary('7')).text, 'Note from the backup.');
});

await test('regenerating after a clear beats the tombstone', async () => {
    const { store, idb, sync } = await loadStore();
    idb.__db.set('favouriteItems', [favourite(101, '7')]);
    await store.onSignedIn({ uid: 'user-1' });

    // A clear happened at t=2000 on some device, and this device then paid for a
    // fresh note. The old marker must not delete it on the next snapshot.
    const cleared = favourite(101, '7');
    cleared.aiSummaryDeletedAt = 2000;
    await sync.__onChange('favourites', [cleared]);

    await store.setAiSummary('7', { text: 'Regenerated.', generatedAt: 3000 });
    assert.equal(idb.__db.get('favouriteItems')[0].aiSummaryDeletedAt, undefined,
        'writing a newer note must drop the stale tombstone');

    const echoed = favourite(101, '7');
    echoed.aiSummaryDeletedAt = 2000;
    echoed.aiSummary = { text: 'Regenerated.', generatedAt: 3000 };
    await sync.__onChange('favourites', [echoed]);

    assert.equal((await store.getAiSummary('7')).text, 'Regenerated.',
        'a note newer than the deletion must survive');
});

console.log('\nsync — the invariant that matters');

await test('an inbound snapshot without summaries does not destroy them', async () => {
    const { store, idb, sync } = await loadStore();
    idb.__db.set('favouriteItems', [favourite(101, '7')]);
    await store.setAiSummary('7', { text: 'Locally generated note.', generatedAt: 5000 });

    await store.onSignedIn({ uid: 'user-1' });
    assert.ok(sync.__onChange, 'sync subscription must be established');

    // A second device that has never generated a summary pushes its favourites.
    // Under a naive wholesale replace, this is where the user loses the note.
    await sync.__onChange('favourites', [favourite(101, '7')]);

    const summary = await store.getAiSummary('7');
    assert.ok(summary, 'the local summary must survive the snapshot');
    assert.equal(summary.text, 'Locally generated note.');

    // The local cache is a separate IndexedDB key, so it survives on its own.
    // The loss the naive version causes is subtler: the mirror is stripped, and
    // the next push from this device propagates that deletion to every other
    // device. So the summary must be re-applied to the stored array too.
    const stored = idb.__db.get('favouriteItems')[0];
    assert.ok(stored.aiSummary, 'the mirror must be restored, not left stripped');
    assert.equal(stored.aiSummary.text, 'Locally generated note.');
    assert.ok(
        sync.__pushes.some(items => items[0] && items[0].aiSummary),
        'the restored summary must be pushed back to Firestore',
    );
});

await test('an inbound snapshot with a summary we lack is harvested', async () => {
    const { store, sync } = await loadStore();
    await store.onSignedIn({ uid: 'user-1' });

    const incoming = favourite(101, '7');
    incoming.aiSummary = { text: 'Made on the phone.', generatedAt: 9000 };
    await sync.__onChange('favourites', [incoming]);

    const summary = await store.getAiSummary('7');
    assert.ok(summary, 'a summary arriving only via sync must be harvested');
    assert.equal(summary.text, 'Made on the phone.');
});

await test('the newer of two summaries wins', async () => {
    const { store, idb, sync } = await loadStore();
    idb.__db.set('favouriteItems', [favourite(101, '7')]);
    await store.setAiSummary('7', { text: 'Older local note.', generatedAt: 1000 });
    await store.onSignedIn({ uid: 'user-1' });

    const newer = favourite(101, '7');
    newer.aiSummary = { text: 'Newer remote note.', generatedAt: 2000 };
    await sync.__onChange('favourites', [newer]);
    assert.equal((await store.getAiSummary('7')).text, 'Newer remote note.');

    const older = favourite(101, '7');
    older.aiSummary = { text: 'Stale remote note.', generatedAt: 500 };
    await sync.__onChange('favourites', [older]);
    assert.equal((await store.getAiSummary('7')).text, 'Newer remote note.', 'a stale echo must not win');
});

await test('a restored backup carries its summaries into the cache', async () => {
    const { store } = await loadStore();
    const item = favourite(101, '7');
    item.aiSummary = { text: 'Note from the backup.', generatedAt: 3000 };

    await store.importUserData(JSON.stringify({
        version: 3,
        favouriteItems: [item],
        historyItems: [],
        userSettings: {},
    }));

    assert.equal((await store.getAiSummary('7')).text, 'Note from the backup.');
});

console.log('\nspend tracking');

await test('usage accumulates across calls and resets', async () => {
    const { store } = await loadStore();
    assert.deepEqual(store.getAiUsage(), { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

    store.recordAiUsage({ input_tokens: 1000, output_tokens: 200 }, 'claude-haiku-4-5');
    store.recordAiUsage({ input_tokens: 500, output_tokens: 100 }, 'claude-haiku-4-5');

    const usage = store.getAiUsage();
    assert.equal(usage.calls, 2);
    assert.equal(usage.inputTokens, 1500);
    assert.equal(usage.outputTokens, 300);
    assert.ok(usage.costUsd > 0);

    store.resetAiUsage();
    assert.equal(store.getAiUsage().calls, 0);
});

await test('a malformed usage record does not produce NaN', async () => {
    const { store } = await loadStore();
    globalThis.localStorage.setItem('aiSummaryUsage', 'not json');
    assert.equal(store.getAiUsage().calls, 0);

    store.recordAiUsage(undefined, 'claude-haiku-4-5');
    const usage = store.getAiUsage();
    assert.equal(usage.calls, 1);
    assert.equal(usage.inputTokens, 0);
    assert.ok(Number.isFinite(usage.costUsd));
});

await rm(tmpDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
