import * as Comlink from '@/js/comlink';
import ffConfig from '@/ffConfig';
import {
    readIndex,
    readManifest,
    writeIndex,
    clearIndex,
    splitIndexPayload,
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
        this.indexDetail = { ...detail, status };
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

    // Await a terminal index state and report whether it is usable. Returns
    // promptly once the state machine has settled — index-dependent calls use
    // this instead of blocking on a promise that may never resolve.
    async _indexIsUsable() {
        if (this.indexStatus === INDEX_STATUS.READY) return true;
        if (this.indexStatus === INDEX_STATUS.UNAVAILABLE) return false;
        await this._indexSettled;
        return this.indexStatus === INDEX_STATUS.READY;
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

        try {
            const cached = await readIndex();

            if (cached) {
                try {
                    await this.loadTuneIndex(cached.index);
                    this._setIndexStatus(INDEX_STATUS.READY, {
                        source: 'cache',
                        v: cached.manifest.v,
                        date: cached.manifest.date,
                        legacy: !!cached.manifest.legacy,
                    });
                    analyticsData['tune_index_metadata_version'] = cached.manifest.v;
                    analyticsData['tune_index_metadata_date'] = cached.manifest.date || null;
                    analyticsData['days_since_update'] = 0;

                    // Deliberately NOT awaited: the app is already usable, and
                    // the update check must never gate readiness.
                    this._checkForUpdateInBackground(cached.manifest).catch(e =>
                        console.warn('Background tune index update failed', e));

                    return this._finishSetup(analyticsData, t0);
                } catch (e) {
                    // Structurally valid but unloadable (e.g. schema change that
                    // panics WASM). Discard it and fall through to a download.
                    console.warn('Cached tune index failed to load; discarding', e);
                    await clearIndex();
                }
            }

            // No usable offline copy. This is the path that must fail FAST when
            // there is no network — the user gets favourites-only mode
            // immediately instead of after a multi-minute hang.
            if (isDefinitelyOffline()) {
                this._setIndexStatus(INDEX_STATUS.UNAVAILABLE, {
                    reason: 'offline',
                    offline: true,
                });
                analyticsData.error = 'No offline copy of the tune index, and you are offline.';
                return this._finishSetup(analyticsData, t0);
            }

            const installed = await this._downloadAndInstall(null);
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

    // Download, load and persist the index. Persisting happens BEFORE parsing
    // so that the offline copy is secured as early as possible — the whole
    // point of the exercise is that this survives to the next launch.
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

        console.time('index-parse-from-network');
        const parsed = JSON.parse(raw);
        console.timeEnd('index-parse-from-network');
        raw = null; // let the ~42 MB string go before we build the split payload

        await this.loadTuneIndex(splitIndexPayload(parsed));

        this._setIndexStatus(INDEX_STATUS.READY, {
            source: 'network',
            v: version.v,
            date: version.date,
            persistError,
        });

        return { v: version.v, date: version.date, persistError };
    }

    async _checkForUpdateInBackground(manifest) {
        if (isDefinitelyOffline()) return;

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
        try {
            await this._downloadAndInstall(remote.v);
        } catch (e) {
            // Non-fatal: the cached index is loaded and usable. Restore READY
            // so a failed background update can't leave the app looking broken.
            console.warn('Tune index update failed; keeping cached version', e);
            this._setIndexStatus(INDEX_STATUS.READY, {
                source: 'cache',
                v: manifest.v,
                date: manifest.date,
                legacy: !!manifest.legacy,
                updateError: (e && e.message) || String(e),
            });
        }
    }

    // Force a fresh download + persist, regardless of version. Used by the
    // Settings "Save offline copy" / "Refresh tune data" actions, and by the
    // 'online' handler when the index is currently unavailable.
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
            try {
                // Unique query string forces a fresh copy past any HTTP cache.
                const installed = await this._downloadAndInstall(Date.now());
                return {
                    ok: true,
                    v: installed.v,
                    date: installed.date,
                    persistError: installed.persistError,
                };
            } catch (e) {
                const wasReady = this.indexStatus === INDEX_STATUS.READY;
                if (!wasReady) {
                    this._setIndexStatus(INDEX_STATUS.UNAVAILABLE, {
                        reason: 'network',
                        message: e && e.message,
                        offline: isDefinitelyOffline(),
                    });
                }
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
