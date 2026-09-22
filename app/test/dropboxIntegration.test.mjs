// Exercise the real backup coordinator with in-memory IDB and Dropbox. The
// recorder/store seams are fakes, so these do not test physical microphone I/O.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { DropboxError, contentHash } from '../src/services/dropboxClient.mjs';
const directory = new URL('./.tmp-dropbox/', import.meta.url);
await mkdir(directory, { recursive: true });
const services = new URL('../src/services/', import.meta.url);
const blob = new Blob(['headerpayload']);
const local = { schema: 1, sessionId: 's1', totalSeconds: 3, bytes: blob.size, updatedAt: 1, mimeType: 'audio/mp4',
    tracks: [{ index: 0, init: new Blob(['header']), mimeType: 'audio/mp4' }],
    segments: [{ index: 0, trackIndex: 0, startSeconds: 0, durationSeconds: 3, bytes: blob.size }] };
class FakeClient {
    files = new Map(); writes = []; deletes = []; moves = []; failPath = ''; failReads = false; rev = 0;
    async json(path) {
        if (this.failReads) throw new DropboxError('Cloud read failed.', 'network');
        const f = this.files.get(path); return f ? { value: JSON.parse(await f.blob.text()), rev: f.rev } : null;
    }
    async metadata(path) { return this.files.get(path) || null; }
    async upload(path, blob, previous) {
        if (path === this.failPath) throw new DropboxError('Cloud full.', 'full');
        const old = this.files.get(path);
        if ((old?.rev || null) !== (previous?.rev || null)) throw new DropboxError('Conflict.', 'conflict');
        const m = { blob, size: blob.size, rev: String(++this.rev), content_hash: await contentHash(blob) };
        this.files.set(path, m); this.writes.push(path); return m;
    }
    async immutable(path, blob) { return await this.metadata(path) || this.upload(path, blob); }
    // The real one chunks above 8 MB and delegates below it. The chunking
    // itself is tested against the real client in dropbox.test.mjs; here it
    // only has to behave like an upload.
    async uploadLarge(path, blob, previous = null) { return this.upload(path, blob, previous); }
    async list(path) {
        const prefix = path.endsWith('/') ? path : `${path}/`;
        return [...this.files.keys()]
            .filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
            .map(k => ({ '.tag': 'file', name: k.slice(prefix.length) }));
    }
    async folders() { return [{ name: 's1' }]; }
    // The real client reads this from a listing of /deleted; the fake serves
    // it from the same files map, so a marker a test writes is one the
    // coordinator can see.
    async deletedSessions() {
        return new Set((await this.list('/deleted'))
            .map(e => /^(.+)\.json$/.exec(e.name))
            .filter(Boolean).map(m => m[1]));
    }
    async move(from, to) {
        const f = this.files.get(from);
        if (!f) return null;
        this.files.delete(from); this.files.set(to, f); this.moves.push([from, to]); return f;
    }
    async request(endpoint, args) {
        if (endpoint === 'files/delete_v2') {
            const { path } = args;
            this.deletes.push(path);
            this.files.delete(path);
            for (const k of this.files.keys()) if (k.startsWith(path + '/')) this.files.delete(k);
        }
        return {};
    }
}
let sequence = 0;
// `shareWith` gives a SECOND device: the same Dropbox account and the same
// session records (which is what Firebase sync means), but its own IndexedDB
// and its own copy of the audio — which is the whole point, since what one
// device knows about a deletion is exactly what the other one does not.
async function load({ enabled = true, expired = false, active = false, shareWith = null } = {}) {
    const f = { db: new Map(), client: shareWith ? shareWith.client : new FakeClient(),
        sessions: shareWith ? shareWith.sessions : [{ id: 's1', startedAt: 1, name: 'Original', tunes: [] }],
        locals: [structuredClone(local)], recorder: { sessionId: active ? 's1' : null, isActive: active, isRecording: active }, deletedLocal: [], events: [] };
    globalThis.__dropboxFixture = f;
    const storage = new Map([['folkfriend.dropbox.enabled', String(enabled)], ['folkfriend.dropbox.account', 'account-1'],
        ['folkfriend.dropbox.auth', JSON.stringify({ accessToken: 'test', expiresAt: expired ? 0 : Date.now() + 1000000 })]]);
    globalThis.localStorage = { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
    const index = sequence++;
    const fakeURL = new URL(`fake-${index}.mjs`, directory);
    await writeFile(fakeURL, `
const f = globalThis.__dropboxFixture;
export const get = async k => f.db.get(k);
export const set = async (k,v) => { f.db.set(k, structuredClone(v)); };
export const del = async k => f.db.delete(k);
export const keys = async () => [...f.db.keys()];
export const Vue = { observable: x => x, set: (o,k,v) => { o[k] = v; } };
export const bus = { $emit: (...args) => f.events.push(args), $on() {} };
// Matches the real store: an upsert REPLACES a record of the same id and
// stamps updatedAt above what it was handed, which is what makes a conflict
// resolution the newest copy. A fake that only pushed could not see either.
export const store = {
    getLiveSessionsStrict: async () => structuredClone(f.sessions),
    upsertLiveSession: async s => {
        const record = { ...s, updatedAt: Math.max(Date.now(), (s.updatedAt || 0) + 1) };
        const index = f.sessions.findIndex(existing => existing.id === record.id);
        if (index === -1) f.sessions.push(record); else f.sessions[index] = record;
        return record;
    },
};
export const recorder = f.recorder;
export const listManifests = async () => structuredClone(f.locals);
export const readManifest = async id => f.locals.find(m => m.sessionId === id);
export const readSegment = async () => ({ blob: new Blob(['headerpayload']), chunks: [{ startSeconds: 0, bytes: 13, init: true }] });
// The whole-recording copy is built from the same local segments the player's
// "Export audio" uses — one continuous file per track.
export const buildClip = async () => ({ blob: new Blob(['headerpayload']), mimeType: 'audio/mp4', startSeconds: 0, endSeconds: 3, trackIndex: 0 });
export const fileExtensionFor = () => 'm4a';
export const headroomBytes = async () => 10000000;
export const deleteSessionAudio = async id => { f.locals = f.locals.filter(m => m.sessionId !== id); f.deletedLocal.push(id); };
export const configureCloudAudio = p => { f.provider = p; };
export class DropboxClient { constructor() { return f.client; } }
export { DropboxError, base64url } from ${JSON.stringify(new URL('dropboxClient.mjs', services).href)};
`);
    let source = await readFile(new URL('dropbox.js', services), 'utf8');
    source = source.replace("import Vue from 'vue';", `import { Vue } from '${fakeURL.href}';`)
        .replace("import eventBus from '@/eventBus.js';", `import { bus as eventBus } from '${fakeURL.href}';`)
        .replace("import store from '@/services/store.js';", `import { store } from '${fakeURL.href}';`)
        .replace("import recorder from '@/services/sessionRecorder.js';", `import { recorder } from '${fakeURL.href}';`)
        .replace("from 'idb-keyval'", `from '${fakeURL.href}'`)
        .replace("from '@/services/sessionAudioStore.js'", `from '${fakeURL.href}'`)
        .replace("from './dropboxClient.mjs'", `from '${fakeURL.href}'`)
        .replace("from './dropboxStorage.mjs'", `from '${new URL('dropboxStorage.mjs', services).href}'`)
        .replace("from './dropboxBackup.mjs'", `from '${new URL('dropboxBackup.mjs', services).href}'`);
    const target = new URL(`coordinator-${index}.mjs`, directory); await writeFile(target, source);
    return { f, api: await import(target.href) };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
await test('disabled backup never reads Dropbox or uploads local audio', async () => {
    const { f, api } = await load({ enabled: false }); f.client.failReads = true;
    await api.syncDropbox(true); assert.equal(f.client.writes.length, 0); assert.equal(api.backupStatus('s1'), 'Local only');
});
await test('completed backup preserves local originals and stores a durable receipt', async () => {
    const { f, api } = await load(); await api.syncDropbox(true);
    assert.equal(api.backupStatus('s1'), 'Backed up'); assert.equal(f.deletedLocal.length, 0);
    assert.ok(f.db.get('dropbox:account-1:receipt:s1').verifiedAt);
});
await test('active recording never reports its pending audio as backed up', async () => {
    const { api } = await load({ active: true }); await api.syncDropbox(true); assert.equal(api.backupStatus('s1'), 'Syncing');
});
await test('quota failure retains local audio and retries after session metadata has advanced', async () => {
    const { f, api } = await load(); f.client.failPath = '/sessions/s1/audio-manifest.json';
    await api.syncDropbox(true); assert.equal(api.backupStatus('s1'), 'Dropbox full'); assert.equal(f.deletedLocal.length, 0);
    f.sessions[0].name = 'Renamed while offline'; f.client.failPath = '';
    await api.syncDropbox(true); assert.equal(api.backupStatus('s1'), 'Backed up');
    assert.equal((await f.client.json('/sessions/s1/session.json')).value.session.name, 'Renamed while offline');
});
await test('expired authorization reports reconnect without touching local audio', async () => {
    const { f, api } = await load({ expired: true }); await api.syncDropbox(true);
    assert.equal(api.backupStatus('s1'), 'Reconnect required'); assert.equal(f.client.writes.length, 0); assert.equal(f.deletedLocal.length, 0);
});
await test('unknown manifests prevent cloud deletion and automatic uploads', async () => {
    const { f, api } = await load(); await api.syncDropbox(true);
    f.client.files.get('/sessions/s1/audio-manifest.json').blob = new Blob(['{"schema":99}']);
    await assert.rejects(api.deleteDropboxCopy('s1')); assert.equal(f.client.deletes.length, 0);
    f.locals[0].updatedAt++; f.client.writes = []; await api.syncDropbox(true); assert.equal(f.client.writes.length, 0);
});
await test('read failures prevent cloud deletion', async () => {
    const { f, api } = await load(); await api.syncDropbox(true); f.client.failReads = true;
    await assert.rejects(api.deleteDropboxCopy('s1')); assert.equal(f.client.deletes.length, 0);
});
await test('local deletion leaves a playable cloud manifest and does not delete cloud files', async () => {
    const { f, api } = await load(); await api.syncDropbox(true); await api.deleteLocalCopy('s1');
    assert.deepEqual(f.deletedLocal, ['s1']); assert.equal(f.client.deletes.length, 0);
    assert.equal((await api.remoteManifest('s1')).segments.length, 1);
});
await test('cloud deletion leaves local audio and suppresses automatic re-upload', async () => {
    const { f, api } = await load(); await api.syncDropbox(true); await api.deleteDropboxCopy('s1');
    assert.equal(f.deletedLocal.length, 0); f.client.writes = [];
    await api.syncDropbox(true); assert.equal(f.client.writes.length, 0); assert.equal(api.backupStatus('s1'), 'Local only');
    await api.enableSessionBackup('s1'); assert.equal(api.backupStatus('s1'), 'Backed up');
});
await test('restore rebuilds missing records but never replaces existing tune edits', async () => {
    const { f, api } = await load(); await api.syncDropbox(true); f.sessions = [];
    assert.equal(await api.restoreDropboxSessions(), 1); assert.equal(f.sessions[0].name, 'Original');
    f.sessions[0].name = 'Local edit'; assert.equal(await api.restoreDropboxSessions(), 0); assert.equal(f.sessions[0].name, 'Local edit');
});
await test('metadata edits after removing local audio are backed up', async () => {
    const { f, api } = await load(); await api.syncDropbox(true); await api.deleteLocalCopy('s1'); f.sessions[0].name = 'Updated';
    await api.syncDropbox(true); assert.equal((await f.client.json('/sessions/s1/session.json')).value.session.name, 'Updated');
});
await test('disconnect removes credentials without deleting originals or cloud copies', async () => {
    const { f, api } = await load(); await api.syncDropbox(true); await api.disconnectDropbox();
    assert.equal(localStorage.getItem('folkfriend.dropbox.auth'), null); assert.equal(f.deletedLocal.length, 0); assert.equal(f.client.deletes.length, 0);
});
await test('storage refresh keeps the last total on failure without changing backup status', async () => {
    const { f, api } = await load(); await api.syncDropbox(true);
    f.client.request = async endpoint => {
        if (endpoint === 'files/list_folder') return { entries: [{ '.tag': 'file', path_lower: '/audio', size: 1500 }], has_more: false };
        throw Object.assign(new Error('scope'), { code: 'scope' });
    };
    await api.refreshDropboxStorage(true);
    assert.equal(api.dropboxState.storage.storedBytes, 1500);
    assert.equal(api.dropboxState.storage.quotaState, 'permission');
    f.client.request = async () => { throw new Error('offline'); };
    await api.refreshDropboxStorage(true);
    assert.equal(api.dropboxState.storage.storedBytes, 1500);
    assert.ok(api.dropboxState.storage.error);
    assert.equal(api.backupStatus('s1'), 'Backed up');
});
await test('a late storage result cannot repopulate usage after disconnect', async () => {
    const { f, api } = await load(); let release;
    f.client.request = endpoint => endpoint === 'files/list_folder'
        ? new Promise(resolve => { release = resolve; })
        : Promise.resolve({ used: 0, allocation: { '.tag': 'individual', allocated: 1000 } });
    const pending = api.refreshDropboxStorage(true);
    await api.disconnectDropbox();
    release({ entries: [{ '.tag': 'file', path_lower: '/audio', size: 1500 }], has_more: false });
    await pending;
    assert.equal(api.dropboxState.storage.storedBytes, null);
});
await test('backup progress never speaks on the recorder\'s event', async () => {
    // sessionAudioState carries the RECORDER's state, and the session bar
    // renders straight from that payload. Emitting it from here with only a
    // sessionId left every recorder field undefined, so a backup landing
    // mid-session cleared the REC chip, the muted indicator and any storage
    // error while recording carried on — on a 30 s timer, in the direction that
    // understates recording.
    const { f, api } = await load();
    f.events.length = 0;
    await api.syncDropbox(true);

    const names = f.events.map(([name]) => name);
    assert.ok(names.includes('dropboxStateChanged'), 'it announces itself');
    assert.ok(!names.includes('sessionAudioState'),
        'and never on the event that means something else');
});

await test('a whole-file copy is only made for a FINISHED session', async () => {
    // A live session's last track is still growing, so building the file now
    // means re-uploading all of it on every new segment — hundreds of megabytes
    // an hour, usually over mobile data.
    const { f, api } = await load();
    await api.setWholeRecordings(true);
    assert.ok(!f.client.writes.some(p => p.startsWith('/recordings/')),
        'nothing while the session is still open');

    f.sessions[0].endedAt = 2;
    f.locals[0].updatedAt++;
    await api.syncDropbox(true);
    const whole = f.client.writes.filter(p => p.startsWith('/recordings/'));
    assert.equal(whole.length, 1);
    assert.match(whole[0], /^\/recordings\/1970-01-01 \d{4} Original \[s1-track-0\]\.m4a$/,
        'named by date and session, where a person would look');
});

await test('the whole-file copy is off unless asked for', async () => {
    const { f, api } = await load();
    f.sessions[0].endedAt = 2;
    await api.syncDropbox(true);
    assert.ok(!f.client.writes.some(p => p.startsWith('/recordings/')));
});

await test('deleting the Dropbox copy removes the whole file too', async () => {
    // It lives OUTSIDE the session folder, which is the price of being
    // somewhere a person would look — so the delete has to reach both, or three
    // hours of a room stays behind in a folder the user browses.
    const { f, api } = await load();
    await api.setWholeRecordings(true);
    f.sessions[0].endedAt = 2;
    f.locals[0].updatedAt++;
    await api.syncDropbox(true);
    const whole = f.client.writes.find(p => p.startsWith('/recordings/'));
    assert.ok(whole);

    await api.deleteDropboxCopy('s1');
    assert.ok(f.client.deletes.includes(whole), 'the whole file was deleted as well');
    assert.ok(f.client.deletes.includes('/sessions/s1'));
});

await test('an unchanged whole file is not uploaded twice', async () => {
    const { f, api } = await load();
    await api.setWholeRecordings(true);
    f.sessions[0].endedAt = 2;
    f.locals[0].updatedAt++;
    await api.syncDropbox(true);

    f.client.writes = [];
    f.locals[0].updatedAt++;
    await api.syncDropbox(true);
    assert.ok(!f.client.writes.some(p => p.startsWith('/recordings/')),
        'the same audio is not sent twice');
});

await test('renaming a session MOVES its whole file rather than re-sending it', async () => {
    // The filename carries the session name, so a rename changes it. Uploading
    // again would cost a hundred megabytes AND leave the old file behind —
    // a recording orphaned under a name the user has just rejected.
    const { f, api } = await load();
    await api.setWholeRecordings(true);
    f.sessions[0].endedAt = 2;
    f.locals[0].updatedAt++;
    await api.syncDropbox(true);
    const before = f.client.writes.find(p => p.startsWith('/recordings/'));

    f.client.writes = [];
    f.sessions[0].name = 'The Cobblestone';
    await api.syncDropbox(true);

    assert.ok(!f.client.writes.some(p => p.startsWith('/recordings/')), 'nothing re-uploaded');
    assert.equal(f.client.moves.length, 1);
    assert.equal(f.client.moves[0][0], before);
    assert.match(f.client.moves[0][1], /The Cobblestone \[s1-track-0\]\.m4a$/);
    assert.ok(!f.client.files.has(before), 'and no orphan left behind');
});

console.log(`\n${passed} Dropbox coordinator tests passed`);

await test('another device can delete whole recordings without local inventory', async () => {
    const { f, api } = await load();
    f.sessions[0].endedAt = 2;
    await api.setWholeRecordings(true);
    const whole = f.client.writes.find(p => p.startsWith('/recordings/'));
    assert.ok(whole);
    f.db.clear();
    await api.deleteDropboxCopy('s1');
    assert.equal(f.client.files.has(whole), false);
});
await test('unfamiliar whole-file inventory prevents all deletion', async () => {
    const { f, api } = await load(); await api.syncDropbox(true);
    await f.client.upload('/sessions/s1/whole-recordings.json', new Blob([JSON.stringify({ schema: 1, sessionId: 's1', paths: ['/recordings/other.m4a'] })]));
    await assert.rejects(api.deleteDropboxCopy('s1'));
    assert.equal(f.client.deletes.length, 0);
});

await test('interrupted cloud deletion retries while retaining its remote inventory', async () => {
    const { f, api } = await load(); f.sessions[0].endedAt = 2;
    await api.setWholeRecordings(true);
    const whole = f.client.writes.find(p => p.startsWith('/recordings/'));
    const request = f.client.request.bind(f.client);
    f.client.request = async (endpoint, args) => {
        if (args.path === whole) throw new DropboxError('Offline', 'network');
        return request(endpoint, args);
    };
    await assert.rejects(api.deleteDropboxCopy('s1'));
    assert.ok(f.client.files.has('/sessions/s1/audio-manifest.json'));
    f.client.request = request;
    await api.deleteDropboxCopy('s1');
    // Everything the session had is gone; what is left is the marker saying so,
    // which is the one file a deletion CREATES.
    assert.deepEqual([...f.client.files.keys()], ['/deleted/s1.json']);
});
await test('lost final delete response can be retried after the folder is gone', async () => {
    const { f, api } = await load(); await api.syncDropbox(true);
    const request = f.client.request.bind(f.client);
    f.client.request = async (endpoint, args) => {
        await request(endpoint, args);
        throw new DropboxError('Response lost', 'network');
    };
    await assert.rejects(api.deleteDropboxCopy('s1'));
    f.client.request = request;
    await api.deleteDropboxCopy('s1');
    assert.equal(f.db.has('dropbox:account-1:deletion:s1'), false);
    assert.equal(api.backupStatus('s1'), 'Local only');
});

// ---- A session received over Firebase, not recorded on this device --------
//
// The iPad records and backs up; the iPhone gets the session record over
// Firestore and has no local audio. Its copy of the record legitimately
// differs from the one in Dropbox — `lastActiveAt` is stamped on every save,
// the name and place label are re-derived per device, and a Firestore round
// trip reorders the fields — and the old guard read any difference as
// somebody else having changed the cloud copy. It refused for ever, behind a
// Retry button that could never succeed.
// ---- Deleting the cloud copy is a SHARED fact -----------------------------

await test('a deletion on one device is not undone by another', async () => {
    // "Delete Dropbox copy" wrote its exclusion into the deleting device's own
    // IndexedDB and nowhere else. Any other device still holding that
    // session's local audio then saw a session with audio and no cloud copy,
    // did exactly what it is for, and put the whole recording back — the
    // deletion undone by a machine that was never told about it.
    const a = await load();
    await a.api.syncDropbox(true);
    assert.ok(a.f.client.files.has('/sessions/s1/audio-manifest.json'));

    const b = await load({ shareWith: a.f });
    await b.api.syncDropbox(true);

    await a.api.deleteDropboxCopy('s1');
    assert.equal(a.f.client.files.has('/sessions/s1/audio-manifest.json'), false);

    // The other device comes to verify, as it does every few minutes.
    b.f.db.delete('dropbox:account-1:receipt:s1');
    b.f.client.writes = [];
    await b.api.syncDropbox(true);

    assert.deepEqual(b.f.client.writes, [], 'nothing was uploaded again');
    assert.equal(b.api.backupStatus('s1'), 'Local only');
    assert.equal(b.f.deletedLocal.length, 0, 'and its own audio is left alone');
    assert.equal(b.f.db.get('dropbox:account-1:excluded:s1'), true,
        'it adopted the exclusion, so later passes need no listing at all');
});

await test('settled timer passes throttle deletion checks, while manual retries reconcile', async () => {
    const { f, api } = await load();
    await api.syncDropbox(true);
    let listings = 0;
    const list = f.client.list.bind(f.client);
    f.client.list = async (path) => { listings++; return list(path); };
    await api.syncDropbox();
    assert.equal(listings, 0);
    await api.syncDropbox(true);
    assert.equal(listings, 1);
});

await test('turning backup back on clears the shared marker too', async () => {
    const { f, api } = await load();
    await api.syncDropbox(true);
    await api.deleteDropboxCopy('s1');
    assert.ok(f.client.files.has('/deleted/s1.json'));

    await api.enableSessionBackup('s1');
    assert.equal(f.client.files.has('/deleted/s1.json'), false,
        'or the next pass, here or anywhere else, would switch it straight off again');
    assert.equal(api.backupStatus('s1'), 'Backed up');
});

await test('recovery does not rebuild a session whose cloud copy was deleted', async () => {
    const { f, api } = await load();
    await api.syncDropbox(true);
    // An interrupted delete leaves the marker and the folder, which is the one
    // state where the folder alone would resurrect the record.
    await f.client.upload('/deleted/s1.json', new Blob([JSON.stringify({ schema: 1, sessionId: 's1', deletedAt: 1 })]));
    f.sessions.length = 0;
    assert.equal(await api.restoreDropboxSessions(), 0);
    assert.equal(f.sessions.length, 0);
});

// ---- A conflict the user can actually settle ------------------------------

async function conflicted() {
    const { f, api } = await load();
    await api.syncDropbox(true);
    await api.deleteLocalCopy('s1');
    const path = '/sessions/s1/session.json';
    await f.client.upload(path, new Blob([JSON.stringify({ schema: 1,
        session: { id: 's1', startedAt: 1, name: 'Edited elsewhere', tunes: [{ tuneId: 9 }], updatedAt: 9_000 } })]),
    f.client.files.get(path));
    f.sessions[0] = { id: 's1', startedAt: 1, name: 'Kept here', tunes: [], updatedAt: 5_000 };
    f.db.delete('dropbox:account-1:receipt:s1');
    await api.syncDropbox(true);
    assert.equal(api.backupStatus('s1'), 'Needs review');
    return { f, api, path };
}

await test('the two copies can be compared before choosing between them', async () => {
    // The refusal told the user to "restore or review that copy", and there was
    // nothing in the app that could do either — "Recover missing sessions"
    // deliberately skips a session that already exists locally, so unless
    // Firebase happened to deliver the newer version the Retry button could
    // never succeed.
    const { api } = await conflicted();
    const both = await api.sessionConflict('s1');
    assert.equal(both.local.name, 'Kept here');
    assert.equal(both.local.tunes, 0);
    assert.equal(both.remote.name, 'Edited elsewhere');
    assert.equal(both.remote.tunes, 1);
    assert.ok(both.remote.updatedAt > both.local.updatedAt, 'which is why it was refused');
});

await test('keeping this device\'s copy unsticks the backup', async () => {
    const { f, api, path } = await conflicted();
    await api.resolveSessionConflict('s1', 'local');
    assert.equal((await f.client.json(path)).value.session.name, 'Kept here');
    assert.equal(api.backupStatus('s1'), 'Backed up');
    assert.equal(api.sessionConflictMessage('s1'), '');
    // Stamped above BOTH copies, so the decision rides Firestore to every
    // other device rather than being re-fought on the next pass.
    assert.ok(f.sessions[0].updatedAt > 9_000);
});

await test('adopting the Dropbox copy replaces the local record with it', async () => {
    const { f, api, path } = await conflicted();
    await api.resolveSessionConflict('s1', 'remote');
    assert.equal(f.sessions[0].name, 'Edited elsewhere');
    assert.equal(f.sessions[0].tunes.length, 1);
    assert.ok(f.sessions[0].updatedAt > 9_000);
    assert.equal((await f.client.json(path)).value.session.name, 'Edited elsewhere');
    assert.equal(api.backupStatus('s1'), 'Backed up');
});

await test('a resolution outranks a cloud copy written by a fast clock', async () => {
    // The stamp has to be taken above BOTH copies, not just above this
    // device's. A phone whose clock runs ten minutes ahead writes a session
    // stamped in the future, and a resolution stamped from the local record
    // alone is still the older one — so the backup is refused again on the
    // very next pass and the button reads as having done nothing.
    const { f, api } = await load();
    await api.syncDropbox(true);
    await api.deleteLocalCopy('s1');
    const path = '/sessions/s1/session.json';
    const ahead = Date.now() + 600_000;
    await f.client.upload(path, new Blob([JSON.stringify({ schema: 1,
        session: { id: 's1', startedAt: 1, name: 'From the fast phone', tunes: [], updatedAt: ahead } })]),
    f.client.files.get(path));
    f.sessions[0] = { id: 's1', startedAt: 1, name: 'Kept here', tunes: [], updatedAt: 5_000 };
    f.db.delete('dropbox:account-1:receipt:s1');
    await api.syncDropbox(true);
    assert.equal(api.backupStatus('s1'), 'Needs review');

    await api.resolveSessionConflict('s1', 'local');
    assert.ok(f.sessions[0].updatedAt > ahead);
    assert.equal((await f.client.json(path)).value.session.name, 'Kept here');
    assert.equal(api.backupStatus('s1'), 'Backed up');
});

await test('a resolution has to name which copy it keeps', async () => {
    const { api } = await conflicted();
    await assert.rejects(api.resolveSessionConflict('s1', 'whichever'));
    assert.equal(api.backupStatus('s1'), 'Needs review');
});

await test('a session synced from another device backs up despite differing from the cloud copy', async () => {
    const { f, api } = await load();
    await api.syncDropbox(true);
    await api.deleteLocalCopy('s1');
    // This device never backed the session up itself — it holds the cloud
    // manifest because it PLAYED the audio. Without clearing the receipt the
    // test passes through the "a copy this device wrote is its own" shortcut
    // and never reaches the rule it is here to pin.
    f.db.delete('dropbox:account-1:receipt:s1');

    // What Firestore hands back: same session, its own field order, a fresh
    // lastActiveAt, a locally re-derived label, and a newer version stamp.
    f.sessions[0] = { endedAt: null, id: 's1', lastActiveAt: 9_000, name: 'Original',
        placeName: '', startedAt: 1, tunes: [], updatedAt: 9_000 };

    f.client.writes = [];
    await api.syncDropbox(true);

    assert.equal(api.backupStatus('s1'), 'Backed up');
    assert.ok(f.client.writes.includes('/sessions/s1/session.json'), 'the newer copy reaches Dropbox');
    assert.equal((await f.client.json('/sessions/s1/session.json')).value.session.lastActiveAt, 9_000);
    assert.equal(api.dropboxState.error, '');
});

await test('a STRICTLY newer cloud copy is still refused', async () => {
    // The whole point of the guard: a device that has been offline while
    // another one edited the session must not push its stale copy over the top.
    const { f, api } = await load();
    await api.syncDropbox(true);
    await api.deleteLocalCopy('s1');

    const path = '/sessions/s1/session.json';
    const previous = f.client.files.get(path);
    await f.client.upload(path, new Blob([JSON.stringify({ schema: 1,
        session: { id: 's1', startedAt: 1, name: 'Edited elsewhere', tunes: [], updatedAt: 9_000 } })]), previous);

    f.sessions[0] = { id: 's1', startedAt: 1, name: 'Stale local', tunes: [], updatedAt: 5_000 };
    f.db.delete('dropbox:account-1:receipt:s1');
    f.client.writes = [];
    await api.syncDropbox(true);

    assert.equal(f.client.writes.length, 0, 'no files were overwritten');
    assert.equal((await f.client.json(path)).value.session.name, 'Edited elsewhere');
    // "Needs review", not "Backup pending": retrying cannot change this one,
    // and saying pending is what left a button being pressed for ever against
    // a state it had no way to move.
    assert.equal(api.backupStatus('s1'), 'Needs review');
    assert.match(api.sessionConflictMessage('s1'), /newer version/);
});

await test('one conflicted session does not block the metadata sync of the next', async () => {
    // The metadata loop broke on ANY error, so a single session stuck in
    // conflict silently stopped every session behind it from syncing at all —
    // which is how one unresolvable copy takes the whole backup down.
    const { f, api } = await load();
    f.sessions.push({ id: 's2', startedAt: 2, name: 'Second', tunes: [] });
    f.locals.push({ ...structuredClone(local), sessionId: 's2' });
    f.client.folders = async () => [{ name: 's1' }, { name: 's2' }];
    await api.syncDropbox(true);
    await api.deleteLocalCopy('s1');
    await api.deleteLocalCopy('s2');

    const path = '/sessions/s1/session.json';
    await f.client.upload(path, new Blob([JSON.stringify({ schema: 1,
        session: { id: 's1', startedAt: 1, name: 'Edited elsewhere', tunes: [], updatedAt: 9_000 } })]), f.client.files.get(path));
    f.sessions[0] = { id: 's1', startedAt: 1, name: 'Stale local', tunes: [], updatedAt: 5_000 };
    f.sessions[1] = { id: 's2', startedAt: 2, name: 'Renamed', tunes: [], updatedAt: 5_000 };
    f.db.delete('dropbox:account-1:receipt:s1');
    f.db.delete('dropbox:account-1:receipt:s2');

    await api.syncDropbox(true);

    assert.equal(api.backupStatus('s1'), 'Needs review');
    assert.equal(api.backupStatus('s2'), 'Backed up');
    assert.equal((await f.client.json('/sessions/s2/session.json')).value.session.name, 'Renamed');
});

await test('whole recording waits for a durable final segment even after endedAt is saved', async () => {
    const { f, api } = await load();
    f.sessions[0].endedAt = 2;
    f.locals[0].finalizedAt = null;
    await api.setWholeRecordings(true);
    assert.ok(!f.client.writes.some(p => p.startsWith('/recordings/')));
    assert.equal(api.backupStatus('s1'), 'Syncing');
    f.locals[0].finalizedAt = Date.now();
    await api.syncDropbox(true);
    assert.equal(f.client.writes.filter(p => p.startsWith('/recordings/')).length, 1);
    assert.equal(api.backupStatus('s1'), 'Backed up');
});

await test('legacy manifest cannot finalize while the recorder still owns it', async () => {
    const { f, api } = await load({ active: true });
    f.sessions[0].endedAt = 2;
    await api.setWholeRecordings(true);
    assert.ok(!f.client.writes.some(p => p.startsWith('/recordings/')));
    f.recorder.sessionId = null; f.recorder.isActive = false; f.recorder.isRecording = false;
    await api.syncDropbox(true);
    assert.equal(f.client.writes.filter(p => p.startsWith('/recordings/')).length, 1);
});

// Node's Web Locks represent tabs of ONE origin. These scenarios represent
// separate devices, which cannot share that lock.
async function separateDevices(action) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    try { await action(); }
    finally {
        if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
        else delete globalThis.navigator;
    }
}

await test('an upload that already read the deletion state cleans up after a concurrent delete', () => separateDevices(async () => {
    const a = await load(); await a.api.syncDropbox(true);
    const b = await load({ shareWith: a.f });
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const paused = new Promise(resolve => { entered = resolve; });
    const read = a.f.client.json.bind(a.f.client);
    let hold = true;
    a.f.client.json = async path => {
        const result = await read(path);
        if (hold && path === '/deleted/s1.json') {
            hold = false; entered(); await gate;
        }
        return result;
    };
    const uploading = b.api.syncDropbox(true);
    await paused;
    await a.api.deleteDropboxCopy('s1');
    release(); await uploading;
    assert.deepEqual([...a.f.client.files.keys()], ['/deleted/s1.json']);
    assert.equal(b.api.backupStatus('s1'), 'Local only');
    assert.equal(b.f.deletedLocal.length, 0);
}));

await test('a whole-file upload finishing after its inventory was deleted is removed too', () => separateDevices(async () => {
    const a = await load(); await a.api.syncDropbox(true);
    a.f.sessions[0].endedAt = 2;
    const b = await load({ shareWith: a.f });
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const paused = new Promise(resolve => { entered = resolve; });
    const upload = a.f.client.uploadLarge.bind(a.f.client);
    a.f.client.uploadLarge = async (...args) => { entered(); await gate; return upload(...args); };
    const uploading = b.api.setWholeRecordings(true);
    await paused;
    await a.api.deleteDropboxCopy('s1');
    release(); await uploading;
    assert.deepEqual([...a.f.client.files.keys()], ['/deleted/s1.json']);
    assert.equal(b.api.backupStatus('s1'), 'Local only');
}));

await test('a later pass cleans crashed-upload residue even without a local session or inventory', async () => {
    const { f, api } = await load(); await api.syncDropbox(true);
    await api.deleteDropboxCopy('s1');
    // Bytes a different uploader committed after the delete, then crashed.
    await f.client.upload('/sessions/s1/segments/000000.m4a', new Blob(['late']));
    await f.client.upload('/recordings/late [s1-track-0].m4a', new Blob(['late']));
    await f.client.upload('/recordings/legacy.m4a', new Blob(['unowned']));
    f.sessions = []; f.locals = [];
    await api.syncDropbox(true);
    assert.deepEqual([...f.client.files.keys()].sort(), ['/deleted/s1.json', '/recordings/legacy.m4a']);
});

await test('unreadable or unknown deletion markers never authorize cleanup', async () => {
    const { f, api } = await load(); await api.syncDropbox(true);
    await f.client.upload('/deleted/s1.json', new Blob(['{"schema":99}']));
    f.client.deletes = [];
    await api.syncDropbox(true);
    assert.deepEqual(f.client.deletes, []);
    assert.ok(f.client.files.has('/sessions/s1/audio-manifest.json'));
});
