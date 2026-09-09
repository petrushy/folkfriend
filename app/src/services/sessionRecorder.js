// Records the session audio in parallel with detection.
//
// MediaRecorder is attached to the same MediaStream the analysis pipeline is
// reading, so recording is genuinely parallel: the ScriptProcessor path in
// mic.js is untouched, and encoding costs effectively nothing because the
// platform does it in hardware.
//
// The unit of recording is a TRACK: one continuous MediaRecorder run. A session
// has one per listening stretch — a Pause ends one, a Resume starts the next,
// and so does a microphone that had to be reacquired after the OS handed it to
// another app. Two tracks cannot be concatenated into one file (each carries
// its own container header), which is why a clip never spans them.
//
// Within a track, chunks arrive every TIMESLICE_MS and are grouped into
// segments that are written as they close. See sessionAudioStore.js for why.
//
// ---- the audio clock -------------------------------------------------------
//
// `audioSeconds` is the position in the recording, and it is what detections
// are stamped with. It deliberately does NOT come from liveAnalysis's
// elapsedSeconds, which is a setInterval tick: that drifts (it is throttled
// whenever the tab is occluded, and the error accumulates over three hours),
// and it keeps counting through a microphone outage during which no audio was
// recorded at all — so every marker after the outage would be shifted.
//
// This clock instead advances only while a track is actually recording, and is
// measured as a single subtraction from that track's origin rather than by
// accumulating ticks. So it agrees with the recording by construction: time the
// recorder did not capture is time the clock did not count.

import micService from './mic.js';
import eventBus from '@/eventBus.js';
import {
    SEGMENT_SECONDS,
    TIMESLICE_MS,
    DEFAULT_BITRATE_KBPS,
    pickMimeType,
    createManifest,
    putManifest,
    patchManifest,
    appendSegment,
    readManifest,
    deleteSessionAudio,
    headroomBytes,
} from './sessionAudioStore.js';

// The earliest position at which new audio may safely begin.
//
// NOT simply manifest.totalSeconds. When a segment cannot be stored the clock
// steps past it deliberately, so the recording has a hole — and detections were
// stamped with timestamps INSIDE that hole. Restarting at the end of the last
// saved segment would hand those timestamps to audio recorded afterwards, and
// every tune from the lost interval would play something unrelated.
//
// `clockFloor` is the durable record of that, and it only ever increases. The
// `stopped` marker cannot serve: it is cleared on the next resume so recording
// can be retried, and a second reload would then lose the hole entirely.
function storedClockFloor(manifest) {
    if (!manifest) return 0;
    return Math.max(
        manifest.totalSeconds || 0,
        manifest.clockFloor || 0,
        (manifest.stopped && manifest.stopped.atSeconds) || 0,
    );
}

