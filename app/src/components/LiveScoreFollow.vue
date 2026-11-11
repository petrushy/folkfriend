<template>
    <div class="liveScoreOverlay">
        <div class="liveScoreHeader">
            <div class="headerText">
                <h2 class="tuneTitle">
                    {{ target ? target.title : 'Listening…' }}
                    <button
                        v-if="target && hasValidSettingID"
                        class="starBtn"
                        :title="favourited ? 'Remove from favourites' : 'Add to favourites'"
                        @click="toggleFavourite"
                    >
                        <v-icon :color="favourited ? 'amber darken-1' : 'grey lighten-1'">
                            {{ favourited ? starIcon : starOutlineIcon }}
                        </v-icon>
                    </button>
                    <TuneBackgroundButton v-if="target" class="backgroundBtn" :tuneID="target.tuneId" :displayName="target.title" :sourceUrl="abcSetting ? abcSetting.source_url || '' : ''" />
                    <!-- What to play next: tunes commonly played in a set
                         with this one. Hidden for tunes with no set data. -->
                    <SetPartnersButton v-if="target" class="backgroundBtn" :tuneID="target.tuneId" :title="target.title" />
                    <button
                        v-if="target"
                        class="freezeBtn"
                        :title="frozen ? 'Unfreeze — follow the tune being played' : 'Freeze on this tune'"
                        :aria-pressed="String(frozen)"
                        @click="toggleFrozen"
                    >
                        <v-icon :color="frozen ? 'blue darken-2' : 'grey lighten-1'">
                            {{ frozen ? frozenIcon : unfrozenIcon }}
                        </v-icon>
                    </button>
                    <!-- Auto-centre: keep the line being played in the middle
                         of the screen (js/scorePosition.mjs). Off by default;
                         remembered per device. -->
                    <button
                        v-if="target"
                        class="autoCenterBtn"
                        :title="autoCenter ? 'Stop following the position in the tune' : 'Follow the position in the tune — keep the line being played in view'"
                        :aria-pressed="String(autoCenter)"
                        @click="toggleAutoCenter"
                    >
                        <v-icon :color="autoCenter ? 'teal darken-1' : 'grey lighten-1'">
                            {{ autoCenterIcon }}
                        </v-icon>
                    </button>
                    <!-- "This is a great tune, let us capture it!" Records
                         this tune only and stops by itself when it is over —
                         see js/tuneCapture.mjs. Shown even before a tune is
                         recognised, since the moment to press it is usually
                         the first bars. Disabled while audio is already being
                         recorded: it is on, so there is nothing to add. -->
                    <button
                        v-if="captureState !== 'not-listening'"
                        class="captureBtn"
                        :class="{ 'captureBtn--on': recordingNow, 'captureBtn--silent': captureLevel === 0 }"
                        :style="recordingNow ? captureLevelStyle : null"
                        :title="captureTitle"
                        :aria-pressed="String(capturing)"
                        :disabled="captureBusy || captureState === 'recording'"
                        @click="toggleCapture"
                    >
                        <!-- Whenever audio is being recorded — this tune, or the
                             whole session — the button IS the level meter: the
                             icon brightens and a ring glows with the sound being
                             kept, and it goes grey and pulses when none is
                             arriving. So "recording" and "recording something"
                             can be told apart at a glance, in no extra space.
                             Still not clickable for a whole-session recording. -->
                        <v-icon :color="recordingNow ? (captureLevel === 0 ? 'grey' : 'red darken-2') : (captureState === 'recording' ? 'grey lighten-2' : 'grey darken-1')">
                            {{ (recordingNow || capturing) ? captureOnIcon : captureOffIcon }}
                        </v-icon>
                    </button>
                    <!-- Last, and set apart from (i) and the pin: it is the one
                         destructive button in this row, and sitting between the
                         two most-tapped ones made it easy to hit by mistake. -->
                    <button
                        v-if="target"
                        class="rejectBtn"
                        title="Not this tune — drop it and go back to the previous detection"
                        @click="rejectTune"
                    >
                        <v-icon color="grey lighten-1">
                            {{ rejectIcon }}
                        </v-icon>
                    </button>
                </h2>
                <div class="tuneMeta">
                    <!-- Live even while frozen, and deliberately so. Freezing
                         stops the READOUTS moving so the dots can be read; this
                         is not a readout about the pinned tune, it is the one
                         thing on screen that says whether the room is still
                         playing it. A frozen view whose light has gone red is
                         exactly the state the user needs to be able to see. -->
                    <span
                        class="freshnessLed"
                        :class="`freshnessLed--${freshness.level}`"
                        :title="freshness.detail"
                        :aria-label="`Detection: ${freshness.label}. ${freshness.detail}`"
                        role="img"
                    />
                    <span class="freshnessLabel">{{ freshness.label }}</span>
                    <span v-if="target" class="scoreReadout">
                        match {{ target.score.toFixed(2) }}
                    </span>
                    <span v-if="target && autoCenter && positionReadout" class="positionReadout">
                        {{ positionReadout }}
                    </span>
                    <span v-if="capturing" class="captureFlag">
                        ● REC this tune
                    </span>
                    <span v-else-if="captureNote" class="captureNote">
                        {{ captureNote }}
                    </span>
                    <span v-if="target && frozen" class="frozenFlag">
                        frozen
                    </span>
                    <span v-else-if="target && target.overridden" class="overrideFlag">
                        manual pick
                    </span>
                    <span v-else-if="target" class="followingFlag">
                        following
                    </span>
                </div>
            </div>
            <button class="exitFollowBtn" title="Exit (Esc)" @click="$emit('close')">
                ✕
            </button>
        </div>

        <div
            ref="scoreBody"
            class="liveScoreBody"
            @touchstart.passive="onManualScroll"
            @wheel.passive="onManualScroll"
            @pointerdown="onManualScroll"
        >
            <div
                v-if="autoCenter && followBand"
                class="followBand"
                :style="{ top: `${followBand.top}px`, height: `${followBand.height}px` }"
                aria-hidden="true"
            />
            <v-alert
                v-if="loadError"
                type="warning"
                dense
                text
                class="mb-3"
            >
                {{ loadError }}
            </v-alert>

            <AbcDisplay
                v-if="abcSetting"
                ref="abcDisplay"
                :key="abcSetting.setting_id"
                hide-controls
                :abc="abcSetting.abc"
                :mode="abcSetting.mode"
                :meter="abcSetting.meter"
            />

            <div v-else-if="!loadError" class="emptyState">
                <v-progress-circular
                    v-if="loading"
                    indeterminate
                    color="primary"
                    class="mb-4"
                />
                <p class="mb-0">
                    {{ loading ? 'Loading score…' : 'Waiting for a tune to be recognised. Keep playing — the score appears here on its own and switches when the tune changes.' }}
                </p>
            </div>
        </div>

        <div class="liveScoreFooter">
            <v-select
                v-if="target && target.tuneOptions.length > 1"
                v-model="selectedTuneKey"
                :items="target.tuneOptions"
                item-text="text"
                item-value="value"
                dense
                hide-details
                solo
                flat
                class="overrideSelect"
                @change="onOverrideChange"
            />
            <div v-else class="footerHint">
                {{ frozen ? 'Frozen' : 'Auto-switching' }} · {{ formatSecondsAsClock(elapsedSeconds) }}
            </div>
            <span v-if="target && target.tuneOptions.length > 1" class="footerClock">
                <!-- The clock is the only footer text in this branch, so the
                     frozen state has to be carried here too — otherwise it is
                     announced everywhere except the one layout where the
                     override dropdown is on screen. -->
                {{ frozen ? 'Frozen · ' : '' }}{{ formatSecondsAsClock(elapsedSeconds) }}
            </span>
        </div>
    </div>
