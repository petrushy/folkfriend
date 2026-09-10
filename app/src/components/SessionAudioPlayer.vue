<template>
    <div class="sessionAudioPlayer">
        <v-alert v-if="!manifest && error" dense text type="warning">{{ error }}</v-alert>
        <template v-if="manifest">
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
            <!-- Stretches with no audio at all: a segment that could not be
                 stored. Detection carried on through them, so tunes are listed
                 there and the strip has to say why they cannot be played. -->
            <div
                v-for="(block, index) in gapBlocks"
                :key="`gap-${index}`"
                class="audioStripGap"
                :style="block"
                title="Not recorded — storage was full"
            />
            <!-- Drawn OVER the tune blocks: a muted stretch still has tunes
                 detected in it (detection never stops), so the two overlap and
                 the mute is the fact that has to win visually. Seeking into
                 unexplained silence is indistinguishable from a bug. -->
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
            <span v-if="gapBlocks.length">Some audio was not saved</span>
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

        </template>
        <audio v-if="manifest"
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
    playbackReadManifest as readManifest, buildClip, trackRanges, formatBytes, fileExtensionFor,
} from '@/services/sessionAudioStore.js';

// Fallback for a session recorded before detections carried their own playback
// anchor. Half the live default window (10 s), which is what the anchor works
// out to for anything recorded at that setting — i.e. very nearly all of them.
//
// A fixed offset is only ever a guess: the right distance back depends on the
// window the session was analysed with, which is why the anchor is computed at
// detection time and persisted. See clusterDetections().
const FALLBACK_WINDOW_SECONDS = 10;
const FALLBACK_PREROLL_SECONDS = FALLBACK_WINDOW_SECONDS / 2;

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
            // How this clip's real decoded length compares with what the
            // manifest claims. 1 when they agree — see _measureDrift().
            driftRatio: 1,
            driftSeconds: 0,
            // The manifest's duration for the clip currently loaded.
            _segmentDurationSeconds: 0,
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
        // The stretches actually on disk, contiguous runs merged. A recording
        // is not necessarily continuous: a segment that failed to store leaves
        // a real hole, and the clock steps past it so later audio does not
        // overwrite what came before.
        recordedRanges() {
            if (!this.manifest) return [];
            const sorted = this.manifest.segments.slice()
                .sort((a, b) => a.startSeconds - b.startSeconds);
            const ranges = [];
            for (const segment of sorted) {
                const from = segment.startSeconds;
                const to = segment.startSeconds + segment.durationSeconds;
                const last = ranges[ranges.length - 1];
                if (last && from - last.to <= 0.25) last.to = Math.max(last.to, to);
                else ranges.push({ from, to });
            }
            return ranges;
        },
        // The complement of the above, which is what the strip draws: showing a
        // hole as ordinary recorded audio makes a ▶ that cannot work look like
        // a bug rather than like missing audio.
        gapBlocks() {
            if (!this.totalSeconds) return [];
            const gaps = [];
            let cursor = 0;
            for (const range of this.recordedRanges) {
                if (range.from > cursor) gaps.push({ from: cursor, to: range.from });
                cursor = Math.max(cursor, range.to);
            }
            if (cursor < this.totalSeconds) gaps.push({ from: cursor, to: this.totalSeconds });
            return gaps.map(gap => {
                const left = (gap.from / this.totalSeconds) * 100;
                return {
                    left: `${left}%`,
                    width: `${Math.min(((gap.to - gap.from) / this.totalSeconds) * 100, 100 - left)}%`,
                };
            });
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
            if (payload && payload.sessionId && payload.sessionId !== this.sessionId) return;
            this.refreshManifest();
        };
        eventBus.$on('sessionAudioState', this._onAudioState);
        // A backup finishing can make a cloud manifest available, so the player
        // listens to both — but they stay separate events, because only one of
        // them says anything about the recorder.
        eventBus.$on('dropboxStateChanged', this._onAudioState);
        this._onDropboxConnected = async () => {
            await this.refreshManifest();
            const pending = this._pendingCloudPlay;
            this._pendingCloudPlay = null;
            if (pending && pending.id === this.sessionId) this.playFrom(pending.seconds, { autoplay: pending.autoplay });
        };
        eventBus.$on('dropboxConnected', this._onDropboxConnected);
    },
    beforeDestroy() {
        eventBus.$off('sessionAudioState', this._onAudioState);
        eventBus.$off('dropboxStateChanged', this._onAudioState);
        eventBus.$off('dropboxConnected', this._onDropboxConnected);
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
            const id = this.sessionId;
            try {
                const manifest = await readManifest(id);
                if (id !== this.sessionId) return;
                this.manifest = manifest && manifest.segments.length ? manifest : null;
                this.error = '';
            } catch (e) { if (id === this.sessionId) this.error = e.message; }
        },

        // Picks up segments written since the manifest was last read, without
        // resetting playback the way reload() does.
        async refreshManifest() {
            if (!this.sessionId) return;
            const id = this.sessionId;
            try {
                const manifest = await readManifest(id);
                if (id !== this.sessionId) return;
                // A refresh only ever ADDS to what is known. readManifest()
                // answers a failed IndexedDB read with null exactly as it
                // answers "there is no recording", so assigning null here made
                // one transient hiccup take the whole player off the screen
                // mid-session. reload() is the only thing that clears it, and
                // it does so because the session itself changed.
                if (manifest && manifest.segments.length) {
                    this.manifest = manifest;
                    this.error = '';
                }
            } catch (e) { if (id === this.sessionId) this.error = e.message; }
        },

        teardown() {
            this._loadGeneration = (this._loadGeneration || 0) + 1;
            this._pendingCloudPlay = null;
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

        // The stored segment covering this moment, or null if none does.
        //
        // Deliberately NOT "the nearest" or "the last one". A tune detected in
        // the segment still being recorded has an offset past everything on
        // disk — segments are only written every SEGMENT_SECONDS — and falling
        // back to the last stored segment plays unrelated audio from minutes
        // earlier while looking like it worked. The same gap is permanent for
        // anything after a crash or a refused quota write.
        _segmentFor(seconds) {
            if (!this.manifest) return null;
            const segments = this.manifest.segments.slice().sort((a, b) => a.index - b.index);
            return segments.find(s =>
                s.startSeconds <= seconds && s.startSeconds + s.durationSeconds > seconds) || null;
        },

        // Whether a given moment is actually on disk yet. The view asks before
        // offering a ▶, so a row whose audio is still in the pending segment
        // shows no button rather than a button that plays the wrong tune.
        covers(seconds) {
            return !!this._segmentFor(Math.max(0, seconds));
        },

        // Public: the ▶ on a tune row calls this.
        async playFrom(seconds, { autoplay = true } = {}) {
            const target = Math.max(0, seconds);
            const segment = this._segmentFor(target);
            if (!segment) {
                this.error = target >= this.totalSeconds
                    ? 'That part of the session has not been saved yet — it is written every few minutes.'
                    : 'That part of the recording is missing.';
                return;
            }
            this.error = '';

            if (this.segmentIndex === segment.index) {
                this._seekWithin(target);
                if (autoplay) this._play();
                return;
            }
            await this._loadSegment(segment, target, autoplay);
        },

        // The recorded stretch a moment falls inside, or null.
        _rangeContaining(seconds) {
            return this.recordedRanges.find(r => seconds >= r.from && seconds < r.to) || null;
        },

        // Where playback starts for a given detection.
        //
        // The stored anchor when there is one: audioStartSeconds is the moment
        // the first matching window ENDED, so the tune's audio runs from a
        // window earlier, and the anchor is that window's midpoint — the one
        // place the tune is certainly playing. A fixed offset cannot express
        // that, because the right distance depends on the window the session
        // was analysed with.
        _anchorFor(detection) {
            if (typeof detection.audioAnchorSeconds === 'number') {
                return Math.max(0, detection.audioAnchorSeconds);
            }
            return Math.max(0, detection.audioStartSeconds - FALLBACK_PREROLL_SECONDS);
        },

        async playTune(detection) {
            if (typeof detection.audioStartSeconds !== 'number') return;
            // CLAMPED to the recorded stretch the tune is in.
            //
            // A recording can have holes, and a tune just after one can sit
            // within an anchor's reach of it: seeking blindly lands in the gap,
            // finds no segment, and reports the audio missing — for a tune
            // whose audio is right there. The same clamp handles the start of
            // the recording, where the anchor would go negative.
            const range = this._rangeContaining(detection.audioStartSeconds);
            if (!range) {
                // Nothing was recorded at this tune's position, so there is
                // nothing to clamp to — and seeking to start - 12 s would land
                // in the PRECEDING stretch and play unrelated audio. The view
                // does not offer a button here, but it decides from state that
                // can be a moment stale while a segment is being written.
                this.error = 'That part of the session was not recorded.';
                return;
            }
            return this.playFrom(Math.max(this._anchorFor(detection), range.from));
        },

        async _loadSegment(segment, seekSeconds, autoplay) {
            const generation = this._loadGeneration = (this._loadGeneration || 0) + 1;
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
                if (generation !== this._loadGeneration) return;
                if (!clip) {
                    this.error = 'That part of the recording is missing.';
                    return;
                }
                this._revoke();
                this.objectUrl = URL.createObjectURL(clip.blob);
                this.segmentIndex = segment.index;
                this.segmentStartSeconds = clip.startSeconds;
                this._segmentDurationSeconds = (clip.endSeconds - clip.startSeconds) || 0;
                this.driftRatio = 1;
                this.driftSeconds = 0;
                this.timelineBase = 0;
                this.pendingSeekSeconds = seekSeconds;
                this._autoplayAfterLoad = autoplay;
                audio.src = this.objectUrl;
                audio.load();
            } catch (e) {
                if (generation !== this._loadGeneration) return;
                if (e.code === 'auth') this._pendingCloudPlay = { id: this.sessionId, seconds: seekSeconds, autoplay };
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
            this._measureDrift(audio);
            if (this.pendingSeekSeconds !== null) {
                this._seekWithin(this.pendingSeekSeconds);
                this.pendingSeekSeconds = null;
            }
            if (this._autoplayAfterLoad) {
                this._autoplayAfterLoad = false;
                this._play();
            }
        },

        // What this clip's audio ACTUALLY decodes to, against what the manifest
        // says it should be.
        //
        // The manifest's times come from the recorder's clock, which is
        // measured at chunk arrivals rather than from the encoded audio itself.
        // The two normally agree closely; they can diverge when the encoder
        // stalls, or when a muted track yields less data than the wall clock
        // says it should. Whatever the cause, the audio element is the
        // authority on its own timeline — so the seek is scaled to it rather
        // than trusting the manifest.
        _measureDrift(audio) {
            this.driftRatio = 1;
            this.driftSeconds = 0;
            const expected = this._segmentDurationSeconds;
            if (!(expected > 0)) return;

            const seekable = audio.seekable;
            const measured = (seekable && seekable.length)
                ? seekable.end(seekable.length - 1) - seekable.start(0)
                : (Number.isFinite(audio.duration) ? audio.duration : 0);
            if (!(measured > 0)) return;

            const ratio = measured / expected;
            this.driftSeconds = measured - expected;
            // Only a plausible correction is applied. A wildly different figure
            // means the MEASUREMENT is wrong (a container reporting nonsense,
            // metadata not fully parsed), and scaling by it would be far worse
            // than not scaling at all.
            //
            // The band is wide on purpose: a clip that really did decode to
            // half its claimed length is a large drift, not a bad reading, and
            // scaling is exactly the right answer for it. Only figures that
            // could not describe this audio at all are ignored.
            if (ratio >= 0.25 && ratio <= 4) this.driftRatio = ratio;
        },

        _seekWithin(targetSeconds) {
            const audio = this.$refs.audio;
            if (!audio) return;
            const offsetIntoSegment = (targetSeconds - this.segmentStartSeconds) * this.driftRatio;
            const local = this.timelineBase + offsetIntoSegment;
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
            if (this.segmentIndex === null) {
                const first = this.manifest.segments.slice()
                    .sort((a, b) => a.index - b.index)[0];
                return this.playFrom(this.covers(this.currentSeconds)
                    ? this.currentSeconds
                    : (first ? first.startSeconds : 0));
            }
            this._play();
        },

        onTimeUpdate() {
            const audio = this.$refs.audio;
            if (!audio || this.segmentIndex === null) return;
            // The inverse of the seek, so the clock the user reads and the
            // position the ▶ buttons jump to stay the same scale.
            this.currentSeconds = this.segmentStartSeconds +
                (audio.currentTime - this.timelineBase) / this.driftRatio;
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
            const target = ratio * this.totalSeconds;
            if (!this.covers(target)) return;
            this.playFrom(target, { autoplay: this.playing });
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

/* A hole in the recording. Flat and dim rather than hatched, so it reads as
   "nothing here" against the muted bands, which are hatched. */
.audioStripGap {
    position: absolute;
    top: 0;
    bottom: 0;
    background: rgba(90, 90, 90, 0.55);
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
