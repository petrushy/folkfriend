// Comparing tune NAMES, for deciding that two different tune ids are the same
// tune — a thesession setting and a Norbeck copy, say. Tune ids never match
// across datasets (each dataset has its own id range, and the worker refuses
// a collision), so the name is the only bridge there is.
//
// Deliberately forgiving about spelling and deliberately strict about
// generic names: "Cooley's Reel", "Cooley’s" and "Cooleys" are one tune, but
// an alias that is only a tune type ("Polska", "Reel") says nothing about
// which tune it is and is never used to match.

// A trailing tune type is dropped: "Cooley's Reel" is "Cooley's" on
// thesession. Longest first, so "slip jig" is not read as "jig".
const TUNE_TYPES = [
    'slangpolska', 'slip jig', 'hop jig', 'single jig', 'double jig',
    'hornpipe', 'strathspey', 'barndance', 'mazurka', 'polska', 'schottis',
    'schottische', 'ganglat', 'marsch', 'march', 'waltz', 'hambo', 'polka',
    'slide', 'reel', 'jig', 'vals', 'air', 'set dance', 'polonas',
];
const TYPE_SUFFIX = new RegExp(` (${TUNE_TYPES.join('|')})$`);
const TYPE_ONLY = new RegExp(`^(${TUNE_TYPES.join('|')})$`);

export function normaliseTuneName(name) {
    let s = String(name || '')
        .replace(/[´’‘`]/g, "'")
        .toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/'/g, '')
        .replace(/[^a-z0-9, ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    // The index stores "banshee, the"; people write "The Banshee".
    s = s.replace(/^the /, '').replace(/,\s*the$/, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    const stripped = s.replace(TYPE_SUFFIX, '').trim();
    // "The Reel" must not collapse to nothing.
    return stripped || s;
}

// The normalised names worth matching on: duplicates removed, and nothing
// too short or too generic to identify a tune.
export function matchableNames(names) {
    const out = new Set();
    for (const n of names || []) {
        const k = normaliseTuneName(n);
        if (k.length < 3 || TYPE_ONLY.test(k)) continue;
        out.add(k);
    }
    return [...out];
}
