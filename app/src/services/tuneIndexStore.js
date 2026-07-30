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

    const raw = await safeGet(KEY_RAW);

    // A payload that parses is usable, full stop. Never discard one because its
    // bookkeeping looks odd — an offline user has no way to get it back.
    if (typeof raw === 'string' && raw.length > 0) {
        try {
            console.time('index-parse-from-cache');
            const parsed = JSON.parse(raw);
            console.timeEnd('index-parse-from-cache');

            let effective = manifest;
            if (!manifest || manifest.schema !== SCHEMA_VERSION) {
                // Payload with no (or an unrecognised) manifest: still perfectly
                // good data, we just don't know its version. Report v=0 so an
                // update is attempted when there is a connection, rather than
                // throwing away the only copy the user has.
                console.warn('Tune index payload present without a valid manifest; '
                    + 'using it and treating the version as unknown');
                effective = { schema: SCHEMA_VERSION, v: 0, date: null,
                    savedAt: null, bytes: raw.length, versionUnknown: true };
            } else if (manifest.bytes && manifest.bytes !== raw.length) {
                // Manifest describes a different payload than the one on disk —
                // the two writes straddled an interruption. The payload is still
                // complete; only the version record is untrustworthy.
                console.warn('Tune index manifest does not match the stored payload; '
                    + 'using the payload and treating the version as unknown');
                effective = { ...manifest, v: 0, versionUnknown: true };
            }
            return { index: splitIndexPayload(parsed), manifest: effective };
        } catch (e) {
            // Genuinely unparseable — this is the only state worth clearing.
            console.warn('Cached tune index failed to parse; discarding', e);
            await clearIndex();
            return null;
        }
    }

    if (manifest) {
        // Manifest with no payload: nothing usable, drop the dangling record.
        console.warn('Tune index manifest present but payload missing');
        await safeDel(KEY_MANIFEST);
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

    // ORDERING IS A RELIABILITY PROPERTY. Payload first, manifest second, and
    // NOTHING is ever deleted on a failure path.
    //
    // This previously deleted the manifest first, "so a reader can't see a
    // half-written copy", and deleted the payload if the write failed. Both
    // were wrong and both could destroy a perfectly good offline copy:
    //
    //   - IndexedDB set() is a single transaction. It commits or it aborts;
    //     a payload can never be half-written. The pre-delete protected
    //     against something that cannot happen.
    //   - Between the delete and the new manifest there was a window with a
    //     payload and no manifest. Anything interrupting there — iOS
    //     suspending the worker, the app being backgrounded, the tab closing,
    //     a quota error — left readIndex seeing "no offline copy", which then
    //     garbage-collected the payload. A failed update thereby deleted the
    //     working copy the user already had, and they discovered it the next
    //     time they were somewhere without a connection.
    //
    // With this order the worst case is a manifest that names the previous
    // version while the payload is the new one. Both are complete and valid;
    // the only consequence is one redundant update later. A failed write
    // leaves the previous copy exactly as it was.
    try {
        await set(KEY_RAW, rawText);
    } catch (e) {
        // Do NOT delete anything. The previous payload is still intact and
        // still described by the existing manifest.
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

    try {
        await set(KEY_MANIFEST, manifest);
    } catch (e) {
        // The payload is on disk and usable; only the version record failed.
        // Leave it — a stale version means a redundant update, not data loss.
        console.warn('Tune index payload saved but its manifest did not', e);
        console.timeEnd('index-persist');
        throw e;
    }

    // The legacy copy is another ~42 MB of the same data. Drop it only once
    // the new one is fully committed.
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
