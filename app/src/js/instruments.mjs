// Written pitch relative to sounding pitch, in semitones, by the instrument's
// key. Tunes are shown as written in the index (what a D whistle or fiddle
// plays), so a whistle in C reads a tone higher than it sounds and one in G or
// A reads lower. B-flat clarinet/trumpet reads a tone higher too, hence
// "C or B♭". Shared by the Tune view's score menu and global Settings.
export const INSTRUMENT_PRESETS = [
    ['Default (as written)', 0],
    ['C or B♭', 2],
    ['E♭', 9],
    ['F', 7],
    ['G', -5],
    ['A', -7],
];

// Select items for the current value; an offset not in the list (e.g. from a
// backup) is kept visible rather than silently replaced.
export function instrumentItems(current) {
    const items = INSTRUMENT_PRESETS.map(([text, value]) => ({ text, value }));
    if (!items.some(i => i.value === current)) {
        items.push({ text: `Custom (${current > 0 ? '+' : ''}${current} semitones)`, value: current });
    }
    return items;
}
