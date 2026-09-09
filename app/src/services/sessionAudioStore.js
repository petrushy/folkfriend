// Durable storage for the audio recorded alongside a live session.
//
// A session can easily run three hours, which at the default 64 kbps is ~86 MB
// — twice the size of the tune index. Three things follow from that, and they
// are the whole design:
//
//  1. It is SEGMENTED. One 86 MB blob would have to be held in memory for the
//     whole evening, committed in a single transaction at exactly the moment
//     the user believes the recording is safe, and lost entirely to a crash.
//     Segments are written as they close, so at most the last partial one is
//     ever at risk and memory is bounded by one segment.
//
//  2. It is NEVER allowed to cost the user their tune index. Browsers evict per
//     ORIGIN, so an audio store that fills the quota takes the offline index
//     down with it — the plane incident, reintroduced from a new direction.
//     headroomBytes() keeps a hard reserve above the index, and the recorder
//     stops rather than spending it. Everything above that reserve is the
//     user's to spend; the reserve itself is not negotiable.
//
//  3. It is LOCAL-ONLY. Nothing here is synced, exported in a backup, or
//     touched by sync.js. Three hours of a pub records the conversations of
//     people who did not agree to it; that stays on the device that captured
//     it, and leaves only by an explicit share.
//
// The commit-marker discipline is the same as tuneIndexStore.js: the manifest
// is written LAST and names only segments that are already on disk, so an
// interrupted append reads as "one segment shorter", never as corruption. The
// cost is an orphan segment, which reclaimOrphans() sweeps up.

import { get, set, del, keys } from 'idb-keyval';

export const AUDIO_SCHEMA_VERSION = 1;

const MANIFEST_PREFIX = 'sessionAudio:';
const SEGMENT_PREFIX = 'sessionAudioSeg:';

// How much audio goes in one stored segment.
//
// Short segments cost more IndexedDB records; long ones cost more lost audio
// on a crash and — the reason this number is as low as it is — a bigger
// worst-case landing error when a browser refuses to seek inside a segment at
// all. MediaRecorder output carries no seek index (WebM has no Cues, Safari's
// fragmented MP4 has no top-level index), so seeking is best-effort. Three
// minutes bounds the damage if it fails: the ▶ on a tune lands at most that
// early rather than anywhere in a three-hour file.
export const SEGMENT_SECONDS = 180;

// How often MediaRecorder hands us a chunk. This is the granularity at which a
// clip can be cut, since a chunk is the smallest independently-appendable unit
// of the stream.
export const TIMESLICE_MS = 1000;

// Never let session audio push origin usage past this much free space. The
// tune index is ~35–45 MB and losing it is the failure the entire offline
// architecture exists to prevent, so the reserve covers a full re-download
// plus room for the app shell and the user's other data.
export const STORAGE_RESERVE_BYTES = 150 * 1024 * 1024;

// Bitrates offered in Settings. 64 is the default: below it a re-analysis of
// the recording (which is half the value of keeping it) starts to suffer, and
// above it three hours gets expensive fast.
export const BITRATE_CHOICES_KBPS = [32, 48, 64, 96, 128, 160];
export const DEFAULT_BITRATE_KBPS = 64;

// Preferred first, because an MP4/AAC file opens in every player app, in
// iOS Files and in Music. WebM/Opus plays fine inside the app but is awkward
// to hand to anything else — and iOS, the target platform, records MP4.
const MIME_CANDIDATES = [
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
];

export function manifestKey(sessionId) { return `${MANIFEST_PREFIX}${sessionId}`; }
export function segmentKey(sessionId, index) { return `${SEGMENT_PREFIX}${sessionId}:${index}`; }

// Which container this browser will actually record, or null if it will not
// record audio at all. Callers must treat null as "the feature is unavailable
// here", not as an error to report.
export function pickMimeType(Recorder = globalThis.MediaRecorder) {
    if (!Recorder) return null;
    if (typeof Recorder.isTypeSupported !== 'function') return '';
    for (const candidate of MIME_CANDIDATES) {
        if (Recorder.isTypeSupported(candidate)) return candidate;
    }
    // A MediaRecorder that supports none of the above may still record in its
    // own default container. Worth trying rather than refusing outright.
    return '';
}

