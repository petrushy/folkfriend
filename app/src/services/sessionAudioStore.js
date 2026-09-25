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
//  3. It is LOCAL-FIRST. Dropbox backup is a separate, explicit opt-in.
//     Recording never waits for cloud storage; sync.js never handles audio.
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

// The container part of a media type, without its codecs parameter.
export function containerOf(mimeType) {
    return String(mimeType || '').split(';')[0].trim().toLowerCase();
}

// What a MediaRecorder says it is recording, when that can be believed.
//
// Reported from the field: playback failing with "format not supported,
// audio/mp3;codecs=mp4a.40.2". That type cannot exist — mp4a.40.2 is AAC in
// MP4, and no MediaRecorder anywhere encodes MP3 — but `_startTrack` adopted
// `recorder.mimeType` unchecked, so it went into the manifest, onto every blob
// built from that track, and into the exported filename. A Blob whose declared
// type contradicts its bytes is refused outright by the decoder, which is the
// error the user saw.
//
// The test is only whether the CONTAINER is one a MediaRecorder could be
// producing. Deliberately not `isTypeSupported(reported)`: that is conservative
// in several browsers, and a fallback to a container it will not advertise is
// exactly the case `_recordActualFormat` exists for — rejecting those would
// trade this bug for the one it fixed. The bytes settle anything this misses,
// at `buildClip`.
const RECORDABLE_CONTAINERS = [
    'audio/mp4', 'video/mp4',
    'audio/webm', 'video/webm',
    'audio/ogg', 'video/ogg',
    // Chromium reports this for what is, to a demuxer, WebM.
    'audio/x-matroska', 'video/x-matroska',
];

export function plausibleRecordedMimeType(reported, requested) {
    if (!reported) return requested || '';
    if (containerOf(reported) === containerOf(requested)) return reported;
    return RECORDABLE_CONTAINERS.includes(containerOf(reported))
        ? reported
        : (requested || '');
}

// The top-level boxes a clip BEGINS with, as a short string for a failure
// message — 'ftyp+moov', 'ftyp+mdat', 'webm'.
//
// The one question worth answering on a device with no console: is there an
// initialisation segment in this clip at all. `ftyp+moov` says the header cut
// found what it was looking for; `ftyp+mdat` says the `moov` is somewhere else
// entirely (some writers put it at the end, and only on stop), which would
// make every clip but a whole finished track unplayable and is not something
// this code could fix by cutting differently.
export function describeContainer(bytes) {
    if (!bytes || bytes.length < 8) return '';
    if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
        return 'webm';
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const names = [];
    let offset = 0;
    // Only the first few, and only as far as the bytes in hand reach — a moov
    // is routinely larger than the sample this is given, which is fine: having
    // seen its name is the whole point.
    while (offset + 8 <= bytes.length && names.length < 4) {
        let size = view.getUint32(offset);
        const type = String.fromCharCode(
            bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        if (!/^[A-Za-z0-9]{4}$/.test(type)) break;
        names.push(type);
        if (size === 1) {
            if (offset + 16 > bytes.length || view.getUint32(offset + 8) !== 0) break;
            size = view.getUint32(offset + 12);
        }
        if (size < 8) break;
        offset += size;
    }
    return names.join('+');
}

// The container a clip's own BYTES are in, or null when they say nothing this
// build recognises.
//
// The bytes are the only authority on this, and the label has been wrong in
// the field in two different ways now — a fallback container that was never
// written down, and a browser reporting a type that cannot exist. A recording
// already on disk carries the bad label for ever, so the repair has to happen
// where the blob is built rather than only at the recorder.
export function sniffContainer(bytes) {
    if (!bytes || bytes.length < 8) return null;
    const ascii = (at, text) => {
        for (let i = 0; i < text.length; i++) {
            if (bytes[at + i] !== text.charCodeAt(i)) return false;
        }
        return true;
    };
    // ISO-BMFF: a size field, then 'ftyp'. MediaRecorder always writes it first.
    if (ascii(4, 'ftyp')) return 'audio/mp4';
    if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
        return 'audio/webm';
    }
    if (ascii(0, 'OggS')) return 'audio/ogg';
    return null;
}

export function fileExtensionFor(mimeType) {
    // The CONTAINER decides the extension. Matching anywhere in the string
    // also matches the codecs parameter, so 'audio/mp3;codecs=mp4a.40.2' was
    // exported as .m4a — right by accident, for a label that is wrong.
    const container = containerOf(mimeType);
    if (!container) return 'bin';
    if (container.includes('mp4') || container.includes('m4a')) return 'm4a';
    if (container.includes('ogg')) return 'ogg';
    if (container.includes('webm') || container.includes('matroska')) return 'webm';
    // Only reachable from an IMPORTED recording: no MediaRecorder writes any
    // of these. Matched exactly, so the impossible 'audio/mp3;codecs=mp4a.40.2'
    // a browser once reported for AAC-in-MP4 still gets no claim at all.
    if (container === 'audio/mpeg') return 'mp3';
    if (container === 'audio/wav') return 'wav';
    if (container === 'audio/flac') return 'flac';
    if (container === 'audio/aac') return 'aac';
    return 'bin';
}

