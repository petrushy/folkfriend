import * as Comlink from '@/js/comlink';
import ffConfig from '@/ffConfig';
import {
    readDataset,
    readDatasets,
    listStoredDatasetIds,
    readDatasetManifest,
    readOfflineInventory,
    readMergedLegacyIndex,
    writeDataset,
    clearDataset,
    clearSupersededMergedCopies,
    splitIndexPayload,
    indexPayloadProblem,
} from '@/services/tuneIndexStore';
import {
    fetchDatasetsManifest,
    fetchDatasetText,
    fetchUserDatasetText,
    isDefinitelyOffline,
    NetworkUnavailableError,
} from '@/services/tuneIndexNetwork';

// Index lifecycle. Every one of these is terminal-or-progressing — there is no
// state the app can get stuck in silently, which was the old design's flaw:
// `loadedIndex` was a promise that never settled on failure, so every caller
// (settingsFromTuneID, runNameQuery, …) hung forever and each view had to
// invent its own timeout.
export const INDEX_STATUS = {
    LOADING: 'loading',       // reading the offline copy
    DOWNLOADING: 'downloading', // no offline copy; fetching one
    READY: 'ready',           // usable
    UNAVAILABLE: 'unavailable', // no offline copy and no usable network
};

// What a fresh install searches. thesession only: folkwiki's detections are
// still unreliable enough that shipping them on by default makes the app look
// worse than it is to someone trying it for the first time. It stays a
// one-tap opt-in in Settings, is still published, and an existing user's
// selection is never narrowed by this — see LEGACY_TUNE_DATASETS in store.js.
export const DEFAULT_DATASETS = ['thesession'];

// The ids the published manifest manages, which is a DIFFERENT question from
// what a fresh install selects. It is the list an import may not claim: storing
// under one of these names would put an unvetted file behind a name the app
// manages, to be overwritten — or not — by the next CDN update depending on
// ordering. Deselecting folkwiki must not make that name available, so this
// cannot be derived from DEFAULT_DATASETS.
export const PUBLISHED_DATASETS = ['thesession', 'folkwiki'];

// PARTIAL SUCCESS IS READY.
//
// With two of three selected datasets loaded, queries work and return real
// tunes. Reporting UNAVAILABLE would make backend.indexReady() resolve false
// and push Tune.vue and Search.vue into favourites-only mode — strictly worse
// than searching the 62k tunes the user does have, and it would take the whole
// app down whenever one small file 404s. This is the same usability-vs-status
// distinction the status machine already draws for background updates.
//
// There is deliberately NO 'partial' status: a dozen `status === 'ready'`
// comparisons across the app would silently stop matching. The detail carries
// datasetsLoaded / datasetsMissing / datasetErrors instead, and Search.vue
// surfaces a note when something is missing — this codebase has three separate
// scars from failures that were invisible for a whole session.

// Merge N split dataset payloads into the single object WASM is given.
//
// Object.assign, not a deep merge: settings and aliases are flat maps keyed by
// globally unique IDs. The builders own disjoint ID ranges and the data repo
// verifies disjointness at build time, so a collision here is a data bug, not
// something to reconcile.
//
// datasetByTune is REBUILT WHOLESALE on every merge and never updated
// incrementally. That is what keeps it from drifting out of agreement with
// what is actually loaded in WASM — the same hazard class as abcStringBySetting.
// A part with `id === null` is a BASE: the pre-multi-dataset merged blob, used
// to fill gaps for datasets that have not been migrated to their own file yet.
// It never overwrites a real dataset file, and it is processed last so the
// dataset files always win. Without it, the first per-dataset load during a
// migration would replace WASM with only that dataset and silently drop every
// source still living in the blob.
function isBasePart(part) {
    return part.id === null || part.id === undefined;
}

// Collisions between ONE candidate part and everything it would be merged
// with — including the legacy migration base.
//
// mergeIndexParts deliberately exempts the base from its collision counts: it
// holds older copies of the very datasets being migrated, so overlap there is
// expected. That exemption is right for a published dataset replacing itself
// and WRONG for an import, which has no business overlapping anything. And
// because the base is processed last, a candidate processed before it never
// sees the overlap either — so an import made while migration is deferred
// (auto-update off, or a migration that failed) could shadow thesession or
// folkwiki IDs that currently live only in the merged blob.
//
// This is deliberately independent of merge order.
export function collisionsForPart(candidate, otherParts) {
    const settingIDs = new Set();
    const tuneIDs = new Set();
    for (const part of otherParts) {
        const data = part.index.indexData || {};
        for (const settingID in (data.settings || {})) settingIDs.add(settingID);
        for (const tuneID in (data.aliases || {})) tuneIDs.add(tuneID);
        for (const tuneID of part.index.tuneIDs || []) tuneIDs.add(tuneID);
    }

    const data = candidate.index.indexData || {};
    let settings = 0;
    for (const settingID in (data.settings || {})) {
        if (settingIDs.has(settingID)) settings++;
    }
    // A set, so a tune that clashes both by alias and by tuneIDs counts once.
    const clashedTunes = new Set();
    for (const tuneID in (data.aliases || {})) {
        if (tuneIDs.has(tuneID)) clashedTunes.add(tuneID);
    }
    for (const tuneID of candidate.index.tuneIDs || []) {
        if (tuneIDs.has(tuneID)) clashedTunes.add(tuneID);
    }
    return { settings, tunes: clashedTunes.size };
}

// Where a part's data came from. Parts read from disk carry their manifest;
// parts built inline during an install carry an explicit origin.
export function partOrigin(part) {
    if (part.origin) return part.origin;
    if (part.manifest && part.manifest.origin) return part.manifest.origin;
    return 'cdn';
}

// Drop any USER-ORIGIN part that would collide with something else in this
// merge, and say which.
//
// The invariant is "no imported dataset ever shadows another dataset's IDs",
// and it has to be enforced HERE — at every merge — not only where an import
// is added. Checking only at the import site left the collision reachable by
// coming at it from the other end: deselect thesession, import something that
// reuses its IDs (accepted, because thesession is not in the merge), then
// re-enable thesession. That merge is triggered by the selection change, not
// by the import, so nothing re-checked it.
//
// The offending part is DROPPED rather than the whole merge refused: at
// startup, refusing outright would leave the user with no index at all, which
// is far worse than leaving out one imported dataset. Published data always
// wins; among imports, the first in selection order wins.
export function vetUserParts(parts) {
    const official = parts.filter(p => partOrigin(p) !== 'user');
    const kept = [...official];
    const rejected = [];

    for (const part of parts) {
        if (partOrigin(part) !== 'user') continue;
        const counts = collisionsForPart(part, kept);
        if (counts.settings || counts.tunes) {
            rejected.push({ id: part.id, ...counts });
        } else {
            kept.push(part);
        }
    }

    return {
        parts: parts.filter(p => kept.includes(p)),   // original order
        rejected,
    };
}

