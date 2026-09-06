// Tests for firestore.rules, against the Firestore emulator.
//
// Run with:  npm run test:rules
//   (which is `firebase emulators:exec --only firestore` around this file —
//    it needs the emulator and therefore Java, so it is deliberately NOT in
//    the `npm test` chain, which stays dependency-free and fast.)
//
// ⚠️ firebase-tools 14+ requires JDK 21. On a machine with an older JDK the
// emulator refuses to start with "no longer supports Java version before 21",
// which has nothing to do with these rules. Either install a newer JDK, or run
// the last CLI that accepts Java 11:
//
//   npx firebase-tools@13 emulators:exec --only firestore \
//     --project demo-folkfriend-rules "node test/firestoreRules.test.mjs"
//
// Note firebase-tools 13 also rejects a `rules` path outside the project
// directory, which is why firestore.rules sits next to firebase.json in app/
// rather than at the repo root.
//
// Two different things are being checked here, and the second is the one that
// bites quietly:
//
//   - SECURITY: a user reaches their own data and nobody else's. This is the
//     only security property the app has — there is no sharing of any kind.
//   - ACCEPTANCE: the rules accept the EXACT documents the app writes. An
//     over-strict rule does not announce itself. The write is rejected, the
//     local IndexedDB copy is already saved and is what every view reads, and
//     the sync failure only reaches console.error — so the app looks perfect
//     while silently syncing nothing. The record shapes below are copied from
//     store.addSighting / store.namePlace / liveAnalysis._persistSession, and
//     that is the point of them: if a field changes there and not here, this
//     fails rather than the user's evening quietly not leaving their phone.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
    initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, deleteDoc } from 'firebase/firestore';