export function fileExtensionFor(mimeType) {
    if (!mimeType) return 'bin';
    if (mimeType.includes('mp4')) return 'm4a';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('webm')) return 'webm';
    return 'bin';
}

export function bytesPerHour(kbps) { return (kbps * 1000 / 8) * 3600; }

export function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ---- reads ----------------------------------------------------------------
//
// Reads never throw, in the manner of tuneIndexStore: a failure resolves to
// null and the caller degrades to "no audio for this session", which is always
// a survivable answer.

export async function readManifest(sessionId) {
    if (!sessionId) return null;
    try {
        const manifest = await get(manifestKey(sessionId));
        if (!manifest || manifest.schema !== AUDIO_SCHEMA_VERSION) return null;
        if (!Array.isArray(manifest.segments) || !Array.isArray(manifest.tracks)) return null;
        return manifest;
    } catch (e) {
        console.warn('Could not read session audio manifest:', e && e.message);
        return null;
    }
}

export async function readSegment(sessionId, index) {
    try {
        return (await get(segmentKey(sessionId, index))) || null;
    } catch (e) {
        console.warn('Could not read session audio segment:', e && e.message);
        return null;
    }
}

export async function listManifests() {
    try {
        const all = await keys();
        const ids = all
            .filter(k => typeof k === 'string' && k.startsWith(MANIFEST_PREFIX))
            .map(k => k.slice(MANIFEST_PREFIX.length));
        const manifests = await Promise.all(ids.map(id => readManifest(id)));
        return manifests.filter(Boolean);
    } catch (e) {
        console.warn('Could not list session audio:', e && e.message);
        return [];
    }
}

export async function totalAudioBytes() {
    const manifests = await listManifests();
    return manifests.reduce((sum, m) => sum + (m.bytes || 0), 0);
}

// ---- quota ----------------------------------------------------------------

// Free bytes that session audio may use, i.e. what is left after the reserve.
// Negative means the reserve is already breached. `null` means the browser will
// not say — older Safari has no estimate(), and there the only signal available
// is a QuotaExceededError on the write itself, which the recorder handles.
export async function headroomBytes() {
    if (!(typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate)) {
        return null;
    }
    try {
        const { usage, quota } = await navigator.storage.estimate();
        if (!quota) return null;
        return (quota - (usage || 0)) - STORAGE_RESERVE_BYTES;
    } catch (e) {
        return null;
    }
}

// ---- writes ---------------------------------------------------------------
//
// Serialised per session. Only the recorder appends, but a delete can arrive
// from the UI at any moment and read-modify-write of the manifest is not atomic
// against IndexedDB.

const chains = new Map();

function withSession(sessionId, fn) {
    const previous = chains.get(sessionId) || Promise.resolve();
    const next = previous.then(fn, fn);
    chains.set(sessionId, next.catch(() => {}));
    return next;
}

export function createManifest({ sessionId, mimeType, bitsPerSecond }) {
    return {
        schema: AUDIO_SCHEMA_VERSION,
        sessionId,
        mimeType: mimeType || '',
        bitsPerSecond: bitsPerSecond || 0,
        timesliceMs: TIMESLICE_MS,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tracks: [],
        segments: [],
        totalSeconds: 0,
        bytes: 0,
        // Set when recording ended for a reason the user needs to know about —
        // storage exhausted, the encoder failing. A player that silently runs
        // out of audio partway through an evening is indistinguishable from a
        // bug, so the manifest carries the explanation with the data.
        stopped: null,
    };
}

