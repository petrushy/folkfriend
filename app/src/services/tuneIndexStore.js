// Durable offline storage for the tune index.
//
// The tune index is ~42 MB of JSON. It is the app's whole reason for working
// offline, so how it is persisted matters more than anything else in the
// caching stack.
//
// Design rules (learned the hard way — see docs/offline-architecture.md):
//
//  1. ONE copy, in IndexedDB. Previously the same 42 MB was ALSO held by the
//     service worker's StaleWhileRevalidate runtime cache, doubling quota use
//     for zero benefit and making eviction far more likely. The SW cache entry
//     has been removed; IndexedDB (+ navigator.storage.persist()) is the
//     single durable store.
//
//  2. Store the RAW JSON TEXT, not a parsed object graph. Structured-cloning
//     a 62k-entry object graph into IndexedDB is slow and is the operation
//     most likely to blow up (or be killed) on iOS. Cloning one big string is
//     effectively a memcpy. The split into {indexData, abcStrings, sourceUrls}
//     is re-derived on read by splitIndexPayload(), which is the same code the
//     download path uses — so the two can never disagree.
//
//  3. A separate MANIFEST key is the commit marker, and it is deleted first
//     and written last. There is therefore no state in which a manifest points
//     at a partially-written payload: an interrupted or quota-failed write
//     leaves no manifest, which reads as "no offline copy" rather than as
//     corrupt data.
//
//  4. Reads never throw. Every failure mode resolves to null ("no offline
//     copy"), because a hang or an exception here is what strands the user
//     with no tunes on a plane.

import { get, set, del } from 'idb-keyval';

// Bump when the on-disk format changes; a mismatched manifest is discarded.
export const SCHEMA_VERSION = 2;

const KEY_MANIFEST = 'ffIndexManifest';
const KEY_RAW = 'ffIndexRaw';

// Pre-schema-2 layout: a single structured-cloned object under 'tuneIndex'
// plus its version under 'tuneIndexMetadata'. Still readable so existing
// installs keep working offline without a 42 MB re-download.
const LEGACY_KEY_INDEX = 'tuneIndex';
const LEGACY_KEY_META = 'tuneIndexMetadata';

async function safeGet(key) {
    try {
        return await get(key);
    } catch (e) {
        console.warn(`IndexedDB read failed (${key})`, e);
        return undefined;
    }
}

async function safeDel(key) {
    try {
        await del(key);
    } catch (e) {
        console.warn(`IndexedDB delete failed (${key})`, e);
    }
}

// Split a parsed tune index into the three pieces the app actually uses.
//
// ABC strings and source URLs are stripped out of the object handed to WASM:
// loading 15 MB of ABC text into WebAssembly linear memory costs seconds on
// every startup and the Rust side never reads it. They are kept worker-side
// and re-attached to query results.
//
// NOTE: this mutates `parsed` in place (deliberately — cloning 42 MB just to
// blank a field is not free). Callers pass a freshly parsed object.
export function splitIndexPayload(parsed) {
    const abcStrings = {};
    const sourceUrls = {};
    const settings = parsed.settings || {};
    for (const settingID in settings) {
        const setting = settings[settingID];
        abcStrings[settingID] = setting.abc;
        setting.abc = '';
        if (setting.source_url) {
            sourceUrls[settingID] = setting.source_url;
            delete setting.source_url;
        }
    }
    return { indexData: parsed, abcStrings, sourceUrls };
}

// Read the manifest only — cheap enough to call from the UI for diagnostics.
// Returns null when there is no usable offline copy.
export async function readManifest() {
    const manifest = await safeGet(KEY_MANIFEST);
    if (manifest && manifest.schema === SCHEMA_VERSION) {
        return manifest;
    }
    const legacy = await safeGet(LEGACY_KEY_INDEX);
    if (legacy && legacy.indexData && legacy.abcStrings) {
        const meta = (await safeGet(LEGACY_KEY_META)) || {};
        return {
            schema: 1,
            v: meta.v || 0,
            date: meta.date || null,
            savedAt: null,
            bytes: null,
            legacy: true,
        };
    }
    return null;
}

