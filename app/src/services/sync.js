import {
    doc, collection, setDoc, deleteDoc, writeBatch, onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { firestore as db } from './firebase.js';
import eventBus from '@/eventBus';

// localStorage key for tracking when local favourites were last modified
const FAV_TS_KEY = 'favouritesLocalUpdatedAt';

function favDoc(uid) {
    return doc(db, 'users', uid, 'data', 'favourites');
}

// Subscribe to real-time Firestore updates for favourites.
//
// getLocalFavs — async function that returns the current local favourites array.
//   Called lazily (only when needed) so it's never stale.
//
// Conflict resolution: every Firestore document now carries clientUpdatedAt
// (a client-side Date.now() millis). The same value is mirrored in
// localStorage[FAV_TS_KEY] after every local write. On each snapshot:
//   • Firestore newer (or no timestamps yet)  → apply Firestore to local
//   • Local newer                             → push local to Firestore
//
// This prevents a stale write from another session/tab from silently
// overwriting newer local data when the snapshot arrives.
//
// Returns an unsubscribe function to call on sign-out.
export function subscribe(uid, getLocalFavs, onChange) {
    let seeded = false;
    let pushInFlight = false;

    const unsubFav = onSnapshot(favDoc(uid), async snap => {
        if (!snap.exists()) {
            if (!seeded) {
                seeded = true;
                const items = await getLocalFavs();
                pushFavourites(uid, items);
            }
            return;
        }

        const data = snap.data();
        const firestoreTs = typeof data.clientUpdatedAt === 'number' ? data.clientUpdatedAt : 0;
        const localTs = Number(localStorage.getItem(FAV_TS_KEY) || 0);

        if (firestoreTs > 0 && localTs > firestoreTs && !pushInFlight) {
            // Local was modified more recently — push local to Firestore, don't
            // overwrite local with stale Firestore data.
            pushInFlight = true;
            const localItems = await getLocalFavs();
            await pushFavourites(uid, localItems);
            pushInFlight = false;
        } else {
            // Firestore is same or newer (or documents predate this versioning) —
            // apply to local and record the Firestore timestamp so future snapshots
            // of our own write don't look "stale".
            onChange('favourites', data.items || []);
            if (firestoreTs > 0) {
                localStorage.setItem(FAV_TS_KEY, String(firestoreTs));
            }
        }
    }, err => {
        console.error('Firestore favourites snapshot error:', err.code, err.message);
        eventBus.$emit('syncError', 'Sync error — favourites may be out of date.');
    });

    return () => { unsubFav(); };
}

function toPlain(items) {
    return JSON.parse(JSON.stringify(items));
}

// Write favourites to Firestore.
// Sets clientUpdatedAt so onSnapshot can tell whether Firestore or local is newer.
// Also updates localStorage so our own echoed snapshot doesn't look stale.
export function pushFavourites(uid, items) {
    const clientUpdatedAt = Date.now();
    localStorage.setItem(FAV_TS_KEY, String(clientUpdatedAt));
    return setDoc(favDoc(uid), {
        items: toPlain(items),
        updatedAt: serverTimestamp(),
        clientUpdatedAt,
    }).catch(console.error);
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

    return onSnapshot(collectionRef(uid, name), async snap => {
        const upserts = [];
        const removals = [];
        for (const change of snap.docChanges()) {
            if (change.type === 'removed') removals.push(change.doc.id);
            else upserts.push(change.doc.data());
        }

        if (upserts.length || removals.length) {
            await applyRemote(upserts, removals);
        }

        if (!seeded && !snap.metadata.fromCache) {
            seeded = true;
            const local = await getLocal();
            const remoteIDs = new Set(snap.docs.map(d => d.id));
            const missing = (local || []).filter(r => r && r.id && !remoteIDs.has(String(r.id)));
            if (missing.length) await pushRecords(uid, name, missing);
        }
    }, err => {
        console.error(`Firestore ${name} snapshot error:`, err.code, err.message);
        eventBus.$emit('syncError', `Sync error — ${name} may be out of date.`);
    });
}

export function pushRecord(uid, name, record) {
    if (!record || record.id == null) return Promise.resolve();
    return setDoc(recordRef(uid, name, record.id), toPlain(record)).catch(console.error);
}

export async function pushRecords(uid, name, records) {
    const usable = (records || []).filter(r => r && r.id != null);
    for (let i = 0; i < usable.length; i += BATCH_LIMIT) {
        const batch = writeBatch(db);
        for (const record of usable.slice(i, i + BATCH_LIMIT)) {
            batch.set(recordRef(uid, name, record.id), toPlain(record));
        }
        await batch.commit().catch(console.error);
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
