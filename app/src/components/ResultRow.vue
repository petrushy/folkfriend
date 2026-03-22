<template>
    <div class="result-row-wrapper d-flex align-center">
        <router-link
            class="flex-grow-1"
            :to="{
                name: 'tune',
                params: {
                    settingID: settingID,
                    tuneID: setting.tune_id,
                    displayName: displayName,
                },
            }"
        >
            <v-container
                v-ripple
                @click="addToHistory"
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
                    <v-col
                        v-show="score !== null"
                        class="py-0 text-right score"
                        :style="`color: ${scoreColour};`"
                    >
                        {{ scoreLabel }}
                    </v-col>
                </v-row>
            </v-container>
        </router-link>
        <v-btn icon class="mr-2" @click.stop="toggleFavourite">
            <v-icon :color="favourited ? 'amber darken-1' : 'grey lighten-1'">
                {{ favourited ? starIcon : starOutlineIcon }}
            </v-icon>
        </v-btn>
    </div>
</template>

<script>
import {mdiStar, mdiStarOutline} from '@mdi/js';
import utils from '@/js/utils.js';
import store from '@/services/store.js';
import {HistoryItem} from '@/js/schema';

export default {
    name: 'ResultRow',
    props: {
        setting: {
            type: Object,
            required: true
        },
        displayName: {
            type: String,
            required: true
        },
        settingID: {
            type: Number,
            default: null,
            required: false
        },
        score: {
            type: Number,
            default: null,
            required: false
        }
    },
    data() {
        return {
            favourited: false,
            starIcon: mdiStar,
            starOutlineIcon: mdiStarOutline,
        };
    },
    created() {
        store.isFavourite(this.settingID).then(v => {
            this.favourited = v;
        });
    },
    computed: {
        descriptor: function () {
            return utils.parseDisplayableDescription(this.setting);
        },
        name: function () {
            return utils.parseDisplayableName(this.displayName);
        },
        scoreLabel: function () {
            if (this.score > 0.65) {
                return 'Very Close';
            } else if (this.score > 0.5) {
                return 'Close';
            } else if (this.score > 0.2) {
                return 'Possible';
            } else if (this.score > 0) {
                return 'Unlikely';
            } else {
                return 'No Match';
            }
        },
        scoreColour: function () {
            let x = this.score;
            x = Math.min(0.7, x);
            x = Math.max(0.0, x);
            x = x / 0.7;

            const a = '#CC1111';
            const b = '#11CC11';
            return utils.lerpColor(a, b, x);
        },
    },
    methods: {
        addToHistory() {
            store.addToHistory(new HistoryItem({
                settingID: this.settingID,
                setting: this.setting,
                displayName: this.displayName,
            }));
        },
        toggleFavourite() {
            if (this.favourited) {
                store.removeFavourite(this.settingID);
                this.favourited = false;
            } else {
                store.addFavourite({
                    settingID: this.settingID,
                    setting: this.setting,
                    displayName: this.displayName,
                });
                this.favourited = true;
            }
        },
    },
};
</script>

<style scoped>
.descriptor {
  font-style: italic;
}

.descriptor::first-letter {
  text-transform: uppercase;
}

.score {
  font-weight: bolder;
  font-style: italic;
}

.result-row-wrapper a {
  text-decoration: none;
  color: inherit;
}

.result-row-wrapper a div {
  background: inherit;
}
</style>
