<template>
    <v-sheet
        v-if="hasSession"
        class="session-status-bar px-3 py-2"
        :class="barClass"
        elevation="2"
    >
        <div class="d-flex flex-wrap align-center" style="gap: 8px;">
            <v-chip x-small :color="status.color" text-color="white">
                <v-icon left x-small>{{ status.icon }}</v-icon>
                {{ status.label }}
            </v-chip>

            <span class="caption text--secondary">
                {{ formatSecondsAsClock(elapsedSeconds) }}
                &middot;
                {{ tuneCount }} {{ tuneCount === 1 ? 'tune' : 'tunes' }}
            </span>

            <v-spacer />

            <v-btn
                v-if="capturing"
                x-small
                text
                color="secondary"
                :loading="pausing"
                @click="pause"
            >
                Pause
            </v-btn>
            <v-btn
                v-else-if="canResume"
                x-small
                color="primary"
                :disabled="!indexLoaded || resuming"
                :loading="resuming"
                @click="resume"
            >
                Resume
            </v-btn>

            <v-btn
                v-if="!onSessionPage"
                x-small
                text
                color="primary"
                :to="{ name: 'session-analysis' }"
            >
                Open
            </v-btn>

            <v-btn
                x-small
                text
                color="secondary"
                :loading="finishing"
                @click="finish"
            >
                Finish
            </v-btn>
        </div>

        <div
            v-if="(capturing && !micHealthy) || saveState === 'error'"
            class="d-flex flex-wrap align-center mt-1"
            style="gap: 8px;"
        >
            <span v-if="capturing && !micHealthy" class="caption warning--text">
                Microphone unavailable{{ micIssue ? ` (${micIssue})` : '' }} — nothing is being
                detected. Your tune list is safe.
            </span>
            <v-btn
                v-if="capturing && !micHealthy"
                x-small
                :loading="retryingMic"
                @click="retryMicrophone"
            >
                Retry
            </v-btn>
            <span v-if="saveState === 'error'" class="caption error--text">
                This session could not be saved{{ saveError ? `: ${saveError}` : '' }}.
            </span>
            <v-btn
                v-if="saveState === 'error'"
                x-small
                :loading="retryingSave"
                @click="retrySave"
            >
                Retry save
            </v-btn>
        </div>
    </v-sheet>
</template>

<script>
// The session's status and controls, rendered by App.vue so they follow the
// user everywhere.
//
// Listening is a background activity: it survives navigating to a tune, to
// favourites, to settings. Before this, the only place that said so was the
// Session Analysis page, so walking away from that page left an app that was
// recording with nothing on screen admitting it — and no way to pause without
// navigating back.
//
// It subscribes to the service directly rather than taking props, because its
// whole point is to work on routes that know nothing about sessions.
import eventBus from '@/eventBus.js';
import store from '@/services/store.js';
import liveAnalysisService from '@/services/liveAnalysis.js';
import {
    mdiPause, mdiRecordCircleOutline, mdiAlertCircleOutline,
} from '@mdi/js';
import { formatSecondsAsClock } from '@/js/sessionAnalysis.js';

