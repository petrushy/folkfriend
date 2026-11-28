<template>
    <v-container class="viewContainerWrapper sets-page sets-ui">
        <div
            class="sets-toolbar d-flex flex-wrap align-center my-2"
            :class="{ 'sets-toolbar-editing': !!draft }"
            style="gap:8px"
        >
            <h1>Sets</h1><v-spacer />
            <template v-if="draft">
                <v-btn
                    :disabled="busy"
                    @click="close"
                >
                    Cancel
                </v-btn>
                <v-btn
                    color="primary"
                    :disabled="!draft.name.trim() || busy"
                    :loading="busy"
                    @click="save"
                >
                    Save set
                </v-btn>
            </template>
            <v-btn
                v-else
                color="primary"
                @click="create"
            >
                New set
            </v-btn>
        </div>
        <p
            v-if="!viewedSet || draft"
            class="sets-description"
        >
            Arrange tunes in playing order. Sets are saved independently of Favorite Tunes.
        </p>
        <p
            v-if="!viewedSet || draft"
            class="sets-status"
        >
            {{ signedIn ? 'Saved on this device. Changes sync to your account.' : 'Saved on this device. Sign in in Settings to sync sets across devices.' }}
        </p>
        <v-alert
            v-if="error"
            type="error"
            dense
            dismissible
            @input="error = ''"
        >
            {{ error }}
        </v-alert>
        <v-progress-linear
            v-if="loading"
            indeterminate
            aria-label="Loading sets"
        />
        <template v-if="!draft && !viewedSet">
            <v-text-field
                v-model="filter"
                label="Find a set by name, tune or tag"
                clearable
            />
            <div
                v-if="allTags.length"
                class="d-flex flex-wrap align-center mb-3"
                style="gap:6px"
                aria-label="Filter sets by tags"
            >
                <span class="caption text--secondary">Tags:</span>
                <v-chip
                    v-for="tag in allTags"
                    :key="tag"
                    small
                    :outlined="!activeTags.includes(tag)"
                    :color="activeTags.includes(tag) ? 'primary' : undefined"
                    @click="toggleTagFilter(tag)"
                >
                    {{ tag }} <span class="caption ml-1">{{ tagCount(tag) }}</span>
                </v-chip>
                <v-btn
                    v-if="activeTags.length"
                    x-small
                    text
                    @click="activeTags = []"
                >
                    Clear
                </v-btn>
            </div>
            <v-card
                v-if="!loading && !sets.length"
                outlined
                class="pa-5"
            >
                Create a set, then search for tunes and add them in the order you want to play them. One-tune drafts are welcome.
            </v-card>
            <p v-else-if="!visibleMatches.length">
                No sets match this filter.
            </p>
            <SetRow
                v-for="{ set, tunes, tags } in visibleMatches"
                :key="set.id"
                :set="set"
                :matched-tunes="tunes"
                :matched-tags="tags"
                :all-tags="allTags"
                @view="openSet(set)"
                @edit="edit(set)"
                @duplicate="duplicate(set)"
                @add-to-session="addToSession(set)"
                @delete="deleteSet(set)"
                @tags="updateSetTags(set, $event)"
                @filter-tag="toggleTagFilter"
            />
        </template>
        <template v-else-if="!draft && viewedSet">
            <div
                class="d-flex align-center flex-wrap my-3"
                style="gap:8px"
            >
                <v-btn
                    text
                    @click="showList"
                >
                    Back to sets
                </v-btn>
                <h2 class="set-name flex-grow-1">
                    {{ viewedSet.name }}
                </h2>
                <v-btn
                    outlined
                    @click="edit(viewedSet)"
                >
                    Edit set
                </v-btn>
                <v-menu
                    offset-y
                    left
                >
                    <template #activator="{ on, attrs }">
                        <v-btn
                            icon
                            title="Set actions"
                            aria-label="Set actions"
                            v-bind="attrs"
                            v-on="on"
                        >
                            <v-icon>{{ icons.more }}</v-icon>
                        </v-btn>
                    </template>
                    <v-list dense>
                        <v-list-item @click="addToSession(viewedSet)">
                            <v-list-item-title>Add to a session…</v-list-item-title>
                        </v-list-item>
                        <v-list-item @click="duplicate(viewedSet)">
                            <v-list-item-title>Duplicate</v-list-item-title>
                        </v-list-item>
                        <v-list-item @click="deleteSet(viewedSet)">
                            <v-list-item-title class="error--text">
                                Delete
                            </v-list-item-title>
                        </v-list-item>
                    </v-list>
                </v-menu>
            </div>
            <v-chip
                v-for="tag in viewedSet.tags"
                :key="tag"
                small
                outlined
                class="mr-1 mb-2"
            >
                {{ tag }}
            </v-chip>
            <p
                v-if="viewedSet.notes"
                class="set-notes"
            >
                {{ viewedSet.notes }}
            </p>
            <p v-if="!viewedSet.entries.length">
                This set has no tunes yet. Choose Edit set to add tunes.
            </p>
            <SetScoreView
                :set="viewedSet"
                :instrument-shift="instrumentShift"
            />
        </template>
        <v-card
            v-else
            outlined
            class="pa-3"
        >
            <v-text-field
                v-model="draft.name"
                label="Set name"
                maxlength="200"
                :disabled="busy"
            />
            <v-combobox
                v-model="draft.tags"
                :items="allTags"
                label="Set tags (session, occasion, practice…)"
                multiple
                chips
                small-chips
                deletable-chips
                :disabled="busy"
            />
            <v-textarea
                v-model="draft.notes"
                label="Set notes"
                hint="For example: tempo, transitions or where you play this arrangement"
                rows="2"
                auto-grow
                maxlength="10000"
                :disabled="busy"
            />
            <p class="caption">
                Tunes in playing order · {{ draft.entries.length }} tunes. Use the arrows to rearrange. Times played counts complete runs through the score, including its written repeats.
            </p>
            <v-card
                v-for="(entry, i) in draft.entries"
                :key="entry.id"
                outlined
                class="mb-2 pa-2"
            >
                <div class="d-flex align-center flex-wrap">
                    <span class="mr-2">{{ i + 1 }}. {{ title(entry.result.displayName) }}</span>
                    <span class="caption text--secondary">{{ key(entry.result.setting.mode) }} · {{ type(entry.result.setting.dance) }}</span>
                    <v-spacer />
                    <v-btn
                        icon
                        small
                        :disabled="busy || i === 0"
                        :aria-label="'Move tune ' + (i + 1) + ' up'"
                        @click="move(i, -1)"
                    >
                        <v-icon>{{ icons.up }}</v-icon>
                    </v-btn>
                    <v-btn
                        icon
                        small
                        :disabled="busy || i === draft.entries.length - 1"
                        :aria-label="'Move tune ' + (i + 1) + ' down'"
                        @click="move(i, 1)"
                    >
                        <v-icon>{{ icons.down }}</v-icon>
                    </v-btn>
                    <v-btn
                        icon
                        small
                        :disabled="busy"
                        :aria-label="'Remove tune ' + (i + 1)"
                        @click="draft.entries.splice(i, 1)"
                    >
                        <v-icon>{{ icons.close }}</v-icon>
                    </v-btn>
                </div>
                <v-text-field
                    v-model.number="entry.repetitions"
                    type="number"
                    label="Times played"
                    min="1"
                    max="99"
                    step="1"
                    dense
                    :disabled="busy"
                    style="max-width:140px"
                />
                <v-btn
                    small
                    text
                    @click="$set(expanded, entry.id, !expanded[entry.id])"
                >
                    {{ expanded[entry.id] ? 'Hide score' : 'Show score' }}
                </v-btn>
                <SetPartnersButton
                    :tune-i-d="String(entry.result.setting.tune_id)"
                    :title="entry.result.displayName"
                    :draft-target="partnerDraftTarget(entry.id)"
                    chip
                />
                <AbcDisplay
                    v-if="expanded[entry.id]"
                    :abc="entry.result.setting.abc"
                    :title="entry.result.displayName"
                    :mode="entry.result.setting.mode"
                    :meter="entry.result.setting.meter"
                    :instrument-shift="instrumentShift"
                />
            </v-card>
            <v-form @submit.prevent="search">
                <div class="d-flex align-center">
                    <v-text-field
                        v-model="query"
                        clearable
                        label="Find a tune to add"
                        hint="Choose a setting below. Adding a tune does not star it."
                        persistent-hint
                        :disabled="busy || searching"
                    />
                    <v-btn
                        text
                        type="submit"
                        :loading="searching"
                        :disabled="busy || !(query || '').trim()"
                    >
                        Search
                    </v-btn>
                </div>
            </v-form>
            <p
                v-if="searched && !results.length && !searching"
                class="caption mt-3"
            >
                No matching settings found. Try another name or enable a tune database in Settings.
            </p>
            <v-list
                v-if="results.length"
                dense
                aria-label="Tune search results"
            >
                <v-list-item
                    v-for="r in results"
                    :key="r.setting_id"
                >
                    <v-list-item-content>
                        <v-list-item-title>
                            <v-icon
                                v-if="r.favourite"
                                small
                                color="amber darken-1"
                                aria-label="In Favorite Tunes"
                                class="mr-1"
                            >
                                {{ icons.star }}
                            </v-icon>
                            {{ title(r.display_name) }}
                        </v-list-item-title><v-list-item-subtitle>{{ key(r.setting.mode) }} · {{ type(r.setting.dance) }} · Setting {{ r.setting_id }}</v-list-item-subtitle>
                    </v-list-item-content>
                    <v-list-item-action>
                        <v-btn
                            small
                            outlined
                            :disabled="busy"
                            @click="add(r)"
                        >
                            Add
                        </v-btn>
                    </v-list-item-action>
                </v-list-item>
            </v-list>
        </v-card>
    </v-container>