// Appends one segment: the payload first, then the manifest that names it.
//
// That order is the whole safety property, and it is the same one the tune
// index store lives by. If the process dies between the two writes the segment
// is an orphan — wasted space, reclaimed later — whereas the reverse ordering
// leaves a manifest pointing at audio that does not exist, which presents to
// the user as a player that breaks partway through.
export async function appendSegment(sessionId, segment, trackPatch = null) {
    return withSession(sessionId, async () => {
        const manifest = (await get(manifestKey(sessionId))) || null;
        if (!manifest) throw new Error('no manifest for this session');

        await set(segmentKey(sessionId, segment.index), {
            sessionId,
            index: segment.index,
            trackIndex: segment.trackIndex,
            startSeconds: segment.startSeconds,
            durationSeconds: segment.durationSeconds,
            bytes: segment.bytes,
            chunks: segment.chunks,
            blob: segment.blob,
        });

        const next = {
            ...manifest,
            updatedAt: Date.now(),
            tracks: trackPatch ? mergeTrack(manifest.tracks, trackPatch) : manifest.tracks,
            segments: [...manifest.segments, {
                index: segment.index,
                trackIndex: segment.trackIndex,
                startSeconds: segment.startSeconds,
                durationSeconds: segment.durationSeconds,
                bytes: segment.bytes,
            }],
            totalSeconds: Math.max(manifest.totalSeconds,
                segment.startSeconds + segment.durationSeconds),
            bytes: (manifest.bytes || 0) + (segment.bytes || 0),
        };
        await set(manifestKey(sessionId), next);
        return next;
    });
}

function mergeTrack(tracks, patch) {
    const existing = tracks.findIndex(t => t.index === patch.index);
    if (existing === -1) return [...tracks, patch];
    const copy = tracks.slice();
    copy[existing] = { ...copy[existing], ...patch };
    return copy;
}

export async function putManifest(sessionId, manifest) {
    return withSession(sessionId, async () => {
        await set(manifestKey(sessionId), { ...manifest, updatedAt: Date.now() });
        return manifest;
    });
}

export async function patchManifest(sessionId, patch) {
    return withSession(sessionId, async () => {
        const manifest = (await get(manifestKey(sessionId))) || null;
        if (!manifest) return null;
        const next = { ...manifest, ...patch, updatedAt: Date.now() };
        await set(manifestKey(sessionId), next);
        return next;
    });
}

// Deletes the manifest FIRST, so nothing can reference a segment that is on its
// way out. An interrupted delete therefore leaves orphan segments rather than a
// half-playable session — space that reclaimOrphans() gets back, against a
// broken player that the user cannot fix.
export async function deleteSessionAudio(sessionId) {
    if (!sessionId) return;
    return withSession(sessionId, async () => {
        const manifest = (await get(manifestKey(sessionId))) || null;
        try { await del(manifestKey(sessionId)); } catch (e) { /* fall through */ }
        const indices = manifest && Array.isArray(manifest.segments)
            ? manifest.segments.map(s => s.index)
            : [];
        for (const index of indices) {
            try { await del(segmentKey(sessionId, index)); } catch (e) { /* best effort */ }
        }
        chains.delete(sessionId);
    });
}

// Deletes segment records no manifest claims: what an interrupted append or an
// interrupted delete leaves behind. Cheap enough to run whenever the session
// list is opened.
export async function reclaimOrphans() {
    let all;
    try { all = await keys(); } catch (e) { return 0; }

    const claimed = new Set();
    const manifests = await listManifests();
    for (const manifest of manifests) {
        for (const segment of manifest.segments) {
            claimed.add(segmentKey(manifest.sessionId, segment.index));
        }
    }

    let reclaimed = 0;
    for (const key of all) {
        if (typeof key !== 'string' || !key.startsWith(SEGMENT_PREFIX)) continue;
        if (claimed.has(key)) continue;
        try { await del(key); reclaimed++; } catch (e) { /* best effort */ }
    }
    return reclaimed;
}

// Audio belonging to sessions that no longer exist. Deleting a session deletes
// its audio directly; this covers the paths that cannot (a session removed by a
// sync deletion from another device, or by a failed delete).
export async function reclaimAudioForMissingSessions(existingSessionIDs) {
    const alive = new Set((existingSessionIDs || []).map(String));
    const manifests = await listManifests();
    let reclaimed = 0;
    for (const manifest of manifests) {
        if (alive.has(String(manifest.sessionId))) continue;
        await deleteSessionAudio(manifest.sessionId);
        reclaimed++;
    }
    return reclaimed;
}

// ---- clip assembly --------------------------------------------------------

