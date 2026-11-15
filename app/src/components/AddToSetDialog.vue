<template>
    <div>
        <v-dialog
            v-model="open"
            max-width="520"
            :persistent="saving"
            scrollable
        >
            <v-card>
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
                        <p v-if="!settings.length">
                            No saved or downloaded settings are available for this tune. Enable its database in Settings.
                        </p>
                        <v-select
                            v-model="selectedID"
                            :items="settingOptions"
                            label="Choose key and setting"
                            :disabled="saving"
                        />
                        <v-select
                            v-model="destination"
                            :items="destinations"
                            label="Add to"
                            :disabled="saving"
                        />
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
                            v-else
                            class="caption"
                        >
                            The tune will be added at the end of the set.
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
                        :disabled="loading || !selectedID || !destination || (destination === 'new' && !name.trim())"
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
        </v-snackbar>
    </div>
</template>
<script>
import eventBus from '@/eventBus.js';
import store from '@/services/store.js';
import ffBackend from '@/services/backend.js';
import { settingsForSetTune } from '@/services/setSearch.mjs';
import { keyLabel, typeLabel } from '@/js/favouriteFacets.mjs';
import utils from '@/js/utils.js';

export default {
    name: 'AddToSetDialog',
    data: () => ({
        open: false, loading: false, saving: false, error: '', title: '',
        settings: [], sets: [], selectedID: null, destination: null, name: '', draftTarget: null,
        noticeOpen: false, notice: '',
    }),
    computed: {
        settingOptions() {
            return this.settings.map(r => ({ value: String(r.setting_id), text:
                `${r.favourite ? '★ ' : ''}${r.setting.mode ? keyLabel(r.setting.mode) : 'Key unknown'} · ${r.setting.dance ? typeLabel(r.setting.dance) : 'Type unknown'} · Setting ${r.setting_id}` }));
        },
        destinations() {
            return [
                ...(this.draftTarget ? [{ value: 'draft', text: this.draftTarget.label }] : []),
                ...this.sets.map(s => ({ value: s.id, text: s.name })),
                { value: 'new', text: 'Create a new set…' },
            ];
        },
    },
    created() {
        this._show = payload => this.show(payload);
        eventBus.$on('showAddToSet', this._show);
    },
    beforeDestroy() { eventBus.$off('showAddToSet', this._show); },
    methods: {
        displayName: value => utils.parseDisplayableName(value || ''),
        async show({ tuneID, title, draftTarget = null }) {
            if (this.saving) return;
            const request = (this._request || 0) + 1;
            this._request = request;
            this.open = true; this.loading = true; this.error = ''; this.title = title;
            this.settings = []; this.sets = []; this.selectedID = null; this.name = '';
            this.draftTarget = draftTarget;
            this.destination = draftTarget ? 'draft' : 'new';
            try {
                const [favourites, sets] = await Promise.all([store.getFavourites(), store.getTuneSets()]);
                const settings = await settingsForSetTune(ffBackend, tuneID, title, favourites);
                if (request !== this._request || !this.open) return;
                this.sets = sets.sort((a, b) => b.updatedAt - a.updatedAt);
                this.settings = settings;
                if (!draftTarget && sets.length) this.destination = sets[0].id;
                if (settings.length === 1 || settings[0]?.favourite) this.selectedID = String(settings[0].setting_id);
            } catch (e) { if (request === this._request) this.error = e.message; }
            finally { if (request === this._request) this.loading = false; }
        },
        async add() {
            if (this.saving) return;
            const selected = this.settings.find(r => String(r.setting_id) === this.selectedID);
            if (!selected) return;
            this.saving = true; this.error = '';
            try {
                if (this.destination === 'draft') {
                    await this.draftTarget.add(selected);
                    this.notice = 'Added to the draft. Save the set when you are ready.';
                } else {
                    const existing = this.sets.find(s => s.id === this.destination);
                    if (this.destination !== 'new' && !existing) throw new Error('Choose a set to add this tune to.');
                    const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
                        id: globalThis.crypto.randomUUID(), name: this.name.trim(), tags: [], notes: '', entries: [],
                    };
                    draft.entries.push({ id: globalThis.crypto.randomUUID(), result: {
                        settingID: selected.setting_id, setting: selected.setting, displayName: selected.display_name,
                    } });
                    await store.saveTuneSet(draft, existing ? existing.updatedAt : null);
                    this.notice = `Added to ${draft.name}.`;
                }
                this.open = false; this.noticeOpen = true;
            } catch (e) { this.error = e.message; }
            finally { this.saving = false; }
        },
    },
};
</script>
