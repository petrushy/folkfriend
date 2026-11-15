<template>
    <v-container class="viewContainerWrapper">
        <div class="d-flex align-center my-2">
            <h1>Sets</h1><v-spacer />
            <v-btn
                color="primary"
                :disabled="!!draft"
                @click="create"
            >
                New set
            </v-btn>
        </div>
        <p class="text--secondary">
            Arrange tunes in playing order. Sets are saved independently of Favorite Tunes.
        </p>
        <p class="caption">
            {{ signedIn ? 'Changes are saved on this device and sync to your account. Concurrent edits to the same set use the latest saved version.' : 'Saved on this device. Sign in in Settings to sync sets across devices.' }}
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
        <template v-if="!draft">
            <v-text-field
                v-model="filter"
                label="Find a set by name or tag"
                clearable
            />
            <v-card
                v-if="!loading && !sets.length"
                outlined
                class="pa-5"
            >
                Create a set, then search for tunes and add them in the order you want to play them. One-tune drafts are welcome.
            </v-card>
            <p v-else-if="!visibleSets.length">
                No sets match this filter.
            </p>
            <v-card
                v-for="set in visibleSets"
                :key="set.id"
                outlined
                class="mb-3 pa-3"
            >
                <h2 class="title">
                    {{ set.name }}
                </h2>
                <p class="mb-2">
                    {{ set.entries.map(e => title(e.result.displayName) + ' (' + key(e.result.setting.mode) + ', ' + type(e.result.setting.dance) + ')').join(' → ') || 'Empty draft' }}
                </p>
                <v-chip
                    v-for="tag in set.tags"
                    :key="tag"
                    small
                    outlined
                    class="mr-1 mb-2"
                >
                    {{ tag }}
                </v-chip>
                <p
                    v-if="set.notes"
                    class="set-notes"
                >
                    {{ set.notes }}
                </p>
                <v-btn
                    text
                    color="primary"
                    @click="edit(set)"
                >
                    Open set
                </v-btn>
                <v-btn
                    text
                    @click="duplicate(set)"
                >
                    Duplicate
                </v-btn>
            </v-card>
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
                Tunes in playing order · {{ draft.entries.length }} tunes. Use the arrows to rearrange.
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
                        label="Find a tune to add"
                        hint="Choose a setting below. Adding a tune does not star it."
                        persistent-hint
                        :disabled="busy || searching"
                    />
                    <v-btn
                        text
                        type="submit"
                        :loading="searching"
                        :disabled="busy || !query.trim()"
                    >
                        Search
                    </v-btn>
                </div>
            </v-form>
            <p
                v-if="searched && !results.length && !searching"
                class="caption mt-3"
            >
                No settings found. Check the name and that a tune database is available in Settings.
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
                    <v-list-item-content><v-list-item-title>{{ title(r.display_name) }}</v-list-item-title><v-list-item-subtitle>{{ key(r.setting.mode) }} · {{ type(r.setting.dance) }} · Setting {{ r.setting_id }}</v-list-item-subtitle></v-list-item-content>
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
            <div
                class="d-flex flex-wrap mt-4"
                style="gap:8px"
            >
                <v-btn
                    color="primary"
                    :disabled="!draft.name.trim() || busy"
                    :loading="busy"
                    @click="save"
                >
                    Save set
                </v-btn>
                <v-btn
                    :disabled="busy"
                    @click="close"
                >
                    Close
                </v-btn>
                <v-spacer />
                <v-btn
                    v-if="version !== null"
                    text
                    color="error"
                    :disabled="busy"
                    @click="remove"
                >
                    Delete set
                </v-btn>
            </div>
        </v-card>
    </v-container>
</template>
<script>
import { searchSetSettings } from '@/services/setSearch.mjs';
import store from '@/services/store';
import ffBackend from '@/services/backend';
import eventBus from '@/eventBus';
import { keyLabel, typeLabel } from '@/js/favouriteFacets.mjs';
import utils from '@/js/utils';
import AbcDisplay from '@/components/AbcDisplay';
import SetPartnersButton from '@/components/SetPartnersButton';
import { mdiArrowUp, mdiArrowDown, mdiClose } from '@mdi/js';