// The chunks of a stored segment, with the end time each one runs to.
function chunkSpans(segment) {
    const spans = [];
    let offset = 0;
    for (let i = 0; i < segment.chunks.length; i++) {
        const chunk = segment.chunks[i];
        const next = segment.chunks[i + 1];
        const end = next
            ? next.startSeconds
            : segment.startSeconds + segment.durationSeconds;
        spans.push({
            startSeconds: chunk.startSeconds,
            endSeconds: end,
            from: offset,
            to: offset + chunk.bytes,
            init: !!chunk.init,
        });
        offset += chunk.bytes;
    }
    return spans;
}

/**
 * Builds a playable Blob covering [fromSeconds, toSeconds) of a session's audio.
 *
 * A clip is the track's init chunk followed by the stream chunks that overlap
 * the range — which is exactly the byte sequence MediaRecorder would have
 * produced had it been asked for that stretch, so no decoding or re-encoding is
 * involved and Blob.slice keeps it lazy.
 *
 * A clip never crosses a TRACK boundary. Each track is a separate MediaRecorder
 * run (the session was paused, or the microphone was reacquired) with its own
 * init chunk, and two such streams cannot be concatenated into one file. A
 * range that spans a boundary is clipped to the first track it meets.
 *
 * Returns null when nothing overlaps, otherwise
 * `{ blob, mimeType, startSeconds, endSeconds, trackIndex }` where
 * startSeconds is the session-audio time the returned blob actually begins at
 * — never later than requested, and possibly earlier, because a cut can only
 * land on a chunk boundary.
 */
export async function buildClip(sessionId, fromSeconds, toSeconds, manifestIn = null) {
    const manifest = manifestIn || await readManifest(sessionId);
    if (!manifest) return null;

    const overlapping = manifest.segments
        .filter(s => s.startSeconds + s.durationSeconds > fromSeconds && s.startSeconds < toSeconds)
        .sort((a, b) => a.index - b.index);
    if (!overlapping.length) return null;

    const trackIndex = overlapping[0].trackIndex;
    const track = manifest.tracks.find(t => t.index === trackIndex);
    if (!track) return null;

    const parts = [];
    let clipStart = null;
    let clipEnd = null;

    for (const meta of overlapping) {
        if (meta.trackIndex !== trackIndex) break;   // never cross a track
        const segment = await readSegment(sessionId, meta.index);
        // A segment the manifest names but that is not on disk means an
        // interrupted delete. Stop here rather than splicing a hole into the
        // middle of a clip, which would play as a glitch or not at all.
        if (!segment || !segment.blob) break;

        const spans = chunkSpans(segment);
        const wanted = spans.filter(s => s.endSeconds > fromSeconds && s.startSeconds < toSeconds);
        if (!wanted.length) continue;

        // The track's first chunk carries the container header AND its first
        // second of audio, so it is stored in the segment like any other chunk.
        // Prepending the init blob to a clip that already begins there would
        // write the header twice, which is not a file any decoder will accept.
        if (clipStart === null && !wanted[0].init && track.init) parts.push(track.init);

        parts.push(segment.blob.slice(wanted[0].from, wanted[wanted.length - 1].to));
        if (clipStart === null) clipStart = wanted[0].startSeconds;
        clipEnd = wanted[wanted.length - 1].endSeconds;
    }

    if (clipStart === null) return null;
    // The TRACK's own container, not the session's. A session resumed onto a
    // browser that fell back to a different encoder has tracks that genuinely
    // differ, and a clip never spans one — so the track is the only level at
    // which "what format is this" has a single answer.
    const mimeType = track.mimeType || manifest.mimeType || '';
    return {
        blob: new Blob(parts, { type: mimeType || 'application/octet-stream' }),
        mimeType,
        startSeconds: clipStart,
        endSeconds: clipEnd,
        trackIndex,
    };
}

// The whole of one continuous recording stretch, as a single file. Whole-session
// export is one file per track for the reason given on buildClip().
export function trackRanges(manifest) {
    if (!manifest) return [];
    return manifest.tracks.map(track => ({
        index: track.index,
        startSeconds: track.startSeconds,
        endSeconds: track.startSeconds + track.durationSeconds,
        durationSeconds: track.durationSeconds,
    })).filter(t => t.durationSeconds > 0).sort((a, b) => a.startSeconds - b.startSeconds);
}
