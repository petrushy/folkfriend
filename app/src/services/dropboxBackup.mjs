import { DropboxError, contentHash } from './dropboxClient.mjs';
export const sessionPath = id => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new DropboxError('Unsupported session identifier.', 'unsupported');
    return `/sessions/${id}`;
};
const jsonBlob = value => new Blob([JSON.stringify(value)], { type: 'application/json' });
const validNumber = n => Number.isFinite(n) && n >= 0;
export function validateManifest(m, id) {
    if (!m || m.cloudSchema !== 1 || m.schema !== 1 || m.sessionId !== id || !Array.isArray(m.tracks) || !Array.isArray(m.segments) ||
        !validNumber(m.totalSeconds) || !validNumber(m.bytes)) throw new DropboxError('Unfamiliar Dropbox manifest. No files were changed.', 'unsupported');
    const indices = new Set();
    for (const t of m.tracks) {
        if (!Number.isInteger(t.index) || t.index < 0 || typeof t.initBase64 !== 'string' || t.initBase64.length > 4000000) throw new DropboxError('Unfamiliar Dropbox track.', 'unsupported');
    }
    for (const s of m.segments) {
        if (!Number.isInteger(s.index) || s.index < 0 || indices.has(s.index) || !m.tracks.some(t => t.index === s.trackIndex) ||
            !validNumber(s.startSeconds) || !validNumber(s.durationSeconds) || !validNumber(s.bytes) ||
            !Array.isArray(s.chunks) || s.chunks.some(c => !validNumber(c.bytes) || !validNumber(c.startSeconds)) ||
            s.chunks.reduce((n, c) => n + c.bytes, 0) !== s.bytes ||
            !/^[0-9a-f]{64}$/.test(s.contentHash) || !/^segments\/\d+\.(m4a|webm|ogg|bin)$/.test(s.file)) {
            throw new DropboxError('Unfamiliar Dropbox segment.', 'unsupported');
        }
        indices.add(s.index);
    }
    return m;
}
export function validateSession(value, id) {
    if (!value || value.schema !== 1 || !value.session || value.session.id !== id || !Array.isArray(value.session.tunes) ||
        !validNumber(value.session.startedAt)) throw new DropboxError('Unfamiliar Dropbox session. No files were changed.', 'unsupported');
    return value.session;
}
async function encodeBlob(blob) {
    if (!blob) return '';
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text);
}
export function playableManifest(m) {
    return { ...m, tracks: m.tracks.map(t => ({ ...t, init: new Blob([Uint8Array.from(atob(t.initBase64), c => c.charCodeAt(0))], { type: t.mimeType }) })) };
}
// All mutations are serialized by the integration layer. Reads must succeed and
// schemas must be understood before any upload, overwrite or delete is attempted.
export async function backupSession(client, session, local, readSegment, extension, expectedSessionRev) {
    const root = sessionPath(session.id);
    const remote = await client.json(`${root}/audio-manifest.json`);
    const previousSession = await client.json(`${root}/session.json`);
    if (expectedSessionRev !== undefined && (previousSession?.rev || null) !== expectedSessionRev) throw new DropboxError('Dropbox session changed during backup. Retry after reviewing it.', 'conflict');
    if (remote) validateManifest(remote.value, session.id);
    if (previousSession) validateSession(previousSession.value, session.id);
    if (remote && remote.value.segments.some(old => !local.segments.some(s => s.index === old.index && s.bytes === old.bytes && s.startSeconds === old.startSeconds && s.durationSeconds === old.durationSeconds && s.trackIndex === old.trackIndex))) {
        throw new DropboxError('Dropbox contains audio absent from this device. No files were overwritten.', 'conflict');
    }
    const manifest = { ...local, cloudSchema: 1, tracks: [], segments: [] };
    for (const track of local.tracks) {
        const { init, ...metadata } = track;
        manifest.tracks.push({ ...metadata, initBase64: await encodeBlob(init) });
    }
    for (const meta of local.segments) {
        const segment = await readSegment(session.id, meta.index);
        if (!segment || !segment.blob || segment.blob.size !== meta.bytes) throw new DropboxError('Local audio could not be read. Backup is incomplete.', 'local');
        const track = local.tracks.find(t => t.index === meta.trackIndex);
        const file = `segments/${String(meta.index).padStart(6, '0')}.${extension(track.mimeType || local.mimeType)}`;
        const uploaded = await client.immutable(`${root}/${file}`, segment.blob);
        manifest.segments.push({ ...meta, chunks: segment.chunks, file, contentHash: uploaded.content_hash });
    }
    // The complete session is recoverable without Firebase. CAS also protects
    // simultaneous updates by another tab/device between the read and write.
    await client.upload(`${root}/session.json`, jsonBlob({ schema: 1, session }), previousSession);
    await client.upload(`${root}/audio-manifest.json`, jsonBlob(manifest), remote);
    return manifest;
}
export async function downloadSegment(client, manifest, index) {
    validateManifest(manifest, manifest.sessionId);
    const meta = manifest.segments.find(s => s.index === index);
    if (!meta) return null;
    const { blob } = await client.request('files/download', { path: `${sessionPath(manifest.sessionId)}/${meta.file}` });
    if (blob.size !== meta.bytes || await contentHash(blob) !== meta.contentHash) throw new DropboxError('Dropbox audio verification failed.', 'integrity');
    return { ...meta, sessionId: manifest.sessionId, blob };
}