</template>

<script>
import { mdiStar, mdiStarOutline, mdiPin, mdiPinOutline, mdiThumbDownOutline, mdiRecordCircleOutline, mdiRecordRec, mdiCrosshairsGps } from '@mdi/js';
import ffBackend from '@/services/backend.js';
import eventBus from '@/eventBus.js';
import store from '@/services/store.js';
import liveAnalysisService from '@/services/liveAnalysis.js';
import AbcDisplay from '@/components/AbcDisplay.vue';
import TuneBackgroundButton from '@/components/TuneBackgroundButton.vue';
import SetPartnersButton from '@/components/SetPartnersButton.vue';
import { formatSecondsAsClock } from '@/js/sessionAnalysis.js';
import { resolveFollowTarget, applyOverride, targetScoreKey, needsScoreLoad, getLastShown, setLastShown } from '@/js/liveScoreFollow.mjs';
import { decideLine, nextFollowLine } from '@/js/scorePosition.mjs';

// After the user touches or scrolls the score, auto-centre keeps its hands off
// for this long. Someone reading ahead, or looking back at a bar, must not
// have the page pulled out from under them.
const MANUAL_SCROLL_HOLD_MS = 8_000;

const SCORE_LOAD_TIMEOUT_MS = 12_000;
const SCORE_LOAD_SLOW_MESSAGE =
    'The score is taking unusually long to load — the tune engine is busy or stuck. '
    + 'It will appear here as soon as it arrives. If it never does, reload the app: '
    + 'the session and its tune list are kept.';

