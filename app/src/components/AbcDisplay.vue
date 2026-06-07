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
            class="py-2"
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
                :color="looping ? 'primary' : ''"
                :title="looping ? 'Loop on' : 'Loop off'"
                @click="looping = !looping"
            >
                <v-icon>{{ icons.repeat }}</v-icon>
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
        </v-row>
        <v-row
            justify="center"
            align="center"
            class="pb-2 px-6 tempoRow"
        >
            <v-icon
                small
                class="mr-2"
            >
                {{ icons.metronome }}
            </v-icon>
            <v-slider
                v-model="tempoPercent"
                min="25"
                max="200"
                step="5"
                hide-details
                dense
                class="tempoSlider"
                @change="tempoChanged"
            />
            <span class="ml-2 tempoLabel">{{ tempoPercent }}%</span>
        </v-row>
    </v-card>
</template>

<script>
import { mdiArrowExpand, mdiMetronome, mdiPause, mdiPlay, mdiRepeat, mdiStop } from '@mdi/js';
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
            looping: false,

            icons: {
                fullscreen: mdiArrowExpand,
                metronome: mdiMetronome,
                pause: mdiPause,
                play: mdiPlay,
                repeat: mdiRepeat,
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

        this.abcVisual = ABCJS.renderAbc(svgDiv, this.abcText, { responsive: 'resize' })[0];
        this.$emit('abcRendered');

        eventBus.$on('stopSynthPlayback', () => {
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
                // Restore the onEnded handler that pause() cleared, so a
                // natural end still triggers a loop restart.
                this.midiBuffer.onEnded = () => this.handlePlaybackEnded();
                this.midiBuffer.resume();
            } else {
                this.paused = true;
                // ABCJS pause() fires onEnded — clear it so loop mode doesn't
                // restart playback when the user only wanted to pause.
                this.midiBuffer.onEnded = null;
                this.midiBuffer.pause();
            }
        },
        startPlaying: function () {
            this.paused = false;

            if (!ABCJS.synth.supportsAudio()) {
                console.error('ABCJS doesn\'t support audio synth');
                return;
            }

            // Can create an AudioContext here because we are inside the context of a button press
            window.AudioContext = window.AudioContext ||
                window.webkitAudioContext ||
                navigator.mozAudioContext ||
                navigator.msAudioContext;

            // Reuse a single AudioContext across plays — iOS disallows creating
            // multiple contexts, and the seamless tempo change below primes a
            // second synth on the same context.
            if (!this.audioContext) {
                this.audioContext = new window.AudioContext();
            }

            this.audioContext.resume().then(() => {
                // In theory the AC shouldn't start suspended because it is being initialized in a click handler, but iOS seems to anyway.

                // This does a bare minimum so this object could be created in advance, or whenever convenient.
                this.midiBuffer = new ABCJS.synth.CreateSynth();

                // Scale the measure duration by the tempo slider: 100% plays at
                // the tune's notated tempo, lower is slower, higher is faster.
                const millisecondsPerMeasure = this.abcVisual.millisecondsPerMeasure() * (100 / this.tempoPercent);

                // midiBuffer.init preloads and caches all the notes needed. There may be significant network traffic here.
                return this.midiBuffer.init({
                    visualObj: this.abcVisual,
                    audioContext: this.audioContext,
                    millisecondsPerMeasure,
                    // onEnded must be nested under options.options — ABCJS reads
                    // it as params = options.options and then params.onEnded.
                    options: {
                        onEnded: () => this.handlePlaybackEnded(),
                    },
                }).then(() => {
                    // midiBuffer.prime actually builds the output buffer.
                    return this.midiBuffer.prime();
                }).then(() => {
                    // At this point, everything slow has happened. midiBuffer.start will return very quickly and will start playing very quickly without lag.
                    this.midiBuffer.start();
                    return Promise.resolve();
                }).catch(error => {
                    console.error('AudioContext error', error);
                });
            });
        },
        tempoChanged: function () {
            // Nothing playing — the new tempo is picked up on the next play.
            if (this.paused || !this.midiBuffer) {
                return;
            }

            // Prime a fresh synth at the new tempo in the background while the
            // current one keeps playing, then swap them at the same musical
            // position so the tempo change is seamless (no audible gap).
            const millisecondsPerMeasure = this.abcVisual.millisecondsPerMeasure() * (100 / this.tempoPercent);
            const newBuffer = new ABCJS.synth.CreateSynth();
            newBuffer.init({
                visualObj: this.abcVisual,
                audioContext: this.audioContext,
                millisecondsPerMeasure,
                options: {
                    onEnded: () => this.handlePlaybackEnded(),
                },
            }).then(() => {
                return newBuffer.prime();
            }).then(() => {
                // pause() returns the elapsed playback time in seconds at the
                // OLD tempo. Convert it to beats so the new synth resumes at the
                // same place in the tune rather than the same wall-clock time.
                let positionBeats = 0;
                if (this.midiBuffer) {
                    this.midiBuffer.onEnded = null;
                    const positionSeconds = this.midiBuffer.pause();
                    const oldMsPerMeasure = this.midiBuffer.millisecondsPerMeasure;
                    const oldBeatsPerMeasure = this.midiBuffer.beatsPerMeasure;
                    if (positionSeconds && oldMsPerMeasure && oldBeatsPerMeasure) {
                        positionBeats = positionSeconds * 1000 * oldBeatsPerMeasure / oldMsPerMeasure;
                    }
                }
                this.midiBuffer = newBuffer;
                if (positionBeats) {
                    newBuffer.seek(positionBeats, 'beats');
                }
                newBuffer.start();
            }).catch(error => {
                console.error('Tempo change error', error);
            });
        },
        handlePlaybackEnded: function () {
            this.midiBuffer = null;
            if (this.looping) {
                this.startPlaying();
                return;
            }
            this.paused = true;
        },
        stopPlaying: function () {
            this.paused = true;
            if (this.midiBuffer) {
                // ABCJS stop() fires onEnded — clear it so loop mode doesn't
                // restart, and null the buffer ourselves.
                this.midiBuffer.onEnded = null;
                this.midiBuffer.stop();
                this.midiBuffer = null;
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

.tempoRow {
    max-width: 320px;
    margin-left: auto;
    margin-right: auto;
}

.tempoLabel {
    min-width: 3em;
    text-align: right;
    font-size: 0.85em;
}
</style>
