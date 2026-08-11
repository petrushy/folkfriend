<template>
    <v-dialog v-model="open" max-width="560" scrollable>
        <v-card v-if="tuneID">
            <v-card-title class="summaryTitle">{{ title || 'Background' }}</v-card-title>
            <v-card-text>
                <!-- The error sits above the note rather than replacing it: a
                     failed regenerate must not hide the note you already have. -->
                <p v-if="summaryError" class="error--text" :class="summary ? 'mb-4' : 'mb-0'">
                    {{ summaryError }}
                </p>
                <div v-if="summaryLoading" class="d-flex align-center py-2">
                    <v-progress-circular indeterminate size="22" width="2" class="mr-3" />
                    <span>Writing a background note…</span>
                </div>
                <template v-else-if="summary">
                    <p class="summaryText">{{ summary.text }}</p>
                    <p class="caption text--secondary mb-0">
                        <span v-if="groundingNote">{{ groundingNote }}</span>
                        Generated {{ formatSummaryDate(summary.generatedAt) }}<span
                            v-if="summary.model">&nbsp;by {{ summary.model }}</span>. Written by
                        an AI and may be wrong — verify anything you rely on against the
                        source.
                    </p>
                </template>
                <p v-else-if="!summaryError" class="mb-0">
                    No background note saved for this tune yet. Generating one makes a
                    single call to the Claude API with your own key, and the result is
                    saved so the same tune is never paid for twice.
                </p>
            </v-card-text>
            <v-card-actions>
                <v-spacer />
                <v-btn text :disabled="summaryLoading" @click="open = false">
                    Close
                </v-btn>
                <v-btn text color="primary" :loading="summaryLoading" @click="generateSummary">
                    {{ summary ? 'Regenerate' : 'Generate' }}
                </v-btn>
            </v-card-actions>
        </v-card>
    </v-dialog>
</template>

<script>
// The one and only tune-background dialog, mounted once in App.vue and opened
// from anywhere via eventBus.$emit('showTuneBackground', { tuneID, ... }).
//
// It lives here rather than in each view because the (i) button appears in four
// places, two of which are list rows: a per-row dialog would mean one dialog
// instance per favourite, which is a lot of DOM for something at most one of
// which is ever visible. Centralising it also keeps the cost guardrails —
// cache-first, never generate without a tap, single in-flight request — in a
// single place rather than copied four times.
import eventBus from '@/eventBus.js';
import store from '@/services/store.js';
import {
    DEFAULT_MODEL as DEFAULT_AI_MODEL,
    describeAiSummaryError,
    fetchSessionComments,
    fetchSessionTuneFacts,
    generateTuneSummary,
} from '@/services/aiSummary.js';

export default {
    name: 'TuneBackgroundDialog',
    data: () => ({
        open: false,
        tuneID: '',
        title: '',
        displayName: '',
        sourceUrl: '',
        summary: null,
        summaryLoading: false,
        summaryError: '',
        // Transient, not persisted: what the note we just generated was built
        // from — 'comments' | 'page' | 'knowledge'. The first thing to look at
        // when a note comes back thin.
        summaryGrounding: null,
        summaryCommentCount: 0,
    }),
    computed: {
        // Names what the note was built from, so a user reporting a thin note
        // carries its own diagnosis. Only shown right after generating — a note
        // read back from the cache does not persist this.
        groundingNote() {
            if (this.summaryGrounding === 'comments') {
                const n = this.summaryCommentCount;
                return `Written from the ${n ? `${n} ` : ''}discussion ${n === 1 ? 'post' : 'posts'} on the source page.`;
            }
            if (this.summaryGrounding === 'page') {
                return 'Written from the source page.';
            }
            if (this.summaryGrounding === 'knowledge') {
                return 'The source page\'s discussion could not be read, so this is from the model\'s own knowledge only.';
            }
            return '';
        },
    },
    created() {
        this._onShow = (payload) => this.show(payload || {});
        eventBus.$on('showTuneBackground', this._onShow);
    },
    beforeDestroy() {
        eventBus.$off('showTuneBackground', this._onShow);
    },
    methods: {
        async show({ tuneID, displayName = '', sourceUrl = '', title = '' }) {
            if (!tuneID) return;
            const changed = String(tuneID) !== String(this.tuneID);

            this.tuneID = String(tuneID);
            this.displayName = displayName;
            this.sourceUrl = sourceUrl;
            this.title = title || displayName;
            this.summaryError = '';

            // Opening for a different tune must never show the previous tune's
            // note — the failure mode a single shared dialog introduces that a
            // per-view one could not have.
            if (changed) {
                this.summary = null;
                this.summaryGrounding = null;
                this.summaryCommentCount = 0;
            }

            this.open = true;

            // Read the cache and stop. Opening must never spend money — a miss
            // shows the Generate button and waits for a tap. It also means an
            // already-summarised tune reads fine on a plane.
            if (!this.summary) {
                const cached = await store.getAiSummary(this.tuneID);
                // Guard against a second open having moved on while we awaited.
                if (String(this.tuneID) === String(tuneID)) this.summary = cached;
            }
        },
        formatSummaryDate(timestamp) {
            if (!timestamp) return 'previously';
            return `on ${new Date(timestamp).toLocaleDateString()}`;
        },
        async generateSummary() {
            // Single in-flight guard: the button is also :loading, but a
            // double-tap that slipped through would be a second paid call.
            if (this.summaryLoading || !this.tuneID) return;

            const apiKey = store.getApiKey();
            if (!apiKey) {
                this.summaryError = describeAiSummaryError({ kind: 'no-key' });
                return;
            }

            const tuneID = this.tuneID;
            this.summaryLoading = true;
            this.summaryError = '';
            this.summaryGrounding = null;
            this.summaryCommentCount = 0;

            try {
                // Both non-fatal: each resolves to null if thesession is
                // unreachable or this is a folkwiki tune, and the note is written
                // anyway — from the model's own knowledge, labelled as such.
                // The comments are the material the note is actually built from.
                const [facts, comments] = await Promise.all([
                    fetchSessionTuneFacts(tuneID),
                    fetchSessionComments(tuneID),
                ]);

                const record = await generateTuneSummary({
                    tuneID,
                    displayName: this.displayName,
                    sourceUrl: this.sourceUrl,
                    facts,
                    comments,
                    model: store.userSettings.aiSummaryModel || DEFAULT_AI_MODEL,
                    apiKey,
                });

                store.recordAiUsage(record.usage, record.model);
                await store.setAiSummary(tuneID, record);

                // The user may have opened another tune while this ran. The note
                // is saved either way; only the display is conditional.
                if (String(this.tuneID) === String(tuneID)) {
                    this.summary = await store.getAiSummary(tuneID);
                    this.summaryGrounding = record.grounding;
                    this.summaryCommentCount = record.commentCount || 0;
                }
            } catch (e) {
                console.error('Tune background note failed', e);
                if (String(this.tuneID) === String(tuneID)) {
                    this.summaryError = describeAiSummaryError(e);
                }
            } finally {
                this.summaryLoading = false;
            }
        },
    },
};
</script>

<style scoped>
.summaryTitle {
    font-size: 1.1rem;
    font-weight: 500;
}

.summaryText {
    /* The model is asked for plain prose, but it may still use paragraph
       breaks — keep them rather than collapsing everything into one block. */
    white-space: pre-wrap;
    line-height: 1.55;
}
</style>
