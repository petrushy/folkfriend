<template>
    <div>
        <v-dialog
            v-model="open"
            max-width="520"
            :persistent="saving"
            scrollable
        >
            <v-card class="sets-ui">
                <v-card-title>Add {{ displayName(title) }} to a set</v-card-title>
                <v-card-text>
                    <v-alert
                        v-if="error"
                        type="error"
                        dense
                    >
                        {{ error }}
                    </v-alert>
                    <v-progress-linear
                        v-if="loading"
                        indeterminate
                        aria-label="Loading tune settings"
                    />
                    <template v-else>
                        <p v-if="!settings.length && !batch.length">
                            No saved or downloaded settings are available for this tune. Enable its database in Settings.
                        </p>
                        <template v-if="batch.length === 1">
                            <p class="caption mb-2">
                                {{ settingLabel(batch[0]) }}
                            </p>
                        </template>
                        <v-list
                            v-if="batch.length > 1"
                            dense
                            aria-label="Selected tunes in set order"
                        >
                            <v-list-item
                                v-for="(entry, i) in batch"
                                :key="entry.setting_id"
                            >
                                <v-list-item-content>
                                    <v-list-item-title>
                                        <router-link
                                            :to="{ name: 'tune', query: { tuneID: String(entry.setting.tune_id), settingID: String(entry.setting_id), displayName: entry.display_name } }"
                                            @click.native="open = false"
                                        >
                                            {{ i + 1 }}. {{ displayName(entry.display_name) }}
                                        </router-link>
                                    </v-list-item-title>
                                    <v-list-item-subtitle>{{ settingLabel(entry) }}</v-list-item-subtitle>
                                </v-list-item-content>
                                <v-list-item-action
                                    v-if="batch.length > 1"
                                    class="d-flex flex-row"
                                >
                                    <v-btn
                                        icon
                                        small
                                        :disabled="saving || i === 0"
                                        :aria-label="'Move selected tune ' + (i + 1) + ' up'"
                                        @click="move(i, -1)"
                                    >
                                        <v-icon>{{ icons.up }}</v-icon>
                                    </v-btn>
                                    <v-btn
                                        icon
                                        small
                                        :disabled="saving || i === batch.length - 1"
                                        :aria-label="'Move selected tune ' + (i + 1) + ' down'"
                                        @click="move(i, 1)"
                                    >
                                        <v-icon>{{ icons.down }}</v-icon>
                                    </v-btn>
                                </v-list-item-action>
                            </v-list-item>
                        </v-list>
                        <v-select
                            v-if="!batch.length"
                            v-model="selectedID"
                            :items="settingOptions"
                            label="Choose key and setting"
                            :disabled="saving"
                        />
                        <div
                            v-if="containingSets.length"
                            class="mb-2"
                            aria-label="Sets that already contain this setting"
                        >
                            <p class="caption mb-1">
                                {{ batch.length > 1 ? 'Already in these sets:' : 'Already in:' }}
                            </p>
                            <v-list
                                dense
                                class="py-0"
                            >
                                <v-list-item
                                    v-for="set in containingSets"
                                    :key="set.id"
                                    :to="{ name: 'sets', query: { setID: set.id } }"
                                    @click="open = false"
                                >
                                    <v-list-item-content>
                                        <v-list-item-title>{{ set.name }}</v-list-item-title>
                                    </v-list-item-content>
                                </v-list-item>
                            </v-list>
                        </div>
                        <p
                            v-else-if="selectedSettingIDs.length"
                            class="caption"
                        >
                            Not in any set yet.
                        </p>
                        <v-select
                            v-model="destination"
                            :items="destinations"
                            label="Choose a set"
                            :disabled="saving"
                        >
                            <template #selection="{ item }">
                                <router-link
                                    v-if="sets.some(set => set.id === item.value)"
                                    :to="{ name: 'sets', query: { setID: item.value } }"
                                    @mousedown.native.stop
                                    @click.native.stop="open = false"
                                >
                                    {{ item.text }}
                                </router-link>
                                <span v-else>{{ item.text }}</span>
                            </template>
                        </v-select>
                        <p
                            v-if="duplicateInDestination"
                            class="caption warning--text"
                        >
                            {{ batch.length > 1 ? 'Some of these settings are' : 'This setting is' }} already in {{ destinationName }}. Adding will repeat {{ batch.length > 1 ? 'them' : 'it' }}.
                        </p>
                        <v-text-field
                            v-if="destination === 'new'"
                            v-model="name"
                            label="New set name"
                            maxlength="200"
                            :disabled="saving"
                        />
                        <p
                            v-if="destination === 'draft'"
                            class="caption"
                        >
                            The tune will be added after the tune you opened the suggestions from. Save the set when you are ready.
                        </p>
                        <p
                            v-else-if="destination"
                            class="caption"
                        >
                            {{ batch.length > 1 ? 'Tunes will be added at the end of the set in the order shown.' : 'The tune will be added at the end of the set.' }}
                        </p>
                    </template>
                </v-card-text>
                <v-card-actions>
                    <v-spacer />
                    <v-btn
                        text
                        :disabled="saving"
                        @click="open = false"
                    >
                        Cancel
                    </v-btn>
                    <v-btn
                        color="primary"
                        :loading="saving"
                        :disabled="loading || (!batch.length && !selectedID) || !destination || (destination === 'new' && !name.trim())"
                        @click="add"
                    >
                        Add to set
                    </v-btn>
                </v-card-actions>
            </v-card>
        </v-dialog>
        <v-snackbar
            v-model="noticeOpen"
            timeout="4000"
        >
            {{ notice }}
            <template #action="{ attrs }">
                <v-btn
                    v-if="noticeSetID"
                    text
                    color="primary"
                    v-bind="attrs"
                    :to="{ name: 'sets', query: { setID: noticeSetID } }"
                    @click="noticeOpen = false"
                >
                    Open set
                </v-btn>
            </template>
        </v-snackbar>
    </div>
