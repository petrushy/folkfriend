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

        <v-row justify="center" class="monitor-row px-4">
            <v-btn
                small
                text
                :color="searchState === 'listening' || searchState === 'working' ? 'green' : 'grey darken-1'"
                :disabled="searchState === 'recording' || searchState === 'working'"
                @click="toggleMonitor"
            >
                <v-icon left small>{{ searchState === 'listening' || searchState === 'working' ? icons.microphoneOff : icons.microphone }}</v-icon>
                {{ searchState === 'listening' || searchState === 'working' ? 'Stop monitoring' : 'Continuously monitor' }}
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
            <v-progress-linear
                :class="{ Transparent: indexLoaded }"
                indeterminate
                rounded
            />
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
import ffBackend from '@/services/backend';
import audioService from '@/services/audio';
import store from '@/services/store';
import eventBus from '@/eventBus';
import { mdiMagnify, mdiMicrophone, mdiMicrophoneOff, mdiWaveform } from '@mdi/js';
import micService from '@/services/mic';

export default {
    name: 'SearchView',
    components: {
        RecorderButton,
    },
    data: function () {
        return {
            snackbar: null,
            snackbarText: null,

            textQuery: '',
            offlineButton: true,
            indexLoaded: store.state.indexLoaded,
            searchState: store.searchState,
            analyzeScale: 1.0,

            icons: {
                magnify: mdiMagnify,
                microphone: mdiMicrophone,
                microphoneOff: mdiMicrophoneOff,
                waveform: mdiWaveform,
            },
        };
    },
    created: function () {
        eventBus.$emit('parentViewActivated');

        if(!this.indexLoaded) {
            eventBus.$on('indexLoaded', () => {
                this.indexLoaded = true;
            });
        }

        eventBus.$on('searchError', (errorMsg) => {
            this.snackbar = true;
            this.snackbarText = errorMsg || 'An error ocurred 😟';
        });

        eventBus.$on('setSearchState', () => {
            this.searchState = store.searchState;
            if (store.isListening()) {
                this._startPulse();
            }
        });

        if (store.isListening()) {
            this._startPulse();
        }
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
            // We re-enter LISTENING after WORKING completes (i.e. when state becomes READY).
            const restoreListening = () => {
                if (store.isReady()) {
                    eventBus.$off('setSearchState', restoreListening);
                    store.setSearchState(store.searchStates.LISTENING);
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