export function mergeIndexParts(parts) {
    if (parts.length === 1) {
        // Overwhelmingly the common case; skip copying 62k keys.
        const part = parts[0];
        const datasetByTune = {};
        if (!isBasePart(part)) {
            for (const tuneID of part.index.tuneIDs || []) {
                datasetByTune[tuneID] = part.id;
            }
        }
        return { ...part.index, datasetByTune, collisions: 0,
            tuneCollisions: 0, empty: [] };
    }

    const settings = {};
    const aliases = {};
    const abcStrings = {};
    const sourceUrls = {};
    const datasetByTune = {};
    // Counted SEPARATELY. A setting-id clash hides one setting; a tune-id
    // clash is worse — the later dataset's aliases overwrite the earlier
    // tune's NAME, its datasetByTune entry relabels the source, and the Rust
    // side groups both datasets' settings under one tune. Counting only
    // setting ids let a dataset with fresh setting ids but recycled tune ids
    // pass every check.
    let collisions = 0;
    let tuneCollisions = 0;
    const empty = [];

    // Dataset files first, the merged base last — it only fills what they left.
    const ordered = [...parts.filter(p => !isBasePart(p)),
                     ...parts.filter(isBasePart)];
    const hasBase = ordered.length !== parts.filter(p => !isBasePart(p)).length;

    for (const part of ordered) {
        const base = isBasePart(part);
        const partSettings = (part.index.indexData && part.index.indexData.settings) || {};
        let added = 0;
        for (const settingID in partSettings) {
            if (settings[settingID] !== undefined) {
                // The base is EXPECTED to overlap — it holds older copies of
                // the very datasets being migrated. Only a collision between
                // two dataset files is a data bug worth counting.
                if (!base) collisions++;
                continue;
            }
            added++;
            settings[settingID] = partSettings[settingID];
        }
        // A dataset file contributing NO new setting IDs is a duplicate of
        // something already merged — which happens if datasets.json points two
        // entries at the same file. Both documents pass indexPayloadProblem
        // perfectly, and without this the failure presents as "folkwiki is
        // missing" with no error reported anywhere. The check is meaningless
        // once a base is present, since the base already holds everything.
        if (added === 0 && !base && !hasBase) empty.push(part.id);

        // Counted through a set: the same tune arrives twice, once via its
        // alias entry and once via tuneIDs, and counting both reported double
        // the real number.
        const clashedTunes = new Set();
        const partAliases = (part.index.indexData && part.index.indexData.aliases) || {};
        if (!base) {
            for (const tuneID in partAliases) {
                if (aliases[tuneID] !== undefined) clashedTunes.add(tuneID);
            }
        }
        assignMissing(aliases, partAliases, base);
        assignMissing(abcStrings, part.index.abcStrings || {}, base);
        assignMissing(sourceUrls, part.index.sourceUrls || {}, base);

        // Base tunes are deliberately left UNLABELLED: the merged blob cannot
        // say which source a tune came from, so source.mjs falls back to the ID
        // range, which is exactly what that fallback is for.
        if (!base) {
            for (const tuneID of part.index.tuneIDs || []) {
                if (datasetByTune[tuneID] !== undefined
                    && datasetByTune[tuneID] !== part.id) {
                    clashedTunes.add(tuneID);
                }
                datasetByTune[tuneID] = part.id;
            }
            tuneCollisions += clashedTunes.size;
        }
    }

    return {
        indexData: { settings, aliases },
        abcStrings,
        sourceUrls,
        datasetByTune,
        collisions,
        tuneCollisions,
        empty,
    };
}

function assignMissing(target, source, gapFillOnly) {
    if (!gapFillOnly) {
        Object.assign(target, source);
        return;
    }
    for (const key in source) {
        if (target[key] === undefined) target[key] = source[key];
    }
}


class FolkFriendWASMWrapper {
    constructor() {
        this.folkfriendWASM = null;
        this.abcStringBySetting = {};
        this.sourceUrlBySetting = {};
        // tuneID -> dataset id, for everything that used to infer the source
        // from the numeric ID range. Rebuilt wholesale by every merge.
        this.datasetByTune = {};

        // Reusable per-frame PCM buffer in WASM linear memory. Allocated once
        // (lazily on first feed) and reused forever — previous code allocated
        // a fresh buffer per frame which the Rust side forgot, leaking ~2 MB
        // of WASM heap per analysis cycle.
        this._pcmWindowPtr = null;

        this.loadedWASM = new Promise(resolve => {
            this.setLoadedWASM = resolve;
        });
        this.loadedSampleRate = new Promise(resolve => {
            this.setLoadedSampleRate = resolve;
        });

        // --- Index state machine -------------------------------------------
        // Whether an index is actually loaded into WASM and queryable. This is
        // deliberately SEPARATE from indexStatus, which describes what the
        // pipeline is doing. They are not the same thing: during a background
        // update the status is 'downloading' while the previously loaded index
        // remains perfectly usable. Conflating them made every query return
        // empty for the whole duration of an update.
        this.indexUsable = false;
        // Startup update check. Can be turned off in Settings — the offline copy
        // is the app's whole reason for working in a pub with no signal, and
        // some users would rather it were never touched without asking.
        this.autoUpdateEnabled = true;
        this.indexStatus = INDEX_STATUS.LOADING;
        this.indexDetail = {};
        this._statusSubscribers = [];
        // Resolves the first time the index reaches a terminal state. Unlike
        // the old `loadedIndex`, this ALWAYS settles — including on failure —
        // so no caller can hang.
        this._indexSettled = new Promise(resolve => {
            this._resolveIndexSettled = resolve;
        });
        this._setupInFlight = null;
        // Guards the whole install (metadata → download → validate → WASM load
        // → persist). SEPARATE from _setupInFlight, which cannot cover it:
        // setup fires the background update check WITHOUT awaiting it and then
        // clears _setupInFlight, so a manual refresh a second later saw no
        // guard at all and ran a second install concurrently.
        this._indexUpdateInFlight = null;
        // Serialises installs that are NOT subsets of each other. A plain
        // `while (inFlight) await inFlight` is wrong: two waiters both wake,
        // both see null, and both start an install.
        this._installChain = Promise.resolve();
        // Which datasets the user wants, pushed from userSettings before setup.
        // Intent, not fact — what is actually installed is derived from disk.
        this.selectedDatasets = [...DEFAULT_DATASETS];
        // id -> { v, date, source } for what is currently loaded in WASM.
        this.loadedDatasets = {};
        // Set while the merged blob is loaded and per-dataset copies have not
        // replaced it yet.
        this._migrationPending = false;
        // What is actually loaded in WASM right now. Kept apart from
        // indexDetail because indexDetail describes the PIPELINE: mid-update it
        // reads 'downloading' and carries no version, so a snapshot taken then
        // would restore READY with v=undefined on failure.
        this._loadedIndexInfo = null;

        import ('@/wasm/folkfriend.js').then(wasm => {
            this.folkfriendWASM = new wasm.FolkFriendWASM();
            this.setLoadedWASM();
        });
    }

    async version(cb) {
        await this.loadedWASM;
        cb(this.folkfriendWASM.version());
    }

    // --- Index status plumbing ---------------------------------------------

    _setIndexStatus(status, detail = {}) {
        this.indexStatus = status;
        // `usable` travels with every status update so the UI can distinguish
        // "busy" from "broken". A background update is busy; the app is still
        // fully functional and must not show a loading state or fall back to
        // favourites while it runs.
        this.indexDetail = { ...detail, status, usable: this.indexUsable };
        if (status === INDEX_STATUS.READY || status === INDEX_STATUS.UNAVAILABLE) {
            this._resolveIndexSettled(status);
        }
        for (const cb of this._statusSubscribers) {
            try {
                // Comlink proxy call — returns a promise we don't await.
                Promise.resolve(cb(this.indexDetail)).catch(() => {});
            } catch (e) {
                console.warn('Index status subscriber threw', e);
            }
        }
    }

    // Register a callback fired on every index status change. Fired once
    // immediately with the current state so a late subscriber (e.g. a view
    // mounted after startup) can never miss the transition — the old one-shot
    // `indexLoaded` event was exactly that bug.
    async subscribeIndexStatus(cb) {
        this._statusSubscribers.push(cb);
        cb(this.indexDetail && this.indexDetail.status
            ? this.indexDetail
            : { status: this.indexStatus });
    }

    async getIndexStatus(cb) {
        cb(this.indexDetail && this.indexDetail.status
            ? this.indexDetail
            : { status: this.indexStatus });
    }

    // Capture enough of the current state to put it back if an install fails.
    //
    // Taken BEFORE _downloadAndInstall, because that sets DOWNLOADING as its
    // first action: asking "was it ready?" afterwards always answers no, which
    // is how a failed manual refresh used to report UNAVAILABLE while the old
    // index was still loaded and answering queries perfectly.
    _snapshotIndexState() {
        return {
            usable: this.indexUsable,
            info: this._loadedIndexInfo
                ? JSON.parse(JSON.stringify(this._loadedIndexInfo))
                : null,
            datasets: { ...this.loadedDatasets },
        };
    }

    // Put back the state captured by _snapshotIndexState after a failed
    // install. An install that fails changes nothing durable (the offline copy
    // is only written once a download has proved itself) and leaves the
    // previously loaded index in WASM, so if we had a usable index we still do.
    //
    // ONLY for an install that THREW — the manifest fetch failed, or every
    // dataset in it failed. A partially successful install did NOT fail: it
    // returns { installed, failed } and sets READY itself, and restoring a
    // stale snapshot over that would undo real progress.
    _restoreAfterFailedInstall(snapshot, error) {
        const message = (error && error.message) || String(error);
        if (snapshot.usable) {
            const info = snapshot.info || {};
            this.loadedDatasets = { ...snapshot.datasets };
            this._setIndexStatus(INDEX_STATUS.READY, {
                source: info.source || 'cache',
                v: info.v,
                date: info.date,
                legacy: !!info.legacy,
                merged: !!info.merged,
                datasetsLoaded: Object.keys(snapshot.datasets || {}),
                datasetsMissing: this.selectedDatasets.filter(
                    id => !(snapshot.datasets || {})[id]),
                updateError: message,
            });
        } else {
            this._setIndexStatus(INDEX_STATUS.UNAVAILABLE, {
                reason: error instanceof NetworkUnavailableError ? 'network' : 'error',
                message,
                offline: isDefinitelyOffline(),
            });
        }
    }

