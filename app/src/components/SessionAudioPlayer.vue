<template>
    <div v-if="manifest" class="sessionAudioPlayer">
        <div class="d-flex align-center flex-wrap" style="gap: 12px;">
            <v-btn icon :disabled="!totalSeconds" :aria-label="playing ? 'Pause playback' : 'Play recording'" @click="togglePlay">
                <v-icon>{{ playing ? icons.pause : icons.play }}</v-icon>
            </v-btn>
            <div class="playerClock">
                {{ formatSecondsAsDuration(currentSeconds) }} / {{ formatSecondsAsDuration(totalSeconds) }}
            </div>
            <v-spacer />
            <div class="text--secondary caption">
                {{ formatBytes(manifest.bytes) }}<span v-if="bitrateLabel"> · {{ bitrateLabel }}</span>
            </div>
        </div>

        <!-- The strip IS the link between the tune list and the recording:
             every detection with an audio offset is a block you can tap. -->
        <div ref="strip" class="audioStrip mt-2" @click="onStripClick">
            <div
                v-for="block in blocks"
                :key="block.key"
                class="audioStripBlock"
                :style="block.style"
                :title="block.title"
            />
            <!-- Drawn OVER the tune blocks: a muted stretch still has tunes
                 detected in it (detection never stops), so the two overlap and
                 the mute is the fact that needs to win visually. -->
            <div
                v-for="(block, index) in mutedBlocks"
                :key="`muted-${index}`"
                class="audioStripMuted"
                :style="block"
                title="Audio muted here"
            />
            <!-- Drawn OVER the tune blocks: a stretch the user muted contains
                 no audio, so a row that looks playable there is a lie. Seeking
                 into unexplained silence is indistinguishable from a bug. -->
            <div
                v-for="(band, i) in mutedBands"
                :key="`muted-${i}`"
                class="audioStripMuted"
                :style="band"
                title="Audio muted here"
            />
            <div class="audioStripCursor" :style="{ left: cursorPercent + '%' }" />
        </div>
        <div class="d-flex justify-space-between caption text--secondary">
            <span>{{ nowPlayingLabel }}</span>
            <span v-if="mutedSeconds > 0">{{ formatSecondsAsDuration(mutedSeconds) }} muted</span>
            <span v-if="mutedBlocks.length">{{ mutedSummary }}</span>
            <span v-if="manifest.stopped">Recording stopped early</span>
        </div>

        <v-alert v-if="manifest.stopped" type="warning" dense text class="mt-2 mb-0">
            {{ manifest.stopped.message || 'Recording stopped before the end of the session.' }}
            Audio covers the first {{ formatSecondsAsDuration(totalSeconds) }} of listening.
        </v-alert>

        <v-alert v-if="listening" type="info" dense text class="mt-2 mb-0">
            This session is still listening. Playback comes out of the speaker, so the
            detector will hear it — expect stray tunes in the list while you listen back.
        </v-alert>

        <v-alert v-if="error" type="error" dense text class="mt-2 mb-0">
            {{ error }}
        </v-alert>

        <div class="d-flex flex-wrap mt-2" style="gap: 8px;">
            <v-btn
                v-for="track in tracks"
                :key="track.index"
                text
                small
                color="primary"
                :loading="exportingIndex === track.index"
                :disabled="exportingIndex !== null"
                @click="exportTrack(track)"
            >
                {{ tracks.length > 1 ? `Export part ${track.index + 1}` : 'Export audio' }}
                ({{ formatSecondsAsDuration(track.durationSeconds) }})
            </v-btn>
        </div>
        <p v-if="tracks.length > 1" class="caption text--secondary mb-0 mt-1">
            The session was paused (or the microphone was reacquired) {{ tracks.length - 1 }}
            {{ tracks.length === 2 ? 'time' : 'times' }}, so the recording exports as
            {{ tracks.length }} separate files.
        </p>

        <audio
            ref="audio"
            preload="metadata"
            @loadedmetadata="onLoadedMetadata"
            @timeupdate="onTimeUpdate"
            @ended="onEnded"
            @play="playing = true"
            @pause="playing = false"
            @error="onAudioError"
        />
    </div>
</template>

<script>
import { mdiPlay, mdiPause } from '@mdi/js';
import eventBus from '@/eventBus.js';
import { formatSecondsAsDuration } from '@/js/sessionAnalysis.js';
import {
    readManifest, buildClip, trackRanges, formatBytes, fileExtensionFor,
} from '@/services/sessionAudioStore.js';

// How far before a tune's detected start to begin playback.
//
// A cluster's start is the moment the FIRST window that matched ended, so the
// tune has already been playing for at least a window by then — seeking to the
// bare offset reliably lands past the opening phrase, which reads as a bug even
// though the detector is working exactly as designed. See clusterDetections().
const PLAY_PREROLL_SECONDS = 12;

