<template>
    <div ref="rowEl" class="favourite-row-wrapper d-flex align-center">
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
            <v-row class="pb-0 pt-0">
                <v-col class="py-0 tune-meta">
                    {{ descriptor }}, {{ timestampString }}
                </v-col>
            </v-row>
            <!-- Tag chips — @click.stop on the row prevents bubbling to the container's navigation handler -->
            <v-row v-if="tags.length > 0" class="pb-2 pt-1" @click.stop>
                <v-col class="py-0 d-flex flex-wrap align-center" style="gap:4px">
                    <v-chip
                        v-for="tag in tags"
                        :key="tag"
                        x-small
                        close
                        @click:close="$emit('removeTag', { settingID, tag })"
                    >{{ tag }}</v-chip>
                </v-col>
            </v-row>
        </v-container>

        <!-- ABC preview — only rendered when the row is wide enough -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-if="showAbcPreview" class="abc-preview" :style="{ width: abcPreviewDisplayWidth + 'px' }" @click.stop="favouriteItemClicked" v-html="abcSvg" />

        <!-- Add tag button — outside the clickable container, left of star, easy to tap -->
        <v-menu v-model="addTagMenu" :close-on-content-click="false" offset-y left>
            <template #activator="{ on }">
                <v-btn icon class="mr-0" @click.stop v-on="on">
                    <v-icon color="grey darken-1">{{ icons.plus }}</v-icon>
                </v-btn>
            </template>
            <v-card width="220" @click.stop>
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

        <v-btn icon class="mr-2" @click.stop="unstar">
            <v-icon color="amber darken-1">
                {{ icons.star }}
            </v-icon>
        </v-btn>
    </div>
</template>

<script>
import { mdiStar, mdiTagPlusOutline } from '@mdi/js';
import ABCJS from 'abcjs';
import utils from '@/js/utils';

// Minimum row width (px) before the ABC preview is shown.
// Left of preview: checkbox(~40) + tune info min(~180) = ~220
// Right of preview: add-tag btn(~36) + star btn(~52) = ~88
// Preview itself needs at least ~200px → total ~508; use 540 to give a little breathing room.
const ABC_PREVIEW_MIN_ROW_WIDTH = 540;

export default {
    name: 'FavouriteRow',
    props: {
        name: { type: String, required: true },
        descriptor: { type: String, required: true },
        settingID: { type: String, required: true },
        timestamp: { type: Number, required: true },
        selected: { type: Boolean, default: false },
        tags: { type: Array, default: () => [] },
        allTags: { type: Array, default: () => [] },
        setting: { type: Object, default: null },
    },
    data() {
        return {
            rowWidth: 0,
            addTagMenu: false,
            tagInputValue: null,
            icons: {
                star: mdiStar,
                plus: mdiTagPlusOutline,
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
            const reserved = 44 + 180 + 92;
            const available = this.rowWidth - reserved;
            return Math.min(480, Math.max(220, Math.floor(available * 0.7)));
        },
        showAbcPreview() {
            return this.rowWidth >= ABC_PREVIEW_MIN_ROW_WIDTH && !!this.setting && !!this.setting.abc;
        },
        abcSvg() {
            if (!this.setting || !this.setting.abc) return '';
            const lines = [];
            if (this.setting.mode) lines.push(`K:${this.setting.mode}`);
            if (this.setting.meter) lines.push(`M:${this.setting.meter}`);
            if (!/^L:/m.test(this.setting.abc)) lines.push('L:1/8');
            // Strip chord annotations and tempo — chords add vertical whitespace above the staff.
            let body = this.setting.abc;
            body = body.replace(/^Q:[^\n]*/gm, '');
            body = body.replace(/"[^"]*"/g, '');
            // Strip multi-voice ABC — keep only V:1 content so only one staff renders.
            if (/^V:/m.test(body)) {
                const filtered = [];
                let inV1 = true; // before any V: marker, include content
                for (const line of body.split('\n')) {
                    if (/^V:1/.test(line)) { inV1 = true; continue; }
                    if (/^V:/.test(line))  { inV1 = false; continue; }
                    if (inV1) filtered.push(line);
                }
                body = filtered.join('\n');
            }
            // Show more bars when more space is available.
            // Each bar is roughly 110px at scale 0.65, so derive bar count from width.
            // +1 to account for the leading |: repeat marker which counts as a pipe but isn't a bar.
            const maxBars = this.abcPreviewDisplayWidth < 300 ? 2
                          : this.abcPreviewDisplayWidth < 390 ? 3
                          : 4;
            const targetPipes = maxBars + 1;
            let count = 0;
            let cutAt = body.length;
            for (let i = 0; i < body.length; i++) {
                if (body[i] === '|' && ++count >= targetPipes) { cutAt = i + 1; break; }
            }
            lines.push(body.slice(0, cutAt));

            const div = document.createElement('div');
            ABCJS.renderAbc(div, lines.join('\n'), {
                // Render at actual display width so no CSS scaling is needed.
                // scale zooms note size (1.0 = default); 0.65 gives compact but readable notation.
                staffwidth: this.abcPreviewDisplayWidth,
                scale: 0.65,
                paddingtop: 0,
                paddingbottom: 0,
                paddingleft: 0,
                paddingright: 0,
                // Force everything onto one line regardless of time signature width
                wrap: { minSpacing: 1, maxSpacing: 3, preferredMeasuresPerLine: 8 },
            });
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
        this.$nextTick(() => this._queueRowWidthSync());
    },
    beforeDestroy() {
        window.removeEventListener('resize', this._queueRowWidthSync);
        if (this._resizeFrame) cancelAnimationFrame(this._resizeFrame);
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
