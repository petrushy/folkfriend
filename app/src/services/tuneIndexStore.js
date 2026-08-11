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
//
//  5. A KNOWN-GOOD COPY IS IMMUTABLE UNTIL A REPLACEMENT HAS PROVED ITSELF.
//     writeIndex() is the point of no return — once it returns, the previous
//     copy is gone — so nothing may call it with a payload that has not been
//     parsed, structurally checked (indexPayloadProblem) and successfully
//     loaded into WASM. See _downloadAndInstall in worker.js.

import { get, set, del } from 'idb-keyval';

// Bump when the on-disk format changes; a mismatched manifest is discarded.
export const SCHEMA_VERSION = 2;

// A real index carries ~62k settings. This floor exists only to reject things
// that are obviously not the tune index at all — an error document, a captive
// portal's JSON, nud-meta.json served from the wrong path, `{}`. It is kept
// deliberately low: a false rejection here means the user can never update
// again, which is a far worse outcome than accepting a small odd payload.
export const MIN_PLAUSIBLE_SETTINGS = 100;

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

// Structural sanity check on a freshly parsed index payload.
//
// JSON.parse alone is not enough to establish that a download is the tune
// index. A captive portal's login page is not valid JSON (so parse catches
// it), but an error document, a redirect body, nud-meta.json served from the
// wrong path, or a half-built dataset all parse perfectly well and would
// happily overwrite the user's only working copy.
//
// Returns null when `parsed` looks like a tune index, otherwise a short
// human-readable reason why it does not. Cheap: it samples one setting rather
// than walking 62k of them.
export function indexPayloadProblem(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'not a JSON object';
    }
    const settings = parsed.settings;
    const aliases = parsed.aliases;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return 'no settings object';
    }
    if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) {
        return 'no aliases object';
    }
    const settingIDs = Object.keys(settings);
    if (settingIDs.length < MIN_PLAUSIBLE_SETTINGS) {
        return `only ${settingIDs.length} settings (expected at least ${MIN_PLAUSIBLE_SETTINGS})`;
    }
    if (Object.keys(aliases).length === 0) {
        return 'no tune aliases';
    }
    // The Rust side deserialises settings with serde and unwraps, so a wrong
    // shape here is a WASM panic rather than an error. tune_id and contour are
    // deliberately strings on both sides (see rust/src/index/schema.rs).
    const sample = settings[settingIDs[0]];
    if (!sample || typeof sample !== 'object'
        || typeof sample.tune_id !== 'string'
        || typeof sample.contour !== 'string') {
        return 'settings entries are not tune settings';
    }
    return null;
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

    // A payload that parses AND looks like a tune index is usable, full stop.
    // Never discard one because its bookkeeping looks odd — an offline user has
    // no way to get it back. The structural check is not bookkeeping: it is the
    // difference between "this is the tune index" and "this is some other JSON
    // document", and it is the only thing standing between a payload written by
    // an older build (which committed before validating) and an install that
    // can never load and is never replaced.
    if (typeof raw === 'string' && raw.length > 0) {
        try {
            console.time('index-parse-from-cache');
            const parsed = JSON.parse(raw);
            console.timeEnd('index-parse-from-cache');

            const problem = indexPayloadProblem(parsed);
            if (problem) {
                console.warn(`Cached tune index is not a tune index (${problem}); discarding`);
                await clearIndex();
                return null;
            }

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
// THIS DESTROYS THE PREVIOUS OFFLINE COPY. Call it only with a payload that has
// already been parsed, passed indexPayloadProblem() and been loaded into WASM
// successfully — see rule 5 at the top of this file. The cheap guard below
// cannot prove that, but it does stop the two most obvious mistakes.
//
// `metadata` is { v, date } from nud-meta.json.
export async function writeIndex(rawText, metadata) {
    if (typeof rawText !== 'string' || rawText.length === 0) {
        throw new Error('refusing to write an empty tune index payload');
    }
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
