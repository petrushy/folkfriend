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
        >
            <button v-if="fullscreen" class="exitFullScreenBtn" @click.stop="exitFullScreen">
                ✕
            </button>
            <h2 v-if="fullscreen && title" class="fullScreenTitle">
                {{ title }}
            </h2>
            <!-- Render ABC sheet music here -->
            <div ref="abcTarget" />
        </div>
        <!-- Controls bar — sibling of the full-screen div so fixed positioning works correctly -->
        <div v-if="!hideControls" :class="fullscreen ? 'fullScreenControls' : 'inlineControls'">
            <v-btn small class="mx-1 px-2 abcControls" @click="playButton">
                <v-icon small v-if="paused">{{ icons.play }}</v-icon>
                <v-icon small v-else>{{ icons.pause }}</v-icon>
            </v-btn>
            <v-btn
                small
                class="mx-1 px-2 abcControls"
                :color="looping ? 'primary' : ''"
                :title="looping ? 'Loop on' : 'Loop off'"
                @click="looping = !looping"
            >
                <v-icon small>{{ icons.repeat }}</v-icon>
            </v-btn>
            <v-btn small class="mx-1 px-2 abcControls" @click="stopPlaying">
                <v-icon small>{{ icons.stop }}</v-icon>
            </v-btn>
            <v-btn small class="mx-1 px-2 abcControls" @click="fullscreen ? exitFullScreen() : goFullScreen()">
                <v-icon small>{{ fullscreen ? icons.fullscreenExit : icons.fullscreen }}</v-icon>
            </v-btn>
            <div class="ml-auto d-flex align-center tempoControl">
                <v-icon small class="mr-1">{{ icons.metronome }}</v-icon>
                <v-slider
                    v-model="tempoPercent"
                    min="25"
                    max="200"
                    step="5"
                    hide-details
                    dense
                    style="width: 100px; min-width: 80px;"
                    @change="tempoChanged"
                />
                <span class="ml-1 tempoLabel">{{ tempoPercent }}%</span>
            </div>
        </div>
    </v-card>
</template>

<script>
import { mdiArrowExpand, mdiArrowCollapse, mdiPause, mdiPlay, mdiStop, mdiMetronome, mdiRepeat } from '@mdi/js';
import store from '@/services/store.js';
import ABCJS from 'abcjs';
import eventBus from '@/eventBus';

