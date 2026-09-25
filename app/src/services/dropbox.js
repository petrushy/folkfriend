import Vue from 'vue';
import { readDropboxStorage } from './dropboxStorage.mjs';
import { get, set, del, keys } from 'idb-keyval';
import eventBus from '@/eventBus.js';
import store from '@/services/store.js';
import recorder from '@/services/sessionRecorder.js';
import { listManifests, readManifest, readSegment, buildClip, asBlob, fileExtensionFor, headroomBytes, deleteSessionAudio, configureCloudAudio } from '@/services/sessionAudioStore.js';
import { DropboxClient, DropboxError, base64url } from './dropboxClient.mjs';
import { authFromTokenResponse, createTokenSource, credentialsUsable } from './dropboxAuth.mjs';
import { backupSession, backupWholeRecordings, downloadSegment, playableManifest, validateWholeRecordings, validateManifest, validateSession, mayReplaceRemoteSession, sessionPath, deletionPath, deletionRecord, sessionSummary } from './dropboxBackup.mjs';

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
    connected: credentialsUsable(auth), busy: false, error: '', sessions: {}, revision: 0, storage: emptyStorage(),
    // Sessions whose backup is blocked by a newer copy in Dropbox, id → why.
    // Kept apart from `sessions` because a conflict is the one backup failure
    // the user can actually do something about, and the view needs to know
    // which one to offer that something for.
    conflicts: {},
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
// Renews the access token from the stored refresh token as it nears expiry,
// so a device stays connected rather than dropping to "Reconnect required"
// four hours after connecting. See dropboxAuth.mjs.
const tokens = createTokenSource({
    appKey: APP_KEY,
    load: () => (dropboxState.enabled ? auth : null),
    save: next => {
        auth = next;
        try { localStorage.setItem(AUTH_KEY, json(auth)); } catch (_) { /* kept in memory for this session */ }
    },
});
const client = new DropboxClient({ token: options => tokens.token(options) });
let queue = Promise.resolve();
let retryAt = 0;
let deletionCheckAt = 0;
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
function noteConflict(id, message) { if (id) Vue.set(dropboxState.conflicts, id, message || ''); }
export function sessionConflictMessage(id) {
    void dropboxState.revision;
    return dropboxState.conflicts[id] || '';
}
function report(e, id) {
    if (e.code === 'auth') { dropboxState.connected = false; auth = null; localStorage.removeItem(AUTH_KEY); }
    retryAt = Date.now() + Math.max(30000, (e.retryAfter || 0) * 1000);
    // A conflict is not "pending": nothing is going to clear it by retrying,
    // and calling it pending is what left a Retry button being pressed for
    // ever against a state it could not change.
    const label = e.code === 'auth' ? 'Reconnect required' : e.code === 'full' ? 'Dropbox full'
        : e.code === 'conflict' ? 'Needs review' : 'Backup pending';
    if (id) status(id, label);
    if (id) noteConflict(id, e.code === 'conflict' ? e.message : '');
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
                redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline',
                scope: 'files.metadata.read files.content.read files.content.write' + (includeSpaceUsage ? ' account_info.read' : '') })}`;
        });
        const response = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams({
            grant_type: 'authorization_code', client_id: APP_KEY, code, code_verifier: verifier, redirect_uri: redirect,
        }) });
        if (!response.ok) throw new Error('Dropbox authorization failed. Please reconnect.');
        const result = await response.json();
        if (!result.account_id) throw new Error('Invalid Dropbox authorization response.');
        const granted = authFromTokenResponse(result);
        await serialize(async () => {
            account = result.account_id;
            dropboxState.storage = emptyStorage();
            localStorage.setItem(SPACE_KEY, String(includeSpaceUsage));
            auth = granted;
            localStorage.setItem(AUTH_KEY, json(auth)); localStorage.setItem(ACCOUNT_KEY, account); localStorage.setItem(ENABLED_KEY, 'true');
            dropboxState.enabled = true; dropboxState.connected = true; dropboxState.sessions = {}; dropboxState.error = ''; retryAt = 0;
        });
        eventBus.$emit('dropboxConnected');
        await syncDropbox();
    } finally { if (!popup.closed) popup.close(); }
}
export async function disconnectDropbox() {
    // Stop scheduling immediately; wait for the one in-flight request chain.
    const previous = auth;
    dropboxState.enabled = false;
    await serialize(async () => {
        // A refresh token is a long-lived credential, so Disconnect has to end
        // the grant at Dropbox, not only forget it here. Revoking an access
        // token also revokes the refresh token it came from. Best-effort and
        // never awaited past taking the token: being offline must not stop
        // someone disconnecting, and the local copy is gone either way.
        let revokeWith = null;
        if (previous && previous.refreshToken) {
            try { revokeWith = await tokens.token({ auth: previous }); } catch (_) { /* offline */ }
        }
        auth = null; localStorage.removeItem(AUTH_KEY); localStorage.setItem(ENABLED_KEY, 'false');
        if (revokeWith) {
            Promise.resolve(client.request('auth/token/revoke', null, undefined, { token: revokeWith })).catch(() => {});
        }
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
            if (!credentialsUsable(auth)) throw new DropboxError('Reconnect Dropbox to continue.', 'auth');
            dropboxState.error = '';
            const sessions = await store.getLiveSessionsStrict();
            const manifests = await listManifests();
            // A crashed uploader may leave files behind AFTER another device
            // deleted them. Reconcile tombstones even for locally excluded or
            // missing sessions. Ordinary timer passes poll at most every 5 min.
            if (force || Date.now() >= deletionCheckAt) {
                const deleted = await client.deletedSessions();
                for (const id of deleted) await reconcileDeletedSession(id);
                deletionCheckAt = Date.now() + 300000;
            }
            for (const local of manifests) {
                if (!dropboxState.enabled) break;
                const id = local.sessionId;
                const session = sessions.find(s => s.id === id);
                if (!session || !local.segments.length || await get(key('excluded', id))) continue;
                try {
                    const fingerprint = json({ local, session, wholeRecordings: dropboxState.wholeRecordings });
                    const receipt = await get(key('receipt', id));
                    if (receipt?.fingerprint === fingerprint && receipt.verifiedAt > Date.now() - 300000) {
                        status(id, recorder.sessionId === id && recorder.isRecording ? 'Syncing' : 'Backed up'); continue;
                    }
                    if (await reconcileDeletedSession(id)) continue;
                    status(id, 'Syncing');
                    // A NEWER cloud session must never be overwritten by a
                    // stale local editor, including after a crash/reconnect.
                    // Newer, not merely different — see mayReplaceRemoteSession.
                    const remoteSession = await client.json(`${sessionPath(id)}/session.json`);
                    if (remoteSession) {
                        validateSession(remoteSession.value, id);
                        if (!mayReplaceRemoteSession(remoteSession.value.session, session, receipt)) {
                            throw new DropboxError('A newer version of this session is in Dropbox. Restore or review that copy before backing up.', 'conflict');
                        }
                    }
                    await set(key('receipt', id), { ...receipt, pendingSession: json(session) });
                    const cloud = await backupSession(client, session, local, readSegment, fileExtensionFor, remoteSession?.rev || null);
                    await set(key('manifest', id), cloud);
                    // endedAt belongs to the tune list. The recorder can still
                    // be committing its tail after that record is saved.
                    if (dropboxState.wholeRecordings && session.endedAt &&
                        (local.finalizedAt === null || (recorder.sessionId === id && recorder.isActive))) {
                        if (await reconcileDeletedSession(id)) continue;
                        status(id, 'Syncing');
                        continue; // No receipt: retry after the final write.
                    }
                    if (dropboxState.wholeRecordings) {
                        // Recorded so deletion can find them: a whole recording
                        // lives outside the session folder, which is the price
                        // of it being somewhere a person would look.
                        const paths = await backupWholeRecordings(client, session, cloud, buildClip,
                            fileExtensionFor, await get(key('whole', id)) || []);
                        if (paths.length) await set(key('whole', id), paths);
                    }
                    if (await reconcileDeletedSession(id)) continue;
                    await set(key('receipt', id), { fingerprint, session: json(session), verifiedAt: Date.now() });
                    noteConflict(id, '');
                    status(id, recorder.sessionId === id && recorder.isRecording ? 'Syncing' : 'Backed up'); changed(id);
                } catch (e) {
                    try { if (await reconcileDeletedSession(id)) continue; }
                    catch (cleanupError) { e = cleanupError; }
                    report(e, id);
                    if (['auth', 'full', 'rate', 'network'].includes(e.code) || !e.code) break;
                }
            }
            for (const session of sessions) {
                const id = session.id;
                if (!dropboxState.enabled || manifests.some(m => m.sessionId === id) || await get(key('excluded', id))) continue;
                const cached = await get(key('manifest', id));
                if (!cached) continue;
                try {
                    const receipt = await get(key('receipt', id));
                    if (receipt?.session === json(session) && receipt.verifiedAt > Date.now() - 300000) continue;
                    if (await reconcileDeletedSession(id)) continue;
                    status(id, 'Syncing');
                    const root = sessionPath(id);
                    const audio = await client.json(`${root}/audio-manifest.json`);
                    const remote = await client.json(`${root}/session.json`);
                    if (!audio || !remote) throw new DropboxError('Dropbox backup is incomplete. No files were changed.', 'missing');
                    validateManifest(audio.value, id); validateSession(remote.value, id);
                    if (!mayReplaceRemoteSession(remote.value.session, session, receipt)) throw new DropboxError('A newer version of this session is in Dropbox. No files were overwritten.', 'conflict');
                    // Confirm every immutable segment before claiming a backup.
                    for (const segment of audio.value.segments) {
                        const metadata = await client.metadata(`${root}/${segment.file}`);
                        if (!metadata || metadata.content_hash !== segment.contentHash || metadata.size !== segment.bytes) throw new DropboxError('Dropbox audio is missing or changed.', 'integrity');
                    }
                    await client.upload(`${root}/session.json`, new Blob([json({ schema: 1, session })]), remote);
                    await set(key('manifest', id), audio.value);
                    if (await reconcileDeletedSession(id)) continue;
                    await set(key('receipt', id), { session: json(session), verifiedAt: Date.now() });
                    noteConflict(id, '');
                    status(id, 'Backed up'); changed(id);
                    // Only a transient, WHOLE-ACCOUNT fault is worth stopping
                    // the pass for. Breaking on anything — which is what this
                    // did — let one session's conflict block the metadata sync
                    // of every session after it, silently and indefinitely.
                    // Same rule as the audio loop above.
                } catch (e) {
                    try { if (await reconcileDeletedSession(id)) continue; }
                    catch (cleanupError) { e = cleanupError; }
                    report(e, id);
                    if (['auth', 'full', 'rate', 'network'].includes(e.code) || !e.code) break;
                }
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
// A cache entry as a segment with a readable Blob, or null to download again.
//
// Entries written before the cache stored bytes hold a Blob, and those are
// NEVER trusted, however they probe. This cache is where the iPhone's playback
// failures actually lived: a device that did not make the recording plays it
// entirely from here, and a WebKit Blob stored in IndexedDB can read at its
// start and fail further in — so a partial probe passed, the first minute
// played, and every later clip failed. Re-downloading one segment costs about
// a megabyte and a hash check; trusting a Blob that may be unreadable costs the
// recording.
function cachedSegment(entry, meta) {
    if (!entry || !entry.data) return null;
    if (meta && meta.bytes && entry.data.byteLength !== meta.bytes) return null;
    const { data, ...rest } = entry;
    return { ...rest, blob: asBlob(data, entry.mimeType) };
}
const cachedSize = entry => (entry && (entry.data ? entry.data.byteLength : entry.blob && entry.blob.size)) || 0;

export async function remoteSegment(id, index) {
    const requestedAccount = account;
    const manifest = await remoteManifest(id);
    if (!manifest) return null;
    const meta = manifest.segments.find(s => s.index === index);
    if (!meta) return null;
    const cacheKey = `${cachePrefix}${account}:${id}:${meta.contentHash}`;
    const cached = await get(cacheKey);
    const hit = cached && cachedSegment(cached.segment, meta);
    if (hit) { await set(cacheKey, { ...cached, used: Date.now() }).catch(() => {}); return hit; }
    // An entry this build will not use is dropped, not left to be misread by
    // anything else that looks in the cache. The download below replaces it.
    if (cached) await del(cacheKey).catch(() => {});
    try {
        const segment = await downloadSegment(client, manifest, index);
        if (account !== requestedAccount || !dropboxState.enabled) throw new Error('Dropbox connection changed. Open the session again.');
        serialize(async () => {
            if (account !== requestedAccount || !dropboxState.enabled) return;
            const entries = [];
            for (const k of await keys()) if (typeof k === 'string' && k.startsWith(cachePrefix)) {
                const value = await get(k); if (value) entries.push({ k, ...value });
            }
            let bytes = entries.reduce((n, e) => n + cachedSize(e.segment), 0);
            for (const entry of entries.sort((a, b) => a.used - b.used)) {
                if (bytes + segment.blob.size <= CACHE_LIMIT) break;
                await del(entry.k); bytes -= cachedSize(entry.segment);
            }
            const room = await headroomBytes();
            if (segment.blob.size <= CACHE_LIMIT && room !== null && room >= segment.blob.size) {
                // As bytes, not a Blob — see storableBytes() in sessionAudioStore.js.
                const { blob, ...rest } = segment;
                await set(cacheKey, { segment: { ...rest, mimeType: blob.type || '', data: await blob.arrayBuffer() }, used: Date.now() });
            }
        }).catch(() => {}); // Never delay playback behind the upload/cache queue.
        return segment;
    } catch (e) { report(e, id); throw e; }
}
export async function restoreDropboxSessions() {
    return serialize(async () => {
        const existing = await store.getLiveSessionsStrict();
        let count = 0;
        // A session whose cloud copy was deleted is not a session to recover,
        // even if an interrupted delete left its folder behind.
        const deletions = await client.deletedSessions();
        for (const folder of await client.folders()) {
            const id = folder.name;
            if (deletions.has(id)) continue;
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
// Called within the coordinator queue, never by entering it again. A marker
// remains until explicit Retry backup; it is also the durable cleanup job for
// an uploader that crashes after recreating bytes. Recheck it after the LAST
// remote write, including whole-file uploads, before reporting Backed up.
async function reconcileDeletedSession(id) {
    const markerPath = deletionPath(id);
    const marker = await client.json(markerPath);
    if (!marker) return false;
    const value = marker.value;
    if (value?.schema !== 1 || value.sessionId !== id ||
        !Number.isFinite(value.deletedAt) || value.deletedAt < 0) {
        throw new DropboxError('Unfamiliar Dropbox deletion marker. No files were changed.', 'unsupported');
    }
    const root = sessionPath(id);
    const manifest = await client.json(`${root}/audio-manifest.json`);
    const session = await client.json(`${root}/session.json`);
    if (manifest) validateManifest(manifest.value, id);
    if (session) validateSession(session.value, id);
    const inventory = await client.json(`${root}/whole-recordings.json`);
    const pending = await get(key('deletion', id));
    const paths = new Set([
        ...validateWholeRecordings({ schema: 1, sessionId: id, paths: value.paths || [] }, id),
        ...(inventory ? validateWholeRecordings(inventory.value, id) : []),
        ...(pending ? validateWholeRecordings(pending, id) : []),
    ]);
    // The old inventory may already be gone when a late whole-file upload
    // finishes. Its stable session/track identity still establishes ownership.
    for (const entry of await client.list('/recordings')) {
        if (entry['.tag'] !== 'file') continue;
        const path = `/recordings/${entry.name}`;
        try { validateWholeRecordings({ schema: 1, sessionId: id, paths: [path] }, id); }
        catch (_) { continue; } // Never delete ambiguous legacy names.
        paths.add(path);
    }
    const stillDeleted = async () => (await client.metadata(markerPath))?.rev === marker.rev;
    if (!await stillDeleted()) return false;
    await set(key('excluded', id), true);
    await set(key('deletion', id), { schema: 1, sessionId: id, paths: [...paths] });
    for (const path of [...paths, root]) {
        if (!await stillDeleted()) return false;
        try { await client.request('files/delete_v2', { path }); }
        catch (e) { if (e.code !== 'missing') throw e; }
    }
    await del(key('deletion', id));
    await del(key('whole', id));
    await del(key('manifest', id));
    await del(key('receipt', id));
    for (const k of await keys()) {
        if (typeof k === 'string' && k.startsWith(`${cachePrefix}${account}:${id}:`)) await del(k);
    }
    noteConflict(id, '');
    status(id, 'Local only'); changed(id);
    return true;
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
        // BEFORE any file is removed, and outside the folder being removed.
        //
        // The exclusion above is local to this device, and that was the whole
        // of the record: another device still holding this session's audio saw
        // a session with local audio and no cloud copy, did what it is for,
        // and put the recording straight back. The deletion has to be a fact
        // both devices can read, so it is written into Dropbox — and written
        // first, so an interrupted delete still leaves the marker rather than
        // a half-removed folder nothing explains.
        const marker = deletionPath(id);
        await client.upload(marker, new Blob([json({ ...deletionRecord(id), paths: wholePaths })]), await client.metadata(marker));
        if (!await reconcileDeletedSession(id)) {
            throw new DropboxError('Dropbox deletion changed on another device. Please retry.', 'conflict');
        }
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
// Turning backup back on for one session. Clears the SHARED marker as well as
// the local exclusion: leaving it would let the next pass — on this device or
// any other — read the deletion and switch the session straight back off, so
// the button would appear to do nothing.
export async function enableSessionBackup(id) {
    await serialize(async () => {
        await del(key('excluded', id));
        if (!dropboxState.enabled) return;
        try { await client.request('files/delete_v2', { path: deletionPath(id) }); }
        catch (e) { if (e.code !== 'missing') throw e; }
    });
    retryAt = 0;
    return syncDropbox(true);
}

// ---- Conflicts: a newer copy in Dropbox -----------------------------------
//
// mayReplaceRemoteSession() refuses to overwrite a strictly newer cloud copy,
// which is right — but the message told the user to "restore or review that
// copy", and there was nothing in the app that could do either: "Recover
// missing sessions" deliberately skips a session that already exists locally,
// so unless Firebase happened to deliver the newer version the Retry button
// could never succeed. These two are that missing half.

// The two copies side by side, so the choice below is an informed one.
export async function sessionConflict(id) {
    return serialize(async () => {
        const remote = await client.json(`${sessionPath(id)}/session.json`);
        const local = (await store.getLiveSessionsStrict()).find(s => s.id === id) || null;
        return {
            local: sessionSummary(local),
            remote: remote ? sessionSummary(validateSession(remote.value, id)) : null,
        };
    });
}

// Settle it, in the user's favour whichever way they choose.
//
// Neither branch reaches past the version rule: both make the LOCAL record
// legitimately the newest copy and let the ordinary backup replace Dropbox
// with it. That also means the decision rides Firestore to every other device,
// so the conflict is resolved everywhere rather than on the phone in front of
// the user — which is what stops it coming back on the next pass.
export async function resolveSessionConflict(id, keep = 'local') {
    if (keep !== 'local' && keep !== 'remote') throw new Error('Choose which copy to keep.');
    await serialize(async () => {
        const remote = await client.json(`${sessionPath(id)}/session.json`);
        const cloud = remote ? validateSession(remote.value, id) : null;
        const local = (await store.getLiveSessionsStrict()).find(s => s.id === id) || null;
        if (!local && !cloud) throw new DropboxError('This session is in neither place.', 'missing');
        if (keep === 'remote' && !cloud) throw new DropboxError('There is no Dropbox copy of this session to keep.', 'missing');
        // Stamped above BOTH copies, because a cloud copy written by a device
        // whose clock runs ahead would otherwise still be the newer one and the
        // conflict would survive the resolution.
        const base = Math.max(cloud?.updatedAt || 0, local?.updatedAt || 0);
        const chosen = keep === 'remote' ? { ...(local || {}), ...cloud } : local;
        await store.upsertLiveSession({ ...chosen, id, updatedAt: base });
        noteConflict(id, '');
        status(id, 'Syncing');
    });
    retryAt = 0;
    return syncDropbox(true);
}
// What this device has cached of one backed-up segment, for the recording
// check: the stored payload itself (bytes, or a legacy Blob) or null. Reads
// only IndexedDB — the backup's manifest is usually cached too, and nothing is
// downloaded either way.
export async function cachedSegmentPayload(id, index) {
    const manifest = await remoteManifest(id);
    const meta = manifest && manifest.segments.find(s => s.index === index);
    if (!meta) return null;
    const cached = await get(`${cachePrefix}${account}:${id}:${meta.contentHash}`);
    const entry = cached && cached.segment;
    if (!entry) return null;
    return { payload: entry.data || entry.blob || null, mimeType: entry.mimeType || '' };
}

export function startDropbox() {
    configureCloudAudio({ manifest: remoteManifest, segment: remoteSegment, remove: removeDropboxCopyIfPresent,
        cached: cachedSegmentPayload });
    const schedule = () => syncDropbox();
    // Listens to the recorder's event (a segment landed, so there is something
    // new to back up) but announces itself on its own — see changed().
    eventBus.$on('sessionAudioState', schedule);
    eventBus.$on('dropboxStateChanged', schedule);
    eventBus.$on('liveSessionsChanged', schedule);
    window.addEventListener('online', () => { retryAt = 0; schedule(); });
    window.addEventListener('storage', event => {
        if (![AUTH_KEY, ACCOUNT_KEY, ENABLED_KEY].includes(event.key)) return;
        // Another tab refreshing its access token rewrites AUTH_KEY every few
        // hours. Same grant, new token: adopt it quietly rather than tearing
        // this tab's backup state down and rebuilding it.
        if (event.key === AUTH_KEY) {
            let next = null;
            try { next = JSON.parse(event.newValue); } catch (_) { next = null; }
            if (next && auth && next.refreshToken && next.refreshToken === auth.refreshToken) {
                auth = next;
                return;
            }
        }
        dropboxState.enabled = false;
        dropboxState.storage = emptyStorage();
        serialize(async () => {
            try { auth = JSON.parse(stored(AUTH_KEY)); } catch (_) { auth = null; }
            account = stored(ACCOUNT_KEY) || '';
            dropboxState.enabled = stored(ENABLED_KEY) === 'true';
            dropboxState.connected = credentialsUsable(auth);
            dropboxState.sessions = {}; changed();
        }).then(schedule);
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
    setInterval(() => { if (!document.hidden) schedule(); }, 30000);
    schedule();
}
