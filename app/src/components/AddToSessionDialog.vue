<template>
    <div>
        <v-dialog v-model="open" max-width="520" :persistent="saving" scrollable>
            <v-card>
                <v-card-title>{{ heading }}</v-card-title>
                <v-card-text>
                    <v-alert v-if="error" type="error" dense text>
                        {{ error }}
                    </v-alert>
                    <v-progress-linear v-if="loading" indeterminate aria-label="Loading sessions" />
                    <template v-else>
                        <p v-if="summary" class="caption mb-2">
                            {{ summary }}
                        </p>
                        <v-radio-group
                            v-if="!createOnly"
                            v-model="destination"
                            class="mt-0"
                            hide-details
                            aria-label="Session to add to"
                        >
                            <v-radio
                                v-if="openSession"
                                :value="openSession.id"
                                :label="`Current session: ${labelFor(openSession)}`"
                            />
                            <v-radio
                                v-for="s in planned"
                                :key="s.id"
                                :value="s.id"
                                :label="`${s.planned ? 'Planned' : 'Past'}: ${labelFor(s)}${s.planned ? '' : ' · ' + formatDate(s.startedAt)}${planCount(s)}`"
                            />
                            <v-radio value="new" label="A new planned session…" />
                        </v-radio-group>
                        <template v-if="createOnly || destination === 'new'">
                            <v-text-field
                                v-model="newName"
                                label="Session name"
                                placeholder="e.g. Thursday at The Crown"
                                maxlength="160"
                                class="mt-3"
                                :disabled="saving"
                                autofocus
                            />
                        </template>
                    </template>
                </v-card-text>
                <v-card-actions>
                    <v-spacer />
                    <v-btn text :disabled="saving" @click="open = false">Cancel</v-btn>
                    <v-btn
                        color="primary"
                        :disabled="loading || !canSave"
                        :loading="saving"
                        @click="save"
                    >
                        {{ createOnly ? 'Create' : 'Add to plan' }}
                    </v-btn>
                </v-card-actions>
            </v-card>
        </v-dialog>
        <v-snackbar v-model="noticeOpen" timeout="5000">
            {{ notice }}
            <template #action="{ attrs }">
                <v-btn v-if="noticeSessionID" text v-bind="attrs" color="primary" @click="openSessionPage">
                    Open
                </v-btn>
            </template>
        </v-snackbar>
    </div>
</template>

<script>
// "Add to session": the one dialog every list sends tunes to a session's plan
// through (favourites, sets, a tune's page, search results), and the one that
// creates a planned session. Mounted once, in App.vue; opened with
//   eventBus.$emit('showAddToSession', { tunes, sets, create })
// tunes: [{ tuneID, settingID, title, dataset, setting? }] in order;
// sets: stored set records; create: true for "Plan a session" with nothing
// to add yet.
import eventBus from '@/eventBus.js';
import store from '@/services/store.js';
import liveAnalysisService from '@/services/liveAnalysis.js';
import { addToSessionPlan, planDestinations } from '@/services/sessionPlanActions.js';
import { sanitisePlan, planTunes } from '@/js/sessionPlan.mjs';
import { formatDateTime } from '@/js/dateFormat.mjs';

export default {
    name: 'AddToSessionDialog',
    data() {
        return {
            open: false,
            loading: false,
            saving: false,
            error: '',
            createOnly: false,
            tunes: [],
            sets: [],
            openSession: null,
            planned: [],
            destination: null,
            newName: '',
            noticeOpen: false,
            notice: '',
            noticeSessionID: null,
        };
    },
    computed: {
        count() {
            return this.tunes.length + this.sets.reduce((n, s) => n + ((s.entries && s.entries.length) || 0), 0);
        },
        heading() {
            if (this.createOnly) return 'Plan a session';
            if (this.sets.length === 1 && !this.tunes.length) return `Add “${this.sets[0].name}” to a session`;
            if (this.tunes.length === 1 && !this.sets.length) return `Add ${this.tunes[0].title} to a session`;
            return `Add ${this.count} tunes to a session`;
        },
        summary() {
            if (this.createOnly) return 'Name it and build its plan. Its date, time and place are taken when you start capturing it.';
            return 'Added to the end of the plan, in this order. Tunes already in the plan are left out.';
        },
        canSave() {
            // The name is all a plan has to go by until it is started.
            if (this.createOnly || this.destination === 'new') return !!this.newName.trim();
            return !!this.destination;
        },
    },
    created() {
        this._show = payload => this.show(payload || {});
        eventBus.$on('showAddToSession', this._show);
    },
    beforeDestroy() { eventBus.$off('showAddToSession', this._show); },
    methods: {
        labelFor(session) {
            return session.name || this.formatDate(session.startedAt);
        },
        planCount(session) {
            const n = planTunes(sanitisePlan(session.plan)).length;
            return n ? ` · ${n} planned` : '';
        },
        formatDate(ms) {
            return formatDateTime(ms);
        },
        async show({ tunes = [], sets = [], create = false }) {
            if (this.saving) return;
            this.createOnly = !!create;
            this.tunes = tunes.filter(t => t && (t.tuneID != null || t.title));
            this.sets = sets.filter(Boolean);
            this.error = '';
            this.newName = '';
            this.destination = null;
            this.open = true;
            this.loading = true;
            try {
                const { open, recent } = await planDestinations(liveAnalysisService.sessionId);
                this.openSession = open || null;
                this.planned = recent;
                // The obvious target is preselected: the session happening now,
                // else the most recent planned one, else the most recent. With
                // none, creating one.
                const plannedOne = recent.find(s => s.planned);
                this.destination = open ? open.id : (plannedOne || recent[0] || { id: 'new' }).id;
            } catch (e) {
                this.error = `Could not read your sessions: ${e.message}`;
                this.destination = 'new';
            } finally {
                this.loading = false;
            }
        },
        async save() {
            if (this.saving || !this.canSave) return;
            this.saving = true;
            this.error = '';
            try {
                let sessionID = this.destination;
                let label = '';
                if (this.createOnly || sessionID === 'new') {
                    const created = await store.createPlannedSession({ name: this.newName });
                    sessionID = created.id;
                    label = created.name || this.formatDate(created.startedAt);
                } else {
                    const target = [this.openSession, ...this.planned].find(s => s && s.id === sessionID);
                    label = target ? this.labelFor(target) : 'the session';
                }
                if (this.createOnly) {
                    this.notice = `Planned ${label}.`;
                } else {
                    const { added, skipped } = await addToSessionPlan(sessionID, { tunes: this.tunes, sets: this.sets });
                    this.notice = `Added ${added} ${added === 1 ? 'tune' : 'tunes'} to ${label}`
                        + (skipped ? ` (${skipped} already planned).` : '.');
                }
                this.noticeSessionID = sessionID;
                this.open = false;
                this.noticeOpen = true;
                eventBus.$emit('sessionPlanSaved', { sessionID, created: this.createOnly || this.destination === 'new' });
            } catch (e) {
                this.error = e.message;
            } finally {
                this.saving = false;
            }
        },
        openSessionPage() {
            this.noticeOpen = false;
            const query = { session: this.noticeSessionID };
            if (this.$route && this.$route.name === 'session-analysis'
                && this.$route.query.session === this.noticeSessionID) return;
            this.$router.push({ name: 'session-analysis', query }).catch(() => {});
        },
    },
};
</script>