</template>
<script>
import '@/assets/sets.css';
import { searchSetSettings } from '@/services/setSearch.mjs';
import { matchSets, indexFavouriteTags } from '@/js/setFilter.mjs';
import store from '@/services/store';
import ffBackend from '@/services/backend';
import eventBus from '@/eventBus';
import { keyLabel, typeLabel } from '@/js/favouriteFacets.mjs';
import utils from '@/js/utils';
import AbcDisplay from '@/components/AbcDisplay';
import SetScoreView from '@/components/SetScoreView.vue';
import SetRow from '@/components/SetRow.vue';
import SetPartnersButton from '@/components/SetPartnersButton';
import { mdiArrowUp, mdiArrowDown, mdiClose, mdiStar, mdiDotsVertical } from '@mdi/js';

export default {
    name: 'SetsView',
    components: { AbcDisplay, SetPartnersButton, SetRow, SetScoreView },
    beforeRouteLeave(to, from, next) {
        next(!this.busy && (!this.dirty || window.confirm('Discard unsaved changes to this set?')));
    },
    // Editing has its own URL (?setID=…&edit=1, or ?edit=new for an unsaved
    // new/duplicated set), so Back from the editor returns to where it was
    // opened instead of leaving the Sets page.
    beforeRouteUpdate(to, from, next) {
        if (this._editsDraft(to.query)) { next(); return; }
        if (this.busy || (this.dirty && !window.confirm('Discard unsaved changes to this set?'))) { next(false); return; }
        this.draft = null; this._pushedEdit = false; next();
    },
    data: () => ({
        viewID: null, activeTags: [],
        sets: [], favouriteTags: null, loading: true, filter: '', draft: null, original: '', version: null,
        query: '', results: [], searching: false, searched: false, expanded: {},
        busy: false, error: '', signedIn: !!store.currentUser,
        icons: { up: mdiArrowUp, down: mdiArrowDown, close: mdiClose, star: mdiStar, more: mdiDotsVertical },
    }),
    computed: {
        // Set name first, then tune names, then tags (the set's own and the
        // favourite tags of its tunes) — js/setFilter.mjs.
        visibleMatches() {
            return matchSets(this.sets, this.filter, {
                tagIndex: this.favouriteTags, activeTags: this.activeTags, displayName: utils.parseDisplayableName,
            });
        },
        viewedSet() { return this.sets.find(s => s.id === this.viewID) || null; },
        allTags() { return [...new Set(this.sets.flatMap(s => s.tags))].sort(); },
        dirty() { return this.draft && JSON.stringify(this.draft) !== this.original; },
        instrumentShift() { return store.userSettings.instrumentShift || 0; },
    },
    watch: {
        '$route.query.setID': { immediate: true, handler(value) { this.viewID = value || null; } },
        '$route.query.edit'(edit) { if (!edit) this._leaving = false; this._syncDraftToRoute(); },
    },
    created() {
        this.refresh();
        this._changed = () => this.refresh();
        this._auth = user => { this.signedIn = !!user; };
        this._unload = e => { if (this.dirty) { e.preventDefault(); e.returnValue = ''; } };
        this._favouritesChanged = () => this.refreshFavouriteTags();
        eventBus.$on('tuneSetsChanged', this._changed);
        eventBus.$on('syncComplete', this._favouritesChanged);
        eventBus.$on('authStateChanged', this._auth);
        window.addEventListener('beforeunload', this._unload);
    },
    beforeDestroy() {
        eventBus.$off('tuneSetsChanged', this._changed);
        eventBus.$off('syncComplete', this._favouritesChanged);
        eventBus.$off('authStateChanged', this._auth);
        window.removeEventListener('beforeunload', this._unload);
    },
    methods: {
        key: value => value ? keyLabel(value) : 'Key unknown',
        type: value => value ? typeLabel(value) : 'Type unknown',
        title: value => utils.parseDisplayableName(value),
        id() { return globalThis.crypto.randomUUID(); },
        // Only feeds the filter, so a failed read just means tune tags are
        // not searchable this time — never an error over the set list.
        async refreshFavouriteTags() {
            try { this.favouriteTags = indexFavouriteTags(await store.getFavourites()); }
            catch (e) { this.favouriteTags = null; }
        },
        async refresh() {
            this.refreshFavouriteTags();
            try {
                this.sets = (await store.getTuneSets()).sort((a, b) => b.updatedAt - a.updatedAt);
                this.activeTags = this.activeTags.filter(t => this.sets.some(s => s.tags.includes(t)));
            }
            catch (e) { this.error = 'Could not read sets from this device. ' + e.message; }
            finally { this.loading = false; }
            this._syncDraftToRoute();
        },
        _editsDraft(query) {
            if (!this.draft || !query.edit) return false;
            return query.edit === 'new' ? this._draftIsNew : query.setID === this.draft.id;
        },
        // A reload or deep link onto an edit URL: reopen the editor from the
        // stored set, or fall back when there is nothing to edit.
        _syncDraftToRoute() {
            const { edit, setID } = this.$route.query;
            if (!edit || this.loading || this._leaving || this._editsDraft(this.$route.query)) return;
            const set = edit === 'new' ? null : this.sets.find(s => s.id === setID);
            if (set) { this._openDraft(set); this._editReturn = { setID }; return; }
            this.$router.replace({ name: 'sets', query: setID && edit !== 'new' ? { setID } : {} }).catch(() => {});
        },
        _startEditing(draftSource, query) {
            this._openDraft(draftSource, query.edit === 'new');
            this._editReturn = this.$route.query.setID && !this.$route.query.edit ? { setID: this.$route.query.setID } : {};
            this._pushedEdit = true;
            return this.$router.push({ name: 'sets', query }).catch(() => {});
        },
        // Leave the editor: Back when we pushed it (so history does not
        // duplicate the page), otherwise replace with the target.
        _leaveEditor(target) {
            const pushed = this._pushedEdit;
            this.draft = null; this._pushedEdit = false;
            // Until the URL has left the editor, a refresh must not treat the
            // edit URL as a deep link to reopen or redirect.
            this._leaving = true;
            const returning = target === undefined;
            if (pushed && (returning || (this._editReturn || {}).setID === target.setID)) { this.$router.back(); return; }
            this.$router.replace({ name: 'sets', query: returning ? (this._editReturn || {}) : target }).catch(() => {});
        },
        toggleTagFilter(tag) { this.activeTags = this.activeTags.includes(tag) ? this.activeTags.filter(t => t !== tag) : [...this.activeTags, tag]; },
        tagCount(tag) { return this.sets.filter(s => s.tags.includes(tag)).length; },
        openSet(set) { return this.$router.push({ name: 'sets', query: { setID: set.id } }).catch(() => {}); },
        showList() { this.viewID = null; return this.$router.push({ name: 'sets' }).catch(() => {}); },
        async updateSetTags(set, tags) {
            try { await store.saveTuneSet({ ...set, tags }, set.updatedAt); await this.refresh(); }
            catch (e) { this.error = e.message; }
        },
        async deleteSet(set) {
            if (!window.confirm('Delete this set from your devices?')) return false;
            this.busy = true; this.error = '';
            try {
                await store.deleteTuneSet(set.id, set.updatedAt);
                if (this.draft?.id === set.id) this.draft = null;
                if (this.viewID === set.id) { this.busy = false; await this.showList(); }
                await this.refresh(); return true;
            } catch (e) { this.error = e.message; return false; }
            finally { this.busy = false; }
        },
        create() { this._startEditing({ id: this.id(), name: '', notes: '', tags: [], entries: [] }, { edit: 'new' }); },
        edit(set) { this._startEditing(set, { setID: set.id, edit: '1' }); },
        _openDraft(set, isNew = false) {
            this._draftIsNew = isNew;
            this.draft = JSON.parse(JSON.stringify(set));
            this.draft.entries = this.draft.entries.map(entry => ({ ...entry, repetitions: entry.repetitions === undefined ? 2 : entry.repetitions }));
            this.version = set.updatedAt || null;
            this.original = JSON.stringify(this.draft);
            this.results = []; this.query = ''; this.searched = false; this.expanded = {}; this.error = '';
        },
        // The whole set goes into the plan as one block.
        addToSession(set) {
            if (set) eventBus.$emit('showAddToSession', { sets: [set] });
        },
        duplicate(set) {
            this._startEditing({ ...set, id: this.id(), name: (set.name.slice(0, 190) + ' (copy)'), updatedAt: undefined,
                                 entries: set.entries.map(e => ({ ...e, id: this.id() })) }, { edit: 'new' });
            this.original = '';
        },
        close() { if (!this.dirty || window.confirm('Discard unsaved changes to this set?')) this._leaveEditor(); },
        move(i, offset) {
            const entry = this.draft.entries.splice(i, 1)[0];
            this.draft.entries.splice(i + offset, 0, entry);
        },
        partnerDraftTarget(entryID) {
            const draftID = this.draft.id;
            return { label: `Current draft: ${this.draft.name || 'Untitled set'}`, add: result => {
                if (!this.draft || this.draft.id !== draftID || this.busy) throw new Error('This draft is no longer open. Reopen the suggestions from the current set.');
                const index = this.draft.entries.findIndex(e => e.id === entryID);
                if (index < 0) throw new Error('The starting tune was removed. Reopen the suggestions from another tune.');
                if (result.setting_id == null || !result.setting?.abc) throw new Error('This setting is missing its ID or score. Choose another setting.');
                this.draft.entries.splice(index + 1, 0, { id: this.id(), repetitions: 2, result: {
                    settingID: result.setting_id, setting: JSON.parse(JSON.stringify(result.setting)), displayName: result.display_name,
                } });
            } };
        },
        add(r) {
            if (r.setting_id == null || !r.setting || !r.setting.abc) {
                this.error = 'This setting is missing its ID or score. Search again before adding it.';
                return;
            }
            this.draft.entries.push({ id: this.id(), repetitions: 2, result: {
                settingID: r.setting_id, setting: JSON.parse(JSON.stringify(r.setting)), displayName: r.display_name,
            } });
        },
        async search() {
            if (!(this.query || '').trim() || this.searching) return;
            this.searching = true; this.searched = true; this.error = '';
            try {
                const [ready, favourites] = await Promise.all([ffBackend.indexReady(), store.getFavourites()]);
                this.results = await searchSetSettings(ffBackend, (this.query || '').trim(), { favourites, indexReady: ready });
            } catch (e) { this.error = e.message; this.results = []; }
            finally { this.searching = false; }
        },
        async save() {
            this.busy = true; this.error = '';
            try {
                const saved = await store.saveTuneSet(this.draft, this.version);
                await this.refresh(); this.busy = false;
                // Saving always lands on the set's score view.
                this._leaveEditor({ setID: saved.id });
            }
            catch (e) { this.error = e.message; }
            finally { this.busy = false; }
        },
        async remove() {
            if (await this.deleteSet({ id: this.draft.id, updatedAt: this.version })) this.draft = null;
        },
    },
};
</script>
<style scoped>
.sets-page { width: calc(100% - 32px); max-width: 1100px; }
.sets-page h1 { font-size: 1.75rem; font-weight: 600; line-height: 1.25; }
.set-name { font-size: 1.25rem; font-weight: 600; line-height: 1.4; }
.sets-description { font-size: .9375rem; color: #616161; margin-bottom: 8px; }
.sets-status { font-size: .875rem; color: #616161; }
.set-notes { white-space: pre-wrap; font-size: .9375rem; }
.sets-toolbar-editing { position: sticky; top: 64px; z-index: 5; background: var(--ff-bg, white); padding: 8px 0; }
@media (max-width: 600px) { .sets-toolbar-editing { top: 56px; } }
</style>
