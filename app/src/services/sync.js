import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import firebaseApp from './firebase.js';

const db = getFirestore(firebaseApp);

function favDoc(uid) {
    return doc(db, 'users', uid, 'data', 'favourites');
}

function histDoc(uid) {
    return doc(db, 'users', uid, 'data', 'history');
}

function mergeFavourites(local, remote) {
    const seen = new Set(local.map(f => f.result.settingID));
    const merged = [...local];
    for (const item of remote) {
        if (!seen.has(item.result.settingID)) {
            merged.push(item);
            seen.add(item.result.settingID);
        }
    }
    return merged;
}

function mergeHistory(local, remote) {
    // Key: tune_id if available, else timestamp string
    const key = item =>
        item.result.setting && item.result.setting.tune_id != null
            ? `tune:${item.result.setting.tune_id}`
            : `ts:${item.timestamp}`;

    const byKey = new Map();
    for (const item of [...local, ...remote]) {
        const k = key(item);
        const existing = byKey.get(k);
        if (!existing || item.timestamp > existing.timestamp) {
            byKey.set(k, item);
        }
    }
    return [...byKey.values()]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 100);
}

export async function pullAndMerge(uid, localFavs, localHistory) {
    const [favSnap, histSnap] = await Promise.all([
        getDoc(favDoc(uid)),
        getDoc(histDoc(uid)),
    ]);

    const remoteFavs = favSnap.exists() ? (favSnap.data().items || []) : [];
    const remoteHistory = histSnap.exists() ? (histSnap.data().items || []) : [];

    return {
        favourites: mergeFavourites(localFavs, remoteFavs),
        history: mergeHistory(localHistory, remoteHistory),
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
