<template>
    <div
        ref="rowEl"
        class="favourite-row-wrapper d-flex align-center"
    >
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
                    <span v-if="altName" class="tune-alt-name ml-1">(also {{ altName }})</span>
                </v-col>
            </v-row>
            <v-row class="pb-0 pt-0">
                <v-col class="py-0 tune-meta">
                    {{ descriptor }}, {{ timestampString }}
                </v-col>
            </v-row>
            <!-- Tag chips — @click.stop on the row prevents bubbling to the container's navigation handler -->
            <v-row
                v-if="tags.length > 0"
                class="pb-2 pt-1"
                @click.stop
            >
                <v-col
                    class="py-0 d-flex flex-wrap align-center"
                    style="gap:4px"
                >
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
            <v-row
                v-if="sets.length"
                class="pt-1"
                @click.stop
            >
                <v-col
                    class="py-0 d-flex flex-wrap align-center"
                    style="gap:4px"
                    aria-label="Sets containing this setting"
                >
                    <span class="caption text--secondary">In sets:</span>
                    <v-chip
                        v-for="set in sets"
                        :key="set.id"
                        x-small
                        outlined
                        :to="{ name: 'sets', query: { setID: set.id } }"
                    >
                        {{ set.name }}
                    </v-chip>
                </v-col>
            </v-row>
        </v-container>

        <!-- ABC preview — only rendered when the row is wide enough -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div
            v-if="showAbcPreview"
            class="abc-preview"
            :style="{ width: abcPreviewDisplayWidth + 'px' }"
            @click.stop="favouriteItemClicked"
            v-html="abcSvg"
        />

        <!-- Session recording ▶ — only when a saved session recorded this tune -->
        <v-btn
            v-if="recordingCount > 0"
            icon
            class="mr-0"
            :aria-label="recordingPlaying ? `Pause ${name}` : (recordingCount > 1 ? `Play ${name} from a session recording (${recordingCount} sessions)` : `Play ${name} from the session recording, looped`)"
            :aria-pressed="recordingPlaying ? 'true' : 'false'"
            @click.stop="$emit('playRecording', tuneID)"
        >
            <v-icon color="primary">
                {{ recordingPlaying ? icons.pause : icons.play }}
            </v-icon>
        </v-btn>

        <!-- Tune background (i) — outside the clickable container so it does not navigate -->
        <TuneBackgroundButton
            :tune-i-d="tuneID"
            :display-name="name"
            :source-url="sourceUrl"
            :small="false"
        />

        <!-- One button, two destinations: the row has no width to spare. -->
        <v-menu offset-y left>
            <template #activator="{ on, attrs }">
                <v-btn
                    icon
                    class="mr-0"
                    title="Add to a set or a session"
                    :aria-label="'Add ' + name + ' to a set or a session'"
                    v-bind="attrs"
                    @click.stop
                    v-on="on"
                >
                    <v-icon color="grey darken-1">
                        {{ icons.addToSet }}
                    </v-icon>
                </v-btn>
            </template>
            <v-list dense>
                <v-list-item @click="$emit('addToSet', settingID)">
                    <v-list-item-title>Add to a set…</v-list-item-title>
                </v-list-item>
                <v-list-item @click="$emit('addToSession', settingID)">
                    <v-list-item-title>Add to a session plan…</v-list-item-title>
                </v-list-item>
            </v-list>
        </v-menu>

        <!-- Add tag button — outside the clickable container, left of star, easy to tap -->
        <v-menu
            v-model="addTagMenu"
            :close-on-content-click="false"
            offset-y
            left
        >
            <template #activator="{ on }">
                <v-btn
                    icon
                    class="mr-0"
                    @click.stop
                    v-on="on"
                >
                    <v-icon color="grey darken-1">
                        {{ icons.plus }}
                    </v-icon>
                </v-btn>
            </template>
            <v-card
                width="220"
                @click.stop
            >
                <v-combobox
                    ref="tagInput"
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

        <v-btn
            icon
            class="mr-2"
            @click.stop="unstar"
        >
            <v-icon color="amber darken-1">
                {{ icons.star }}
            </v-icon>
        </v-btn>
    </div>
</template>

<script>
import { mdiStar, mdiPlaylistPlus, mdiTagPlusOutline, mdiPlayCircleOutline, mdiPauseCircleOutline } from '@mdi/js';
import ABCJS from 'abcjs';
import utils from '@/js/utils';
import { previewAbc, previewBars, previewRenderOptions } from '@/js/abcPreview.mjs';
import TuneBackgroundButton from '@/components/TuneBackgroundButton.vue';

// Minimum row width (px) before the ABC preview is shown.
// Left of preview: checkbox(~40) + tune info min(~180) = ~220
// Right of preview: add-tag btn(~36) + star btn(~52) = ~88
// Preview itself needs at least ~200px → total ~508; use 540 to give a little breathing room.
const ABC_PREVIEW_MIN_ROW_WIDTH = 540;

// Engraving the preview is by far the most expensive thing a row does — a full
// ABCJS layout pass producing several hundred SVG nodes, a few milliseconds on
// a desktop and several times that on an older iPad. Doing it for every row in
// a long list, synchronously, during the render that is supposed to put the
// view on screen, is what made Favourites take seconds to appear. So a row only
// engraves once it is actually near the viewport. One screen of lookahead, so
// the score is there by the time the row is scrolled onto.
const PREVIEW_LOOKAHEAD_PX = 400;