// How far ahead of the audio (in ms) the score highlight is shown. A small
// lead makes the highlight feel like it anticipates the note rather than
// reacting to it, which is easier to follow when reading along.
const HIGHLIGHT_LEAD_MS = 100;

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
        title: {
            type: String,
            required: false,
            default: null
        },
        settingID: {
            type: Number,
            required: false,
            default: null,
        },
        // Render notation only. Used by the live-follow overlay, where synth
        // playback would feed straight back into the listening microphone.
        hideControls: {
            type: Boolean,
            required: false,
            default: false,
        },
    },
    data: function () {
        return {
            abcVisual: null,
            midiBuffer: null,
            playbackTimer: null,
            playbackSyncFrame: null,
            audioContext: null,
            paused: true,
            fullscreen: false,
            tempoPercent: 100,
            looping: false,
            highlightedNoteEls: [],

            icons: {
                fullscreen: mdiArrowExpand,
                fullscreenExit: mdiArrowCollapse,
                metronome: mdiMetronome,
                pause: mdiPause,
                play: mdiPlay,
                stop: mdiStop,
                repeat: mdiRepeat,
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
            // PIN THE PULSE TO THE QUARTER NOTE.
            //
            // ABCJS's default tempo is counted in the METER'S OWN beat unit, so
            // identical notes play at different speeds depending only on how
            // the meter is written. Cut time is the case that bites: C| counts
            // half notes, so a reel written M:C| plays at exactly double the
            // speed of the same reel written M:4/4 — 667 ms/bar against 1333.
            //
            // thesession writes reels as 4/4 and Norbeck writes 1,487 of them
            // as C|, which is why Norbeck tunes sounded frantic while the same
            // tune from thesession sounded right.
            //
            // Naming an absolute note value takes the meter out of it. 180 is
            // chosen to reproduce exactly what 4/4 already does, so every meter
            // that sounded right before is untouched (4/4, C, 6/8, 9/8, 12/8,
            // 3/4, 2/4); only C|, 2/2, 6/4, 3/8 and the additive Balkan meters
            // move, and all of those were wrong.
            if (!/^Q:/m.test(this.abc)) {
                // Polkas are the one meter that needs a slower pulse than the
                // default; ABCJS's own is too fast for them.
                const isPolka = this.meter === '2/4' || /^M:2\/4/m.test(this.abc);
                abcLines.push(`Q:1/4=${isPolka ? 120 : 180}`);
            }
            abcLines.push(this.abc);
            return abcLines.join('\n');
        },
        showAbcText: function () {
            return store.userSettings.showAbcText;
        },
    },
    mounted: async function () {
        if (this.settingID != null) {
            const saved = await store.getFavouriteTempo(this.settingID);
            if (saved != null) this.tempoPercent = saved;
        }

        this._onKeyDown = (e) => {
            if (e.key === 'Escape' && this.fullscreen) {
                this.exitFullScreen();
            }
        };
        document.addEventListener('keydown', this._onKeyDown);

        const svgDiv = this.$refs.abcTarget;

        this.abcVisual = ABCJS.renderAbc(svgDiv, this.abcText, { responsive: 'resize' })[0];
        this.$emit('abcRendered');

        this._onStopSynthPlayback = () => {
            this.stopPlaying();
            delete this.midiBuffer;
        };
        eventBus.$on('stopSynthPlayback', this._onStopSynthPlayback);
    },
    beforeDestroy() {
        document.removeEventListener('keydown', this._onKeyDown);
        eventBus.$off('stopSynthPlayback', this._onStopSynthPlayback);
        this.stopPlaying();
        this._clearHighlightedNotes();
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    },
    methods: {
        _msPerMeasureToQpm(millisecondsPerMeasure) {
            if (!this.abcVisual || !millisecondsPerMeasure) return null;
            return this.abcVisual.getBeatsPerMeasure() / millisecondsPerMeasure * 60000;
        },
        _clearHighlightedNotes() {
            this.highlightedNoteEls.forEach(el => el.classList.remove('abcjs-current-note'));
            this.highlightedNoteEls = [];
        },
        _highlightTimingEvent(event) {
            this._clearHighlightedNotes();
            if (!event || !event.elements || !event.midiPitches || event.midiPitches.length === 0) return;

            const noteEls = event.elements
                .flat()
                .filter(el => el && el.classList);

            noteEls.forEach(el => el.classList.add('abcjs-current-note'));
            this.highlightedNoteEls = noteEls;
        },
        _createPlaybackTimer(millisecondsPerMeasure) {
            const qpm = this._msPerMeasureToQpm(millisecondsPerMeasure);
            // eventCallback intentionally omitted: ABCJS's setProgress() path
            // fires it with the NEXT upcoming event rather than the current
            // one, which causes the highlight to lead the audio by ~one note.
            // We drive the highlight ourselves from _syncPlaybackTimerToAudio.
            return new ABCJS.TimingCallbacks(this.abcVisual, { qpm });
        },
        _findActiveNoteEvent(currentTimeMs) {
            const timings = this.playbackTimer && this.playbackTimer.noteTimings;
            if (!timings || timings.length === 0) return null;
            let active = null;
            for (let i = 0; i < timings.length; i++) {
                if (timings[i].milliseconds > currentTimeMs) break;
                if (timings[i].type === 'event') active = timings[i];
            }
            return active;
        },
        _audioElapsedSeconds() {
            if (
                !this.audioContext ||
                !this.midiBuffer ||
                typeof this.midiBuffer.startTimeSec !== 'number'
            ) {
                return null;
            }
            // outputLatency: seconds between scheduling a sample and it
            // reaching the speakers. Subtracting it makes the highlight
            // track what is HEARD rather than what is SCHEDULED. baseLatency
            // is the fallback for browsers where outputLatency reports 0.
            const latency = this.audioContext.outputLatency
                || this.audioContext.baseLatency
                || 0;
            return Math.max(0, this.audioContext.currentTime - this.midiBuffer.startTimeSec - latency);
        },
        _syncPlaybackTimerToAudio() {
            if (!this.playbackTimer || !this.midiBuffer || this.paused || !this.audioContext) {
                this.playbackSyncFrame = null;
                return;
            }

            const elapsedSec = this._audioElapsedSeconds();
            if (elapsedSec !== null) {
                const activeEvent = this._findActiveNoteEvent(elapsedSec * 1000 + HIGHLIGHT_LEAD_MS);
                if (activeEvent !== this._activeHighlightEvent) {
                    this._activeHighlightEvent = activeEvent;
                    this._highlightTimingEvent(activeEvent);
                }
            }

            this.playbackSyncFrame = window.requestAnimationFrame(() => this._syncPlaybackTimerToAudio());
        },
        _startPlaybackSyncLoop() {
            if (this.playbackSyncFrame !== null) {
                window.cancelAnimationFrame(this.playbackSyncFrame);
            }
            this.playbackSyncFrame = window.requestAnimationFrame(() => this._syncPlaybackTimerToAudio());
        },
        _stopPlaybackSyncLoop() {
            if (this.playbackSyncFrame !== null) {
                window.cancelAnimationFrame(this.playbackSyncFrame);
                this.playbackSyncFrame = null;
            }
        },
        _startPlaybackTimer(millisecondsPerMeasure, offset, units) {
            this._stopPlaybackSyncLoop();
            if (this.playbackTimer) {
                this.playbackTimer.stop();
            }
            this.playbackTimer = this._createPlaybackTimer(millisecondsPerMeasure);
            if (offset !== undefined) {
                this.playbackTimer.setProgress(offset, units);
            } else {
                this.playbackTimer.setProgress(0, 'seconds');
            }
            this._activeHighlightEvent = null;
            this._startPlaybackSyncLoop();
        },
        _pausePlaybackTimer() {
            this._stopPlaybackSyncLoop();
            if (this.playbackTimer) {
                const elapsedSec = this._audioElapsedSeconds();
                if (elapsedSec !== null) {
                    this.playbackTimer.setProgress(elapsedSec, 'seconds');
                }
            }
        },
        _resumePlaybackTimer() {
            this._startPlaybackSyncLoop();
        },
        _stopPlaybackTimer() {
            this._stopPlaybackSyncLoop();
            if (this.playbackTimer) {
                this.playbackTimer.stop();
                this.playbackTimer = null;
            }
            this._activeHighlightEvent = null;
            this._clearHighlightedNotes();
        },
        _handlePlaybackEnded() {
            this.midiBuffer = null;
            this._stopPlaybackTimer();
            if (this.looping) {
                this.startPlaying();
                return;
            }
            this.paused = true;
            this.$forceUpdate();
        },
        playButton: function() {
            if (!this.midiBuffer) {
                this.startPlaying();
            } else if(this.paused) {
                this.paused = false;
                // Restore onEnded that pause cleared so natural-end loop restart works.
                this.midiBuffer.onEnded = () => this._handlePlaybackEnded();
                this._resumePlaybackTimer();
                this.midiBuffer.resume();
            } else {
                this.paused = true;
                // ABCJS fires the source end-callback when pause() stops audio,
                // and it calls onEnded() unconditionally — use a no-op (not null,
                // which would throw) so loop mode doesn't restart on a pause.
                this.midiBuffer.onEnded = () => {};
                this.midiBuffer.pause();
                this._pausePlaybackTimer();
            }
        },
        startPlaying: function () {
            eventBus.$emit('stopSynthPlayback');
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
                const millisecondsPerMeasure = this.abcVisual.millisecondsPerMeasure() * (100 / this.tempoPercent);

                return this.midiBuffer.init({
                    visualObj: this.abcVisual,
                    audioContext: this.audioContext,
                    millisecondsPerMeasure,
                    // onEnded must be nested under options.options — ABCJS reads it as
                    // params = options.options and then params.onEnded.
                    // soundFontUrl points to the locally bundled FluidR3_GM subset;
                    // soundFontVolumeMultiplier must be set explicitly because ABCJS
                    // only auto-applies 3.0 for the known remote CDN URL.
                    options: {
                        onEnded: () => this._handlePlaybackEnded(),
                        soundFontUrl: '/soundfont/',
                        soundFontVolumeMultiplier: 3.0,
                    },
                }).then(() => {
                    return this.midiBuffer.prime();
                }).then(() => {
                    return this.audioContext.resume();
                }).then(() => {
                    this._startPlaybackTimer(millisecondsPerMeasure);
                    this.midiBuffer.start();
                }).catch(error => {
                    console.error('AudioContext error', error);
                });
            });
        },
        tempoChanged: function () {
            if (this.settingID != null) {
                store.setFavouriteTempo(this.settingID, this.tempoPercent);
            }
            // If not playing, nothing to do — new tempo will be used on next play.
            if (this.paused || !this.midiBuffer) return;

            // Prime a NEW synth instance in the background while the current one
            // keeps playing. When ready, get the current position, stop the old
            // one, seek the new one to that position, and start it.
            const msPerMeasure = this.abcVisual.millisecondsPerMeasure() * (100 / this.tempoPercent);
            const onEnded = () => this._handlePlaybackEnded();
            const newBuffer = new ABCJS.synth.CreateSynth();
            newBuffer.init({
                visualObj: this.abcVisual,
                audioContext: this.audioContext,
                millisecondsPerMeasure: msPerMeasure,
                options: { onEnded, soundFontUrl: '/soundfont/', soundFontVolumeMultiplier: 3.0 },
            }).then(() => {
                return newBuffer.prime();
            }).then(() => {
                // pause() returns elapsed playback time in seconds at the OLD
                // tempo. To preserve musical position after changing tempo, we
                // convert that elapsed time to beats and seek the new synth by
                // beats instead of raw seconds.
                let positionBeats = 0;
                if (this.midiBuffer) {
                    // No-op rather than null: pause() triggers the old synth's
                    // end-callback, which calls onEnded() unconditionally.
                    this.midiBuffer.onEnded = () => {};
                    const positionSeconds = this.midiBuffer.pause();
                    const oldMsPerMeasure = this.midiBuffer.millisecondsPerMeasure;
                    const oldBeatsPerMeasure = this.midiBuffer.beatsPerMeasure;
                    if (positionSeconds && oldMsPerMeasure && oldBeatsPerMeasure) {
                        positionBeats = positionSeconds * 1000 * oldBeatsPerMeasure / oldMsPerMeasure;
                    }
                }
                this.midiBuffer = newBuffer;
                if (positionBeats) newBuffer.seek(positionBeats, 'beats');
                this._startPlaybackTimer(msPerMeasure, positionBeats, 'beats');
                newBuffer.start();
            }).catch(error => {
                console.error('Tempo change error', error);
            });
        },
        stopPlaying: function () {
            this.paused = true;
            this._stopPlaybackTimer();
            if (this.midiBuffer) {
                // ABCJS stop() fires the source end-callback, which calls
                // onEnded() unconditionally — use a no-op (not null, which would
                // throw) so loop mode doesn't restart, and null midiBuffer
                // manually since the handler would normally do it.
                this.midiBuffer.onEnded = () => {};
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

.fullScreenTitle {
    padding: max(16px, env(safe-area-inset-top, 16px)) 64px 4px 20px;
    font-size: 1.25rem;
    font-weight: 500;
    color: #1a1a1a;
}

.inlineControls {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    padding: 8px;
}

.fullScreenControls {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    padding: 8px max(12px, env(safe-area-inset-right, 12px)) max(8px, env(safe-area-inset-bottom, 8px)) max(12px, env(safe-area-inset-left, 12px));
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: blur(6px);
    z-index: 11;
    border-top: 1px solid rgba(0, 0, 0, 0.08);
}

.exitFullScreenBtn {
    position: fixed;
    top: max(12px, env(safe-area-inset-top, 12px));
    right: max(12px, env(safe-area-inset-right, 12px));
    z-index: 11;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: none;
    background: rgba(0, 0, 0, 0.55);
    color: white;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
}

:deep(.abcjs-current-note .abcjs-notehead) {
    fill: #d32f2f;
    stroke: #d32f2f;
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
