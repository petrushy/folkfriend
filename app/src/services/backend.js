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

        this.folkfriendWorker.onIndexLoad(Comlink.proxy(() => {
            eventBus.$emit('indexLoaded');
        }));

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

    async version() {
        return new Promise(resolve => {
            this.folkfriendWorker.version(Comlink.proxy(version => {
                resolve(version);
            }));
        });
    }

    async setupTuneIndex() {
        const analyticsData = await new Promise(resolve => {
            this.folkfriendWorker.setupTuneIndex(Comlink.proxy(analyticsData => {
                resolve(analyticsData);
            }));
        });
        if (analyticsData.error) {
            console.error('Tune index setup failed:', analyticsData.error);
            eventBus.$emit('tuneIndexError', analyticsData.error);
            return;
        }
        store.logAnalyticsEvent('tune_index_init', analyticsData).then();
        store.state.tuneIndexVersion = analyticsData['tune_index_metadata_version'];
        store.state.tuneIndexDate = analyticsData['tune_index_metadata_date'] || null;
        // Apply the persisted ML-transcriber preference now that the worker is up.
        this.setUseMlTranscriber(store.userSettings.useMlTranscriber || false).catch(e =>
            console.warn('Could not set ML transcriber preference', e));
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
