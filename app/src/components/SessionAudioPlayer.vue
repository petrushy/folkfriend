<template>
    <div class="sessionAudioPlayer">
        <v-alert v-if="!manifest && error" dense text type="warning">{{ error }}</v-alert>
        <template v-if="manifest">
        <div class="d-flex align-center flex-wrap" style="gap: 12px;">
            <!-- Landing on a given second by tapping a three-hour evening
                 mapped onto a phone-width strip is not something anyone can
                 do: one pixel is about twenty seconds. These are the precise
                 control, and they are also what the keyboard bindings on the
                 strip do. -->
            <v-btn icon :disabled="!totalSeconds" aria-label="Back 15 seconds" @click="seekBy(-SKIP_SECONDS)">
                <v-icon>{{ icons.rewind }}</v-icon>
            </v-btn>
            <v-btn icon :disabled="!totalSeconds" :aria-label="playing ? 'Pause playback' : 'Play recording'" @click="togglePlay">
                <v-icon>{{ playing ? icons.pause : icons.play }}</v-icon>
            </v-btn>
            <v-btn icon :disabled="!totalSeconds" aria-label="Forward 15 seconds" @click="seekBy(SKIP_SECONDS)">
                <v-icon>{{ icons.forward }}</v-icon>
            </v-btn>
            <div class="playerClock">
                {{ formatSecondsAsDuration(currentSeconds) }} / {{ formatSecondsAsDuration(totalSeconds) }}
            </div>
            <v-spacer />
            <div class="text--secondary caption">
                {{ formatBytes(manifest.bytes) }}<span v-if="bitrateLabel"> · {{ bitrateLabel }}</span><span
                    v-if="channelsLabel"
                > · {{ channelsLabel }}</span>
            </div>
        </div>

        <!-- The strip IS the link between the tune list and the recording:
             every detection with an audio offset is a block you can tap. -->
        <!-- A slider, not a decorated div. It was click-only: no keyboard
             seeking, nothing for a screen reader to read, and no way to land
             on a particular second. -->
        <div
            ref="strip"
            class="audioStrip mt-2"
            role="slider"
            tabindex="0"
            aria-label="Recording position"
            aria-valuemin="0"
            :aria-valuemax="Math.round(totalSeconds)"
            :aria-valuenow="Math.round(currentSeconds)"
            :aria-valuetext="positionLabel"
            @click="onStripClick"
            @keydown="onStripKey"
        >
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
            <!-- Reading a position off an unmarked bar means guessing. -->
            <div
                v-for="tick in ticks"
                :key="`tick-${tick.seconds}`"
                class="audioStripTick"
                :style="{ left: tick.percent + '%' }"
            />
            <div class="audioStripCursor" :style="{ left: cursorPercent + '%' }" />
        </div>
        <div class="audioStripScale caption text--secondary" aria-hidden="true">
            <span v-for="tick in ticks" :key="`label-${tick.seconds}`" :style="{ left: tick.percent + '%' }">
                {{ tick.label }}
            </span>
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

        <!-- A recording whose second channel is silent plays out of one
             speaker in every ordinary player. Playback here is corrected, but
             the stored bytes are what they are, so the export is not — and a
             note that says only the first half would be a false promise. -->
        <p v-if="channelRepair" class="caption text--secondary mb-0 mt-2">
            This recording has sound on one channel only. Playback here is corrected to
            both speakers; an exported copy of it keeps the original channels.
            Recordings made from now on are corrected as they are recorded.
        </p>
        <!-- Not cosmetic: one-sided playback with no correction is exactly
             what this looks like, and without this line it is indistinguishable
             from a recording that genuinely has nothing to correct. -->
        <p v-if="channelProbeFailed" class="caption text--secondary mb-0 mt-2">
            This device could not examine the recording's channels, so playback is
            not being corrected. If it plays out of one speaker only, an exported
            copy will too.
        </p>
        <!-- The correction routes the element through a Web Audio graph, and a
             suspended context in front of it is SILENCE rather than merely
             uncorrected sound. Saying nothing here would present as playback
             that runs with no audio at all. -->
        <v-alert v-if="channelRepairStalled" type="warning" dense text class="mt-2 mb-0">
            This device's audio engine is suspended, so the one-channel correction
            cannot play. Tap play again, or reload the page.
        </v-alert>

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
import { mdiPlay, mdiPause, mdiRewind15, mdiFastForward15 } from '@mdi/js';
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

