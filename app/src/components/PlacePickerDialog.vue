<template>
    <v-dialog v-model="open" max-width="520" scrollable>
        <v-card class="pa-4">
            <h2 class="text-h6 mb-3">
                {{ editing ? 'Edit place' : 'Add a place' }}
            </h2>

            <v-text-field
                v-model="name"
                label="Name"
                placeholder="e.g. The Cobblestone"
                autofocus
                dense
                @keyup.enter="save"
            />

            <div class="pickerMapWrapper mb-1">
                <div ref="map" class="pickerMap" />
                <div v-if="mapFailed" class="pickerMapFallback">
                    <p class="mb-1">
                        Map unavailable offline.
                    </p>
                    <p class="mb-0 caption">
                        Use your current location, or type coordinates below.
                    </p>
                </div>
            </div>

            <p class="caption text--secondary mb-2">
                <span v-if="!mapFailed">Tap the map to move the pin. </span>
                <span v-if="hasPoint">{{ lat.toFixed(5) }}, {{ lon.toFixed(5) }}</span>
                <span v-else class="warning--text">No location chosen yet.</span>
            </p>

            <div class="d-flex flex-wrap mb-2" style="gap: 8px;">
                <v-btn small :loading="locating" @click="useCurrentLocation">
                    <v-icon left small>{{ icons.crosshairs }}</v-icon>
                    Use my location
                </v-btn>
                <v-btn small text @click="showCoordinateEntry = !showCoordinateEntry">
                    <v-icon left small>{{ icons.keyboard }}</v-icon>
                    Enter coordinates
                </v-btn>
            </div>

            <v-row v-if="showCoordinateEntry" dense class="mb-1">
                <v-col cols="6">
                    <v-text-field
                        v-model="latInput"
                        label="Latitude"
                        dense
                        hide-details
                        @change="applyTypedCoordinates"
                    />
                </v-col>
                <v-col cols="6">
                    <v-text-field
                        v-model="lonInput"
                        label="Longitude"
                        dense
                        hide-details
                        @change="applyTypedCoordinates"
                    />
                </v-col>
            </v-row>

            <v-slider
                v-model="radiusM"
                :min="25"
                :max="500"
                :step="25"
                label="Radius"
                thumb-label
                hide-details
                class="mt-3"
                @input="drawRadius"
            />
            <p class="caption text--secondary mt-1 mb-0">
                Hearings recorded within {{ radiusM }} m of the pin take this name, including
                ones already logged.
            </p>

            <p v-if="error" class="error--text mt-2 mb-0" style="font-size: 0.85rem;">
                {{ error }}
            </p>

            <div class="d-flex justify-end mt-3">
                <v-btn text @click="open = false">
                    Cancel
                </v-btn>
                <v-btn color="primary" :disabled="!canSave" @click="save">
                    Save
                </v-btn>
            </div>
        </v-card>
    </v-dialog>
</template>

<script>
// Creating a place anywhere, not only where the app happened to record one.
//
// Before this, a place could only come into existence by playing somewhere with
// geo-tagging on and then naming the cluster that produced. That covers the pub
// you were just in and nothing else — you could not set up the session you are
// going to on Tuesday, or fix a pin that landed in the car park.
//
// Three ways to choose a point, in the order people actually reach for them:
// tap the map, take a fix, or type coordinates. The last exists because the map
// needs tiles and tiles need a network: offline, with no cached tiles, the first
// two are all that is left and typing must still work.
//
// The radius is drawn as a live circle rather than being a number on a slider,
// because it is the setting that decides which past hearings the new name
// adopts — and 150 m means nothing until you see it over a street.

import { mdiCrosshairsGps, mdiKeyboard } from '@mdi/js';
import geoService from '@/services/geo.js';
import { loadLeaflet, TILE_URL, TILE_ATTRIBUTION, TILE_MAX_ZOOM } from '@/js/leaflet.mjs';
import { DEFAULT_PLACE_RADIUS_M } from '@/js/places.mjs';

