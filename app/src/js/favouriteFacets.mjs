// Tune-type and key filters for the Favourites list.
//
// Both come straight off the stored setting (`dance`, `mode`), so a favourite
// carries them even when the tune index is not loaded. Pure, so the rules can
// be tested without a Vue runtime.
//
// The combination rule differs from tags on purpose. Tags are AND, because a
// favourite can carry several and "has both" is the useful question. A setting
// has exactly ONE type and ONE key, so AND within either would filter to
// nothing the moment a second chip is chosen — "Reel" + "Jig" means "reels or
// jigs". Across the two it is AND again: "Jig" + "D major" is D major jigs.

const TONIC_ORDER = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const MODE_ORDER = ['major', 'minor', 'dorian', 'mixolydian', 'lydian', 'phrygian', 'locrian', 'aeolian', 'ionian'];

export function tuneTypeOf(item) {
    const setting = item && item.result && item.result.setting;
    const dance = setting && typeof setting.dance === 'string' ? setting.dance.trim() : '';
    return dance || null;
}

export function tuneKeyOf(item) {
    const setting = item && item.result && item.result.setting;
    const mode = setting && typeof setting.mode === 'string' ? setting.mode.trim() : '';
    return mode || null;
}

// 'Dmajor' -> { tonic: 'D', mode: 'major' }; 'F#minor' -> { tonic: 'F#', ... }.
// Anything unrecognised is kept whole as the tonic, so it still gets a chip.
export function parseKey(key) {
    const m = /^([A-Ga-g])([#b♯♭]?)(.*)$/.exec(key || '');
    if (!m) return { tonic: key || '', mode: '' };
    const accidental = m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2];
    return { tonic: m[1].toUpperCase() + accidental, mode: m[3].trim().toLowerCase() };
}

export function keyLabel(key) {
    const { tonic, mode } = parseKey(key);
    const shown = tonic.replace('#', '♯').replace(/^([A-G])b$/, '$1♭');
    return mode ? `${shown} ${mode}` : shown;
}

export function typeLabel(type) {
    return type ? type.charAt(0).toUpperCase() + type.slice(1) : '';
}

// Musical order rather than alphabetical: C, C♯, D♭... then by mode, major first.
export function compareKeys(a, b) {
    const pa = parseKey(a);
    const pb = parseKey(b);
    const letter = t => TONIC_ORDER.indexOf(t.charAt(0));
    const shift = t => (t.endsWith('b') ? -1 : t.endsWith('#') ? 1 : 0);
    const byLetter = letter(pa.tonic) - letter(pb.tonic);
    if (byLetter) return byLetter;
    const byShift = shift(pa.tonic) - shift(pb.tonic);
    if (byShift) return byShift;
    const mi = m => { const i = MODE_ORDER.indexOf(m); return i < 0 ? MODE_ORDER.length : i; };
    return (mi(pa.mode) - mi(pb.mode)) || pa.mode.localeCompare(pb.mode);
}

// [{ value, label, count }] for every value present, so no chip ever filters
// to nothing. Types are ordered by how many favourites they cover; keys in
// musical order, since a list of keys is scanned by name, not by size.
export function facetOptions(items, getValue, { label, compare } = {}) {
    const counts = new Map();
    for (const item of items) {
        const value = getValue(item);
        if (!value) continue;
        counts.set(value, (counts.get(value) || 0) + 1);
    }
    const options = [...counts.entries()].map(([value, count]) => ({
        value,
        label: label ? label(value) : value,
        count,
    }));
    options.sort(compare
        ? (a, b) => compare(a.value, b.value)
        : (a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return options;
}

export function typeOptions(items) {
    return facetOptions(items, tuneTypeOf, { label: typeLabel });
}

export function keyOptions(items) {
    return facetOptions(items, tuneKeyOf, { label: keyLabel, compare: compareKeys });
}

// OR within a facet, AND across facets; an empty selection does not filter.
export function matchesFacets(item, activeTypes, activeKeys) {
    if (activeTypes && activeTypes.length > 0 && !activeTypes.includes(tuneTypeOf(item))) return false;
    if (activeKeys && activeKeys.length > 0 && !activeKeys.includes(tuneKeyOf(item))) return false;
    return true;
}