    // Await a terminal index state and report whether it is usable. Returns
    // promptly once the state machine has settled — index-dependent calls use
    // this instead of blocking on a promise that may never resolve.
    async _indexIsUsable() {
        // An index that is loaded stays usable no matter what the pipeline is
        // doing. In particular a background update ('downloading') must NOT
        // make queries fail: the old index is still in WASM and still answers
        // correctly until the new one replaces it.
        if (this.indexUsable) return true;
        if (this.indexStatus === INDEX_STATUS.UNAVAILABLE) return false;
        await this._indexSettled;
        return this.indexUsable;
    }


    // --- Index acquisition --------------------------------------------------
    //
    // Ordering rule: THE OFFLINE COPY ALWAYS WINS THE RACE. We load whatever is
    // on disk and declare the app usable before touching the network, then
    // check for a newer version in the background. The old code awaited the
    // metadata request before completing setup, so a stalled connection (plane
    // Wi-Fi) left the whole app in "loading" — which is what made every tune
    // view sit through its own 15 s timeout.

    async setupTuneIndex(cb) {
        // Re-entrancy guard: 'online' events and the Settings page can both
        // ask for a retry while one is already running.
        if (this._setupInFlight) {
            const analytics = await this._setupInFlight;
            cb(analytics);
            return;
        }
        this._setupInFlight = this._setupTuneIndexUnguarded();
        try {
            cb(await this._setupInFlight);
        } finally {
            this._setupInFlight = null;
        }
    }

    async _setupTuneIndexUnguarded() {
        const t0 = performance.now();
        const analyticsData = {
            'newly_installed': false,
            'newly_updated': false,
        };
        console.time('tune-index-setup');

        let cachedLoadError = null;
        const selected = [...this.selectedDatasets];

        // An empty selection is a legitimate choice, not a failure. It gets its
        // own terminal reason so backend's 'online' retry can skip it — without
        // that, every network blip re-runs a setup that cannot possibly succeed.
        if (selected.length === 0) {
            this._setIndexStatus(INDEX_STATUS.UNAVAILABLE,
                { reason: 'no-datasets-selected' });
            analyticsData.error = 'No tune databases are selected.';
            return this._finishSetup(analyticsData, t0);
        }

        try {
            const { parts, missing } = await readDatasets(selected);

            if (parts.length > 0) {
                try {
                    const merged = await this.loadMergedIndex(parts);
                    this._recordLoadedDatasets(
                        parts, 'cache', missing, merged.rejected);
                    analyticsData['tune_index_metadata_version'] = this._loadedIndexInfo.v;
                    analyticsData['tune_index_metadata_date'] = this._loadedIndexInfo.date || null;
                    analyticsData['days_since_update'] = 0;
                    // The VETTED set, not the parts we set out to load — a
                    // part the merge dropped is not loaded.
                    analyticsData['datasets_loaded'] =
                        Object.keys(this.loadedDatasets).join(',');
                    const notLoaded = [...missing, ...this.selectedDatasets.filter(
                        id => !this.loadedDatasets[id] && !missing.includes(id))];
                    if (notLoaded.length) {
                        analyticsData['datasets_missing'] = notLoaded.join(',');
                    }

                    // Deliberately NOT awaited: the app is already usable, and
                    // neither the update check nor fetching a missing dataset
                    // may gate readiness.
                    this._afterCacheLoad(parts, missing).catch(e =>
                        console.warn('Background tune index work failed', e));

                    return this._finishSetup(analyticsData, t0);
                } catch (e) {
                    // KEEP THE COPIES. Failing to consume the data is not proof
                    // that the data is bad: readDataset has already established
                    // that each payload parses and is shaped like a tune index,
                    // so the likely causes here are memory pressure, a worker
                    // killed mid-load, or a bug in this particular build — all
                    // of which a later launch may well survive. Deleting them
                    // meant one bad startup cost the user their only offline
                    // copy, and they found out the next time they had no signal.
                    cachedLoadError = (e && e.message) || String(e);
                    console.warn('Cached datasets failed to load into WASM; '
                        + 'keeping the offline copies and trying the network', e);
                }
            }

            // No per-dataset copies. Before touching the network, look for the
            // pre-multi-dataset merged blob: an upgrading user has 42 MB of
            // perfectly good tunes on disk and must not be stranded while the
            // per-dataset files download.
            const merged = await readMergedLegacyIndex();
            if (merged && !cachedLoadError) {
                try {
                    await this.loadMergedIndex([{
                        id: null, index: merged.index,
                    }], merged.datasets);
                    this._migrationPending = true;
                    this.loadedDatasets = {};
                    for (const id of merged.datasets) {
                        this.loadedDatasets[id] = {
                            v: merged.manifest.v,
                            date: merged.manifest.date,
                            source: 'merged',
                        };
                    }
                    this._loadedIndexInfo = {
                        source: 'cache',
                        merged: true,
                        legacy: !!merged.manifest.legacy,
                        v: merged.manifest.v,
                        date: merged.manifest.date,
                        datasets: { ...this.loadedDatasets },
                    };
                    this._setIndexStatus(INDEX_STATUS.READY, {
                        ...this._loadedIndexInfo,
                        migrationPending: true,
                        datasetsLoaded: [...merged.datasets],
                        datasetsMissing: selected.filter(
                            id => !merged.datasets.includes(id)),
                    });
                    analyticsData['tune_index_metadata_version'] = merged.manifest.v;
                    analyticsData['tune_index_metadata_date'] = merged.manifest.date || null;
                    analyticsData['migration_pending'] = true;

                    this._migrateFromMerged(selected).catch(e =>
                        console.warn('Migration from the merged copy failed', e));

                    return this._finishSetup(analyticsData, t0);
                } catch (e) {
                    cachedLoadError = (e && e.message) || String(e);
                    console.warn('Merged tune index failed to load into WASM; '
                        + 'keeping it and trying the network', e);
                }
            }

            // Nothing usable on disk. This is the path that must fail FAST when
            // there is no network — the user gets favourites-only mode
            // immediately instead of after a multi-minute hang.
            if (isDefinitelyOffline()) {
                this._setIndexStatus(INDEX_STATUS.UNAVAILABLE, {
                    reason: 'offline',
                    offline: true,
                    loadError: cachedLoadError,
                    datasetsMissing: selected,
                });
                analyticsData.error = 'No offline copy of the tune index, and you are offline.';
                if (cachedLoadError) analyticsData['cached_load_error'] = cachedLoadError;
                return this._finishSetup(analyticsData, t0);
            }

            const result = await this._installExclusively({ ids: selected });
            if (cachedLoadError) analyticsData['cached_load_error'] = cachedLoadError;
            analyticsData['newly_installed'] = true;
            analyticsData['days_since_update'] = 0;
            analyticsData['tune_index_metadata_version'] = result.v;
            analyticsData['tune_index_metadata_date'] = result.date || null;
            analyticsData['datasets_loaded'] = Object.keys(result.installed).join(',');
            const failedIds = Object.keys(result.failed);
            if (failedIds.length) analyticsData['datasets_failed'] = failedIds.join(',');
            const persistErrors = Object.keys(result.persistErrors);
            if (persistErrors.length) {
                analyticsData['persist_error'] = result.persistErrors[persistErrors[0]];
            }
            return this._finishSetup(analyticsData, t0);
        } catch (e) {
            console.error('Tune index setup failed', e);
            this._setIndexStatus(INDEX_STATUS.UNAVAILABLE, {
                reason: e instanceof NetworkUnavailableError ? 'network' : 'error',
                message: e && e.message,
                offline: isDefinitelyOffline(),
                datasetsMissing: selected,
            });
            analyticsData.error = e instanceof NetworkUnavailableError
                ? 'Could not reach the tune database.'
                : 'Could not load the tune index.';
            return this._finishSetup(analyticsData, t0);
        }
    }

    _finishSetup(analyticsData, t0) {
        console.timeEnd('tune-index-setup');
        analyticsData['wall_time'] = performance.now() - t0;
        analyticsData['index_status'] = this.indexStatus;
        return analyticsData;
    }

    // After a successful load from the offline copies: check for newer versions
    // and, if any selected dataset has no copy at all, fetch it. Both are
    // background work — the app is already READY.
    async _afterCacheLoad(parts, missing) {
        if (missing.length && this.autoUpdateEnabled && !isDefinitelyOffline()) {
            try {
                await this._installExclusively({ ids: missing });
            } catch (e) {
                console.warn('Could not fetch missing datasets', e);
            }
        }
        await this._checkForUpdatesInBackground(parts);
    }