export default {
    name: 'LiveScoreFollow',
    components: { AbcDisplay, TuneBackgroundButton, SetPartnersButton },
    props: {
        detections: {
            type: Array,
            required: true,
        },
    },
    data() {
        // Seed from whatever was on screen the last time this overlay was open,
        // so closing and reopening on the same still-playing tune shows it
        // instantly instead of forcing a reload — see the comment on
        // getLastShown() in liveScoreFollow.mjs.
        const lastShown = getLastShown();
        // Non-reactive: which target the cached/loading abcSetting is for.
        // See needsScoreLoad() in liveScoreFollow.mjs.
        this._abcTargetKey = lastShown.abcTargetKey || null;
        this._loadingTargetKey = null;
        // Everything loadScore()/_syncFavourited() read is set up HERE, not
        // in created(). Vue 2 runs an `immediate` watcher during initState —
        // after data(), BEFORE created() — so opening the overlay while a tune
        // was already detected started a load with `++undefined`, i.e. token
        // NaN. created() then reset the counter to 0, the answer arrived,
        // `NaN !== 0` discarded it as stale, `loading` was never cleared, and
        // _loadingTargetKey stayed set so no later tick retried: the tune's
        // name on screen and "Loading score…" spinning until the tune changed.
        //
        // Loads are guarded by a token so a slow settingsFromTuneID for an old
        // tune cannot land after a newer one and put the wrong score on screen.
        this._loadToken = 0;
        // Same idea for the favourited flag, keyed off the currently displayed
        // setting — a slow isFavourite() for a tune we've since moved on from
        // must not overwrite the star for the tune now on screen.
        this._favouriteToken = 0;
        // How long the spinner may run before the overlay says something.
        // settingsFromTuneID normally answers in well under a second, but it
        // shares the worker with live transcription, and nothing bounded it.
        // On an instance so a test can shorten it.
        this._scoreLoadTimeoutMs = SCORE_LOAD_TIMEOUT_MS;
        this._scoreLoadTimer = null;
        // Auto-centre bookkeeping, non-reactive: the hysteresis state, which
        // score it is about, and the hold after a manual scroll.
        this._followState = null;
        this._followKey = null;
        this._manualScrollUntil = 0;
        return {
            target: lastShown.target,
            abcSetting: lastShown.abcSetting,
            selectedTuneKey: lastShown.target ? this._optionKeyFor(lastShown.target) : null,
            loading: false,
            loadError: '',
            elapsedSeconds: liveAnalysisService.elapsedSeconds,
            freshness: liveAnalysisService.detectionFreshness(),
            favourited: lastShown.favourited,
            // Deliberately not seeded from lastShown: freezing lasts "until
            // unfrozen or closed", so closing the overlay ends it. Carrying it
            // across a reopen would leave the view silently pinned to a tune
            // that stopped being played some time ago, with nothing on the
            // previous screen to explain why.
            frozen: false,
            starIcon: mdiStar,
            starOutlineIcon: mdiStarOutline,
            frozenIcon: mdiPin,
            unfrozenIcon: mdiPinOutline,
            rejectIcon: mdiThumbDownOutline,
            captureOnIcon: mdiRecordRec,
            captureOffIcon: mdiRecordCircleOutline,
            // Read from the service, which owns the capture — the overlay
            // only asks for one and reports what is happening.
            capturing: !!liveAnalysisService.tuneCapture,
            captureState: liveAnalysisService.tuneCaptureAvailability(),
            captureBusy: false,
            // 0..1, how loud the audio being recorded is, or null when
            // nothing is being recorded. Polled while the overlay is open;
            // see _syncCaptureLevelPolling().
            captureLevel: liveAnalysisService.recordingLevel ? liveAnalysisService.recordingLevel() : null,
            // What a capture that has just ended did, or why one could not
            // start. Cleared after a few seconds.
            captureNote: '',
            // store.userSettings is not reactive, so the toggle keeps its own
            // copy (see the userSettings note in CLAUDE.md).
            autoCenter: !!(store.userSettings && store.userSettings.liveAutoCenter),
            autoCenterIcon: mdiCrosshairsGps,
            // What auto-centre currently thinks, as a few words beside the
            // match score — the only way to judge it on a device.
            positionReadout: '',
            // The highlighted line, in the score body's own scroll
            // coordinates, or null.
            followBand: null,
        };
    },
    computed: {
        recordingNow() {
            return this.captureLevel !== null && this.captureLevel !== undefined;
        },
        captureLevelStyle() {
            const level = this.captureLevel || 0;
            return {
                // Box-shadow, not size: the ring grows outwards without
                // moving anything else in the header.
                boxShadow: `0 0 ${2 + 10 * level}px ${1 + 4 * level}px rgba(211, 47, 47, ${0.15 + 0.6 * level})`,
                '--capture-icon-opacity': String(0.5 + 0.5 * level),
            };
        },
        captureTitle() {
            if (this.capturing) return 'Recording this tune — tap to stop now';
            if (this.captureState === 'recording') {
                return this.recordingNow
                    ? 'Recording the whole session — the ring shows the level being recorded'
                    : 'Audio is already being recorded';
            }
            return 'Record this tune (stops by itself when the tune is over)';
        },
        hasValidSettingID() {
            return !!this.target && store._isValidSettingID(this.target.settingId);
        },
    },
    watch: {
        detections: {
            immediate: true,
            handler(detections) {
                this.freshness = liveAnalysisService.detectionFreshness();
                this._resolveFromDetections(detections);
            },
        },
    },
    mounted() {
        this._onKeyDown = (e) => {
            if (e.key === 'Escape') this.$emit('close');
        };
        document.addEventListener('keydown', this._onKeyDown);

        this._onTimerTick = (secs) => {
            this.elapsedSeconds = secs;
            // Driven by the clock, not by detections: its job is to change
            // while nothing is being recognised.
            this.freshness = liveAnalysisService.detectionFreshness();
            // store.userSettings is not reactive, and the session page's
            // switch can change between ticks.
            this.captureState = liveAnalysisService.tuneCaptureAvailability();
            this._syncCaptureLevelPolling();
            // Re-decide every second, not only per window: the position is
            // projected forward from where the last window ended.
            this._updateFollowPosition();
        };
        eventBus.$on('liveAnalysisTimerTick', this._onTimerTick);

        this._onScorePosition = () => this._updateFollowPosition();
        eventBus.$on('liveScorePosition', this._onScorePosition);

        this._onCaptureState = (state = {}) => {
            this.capturing = !!state.capturing;
            this._syncCaptureLevelPolling();
            // A capture that ends or starts changes whether the recorder runs.
            this.captureState = liveAnalysisService.tuneCaptureAvailability();
            if (state.message) this._showCaptureNote(state.message);
        };
        eventBus.$on('liveAnalysisCaptureState', this._onCaptureState);
        this._syncCaptureLevelPolling();

        this._wakeLock = null;
        this._onVisibilityChange = () => {
            // Browsers drop the lock whenever the document is hidden, so it has
            // to be taken again each time we come back to the foreground.
            if (document.visibilityState === 'visible') this._requestWakeLock();
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);
        this._requestWakeLock();
    },
    beforeDestroy() {
        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        eventBus.$off('liveAnalysisTimerTick', this._onTimerTick);
        eventBus.$off('liveScorePosition', this._onScorePosition);
        eventBus.$off('liveAnalysisCaptureState', this._onCaptureState);
        clearTimeout(this._captureNoteTimer);
        clearInterval(this._captureLevelTimer);
        this._captureLevelTimer = null;
        this._releaseWakeLock();
        clearTimeout(this._scoreLoadTimer);
        setLastShown({
            target: this.target,
            abcSetting: this.abcSetting,
            abcTargetKey: this._abcTargetKey,
            favourited: this.favourited,
        });
    },
    methods: {
        formatSecondsAsClock,
        async _requestWakeLock() {
            if (this._wakeLock || !navigator.wakeLock) return;
            try {
                this._wakeLock = await navigator.wakeLock.request('screen');
                this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
            } catch (e) {
                // Unsupported, or refused (e.g. low battery) — follow mode still
                // works, the screen just dims as usual.
                this._wakeLock = null;
            }
        },
        _releaseWakeLock() {
            if (!this._wakeLock) return;
            const lock = this._wakeLock;
            this._wakeLock = null;
            lock.release().catch(() => {});
        },
        _optionKeyFor(target) {
            const match = target.tuneOptions.find(
                option => option.tuneId === target.tuneId &&
                    String(option.settingId || '') === String(target.settingId || '')
            );
            return match ? match.value : null;
        },
        // "That is not what I am playing." Drops the detection from the live
        // analysis — so it leaves the session's tune list too, and does not come
        // straight back on the next cycle — and falls back to whatever was
        // detected before it.
        rejectTune() {
            const target = this.target;
            if (!target || target.detectedTuneId == null) return;
            liveAnalysisService.rejectTune(target.detectedTuneId);
            // The `detections` prop only catches up on the next render, and the
            // resolver ignores everything while frozen — but a rejection is the
            // user telling us the pinned tune is wrong, so it has to move. Read
            // the service's own list directly and resolve from that.
            this.frozen = false;
            this._resolveFromDetections(liveAnalysisService.detections);
        },
        // ~8 times a second while listening: fast enough to move with the
        // music. It has to run whenever the session is listening, not only
        // during a one-tune capture — a whole-session recording is started
        // from another page, and the button must show it too. The read is
        // two property lookups, so this costs nothing measurable.
        _syncCaptureLevelPolling() {
            const listening = this.captureState !== 'not-listening';
            if (listening && !this._captureLevelTimer) {
                this._captureLevelTimer = setInterval(() => {
                    this.captureLevel = liveAnalysisService.recordingLevel();
                }, 125);
            } else if (!listening && this._captureLevelTimer) {
                clearInterval(this._captureLevelTimer);
                this._captureLevelTimer = null;
                this.captureLevel = null;
            }
        },
        _showCaptureNote(text) {
            this.captureNote = text;
            clearTimeout(this._captureNoteTimer);
            this._captureNoteTimer = setTimeout(() => { this.captureNote = ''; }, 8000);
        },
        async toggleCapture() {
            if (this.captureBusy) return;
            this.captureBusy = true;
            try {
                if (this.capturing) {
                    await liveAnalysisService.cancelTuneCapture();
                } else {
                    const result = await liveAnalysisService.captureTune();
                    if (!result.ok && result.error) this._showCaptureNote(`Could not record: ${result.error}`);
                }
            } finally {
                // Read back rather than trusting the tap.
                this.capturing = !!liveAnalysisService.tuneCapture;
                this._syncCaptureLevelPolling();
                this.captureState = liveAnalysisService.tuneCaptureAvailability();
                this.captureBusy = false;
            }
        },
        toggleAutoCenter() {
            this.autoCenter = !this.autoCenter;
            if (store.userSettings) {
                store.userSettings.liveAutoCenter = this.autoCenter;
                store.updateUserSettings(store.userSettings);
            }
            this._followState = null;
            this.followBand = null;
            this.positionReadout = '';
            // Turning it on is the moment the user wants to be taken there.
            this._manualScrollUntil = 0;
            if (this.autoCenter) this._updateFollowPosition();
        },
        onManualScroll() {
            this._manualScrollUntil = Date.now() + MANUAL_SCROLL_HOLD_MS;
        },
        // Where in the tune the music is, and — when auto-centre is on and the
        // view is neither frozen nor being scrolled by hand — move it there.
        _updateFollowPosition() {
            if (!this.autoCenter) return;
            const display = this.$refs && this.$refs.abcDisplay;
            const target = this.target;
            const setting = this.abcSetting;
            if (!target || !setting || !display || typeof display.followTimeline !== 'function') {
                this.positionReadout = '';
                this.followBand = null;
                return;
            }
            // A different score means a different tune's lines: start over.
            const key = `${target.tuneId}::${setting.setting_id}`;
            if (key !== this._followKey) {
                this._followKey = key;
                this._followState = null;
                this.followBand = null;
            }
            const timeline = display.followTimeline();
            const position = liveAnalysisService.scorePosition;
            // Against the setting actually ON SCREEN, which is not always the
            // detected one (a fallback to settings[0]).
            const decision = decideLine(position, {
                tuneId: target.tuneId,
                settingId: setting.setting_id,
                nowMs: Date.now(),
                timeline,
            });
            this._followState = nextFollowLine(
                this._followState, decision.line, position ? position.readAt : null);
            const line = this._followState.line;
            const count = timeline ? timeline.lineCount : 0;
            this.positionReadout = this._positionText(decision, line, count);
            if (line === null) return;
            // The freeze is total: nothing moves while the user reads.
            if (this.frozen) return;
            // While the user is scrolling by hand the band still follows the
            // music; only the page stays where they put it.
            this._centreLine(display, line, Date.now() >= this._manualScrollUntil);
        },
        _positionText(decision, line, count) {
            if (decision.reason === 'ok') {
                return `line ${decision.line + 1}/${count} · ${Math.round(decision.fraction * 100)}%`;
            }
            const held = line !== null ? `line ${line + 1}/${count}, ` : '';
            switch (decision.reason) {
            case 'ambiguous': return `${held}which part?`;
            case 'weak': return `${held}position unclear`;
            case 'stale': return `${held}no recent match`;
            case 'other-setting': return 'position n/a for this setting';
            case 'no-timeline': return 'position n/a';
            default: return held ? held.replace(/, $/, '') : '';
            }
        },
        _centreLine(display, line, scroll) {
            const body = this.$refs.scoreBody;
            const rect = display.lineClientRect(line);
            if (!body || !rect || typeof body.getBoundingClientRect !== 'function') return;
            const bodyRect = body.getBoundingClientRect();
            const top = body.scrollTop + (rect.top - bodyRect.top);
            const height = Math.max(0, rect.bottom - rect.top);
            const band = { top, height };
            const moved = !this.followBand ||
                Math.abs(this.followBand.top - band.top) > 1 ||
                Math.abs(this.followBand.height - band.height) > 1;
            this.followBand = band;
            if (!moved || !scroll) return;
            const wanted = Math.max(0, top + height / 2 - bodyRect.height / 2);
            if (typeof body.scrollTo === 'function') {
                body.scrollTo({ top: wanted, behavior: 'smooth' });
            } else {
                body.scrollTop = wanted;
            }
        },
        toggleFrozen() {
            this.frozen = !this.frozen;
            if (this.frozen) return;
            // Unfreezing must re-join whatever is being played *now*. The
            // detections watcher only fires when the array changes, and while
            // frozen every one of those ticks was discarded, so without this
            // the view would sit on the frozen tune until the next tune change
            // — looking as though unfreeze hadn't worked.
            this._resolveFromDetections();
        },
        _resolveFromDetections(detections = this.detections) {
            const { target, changed } = resolveFollowTarget(detections, this.target, this.frozen);
            this.target = target;
            this.selectedTuneKey = target ? this._optionKeyFor(target) : null;
            // detections updates continuously while listening (many times a
            // second) but the displayed settingId only actually moves when
            // `changed` is true — see resolveFollowTarget(). Re-checking
            // isFavourite() on every tick raced store.addFavourite()/
            // removeFavourite(), whose in-memory cache only reflects a
            // write after its IndexedDB write resolves: a tick landing in
            // that window read the stale cache and snapped the star back,
            // making it look like the tap hadn't registered.
            if (changed) this._syncFavourited();
            // needsScoreLoad() covers a real tune change (this._abcTargetKey
            // stops matching) and also a stale-on-reopen cache (same idea,
            // caught by the key rather than by `changed`) — while also
            // deduping against an in-flight load for this same target, so
            // the many detections ticks that land while one fetch is
            // outstanding don't each restart it. See its comment.
            if (needsScoreLoad(target, this._abcTargetKey, this._loadingTargetKey)) this.loadScore();
        },
        onOverrideChange(value) {
            const option = this.target.tuneOptions.find(o => o.value === value);
            const { target } = applyOverride(this.target, option);
            this.target = target;
            this._syncFavourited();
            if (needsScoreLoad(target, this._abcTargetKey, this._loadingTargetKey)) this.loadScore();
        },
        _syncFavourited() {
            const token = ++this._favouriteToken;
            const settingId = this.target ? this.target.settingId : '';
            if (!store._isValidSettingID(settingId)) {
                this.favourited = false;
                return;
            }
            store.isFavourite(settingId).then(v => {
                if (token !== this._favouriteToken) return;
                this.favourited = v;
            });
        },
        async toggleFavourite() {
            // A shaky field tap can register as two quick clicks on the same
            // gesture; without this guard the second one reads `favourited`
            // before the first write lands and repeats the same store call.
            if (this._togglingFavourite) return;
            const target = this.target;
            if (!target || !store._isValidSettingID(target.settingId)) return;
            this._togglingFavourite = true;
            // Set optimistically so the star responds on this click rather
            // than after the IndexedDB round-trip.
            const nowFavourited = !this.favourited;
            this.favourited = nowFavourited;
            try {
                if (nowFavourited) {
                    await store.addFavourite({
                        settingID: target.settingId,
                        setting: this.abcSetting || { tune_id: target.tuneId, setting_id: target.settingId },
                        displayName: target.title,
                    });
                } else {
                    await store.removeFavourite(target.settingId);
                }
            } finally {
                this._togglingFavourite = false;
            }
        },
        async loadScore() {
            const token = ++this._loadToken;
            const target = this.target;
            const key = targetScoreKey(target);
            this._loadingTargetKey = key;

            if (!target) {
                this.abcSetting = null;
                this._abcTargetKey = null;
                this.loadError = '';
                this.loading = false;
                if (this._loadingTargetKey === key) this._loadingTargetKey = null;
                return;
            }

            this.loading = true;
            this.loadError = '';
            clearTimeout(this._scoreLoadTimer);
            // A deadline, not a cancellation: the request keeps its token, so
            // if the answer does turn up late it is still shown. What the
            // deadline does is stop the spinner, say what is happening, and
            // release _loadingTargetKey so the next detections tick may try
            // again (which supersedes this one via the token).
            this._scoreLoadTimer = setTimeout(() => {
                if (token !== this._loadToken) return;
                this.loading = false;
                this.loadError = SCORE_LOAD_SLOW_MESSAGE;
                if (this._loadingTargetKey === key) this._loadingTargetKey = null;
            }, this._scoreLoadTimeoutMs);
            try {
                // The previous score deliberately stays on screen until the new
                // one is ready, so a tune change doesn't flash an empty page.
                const settings = await ffBackend.settingsFromTuneID(target.tuneId);
                // A newer call already claimed _loadingTargetKey for its own key
                // — leave it alone, only our own token's bookkeeping is stale.
                if (token !== this._loadToken) return;

                if (!settings || !settings.length) {
                    // Index-dependent worker calls fail fast with [] when the
                    // tune index is unavailable, rather than hanging.
                    this.abcSetting = null;
                    this._abcTargetKey = null;
                    this.loadError = ffBackend.indexUnavailableMessage();
                    return;
                }

                const chosen = settings.find(
                    setting => String(setting.setting_id) === String(target.settingId)
                ) || settings[0];
                this.abcSetting = chosen;
                this._abcTargetKey = key;
                // Arrived after the deadline: take the slow-load warning down.
                this.loadError = '';
            } catch (e) {
                // A rejection (rather than the [] settingsFromTuneID normally
                // resolves with) must still clear loading/_loadingTargetKey —
                // otherwise this target reads as permanently "in flight" and
                // needsScoreLoad() never lets it be retried.
                if (token !== this._loadToken) return;
                this.abcSetting = null;
                this._abcTargetKey = null;
                this.loadError = ffBackend.indexUnavailableMessage();
            } finally {
                if (token === this._loadToken) {
                    clearTimeout(this._scoreLoadTimer);
                    this.loading = false;
                    if (this._loadingTargetKey === key) this._loadingTargetKey = null;
                }
            }
        },
    },
};
</script>

