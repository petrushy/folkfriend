import {
    doc, collection, setDoc, deleteDoc, writeBatch, onSnapshot,
} from 'firebase/firestore';
import { firestore as db } from './firebase.js';
import eventBus from '@/eventBus';

// ---- Favourites -------------------------------------------------------------
//
// ONE DOCUMENT PER FAVOURITE, under users/{uid}/favourites/{settingID}
// (November 2026). Favourites used to be one document holding the whole array,
// rewritten wholesale on every star, and that broke in two ways that both end
// with two devices showing different lists:
//
//   • Size. Every item carries its setting's full ABC, its contour and, since
//     3.9.0, a mirrored AI note of up to 1200 characters. A few hundred
//     favourites reach Firestore's 1 MiB document limit, after which EVERY
//     write is rejected — and pushFavourites ended in `.catch(console.error)`,
//     so the rejection was invisible. Each device kept its own edits locally
//     while the account copy sat frozen, and the sign-in light stayed green.
//   • Last writer wins, for the WHOLE LIST. Whichever device pushed last
//     replaced every other device's list, so a star made on one device while
//     the other was offline (or behind on a snapshot) was simply overwritten.
//
// Now each favourite is its own small document, `{ id, updatedAt, item }`, and
// a removal is a TOMBSTONE, `{ id, updatedAt, deleted: true }`, rather than an
// absence — absence cannot be told apart from "not synced yet". Conflicts are
// decided per favourite by `updatedAt`, which the store keeps monotone per
// record, so editing one tune can never cost another.
//
// The old single document is still READ, never written: at sign-in its items
// are merged in additively (anything missing here and never deleted in the
// collection is added), which both migrates an install and recovers anything
// that only ever reached the old document. It is left in place as a backup.
export const FAVOURITES_COLLECTION = 'favourites';

function legacyFavDoc(uid) {
    return doc(db, 'users', uid, 'data', 'favourites');
}

// ---- Favourites sync status ----------------------------------------------
//
// What Settings shows as "All 312 favourites synced" or "10 favourites not
// synced". A favourite is PENDING from the moment it is pushed until the
// SERVER has confirmed it — either the write's own acknowledgement, or a
// server snapshot (not from cache, no pending local writes) carrying that
// stamp or newer. Offline, a write is queued by the SDK and not acknowledged,
// so it rightly counts as not synced.
//
// Persisted in localStorage, so an app relaunched offline still says how many
// are waiting rather than claiming everything is fine.
const PENDING_KEY = 'favouritesUnsynced';
const favSync = {
    pending: new Map(), // id -> { updatedAt, deleted }
    lastError: null,    // code of the last refused push, until one succeeds
    localError: null,   // a remote change this device could not store
    listenerError: null,
    listening: false,
    serverSeen: false,  // a server snapshot has arrived this session
    confirmedAt: 0,     // last time the server confirmed anything
};

(function loadPending() {
    try {
        const raw = JSON.parse(globalThis.localStorage.getItem(PENDING_KEY) || '[]');
        for (const [id, entry] of raw) favSync.pending.set(String(id), entry);
    } catch (e) { /* nothing persisted, or no localStorage */ }
})();

function emitFavSync() {
    try {
        globalThis.localStorage.setItem(PENDING_KEY, JSON.stringify([...favSync.pending]));
    } catch (e) { /* the in-memory count still works */ }
    eventBus.$emit('favouritesSyncState', getFavouritesSyncState());
}

export function getFavouritesSyncState() {
    return {
        pending: favSync.pending.size,
        pendingRemovals: [...favSync.pending.values()].filter(p => p.deleted).length,
        lastError: favSync.lastError,
        localError: favSync.localError,
        listenerError: favSync.listenerError,
        listening: favSync.listening,
        serverSeen: favSync.serverSeen,
        confirmedAt: favSync.confirmedAt,
    };
}

// The pending entries, for a retry: id -> { updatedAt, deleted }.
export function pendingFavourites() {
    return new Map(favSync.pending);
}

// Confirmed by the server at `updatedAt` or newer: no longer pending.
function confirmFavourite(id, updatedAt) {
    const entry = favSync.pending.get(String(id));
    if (entry && (Number(entry.updatedAt) || 0) <= (Number(updatedAt) || 0)) {
        favSync.pending.delete(String(id));
        return true;
    }
    return false;
}

