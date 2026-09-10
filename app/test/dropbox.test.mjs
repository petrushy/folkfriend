import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DropboxClient, DropboxError, contentHash } from '../src/services/dropboxClient.mjs';
import { backupSession, downloadSegment, validateManifest, validateSession, playableManifest, sessionPath } from '../src/services/dropboxBackup.mjs';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
const blob = new Blob(['header-payload'], { type: 'audio/mp4' });
const session = { id: 'session-1', startedAt: 123, name: 'An evening', tunes: [{ tuneId: 4, audioStartSeconds: 1 }] };
const local = { schema: 1, sessionId: session.id, updatedAt: 1, totalSeconds: 3, bytes: blob.size, mimeType: 'audio/mp4',
    tracks: [{ index: 0, init: new Blob(['header']), mimeType: 'audio/mp4', startSeconds: 0, durationSeconds: 3 }],
    segments: [{ index: 0, trackIndex: 0, startSeconds: 0, durationSeconds: 3, bytes: blob.size }], mutedRanges: [{ from: 1, to: 2 }] };
const segment = { ...local.segments[0], blob, chunks: [{ bytes: 6, startSeconds: 0, init: true }, { bytes: 8, startSeconds: 1 }] };
const extension = () => 'm4a';
class FakeDropbox {
    files = new Map(); writes = []; failPath = ''; readFailure = false; rev = 0;
    async json(path) { if (this.readFailure) throw new DropboxError('read failed', 'network'); const f = this.files.get(path); return f ? { value: JSON.parse(await f.blob.text()), rev: f.rev } : null; }
    async metadata(path) { return this.files.get(path) || null; }
    async upload(path, blob, previous) {
        if (path === this.failPath) throw new DropboxError('upload interrupted', 'network');
        const old = this.files.get(path);
        if ((old?.rev || null) !== (previous?.rev || null)) throw new DropboxError('conflict', 'conflict');
        const value = { blob, size: blob.size, content_hash: await contentHash(blob), rev: String(++this.rev) };
        this.files.set(path, value); this.writes.push(path); return value;
    }
    async immutable(path, blob) {
        const old = await this.metadata(path);
        if (old) { assert.equal(old.content_hash, await contentHash(blob)); return old; }
        return this.upload(path, blob);
    }
    async request(_, { path }) { return { blob: this.files.get(path).blob }; }
}
const root = sessionPath(session.id);
await test('audio and full session precede manifest; headers, chunk offsets and mute ranges survive JSON', async () => {
    const c = new FakeDropbox();
    const manifest = await backupSession(c, session, local, async () => segment, extension);
    assert.deepEqual(c.writes, [`${root}/segments/000000.m4a`, `${root}/session.json`, `${root}/audio-manifest.json`]);
    validateManifest(manifest, session.id);
    assert.equal(await playableManifest(manifest).tracks[0].init.text(), 'header');
    assert.deepEqual(manifest.segments[0].chunks, segment.chunks);
    assert.deepEqual(manifest.mutedRanges, local.mutedRanges);
    assert.deepEqual(validateSession((await c.json(`${root}/session.json`)).value, session.id), session);
    assert.equal(await (await downloadSegment(c, manifest, 0)).blob.text(), await blob.text());
});
await test('interrupted segment upload never publishes a manifest; retry completes', async () => {
    const c = new FakeDropbox(); c.failPath = `${root}/segments/000000.m4a`;
    await assert.rejects(backupSession(c, session, local, async () => segment, extension));
    assert.equal(c.files.has(`${root}/audio-manifest.json`), false);
    c.failPath = ''; await backupSession(c, session, local, async () => segment, extension);
    assert.equal(c.files.has(`${root}/audio-manifest.json`), true);
});
await test('interrupted manifest upload reuses immutable audio on retry', async () => {
    const c = new FakeDropbox(); c.failPath = `${root}/audio-manifest.json`;
    await assert.rejects(backupSession(c, session, local, async () => segment, extension));
    c.failPath = ''; await backupSession(c, session, local, async () => segment, extension);
    assert.equal(c.writes.filter(p => p.includes('/segments/')).length, 1);
});
await test('failed cloud read causes zero uploads', async () => {
    const c = new FakeDropbox(); c.readFailure = true;
    await assert.rejects(backupSession(c, session, local, async () => segment, extension)); assert.equal(c.writes.length, 0);
});
await test('unfamiliar cloud manifest causes zero uploads and retains remote data', async () => {
    const c = new FakeDropbox(); await c.upload(`${root}/audio-manifest.json`, new Blob(['{"schema":99}'])); c.writes = [];
    await assert.rejects(backupSession(c, session, local, async () => segment, extension), e => e.code === 'unsupported');
    assert.equal(c.writes.length, 0); assert.equal((await c.json(`${root}/audio-manifest.json`)).value.schema, 99);
});
await test('a stale local snapshot cannot truncate a cloud recording', async () => {
    const c = new FakeDropbox(); await backupSession(c, session, local, async () => segment, extension); c.writes = [];
    await assert.rejects(backupSession(c, session, { ...local, segments: [] }, async () => segment, extension), e => e.code === 'conflict');
    assert.equal(c.writes.length, 0);
});
await test('a concurrent session edit between preflight and upload is rejected', async () => {
    const c = new FakeDropbox(); await backupSession(c, session, local, async () => segment, extension); c.writes = [];
    await assert.rejects(backupSession(c, session, local, async () => segment, extension, 'old-revision'), e => e.code === 'conflict');
    assert.equal(c.writes.length, 0);
});
await test('missing local audio never publishes session metadata or manifest', async () => {
    const c = new FakeDropbox(); await assert.rejects(backupSession(c, session, local, async () => null, extension)); assert.equal(c.writes.length, 0);
});
await test('download corruption is detected before playback/cache', async () => {
    const c = new FakeDropbox(); const manifest = await backupSession(c, session, local, async () => segment, extension);
    c.files.get(`${root}/segments/000000.m4a`).blob = new Blob(['wrong-payload!']);
    await assert.rejects(downloadSegment(c, manifest, 0), e => e.code === 'integrity');
});
await test('path traversal and unsupported schemas are rejected', async () => {
    assert.throws(() => sessionPath('../other')); assert.throws(() => sessionPath('a/b'));
    assert.throws(() => validateSession({ schema: 2, session }, session.id));
    const c = new FakeDropbox(); const m = await backupSession(c, session, local, async () => segment, extension);
    m.segments[0].file = '../elsewhere'; assert.throws(() => validateManifest(m, session.id));
});
await test('expired tokens do not make network calls', async () => {
    const c = new DropboxClient({ token: () => ({ accessToken: 'expired', expiresAt: 0 }), fetcher: () => { throw new Error('must not fetch'); } });
    await assert.rejects(c.metadata('/x'), e => e.code === 'auth');
});
await test('authorization, quota and rate errors are distinguished from absent files', async () => {
    for (const [status, detail, code] of [[401, '', 'auth'], [409, 'insufficient_space', 'full'], [429, '', 'rate'], [409, 'path/not_found', 'missing'], [409, 'path/conflict', 'conflict']]) {
        const c = new DropboxClient({ token: () => ({ accessToken: 'ok', expiresAt: Date.now() + 100000 }), fetcher: async () => new Response(detail, { status }) });
        await assert.rejects(c.request('files/get_metadata', { path: '/x' }), e => e.code === code);
    }
});
await test('transport verifies Dropbox hashes and uses add without autorename', async () => {
    let args;
    const c = new DropboxClient({ token: () => ({ accessToken: 'ok', expiresAt: Date.now() + 100000 }), fetcher: async (_, options) => {
        args = JSON.parse(options.headers['Dropbox-API-Arg']);
        return Response.json({ size: blob.size, content_hash: 'wrong', rev: '1' });
    } });
    await assert.rejects(c.upload('/test', blob), e => e.code === 'integrity');
    assert.equal(args.mode, 'add'); assert.equal(args.autorename, false); assert.equal(args.strict_conflict, true);
});
await test('immutable content mismatch cannot overwrite remote audio', async () => {
    let uploads = 0;
    const c = new DropboxClient({ token: () => ({ accessToken: 'ok', expiresAt: Date.now() + 100000 }) });
    c.metadata = async () => ({ size: blob.size, content_hash: 'wrong' }); c.upload = async () => uploads++;
    await assert.rejects(c.immutable('/test', blob), e => e.code === 'conflict'); assert.equal(uploads, 0);
});
await test('Dropbox content hash uses 4 MiB blocks, including empty files', async () => {
    assert.equal(await contentHash(new Blob([])), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const bytes = new Uint8Array(4194305).fill(65);
    const first = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice(0, 4194304)));
    const second = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice(4194304)));
    const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array([...first, ...second]))).toString('hex');
    assert.equal(await contentHash(new Blob([bytes])), expected);
});
console.log(`\n${passed} Dropbox tests passed`);
