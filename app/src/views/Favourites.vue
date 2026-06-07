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
                style="max-width: 120px;"
                class="mr-2 caption"
                :prepend-icon="icons.sort"
            />
            <v-btn icon small title="Export favourites" :disabled="favouriteItems.length === 0" @click="exportFavourites">
                <v-icon small>{{ icons.export }}</v-icon>
            </v-btn>
            <v-btn icon small title="Import favourites" @click="triggerImport">
                <v-icon small>{{ icons.import }}</v-icon>
            </v-btn>
            <input ref="importInput" type="file" accept="application/json,.json" class="d-none" @change="onImportFileChosen">
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
                >
                    {{ tag }}
                </v-chip>
                <v-btn v-if="activeTags.length > 0" x-small text @click="activeTags = []">Clear</v-btn>
                <v-spacer />
                <v-btn x-small text color="grey" @click="manageTagsDialog = true">Manage tags</v-btn>
            </div>
        </div>

        <v-list v-if="visibleItems.length > 0" class="resultsTable">
            <FavouriteRow
                v-for="item in visibleItems"
                :key="item.result.settingID"
                :name="parseName(item)"
                :descriptor="parseDescriptor(item)"
                :setting-i-d="item.result.settingID"
                :timestamp="item.timestamp"
                :tags="item.tags || []"
                :all-tags="allTags"
                @favouriteItemClicked="loadFavouriteItem"
                @unstar="removeFavourite"
                @addTag="addTag"
                @removeTag="removeTag"
            />
        </v-list>

        <p v-else-if="favouriteItems.length > 0" class="mt-4 grey--text">
            No favourites match the selected tags.
        </p>
        <p v-else class="mt-4 grey--text">
            No favourites yet. Star a tune from the results list to save it here.
        </p>

        <v-snackbar v-model="snackbar" :timeout="4000">{{ snackbarText }}</v-snackbar>

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
import { mdiExport, mdiImport, mdiPencil, mdiDelete, mdiSort } from '@mdi/js';
import eventBus from '@/eventBus';
import store from '@/services/store';
import FavouriteRow from '@/components/FavouriteRow';
import utils from '@/js/utils';
import router from '@/router/index.js';

export default {
    name: 'FavouritesView',
    components: { FavouriteRow },
    data() {
        return {
            favouriteItems: [],
            activeTags: [],
            manageTagsDialog: false,
            renameTagDialog: false,
            renameTagOld: '',
            renameTagNew: '',
            deleteTagDialog: false,
            deleteTagTarget: null,
            snackbar: false,
            snackbarText: '',
            sortBy: 'date',
            sortOptions: [
                { text: 'Date', value: 'date' },
                { text: 'Name', value: 'name' },
            ],
            icons: {
                export: mdiExport,
                import: mdiImport,
                pencil: mdiPencil,
                delete: mdiDelete,
                sort: mdiSort,
            },
        };
    },
    computed: {
        allTags() {
            const tags = new Set();
            this.favouriteItems.forEach(item => (item.tags || []).forEach(t => tags.add(t)));
            return [...tags].sort();
        },
        visibleItems() {
            const filtered = this.favouriteItems.filter(item =>
                this.activeTags.length === 0 ||
                this.activeTags.every(t => (item.tags || []).includes(t))
            );
            const sorted = [...filtered];
            if (this.sortBy === 'name') {
                sorted.sort((a, b) => this.parseName(a).localeCompare(this.parseName(b)));
            } else {
                sorted.sort((a, b) => b.timestamp - a.timestamp);
            }
            return sorted;
        },
    },
    created() {
        eventBus.$emit('parentViewActivated');
        this.loadFavourites();
    },
    methods: {
        parseName(item) {
            return utils.parseDisplayableName(item.result.displayName);
        },
        parseDescriptor(item) {
            return utils.parseDisplayableDescription(item.result.setting);
        },
        loadFavourites() {
            store.getFavourites().then(items => {
                this.favouriteItems = items;
                // Drop any active filter tags that no longer exist.
                const tagSet = new Set();
                items.forEach(i => (i.tags || []).forEach(t => tagSet.add(t)));
                this.activeTags = this.activeTags.filter(t => tagSet.has(t));
            });
        },
        toggleActiveTag(tag) {
            const i = this.activeTags.indexOf(tag);
            if (i >= 0) this.activeTags.splice(i, 1);
            else this.activeTags.push(tag);
        },
        loadFavouriteItem(settingID) {
            const item = this.favouriteItems.find(f => f.result.settingID === settingID);
            if (item) {
                router.push({
                    name: 'tune',
                    params: {
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
        addTag({ settingID, tag }) {
            store.addTagToFavourite(settingID, tag).then(() => this.loadFavourites());
        },
        removeTag({ settingID, tag }) {
            store.removeTagFromFavourite(settingID, tag).then(() => this.loadFavourites());
        },
        openRenameTag(tag) {
            this.renameTagOld = tag;
            this.renameTagNew = tag;
            this.manageTagsDialog = false;
            this.renameTagDialog = true;
        },
        commitRenameTag() {
            const newName = this.renameTagNew.trim();
            if (!newName) { this.renameTagDialog = false; return; }
            store.renameTag(this.renameTagOld, newName).then(() => {
                const i = this.activeTags.indexOf(this.renameTagOld);
                if (i >= 0) this.activeTags.splice(i, 1, newName);
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
        async exportFavourites() {
            const json = await store.exportFavourites();
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'folkfriend-favourites.json';
            a.click();
            URL.revokeObjectURL(url);
        },
        triggerImport() {
            this.$refs.importInput.click();
        },
        onImportFileChosen(event) {
            const file = event.target.files && event.target.files[0];
            // Reset so choosing the same file again re-triggers change.
            event.target.value = '';
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                store.importFavourites(reader.result)
                    .then(({ added, updated }) => {
                        this.loadFavourites();
                        this.snackbarText = `Imported ${added} new favourite${added === 1 ? '' : 's'}` +
                            (updated > 0 ? `, updated tags on ${updated}.` : '.');
                        this.snackbar = true;
                    })
                    .catch(err => {
                        this.snackbarText = err.message || 'Import failed.';
                        this.snackbar = true;
                    });
            };
            reader.readAsText(file);
        },
    }
};
</script>

<style scoped>
.resultsTable > div:nth-child(odd) {
    background: #efefef;
}

.descriptor {
  font-style: italic;
}

.tag-filter-bar {
    border-bottom: 1px solid #e0e0e0;
    padding-bottom: 10px;
}

.timestamp {
    white-space: nowrap;
}
</style>
