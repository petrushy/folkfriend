<template>
    <v-card
        ref="row"
        outlined
        class="set-row d-flex align-center mb-2 pa-2"
    >
        <div
            class="set-summary flex-grow-1"
            role="button"
            tabindex="0"
            :aria-label="'View ' + set.name"
            @click="$emit('view')"
            @keydown.enter.self.prevent="$emit('view')"
            @keydown.space.self.prevent="$emit('view')"
        >
            <h2 class="subtitle-1 font-weight-bold">
                {{ set.name }}
            </h2>
            <p class="caption mb-1 set-sequence">
                {{ sequence || 'Empty draft' }}
            </p>
            <p
                v-if="matchNote"
                class="caption mb-1 primary--text set-match"
            >
                {{ matchNote }}
            </p>
            <div
                v-if="set.tags.length"
                @click.stop
            >
                <v-chip
                    v-for="tag in set.tags"
                    :key="tag"
                    x-small
                    close
                    class="mr-1 mb-1"
                    @click="$emit('filter-tag', tag)"
                    @click:close="$emit('tags', set.tags.filter(t => t !== tag))"
                >
                    {{ tag }}
                </v-chip>
            </div>
        </div>
        <SetScorePreview
            v-if="rowWidth >= 540 && set.entries.length"
            :setting="set.entries[0].result.setting"
            :width="previewWidth"
            @click.native="$emit('view')"
        />
        <v-menu
            v-model="tagMenu"
            :close-on-content-click="false"
            offset-y
            left
        >
            <template #activator="{ on, attrs }">
                <v-btn
                    icon
                    title="Add tag to set"
                    :aria-label="'Add tag to ' + set.name"
                    v-bind="attrs"
                    v-on="on"
                >
                    <v-icon color="grey darken-1">
                        {{ icons.tag }}
                    </v-icon>
                </v-btn>
            </template>
            <v-card width="220">
                <v-combobox
                    v-model="tagInput"
                    :items="allTags.filter(t => !set.tags.includes(t))"
                    label="Add tag"
                    dense
                    solo
                    flat
                    hide-details
                    class="px-2 pt-1 pb-1"
                    @change="addTag"
                />
            </v-card>
        </v-menu>
        <v-menu
            offset-y
            left
        >
            <template #activator="{ on, attrs }">
                <v-btn
                    icon
                    :aria-label="'Actions for ' + set.name"
                    title="Set actions"
                    v-bind="attrs"
                    v-on="on"
                >
                    <v-icon>{{ icons.more }}</v-icon>
                </v-btn>
            </template>
            <v-list dense>
                <v-list-item @click="$emit('view')">
                    <v-list-item-title>View scores</v-list-item-title>
                </v-list-item>
                <v-list-item @click="$emit('edit')">
                    <v-list-item-title>Edit set</v-list-item-title>
                </v-list-item>
                <v-list-item @click="$emit('duplicate')">
                    <v-list-item-title>Duplicate</v-list-item-title>
                </v-list-item>
                <v-list-item @click="$emit('delete')">
                    <v-list-item-title class="error--text">
                        Delete
                    </v-list-item-title>
                </v-list-item>
            </v-list>
        </v-menu>
    </v-card>
</template>
<script>
import { mdiTagPlusOutline, mdiDotsVertical } from '@mdi/js';
import SetScorePreview from './SetScorePreview.vue';
import { keyLabel, typeLabel } from '@/js/favouriteFacets.mjs';
import utils from '@/js/utils.js';
export default {
    name: 'SetRow',
    components: { SetScorePreview },
    props: {
        set: { type: Object, required: true },
        allTags: { type: Array, default: () => [] },
        // From the list's search (js/setFilter.mjs): why this set is listed.
        matchedTunes: { type: Array, default: () => [] },
        matchedTags: { type: Array, default: () => [] },
    },
    data: () => ({ tagMenu: false, tagInput: null, rowWidth: 0, icons: { tag: mdiTagPlusOutline, more: mdiDotsVertical } }),
    computed: {
        sequence() { return this.set.entries.map(e => `${utils.parseDisplayableName(e.result.displayName)} (${keyLabel(e.result.setting.mode || '')}, ${typeLabel(e.result.setting.dance || '')})`).join(' → '); },
        // Set tags already show as chips below, so only name the tags that
        // came from the tunes.
        matchNote() {
            const tuneTags = this.matchedTags.filter(t => !this.set.tags.includes(t));
            const parts = [];
            if (this.matchedTunes.length) parts.push('Tune: ' + this.matchedTunes.join(', '));
            if (tuneTags.length) parts.push('Tune tag: ' + tuneTags.join(', '));
            return parts.join(' · ');
        },
        previewWidth() { return Math.min(480, Math.max(220, Math.floor((this.rowWidth - 300) * 0.7))); },
    },
    mounted() {
        this._measure = () => { this.rowWidth = this.$refs.row.$el.getBoundingClientRect().width; };
        this._measure();
        if (typeof ResizeObserver !== 'undefined') { this._resize = new ResizeObserver(this._measure); this._resize.observe(this.$refs.row.$el); }
        else window.addEventListener('resize', this._measure);
    },
    beforeDestroy() { if (this._resize) this._resize.disconnect(); else window.removeEventListener('resize', this._measure); },
    methods: {
        addTag(value) {
            const tag = typeof value === 'string' ? value.trim() : '';
            if (tag && !this.set.tags.includes(tag)) this.$emit('tags', [...this.set.tags, tag]);
            this.tagInput = null; this.tagMenu = false;
        },
    },
};
</script>
<style scoped>
.set-summary { min-width: 0; cursor: pointer; }
.set-sequence { color: #757575; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>
