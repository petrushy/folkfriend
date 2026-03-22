<template>
    <div class="favourite-row-wrapper d-flex align-center">
        <v-container
            v-ripple
            class="flex-grow-1"
            @click="favouriteItemClicked"
        >
            <v-row class="pt-1 pb-0">
                <v-col class="py-0">
                    <h2>{{ name }}</h2>
                </v-col>
            </v-row>
            <v-row class="pb-2 pt-0">
                <v-col class="py-0 descriptor">
                    {{ descriptor }}
                </v-col>
            </v-row>
        </v-container>
        <v-btn icon class="mr-2" @click.stop="unstar">
            <v-icon color="amber darken-1">
                {{ starIcon }}
            </v-icon>
        </v-btn>
    </div>
</template>

<script>
import {mdiStar} from '@mdi/js';

export default {
    name: 'FavouriteRow',
    props: {
        name: {
            type: String,
            required: true
        },
        descriptor: {
            type: String,
            required: true
        },
        settingID: {
            type: Number,
            required: true
        },
    },
    data() {
        return {
            starIcon: mdiStar,
        };
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
.descriptor {
  font-style: italic;
}

.descriptor::first-letter {
  text-transform: uppercase;
}
</style>
