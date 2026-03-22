<template>
    <v-card elevation="0">
        <v-container
            v-if="showAbcText"
            class="ma-0 pa-0"
        >
            <span class="abcTextView mx-auto">{{ abcText }}</span>
        </v-container>
        <div
            :class="{ FullScreenAbcDisplay: fullscreen }"
            class="abcSheetMusic"
            @click="exitFullScreen"
        >
            <!-- Render ABC sheet music here -->
            <div />
        </div>
        <v-row
            wrap
            justify="center"
            align="center"
            class="py-2 px-2"
        >
            <v-btn
                class="mx-1 px-3 abcControls"
                @click="playButton"
            >
                <v-icon v-if="paused">
                    {{ icons.play }}
                </v-icon>
                <v-icon v-else>
                    {{ icons.pause }}
                </v-icon>
            </v-btn>
            <v-btn
                class="mx-1 px-3 abcControls"
                @click="stopPlaying"
            >
                <v-icon>{{ icons.stop }}</v-icon>
            </v-btn>
            <v-btn
                class="mx-1 px-3 abcControls"
                @click="goFullScreen"
            >
                <v-icon>{{ icons.fullscreen }}</v-icon>
            </v-btn>
            <div class="ml-auto d-flex align-center tempoControl">
                <v-icon small class="mr-1">{{ icons.metronome }}</v-icon>
                <v-slider
                    v-model="tempoPercent"
                    min="50"
                    max="200"
                    step="5"
                    hide-details
                    dense
                    style="width: 100px; min-width: 80px;"
                    @change="tempoChanged"
                />
                <span class="ml-1 tempoLabel">{{ tempoPercent }}%</span>
            </div>
        </v-row>
    </v-card>
</template>

<script>
import { mdiArrowExpand, mdiPause, mdiPlay, mdiStop, mdiMetronome } from '@mdi/js';
import store from '@/services/store.js';
import ABCJS from 'abcjs';
import eventBus from '@/eventBus';

export default {
    name: 'AbcDisplay',
    props: {
        abc: {
            type: String,
            required: true,
        },
        mode: {
            type: String,
            required: false,
            default: null
        },
        meter: {
            type: String,
            required: false,
            default: null
        },
    },
    data: function () {
        return {
            abcVisual: null,
            midiBuffer: null,
            audioContext: null,
            paused: true,
            fullscreen: false,
            tempoPercent: 100,

            icons: {
                fullscreen: mdiArrowExpand,
                metronome: mdiMetronome,
                pause: mdiPause,
                play: mdiPlay,
                stop: mdiStop,
            },
        };
    },
    computed: {
        abcText: function () {
            const abcLines = [];
            if (this.mode) {
                abcLines.push(`K:${this.mode}`);
            }
            if (this.meter) {
                abcLines.push(`M:${this.meter}`);
            }
            // Per ABC standard, L: (unit note length) defaults to 1/8 if absent.
            // Without it some renderers misinterpret note durations.
            if (!/^L:/m.test(this.abc)) {
                abcLines.push('L:1/8');
            }
            // Default tempo if none specified. ABCJS defaults to Q:1/4=180
            // which is too fast for most session tunes. 120 BPM is a comfortable
            // moderate tempo.
            if (!/^Q:/m.test(this.abc)) {
                abcLines.push('Q:1/4=120');
            }
            abcLines.push(this.abc);
            return abcLines.join('\n');
        },
        showAbcText: function () {
            return store.userSettings.showAbcText;
        },
    },
    mounted: async function () {
        const abcJsWrapperDiv = this.$el.childNodes[1];
        const svgDiv = abcJsWrapperDiv.firstChild;
        const midDiv = abcJsWrapperDiv.lastChild;

        this.abcVisual = ABCJS.renderAbc(svgDiv, this.abcText, { responsive: 'resize' })[0];
        this.$emit('abcRendered');

        eventBus.$on("stopSynthPlayback", () => {
            this.stopPlaying();
            delete this.midiBuffer;
        });
    },
    methods: {
        playButton: function() {
            if (!this.midiBuffer) {
                this.startPlaying();
            } else if(this.paused) {
                this.paused = false;
                this.midiBuffer.resume();
            } else {
                this.paused = true;
                this.midiBuffer.pause();
            }
        },
        startPlaying: function () {
            this.paused = false;

            if (!ABCJS.synth.supportsAudio()) {
                console.error("ABCJS doesn't support audio synth");
                return;
            }

            window.AudioContext = window.AudioContext || window.webkitAudioContext;

            // Reuse the AudioContext across plays — iOS does not allow multiple contexts
            if (!this.audioContext) {
                this.audioContext = new window.AudioContext();
            }

            this.audioContext.resume().then(() => {
                this.midiBuffer = new ABCJS.synth.CreateSynth();

                return this.midiBuffer.init({
                    visualObj: this.abcVisual,
                    audioContext: this.audioContext,
                    millisecondsPerMeasure: this.abcVisual.millisecondsPerMeasure() * (100 / this.tempoPercent),
                }).then(() => {
                    return this.midiBuffer.prime();
                }).then(() => {
                    return this.audioContext.resume();
                }).then(() => {
                    this.midiBuffer.start();
                    this.midiBuffer.onEnded = () => {
                        if (!this.paused) {
                            this.stopPlaying();
                        }
                    };
                }).catch(error => {
                    console.error('AudioContext error', error);
                });
            });
        },
        tempoChanged: function () {
            // Tempo is baked in at init() time — stop playback so the
            // user restarts at the new tempo.
            if (!this.paused) {
                this.stopPlaying();
                delete this.midiBuffer;
            }
        },
        stopPlaying: function () {
            this.paused = true;
            if (this.midiBuffer) {
                this.midiBuffer.stop();
                this.pause = false;
            }
        },
        goFullScreen: function () {
            this.$emit('abcGoFullScreen');
            this.fullscreen = true;
        },
        exitFullScreen: function () {
            this.$emit('abcExitFullScreen');
            this.fullscreen = false;
        },
    },
};
</script>

<style scoped>
.abcTextView {
    font-family: Courier, serif;
    white-space: pre-wrap;
    display: inline-block;
}

.FullScreenAbcDisplay {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: white;
    overflow-y: scroll;

    /* TODO z index flicker here isn't great */
    z-index: 10;
}

.FullScreenAbcDisplay > div {
    min-height: 100%;
}

.abcControls {
    min-width: 0 !important;
}


.tempoLabel {
    min-width: 3em;
    text-align: right;
    font-size: 0.85em;
}
</style>