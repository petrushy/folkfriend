<template>
    <div class="search">
        <RecorderButton
            v-if="searchState !== 'listening' && searchState !== 'working'"
            ref="recorderButton"
            class="mx-auto my-xl-5 pt-5"
            @clickFileUpload="$refs.fileUpload.click()"
        />

        <!-- Analyze circle — same position/size as RecorderButton, shown during monitor mode -->
        <div
            v-if="searchState === 'listening' || searchState === 'working'"
            class="analyze-circle mx-auto my-xl-5 pt-5"
            @click="analyze"
        >
            <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="-1 -1 26 26"
                class="analyze-svg mx-auto"
                :style="searchState === 'listening' ? { '--analyze-scale': analyzeScale } : {}"
            >
                <circle
                    class="analyze-ring"
                    :class="{ 'analyze-ring--active': searchState === 'listening' }"
                    cx="12" cy="12" r="12"
                />
                <path
                    v-if="searchState !== 'working'"
                    class="analyze-icon"
                    d="M2 12 Q5 6 8 12 Q11 18 14 12 Q17 6 20 12 L22 12"
                    stroke-width="1.2"
                    stroke-linecap="round"
                    fill="none"
                />
                <path
                    v-if="searchState === 'working'"
                    class="analyze-icon analyze-spin"
                    d="M12 4a8 8 0 0 1 8 8"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    fill="none"
                />
            </svg>
        </div>

        <v-row
            v-if="searchState === 'recording' || searchState === 'listening'"
            justify="center"
            class="px-4"
            style="margin-top: 8px; min-height: 18px;"
        >
            <VolumeMeter :active="searchState === 'recording' || searchState === 'listening'" />
        </v-row>

        <v-row justify="center" class="monitor-row px-4" style="gap: 4px;">
            <v-btn
                small
                text
                :color="searchState === 'listening' || searchState === 'working' ? 'green' : 'grey darken-1'"
                :disabled="searchState === 'recording' || searchState === 'working'"
                @click="toggleMonitor"
            >
                <v-icon left small>{{ searchState === 'listening' || searchState === 'working' ? icons.microphoneOff : icons.microphone }}</v-icon>
                {{ searchState === 'listening' || searchState === 'working' ? 'Stop monitoring' : 'Monitor' }}
            </v-btn>
            <v-btn
                small
                text
                color="grey darken-1"
                :disabled="searchState === 'recording' || searchState === 'listening' || searchState === 'working'"
                :to="{ name: 'session-analysis', query: { live: '1' } }"
            >
                <v-icon left small>{{ icons.timer }}</v-icon>
                Continuous
            </v-btn>
        </v-row>
        <input
            id="audio-upload"
            ref="fileUpload"
            type="file"
            accept="audio/*"
            style="display: none"
            @change="audioFileChanged"
        >

        <v-container>
            <v-row
                wrap
                justify="center"
            >
                <v-col
                    class="mx-5 pt-8 pb-0"
                    sm="6"
                    md="8"
                >
                    <v-text-field
                        v-model="textQuery"
                        label="Search By Tune Name"
                        solo
                        @keypress.enter="nameQuery"
                    >
                        <template #append>
                            <v-icon @click="nameQuery">
                                {{
                                    icons.magnify
                                }}
                            </v-icon>
                        </template>
                    </v-text-field>
                </v-col>
            </v-row>
        </v-container>

        <v-container class="tuneProgress">
            <template v-if="!indexError">
                <v-progress-linear
                    :class="{ Transparent: indexLoaded }"
                    :indeterminate="downloadPercent === null"
                    :value="downloadPercent || 0"
                    rounded
                />
                <p v-if="indexStatus === 'downloading'" class="indexProgressMsg">
                    Downloading tune database{{ downloadPercent === null ? '' : ` — ${downloadPercent}%` }}…
                    <br>This happens once; afterwards FolkFriend works offline.
                </p>
            </template>
            <p v-else class="indexErrorMsg">
                {{ indexError }}
            </p>
        </v-container>

        <v-snackbar
            v-model="snackbar"
            class="text-center"
            :timeout="3000"
        >
            {{ snackbarText }}
        </v-snackbar>
    </div>
</template>

<script>
import RecorderButton from '@/components/RecorderButton';
import VolumeMeter from '@/components/VolumeMeter';
import ffBackend from '@/services/backend';
import audioService from '@/services/audio';
import store from '@/services/store';
import eventBus from '@/eventBus';
import { mdiMagnify, mdiMicrophone, mdiMicrophoneOff, mdiWaveform, mdiTimerOutline } from '@mdi/js';
import micService from '@/services/mic';

