<template>
    <v-container class="viewContainerWrapper">
        <h1 class="my-2">
            Favourites
        </h1>
        <v-list class="resultsTable">
            <FavouriteRow
                v-for="row in favouriteRowsProps"
                :key="row.settingID"
                :name="row.name"
                :descriptor="row.descriptor"
                :settingID="row.settingID"
                :timestamp="row.timestamp"
                @favouriteItemClicked="loadFavouriteItem"
                @unstar="removeFavourite"
            />
        </v-list>
        <p v-if="favouriteRowsProps.length === 0" class="mt-4 grey--text">
            No favourites yet. Star a tune from the results list to save it here.
        </p>
        <v-btn
            v-if="favouriteItems.length > 0"
            class="mt-4"
            @click="exportFavourites"
        >
            <v-icon left>{{ icons.export }}</v-icon>
            Export
        </v-btn>
    </v-container>
</template>

<script>
import {mdiExport} from '@mdi/js';
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
            icons: {
                export: mdiExport,
            },
        };
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
            });
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
        exportFavourites() {
            const rows = this.favouriteItems.map((item) => {
                const name = utils.parseDisplayableName(item.result.displayName);
                const descriptor = utils.parseDisplayableDescription(item.result.setting);
                const url = `https://thesession.org/tunes/${item.result.setting.tune_id}#setting${item.result.settingID}`;
                return `  <li><a href="${url}">${name}</a> — ${descriptor}</li>`;
            }).join('\n');

            const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FolkFriend Favourites</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 2em auto; }
    li { margin: 0.5em 0; }
    a { color: #1565C0; }
  </style>
</head>
<body>
  <h1>FolkFriend Favourites</h1>
  <ul>
${rows}
  </ul>
</body>
</html>`;

            const blob = new Blob([html], {type: 'text/html'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'folkfriend-favourites.html';
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