// Where the map opens when there is nothing at all to centre on: no existing
// places, no location permission, no starting point. Zoomed right out, because
// any guess at a country would be wrong more often than not.
const WORLD_VIEW = { lat: 20, lon: 0, zoom: 2 };

export default {
    name: 'PlacePickerDialog',
    props: {
        value: { type: Boolean, default: false },
        // An existing place to edit, or null to create a new one.
        place: { type: Object, default: null },
        // Starting point for a new place — normally an unnamed cluster's centre.
        start: { type: Object, default: null },
        // Other places, drawn faintly for context so the user does not
        // unknowingly create one overlapping another.
        otherPlaces: { type: Array, default: () => [] },
    },
    data() {
        return {
            name: '',
            lat: null,
            lon: null,
            radiusM: DEFAULT_PLACE_RADIUS_M,
            latInput: '',
            lonInput: '',
            showCoordinateEntry: false,
            locating: false,
            mapFailed: false,
            error: null,
            icons: {
                crosshairs: mdiCrosshairsGps,
                keyboard: mdiKeyboard,
            },
        };
    },
    computed: {
        open: {
            get() { return this.value; },
            set(v) { this.$emit('input', v); },
        },
        editing() { return !!this.place; },
        hasPoint() { return Number.isFinite(this.lat) && Number.isFinite(this.lon); },
        canSave() { return !!this.name.trim() && this.hasPoint; },
    },
    watch: {
        value(isOpen) {
            if (isOpen) this.onOpen();
            else this.teardownMap();
        },
    },
    beforeDestroy() {
        this.teardownMap();
    },
    methods: {
        onOpen() {
            this.error = null;
            this.showCoordinateEntry = false;
            const source = this.place || this.start || {};
            this.name = this.place ? this.place.name : '';
            this.lat = Number.isFinite(source.lat) ? source.lat : null;
            this.lon = Number.isFinite(source.lon) ? source.lon : null;
            this.radiusM = (this.place && this.place.radiusM) || DEFAULT_PLACE_RADIUS_M;
            this.syncInputs();

            // A brand new place with no starting point: offer the last known fix
            // rather than making the user hunt for themselves on a world map.
            // peekFix, not getFix — opening a dialog must not spin the radio or
            // raise a permission prompt the user did not ask for.
            if (!this.hasPoint) {
                const known = geoService.peekFix();
                if (known) {
                    this.lat = known.lat;
                    this.lon = known.lon;
                    this.syncInputs();
                }
            }

            // The dialog's DOM does not exist until Vuetify has rendered it, and
            // Leaflet measures its container on creation.
            this.$nextTick(() => this.initMap());
        },
        syncInputs() {
            this.latInput = this.hasPoint ? String(this.lat) : '';
            this.lonInput = this.hasPoint ? String(this.lon) : '';
        },
        async initMap() {
            if (!this.$refs.map || this._map) return;
            let L;
            try {
                L = await loadLeaflet();
            } catch (e) {
                this.mapFailed = true;
                // Typing coordinates is the only route left, so open it.
                this.showCoordinateEntry = true;
                return;
            }
            this.L = L;
            if (!this.$refs.map || !this.open) return;

            const map = L.map(this.$refs.map, { zoomControl: true, scrollWheelZoom: false });
            this._map = map;

            let tileErrors = 0;
            const tiles = L.tileLayer(TILE_URL, {
                maxZoom: TILE_MAX_ZOOM,
                attribution: TILE_ATTRIBUTION,
            });
            let tilesLoaded = 0;
            tiles.on('tileload', () => { tilesLoaded++; });
            tiles.on('tileerror', () => {
                tileErrors++;
                // Same rule as PlacesMap: only a total failure counts, and the
                // pin still works over a blank background, so this only opens
                // the typed fallback rather than hiding the map.
                if (tilesLoaded === 0 && tileErrors >= 4) {
                    this.mapFailed = true;
                    this.showCoordinateEntry = true;
                }
            });
            tiles.addTo(map);

            // Existing places, faint, for context.
            for (const other of this.otherPlaces) {
                if (this.place && other.id === this.place.id) continue;
                if (!Number.isFinite(other.lat) || !Number.isFinite(other.lon)) continue;
                L.circleMarker([other.lat, other.lon], {
                    radius: 5, weight: 1, color: '#888', fillColor: '#888', fillOpacity: 0.35,
                }).bindTooltip(other.name).addTo(map);
            }

            map.on('click', (e) => {
                this.lat = e.latlng.lat;
                this.lon = e.latlng.lng;
                this.syncInputs();
                this.drawPin();
            });

            if (this.hasPoint) {
                map.setView([this.lat, this.lon], 16);
            } else {
                map.setView([WORLD_VIEW.lat, WORLD_VIEW.lon], WORLD_VIEW.zoom);
            }
            this.drawPin();
            // Vuetify animates the dialog in, so the container is still resizing
            // when Leaflet first measures it.
            setTimeout(() => { if (this._map) this._map.invalidateSize(); }, 250);
        },
        drawPin() {
            if (!this._map || !this.hasPoint) return;
            const L = this.L;
            if (!this._pin) {
                this._pin = L.circleMarker([this.lat, this.lon], {
                    radius: 7, weight: 2, color: '#055581', fillColor: '#055581', fillOpacity: 0.9,
                }).addTo(this._map);
            } else {
                this._pin.setLatLng([this.lat, this.lon]);
            }
            this.drawRadius();
        },
        drawRadius() {
            if (!this._map || !this.hasPoint) return;
            const L = this.L;
            if (!this._circle) {
                this._circle = L.circle([this.lat, this.lon], {
                    radius: this.radiusM, weight: 1, color: '#055581', fillOpacity: 0.08,
                }).addTo(this._map);
            } else {
                this._circle.setLatLng([this.lat, this.lon]);
                this._circle.setRadius(this.radiusM);
            }
        },
        async useCurrentLocation() {
            this.error = null;
            this.locating = true;
            try {
                // A deliberate tap, so this is the right moment for the OS
                // prompt — and a previous refusal must not make the button
                // permanently inert.
                const result = await geoService.requestPermission();
                if (!result.ok) {
                    this.error = `${result.error} Tap the map or type coordinates instead.`;
                    this.showCoordinateEntry = true;
                    return;
                }
                this.lat = result.fix.lat;
                this.lon = result.fix.lon;
                this.syncInputs();
                if (this._map) this._map.setView([this.lat, this.lon], 16);
                this.drawPin();
            } finally {
                this.locating = false;
            }
        },
        applyTypedCoordinates() {
            const lat = Number(this.latInput);
            const lon = Number(this.lonInput);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
                Math.abs(lat) > 90 || Math.abs(lon) > 180) {
                this.error = 'Latitude must be between -90 and 90, longitude between -180 and 180.';
                return;
            }
            this.error = null;
            this.lat = lat;
            this.lon = lon;
            if (this._map) this._map.setView([lat, lon], 16);
            this.drawPin();
        },
        save() {
            if (!this.canSave) return;
            this.$emit('save', {
                id: this.place ? this.place.id : null,
                name: this.name.trim(),
                lat: this.lat,
                lon: this.lon,
                radiusM: this.radiusM,
            });
            this.open = false;
        },
        teardownMap() {
            if (this._map) {
                this._map.remove();
                this._map = null;
            }
            this._pin = null;
            this._circle = null;
            this.mapFailed = false;
        },
    },
};
</script>

<style scoped>
.pickerMapWrapper {
    position: relative;
}

/* No :class binding on .pickerMap — Leaflet writes its own classes onto the
   container and a reactive binding would strip them, silently killing pinch and
   drag on iOS. See the note in PlacesMap.vue. */
.pickerMap {
    width: 100%;
    height: 240px;
    border-radius: 4px;
    background: rgba(127, 127, 127, 0.12);
    z-index: 0;
}

.pickerMapFallback {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    background: rgba(127, 127, 127, 0.12);
    border-radius: 4px;
}
</style>