    _recordLoadedDatasets(parts, source, missing = [], rejected = []) {
        // A part the merge refused is NOT loaded, so it must not be reported
        // as such — that was the whole class of bug where the status claimed
        // more than WASM actually held.
        const refused = new Set(rejected.map(r => r.id));
        this.loadedDatasets = {};
        for (const part of parts.filter(p => !refused.has(p.id))) {
            this.loadedDatasets[part.id] = {
                v: part.manifest ? part.manifest.v : 0,
                date: part.manifest ? part.manifest.date : null,
                source,
            };
        }
        this._migrationPending = false;
        this._loadedIndexInfo = {
            source,
            datasets: { ...this.loadedDatasets },
            ...this._scalarVersion(),
        };
        this._setIndexStatus(INDEX_STATUS.READY, {
            ...this._loadedIndexInfo,
            datasetsLoaded: Object.keys(this.loadedDatasets),
            datasetsMissing: [...missing, ...refused],
            datasetErrors: Object.fromEntries(rejected.map(r => [
                r.id,
                `reuses ${r.settings} setting and ${r.tunes} tune IDs that `
                + 'another database already uses',
            ])),
        });
    }

    // Help/About and store.state.tuneIndexVersion still want a single version
    // number. Define the rule explicitly or the About box flickers as datasets
    // land in different orders: thesession's when it is loaded, otherwise the
    // newest loaded dataset's. The per-dataset map is the real truth.
    _scalarVersion() {
        const ids = Object.keys(this.loadedDatasets);
        if (!ids.length) return { v: 0, date: null };
        const preferred = this.loadedDatasets['thesession'];
        if (preferred) return { v: preferred.v, date: preferred.date };
        let best = null;
        for (const id of ids) {
            const entry = this.loadedDatasets[id];
            if (!best || (entry.v || 0) > (best.v || 0)) best = entry;
        }
        return { v: best.v || 0, date: best.date || null };
    }

    // Download, VALIDATE, load and only then persist each dataset.
    //
    // ORDER IS A RELIABILITY PROPERTY, and this is the second half of the rule
    // writeDataset documents: a known-good offline copy is immutable until a
    // replacement has proved itself. writeDataset overwrites that dataset's
    // previous copy irrecoverably, so everything that can reject the download
    // must happen first:
    //
    //   download → JSON.parse → indexPayloadProblem → load into WASM → write
    //
    // This used to persist first, "to secure the offline copy as early as
    // possible". It secured the wrong thing. Any 200 response that happened to
    // be valid JSON — an error document, a truncated body that still closed its
    // braces, a captive portal's API response, a half-built dataset — replaced
    // a working offline copy before anything checked it was usable. During a
    // background update the old index stays loaded in WASM and the caller
    // restores READY, so the session looked completely healthy; the user found
    // out at the next cold start, offline, which is precisely when they could
    // do nothing about it.
    //
    // Datasets are installed ONE FULL CYCLE AT A TIME rather than all being
    // staged and then merged once. Two reasons: only one raw string is alive at
    // a time (staging three would hold ~45 MB of text simultaneously), and each
    // dataset becomes durable the moment it proves itself, so an OOM during
    // norbeck does not cost the thesession download.
    //
    // A dataset that fails does NOT abort the others — it is recorded in
    // `failed` and the loop continues. Partial success is success.
    async _installDatasets({ ids, bypassCacheVersion = null }) {
        this._setIndexStatus(INDEX_STATUS.DOWNLOADING, { received: 0, total: 0 });

        // datasets.json is ~600 bytes from the same host as the datasets, and
        // is required anyway (it carries the filenames and versions). So it
        // doubles as a fast reachability probe, and its failure is deliberately
        // FATAL: if we cannot read 600 bytes from that host there is no sense
        // starting a 35 MB download, and failing at the 8 s deadline is what
        // lets the app say "unavailable" quickly behind a captive portal
        // instead of grinding on a stalled transfer.
        const manifest = await fetchDatasetsManifest(bypassCacheVersion);

        const installed = {};
        const failed = {};
        const persistErrors = {};
        // A merge can DROP a user-origin part that collides with what is being
        // installed — safety is preserved, but the drop has to be carried into
        // the bookkeeping or the status keeps claiming a dataset that is no
        // longer in WASM and whose tunes have silently stopped being findable.
        const rejected = {};

        const work = [];
        for (const id of ids) {
            const entry = manifest.byId.get(id);
            if (entry) {
                work.push(entry);
                continue;
            }
            // Not in datasets.json. That is normal for a dataset the user
            // added by hand: it has no manifest entry by definition. If its
            // stored manifest remembers a URL we can refresh it from there;
            // otherwise there is nothing to fetch and saying "not published"
            // would be both wrong and unactionable.
            const local = await readDatasetManifest(id);
            if (local && local.origin === 'user') {
                if (local.url) {
                    work.push({
                        id, url: local.url, v: local.v || 0,
                        date: local.date || null, size: local.bytes || 0,
                        origin: 'user', label: local.label || id,
                    });
                } else {
                    failed[id] = 'added from a file — re-import it to update';
                }
                continue;
            }
            failed[id] = 'not published';
            console.warn(`Dataset ${id} is not in datasets.json; skipping`);
        }

        // Largest first. During a migration the first successful load replaces
        // the merged blob in WASM with a partial per-dataset set, so the window
        // in which the app can search fewer tunes than a minute ago should be
        // as short and as small as possible.
        work.sort((a, b) => (b.size || 0) - (a.size || 0));

        const plannedTotal = work.reduce((sum, e) => sum + (e.size || 0), 0);
        let completedBytes = 0;
        // ONE throttle for the whole install, not one per dataset, so three
        // datasets do not triple the Comlink chatter at their boundaries.
        let lastReport = 0;

        for (let i = 0; i < work.length; i++) {
            const entry = work[i];
            let raw = null;
            let loadedThisEntry = false;
            try {
                const download = entry.url
                    ? (onProgress) => fetchUserDatasetText(entry.url, onProgress)
                    : (onProgress) => fetchDatasetText(
                        entry.filename, bypassCacheVersion, onProgress);
                raw = await download(({ received }) => {
                    const now = Date.now();
                    if (now - lastReport < 250) return;
                    lastReport = now;
                    // Clamp to this dataset's published size. `received`
                    // counts DECODED bytes while `size` is the uncompressed
                    // length from datasets.json; they agree in production
                    // (the data repo asserts it) but a stale manifest must
                    // not make the bar overshoot.
                    const inFlight = entry.size
                        ? Math.min(received, entry.size)
                        : received;
                    this._setIndexStatus(INDEX_STATUS.DOWNLOADING, {
                        received: completedBytes + inFlight,
                        total: plannedTotal,
                        dataset: entry.id,
                        datasetIndex: i + 1,
                        datasetCount: work.length,
                    });
                });

                // A parse failure lands here with nothing written: truncated
                // bodies, HTML error pages and captive-portal interception all
                // arrive as valid-looking 200s. try/finally because the timer
                // must be closed on the throwing path too.
                let parsed;
                console.time(`index-parse-from-network:${entry.id}`);
                try {
                    parsed = JSON.parse(raw);
                } finally {
                    console.timeEnd(`index-parse-from-network:${entry.id}`);
                }

                // Valid JSON is not the same as "is a tune index".
                const problem = indexPayloadProblem(parsed);
                if (problem) {
                    throw new Error(`not usable (${problem})`);
                }

                // An imported dataset describes ITSELF — there is no
                // datasets.json entry to describe it — so its version comes
                // from the file just fetched, not from the stale local
                // manifest we used to find the URL.
                if (entry.origin === 'user') {
                    // The URL is remembered across releases and is not under
                    // our control. If it starts serving a different dataset,
                    // storing that under the original id would silently swap
                    // one collection for another beneath the user's
                    // favourites.
                    // Exact equality, not "different if it says anything".
                    // An imported dataset is REQUIRED to be self-describing, so
                    // a payload with no id is not a lenient case — it is a file
                    // that cannot prove it is still the same collection.
                    const servedId = typeof parsed.id === 'string'
                        ? parsed.id.trim() : '';
                    if (servedId !== entry.id) {
                        throw new Error(
                            `that link now serves ${servedId
                                ? `"${servedId}"` : 'a file with no id'}, not `
                            + `"${entry.id}"`);
                    }
                    entry.v = Number(parsed.v) || entry.v || 0;
                    entry.date = parsed.date || entry.date || null;
                    if (typeof parsed.label === 'string' && parsed.label) {
                        entry.label = parsed.label;
                    }
                }

                const part = {
                    id: entry.id,
                    index: splitIndexPayload(parsed),
                    origin: entry.origin || 'cdn',
                };

                // Merge with everything else that should be loaded. The other
                // datasets are re-read from IndexedDB rather than retained in
                // memory: retaining the merged object graph would cost 50-70 MB
                // permanently, and steady-state pressure is what gets a worker
                // killed while backgrounded on iOS.
                const others = await this._partsToKeep(
                    entry.id, [...Object.keys(installed)]);

                // Mid-migration, the datasets that have not moved to their own
                // file yet exist ONLY in the merged blob, so `others` cannot
                // include them. Loading without a base would replace WASM with
                // just this dataset and silently drop the rest from search for
                // the whole session — while still reporting them loaded.
                const base = await this._migrationBase(
                    [entry.id, ...others.map(p => p.id)]);

                // The final proof, and the only one that covers a payload the
                // Rust side rejects: if this throws, the previous index is still
                // the one loaded in WASM (use_tune_index runs only after serde
                // has deserialised the whole thing) and every offline copy is
                // still on disk.
                // An imported dataset is untrusted on every fetch, not only
                // the first: the URL is remembered and its contents can change.
                // Vetted BEFORE anything is merged or loaded, and against every
                // other part INCLUDING the legacy migration base — see
                // collisionsForPart.
                if (entry.origin === 'user') {
                    this._assertNoCollisions(
                        collisionsForPart(part, [...base, ...others]), entry.id);
                }
                const merged = await this.loadMergedIndex(
                    [...base, ...others, part]);
                loadedThisEntry = true;
                for (const bad of merged.rejected || []) {
                    rejected[bad.id] =
                        `reuses ${bad.settings} setting and ${bad.tunes} tune `
                        + 'IDs that another database already uses';
                }
                if (merged.empty.includes(entry.id)) {
                    throw new Error(
                        'duplicate of an already-loaded dataset — check the '
                        + 'filenames in datasets.json');
                }

                // --- Only now may this dataset's previous copy be replaced ---
                try {
                    // Carry the provenance through a refresh. Dropping it would
                    // turn an imported dataset back into an unknown one: the
                    // next update check would call it "not published" and its
                    // name would revert to its raw id.
                    await writeDataset(entry.id, raw, {
                        v: entry.v || 0,
                        date: entry.date || null,
                        origin: entry.origin || undefined,
                        label: entry.label,
                        url: entry.url,
                    });
                } catch (e) {
                    // It works for this session; it just will not survive a
                    // restart. Surfaced in Settings rather than swallowed,
                    // because "silently no offline copy" is the failure the
                    // user actually hits.
                    console.error(`Could not persist ${entry.id} offline`, e);
                    persistErrors[entry.id] = (e && e.message) || String(e);
                }

                installed[entry.id] = { v: entry.v || 0, date: entry.date || null };
                completedBytes += entry.size || 0;
            } catch (e) {
                console.warn(`Dataset ${entry.id} failed to install`, e);
                failed[entry.id] = (e && e.message) || String(e);
                if (loadedThisEntry) {
                    // A rejected payload is already in WASM. Put back what the
                    // selection actually says, from disk, or the session keeps
                    // searching data we just refused to save.
                    await this._reloadSelected();
                }
            } finally {
                raw = null; // release the raw string before the next dataset
            }
        }

        if (Object.keys(installed).length === 0) {
            const reasons = Object.entries(failed)
                .map(([id, why]) => `${id}: ${why}`).join('; ');
            throw new Error(reasons || 'No datasets could be installed');
        }

        await this._afterInstall(installed, failed, persistErrors, rejected);
        return {
            ...this._scalarVersion(),
            installed,
            failed: { ...failed, ...rejected },
            persistErrors,
        };
    }

