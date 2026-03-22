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
    </v-container>
</template>

<script>
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
    }
};
</script>

<style scoped>
.resultsTable > div:nth-child(odd) {
    background: #efefef;
}
</style>
