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
            <v-btn icon small :color="groupByTag ? 'primary' : ''" :title="groupByTag ? 'Flat list' : 'Group by tag'" @click="groupByTag = !groupByTag">
                <v-icon small>{{ icons.group }}</v-icon>
            </v-btn>
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
        <template v-if="!groupByTag">
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

        <!-- Grouped view -->
        <template v-else>
            <div v-for="group in tagGroups" :key="group.tag || '__untagged__'" class="mb-2">
                <v-list class="resultsTable">
                    <div
                        class="tag-group-header d-flex align-center px-3 py-1"
                        style="cursor:pointer"
                        @click="toggleTagGroup(group.tag)"
                    >
                        <v-icon small class="mr-1">{{ collapsedTagGroups.has(group.tag) ? icons.chevronRight : icons.chevronDown }}</v-icon>
                        <span class="tag-group-title">{{ group.tag || 'Untagged' }}</span>
                        <span class="ml-1 caption grey--text">({{ group.rows.length }})</span>
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

        <v-btn
            v-if="allRows.length > 0"
            :disabled="selectedIDs.size === 0"
            class="mt-4"
            @click="shareFavourites"
        >
            <v-icon left>{{ icons.export }}</v-icon>
            Share selected
        </v-btn>

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
import { mdiChevronRight, mdiChevronDown, mdiExport, mdiPencil, mdiDelete, mdiTagMultipleOutline, mdiSort } from '@mdi/js';
import ABCJS from 'abcjs';
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
            selectedIDs: new Set(),
            activeTags: [],
            nameFilter: '',
            groupByTag: false,
            collapsedTagGroups: new Set(),
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
                group: mdiTagMultipleOutline,
                sort: mdiSort,
            },
        };
    },
    computed: {
        filteredItems() {
            const needle = (this.nameFilter || '').trim().toLowerCase();
            const filtered = this.favouriteItems.filter(item => {
                if (this.activeTags.length > 0 && !this.activeTags.every(t => (item.tags || []).includes(t))) return false;
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
        tagGroups() {
            const tagsToShow = this.activeTags.length > 0 ? this.activeTags : this.allTags;
            const groups = [];
            for (const tag of tagsToShow) {
                const items = this.favouriteItems.filter(item => (item.tags || []).includes(tag));
                if (items.length > 0) groups.push({ tag, rows: items.map(i => this._toRow(i)) });
            }
            if (this.activeTags.length === 0) {
                const untagged = this.favouriteItems.filter(item => !(item.tags && item.tags.length > 0));
                if (untagged.length > 0) groups.push({ tag: null, rows: untagged.map(i => this._toRow(i)) });
            }
            return groups;
        },
    },
    created() {
        eventBus.$emit('parentViewActivated');
        this.loadFavourites();
        eventBus.$on('syncComplete', this.loadFavourites);
    },
    beforeDestroy() {
        eventBus.$off('syncComplete', this.loadFavourites);
    },
    methods: {
        _toRow(item) {
            return {
                name: utils.parseDisplayableName(item.result.displayName),
                descriptor: utils.parseDisplayableDescription(item.result.setting),
                settingID: item.result.settingID,
                timestamp: item.timestamp,
                tags: item.tags || [],
                setting: item.result.setting || null,
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
        toggleSelectAll() {
            const next = new Set(this.selectedIDs);
            if (this.allVisibleSelected) {
                this.allRows.forEach(r => next.delete(r.settingID));
            } else {
                this.allRows.forEach(r => next.add(r.settingID));
            }
            this.selectedIDs = next;
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
        shareFavourites() {
            const selected = this.favouriteItems.filter(item => this.selectedIDs.has(item.result.settingID));
            if (selected.length === 0) return;

            if (navigator.share) {
                const text = selected.map((item) => {
                    const name = utils.parseDisplayableName(item.result.displayName);
                    const descriptor = utils.parseDisplayableDescription(item.result.setting);
                    const url = `https://thesession.org/tunes/${item.result.setting.tune_id}#setting${item.result.settingID}`;
                    return `${name} — ${descriptor}\n${url}`;
                }).join('\n\n');
                navigator.share({ title: 'FolkFriend — Shared Tunes', text });
                return;
            }

            const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

            const renderItem = (item) => {
                const name = escapeHtml(utils.parseDisplayableName(item.result.displayName));
                const descriptor = escapeHtml(utils.parseDisplayableDescription(item.result.setting));
                const tuneID = parseInt(item.result.setting.tune_id, 10);
                const settingID = parseInt(item.result.settingID, 10);
                const url = `https://thesession.org/tunes/${tuneID}#setting${settingID}`;
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