// The canonical media type of an imported file, from its declared type and
// then its extension. Canonical because the same file arrives as audio/x-m4a,
// audio/m4a or audio/mp4 depending on the platform, as audio/x-wav or
// audio/wave, and — from some file pickers — with no type at all.
export function importedMimeType(file) {
    const type = containerOf(file && file.type);
    const ext = (String((file && file.name) || '').match(/\.([a-z0-9]+)$/i) || [])[1];
    const is = (types, exts) => types.includes(type) || (!type && exts.includes((ext || '').toLowerCase()));
    if (is(['audio/mpeg', 'audio/mp3', 'audio/x-mp3', 'audio/mpeg3'], ['mp3'])) return 'audio/mpeg';
    if (is(['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'video/mp4'], ['m4a', 'mp4'])) return 'audio/mp4';
    if (is(['audio/aac', 'audio/x-aac'], ['aac'])) return 'audio/aac';
    if (is(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'], ['wav', 'wave'])) return 'audio/wav';
    if (is(['audio/flac', 'audio/x-flac'], ['flac'])) return 'audio/flac';
    if (is(['audio/ogg', 'application/ogg'], ['ogg', 'oga', 'opus'])) return 'audio/ogg';
    if (is(['audio/webm', 'video/webm'], ['webm'])) return 'audio/webm';
    return type || '';
}

export function bytesPerHour(kbps) { return (kbps * 1000 / 8) * 3600; }

export function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ---- payload encoding -----------------------------------------------------
//
// Audio is stored in IndexedDB as an ArrayBuffer, never as a Blob.
//
// WebKit keeps a Blob stored in IndexedDB as a separate file beside the
// database and hands back a reference to it, and on iOS that reference can
// stop being readable: the record is still there, `size` still answers, and
// every read fails. The first thing this was seen as was a clip iOS refused to
// play with "The operation is not supported" and no container shape at all —
// the shape could not be sniffed because the first bytes could not be read.
// The channel probe failed on the same session for the same reason. An
// ArrayBuffer is serialised into the record itself, so there is no second
// file to lose.
//
// Reads accept both, because every recording made before this carries Blobs.
async function storableBytes(value) {
    if (value && typeof value.arrayBuffer === 'function') return value.arrayBuffer();
    return value || null;
}

export function asBlob(value, type = '') {
    if (!value) return null;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return new Blob([value], { type: type || '' });
    }
    return value;
}

// Null when a stored Blob can be read, otherwise the error that says why not.
// A few bytes are enough: the failure is in reaching the backing file at all.
async function unreadableReason(blob) {
    if (!blob || typeof blob.slice !== 'function') return 'no audio data';
    if (!blob.size) return null;
    try {
        await blob.slice(0, 16).arrayBuffer();
        return null;
    } catch (e) {
        return (e && (e.name || e.message)) || String(e);
    }
}

// ---- reads ----------------------------------------------------------------
//
// Reads never throw, in the manner of tuneIndexStore: a failure resolves to
// null and the caller degrades to "no audio for this session", which is always
// a survivable answer.

// Playback can fetch cloud audio; recorder reads/writes remain strictly local.
let cloudAudio = null;
export function configureCloudAudio(provider) { cloudAudio = provider; }

// Deleting a session deletes its recording — INCLUDING a cloud copy.
//
// Routed through the provider rather than imported, because store.js cannot
// import the Dropbox service (that service imports store.js). Best-effort and
// never allowed to block the local delete: a cloud copy that could not be
// removed now is still removable from Settings, whereas a local delete that
// failed would leave the session listed with audio the user asked to be rid of.
//
// Deliberately called from the explicit user deletions only, never from the
// reclamation sweeps: a local tidy-up must not reach across and destroy the
// user's own Dropbox files.
export async function deleteCloudAudio(sessionId) {
    if (!sessionId || !cloudAudio || typeof cloudAudio.remove !== 'function') return false;
    try {
        await cloudAudio.remove(sessionId);
        return true;
    } catch (e) {
        console.warn('Could not delete the Dropbox copy of this recording:', e && e.message);
        return false;
    }
}
export async function playbackReadManifest(sessionId) {
    const local = await readManifest(sessionId);
    return local || (cloudAudio ? cloudAudio.manifest(sessionId) : null);
}

export async function readManifest(sessionId) {
    if (!sessionId) return null;
    try {
        const manifest = await get(manifestKey(sessionId));
        if (!manifest || manifest.schema !== AUDIO_SCHEMA_VERSION) return null;
        if (!Array.isArray(manifest.segments) || !Array.isArray(manifest.tracks)) return null;
        return withInitBlobs(manifest);
    } catch (e) {
        console.warn('Could not read session audio manifest:', e && e.message);
        return null;
    }
}

// Tracks carry their initialisation bytes, stored as an ArrayBuffer since the
// Blob problem above; every reader downstream expects a Blob.
function withInitBlobs(manifest) {
    return {
        ...manifest,
        tracks: manifest.tracks.map(t => (t && t.init && !(t.init instanceof Blob)
            ? { ...t, init: asBlob(t.init, t.mimeType || manifest.mimeType) }
            : t)),
    };
}

// The three answers readManifest() collapses into null, kept apart.
//
// "There is no recording", "I could not read it" and "it was written by a
// newer build" are the same value to a reader that only wants to play
// something, and completely different to one that is about to WRITE. Treating
// the last two as absence means creating a fresh manifest over an existing
// recording, orphaning every segment it named — the same "could not tell means
// it is gone" mistake as the orphan sweep, on the write path.
//
// Returns `{ state, manifest }` where state is:
//   'ok'          — a manifest this build understands
//   'absent'      — nothing stored, and it is safe to create one
//   'unreadable'  — the read failed; nothing may be assumed
//   'unsupported' — present but not this schema, i.e. possibly newer
export async function probeManifest(sessionId) {
    if (!sessionId) return { state: 'absent', manifest: null };
    let raw;
    try {
        raw = await get(manifestKey(sessionId));
    } catch (e) {
        console.warn('Could not read session audio manifest:', e && e.message);
        return { state: 'unreadable', manifest: null };
    }
    if (!raw) return { state: 'absent', manifest: null };
    if (raw.schema !== AUDIO_SCHEMA_VERSION ||
        !Array.isArray(raw.segments) || !Array.isArray(raw.tracks)) {
        return { state: 'unsupported', manifest: null };
    }
    return { state: 'ok', manifest: raw };
}

// A segment record with its payload as a Blob, or null when nothing is stored.
//
// A record whose payload cannot be read comes back with `blob: null` and the
// reason in `unreadable`, rather than as null: "this device holds the segment
// but cannot read it" is the one case where another copy (Dropbox) is the
// answer, and the caller needs to be able to say which it was.
export async function readSegment(sessionId, index) {
    let record;
    try {
        record = (await get(segmentKey(sessionId, index))) || null;
    } catch (e) {
        console.warn('Could not read session audio segment:', e && e.message);
        return null;
    }
    if (!record) return null;
    const { data, ...rest } = record;
    if (data) return { ...rest, blob: asBlob(data, record.mimeType) };
    // Written before payloads were stored as bytes: a Blob, which WebKit may
    // no longer be able to read.
    const reason = await unreadableReason(record.blob);
    if (reason) {
        console.warn('Stored session audio could not be read:', reason);
        return { ...rest, blob: null, unreadable: reason };
    }
    return record;
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

// Held while reclaimOrphans() is deciding what nothing claims.
//
// The sweep and an append are directly incompatible: appendSegment writes the
// PAYLOAD first and the manifest second, so between the two there is a real
// segment on disk that no manifest names yet. A sweep landing in that window
// deletes it, and the manifest write then lands naming audio that is gone —
// producing the exact "manifest points at missing segments" state the
// payload-first ordering exists to prevent.
let sweeping = null;

async function withSession(sessionId, fn) {
    // Waited BEFORE joining the chain, never inside it: the sweep waits on the
    // chains, so a chain entry waiting on the sweep would deadlock.
    if (sweeping) { try { await sweeping; } catch (e) { /* sweep failures are its own */ } }
    const previous = chains.get(sessionId) || Promise.resolve();
    const next = previous.then(fn, fn);
    chains.set(sessionId, next.catch(() => {}));
    return next;
}

export function createManifest({ sessionId, mimeType, bitsPerSecond, channels = null }) {
    return {
        schema: AUDIO_SCHEMA_VERSION,
        sessionId,
        mimeType: mimeType || '',
        bitsPerSecond: bitsPerSecond || 0,
        // How many channels the encoder is being fed, as the TRACK reported it
        // rather than as it was requested. Null means the browser would not
        // say, which is a different answer from "one" and must not be shown as
        // one. Additive: a recording made before this existed has no value
        // here, and is described as unknown rather than guessed at.
        channels: channels || null,
        timesliceMs: TIMESLICE_MS,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tracks: [],
        segments: [],
        totalSeconds: 0,
        bytes: 0,
        // The earliest position at which new audio may begin. Advanced past a
        // segment that could not be stored, monotone, and never cleared — see
        // storedClockFloor() in sessionRecorder.js.
        clockFloor: 0,
        // null until end() has drained the final segment write. Older manifests
        // omit this field; new recordings must not publish whole files early.
        finalizedAt: null,
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
    // Outside the chain: reading a few hundred kB out of a fresh Blob need not
    // hold up a delete or a sweep. See storableBytes() for why bytes at all.
    const data = await storableBytes(segment.blob);
    const patch = trackPatch && trackPatch.init
        ? { ...trackPatch, init: await storableBytes(trackPatch.init) }
        : trackPatch;
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
            mimeType: (segment.blob && segment.blob.type) || '',
            data,
        });

        const next = {
            ...manifest,
            updatedAt: Date.now(),
            finalizedAt: null,
            tracks: patch ? mergeTrack(manifest.tracks, patch) : manifest.tracks,
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
        return withInitBlobs(next);
    });
}

// ---- imported recordings ---------------------------------------------------
//
// A recording made elsewhere and brought in through Session Tools, stored so
// that it plays, seeks and backs up exactly like one the app recorded.
//
// It cannot be stored the way a live recording is. MediaRecorder output is a
// header followed by independently appendable chunks, which is what lets a
// live recording be cut into three-minute clips. An uploaded MP3, M4A or WAV is
// none of that: a byte range from the middle of an M4A is not a file at all,
// and a WAV slice has no header. So an imported file is ONE track marked
// `wholeFile`, and buildClip() always hands back the whole of it — the browser
// then seeks inside a complete, ordinary audio file, which it does perfectly.
//
// It is still STORED in pieces, because everything downstream is built around
// small records: one IndexedDB write per few megabytes rather than a single
// transaction the size of the file, and Dropbox segments that fit its
// single-request upload and a download deadline. A piece's time span is its
// share of the bytes. That is exact for constant-bitrate audio and approximate
// otherwise, and it does not matter which: the spans only decide which piece
// "covers" a moment, and every piece of a whole-file track yields the same clip.
export const IMPORT_PIECE_BYTES = 4 * 1024 * 1024;

// Above this the file is not kept. Playback holds the whole file in memory —
// read from storage and then assembled — so this is roughly what a phone has
// to spare twice over. Three hours of MP3 at 192 kbps fits; an hour of
// uncompressed WAV does not, and the message says to convert it.
export const MAX_IMPORT_AUDIO_BYTES = 300 * 1024 * 1024;

// Whether a whole-file track has to be PLAYED whole.
//
// MP3 and ADTS AAC are streams of self-synchronising frames: a decoder handed
// bytes from the middle finds the next frame header and plays from there. So a
// 4 MB piece of an MP3 is itself a playable file, and requiring the whole file
// for every play was pure cost — worst on a device playing the recording from
// Dropbox, which had to download all of it (133 MB, found in the field for a
// 95-minute import) before a note, through a download cache a quarter that
// size, so every tap started the download again.
//
// Decided at READ time from the stored container, so recordings already
// imported get it without being imported again. M4A, WAV, FLAC and Ogg keep the
// whole-file rule: their pieces are not files.
const SLICEABLE_CONTAINERS = ['audio/mpeg', 'audio/aac'];
export function playsWhole(track) {
    return !!(track && track.wholeFile) && !SLICEABLE_CONTAINERS.includes(containerOf(track.mimeType));
}

export class ImportAudioError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

// Stores `file` as the recording of `sessionId`. Payload first, manifest last,
// exactly as appendSegment() does, so an interrupted import leaves orphans for
// reclaimOrphans() and never a manifest naming audio that is not there.
export async function importAudioFile(sessionId, file, { durationSeconds } = {}) {
    if (!file || !file.size) throw new ImportAudioError('The recording is empty.', 'empty');
    if (!(durationSeconds > 0)) throw new ImportAudioError('The recording\'s length is unknown.', 'duration');
    if (file.size > MAX_IMPORT_AUDIO_BYTES) {
        throw new ImportAudioError(
            `The file is ${formatBytes(file.size)}, more than the ${formatBytes(MAX_IMPORT_AUDIO_BYTES)} that can be kept. ` +
            'Convert it to MP3 or M4A to keep the audio.', 'too-large');
    }
    const headroom = await headroomBytes();
    if (headroom !== null && headroom < file.size) {
        throw new ImportAudioError('Not enough free storage to keep this recording.', 'storage');
    }
    // Never over an existing recording, and never on a guess that there is
    // none — see probeManifest().
    const probe = await probeManifest(sessionId);
    if (probe.state !== 'absent') {
        throw new ImportAudioError('This session already has a recording.', 'exists');
    }

    const mimeType = importedMimeType(file);
    const total = file.size;
    return withSession(sessionId, async () => {
        const written = [];
        const segments = [];
        try {
            for (let from = 0, index = 0; from < total; from += IMPORT_PIECE_BYTES, index++) {
                const to = Math.min(total, from + IMPORT_PIECE_BYTES);
                const startSeconds = durationSeconds * from / total;
                const meta = {
                    index,
                    trackIndex: 0,
                    startSeconds,
                    durationSeconds: durationSeconds * to / total - startSeconds,
                    bytes: to - from,
                };
                const data = await file.slice(from, to).arrayBuffer();
                await set(segmentKey(sessionId, index), {
                    sessionId,
                    ...meta,
                    // One chunk per piece, and only the first carries the
                    // file's header — which is what tells buildClip() never
                    // to prepend one.
                    chunks: [{ startSeconds, bytes: meta.bytes, ...(index === 0 ? { init: true } : {}) }],
                    mimeType,
                    data,
                });
                written.push(index);
                segments.push(meta);
            }
            const manifest = {
                ...createManifest({
                    sessionId,
                    mimeType,
                    bitsPerSecond: Math.round(total * 8 / durationSeconds),
                }),
                source: 'import',
                sourceFileName: String(file.name || ''),
                tracks: [{
                    index: 0,
                    startSeconds: 0,
                    durationSeconds,
                    init: null,
                    mimeType,
                    wholeFile: true,
                }],
                segments,
                totalSeconds: durationSeconds,
                bytes: total,
                // Complete on arrival: nothing will ever be appended, so the
                // whole-file Dropbox copy need not wait for anything.
                finalizedAt: Date.now(),
            };
            await set(manifestKey(sessionId), manifest);
            return withInitBlobs(manifest);
        } catch (e) {
            // Nothing names these yet, so they are ours to take back — and
            // leaving 300 MB for the next sweep is not a kindness.
            for (const index of written) {
                try { await del(segmentKey(sessionId, index)); } catch (err) { /* swept later */ }
            }
            const message = (e && e.message) || String(e);
            if (/quota/i.test(message) || (e && e.name === 'QuotaExceededError')) {
                throw new ImportAudioError('Not enough free storage to keep this recording.', 'storage');
            }
            throw e;
        }
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
        // A failed commit-marker delete must leave every referenced payload
        // intact. Report it so the caller can retry instead of claiming success.
        await del(manifestKey(sessionId));
        const indices = manifest && Array.isArray(manifest.segments)
            ? manifest.segments.map(s => s.index)
            : [];
        for (const index of indices) {
            try { await del(segmentKey(sessionId, index)); } catch (e) { /* best effort */ }
        }
        chains.delete(sessionId);
    });
}

// What every manifest on disk currently claims, read STRICTLY.
//
// Rethrows rather than skipping: this is the input to a delete, and a manifest
// that merely failed to read looks identical to one that does not exist —
// which would make the sweep destroy a whole recording over one transient
// error. Returns the claimed segment keys plus the sessions whose manifests
// could be read but not understood, which are protected wholesale.
async function claimedSegments() {
    const all = await keys();
    const claimed = new Set();
    const protectedSessions = new Set();

    for (const key of all) {
        if (typeof key !== 'string' || !key.startsWith(MANIFEST_PREFIX)) continue;
        const manifest = await get(key);        // throws → the sweep is abandoned
        if (!manifest) continue;                // genuinely absent
        const sessionId = key.slice(MANIFEST_PREFIX.length);

        // A manifest this build does not recognise may be a NEWER format a
        // later release wrote. It is not used, but its audio is certainly not
        // rubbish — same rule as the tune index's read-side delete. Retain
        // everything under that session rather than guessing at its shape.
        if (manifest.schema !== AUDIO_SCHEMA_VERSION || !Array.isArray(manifest.segments)) {
            protectedSessions.add(sessionId);
            continue;
        }
        for (const segment of manifest.segments) {
            claimed.add(segmentKey(sessionId, segment.index));
        }
    }
    return { all, claimed, protectedSessions };
}

// Deletes segment records no manifest claims: what an interrupted append or an
// interrupted delete leaves behind. Cheap enough to run whenever the session
// list is opened.
//
// Abandons itself rather than guessing. Every read here feeds a delete, so
// "could not tell" must mean "delete nothing", never "delete everything".
export async function reclaimOrphans() {
    if (sweeping) return sweeping;

    let release;
    sweeping = new Promise(resolve => { release = resolve; });
    try {
        // Let writes already past the gate finish, so a payload whose manifest
        // is still on its way is not mistaken for an orphan.
        await Promise.allSettled([...chains.values()]);

        let view;
        try {
            view = await claimedSegments();
        } catch (e) {
            console.warn('Not reclaiming session audio — could not read what is claimed:',
                e && e.message);
            return 0;
        }

        let reclaimed = 0;
        for (const key of view.all) {
            if (typeof key !== 'string' || !key.startsWith(SEGMENT_PREFIX)) continue;
            if (view.claimed.has(key)) continue;
            const sessionId = key.slice(SEGMENT_PREFIX.length).split(':')[0];
            if (view.protectedSessions.has(sessionId)) continue;
            try { await del(key); reclaimed++; } catch (e) { /* best effort */ }
        }
        return reclaimed;
    } finally {
        sweeping = null;
        release();
    }
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

// The initialisation bytes of a track: everything BEFORE its first frame of
// audio.
//
// A track's first chunk carries the container header AND its first second of
// audio, and prepending the whole of it to a mid-stream clip was the bug this
// exists to fix. The clip then held two stretches of audio whose container
// timestamps disagreed — one at the track's origin, one at the chunk's real
// position — and where a media element lands when asked to seek into such a
// file is not defined by anything. Measured in Chromium: it plays the two
// contiguously but SEEKS by the raw timestamps, so the same offset resolves
// differently depending on how much had already been buffered. From the user's
// side that is a timeline that works near the start of a session and stops
// working further in.
//
// With the audio stripped, what is left is exactly an initialisation segment
// followed by media segments — the arrangement MSE is built on — and the
// clip's timeline IS the track's, at every offset and in every engine, because
// the timestamps are the only thing describing it. `buildClip` therefore
// reports `trackStartSeconds` and the player maps through that.
//
// Returns the whole blob unchanged when the first frame cannot be located: a
// clip that plays with the old ambiguity is far better than one that does not
// play at all, and a container this does not recognise is exactly the case
// where guessing would produce the latter.
// Null when the init blob cannot be read at all — prepending bytes nobody can
// read would only move the failure to the decoder, where it says nothing.
async function containerHeader(initBlob) {
    if (!initBlob || !initBlob.size) return initBlob;
    let bytes;
    try {
        bytes = new Uint8Array(await initBlob.arrayBuffer());
    } catch (e) {
        return null;
    }
    const cut = firstMediaOffset(bytes);
    // From the bytes already read, never a slice of the stored Blob: see
    // readRange() for why the stored file is not trusted past a read.
    return new Blob([cut > 0 && cut < bytes.length ? bytes.subarray(0, cut) : bytes]);
}

// Where the audio starts inside a track's first chunk, or -1.
//
// Two containers, because MediaRecorder produces one or the other and which
// one is the browser's choice, not ours (pickMimeType prefers audio/mp4 and
// falls back to WebM).
function firstMediaOffset(bytes) {
    const webm = firstWebmClusterOffset(bytes);
    if (webm >= 0) return webm;
    // ISO-BMFF (audio/mp4): the first movie-fragment box. ftyp and moov are
    // the initialisation segment; moof/mdat are the media. styp precedes moof
    // in some writers and belongs with it.
    return firstIsoFragmentOffset(bytes);
}

// WebM: the first Cluster element inside the Segment.
//
// Walked as EBML rather than scanned for the Cluster's four ID bytes. Those
// bytes occur by chance inside CodecPrivate and the seek table often enough to
// matter, and cutting there would leave a header that no decoder accepts —
// which is a worse failure than the one this is fixing, because it takes the
// audio away entirely rather than putting it at the wrong offset.
function firstWebmClusterOffset(bytes) {
    const EBML_HEADER = 0x1A45DFA3;
    const SEGMENT = 0x18538067;
    const CLUSTER = 0x1F43B675;

    // An EBML variable-length integer. `keepMarker` is the difference between
    // an element ID (stored with its length marker) and a size (without).
    function vint(at, keepMarker) {
        if (at >= bytes.length) return null;
        const first = bytes[at];
        if (first === 0) return null;
        let length = 1;
        for (let mask = 0x80; !(first & mask); mask >>= 1) length++;
        if (length > 8 || at + length > bytes.length) return null;
        let value = keepMarker ? first : (first & (0xFF >> length));
        let unknown = !keepMarker && (first & (0xFF >> length)) === (0xFF >> length);
        for (let i = 1; i < length; i++) {
            value = value * 256 + bytes[at + i];
            if (bytes[at + i] !== 0xFF) unknown = false;
        }
        return { value, length, unknown };
    }

    let offset = 0;
    let insideSegment = false;
    while (offset < bytes.length) {
        const id = vint(offset, true);
        if (!id) return -1;
        const size = vint(offset + id.length, false);
        if (!size) return -1;
        const body = offset + id.length + size.length;

        if (id.value === CLUSTER && insideSegment) return offset;
        // The Segment is descended into rather than skipped: its size is
        // written as unknown by MediaRecorder, since the length is not known
        // until recording stops.
        if (id.value === SEGMENT) { insideSegment = true; offset = body; continue; }
        if (size.unknown) return -1;
        if (id.value !== EBML_HEADER && !insideSegment) return -1;
        offset = body + size.value;
    }
    return -1;
}

function firstIsoFragmentOffset(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    while (offset + 8 <= bytes.length) {
        let size = view.getUint32(offset);
        const type = String.fromCharCode(
            bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        if (type === 'moof' || type === 'styp' || type === 'mdat') return offset;
        if (size === 1) {
            // 64-bit largesize. Only the low half can address a chunk this
            // small, and a header box that large is not one we can walk.
            if (offset + 16 > bytes.length) return -1;
            if (view.getUint32(offset + 8) !== 0) return -1;
            size = view.getUint32(offset + 12);
        }
        // Size 0 means "to the end of the file", so there is no next box.
        if (size < 8) return -1;
        offset += size;
    }
    return -1;
}

// The label a clip's bytes will actually be accepted under.
//
// The sniffed container wins whenever the two disagree; the label is kept when
// it agrees, because it carries the codecs parameter as well. Bytes this build
// does not recognise leave the label alone — being unable to tell is not
// grounds for relabelling someone's recording.
function correctedMimeType(head, labelled) {
    const sniffed = head ? sniffContainer(head) : null;
    if (!sniffed) return labelled;
    return containerOf(labelled) === sniffed ? labelled : sniffed;
}

// `{ bytes }` for the range, or `{ error }` naming why it could not be read.
async function readRange(blob, from, to) {
    try {
        return { bytes: new Uint8Array(await blob.slice(from, to).arrayBuffer()) };
    } catch (e) {
        return { error: (e && (e.name || e.message)) || String(e) };
    }
}

// Replaces a stored segment whose Blob could not be read with the verified
// backed-up copy, as bytes, so the next play is local and works offline.
//
// Only ever over an existing record — a segment deleted meanwhile stays
// deleted — and never allowed to fail playback: the clip is already built from
// the downloaded copy.
function healSegment(sessionId, index, blob) {
    withSession(sessionId, async () => {
        const key = segmentKey(sessionId, index);
        const record = await get(key);
        if (!record || record.data) return;
        const data = await blob.arrayBuffer();
        if (data.byteLength !== record.bytes) return;
        const healed = { ...record, mimeType: blob.type || record.mimeType || '', data };
        delete healed.blob;
        await set(key, healed);
    }).catch(e => console.warn('Could not repair stored session audio:', e && e.message));
}

// A track's header from the backed-up copy, for when this device's own copy
// cannot be read. The cloud manifest carries it as base64 inside the JSON,
// which is why it survives where a stored Blob did not.
async function cloudHeader(sessionId, trackIndex) {
    if (!cloudAudio) return null;
    try {
        const manifest = await cloudAudio.manifest(sessionId);
        const track = manifest && (manifest.tracks || []).find(t => t.index === trackIndex);
        return track && track.init ? await containerHeader(track.init) : null;
    } catch (e) {
        return null;
    }
}

// The failure a player can act on: the audio is on this device and this
// device cannot read it. Different from "missing" (interrupted delete) and
// from "this browser will not play it", both of which read the same on screen
// without it.
function unreadableAudio(what, triedCloud) {
    const error = new Error(`The audio saved on this device can no longer be read (${what})` +
        (triedCloud ? ' and no backed-up copy could be fetched.' : '.'));
    error.code = 'unreadable';
    return error;
}

function unreadableBackup(what) {
    const error = new Error(`The backed-up audio for this part could not be read on this device (${what}).`);
    error.code = 'unreadable';
    return error;
}

// The first bytes of an assembled clip, or null if they cannot be read.
async function readHead(parts) {
    try {
        return new Uint8Array(await new Blob(parts).slice(0, 2048).arrayBuffer());
    } catch (e) {
        return null;
    }
}

/**
 * Builds a playable Blob covering [fromSeconds, toSeconds) of a session's audio.
 *
 * A clip is the track's initialisation bytes followed by the stream chunks that
 * overlap the range, so no decoding or re-encoding is involved and Blob.slice
 * keeps it lazy. The bytes carry the track's own timestamps, so the clip's
 * media timeline starts at `trackStartSeconds` rather than at `startSeconds`.
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
export async function buildClip(sessionId, fromSeconds, toSeconds, manifestIn = null, { requireComplete = false } = {}) {
    const manifest = manifestIn || await readManifest(sessionId);
    if (!manifest) return null;

    let overlapping = manifest.segments
        .filter(s => s.startSeconds + s.durationSeconds > fromSeconds && s.startSeconds < toSeconds)
        .sort((a, b) => a.index - b.index);
    if (!overlapping.length) return null;

    const trackIndex = overlapping[0].trackIndex;
    const track = manifest.tracks.find(t => t.index === trackIndex);
    if (!track) return null;

    // An imported file is only a file when it is whole — see importAudioFile().
    // Whatever was asked for, the clip is the entire track, and the timeline
    // below (trackStartSeconds) is what maps a moment into it.
    if (playsWhole(track)) {
        overlapping = manifest.segments
            .filter(s => s.trackIndex === trackIndex)
            .sort((a, b) => a.index - b.index);
        fromSeconds = Math.min(...overlapping.map(s => s.startSeconds));
        toSeconds = Math.max(...overlapping.map(s => s.startSeconds + s.durationSeconds));
    }

    const parts = [];
    let clipStart = null;
    let clipEnd = null;
    let coveredTo = fromSeconds;
    const incomplete = () => new Error('Some audio for this part is missing or unreadable. No complete file was created.');
    // 0 when the clip begins at the track's own first chunk and needs no
    // header prepended. Reported because a header far smaller than a real
    // initialisation segment is itself the diagnosis.
    let headerBytes = 0;

    for (const meta of overlapping) {
        if (meta.trackIndex !== trackIndex) break;   // never cross a track
        if (requireComplete && meta.startSeconds > coveredTo + 0.001) throw incomplete();
        const local = await readSegment(sessionId, meta.index);
        const wantedOf = seg => chunkSpans(seg)
            .filter(s => s.endSeconds > fromSeconds && s.startSeconds < toSeconds);

        // The bytes this clip needs from this segment are READ here, not
        // merely sliced. A Blob stored in IndexedDB on WebKit can be readable
        // at its start and not further in — seen in the field as some tunes
        // playing and others not from the same recording — so the only test
        // that means anything is reading exactly the range that will be
        // played. What is read is memory, so the finished clip no longer
        // depends on the stored file at all.
        let segment = null;
        let wanted = null;
        let bytes = null;
        let failure = local && local.unreadable || null;
        if (local && local.blob) {
            wanted = wantedOf(local);
            if (!wanted.length) continue;
            const read = await readRange(local.blob, wanted[0].from, wanted[wanted.length - 1].to);
            if (read.bytes) { segment = local; bytes = read.bytes; } else failure = read.error;
        }
        // Missing here, or here and unreadable: either way a backed-up copy is
        // the audio, and it is verified against its hash on the way in.
        let triedCloud = false;
        let cloudFailure = null;
        if (!segment && cloudAudio) {
            triedCloud = true;
            let remote = null;
            try {
                remote = await cloudAudio.segment(sessionId, meta.index);
            } catch (e) {
                // Only swallowed when the local copy explains the failure
                // better than the network does.
                if (!failure) throw e;
            }
            if (remote && remote.blob) {
                wanted = wantedOf(remote);
                if (!wanted.length) continue;
                const read = await readRange(remote.blob, wanted[0].from, wanted[wanted.length - 1].to);
                if (read.bytes) {
                    segment = remote;
                    bytes = read.bytes;
                    if (failure) healSegment(sessionId, meta.index, remote.blob);
                } else {
                    // Said, not dropped: a backup copy that cannot be read
                    // presented as "that part of the recording is missing",
                    // which is exactly how the last round of this was hidden.
                    failure = failure || read.error;
                    cloudFailure = read.error;
                }
            }
        }
        if (!segment && failure) {
            if (!parts.length) {
                throw cloudFailure && !(local && local.unreadable)
                    ? unreadableBackup(cloudFailure)
                    : unreadableAudio(failure, triedCloud);
            }
            break;
        }
        // A segment the manifest names but that is not on disk means an
        // interrupted delete. Stop here rather than splicing a hole into the
        // middle of a clip, which would play as a glitch or not at all.
        if (!segment || !segment.blob) {
            if (requireComplete) throw incomplete();
            break;
        }
        if (requireComplete && (segment.blob.size !== meta.bytes ||
            !Array.isArray(segment.chunks) ||
            segment.chunks.reduce((n, c) => n + c.bytes, 0) !== meta.bytes)) throw incomplete();

        // The track's first chunk carries the container header AND its first
        // second of audio, so it is stored in the segment like any other chunk.
        // Prepending the init blob to a clip that already begins there would
        // write the header twice, which is not a file any decoder will accept.
        if (clipStart === null && !wanted[0].init && track.init) {
            let header = await containerHeader(track.init);
            if (!header) header = await cloudHeader(sessionId, trackIndex);
            if (!header) throw unreadableAudio('the recording\'s header', !!cloudAudio);
            headerBytes = header.size || 0;
            parts.push(header);
        }

        parts.push(new Blob([bytes]));
        if (clipStart === null) clipStart = wanted[0].startSeconds;
        clipEnd = wanted[wanted.length - 1].endSeconds;
        coveredTo = clipEnd;
    }

    if (requireComplete && (clipStart === null || clipStart > fromSeconds + 0.001 ||
        coveredTo < toSeconds - 0.001)) throw incomplete();
    if (clipStart === null) return null;
    // The TRACK's own container, not the session's. A session resumed onto a
    // browser that fell back to a different encoder has tracks that genuinely
    // differ, and a clip never spans one — so the track is the only level at
    // which "what format is this" has a single answer.
    //
    // Then checked against the BYTES, which outrank it. A blob whose declared
    // type contradicts its content is refused outright by the decoder, and
    // this label has been wrong in the field twice: a fallback container that
    // was never written down, and Safari reporting the impossible
    // 'audio/mp3;codecs=mp4a.40.2' for AAC-in-MP4. Recordings already on disk
    // carry the bad label for ever, so the repair belongs here.
    const labelled = track.mimeType || manifest.mimeType || '';
    const head = await readHead(parts);
    // Nothing above could read these bytes, so no player will either.
    if (!head) throw unreadableAudio('the assembled clip', false);
    const mimeType = correctedMimeType(head, labelled);
    return {
        blob: new Blob(parts, { type: mimeType || 'application/octet-stream' }),
        mimeType,
        // Per track for the same reason as the container: a session resumed
        // after the user changed the stereo setting has tracks that genuinely
        // differ, and a clip never spans one.
        channels: track.channels || manifest.channels || null,
        startSeconds: clipStart,
        endSeconds: clipEnd,
        trackIndex,
        // What these bytes ARE, for a failure message on a device with no
        // console. See describeContainer().
        shape: describeContainer(head),
        headerBytes,
        // The origin of the clip's own media timeline. A clip's container
        // timestamps are the TRACK's, not the clip's — it begins with that
        // track's initialisation bytes — so this is what a seek is measured
        // from, never clipStart.
        //
        // Except a slice of an imported MP3/AAC stream: those bytes carry no
        // timestamps at all, so the element's timeline starts at zero where
        // the slice does. Saying so here, rather than leaving the player to
        // detect it, means there is no ambiguity for it to resolve.
        trackStartSeconds: track.wholeFile && !playsWhole(track) ? clipStart : (track.startSeconds || 0),
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
        wholeFile: !!track.wholeFile,
    })).filter(t => t.durationSeconds > 0).sort((a, b) => a.startSeconds - b.startSeconds);
}

// ---- the recording check ---------------------------------------------------
//
// Reads every byte of a session's stored audio and reports, per segment,
// whether this device can actually read it — and, where it cannot, whether the
// Dropbox backup holds a copy.
//
// It exists because playback failures on the phone arrive one error message at
// a time, and each message describes only the one clip that failed. This
// answers the whole recording in one tap, on the device, with no console:
// which pieces are stored how, which read, where a failing one stops reading,
// and what the bytes at its start are.
//
// Strictly read-only. It never repairs, deletes or downloads audio; the cloud
// half only reads the backup's manifest, which is small and usually cached.

// How much is read at a time. A failing Blob is located to within this, and no
// more than this is ever held in memory for a stored Blob.
const CHECK_STEP_BYTES = 256 * 1024;

// How far into `blob` can be read, stepping from the start.
async function readableExtent(blob) {
    let offset = 0;
    while (offset < blob.size) {
        const end = Math.min(blob.size, offset + CHECK_STEP_BYTES);
        try {
            await blob.slice(offset, end).arrayBuffer();
        } catch (e) {
            return { readable: offset, error: (e && (e.name || e.message)) || String(e) };
        }
        offset = end;
    }
    return { readable: blob.size, error: null };
}

async function headShape(blob) {
    try {
        return describeContainer(new Uint8Array(await blob.slice(0, 256).arrayBuffer()));
    } catch (e) {
        return '';
    }
}

async function inspectPayload(value, type) {
    if (!value) return { stored: 'none', size: 0, readableBytes: 0, error: null, shape: '' };
    const inline = !(typeof Blob !== 'undefined' && value instanceof Blob) &&
        (value instanceof ArrayBuffer || ArrayBuffer.isView(value));
    const blob = asBlob(value, type);
    if (!blob || typeof blob.slice !== 'function') {
        return { stored: 'unknown', size: 0, readableBytes: 0, error: 'not audio data', shape: '' };
    }
    const extent = await readableExtent(blob);
    return {
        stored: inline ? 'bytes' : 'blob',
        size: blob.size || 0,
        readableBytes: extent.readable,
        error: extent.error,
        shape: extent.readable > 0 ? await headShape(blob) : '',
    };
}

async function inspectBackupOnly(sessionId, report, onProgress) {
    let remote;
    try {
        remote = await cloudAudio.manifest(sessionId);
    } catch (e) {
        report.cloud.state = `unavailable: ${(e && e.message) || e}`;
        return report;
    }
    if (!remote || !Array.isArray(remote.segments)) {
        report.cloud.state = 'not backed up';
        return report;
    }
    report.source = 'backup';
    report.cloud.state = 'ok';
    report.cloud.listed = remote.segments.length;
    report.manifest = {
        state: 'backup',
        mimeType: remote.mimeType || '',
        bitsPerSecond: remote.bitsPerSecond || 0,
        totalSeconds: remote.totalSeconds || 0,
        bytes: remote.bytes || 0,
        finalized: !!remote.finalizedAt,
        stopped: remote.stopped ? (remote.stopped.reason || 'yes') : null,
    };
    for (const track of (remote.tracks || []).slice().sort((a, b) => a.index - b.index)) {
        report.tracks.push({
            index: track.index,
            startSeconds: track.startSeconds || 0,
            durationSeconds: track.durationSeconds || 0,
            mimeType: track.mimeType || '',
            channels: track.channels || null,
            init: await inspectPayload(track.init, track.mimeType || remote.mimeType),
        });
    }
    const metas = remote.segments.slice().sort((a, b) => a.index - b.index);
    for (let i = 0; i < metas.length; i++) {
        const meta = metas[i];
        if (onProgress) onProgress(i, metas.length);
        const entry = {
            index: meta.index,
            trackIndex: meta.trackIndex,
            startSeconds: meta.startSeconds,
            durationSeconds: meta.durationSeconds,
            expectedBytes: meta.bytes || 0,
            inCloud: true,
        };
        let cached = null;
        try {
            cached = typeof cloudAudio.cached === 'function'
                ? await cloudAudio.cached(sessionId, meta.index) : null;
        } catch (e) {
            report.segments.push({ ...entry, stored: 'cache unreadable', size: 0, readableBytes: 0,
                error: (e && (e.name || e.message)) || String(e), shape: '' });
            continue;
        }
        if (!cached || !cached.payload) {
            report.segments.push({ ...entry, stored: 'not cached', size: 0, readableBytes: 0, error: null, shape: '' });
            continue;
        }
        const payload = await inspectPayload(cached.payload, cached.mimeType);
        report.segments.push({ ...entry, ...payload,
            stored: payload.stored === 'bytes' ? 'cached bytes' : 'cached blob' });
    }
    if (onProgress) onProgress(metas.length, metas.length);
    await addStorage(report);
    return report;
}

async function addStorage(report) {
    if (typeof navigator === 'undefined' || !navigator.storage) return;
    const storage = {};
    try {
        const { usage, quota } = await navigator.storage.estimate();
        Object.assign(storage, { usage, quota });
    } catch (e) { /* not reported */ }
    try {
        if (navigator.storage.persisted) storage.persisted = await navigator.storage.persisted();
    } catch (e) { /* not reported */ }
    report.storage = storage;
}

export async function inspectRecording(sessionId, { onProgress = null } = {}) {
    const report = {
        sessionId,
        checkedAt: Date.now(),
        manifest: null,
        tracks: [],
        segments: [],
        cloud: { configured: !!cloudAudio, state: cloudAudio ? 'not checked' : 'not connected', listed: 0 },
        storage: null,
    };

    const probe = await probeManifest(sessionId);
    report.manifest = { state: probe.state };
    report.source = 'local';
    // No copy of its own is the ordinary state for a device that did not make
    // the recording — it plays entirely from the backup, through the download
    // cache. Stopping here said "no recording" about audio that was playing.
    if (probe.state === 'absent' && cloudAudio) {
        return inspectBackupOnly(sessionId, report, onProgress);
    }
    if (probe.state !== 'ok') return report;
    const manifest = probe.manifest;
    Object.assign(report.manifest, {
        mimeType: manifest.mimeType || '',
        bitsPerSecond: manifest.bitsPerSecond || 0,
        totalSeconds: manifest.totalSeconds || 0,
        bytes: manifest.bytes || 0,
        finalized: !!manifest.finalizedAt,
        stopped: manifest.stopped ? (manifest.stopped.reason || 'yes') : null,
    });

    // The backup's own list, so a local failure can be said to be recoverable
    // or not. Only the manifest — nothing is downloaded.
    const inCloud = new Set();
    if (cloudAudio) {
        try {
            const remote = await cloudAudio.manifest(sessionId);
            if (remote && Array.isArray(remote.segments)) {
                remote.segments.forEach(s => inCloud.add(s.index));
                report.cloud.state = 'ok';
                report.cloud.listed = inCloud.size;
            } else {
                report.cloud.state = 'not backed up';
            }
        } catch (e) {
            report.cloud.state = `unavailable: ${(e && e.message) || e}`;
        }
    }

    for (const track of (manifest.tracks || []).slice().sort((a, b) => a.index - b.index)) {
        report.tracks.push({
            index: track.index,
            startSeconds: track.startSeconds || 0,
            durationSeconds: track.durationSeconds || 0,
            mimeType: track.mimeType || '',
            channels: track.channels || null,
            init: await inspectPayload(track.init, track.mimeType || manifest.mimeType),
        });
    }

    const metas = manifest.segments.slice().sort((a, b) => a.index - b.index);
    for (let i = 0; i < metas.length; i++) {
        const meta = metas[i];
        if (onProgress) onProgress(i, metas.length);
        const entry = {
            index: meta.index,
            trackIndex: meta.trackIndex,
            startSeconds: meta.startSeconds,
            durationSeconds: meta.durationSeconds,
            expectedBytes: meta.bytes || 0,
            inCloud: cloudAudio && report.cloud.state === 'ok' ? inCloud.has(meta.index) : null,
        };
        let record;
        try {
            record = await get(segmentKey(sessionId, meta.index));
        } catch (e) {
            report.segments.push({ ...entry, stored: 'unreadable record',
                size: 0, readableBytes: 0, error: (e && (e.name || e.message)) || String(e), shape: '' });
            continue;
        }
        if (!record) {
            report.segments.push({ ...entry, stored: 'missing', size: 0, readableBytes: 0, error: null, shape: '' });
            continue;
        }
        const payload = await inspectPayload(record.data || record.blob, record.mimeType || '');
        const chunkBytes = Array.isArray(record.chunks)
            ? record.chunks.reduce((n, c) => n + (c.bytes || 0), 0) : null;
        report.segments.push({
            ...entry,
            ...payload,
            chunksMatch: chunkBytes === null ? null : chunkBytes === entry.expectedBytes,
            startsTrack: !!(record.chunks && record.chunks[0] && record.chunks[0].init),
        });
    }
    if (onProgress) onProgress(metas.length, metas.length);
    await addStorage(report);
    return report;
}
