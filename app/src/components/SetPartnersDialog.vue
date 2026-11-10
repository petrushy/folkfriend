<template>
    <v-dialog v-model="open" max-width="520" scrollable>
        <v-card v-if="tuneID">
            <v-card-title class="partnersTitle">
                <span>Played in sets with {{ title ? displayName(title) : 'this tune' }}</span>
            </v-card-title>
            <v-card-subtitle class="pb-1">
                {{ subtitle }}
            </v-card-subtitle>
            <v-card-text class="px-2">
                <div v-if="loading" class="d-flex align-center pa-3">
                    <v-progress-circular indeterminate size="22" width="2" class="mr-3" />
                    <span>Looking up sets…</span>
                </div>
                <p v-else-if="!partners.length" class="pa-3 mb-0">
                    No set information for this tune. It is only available for
                    tunes from thesession.org.
                </p>
                <v-list v-else dense class="py-0">
                    <template v-for="(p, i) in partners">
                        <v-subheader
                            v-if="i > 0 && !p.common && partners[i - 1].common"
                            :key="`sep-${p.tuneID}`"
                            class="px-2"
                        >
                            Less often
                        </v-subheader>
                        <v-list-item
                            :key="p.tuneID"
                            class="px-2 partnerRow"
                            :class="{ 'partnerRow--rare': !p.common }"
                            @click="openTune(p)"
                        >
                            <v-list-item-icon class="mr-2 my-auto">
                                <v-icon
                                    small
                                    :color="p.starred ? 'amber darken-1' : 'transparent'"
                                    :aria-hidden="String(!p.starred)"
                                    :title="p.starred ? 'In your favourites' : ''"
                                >
                                    {{ icons.star }}
                                </v-icon>
                            </v-list-item-icon>
                            <v-list-item-content>
                                <v-list-item-title class="partnerName">
                                    {{ displayName(p.name) }}
                                </v-list-item-title>
                                <v-list-item-subtitle class="partnerDetail">
                                    <span v-if="p.dance" class="partnerDance">{{ p.dance }}</span>
                                    <span v-if="p.direction === 'after'" class="partnerDirection">
                                        · usually played after it
                                    </span>
                                    <span v-else-if="p.direction === 'before'" class="partnerDirection">
                                        · usually played before it
                                    </span>
                                    <span class="partnerCounts"> · {{ describeCounts(p) }}</span>
                                </v-list-item-subtitle>
                            </v-list-item-content>
                            <div class="partnerBar" :title="describeCounts(p)">
                                <div class="partnerBarFill" :style="{ width: barWidth(p) }" />
                            </div>
                        </v-list-item>
                    </template>
                </v-list>
            </v-card-text>
            <v-card-actions>
                <span class="caption text--secondary pl-2">Data: thesession.org</span>
                <v-spacer />
                <v-btn text @click="open = false">Close</v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>
</template>

<script>
// "Played in sets with…" — the tunes most often played in a set with the one
// in focus, for picking what to play next in a session and for building sets
// beforehand. One dialog for the whole app, mounted in App.vue and opened with
// eventBus.$emit('showSetPartners', { tuneID, title }), like the tune
// background dialog.
//
// The order is js/setPartners.mjs: starred tunes first when they are commonly
// played with this one, then by how often.
import eventBus from '@/eventBus.js';
import ffBackend from '@/services/backend.js';
import store from '@/services/store.js';
import utils from '@/js/utils.js';
import { describeCounts, rankSetPartners } from '@/js/setPartners.mjs';
import { mdiStar } from '@mdi/js';

export default {
    name: 'SetPartnersDialog',
    data: () => ({
        open: false,
        tuneID: '',
        title: '',
        partners: [],
        loading: false,
        icons: { star: mdiStar },
    }),
    computed: {
        hasStarredCommon() {
            return this.partners.some(p => p.starred && p.common);
        },
        subtitle() {
            return 'How often thesession.org members put these together in a set, '
                + 'and on recordings.'
                + (this.hasStarredCommon ? ' Your starred tunes come first.' : '');
        },
    },
    created() {
        this._onShow = (payload) => this.show(payload || {});
        eventBus.$on('showSetPartners', this._onShow);
    },
    beforeDestroy() {
        eventBus.$off('showSetPartners', this._onShow);
    },
    methods: {
        describeCounts,
        displayName(raw) {
            return raw ? utils.parseDisplayableName(String(raw)) : '';
        },
        async show({ tuneID, title = '' }) {
            const asked = String(tuneID || '');
            if (!asked) return;
            if (asked !== this.tuneID) this.partners = [];
            this.tuneID = asked;
            this.title = title;
            this.open = true;
            this.loading = true;
            let raw = [];
            let starred = new Set();
            try {
                [raw, starred] = await Promise.all([
                    ffBackend.setPartnersFromTuneID(asked),
                    store._loadFavouriteTuneIDs().catch(() => new Set()),
                ]);
            } catch (e) {
                raw = [];
            }
            // Reopened for another tune while this one was loading: its
            // answer must not be shown under the other tune's title.
            if (this.tuneID !== asked) return;
            this.partners = rankSetPartners(raw || [], starred || new Set());
            this.loading = false;
        },
        barWidth(p) {
            const top = this.partners.reduce((m, q) => Math.max(m, q.total), 0) || 1;
            return `${Math.max(4, Math.round(100 * p.total / top))}%`;
        },
        openTune(p) {
            this.open = false;
            this.$router.push({
                name: 'tune',
                query: { tuneID: p.tuneID, displayName: p.name },
            }).catch(() => {});
        },
    },
};
</script>

<style scoped>
.partnersTitle {
    word-break: normal;
}

.partnerName {
    font-weight: 500;
}

/* Wraps rather than ellipsising: at phone width "usually played before it"
   pushed the counts — the actual answer — off the end of the line. */
.partnerDetail {
    white-space: normal;
    -webkit-line-clamp: unset;
    overflow: visible;
}

.partnerDance {
    text-transform: capitalize;
}

.partnerRow--rare .partnerName {
    font-weight: 400;
}

.partnerBar {
    flex: 0 0 56px;
    height: 6px;
    margin-left: 8px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.08);
    overflow: hidden;
}

.partnerBarFill {
    height: 100%;
    background: var(--v-primary-base, #1976d2);
}
</style>
