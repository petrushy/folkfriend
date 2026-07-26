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

        <v-alert v-if="offlineFallback" dense text type="info" class="mx-2 my-2">
            Showing your saved offline copy. Connect to the internet to see all
            settings for this tune.
        </v-alert>

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

// Absolute last-resort cap on waiting for the tune index. This should never
// fire: ffBackend.indexReady() resolves as soon as the worker's state machine
// settles, and the worker's network calls are themselves bounded. It exists
// only so that a bug in that chain degrades to the offline copy rather than a
// blank screen.
const TUNE_INDEX_WAIT_MS = 20000;

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
            // True when the tune index was unavailable and we rendered from the
            // user's saved (favourite) copy instead — shown as a banner.
            offlineFallback: false,

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
            const loaded = await this._loadSettingsAndAliases();
            if (!loaded) {
                this.loadError = navigator.onLine
                    ? 'Could not load tune. Please go back and try again.'
                    : "This tune isn't saved for offline use. Open it once while online, or favourite it, to view it without a connection.";
                return;
            }
            this.settings = loaded.settings;
            let aliases = loaded.aliases;

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
    mounted: function () {
        // If we rendered from the offline fallback (or failed outright) and the
        // index later becomes available — connectivity returns and the
        // background download finishes — upgrade the view in place rather than
        // leaving the user on a partial copy.
        this._onIndexStatus = (detail) => {
            if (detail.status !== 'ready') return;
            if (!this.offlineFallback && !this.loadError) return;
            this._reloadFromIndex();
        };
        eventBus.$on('indexStatusChanged', this._onIndexStatus);
    },
    beforeDestroy: function () {
        eventBus.$off('indexStatusChanged', this._onIndexStatus);
    },
    beforeRouteLeave: function (_to, _from, next) {
        eventBus.$emit('stopSynthPlayback');
        next();
    },
    methods: {
        async _reloadFromIndex() {
            if (!this.tuneID || this._reloading) return;
            this._reloading = true;
            try {
                const [settings, aliases] = await Promise.all([
                    ffBackend.settingsFromTuneID(this.tuneID),
                    ffBackend.aliasesFromTuneID(this.tuneID),
                ]);
                if (!settings || !settings.length) return;
                const chordPattern = /"[ABCDEFG]b?#?m?(in|aj)?7?(dim)?(\/[ABCDEFG]b?#?m?(in|aj)?7?(dim)?)?"/;
                this.settings = settings.map(s => ({ ...s, hasChords: chordPattern.test(s.abc) }));
                if (aliases && aliases.length) {
                    const displayable = aliases.map(a => utils.parseDisplayableName(a));
                    let primary = this.displayName ? aliases.indexOf(this.displayName) : 0;
                    if (primary === -1) primary = 0;
                    this.displayableAliases = displayable;
                    this.name = this.displayableAliases.splice(primary, 1)[0];
                }
                this.offlineFallback = false;
                this.loadError = null;
            } catch (e) {
                console.warn('Could not upgrade tune view from index', e);
            } finally {
                this._reloading = false;
            }
        },
        // Load this tune's settings + aliases from the WASM index, or — if the
        // index is unavailable (offline before an offline copy was saved) —
        // from the self-contained copy stored in the user's favourites.
        async _loadSettingsAndAliases() {
            const status = await this._waitForIndex(TUNE_INDEX_WAIT_MS);

            if (status === 'ready') {
                const [settings, aliases] = await Promise.all([
                    ffBackend.settingsFromTuneID(this.tuneID),
                    ffBackend.aliasesFromTuneID(this.tuneID),
                ]);
                if (settings && settings.length) {
                    return { settings, aliases };
                }
            }

            const fallback = await this._settingsFromFavourites();
            if (fallback) {
                this.offlineFallback = true;
                return fallback;
            }
            return null;
        },
        // Resolve as soon as the index is usable or definitively unavailable.
        // ffBackend.indexReady() reads the worker's state machine, which always
        // reaches a terminal state, so the common offline case returns
        // immediately instead of burning a timeout per tune.
        _waitForIndex(timeoutMs) {
            let timer = null;
            const timeout = new Promise((resolve) => {
                timer = setTimeout(() => resolve('timeout'), timeoutMs);
            });
            return Promise.race([
                ffBackend.indexReady().then(ok => (ok ? 'ready' : 'error')),
                timeout,
            ]).finally(() => clearTimeout(timer));
        },
        // Reconstruct settings for this tune from favourites (stored with their
        // own ABC), so favourited tunes remain fully viewable offline.
        async _settingsFromFavourites() {
            let favourites;
            try {
                favourites = await store.getFavourites();
            } catch (e) {
                console.warn('Could not read favourites for offline fallback', e);
                return null;
            }

            const tuneID = String(this.tuneID);
            const seen = new Set();
            const settings = [];
            const aliases = [];
            for (const fav of favourites) {
                const setting = fav.result && fav.result.setting;
                if (!setting || String(setting.tune_id) !== tuneID) continue;

                const settingID = String(fav.result.settingID ?? setting.setting_id);
                if (seen.has(settingID)) continue;
                seen.add(settingID);

                // Clone so we never mutate the cached favourite object.
                settings.push({
                    ...setting,
                    setting_id: fav.result.settingID ?? setting.setting_id,
                });

                if (fav.result.displayName && !aliases.includes(fav.result.displayName)) {
                    aliases.push(fav.result.displayName);
                }
            }

            if (settings.length === 0) return null;
            if (this.displayName && !aliases.includes(this.displayName)) {
                aliases.unshift(this.displayName);
            }
            return { settings, aliases };
        },
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
