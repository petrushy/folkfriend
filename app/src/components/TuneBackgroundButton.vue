<template>
    <v-btn
        v-if="enabled"
        icon
        :small="small"
        :x-small="xSmall"
        aria-label="Tune background"
        title="Tune background"
        @click.stop="openBackground"
    >
        <v-icon :small="xSmall" color="grey darken-1">{{ infoIcon }}</v-icon>
    </v-btn>
</template>

<script>
// The (i) button. Trivial on its own, but it exists as a component so the
// aiSummariesEnabled gate, the icon, and the event payload are defined once
// instead of four times — the button now appears on the Tune view, in search
// results, in the favourites list, and in the live session follow view.
//
// It opens the single app-level TuneBackgroundDialog via the event bus rather
// than owning a dialog itself; see that component for why.
import eventBus from '@/eventBus.js';
import store from '@/services/store.js';
import { mdiInformationOutline } from '@mdi/js';

export default {
    name: 'TuneBackgroundButton',
    props: {
        tuneID: { type: [String, Number], default: '' },
        displayName: { type: String, default: '' },
        // Only meaningful for folkwiki tunes, where the URL cannot be derived
        // from the tune ID. Harmless to omit.
        sourceUrl: { type: String, default: '' },
        small: { type: Boolean, default: true },
        xSmall: { type: Boolean, default: false },
    },
    data: () => ({
        userSettings: store.userSettings,
        infoIcon: mdiInformationOutline,
    }),
    computed: {
        enabled() {
            return Boolean(this.userSettings.aiSummariesEnabled) && Boolean(this.tuneID);
        },
    },
    methods: {
        openBackground() {
            eventBus.$emit('showTuneBackground', {
                tuneID: this.tuneID,
                displayName: this.displayName,
                sourceUrl: this.sourceUrl,
                title: this.displayName,
            });
        },
    },
};
</script>