export default {
    name: 'SetsView',
    components: { AbcDisplay, SetPartnersButton },
    beforeRouteLeave(to, from, next) {
        next(!this.busy && (!this.dirty || window.confirm('Discard unsaved changes to this set?')));
    },
    data: () => ({
        sets: [], loading: true, filter: '', draft: null, original: '', version: null,
        query: '', results: [], searching: false, searched: false, expanded: {},
        busy: false, error: '', signedIn: !!store.currentUser,
        icons: { up: mdiArrowUp, down: mdiArrowDown, close: mdiClose },
    }),
    computed: {
        visibleSets() {
            const q = (this.filter || '').toLocaleLowerCase();
            return this.sets.filter(s => [s.name, ...s.tags].some(t => t.toLocaleLowerCase().includes(q)));
        },
        allTags() { return [...new Set(this.sets.flatMap(s => s.tags))].sort(); },
        dirty() { return this.draft && JSON.stringify(this.draft) !== this.original; },
        instrumentShift() { return store.userSettings.instrumentShift || 0; },
    },
    created() {
        this.refresh();
        this._changed = () => this.refresh();
        this._auth = user => { this.signedIn = !!user; };
        this._unload = e => { if (this.dirty) { e.preventDefault(); e.returnValue = ''; } };
        eventBus.$on('tuneSetsChanged', this._changed);
        eventBus.$on('authStateChanged', this._auth);
        window.addEventListener('beforeunload', this._unload);
    },
    beforeDestroy() {
        eventBus.$off('tuneSetsChanged', this._changed);
        eventBus.$off('authStateChanged', this._auth);
        window.removeEventListener('beforeunload', this._unload);
    },
    methods: {
        key: value => value ? keyLabel(value) : 'Key unknown',
        type: value => value ? typeLabel(value) : 'Type unknown',
        title: value => utils.parseDisplayableName(value),
        id() { return globalThis.crypto.randomUUID(); },
        async refresh() {
            try { this.sets = (await store.getTuneSets()).sort((a, b) => b.updatedAt - a.updatedAt); }
            catch (e) { this.error = 'Could not read sets from this device. ' + e.message; }
            finally { this.loading = false; }
        },
        create() { this.edit({ id: this.id(), name: '', notes: '', tags: [], entries: [] }); },
        edit(set) {
            this.draft = JSON.parse(JSON.stringify(set));
            this.version = set.updatedAt || null;
            this.original = JSON.stringify(this.draft);
            this.results = []; this.query = ''; this.searched = false; this.expanded = {}; this.error = '';
        },
        duplicate(set) {
            this.edit({ ...set, id: this.id(), name: (set.name.slice(0, 190) + ' (copy)'), updatedAt: undefined,
                        entries: set.entries.map(e => ({ ...e, id: this.id() })) });
            this.original = '';
        },
        close() { if (!this.dirty || window.confirm('Discard unsaved changes to this set?')) this.draft = null; },
        move(i, offset) {
            const entry = this.draft.entries.splice(i, 1)[0];
            this.draft.entries.splice(i + offset, 0, entry);
        },
        add(r) {
            if (r.setting_id == null || !r.setting || !r.setting.abc) {
                this.error = 'This setting is missing its ID or score. Search again before adding it.';
                return;
            }
            this.draft.entries.push({ id: this.id(), result: {
                settingID: r.setting_id, setting: JSON.parse(JSON.stringify(r.setting)), displayName: r.display_name,
            } });
        },
        async search() {
            if (!this.query.trim() || this.searching) return;
            this.searching = true; this.searched = true; this.error = '';
            try {
                const ready = await ffBackend.indexReady();
                if (!ready) throw new Error('No tune database is available. Open Settings to download one.');
                this.results = await searchSetSettings(ffBackend, this.query.trim());
            } catch (e) { this.error = e.message; this.results = []; }
            finally { this.searching = false; }
        },
        async save() {
            this.busy = true; this.error = '';
            try { await store.saveTuneSet(this.draft, this.version); this.draft = null; await this.refresh(); }
            catch (e) { this.error = e.message; }
            finally { this.busy = false; }
        },
        async remove() {
            if (!window.confirm('Delete this set from your devices?')) return;
            this.busy = true;
            try { await store.deleteTuneSet(this.draft.id, this.version); this.draft = null; await this.refresh(); }
            catch (e) { this.error = e.message; }
            finally { this.busy = false; }
        },
    },
};
</script>
<style scoped>
.set-notes { white-space: pre-wrap; }
</style>