<style scoped>
.liveScoreOverlay {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 12;
    background: white;
    display: flex;
    flex-direction: column;
}

.liveScoreHeader {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: max(12px, env(safe-area-inset-top, 12px)) max(12px, env(safe-area-inset-right, 12px)) 8px max(16px, env(safe-area-inset-left, 16px));
    border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}

.headerText {
    flex: 1;
    min-width: 0;
}

.tuneTitle {
    font-size: 1.25rem;
    font-weight: 500;
    line-height: 1.3;
    color: #1a1a1a;
    overflow-wrap: anywhere;
}

.starBtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: none;
    /* Icon is 24px; padding brings the tappable area to the ~44px minimum
       recommended touch target. Negative top/bottom margin cancels the
       padding's effect on the title's line height. */
    padding: 10px;
    margin: -10px 0 -10px 2px;
    cursor: pointer;
    vertical-align: middle;
    line-height: 1;
    -webkit-tap-highlight-color: transparent;
}

/* Scoped styles reach a child component's root element, so this lands on the
   v-btn itself — aligning it with the star beside it without the button
   stretching the title's line height. */
.backgroundBtn {
    vertical-align: middle;
    margin: -10px 0 -10px 2px;
}

.rejectBtn,
.freezeBtn,
.autoCenterBtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: none;
    /* Same 44px touch target as .starBtn, with the same negative margin so it
       doesn't stretch the title's line height. */
    padding: 10px;
    margin: -10px 0 -10px 2px;
    cursor: pointer;
    vertical-align: middle;
    line-height: 1;
    -webkit-tap-highlight-color: transparent;
}