    // Which already-stored datasets should be merged alongside the one being
    // installed.
    //
    // ONLY datasets that are known to load: the ones currently in WASM, plus
    // the ones this install has already written and loaded. NOT simply
    // everything on disk — a cached copy the Rust side refuses (a real schema
    // change, say) would then be merged into every subsequent install and
    // poison it, so the incompatible copy could never be replaced and the app
    // would stay unavailable forever. Keeping such a copy is right; feeding it
    // back into WASM is not.
    //
    // They are re-read from IndexedDB rather than retained in memory: holding
    // the merged object graph would cost 50-70 MB permanently, and steady-state
    // pressure is what gets a worker killed while backgrounded on iOS.
    async _partsToKeep(excludeId, justInstalled) {
        const loadable = new Set([
            ...Object.keys(this.loadedDatasets),
            ...justInstalled,
        ]);
        const wanted = [...new Set(this.selectedDatasets)]
            .filter(id => id !== excludeId && loadable.has(id));
        if (wanted.length === 0) return [];
        const { parts } = await readDatasets(wanted);
        return parts;
    }

    // Of a set of parts, the ones the user actually has selected. The vetting
    // read is deliberately wider than the merge.
    _selectedOf(parts) {
        return parts.filter(p => this.selectedDatasets.includes(p.id));
    }

    // Every dataset with a usable copy on disk, whatever the selection says.
    // Used to vet an import: a deselected dataset still has favourites pointing
    // into it, so its IDs are still spoken for.
    async _allStoredParts(excludeId) {
        const ids = (await listStoredDatasetIds()).filter(id => id !== excludeId);
        if (!ids.length) return [];
        const { parts } = await readDatasets(ids);
        return parts;
    }

    // The merged blob, as a gap-filling base, when some selected dataset is not
    // yet covered by a per-dataset file. Returns [] once migration is complete,
    // which is the steady state — this costs nothing outside a migration.
    async _migrationBase(coveredIds) {
        if (!this._migrationPending) return [];
        const covered = new Set(coveredIds.filter(Boolean));
        if (this.selectedDatasets.every(id => covered.has(id))) return [];
        const merged = await readMergedLegacyIndex();
        if (!merged) return [];
        return [{ id: null, index: merged.index }];
    }

    async _afterInstall(installed, failed, persistErrors, rejected = {}) {
        const loaded = { ...this.loadedDatasets };
        for (const [id, info] of Object.entries(installed)) {
            loaded[id] = { ...info, source: 'network' };
        }
        // A part a merge dropped is no longer in WASM, whatever it was before.
        for (const id of Object.keys(rejected)) {
            delete loaded[id];
        }
        // Report only what is genuinely searchable. A dataset inherited from
        // the merged blob stays loaded ONLY while that blob is still the base
        // of what is in WASM; once migration completes it must have its own
        // file or it is missing. Claiming otherwise is how a half-finished
        // migration used to look perfectly healthy while half the tunes had
        // quietly stopped being findable.
        this.loadedDatasets = {};
        for (const id of Object.keys(loaded)) {
            if (!this.selectedDatasets.includes(id)) continue;
            if (loaded[id].source === 'merged') {
                const stillBacked = this._migrationPending
                    && !!(await readMergedLegacyIndex());
                if (!stillBacked) continue;
            }
            this.loadedDatasets[id] = loaded[id];
        }

        const datasetsLoaded = Object.keys(this.loadedDatasets);
        // `datasetsMissing` is derived from what is actually loaded, so a
        // rejected dataset lands here automatically — but its REASON only
        // exists in `rejected`, and without it the UI would show a dataset
        // missing with nothing to say about why.
        const datasetsMissing = this.selectedDatasets.filter(
            id => !this.loadedDatasets[id]);

        this._loadedIndexInfo = {
            source: 'network',
            datasets: { ...this.loadedDatasets },
            ...this._scalarVersion(),
        };

        // The merged blob is only redundant once every dataset it covers has a
        // committed per-dataset copy AND that set is loaded. Re-read from disk
        // rather than trusting what this install thinks it wrote.
        if (this._migrationPending || datasetsLoaded.length) {
            try {
                const covered = [];
                for (const id of ['thesession', 'folkwiki']) {
                    if (await readDataset(id)) covered.push(id);
                }
                if (await clearSupersededMergedCopies(covered)) {
                    this._migrationPending = false;
                }
            } catch (e) {
                // Wasted quota, never data loss.
                console.warn('Could not reclaim the merged tune index copy', e);
            }
        }

        const firstPersistError = Object.values(persistErrors)[0] || null;
        this._setIndexStatus(INDEX_STATUS.READY, {
            ...this._loadedIndexInfo,
            datasetsLoaded,
            datasetsMissing,
            datasetErrors: { ...failed, ...rejected },
            persistError: firstPersistError,
            migrationPending: this._migrationPending,
        });
    }

