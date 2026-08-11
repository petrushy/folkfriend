<template>
    <div ref="rowEl" class="result-row-wrapper d-flex align-center">
        <router-link
            class="flex-grow-1 d-flex align-center result-link"
            :to="{
                name: 'tune',
                query: {
                    settingID: settingID,
                    tuneID: setting.tune_id,
                    displayName: displayName,
                },
            }"
        >
            <v-container
                v-ripple
                class="flex-shrink-1"
                style="min-width: 0"
                @click="addToHistory"
            >
                <v-row class="pt-1 pb-0">
                    <v-col class="py-0">
                        <span class="tune-title">{{ name }}</span>
                    </v-col>
                </v-row>
                <v-row class="pb-0 pt-0">
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
                <v-row v-if="tags.length > 0" class="pb-2 pt-1">
                    <v-col class="py-0 d-flex flex-wrap" style="gap:4px">
                        <v-chip v-for="tag in tags" :key="tag" x-small outlined>{{ tag }}</v-chip>
                    </v-col>
                </v-row>
            </v-container>

            <!-- ABC thumbnail — only shown when the row is wide enough -->
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-if="showAbcPreview" class="abc-preview" :style="{ width: abcPreviewDisplayWidth + 'px' }" @click="addToHistory" v-html="abcSvg" />
        </router-link>
        <!-- Outside the router-link, so tapping it opens the note rather than
             navigating to the tune. -->
        <TuneBackgroundButton :tuneID="setting.tune_id" :displayName="name" :sourceUrl="setting.source_url || ''" :small="false" />
        <v-btn icon class="mr-2" :disabled="!hasValidSettingID && !favourited" @click.stop="toggleFavourite">
            <v-icon :color="favourited ? 'amber darken-1' : 'grey lighten-1'">
                {{ favourited ? starIcon : starOutlineIcon }}
            </v-icon>
        </v-btn>
    </div>
</template>

<script>
import { mdiStar, mdiStarOutline } from '@mdi/js';
import ABCJS from 'abcjs';
import utils from '@/js/utils.js';
import store from '@/services/store.js';
import ffBackend from '@/services/backend.js';
import { HistoryItem } from '@/js/schema';
import TuneBackgroundButton from '@/components/TuneBackgroundButton.vue';

// Minimum row width (px) before showing the ABC preview.
// Reserved: min text (~180) + star btn (~52) + preview min (~200) = ~432; use 480.
const ABC_PREVIEW_MIN_ROW_WIDTH = 480;

export default {
    name: 'ResultRow',
    components: { TuneBackgroundButton },
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
            type: String,
            default: '',
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
            tags: [],
            rowWidth: 0,
            // ABC for the thumbnail. Pre-populated by worker.js for transcription
            // results (which have setting_id). For name results (no setting_id)
            // or stale cached workers, we lazy-fetch it on mount.
            loadedAbc: (this.setting && this.setting.abc) || '',
            starIcon: mdiStar,
            starOutlineIcon: mdiStarOutline,
        };
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
        // Lazily fetch ABC if not already present (name query results lack
        // setting_id so worker.js cannot pre-populate it)
        if (!this.loadedAbc && this.setting && this.setting.tune_id) {
            ffBackend.settingsFromTuneID(this.setting.tune_id).then(settings => {
                const target = this.settingID
                    ? settings.find(s => String(s.setting_id) === String(this.settingID))
                    : settings[0];
                if (target && target.abc) this.loadedAbc = target.abc;
            }).catch(() => {});
        }
    },
    beforeDestroy() {
        window.removeEventListener('resize', this._queueRowWidthSync);
        if (this._resizeFrame) cancelAnimationFrame(this._resizeFrame);
    },
    created() {
        store.isTuneFavourite(this.setting.tune_id).then(v => {
            this.favourited = v;
            if (v) this._loadTags();
        });
    },
    computed: {
        descriptor: function () {
            return utils.parseDisplayableDescription(this.setting);
        },
        name: function () {
            return utils.parseDisplayableName(this.displayName);
        },
        abcPreviewDisplayWidth() {
            const reserved = 180 + 52; // min text + star btn
            const available = this.rowWidth - reserved;
            return Math.min(480, Math.max(200, Math.floor(available * 0.7)));
        },
        showAbcPreview() {
            return this.rowWidth >= ABC_PREVIEW_MIN_ROW_WIDTH && !!this.loadedAbc;
        },
        abcSvg() {
            if (!this.loadedAbc) return '';
            const lines = [];
            if (this.setting.mode) lines.push(`K:${this.setting.mode}`);
            if (this.setting.meter) lines.push(`M:${this.setting.meter}`);
            if (!/^L:/m.test(this.loadedAbc)) lines.push('L:1/8');
            let body = this.loadedAbc;
            body = body.replace(/^Q:[^\n]*/gm, '');
            body = body.replace(/"[^"]*"/g, '');
            if (/^V:/m.test(body)) {
                const filtered = [];
                let inV1 = true;
                for (const line of body.split('\n')) {
                    if (/^V:1/.test(line)) { inV1 = true; continue; }
                    if (/^V:/.test(line))  { inV1 = false; continue; }
                    if (inV1) filtered.push(line);
                }
                body = filtered.join('\n');
            }
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
                staffwidth: this.abcPreviewDisplayWidth,
                scale: 0.65,
                paddingtop: 0,
                paddingbottom: 0,
                paddingleft: 0,
                paddingright: 0,
                wrap: { minSpacing: 1, maxSpacing: 3, preferredMeasuresPerLine: 8 },
            });
            return div.innerHTML;
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
        hasValidSettingID() {
            return store._isValidSettingID(this.settingID);
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
        _loadTags() {
            store.getTagsForTune(this.setting.tune_id).then(tags => { this.tags = tags; });
        },
        addToHistory() {
            store.addToHistory(new HistoryItem({
                settingID: this.settingID,
                setting: this.setting,
                displayName: this.displayName,
            }));
        },
        async toggleFavourite() {
            if (!store._isValidSettingID(this.settingID)) {
                // Name query results have no settingID — navigate to tune to star a specific setting
                return;
            }
            if (this.favourited) {
                await store.removeFavourite(this.settingID);
                this.favourited = await store.isTuneFavourite(this.setting.tune_id);
                if (this.favourited) this._loadTags(); else this.tags = [];
            } else {
                // Query results have abc='' — fetch the full setting so the exported HTML has sheet music
                let fullSettings = null;
                try {
                    fullSettings = await ffBackend.settingsFromTuneID(this.setting.tune_id);
                } catch (e) {
                    console.warn('Could not fetch full setting, starring with empty ABC', e);
                }
                const fullSetting = fullSettings
                    ? fullSettings.find(s => String(s.setting_id) === String(this.settingID))
                    : null;
                await store.addFavourite({
                    settingID: this.settingID,
                    setting: fullSetting || this.setting,
                    displayName: this.displayName,
                });
                this.favourited = true;
                this._loadTags();
            }
        },
    },
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

.score {
  font-weight: bolder;
  font-style: italic;
}

.result-link {
  text-decoration: none;
  color: inherit;
}

.result-link div {
  background: inherit;
}

.abc-preview {
  overflow: hidden;
  max-height: 80px;
  opacity: 0.75;
  margin: 0 6px;
  flex-shrink: 0;
  align-self: center;
}

.abc-preview :deep(svg) {
  display: block;
}
</style>