// A pending entry that no longer describes anything this device can push.
export function forgetPendingFavourite(id) {
    if (favSync.pending.delete(String(id))) emitFavSync();
}

// For tests: start from a clean slate.
export function __resetFavouritesSyncState() {
    favSync.pending.clear();
    Object.assign(favSync, { lastError: null, localError: null, listenerError: null,
        listening: false, serverSeen: false, confirmedAt: 0 });
}

// handlers:
//   applyRemote(docs)        — docs that changed remotely (tombstones included).
//                              Must merge, never replace.
//   seed(remoteByID)         — once, after the first SERVER snapshot has been
//                              applied: push whatever this device has that the
//                              account does not, or has newer.
//   applyLegacy(items, remoteByID) — the old single document's items, after
//                              seeding. Additive only.
//   retry()                  — re-push whatever is pending; called when the
//                              browser comes back online.
export function subscribeFavourites(uid, { applyRemote, seed, applyLegacy, retry }) {
    const remoteByID = new Map();
    let seeded = false;
    let legacyItems = null;
    let legacyApplied = false;

    // Serialised: a seed must see the merge of the snapshot that triggered it,
    // and two snapshots must not merge concurrently.
    let chain = Promise.resolve();
    const enqueue = fn => { chain = chain.then(fn).catch(e => console.error('[folkfriend sync] favourites', e)); return chain; };

    const runLegacy = () => enqueue(async () => {
        if (!seeded || !legacyItems || legacyApplied) return;
        legacyApplied = true;
        try {
            await applyLegacy(legacyItems, remoteByID);
        } catch (e) {
            legacyApplied = false;
            console.error('[folkfriend sync] could not merge the old favourites document', e);
        }
    });

    favSync.listening = true;
    favSync.listenerError = null;
    favSync.serverSeen = false;
    emitFavSync();

    // includeMetadataChanges is REQUIRED. With the offline cache warm, the
    // server's answer usually changes no document — it only flips
    // metadata.fromCache — and without this option the SDK never delivers it.
    // The device then never sees a server snapshot: the status reads
    // "Checking…" for ever and seeding never runs.
    const unsubCollection = onSnapshot(collectionRef(uid, FAVOURITES_COLLECTION), { includeMetadataChanges: true }, snap => enqueue(async () => {
        const changed = [];
        const fromServer = !(snap.metadata && snap.metadata.fromCache);
        let confirmed = false;
        for (const change of snap.docChanges()) {
            // A hard delete of a document (only ever done by hand, in the
            // console) is ignored: nothing in the app deletes these, and
            // reading it as "remove the favourite" is the one interpretation
            // that can lose data.
            if (change.type === 'removed') continue;
            const data = change.doc.data();
            if (!data || data.id == null) continue;
            remoteByID.set(String(data.id), data);
            changed.push(data);
            // Only the server's own copy confirms anything: a cached or
            // latency-compensated document is this device's write echoed back.
            const local = change.doc.metadata && change.doc.metadata.hasPendingWrites;
            if (fromServer && !local && confirmFavourite(data.id, data.updatedAt)) confirmed = true;
        }
        if (fromServer && (!favSync.serverSeen || confirmed)) {
            favSync.serverSeen = true;
            favSync.confirmedAt = Date.now();
            emitFavSync();
        }
        if (changed.length) {
            try {
                await applyRemote(changed);
                if (favSync.localError) { favSync.localError = null; emitFavSync(); }
            } catch (e) {
                const reason = (e && (e.name || e.message)) || 'unknown error';
                console.error('[folkfriend sync] could not store favourites locally:', e);
                reportSyncProblem('local:favourites', `Could not save favourites on this device (${reason}).`);
                favSync.localError = reason;
                emitFavSync();
                return;
            }
        }
        if (!seeded && !snap.metadata.fromCache) {
            try {
                await seed(remoteByID);
                seeded = true;
            } catch (e) {
                // Retried on the next server snapshot rather than seeding nothing.
                console.error('[folkfriend sync] could not read local favourites to seed', e);
            }
        }
    }).then(runLegacy), err => {
        console.error('[folkfriend sync] favourites listener failed:', err.code, err.message, err);
        reportSyncProblem('listen:favourites',
            `Favourites sync failed (${err.code || 'unknown'}) — they may be out of date.`);
        favSync.listenerError = err.code || 'unknown';
        favSync.listening = false;
        emitFavSync();
    });

    const unsubLegacy = onSnapshot(legacyFavDoc(uid), snap => {
        if (!snap.exists()) return;
        const data = snap.data();
        // Re-read whenever an older build on another device writes it, so its
        // additions keep arriving until that device updates.
        legacyItems = Array.isArray(data && data.items) ? data.items : [];
        legacyApplied = false;
        runLegacy();
    }, err => {
        console.error('[folkfriend sync] old favourites document unreadable:', err.code, err);
    });

    const onOnline = () => { if (favSync.pending.size && retry) retry(); };
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('online', onOnline);

    return () => {
        unsubCollection();
        unsubLegacy();
        if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('online', onOnline);
        favSync.listening = false;
        emitFavSync();
    };
}