    // Run an install with at most one in flight across the whole worker.
    //
    // Two installs could previously overlap: setup fires the background update
    // check without awaiting it (deliberately — readiness must never wait on
    // the network), then clears _setupInFlight, so tapping "Update offline
    // copy" in Settings while that background update was still downloading
    // started a second one. Both would validate before writing, so neither
    // could store junk — but their writes interleave, and each dataset's
    // payload and manifest are separate transactions, so the end state could be
    // a manifest from one install describing the payload of the other.
    //
    // A second caller JOINS the running install only when that install ALREADY
    // COVERS everything it wants. Joining unconditionally is wrong once
    // requests can be disjoint: an install of ['thesession'] would hand a
    // caller asking for ['norbeck'] a result with no norbeck in it. Anything
    // not covered is serialised behind the running install instead.
    async _installExclusively({ ids, bypassCacheVersion = null }) {
        const running = this._indexUpdateInFlight;
        if (running && ids.every(id => running.ids.includes(id))) {
            console.debug('Tune index install already covers these datasets; joining it');
            return await running.promise;
        }
        return await this._withInstallLock(async () => {
            const promise = this._installDatasets({ ids, bypassCacheVersion });
            this._indexUpdateInFlight = { ids: [...ids], promise };
            try {
                return await promise;
            } finally {
                this._indexUpdateInFlight = null;
            }
        });
    }

    _withInstallLock(fn) {
        const previous = this._installChain;
        let release;
        this._installChain = new Promise(resolve => { release = resolve; });
        return previous.then(fn).finally(release);
    }

    async _checkForUpdatesInBackground(parts) {
        if (isDefinitelyOffline()) return;
        if (!this.autoUpdateEnabled) {
            console.debug('Automatic tune index updates are disabled');
            return;
        }

        let manifest;
        try {
            manifest = await fetchDatasetsManifest();
        } catch (e) {
            // Entirely expected when offline or behind a captive portal.
            console.debug('Tune index update check skipped:', e.message);
            return;
        }

        // Only the datasets that actually moved. This is the point of the
        // split: a folkwiki bump must not re-download 35 MB of thesession.
        const stale = [];
        for (const part of parts) {
            const entry = manifest.byId.get(part.id);
            const localV = part.manifest ? part.manifest.v : 0;
            if (entry && (entry.v || 0) > localV) {
                console.debug(`Upgrading ${part.id} v${localV} -> v${entry.v}`);
                stale.push(part.id);
            }
        }
        if (!stale.length) {
            console.debug('All tune datasets are up to date');
            return;
        }

        const snapshot = this._snapshotIndexState();
        try {
            await this._installExclusively({ ids: stale });
        } catch (e) {
            // Non-fatal: the cached datasets are loaded and usable, and the
            // failed update changed nothing on disk. Restore READY so a failed
            // background update can't leave the app looking broken.
            console.warn('Tune index update failed; keeping cached version', e);
            this._restoreAfterFailedInstall(snapshot, e);
        }
    }

    // Migrate an upgrading install from the merged blob to per-dataset copies.
    //
    // The merged blob is already loaded and the app is READY, so this is pure
    // background work and a failure changes nothing: the blob stays on disk and
    // the next launch tries again.
    //
    // Gated on autoUpdateEnabled. A user who turned that off has explicitly
    // asked not to be given downloads they did not request, and this is ~42 MB
    // for zero new content. They keep the merged blob and migrate on their next
    // explicit tap in Settings.
    async _migrateFromMerged(selected) {
        if (!this.autoUpdateEnabled) {
            console.debug('Migration to per-dataset storage deferred: '
                + 'automatic updates are off');
            return;
        }
        if (isDefinitelyOffline()) return;

        const snapshot = this._snapshotIndexState();
        try {
            await this._installExclusively({ ids: selected });
        } catch (e) {
            console.warn('Migration to per-dataset storage failed; '
                + 'keeping the merged copy', e);
            this._restoreAfterFailedInstall(snapshot, e);
        }
    }

    // Download + persist regardless of the local version. Used by the Settings
    // "Save offline copy" action, and by the 'online' handler when the index is
    // currently unavailable.
    //
    // `datasetIds` of null means the current selection.
    async refreshTuneIndex(datasetIds, cb) {
        if (this._setupInFlight) {
            await this._setupInFlight;
            cb({ ok: this.indexStatus === INDEX_STATUS.READY });
            return;
        }
        const ids = (datasetIds && datasetIds.length)
            ? datasetIds
            : [...this.selectedDatasets];

        this._setupInFlight = (async () => {
            if (!ids.length) {
                return { ok: false, error: 'No tune databases are selected.' };
            }
            if (isDefinitelyOffline()) {
                return { ok: false, error: 'You are offline.' };
            }
            // Captured before the download starts, because _installDatasets
            // sets DOWNLOADING immediately — reading the status in the catch
            // block below always saw DOWNLOADING, never READY, so every failed
            // manual refresh reported UNAVAILABLE even with a perfectly good
            // index still loaded. That produced status='unavailable' alongside
            // usable=true, and which of the two a given view believed decided
            // whether it showed tunes or an error.
            const snapshot = this._snapshotIndexState();
            try {
                // Unique query string forces a fresh copy past any HTTP cache.
                const result = await this._installExclusively(
                    { ids, bypassCacheVersion: Date.now() });
                const failedIds = Object.keys(result.failed);
                return {
                    ok: true,
                    v: result.v,
                    date: result.date,
                    installed: result.installed,
                    failed: result.failed,
                    persistError: Object.values(result.persistErrors)[0] || null,
                    partial: failedIds.length > 0,
                };
            } catch (e) {
                this._restoreAfterFailedInstall(snapshot, e);
                return { ok: false, error: (e && e.message) || String(e) };
            }
        })();
        try {
            cb(await this._setupInFlight);
        } finally {
            this._setupInFlight = null;
        }
    }

    // Change which datasets are searched.
    //
    // Rules, in order of how much they matter:
    //
    //  1. A TOGGLE MUST NEVER DELETE A PAYLOAD. This is reliability rule 1
    //     generalised, and it is worse than deleting on failure: the user may
    //     flip it back thirty seconds later and now needs 35 MB of signal they
    //     may not have. Deselected copies are kept and shown in Settings, and
    //     removeDataset — behind an explicit confirm — is the only path that
    //     deletes one.
    //  2. Turning a dataset back ON must not need the network when its copy is
    //     already on disk.
    //  3. The loaded index is never cleared before its replacement has loaded.
    //  4. A failed toggle-on must not revert the setting. It is the user's
    //     intent and it retries next launch or on the next 'online' event.
    async setSelectedDatasets(ids, cb) {
        const next = Array.isArray(ids) ? [...new Set(ids)] : [];
        const previous = [...this.selectedDatasets];
        this.selectedDatasets = next;

        const unchanged = previous.length === next.length
            && previous.every(id => next.includes(id));
        if (unchanged) {
            if (cb) cb({ ok: true, unchanged: true });
            return;
        }

        // Turning off the LAST dataset: do not load an empty index.
        // indexPayloadProblem would reject one anyway, and Rust would happily
        // load something that returns nothing with no explanation. Unload
        // instead — WASM still physically holds the old index, which is
        // harmless because _indexIsUsable gates every query.
        if (next.length === 0) {
            this.indexUsable = false;
            this.abcStringBySetting = {};
            this.sourceUrlBySetting = {};
            this.datasetByTune = {};
            this.loadedDatasets = {};
            this._loadedIndexInfo = null;
            this._setIndexStatus(INDEX_STATUS.UNAVAILABLE,
                { reason: 'no-datasets-selected' });
            if (cb) cb({ ok: true, datasetsLoaded: [] });
            return;
        }

        // Taken BEFORE anything can set DOWNLOADING, for the same reason
        // refreshTuneIndex takes one: a failure here used to leave the status
        // stuck on 'downloading' forever, with no terminal state and no way for
        // the UI to tell busy from broken.
        const snapshot = this._snapshotIndexState();
        try {
            const { parts, missing } = await readDatasets(next);
            if (parts.length) {
                const merged = await this.loadMergedIndex(parts);
                this._recordLoadedDatasets(
                    parts, 'cache', missing, merged.rejected);
            }

            // Only download what we genuinely do not have.
            if (missing.length && !isDefinitelyOffline()) {
                await this._installExclusively({ ids: missing });
            } else if (missing.length) {
                this._setIndexStatus(INDEX_STATUS.READY, {
                    ...this._loadedIndexInfo,
                    datasetsLoaded: parts.map(p => p.id),
                    datasetsMissing: missing,
                    offline: true,
                });
            }
            if (cb) cb({ ok: true, datasetsLoaded: Object.keys(this.loadedDatasets) });
        } catch (e) {
            console.warn('Could not apply the new dataset selection', e);
            // The SETTING stands — it is the user's intent and it retries next
            // launch or when the connection returns — but the STATUS must be
            // put back to a terminal one, or the UI shows a database that is
            // downloading forever.
            this._restoreAfterFailedInstall(snapshot, e);
            if (cb) cb({ ok: false, error: (e && e.message) || String(e) });
        }
    }

