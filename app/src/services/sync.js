import { getFirestore, doc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import firebaseApp from './firebase.js';

const db = getFirestore(firebaseApp);

function favDoc(uid) {
    return doc(db, 'users', uid, 'data', 'favourites');
}

function histDoc(uid) {
    return doc(db, 'users', uid, 'data', 'history');
}

// Subscribe to real-time Firestore updates for both favourites and history.
// - On first snapshot: if Firestore has data → use it; if empty → seed from local.
// - On subsequent snapshots: always use Firestore (source of truth), call onChange.
// Returns an unsubscribe function to call on sign-out.
export function subscribe(uid, localFavs, localHistory, onChange) {
    let favSeeded = false;
    let histSeeded = false;

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

    const unsubHist = onSnapshot(histDoc(uid), snap => {
        if (!snap.exists()) {
            if (!histSeeded) {
                histSeeded = true;
                pushHistory(uid, localHistory);
            }
        } else {
            onChange('history', snap.data().items || []);
        }
    });

    return () => { unsubFav(); unsubHist(); };
}

function toPlain(items) {
    return JSON.parse(JSON.stringify(items));
}

export function pushFavourites(uid, items) {
    setDoc(favDoc(uid), { items: toPlain(items), updatedAt: serverTimestamp() }).catch(console.error);
}

export function pushHistory(uid, items) {
    setDoc(histDoc(uid), { items: toPlain(items), updatedAt: serverTimestamp() }).catch(console.error);
}
