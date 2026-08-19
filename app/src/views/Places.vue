<template>
    <v-container class="viewContainerWrapper">
        <h1 class="my-2">
            Places
        </h1>

        <v-card v-if="!enabled" class="pa-5 my-3">
            <p class="mb-2">
                Recording where you hear tunes is switched off.
            </p>
            <p class="text--secondary mb-4" style="font-size: 0.9rem;">
                When it is on, FolkFriend notes roughly where each tune was recognised, so you can
                see which session you learned something at. It takes one location fix when a
                listening session starts — not a continuous track — so the battery cost is
                negligible next to running the microphone.
            </p>
            <v-btn color="primary" to="/settings">
                Open Settings
            </v-btn>
        </v-card>

        <v-card v-else-if="!groups.length" class="pa-5 my-3">
            <p class="mb-0">
                Nothing recorded yet. Start a live session or search for a tune, and the places
                you hear tunes in will collect here.
            </p>
        </v-card>

        <template v-else>
            <!-- A tile-free scatter: no basemap, because a map service would mean a
                 network request on every pan and this app is built to work in a cellar
                 with no signal. Shape and grouping are real; absolute geography is not. -->
            <v-card v-if="mapPoints.length > 1" class="pa-3 my-3">
                <svg class="miniMap" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <circle
                        v-for="point in mapPoints"
                        :key="point.key"
                        :cx="point.x * 100"
                        :cy="point.y * 100"
                        :r="point.radius"
                        :class="point.named ? 'miniMapDot miniMapDot--named' : 'miniMapDot'"
                    />
                </svg>
                <p class="text--secondary mb-0 mt-2" style="font-size: 0.78rem;">
                    Relative positions only — larger dots are places you have heard more tunes.
                </p>
            </v-card>

            <v-card
                v-for="group in groups"
                :key="group.key"
                class="pa-4 my-2"
            >
                <div class="d-flex align-center">
                    <div class="flex-grow-1" style="min-width: 0;">
                        <h2 class="text-h6 mb-1">
                            <v-icon left small>{{ group.place ? icons.mapMarker : icons.mapMarkerQuestion }}</v-icon>
                            {{ group.place ? group.place.name : 'Unnamed location' }}
                        </h2>
                        <p class="text--secondary mb-0" style="font-size: 0.85rem;">
                            {{ group.tuneCount }} {{ group.tuneCount === 1 ? 'tune' : 'tunes' }},
                            {{ group.count }} {{ group.count === 1 ? 'hearing' : 'hearings' }} ·
                            last {{ formatDate(group.lastSeen) }}
                        </p>
                    </div>
                    <v-btn icon :title="group.place ? 'Rename' : 'Name this place'" @click="openNameDialog(group)">
                        <v-icon>{{ group.place ? icons.pencil : icons.tagPlus }}</v-icon>
                    </v-btn>
                    <v-btn icon :title="group.expanded ? 'Hide tunes' : 'Show tunes'" @click="toggle(group)">
                        <v-icon>{{ group.expanded ? icons.chevronUp : icons.chevronDown }}</v-icon>
                    </v-btn>
                </div>

                <v-list v-if="group.expanded" dense class="mt-2">
                    <v-list-item
                        v-for="tune in group.tunes"
                        :key="tune.tuneID"
                        class="px-0"
                        @click="openTune(tune)"
                    >
                        <v-list-item-content>
                            <v-list-item-title>{{ tune.displayName || `Tune ${tune.tuneID}` }}</v-list-item-title>
                            <v-list-item-subtitle>
                                heard {{ tune.count }}×, last {{ formatDate(tune.lastSeen) }}
                            </v-list-item-subtitle>
                        </v-list-item-content>
                    </v-list-item>
                </v-list>

                <div v-if="group.expanded && group.place" class="mt-2">
                    <v-btn small text color="error" @click="confirmDeletePlace(group.place)">
                        <v-icon left small>{{ icons.delete }}</v-icon>
                        Forget this name
                    </v-btn>
                    <span class="text--secondary" style="font-size: 0.78rem;">
                        The tunes stay; only the name is removed.
                    </span>
                </div>
            </v-card>

            <v-btn class="mt-4" @click="confirmClear">
                <v-icon left>{{ icons.delete }}</v-icon>
                Clear all places
            </v-btn>
        </template>

        <v-dialog v-model="nameDialog" max-width="420">
            <v-card class="pa-4">
                <h2 class="text-h6 mb-3">
                    {{ editing && editing.place ? 'Rename place' : 'Name this place' }}
                </h2>
                <v-text-field
                    v-model="nameInput"
                    label="Name"
                    placeholder="e.g. The Cobblestone"
                    autofocus
                    @keyup.enter="savePlace"
                />
                <p class="text--secondary" style="font-size: 0.82rem;">
                    Every hearing recorded within {{ radiusInput }} m of here takes this name,
                    including the ones already logged.
                </p>
                <v-slider
                    v-model="radiusInput"
                    :min="25"
                    :max="500"
                    :step="25"
                    label="Radius"
                    thumb-label
                    class="mt-2"
                />
                <div class="d-flex justify-end">
                    <v-btn text @click="nameDialog = false">
                        Cancel
                    </v-btn>
                    <v-btn color="primary" :disabled="!nameInput.trim()" @click="savePlace">
                        Save
                    </v-btn>
                </div>
            </v-card>
        </v-dialog>

        <v-snackbar v-model="snackbar" :timeout="4000">
            {{ snackbarText }}
        </v-snackbar>
    </v-container>
</template>