const here = path.dirname(fileURLToPath(import.meta.url));
const rulesPath = path.join(here, '..', 'firestore.rules');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`);
    }
}

// --- the shapes the app actually writes ------------------------------------
//
// Kept as functions rather than constants so a test can vary one field without
// mutating what the next test sends.

// store.addSighting, with a location fix and a matched place.
const sighting = (over = {}) => ({
    id: '1757000000000-42-a1b2c3',
    tuneID: '42',
    settingID: '420',
    displayName: 'The Kesh',
    timestamp: 1757000000000,
    source: 'live',
    lat: 53.3489,
    lon: -6.2795,
    accuracy: 12,
    placeID: 'place-1757000000000-x1y2z3',
    ...over,
});

// store.namePlace.
const place = (over = {}) => ({
    id: 'place-1757000000000-x1y2z3',
    name: 'The Cobblestone',
    lat: 53.3489,
    lon: -6.2795,
    radiusM: 150,
    createdAt: 1757000000000,
    ...over,
});

// liveAnalysis._persistSession.
const liveSession = (over = {}) => ({
    id: 'session-1757000000000-q7w8e9',
    startedAt: 1757000000000,
    endedAt: 1757003600000,
    tunes: [{
        tuneId: 42,
        settingId: '420',
        sourceUrl: 'https://thesession.org/tunes/42',
        dataset: 'thesession',
        title: 'The Kesh',
        startSeconds: 0,
        endSeconds: 55,
        bestScore: 0.87,
    }],
    lat: 53.3489,
    lon: -6.2795,
    accuracy: 12,
    ...over,
});

const PATHS = {
    sightings: r => `users/alice/sightings/${r.id}`,
    places: r => `users/alice/places/${r.id}`,
    liveSessions: r => `users/alice/liveSessions/${r.id}`,
};

let testEnv;
let alice;
let bob;
let anon;

function write(db, collectionName, record) {
    return setDoc(doc(db, PATHS[collectionName](record)), record);
}

async function run() {
    testEnv = await initializeTestEnvironment({
        projectId: 'demo-folkfriend-rules',
        firestore: { rules: await readFile(rulesPath, 'utf8') },
    });
    await testEnv.clearFirestore();

    alice = testEnv.authenticatedContext('alice').firestore();
    bob = testEnv.authenticatedContext('bob').firestore();
    anon = testEnv.unauthenticatedContext().firestore();

    console.log('\nthe documents the app actually writes are accepted');

    await test('a sighting with a fix and a matched place', async () => {
        await assertSucceeds(write(alice, 'sightings', sighting()));
    });

    await test('a sighting with no fix at all', async () => {
        // "A sighting is recorded even with no fix" is a load-bearing rule of
        // the feature — refused permission, or a cellar with no signal.
        await assertSucceeds(write(alice, 'sightings', sighting({
            id: 'no-fix-1', lat: null, lon: null, accuracy: null, placeID: null,
        })));
    });

    await test('a manually tagged sighting, which has no settingID', async () => {
        await assertSucceeds(write(alice, 'sightings', sighting({
            id: 'manual-1', settingID: null, source: 'manual', displayName: '',
        })));
    });

    await test('a place', async () => {
        await assertSucceeds(write(alice, 'places', place()));
    });

    await test('a live session that is still open (endedAt null)', async () => {
        // Every session is written this way first — Stop flushes with endedAt
        // null, and only Clear finalizes it. Rejecting these would mean only
        // finished sessions ever synced.
        await assertSucceeds(write(alice, 'liveSessions', liveSession({
            id: 'session-open', endedAt: null,
        })));
    });

    await test('a live session recorded with geo-tagging off', async () => {
        await assertSucceeds(write(alice, 'liveSessions', liveSession({
            id: 'session-nogeo', lat: null, lon: null, accuracy: null,
        })));
    });

    await test('a long session — an evening is dozens of tunes', async () => {
        const tunes = Array.from({ length: 120 }, (_, i) => ({
            tuneId: i, settingId: String(i), sourceUrl: '', dataset: 'thesession',
            title: `Tune ${i}`, startSeconds: i * 60, endSeconds: i * 60 + 55, bestScore: 0.7,
        }));
        await assertSucceeds(write(alice, 'liveSessions', liveSession({
            id: 'session-long', tunes,
        })));
    });

    await test('the favourites document still works', async () => {
        await assertSucceeds(setDoc(doc(alice, 'users/alice/data/favourites'), {
            items: [], clientUpdatedAt: Date.now(),
        }));
    });

    await test('an update to an existing record, as a resumed session makes', async () => {
        await assertSucceeds(write(alice, 'liveSessions', liveSession()));
        await assertSucceeds(write(alice, 'liveSessions', liveSession({
            tunes: [...liveSession().tunes, {
                tuneId: 99, settingId: '990', sourceUrl: '', dataset: 'thesession',
                title: 'Another', startSeconds: 60, endSeconds: 120, bestScore: 0.8,
            }],
        })));
    });

    await test('deleting a record, as Clear and un-tagging do', async () => {
        await assertSucceeds(write(alice, 'sightings', sighting({ id: 'to-delete' })));
        await assertSucceeds(deleteDoc(doc(alice, 'users/alice/sightings/to-delete')));
    });

    console.log('\nowners reach their own data and nobody reaches anyone else\'s');

    await test('a user reads their own records back', async () => {
        await assertSucceeds(getDoc(doc(alice, PATHS.sightings(sighting()))));
    });

    await test('another signed-in user cannot read them', async () => {
        await assertFails(getDoc(doc(bob, PATHS.sightings(sighting()))));
    });

    await test('another signed-in user cannot write into them', async () => {
        await assertFails(write(bob, 'sightings', sighting({ id: 'bobs-forgery' })));
    });

    await test('another signed-in user cannot delete them', async () => {
        await assertFails(deleteDoc(doc(bob, PATHS.sightings(sighting()))));
    });

    await test('an unauthenticated client reaches nothing', async () => {
        await assertFails(getDoc(doc(anon, PATHS.sightings(sighting()))));
        await assertFails(write(anon, 'sightings', sighting({ id: 'anon-1' })));
        await assertFails(getDoc(doc(anon, 'users/alice/data/favourites')));
    });

    await test('nothing outside users/{uid} is reachable at all', async () => {
        await assertFails(getDoc(doc(alice, 'somethingElse/x')));
        await assertFails(setDoc(doc(alice, 'somethingElse/x'), { a: 1 }));
    });

    console.log('\nmalformed records are refused');

    await test('a record whose id does not match its document id', async () => {
        // Addressed by one id and carrying another, it would be written where
        // nothing looks it up — silent loss rather than an error.
        await assertFails(setDoc(
            doc(alice, 'users/alice/sightings/some-doc-id'),
            sighting({ id: 'a-different-id' }),
        ));
    });

    await test('a sighting with no tune', async () => {
        const { tuneID, ...withoutTune } = sighting({ id: 'no-tune' });
        await assertFails(write(alice, 'sightings', withoutTune));
    });

    await test('a place with no name', async () => {
        await assertFails(write(alice, 'places', place({ id: 'p-noname', name: '' })));
    });

    await test('a session whose tunes are not a list', async () => {
        await assertFails(write(alice, 'liveSessions', liveSession({
            id: 'session-bad', tunes: 'not-a-list',
        })));
    });

    await testEnv.cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);
}

run().catch(async e => {
    console.error(e);
    if (testEnv) await testEnv.cleanup();
    process.exit(1);
});
