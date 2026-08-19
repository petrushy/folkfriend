<template>
    <v-container class="viewContainerWrapper">
        <div class="d-flex align-center my-2">
            <h1>Favourites</h1>
            <v-spacer />
            <v-select
                v-model="sortBy"
                :items="sortOptions"
                dense
                hide-details
                style="max-width: 130px;"
                class="mr-2 caption"
                :prepend-icon="icons.sort"
            />
            <v-btn icon small :color="groupBy ? 'primary' : ''" :title="groupByLabel" @click="cycleGroupBy">
                <v-icon small>{{ groupByIcon }}</v-icon>
            </v-btn>
            <v-menu offset-y left :disabled="selectedIDs.size === 0">
                <template #activator="{ on }">
                    <v-btn icon small :color="selectedIDs.size > 0 ? 'primary' : ''" :disabled="selectedIDs.size === 0" title="Share selected" v-on="on">
                        <v-icon small>{{ icons.export }}</v-icon>
                    </v-btn>
                </template>
                <v-list dense>
                    <v-list-item @click="shareFavourites('html')">
                        <v-list-item-title>Share with scores (HTML)</v-list-item-title>
                    </v-list-item>
                    <v-list-item @click="shareFavourites('text')">
                        <v-list-item-title>Share as text</v-list-item-title>
                    </v-list-item>
                </v-list>
            </v-menu>
        </div>

        <!-- Place filter bar. Only appears once geo-tagging has produced places
             that actually contain favourites, so it costs nothing for anyone not
             using the feature. -->
        <div v-if="placeFilterOptions.length > 0" class="tag-filter-bar mb-3">
            <div class="d-flex flex-wrap align-center" style="gap:6px">
                <span class="caption grey--text mr-1">
                    <v-icon x-small class="pb-1">{{ icons.mapMarker }}</v-icon>
                    Heard at:
                </span>
                <v-chip
                    v-for="place in placeFilterOptions"
                    :key="place.id"
                    small
                    :color="activePlaceIDs.includes(place.id) ? 'primary' : undefined"
                    :outlined="!activePlaceIDs.includes(place.id)"
                    @click="toggleActivePlace(place.id)"
                >{{ place.name }} <span class="pl-1 caption">{{ place.matchCount }}</span></v-chip>
                <v-btn v-if="activePlaceIDs.length > 0" x-small text @click="activePlaceIDs = []">Clear</v-btn>
                <v-spacer />
                <v-btn x-small text color="grey" to="/places">Manage places</v-btn>
            </div>
        </div>

        <!-- Tag filter bar -->
        <div v-if="allTags.length > 0" class="tag-filter-bar mb-3">
            <div class="d-flex flex-wrap align-center" style="gap:6px">
                <span class="caption grey--text mr-1">Filter:</span>
                <v-chip
                    v-for="tag in allTags"
                    :key="tag"
                    small
                    :color="activeTags.includes(tag) ? 'primary' : undefined"
                    :outlined="!activeTags.includes(tag)"
                    @click="toggleActiveTag(tag)"
                    @click.right.prevent="openTagMenu(tag, $event)"
                >{{ tag }}</v-chip>
                <v-btn v-if="activeTags.length > 0" x-small text @click="activeTags = []">Clear</v-btn>
                <v-spacer />
                <v-btn x-small text color="grey" @click="manageTagsDialog = true">Manage tags</v-btn>
            </div>
        </div>

        <!-- Select all + name filter bar -->
        <div v-if="favouriteItems.length > 0" class="d-flex align-center px-2 py-1 select-all-bar">
            <v-checkbox
                :input-value="allVisibleSelected"
                :indeterminate="someVisibleSelected && !allVisibleSelected"
                class="ml-2 mr-1 mt-0 pt-0 flex-grow-0"
                hide-details
                @change="toggleSelectAll"
            />
            <span class="caption grey--text text--darken-1 flex-shrink-0">
                {{ allVisibleSelected ? 'Deselect all' : 'Select all' }}
                <template v-if="selectedIDs.size > 0">({{ selectedIDs.size }})</template>
            </span>
            <v-menu
                v-model="bulkTagMenu"
                :close-on-content-click="false"
                offset-y
                :disabled="selectedIDs.size === 0"
            >
                <template #activator="{ on }">
                    <v-btn
                        icon
                        small
                        :color="selectedIDs.size > 0 ? 'primary' : 'grey lighten-1'"
                        :disabled="selectedIDs.size === 0"
                        class="ml-2"
                        title="Add tag to selected"
                        v-on="on"
                    >
                        <v-icon small>{{ icons.tagPlus }}</v-icon>
                    </v-btn>
                </template>
                <v-card width="220" @click.stop>
                    <v-combobox
                        v-model="bulkTagInput"
                        :items="allTags"
                        label="Add tag to selected"
                        dense
                        solo
                        flat
                        hide-details
                        autofocus
                        class="px-2 pt-1 pb-1"
                        @change="onBulkTagSelected"
                        @keydown.esc.stop="bulkTagMenu = false"
                    />
                </v-card>
            </v-menu>
            <v-text-field
                v-model="nameFilter"
                placeholder="Search by name…"
                dense
                hide-details
                clearable
                class="ml-3"
            />
        </div>

        <!-- Flat list view -->
        <template v-if="!groupBy">
            <v-list v-if="allRows.length > 0" class="resultsTable">
                <FavouriteRow
                    v-for="row in allRows"
                    :key="row.settingID"
                    :name="row.name"
                    :descriptor="row.descriptor"
                    :settingID="row.settingID"
                    :timestamp="row.timestamp"
                    :selected="selectedIDs.has(row.settingID)"
                    :tags="row.tags"
                    :allTags="allTags"
                    :setting="row.setting"
                    :tuneID="row.tuneID"
                    :sourceUrl="row.sourceUrl"
                    @favouriteItemClicked="loadFavouriteItem"
                    @unstar="removeFavourite"
                    @toggle="toggleSelected"
                    @addTag="addTag"
                    @removeTag="removeTag"
                />
            </v-list>
            <p v-else-if="favouriteItems.length > 0" class="mt-4 grey--text">
                No favourites match the selected tags.
            </p>
        </template>

        <!-- Grouped by tag -->
        <template v-else-if="groupBy === 'tag'">
            <div v-for="group in tagGroups" :key="group.tag || '__untagged__'" class="mb-2">
                <v-list class="resultsTable">
                    <div class="tag-group-header d-flex align-center px-2 py-1">
                        <v-checkbox
                            :input-value="groupAllSelected(group.rows)"
                            :indeterminate="groupSomeSelected(group.rows) && !groupAllSelected(group.rows)"
                            class="mt-0 pt-0 mr-0 flex-grow-0"
                            hide-details
                            @click.stop="toggleGroupSelect(group.rows)"
                        />
                        <div class="d-flex align-center flex-grow-1 group-collapse-trigger" @click="toggleTagGroup(group.tag)">
                            <v-icon small class="mr-1">{{ collapsedTagGroups.has(group.tag) ? icons.chevronRight : icons.chevronDown }}</v-icon>
                            <span class="tag-group-title">{{ group.tag || 'Untagged' }}</span>
                            <span class="ml-1 caption grey--text">({{ group.rows.length }})</span>
                        </div>
                    </div>
                    <template v-if="!collapsedTagGroups.has(group.tag)">
                        <FavouriteRow
                            v-for="row in group.rows"
                            :key="row.settingID"
                            :name="row.name"
                            :descriptor="row.descriptor"
                            :settingID="row.settingID"
                            :timestamp="row.timestamp"
                            :selected="selectedIDs.has(row.settingID)"
                            :tags="row.tags"
                            :allTags="allTags"
                            :tuneID="row.tuneID"
                            :sourceUrl="row.sourceUrl"
                            @favouriteItemClicked="loadFavouriteItem"
                            @unstar="removeFavourite"
                            @toggle="toggleSelected"
                            @addTag="addTag"
                            @removeTag="removeTag"
                        />
                    </template>
                </v-list>
            </div>
        </template>

        <!-- Grouped by date -->
        <template v-else-if="groupBy === 'date'">
            <div v-for="group in dateGroups" :key="group.label" class="mb-2">
                <v-list class="resultsTable">
                    <div class="tag-group-header d-flex align-center px-2 py-1">
                        <v-checkbox
                            :input-value="groupAllSelected(group.rows)"
                            :indeterminate="groupSomeSelected(group.rows) && !groupAllSelected(group.rows)"
                            class="mt-0 pt-0 mr-0 flex-grow-0"
                            hide-details
                            @click.stop="toggleGroupSelect(group.rows)"
                        />
                        <div class="d-flex align-center flex-grow-1 group-collapse-trigger" @click="toggleDateGroup(group.label)">
                            <v-icon small class="mr-1">{{ collapsedDateGroups.has(group.label) ? icons.chevronRight : icons.chevronDown }}</v-icon>
                            <span class="tag-group-title">{{ group.label }}</span>
                            <span class="ml-1 caption grey--text">({{ group.rows.length }})</span>
                        </div>
                    </div>
                    <template v-if="!collapsedDateGroups.has(group.label)">
                        <FavouriteRow
                            v-for="row in group.rows"
                            :key="row.settingID"
                            :name="row.name"
                            :descriptor="row.descriptor"
                            :settingID="row.settingID"
                            :timestamp="row.timestamp"
                            :selected="selectedIDs.has(row.settingID)"
                            :tags="row.tags"
                            :allTags="allTags"
                            :tuneID="row.tuneID"
                            :sourceUrl="row.sourceUrl"
                            @favouriteItemClicked="loadFavouriteItem"
                            @unstar="removeFavourite"
                            @toggle="toggleSelected"
                            @addTag="addTag"
                            @removeTag="removeTag"
                        />
                    </template>
                </v-list>
            </div>
        </template>

        <p v-if="favouriteItems.length === 0" class="mt-4 grey--text">
            No favourites yet. Star a tune from the results list to save it here.
        </p>

        <v-snackbar v-model="snackbar" :timeout="3000">{{ snackbarText }}</v-snackbar>

        <!-- Manage tags dialog -->
        <v-dialog v-model="manageTagsDialog" max-width="360">
            <v-card>
                <v-card-title>Manage tags</v-card-title>
                <v-list dense>
                    <v-list-item v-for="tag in allTags" :key="tag">
                        <v-list-item-content>
                            <v-list-item-title>{{ tag }}</v-list-item-title>
                        </v-list-item-content>
                        <v-list-item-action class="flex-row" style="gap:4px">
                            <v-btn icon x-small @click="openRenameTag(tag)">
                                <v-icon x-small>{{ icons.pencil }}</v-icon>
                            </v-btn>
                            <v-btn icon x-small color="red" @click="confirmDeleteTag(tag)">
                                <v-icon x-small>{{ icons.delete }}</v-icon>
                            </v-btn>
                        </v-list-item-action>
                    </v-list-item>
                    <v-list-item v-if="allTags.length === 0">
                        <v-list-item-content class="grey--text">No tags yet.</v-list-item-content>
                    </v-list-item>
                </v-list>
                <v-card-actions>
                    <v-spacer />
                    <v-btn text @click="manageTagsDialog = false">Close</v-btn>
                </v-card-actions>
            </v-card>
        </v-dialog>

        <!-- Rename tag dialog -->
        <v-dialog v-model="renameTagDialog" max-width="320">
            <v-card>
                <v-card-title>Rename tag</v-card-title>
                <v-card-text>
                    <v-text-field
                        ref="renameTagField"
                        v-model="renameTagNew"
                        label="New name"
                        autofocus
                        @keydown.enter="commitRenameTag"
                        @keydown.esc="renameTagDialog = false"
                    />
                </v-card-text>
                <v-card-actions>
                    <v-spacer />
                    <v-btn text @click="renameTagDialog = false">Cancel</v-btn>
                    <v-btn color="primary" text :disabled="!renameTagNew.trim()" @click="commitRenameTag">Rename</v-btn>
                </v-card-actions>
            </v-card>
        </v-dialog>

        <!-- Delete tag confirm dialog -->
        <v-dialog v-model="deleteTagDialog" max-width="320">
            <v-card>
                <v-card-title>Delete tag?</v-card-title>
                <v-card-text>
                    "{{ deleteTagTarget }}" will be removed from all favourites.
                </v-card-text>
                <v-card-actions>
                    <v-spacer />
                    <v-btn text @click="deleteTagDialog = false">Cancel</v-btn>
                    <v-btn color="red" text @click="doDeleteTag">Delete</v-btn>
                </v-card-actions>
            </v-card>
        </v-dialog>
    </v-container>