// Writes favourite documents (upserts and tombstones). Failures are REPORTED:
// a rejected write here is the whole bug this layout replaces.
export async function pushFavouriteRecords(uid, docs) {
    const usable = (docs || []).filter(d => d && d.id != null);
    if (!usable.length) return;
    // Pending from now until the server confirms it. A newer stamp replaces
    // an older pending one; an older one never lowers it.
    for (const d of usable) {
        const id = String(d.id);
        const prev = favSync.pending.get(id);
        if (!prev || (Number(d.updatedAt) || 0) >= (Number(prev.updatedAt) || 0)) {
            favSync.pending.set(id, { updatedAt: Number(d.updatedAt) || 0, deleted: Boolean(d.deleted) });
        }
    }
    emitFavSync();
    for (let i = 0; i < usable.length; i += BATCH_LIMIT) {
        const slice = usable.slice(i, i + BATCH_LIMIT);
        const batch = writeBatch(db);
        for (const d of slice) {
            batch.set(recordRef(uid, FAVOURITES_COLLECTION, d.id), toPlain(d));
        }
        try {
            await batch.commit();
            for (const d of slice) confirmFavourite(d.id, d.updatedAt);
            favSync.lastError = null;
            favSync.confirmedAt = Date.now();
        } catch (e) {
            console.error('[folkfriend sync] could not push favourites:', e && e.code, e);
            favSync.lastError = (e && e.code) || (e && e.message) || 'unknown';
            reportSyncProblem('push:favourites',
                `Could not sync favourites to your account (${favSync.lastError}). ` +
                'They are safe on this device.');
        }
        emitFavSync();
    }
}

function toPlain(items) {
    return JSON.parse(JSON.stringify(items));
}

// ---- Record-per-document collections -------------------------------------
//
// Places, sightings and live sessions sync as ONE DOCUMENT PER RECORD, not as
// one array document like favourites. Two reasons, and both are hard limits
// rather than preferences:
//
//   • Size. Firestore caps a document at 1 MiB. At their local caps, 5000
//     sightings and 300 sessions (each holding its own tune list) are both
//     around or past that, so the favourites shape would start failing once a
//     user had a year of sessions behind them — silently, and only for the
//     people using the feature most.
//   • Write amplification. A live session saves on every tune change, so an
//     array push would re-upload the user's ENTIRE history every time a tune
//     is recognised — repeatedly, over an evening, on mobile data. One
//     document per record makes that write a few hundred bytes.
//
// It also makes deletion explicit. The favourites document has to encode
// deletion as absence, which is what forced the tombstone machinery around AI
// summaries; here a delete is a deleted document and the listener reports it.
export const SYNCED_COLLECTIONS = ['places', 'sightings', 'liveSessions'];

// Firestore rejects a batch over 500 operations.
const BATCH_LIMIT = 400;

// One report per collection per minute. A rules rejection or a lost connection
// fails EVERY record, and seeding can be thousands of them — without this the
// first sign of trouble is a stampede of identical snackbars that buries the
// one message worth reading.
const REPORT_INTERVAL_MS = 60_000;
const lastReported = new Map();

function reportSyncProblem(key, message) {
    const now = Date.now();
    if (now - (lastReported.get(key) || 0) < REPORT_INTERVAL_MS) return;
    lastReported.set(key, now);
    eventBus.$emit('syncError', message);
}

function collectionRef(uid, name) {
    return collection(db, 'users', uid, name);
}

function recordRef(uid, name, id) {
    return doc(db, 'users', uid, name, String(id));
}