// Load the offline copy, if there is a complete one.
// Resolves to { index: {indexData, abcStrings, sourceUrls}, manifest } or null.
export async function readIndex() {
    const manifest = await safeGet(KEY_MANIFEST);

    if (manifest && manifest.schema === SCHEMA_VERSION) {
        const raw = await safeGet(KEY_RAW);
        if (typeof raw === 'string' && raw.length > 0) {
            try {
                console.time('index-parse-from-cache');
                const parsed = JSON.parse(raw);
                console.timeEnd('index-parse-from-cache');
                return { index: splitIndexPayload(parsed), manifest };
            } catch (e) {
                console.warn('Cached tune index failed to parse; discarding', e);
            }
        } else {
            console.warn('Tune index manifest present but payload missing; discarding');
        }
        // Manifest without a usable payload is the one genuinely corrupt state.
        await clearIndex();
        return null;
    }

    // Manifest missing. Garbage-collect any orphaned payload left by a write
    // that ran out of quota part-way through, so it stops occupying space.
    if (manifest || (await safeGet(KEY_RAW)) !== undefined) {
        await clearIndex();
    }

    return await readLegacyIndex();
}

async function readLegacyIndex() {
    const legacy = await safeGet(LEGACY_KEY_INDEX);
    if (!legacy || !legacy.indexData || !legacy.abcStrings) {
        return null;
    }
    const meta = (await safeGet(LEGACY_KEY_META)) || {};
    console.debug('Loaded tune index from legacy (schema 1) cache');
    return {
        index: {
            indexData: legacy.indexData,
            abcStrings: legacy.abcStrings,
            sourceUrls: legacy.sourceUrls || {},
        },
        manifest: {
            schema: 1,
            v: meta.v || 0,
            date: meta.date || null,
            savedAt: null,
            bytes: null,
            legacy: true,
        },
    };
}

// Persist raw index JSON text. Throws on failure (quota, IDB unavailable) so
// callers can tell the user their offline copy did not save — silently failing
// here is exactly how people end up with no tunes on a plane.
//
// `metadata` is { v, date } from nud-meta.json.
export async function writeIndex(rawText, metadata) {
    console.time('index-persist');

    // Invalidate first: from here until the manifest is written, any reader
    // correctly sees "no offline copy" rather than a half-written one.
    await safeDel(KEY_MANIFEST);

    try {
        await set(KEY_RAW, rawText);
    } catch (e) {
        await safeDel(KEY_RAW);
        console.timeEnd('index-persist');
        throw e;
    }

    const manifest = {
        schema: SCHEMA_VERSION,
        v: (metadata && metadata.v) || 0,
        date: (metadata && metadata.date) || null,
        savedAt: Date.now(),
        bytes: rawText.length,
    };
    await set(KEY_MANIFEST, manifest);

    // Confirm the commit actually landed. IndexedDB resolves its transaction
    // only on commit, so this is a cheap belt-and-braces check that also
    // catches storage that silently drops writes.
    const check = await safeGet(KEY_MANIFEST);
    if (!check || check.savedAt !== manifest.savedAt) {
        await safeDel(KEY_RAW);
        console.timeEnd('index-persist');
        throw new Error('Offline copy did not commit to IndexedDB');
    }

    // The legacy copy is another ~42 MB of the same data. Drop it as soon as
    // schema 2 is safely on disk.
    await safeDel(LEGACY_KEY_INDEX);
    await safeDel(LEGACY_KEY_META);

    console.timeEnd('index-persist');
    return manifest;
}

export async function clearIndex() {
    await safeDel(KEY_MANIFEST);
    await safeDel(KEY_RAW);
}

// Best-effort quota diagnostics for the Settings page.
export async function estimateStorage() {
    if (!(typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate)) {
        return null;
    }
    try {
        const { usage, quota } = await navigator.storage.estimate();
        return { usage: usage || 0, quota: quota || 0 };
    } catch (e) {
        return null;
    }
}
