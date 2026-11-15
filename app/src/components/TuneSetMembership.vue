<template>
    <div
        v-if="memberships.length"
        class="d-flex flex-wrap align-center my-2"
        style="gap:6px"
        aria-label="Sets containing this tune"
    >
        <span class="caption text--secondary">In sets:</span>
        <v-chip
            v-for="set in memberships"
            :key="set.id"
            small
            outlined
            :to="{ name: 'sets', query: { setID: set.id } }"
        >
            {{ set.name }} · {{ keys(set) }}
        </v-chip>
    </div>
</template>
<script>
import store from '@/services/store';
import eventBus from '@/eventBus';
import { setsForTune } from '@/js/setMembership.mjs';
import { keyLabel } from '@/js/favouriteFacets.mjs';
export default {
    name: 'TuneSetMembership',
    props: { tuneID: { type: [String, Number], required: true } },
    data: () => ({ sets: [] }),
    computed: { memberships() { return setsForTune(this.sets, this.tuneID); } },
    created() { this.refresh(); eventBus.$on('tuneSetsChanged', this.refresh); },
    beforeDestroy() { eventBus.$off('tuneSetsChanged', this.refresh); },
    methods: {
        async refresh() {
            try { this.sets = await store.getTuneSets(); }
            catch (e) { eventBus.$emit('syncError', 'Could not read set membership on this device.'); }
        },
        keys(set) { return [...new Set(set.entries.map(e => keyLabel(e.result.setting.mode || '')))].join(' / '); },
    },
};
</script>
