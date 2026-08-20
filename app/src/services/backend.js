import * as Comlink from '@/js/comlink.js';
import store from '@/services/store.js';
import router from '@/router/index.js';
import eventBus from '@/eventBus';
import ffConfig from '@/ffConfig.js';
import {
    HistoryItem
} from '@/js/schema';

class FFBackend {
    /* Yet another layer of abstraction. This class is the route that all
            information to / from the WebAssembly backend must pass through.
            This is the class that the app directly uses to make use of folkfriend.
            It uses comlink and callbacks to communicate with the worker thread,
            which actually loads in the WebAssembly module.
        */

    constructor() {
        const worker = new Worker(new URL('@/services/worker.js', import.meta.url));
        this.folkfriendWorker = Comlink.wrap(worker);

        // Single source of truth for "is the tune index usable". Views read
        // store.state.indexStatus (and listen for 'indexStatusChanged') rather
        // than racing a one-shot event against their own mount, which is what
        // made every Tune view sit through a 15 s timeout when the index was
        // slow or unavailable.
        this.folkfriendWorker.subscribeIndexStatus(Comlink.proxy(detail => {
            this._onIndexStatus(detail);
        }));

        // When connectivity comes back, an index that failed to install is
        // retried automatically — the user should not have to restart the app.
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => {
                const detail = store.state.indexStatusDetail || {};
                // An empty selection is a legitimate choice, not a failure to
                // retry. Without this check every network blip re-runs a setup
                // that cannot possibly succeed.
                if (detail.reason === 'no-datasets-selected') return;
                if (store.state.indexStatus === 'unavailable') {
                    console.debug('Back online — retrying tune index setup');
                    this.setupTuneIndex().catch(e =>
                        console.warn('Tune index retry failed', e));
                }
            });
        }

        // Serialises compound PCM-buffer pipelines (flush → feed → transcribe → query)
        // so two callers cannot interleave and corrupt each other's WASM buffer.
        // Only wraps operations that touch the shared PCM buffer; index lookups
        // (name search, settings-by-tune-id, etc.) run unguarded.
        this._pcmBufferLock = Promise.resolve();
    }

    _withPCMBufferLock(fn) {
        const prev = this._pcmBufferLock;
        let release;
        const next = new Promise(resolve => { release = resolve; });
        this._pcmBufferLock = next;
        return prev.then(fn).finally(release);
    }

    _onIndexStatus(detail) {
        const previous = store.state.indexStatus;
        const previouslyLoaded = store.state.indexLoaded;
        store.state.indexStatus = detail.status;
        store.state.indexStatusDetail = detail;
        // Usable, not "ready": during a background update the status is
        // 'downloading' but the loaded index still answers queries, so the UI
        // must not regress to a loading state or fall back to favourites.
        store.state.indexLoaded = !!detail.usable || detail.status === 'ready';
        store.state.tuneIndexError = detail.status === 'unavailable' && !detail.usable;
        store.state.indexDownloadProgress =
            detail.status === 'downloading'
                ? { received: detail.received || 0, total: detail.total || 0 }
                : null;

        if (detail.status === 'ready') {
            if (detail.v) store.state.tuneIndexVersion = detail.v;
            if (detail.date) store.state.tuneIndexDate = detail.date;
        }
        // Which datasets are actually searchable right now, and which of the
        // selected ones are not. Search.vue surfaces the gap: a user whose
        // norbeck download quietly failed would otherwise search a Swedish
        // tune, get nothing, and conclude the app does not have it.
        store.state.indexDatasets = {
            loaded: detail.datasetsLoaded || [],
            missing: detail.datasetsMissing || [],
            errors: detail.datasetErrors || {},
            migrationPending: !!detail.migrationPending,
        };

        eventBus.$emit('indexStatusChanged', detail);
        // Legacy edge events, kept so existing views keep working.
        if (store.state.indexLoaded && !previouslyLoaded) {
            eventBus.$emit('indexLoaded');
        }
        if (store.state.tuneIndexError && previous !== 'unavailable') {
            eventBus.$emit('tuneIndexError', this.indexUnavailableMessage(detail));
        }
    }

    indexUnavailableMessage(detail) {
        const d = detail || store.state.indexStatusDetail || {};
        if (d.reason === 'no-datasets-selected') {
            return 'No tune databases are selected. Choose one in Settings. Your favourites are still available.';
        }
        if (d.offline || d.reason === 'offline') {
            return 'You are offline and no tune database is saved on this device. Your favourites are still available.';
        }
        if (d.reason === 'network') {
            return 'Could not reach the tune database. Your favourites are still available.';
        }
        return 'Could not load the tune database. Your favourites are still available.';
    }

    // Resolves as soon as the index is usable, or as soon as it is known not to
    // be — true when queries will work, false when the caller should fall back
    // to locally saved data. Never hangs: the worker's state machine always
    // settles.
    //
    // USABILITY, NOT PIPELINE STATUS. A loaded index keeps answering queries
    // while a newer one downloads in the background, so waiting for the status
    // to read 'ready' meant every caller — the Tune view, TheSession bookmark
    // import — blocked on a 42 MB transfer that had no bearing on whether their
    // query would work. Same distinction the worker draws between indexUsable
    // and indexStatus; this is the client side of it.
    indexReady() {
        if (store.state.indexLoaded) return Promise.resolve(true);
        if (store.state.indexStatus === 'unavailable') return Promise.resolve(false);
        return new Promise(resolve => {
            const onChange = detail => {
                const usable = !!detail.usable || detail.status === 'ready';
                if (usable || detail.status === 'unavailable') {
                    eventBus.$off('indexStatusChanged', onChange);
                    resolve(usable);
                }
            };
            eventBus.$on('indexStatusChanged', onChange);
        });
    }

    // `datasetIds` of null refreshes everything currently selected.
    async refreshTuneIndex(datasetIds = null) {
        return new Promise(resolve => {
            this.folkfriendWorker.refreshTuneIndex(
                datasetIds, Comlink.proxy(resolve));
        });
    }

    // Apply a new dataset selection. Unlike setAutoUpdate this MUST be pushed
    // on change rather than waiting for the next setupTuneIndex — the user has
    // just asked for different tunes and expects them now.
    async setSelectedDatasets(ids) {
        return new Promise(resolve => {
            this.folkfriendWorker.setSelectedDatasets(
                [...ids], Comlink.proxy(resolve));
        });
    }

    async removeDataset(id) {
        return new Promise(resolve => {
            this.folkfriendWorker.removeDataset(id, Comlink.proxy(resolve));
        });
    }

    async getDatasetInventory(ids) {
        return new Promise(resolve => {
            this.folkfriendWorker.getDatasetInventory(
                [...ids], Comlink.proxy(resolve));
        });
    }

    async getOfflineStatus() {
        return new Promise(resolve => {
            this.folkfriendWorker.getOfflineStatus(Comlink.proxy(resolve));
        });
    }

    async version() {
        return new Promise(resolve => {
            this.folkfriendWorker.version(Comlink.proxy(version => {
                resolve(version);
            }));
        });
    }

    async setAutoUpdate(enabled) {
        await this.folkfriendWorker.setAutoUpdate(!!enabled);
    }

    async setupTuneIndex() {
        // Push the preference BEFORE setup, so a user who has disabled updates
        // never gets one on the very launch where it matters.
        const auto = store.userSettings.autoUpdateTuneData;
        await this.folkfriendWorker.setAutoUpdate(auto === undefined ? true : !!auto);
        // Likewise the dataset selection: the worker must know what to load
        // before it reads anything off disk.
        await this.folkfriendWorker.setSelectedDatasets(
            [...store.selectedDatasets()], null);
        const analyticsData = await new Promise(resolve => {
            this.folkfriendWorker.setupTuneIndex(Comlink.proxy(analyticsData => {
                resolve(analyticsData);
            }));
        });
        // Status (and therefore the tuneIndexError flag and events) is driven
        // by subscribeIndexStatus, not by this callback — the callback only
        // carries analytics. This keeps a single code path for readiness.
        store.logAnalyticsEvent('tune_index_init', analyticsData).then();

        // Independent of the index: apply the persisted ML-transcriber
        // preference now that the worker is up.
        this.setUseMlTranscriber(store.userSettings.useMlTranscriber || false).catch(e =>
            console.warn('Could not set ML transcriber preference', e));

        if (analyticsData.error) {
            console.error('Tune index setup failed:', analyticsData.error);
            return;
        }
        if (analyticsData['tune_index_metadata_version'] !== undefined) {
            store.state.tuneIndexVersion = analyticsData['tune_index_metadata_version'];
            store.state.tuneIndexDate = analyticsData['tune_index_metadata_date'] || null;
        }
        eventBus.$emit('tuneIndexReady');
    }

    async setSampleRate(sampleRate) {
        // Same check as in folkfriend::feature::signal::validate_sample_rate
        let isValid = sampleRate < ffConfig.SAMPLE_RATE_MAX && sampleRate > ffConfig.SAMPLE_RATE_MIN;
        if (!isValid) {
            throw {
                name: 'SampleRateError',
                message: `Invalid sample rate: ${sampleRate} Hz`
            };
        }

        await this.folkfriendWorker.setSampleRate(sampleRate);
    }

    async setUseMlTranscriber(useMl) {
        // Push the opt-in ML-transcriber setting to the worker/WASM. Must be set
        // before PCM is fed (the feed path branches on it), so we call this on
        // startup and whenever the Settings toggle changes — not per-recording.
        await this.folkfriendWorker.setUseMlTranscriber(!!useMl);
    }

    async feedEntirePCMSignal(PCMSignal) {
        // Assert the transcriber mode from the current setting BEFORE feeding —
        // the WASM feed path branches on it. This guarantees the ML toggle
        // applies to file upload, live session and ring-buffer analysis (all of
        // which feed a whole signal through here), independent of when the
        // setting was last pushed.
        await this.setUseMlTranscriber(store.userSettings.useMlTranscriber || false);
        await this.folkfriendWorker.feedEntirePCMSignal(PCMSignal);
    }

    async feedSinglePCMWindow(PCMWindow) {
        await this.folkfriendWorker.feedSinglePCMWindow(PCMWindow);
    }

    async flushPCMBuffer() {
        await this.folkfriendWorker.flushPCMBuffer();
    }

    async transcribePCMBuffer() {
        console.time('transcribe-pcm-buffer');
        return new Promise(resolve => {
            this.folkfriendWorker.transcribePCMBuffer(Comlink.proxy(contour => {
                console.timeEnd('transcribe-pcm-buffer');
                resolve(contour);
            }));
        });
    }

    async runTranscriptionQuery(query) {
        console.time('run-transcription-query');
        return new Promise(resolve => {
            this.folkfriendWorker.runTranscriptionQuery(query, Comlink.proxy(response => {
                console.timeEnd('run-transcription-query');
                resolve(response);
            }));
        });
    }

    submitFilledBuffer(skipHistory = false) {
        return this._withPCMBufferLock(() => this._submitFilledBufferUnlocked(skipHistory));
    }

    async _submitFilledBufferUnlocked(skipHistory) {
        let t0 = performance.now();
        const contour = await this.transcribePCMBuffer();
        let tEnd = performance.now();

        console.debug('contour', contour);

        store.logAnalyticsEvent('transcription', {
            'wall_time': tEnd - t0,
            'contour': contour,
            'contour_length': contour.length,
        }).then();

        try {
            let errorMsg = JSON.parse(contour)['error'];
            if (errorMsg) {
                eventBus.$emit('searchError', errorMsg);
                store.setSearchState(store.searchStates.READY);
                return;
            }
        } catch (e) {
            if (!(e instanceof SyntaxError)) {
                store.setSearchState(store.searchStates.READY);
                throw e;
            }
        }

        // If we have limited the recording time, then the query will probably
        //  be short, and so it's sensible to run a search query. Users can
        //  disable the automatic querying if they desire, for example if
        //  transcribing a new and/or long tune to sheet music.
        const doQuery = !store.userSettings.advancedMode;

        if (doQuery) {
            let t0 = performance.now();
            const queryResults = await this.runTranscriptionQuery(contour);
            let tEnd = performance.now();

            const highestScore = (queryResults[0] || {
                score: 0
            }).score;

            store.logAnalyticsEvent('transcription_query', {
                'wall_time': tEnd - t0,
                'query_length': contour.length,
                'highest_score': highestScore,
            }).then();

            // No point proceeding if not a single sensible note was found...
            if (highestScore === 0) {
                eventBus.$emit('searchError', 'Could not detect any music');
                store.setSearchState(store.searchStates.READY);
                return;
            }

            store.state.lastResults = queryResults;

            router.push({
                name: 'results'
            });
            eventBus.$emit('childViewActivated');
        }

        store.state.lastContour = contour;
        if (!skipHistory) {
            store.addToHistory(new HistoryItem({
                contour: contour
            }));
        }

        if (!doQuery) {
            router.push({
                name: 'notes'
            });
            eventBus.$emit('childViewActivated');
        }

        store.setSearchState(store.searchStates.READY);
    }

    async runNameQuery(query) {
        return new Promise(resolve => {
            this.folkfriendWorker.runNameQuery(query, Comlink.proxy(response => {
                resolve(response);
            }));
        });
    }

    async contourToAbc(contour) {
        return new Promise(resolve => {
            this.folkfriendWorker.contourToAbc(contour, Comlink.proxy(abc => {
                resolve(abc);
            }));
        });
    }

    transcribeAndQueryPCMSignal(PCMSignal) {
        return this._withPCMBufferLock(() => this._transcribeAndQueryPCMSignalUnlocked(PCMSignal));
    }

    async _transcribeAndQueryPCMSignalUnlocked(PCMSignal) {
        await this.flushPCMBuffer();

        try {
            await this.feedEntirePCMSignal(PCMSignal);
        } catch (e) {
            await this.flushPCMBuffer();
            return {
                error: e && e.message ? e.message : String(e),
                contour: '',
                results: [],
            };
        }

        const contour = await this.transcribePCMBuffer();

        try {
            const maybeError = JSON.parse(contour);
            if (maybeError && maybeError.error) {
                await this.flushPCMBuffer();
                return {
                    error: maybeError.error,
                    contour: '',
                    results: [],
                };
            }
        } catch (e) {
            if (!(e instanceof SyntaxError)) {
                await this.flushPCMBuffer();
                throw e;
            }
        }

        const results = await this.runTranscriptionQuery(contour);
        return {
            error: null,
            contour,
            results,
        };
    }

    analyzeRingBuffer(pcm) {
        return this._withPCMBufferLock(async () => {
            await this.feedEntirePCMSignal(pcm);
            await this._submitFilledBufferUnlocked(true);
        });
    }

    async settingsFromTuneID(tuneID) {
        return new Promise((resolve, reject) => {
            this.folkfriendWorker.settingsFromTuneID(tuneID, Comlink.proxy(resolve))
                .catch(reject);
        });
    }

    async aliasesFromTuneID(tuneID) {
        return new Promise((resolve, reject) => {
            this.folkfriendWorker.aliasesFromTuneID(tuneID, Comlink.proxy(resolve))
                .catch(reject);
        });
    }
}

const ffBackend = new FFBackend();
export default ffBackend;
