<template>
    <div class="set-score-view">
        <div class="set-follow-bar pa-2 mb-3">
            <div
                class="d-flex flex-wrap align-center"
                style="gap:8px"
            >
                <v-btn
                    v-if="!midiActive"
                    color="primary"
                    :disabled="!set.entries.length || starting"
                    @click="playSet"
                >
                    Play set
                </v-btn>
                <template v-else>
                    <v-btn
                        outlined
                        :disabled="midiStatus === 'preparing'"
                        @click="toggleMidiPause"
                    >
                        {{ midiStatus === 'paused' ? 'Resume set' : 'Pause set' }}
                    </v-btn>
                    <v-btn
                        text
                        @click="stopSetPlayback"
                    >
                        Stop set
                    </v-btn>
                </template>
                <v-text-field
                    v-model.number="midiTempo"
                    label="Playback speed (%)"
                    type="number"
                    min="25"
                    max="200"
                    step="5"
                    dense
                    hide-details
                    :disabled="midiActive"
                    style="max-width:145px"
                />
                <v-btn
                    outlined
                    :color="running ? 'primary' : ''"
                    :loading="starting"
                    :aria-pressed="String(running)"
                    :disabled="!set.entries.length"
                    @click="running ? stopFollow() : startFollow(0)"
                >
                    <v-icon
                        small
                        left
                    >
                        {{ icon }}
                    </v-icon>{{ running ? 'Stop following' : 'Follow my playing' }}
                </v-btn>
                <template v-if="performanceActive">
                    <v-switch
                        v-model="autoScroll"
                        label="Auto-scroll"
                        dense
                        hide-details
                        class="mt-0 pt-0"
                    />
                    <v-btn
                        small
                        text
                        :disabled="midiActive || activeIndex >= set.entries.length - 1"
                        @click="selectEntry(activeIndex + 1)"
                    >
                        Next tune
                    </v-btn>
                    <v-btn
                        v-if="held"
                        small
                        text
                        @click="resumeScroll"
                    >
                        Resume scrolling
                    </v-btn>
                </template>
            </div>
            <p
                v-if="midiActive"
                class="score-meta mb-0 mt-2"
                aria-live="polite"
            >
                {{ midiStatus === 'preparing' ? 'Preparing audio…' : midiStatus === 'paused' ? 'Paused' : 'Playing' }} · Tune {{ midiIndex + 1 }}/{{ set.entries.length }} · {{ title(set.entries[midiIndex].result.displayName) }} · {{ midiRepetition }}/{{ repetitions(set.entries[midiIndex]) }}
            </p>
            <p
                v-else-if="running"
                class="score-meta mb-0 mt-2"
                aria-live="polite"
            >
                Tune {{ activeIndex + 1 }}/{{ set.entries.length }} · {{ title(set.entries[activeIndex].result.displayName) }} · {{ held ? 'Scrolling paused while you browse' : readout || 'Listening…' }}
            </p>
            <p
                v-else
                class="score-meta mb-0 mt-2"
            >
                Follow listens across all tunes in this set and keeps the matching score row in view.
            </p>
            <v-alert
                v-if="error"
                dense
                type="error"
                class="mt-2 mb-0"
            >
                {{ error }}
            </v-alert>
        </div>
        <div
            v-for="(entry, i) in set.entries"
            :key="entry.id"
            :ref="'entry-' + entry.id"
            class="set-score mb-6"
            :class="{ 'set-score-active': performanceActive && activeIndex === i }"
        >
            <div class="d-flex flex-wrap align-center">
                <router-link
                    class="set-tune-title flex-grow-1"
                    :to="{ name: 'tune', query: { tuneID: String(entry.result.setting.tune_id), settingID: String(entry.result.settingID), displayName: entry.result.displayName } }"
                >
                    {{ i + 1 }}. {{ title(entry.result.displayName) }}
                </router-link>
            </div>
            <p class="score-meta mb-2">
                {{ key(entry.result.setting.mode) }} · {{ type(entry.result.setting.dance) }} · {{ repetitions(entry) }}×
            </p>
            <AbcDisplay
                :ref="'score-' + entry.id"
                :abc="entry.result.setting.abc"
                :title="entry.result.displayName"
                :mode="entry.result.setting.mode"
                :meter="entry.result.setting.meter"
                :instrument-shift="instrumentShift"
                hide-score-title
                :hide-controls="performanceActive"
                :follow-line="performanceActive && activeIndex === i ? line : null"
                :follow-auto-scroll="performanceActive && autoScroll && !held"
                @abcRendered="updateFollow()"
            />
        </div>
    </div>
