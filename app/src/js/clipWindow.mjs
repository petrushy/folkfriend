// How much of a recording the player loads into one clip.
//
// Every clip is a separate file handed to the <audio> element, and moving from
// one to the next is a reload: new source, metadata, a seek, play() again. That
// is not gapless on any browser, and it was audible in the field as short skips
// every three minutes — the export of the same session, one continuous file,
// had none. So a clip should end as rarely as possible, and when it does the
// next one should already be built.
//
// A clip after the first one therefore carries as many segments as can be
// joined without a break — same track (two MediaRecorder runs cannot be
// concatenated), no hole between them (buildClip() stops at one anyway) — up
// to a byte budget, because the clip is held in memory and the next is built
// while it plays. The FIRST clip of a tap stays one segment: over Dropbox every
// segment is a download before a note plays.
//
// Pure: no Vue, no storage. Tested by test/clipWindow.test.mjs.

// Two windows exist at once (the playing one and the one being built), so this
// is roughly half of what the player may hold. ~28 min at 114 kbps, ~50 min at
// the 64 kbps default.
export const CLIP_WINDOW_BYTES = 24 * 1024 * 1024;

// A bound that holds when a segment's size is unknown (older manifests), so an
// absent byte count can never make the window the whole evening.
export const CLIP_WINDOW_MAX_SEGMENTS = 20;

// How far before the end of the playing clip the next one starts being built.
// Locally that is a few IndexedDB reads; over Dropbox it is a download per
// segment, which is why it is well over a few seconds.
export const PREFETCH_LEAD_SECONDS = 90;

// Segment ends are wall-clock measurements that meet within microseconds, not
// exactly — the same tolerance recordedRanges() uses to merge them.
const JOIN_TOLERANCE_SECONDS = 0.25;

function byIndex(segments) {
    return (segments || []).slice().sort((a, b) => a.index - b.index);
}

// The piece that carries on where a clip ends: the first one starting at or
// after that point, not merely the next index — a clip can span several
// pieces (a whole imported file spans all of its own), and the next index
// would replay them.
export function segmentAfter(segments, currentIndex, clipEndSeconds) {
    return byIndex(segments).find(s => s.index > currentIndex &&
        s.startSeconds >= (clipEndSeconds || 0) - 0.5) || null;
}

// The span [fromSeconds, toSeconds) of one clip starting at `first`.
export function clipWindow(segments, first, {
    maxBytes = CLIP_WINDOW_BYTES,
    maxSegments = CLIP_WINDOW_MAX_SEGMENTS,
} = {}) {
    const end = s => s.startSeconds + s.durationSeconds;
    const sorted = byIndex(segments);
    let at = sorted.findIndex(s => s.index === first.index);
    if (at === -1) return { fromSeconds: first.startSeconds, toSeconds: end(first), count: 1 };
    let last = sorted[at];
    let bytes = last.bytes || 0;
    let count = 1;
    while (++at < sorted.length && count < maxSegments) {
        const next = sorted[at];
        if (next.trackIndex !== first.trackIndex) break;
        if (Math.abs(next.startSeconds - end(last)) > JOIN_TOLERANCE_SECONDS) break;
        if (bytes + (next.bytes || 0) > maxBytes) break;
        bytes += next.bytes || 0;
        last = next;
        count++;
    }
    return { fromSeconds: first.startSeconds, toSeconds: end(last), count };
}

// The stretches that can be exported as one file each: one per run of
// segments that are in the same track AND contiguous. For an ordinary
// recording that is exactly one per track; a "tunes only" recording has holes
// inside a track, and a part cannot span one.
//
// `index` numbers the parts in order and is what the export button shows;
// `trackIndex` is the track the part was cut from. `firstSegmentIndex` is a
// stable identity for the part, since a part's position in the list can change
// as later segments are pruned.
export function recordingParts(manifest) {
    if (!manifest) return [];
    const tracks = new Map((manifest.tracks || []).map(t => [t.index, t]));
    const sorted = (manifest.segments || []).slice().sort((a, b) => a.index - b.index);
    const parts = [];
    for (const segment of sorted) {
        const end = segment.startSeconds + segment.durationSeconds;
        const last = parts[parts.length - 1];
        if (last && last.trackIndex === segment.trackIndex &&
            Math.abs(segment.startSeconds - last.endSeconds) <= JOIN_TOLERANCE_SECONDS) {
            last.endSeconds = Math.max(last.endSeconds, end);
            last.segmentCount++;
            continue;
        }
        parts.push({
            trackIndex: segment.trackIndex,
            firstSegmentIndex: segment.index,
            startSeconds: segment.startSeconds,
            endSeconds: end,
            segmentCount: 1,
            wholeFile: !!(tracks.get(segment.trackIndex) || {}).wholeFile,
        });
    }
    // Whether the part is its track's whole stored audio: an ordinary
    // recording's parts all are, and keep the track as their identity.
    const perTrack = new Map();
    for (const p of parts) perTrack.set(p.trackIndex, (perTrack.get(p.trackIndex) || 0) + 1);
    return parts
        .map(p => ({
            ...p,
            wholeTrack: perTrack.get(p.trackIndex) === 1,
            durationSeconds: Math.max(0, p.endSeconds - p.startSeconds),
        }))
        .filter(p => p.durationSeconds > 0)
        .sort((a, b) => a.startSeconds - b.startSeconds)
        .map((p, index) => ({ ...p, index }));
}
