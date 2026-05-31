<template>
    <v-container
        v-if="lastResults.length"
        class="viewContainerWrapper"
    >
        <div class="d-flex align-center my-2">
            <h1>Results</h1>
            <v-spacer />
            <v-btn
                v-if="hasRecording"
                small
                outlined
                color="primary"
                :title="'Save this recording as a WAV test clip'"
                @click="saveRecording"
            >
                <v-icon left small>
                    {{ mdiContentSave }}
                </v-icon>
                Save clip
            </v-btn>
        </div>
        <v-list class="resultsTable">
            <ResultRow
                v-for="result in lastResults"
                :key="`${result.setting_id}`"
                :setting="result.setting"
                :display-name="result.display_name"
                :setting-i-d="result.setting_id"
                :score="result.score"
            />
        </v-list>
        <v-snackbar v-model="snackbar" timeout="3000">
            {{ snackbarText }}
        </v-snackbar>
    </v-container>
    <v-container v-else>
        <h1 class="my-2">
            Results
        </h1>
        <p>
            Please record some music or upload an audio file to search the tune database.
        </p>
    </v-container>
</template>

<script>
import ResultRow from '@/components/ResultRow';
import store from '@/services/store';
import { mdiContentSave } from '@mdi/js';
import { encodeWav, slugify } from '@/js/wav.mjs';

export default {
    name: 'SearchesView',
    components: {
        ResultRow,
    },
    data: function () {
        return {
            lastResults: store.state.lastResults,
            hasRecording: !!store.state.lastRecordedPcm,
            mdiContentSave,
            snackbar: false,
            snackbarText: '',
        };
    },
    methods: {
        async saveRecording() {
            const pcm = store.state.lastRecordedPcm;
            if (!pcm) {
                this._notify('No recording available to save.');
                return;
            }
            const sampleRate = store.state.lastRecordedSampleRate || 48000;
            const blob = encodeWav(pcm, sampleRate);

            // Default the filename to the top match so it maps to a known tune
            // when building benchmark cases (you know what you played regardless).
            const top = this.lastResults[0];
            const label = top && top.setting
                ? `${slugify(top.display_name)}_tune${top.setting.tune_id}`
                : 'clip';
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filename = `${label}_${ts}.wav`;
            const file = new File([blob], filename, { type: 'audio/wav' });

            // Prefer the Web Share sheet (iOS: Save to Files / iCloud Drive or
            // AirDrop to a Mac). Fall back to a direct download on desktop.
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({ files: [file], title: filename });
                    return;
                } catch (e) {
                    if (e && e.name === 'AbortError') return; // user cancelled
                    // otherwise fall through to download
                }
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            this._notify(`Saved ${filename}`);
        },
        _notify(text) {
            this.snackbarText = text;
            this.snackbar = true;
        },
    },
};
</script>

<style scoped>
.resultsTableWrapper {
    display: block;
    max-width: min(90vh, 90vw);
}

.resultsTable > div:nth-child(odd) {
    background: #efefef;
}

</style>