</template>
<script>
import { mdiArrowUp, mdiArrowDown } from '@mdi/js';
import eventBus from '@/eventBus.js';
import store from '@/services/store.js';
import ffBackend from '@/services/backend.js';
import { settingsForSetTune } from '@/services/setSearch.mjs';
import { keyLabel, typeLabel } from '@/js/favouriteFacets.mjs';
import utils from '@/js/utils.js';
import { indexSetsBySetting } from '@/js/setMembership.mjs';

export default {
    name: 'AddToSetDialog',
    data: () => ({
        open: false, loading: false, saving: false, error: '', title: '',
        batch: [], icons: { up: mdiArrowUp, down: mdiArrowDown },
        settings: [], sets: [], selectedID: null, destination: null, name: '', draftTarget: null,
        noticeOpen: false, notice: '', noticeSetID: null,
    }),
    computed: {
        // Exact settingID, as on the Tune view and Favourite Tunes chips.
        selectedSettingIDs() {
            return this.batch.length ? this.batch.map(e => String(e.setting_id)) : (this.selectedID ? [String(this.selectedID)] : []);
        },
        containingSets() {
            const index = indexSetsBySetting(this.sets);
            const seen = new Set();
            return this.selectedSettingIDs.flatMap(id => index[id] || [])
                .filter(set => !seen.has(set.id) && seen.add(set.id));
        },
        settingOptions() {
            return this.settings.map(r => ({ value: String(r.setting_id), text:
                `${r.favourite ? '★ ' : ''}${r.setting.mode ? keyLabel(r.setting.mode) : 'Key unknown'} · ${r.setting.dance ? typeLabel(r.setting.dance) : 'Type unknown'} · Setting ${r.setting_id}` }));
        },
        destinations() {
            // From the set editor the only sensible target is the draft being
            // edited; saving into another set from there is surprising.
            if (this.draftTarget) return [{ value: 'draft', text: this.draftTarget.label }];
            return [
                ...this.sets.map(s => ({ value: s.id, text: s.name })),
                { value: 'new', text: 'Create a new set…' },
            ];
        },
        destinationName() {
            const set = this.sets.find(s => s.id === this.destination);
            return set ? set.name : '';
        },
        duplicateInDestination() {
            const set = this.sets.find(s => s.id === this.destination);
            if (!set) return false;
            const held = new Set(set.entries.map(e => String(e.result.settingID)));
            return this.selectedSettingIDs.some(id => held.has(id));
        },
    },
    created() {
        this._show = payload => this.show(payload);
        eventBus.$on('showAddToSet', this._show);
    },
    beforeDestroy() { eventBus.$off('showAddToSet', this._show); },
    methods: {
        settingLabel(entry) {
            return `${entry.setting.mode ? keyLabel(entry.setting.mode) : 'Key unknown'} · ${entry.setting.dance ? typeLabel(entry.setting.dance) : 'Type unknown'} · Setting ${entry.setting_id}`;
        },
        move(index, offset) {
            const entry = this.batch.splice(index, 1)[0];
            this.batch.splice(index + offset, 0, entry);
        },
        displayName: value => utils.parseDisplayableName(value || ''),
        async show({ tuneID, title, draftTarget = null, entries = null, preferredSettingID = null }) {
            if (this.saving) return;
            const request = (this._request || 0) + 1;
            this._request = request;
            this.open = true; this.loading = true; this.error = ''; this.title = title;
            this.batch = entries ? JSON.parse(JSON.stringify(entries)) : [];
            this.settings = []; this.sets = []; this.selectedID = null; this.name = '';
            this.draftTarget = draftTarget;
            this.destination = draftTarget ? 'draft' : 'new';
            this.noticeOpen = false; this.noticeSetID = null;
            try {
                const [favourites, sets] = await Promise.all([store.getFavourites(), store.getTuneSets()]);
                const settings = entries ? [] : await settingsForSetTune(ffBackend, tuneID, title, favourites);
                if (request !== this._request || !this.open) return;
                this.sets = sets.sort((a, b) => b.updatedAt - a.updatedAt);
                this.settings = settings;
                // No preselected set: one tap must never add to whichever set
                // was touched last. With no sets yet, creating one is the only choice.
                if (!draftTarget && sets.length) this.destination = null;
                if (!entries && preferredSettingID != null && settings.some(r => String(r.setting_id) === String(preferredSettingID))) this.selectedID = String(preferredSettingID);
                else if (!entries && (settings.length === 1 || settings[0]?.favourite)) this.selectedID = String(settings[0].setting_id);
            } catch (e) { if (request === this._request) this.error = e.message; }
            finally { if (request === this._request) this.loading = false; }
        },
        async add() {
            if (this.saving) return;
            const selected = this.batch.length ? this.batch : this.settings.filter(r => String(r.setting_id) === this.selectedID);
            if (!selected.length) return;
            this.saving = true; this.error = '';
            try {
                if (this.destination === 'draft') {
                    for (const entry of [...selected].reverse()) await this.draftTarget.add(entry);
                    this.notice = 'Added to the draft. Save the set when you are ready.';
                    this.noticeSetID = null;
                } else {
                    const existing = this.sets.find(s => s.id === this.destination);
                    if (this.destination !== 'new' && !existing) throw new Error('Choose a set to add this tune to.');
                    const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
                        id: globalThis.crypto.randomUUID(), name: this.name.trim(), tags: [], notes: '', entries: [],
                    };
                    draft.entries.push(...selected.map(entry => ({ id: globalThis.crypto.randomUUID(), repetitions: 2, result: {
                        settingID: entry.setting_id, setting: entry.setting, displayName: entry.display_name,
                    } })));
                    const saved = await store.saveTuneSet(draft, existing ? existing.updatedAt : null);
                    this.notice = `Added to ${saved.name}.`;
                    this.noticeSetID = saved.id;
                }
                this.open = false; this.noticeOpen = true;
            } catch (e) { this.error = e.message; }
            finally { this.saving = false; }
        },
    },
};
</script>
