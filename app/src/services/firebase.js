import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, enableMultiTabIndexedDbPersistence } from 'firebase/firestore';

// This **IS** okay to be public !!!
const firebaseConfig = {

  apiKey: "AIzaSyBrECdxMrbjPWWFkTu_Riqo2s1dbSVfjvM",

  authDomain: "folkfriend-petrush-fork.firebaseapp.com",

  projectId: "folkfriend-petrush-fork",

  storageBucket: "folkfriend-petrush-fork.firebasestorage.app",

  messagingSenderId: "253027926478",

  appId: "1:253027926478:web:08b816f209f93809de2b9f",

  measurementId: "G-7WY6R8QZVD"

};

const firebaseApp = initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(firebaseApp);

// The single Firestore instance. It lives here rather than in sync.js because
// persistence has to be enabled before anything else touches Firestore, and
// exporting it keeps a second getFirestore() call from creating a parallel
// view of the same data.
export const firestore = getFirestore(firebaseApp);

// Sightings and live sessions are synced as one document per record, so a
// device that re-downloaded every one of them on each launch would spend real
// mobile data doing it (the cap is 5000 sightings). With the local cache on,
// a launch reads from disk and the server only sends what actually changed.
//
// Never awaited and never fatal: every failure mode here — a second tab that
// won a race, a browser with no IndexedDB, private browsing — leaves Firestore
// working exactly as it did before, in memory. Sync correctness must not
// depend on it, and does not: the app's own IndexedDB is the source of truth
// for everything it displays, and Firestore is only the transport.
enableMultiTabIndexedDbPersistence(firestore).catch(e => {
    console.warn('[folkfriend sync] offline cache unavailable, using memory:', e && e.code, e);
});

export default firebaseApp;
