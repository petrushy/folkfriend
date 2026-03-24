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
                    <h2>{{ name }}</h2>
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
        <v-btn icon class="mr-2" @click.stop="unstar">
            <v-icon color="amber darken-1">
                {{ starIcon }}
            </v-icon>
        </v-btn>
    </div>
</template>

<script>
import {mdiStar} from '@mdi/js';
import utils from '@/js/utils';

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
        timestamp: {
            type: Number,
            required: true
        },
        selected: {
            type: Boolean,
            default: false
        },
    },
    data() {
        return {
            starIcon: mdiStar,
        };
    },
    computed: {
        timestampString() {
            return utils.utcToString(this.timestamp);
        }
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