    // Install a dataset the USER supplied, from a file they picked or a URL
    // they typed, rather than from the published manifest.
    //
    // This exists so FolkFriend does not have to host every dataset it can
    // search. Norbeck's collection may not be made available for download on a
    // web page, so it is built but never served: you import the file yourself.
    // The same path lets anyone add a collection of their own.
    //
    // Same order as every other install — parse → structural check → load into
    // WASM → write — because it replaces a copy just as irrecoverably.
    // `text` and `url` are alternatives; a url is fetched here rather than in
    // the page so the 3 MB body never crosses the Comlink boundary.
    async addUserDataset({ text = null, url = null }, cb) {
        // Serialised with every other install. Without the lock an import can
        // interleave with a startup update or a manual refresh: each merges
        // from its own view of what is loaded, so WASM ends up holding one
        // operation's merge while loadedDatasets claims both.
        const result = await this._withInstallLock(
            () => this._addUserDatasetLocked({ text, url }));
        if (cb) cb(result);
        return result;
    }

    async _addUserDatasetLocked({ text = null, url = null }) {
        const done = (result) => result;
        const snapshot = this._snapshotIndexState();

        let raw = text;
        try {
            if (raw === null) {
                if (!url) throw new Error('No file or URL given');
                this._setIndexStatus(INDEX_STATUS.DOWNLOADING,
                    { received: 0, total: 0 });
                raw = await fetchUserDatasetText(url);
            }

            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                throw new Error('That file is not JSON.');
            }

            const problem = indexPayloadProblem(parsed);
            if (problem) {
                throw new Error(`That file is not a tune database (${problem}).`);
            }

            // Published datasets are described by their datasets.json entry.
            // An imported file has none, so it has to describe itself — see
            // the stamping in the data repo's assemble_datasets.py.
            const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
            if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
                throw new Error(
                    'That file does not say which database it is (no usable '
                    + '"id" field), so it cannot be added.');
            }
            const label = (typeof parsed.label === 'string' && parsed.label)
                ? parsed.label
                : id;

            // An import must not be able to impersonate a published dataset.
            // Storing under `thesession` would put a file nobody vetted behind
            // a name the app manages, and the next CDN update would silently
            // overwrite it — or not, depending on ordering.
            if (await this._isPublishedDataset(id)) {
                throw new Error(
                    `"${id}" is one of FolkFriend's own databases and cannot be `
                    + 'replaced by an imported file.');
            }

            const part = { id, index: splitIndexPayload(parsed), origin: 'user' };
            // Vetted against EVERY stored dataset, not merely the selected
            // ones. Otherwise: deselect thesession, import something reusing
            // its IDs (accepted, since thesession is not in the merge),
            // re-enable thesession — and the conflict only surfaces later, as
            // a dataset that silently refuses to load. Better to say so now.
            const others = await this._allStoredParts(id);
            const base = await this._migrationBase(
                [id, ...others.map(p => p.id)]);
            this._assertNoCollisions(
                collisionsForPart(part, [...base, ...others]), id);
            const merged = await this.loadMergedIndex(
                [...base, ...this._selectedOf(others), part]);

            // IDs are global. A dataset reusing another's setting or tune ids
            // does not fail loudly — one record shadows the other, and because
            // favourites are keyed by setting id alone, a favourite can then
            // open the wrong tune or look already-favourited. For a file from
            // the CDN a collision is a data-repo bug we report and carry on
            // with; for an arbitrary import it is a reason to refuse.

            let persistError = null;
            try {
                await writeDataset(id, raw, {
                    v: Number(parsed.v) || 0,
                    date: parsed.date || null,
                    origin: 'user',
                    label,
                    url: url || null,
                });
            } catch (e) {
                persistError = (e && e.message) || String(e);
            }
            raw = null;

            if (!this.selectedDatasets.includes(id)) {
                this.selectedDatasets = [...this.selectedDatasets, id];
            }
            await this._afterInstall(
                { [id]: { v: Number(parsed.v) || 0, date: parsed.date || null } },
                {},
                persistError ? { [id]: persistError } : {});

