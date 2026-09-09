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

            <!-- An app that is recording the room must say so wherever the
                 user happens to be, not only on the page they started it from.
                 The chip carries the mute state too: "muted" is the claim the
                 user most needs to be able to check at a glance, and a chip
                 that still read REC while the audio was silenced would be
                 worse than no chip at all. -->
            <v-chip
                v-if="audioRecording"
                x-small
                :color="audioMuted ? 'grey darken-2' : 'red darken-3'"
                text-color="white"
            >
                <v-icon left x-small>{{ audioMuted ? icons.micOff : icons.recording }}</v-icon>
                {{ audioMuted ? `MUTED ${formatSecondsAsClock(audioMutedSeconds)}` : 'REC' }}
            </v-chip>
            <v-btn
                v-if="audioRecording && audioMuteSupported"
                x-small
                :text="!audioMuted"
                :color="audioMuted ? 'primary' : 'secondary'"
                :aria-label="audioMuted ? 'Record audio again' : 'Stop recording audio'"
                @click="toggleAudioMute"
            >
                {{ audioMuted ? 'Record audio' : 'Mute audio' }}
            </v-btn>
            <span v-if="sessionName" class="caption session-name" :title="sessionName">{{ sessionName }}</span>
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
                x-small
                text
                color="primary"
                :to="{ name: 'session-analysis', query: { live: '1' } }"
                @click="openCurrent"
            >
                Current session
            </v-btn>


        </div>

        <div
            v-if="(capturing && !micHealthy) || saveState === 'error' || audioError || audioMuted"
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
            <span v-if="audioMuted" class="caption text--secondary">
                Audio muted — tunes are still being detected, but nothing is being recorded.
            </span>
            <span v-if="audioError" class="caption warning--text">
                {{ audioError }} The session and its tune list are unaffected.
            </span>
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
import sessionRecorder from '@/services/sessionRecorder.js';
import {
    mdiPause, mdiRecordCircleOutline, mdiAlertCircleOutline, mdiMicrophoneOff,
} from '@mdi/js';
import { formatSecondsAsClock } from '@/js/sessionAnalysis.js';

export default {
    name: 'SessionStatusBar',
    data() {
        return {
            hasSession: false,
            sessionName: '',
            capturing: false,
            canResume: true,
            elapsedSeconds: 0,
            tuneCount: 0,
            micHealthy: true,
            micIssue: '',
            saveState: 'idle',
            saveError: null,
            audioRecording: false,
            audioError: '',
            audioMuted: false,
            audioMuteSupported: false,
            audioMutedSeconds: 0,
            indexLoaded: store.state.indexLoaded,
            pausing: false,
            resuming: false,
            retryingMic: false,
            retryingSave: false,
            icons: {
                pause: mdiPause,
                recording: mdiRecordCircleOutline,
                alert: mdiAlertCircleOutline,
                micOff: mdiMicrophoneOff,
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
            this.sessionName = svc.sessionName || '';
            this.capturing = svc.isRunning;
            this.canResume = svc.canResume();
            this.elapsedSeconds = svc.elapsedSeconds;
            this.tuneCount = svc.detections.length;
            this.micHealthy = svc.micHealthy;
            this.micIssue = svc.micIssue || '';
            this.saveState = svc.saveState;
            this.saveError = svc.saveError;
        };
        this._onTick = (secs) => {
            this.elapsedSeconds = secs;
            // sessionAudioState only fires when a segment is written — every
            // three minutes — so without this the muted counter sits still
            // while the user watches it, which defeats the reassurance it
            // exists to give.
            if (this.audioMuted) this.audioMutedSeconds = sessionRecorder.mutedSeconds;
        };
        this._onUpdate = (detections) => { this.tuneCount = detections.length; };
        this._onIndexLoaded = () => { this.indexLoaded = true; };
        this._onAudioState = ({
            recording, stoppedReason, error, muted, muteSupported, mutedSeconds,
        }) => {
            this.audioRecording = !!recording;
            this.audioMuted = !!muted;
            this.audioMuteSupported = !!muteSupported;
            this.audioMutedSeconds = mutedSeconds || 0;
            // Only a stop the user needs to know about. 'unsupported' is not
            // one: nothing was promised on a browser that cannot record.
            this.audioError = stoppedReason && stoppedReason !== 'unsupported' ? (error || '') : '';
        };

        for (const name of [
            'liveAnalysisStopped', 'liveAnalysisFinished', 'liveAnalysisRestored',
            'liveAnalysisMicState', 'liveAnalysisSaveState',
        ]) {
            eventBus.$on(name, this._sync);
        }
        eventBus.$on('liveAnalysisTimerTick', this._onTick);
        eventBus.$on('liveAnalysisUpdate', this._onUpdate);
        eventBus.$on('indexLoaded', this._onIndexLoaded);
        eventBus.$on('sessionAudioState', this._onAudioState);
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
        eventBus.$off('sessionAudioState', this._onAudioState);
    },
    methods: {
        formatSecondsAsClock,
        openCurrent() { eventBus.$emit('openCurrentSession'); },
        // Silences what is recorded without touching capture, so detection
        // carries on through the conversation the user is muting. The state
        // comes back from the service rather than being assumed: on a browser
        // that cannot clone the capture track there is nothing to mute, and
        // the bar must not claim otherwise.
        toggleAudioMute() {
            const applied = sessionRecorder.setMuted(!this.audioMuted);
            this.audioMuted = applied;
            this.audioMuteSupported = sessionRecorder.muteSupported;
            this.audioMutedSeconds = sessionRecorder.mutedSeconds;
        },
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
.session-name { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
