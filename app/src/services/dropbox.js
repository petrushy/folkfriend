import Vue from 'vue';
import { readDropboxStorage } from './dropboxStorage.mjs';
import { get, set, del, keys } from 'idb-keyval';
import eventBus from '@/eventBus.js';
import store from '@/services/store.js';
import recorder from '@/services/sessionRecorder.js';
import { listManifests, readManifest, readSegment, buildClip, fileExtensionFor, headroomBytes, deleteSessionAudio, configureCloudAudio } from '@/services/sessionAudioStore.js';
import { DropboxClient, DropboxError, base64url } from './dropboxClient.mjs';
import { backupSession, backupWholeRecordings, downloadSegment, playableManifest, validateWholeRecordings, validateManifest, validateSession, sessionPath } from './dropboxBackup.mjs';

// Public OAuth identifier, deliberately shipped with the browser app.
const APP_KEY = process.env.VUE_APP_DROPBOX_APP_KEY || 'zl982bc269ijgda';
const AUTH_KEY = 'folkfriend.dropbox.auth';
const ENABLED_KEY = 'folkfriend.dropbox.enabled';
const ACCOUNT_KEY = 'folkfriend.dropbox.account';
const SPACE_KEY = 'folkfriend.dropbox.spacePermission';
// Opt-in: a whole-session copy DOUBLES what a session costs in Dropbox and
// uploads the same bytes a second time, usually over mobile data. Worth it when
// you want to open a recording in something else; not worth imposing.
const WHOLE_KEY = 'folkfriend.dropbox.wholeRecordings';
const emptyStorage = () => ({ storedBytes: null, availableBytes: null, quotaState: 'unavailable', checkedAt: 0, attemptedAt: 0, loading: false, error: '' });
const cachePrefix = 'dropboxCache:';
const CACHE_LIMIT = 32 * 1024 * 1024;
const json = value => JSON.stringify(value);
function stored(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
let auth;
try { auth = JSON.parse(stored(AUTH_KEY)); } catch (_) { auth = null; }
let account = stored(ACCOUNT_KEY) || '';
export const dropboxState = Vue.observable({ configured: !!APP_KEY, enabled: stored(ENABLED_KEY) === 'true',
    connected: !!auth && auth.expiresAt > Date.now() + 30000, busy: false, error: '', sessions: {}, revision: 0, storage: emptyStorage(),
    wholeRecordings: stored(WHOLE_KEY) === 'true' });

// Turning it ON re-runs the backup so finished sessions already in Dropbox get
// their whole-file copy without waiting for something else to change.
export function setWholeRecordings(enabled) {
    dropboxState.wholeRecordings = !!enabled;
    try { localStorage.setItem(WHOLE_KEY, String(!!enabled)); } catch (_) { /* private mode */ }
    dropboxState.revision++;
    if (enabled) { retryAt = 0; return syncDropbox(true); }
    return Promise.resolve();
}
const client = new DropboxClient({ token: () => dropboxState.enabled ? auth : null });
let queue = Promise.resolve();
let retryAt = 0;
const serialize = fn => {
    // Coordinate tabs where Web Locks is available; revision checks remain the
    // protection against other devices and browsers without Web Locks.
    const run = () => globalThis.navigator?.locks
        ? navigator.locks.request('folkfriend-dropbox', fn) : fn();
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
};
const key = (kind, id) => `dropbox:${account}:${kind}:${id}`;
// Dropbox's OWN event, deliberately not sessionAudioState.
//
// That event carries the recorder's state — whether it is recording, whether it
// is muted, why it stopped — and the session bar renders straight from the
// payload. Re-using it with a Dropbox-shaped payload left every one of those
// fields undefined, so the bar cleared the REC chip, the muted indicator and
// any storage error WHILE RECORDING CONTINUED, every time a backup finished.
// One event, one meaning.
function changed(id) { dropboxState.revision++; eventBus.$emit('dropboxStateChanged', { sessionId: id }); }
function status(id, label) { Vue.set(dropboxState.sessions, id, label); }
function report(e, id) {
    if (e.code === 'auth') { dropboxState.connected = false; auth = null; localStorage.removeItem(AUTH_KEY); }
    retryAt = Date.now() + Math.max(30000, (e.retryAfter || 0) * 1000);
    const label = e.code === 'auth' ? 'Reconnect required' : e.code === 'full' ? 'Dropbox full' : 'Backup pending';
    if (id) status(id, label);
    dropboxState.error = e.message || 'Dropbox is unavailable. Backup will retry.';
}
export async function refreshDropboxStorage(force = false) {
    const storage = dropboxState.storage;
    if (!dropboxState.enabled || !dropboxState.connected || storage.loading) return;
    if (!force && storage.attemptedAt > Date.now() - 60000) return;
    const requestedAccount = account;
    storage.loading = true;
    storage.attemptedAt = Date.now();
    try {
        const result = await readDropboxStorage(client);
        if (storage !== dropboxState.storage || requestedAccount !== account || !dropboxState.enabled) return;
        Object.assign(storage, result, { error: '' });
    } catch (e) {
        if (storage !== dropboxState.storage || requestedAccount !== account || !dropboxState.enabled) return;
        storage.error = 'Could not refresh Dropbox storage. Try again when connected.';
        if (e.code === 'auth') report(e);
    } finally { storage.loading = false; }
}

export function backupStatus(id) {
    // Read the observable revision even when no status has been set yet.
    void dropboxState.revision;
    if (!dropboxState.enabled) return 'Local only';
    if (!dropboxState.connected) return 'Reconnect required';
    return dropboxState.sessions[id] || 'Local only';
}

// OAuth uses a popup so connecting cannot unload an ongoing recording. The
// callback sends only the code to its opener; verifier/token stay in that tab.
export function handleDropboxCallback() {
    const params = new URLSearchParams(location.search);
    if (!params.get('state')?.startsWith('ffdb-') || !(params.has('code') || params.has('error'))) return false;
    const payload = { type: 'folkfriend-dropbox', state: params.get('state'), code: params.get('code'), error: params.get('error') };
    history.replaceState(null, '', location.pathname);
    // With no opener there is nobody to hand the code to: the popup was
    // blocked, the window that started it is gone, or this is a stale callback
    // URL someone reopened. Claiming the tab then left it showing a line of
    // text with no way back — the app never mounted, for a link the user may
    // simply have had in their history. The query string is already cleared
    // above, so falling through starts FolkFriend normally.
    if (!window.opener) return false;
    window.opener.postMessage(payload, location.origin);
    window.close();
    document.body.textContent = 'Dropbox authorization finished. Return to the FolkFriend window where you connected.';
    return true;
}
export async function connectDropbox({ includeSpaceUsage = stored(SPACE_KEY) === 'true' } = {}) {
    if (!APP_KEY) throw new Error('Dropbox backup is not configured for this installation.');
    const popup = window.open('about:blank', 'folkfriend-dropbox', 'width=600,height=750');
    if (!popup) throw new Error('Allow the Dropbox sign-in popup, then try again.');
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
    const state = `ffdb-${base64url(crypto.getRandomValues(new Uint8Array(24)))}`;
    const redirect = new URL(process.env.BASE_URL || '/', location.origin).href;
    try {
        const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        const code = await new Promise((resolve, reject) => {
            const cleanup = () => { clearInterval(timer); window.removeEventListener('message', receive); };
            const receive = event => {
                if (event.origin !== location.origin || event.source !== popup || event.data?.type !== 'folkfriend-dropbox' || event.data.state !== state) return;
                cleanup();
                if (event.data.error || !event.data.code) reject(new Error('Dropbox connection was cancelled.'));
                else resolve(event.data.code);
            };
            const started = Date.now();
            const timer = setInterval(() => {
                if (popup.closed || Date.now() - started > 300000) { cleanup(); reject(new Error('Dropbox connection was cancelled or timed out.')); }
            }, 1000);
            window.addEventListener('message', receive);
            popup.location.href = `https://www.dropbox.com/oauth2/authorize?${new URLSearchParams({ client_id: APP_KEY, response_type: 'code',
                redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'online',
                scope: 'files.metadata.read files.content.read files.content.write' + (includeSpaceUsage ? ' account_info.read' : '') })}`;
        });
        const response = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams({
            grant_type: 'authorization_code', client_id: APP_KEY, code, code_verifier: verifier, redirect_uri: redirect,
        }) });
        if (!response.ok) throw new Error('Dropbox authorization failed. Please reconnect.');
        const result = await response.json();
        if (!result.access_token || !result.account_id || !(result.expires_in > 0)) throw new Error('Invalid Dropbox authorization response.');
        await serialize(async () => {
            account = result.account_id;
            dropboxState.storage = emptyStorage();
            localStorage.setItem(SPACE_KEY, String(includeSpaceUsage));
            auth = { accessToken: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
            localStorage.setItem(AUTH_KEY, json(auth)); localStorage.setItem(ACCOUNT_KEY, account); localStorage.setItem(ENABLED_KEY, 'true');
            dropboxState.enabled = true; dropboxState.connected = true; dropboxState.sessions = {}; dropboxState.error = ''; retryAt = 0;
        });
        eventBus.$emit('dropboxConnected');
        await syncDropbox();
    } finally { if (!popup.closed) popup.close(); }
}
export async function disconnectDropbox() {
    // Stop scheduling immediately; wait for the one in-flight request chain.
    dropboxState.enabled = false;
    await serialize(async () => {
        auth = null; localStorage.removeItem(AUTH_KEY); localStorage.setItem(ENABLED_KEY, 'false');
        dropboxState.storage = emptyStorage(); localStorage.removeItem(SPACE_KEY);
        dropboxState.connected = false; dropboxState.sessions = {}; dropboxState.error = ''; changed();
    });
}
export function syncDropbox(force = false) {
    if (dropboxState.busy || !dropboxState.enabled) return Promise.resolve();
    if (!force && Date.now() < retryAt) return Promise.resolve();
    dropboxState.busy = true;
    return serialize(async () => {
        try {
            if (!auth || auth.expiresAt <= Date.now() + 30000) throw new DropboxError('Reconnect Dropbox to continue.', 'auth');
            dropboxState.error = '';
            const sessions = await store.getLiveSessionsStrict();
            const manifests = await listManifests();
            for (const local of manifests) {
                if (!dropboxState.enabled) break;
                const id = local.sessionId;
                const session = sessions.find(s => s.id === id);
                if (!session || !local.segments.length || await get(key('excluded', id))) continue;
                try {
                    const fingerprint = json({ local, session });
                    const receipt = await get(key('receipt', id));
                    if (receipt?.fingerprint === fingerprint && receipt.verifiedAt > Date.now() - 300000) {
                        status(id, recorder.sessionId === id && recorder.isRecording ? 'Syncing' : 'Backed up'); continue;
                    }
                    status(id, 'Syncing');
                    // A changed cloud session must never be overwritten by a
                    // stale local editor, including after a crash/reconnect.
                    const remoteSession = await client.json(`${sessionPath(id)}/session.json`);
                    if (remoteSession) {
                        validateSession(remoteSession.value, id);
                        if (json(remoteSession.value.session) !== json(session) && json(remoteSession.value.session) !== receipt?.session && json(remoteSession.value.session) !== receipt?.pendingSession) {
                            throw new DropboxError('The Dropbox session has changed. Restore or review that copy before backing up.', 'conflict');
                        }
                    }
                    await set(key('receipt', id), { ...receipt, pendingSession: json(session) });
                    const cloud = await backupSession(client, session, local, readSegment, fileExtensionFor, remoteSession?.rev || null);
                    await set(key('manifest', id), cloud);
                    if (dropboxState.wholeRecordings) {
                        // Recorded so deletion can find them: a whole recording
                        // lives outside the session folder, which is the price
                        // of it being somewhere a person would look.
                        const paths = await backupWholeRecordings(client, session, cloud, buildClip,
                            fileExtensionFor, await get(key('whole', id)) || []);
                        if (paths.length) await set(key('whole', id), paths);
                    }
                    await set(key('receipt', id), { fingerprint, session: json(session), verifiedAt: Date.now() });
                    status(id, recorder.sessionId === id && recorder.isRecording ? 'Syncing' : 'Backed up'); changed(id);
                } catch (e) { report(e, id); if (['auth', 'full', 'rate', 'network'].includes(e.code) || !e.code) break; }
            }
            for (const session of sessions) {
                const id = session.id;
                if (!dropboxState.enabled || manifests.some(m => m.sessionId === id) || await get(key('excluded', id))) continue;
                const cached = await get(key('manifest', id));
                if (!cached) continue;
                try {
                    const receipt = await get(key('receipt', id));
                    if (receipt?.session === json(session) && receipt.verifiedAt > Date.now() - 300000) continue;
                    status(id, 'Syncing');
                    const root = sessionPath(id);
                    const audio = await client.json(`${root}/audio-manifest.json`);
                    const remote = await client.json(`${root}/session.json`);
                    if (!audio || !remote) throw new DropboxError('Dropbox backup is incomplete. No files were changed.', 'missing');
                    validateManifest(audio.value, id); validateSession(remote.value, id);
                    if (json(remote.value.session) !== json(session) && json(remote.value.session) !== receipt?.session) throw new DropboxError('The Dropbox session has changed. No files were overwritten.', 'conflict');
                    // Confirm every immutable segment before claiming a backup.
                    for (const segment of audio.value.segments) {
                        const metadata = await client.metadata(`${root}/${segment.file}`);
                        if (!metadata || metadata.content_hash !== segment.contentHash || metadata.size !== segment.bytes) throw new DropboxError('Dropbox audio is missing or changed.', 'integrity');
                    }
                    await client.upload(`${root}/session.json`, new Blob([json({ schema: 1, session })]), remote);
                    await set(key('manifest', id), audio.value);
                    await set(key('receipt', id), { session: json(session), verifiedAt: Date.now() });
                    status(id, 'Backed up'); changed(id);
                } catch (e) { report(e, id); break; }
            }
        } catch (e) { report(e); }
        finally { dropboxState.busy = false; }
    });
}
export async function remoteManifest(id) {
    if (!dropboxState.enabled || !account) return null;
    const manifestKey = key('manifest', id);
    const requestedAccount = account;
    const cached = await get(manifestKey);
    if (cached) return playableManifest(validateManifest(cached, id));
    try {
        const result = await client.json(`${sessionPath(id)}/audio-manifest.json`);
        if (!result) return null;
        const manifest = validateManifest(result.value, id);
        if (account !== requestedAccount || !dropboxState.enabled) throw new Error('Dropbox connection changed. Open the session again.');
        await set(manifestKey, manifest);
        return playableManifest(manifest);
    } catch (e) { report(e, id); throw e; }
}
async function remoteSegment(id, index) {
    const requestedAccount = account;
    const manifest = await remoteManifest(id);
    if (!manifest) return null;
    const meta = manifest.segments.find(s => s.index === index);
    if (!meta) return null;
    const cacheKey = `${cachePrefix}${account}:${id}:${meta.contentHash}`;
    const cached = await get(cacheKey);
    if (cached) { await set(cacheKey, { ...cached, used: Date.now() }).catch(() => {}); return cached.segment; }
    try {
        const segment = await downloadSegment(client, manifest, index);
        if (account !== requestedAccount || !dropboxState.enabled) throw new Error('Dropbox connection changed. Open the session again.');
        serialize(async () => {
            if (account !== requestedAccount || !dropboxState.enabled) return;
            const entries = [];
            for (const k of await keys()) if (typeof k === 'string' && k.startsWith(cachePrefix)) {
                const value = await get(k); if (value) entries.push({ k, ...value });
            }
            let bytes = entries.reduce((n, e) => n + e.segment.blob.size, 0);
            for (const entry of entries.sort((a, b) => a.used - b.used)) {
                if (bytes + segment.blob.size <= CACHE_LIMIT) break;
                await del(entry.k); bytes -= entry.segment.blob.size;
            }
            const room = await headroomBytes();
            if (segment.blob.size <= CACHE_LIMIT && room !== null && room >= segment.blob.size) await set(cacheKey, { segment, used: Date.now() });
        }).catch(() => {}); // Never delay playback behind the upload/cache queue.
        return segment;
    } catch (e) { report(e, id); throw e; }
}
export async function restoreDropboxSessions() {
    return serialize(async () => {
        const existing = await store.getLiveSessionsStrict();
        let count = 0;
        for (const folder of await client.folders()) {
            const id = folder.name;
            sessionPath(id);
            const result = await client.json(`${sessionPath(id)}/session.json`);
            const audio = await client.json(`${sessionPath(id)}/audio-manifest.json`);
            if (!result || !audio) continue;
            const session = validateSession(result.value, id);
            const manifest = validateManifest(audio.value, id);
            await set(key('manifest', id), manifest);
            if (!existing.some(s => s.id === id) || json(existing.find(s => s.id === id)) === json(session)) {
                await set(key('receipt', id), { session: json(session), verifiedAt: 0 });
            }
            // Restore missing records only. Never replace a local tune edit.
            if (!existing.some(s => s.id === id)) { await store.upsertLiveSession(session); count++; }
            changed(id);
        }
        return count;
    });
}
export async function deleteDropboxCopy(id) {
    return serialize(async () => {
        if (recorder.sessionId === id && recorder.isActive) throw new Error('Close this recording session before deleting its Dropbox copy.');
        const path = sessionPath(id);
        const pending = await get(key('deletion', id));
        const manifest = await client.json(`${path}/audio-manifest.json`);
        const session = await client.json(`${path}/session.json`);
        // A durable, previously validated job can finish after the final
        // folder delete succeeded but its response was lost.
        if ((!manifest || !session) && !pending) throw new Error('The cloud copy is incomplete or missing. No files were deleted.');
        if (manifest) validateManifest(manifest.value, id);
        if (session) validateSession(session.value, id);
        const inventory = await client.json(`${path}/whole-recordings.json`);
        const wholePaths = [...new Set([
            ...(inventory ? validateWholeRecordings(inventory.value, id) : []),
            ...(pending ? validateWholeRecordings(pending, id) : []),
        ])];
        await set(key('deletion', id), { schema: 1, sessionId: id, paths: wholePaths });
        await set(key('excluded', id), true);
        // Keep the remote manifests and inventory until every external file
        // is gone. A different device can also resume this operation.
        for (const whole of wholePaths) {
            try { await client.request('files/delete_v2', { path: whole }); }
            catch (e) { if (e.code !== 'missing') throw e; }
        }
        try { await client.request('files/delete_v2', { path }); }
        catch (e) { if (e.code !== 'missing') throw e; }
        await del(key('deletion', id));
        await del(key('whole', id));
        await del(key('manifest', id)); await del(key('receipt', id));
        for (const k of await keys()) if (typeof k === 'string' && k.startsWith(`${cachePrefix}${account}:${id}:`)) await del(k);
        status(id, 'Local only'); changed(id);
    });
}
// Deleting a SESSION takes its Dropbox copy with it.
//
// Without this the remote copy outlived the record that pointed at it, and
// since the session had gone from the list there was no longer anywhere in the
// app to reach it: three hours of a room, orphaned in the user's Dropbox, only
// findable by restoring it first. deleteDropboxCopy() refuses when nothing is
// stored remotely, which is the ordinary case, so that is not an error here.
async function removeDropboxCopyIfPresent(id) {
    if (!dropboxState.enabled || !account) return;
    if (!(await get(key('manifest', id))) && !(await client.json(`${sessionPath(id)}/audio-manifest.json`))) return;
    await deleteDropboxCopy(id);
}

