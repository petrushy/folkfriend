// Line breaking for the score view.
//
// abcjs breaks staff lines exactly where the ABC source breaks its lines. That
// is right for almost every tune — thesession and most folkwiki transcribers
// put four or eight bars on a line on purpose — but some sources write a whole
// tune on ONE line (folkwiki Musik/2906: sixteen bars and a repeat), which
// abcjs then draws as a single staff scaled down to fit the screen. The
// folkwiki site itself renders with abcm2ps, which wraps long lines on its own,
// so the same tune looks fine there.
//
// So: keep the author's layout unless a line is too long to read, and only
// then let abcjs re-flow the whole tune. Wrapping is all-or-nothing in abcjs
// (it ignores the source's line breaks once on), which is why this is not
// simply switched on for everything.

// More bars than this on one source line is treated as "not laid out".
// Deliberate eight-bar lines are common on both sites and come to 9-11 once a
// pickup or a first/second ending is counted, so the limit sits above that.
// Measured over the datasets (October 2026): 29 of 54,293 thesession settings
// and 183 of 8,484 folkwiki settings exceed it — Musik/2906 among them at 16.
export const MAX_BARS_PER_LINE = 12;

export const WRAP_OPTIONS = Object.freeze({
    // abcjs requires a staff width to wrap against; with `responsive:
    // 'resize'` the SVG is still scaled to the container afterwards.
    staffwidth: 740,
    wrap: Object.freeze({
        minSpacing: 1.8,
        maxSpacing: 2.7,
        preferredMeasuresPerLine: 4,
    }),
});

// A bar line in any of its spellings — |, ||, |], [|, |:, :|, ::, :||:, |1 —
// counted once each.
const BAR_RE = /\[\||:*\|[|\]:]*|::/g;

// Bars, not bar lines: `|: A | B | C | D :|` is four bars on five bar lines,
// so a line that opens with a bar line does not count that one.
export function barsPerLine(line) {
    const music = line
        .replace(/%.*$/, '') // comment
        .replace(/"[^"]*"/g, '') // chord symbols and annotations
        .replace(/![^!]*!/g, '') // decorations
        .replace(/\[[A-Za-z]:[^\]]*\]/g, '') // inline fields like [M:3/4]
        .trim();
    const barLines = (music.match(BAR_RE) || []).length;
    const opensWithBarLine = /^(\[\||:*\||::)/.test(music);
    return Math.max(0, barLines - (opensWithBarLine ? 1 : 0));
}

export function longestMusicLine(abcText) {
    let inBody = false;
    let longest = 0;
    for (const raw of (abcText || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!inBody) {
            if (/^K:/.test(line)) inBody = true;
            continue;
        }
        if (!line || line.startsWith('%') || /^[A-Za-z]:/.test(line)) continue;
        longest = Math.max(longest, barsPerLine(line));
    }
    return longest;
}

// Extra renderAbc options for this tune: {} to keep the source's layout.
export function layoutOptionsFor(abcText) {
    return longestMusicLine(abcText) > MAX_BARS_PER_LINE ? WRAP_OPTIONS : {};
}
