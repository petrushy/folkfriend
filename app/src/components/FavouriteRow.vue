<template>
    <div class="favouriteRow d-flex align-center">
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
            <v-row class="pb-1 pt-0">
                <v-col class="py-0 descriptor">
                    {{ descriptor }}
                </v-col>
                <v-col class="py-0 text-right timestamp">
                    {{ timestampString }}
                </v-col>
            </v-row>
            <!-- Tag chips. @click.stop prevents the row's navigation handler firing. -->
            <v-row v-if="tags.length > 0" class="pb-2 pt-0" @click.stop>
                <v-col class="py-0 d-flex flex-wrap align-center" style="gap:4px">
                    <v-chip
                        v-for="tag in tags"
                        :key="tag"
                        x-small
                        close
                        @click:close="$emit('removeTag', { settingID, tag })"
                    >
                        {{ tag }}
                    </v-chip>
                </v-col>
            </v-row>
        </v-container>

        <!-- Add-tag button, outside the clickable container -->
        <v-menu v-model="addTagMenu" :close-on-content-click="false" offset-y left>
            <template #activator="{ on }">
                <v-btn icon @click.stop v-on="on">
                    <v-icon color="grey darken-1">
                        {{ icons.tagPlus }}
                    </v-icon>
                </v-btn>
            </template>
            <v-card width="220" @click.stop>
                <v-combobox
                    v-model="tagInputValue"
                    :items="addableTags"
                    label="Add tag"
                    dense
                    solo
                    flat
                    hide-details
                    class="px-2 pt-1 pb-1"
                    @change="onTagSelected"
                    @keydown.esc.stop="addTagMenu = false"
                />
            </v-card>
        </v-menu>

        <v-btn icon class="mr-2" @click.stop="unstar">
            <v-icon color="amber darken-1">
                {{ icons.star }}
            </v-icon>
        </v-btn>
    </div>
</template>

<script>
import { mdiStar, mdiTagPlusOutline } from '@mdi/js';
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
            type: String,
            required: true
        },
        timestamp: {
            type: Number,
            required: true
        },
        tags: {
            type: Array,
            default: () => []
        },
        allTags: {
            type: Array,
            default: () => []
        },
    },
    data() {
        return {
            addTagMenu: false,
            tagInputValue: null,
            icons: {
                star: mdiStar,
                tagPlus: mdiTagPlusOutline,
            },
        };
    },
    computed: {
        timestampString() {
            return utils.utcToString(this.timestamp);
        },
        addableTags() {
            return this.allTags.filter(t => !this.tags.includes(t));
        },
    },
    methods: {
        favouriteItemClicked() {
            this.$emit('favouriteItemClicked', this.settingID);
        },
        unstar() {
            this.$emit('unstar', this.settingID);
        },
        onTagSelected(val) {
            const tag = typeof val === 'string' ? val.trim() : '';
            if (tag && !this.tags.includes(tag)) {
                this.$emit('addTag', { settingID: this.settingID, tag });
            }
            this.$nextTick(() => {
                this.tagInputValue = null;
                this.addTagMenu = false;
            });
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
