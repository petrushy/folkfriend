<template>
    <v-container v-if="name" class="viewContainerWrapper">
        <h1 class="my-2">
            {{ name }}
        </h1>

        <v-container v-if="displayableAliases.length" class="mt-0 mb-2 py-0">
            <span class="akaSpan pl-2 pr-1">Also known as</span>
            <v-chip v-for="alias in displayableAliases" :key="alias" class="ma-1 px-2" small>
                {{ alias }}
            </v-chip>
            <v-chip small class="sourceChip ma-1 px-2" @click="sourceClicked">
                {{ sourceName }}&nbsp;<v-icon small>
                    {{ icons.openInNew }}
                </v-icon>
            </v-chip>
        </v-container>
        <v-container v-else class="mt-0 mb-2 py-0">
            <v-chip small class="sourceChip ma-1 px-2 py-2" @click="sourceClicked">
                {{ sourceName }}&nbsp;<v-icon small>
                    {{ icons.openInNew }}
                </v-icon>
            </v-chip>
        </v-container>

        <v-expansion-panels ref="expansionPanels" v-model="expandedIndex" :class="{ abcFullScreen: abcFullScreen }"
            multiple>
            <v-expansion-panel v-for="(settingData, i) in settings" :key="settingData.setting_id" class="expansionPanel"
                :setting="settingData">
                <v-expansion-panel-header>
                    <div class="headerLeft">
                        <h3 class="descriptor font-weight-medium">
                            {{
                                `${settingData.dance} in ${settingData.mode.slice(
                                    0,
                                    4
                                )}`
                            }}
                        </h3>
                        <div
                            v-if="settingTags[settingData.setting_id] && settingTags[settingData.setting_id].length > 0"
                            class="settingTagRow"
                        >
                            <v-chip
                                v-for="tag in settingTags[settingData.setting_id]"
                                :key="tag"
                                x-small
                                outlined
                                @click.stop
                            >{{ tag }}</v-chip>
                        </div>
                    </div>
                    <div class="headerActions">
                        <v-menu
                            v-if="expandedIndex.includes(i) && favouritedSettings[settingData.setting_id]"
                            v-model="addTagMenus[settingData.setting_id]"
                            :close-on-content-click="false"
                            offset-y
                            left
                        >
                            <template #activator="{ on }">
                                <v-btn icon small @click.stop v-on="on">
                                    <v-icon color="grey darken-1">{{ icons.tagPlus }}</v-icon>
                                </v-btn>
                            </template>
                            <v-card width="220" @click.stop>
                                <v-combobox
                                    v-model="tagInputValues[settingData.setting_id]"
                                    :items="addableTagsFor(settingData.setting_id)"
                                    label="Add tag"
                                    dense
                                    solo
                                    flat
                                    hide-details
                                    class="px-2 pt-1 pb-1"
                                    @change="onTagSelected(settingData.setting_id, $event)"
                                    @keydown.esc.stop="$set(addTagMenus, settingData.setting_id, false)"
                                />
                            </v-card>
                        </v-menu>
                        <v-icon v-if="expandedIndex.includes(i) || favouritedSettings[settingData.setting_id]" class="settingStarIcon"
                            :color="favouritedSettings[settingData.setting_id] ? 'amber darken-1' : 'grey lighten-1'"
                            @click.stop="toggleFavourite(settingData)">
                            {{ favouritedSettings[settingData.setting_id] ? icons.star : icons.starOutline }}
                        </v-icon>
                        <v-icon v-if="settingData.hasChords" class="tabChordIcon">
                            $vuetify.icons.tabChord
                        </v-icon>
                        <v-chip v-if="expandedIndex.includes(i)" small class="sourceChip settingSourceChip px-2"
                            @click.stop="$openUrl(settingSourceUrl(settingData))">
                            {{ sourceName }}&nbsp;<v-icon small>{{ icons.openInNew }}</v-icon>
                        </v-chip>
                    </div>
                </v-expansion-panel-header>
                <v-expansion-panel-content>
                    <div v-if="settingData.composer || settingData.origin" class="settingMeta">
                        <span v-if="settingData.composer" class="settingMetaItem">
                            <span class="settingMetaLabel">Composer</span> {{ settingData.composer }}
                        </span>
                        <span v-if="settingData.origin" class="settingMetaItem">
                            <span class="settingMetaLabel">Origin</span> {{ settingData.origin }}
                        </span>
                    </div>
                    <AbcDisplay :abc="settingData.abc" :mode="settingData.mode" :meter="settingData.meter"
                        :title="name" :settingID="settingData.setting_id"
                        @abcGoFullScreen="abcGoFullScreen" @abcExitFullScreen="abcExitFullScreen"
                        @abcRendered="scrollIntoView" />
                </v-expansion-panel-content>
            </v-expansion-panel>
        </v-expansion-panels>
    </v-container>
    <v-container v-else-if="loadError" class="px-10">
        <p>{{ loadError }}</p>
    </v-container>
    <!-- This actually shouldn't ever happen unless the user manually navigates to /tunes -->
    <v-container v-else-if="!tuneID">
        <p class="px-10">
            No tune loaded. Please search for a tune.
        </p>
    </v-container>
