// Unit tests for geo-tagged tune sightings: the geometry, the store, and the
// service that decides when to spend a location fix.
//
// Run with:  node app/test/sightings.test.mjs
//
// The properties worth pinning here are not "does it save a record". They are
// the ones that make the feature either useful or a battery bug:
//
//   - the SAME TUNE IN SEVERAL PLACES must survive. This is the entire point,
//     and it is exactly what the existing history path destroys (addToHistory
//     deliberately drops the previous entry for a tune), so a future refactor
//     that "tidies up" sightings the same way must fail loudly.
//   - naming a place is RETROACTIVE. Users play somewhere for weeks before
//     bothering to name it; if naming only labelled future sightings the
//     feature would look broken to precisely the people using it most.
//   - a sighting is recorded WITHOUT a fix. Refused permission, no signal in a
//     cellar, or a slow radio must still leave "I heard this tune that night".
//   - deleting a place KEEPS its sightings. They are observations; the name was
//     only ever a label over them. Same reasoning as never deleting the offline
//     tune index on a failure path.
//   - ONE FIX PER SESSION. Concurrent callers join a single acquisition, a
//     cached fix is reused, and a refusal is not retried — that is the whole
//     battery argument, and it is invisible in code review.
//
// store.js and geo.js are loaded from source with their imports rewritten to
// in-memory fakes; places.mjs is used for real, being pure geometry.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-sightings');

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

// --- fakes ----------------------------------------------------------------

const FAKES = {
    'fake-idb.mjs': `
export const __db = new Map();
export async function get(key) { return __db.get(key); }
export async function set(key, value) { __db.set(key, value); }
export async function del(key) { __db.delete(key); }
`,
    'fake-eventbus.mjs': `
export const __events = [];
export default { $emit: (name, payload) => __events.push({ name, payload }), $on() {}, $off() {} };
`,
    'fake-sync.mjs': `
export const __pushes = [];
export function pushFavourites(uid, items) { __pushes.push(items); }
export function subscribe() { return () => {}; }
export function __reset() { __pushes.length = 0; }
`,
    'fake-ai.mjs': `
export const DEFAULT_MODEL = 'claude-haiku-4-5';
export function estimateCostUsd() { return 0; }
`,
    'fake-firebase-auth.mjs': `
export class GoogleAuthProvider {}
export const browserPopupRedirectResolver = {};
export async function signInWithPopup() {}
export async function signOut() {}
`,
    'fake-firebase-analytics.mjs': `
export function logEvent() {}
`,
};

class FakeLocalStorage {
    constructor() { this.map = new Map(); }
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
    setItem(key, value) { this.map.set(key, String(value)); }
    removeItem(key) { this.map.delete(key); }
}

async function writeFakes() {
    for (const [name, source] of Object.entries(FAKES)) {
        await writeFile(path.join(tmpDir, name), source);
    }
    for (const name of ['schema.js', 'places.mjs']) {
        await writeFile(
            path.join(tmpDir, name.replace('.js', '.mjs')),
            await readFile(path.join(srcDir, 'js', name), 'utf8'),
        );
    }
}