function now() {
    return (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
}

class SessionRecorder {
    constructor() {
        this.sessionId = null;
        this.mimeType = null;
        this.bitsPerSecond = 0;
        this.isRecording = false;
        // Why recording ended early, when it did: 'storage' | 'encoder' |
        // 'unsupported'. Surfaced in the session bar and stored in the
        // manifest, because a recording that quietly stops halfway through an
        // evening is indistinguishable from a bug.
        this.stoppedReason = null;
        this.error = '';

        this._recorder = null;
        this._streamGeneration = -1;
        this._transition = null;

        // Audio time (seconds) already committed by finished tracks.
        this._committedSeconds = 0;
        // Audio time at the end of the last chunk received, i.e. where the next
        // chunk starts.
        this._chunkCursorSeconds = 0;
        this._trackStartedPerf = 0;
        this._trackIndex = 0;
        this._trackStartSeconds = 0;
        // Which track the currently wired ondataavailable belongs to, so a
        // chunk arriving from a recorder we have already replaced cannot be
        // filed against the new one.
        this._trackIndexActive = -1;

        this._segmentIndex = 0;
        this._pending = [];          // chunks awaiting a segment write
        this._pendingBytes = 0;
        this._pendingStartSeconds = 0;
        this._initBlob = null;

        this.bytes = 0;
        this._writeChain = Promise.resolve();
        // What the manifest currently claims, so _recordActualFormat() writes
        // only when the encoder actually disagreed with the request.
        this._manifestMimeType = null;
        this._manifestBitsPerSecond = 0;

        // Stretches of the recording the user silenced, in audio-clock
        // seconds. The last entry has `to: null` while a mute is still open.
        // Stored so the player can show them: seeking to a tune and getting
        // silence with no explanation is indistinguishable from a bug.
        this.mutedRanges = [];
    }

    // ---- mute --------------------------------------------------------------
    //
    // Silences what is RECORDED while leaving capture — and therefore tune
    // detection — running. See micService's recording branch for how.

    get muteSupported() { return micService.recordingMuteSupported; }

    get muted() { return micService.recordingMuted; }

    // Audio-clock seconds spent muted so far, so the UI can show how long a
    // mute has been running. A mute the user forgot about is the failure mode
    // of a manual control, and the only defence is making it visible.
    get mutedSeconds() {
        const now = this.audioSeconds || 0;
        return this.mutedRanges.reduce(
            (total, range) => total + (Math.min(range.to ?? now, now) - range.from), 0);
    }

    // Returns the state actually reached: false on a browser that cannot clone
    // the capture track, where the control is unavailable and the caller must
    // say so rather than appear to have muted.
    setMuted(muted) {
        if (!this.sessionId || !this.muteSupported) return false;
        const applied = micService.setRecordingMuted(muted);
        this._markMuteRange(applied);
        this._emit();
        return applied;
    }

    _markMuteRange(muted) {
        const at = this.audioSeconds || 0;
        const open = this.mutedRanges[this.mutedRanges.length - 1];
        if (muted) {
            if (open && open.to === null) return;   // already open
            this.mutedRanges.push({ from: at, to: null });
        } else if (open && open.to === null) {
            open.to = Math.max(at, open.from);
        }
        this._persistMuteRanges();
    }

    // Closes a mute that is still open, at the end of the recorded audio.
    // Without this a session finished while muted stores an open-ended range,
    // and the player would grey out everything after it for ever.
    _closeOpenMuteRange() {
        const open = this.mutedRanges[this.mutedRanges.length - 1];
        if (!open || open.to !== null) return;
        open.to = Math.max(this._chunkCursorSeconds, open.from);
        this._persistMuteRanges();
    }

    _persistMuteRanges() {
        if (!this.sessionId) return;
        patchManifest(this.sessionId, { mutedRanges: this.mutedRanges.map(r => ({ ...r })) })
            .catch(e => console.warn('Could not record muted ranges:', e && e.message));
    }

    // Whether this browser can record at all. Null mime means no MediaRecorder;
    // the feature then reports itself unavailable rather than failing later.
    get available() {
        return pickMimeType() !== null;
    }

    get isActive() { return !!this.sessionId; }

    // Position in the recording, in seconds. Null when nothing is being
    // recorded — which is what stops liveAnalysis stamping detections with a
    // clock that is not advancing.
    get audioSeconds() {
        if (!this.sessionId) return null;
        if (!this.isRecording) return this._chunkCursorSeconds;
        return this._committedSeconds + (now() - this._trackStartedPerf) / 1000;
    }

    _emit() {
        eventBus.$emit('sessionAudioState', {
            sessionId: this.sessionId,
            active: this.isActive,
            recording: this.isRecording,
            seconds: this.audioSeconds || 0,
            bytes: this.bytes,
            stoppedReason: this.stoppedReason,
            error: this.error,
            muted: this.muted,
            muteSupported: this.muteSupported,
            mutedSeconds: this.mutedSeconds,
        });
    }

    // ---- session lifecycle -------------------------------------------------

    // Opens the audio side of a session. Never throws: recording is the
    // expendable half of a session, and a browser that cannot encode, or a disk
    // with no room, must not stop the user logging their tunes.
    async begin(sessionId, { bitrateKbps = DEFAULT_BITRATE_KBPS } = {}) {
        if (!sessionId) return false;
        if (this.sessionId === sessionId) return true;
        await this.end();

        const mimeType = pickMimeType();
        if (mimeType === null) {
            this.stoppedReason = 'unsupported';
            this.error = 'This browser cannot record audio.';
            this._emit();
            return false;
        }

        this.sessionId = sessionId;
        this.mimeType = mimeType;
        this.bitsPerSecond = Math.round(bitrateKbps * 1000);
        this.stoppedReason = null;
        this.error = '';
        this._committedSeconds = 0;
        this._chunkCursorSeconds = 0;
        this._trackIndex = 0;
        this._segmentIndex = 0;
        this.bytes = 0;
        this.mutedRanges = [];
        // A NEW session starts recording. Carrying a mute over from the
        // previous one would silently lose an evening's audio to a button
        // pressed hours earlier — and unlike the resume case below, nothing on
        // screen would connect the two.
        micService.setRecordingMuted(false);
        this._resetPending();

        // Refuse before spending anything if there is no room. Starting and
        // dying two minutes later wastes the writes and tells the user less.
        const headroom = await headroomBytes();
        if (headroom !== null && headroom <= 0) {
            this.sessionId = null;
            this.stoppedReason = 'storage';
            this.error = 'Not enough free storage to record audio.';
            this._emit();
            return false;
        }

        try {
            await putManifest(sessionId, createManifest({
                sessionId,
                mimeType,
                bitsPerSecond: this.bitsPerSecond,
            }));
            this._manifestMimeType = mimeType;
            this._manifestBitsPerSecond = this.bitsPerSecond;
        } catch (e) {
            this.sessionId = null;
            this.stoppedReason = 'storage';
            this.error = `Could not start recording: ${(e && e.message) || e}`;
            this._emit();
            return false;
        }

        this._emit();
        return true;
    }

    // Picks an existing session's audio back up after a reload or a Resume, so
    // the clock continues from where the stored audio ends rather than
    // restarting at zero and overwriting it.
    async resume(sessionId, { bitrateKbps = DEFAULT_BITRATE_KBPS } = {}) {
        if (!sessionId) return false;
        // Already ours — an ordinary Pause → Resume, where stop() left the
        // session open. Still clear a storage stop: the user has had a chance
        // to free space, and leaving it latched means ensureRecording() refuses
        // for the rest of the session with nothing on screen explaining why.
        // The reset below is not reached on this path, which is what made the
        // ordinary pause/resume case behave differently from a reload.
        if (this.sessionId === sessionId) {
            // Belt and braces against the clock having been left behind by any
            // path that ended a track without committing it. Reading what is
            // actually stored is the only authority on where new audio may
            // safely begin: anything earlier overwrites the timeline of
            // segments that already exist.
            await this._adoptStoredClock(sessionId);
            this._clearStorageStop();
            return true;
        }

        const manifest = await readManifest(sessionId);
        if (!manifest) return this.begin(sessionId, { bitrateKbps });

        const mimeType = pickMimeType();
        if (mimeType === null) return false;

        this.sessionId = sessionId;
        // Keep recording in the container the existing tracks are in. A session
        // whose segments were half MP4 and half WebM could not be exported as
        // anything.
        this.mimeType = manifest.mimeType || mimeType;
        this._manifestMimeType = manifest.mimeType || null;
        this._manifestBitsPerSecond = manifest.bitsPerSecond || 0;
        this.bitsPerSecond = Math.round(bitrateKbps * 1000);
        // A new listening stretch gets a fresh chance, even after a stop for
        // storage: the user may well have deleted something in between, and the
        // per-write headroom check will stop it again within a segment if not.
        // Leaving it latched would mean a session that once ran out of space
        // could never record again, with nothing on screen explaining why.
        this.stoppedReason = null;
        this.error = '';
        if (manifest.stopped) {
            patchManifest(sessionId, { stopped: null })
                .catch(e => console.warn('Could not clear audio stop marker:', e && e.message));
        }
        this._committedSeconds = storedClockFloor(manifest);
        this._chunkCursorSeconds = this._committedSeconds;
        this._trackIndex = manifest.tracks.reduce((max, t) => Math.max(max, t.index + 1), 0);
        this._segmentIndex = manifest.segments.reduce((max, s) => Math.max(max, s.index + 1), 0);
        this.bytes = manifest.bytes || 0;
        this.mutedRanges = Array.isArray(manifest.mutedRanges)
            ? manifest.mutedRanges.map(r => ({ ...r }))
            : [];
        this._resetPending();

        // A session that was muted when the app was closed comes back MUTED.
        // The two errors are not symmetric: resuming un-muted records a
        // conversation the user believes is private and cannot be undone,
        // while resuming muted loses audio the user can see is being lost —
        // the bar says so, with the elapsed muted time.
        const open = this.mutedRanges[this.mutedRanges.length - 1];
        micService.setRecordingMuted(!!(open && open.to === null));

        this._emit();
        return true;
    }

    // Never lets the clock sit behind what is on disk.
    async _adoptStoredClock(sessionId) {
        const manifest = await readManifest(sessionId);
        const safe = Math.max(
            this._committedSeconds, this._chunkCursorSeconds, storedClockFloor(manifest));
        this._committedSeconds = safe;
        this._chunkCursorSeconds = safe;
    }

    // Gives a recording that ran out of space another go. Only 'storage' is
    // cleared: 'unsupported' and 'encoder' say something about the browser, not
    // about a condition the user can change between two taps.
    _clearStorageStop() {
        if (this.stoppedReason !== 'storage') return;
        this.stoppedReason = null;
        this.error = '';
        const sessionId = this.sessionId;
        if (sessionId) {
            // `stopped` only. clockFloor records where the recording actually
            // reached and must survive every retry.
            patchManifest(sessionId, { stopped: null })
                .catch(e => console.warn('Could not clear audio stop marker:', e && e.message));
        }
        this._emit();
    }

    // Stops recording, keeping everything written so far. This is Pause: the
    // session stays open and a later ensureRecording() opens a fresh track.
    async stop() {
        await this._stopTrack();
        this._emit();
    }

    // Closes the audio side of the session entirely.
    async end() {
        if (!this.sessionId) return;
        await this._stopTrack();
        this._closeOpenMuteRange();
        await this._writeChain.catch(() => {});
        this.sessionId = null;
        this.mimeType = null;
        this.stoppedReason = null;
        this.error = '';
        this.bytes = 0;
        this.mutedRanges = [];
        micService.setRecordingMuted(false);
        this._emit();
    }

    // Tears the recording down and deletes it. For a session the user has
    // deleted: keeping its audio would be both a privacy failure and the
    // largest single thing in storage with nothing referencing it.
    async discard(sessionId = this.sessionId) {
        if (!sessionId) return;
        if (this.sessionId === sessionId) await this.end();
        await deleteSessionAudio(sessionId);
    }

    // ---- track lifecycle ---------------------------------------------------

    // Called once per analysis cycle, next to micService.ensureMicHealthy().
    // Starts a track when there is none, and replaces one whose stream has been
    // rebuilt underneath it — a microphone reacquired after the OS took it
    // leaves the old MediaRecorder attached to a dead stream, silently
    // recording nothing for the rest of the evening.
    ensureRecording() {
        if (!this.sessionId || this.stoppedReason) return Promise.resolve(false);
        if (this._transition) return this._transition;

        const stream = micService.recordingStream;
        if (!stream) return Promise.resolve(false);

        const healthy = this._recorder &&
            this._recorder.state === 'recording' &&
            this._streamGeneration === micService.streamGeneration;
        if (healthy) return Promise.resolve(true);

        this._transition = (async () => {
            await this._stopTrack();
            return this._startTrack(stream);
        })().finally(() => { this._transition = null; });
        return this._transition;
    }

    async _startTrack(stream) {
        const Recorder = globalThis.MediaRecorder;
        if (!Recorder || !stream) return false;

        const trackIndex = this._trackIndex++;
        this._trackStartSeconds = this._committedSeconds;
        this._chunkCursorSeconds = this._committedSeconds;
        this._trackStartedPerf = now();
        this._initBlob = null;
        this._resetPending();

        try {
            const options = { mimeType: this.mimeType || undefined };
            if (this.bitsPerSecond) options.audioBitsPerSecond = this.bitsPerSecond;
            this._recorder = new Recorder(stream, options);
        } catch (e) {
            // A mimeType the browser advertised but will not instantiate.
            // Falling back to its default container is better than no recording.
            try {
                this._recorder = new Recorder(stream);
                this.mimeType = this._recorder.mimeType || this.mimeType;
            } catch (e2) {
                this._fail('encoder', `Could not start recording: ${(e2 && e2.message) || e2}`);
                return false;
            }
        }

        // What the encoder settled on, which is not necessarily what was asked
        // for — same rule as micService.appliedAudioSettings. Recorded so the
        // Settings readout can show the truth rather than the request.
        if (this._recorder.audioBitsPerSecond) {
            this.bitsPerSecond = this._recorder.audioBitsPerSecond;
        }
        if (this._recorder.mimeType) this.mimeType = this._recorder.mimeType;
        // What was ASKED for and what the encoder does are different things,
        // and the manifest is what the export and the player read. Left
        // unpatched, a fallback to the browser's own container writes WebM
        // bytes that get exported as .m4a and handed to a decoder as MP4 —
        // which fails in a way that looks like corrupt audio rather than a
        // mislabelled file.
        this._recordActualFormat();

        this._recorder.ondataavailable = (event) => this._onChunk(event, trackIndex);
        this._recorder.onerror = (event) => {
            const message = (event && event.error && event.error.message) || 'recording error';
            this._fail('encoder', message);
        };

        try {
            this._recorder.start(TIMESLICE_MS);
        } catch (e) {
            this._recorder = null;
            this._fail('encoder', `Could not start recording: ${(e && e.message) || e}`);
            return false;
        }

        this._streamGeneration = micService.streamGeneration;
        this._trackIndexActive = trackIndex;
        this.isRecording = true;
        this._emit();
        return true;
    }

    // The format is recorded PER TRACK, and the session-level one is only ever
    // the first track's.
    //
    // A resumed session asks for the container its existing segments are in,
    // but the encoder can still hand back a different one — a fallback after a
    // failed construction, or simply a browser that reports its own. Rewriting
    // the session-level mimeType then relabels segments that are genuinely MP4
    // as WebM, and the export hands a decoder bytes that are neither. Tracks
    // are already the unit a clip never spans, so labelling them individually
    // is both correct and free: buildClip() prefers the track's own format.
    _recordActualFormat() {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        if (this.mimeType === this._manifestMimeType &&
            this.bitsPerSecond === this._manifestBitsPerSecond) return;
        this._manifestMimeType = this.mimeType;
        this._manifestBitsPerSecond = this.bitsPerSecond;

        // Nothing is stored yet, so this track's format IS the session's.
        // Otherwise the session keeps the container its existing audio is in
        // and only this track carries the difference (see _flushPending).
        if (this._segmentIndex !== 0) return;
        patchManifest(sessionId, {
            mimeType: this.mimeType,
            bitsPerSecond: this.bitsPerSecond,
        }).catch(e => console.warn('Could not record audio format:', e && e.message));
    }

    async _stopTrack() {
        const recorder = this._recorder;
        this._recorder = null;
        this.isRecording = false;
        if (!recorder) {
            this._flushPending(true);
            this._trackIndexActive = -1;
            return;
        }

        // The final ondataavailable lands during stop(), so wait for the
        // recorder to actually finish before flushing — otherwise the tail of
        // the track is dropped, which is the audio for whatever tune was
        // playing when the user hit Pause.
        await new Promise(resolve => {
            let settled = false;
            const done = () => { if (!settled) { settled = true; resolve(); } };
            recorder.onstop = done;
            try {
                if (recorder.state !== 'inactive') recorder.stop();
                else done();
            } catch (e) { done(); }
            // A recorder that never fires onstop must not hang a Pause.
            setTimeout(done, 2000);
        });

        // Deliberately not awaited. Pause is a direct response to a tap and
        // must not be held up by a segment write; end() awaits _writeChain when
        // the session is actually being closed. The clock below is safe either
        // way — _flushPending captures its chunks synchronously.
        this._flushPending(true);
        this._committedSeconds = this._chunkCursorSeconds;
        this._trackIndexActive = -1;
    }

    _resetPending() {
        this._pending = [];
        this._pendingBytes = 0;
        this._pendingStartSeconds = this._chunkCursorSeconds;
    }

    _onChunk(event, trackIndex) {
        const blob = event && event.data;
        if (!blob || !blob.size) return;
        if (trackIndex !== this._trackIndexActive) return;   // a stale track

        const startSeconds = this._chunkCursorSeconds;
        const endSeconds = this._committedSeconds + (now() - this._trackStartedPerf) / 1000;
        this._chunkCursorSeconds = Math.max(endSeconds, startSeconds);

        const isInit = this._initBlob === null;
        if (isInit) this._initBlob = blob;

        if (!this._pending.length) this._pendingStartSeconds = startSeconds;
        this._pending.push({ blob, startSeconds, bytes: blob.size, init: isInit });
        this._pendingBytes += blob.size;

        const span = this._chunkCursorSeconds - this._pendingStartSeconds;
        if (span >= SEGMENT_SECONDS) this._flushPending(false);
    }

    // Writes the accumulated chunks as one segment. Serialised on _writeChain so
    // a flush triggered by a full segment and one triggered by Pause cannot
    // interleave and store segments out of order.
    _flushPending(final) {
        if (!this._pending.length || !this.sessionId) {
            if (final) this._resetPending();
            return this._writeChain;
        }

        const chunks = this._pending;
        const bytes = this._pendingBytes;
        const startSeconds = this._pendingStartSeconds;
        const endSeconds = this._chunkCursorSeconds;
        const index = this._segmentIndex++;
        const trackIndex = this._trackIndexActive;
        const sessionId = this.sessionId;
        const initBlob = this._initBlob;
        const trackStartSeconds = this._trackStartSeconds;
        const trackMimeType = this.mimeType;
        const trackBitsPerSecond = this.bitsPerSecond;
        this._resetPending();

        this._writeChain = this._writeChain.then(async () => {
            if (this.sessionId !== sessionId || this.stoppedReason) return;

            // Checked before every write, not only at the start: a three-hour
            // recording spends its budget gradually, and the point at which it
            // runs out is exactly the point where it must stop cleanly rather
            // than start throwing.
            const headroom = await headroomBytes();
            if (headroom !== null && headroom < bytes) {
                this._fail('storage', 'Ran out of free storage — audio recording stopped.');
                return;
            }

            try {
                const manifest = await appendSegment(sessionId, {
                    index,
                    trackIndex,
                    startSeconds,
                    durationSeconds: Math.max(0, endSeconds - startSeconds),
                    bytes,
                    chunks: chunks.map(c => ({
                        startSeconds: c.startSeconds,
                        bytes: c.bytes,
                        ...(c.init ? { init: true } : {}),
                    })),
                    blob: new Blob(chunks.map(c => c.blob), { type: trackMimeType || '' }),
                }, {
                    index: trackIndex,
                    startSeconds: trackStartSeconds,
                    durationSeconds: Math.max(0, endSeconds - trackStartSeconds),
                    init: initBlob,
                    // What this track's bytes actually are, which need not match
                    // the session's other tracks. See _recordActualFormat().
                    mimeType: trackMimeType,
                    bitsPerSecond: trackBitsPerSecond,
                });
                this.bytes = manifest.bytes;
                this._emit();
            } catch (e) {
                const message = (e && e.message) || String(e);
                const quota = /quota/i.test(message) || (e && e.name === 'QuotaExceededError');
                this._fail(quota ? 'storage' : 'encoder',
                    quota
                        ? 'Ran out of free storage — audio recording stopped.'
                        : `Could not save audio: ${message}`);
            }
        });

        return this._writeChain;
    }

    // Ends recording for this session while leaving everything already written
    // exactly as it is, and records WHY in the manifest so the player can say
    // "audio recorded for the first 1 h 47 m" rather than appearing to lose it.
    //
    // The session itself is untouched. Audio is the expendable half: a full
    // disk must cost the user their recording, never their tune list.
    _fail(reason, message) {
        if (this.stoppedReason) return;
        this.stoppedReason = reason;
        this.error = message;
        this.isRecording = false;

        const recorder = this._recorder;
        this._recorder = null;
        if (recorder) {
            try { if (recorder.state !== 'inactive') recorder.stop(); } catch (e) { /* ignore */ }
        }

        // Commit the clock, exactly as _stopTrack() does. This path ends a
        // track without going through it, and skipping this rewinds the clock:
        // the next track would start at the position the FAILED one did, laying
        // new audio over segments already written at those offsets. Two
        // segments then claim the same seconds, and every detection after the
        // failure seeks into the wrong one.
        this._committedSeconds = this._chunkCursorSeconds;
        this._trackIndexActive = -1;

        const sessionId = this.sessionId;
        const atSeconds = this._chunkCursorSeconds;
        if (sessionId) {
            // clockFloor alongside the stop marker, because the marker is
            // cleared on the next resume and this must outlive it — see
            // storedClockFloor().
            patchManifest(sessionId, {
                stopped: { reason, message, atSeconds },
                clockFloor: atSeconds,
            }).catch(e => console.warn('Could not record audio stop reason:', e && e.message));
        }
        console.warn(`Session audio stopped (${reason}): ${message}`);
        this._emit();
    }
}

const sessionRecorder = new SessionRecorder();
export default sessionRecorder;
