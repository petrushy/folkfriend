<template>
    <v-container class="viewContainerWrapper">
        <div class="d-flex align-center my-2">
            <h1>Favourites</h1>
            <v-spacer />
            <v-btn small text color="primary" @click="promptNewFolder">
                <v-icon left small>{{ icons.folderPlus }}</v-icon>
                New folder
            </v-btn>
        </div>

        <!-- Unfiled items (no folder) -->
        <div v-if="unfiledRows.length > 0" class="mb-2">
            <v-list class="resultsTable">
                <div class="folder-header d-flex align-center px-2 py-1">
                    <v-checkbox
                        :input-value="allUnfiledSelected"
                        :indeterminate="someUnfiledSelected && !allUnfiledSelected"
                        class="ml-2 mr-0 mt-0 pt-0 flex-grow-0"
                        hide-details
                        @change="toggleSelectGroup(unfiledRows)"
                    />
                    <span class="folder-title grey--text text--darken-1">Unfiled</span>
                </div>
                <FavouriteRow
                    v-for="row in unfiledRows"
                    :key="row.settingID"
                    :name="row.name"
                    :descriptor="row.descriptor"
                    :settingID="row.settingID"
                    :timestamp="row.timestamp"
                    :selected="selectedIDs.has(row.settingID)"
                    :folders="folderList"
                    :currentFolderId="null"
                    @favouriteItemClicked="loadFavouriteItem"
                    @unstar="removeFavourite"
                    @toggle="toggleSelected"
                    @moveToFolder="moveFavouriteToFolder"
                />
            </v-list>
        </div>

        <!-- Folders -->
        <div v-for="folder in folders" :key="folder.id" class="mb-2">
            <v-list class="resultsTable">
                <div
                    class="folder-header d-flex align-center px-2 py-1"
                    style="cursor:pointer"
                    @click="toggleFolder(folder.id)"
                >
                    <v-checkbox
                        :input-value="allFolderSelected(folder.id)"
                        :indeterminate="someFolderSelected(folder.id) && !allFolderSelected(folder.id)"
                        class="ml-2 mr-0 mt-0 pt-0 flex-grow-0"
                        hide-details
                        @change="toggleSelectGroup(rowsByFolder(folder.id))"
                        @click.stop
                    />
                    <v-icon small class="mr-1">{{ collapsedFolders.has(folder.id) ? icons.chevronRight : icons.chevronDown }}</v-icon>
                    <span v-if="editingFolderId !== folder.id" class="folder-title" @dblclick.stop="startRename(folder)">
                        {{ folder.name }}
                    </span>
                    <v-text-field
                        v-else
                        :ref="`rename-${folder.id}`"
                        v-model="editingFolderName"
                        dense
                        hide-details
                        class="folder-rename-field"
                        @click.stop
                        @keydown.enter.stop="commitRename(folder.id)"
                        @keydown.esc.stop="cancelRename"
                        @blur="commitRename(folder.id)"
                    />
                    <v-spacer />
                    <v-btn icon small @click.stop="startRename(folder)">
                        <v-icon small>{{ icons.pencil }}</v-icon>
                    </v-btn>
                    <v-btn icon small @click.stop="confirmDeleteFolder(folder)">
                        <v-icon small>{{ icons.delete }}</v-icon>
                    </v-btn>
                </div>

                <template v-if="!collapsedFolders.has(folder.id)">
                    <FavouriteRow
                        v-for="row in rowsByFolder(folder.id)"
                        :key="row.settingID"
                        :name="row.name"
                        :descriptor="row.descriptor"
                        :settingID="row.settingID"
                        :timestamp="row.timestamp"
                        :selected="selectedIDs.has(row.settingID)"
                        :folders="folderList"
                        :currentFolderId="folder.id"
                        @favouriteItemClicked="loadFavouriteItem"
                        @unstar="removeFavourite"
                        @toggle="toggleSelected"
                        @moveToFolder="moveFavouriteToFolder"
                    />
                    <div v-if="rowsByFolder(folder.id).length === 0" class="px-4 py-2 grey--text text--darken-1">
                        Empty folder
                    </div>
                </template>
            </v-list>
        </div>

        <p v-if="allRows.length === 0 && folders.length === 0" class="mt-4 grey--text">
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

        <!-- New folder dialog -->
        <v-dialog v-model="newFolderDialog" max-width="320">
            <v-card>
                <v-card-title>New folder</v-card-title>
                <v-card-text>
                    <v-text-field
                        ref="newFolderField"
                        v-model="newFolderName"
                        label="Folder name"
                        autofocus
                        @keydown.enter="createFolder"
                        @keydown.esc="newFolderDialog = false"
                    />
                </v-card-text>
                <v-card-actions>
                    <v-spacer />
                    <v-btn text @click="newFolderDialog = false">Cancel</v-btn>
                    <v-btn color="primary" text :disabled="!newFolderName.trim()" @click="createFolder">Create</v-btn>
                </v-card-actions>
            </v-card>
        </v-dialog>

        <!-- Delete folder confirm dialog -->
        <v-dialog v-model="deleteFolderDialog" max-width="320">
            <v-card>
                <v-card-title>Delete folder?</v-card-title>
                <v-card-text>
                    "{{ deleteFolderTarget && deleteFolderTarget.name }}" will be deleted. Tunes inside will become unfiled.
                </v-card-text>
                <v-card-actions>
                    <v-spacer />
                    <v-btn text @click="deleteFolderDialog = false">Cancel</v-btn>
                    <v-btn color="red" text @click="deleteFolder">Delete</v-btn>
                </v-card-actions>
            </v-card>
        </v-dialog>
    </v-container>
