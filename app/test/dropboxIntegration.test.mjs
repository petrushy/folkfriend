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
    async folders() { return [{ name: 's1' }]; }
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
async function load({ enabled = true, expired = false, active = false } = {}) {
    const f = { db: new Map(), client: new FakeClient(), sessions: [{ id: 's1', startedAt: 1, name: 'Original', tunes: [] }],
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
export const store = { getLiveSessionsStrict: async () => structuredClone(f.sessions), upsertLiveSession: async s => f.sessions.push(s) };
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
    assert.match(whole[0], /^\/recordings\/1970-01-01 \d{4} Original\.m4a$/,
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
    assert.match(f.client.moves[0][1], /The Cobblestone\.m4a$/);
    assert.ok(!f.client.files.has(before), 'and no orphan left behind');
});

console.log(`\n${passed} Dropbox coordinator tests passed`);