// The skip buttons, and what an arrow key moves by. Fifteen seconds is about a
// phrase: far enough to be worth a tap, short enough not to skip the tune.
const SKIP_SECONDS = 15;
// Shift, and Page Up/Down, for getting across an evening.
const COARSE_SKIP_SECONDS = 60;
// How many labelled marks go under the strip. Five (four intervals) is what
// fits at phone width without the labels colliding.
const TICK_COUNT = 5;

// How much of the recording is decoded to find out what its channels actually
// contain. Only long enough to tell sound from digital silence — the point is
// to detect a dead channel, not to measure the audio.
const CHANNEL_PROBE_SECONDS = 4;

// Where in a track those seconds are taken from, in order.
//
// One look at the opening is not enough: a session muted for its first minute,
// or one that simply started before anyone played, decodes to silence — and
// silence cannot tell a dead channel from a quiet room, so it is INCONCLUSIVE
// rather than "nothing to correct". Each further attempt looks further in, and
// there are only three of them: re-decoding on every manifest refresh would be
// a real cost on a live session for an answer that is usually unobtainable.
const CHANNEL_PROBE_OFFSETS_SECONDS = [0, 30, 120];

// Anything above this RMS counts as signal, for the same reason and at the same
// order of magnitude as SILENT_RMS in mic.js: a channel carrying real audio is
// orders of magnitude above it, and a dead one is exact zeroes.
const SILENT_CHANNEL_RMS = 1e-5;

// Decodes a clip to PCM without needing a playback AudioContext — an
// OfflineAudioContext can be constructed with no user gesture, which a probe
// that runs on load must not require. Resolves null when the browser cannot do
// it, so an unanswerable question leaves playback exactly as it was.
async function decodeClip(blob) {
    const Offline = typeof window !== 'undefined' &&
        (window.OfflineAudioContext || window.webkitOfflineAudioContext);
    if (!Offline || !blob || typeof blob.arrayBuffer !== 'function') return null;
    // TWO channels, not one. Per spec the context's channel count does not
    // constrain what decodeAudioData returns — the buffer carries the FILE's
    // channels — so one would be harmless. But this probe exists precisely to
    // count the file's channels, and WebKit has a long history of remixing
    // decoded data to the decoding context's own configuration. If it does,
    // a stereo file comes back as one channel, `numberOfChannels > 1` is
    // false, and the probe reports "nothing to fix" about the very recording
    // it was asked to examine — the one-sided playback it exists to correct,
    // declared healthy. Asking for two removes the dependency altogether: a
    // genuinely mono file still answers mono where the spec is followed, and
    // upmixes to two IDENTICAL channels where it is not, which reads as
    // not-one-sided either way.
    const ctx = new Offline(2, 1, 44100);
    const bytes = await blob.arrayBuffer();
    // Safari only grew the promise form in 14.1, and the callback form is still
    // the one it implements most reliably.
    return new Promise((resolve, reject) => {
        let settled = false;
        const ok = (buffer) => { if (!settled) { settled = true; resolve(buffer); } };
        const fail = (e) => { if (!settled) { settled = true; reject(e || new Error('decode failed')); } };
        let maybePromise;
        try {
            maybePromise = ctx.decodeAudioData(bytes, ok, fail);
        } catch (e) {
            fail(e);
            return;
        }
        if (maybePromise && maybePromise.then) maybePromise.then(ok, fail);
    });
}

