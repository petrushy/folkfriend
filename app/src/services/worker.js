import * as Comlink from '@/js/comlink';
import ffConfig from '@/ffConfig';
import {
    readIndex,
    readManifest,
    writeIndex,
    splitIndexPayload,
    indexPayloadProblem,
    estimateStorage,
} from '@/services/tuneIndexStore';
import {
    fetchTuneIndexMetadata,
    fetchTuneIndexText,
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


class FolkFriendWASMWrapper {
    constructor() {
        this.folkfriendWASM = null;
        this.abcStringBySetting = {};
        this.sourceUrlBySetting = {};

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
            info: this._loadedIndexInfo ? { ...this._loadedIndexInfo } : null,
        };
    }

    // Put back the state captured by _snapshotIndexState after a failed
    // install. An install that fails changes nothing durable (the offline copy
    // is only written once a download has proved itself) and leaves the
    // previously loaded index in WASM, so if we had a usable index we still do.
    _restoreAfterFailedInstall(snapshot, error) {
        const message = (error && error.message) || String(error);
        if (snapshot.usable) {
            const info = snapshot.info || {};
            this._setIndexStatus(INDEX_STATUS.READY, {
                source: info.source || 'cache',
                v: info.v,
                date: info.date,
                legacy: !!info.legacy,
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

        try {
            const cached = await readIndex();

            if (cached) {
                try {
                    await this.loadTuneIndex(cached.index);
                    this._loadedIndexInfo = {
                        source: 'cache',
                        v: cached.manifest.v,
                        date: cached.manifest.date,
                        legacy: !!cached.manifest.legacy,
                    };
                    this._setIndexStatus(INDEX_STATUS.READY, { ...this._loadedIndexInfo });
                    analyticsData['tune_index_metadata_version'] = cached.manifest.v;
                    analyticsData['tune_index_metadata_date'] = cached.manifest.date || null;
                    analyticsData['days_since_update'] = 0;

                    // Deliberately NOT awaited: the app is already usable, and
                    // the update check must never gate readiness.
                    this._checkForUpdateInBackground(cached.manifest).catch(e =>
                        console.warn('Background tune index update failed', e));

                    return this._finishSetup(analyticsData, t0);
                } catch (e) {
                    // KEEP THE COPY. Failing to consume the data is not proof
                    // that the data is bad: readIndex has already established
                    // that it parses and is shaped like a tune index, so the
                    // likely causes here are memory pressure, a worker killed
                    // mid-load, or a bug in this particular build — all of which
                    // a later launch may well survive. Deleting it meant one bad
                    // startup cost the user their only offline copy, and they
                    // found out the next time they had no signal.
                    //
                    // A genuinely unloadable payload is not stuck forever: the
                    // download below replaces it as soon as there is a network,
                    // and a payload that stops looking like a tune index at all
                    // is cleared by readIndex.
                    cachedLoadError = (e && e.message) || String(e);
                    console.warn('Cached tune index failed to load into WASM; '
                        + 'keeping the offline copy and trying the network', e);
                }
            }

            // No usable offline copy. This is the path that must fail FAST when
            // there is no network — the user gets favourites-only mode
            // immediately instead of after a multi-minute hang.
            if (isDefinitelyOffline()) {
                this._setIndexStatus(INDEX_STATUS.UNAVAILABLE, {
                    reason: 'offline',
                    offline: true,
                    loadError: cachedLoadError,
                });
                analyticsData.error = 'No offline copy of the tune index, and you are offline.';
                if (cachedLoadError) analyticsData['cached_load_error'] = cachedLoadError;
                return this._finishSetup(analyticsData, t0);
            }

            const installed = await this._installExclusively(null);
            if (cachedLoadError) analyticsData['cached_load_error'] = cachedLoadError;
            analyticsData['newly_installed'] = true;
            analyticsData['days_since_update'] = 0;
            analyticsData['tune_index_metadata_version'] = installed.v;
            analyticsData['tune_index_metadata_date'] = installed.date || null;
            if (installed.persistError) {
                analyticsData['persist_error'] = installed.persistError;
            }
            return this._finishSetup(analyticsData, t0);
        } catch (e) {
            console.error('Tune index setup failed', e);
            this._setIndexStatus(INDEX_STATUS.UNAVAILABLE, {
                reason: e instanceof NetworkUnavailableError ? 'network' : 'error',
                message: e && e.message,
                offline: isDefinitelyOffline(),
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

    // Download, VALIDATE, load and only then persist the index.
    //
    // ORDER IS A RELIABILITY PROPERTY, and this is the second half of the rule
    // writeIndex documents: a known-good offline copy is immutable until a
    // replacement has proved itself. writeIndex overwrites the previous copy
    // irrecoverably, so everything that can reject the download must happen
    // first:
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
    // The cost is holding the ~42 MB raw string alive across the WASM load
    // instead of releasing it just before, so peak memory during an install is
    // higher. That trade is right: running out of memory here now fails BEFORE
    // the write and leaves the previous copy untouched, whereas the old order
    // could survive the write and still leave the user with an index that
    // cannot load.
    async _downloadAndInstall(bypassCacheVersion) {
        this._setIndexStatus(INDEX_STATUS.DOWNLOADING, { received: 0, total: 0 });

        // nud-meta.json is ~50 bytes from the same host as the index, so it
        // doubles as a fast reachability probe. Its failure is deliberately
        // FATAL here: if we cannot read 50 bytes from that host there is no
        // sense starting a 42 MB download, and failing at the 8 s metadata
        // deadline is what lets the app say "unavailable" quickly behind a
        // captive portal instead of grinding on a stalled transfer.
        const metadata = await fetchTuneIndexMetadata();

        let lastReport = 0;
        let raw = await fetchTuneIndexText(bypassCacheVersion, ({ received, total }) => {
            // Throttle: this fires per network chunk and each report crosses
            // the Comlink boundary.
            const now = Date.now();
            if (now - lastReport < 250) return;
            lastReport = now;
            this._setIndexStatus(INDEX_STATUS.DOWNLOADING, { received, total });
        });

        const version = { v: metadata.v || 0, date: metadata.date || null };

        // --- Prove the download is good, before anything durable changes ----

        // A parse failure throws out of here with nothing written: truncated
        // bodies, HTML error pages and captive-portal interception all land
        // here. try/finally because the timer must be closed on the throwing
        // path too — otherwise every failed update leaks its label and the next
        // one reports a nonsense duration.
        let parsed;
        console.time('index-parse-from-network');
        try {
            parsed = JSON.parse(raw);
        } finally {
            console.timeEnd('index-parse-from-network');
        }

        // Valid JSON is not the same as "is the tune index".
        const problem = indexPayloadProblem(parsed);
        if (problem) {
            throw new Error(`Downloaded tune index is not usable (${problem})`);
        }

        // The final proof, and the only one that covers a payload the Rust side
        // rejects: if this throws, the previous index is still the one loaded in
        // WASM (use_tune_index runs only after serde has deserialised the whole
        // thing) and the previous offline copy is still on disk.
        await this.loadTuneIndex(splitIndexPayload(parsed));

        // --- Only now may the previous offline copy be replaced -------------

        let persistError = null;
        try {
            await writeIndex(raw, version);
        } catch (e) {
            // The index still works for this session; it just won't survive a
            // restart. Surfaced in Settings rather than swallowed, because
            // "silently no offline copy" is the failure the user actually hit.
            console.error('Could not persist offline copy of tune index', e);
            persistError = (e && e.message) || String(e);
        }
        raw = null; // release the ~42 MB string

        this._loadedIndexInfo = { source: 'network', v: version.v, date: version.date };
        this._setIndexStatus(INDEX_STATUS.READY, {
            ...this._loadedIndexInfo,
            persistError,
        });

        return { v: version.v, date: version.date, persistError };
    }

    // Run an install with at most one in flight across the whole worker.
    //
    // Two installs could previously overlap: setup fires the background update
    // check without awaiting it (deliberately — readiness must never wait on
    // the network), then clears _setupInFlight, so tapping "Update offline
    // copy" in Settings while that background update was still downloading
    // started a second one. Both would validate before writing, so neither
    // could store junk — but their writes interleave, and ffIndexRaw and
    // ffIndexManifest are separate transactions. The end state could be a
    // manifest from one install describing the payload of the other. When the
    // two payloads differ in length readIndex catches the mismatch and reports
    // the version as unknown, costing a redundant download; when they happen to
    // be the same length nothing detects it and the version is simply wrong.
    //
    // A second caller JOINS the running install rather than queueing another:
    // both want the same thing (the newest data, validated and saved), and
    // queueing would mean a second 42 MB transfer on what is usually mobile
    // data. The joiner gets the same resolution or rejection, and restores its
    // own snapshot on failure.
    async _installExclusively(bypassCacheVersion) {
        if (this._indexUpdateInFlight) {
            console.debug('Tune index install already in flight; joining it');
            return await this._indexUpdateInFlight;
        }
        this._indexUpdateInFlight = this._downloadAndInstall(bypassCacheVersion);
        try {
            return await this._indexUpdateInFlight;
        } finally {
            this._indexUpdateInFlight = null;
        }
    }

    async _checkForUpdateInBackground(manifest) {
        if (isDefinitelyOffline()) return;
        if (!this.autoUpdateEnabled) {
            console.debug('Automatic tune index updates are disabled');
            return;
        }

        let remote;
        try {
            remote = await fetchTuneIndexMetadata();
        } catch (e) {
            // Entirely expected when offline or behind a captive portal.
            console.debug('Tune index update check skipped:', e.message);
            return;
        }

        if (!(remote.v > manifest.v)) {
            console.debug(`Tune index up to date (v${manifest.v})`);
            return;
        }

        console.debug(`Upgrading tune index v${manifest.v} -> v${remote.v}`);
        const snapshot = this._snapshotIndexState();
        try {
            await this._installExclusively(remote.v);
        } catch (e) {
            // Non-fatal: the cached index is loaded and usable, and the failed
            // update changed nothing on disk. Restore READY so a failed
            // background update can't leave the app looking broken.
            console.warn('Tune index update failed; keeping cached version', e);
            this._restoreAfterFailedInstall(snapshot, e);
        }
    }

    // Download + persist regardless of the local version. Used by the Settings
    // "Save offline copy" / "Refresh tune data" actions, and by the 'online'
    // handler when the index is currently unavailable.
    //
    // NOT unconditionally a *fresh* download: if an install is already running
    // this joins it (see _installExclusively) rather than starting a second
    // 42 MB transfer. So if a background update to v2 is in flight and the host
    // has since published v3, this reports success at v2. That is the right
    // trade on mobile data — the user asked for their offline copy to be
    // brought up to date, and it was — but it does mean a tap can land one
    // version behind the very newest. Re-checking the metadata after joining
    // and only then downloading again would close that gap cheaply.
    async refreshTuneIndex(cb) {
        if (this._setupInFlight) {
            await this._setupInFlight;
            cb({ ok: this.indexStatus === INDEX_STATUS.READY });
            return;
        }
        this._setupInFlight = (async () => {
            if (isDefinitelyOffline()) {
                return { ok: false, error: 'You are offline.' };
            }
            // Captured before the download starts, because _downloadAndInstall
            // sets DOWNLOADING immediately — reading the status in the catch
            // block below always saw DOWNLOADING, never READY, so every failed
            // manual refresh reported UNAVAILABLE even with a perfectly good
            // index still loaded. That produced status='unavailable' alongside
            // usable=true, and which of the two a given view believed decided
            // whether it showed tunes or an error.
            const snapshot = this._snapshotIndexState();
            try {
                // Unique query string forces a fresh copy past any HTTP cache.
                const installed = await this._installExclusively(Date.now());
                return {
                    ok: true,
                    v: installed.v,
                    date: installed.date,
                    persistError: installed.persistError,
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

    // Diagnostics for the Settings page: what is actually on disk, and how
    // much room there is. Read straight from IndexedDB so it reflects reality
    // rather than in-memory state.
    async getOfflineStatus(cb) {
        let manifest = null;
        try {
            manifest = await readManifest();
        } catch (e) {
            console.warn('Could not read tune index manifest', e);
        }
        const storage = await estimateStorage();
        cb({
            manifest,
            storage,
            status: this.indexStatus,
            detail: this.indexDetail,
        });
    }

    async loadTuneIndex(tuneIndex) {
        console.time('tune-index-to-wasm');
        await this.loadedWASM;
        try {
            await this.folkfriendWASM.load_index_from_json_obj(tuneIndex.indexData);
            this.abcStringBySetting = tuneIndex.abcStrings || {};
            this.sourceUrlBySetting = tuneIndex.sourceUrls || {};
            // From here queries work, regardless of what the pipeline does next.
            this.indexUsable = true;
        } finally {
            console.timeEnd('tune-index-to-wasm');
        }
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