export default {
    name: 'SessionStatusBar',
    data() {
        return {
            hasSession: false,
            capturing: false,
            canResume: true,
            elapsedSeconds: 0,
            tuneCount: 0,
            micHealthy: true,
            micIssue: '',
            saveState: 'idle',
            saveError: null,
            indexLoaded: store.state.indexLoaded,
            pausing: false,
            resuming: false,
            finishing: false,
            retryingMic: false,
            retryingSave: false,
            icons: {
                pause: mdiPause,
                recording: mdiRecordCircleOutline,
                alert: mdiAlertCircleOutline,
            },
        };
    },
    computed: {
        status() {
            if (this.capturing && !this.micHealthy) {
                return { label: 'Mic unavailable', color: 'warning', icon: this.icons.alert };
            }
            if (this.capturing) {
                return { label: 'Listening', color: 'red darken-1', icon: this.icons.recording };
            }
            return { label: 'Paused', color: 'grey darken-1', icon: this.icons.pause };
        },
        barClass() {
            if (this.capturing && !this.micHealthy) return 'session-status-bar--warning';
            return this.capturing ? 'session-status-bar--live' : 'session-status-bar--paused';
        },
        onSessionPage() {
            return !!this.$route && this.$route.name === 'session-analysis';
        },
    },
    created() {
        this._sync = () => {
            const svc = liveAnalysisService;
            this.hasSession = !!svc.sessionId;
            this.capturing = svc.isRunning;
            this.canResume = svc.canResume();
            this.elapsedSeconds = svc.elapsedSeconds;
            this.tuneCount = svc.detections.length;
            this.micHealthy = svc.micHealthy;
            this.micIssue = svc.micIssue || '';
            this.saveState = svc.saveState;
            this.saveError = svc.saveError;
        };
        this._onTick = (secs) => { this.elapsedSeconds = secs; };
        this._onUpdate = (detections) => { this.tuneCount = detections.length; };
        this._onIndexLoaded = () => { this.indexLoaded = true; };

        for (const name of [
            'liveAnalysisStopped', 'liveAnalysisFinished', 'liveAnalysisRestored',
            'liveAnalysisMicState', 'liveAnalysisSaveState',
        ]) {
            eventBus.$on(name, this._sync);
        }
        eventBus.$on('liveAnalysisTimerTick', this._onTick);
        eventBus.$on('liveAnalysisUpdate', this._onUpdate);
        eventBus.$on('indexLoaded', this._onIndexLoaded);
        // Deliberately NOT micLost/micRecovered: the service adopts those and
        // republishes them as liveAnalysisMicState, so it stays the single
        // source of truth for whether this session is actually hearing
        // anything. Reading the microphone directly here is how the bar and
        // the session end up disagreeing.
        this._sync();
    },
    beforeDestroy() {
        for (const name of [
            'liveAnalysisStopped', 'liveAnalysisFinished', 'liveAnalysisRestored',
            'liveAnalysisMicState', 'liveAnalysisSaveState',
        ]) {
            eventBus.$off(name, this._sync);
        }
        eventBus.$off('liveAnalysisTimerTick', this._onTick);
        eventBus.$off('liveAnalysisUpdate', this._onUpdate);
        eventBus.$off('indexLoaded', this._onIndexLoaded);
    },
    methods: {
        formatSecondsAsClock,
        async pause() {
            this.pausing = true;
            try { await liveAnalysisService.pause(); } finally {
                this.pausing = false;
                this._sync();
            }
        },
        async resume() {
            this.resuming = true;
            try {
                await liveAnalysisService.start(
                    liveAnalysisService.options ? liveAnalysisService.options.windowSeconds : 10,
                    liveAnalysisService.options ? liveAnalysisService.options.stepSeconds : 5,
                );
            } catch (e) {
                console.warn('Could not resume listening:', e && e.message);
            } finally {
                this.resuming = false;
                this._sync();
            }
        },
        async finish() {
            this.finishing = true;
            try { await liveAnalysisService.finish(); } finally {
                this.finishing = false;
                this._sync();
            }
        },
        async retryMicrophone() {
            this.retryingMic = true;
            try { await liveAnalysisService.retryMicrophone(); } finally {
                this.retryingMic = false;
                this._sync();
            }
        },
        async retrySave() {
            this.retryingSave = true;
            try { await liveAnalysisService._persistSession(); } finally {
                this.retryingSave = false;
                this._sync();
            }
        },
    },
};
</script>

<style scoped>
.session-status-bar {
    border-left: 4px solid transparent;
    position: sticky;
    top: 0;
    z-index: 4;
}

.session-status-bar--live {
    border-left-color: #c62828;
}

.session-status-bar--paused {
    border-left-color: #9e9e9e;
}

.session-status-bar--warning {
    border-left-color: #f9a825;
}
</style>
