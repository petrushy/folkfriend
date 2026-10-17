// The key of the player's instrument, named the way whistles are: a D whistle
// plays a tune as written, and an instrument in key K sounds K where a D one
// sounds D, so to sound the tune's own key it must read it shifted by D - K.
// That is an octave-ambiguous number; the nearest to zero is used since only
// the pitch class matters for reading.
//
//   C  -> +2   (a tone lower than D, so read a tone higher)
//   B♭ -> +4
//   G  -> -5   (a fourth higher than D, so read a fourth lower)
//
// Keys are listed from the default outwards, flat and sharp spellings as
// players say them.
export const INSTRUMENT_PRESETS = [
    ['D (default, as written)', 0],
    ['C♯', 1],
    ['C', 2],
    ['B', 3],
    ['B♭', 4],
    ['A', 5],
    ['A♭', 6],
    ['G', -5],
    ['F♯', -4],
    ['F', -3],
    ['E', -2],
    ['E♭', -1],
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
