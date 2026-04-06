import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import firebaseApp from './firebase.js';

const db = getFirestore(firebaseApp);

function favDoc(uid) {
    return doc(db, 'users', uid, 'data', 'favourites');
}

function histDoc(uid) {
    return doc(db, 'users', uid, 'data', 'history');
}

// Firestore is the source of truth. On sign-in:
//   - If Firestore has data → use it (replace local).
//   - If Firestore is empty (first device) → seed it from local.
export async function pullOrSeed(uid, localFavs, localHistory) {
    const [favSnap, histSnap] = await Promise.all([
        getDoc(favDoc(uid)),
        getDoc(histDoc(uid)),
    ]);

    const remoteFavs = favSnap.exists() ? (favSnap.data().items ?? null) : null;
    const remoteHistory = histSnap.exists() ? (histSnap.data().items ?? null) : null;

    return {
        favourites: remoteFavs ?? localFavs,
        history: remoteHistory ?? localHistory,
        seeded: remoteFavs === null || remoteHistory === null,
    };
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