export async function deleteLocalCopy(id) {
    return serialize(async () => {
        if (recorder.sessionId === id) throw new Error('Close this recording session before removing its local audio.');
        // Explicit user deletion is allowed independently of backup status.
        await deleteSessionAudio(id);
        changed(id);
    });
}
export async function enableSessionBackup(id) { await del(key('excluded', id)); retryAt = 0; return syncDropbox(true); }
export function startDropbox() {
    configureCloudAudio({ manifest: remoteManifest, segment: remoteSegment, remove: removeDropboxCopyIfPresent });
    const schedule = () => syncDropbox();
    // Listens to the recorder's event (a segment landed, so there is something
    // new to back up) but announces itself on its own — see changed().
    eventBus.$on('sessionAudioState', schedule);
    eventBus.$on('dropboxStateChanged', schedule);
    eventBus.$on('liveSessionsChanged', schedule);
    window.addEventListener('online', () => { retryAt = 0; schedule(); });
    window.addEventListener('storage', event => {
        if (![AUTH_KEY, ACCOUNT_KEY, ENABLED_KEY].includes(event.key)) return;
        dropboxState.enabled = false;
        dropboxState.storage = emptyStorage();
        serialize(async () => {
            try { auth = JSON.parse(stored(AUTH_KEY)); } catch (_) { auth = null; }
            account = stored(ACCOUNT_KEY) || '';
            dropboxState.enabled = stored(ENABLED_KEY) === 'true';
            dropboxState.connected = !!auth && auth.expiresAt > Date.now() + 30000;
            dropboxState.sessions = {}; changed();
        }).then(schedule);
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
    setInterval(() => { if (!document.hidden) schedule(); }, 30000);
    schedule();
}
