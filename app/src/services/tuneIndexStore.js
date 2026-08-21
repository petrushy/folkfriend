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
//     writeDataset() is the point of no return — once it returns, that
//     dataset's previous copy is gone — so nothing may call it with a payload
//     that has not been parsed, structurally checked (indexPayloadProblem) and
//     successfully loaded into WASM. See _installDatasets in worker.js.
//
//  6. EVERY DELETE IS SCOPED TO ONE DATASET. The index is now stored as one
//     payload per dataset (thesession / folkwiki / norbeck), and a corrupt or
//     unreadable folkwiki must never cost the user their thesession copy.
//     This is the failure mode the multi-dataset split introduces, and the
//     one the fault-injection tests are aimed at.

import { get, set, del, keys } from 'idb-keyval';

// Bump when the on-disk format changes; a mismatched manifest is discarded.
//
// Schema 3 is the per-dataset layout. Bumping is load-bearing, not cosmetic:
// the "this payload is not a tune index, discard it" branch in readDataset
// fires only when the manifest names OUR schema. If the per-dataset reader
// still called itself schema 2 it would consider the old merged blob's
// manifest its own and could delete the very thing migration depends on.
export const SCHEMA_VERSION = 3;

// The pre-multi-dataset single-blob layout. Read-only from here on.
export const MERGED_SCHEMA_VERSION = 2;

// A real index carries ~62k settings. This floor exists only to reject things
// that are obviously not the tune index at all — an error document, a captive
// portal's JSON, nud-meta.json served from the wrong path, `{}`. It is kept
// deliberately low: a false rejection here means the user can never update
// again, which is a far worse outcome than accepting a small odd payload.
export const MIN_PLAUSIBLE_SETTINGS = 100;

// Schema 3: one payload and one manifest per dataset.
const rawKey = (id) => `ffIndexRaw:${id}`;
const manifestKey = (id) => `ffIndexManifest:${id}`;