// Subscribes to one collection.
//
// `applyRemote(upserts, removals)` receives what actually changed, so a local
// store only has to merge deltas rather than diff whole arrays. `getLocal()`
// is called once, on the first snapshot that came from the server, to find
// records this device has that Firestore does not.
//
// Seeding is a UNION, deliberately, and this is the property the whole design
// rests on: these are append-only observation logs, and a record missing from
// one side is always "not yet synced", never "deleted". Replacing local with
// remote — what the favourites document does — would throw away every session
// recorded before the user signed in, on a device that was working perfectly.
//
// The seed waits for a SERVER snapshot (`fromCache` false). The local cache
// answers first when persistence is on, and seeding from it would push
// everything the cache happens to be missing straight back up.
export function subscribeCollection(uid, name, { applyRemote, getLocal }) {
    let seeded = false;

    // includeMetadataChanges: see subscribeFavourites — without it a warm
    // cache means the server snapshot is never delivered and the seed never runs.
    return onSnapshot(collectionRef(uid, name), { includeMetadataChanges: true }, async snap => {
        const upserts = [];
        const removals = [];
        for (const change of snap.docChanges()) {
            if (change.type === 'removed') removals.push(change.doc.id);
            else upserts.push(change.doc.data());
        }

        if (upserts.length || removals.length) {
            // The store's writes are strict now, so a failed merge rejects
            // rather than quietly writing an empty collection. Inside an
            // onSnapshot callback that would otherwise surface only as an
            // unhandled rejection.
            try {
                await applyRemote(upserts, removals);
            } catch (e) {
                // NOT a sync failure: the data arrived, and writing it to this
                // device's own IndexedDB is what failed — quota, or a browser
                // blocking storage. Saying "sync error" sends anyone debugging
                // it to the network and the security rules, which is the wrong
                // half of the system entirely.
                const reason = (e && (e.name || e.message)) || 'unknown error';
                console.error(`[folkfriend sync] could not store ${name} locally:`, e);
                reportSyncProblem(`local:${name}`,
                    `Could not save ${name} on this device (${reason}).`);
                return;
            }
        }

        if (!seeded && !snap.metadata.fromCache) {
            seeded = true;
            const local = await getLocal();
            const remoteIDs = new Set(snap.docs.map(d => d.id));
            const missing = (local || []).filter(r => r && r.id && !remoteIDs.has(String(r.id)));
            if (missing.length) await pushRecords(uid, name, missing);
        }
    }, err => {
        console.error(`[folkfriend sync] ${name} listener failed:`, err.code, err.message, err);
        reportSyncProblem(`listen:${name}`,
            `Could not read ${name} from your account (${err.code || 'unknown'}).`);
    });
}

export function pushRecord(uid, name, record) {
    if (!record || record.id == null) return Promise.resolve();
    return setDoc(recordRef(uid, name, record.id), toPlain(record)).catch(e => {
        // A rejected write here is usually the security rules refusing the
        // document's shape, which is otherwise completely silent: the local
        // copy saved fine and every view reads that, so the app looks perfect
        // while nothing reaches the account.
        console.error(`[folkfriend sync] could not push ${name}/${record.id}:`, e && e.code, e);
        reportSyncProblem(`push:${name}`,
            `Could not sync ${name} to your account (${(e && e.code) || 'unknown'}).`);
    });
}

export async function pushRecords(uid, name, records) {
    const usable = (records || []).filter(r => r && r.id != null);
    for (let i = 0; i < usable.length; i += BATCH_LIMIT) {
        const batch = writeBatch(db);
        for (const record of usable.slice(i, i + BATCH_LIMIT)) {
            batch.set(recordRef(uid, name, record.id), toPlain(record));
        }
        await batch.commit().catch(e => {
            console.error(`[folkfriend sync] could not push a batch of ${name}:`, e && e.code, e);
            reportSyncProblem(`push:${name}`,
                `Could not sync ${name} to your account (${(e && e.code) || 'unknown'}).`);
        });
    }
}

export function deleteRecord(uid, name, id) {
    if (id == null) return Promise.resolve();
    return deleteDoc(recordRef(uid, name, id)).catch(console.error);
}

export async function deleteRecords(uid, name, ids) {
    const usable = (ids || []).filter(id => id != null);
    for (let i = 0; i < usable.length; i += BATCH_LIMIT) {
        const batch = writeBatch(db);
        for (const id of usable.slice(i, i + BATCH_LIMIT)) {
            batch.delete(recordRef(uid, name, id));
        }
        await batch.commit().catch(console.error);
    }
}
