<template>
    <v-dialog v-model="open" max-width="420">
        <v-card class="pa-4">
            <h2 class="text-h6 mb-1">
                Where did you hear this?
            </h2>
            <p class="text--secondary mb-4" style="font-size: 0.85rem;">
                {{ displayName || 'This tune' }}
            </p>

            <v-btn
                block
                color="primary"
                class="mb-4"
                :loading="locating"
                :disabled="busy"
                @click="addHere"
            >
                <v-icon left>{{ icons.crosshairs }}</v-icon>
                I'm here now
            </v-btn>

            <template v-if="places.length">
                <p class="caption text--secondary mb-1">
                    Or pick a place you have named:
                </p>
                <v-list dense class="placeList">
                    <v-list-item
                        v-for="place in places"
                        :key="place.id"
                        :disabled="busy"
                        @click="addAt(place)"
                    >
                        <v-list-item-icon class="mr-2">
                            <v-icon small>{{ alreadyAt(place.id) ? icons.check : icons.mapMarker }}</v-icon>
                        </v-list-item-icon>
                        <v-list-item-content>
                            <v-list-item-title>{{ place.name }}</v-list-item-title>
                            <v-list-item-subtitle v-if="alreadyAt(place.id)">
                                already recorded here
                            </v-list-item-subtitle>
                        </v-list-item-content>
                    </v-list-item>
                </v-list>
            </template>
            <p v-else class="caption text--secondary mb-0">
                You have not named any places yet. Record a tune somewhere, then name the
                spot on the Places screen — after that it will be offered here.
            </p>

            <p v-if="error" class="error--text mt-3 mb-0" style="font-size: 0.85rem;">
                {{ error }}
            </p>

            <div class="d-flex justify-end mt-3">
                <v-btn text :disabled="busy" @click="open = false">
                    Close
                </v-btn>
            </div>
        </v-card>
    </v-dialog>
</template>

<script>
// Manual "I heard this here" tagging.
//
// It exists because automatic capture has two failure modes that no amount of
// tuning fixes: the detector sometimes gets the tune wrong, and it never sees
// the tunes played while the app was in a pocket. Without this, the log can only
// ever be a subset of a session, and a wrong entry is permanent.
//
// Two ways in, deliberately. "I'm here now" is for the pub, and takes a fix.
// Picking a named place is for afterwards, on the sofa, where a fix would be
// both unavailable and actively wrong — which is exactly the mistake that made
// sightings a separate log rather than a field on favourites in the first place.

import { mdiCheck, mdiCrosshairsGps, mdiMapMarker } from '@mdi/js';
import store from '@/services/store.js';
import geoService from '@/services/geo.js';

export default {
    name: 'TunePlaceDialog',
    props: {
        value: { type: Boolean, default: false },
        tuneID: { type: [String, Number], required: true },
        settingID: { type: [String, Number], default: null },
        displayName: { type: String, default: '' },
    },
    data() {
        return {
            places: [],
            taggedPlaceIDs: [],
            locating: false,
            saving: false,
            error: null,
            icons: {
                check: mdiCheck,
                crosshairs: mdiCrosshairsGps,
                mapMarker: mdiMapMarker,
            },
        };
    },
    computed: {
        open: {
            get() { return this.value; },
            set(v) { this.$emit('input', v); },
        },
        busy() { return this.locating || this.saving; },
    },
    watch: {
        value(isOpen) {
            if (isOpen) this.load();
        },
    },
    methods: {
        async load() {
            this.error = null;
            const [places, sightings] = await Promise.all([
                store.getPlaces(),
                store.getSightings(),
            ]);
            this.places = places;
            this.taggedPlaceIDs = sightings
                .filter(s => String(s.tuneID) === String(this.tuneID) && s.placeID)
                .map(s => s.placeID);
        },
        alreadyAt(placeID) {
            return this.taggedPlaceIDs.includes(placeID);
        },
        async addHere() {
            this.error = null;
            this.locating = true;
            try {
                // requestPermission rather than getFix: this is a deliberate tap,
                // so it is the right moment to raise the OS prompt, and a
                // previous refusal should not silently make the button do
                // nothing forever.
                const result = await geoService.requestPermission();
                if (!result.ok) {
                    this.error = `${result.error} You can still pick a named place below.`;
                    return;
                }
                await this.record({ fix: result.fix });
            } finally {
                this.locating = false;
            }
        },
        async addAt(place) {
            this.error = null;
            await this.record({ placeID: place.id });
        },
        async record(where) {
            this.saving = true;
            try {
                const sighting = await store.addSighting({
                    tuneID: this.tuneID,
                    settingID: this.settingID,
                    displayName: this.displayName,
                    source: 'manual',
                    ...where,
                });
                if (!sighting) {
                    this.error = 'Could not save that.';
                    return;
                }
                this.$emit('added', sighting);
                this.open = false;
            } finally {
                this.saving = false;
            }
        },
    },
};
</script>

<style scoped>
.placeList {
    max-height: 240px;
    overflow-y: auto;
}
</style>
