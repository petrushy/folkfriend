// Which stored audio a "tunes only" recording keeps.
//
// The option exists for the break between sets: a three-hour evening is often
// an hour or more of conversation, and at 64 kbps every hour is ~29 MB. With it
// on, a stored segment is deleted once the analysis has shown that nothing in
// it, or within a margin either side of it, sounded like a tune.
//
// Three rules decide it, and each one is the "could not tell means keep" rule
// that the rest of the audio code lives by, applied to a new question:
//
//  1. EVIDENCE IS THE ANALYSIS, NOT THE TUNE LIST. A window counts as music
//     when its best match clears MUSIC_EVIDENCE_MIN_SCORE, which is
//     deliberately well below the score a detection needs to be listed — an
//     unfamiliar tune, an unusual setting or a poor window still scores
//     something, and those are exactly the tunes most worth going back to.
//     Rejecting or correcting a tune does not withdraw the evidence either:
//     "that was not tune X" still means a tune was being played.
//
//  2. ONLY AUDIO THAT WAS ANALYSED CAN BE JUDGED. A stretch recorded while the
//     analysis was not running — the index still loading, a backend error, a
//     microphone being reacquired — has no evidence either way, and absence of
//     evidence is not a break. A segment is deleted only when the analysed
//     windows cover all of it.
//
//  3. A SEGMENT IS JUDGED ONLY ONCE NO FUTURE WINDOW CAN CLAIM IT. A tune is
//     recognised a window after it starts, and the keep margin reaches back
//     before that, so the tail of the segment before a tune is needed as its
//     lead-in. The decision waits until the analysis has passed far enough
//     beyond the segment that no later window's margin can reach back into it.
//
// The granularity is a whole stored segment (SEGMENT_SECONDS, three minutes).
// That is coarser than the margins, so in practice a break shorter than about
// six minutes keeps all its audio — which costs little, and is never wrong.
//
// Pure: no Vue, no storage, no clock. Tested by test/audioKeep.test.mjs.

// Kept before the start of the first window that sounded like a tune. The
// window itself already reaches back windowSeconds before its stamp, and a
// tune's opening bars are the part most often played before anything matches.
export const KEEP_BEFORE_SECONDS = 30;

// Kept after the end of the last window that sounded like a tune: the last
// notes, the applause, and whoever names the tune afterwards.
export const KEEP_AFTER_SECONDS = 30;

// The bar for "this window sounded like a tune". The listed-detection bar
// (SESSION_ANALYSIS_DEFAULTS.minTopScore) is 0.45. Lower is the safe
// direction: a false "music" keeps three minutes of conversation, a false
// "break" deletes a tune for good. Not calibrated against recorded speech yet.
export const MUSIC_EVIDENCE_MIN_SCORE = 0.3;

// Windows closer together than this count as continuous analysis. The live
// loop steps every few seconds and a slow backend cycle stretches that; a gap
// longer than this means the analysis genuinely was not running.
export const ANALYSED_JOIN_SECONDS = 20;

// Extra distance the analysis must have moved past a segment before it is
// judged, on top of the window and the keep margin.
export const SETTLE_SLACK_SECONDS = 5;

function finite(n) { return typeof n === 'number' && Number.isFinite(n); }

// Inserts [from, to) into a sorted list of ranges, merging any it touches or
// comes within `joinSeconds` of. Returns a new array; the input is not changed.
export function addRange(ranges, from, to, joinSeconds = 0) {
    if (!finite(from) || !finite(to) || to <= from) return (ranges || []).slice();
    const out = [];
    let merged = { from, to };
    for (const range of (ranges || [])) {
        if (range.to + joinSeconds < merged.from || range.from - joinSeconds > merged.to) {
            out.push({ from: range.from, to: range.to });
        } else {
            merged = { from: Math.min(range.from, merged.from), to: Math.max(range.to, merged.to) };
        }
    }
    out.push(merged);
    return out.sort((a, b) => a.from - b.from);
}

// What one analysed window contributes. `stampSeconds` is where the window ENDS
// in the recording — liveAnalysis reads the recorder's clock when it reads the
// window's PCM.
export function noteWindow({ keepRanges = [], analysedRanges = [] } = {},
    stampSeconds, { music = false, windowSeconds = 0 } = {}) {
    if (!finite(stampSeconds)) return { keepRanges, analysedRanges };
    const start = Math.max(0, stampSeconds - Math.max(0, windowSeconds || 0));
    return {
        analysedRanges: addRange(analysedRanges, start, stampSeconds, ANALYSED_JOIN_SECONDS),
        keepRanges: music
            ? addRange(keepRanges, Math.max(0, start - KEEP_BEFORE_SECONDS),
                stampSeconds + KEEP_AFTER_SECONDS)
            : keepRanges,
    };
}

// The latest segment end that can no longer be claimed by a window not yet
// analysed. `analysedToSeconds` is the newest window stamp seen.
export function settledBefore(analysedToSeconds, windowSeconds) {
    if (!finite(analysedToSeconds)) return -Infinity;
    return analysedToSeconds - Math.max(0, windowSeconds || 0) -
        KEEP_BEFORE_SECONDS - SETTLE_SLACK_SECONDS;
}

function covered(ranges, from, to) {
    return (ranges || []).some(r => r.from <= from + 0.001 && r.to >= to - 0.001);
}

function overlaps(ranges, from, to) {
    return (ranges || []).some(r => r.from < to && r.to > from);
}

// Indices of stored segments that may be deleted: settled, fully analysed, and
// touching no keep range.
export function prunableSegments(segments, { keepRanges = [], analysedRanges = [], settledBeforeSeconds = -Infinity } = {}) {
    return (segments || []).filter(segment => {
        const from = segment.startSeconds;
        const to = segment.startSeconds + segment.durationSeconds;
        if (!finite(from) || !finite(to) || to <= from) return false;
        if (to > settledBeforeSeconds) return false;
        if (!covered(analysedRanges, from, to)) return false;
        return !overlaps(keepRanges, from, to);
    }).map(segment => segment.index);
}