function channelRms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

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
            // Which stored segment the <audio> element currently holds.
            segmentIndex: null,
            // THE ORIGIN OF THE LOADED CLIP'S MEDIA TIMELINE, in session-audio
            // time — the start of the TRACK the clip was cut from, not the
            // start of the clip.
            //
            // A clip is a track's initialisation bytes followed by chunks that
            // carry that track's own timestamps, so a clip cut from an hour
            // into a track begins, as far as the container is concerned, an
            // hour in. Seeking as though it began at zero is what made the
            // timeline work near the start of a session and not further in.
            trackStartSeconds: 0,
            // Where the browser says the clip's timeline begins. Used only as
            // a floor, never as the origin: Chromium reports 0 for a WebM
            // whose audio starts an hour in, so it cannot answer that question
            // — the timestamps in the bytes do.
            timelineBase: 0,
            // How this clip's real decoded length compares with what the
            // manifest claims. 1 when they agree — see _measureDrift().
            driftRatio: 1,
            driftSeconds: 0,
            // Where the manifest says the loaded clip ends, on its own media
            // timeline (i.e. measured from the track's start).
            _clipMediaEndSeconds: 0,
            objectUrl: null,
            pendingSeekSeconds: null,
            // What the recording's channels actually CONTAIN, measured from
            // decoded audio rather than taken from the manifest, PER TRACK:
            // `{ [trackIndex]: { channels, oneSided, inconclusive } }`. A
            // device that reports two input channels and only fills the first
            // produces a stereo file that plays out of one speaker, and
            // nothing in the manifest distinguishes that from real stereo.
            //
            // Per track because a track is a separate MediaRecorder run: Pause,
            // Resume and a reacquired microphone each start one, and each can
            // come back on a different device or a different channel count.
            // One answer for the whole session applied the first track's
            // finding to every later one — which for a later MONO track means
            // a doubled gain on audio that was never one-sided.
            channelProbes: {},
            // Which track the loaded clip belongs to, i.e. which of the above
            // applies right now.
            currentTrackIndex: 0,
            // Whether playback is being corrected for the above.
            channelRepair: false,
            // The correction is configured but its AudioContext is suspended,
            // so nothing is coming out of it. Worth saying plainly: an element
            // that has been given a MediaElementAudioSourceNode plays through
            // the graph permanently, so a suspended context is SILENCE, not a
            // missing correction.
            channelRepairStalled: false,
            // The probe could not answer. Distinct from "answered: nothing to
            // correct", because the two sound entirely different out of a
            // phone and only one of them is worth telling someone about.
            channelProbeFailed: false,
            // What the currently loaded clip actually is, for the failure
            // message: the container a decode refusal is about.
            clipMimeType: '',
            clipBytes: 0,
            // What the loaded clip's bytes ARE, and how many of them were
            // prepended as the track's initialisation segment. On the one
            // device this matters on there is no console, so a refusal has to
            // carry enough to say WHICH half of the system is at fault.
            clipShape: '',
            clipHeaderBytes: 0,
            icons: { play: mdiPlay, pause: mdiPause, rewind: mdiRewind15, forward: mdiFastForward15 },
            SKIP_SECONDS,
        };
    },
    computed: {
        totalSeconds() { return this.manifest ? this.manifest.totalSeconds : 0; },
        // What was measured about the stretch being played, or null while
        // unknown. An inconclusive answer is kept — it is what stops the probe
        // running for ever — but it claims nothing.
        channelProbe() { return this.channelProbes[this.currentTrackIndex] || null; },
        tracks() { return trackRanges(this.manifest); },
        bitrateLabel() {
            const bps = this.manifest && this.manifest.bitsPerSecond;
            return bps ? `${Math.round(bps / 1000)} kbps` : '';
        },
        // What the recording IS, preferring what was measured over what was
        // recorded at the time. Empty when neither is known — a recording made
        // before the manifest carried a channel count is described as unknown
        // rather than guessed at.
        channelsLabel() {
            const probe = this.channelProbe;
            if (probe && probe.oneSided) return 'one channel only';
            const count = (probe && probe.channels) ||
                (this.manifest && this.manifest.channels) || 0;
            if (count === 1) return 'mono';
            if (count === 2) return 'stereo';
            return '';
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
        // Read out by the slider, and what a screen reader announces after
        // each arrow press.
        positionLabel() {
            return `${formatSecondsAsDuration(this.currentSeconds)} of ${formatSecondsAsDuration(this.totalSeconds)}`;
        },
        ticks() {
            if (!this.totalSeconds) return [];
            return Array.from({ length: TICK_COUNT }, (_, i) => {
                const percent = (i / (TICK_COUNT - 1)) * 100;
                const seconds = (percent / 100) * this.totalSeconds;
                return { percent, seconds, label: formatSecondsAsDuration(seconds) };
            });
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
                const span = this.audioSpan(detection);
                const start = span.from;
                const end = Math.min(this.totalSeconds, span.to);
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
            const current = this.playableDetections.filter(d => {
                const span = this.audioSpan(d);
                return span.from <= this.currentSeconds && span.to >= this.currentSeconds;
            });
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
        if (this._audioCtx && this._audioCtx.close) {
            this._audioCtx.close().catch(() => {});
            this._audioCtx = null;
            this._mixNode = null;
            this._sourceNode = null;
        }
    },
    methods: {
        formatSecondsAsDuration,
        formatBytes,

        async reload() {
            this.teardown();
            this.manifest = null;
            this.error = '';
            this.currentSeconds = 0;
            // A different recording is a different question, and the repair
            // graph (if one was built) is reconfigured rather than torn down —
            // an element can only ever have one MediaElementAudioSourceNode.
            this.channelProbes = {};
            this._probeAttempts = {};
            this.currentTrackIndex = 0;
            this.channelProbeFailed = false;
            this.channelRepairStalled = false;
            this._applyChannelRepair();
            if (!this.sessionId) return;
            const id = this.sessionId;
            try {
                const manifest = await readManifest(id);
                if (id !== this.sessionId) return;
                this.manifest = manifest && manifest.segments.length ? manifest : null;
                this.error = '';
                if (this.manifest) this._probeChannels();
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
                    // Cheap after the first: _probeChannels returns at once
                    // once it has answered for this session, and a live
                    // session refreshes its manifest every few seconds.
                    this._probeChannels();
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
            // SYNCHRONOUSLY, before any await. Every route into this method is
            // a tap — a ▶ on a tune row, a tap on the strip — and building the
            // repair graph needs an AudioContext, which iOS only starts inside
            // a gesture. Doing it here rather than leaving it all to _play()
            // means the graph is built while the gesture is still current,
            // instead of several awaits later from a loadedmetadata callback.
            this._prepareAudioGraph();
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
                // CANCELS an older load that has not landed yet.
                //
                // segmentIndex names the segment currently IN the element, and
                // a load only sets it once its clip has been built — which over
                // Dropbox means a download and a hash verification. So while a
                // load of another segment is in flight, a seek back into the
                // loaded one takes this branch, and without bumping the
                // generation the older request would arrive afterwards, replace
                // the source and seek to ITS target: the user's newer choice
                // silently overridden by the one they had already moved on
                // from. Every seek invalidates the seeks before it.
                this._loadGeneration = (this._loadGeneration || 0) + 1;
                this._seekWithin(target);
                if (autoplay) this._play();
                return;
            }
            await this._loadSegment(segment, target, autoplay);
        },

        // The stretch of recording a detection was actually HEARD in.
        //
        // audioStartSeconds is where the tune's first matching window ended
        // and audioEndSeconds where its last one did, so neither is the edge of
        // the audio: the tune runs from a window before the first stamp. The
        // stored anchor is that window's midpoint — the earliest moment the
        // tune is certainly playing — which is both where playback starts and
        // the honest left edge of the block. Using it also gives a row matched
        // in a single window a visible extent, without claiming any audio the
        // detector never looked at.
        audioSpan(detection) {
            const start = Math.max(0, typeof detection.audioAnchorSeconds === 'number'
                ? detection.audioAnchorSeconds
                : detection.audioStartSeconds);
            const end = typeof detection.audioEndSeconds === 'number'
                ? detection.audioEndSeconds
                : detection.audioStartSeconds;
            return { from: start, to: Math.max(start, end) };
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

        // `fromTrackStart` is the fallback for a clip a browser refuses: see
        // _retryFromTrackStart(). It changes only how much of the track is in
        // the blob — the timeline is the track's either way, so nothing about
        // seeking changes with it.
        async _loadSegment(segment, seekSeconds, autoplay, { fromTrackStart = false } = {}) {
            const generation = this._loadGeneration = (this._loadGeneration || 0) + 1;
            const audio = this.$refs.audio;
            if (!audio) return;
            this.error = '';
            const track = (this.manifest.tracks || [])
                .find(t => t.index === segment.trackIndex);
            const from = fromTrackStart && track
                ? track.startSeconds
                : segment.startSeconds;
            try {
                const clip = await buildClip(
                    this.sessionId,
                    from,
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
                this.clipMimeType = clip.mimeType || (clip.blob && clip.blob.type) || '';
                this.clipBytes = (clip.blob && clip.blob.size) || 0;
                this.clipShape = clip.shape || '';
                this.clipHeaderBytes = clip.headerBytes || 0;
                this.segmentIndex = segment.index;
                // Which track's channel finding now applies. A correction
                // worked out for the first track is not a claim about a later
                // one: each is its own MediaRecorder run and can come back on
                // a different device.
                this.currentTrackIndex = segment.trackIndex || 0;
                this._probeChannels(this.currentTrackIndex);
                this._applyChannelRepair({ build: false });
                this.trackStartSeconds = clip.trackStartSeconds || 0;
                this._clipMediaEndSeconds =
                    Math.max(0, clip.endSeconds - (clip.trackStartSeconds || 0));
                this.driftRatio = 1;
                this.driftSeconds = 0;
                this.timelineBase = 0;
                this.pendingSeekSeconds = seekSeconds;
                this._autoplayAfterLoad = autoplay;
                this._loadedSegment = segment;
                this._loadedSeekSeconds = seekSeconds;
                this._clipFromTrackStart = fromTrackStart;
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
            // A floor for seeking, not the origin — see the field's comment.
            const start = (audio.seekable && audio.seekable.length)
                ? audio.seekable.start(0)
                : 0;
            this.timelineBase = Number.isFinite(start) ? start : 0;
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

        // What this recording's channels actually CARRY, for ONE track.
        //
        // The manifest records how many channels were recorded, which does not
        // answer the question: a device that reports two input channels and
        // fills only the first produces a file that is stereo by every label
        // on it and plays out of one speaker. So a few seconds are decoded and
        // measured.
        //
        // Per track, because each track is its own MediaRecorder run and can
        // come back on a different device. Never throws, and an unanswerable
        // probe leaves playback exactly as it was.
        async _probeChannels(trackIndex = this.currentTrackIndex) {
            if (!this.sessionId) return;
            const id = this.sessionId;
            const track = this.tracks.find(t => t.index === trackIndex) || this.tracks[0];
            if (!track) return;

            if (!this._probeAttempts) this._probeAttempts = {};
            const settled = this.channelProbes[track.index];
            // A conclusive answer never changes; an inconclusive one means the
            // stretch examined was silent, which is worth one more look from
            // further in — but only a few, and never while one is in flight.
            if (settled && !settled.inconclusive) return;
            const slot = `${id}:${track.index}`;
            const attempt = this._probeAttempts[slot] || 0;
            if (attempt >= CHANNEL_PROBE_OFFSETS_SECONDS.length) return;
            if (this._probeInFlight) return;

            const from = track.startSeconds + CHANNEL_PROBE_OFFSETS_SECONDS[attempt];
            if (from >= track.endSeconds) {
                // Nothing further in to look at. Stop, rather than re-reading
                // the same opening for ever.
                this._probeAttempts[slot] = CHANNEL_PROBE_OFFSETS_SECONDS.length;
                return;
            }
            this._probeAttempts[slot] = attempt + 1;
            this._probeInFlight = slot;
            try {
                const clip = await buildClip(
                    id, from,
                    Math.min(track.endSeconds, from + CHANNEL_PROBE_SECONDS),
                    this.manifest,
                );
                if (!clip || id !== this.sessionId) return;
                const buffer = await decodeClip(clip.blob);
                if (!buffer || id !== this.sessionId) return;

                const levels = [];
                for (let c = 0; c < buffer.numberOfChannels; c++) {
                    levels.push(channelRms(buffer.getChannelData(c)));
                }
                const loudest = Math.max(...levels, 0);
                const quietest = Math.min(...levels, loudest);
                this._recordProbe(track.index, {
                    channels: buffer.numberOfChannels,
                    // Both halves matter: a recording of a silent room has
                    // every channel below the threshold and is not one-sided,
                    // it is just quiet — correcting it would be a claim about
                    // audio nobody has heard yet.
                    oneSided: buffer.numberOfChannels > 1 &&
                        loudest > SILENT_CHANNEL_RMS && quietest <= SILENT_CHANNEL_RMS,
                    // Silence cannot answer the question either way: a muted
                    // opening and a dead channel decode identically. Say so,
                    // so a later stretch of the same track gets a look.
                    inconclusive: loudest <= SILENT_CHANNEL_RMS,
                });
                this.channelProbeFailed = false;
                // Reconfigures an EXISTING graph so an answer that arrives
                // mid-playback takes effect, but never builds one: this runs
                // from reload(), from refreshManifest() and from a segment
                // load, none of which is a user gesture. On iOS an
                // AudioContext created outside one starts suspended and
                // cannot be resumed without one, and an element that has been
                // given a MediaElementAudioSourceNode outputs through the
                // graph PERMANENTLY — so building it here does not merely
                // fail to correct the audio, it can take playback to silent
                // for the whole session. _play() is the only caller that is
                // always a gesture.
                this._applyChannelRepair({ build: false });
            } catch (e) {
                // The correction is all that is lost, so playback continues —
                // but NOT silently. "No correction needed" and "the correction
                // could not be worked out" sound completely different coming
                // out of a phone, and console.debug is unreadable on the
                // device this feature is used on.
                this.channelProbeFailed = true;
                console.debug('Could not probe recording channels:', e && e.message);
            } finally {
                if (this._probeInFlight === slot) this._probeInFlight = null;
            }
        },

        // Vue 2 cannot see a key added to an object in place.
        _recordProbe(trackIndex, probe) {
            this.channelProbes = { ...this.channelProbes, [trackIndex]: probe };
        },

        // Routes playback through a downmix when, and only when, the recording
        // has sound on one channel only.
        //
        // The graph is built once and thereafter reconfigured, because an
        // element can only ever be given one MediaElementAudioSourceNode — and
        // once it has one, its sound comes out of the graph rather than the
        // element, so this is never built speculatively.
        _applyChannelRepair({ build = true } = {}) {
            const needed = !!(this.channelProbe && this.channelProbe.oneSided);
            if (!this._mixNode) {
                // Nothing is routed through a graph yet, so playback is
                // whatever the file is. Building one is a permanent change to
                // how this element makes sound, so it happens only when a
                // correction is actually needed AND the caller is a gesture.
                if (!needed || !build) { this.channelRepair = false; return; }
                if (!this._buildRepairGraph()) return;
            }
            // 'explicit' + one channel is what forces the downmix; 'max' hands
            // whatever the file has straight through again.
            this._mixNode.channelCountMode = needed ? 'explicit' : 'max';
            this._mixNode.channelCount = needed ? 1 : 2;
            // A stereo-to-mono downmix is (L + R) / 2, and R is the silent one,
            // so without this the correction would cost 6 dB. With R at zero
            // the product is exactly L.
            this._mixNode.gain.value = needed ? 2 : 1;
            this.channelRepair = needed;
        },

        _buildRepairGraph() {
            const audio = this.$refs.audio;
            const Ctx = typeof window !== 'undefined' &&
                (window.AudioContext || window.webkitAudioContext);
            if (!audio || !Ctx) return false;
            try {
                const ctx = this._audioCtx || new Ctx();
                this._audioCtx = ctx;
                const source = ctx.createMediaElementSource(audio);
                const mix = ctx.createGain();
                source.connect(mix);
                mix.connect(ctx.destination);
                this._sourceNode = source;
                this._mixNode = mix;
                // Resuming is _resumeGraph()'s job, on EVERY play rather than
                // only at construction: a context can be suspended long after
                // it was built — the browser suspends one whose page is
                // backgrounded — and a suspended context in front of the
                // element is silence, not a missing correction.
                return true;
            } catch (e) {
                console.warn('Could not correct one-sided playback:', e && e.message);
                return false;
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
            // Both sides are measured from the track's start, because that is
            // where the clip's timeline begins — comparing a media time
            // against a segment's own duration would report the distance from
            // the track's start as drift.
            const expected = this._clipMediaEndSeconds;
            if (!(expected > 0)) return;

            const seekable = audio.seekable;
            const measured = (seekable && seekable.length)
                ? seekable.end(seekable.length - 1)
                : (Number.isFinite(audio.duration) ? audio.duration : 0);
            if (!(measured > 0) || !Number.isFinite(measured)) return;

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
            // Measured from the TRACK's start, which is where the clip's own
            // timestamps are measured from.
            const local = (targetSeconds - this.trackStartSeconds) * this.driftRatio;
            try { audio.currentTime = Math.max(this.timelineBase, local); } catch (e) { /* not seekable yet */ }
            this.currentSeconds = targetSeconds;
        },

        // Everything the correction needs doing from a user gesture: build the
        // graph if this recording needs one, and resume the context if it has
        // been suspended since the last time.
        _prepareAudioGraph() {
            this._applyChannelRepair();
            this._resumeGraph();
        },

        // A suspended AudioContext in front of the element produces no sound at
        // all, so this runs on every play rather than once at construction. A
        // resume that does not take is reported rather than swallowed: it is
        // the difference between "uncorrected" and "silent".
        _resumeGraph() {
            const ctx = this._audioCtx;
            if (!ctx || !this._mixNode) { this.channelRepairStalled = false; return; }
            if (ctx.state !== 'suspended') { this.channelRepairStalled = false; return; }
            if (!ctx.resume) { this.channelRepairStalled = true; return; }
            const done = ctx.resume();
            if (done && done.then) {
                done.then(
                    () => { this.channelRepairStalled = ctx.state === 'suspended'; },
                    () => { this.channelRepairStalled = true; },
                );
            } else {
                this.channelRepairStalled = ctx.state === 'suspended';
            }
        },

        _play() {
            const audio = this.$refs.audio;
            if (!audio) return;
            // Here rather than at load, because building the graph needs an
            // AudioContext and iOS only starts one in a user gesture. Not every
            // route here is one — onLoadedMetadata reaches it several awaits
            // after the tap, and onEnded reaches it with no tap at all — which
            // is why playFrom() and togglePlay() prime it synchronously too.
            this._prepareAudioGraph();
            const started = audio.play();
            if (started && started.catch) {
                started.catch(e => {
                    if (audio.error && audio.error.code === 4 &&
                        this._retryFromTrackStart(true)) return;
                    this.error = `Could not play: ${this._playFailureDetail(audio, e)}`;
                });
            }
        },

        // play() rejects with NotSupportedError — "The operation is not
        // supported" — for every reason the element could not use the clip,
        // and that message alone cannot tell them apart. The element's own
        // error code can: DECODE (4 is SRC_NOT_SUPPORTED) says the bytes are
        // not something this browser will play, which is a different problem
        // from a refused autoplay and needs a different answer.
        //
        // The clip's declared type and size go in the same line because they
        // are what decides it, and because the one device this matters on is
        // a phone with no console to read.
        _playFailureDetail(audio, e) {
            const base = (e && e.message) || String(e);
            const detail = this._clipDetail(audio);
            return detail ? `${base} (${detail})` : base;
        },

        // What the element was asked to play, in one line.
        //
        // Reported from the field: the FIRST failure said only "This browser
        // could not play the recorded audio", and the detail appeared on the
        // second tap — from the play() rejection rather than the element's own
        // error event. So the informative moment was the one carrying nothing,
        // and two attempts were needed to learn anything. Both paths read this.
        _clipDetail(audio) {
            const code = audio && audio.error && audio.error.code;
            const KINDS = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'format not supported' };
            const parts = [];
            if (code) parts.push(KINDS[code] || `media error ${code}`);
            if (this.clipMimeType) parts.push(this.clipMimeType);
            if (this.clipShape) parts.push(this.clipShape);
            if (this.clipBytes) parts.push(`${Math.round(this.clipBytes / 1024)} kB`);
            // Which clip this was, since the answer differs entirely between a
            // mid-track clip, a track-start one that was already the fallback,
            // and a clip that began at the track's own first chunk — the last
            // of which is a plain prefix of what MediaRecorder wrote, so a
            // refusal there is not about anything this code assembled.
            parts.push(this._clipFromTrackStart
                ? 'from track start'
                : `hdr ${this.clipHeaderBytes} B`);
            return parts.join(', ');
        },

        async togglePlay() {
            const audio = this.$refs.audio;
            if (!audio) return;
            if (this.playing) { audio.pause(); return; }
            // Synchronously, while the tap is still current — see playFrom().
            this._prepareAudioGraph();
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
            this.currentSeconds = this.trackStartSeconds +
                audio.currentTime / this.driftRatio;
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

        // A clip a browser will not decode, rebuilt from the track's start.
        //
        // A mid-track clip is [the track's initialisation bytes, ...the wanted
        // chunks]. That is the arrangement MSE is built on and Chromium accepts
        // it, but whether WebKit does for its own fMP4 has never been
        // measurable from anywhere but the device — and a refusal there looks
        // exactly like a refusal for any other reason. A clip from the track's
        // start needs no assembly at all: it is a prefix of what MediaRecorder
        // wrote, which is what "Export part N" produces and is known to play.
        //
        // Tried once per clip, and only for a decode refusal. It costs a larger
        // blob, so it is a fallback rather than the default; the timeline is
        // the track's under both, so the seek does not change.
        _retryFromTrackStart(autoplay) {
            // A refused clip reaches BOTH the element's error event and the
            // rejection of the play() that was waiting on it, and neither
            // arrives first reliably. The second one through must not report a
            // failure the first one is already retrying — and it would report
            // it against the OLD clip's size and container, since the retry's
            // own clip is still being assembled. That is a message describing
            // bytes nothing is trying to play any more.
            if (this._retryingFromTrackStart) return true;
            const segment = this._loadedSegment;
            if (!segment || this._clipFromTrackStart) return false;
            const track = (this.manifest && this.manifest.tracks || [])
                .find(t => t.index === segment.trackIndex);
            // Already the whole track; there is nothing larger to try.
            if (!track || track.startSeconds >= segment.startSeconds) return false;
            this._retryingFromTrackStart = true;
            const done = () => { this._retryingFromTrackStart = false; };
            this._loadSegment(segment, this._loadedSeekSeconds, autoplay,
                { fromTrackStart: true }).then(done, done);
            return true;
        },

        onAudioError() {
            // An empty src is how teardown() clears the element; not an error.
            const audio = this.$refs.audio;
            if (!audio || !audio.getAttribute('src')) return;
            const code = audio.error && audio.error.code;
            // 4 is SRC_NOT_SUPPORTED: these BYTES, not this situation.
            if (code === 4 && this._retryFromTrackStart(this._autoplayAfterLoad)) return;
            this.error =
                `This browser could not play the recorded audio (${this._clipDetail(audio)}).`;
        },

        // Relative seeking, which is what the skip buttons and the arrow keys
        // both do. Keeps playing if it was playing; a seek is not a transport
        // change.
        seekBy(deltaSeconds) {
            if (!this.totalSeconds) return;
            const target = Math.min(this.totalSeconds,
                Math.max(0, this.currentSeconds + deltaSeconds));
            return this.playFrom(target, { autoplay: this.playing });
        },

        onStripKey(event) {
            const coarse = event.shiftKey ? COARSE_SKIP_SECONDS : SKIP_SECONDS;
            const handlers = {
                ArrowLeft: () => this.seekBy(-coarse),
                ArrowDown: () => this.seekBy(-coarse),
                ArrowRight: () => this.seekBy(coarse),
                ArrowUp: () => this.seekBy(coarse),
                PageDown: () => this.seekBy(-COARSE_SKIP_SECONDS),
                PageUp: () => this.seekBy(COARSE_SKIP_SECONDS),
                Home: () => this.playFrom(0, { autoplay: this.playing }),
                End: () => this.playFrom(this.totalSeconds, { autoplay: this.playing }),
                Enter: () => this.togglePlay(),
                ' ': () => this.togglePlay(),
            };
            const handler = handlers[event.key];
            if (!handler) return;
            // Only for keys this actually acts on: swallowing everything would
            // take Tab off the control the user just focused.
            event.preventDefault();
            handler();
        },

        onStripClick(event) {
            const strip = this.$refs.strip;
            if (!strip || !this.totalSeconds) return;
            const rect = strip.getBoundingClientRect();
            if (!rect.width) return;
            const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            const target = ratio * this.totalSeconds;
            // Deliberately NOT gated on covers(): a tap that lands in a hole
            // has to say so. Returning silently is indistinguishable from a
            // timeline that does not respond, and playFrom() already explains
            // which of the two it was.
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

/* It is focusable now, so it has to show that it is. */
.audioStrip:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
}

.audioStripTick {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: rgba(255, 255, 255, 0.55);
    pointer-events: none;
}

/* Labels sit under the strip, anchored at their tick. The first and last are
   nudged inside so neither runs off the edge at phone width. */
.audioStripScale {
    position: relative;
    height: 14px;
    width: 100%;
}
.audioStripScale span {
    position: absolute;
    transform: translateX(-50%);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
}
.audioStripScale span:first-child {
    transform: none;
}
.audioStripScale span:last-child {
    transform: translateX(-100%);
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
