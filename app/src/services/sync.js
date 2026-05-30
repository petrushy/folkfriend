import { getFirestore, doc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import firebaseApp from './firebase.js';
import eventBus from '@/eventBus';

const db = getFirestore(firebaseApp);

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
