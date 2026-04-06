import { getFirestore, doc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import firebaseApp from './firebase.js';

const db = getFirestore(firebaseApp);

function favDoc(uid) {
    return doc(db, 'users', uid, 'data', 'favourites');
}

// Subscribe to real-time Firestore updates for favourites.
// - On first snapshot: if Firestore has data → use it; if empty → seed from local.
// - On subsequent snapshots: always use Firestore (source of truth), call onChange.
// Returns an unsubscribe function to call on sign-out.
export function subscribe(uid, localFavs, onChange) {
    let favSeeded = false;

    const unsubFav = onSnapshot(favDoc(uid), snap => {
        if (!snap.exists()) {
            if (!favSeeded) {
                favSeeded = true;
                pushFavourites(uid, localFavs);
            }
        } else {
            onChange('favourites', snap.data().items || []);
        }
    });

    return () => { unsubFav(); };
}

function toPlain(items) {
    return JSON.parse(JSON.stringify(items));
}

export function pushFavourites(uid, items) {
    setDoc(favDoc(uid), { items: toPlain(items), updatedAt: serverTimestamp() }).catch(console.error);
}
