import * as Comlink from '@/js/comlink';
import ffConfig from '@/ffConfig';
import {get,
    set
} from 'idb-keyval';


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
        this.loadedIndex = new Promise(resolve => {
            this.setLoadedIndex = resolve;
        });
        this.loadedSampleRate = new Promise(resolve => {
            this.setLoadedSampleRate = resolve;
        });

        import ('@/wasm/folkfriend.js').then(wasm => {
            this.folkfriendWASM = new wasm.FolkFriendWASM();
            this.setLoadedWASM();
        });
    }

    async version(cb) {
        await this.loadedWASM;
        cb(this.folkfriendWASM.version());
    }

    async onIndexLoad(cb) {
        await this.loadedWASM;
        await this.loadedIndex;
        cb();
    }

    async fetchTuneIndexMetadata() {
        let url = '/res/nud-meta.json';
        // eslint-disable-next-line no-undef
        if (process.env.NODE_ENV === 'production') {
            url = 'https://folkfriend-data.web.app/nud-meta.json';
        }
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch tune index metadata: ${response.status}`);
        return response.json();
    }

    async fetchTuneIndexData(bypassCacheVersion = null) {
        console.time('index-fetch');

        let url = '/res/folkfriend-non-user-data.json';

        // eslint-disable-next-line no-undef
        if (process.env.NODE_ENV === 'production') {
            url = 'https://folkfriend-data.web.app/folkfriend-non-user-data.json';
        }

        // Append ?v=N when forcing an update so the service worker's
        // StaleWhileRevalidate cache (which matches the bare URL) is bypassed
        // and we always get the freshly deployed version from the network.
        if (bypassCacheVersion !== null) {
            url += `?v=${bypassCacheVersion}`;
        }

        // Fetch
        const fetchResponse = await fetch(url);
        if (!fetchResponse.ok) throw new Error(`Failed to fetch tune index: ${fetchResponse.status}`);
        let indexData = await fetchResponse.json();

        // Lightly postprocess. ABC strings and source URLs don't go to WASM
        //  because of slow memory loading in WebAssembly.
        let abcStringBySetting = {};
        let sourceUrlBySetting = {};
        for (let settingID in indexData.settings) {
            abcStringBySetting[settingID] = indexData.settings[settingID].abc;
            indexData.settings[settingID].abc = '';
            if (indexData.settings[settingID].source_url) {
                sourceUrlBySetting[settingID] = indexData.settings[settingID].source_url;
                delete indexData.settings[settingID].source_url;
            }
        }

        const downloadedTuneIndex = {
            indexData: indexData,
            abcStrings: abcStringBySetting,
            sourceUrls: sourceUrlBySetting,
        };

        console.timeEnd('index-fetch');

        return downloadedTuneIndex;
    }

    async setupTuneIndex(cb) {
        // This is the entry point, run every application start, for
        //  loading in the tune index ASAP and also maintaining an up-to-date
        //  offline copy.
        let t0 = performance.now();
        let analyticsData = {
            'newly_installed': false,
            'newly_updated': false
        };
        console.time('tune-index-setup');
        console.time('tune-index-load');

        // Outer catch ensures cb is always called even if IndexedDB itself
        // throws (e.g. storage quota error, browser bug) — without this the
        // backend.js promise never resolves and the app hangs silently.
        let localTuneIndex;
        try {
            localTuneIndex = await get('tuneIndex');
        } catch (e) {
            console.error('IndexedDB read failed in setupTuneIndex', e);
            cb({ error: 'Could not load tune index. Please check your connection and refresh.' });
            return;
        }

        // Guard against true first-install, entries from old IDB formats (stored
        // before the {indexData, abcStrings} split), and entries that lost their
        // abcStrings field under storage pressure. Any of these would cause a
        // WASM panic or silent empty-content bug if loaded as-is.
        const isCachedIndexValid = localTuneIndex &&
            localTuneIndex.indexData &&
            localTuneIndex.abcStrings;

        if (!isCachedIndexValid) {
            console.debug(localTuneIndex
                ? 'Cached tune index is stale or in an invalid format, re-downloading'
                : 'No tune index was cached, requesting download');

            try {
                const downloadedTuneIndex = await this.fetchTuneIndexData();

                // Load (so the user can start using the application)
                await this.loadTuneIndex(downloadedTuneIndex);
                console.timeEnd('tune-index-load');

                // Store the version of this newly downloaded tune index. If
                // metadata fetch fails we can still proceed with the loaded
                // index and persist a safe fallback metadata record.
                let tuneIndexMetadata;
                try {
                    tuneIndexMetadata = await this.fetchTuneIndexMetadata();
                } catch (e) {
                    console.warn('Could not fetch tune index metadata on first install, using fallback metadata', e);
                    tuneIndexMetadata = {
                        v: 0,
                        date: null,
                    };
                }
                await set('tuneIndex', downloadedTuneIndex);
                await set('tuneIndexMetadata', tuneIndexMetadata);

                analyticsData['days_since_update'] = 0;
                analyticsData['tune_index_metadata_version'] = tuneIndexMetadata['v'];
                analyticsData['tune_index_metadata_date'] = tuneIndexMetadata['date'] || null;
                analyticsData['newly_installed'] = true;
            } catch (e) {
                console.error('Failed to download or load tune index on first install', e);
                cb({ error: 'Could not load tune index. Please check your connection and refresh.' });
                return;
            }
        } else {
            console.debug('Found cached tune index');

            // Load cached copy. Wrap in try/catch: a WASM panic on a corrupt
            // (but structurally valid) entry must not hang the app. On failure,
            // wipe the bad entry and try a fresh download; if that also fails
            // (offline), surface an error rather than leaving the app frozen.
            let cachedLoadFailed = false;
            try {
                await this.loadTuneIndex(localTuneIndex);
            } catch (e) {
                console.warn('Cached tune index failed to load (corrupt?), attempting re-download', e);
                cachedLoadFailed = true;
                // Do NOT delete the IDB entry here — only overwrite after a fresh
                // download succeeds. Deleting first would leave the user with no
                // data if the download fails (e.g. offline), which is strictly worse.
                try {
                    const freshIndex = await this.fetchTuneIndexData();
                    await this.loadTuneIndex(freshIndex);
                    let meta;
                    try {
                        meta = await this.fetchTuneIndexMetadata();
                    } catch (_) {
                        meta = { v: 0, date: null };
                    }
                    await set('tuneIndex', freshIndex);
                    await set('tuneIndexMetadata', meta);
                    analyticsData['days_since_update'] = 0;
                    analyticsData['tune_index_metadata_version'] = meta['v'];
                    analyticsData['tune_index_metadata_date'] = meta['date'] || null;
                    analyticsData['newly_installed'] = true;
                } catch (e2) {
                    console.error('Failed to re-download after corrupt cached index', e2);
                    cb({ error: 'Could not load tune index. Please check your connection and refresh.' });
                    return;
                }
            }
            console.timeEnd('tune-index-load');

            if (!cachedLoadFailed) {
                // THEN check the latest version and if we want to upgrade
                let tuneIndexMetadataLocal;
                try {
                    tuneIndexMetadataLocal = await get('tuneIndexMetadata');
                } catch (_) {
                    // IDB error — treat as missing; v=0 will trigger a re-download
                    tuneIndexMetadataLocal = undefined;
                }

                if (typeof tuneIndexMetadataLocal === 'undefined') {
                    // This is a near-impossible state, only reached by people
                    //  selectively deleting from IndexedDB. As browsers do delete
                    //   from IndexedDB when under storage pressure it's best to
                    //   cover this case and be safe.
                    tuneIndexMetadataLocal = {
                        'v': 0
                    };
                }

                const localVersion = tuneIndexMetadataLocal['v'];
                analyticsData['tune_index_metadata_version'] = localVersion;
                analyticsData['tune_index_metadata_date'] = tuneIndexMetadataLocal['date'] || null;

                try {
                    const tuneIndexMetadataRemote = await this.fetchTuneIndexMetadata();
                    const remoteVersion = tuneIndexMetadataRemote['v'];
                    const daysSinceUpdate = remoteVersion - localVersion;
                    console.debug(`Tune index was ${daysSinceUpdate} days out of date`);

                    // Update whenever the remote version is strictly newer than the
                    //  cached version. The dataset is large (~38 MB) but only
                    //  re-fetched when v actually increases, so bandwidth is bounded
                    //  by how often the data pipeline runs.
                    if (remoteVersion > localVersion) {
                        console.debug('Upgrading tune index');
                        try {
                            const downloadedTuneIndex = await this.fetchTuneIndexData(remoteVersion);
                            await this.loadTuneIndex(downloadedTuneIndex);
                            await set('tuneIndex', downloadedTuneIndex);
                            await set('tuneIndexMetadata', tuneIndexMetadataRemote);
                            analyticsData['days_since_update'] = 0;
                            analyticsData['tune_index_metadata_version'] = tuneIndexMetadataRemote['v'];
                            analyticsData['tune_index_metadata_date'] = tuneIndexMetadataRemote['date'] || null;
                            analyticsData['newly_updated'] = true;
                        } catch (e) {
                            // Non-fatal: the cached index is already loaded and usable.
                            console.warn('Failed to update tune index, continuing with cached version', e);
                            analyticsData['days_since_update'] = daysSinceUpdate;
                        }
                    } else {
                        analyticsData['days_since_update'] = daysSinceUpdate;
                    }
                } catch (e) {
                    console.warn('Could not refresh tune index metadata, using cached index', e);
                    analyticsData['days_since_update'] = 0;
                }
            }
        }

        console.timeEnd('tune-index-setup');

        let tEnd = performance.now();
        analyticsData['wall_time'] = tEnd - t0;

        cb(analyticsData);
    }

    async loadTuneIndex(tuneIndex) {
        console.time('tune-index-to-wasm');
        await this.loadedWASM;
        try {
            await this.folkfriendWASM.load_index_from_json_obj(tuneIndex.indexData);
            this.abcStringBySetting = tuneIndex.abcStrings || {};
            this.sourceUrlBySetting = tuneIndex.sourceUrls || {};
            // Signal "index loaded" only on success. A failed load must NOT resolve
            // loadedIndex — queries await it and must not run against an empty WASM
            // index. setupTuneIndex catches the error and either re-downloads or
            // surfaces an error to the user.
            this.setLoadedIndex();
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
    // fetchTuneIndexData) so they must be re-attached to each query result here.
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
        await this.loadedIndex;
        const response = await this.folkfriendWASM.run_transcription_query(query);
        cb(this._reattachSidebandData(JSON.parse(response)));
    }

    async runNameQuery(query, cb) {
        await this.loadedWASM;
        await this.loadedIndex;
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
        await this.loadedIndex;

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
        await this.loadedIndex;
        const aliases = await this.folkfriendWASM.aliases_from_tune_id(tuneID);
        cb(JSON.parse(aliases));
    }
}

const folkfriendWASMWrapper = new FolkFriendWASMWrapper();
Comlink.expose(folkfriendWASMWrapper);
