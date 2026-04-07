<template>
    <div class="favourite-row-wrapper d-flex align-center">
        <v-checkbox
            :input-value="selected"
            class="ml-2 mr-0 mt-0 pt-0 flex-grow-0"
            hide-details
            @change="$emit('toggle', settingID)"
            @click.stop
        />
        <v-container
            v-ripple
            class="flex-grow-1"
            @click="favouriteItemClicked"
        >
            <v-row class="pt-1 pb-0">
                <v-col class="py-0">
                    <span class="tune-title">{{ name }}</span>
                </v-col>
            </v-row>
            <v-row class="pb-2 pt-0">
                <v-col class="py-0 descriptor">
                    {{ descriptor }}
                </v-col>
                <v-col class="py-0 text-right timestamp">
                    {{ timestampString }}
                </v-col>
            </v-row>
        </v-container>

        <!-- Move to folder menu -->
        <v-menu v-if="folders.length > 0" offset-y left>
            <template #activator="{ on }">
                <v-btn icon class="mr-0" @click.stop v-on="on">
                    <v-icon small>{{ icons.folderMove }}</v-icon>
                </v-btn>
            </template>
            <v-list dense>
                <v-list-item
                    v-for="folder in moveTargetFolders"
                    :key="folder.id"
                    @click="$emit('moveToFolder', { settingID, folderId: folder.id })"
                >
                    <v-list-item-title>{{ folder.name }}</v-list-item-title>
                </v-list-item>
                <v-list-item
                    v-if="currentFolderId !== null"
                    @click="$emit('moveToFolder', { settingID, folderId: null })"
                >
                    <v-list-item-title class="grey--text">Unfile</v-list-item-title>
                </v-list-item>
            </v-list>
        </v-menu>

        <v-btn icon class="mr-2" @click.stop="unstar">
            <v-icon color="amber darken-1">
                {{ icons.star }}
            </v-icon>
        </v-btn>
    </div>
</template>

<script>
import { mdiStar, mdiFolderMoveOutline } from '@mdi/js';
import utils from '@/js/utils';

export default {
    name: 'FavouriteRow',
    props: {
        name: { type: String, required: true },
        descriptor: { type: String, required: true },
        settingID: { type: Number, required: true },
        timestamp: { type: Number, required: true },
        selected: { type: Boolean, default: false },
        folders: { type: Array, default: () => [] },
        currentFolderId: { default: null },
    },
    data() {
        return {
            icons: {
                star: mdiStar,
                folderMove: mdiFolderMoveOutline,
            },
        };
    },
    computed: {
        timestampString() {
            return utils.utcToString(this.timestamp);
        },
        moveTargetFolders() {
            return this.folders.filter(f => f.id !== this.currentFolderId);
        },
    },
    methods: {
        favouriteItemClicked() {
            this.$emit('favouriteItemClicked', this.settingID);
        },
        unstar() {
            this.$emit('unstar', this.settingID);
        },
    }
};
</script>

<style scoped>
.tune-title {
  font-size: 0.95rem;
  font-weight: 600;
  display: block;
}

.descriptor {
  font-style: italic;
}

.descriptor::first-letter {
  text-transform: uppercase;
}
</style>
