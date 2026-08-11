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
                </h2>
                <div class="tuneMeta">
                    <span v-if="target" class="scoreReadout">
                        match {{ target.score.toFixed(2) }}
                    </span>
                    <span v-if="target && target.overridden" class="overrideFlag">
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

        <div class="liveScoreBody">
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
                Auto-switching · {{ formatSecondsAsClock(elapsedSeconds) }}
            </div>
            <span v-if="target && target.tuneOptions.length > 1" class="footerClock">
                {{ formatSecondsAsClock(elapsedSeconds) }}
            </span>
        </div>
    </div>
</template>

<script>
import { mdiStar, mdiStarOutline } from '@mdi/js';
import ffBackend from '@/services/backend.js';
import eventBus from '@/eventBus.js';
import store from '@/services/store.js';
import liveAnalysisService from '@/services/liveAnalysis.js';
import AbcDisplay from '@/components/AbcDisplay.vue';
import { formatSecondsAsClock } from '@/js/sessionAnalysis.js';
import { resolveFollowTarget, applyOverride, targetScoreKey, needsScoreLoad, getLastShown, setLastShown } from '@/js/liveScoreFollow.mjs';

export default {
    name: 'LiveScoreFollow',
    components: { AbcDisplay },
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
        return {
            target: lastShown.target,
            abcSetting: lastShown.abcSetting,
            selectedTuneKey: lastShown.target ? this._optionKeyFor(lastShown.target) : null,
            loading: false,
            loadError: '',
            elapsedSeconds: liveAnalysisService.elapsedSeconds,
            favourited: lastShown.favourited,
            starIcon: mdiStar,
            starOutlineIcon: mdiStarOutline,
        };
    },
    computed: {
        hasValidSettingID() {
            return !!this.target && store._isValidSettingID(this.target.settingId);
        },
    },
    watch: {
        detections: {
            immediate: true,
            handler(detections) {
                const { target, changed } = resolveFollowTarget(detections, this.target);
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
                // needsScoreLoad() covers a real tune change (this.abcTargetKey
                // stops matching) and also a stale-on-reopen cache (same idea,
                // caught by the key rather than by `changed`) — while also
                // deduping against an in-flight load for this same target, so
                // the many detections ticks that land while one fetch is
                // outstanding don't each restart it. See its comment.
                if (needsScoreLoad(target, this._abcTargetKey, this._loadingTargetKey)) this.loadScore();
            },
        },
    },
    created() {
        // Loads are guarded by a token so a slow settingsFromTuneID for an old
        // tune cannot land after a newer one and put the wrong score on screen.
        this._loadToken = 0;
        // Same idea for the favourited flag, keyed off the currently displayed
        // setting — a slow isFavourite() for a tune we've since moved on from
        // must not overwrite the star for the tune now on screen.
        this._favouriteToken = 0;
    },
    mounted() {
        this._onKeyDown = (e) => {
            if (e.key === 'Escape') this.$emit('close');
        };
        document.addEventListener('keydown', this._onKeyDown);

        this._onTimerTick = (secs) => { this.elapsedSeconds = secs; };
        eventBus.$on('liveAnalysisTimerTick', this._onTimerTick);

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
        this._releaseWakeLock();
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
            // The previous score deliberately stays on screen until the new one
            // is ready, so a tune change doesn't flash an empty page.
            const settings = await ffBackend.settingsFromTuneID(target.tuneId);
            // A newer call already claimed _loadingTargetKey for its own key —
            // leave it alone, only our own token's bookkeeping is stale here.
            if (token !== this._loadToken) return;

            this.loading = false;

            if (!settings || !settings.length) {
                // Index-dependent worker calls fail fast with [] when the tune
                // index is unavailable, rather than hanging.
                this.abcSetting = null;
                this._abcTargetKey = null;
                this.loadError = ffBackend.indexUnavailableMessage();
                if (this._loadingTargetKey === key) this._loadingTargetKey = null;
                return;
            }

            const chosen = settings.find(
                setting => String(setting.setting_id) === String(target.settingId)
            ) || settings[0];
            this.abcSetting = chosen;
            this._abcTargetKey = key;
            if (this._loadingTargetKey === key) this._loadingTargetKey = null;
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

.tuneMeta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 0.8rem;
    color: #5f6b77;
    margin-top: 2px;
}

.followingFlag::before {
    content: '●';
    color: #2e7d32;
    margin-right: 4px;
}

.overrideFlag {
    color: #b26500;
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
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 8px max(8px, env(safe-area-inset-right, 8px)) 8px max(8px, env(safe-area-inset-left, 8px));
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
