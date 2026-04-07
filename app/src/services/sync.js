import { getFirestore, doc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import firebaseApp from './firebase.js';

const db = getFirestore(firebaseApp);

function favDoc(uid) {
    return doc(db, 'users', uid, 'data', 'favourites');
}

// Subscribe to real-time Firestore updates for favourites and folders.
// - On first snapshot: if Firestore has data → use it; if empty → seed from local.
// - On subsequent snapshots: always use Firestore (source of truth), call onChange.
// Returns an unsubscribe function to call on sign-out.
export function subscribe(uid, localFavs, localFolders, onChange) {
    let seeded = false;

    const unsubFav = onSnapshot(favDoc(uid), snap => {
        if (!snap.exists()) {
            if (!seeded) {
                seeded = true;
                pushFavourites(uid, localFavs, localFolders);
            }
        } else {
            const data = snap.data();
            onChange('favourites', data.items || [], data.folders || []);
        }
    });

    return () => { unsubFav(); };
}

function toPlain(items) {
    return JSON.parse(JSON.stringify(items));
}

export function pushFavourites(uid, items, folders = []) {
    setDoc(favDoc(uid), {
        items: toPlain(items),
        folders: toPlain(folders),
        updatedAt: serverTimestamp(),
    }).catch(console.error);
}
