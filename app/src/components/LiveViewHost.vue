<template>
    <div>
        <!-- The ONE live view, mounted for the life of the app so it can be
             opened from any page and survives navigation underneath it.
             See services/liveView.js. -->
        <LiveScoreFollow
            v-if="liveView.open"
            :detections="detections"
            @close="close"
        />
        <v-snackbar :value="!!liveView.error" :timeout="8000" bottom @input="onSnackbar">
            {{ liveView.error }}
            <template #action="{ attrs }">
                <v-btn text small v-bind="attrs" @click="openSessionTools">Session Tools</v-btn>
            </template>
        </v-snackbar>
    </div>
</template>

<script>
import eventBus from '@/eventBus.js';
import liveAnalysisService from '@/services/liveAnalysis.js';
import LiveScoreFollow from '@/components/LiveScoreFollow.vue';
import { liveView, closeLiveView } from '@/services/liveView.js';
import { buildDetectionRow } from '@/js/sessionAnalysis.js';

export default {
    name: 'LiveViewHost',
    components: { LiveScoreFollow },
    data: () => ({
        liveView,
        detections: [],
    }),
    watch: {
        // Opening reads the service's list as it is NOW: the update events
        // that arrived while the view was closed were not kept.
        'liveView.open'(open) {
            if (open) this._refresh(liveAnalysisService.detections);
        },
    },
    created() {
        this._onUpdate = detections => this._refresh(detections);
        // A score with no microphone behind it claims to be following
        // something it cannot hear: Pause closes it, as it always has.
        this._onStopped = () => closeLiveView();
        this._onFinished = () => { this.detections = []; };
        eventBus.$on('liveAnalysisUpdate', this._onUpdate);
        eventBus.$on('liveAnalysisRestored', this._onUpdate);
        eventBus.$on('liveAnalysisStopped', this._onStopped);
        eventBus.$on('liveAnalysisFinished', this._onFinished);
    },
    beforeDestroy() {
        eventBus.$off('liveAnalysisUpdate', this._onUpdate);
        eventBus.$off('liveAnalysisRestored', this._onUpdate);
        eventBus.$off('liveAnalysisStopped', this._onStopped);
        eventBus.$off('liveAnalysisFinished', this._onFinished);
    },
    methods: {
        _refresh(detections) {
            this.detections = (detections || []).map(buildDetectionRow);
        },
        close() {
            closeLiveView();
        },
        onSnackbar(visible) {
            if (!visible) liveView.error = '';
        },
        openSessionTools() {
            liveView.error = '';
            if (this.$route && this.$route.name === 'session-analysis') return;
            this.$router.push({ name: 'session-analysis', query: { live: '1' } }).catch(() => {});
        },
    },
};
</script>