// Schema 2: the merged thesession+folkwiki blob. Still read, so an upgrading
// user keeps working offline while the per-dataset copies download, and only
// deleted once every selected dataset is committed AND loaded (see
// clearSupersededMergedCopies).
const KEY_MERGED_MANIFEST = 'ffIndexManifest';
const KEY_MERGED_RAW = 'ffIndexRaw';

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
// `tuneIDs` is the distinct set of tune ids in this payload. It is collected
// here rather than in a second pass because this loop already walks all 62k
// settings; the worker uses it to label every tune with the dataset it came
// from (datasetByTune), which is what replaced the old "infer the source from
// the numeric ID range" rule.
//
// NOTE: this mutates `parsed` in place (deliberately — cloning 42 MB just to
// blank a field is not free). Callers pass a freshly parsed object.
export function splitIndexPayload(parsed) {
    const abcStrings = {};
    const sourceUrls = {};
    const tuneIDs = new Set();
    const settings = parsed.settings || {};
    for (const settingID in settings) {
        const setting = settings[settingID];
        abcStrings[settingID] = setting.abc;
        setting.abc = '';
        if (setting.source_url) {
            sourceUrls[settingID] = setting.source_url;
            delete setting.source_url;
        }
        tuneIDs.add(setting.tune_id);
    }
    return { indexData: parsed, abcStrings, sourceUrls, tuneIDs };
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

// Read one dataset's offline copy.
//
// Never throws. Applies the whole readIndex ruleset, SCOPED TO ONE DATASET:
// every delete below touches only this id's two keys, so a corrupt folkwiki
// cannot cost the user their thesession copy.
//
// Resolves to { id, index: {indexData, abcStrings, sourceUrls, tuneIDs},
// manifest } or null.
export async function readDataset(id) {
    const manifest = await safeGet(manifestKey(id));
    const raw = await safeGet(rawKey(id));

    // A payload that parses AND looks like a tune index is usable, full stop.
    // Never discard one because its bookkeeping looks odd — an offline user has
    // no way to get it back. The structural check is not bookkeeping: it is the
    // difference between "this is a tune index" and "this is some other JSON
    // document", and it is the only thing standing between a payload written by
    // an older build (which committed before validating) and an install that
    // can never load and is never replaced.
    if (typeof raw === 'string' && raw.length > 0) {
        try {
            console.time(`index-parse-from-cache:${id}`);
            const parsed = JSON.parse(raw);
            console.timeEnd(`index-parse-from-cache:${id}`);

            const problem = indexPayloadProblem(parsed);
            if (problem) {
                // Unusable — but "don't use it" and "destroy it" are separate
                // decisions, and only one of them is irreversible.
                //
                // Delete ONLY when this build's own schema wrote it AND the
                // manifest claims to be this dataset. A manifest naming another
                // schema (or no manifest at all) may be a NEWER format a later
                // release wrote and this older client cannot recognise — the
                // same "I can't consume it, therefore it must be junk"
                // reasoning that used to delete a perfectly good copy whenever
                // WASM failed to load it. Retaining it costs nothing:
                // writeDataset targets the same keys, so the next validated
                // download overwrites it either way.
                const ours = manifest
                    && manifest.schema === SCHEMA_VERSION
                    && manifest.dataset === id;
                console.warn(`Cached ${id} index is not a tune index (${problem}); `
                    + (ours ? 'discarding' : 'keeping it but not using it'));
                if (ours) await clearDataset(id);
                return null;
            }

            let effective = manifest;
            if (!manifest || manifest.schema !== SCHEMA_VERSION) {
                // Payload with no (or an unrecognised) manifest: still perfectly
                // good data, we just don't know its version. Report v=0 so an
                // update is attempted when there is a connection, rather than
                // throwing away the only copy the user has.
                console.warn(`${id} payload present without a valid manifest; `
                    + 'using it and treating the version as unknown');
                effective = { schema: SCHEMA_VERSION, dataset: id, v: 0,
                    date: null, savedAt: null, bytes: raw.length,
                    versionUnknown: true };
            } else if (manifest.bytes && manifest.bytes !== raw.length) {
                // Manifest describes a different payload than the one on disk —
                // the two writes straddled an interruption. The payload is still
                // complete; only the version record is untrustworthy.
                console.warn(`${id} manifest does not match the stored payload; `
                    + 'using the payload and treating the version as unknown');
                effective = { ...manifest, v: 0, versionUnknown: true };
            }
            return { id, index: splitIndexPayload(parsed), manifest: effective };
        } catch (e) {
            // Genuinely unparseable — this is the only state worth clearing.
            console.warn(`Cached ${id} index failed to parse; discarding`, e);
            await clearDataset(id);
            return null;
        }
    }

    if (manifest) {
        // Manifest with no payload: nothing usable, drop the dangling record.
        console.warn(`${id} manifest present but payload missing`);
        await safeDel(manifestKey(id));
    }

    return null;
}

// Every dataset with something stored, whether or not this build knows about
// it and whether or not it is currently selected.
//
// Settings needs this to offer a deselected dataset back: an imported one is in
// no manifest and no default list, so without enumerating storage it vanishes
// from the UI the moment it is turned off — leaving 3 MB on disk that cannot be
// re-enabled or removed.
export async function listStoredDatasetIds() {
    try {
        const all = await keys();
        const prefix = 'ffIndexManifest:';
        return all
            .filter(k => typeof k === 'string' && k.startsWith(prefix))
            .map(k => k.slice(prefix.length));
    } catch (e) {
        console.warn('Could not enumerate stored datasets', e);
        return [];
    }
}

// One dataset's manifest, with no payload read or parse. Cheap.
export async function readDatasetManifest(id) {
    const manifest = await safeGet(manifestKey(id));
    return (manifest && manifest.schema === SCHEMA_VERSION) ? manifest : null;
}

// Read several datasets. Resolves to { parts, missing } where `parts` is in
// `ids` order and `missing` names the ones with no usable copy. One dataset
// failing never affects the others.
export async function readDatasets(ids) {
    const parts = [];
    const missing = [];
    for (const id of ids) {
        const part = await readDataset(id);
        if (part) {
            parts.push(part);
        } else {
            missing.push(id);
        }
    }
    return { parts, missing };
}

// Manifests only, no payload reads or parses. This is what Settings renders,
// and it must stay cheap enough to call on every visit.
//
// Returns { datasets: {id: manifest|null}, merged, legacy, storage }.
export async function readOfflineInventory(ids) {
    const datasets = {};
    // Anything stored counts, not just what was asked for — see
    // listStoredDatasetIds.
    const wanted = [...new Set([...(ids || []), ...await listStoredDatasetIds()])];
    for (const id of wanted) {
        const manifest = await safeGet(manifestKey(id));
        datasets[id] = (manifest && manifest.schema === SCHEMA_VERSION)
            ? manifest
            : null;
    }
    return {
        datasets,
        merged: await readMergedManifest(),
        legacy: await readLegacyManifest(),
        storage: await estimateStorage(),
    };
}

async function readMergedManifest() {
    const manifest = await safeGet(KEY_MERGED_MANIFEST);
    if (manifest && manifest.schema === MERGED_SCHEMA_VERSION) {
        return manifest;
    }
    return null;
}

async function readLegacyManifest() {
    const legacy = await safeGet(LEGACY_KEY_INDEX);
    if (legacy && legacy.indexData && legacy.abcStrings) {
        const meta = (await safeGet(LEGACY_KEY_META)) || {};
        return {
            schema: 1, v: meta.v || 0, date: meta.date || null,
            savedAt: null, bytes: null, legacy: true,
        };
    }
    return null;
}

// The pre-multi-dataset merged copy: schema 2 first, then schema 1.
//
// This is what keeps an upgrading user working. It is loaded at startup so the
// app is READY immediately, and only deleted once every selected dataset has a
// committed per-dataset copy that has loaded into WASM.
//
// Resolves to { index, manifest, datasets } or null. `datasets` names what the
// blob is known to contain — always thesession + folkwiki, because no merged
// blob was ever published with anything else in it.
export async function readMergedLegacyIndex() {
    const raw = await safeGet(KEY_MERGED_RAW);
    const manifest = await safeGet(KEY_MERGED_MANIFEST);

    if (typeof raw === 'string' && raw.length > 0) {
        try {
            console.time('index-parse-from-cache:merged');
            const parsed = JSON.parse(raw);
            console.timeEnd('index-parse-from-cache:merged');
            const problem = indexPayloadProblem(parsed);
            if (problem) {
                console.warn(`Merged tune index is not a tune index (${problem}); `
                    + 'keeping it but not using it');
                return null;
            }
            return {
                index: splitIndexPayload(parsed),
                manifest: manifest && manifest.schema === MERGED_SCHEMA_VERSION
                    ? { ...manifest, merged: true }
                    : { schema: MERGED_SCHEMA_VERSION, v: 0, date: null,
                        savedAt: null, bytes: raw.length,
                        versionUnknown: true, merged: true },
                datasets: ['thesession', 'folkwiki'],
            };
        } catch (e) {
            console.warn('Merged tune index failed to parse; discarding', e);
            await safeDel(KEY_MERGED_RAW);
            await safeDel(KEY_MERGED_MANIFEST);
        }
    }

    const legacy = await safeGet(LEGACY_KEY_INDEX);
    if (!legacy || !legacy.indexData || !legacy.abcStrings) {
        return null;
    }
    const meta = (await safeGet(LEGACY_KEY_META)) || {};
    console.debug('Loaded tune index from legacy (schema 1) cache');

    // Schema 1 stored the split form, so tuneIDs was never persisted. Derive
    // it, so a legacy blob labels its tunes the same way a fresh one does.
    const tuneIDs = new Set();
    const settings = (legacy.indexData && legacy.indexData.settings) || {};
    for (const settingID in settings) {
        tuneIDs.add(settings[settingID].tune_id);
    }

    return {
        index: {
            indexData: legacy.indexData,
            abcStrings: legacy.abcStrings,
            sourceUrls: legacy.sourceUrls || {},
            tuneIDs,
        },
        manifest: {
            schema: 1, v: meta.v || 0, date: meta.date || null,
            savedAt: null, bytes: null, legacy: true, merged: true,
        },
        datasets: ['thesession', 'folkwiki'],
    };
}

// Persist one dataset's raw JSON text. Throws on failure (quota, IDB
// unavailable) so callers can tell the user their offline copy did not save —
// silently failing here is exactly how people end up with no tunes on a plane.
//
// THIS DESTROYS THAT DATASET'S PREVIOUS OFFLINE COPY. Call it only with a
// payload that has already been parsed, passed indexPayloadProblem() and been
// loaded into WASM successfully — see rule 5 at the top of this file.
//
// It does NOT touch the merged blob. The merged copy covers two datasets and
// one per-dataset write covers one, so deleting it here would drop data that
// nothing has replaced yet. That is clearSupersededMergedCopies' job, and it
// only runs once the whole selection is committed.
//
// `metadata` is { v, date } from datasets.json.
export async function writeDataset(id, rawText, metadata) {
    if (typeof rawText !== 'string' || rawText.length === 0) {
        throw new Error(`refusing to write an empty ${id} payload`);
    }
    console.time(`index-persist:${id}`);

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
    //     a quota error — left the reader seeing "no offline copy", which then
    //     garbage-collected the payload. A failed update thereby deleted the
    //     working copy the user already had, and they discovered it the next
    //     time they were somewhere without a connection.
    //
    // With this order the worst case is a manifest that names the previous
    // version while the payload is the new one. Both are complete and valid;
    // the only consequence is one redundant update later. A failed write
    // leaves the previous copy exactly as it was.
    try {
        await set(rawKey(id), rawText);
    } catch (e) {
        // Do NOT delete anything. The previous payload is still intact and
        // still described by the existing manifest.
        console.timeEnd(`index-persist:${id}`);
        throw e;
    }

    const manifest = {
        schema: SCHEMA_VERSION,
        // Provenance. readDataset will only delete a payload whose manifest
        // agrees it is this dataset, so a future build that means something
        // else by this key is not ours to destroy.
        dataset: id,
        v: (metadata && metadata.v) || 0,
        date: (metadata && metadata.date) || null,
        savedAt: Date.now(),
        bytes: rawText.length,
    };
    // A dataset the user added by hand: it has no datasets.json entry, so the
    // manifest is the only place its name lives, and the update check must not
    // treat "not in the manifest" as an error for it.
    if (metadata && metadata.origin === 'user') {
        manifest.origin = 'user';
        manifest.label = metadata.label || id;
        if (metadata.url) manifest.url = metadata.url;
    }

    try {
        await set(manifestKey(id), manifest);
    } catch (e) {
        // The payload is on disk and usable; only the version record failed.
        // Leave it — a stale version means a redundant update, not data loss.
        console.warn(`${id} payload saved but its manifest did not`, e);
        console.timeEnd(`index-persist:${id}`);
        throw e;
    }

    console.timeEnd(`index-persist:${id}`);
    return manifest;
}

// Delete one dataset's copy. Scoped to that id, and never called on a failure
// path — the only routes here are an explicit confirmed tap in Settings and
// readDataset finding a payload that is provably not a tune index.
export async function clearDataset(id) {
    await safeDel(manifestKey(id));
    await safeDel(rawKey(id));
}

// Drop the superseded merged copies (schema 2 and schema 1).
//
// `coveredIds` is the set of datasets the caller has PROVED are committed —
// re-read from disk, not remembered from an install — and loaded into WASM.
// The merged blob holds thesession and folkwiki, so it is only redundant once
// both of those are covered.
//
// Returns true when something was deleted. A failure to delete is wasted quota,
// never data loss, so it is a warning rather than a throw.
export async function clearSupersededMergedCopies(coveredIds) {
    const covered = new Set(coveredIds || []);
    const needed = ['thesession', 'folkwiki'];
    if (!needed.every((id) => covered.has(id))) {
        return false;
    }
    const hadMerged = (await safeGet(KEY_MERGED_RAW)) !== undefined
        || (await safeGet(KEY_MERGED_MANIFEST)) !== undefined
        || (await safeGet(LEGACY_KEY_INDEX)) !== undefined;
    if (!hadMerged) {
        return false;
    }
    console.debug('Per-dataset copies cover the merged blob; reclaiming it');
    await safeDel(KEY_MERGED_MANIFEST);
    await safeDel(KEY_MERGED_RAW);
    await safeDel(LEGACY_KEY_INDEX);
    await safeDel(LEGACY_KEY_META);
    return true;
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
