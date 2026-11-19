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
        // Opening reads the listener's list as it is NOW: updates that
        // arrived while the view was closed were not kept here.
        'liveView.open'(open) {
            if (open) this._refresh(liveAnalysisService.liveDetections);
        },
    },
    created() {
        // The live view's OWN list, fed whenever anything is listening —
        // never the session's, which a paused capture stops feeding.
        this._onUpdate = detections => this._refresh(detections);
        // The listener stopped under the view (the loop failed): a score with
        // no microphone behind it claims to follow something it cannot hear.
        this._onListeningStopped = () => { liveView.open = false; };
        eventBus.$on('liveViewUpdate', this._onUpdate);
        eventBus.$on('liveListeningStopped', this._onListeningStopped);
    },
    beforeDestroy() {
        eventBus.$off('liveViewUpdate', this._onUpdate);
        eventBus.$off('liveListeningStopped', this._onListeningStopped);
    },
    methods: {
        _refresh(detections) {
            this.detections = (detections || []).map(buildDetectionRow);
        },
        close() {
            return closeLiveView();
        },
        onSnackbar(visible) {
            if (!visible) liveView.error = '';
        },
    },
};
</script>
