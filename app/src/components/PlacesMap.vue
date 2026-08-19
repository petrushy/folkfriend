<template>
    <div
        class="placesMapWrapper"
        :class="{ 'placesMapWrapper--loading': !ready }"
    >
        <!-- NO :class ON THIS DIV. Leaflet writes its own classes straight onto
             the container element (leaflet-container, leaflet-touch, the
             fade/zoom-anim classes). A reactive class binding here makes Vue
             re-render the class attribute whenever the bound value changes,
             which silently strips all of them — `ready` flipping false→true was
             enough. The map still *looked* fine, because the panes Leaflet
             created underneath keep their own classes, but the container lost
             position/overflow and, critically, `touch-action: none`: pinch and
             drag on iOS, the whole reason for using Leaflet, quietly stopped
             working. State classes go on the wrapper instead. -->
        <div
            ref="map"
            class="placesMap"
        />
        <div
            v-if="!ready && !failed"
            class="placesMapOverlay"
        >
            Loading map…
        </div>
    </div>
</template>

<script>
// A real slippy map for the Places view.
//
// Leaflet is loaded lazily via js/leaflet.mjs, which keeps ~150 KB of mapping
// code out of the main bundle and lets a failure to fetch the chunk (offline,
// first visit) degrade to the tile-free scatter in Places.vue rather than
// breaking the view.
//
// Markers are L.circleMarker, which Leaflet draws as SVG. The default L.marker
// pulls PNG icons through webpack's asset pipeline, which is the single most
// common Leaflet-with-webpack breakage (marker-icon.png 404s at a hashed path).
// Circles also carry the count naturally, by area.
//
// Tiles are the one part of this app that genuinely cannot work offline the
// first time. The service worker caches them as they are viewed (see
// runtimeCaching in vue.config.js), so a place you have looked at before comes
// back on a plane; a place you have not, does not. When no tile loads at all,
// this emits `unavailable` and Places.vue falls back to the scatter — which
// always works, having no external dependency at all.

import { loadLeaflet, TILE_URL, TILE_ATTRIBUTION, TILE_MAX_ZOOM } from '@/js/leaflet.mjs';

// Enough consecutive failures with nothing loaded to call it: a single 404 on
// one tile at the edge of the world is not an outage.
const TILE_FAILURE_THRESHOLD = 4;

export default {
    name: 'PlacesMap',
    props: {
        groups: {
            type: Array,
            required: true,
        },
        // Highlighted marker, so tapping a card in the list moves the map.
        focusKey: {
            type: String,
            default: null,
        },
    },
    data() {
        return {
            ready: false,
            failed: false,
        };
    },
    watch: {
        groups() {
            this.drawMarkers();
        },
        focusKey(key) {
            this.focusOn(key);
        },
    },
    async mounted() {
        try {
            this.L = await loadLeaflet();
        } catch (e) {
            console.warn('Map library could not be loaded', e);
            this.failed = true;
            this.$emit('unavailable', 'library');
            return;
        }
        // The component can be torn down while the chunk is in flight.
        if (this._destroyed || !this.$refs.map) return;
        this.initMap();
    },
    beforeDestroy() {
        this._destroyed = true;
        if (this._map) {
            this._map.remove();
            this._map = null;
        }
    },
    methods: {
        initMap() {
            const L = this.L;
            this._map = L.map(this.$refs.map, {
                zoomControl: true,
                // The map sits inside a scrolling page on a phone. Grabbing the
                // wheel/two-finger scroll would trap the page; a deliberate
                // pinch or a double-tap still zooms.
                scrollWheelZoom: false,
                attributionControl: true,
            });

            this._tilesLoaded = 0;
            this._tileErrors = 0;

            const tiles = L.tileLayer(TILE_URL, {
                maxZoom: TILE_MAX_ZOOM,
                attribution: TILE_ATTRIBUTION,
            });
            tiles.on('tileload', () => {
                this._tilesLoaded++;
                if (!this.ready) this.ready = true;
            });
            tiles.on('tileerror', () => {
                this._tileErrors++;
                // Only a total failure counts. A map that drew last week's tiles
                // from the cache and cannot reach the server for the rest is
                // still a useful map.
                if (this._tilesLoaded === 0 && this._tileErrors >= TILE_FAILURE_THRESHOLD && !this.failed) {
                    this.failed = true;
                    this.$emit('unavailable', 'tiles');
                }
            });
            tiles.addTo(this._map);

            this._markerLayer = L.layerGroup().addTo(this._map);
            this.drawMarkers();
        },
        drawMarkers() {
            if (!this._map || !this._markerLayer) return;
            const L = this.L;
            this._markerLayer.clearLayers();
            this._markers = new Map();

            const points = this.groups.filter(g => Number.isFinite(g.lat) && Number.isFinite(g.lon));
            if (!points.length) return;

            const busiest = Math.max(...points.map(p => p.count), 1);

            for (const group of points) {
                // Area tracks the count — scaling the radius linearly makes a
                // busy place look wildly more dominant than it is.
                const radius = 6 + 10 * Math.sqrt(group.count / busiest);
                const marker = L.circleMarker([group.lat, group.lon], {
                    radius,
                    weight: 2,
                    color: '#055581',
                    // Unnamed places are hollow: they are a question the user
                    // has not answered yet, and the map is where they will
                    // notice it.
                    fillColor: group.place ? '#055581' : '#ffffff',
                    fillOpacity: group.place ? 0.55 : 0.85,
                });
                const label = group.place ? escapeHtml(group.place.name) : 'Unnamed location';
                marker.bindPopup(
                    `<strong>${label}</strong><br>` +
                        `${group.tuneCount} ${group.tuneCount === 1 ? 'tune' : 'tunes'}, ` +
                        `${group.count} ${group.count === 1 ? 'hearing' : 'hearings'}`
                );
                marker.on('click', () => this.$emit('select', group.key));
                marker.addTo(this._markerLayer);
                this._markers.set(group.key, marker);
            }

            const bounds = L.latLngBounds(points.map(p => [p.lat, p.lon]));
            // A single place has no extent, so fitBounds would zoom to maximum.
            if (points.length === 1) {
                this._map.setView([points[0].lat, points[0].lon], 15);
            } else {
                this._map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
            }

            // Tiles may never load (offline, nothing cached), and the map is
            // still usable for position — so readiness is not gated on them
            // forever.
            if (!this.ready) {
                setTimeout(() => { if (!this._destroyed) this.ready = true; }, 1500);
            }

            if (this.focusKey) this.focusOn(this.focusKey);
        },
        focusOn(key) {
            if (!this._map || !this._markers) return;
            const marker = this._markers.get(key);
            if (!marker) return;
            this._map.setView(marker.getLatLng(), Math.max(this._map.getZoom(), 15), { animate: true });
            marker.openPopup();
        },
        // Leaflet measures the container on creation; if the view was hidden or
        // resized since, it renders into stale dimensions until told otherwise.
        refresh() {
            if (this._map) this._map.invalidateSize();
        },
    },
};

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    }[ch]));
}
</script>

<style scoped>
.placesMapWrapper {
    position: relative;
}

.placesMap {
    width: 100%;
    height: 320px;
    border-radius: 4px;
    z-index: 0; /* keep tiles under Vuetify overlays and dialogs */
}

.placesMapWrapper--loading .placesMap {
    background: rgba(127, 127, 127, 0.12);
}

.placesMapOverlay {
    position: absolute;
    top: 50%;
    left: 0;
    right: 0;
    text-align: center;
    transform: translateY(-50%);
    font-size: 0.85rem;
    opacity: 0.7;
    pointer-events: none;
}
</style>
