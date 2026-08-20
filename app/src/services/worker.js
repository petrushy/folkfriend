import * as Comlink from '@/js/comlink';
import ffConfig from '@/ffConfig';
import {
    readDataset,
    readDatasets,
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

// What a fresh install searches. Must equal the app's pre-multi-dataset
// behaviour, so that an existing user upgrading — or an old backup restored
// through updateUserSettings' backfill — neither loses thesession nor silently
// gains norbeck.
export const DEFAULT_DATASETS = ['thesession', 'folkwiki'];

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
export function mergeIndexParts(parts) {
    if (parts.length === 1) {
        // Overwhelmingly the common case; skip copying 62k keys.
        const part = parts[0];
        const datasetByTune = {};
        for (const tuneID of part.index.tuneIDs || []) {
            datasetByTune[tuneID] = part.id;
        }
        return { ...part.index, datasetByTune, collisions: 0, empty: [] };
    }

    const settings = {};
    const aliases = {};
    const abcStrings = {};
    const sourceUrls = {};
    const datasetByTune = {};
    let collisions = 0;
    const empty = [];

    for (const part of parts) {
        const partSettings = (part.index.indexData && part.index.indexData.settings) || {};
        let added = 0;
        for (const settingID in partSettings) {
            if (settings[settingID] !== undefined) collisions++;
            else added++;
            settings[settingID] = partSettings[settingID];
        }
        // A part contributing NO new setting IDs is a duplicate of something
        // already merged — which happens if datasets.json points two entries at
        // the same file. Both documents pass indexPayloadProblem perfectly, and
        // without this the failure presents as "folkwiki is missing" with no
        // error reported anywhere.
        if (added === 0) empty.push(part.id);
        Object.assign(aliases, (part.index.indexData && part.index.indexData.aliases) || {});
        Object.assign(abcStrings, part.index.abcStrings || {});
        Object.assign(sourceUrls, part.index.sourceUrls || {});
        for (const tuneID of part.index.tuneIDs || []) {
            datasetByTune[tuneID] = part.id;
        }
    }

    return {
        indexData: { settings, aliases },
        abcStrings,
        sourceUrls,
        datasetByTune,
        collisions,
        empty,
    };
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
                    await this.loadMergedIndex(parts);
                    this._recordLoadedDatasets(parts, 'cache', missing);
                    analyticsData['tune_index_metadata_version'] = this._loadedIndexInfo.v;
                    analyticsData['tune_index_metadata_date'] = this._loadedIndexInfo.date || null;
                    analyticsData['days_since_update'] = 0;
                    analyticsData['datasets_loaded'] = parts.map(p => p.id).join(',');
                    if (missing.length) {
                        analyticsData['datasets_missing'] = missing.join(',');
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

    _recordLoadedDatasets(parts, source, missing = []) {
        this.loadedDatasets = {};
        for (const part of parts) {
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
            datasetsLoaded: parts.map(p => p.id),
            datasetsMissing: [...missing],
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

        const work = [];
        for (const id of ids) {
            const entry = manifest.byId.get(id);
            if (!entry) {
                failed[id] = 'not published';
                console.warn(`Dataset ${id} is not in datasets.json; skipping`);
                continue;
            }
            work.push(entry);
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
            try {
                raw = await fetchDatasetText(
                    entry.filename, bypassCacheVersion, ({ received }) => {
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

                const part = { id: entry.id, index: splitIndexPayload(parsed) };

                // Merge with everything else that should be loaded. The other
                // datasets are re-read from IndexedDB rather than retained in
                // memory: retaining the merged object graph would cost 50-70 MB
                // permanently, and steady-state pressure is what gets a worker
                // killed while backgrounded on iOS.
                const others = await this._partsToKeep(
                    entry.id, [...Object.keys(installed)]);

                // The final proof, and the only one that covers a payload the
                // Rust side rejects: if this throws, the previous index is still
                // the one loaded in WASM (use_tune_index runs only after serde
                // has deserialised the whole thing) and every offline copy is
                // still on disk.
                const merged = await this.loadMergedIndex([...others, part]);
                if (merged.empty.includes(entry.id)) {
                    throw new Error(
                        'duplicate of an already-loaded dataset — check the '
                        + 'filenames in datasets.json');
                }

                // --- Only now may this dataset's previous copy be replaced ---
                try {
                    await writeDataset(entry.id, raw,
                        { v: entry.v || 0, date: entry.date || null });
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
            } finally {
                raw = null; // release the raw string before the next dataset
            }
        }

        if (Object.keys(installed).length === 0) {
            const reasons = Object.entries(failed)
                .map(([id, why]) => `${id}: ${why}`).join('; ');
            throw new Error(reasons || 'No datasets could be installed');
        }

        await this._afterInstall(installed, failed, persistErrors);
        return { ...this._scalarVersion(), installed, failed, persistErrors };
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

    async _afterInstall(installed, failed, persistErrors) {
        const loaded = { ...this.loadedDatasets };
        for (const [id, info] of Object.entries(installed)) {
            loaded[id] = { ...info, source: 'network' };
        }
        // Anything selected that we could not install, and have no cached copy
        // of, is genuinely missing.
        this.loadedDatasets = {};
        for (const id of Object.keys(loaded)) {
            if (this.selectedDatasets.includes(id)) {
                this.loadedDatasets[id] = loaded[id];
            }
        }

        const datasetsLoaded = Object.keys(this.loadedDatasets);
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
            datasetErrors: { ...failed },
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

        try {
            const { parts, missing } = await readDatasets(next);
            if (parts.length) {
                await this.loadMergedIndex(parts);
                this._recordLoadedDatasets(parts, 'cache', missing);
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
            // The setting stands; it retries next launch or when back online.
            if (cb) cb({ ok: false, error: (e && e.message) || String(e) });
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
    async loadMergedIndex(parts, mergedDatasets = null) {
        console.time('tune-index-to-wasm');
        await this.loadedWASM;
        const merged = mergeIndexParts(parts);
        if (merged.collisions) {
            // A colliding ID makes one setting shadow another — a display bug.
            // Denying the user their whole index over it is not proportionate,
            // so this is reported, never thrown.
            console.warn(`${merged.collisions} setting ID collisions while `
                + 'merging datasets; the data repo should have caught this');
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