</template>
<script>
import { mdiCrosshairsGps } from '@mdi/js';
import AbcDisplay from '@/components/AbcDisplay';
import practiceFollow from '@/services/practiceFollow.js';
import eventBus from '@/eventBus';
import { SetMidiPlayer, repetitionsFor } from '@/js/setMidiPlayer.mjs';
import { SetScoreFollower } from '@/js/setScoreFollower.mjs';
import { MIN_QUERY_LENGTH } from '@/js/scorePosition.mjs';
import { keyLabel, typeLabel } from '@/js/favouriteFacets.mjs';
import utils from '@/js/utils.js';

const MANUAL_HOLD_MS = 8000;
export default {
    name: 'SetScoreView',
    components: { AbcDisplay },
    props: { set: { type: Object, required: true }, instrumentShift: { type: Number, default: 0 } },
    data: () => ({ midiStatus: 'idle', midiIndex: 0, midiRepetition: 1, midiTempo: 100, running: false, starting: false, activeIndex: 0, line: null, readout: '', autoScroll: true, held: false, error: '', icon: mdiCrosshairsGps }),
    computed: {
        midiActive() { return ['preparing', 'playing', 'paused'].includes(this.midiStatus); },
        performanceActive() { return this.running || this.midiActive; },
        scoreSignature() { return JSON.stringify([this.set.id, this.set.entries]); },
    },
    watch: {
        scoreSignature() { this.stopSetPlayback(); this.stopFollow(); this.activeIndex = 0; },
        autoScroll(on) { if (on) this.resumeScroll(); },
    },
    created() {
        this._position = () => this.updateFollow();
        this._state = state => {
            if (this.running && !this.starting && (!state.active || state.settingId !== this._owner)) this.clearLocal();
        };
        this._stopSynth = () => this.stopSetPlayback();
        eventBus.$on('stopSynthPlayback', this._stopSynth);
        eventBus.$on('practiceFollowPosition', this._position);
        eventBus.$on('practiceFollowState', this._state);
    },
    beforeDestroy() {
        this._destroyed = true;
        this.stopSetPlayback();
        eventBus.$off('stopSynthPlayback', this._stopSynth);
        if (this._midiContext) this._midiContext.close().catch(() => {});
        this.stopFollow();
        eventBus.$off('practiceFollowPosition', this._position);
        eventBus.$off('practiceFollowState', this._state);
    },
    methods: {
        repetitions: repetitionsFor,
        async playSet() {
            if (this.midiActive) return;
            this.error = '';
            if (!Number.isFinite(this.midiTempo) || this.midiTempo < 25 || this.midiTempo > 200) { this.error = 'Playback speed must be between 25% and 200%.'; return; }
            try { this.set.entries.forEach(repetitionsFor); }
            catch (e) { this.error = e.message; return; }
            // Create/resume in the button gesture, before any asynchronous work.
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) { this.error = 'This browser does not support audio playback.'; return; }
            this.stopSetPlayback();
            eventBus.$emit('stopSynthPlayback');
            const request = (this._midiRequest || 0) + 1;
            this._midiRequest = request; this._midiStarting = true;
            this.midiStatus = 'preparing'; this.midiIndex = 0; this.midiRepetition = 1;
            try {
                if (!this._midiContext || this._midiContext.state === 'closed') this._midiContext = new AudioContextClass();
                const resumed = this._midiContext.resume();
                await this.stopFollow();
                await resumed;
                if (this._destroyed || request !== this._midiRequest) return;
                const context = this._midiContext;
                const tempo = this.midiTempo;
                this._midiPlayer = new SetMidiPlayer({ entries: this.set.entries,
                                                       prepare: async index => {
                                                           const ref = this.$refs['score-' + this.set.entries[index].id];
                                                           const display = Array.isArray(ref) ? ref[0] : ref;
                                                           if (!display) throw new Error('The score is not ready to play.');
                                                           return display.prepareSetPlayback(context, tempo);
                                                       },
                                                       onState: state => {
                                                           this.midiStatus = state.status; this.midiIndex = state.index; this.midiRepetition = state.repetition;
                                                           this.line = null;
                                                           if (state.error) this.error = state.error;
                                                           if (state.index < this.set.entries.length) this.activeIndex = state.index;
                                                           if (state.status === 'playing') {
                                                               this.revealEntry();
                                                               // Drives note highlighting and the line band from the audio clock.
                                                               if (!this._midiFrame) this._midiFrame = requestAnimationFrame(() => this.midiTick());
                                                           }
                                                           if (!['preparing', 'playing', 'paused'].includes(state.status)) {
                                                               this.clearMidiFrame();
                                                               // Finished or failed on its own: nothing left to hold scrolling for.
                                                               this.releaseManualScroll();
                                                           }
                                                       },
                });
                await this._midiPlayer.start();
                if (request !== this._midiRequest || this._destroyed || !this.midiActive) return;
                this._manual = () => this.onManualScroll();
                window.addEventListener('wheel', this._manual, { passive: true });
                window.addEventListener('touchstart', this._manual, { passive: true });
            } catch (e) { if (request === this._midiRequest) { this.stopSetPlayback(); if (!this._destroyed) this.error = `Could not play the set: ${e.message || 'audio playback failed'}`; } }
            finally { if (request === this._midiRequest) this._midiStarting = false; }
        },
        midiTick() {
            this._midiFrame = null;
            if (this.midiStatus !== 'playing') return;
            const progress = this._midiPlayer?.progress();
            if (progress) this.line = progress.line;
            this._midiFrame = requestAnimationFrame(() => this.midiTick());
        },
        clearMidiFrame() {
            if (this._midiFrame) cancelAnimationFrame(this._midiFrame);
            this._midiFrame = null;
        },
        toggleMidiPause() {
            if (!this._midiPlayer) return;
            if (this.midiStatus === 'paused') this._midiPlayer.resume(); else this._midiPlayer.pause();
        },
        stopSetPlayback() {
            this._midiRequest = (this._midiRequest || 0) + 1;
            this._midiPlayer?.stop(); this._midiPlayer = null;
            this.clearMidiFrame(); this.midiStatus = 'idle'; this.line = null;
            this.releaseManualScroll();
        },
        releaseManualScroll() {
            clearTimeout(this._holdTimer); this.held = false;
            if (!this.running && this._manual) { window.removeEventListener('wheel', this._manual); window.removeEventListener('touchstart', this._manual); this._manual = null; }
        },
        title: value => utils.parseDisplayableName(value || ''),
        key: value => value ? keyLabel(value) : 'Key unknown',
        type: value => value ? typeLabel(value) : 'Type unknown',
        followable(entry) { return typeof entry?.result?.setting?.contour === 'string' && entry.result.setting.contour.length >= MIN_QUERY_LENGTH; },
        async startFollow(index) {
            if (this.starting) return;
            if (!this.followable(this.set.entries[index])) index = this.set.entries.findIndex(entry => this.followable(entry));
            if (index < 0) { this.error = 'No listening contours are saved in this set. Add the tune settings again to enable Follow.'; return; }
            this.stopSetPlayback();
            await this.stopFollow();
            if (this._destroyed) return;
            eventBus.$emit('stopSynthPlayback');
            this.error = ''; this.running = true; this.starting = true;
            const owner = 'set:' + globalThis.crypto.randomUUID();
            this._owner = owner;
            this._engine = new SetScoreFollower(this.set.entries.map(e => ({ id: e.id, contour: e.result.setting.contour })));
            this._engine.select(index);
            this.activeIndex = index;
            try {
                this._startTask = practiceFollow.start(owner);
                await this._startTask;
                if (!this.running || this._destroyed || practiceFollow.settingId !== owner) { this.clearLocal(); return; }
                this._timer = setInterval(() => this.updateFollow(), 1000);
                this._manual = () => this.onManualScroll();
                window.addEventListener('wheel', this._manual, { passive: true });
                window.addEventListener('touchstart', this._manual, { passive: true });
                this.revealEntry();
            } catch (e) {
                if (!this._destroyed) this.error = `Could not listen: ${e.message || 'the microphone could not be opened'}`;
                this.clearLocal();
            } finally {
                this.starting = false;
                if ((!this.running || this._destroyed) && practiceFollow.settingId === owner) await practiceFollow.stop();
            }
        },
        clearLocal() {
            clearInterval(this._timer); clearTimeout(this._holdTimer);
            if (this._manual) { window.removeEventListener('wheel', this._manual); window.removeEventListener('touchstart', this._manual); }
            this._manual = null; this._engine = null; this.running = false; this.line = null; this.readout = ''; this.held = false;
        },
        async stopFollow() {
            const owner = this._owner;
            const task = this._startTask;
            this.clearLocal();
            if (task) { try { await task; } catch (_) { /* reported by start */ } }
            if (owner && practiceFollow.settingId === owner) await practiceFollow.stop();
        },
        selectEntry(index) {
            if (!this._engine || !this._engine.select(index, practiceFollow.position?.readAt)) return;
            this.activeIndex = index; this.line = null; this.readout = ''; this.resumeScroll();
        },
        updateFollow(position = practiceFollow.position, nowMs = Date.now()) {
            if (!this.running || !this._engine) return;
            const result = this._engine.update({ position, nowMs, timeline: index => {
                const ref = this.$refs['score-' + this.set.entries[index].id];
                const display = Array.isArray(ref) ? ref[0] : ref;
                return display?.followTimeline() || null;
            } });
            this.activeIndex = result.index; this.line = result.line; this.readout = result.readout;
            if (result.changed) this.revealEntry();
        },
        onManualScroll() {
            this.held = true; clearTimeout(this._holdTimer);
            this._holdTimer = setTimeout(() => this.resumeScroll(), MANUAL_HOLD_MS);
        },
        resumeScroll() {
            clearTimeout(this._holdTimer); this.held = false;
            this.$nextTick(() => { if (this.line === null) this.revealEntry(); });
        },
        revealEntry() {
            if (!this.performanceActive || !this.autoScroll || this.held) return;
            this.$nextTick(() => {
                if (!this.performanceActive || !this.autoScroll || this.held) return;
                const ref = this.$refs['entry-' + this.set.entries[this.activeIndex].id];
                const element = Array.isArray(ref) ? ref[0] : ref;
                element?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            });
        },
    },
};
</script>
<style scoped>
.set-follow-bar { position: sticky; top: 64px; z-index: 4; background: #f8fafb; border: 1px solid #dce3e7; border-radius: 6px; }
.set-score { scroll-margin-top: 210px; padding-top: 16px; border-top: 1px solid #eceff1; }
.score-meta { font-size: .875rem; line-height: 1.5; color: #616161; }
.set-tune-title { font-size: 1.125rem; font-weight: 600; line-height: 1.4; color: inherit; text-decoration: none; }
.set-tune-title:hover { color: #055581; text-decoration: underline; }
.set-score-view ::v-deep .abcSheetMusic svg text { font-family: Roboto, Arial, sans-serif; }
.set-score-active .set-tune-title { color: #055581; }
@media (max-width: 600px) { .set-follow-bar { top: 56px; } }
</style>