// A tiny palette for the timeline. Distinguishing adjacent tunes is all this
// has to do, so it cycles rather than trying to be stable per tune.
const BLOCK_COLOURS = ['#1976d2', '#43a047', '#8e24aa', '#ef6c00', '#00838f', '#c62828'];

export default {
    name: 'SessionAudioPlayer',
    props: {
        sessionId: { type: String, default: '' },
        detections: { type: Array, default: () => [] },
        // Whether the session this belongs to is currently recording. Purely
        // for the warning above — playback and capture are independent.
        listening: { type: Boolean, default: false },
    },
    data() {
        return {
            manifest: null,
            playing: false,
            currentSeconds: 0,
            error: '',
            exportingIndex: null,
            // Which stored segment the <audio> element currently holds, and
            // where that segment starts in session-audio time.
            segmentIndex: null,
            segmentStartSeconds: 0,
            // The timeline origin the browser gave this blob. A clip cut from
            // mid-stream may keep its ORIGINAL timestamps rather than starting
            // at zero, and which of the two happens differs between containers
            // and browsers — so it is measured from seekable rather than
            // assumed. Every seek is expressed relative to it, which is correct
            // under both behaviours.
            timelineBase: 0,
            objectUrl: null,
            pendingSeekSeconds: null,
            icons: { play: mdiPlay, pause: mdiPause },
        };
    },
    computed: {
        totalSeconds() { return this.manifest ? this.manifest.totalSeconds : 0; },
        tracks() { return trackRanges(this.manifest); },
        bitrateLabel() {
            const bps = this.manifest && this.manifest.bitsPerSecond;
            return bps ? `${Math.round(bps / 1000)} kbps` : '';
        },
        // Ranges the user muted, as strip geometry. An unclosed range (the
        // session is still muted, or ended while muted) runs to the end of
        // what was recorded.
        mutedBands() {
            const ranges = (this.manifest && this.manifest.mutedRanges) || [];
            if (!this.totalSeconds) return [];
            return ranges.map(range => {
                const from = Math.max(0, range.from);
                const to = Math.min(this.totalSeconds, range.to == null ? this.totalSeconds : range.to);
                const left = (from / this.totalSeconds) * 100;
                return {
                    left: `${left}%`,
                    width: `${Math.max(0, Math.min((to - from) / this.totalSeconds * 100, 100 - left))}%`,
                };
            }).filter(band => parseFloat(band.width) > 0);
        },
        mutedSeconds() {
            const ranges = (this.manifest && this.manifest.mutedRanges) || [];
            return ranges.reduce((total, range) => {
                const to = range.to == null ? this.totalSeconds : range.to;
                return total + Math.max(0, Math.min(to, this.totalSeconds) - range.from);
            }, 0);
        },
        cursorPercent() {
            if (!this.totalSeconds) return 0;
            return Math.min(100, Math.max(0, (this.currentSeconds / this.totalSeconds) * 100));
        },
        playableDetections() {
            return this.detections.filter(d => typeof d.audioStartSeconds === 'number');
        },
        blocks() {
            if (!this.totalSeconds) return [];
            return this.playableDetections.map((detection, index) => {
                const start = Math.max(0, detection.audioStartSeconds);
                const end = Math.min(this.totalSeconds,
                    typeof detection.audioEndSeconds === 'number' ? detection.audioEndSeconds : start + 1);
                const left = (start / this.totalSeconds) * 100;
                const width = Math.max(0.4, ((end - start) / this.totalSeconds) * 100);
                return {
                    key: detection.id || `${detection.tuneId}-${index}`,
                    title: `${detection.title || 'Unknown'} — ${formatSecondsAsDuration(start)}`,
                    style: {
                        left: `${left}%`,
                        width: `${Math.min(width, 100 - left)}%`,
                        background: BLOCK_COLOURS[index % BLOCK_COLOURS.length],
                    },
                };
            });
        },
        // Stretches the user silenced with the mute button. Tunes detected
        // during one are still listed and still seekable — they just play
        // silence, and the strip has to say so.
        mutedBlocks() {
            if (!this.manifest || !this.totalSeconds) return [];
            const ranges = Array.isArray(this.manifest.mutedRanges) ? this.manifest.mutedRanges : [];
            return ranges.map(range => {
                const from = Math.max(0, range.from);
                // A range left open by a session that ended while muted runs to
                // the end of the recorded audio.
                const to = Math.min(this.totalSeconds,
                    typeof range.to === 'number' ? range.to : this.totalSeconds);
                if (!(to > from)) return null;
                const left = (from / this.totalSeconds) * 100;
                return {
                    left: `${left}%`,
                    width: `${Math.min(((to - from) / this.totalSeconds) * 100, 100 - left)}%`,
                };
            }).filter(Boolean);
        },
        mutedSummary() {
            const ranges = Array.isArray(this.manifest.mutedRanges) ? this.manifest.mutedRanges : [];
            const total = ranges.reduce((sum, range) => sum +
                Math.max(0, (typeof range.to === 'number' ? range.to : this.totalSeconds) - range.from), 0);
            return `${formatSecondsAsDuration(total)} muted`;
        },
        nowPlayingLabel() {
            const current = this.playableDetections.filter(d =>
                d.audioStartSeconds <= this.currentSeconds &&
                (typeof d.audioEndSeconds !== 'number' || d.audioEndSeconds >= this.currentSeconds));
            if (current.length) return current[current.length - 1].title || 'Unknown tune';
            return this.playing ? 'Playing' : 'Ready';
        },
    },
    watch: {
        sessionId() { this.reload(); },
    },
    created() {
        this.reload();
        // A live session's recording grows under the player: without this the
        // timeline strip would stop at whatever had been written when the view
        // was opened, and a tune played since would have no block to tap.
        // Re-reading the manifest never disturbs playback — it does not touch
        // the audio element.
        this._onAudioState = (payload) => {
            if (!payload || payload.sessionId !== this.sessionId) return;
            this.refreshManifest();
        };
        eventBus.$on('sessionAudioState', this._onAudioState);
    },
    beforeDestroy() {
        eventBus.$off('sessionAudioState', this._onAudioState);
        this.teardown();
    },
    methods: {
        formatSecondsAsDuration,
        formatBytes,

        async reload() {
            this.teardown();
            this.manifest = null;
            this.error = '';
            this.currentSeconds = 0;
            if (!this.sessionId) return;
            const manifest = await readManifest(this.sessionId);
            if (manifest && manifest.segments.length) this.manifest = manifest;
        },

        // Picks up segments written since the manifest was last read, without
        // resetting playback the way reload() does.
        async refreshManifest() {
            if (!this.sessionId) return;
            const manifest = await readManifest(this.sessionId);
            if (manifest && manifest.segments.length) this.manifest = manifest;
        },

        teardown() {
            const audio = this.$refs.audio;
            if (audio) {
                try { audio.pause(); } catch (e) { /* not loaded */ }
                audio.removeAttribute('src');
            }
            this._revoke();
            this.playing = false;
            this.segmentIndex = null;
        },

        _revoke() {
            if (this.objectUrl) {
                URL.revokeObjectURL(this.objectUrl);
                this.objectUrl = null;
            }
        },

        _segmentFor(seconds) {
            if (!this.manifest) return null;
            const segments = this.manifest.segments.slice().sort((a, b) => a.index - b.index);
            return segments.find(s => s.startSeconds + s.durationSeconds > seconds) ||
                segments[segments.length - 1] || null;
        },

        // Public: the ▶ on a tune row calls this.
        async playFrom(seconds, { autoplay = true } = {}) {
            const target = Math.max(0, Math.min(seconds, Math.max(0, this.totalSeconds - 0.5)));
            const segment = this._segmentFor(target);
            if (!segment) return;

            if (this.segmentIndex === segment.index) {
                this._seekWithin(target);
                if (autoplay) this._play();
                return;
            }
            await this._loadSegment(segment, target, autoplay);
        },

        async playTune(detection) {
            if (typeof detection.audioStartSeconds !== 'number') return;
            return this.playFrom(detection.audioStartSeconds - PLAY_PREROLL_SECONDS);
        },

        async _loadSegment(segment, seekSeconds, autoplay) {
            const audio = this.$refs.audio;
            if (!audio) return;
            this.error = '';
            try {
                const clip = await buildClip(
                    this.sessionId,
                    segment.startSeconds,
                    segment.startSeconds + segment.durationSeconds,
                    this.manifest,
                );
                if (!clip) {
                    this.error = 'That part of the recording is missing.';
                    return;
                }
                this._revoke();
                this.objectUrl = URL.createObjectURL(clip.blob);
                this.segmentIndex = segment.index;
                this.segmentStartSeconds = clip.startSeconds;
                this.timelineBase = 0;
                this.pendingSeekSeconds = seekSeconds;
                this._autoplayAfterLoad = autoplay;
                audio.src = this.objectUrl;
                audio.load();
            } catch (e) {
                this.error = `Could not load the recording: ${(e && e.message) || e}`;
            }
        },

        onLoadedMetadata() {
            const audio = this.$refs.audio;
            if (!audio) return;
            // Whatever origin this blob's timeline happens to have. Seeking is
            // then `base + (target - segmentStart)`, which is right whether the
            // browser rebased the clip to zero or kept its original timestamps.
            this.timelineBase = (audio.seekable && audio.seekable.length)
                ? audio.seekable.start(0)
                : 0;
            if (this.pendingSeekSeconds !== null) {
                this._seekWithin(this.pendingSeekSeconds);
                this.pendingSeekSeconds = null;
            }
            if (this._autoplayAfterLoad) {
                this._autoplayAfterLoad = false;
                this._play();
            }
        },

        _seekWithin(targetSeconds) {
            const audio = this.$refs.audio;
            if (!audio) return;
            const local = this.timelineBase + (targetSeconds - this.segmentStartSeconds);
            try { audio.currentTime = Math.max(this.timelineBase, local); } catch (e) { /* not seekable yet */ }
            this.currentSeconds = targetSeconds;
        },

        _play() {
            const audio = this.$refs.audio;
            if (!audio) return;
            const started = audio.play();
            if (started && started.catch) {
                started.catch(e => { this.error = `Could not play: ${(e && e.message) || e}`; });
            }
        },

        async togglePlay() {
            const audio = this.$refs.audio;
            if (!audio) return;
            if (this.playing) { audio.pause(); return; }
            if (this.segmentIndex === null) return this.playFrom(this.currentSeconds);
            this._play();
        },

        onTimeUpdate() {
            const audio = this.$refs.audio;
            if (!audio || this.segmentIndex === null) return;
            this.currentSeconds = this.segmentStartSeconds + (audio.currentTime - this.timelineBase);
        },

        // Segments are separate files, so continuous playback has to walk them.
        // Blob URLs load from local storage, so the join is short — but it is
        // not gapless, and a segment boundary is audible as a brief break.
        async onEnded() {
            if (!this.manifest || this.segmentIndex === null) return;
            const next = this.manifest.segments
                .slice()
                .sort((a, b) => a.index - b.index)
                .find(s => s.index > this.segmentIndex);
            if (!next) { this.playing = false; return; }
            await this._loadSegment(next, next.startSeconds, true);
        },

        onAudioError() {
            // An empty src is how teardown() clears the element; not an error.
            const audio = this.$refs.audio;
            if (!audio || !audio.getAttribute('src')) return;
            this.error = 'This browser could not play the recorded audio.';
        },

        onStripClick(event) {
            const strip = this.$refs.strip;
            if (!strip || !this.totalSeconds) return;
            const rect = strip.getBoundingClientRect();
            if (!rect.width) return;
            const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            this.playFrom(ratio * this.totalSeconds, { autoplay: this.playing });
        },

        async exportTrack(track) {
            this.exportingIndex = track.index;
            this.error = '';
            try {
                const clip = await buildClip(
                    this.sessionId, track.startSeconds, track.endSeconds, this.manifest);
                if (!clip) throw new Error('nothing recorded for this part');
                const extension = fileExtensionFor(clip.mimeType);
                const name = `folkfriend-session-${this.sessionId}` +
                    `${this.tracks.length > 1 ? `-part${track.index + 1}` : ''}.${extension}`;
                const file = new File([clip.blob], name, { type: clip.mimeType || 'audio/mpeg' });

                if (navigator.canShare && navigator.canShare({ files: [file] })) {
                    await navigator.share({ files: [file], title: name });
                    return;
                }
                const url = URL.createObjectURL(clip.blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = name;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                setTimeout(() => URL.revokeObjectURL(url), 30_000);
            } catch (e) {
                // A share the user dismissed is not a failure worth reporting.
                if (e && e.name === 'AbortError') return;
                this.error = `Could not export the recording: ${(e && e.message) || e}`;
            } finally {
                this.exportingIndex = null;
            }
        },
    },
};
</script>

<style scoped>
.playerClock {
    font-variant-numeric: tabular-nums;
}

.audioStrip {
    position: relative;
    height: 26px;
    width: 100%;
    border-radius: 4px;
    background: rgba(128, 128, 128, 0.18);
    overflow: hidden;
    cursor: pointer;
}

.audioStripBlock {
    position: absolute;
    top: 0;
    bottom: 0;
    opacity: 0.75;
}

/* Diagonal hatching rather than a flat block: it has to read as "nothing
   here" over the coloured tune blocks underneath, at phone size. */
.audioStripMuted {
    position: absolute;
    top: 0;
    bottom: 0;
    background: repeating-linear-gradient(
        45deg,
        rgba(120, 120, 120, 0.95),
        rgba(120, 120, 120, 0.95) 4px,
        rgba(80, 80, 80, 0.95) 4px,
        rgba(80, 80, 80, 0.95) 8px
    );
}

.audioStripMuted {
    position: absolute;
    top: 0;
    bottom: 0;
    background: repeating-linear-gradient(
        45deg,
        rgba(128, 128, 128, 0.85),
        rgba(128, 128, 128, 0.85) 4px,
        rgba(160, 160, 160, 0.85) 4px,
        rgba(160, 160, 160, 0.85) 8px
    );
}

.audioStripCursor {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: #000;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.7);
}
</style>