/* A clear gap plus a thin divider, so a slightly-off tap on the pin lands
   on nothing rather than on the thumbs-down. The 44px target is unchanged. */
.rejectBtn {
    position: relative;
    margin-left: 28px;
}

.rejectBtn::before {
    content: '';
    position: absolute;
    left: -15px;
    top: 25%;
    height: 50%;
    border-left: 1px solid rgba(0, 0, 0, 0.15);
}

.tuneMeta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 0.8rem;
    color: #5f6b77;
    margin-top: 2px;
}

/* `followingFlag` used to carry a green ● of its own. It was always green —
   it meant "auto-switching is on", not "this is right" — and read as a
   confidence light that never changed. Two dots side by side, one of them
   permanently green, would be worse than none, so the real LED below is the
   only dot in this header now. */

/* Green / amber / red on how recently, and how well, something matched. A
   filled dot rather than an icon: it has to be readable at a glance from a
   music stand's distance. */
.freshnessLed {
    align-self: center;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #9e9e9e;
    flex: none;
}

.freshnessLed--green { background: #2e7d32; box-shadow: 0 0 6px rgba(46, 125, 50, 0.9); }
.freshnessLed--amber { background: #f9a825; box-shadow: 0 0 6px rgba(249, 168, 37, 0.9); }
.freshnessLed--red { background: #c62828; box-shadow: 0 0 6px rgba(198, 40, 40, 0.9); }
.freshnessLed--idle { background: #9e9e9e; }
.freshnessLed--off { background: #616161; }

.captureBtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: none;
    padding: 10px;
    margin: -10px 0 -10px 2px;
    vertical-align: middle;
    cursor: pointer;
}

.captureBtn:disabled {
    cursor: default;
}

.captureBtn--on {
    border-radius: 50%;
    transition: box-shadow 0.12s linear;
}

.captureBtn--on .v-icon {
    opacity: var(--capture-icon-opacity, 1);
    transition: opacity 0.12s linear;
}

/* Recording, but no sound is reaching it: a slow pulse, so it reads as
   "waiting" rather than as a button that has simply gone dark. */
.captureBtn--silent .v-icon {
    animation: captureSilent 1.6s ease-in-out infinite;
}

@keyframes captureSilent {
    0%, 100% { opacity: 0.9; }
    50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
    .captureBtn--on, .captureBtn--on .v-icon { transition: none; }
    .captureBtn--silent .v-icon { animation: none; }
}

.captureFlag {
    color: #c62828;
    font-weight: 500;
}

.captureNote {
    color: #455a64;
}

.freshnessLabel {
    margin-left: -4px;
}

.overrideFlag {
    color: #b26500;
}

.frozenFlag {
    color: #1565c0;
}

.frozenFlag::before {
    content: '●';
    margin-right: 4px;
}

.exitFollowBtn {
    flex: none;
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

.liveScoreBody {
    position: relative;
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 8px max(8px, env(safe-area-inset-right, 8px)) 8px max(8px, env(safe-area-inset-left, 8px));
}

.followBand {
    position: absolute;
    left: 0;
    right: 0;
    background: rgba(0, 150, 136, 0.10);
    border-left: 4px solid rgba(0, 137, 123, 0.7);
    pointer-events: none;
    z-index: 1;
    transition: top 0.4s ease, height 0.4s ease;
}

.positionReadout {
    color: #00796b;
}

.emptyState {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    height: 100%;
    padding: 32px;
    color: #5f6b77;
}

.liveScoreFooter {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px max(12px, env(safe-area-inset-right, 12px)) max(8px, env(safe-area-inset-bottom, 8px)) max(12px, env(safe-area-inset-left, 12px));
    border-top: 1px solid rgba(0, 0, 0, 0.08);
    background: rgba(255, 255, 255, 0.92);
}

.overrideSelect {
    flex: 1;
    min-width: 0;
}

.footerHint,
.footerClock {
    font-size: 0.8rem;
    color: #5f6b77;
    white-space: nowrap;
}
</style>