            return done({ ok: true, id, label, persistError });
        } catch (e) {
            // Nothing durable changed: the write is the last step and anything
            // that threw got there first. Put the status back so the UI does
            // not sit on 'downloading' forever.
            this._restoreAfterFailedInstall(snapshot, e);
            return done({ ok: false, error: (e && e.message) || String(e) });
        }
    }

    // Refuse a merge in which an imported dataset has trodden on another's IDs.
    //
    // Applied on EVERY import and EVERY refresh, not just the first install: a
    // remembered URL is not under our control, so a payload that was clean when
    // it was added can start colliding later. IDs are global and a collision
    // does not fail loudly — one setting shadows another, one tune's aliases
    // overwrite another's name — and because favourites are keyed by setting id
    // alone, the visible symptom is a favourite opening the wrong tune.
    _assertNoCollisions(counts, id) {
        const parts = [];
        if (counts.settings) parts.push(`${counts.settings} setting IDs`);
        if (counts.tunes) parts.push(`${counts.tunes} tune IDs`);
        if (!parts.length) return;
        throw new Error(
            `That database reuses ${parts.join(' and ')} that another database `
            + 'already uses, so it cannot be added without hiding existing '
            + 'tunes.');
    }

    // Is this id one the published manifest manages? Answered from the network
    // when we can, and from what is loaded when we cannot — offline, an import
    // must still not be able to claim a name the app already uses.
    async _isPublishedDataset(id) {
        if (PUBLISHED_DATASETS.includes(id)) return true;
        const local = await readDatasetManifest(id);
        if (local && local.origin === 'user') return false;
        if (local) return true;
        if (isDefinitelyOffline()) return false;
        try {
            const manifest = await fetchDatasetsManifest();
            return manifest.byId.has(id);
        } catch (e) {
            return false;
        }
    }

    // Re-load exactly what the selection says, from disk. Used to undo a merge
    // that was performed to validate something we then decided to reject.
    async _reloadSelected() {
        try {
            const { parts, missing } = await readDatasets(this.selectedDatasets);
            if (parts.length) {
                const merged = await this.loadMergedIndex(parts);
                this._recordLoadedDatasets(
                    parts, 'cache', missing, merged.rejected);
            }
        } catch (e) {
            console.warn('Could not restore the previous index', e);
        }
    }

    // Delete one dataset's offline copy. The ONLY path in the app that removes
    // a validated copy, and it is reachable only from an explicit confirmed tap.
    async removeDataset(id, cb) {
        try {
            await clearDataset(id);
            // If it was still selected, drop it from the loaded set too.
            if (this.loadedDatasets[id]) {
                const remaining = this.selectedDatasets.filter(x => x !== id);
                await this.setSelectedDatasets(remaining, null);
            }
            if (cb) cb({ ok: true });
        } catch (e) {
            if (cb) cb({ ok: false, error: (e && e.message) || String(e) });
        }
    }

    // Diagnostics for the Settings page: what is actually on disk, and how
    // much room there is. Read straight from IndexedDB so it reflects reality
    // rather than in-memory state.
    async getOfflineStatus(cb) {
        let inventory = { datasets: {}, merged: null, legacy: null, storage: null };
        try {
            inventory = await readOfflineInventory(this.selectedDatasets);
        } catch (e) {
            console.warn('Could not read the offline inventory', e);
        }
        cb({
            ...inventory,
            selected: [...this.selectedDatasets],
            loaded: { ...this.loadedDatasets },
            status: this.indexStatus,
            detail: this.indexDetail,
        });
    }

    // Also read the manifests of datasets the user has DESELECTED, so Settings
    // can offer to remove a copy that is on disk but not in use.
    async getDatasetInventory(ids, cb) {
        try {
            cb(await readOfflineInventory(ids));
        } catch (e) {
            cb({ datasets: {}, merged: null, legacy: null, storage: null });
        }
    }

    // Merge N dataset parts and hand the result to WASM as ONE index.
    //
    // use_tune_index on the Rust side replaces wholesale and has no add/remove,
    // so "load dataset D" always means "load the merge of everything selected".
    // Merging JS-side keeps that to a single wasm-bindgen call and needs no new
    // Rust surface.
    //
    // `mergedDatasets` labels a part whose id is null — the pre-multi-dataset
    // merged blob, which contains thesession and folkwiki but cannot say which
    // tune came from which. Those tunes fall back to the ID-range rule in
    // source.mjs, which is exactly what that fallback exists for.
    // Merge and load. Anything that could REFUSE a part is checked by the
    // caller before getting here (collisionsForPart), so a rejected payload is
    // never merged or loaded at all — rather than being loaded and then undone,
    // which left a window where the app was searching data it had just refused
    // to save, and depended on the undo itself not failing.
    async loadMergedIndex(parts, mergedDatasets = null) {
        await this.loadedWASM;

        // Enforced on EVERY merge, whatever triggered it — see vetUserParts.
        const vetted = vetUserParts(parts);
        for (const bad of vetted.rejected) {
            console.warn(`Not loading imported dataset ${bad.id}: it reuses `
                + `${bad.settings} setting and ${bad.tunes} tune IDs that `
                + 'another database already uses');
        }
        if (vetted.parts.length === 0) {
            throw new Error('No usable datasets to load');
        }

        const merged = mergeIndexParts(vetted.parts);
        merged.rejected = vetted.rejected;

        console.time('tune-index-to-wasm');
        if (merged.collisions || merged.tuneCollisions) {
            // For DATASETS WE PUBLISH a collision is a data-repo bug: report it
            // and carry on, because denying the user their whole index over it
            // is not proportionate. An imported dataset is held to a stricter
            // rule — see assertNoCollisions.
            console.warn(`${merged.collisions} setting and `
                + `${merged.tuneCollisions} tune ID collisions while merging `
                + 'datasets; the data repo should have caught this');
        }
        try {
            await this.folkfriendWASM.load_index_from_json_obj(merged.indexData);
            // Assigned AFTER the load, deliberately: a throw above leaves the
            // sidebands still matching the index actually in WASM.
            this.abcStringBySetting = merged.abcStrings || {};
            this.sourceUrlBySetting = merged.sourceUrls || {};
            this.datasetByTune = merged.datasetByTune || {};
            if (mergedDatasets) {
                // Nothing to label per tune; source.mjs falls back to the range.
                this.datasetByTune = {};
            }
            // From here queries work, regardless of what the pipeline does next.
            this.indexUsable = true;
        } finally {
            console.timeEnd('tune-index-to-wasm');
        }
        return merged;
    }

    async setSampleRate(sampleRate) {
        await this.loadedWASM;

        // This can fail by returning false. We never actually check the return
        //  value because it can only fail if passed an invalid sample rate,
        //  and it's trivial to check the sample rate before passing that value
        //  into this worker. It should be impossible for an invalid sample 
        //  rate to make it to the worker, but even if it does the WASM backend
        //  simply ignores the invalid sample rate and stays on the default.
        await this.folkfriendWASM.set_sample_rate(sampleRate);
        this.setLoadedSampleRate();
    }

    async setAutoUpdate(enabled) {
        this.autoUpdateEnabled = !!enabled;
    }

    async setUseMlTranscriber(useMl) {
        // Opt-in basic-pitch ML transcriber (default off = DSP path). The WASM
        // side lazily builds the model on first enable and falls back to DSP if
        // it can't. Safe to call repeatedly.
        await this.loadedWASM;
        this.folkfriendWASM.set_use_ml(!!useMl);
    }

    async feedEntirePCMSignal(PCMSignal) {
        const windowSize = ffConfig.SPEC_WINDOW_SIZE;
        const frames = Math.floor(PCMSignal.length / windowSize);
        if (frames === 0) {
            throw 'PCM signal too short';
        }
        await this.loadedWASM;
        await this.loadedSampleRate;

        // Allocate the reusable WASM-side PCM buffer once (idempotent across
        // calls). The Rust-side allocator forgets the buffer so it persists
        // for the lifetime of the worker.
        if (this._pcmWindowPtr === null) {
            this._pcmWindowPtr = this.folkfriendWASM.alloc_single_pcm_window();
        }
        const ptr = this._pcmWindowPtr;
        const wasm = this.folkfriendWASM;

        // The view is re-fetched inside the loop because WASM linear memory
        // may grow underneath us; resizing detaches existing views. Cheap to
        // re-create — it's just a typed-array header over the same memory.
        for (let i = 0; i < frames; i++) {
            const start = windowSize * i;
            const view = wasm.get_allocated_pcm_window(ptr);
            view.set(PCMSignal.subarray(start, start + windowSize));
            wasm.feed_single_pcm_window(ptr);
        }
    }

    async feedSinglePCMWindow(PCMWindow) {
        // Kept for the live-recording mic processor which feeds frames as they
        // arrive. Uses the same reusable WASM buffer.
        await this.loadedWASM;
        await this.loadedSampleRate;
        if (this._pcmWindowPtr === null) {
            this._pcmWindowPtr = this.folkfriendWASM.alloc_single_pcm_window();
        }
        const ptr = this._pcmWindowPtr;
        const view = this.folkfriendWASM.get_allocated_pcm_window(ptr);
        view.set(PCMWindow);
        this.folkfriendWASM.feed_single_pcm_window(ptr);
    }

    async flushPCMBuffer() {
        await this.folkfriendWASM.flush_pcm_buffer();
    }

    async transcribePCMBuffer(cb) {
        try {
            const contour = await this.folkfriendWASM.transcribe_pcm_buffer();
            cb(contour);
        } catch (e) {
            console.error(e);
            console.warn('Aborting transcribePCMBuffer');
            cb(JSON.stringify({
                'error': 'An error ocurred whilst transcribing audio.'
            }));
        }
    }

    // ABC strings and source URLs are kept worker-side (not passed to WASM, see
    // splitIndexPayload) so they must be re-attached to each query result here.
    _reattachSidebandData(results) {
        for (const result of results) {
            if (result.setting && result.setting_id !== undefined) {
                const settingID = String(result.setting_id);
                result.setting.abc = this.abcStringBySetting[settingID] || '';
                result.setting.source_url = this.sourceUrlBySetting[settingID] || '';
                // Which dataset this tune came from. Keyed by TUNE id, not
                // setting id, because every consumer (the source chip, the
                // AI-summary guards) works off the tune id.
                result.setting.dataset =
                    this.datasetByTune[String(result.setting.tune_id)] || '';
            }
        }
        return results;
    }

    async runTranscriptionQuery(query, cb) {
        await this.loadedWASM;
        if (!(await this._indexIsUsable())) { cb([]); return; }
        const response = await this.folkfriendWASM.run_transcription_query(query);
        cb(this._reattachSidebandData(JSON.parse(response)));
    }

    async runNameQuery(query, cb) {
        await this.loadedWASM;
        if (!(await this._indexIsUsable())) { cb([]); return; }
        const response = await this.folkfriendWASM.run_name_query(query);
        cb(this._reattachSidebandData(JSON.parse(response)));
    }

    async contourToAbc(contour, cb) {
        await this.loadedWASM;
        const abc = await this.folkfriendWASM.contour_to_abc(contour);
        cb(abc);
    }

    async settingsFromTuneID(tuneID, cb) {
        await this.loadedWASM;
        // Fail fast rather than hang: when there is no index the caller can
        // immediately fall back to the user's own saved copies.
        if (!(await this._indexIsUsable())) { cb([]); return; }

        const response = await this.folkfriendWASM.settings_from_tune_id(tuneID);
        let settings = JSON.parse(response);

        // Recall that we delete the ABC string before passing data into WebAssembly,
        //  because otherwise it takes a lot of time every startup to load that data in
        //  and it's only used by the frontend and not the backend. So here we reinject
        //  the ABC strings that are stored in the worker.
        let settingsIncludingAbc = settings.map(([settingID, setting]) => {
            setting['setting_id'] = settingID;
            setting['abc'] = this.abcStringBySetting[settingID];
            setting['source_url'] = this.sourceUrlBySetting[settingID] || '';
            setting['dataset'] = this.datasetByTune[String(tuneID)] || '';
            return setting;
        });

        cb(settingsIncludingAbc);
    }

    async aliasesFromTuneID(tuneID, cb) {
        await this.loadedWASM;
        if (!(await this._indexIsUsable())) { cb([]); return; }
        const aliases = await this.folkfriendWASM.aliases_from_tune_id(tuneID);
        cb(JSON.parse(aliases));
    }
}

const folkfriendWASMWrapper = new FolkFriendWASMWrapper();
Comlink.expose(folkfriendWASMWrapper);