</template>

<script>
import { mdiChevronRight, mdiChevronDown, mdiExport, mdiPencil, mdiDelete, mdiFolderPlus } from '@mdi/js';
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
            folders: [],
            selectedIDs: new Set(),
            collapsedFolders: new Set(),
            editingFolderId: null,
            editingFolderName: '',
            newFolderDialog: false,
            newFolderName: '',
            deleteFolderDialog: false,
            deleteFolderTarget: null,
            snackbar: false,
            snackbarText: '',
            icons: {
                export: mdiExport,
                pencil: mdiPencil,
                delete: mdiDelete,
                chevronRight: mdiChevronRight,
                chevronDown: mdiChevronDown,
                folderPlus: mdiFolderPlus,
            },
        };
    },
    computed: {
        folderList() {
            return this.folders.map(f => ({ id: f.id, name: f.name }));
        },
        allRows() {
            return this.favouriteItems.map(item => this._toRow(item));
        },
        unfiledRows() {
            return this.favouriteItems
                .filter(item => !item.folderId)
                .map(item => this._toRow(item));
        },
        allUnfiledSelected() {
            return this.unfiledRows.length > 0 &&
                this.unfiledRows.every(r => this.selectedIDs.has(r.settingID));
        },
        someUnfiledSelected() {
            return this.unfiledRows.some(r => this.selectedIDs.has(r.settingID));
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
                folderId: item.folderId || null,
            };
        },
        loadFavourites() {
            Promise.all([store.getFavourites(), store.getFolders()]).then(([items, folders]) => {
                items.sort((a, b) => b.timestamp - a.timestamp);
                // Sort folders by createdAt descending (newest session first)
                folders.sort((a, b) => b.createdAt - a.createdAt);
                this.favouriteItems = items;
                this.folders = folders;
                const existingIDs = new Set(items.map(i => i.result.settingID));
                this.selectedIDs = new Set([...this.selectedIDs].filter(id => existingIDs.has(id)));
            });
        },
        rowsByFolder(folderId) {
            return this.favouriteItems
                .filter(item => item.folderId === folderId)
                .map(item => this._toRow(item));
        },
        allFolderSelected(folderId) {
            const rows = this.rowsByFolder(folderId);
            return rows.length > 0 && rows.every(r => this.selectedIDs.has(r.settingID));
        },
        someFolderSelected(folderId) {
            return this.rowsByFolder(folderId).some(r => this.selectedIDs.has(r.settingID));
        },
        toggleFolder(folderId) {
            const next = new Set(this.collapsedFolders);
            if (next.has(folderId)) next.delete(folderId);
            else next.add(folderId);
            this.collapsedFolders = next;
        },
        toggleSelected(settingID) {
            const next = new Set(this.selectedIDs);
            if (next.has(settingID)) next.delete(settingID);
            else next.add(settingID);
            this.selectedIDs = next;
        },
        toggleSelectGroup(rows) {
            const allSel = rows.every(r => this.selectedIDs.has(r.settingID));
            const next = new Set(this.selectedIDs);
            rows.forEach(r => allSel ? next.delete(r.settingID) : next.add(r.settingID));
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
        moveFavouriteToFolder({ settingID, folderId }) {
            store.moveFavouriteToFolder(settingID, folderId).then(() => this.loadFavourites());
        },
        promptNewFolder() {
            this.newFolderName = '';
            this.newFolderDialog = true;
        },
        createFolder() {
            if (!this.newFolderName.trim()) return;
            store.addFolder(this.newFolderName.trim()).then(() => {
                this.newFolderDialog = false;
                this.newFolderName = '';
                this.loadFavourites();
            });
        },
        startRename(folder) {
            this.editingFolderId = folder.id;
            this.editingFolderName = folder.name;
            this.$nextTick(() => {
                const ref = this.$refs[`rename-${folder.id}`];
                if (ref && ref[0]) ref[0].focus();
            });
        },
        cancelRename() {
            this.editingFolderId = null;
            this.editingFolderName = '';
        },
        commitRename(folderId) {
            if (!this.editingFolderName.trim()) { this.cancelRename(); return; }
            store.renameFolder(folderId, this.editingFolderName.trim()).then(() => {
                this.cancelRename();
                this.loadFavourites();
            });
        },
        confirmDeleteFolder(folder) {
            this.deleteFolderTarget = folder;
            this.deleteFolderDialog = true;
        },
        deleteFolder() {
            store.deleteFolder(this.deleteFolderTarget.id).then(() => {
                this.deleteFolderDialog = false;
                this.deleteFolderTarget = null;
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
                return `  <div class="tune">
    <h2><a href="${url}">${name}</a></h2>
    <p class="descriptor">${descriptor}</p>
    ${svg}
  </div>`;
            };

            // Build folder-grouped sections
            const folderMap = new Map(this.folders.map(f => [f.id, f.name]));
            const groups = [];

            // Folders in display order (newest first, matching the UI)
            for (const folder of this.folders) {
                const items = selected.filter(item => item.folderId === folder.id);
                if (items.length > 0) groups.push({ heading: folder.name, items });
            }
            // Unfiled
            const unfiled = selected.filter(item => !item.folderId || !folderMap.has(item.folderId));
            if (unfiled.length > 0) groups.push({ heading: null, items: unfiled });

            const sections = groups.map(({ heading, items }) => {
                const headingHtml = heading ? `  <h2 class="folder-heading">${escapeHtml(heading)}</h2>` : '';
                return headingHtml + '\n' + items.map(renderItem).join('\n');
            }).join('\n');

            const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FolkFriend — Shared Tunes</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 2em auto; }
    .folder-heading { margin: 2em 0 0.5em; color: #444; border-bottom: 2px solid #ccc; padding-bottom: 0.2em; }
    .tune { margin: 1.5em 0 1.5em 0; border-top: 1px solid #eee; padding-top: 1em; }
    h2.tune-title { margin: 0 0 0.2em; font-size: 1.1em; }
    h2 a { color: #1565C0; text-decoration: none; }
    h2 a:hover { text-decoration: underline; }
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

.folder-header {
    background: #e8e8e8;
    border-radius: 4px 4px 0 0;
    min-height: 40px;
}

.folder-title {
    font-weight: 600;
    font-size: 0.95rem;
}

.folder-rename-field {
    max-width: 200px;
    font-size: 0.95rem;
}
</style>