async function loadStore({ settings = {} } = {}) {
    await writeFakes();

    let source = await readFile(path.join(srcDir, 'services', 'store.js'), 'utf8');
    const replacements = [
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from 'idb-keyval'", "from './fake-idb.mjs'"],
        ["from '@/js/schema'", "from './schema.mjs'"],
        ["from '@/js/places.mjs'", "from './places.mjs'"],
        ["from './aiSummary.js'", "from './fake-ai.mjs'"],
        ["from 'firebase/auth'", "from './fake-firebase-auth.mjs'"],
        ["from './sync.js'", "from './fake-sync.mjs'"],
        ["from 'firebase/analytics'", "from './fake-firebase-analytics.mjs'"],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in store.js`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'store.mjs'), source);

    globalThis.localStorage = new FakeLocalStorage();
    globalThis.localStorage.setItem('userSettings', JSON.stringify({ geoTagDetections: true, ...settings }));

    const idb = await import(path.join(tmpDir, 'fake-idb.mjs'));
    idb.__db.clear();

    const mod = await import(`${path.join(tmpDir, 'store.mjs')}?v=${Math.random()}`);
    return { store: mod.default, idb };
}

// geo.js is loaded with a hand-written store fake rather than the real store —
// it only reads userSettings, and pulling the real one in would drag Firebase
// into a test about the location radio.
let geoLoadCounter = 0;
async function loadGeo({ enabled = true } = {}) {
    const n = ++geoLoadCounter;
    const storeName = `fake-geo-store-${n}.mjs`;
    await writeFile(path.join(tmpDir, storeName), `
export default { userSettings: { geoTagDetections: ${enabled} } };
`);
    let source = await readFile(path.join(srcDir, 'services', 'geo.js'), 'utf8');
    const from = "from './store.js'";
    assert.ok(source.includes(from), 'expected geo.js to import the store');
    source = source.split(from).join(`from './${storeName}'`);
    const out = path.join(tmpDir, `geo-${n}.mjs`);
    await writeFile(out, source);
    const mod = await import(out);
    return mod.default;
}

// --- fake geolocation -----------------------------------------------------

const geoEnv = {
    calls: 0,
    // A queue of outcomes; the last one repeats once exhausted.
    outcomes: [],
    // Held callbacks, for testing that concurrent callers share one request.
    pending: [],
    manual: false,
};

function resetGeoEnv() {
    geoEnv.calls = 0;
    geoEnv.outcomes = [];
    geoEnv.pending = [];
    geoEnv.manual = false;
}

function installGeoGlobals() {
    globalThis.document = { visibilityState: 'visible' };
    // Node 22 exposes a getter-only global `navigator`, so plain assignment
    // throws — it has to be redefined.
    defineGlobal('navigator', {
        geolocation: {
            getCurrentPosition(onSuccess, onError, options) {
                geoEnv.calls++;
                const outcome = geoEnv.outcomes.length > 1
                    ? geoEnv.outcomes.shift()
                    : geoEnv.outcomes[0];
                if (geoEnv.manual) {
                    geoEnv.pending.push({ onSuccess, onError, options });
                    return;
                }
                queueMicrotask(() => {
                    if (!outcome) return;
                    if (outcome.error) onError(outcome.error);
                    else onSuccess(outcome);
                });
            },
        },
    });
}

function defineGlobal(name, value) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const position = (lat, lon, accuracy = 12) => ({ coords: { latitude: lat, longitude: lon, accuracy } });

// Dublin city centre, and a spot ~60 m away — inside a place radius but far
// enough that a coarse fix would confuse them, which is why geo.js asks for
// high accuracy.
const COBBLESTONE = { lat: 53.3489, lon: -6.2795 };
const NEARBY = { lat: 53.3494, lon: -6.2795 };
// Stockholm — unambiguously a different venue.
const STOCKHOLM = { lat: 59.3293, lon: 18.0686 };

// --- tests: geometry ------------------------------------------------------

async function run() {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    const places = await import(path.join(srcDir, 'js', 'places.mjs'));

    console.log('\nplaces.mjs — geometry and clustering');

    await test('haversine measures a short hop and a long one', () => {
        assert.ok(Math.abs(places.haversineMetres(COBBLESTONE, NEARBY) - 56) < 6);
        // Dublin to Stockholm, great-circle, is ~1630 km.
        const km = places.haversineMetres(COBBLESTONE, STOCKHOLM) / 1000;
        assert.ok(km > 1600 && km < 1660, `expected ~1630 km, got ${km}`);
    });

    await test('an invalid or zeroed fix never matches anything', () => {
        assert.equal(places.isValidFix({ lat: 0, lon: 0 }), false);
        assert.equal(places.isValidFix({ lat: 91, lon: 0 }), false);
        assert.equal(places.isValidFix(null), false);
        assert.equal(places.haversineMetres({ lat: 0, lon: 0 }, COBBLESTONE), Infinity);
        assert.equal(places.matchPlace({ lat: 0, lon: 0 }, [{ id: 'p', ...COBBLESTONE }]), null);
    });

    await test('matchPlace picks the nearest place that actually contains the fix', () => {
        const near = { id: 'tight', name: 'Tight', ...COBBLESTONE, radiusM: 10 };
        const wide = { id: 'wide', name: 'Wide', ...COBBLESTONE, radiusM: 500 };
        // NEARBY is ~56 m away: outside the tight radius, inside the wide one.
        assert.equal(places.matchPlace(NEARBY, [near, wide]).id, 'wide');
        assert.equal(places.matchPlace(COBBLESTONE, [near, wide]).id, 'tight');
        assert.equal(places.matchPlace(STOCKHOLM, [near, wide]), null);
    });

    await test('unplaced sightings cluster by proximity, deterministically', () => {
        const sightings = [
            { id: 'a', tuneID: '1', timestamp: 3000, ...COBBLESTONE },
            { id: 'b', tuneID: '2', timestamp: 1000, ...NEARBY },
            { id: 'c', tuneID: '1', timestamp: 2000, ...STOCKHOLM },
        ];
        const clusters = places.clusterUnplacedSightings(sightings);
        assert.equal(clusters.length, 2);
        // Most recent first.
        assert.equal(clusters[0].count, 2);
        assert.equal(clusters[0].tuneCount, 2);
        assert.equal(clusters[1].count, 1);
        // Same input, same output — the UI offers these as nameable proposals.
        const again = places.clusterUnplacedSightings([...sightings].reverse());
        assert.deepEqual(again.map(c => c.count), clusters.map(c => c.count));
    });

    await test('a sighting pointing at a deleted place resurfaces as unnamed', () => {
        const sightings = [{ id: 'a', tuneID: '1', timestamp: 1, placeID: 'gone', ...COBBLESTONE }];
        const grouped = places.groupSightingsByPlace(sightings, []);
        assert.equal(grouped.length, 1);
        assert.equal(grouped[0].place, null);
        assert.equal(grouped[0].count, 1);
    });

    await test('placesForTune reports every place one tune was heard', () => {
        const cobblestone = { id: 'p1', name: 'The Cobblestone', ...COBBLESTONE };
        const sightings = [
            { id: 'a', tuneID: '42', timestamp: 1, placeID: 'p1' },
            { id: 'b', tuneID: '42', timestamp: 2, placeID: 'p1' },
            { id: 'c', tuneID: '42', timestamp: 3, placeID: null, ...STOCKHOLM },
            { id: 'd', tuneID: '99', timestamp: 4, placeID: 'p1' },
        ];
        const found = places.placesForTune(sightings, [cobblestone], '42');
        assert.equal(found.length, 2);
        const named = found.find(f => f.place);
        assert.equal(named.place.name, 'The Cobblestone');
        assert.equal(named.count, 2);
        // Unnamed sightings collapse into one bucket rather than a row each.
        assert.equal(found.find(f => !f.place).count, 1);
    });

    await test('projectPoints keeps north up and survives a single point', () => {
        const projected = places.projectPoints([COBBLESTONE, { lat: 53.36, lon: -6.2795 }]);
        // The more northerly point must have the smaller y (SVG grows downward).
        assert.ok(projected[1].y < projected[0].y);
        const single = places.projectPoints([COBBLESTONE]);
        assert.deepEqual([single[0].x, single[0].y], [0.5, 0.5]);
        assert.equal(places.projectPoints([]), null);
    });

    // --- tests: store ------------------------------------------------------

    console.log('\nstore — the sightings log');

    await test('the same tune in several places is kept, not deduplicated', async () => {
        const { store } = await loadStore();
        await store.addSighting({ tuneID: '42', displayName: 'The Kesh', fix: COBBLESTONE, timestamp: 1000 });
        await store.addSighting({ tuneID: '42', displayName: 'The Kesh', fix: STOCKHOLM, timestamp: 5_000_000 });
        const sightings = await store.getSightings();
        assert.equal(sightings.length, 2, 'both hearings of the same tune must survive');
        assert.deepEqual(new Set(sightings.map(s => Math.round(s.lat))), new Set([53, 59]));
    });

    await test('the same tune twice in one minute is one sighting', async () => {
        const { store } = await loadStore();
        const now = Date.now();
        await store.addSighting({ tuneID: '42', fix: COBBLESTONE, timestamp: now });
        const second = await store.addSighting({ tuneID: '42', fix: COBBLESTONE, timestamp: now + 5000 });
        assert.equal(second, null, 'a double tap must not log twice');
        assert.equal((await store.getSightings()).length, 1);
    });

    await test('a sighting is recorded with no fix at all', async () => {
        const { store } = await loadStore();
        const sighting = await store.addSighting({ tuneID: '42', displayName: 'The Kesh', fix: null });
        assert.ok(sighting, 'a refused or unavailable location must not lose the record');
        assert.equal(sighting.lat, null);
        assert.equal(sighting.placeID, null);
        assert.equal((await store.getSightings()).length, 1);
    });

    await test('a sighting inside a known place is tagged with it on the spot', async () => {
        const { store } = await loadStore();
        await store.namePlace({ name: 'The Cobblestone', ...COBBLESTONE });
        const sighting = await store.addSighting({ tuneID: '42', fix: NEARBY });
        const [place] = await store.getPlaces();
        assert.equal(sighting.placeID, place.id);
    });

    await test('naming a place is retroactive over past sightings', async () => {
        const { store } = await loadStore();
        // Six evenings before anyone thought to name the pub.
        for (let i = 0; i < 6; i++) {
            await store.addSighting({ tuneID: String(i), fix: NEARBY, timestamp: 1000 + i * 120_000 });
        }
        await store.addSighting({ tuneID: '99', fix: STOCKHOLM, timestamp: 9_000_000 });

        const place = await store.namePlace({ name: 'The Cobblestone', ...COBBLESTONE });
        const sightings = await store.getSightings();
        const tagged = sightings.filter(s => s.placeID === place.id);
        assert.equal(tagged.length, 6, 'every past sighting in range must adopt the new name');
        assert.equal(sightings.find(s => s.tuneID === '99').placeID, null, 'a distant sighting must not be swept in');
    });

    await test('naming a second place does not steal another place\'s sightings', async () => {
        const { store } = await loadStore();
        await store.addSighting({ tuneID: '1', fix: COBBLESTONE, timestamp: 1000 });
        const first = await store.namePlace({ name: 'The Cobblestone', ...COBBLESTONE });
        // A second, overlapping place named later.
        const second = await store.namePlace({ name: 'Upstairs Room', ...NEARBY });
        const sightings = await store.getSightings();
        assert.equal(sightings[0].placeID, first.id, 'an explicit assignment must not be reassigned');
        assert.notEqual(sightings[0].placeID, second.id);
    });

    await test('deleting a place keeps its sightings and returns them to unnamed', async () => {
        const { store } = await loadStore();
        await store.namePlace({ name: 'The Cobblestone', ...COBBLESTONE });
        await store.addSighting({ tuneID: '42', fix: COBBLESTONE });
        const [place] = await store.getPlaces();

        await store.deletePlace(place.id);
        const sightings = await store.getSightings();
        assert.equal(sightings.length, 1, 'tidying up a name must never destroy an observation');
        assert.equal(sightings[0].placeID, null);
        assert.equal((await store.getPlaces()).length, 0);
    });

    await test('renaming a place keeps its id, so its sightings stay attached', async () => {
        const { store } = await loadStore();
        const place = await store.namePlace({ name: 'That pub', ...COBBLESTONE });
        await store.addSighting({ tuneID: '42', fix: COBBLESTONE });
        const renamed = await store.namePlace({ id: place.id, name: 'The Cobblestone', ...COBBLESTONE });
        assert.equal(renamed.id, place.id);
        assert.equal((await store.getPlaces()).length, 1);
        assert.equal((await store.getSightings())[0].placeID, place.id);
    });

    await test('an empty or invalid name is refused rather than stored', async () => {
        const { store } = await loadStore();
        assert.equal(await store.namePlace({ name: '   ', ...COBBLESTONE }), null);
        assert.equal(await store.namePlace({ name: 'Nowhere', lat: NaN, lon: NaN }), null);
        assert.equal((await store.getPlaces()).length, 0);
    });

    await test('a sighting with no tune is not recorded', async () => {
        const { store } = await loadStore();
        assert.equal(await store.addSighting({ tuneID: null, fix: COBBLESTONE }), null);
        assert.equal(await store.addSighting({ tuneID: '', fix: COBBLESTONE }), null);
        assert.equal((await store.getSightings()).length, 0);
    });

    await test('sightings are exported and restored, and an old backup does not wipe them', async () => {
        const { store } = await loadStore();
        await store.namePlace({ name: 'The Cobblestone', ...COBBLESTONE });
        await store.addSighting({ tuneID: '42', fix: COBBLESTONE });

        const exported = JSON.parse(await store.exportUserData());
        assert.equal(exported.version, 4);
        assert.equal(exported.tuneSightings.length, 1);
        assert.equal(exported.places.length, 1);

        await store.clearSightings();
        assert.equal((await store.getSightings()).length, 0);

        await store.importUserData(JSON.stringify(exported));
        assert.equal((await store.getSightings()).length, 1);
        assert.equal((await store.getPlaces()).length, 1);

        // A v3 backup predates the feature; restoring it must not be read as
        // "this user has no sightings".
        await store.importUserData(JSON.stringify({ version: 3, historyItems: [], favouriteItems: [] }));
        assert.equal((await store.getSightings()).length, 1, 'an older backup must not delete sightings');
    });

    await test('sightings are never written to the favourites document', async () => {
        const { store, idb } = await loadStore();
        await store.addSighting({ tuneID: '42', fix: COBBLESTONE });
        const favourites = idb.__db.get('favouriteItems') || [];
        const serialised = JSON.stringify(favourites);
        assert.ok(!serialised.includes('53.34'), 'coordinates must not reach the synced favourites array');
    });

    // --- tests: the geo service -------------------------------------------

    console.log('\ngeo.js — one fix per session');

    await test('nothing is requested while the setting is off', async () => {
        resetGeoEnv();
        installGeoGlobals();
        geoEnv.outcomes = [position(53.3489, -6.2795)];
        const geo = await loadGeo({ enabled: false });
        geo.beginSession();
        assert.equal(await geo.getFix(), null);
        assert.equal(geoEnv.calls, 0, 'a disabled feature must never raise a permission prompt');
    });

    await test('a cached fix is reused instead of spending a second one', async () => {
        resetGeoEnv();
        installGeoGlobals();
        geoEnv.outcomes = [position(53.3489, -6.2795)];
        const geo = await loadGeo();
        const first = await geo.getFix();
        const second = await geo.getFix();
        assert.equal(geoEnv.calls, 1, 'the radio must be spun once per session, not once per tune');
        assert.deepEqual(first, second);
        assert.equal(first.accuracy, 12);
    });

    await test('concurrent callers join one acquisition', async () => {
        resetGeoEnv();
        installGeoGlobals();
        geoEnv.manual = true;
        const geo = await loadGeo();
        const all = Promise.all([geo.getFix(), geo.getFix(), geo.getFix()]);
        assert.equal(geoEnv.calls, 1, 'three detections in one cycle must not cost three fixes');
        geoEnv.pending[0].onSuccess(position(53.3489, -6.2795));
        const results = await all;
        assert.equal(results[0].lat, 53.3489);
        assert.deepEqual(results[1], results[2]);
    });

    await test('a refusal is sticky — no retry, no re-prompt', async () => {
        resetGeoEnv();
        installGeoGlobals();
        geoEnv.outcomes = [{ error: { code: 1, message: 'denied' } }];
        const geo = await loadGeo();
        assert.equal(await geo.getFix(), null);
        assert.equal(await geo.getFix(), null);
        assert.equal(geoEnv.calls, 1, 'the user said no once; asking again is both rude and expensive');
        assert.equal(geo.lastError.kind, 'denied');
        assert.equal(await geo.permissionState(), 'denied');
    });

    await test('a timeout leaves the previous fix in place rather than nulling it', async () => {
        resetGeoEnv();
        installGeoGlobals();
        geoEnv.outcomes = [position(53.3489, -6.2795), { error: { code: 3, message: 'timeout' } }];
        const geo = await loadGeo();
        const good = await geo.getFix();
        // Force a re-acquisition by ageing the cached fix past its lifetime.
        geo._fix.at = Date.now() - (31 * 60 * 1000);
        const after = await geo.getFix();
        assert.deepEqual(after, good, 'a failed refresh must not discard a usable fix');
        assert.equal(geo.lastError.kind, 'timeout');
    });

    await test('a backgrounded app does not request a position', async () => {
        resetGeoEnv();
        installGeoGlobals();
        geoEnv.outcomes = [position(53.3489, -6.2795)];
        const geo = await loadGeo();
        globalThis.document.visibilityState = 'hidden';
        assert.equal(await geo.getFix(), null);
        assert.equal(geoEnv.calls, 0, 'a prompt the user cannot see is worse than no fix');
        globalThis.document.visibilityState = 'visible';
        assert.ok(await geo.getFix());
    });

    await test('beginSession keeps a fix taken seconds ago', async () => {
        resetGeoEnv();
        installGeoGlobals();
        geoEnv.outcomes = [position(53.3489, -6.2795)];
        const geo = await loadGeo();
        await geo.getFix();
        geo.beginSession();
        await geo.getFix();
        assert.equal(geoEnv.calls, 1, 'record → search → record must not cost three fixes');
    });

    await test('beginSession drops a stale fix so a new venue is not mislabelled', async () => {
        resetGeoEnv();
        installGeoGlobals();
        geoEnv.outcomes = [position(53.3489, -6.2795), position(59.3293, 18.0686)];
        const geo = await loadGeo();
        await geo.getFix();
        geo._fix.at = Date.now() - (10 * 60 * 1000);
        geo.beginSession();
        const fix = await geo.getFix();
        assert.equal(Math.round(fix.lat), 59, 'an evening later, somewhere else, must re-fix');
    });

    await test('a garbled position is rejected rather than stored as 0,0', async () => {
        resetGeoEnv();
        installGeoGlobals();
        geoEnv.outcomes = [{ coords: { latitude: 'nonsense', longitude: null, accuracy: 5 } }];
        const geo = await loadGeo();
        assert.equal(await geo.getFix(), null);
        assert.equal(geo.peekFix(), null);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    await rm(tmpDir, { recursive: true, force: true });
    if (failed) process.exit(1);
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