</template>

<script>
import utils from '@/js/utils.js';
import { sourceNameForTuneID, settingSourceUrl, tuneSourceUrl } from '@/js/source.mjs';
import AbcDisplay from '@/components/AbcDisplay';
import ffBackend from '@/services/backend.js';
import eventBus from '@/eventBus';

import {
    mdiOpenInNew,
    mdiStar,
    mdiStarOutline,
    mdiTagPlusOutline,
} from '@mdi/js';
import store from '@/services/store.js';
export default {
    name: 'TuneView',
    components: { AbcDisplay },
    props: {
        tuneID: {
            type: String,
            required: false,
            default: ''
        },
        displayName: {
            type: String,
            required: false,
            default: ''
        },
        settingID: {
            type: String,
            required: false,
            default: ''
        },
    },
    data: function () {
        return {
            settings: null,
            name: null,
            displayableAliases: [],
            abcFullScreen: false,
            loadError: null,

            expandedIndex: [],
            favouritedSettings: {},
            settingTags: {},
            allTags: [],
            addTagMenus: {},
            tagInputValues: {},

            icons: {
                openInNew: mdiOpenInNew,
                star: mdiStar,
                starOutline: mdiStarOutline,
                tagPlus: mdiTagPlusOutline,
            },
        };
    },
    computed: {
        sourceName() {
            return sourceNameForTuneID(this.tuneID);
        },
        sourceUrl() {
            const selectedSetting = this.currentSettingForSource;
            return tuneSourceUrl({
                tuneID: this.tuneID,
                displayName: this.name || this.displayName,
                sourceUrl: selectedSetting ? selectedSetting.source_url : '',
            });
        },
        currentSettingForSource() {
            if (!this.settings || this.settings.length === 0) {
                return null;
            }

            const expandedIndex = this.expandedIndex[0];
            if (typeof expandedIndex === 'number' && this.settings[expandedIndex]) {
                return this.settings[expandedIndex];
            }

            return this.settings[0];
        },
    },
    created: async function () {
        eventBus.$emit('childViewActivated');

        if (this.tuneID === '') {
            return;
        }

        try {
            this.settings = await ffBackend.settingsFromTuneID(this.tuneID);
            let aliases = await ffBackend.aliasesFromTuneID(this.tuneID);

            // Detect chord symbols in ABC notation — chords are written as
            // double-quoted strings e.g. "Am", "Gmaj7", "C#dim", "G/B".
            // The pattern matches a full chord name to avoid false positives
            // from other quoted strings (e.g. text annotations).
            const chordPattern = /"[ABCDEFG]b?#?m?(in|aj)?7?(dim)?(\/[ABCDEFG]b?#?m?(in|aj)?7?(dim)?)?"/;
            this.settings = this.settings.map((settingData) => {
                settingData.hasChords = chordPattern.test(settingData.abc);
                return settingData;
            });

            let primaryAliasIndex = 0;

            if (typeof this.displayName !== 'undefined') {
                primaryAliasIndex = aliases.indexOf(this.displayName);
                if (primaryAliasIndex == -1) {
                    console.warn('Display name was not found in aliases!');
                    primaryAliasIndex = 0;
                }
            }

            this.displayableAliases = aliases.map((a) =>
                utils.parseDisplayableName(a)
            );
            this.name = this.displayableAliases.splice(primaryAliasIndex, 1)[0];

            // Load favourite state and tags for all settings, then decide which panel to open
            // Pre-declare per-setting menu/input keys so Vue 2 reactivity tracks them from the start.
            this.settings.forEach(s => {
                this.$set(this.addTagMenus, s.setting_id, false);
                this.$set(this.tagInputValues, s.setting_id, null);
            });

            [this.allTags] = await Promise.all([
                store.getAllTags(),
                ...this.settings.map(async s => {
                    const [v, tags] = await Promise.all([
                        store.isFavourite(s.setting_id),
                        store.getTagsForSetting(s.setting_id),
                    ]);
                    this.$set(this.favouritedSettings, s.setting_id, v);
                    this.$set(this.settingTags, s.setting_id, tags);
                }),
            ]);

            // Auto-pop open the matched setting:
            // 1. If a specific settingID was passed (e.g. from audio results or favourites list), use it
            // 2. Else if any setting is favourited, open the first favourited one
            // 3. Otherwise open the first setting
            if (this.settingID) {
                const requestedSettingID = String(this.settingID);
                for (const [i, setting] of this.settings.entries()) {
                    if (String(setting.setting_id) === requestedSettingID) {
                        this.expandedIndex = [i];
                        break;
                    }
                }
            } else {
                let favouritedIndex = this.settings.findIndex(s => this.favouritedSettings[s.setting_id]);
                this.expandedIndex = [favouritedIndex >= 0 ? favouritedIndex : 0];
            }
        } catch (e) {
            console.error('Failed to load tune', e);
            this.loadError = 'Could not load tune. Please go back and try again.';
        }
    },
    beforeRouteLeave: function (_to, _from, next) {
        eventBus.$emit('stopSynthPlayback');
        next();
    },
    methods: {
        descriptor: function (setting) {
            return utils.parseDisplayableDescription(setting);
        },
        abcGoFullScreen: function () {
            this.abcFullScreen = true;
        },
        abcExitFullScreen: function () {
            this.abcFullScreen = false;
        },
        scrollIntoView: function () {
            // If it's a couple of tunes down then help the user by scrolling
            //  the setting into view.
            let expandedIndex = this.expandedIndex[0];
            if (expandedIndex && expandedIndex >= 3) {
                let panels = this.$refs.expansionPanels;
                panels.$children[expandedIndex].$el.scrollIntoView();
            }
        },
        toggleFavourite: function (settingData) {
            const sid = settingData.setting_id;
            if (this.favouritedSettings[sid]) {
                store.removeFavourite(sid);
                this.$set(this.favouritedSettings, sid, false);
                this.$set(this.settingTags, sid, []);
            } else {
                store.addFavourite({
                    settingID: sid,
                    setting: settingData,
                    displayName: this.displayName,
                });
                this.$set(this.favouritedSettings, sid, true);
                store.getTagsForSetting(sid).then(tags => this.$set(this.settingTags, sid, tags));
            }
        },
        addableTagsFor(settingID) {
            const current = this.settingTags[settingID] || [];
            return this.allTags.filter(t => !current.includes(t));
        },
        async onTagSelected(settingID, val) {
            const tag = typeof val === 'string' ? val.trim() : '';
            if (tag && !(this.settingTags[settingID] || []).includes(tag)) {
                await store.addTagToFavourite(settingID, tag);
                if (!this.allTags.includes(tag)) this.allTags = [...this.allTags, tag].sort();
                const tags = await store.getTagsForSetting(settingID);
                this.$set(this.settingTags, settingID, tags);
            }
            this.$nextTick(() => {
                this.$set(this.tagInputValues, settingID, null);
                this.$set(this.addTagMenus, settingID, false);
            });
        },
        sourceClicked: function () {
            window.open(this.sourceUrl);
        },
        settingSourceUrl: function (settingData) {
            return settingSourceUrl({
                tuneID: this.tuneID,
                settingID: settingData.setting_id,
                displayName: this.name || this.displayName,
                sourceUrl: settingData.source_url,
            });
        },
        $openUrl: function (url) {
            window.open(url);
        }
    },
};
</script>

<style scoped>
.descriptor::first-letter {
    text-transform: uppercase;
    display: inline-block;
}

.abcFullScreen {
    z-index: 8;
}

h1 {
    font-size: x-large;
}

.expansionPanel {
    scroll-margin-top: 60px;
}

.sourceChip {
    font-style: italic;
}

.settingSourceChip {
    flex: 0 0 auto;
}

.headerLeft {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
}

.settingTagRow {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
}

.headerActions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    flex: 0 0 auto;
}

.settingStarIcon {
    cursor: pointer;
}

.akaSpan {
    font-size: smaller;
    font-style: italic;
}

.settingMeta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding: 8px 0 4px;
    font-size: 0.85em;
    color: rgba(0, 0, 0, 0.6);
}

.settingMetaLabel {
    font-weight: 600;
    margin-right: 4px;
}
</style>