export default {
    name: 'SearchView',
    components: {
        RecorderButton,
        VolumeMeter,
    },
    data: function () {
        return {
            snackbar: null,
            snackbarText: null,

            textQuery: '',
            offlineButton: true,
            indexLoaded: store.state.indexLoaded,
            indexStatus: store.state.indexStatus,
            downloadProgress: null,
            indexError: null,
            searchState: store.searchState,
            analyzeScale: 1.0,

            icons: {
                magnify: mdiMagnify,
                microphone: mdiMicrophone,
                microphoneOff: mdiMicrophoneOff,
                waveform: mdiWaveform,
                timer: mdiTimerOutline,
            },
        };
    },
    computed: {
        downloadPercent() {
            // store.state is a plain (non-reactive) object, so progress is
            // pushed in from the indexStatusChanged handler rather than read
            // from the store here.
            const p = this.downloadProgress;
            if (!p || !p.total) return null;
            return Math.min(100, Math.round((p.received / p.total) * 100));
        },
    },
    created: function () {
        eventBus.$emit('parentViewActivated');

        this._onIndexLoaded = () => { this.indexLoaded = true; };
        this._onIndexError = (msg) => { this.indexError = msg; };
        this._onIndexStatus = (detail) => {
            this.indexStatus = detail.status;
            this.downloadProgress = detail.status === 'downloading'
                ? { received: detail.received || 0, total: detail.total || 0 }
                : null;
            if (detail.status !== 'unavailable') this.indexError = null;
        };
        this._onSearchError = (errorMsg) => {
            this.snackbar = true;
            this.snackbarText = errorMsg || 'An error ocurred 😟';
        };
        this._onSetSearchState = () => {
            this.searchState = store.searchState;
            if (store.isListening()) {
                this._startPulse();
            }
        };

        if (!this.indexLoaded) {
            eventBus.$on('indexLoaded', this._onIndexLoaded);
        }
        eventBus.$on('tuneIndexError', this._onIndexError);
        eventBus.$on('indexStatusChanged', this._onIndexStatus);
        eventBus.$on('searchError', this._onSearchError);
        eventBus.$on('setSearchState', this._onSetSearchState);

        if (store.isListening()) {
            this._startPulse();
        }
    },
    beforeDestroy() {
        this._destroyed = true;
        eventBus.$off('indexLoaded', this._onIndexLoaded);
        eventBus.$off('tuneIndexError', this._onIndexError);
        eventBus.$off('indexStatusChanged', this._onIndexStatus);
        eventBus.$off('searchError', this._onSearchError);
        eventBus.$off('setSearchState', this._onSetSearchState);
    },
    methods: {
        _startPulse() {
            if (this._pulseRunning) return;
            this._pulseRunning = true;
            const pulse = () => {
                if (!store.isListening()) {
                    this._pulseRunning = false;
                    return;
                }
                this.analyzeScale = 0.85 + 0.15 * Math.random();
                window.requestAnimationFrame(pulse);
            };
            window.requestAnimationFrame(pulse);
        },
        async toggleMonitor() {
            if (store.isListening()) {
                await micService.stopContinuous();
            } else {
                await micService.startContinuous();
            }
        },
        async analyze() {
            if (!store.isListening()) return;
            const pcm = micService.getContinuousAudio();
            if (pcm.length === 0) {
                this.snackbar = true;
                this.snackbarText = 'No audio captured yet';
                return;
            }
            // analyzeRingBuffer sets state to WORKING then READY when done.
            // We re-enter LISTENING after WORKING completes, but only if we're still on this view.
            const restoreListening = () => {
                if (store.isReady()) {
                    eventBus.$off('setSearchState', restoreListening);
                    if (!this._destroyed) {
                        store.setSearchState(store.searchStates.LISTENING);
                    }
                }
            };
            eventBus.$on('setSearchState', restoreListening);
            await ffBackend.analyzeRingBuffer(pcm);
        },
        nameQuery() {
            if(this.textQuery.length < 2) {
                this.snackbar = true;
                this.snackbarText = 'Search query too short';
                return;
            }

            ffBackend.runNameQuery(this.textQuery).then((results) => {
                store.state.lastResults = results;
                this.$router.push({ name: 'results' });
                eventBus.$emit('childViewActivated');
            });
        },
        placeholderMethod() {
            console.debug('placeholder action');
        },
        advancedMode(mode) {
            store.userSettings.advancedMode = mode;
        },
        async audioFileChanged(e) {
            try {
                store.setSearchState(store.searchStates.WORKING);
    
                // Uploaded audio isn't a mic recording — clear any retained mic
                // PCM so the Results "save clip" button can't export a stale one.
                store.state.lastRecordedPcm = null;
                console.time('file-upload');
                const file = e.target.files[0];
                const url = URL.createObjectURL(file);
                const audioData = await audioService.urlToTimeDomainData(url);
                console.timeEnd('file-upload');
                
                console.time('feed-pcm-signal');
                await ffBackend.feedEntirePCMSignal(audioData);
                console.timeEnd('feed-pcm-signal');
                
                await ffBackend.submitFilledBuffer();
            } catch(e) {
                console.error(e);
            } finally {
                store.setSearchState(store.searchStates.READY);
            }
        },
    },
};
</script>

<style scoped>
.tuneProgress {
    max-width: 50%;
    opacity: 1;
}

.Transparent {
    opacity: 0;
}

.indexErrorMsg {
    text-align: center;
    color: #c62828;
    font-size: 0.9em;
    margin: 4px 0 0;
}

.noFlexGrow {
    flex-grow: 0;
}

.monitor-row {
    margin-top: 8px;
    margin-bottom: 0;
    min-height: 36px;
}

.analyze-circle {
    cursor: pointer;
    display: block;
}

.analyze-svg {
    display: block;
    max-width: min(35vh, 45vw);
    user-select: none;
}

.analyze-ring {
    stroke: var(--v-secondary-base);
    fill: white;
    stroke-width: 1px;
    transform-origin: 12px 12px;
    transition: transform 200ms ease-out;
}

.analyze-ring--active {
    transform: scale(var(--analyze-scale));
}

.analyze-circle:active .analyze-ring {
    fill: #f5f5f5;
}

.analyze-icon {
    stroke: var(--v-secondary-base);
}

.analyze-spin {
    transform-origin: 12px 12px;
    animation: spin-once 1s linear infinite;
}

@keyframes spin-once {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
}
</style>
