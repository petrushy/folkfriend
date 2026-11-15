<template>
    <div>
        <div class="set-follow-bar pa-2 mb-3">
            <div
                class="d-flex flex-wrap align-center"
                style="gap:8px"
            >
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
                <template v-if="running">
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
                        :disabled="activeIndex >= set.entries.length - 1"
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
                v-if="running"
                class="caption mb-0 mt-1"
                aria-live="polite"
            >
                Tune {{ activeIndex + 1 }}/{{ set.entries.length }} · {{ title(set.entries[activeIndex].result.displayName) }} · {{ held ? 'Scrolling paused while you browse' : readout || 'Listening…' }}
            </p>
            <p
                v-else
                class="caption mb-0 mt-1"
            >
                Follow listens while you play and keeps the matching score row in view. You can also start from any tune below.
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
            :class="{ 'set-score-active': running && activeIndex === i }"
        >
            <div class="d-flex flex-wrap align-center">
                <h3 class="subtitle-1 font-weight-bold flex-grow-1">
                    {{ i + 1 }}. {{ title(entry.result.displayName) }}
                </h3>
                <v-btn
                    small
                    text
                    :disabled="!followable(entry) || starting"
                    @click="running ? selectEntry(i) : startFollow(i)"
                >
                    Follow from here
                </v-btn>
            </div>
            <p class="caption text--secondary mb-1">
                {{ key(entry.result.setting.mode) }} · {{ type(entry.result.setting.dance) }}
            </p>
            <AbcDisplay
                :ref="'score-' + entry.id"
                :abc="entry.result.setting.abc"
                :title="entry.result.displayName"
                :mode="entry.result.setting.mode"
                :meter="entry.result.setting.meter"
                :instrument-shift="instrumentShift"
                :hide-controls="running"
                :follow-line="running && activeIndex === i ? line : null"
                :follow-auto-scroll="running && autoScroll && !held"
                @abcRendered="updateFollow()"
            />
            <v-btn
                small
                text
                :to="{ name: 'tune', query: { tuneID: String(entry.result.setting.tune_id), settingID: String(entry.result.settingID), displayName: entry.result.displayName } }"
            >
                Open tune
            </v-btn>
        </div>
    </div>
</template>
<script>
import { mdiCrosshairsGps } from '@mdi/js';
import AbcDisplay from '@/components/AbcDisplay';
import practiceFollow from '@/services/practiceFollow.js';
import eventBus from '@/eventBus';
import { SetScoreFollower } from '@/js/setScoreFollower.mjs';
import { MIN_QUERY_LENGTH } from '@/js/scorePosition.mjs';
import { keyLabel, typeLabel } from '@/js/favouriteFacets.mjs';
import utils from '@/js/utils.js';

const MANUAL_HOLD_MS = 8000;
export default {
    name: 'SetScoreView',
    components: { AbcDisplay },
    props: { set: { type: Object, required: true }, instrumentShift: { type: Number, default: 0 } },
    data: () => ({ running: false, starting: false, activeIndex: 0, line: null, readout: '', autoScroll: true, held: false, error: '', icon: mdiCrosshairsGps }),
    computed: {
        scoreSignature() { return JSON.stringify([this.set.id, this.set.entries]); },
    },
    watch: {
        scoreSignature() { this.stopFollow(); this.activeIndex = 0; },
        autoScroll(on) { if (on) this.resumeScroll(); },
    },
    created() {
        this._position = () => this.updateFollow();
        this._state = state => {
            if (this.running && !this.starting && (!state.active || state.settingId !== this._owner)) this.clearLocal();
        };
        eventBus.$on('practiceFollowPosition', this._position);
        eventBus.$on('practiceFollowState', this._state);
    },
    beforeDestroy() {
        this._destroyed = true;
        this.stopFollow();
        eventBus.$off('practiceFollowPosition', this._position);
        eventBus.$off('practiceFollowState', this._state);
    },
    methods: {
        title: value => utils.parseDisplayableName(value || ''),
        key: value => value ? keyLabel(value) : 'Key unknown',
        type: value => value ? typeLabel(value) : 'Type unknown',
        followable(entry) { return typeof entry?.result?.setting?.contour === 'string' && entry.result.setting.contour.length >= MIN_QUERY_LENGTH; },
        async startFollow(index) {
            if (this.starting) return;
            if (!this.followable(this.set.entries[index])) { this.error = 'This tune has no saved listening contour. Choose Follow from here on another tune, or add its setting again.'; return; }
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
            if (!this.running || !this.autoScroll || this.held) return;
            this.$nextTick(() => {
                if (!this.running || !this.autoScroll || this.held) return;
                const ref = this.$refs['entry-' + this.set.entries[this.activeIndex].id];
                const element = Array.isArray(ref) ? ref[0] : ref;
                element?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            });
        },
    },
};
</script>
<style scoped>
.set-follow-bar { position: sticky; top: 64px; z-index: 4; background: white; border-bottom: 1px solid #ddd; }
.set-score { scroll-margin-top: 190px; }
.set-score-active h3 { color: #055581; }
@media (max-width: 600px) { .set-follow-bar { top: 56px; } }
</style>