export default {
    name: 'FavouriteRow',
    components: { TuneBackgroundButton },
    props: {
        name: { type: String, required: true },
        // Passed separately from `setting` because the tag- and date-grouped
        // lists do not bind `setting` (they have no ABC preview) but still want
        // the background button.
        tuneID: { type: [String, Number], default: '' },
        sourceUrl: { type: String, default: '' },
        descriptor: { type: String, required: true },
        // The database name, when the user has given the tune their own.
        altName: { type: String, default: '' },
        settingID: { type: String, required: true },
        timestamp: { type: Number, required: true },
        selected: { type: Boolean, default: false },
        tags: { type: Array, default: () => [] },
        sets: { type: Array, default: () => [] },
        allTags: { type: Array, default: () => [] },
        setting: { type: Object, default: null },
        // How many saved sessions hold a playable recording of this TUNE (any
        // setting of it). Zero hides the ▶.
        recordingCount: { type: Number, default: 0 },
        // This tune is what the session player is playing right now: the ▶
        // becomes a pause, and the same tap stops it.
        recordingPlaying: { type: Boolean, default: false },
    },
    data() {
        return {
            rowWidth: 0,
            // Set by the IntersectionObserver below. Without an observer
            // (a genuinely old browser) it starts true and behaves as before.
            inView: typeof IntersectionObserver === 'undefined',
            addTagMenu: false,
            tagInputValue: null,
            icons: {
                star: mdiStar,
                addToSet: mdiPlaylistPlus,
                plus: mdiTagPlusOutline,
                play: mdiPlayCircleOutline,
                pause: mdiPauseCircleOutline,
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
        abcPreviewDisplayWidth() {
            // buttons (add-tag ~40 + star ~52) + checkbox (~44) + min tune-info (~180)
            // plus the recording ▶ (~36) when there is one.
            const reserved = 44 + 180 + 92 + (this.recordingCount > 0 ? 36 : 0);
            const available = this.rowWidth - reserved;
            return Math.min(480, Math.max(220, Math.floor(available * 0.7)));
        },
        showAbcPreview() {
            return this.inView
                && this.rowWidth >= ABC_PREVIEW_MIN_ROW_WIDTH
                && !!this.setting && !!this.setting.abc;
        },
        abcSvg() {
            if (!this.setting || !this.setting.abc) return '';
            const width = this.abcPreviewDisplayWidth;
            const div = document.createElement('div');
            ABCJS.renderAbc(div, previewAbc(this.setting, previewBars(width)), previewRenderOptions(width));
            return div.innerHTML;
        },
    },
    mounted() {
        this._syncRowWidth = () => {
            if (!this.$refs.rowEl) return;
            const nextWidth = Math.round(this.$refs.rowEl.getBoundingClientRect().width);
            if (this.rowWidth !== nextWidth) {
                this.rowWidth = nextWidth;
            }
        };
        this._queueRowWidthSync = () => {
            if (this._resizeFrame) cancelAnimationFrame(this._resizeFrame);
            this._resizeFrame = requestAnimationFrame(() => {
                this._syncRowWidth();
                this._resizeFrame = null;
            });
        };
        window.addEventListener('resize', this._queueRowWidthSync, { passive: true });
        // Measured here rather than a frame later: the element is already in the
        // DOM, and deferring only bought the row a second render pass before it
        // could know whether it had room for a preview at all.
        this._syncRowWidth();
        // Kept as a safety net: if the row was not laid out yet (a hidden
        // parent, a font still loading) the synchronous read above is 0.
        this.$nextTick(() => this._queueRowWidthSync());

        if (typeof IntersectionObserver !== 'undefined' && this.$refs.rowEl) {
            this._visibilityObserver = new IntersectionObserver(entries => {
                if (!entries.some(e => e.isIntersecting)) return;
                this.inView = true;
                // One-way: a row that has been engraved keeps its score rather
                // than re-rendering it every time it scrolls past.
                this._disconnectVisibilityObserver();
            }, { rootMargin: `${PREVIEW_LOOKAHEAD_PX}px 0px` });
            this._visibilityObserver.observe(this.$refs.rowEl);
        } else {
            this.inView = true;
        }
    },
    beforeDestroy() {
        window.removeEventListener('resize', this._queueRowWidthSync);
        if (this._resizeFrame) cancelAnimationFrame(this._resizeFrame);
        this._disconnectVisibilityObserver();
    },
    methods: {
        _disconnectVisibilityObserver() {
            if (!this._visibilityObserver) return;
            this._visibilityObserver.disconnect();
            this._visibilityObserver = null;
        },
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
.tune-alt-name {
    font-size: 0.8rem;
    opacity: 0.7;
    line-height: 1.2;
}
.tune-title {
  font-size: 0.95rem;
  font-weight: 600;
  display: block;
}

.tune-meta {
  font-style: italic;
  color: #757575; /* grey darken-1 */
  font-size: 0.85rem;
}

.tune-meta::first-letter {
  text-transform: uppercase;
}

.abc-preview {
  /* width set inline; height capped to one staff line — second wraps clip below */
  overflow: hidden;
  max-height: 80px;
  opacity: 0.75;
  margin: 0 6px;
  flex-shrink: 0;
  align-self: center;
  cursor: pointer;
}

.abc-preview :deep(svg) {
  display: block;
}
</style>
