<template>
    <v-container class="viewContainerWrapper">
        <h1 class="my-2">
            Favourites
        </h1>
        <v-list class="resultsTable">
            <div v-if="favouriteRowsProps.length > 0" class="select-all-row d-flex align-center px-2">
                <v-checkbox
                    :input-value="allSelected"
                    :indeterminate="someSelected && !allSelected"
                    class="ml-2 mr-0 mt-0 pt-0"
                    hide-details
                    label="Select all"
                    @change="toggleSelectAll"
                />
            </div>
            <FavouriteRow
                v-for="row in favouriteRowsProps"
                :key="row.settingID"
                :name="row.name"
                :descriptor="row.descriptor"
                :settingID="row.settingID"
                :timestamp="row.timestamp"
                :selected="selectedIDs.has(row.settingID)"
                @favouriteItemClicked="loadFavouriteItem"
                @unstar="removeFavourite"
                @toggle="toggleSelected"
            />
        </v-list>
        <p v-if="favouriteRowsProps.length === 0" class="mt-4 grey--text">
            No favourites yet. Star a tune from the results list to save it here.
        </p>
        <v-btn
            v-if="favouriteItems.length > 0"
            :disabled="selectedIDs.size === 0"
            class="mt-4"
            @click="shareFavourites"
        >
            <v-icon left>{{ icons.export }}</v-icon>
            Share
        </v-btn>
    </v-container>
</template>

<script>
import {mdiExport} from '@mdi/js';
import ABCJS from 'abcjs';
import eventBus from '@/eventBus';
import store from '@/services/store';
import FavouriteRow from '@/components/FavouriteRow';
import utils from '@/js/utils';
import router from '@/router/index.js';

export default {
    name: 'FavouritesView',
    components: {
        FavouriteRow,
    },
    data: function () {
        return {
            favouriteItems: [],
            favouriteRowsProps: [],
            selectedIDs: new Set(),
            icons: {
                export: mdiExport,
            },
        };
    },
    computed: {
        allSelected() {
            return this.favouriteRowsProps.length > 0 &&
                this.selectedIDs.size === this.favouriteRowsProps.length;
        },
        someSelected() {
            return this.selectedIDs.size > 0;
        },
    },
    created: function () {
        eventBus.$emit('parentViewActivated');
        this.loadFavourites();
    },
    methods: {
        loadFavourites() {
            store.getFavourites().then((items) => {
                this.favouriteItems = items;
                this.favouriteRowsProps = items.map((item) => ({
                    name: utils.parseDisplayableName(item.result.displayName),
                    descriptor: utils.parseDisplayableDescription(item.result.setting),
                    settingID: item.result.settingID,
                    timestamp: item.timestamp,
                }));
                // Remove any selectedIDs that no longer exist
                const existingIDs = new Set(this.favouriteRowsProps.map(r => r.settingID));
                this.selectedIDs = new Set([...this.selectedIDs].filter(id => existingIDs.has(id)));
            });
        },
        toggleSelected(settingID) {
            const next = new Set(this.selectedIDs);
            if (next.has(settingID)) {
                next.delete(settingID);
            } else {
                next.add(settingID);
            }
            this.selectedIDs = next;
        },
        toggleSelectAll() {
            if (this.allSelected) {
                this.selectedIDs = new Set();
            } else {
                this.selectedIDs = new Set(this.favouriteRowsProps.map(r => r.settingID));
            }
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
            store.removeFavourite(settingID).then(() => {
                this.loadFavourites();
            });
        },
        buildAbcText(setting) {
            const lines = [];
            if (setting.mode) lines.push(`K:${setting.mode}`);
            if (setting.meter) lines.push(`M:${setting.meter}`);
            if (!/^L:/m.test(setting.abc)) lines.push('L:1/8');
            const isPolka = setting.meter === '2/4' || /^M:2\/4/m.test(setting.abc);
            if (isPolka && !/^Q:/m.test(setting.abc)) lines.push('Q:1/4=120');
            lines.push(setting.abc);
            return lines.join('\n');
        },
        renderAbcSvg(setting) {
            const div = document.createElement('div');
            ABCJS.renderAbc(div, this.buildAbcText(setting), { staffwidth: 540 });
            return div.innerHTML;
        },
        shareFavourites() {
            const selected = this.favouriteItems.filter((item) =>
                this.selectedIDs.has(item.result.settingID)
            );

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

            const sections = selected.map((item) => {
                const name = utils.parseDisplayableName(item.result.displayName);
                const descriptor = utils.parseDisplayableDescription(item.result.setting);
                const url = `https://thesession.org/tunes/${item.result.setting.tune_id}#setting${item.result.settingID}`;
                const svg = this.renderAbcSvg(item.result.setting);
                return `  <div class="tune">
    <h2><a href="${url}">${name}</a></h2>
    <p class="descriptor">${descriptor}</p>
    ${svg}
  </div>`;
            }).join('\n');

            const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FolkFriend — Shared Tunes</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 2em auto; }
    .tune { margin: 2em 0; border-top: 1px solid #ccc; padding-top: 1em; }
    .tune:first-child { border-top: none; }
    h2 { margin: 0 0 0.2em; }
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

            const blob = new Blob([html], {type: 'text/html'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'folkfriend-shared-tunes.html';
            a.click();
            URL.revokeObjectURL(url);
        },
    }
};
</script>

<style scoped>
.resultsTable > div:nth-child(odd) {
    background: #efefef;
}
</style>
