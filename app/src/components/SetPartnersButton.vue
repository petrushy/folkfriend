<template>
    <span v-if="available" class="setPartnersButton">
        <v-chip
            v-if="chip"
            small
            class="px-2"
            title="Tunes commonly played in a set with this one"
            @click.stop="openPartners"
        >
            <v-icon small left>{{ icon }}</v-icon>
            Played in sets with
        </v-chip>
        <v-btn
            v-else
            icon
            small
            aria-label="Tunes commonly played in a set with this one"
            title="Tunes commonly played in a set with this one — what to play next"
            @click.stop="openPartners"
        >
            <v-icon color="grey darken-1">{{ icon }}</v-icon>
        </v-btn>
    </span>
</template>

<script>
// Opens the single app-level SetPartnersDialog (mounted in App.vue) via the
// event bus — the same split as TuneBackgroundButton / TuneBackgroundDialog.
//
// It shows itself only for a tune that HAS set partners, which in practice
// means a thesession tune once a dataset carrying `sets` is loaded. Offering a
// button that opens an empty list on every folkwiki tune would teach people
// to ignore it.
import eventBus from '@/eventBus.js';
import ffBackend from '@/services/backend.js';
import { mdiPlaylistMusic } from '@mdi/js';

export default {
    name: 'SetPartnersButton',
    props: {
        tuneID: { type: [String, Number], default: '' },
        title: { type: String, default: '' },
        // A labelled chip (Tune view) or a bare icon (the follow header).
        chip: { type: Boolean, default: false },
    },
    data: () => ({
        available: false,
        icon: mdiPlaylistMusic,
    }),
    watch: {
        tuneID: { immediate: true, handler: 'checkAvailable' },
    },
    created() {
        // The index may still be loading when the view mounts.
        this._onIndexLoaded = () => this.checkAvailable();
        eventBus.$on('indexLoaded', this._onIndexLoaded);
    },
    beforeDestroy() {
        eventBus.$off('indexLoaded', this._onIndexLoaded);
    },
    methods: {
        async checkAvailable() {
            const asked = String(this.tuneID || '');
            if (!asked) { this.available = false; return; }
            let partners = [];
            try {
                partners = await ffBackend.setPartnersFromTuneID(asked);
            } catch (e) {
                partners = [];
            }
            // A slower answer for the previous tune must not decide this one.
            if (String(this.tuneID || '') !== asked) return;
            this.available = Array.isArray(partners) && partners.length > 0;
        },
        openPartners() {
            eventBus.$emit('showSetPartners', {
                tuneID: String(this.tuneID),
                title: this.title,
            });
        },
    },
};
</script>

<style scoped>
.setPartnersButton {
    display: inline-block;
}
</style>