</template>

<script>
import { mdiChevronRight, mdiChevronDown, mdiExport, mdiPencil, mdiDelete, mdiTagMultipleOutline, mdiTagPlusOutline, mdiSort, mdiCalendarMonth, mdiMapMarker } from '@mdi/js';
import ABCJS from 'abcjs';
import eventBus from '@/eventBus';
import store from '@/services/store';
import FavouriteRow from '@/components/FavouriteRow';
import utils from '@/js/utils';
import { settingSourceUrl } from '@/js/source.mjs';
import router from '@/router/index.js';

const FILTER_STATE_KEY = 'favouritesFilterState';

function loadPersistedFilterState() {
    try {
        const raw = sessionStorage.getItem(FILTER_STATE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

export default {
    name: 'FavouritesView',
    components: { FavouriteRow },
    data() {
        const persisted = loadPersistedFilterState() || {};
        return {
            favouriteItems: [],
            selectedIDs: new Set(),
            activeTags: Array.isArray(persisted.activeTags) ? persisted.activeTags : [],
            activePlaceIDs: Array.isArray(persisted.activePlaceIDs) ? persisted.activePlaceIDs : [],
            // Sightings and places, loaded once and refreshed on the event —
            // filtering must not hit IndexedDB per row.
            sightings: [],
            places: [],
            nameFilter: typeof persisted.nameFilter === 'string' ? persisted.nameFilter : '',
            groupBy: persisted.groupBy === 'tag' || persisted.groupBy === 'date' ? persisted.groupBy : null,
            collapsedTagGroups: new Set(Array.isArray(persisted.collapsedTagGroups) ? persisted.collapsedTagGroups : []),
            collapsedDateGroups: new Set(Array.isArray(persisted.collapsedDateGroups) ? persisted.collapsedDateGroups : []),
            manageTagsDialog: false,
            renameTagDialog: false,
            renameTagOld: '',
            renameTagNew: '',
            deleteTagDialog: false,
            deleteTagTarget: null,
            bulkTagMenu: false,
            bulkTagInput: null,
            snackbar: false,
            snackbarText: '',
            sortBy: typeof persisted.sortBy === 'string' ? persisted.sortBy : 'date',
            sortOptions: [
                { text: 'Date', value: 'date' },
                { text: 'Name', value: 'name' },
                { text: 'Tune type', value: 'type' },
                { text: 'Key', value: 'key' },
                { text: 'Tags', value: 'tags' },
            ],
            icons: {
                export: mdiExport,
                pencil: mdiPencil,
                delete: mdiDelete,
                chevronRight: mdiChevronRight,
                chevronDown: mdiChevronDown,
                groupTag: mdiTagMultipleOutline,
                tagPlus: mdiTagPlusOutline,
                groupDate: mdiCalendarMonth,
                sort: mdiSort,
                mapMarker: mdiMapMarker,
            },
        };
    },
    computed: {
        groupByLabel() {
            if (this.groupBy === 'tag') return 'Grouped by tag';
            if (this.groupBy === 'date') return 'Grouped by date';
            return 'No grouping';
        },
        groupByIcon() {
            return this.groupBy === 'date' ? this.icons.groupDate : this.icons.groupTag;
        },
        filteredItems() {
            const needle = (this.nameFilter || '').trim().toLowerCase();
            const filtered = this.favouriteItems.filter(item => {
                if (this.activeTags.length > 0 && !this.activeTags.every(t => (item.tags || []).includes(t))) return false;
                // OR across places, unlike tags which are AND. Selecting two
                // places means "heard at either" — the useful reading, since a
                // tune heard at *both* of two named pubs is a rare thing to ask
                // for and would usually filter to nothing.
                if (this.activePlaceIDs.length > 0) {
                    const tuneID = item.result.setting && item.result.setting.tune_id;
                    const placeIDs = tuneID ? this.placeIDsByTune.get(String(tuneID)) : null;
                    if (!placeIDs || !this.activePlaceIDs.some(id => placeIDs.has(id))) return false;
                }
                if (needle && !utils.parseDisplayableName(item.result.displayName).toLowerCase().includes(needle)) return false;
                return true;
            });
            const sorted = [...filtered];
            switch (this.sortBy) {
                case 'name':
                    sorted.sort((a, b) =>
                        utils.parseDisplayableName(a.result.displayName)
                            .localeCompare(utils.parseDisplayableName(b.result.displayName)));
                    break;
                case 'type':
                    sorted.sort((a, b) => {
                        const da = utils.parseDisplayableDescription(a.result.setting) || '';
                        const db = utils.parseDisplayableDescription(b.result.setting) || '';
                        return da.localeCompare(db);
                    });
                    break;
                case 'key':
                    sorted.sort((a, b) => {
                        const ka = (a.result.setting && a.result.setting.mode) || '';
                        const kb = (b.result.setting && b.result.setting.mode) || '';
                        return ka.localeCompare(kb);
                    });
                    break;
                case 'tags':
                    sorted.sort((a, b) => {
                        const ta = (a.tags || []).join(',');
                        const tb = (b.tags || []).join(',');
                        return ta.localeCompare(tb);
                    });
                    break;
                case 'date':
                default:
                    sorted.sort((a, b) => b.timestamp - a.timestamp);
                    break;
            }
            return sorted;
        },
        // tuneID -> Set(placeID). Built once per sightings change rather than
        // per row: a favourites list of 200 against a few thousand sightings is
        // otherwise a nested scan on every keystroke in the name filter.
        placeIDsByTune() {
            const map = new Map();
            for (const sighting of this.sightings) {
                if (!sighting.placeID) continue;
                const key = String(sighting.tuneID);
                if (!map.has(key)) map.set(key, new Set());
                map.get(key).add(sighting.placeID);
            }
            return map;
        },
        // Only places that actually contain a favourite, with the count, so the
        // bar never offers a chip that filters to nothing.
        placeFilterOptions() {
            const counts = new Map();
            for (const item of this.favouriteItems) {
                const tuneID = item.result.setting && item.result.setting.tune_id;
                if (!tuneID) continue;
                const placeIDs = this.placeIDsByTune.get(String(tuneID));
                if (!placeIDs) continue;
                for (const placeID of placeIDs) {
                    counts.set(placeID, (counts.get(placeID) || 0) + 1);
                }
            }
            return this.places
                .filter(place => counts.has(place.id))
                .map(place => ({ ...place, matchCount: counts.get(place.id) }))
                .sort((a, b) => b.matchCount - a.matchCount || a.name.localeCompare(b.name));
        },
        allTags() {
            const tags = new Set();
            this.filteredItems.forEach(item => (item.tags || []).forEach(t => tags.add(t)));
            return [...tags].sort();
        },
        allRows() {
            return this.filteredItems.map(item => this._toRow(item));
        },
        allVisibleSelected() {
            return this.allRows.length > 0 && this.allRows.every(r => this.selectedIDs.has(r.settingID));
        },
        someVisibleSelected() {
            return this.allRows.some(r => this.selectedIDs.has(r.settingID));
        },
        dateGroups() {
            const byMonth = new Map();
            for (const item of this.filteredItems) {
                const d = new Date(item.timestamp);
                const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
                if (!byMonth.has(label)) byMonth.set(label, []);
                byMonth.get(label).push(item);
            }
            return [...byMonth.entries()].map(([label, items]) => ({
                label,
                rows: items.map(i => this._toRow(i)),
            }));
        },
        tagGroups() {
            const tagsToShow = this.activeTags.length > 0 ? this.activeTags : this.allTags;
            const groups = [];
            for (const tag of tagsToShow) {
                const items = this.filteredItems.filter(item => (item.tags || []).includes(tag));
                if (items.length > 0) groups.push({ tag, rows: items.map(i => this._toRow(i)) });
            }
            if (this.activeTags.length === 0) {
                const untagged = this.filteredItems.filter(item => !(item.tags && item.tags.length > 0));
                if (untagged.length > 0) groups.push({ tag: null, rows: untagged.map(i => this._toRow(i)) });
            }
            return groups;
        },
    },
    watch: {
        activeTags: { handler() { this._persistFilterState(); }, deep: true },
        activePlaceIDs: { handler() { this._persistFilterState(); }, deep: true },
        nameFilter() { this._persistFilterState(); },
        groupBy() { this._persistFilterState(); },
        sortBy() { this._persistFilterState(); },
        collapsedTagGroups() { this._persistFilterState(); },
        collapsedDateGroups() { this._persistFilterState(); },
    },
    created() {
        eventBus.$emit('parentViewActivated');
        this.loadFavourites();
        this.loadPlaces();
        eventBus.$on('syncComplete', this.loadFavourites);
        eventBus.$on('sightingsChanged', this.loadPlaces);
    },
    beforeDestroy() {
        eventBus.$off('syncComplete', this.loadFavourites);
        eventBus.$off('sightingsChanged', this.loadPlaces);
    },
    methods: {
        _persistFilterState() {
            try {
                sessionStorage.setItem(FILTER_STATE_KEY, JSON.stringify({
                    activeTags: this.activeTags,
                    activePlaceIDs: this.activePlaceIDs,
                    nameFilter: this.nameFilter,
                    groupBy: this.groupBy,
                    sortBy: this.sortBy,
                    collapsedTagGroups: [...this.collapsedTagGroups],
                    collapsedDateGroups: [...this.collapsedDateGroups],
                }));
            } catch (e) {
                // sessionStorage may be unavailable (private mode, quota); ignore.
            }
        },
        _toRow(item) {
            return {
                name: utils.parseDisplayableName(item.result.displayName),
                descriptor: utils.parseDisplayableDescription(item.result.setting),
                settingID: item.result.settingID,
                timestamp: item.timestamp,
                tags: item.tags || [],
                setting: item.result.setting || null,
                // Lifted out of `setting` so the tag-grouped list — which does
                // not bind `setting` (it has no ABC preview) — can still offer
                // the tune-background button.
                tuneID: (item.result.setting && item.result.setting.tune_id) || '',
                sourceUrl: (item.result.setting && item.result.setting.source_url) || '',
            };
        },
        loadFavourites() {
            store.getFavourites().then(items => {
                this.favouriteItems = items;
                const existingIDs = new Set(items.map(i => i.result.settingID));
                this.selectedIDs = new Set([...this.selectedIDs].filter(id => existingIDs.has(id)));
                // Drop any activeTags that no longer exist
                const tagSet = new Set();
                items.forEach(i => (i.tags || []).forEach(t => tagSet.add(t)));
                this.activeTags = this.activeTags.filter(t => tagSet.has(t));
            });
        },
        cycleGroupBy() {
            if (this.groupBy === null) this.groupBy = 'tag';
            else if (this.groupBy === 'tag') this.groupBy = 'date';
            else this.groupBy = null;
        },
        groupAllSelected(rows) {
            return rows.length > 0 && rows.every(r => this.selectedIDs.has(r.settingID));
        },
        groupSomeSelected(rows) {
            return rows.some(r => this.selectedIDs.has(r.settingID));
        },
        toggleGroupSelect(rows) {
            const next = new Set(this.selectedIDs);
            if (this.groupAllSelected(rows)) {
                rows.forEach(r => next.delete(r.settingID));
            } else {
                rows.forEach(r => next.add(r.settingID));
            }
            this.selectedIDs = next;
        },
        toggleSelectAll() {
            const next = new Set(this.selectedIDs);
            if (this.allVisibleSelected) {
                this.allRows.forEach(r => next.delete(r.settingID));
            } else {
                this.allRows.forEach(r => next.add(r.settingID));
            }
            this.selectedIDs = next;
        },
        async loadPlaces() {
            if (!store.userSettings.geoTagDetections) {
                this.sightings = [];
                this.places = [];
                return;
            }
            const [sightings, places] = await Promise.all([
                store.getSightings(),
                store.getPlaces(),
            ]);
            this.sightings = sightings;
            this.places = places;
            // A place the user has since deleted must not stay silently active,
            // filtering the list against something no chip can clear.
            const known = new Set(places.map(p => p.id));
            const stillValid = this.activePlaceIDs.filter(id => known.has(id));
            if (stillValid.length !== this.activePlaceIDs.length) this.activePlaceIDs = stillValid;
        },
        toggleActivePlace(placeID) {
            const i = this.activePlaceIDs.indexOf(placeID);
            if (i >= 0) this.activePlaceIDs.splice(i, 1);
            else this.activePlaceIDs.push(placeID);
        },
        toggleActiveTag(tag) {
            const i = this.activeTags.indexOf(tag);
            if (i >= 0) this.activeTags.splice(i, 1);
            else this.activeTags.push(tag);
        },
        toggleTagGroup(tag) {
            const next = new Set(this.collapsedTagGroups);
            if (next.has(tag)) next.delete(tag);
            else next.add(tag);
            this.collapsedTagGroups = next;
        },
        toggleDateGroup(label) {
            const next = new Set(this.collapsedDateGroups);
            if (next.has(label)) next.delete(label);
            else next.add(label);
            this.collapsedDateGroups = next;
        },
        toggleSelected(settingID) {
            const next = new Set(this.selectedIDs);
            if (next.has(settingID)) next.delete(settingID);
            else next.add(settingID);
            this.selectedIDs = next;
        },
        loadFavouriteItem(settingID) {
            const item = this.favouriteItems.find(f => f.result.settingID === settingID);
            if (item) {
                router.push({
                    name: 'tune',
                    query: {
                        tuneID: item.result.setting.tune_id,
                        settingID: item.result.settingID,
                        displayName: item.result.displayName,
                    }
                });
                eventBus.$emit('childViewActivated');
            }
        },
        removeFavourite(settingID) {
            store.removeFavourite(settingID).then(() => this.loadFavourites());
        },
        async onBulkTagSelected(val) {
            const tag = typeof val === 'string' ? val.trim() : '';
            if (!tag) { this.bulkTagMenu = false; return; }
            for (const id of this.selectedIDs) {
                await store.addTagToFavourite(id, tag);
            }
            this.bulkTagInput = null;
            this.bulkTagMenu = false;
            this.loadFavourites();
        },
        addTag({ settingID, tag }) {
            store.addTagToFavourite(settingID, tag).then(() => this.loadFavourites());
        },
        removeTag({ settingID, tag }) {
            store.removeTagFromFavourite(settingID, tag).then(() => this.loadFavourites());
        },
        openTagMenu(tag) {
            // Right-click on filter chip — quick rename shortcut
            this.openRenameTag(tag);
        },
        openRenameTag(tag) {
            this.renameTagOld = tag;
            this.renameTagNew = tag;
            this.manageTagsDialog = false;
            this.renameTagDialog = true;
        },
        commitRenameTag() {
            if (!this.renameTagNew.trim()) { this.renameTagDialog = false; return; }
            store.renameTag(this.renameTagOld, this.renameTagNew.trim()).then(() => {
                const i = this.activeTags.indexOf(this.renameTagOld);
                if (i >= 0) this.activeTags.splice(i, 1, this.renameTagNew.trim());
                this.renameTagDialog = false;
                this.loadFavourites();
            });
        },
        confirmDeleteTag(tag) {
            this.deleteTagTarget = tag;
            this.manageTagsDialog = false;
            this.deleteTagDialog = true;
        },
        doDeleteTag() {
            store.deleteTag(this.deleteTagTarget).then(() => {
                const i = this.activeTags.indexOf(this.deleteTagTarget);
                if (i >= 0) this.activeTags.splice(i, 1);
                this.deleteTagDialog = false;
                this.deleteTagTarget = null;
                this.loadFavourites();
            });
        },
        shareFavourites(format = 'html') {
            const selected = this.favouriteItems.filter(item => this.selectedIDs.has(item.result.settingID));
            if (selected.length === 0) return;

            const plainText = selected.map((item) => {
                const name = utils.parseDisplayableName(item.result.displayName);
                const descriptor = utils.parseDisplayableDescription(item.result.setting);
                const url = settingSourceUrl({
                    tuneID: item.result.setting.tune_id,
                    settingID: item.result.settingID,
                    displayName: item.result.displayName,
                    sourceUrl: item.result.setting.source_url,
                });
                return `${name} — ${descriptor}\n${url}`;
            }).join('\n\n');

            if (format === 'text') {
                if (navigator.share) {
                    navigator.share({ title: 'FolkFriend — Shared Tunes', text: plainText });
                } else {
                    const blob = new Blob([plainText], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'folkfriend-shared-tunes.txt';
                    a.click();
                    URL.revokeObjectURL(url);
                }
                return;
            }

            const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

            const renderItem = (item) => {
                const name = escapeHtml(utils.parseDisplayableName(item.result.displayName));
                const descriptor = escapeHtml(utils.parseDisplayableDescription(item.result.setting));
                const url = settingSourceUrl({
                    tuneID: item.result.setting.tune_id,
                    settingID: item.result.settingID,
                    displayName: item.result.displayName,
                    sourceUrl: item.result.setting.source_url,
                });
                const svg = this._renderAbcSvg(item.result.setting);
                const tagsHtml = (item.tags && item.tags.length > 0)
                    ? `<p class="tags">${item.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</p>`
                    : '';
                return `  <div class="tune">
    <h2><a href="${url}">${name}</a></h2>
    ${tagsHtml}<p class="descriptor">${descriptor}</p>
    ${svg}
  </div>`;
            };

            const sections = selected.map(renderItem).join('\n');
            const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FolkFriend — Shared Tunes</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 2em auto; }
    .tune { margin: 1.5em 0 1.5em 0; border-top: 1px solid #eee; padding-top: 1em; }
    h2 a { color: #1565C0; text-decoration: none; }
    h2 a:hover { text-decoration: underline; }
    .tags { margin: 0.2em 0 0.5em; display: flex; flex-wrap: wrap; gap: 4px; }
    .tag { background: #e8f0fe; color: #1a56a0; border-radius: 12px; padding: 1px 8px; font-size: 0.8em; }
    .descriptor { margin: 0 0 0.8em; font-style: italic; color: #555; }
    svg { width: 100%; height: auto; }
  </style>
</head>
<body>
  <h1>FolkFriend — Shared Tunes</h1>
${sections}
</body>
</html>`;

            const htmlFile = new File([html], 'folkfriend-shared-tunes.html', { type: 'text/html' });

            // Share as HTML file via native sheet (Web Share API Level 2: macOS PWA / iOS Safari).
            // Falls through to download if the platform doesn't support file sharing.
            if (navigator.canShare && navigator.canShare({ files: [htmlFile] })) {
                navigator.share({ title: 'FolkFriend — Shared Tunes', files: [htmlFile] });
                return;
            }

            // Download fallback for browsers / platforms without file share support.
            const blob = new Blob([html], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'folkfriend-shared-tunes.html';
            a.click();
            URL.revokeObjectURL(url);
        },
        _buildAbcText(setting) {
            const lines = [];
            if (setting.mode) lines.push(`K:${setting.mode}`);
            if (setting.meter) lines.push(`M:${setting.meter}`);
            if (!/^L:/m.test(setting.abc)) lines.push('L:1/8');
            const isPolka = setting.meter === '2/4' || /^M:2\/4/m.test(setting.abc);
            if (isPolka && !/^Q:/m.test(setting.abc)) lines.push('Q:1/4=120');
            lines.push(setting.abc);
            return lines.join('\n');
        },
        _renderAbcSvg(setting) {
            const div = document.createElement('div');
            ABCJS.renderAbc(div, this._buildAbcText(setting), { staffwidth: 540 });
            return div.innerHTML;
        },
    }
};
</script>

<style scoped>
.resultsTable > div:nth-child(odd) {
    background: #efefef;
}

.tag-group-header {
    background: #e8e8e8;
    border-radius: 4px 4px 0 0;
    min-height: 36px;
}

.group-collapse-trigger {
    cursor: pointer;
}

.tag-group-title {
    font-weight: 600;
    font-size: 0.95rem;
}

.tag-filter-bar {
    border-bottom: 1px solid #e0e0e0;
    padding-bottom: 10px;
}

.select-all-bar {
    border-bottom: 1px solid #e0e0e0;
    min-height: 36px;
}
</style>