<script>
import {
    mdiChevronDown,
    mdiChevronUp,
    mdiDelete,
    mdiMapMarker,
    mdiMapMarkerQuestion,
    mdiPencil,
    mdiTagPlus,
} from '@mdi/js';
import eventBus from '@/eventBus';
import store from '@/services/store';
import router from '@/router/index.js';
import {
    groupSightingsByPlace,
    projectPoints,
    DEFAULT_PLACE_RADIUS_M,
} from '@/js/places.mjs';

export default {
    name: 'PlacesView',
    data() {
        return {
            groups: [],
            enabled: false,
            nameDialog: false,
            editing: null,
            nameInput: '',
            radiusInput: DEFAULT_PLACE_RADIUS_M,
            snackbar: false,
            snackbarText: '',
            icons: {
                chevronDown: mdiChevronDown,
                chevronUp: mdiChevronUp,
                delete: mdiDelete,
                mapMarker: mdiMapMarker,
                mapMarkerQuestion: mdiMapMarkerQuestion,
                pencil: mdiPencil,
                tagPlus: mdiTagPlus,
            },
        };
    },
    computed: {
        mapPoints() {
            const projected = projectPoints(this.groups.filter(g => g.lat != null));
            if (!projected) return [];
            const busiest = Math.max(...projected.map(p => p.count), 1);
            return projected.map(point => ({
                key: point.key,
                x: point.x,
                y: point.y,
                named: !!point.place,
                // Area, not radius, tracks the count — a radius-linear scale
                // makes a busy place look wildly more dominant than it is.
                radius: 1.6 + 3.4 * Math.sqrt(point.count / busiest),
            }));
        },
    },
    created() {
        eventBus.$emit('parentViewActivated');
        this.enabled = !!store.userSettings.geoTagDetections;
        this._onSightingsChanged = () => this.load();
        eventBus.$on('sightingsChanged', this._onSightingsChanged);
        this.load();
    },
    beforeDestroy() {
        eventBus.$off('sightingsChanged', this._onSightingsChanged);
    },
    methods: {
        async load() {
            const [sightings, places] = await Promise.all([
                store.getSightings(),
                store.getPlaces(),
            ]);
            // Expansion state is per-render, so preserve what the user opened
            // rather than collapsing everything whenever a sighting lands.
            const openKeys = new Set(this.groups.filter(g => g.expanded).map(g => g.key));
            this.groups = groupSightingsByPlace(sightings, places).map(group => {
                const key = group.place ? group.place.id : `unnamed-${group.lat}-${group.lon}`;
                return {
                    ...group,
                    key,
                    expanded: openKeys.has(key),
                    tunes: summariseTunes(group.sightings),
                    // Named places have their own centre; unnamed clusters
                    // carry their leader's coordinates.
                    lat: group.place ? group.place.lat : group.lat,
                    lon: group.place ? group.place.lon : group.lon,
                };
            });
        },
        toggle(group) {
            group.expanded = !group.expanded;
        },
        formatDate(millis) {
            if (!millis) return 'unknown';
            return new Date(millis).toLocaleDateString(undefined, {
                year: 'numeric', month: 'short', day: 'numeric',
            });
        },
        openTune(tune) {
            router.push({
                name: 'tune',
                query: {
                    tuneID: tune.tuneID,
                    displayName: tune.displayName || '',
                    settingID: tune.settingID || '',
                },
            });
        },
        openNameDialog(group) {
            this.editing = group;
            this.nameInput = group.place ? group.place.name : '';
            this.radiusInput = group.place && group.place.radiusM
                ? group.place.radiusM
                : DEFAULT_PLACE_RADIUS_M;
            this.nameDialog = true;
        },
        async savePlace() {
            const group = this.editing;
            if (!group || !this.nameInput.trim()) return;
            const place = await store.namePlace({
                id: group.place ? group.place.id : null,
                name: this.nameInput,
                lat: group.lat,
                lon: group.lon,
                radiusM: this.radiusInput,
            });
            this.nameDialog = false;
            this.editing = null;
            if (!place) {
                this.notify('That location could not be saved.');
                return;
            }
            await this.load();
        },
        async confirmDeletePlace(place) {
            if (!window.confirm(`Forget the name "${place.name}"? The tunes heard there are kept.`)) return;
            await store.deletePlace(place.id);
            await this.load();
        },
        async confirmClear() {
            if (!window.confirm('Delete every recorded place and hearing? This cannot be undone.')) return;
            await store.clearSightings();
            await this.load();
        },
        notify(text) {
            this.snackbarText = text;
            this.snackbar = true;
        },
    },
};

// Collapses a place's sightings into one row per tune, most recent first.
function summariseTunes(sightings) {
    const byTune = new Map();
    for (const sighting of sightings) {
        const key = String(sighting.tuneID);
        const existing = byTune.get(key);
        if (existing) {
            existing.count++;
            if (sighting.timestamp > existing.lastSeen) {
                existing.lastSeen = sighting.timestamp;
                // Keep the most recent naming and setting — display names drift
                // as the index is updated.
                if (sighting.displayName) existing.displayName = sighting.displayName;
                if (sighting.settingID) existing.settingID = sighting.settingID;
            }
        } else {
            byTune.set(key, {
                tuneID: key,
                displayName: sighting.displayName || '',
                settingID: sighting.settingID || '',
                count: 1,
                lastSeen: sighting.timestamp || 0,
            });
        }
    }
    return [...byTune.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}
</script>

<style scoped>
.miniMap {
    width: 100%;
    height: 160px;
    display: block;
}

.miniMapDot {
    fill: var(--v-primary-base, #1976d2);
    opacity: 0.45;
}

.miniMapDot--named {
    opacity: 0.9;
}
</style>
