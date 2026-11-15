import assert from 'node:assert/strict';
import { SetScoreFollower } from '../src/js/setScoreFollower.mjs';
function contour(seed, alphabet) {
    let x = seed;
    return Array.from({ length: 160 }, () => {
        x = (x * 1664525 + 1013904223) >>> 0;
        return alphabet[x % alphabet.length];
    }).join('');
}
const a = contour(17, 'opqrstuvwxyz');
const b = contour(43, 'abcdefghijk');
const c = contour(87, 'ABCDEFGHJKLM');
const entries = [a, b, c].map((value, i) => ({ id: String(i), contour: value }));
const timeline = () => ({ totalMs: 32000, lineCount: 4,
    events: Array.from({ length: 160 }, (_, i) => ({ milliseconds: i * 200, line: Math.floor(i / 40) })),
});
const step = (f, notes, at, now = at) => f.update({
    position: { contour: notes, readAt: at, windowSeconds: notes.length / 8 }, nowMs: now, timeline,
});
const f = new SetScoreFollower(entries);
let result = step(f, a.slice(20, 52), 1000);
assert.equal(result.index, 0);
assert.ok(Number.isInteger(result.line), 'same line tracker locates the current tune');
assert.equal(step(f, b.slice(0, 32), 2000).index, 0, 'one next-tune window cannot move the page');
assert.equal(step(f, b.slice(0, 32), 2000).index, 0, 'reprojection of one window is not a second confirmation');
result = step(f, b.slice(16, 48), 3000);
assert.equal(result.index, 1);
assert.equal(result.changed, true);
assert.equal(step(f, b.slice(32, 64), 4000).index, 1, 'repeating current tune keeps the same entry');
assert.equal(step(f, c.slice(0, 32), 5000).index, 1);
assert.equal(step(f, c.slice(16, 48), 6000).index, 2);
assert.equal(step(f, a.slice(0, 32), 7000).index, 2, 'last tune never wraps automatically');
assert.equal(f.select(0, 7000), true);
assert.equal(step(f, a.slice(0, 32), 7000).line, null, 'manual cue discards the old window');
assert.equal(f.select(99), false);

const transient = new SetScoreFollower(entries);
step(transient, b.slice(0, 32), 1000);
step(transient, a.slice(0, 32), 2000);
assert.equal(step(transient, b.slice(16, 48), 3000).index, 0, 'current-tune evidence clears a transient next match');
assert.equal(step(transient, b.slice(32, 64), 4000).index, 1);
const latestWindow = transient._lineFollower.track.window;
step(transient, a.slice(0, 32), 2000, 4000);
assert.equal(transient._lineFollower.track.window, latestWindow, 'late analysis cannot rewind the tracker');

const identical = new SetScoreFollower([{ id: 'a', contour: a }, { id: 'again', contour: a }]);
for (let i = 0; i < 4; i++) assert.equal(step(identical, a.slice(i * 8, i * 8 + 32), (i + 1) * 1000).index, 0);
assert.equal(identical.select(1), true, 'explicit cue distinguishes identical occurrences');
const skip = new SetScoreFollower(entries);
for (let i = 0; i < 3; i++) assert.equal(step(skip, c.slice(i * 8, i * 8 + 32), (i + 1) * 1000).index, 0, 'does not skip over the next tune');
const stale = new SetScoreFollower(entries);
step(stale, b.slice(0, 32), 1000, 20000);
assert.equal(step(stale, b.slice(16, 48), 2000, 21000).index, 0, 'stale windows cannot advance');
const shared = new SetScoreFollower([{ id: 'a', contour: a }, { id: 'shared', contour: a + b }]);
for (let i = 0; i < 3; i++) assert.equal(step(shared, a.slice(i * 8, i * 8 + 32), (i + 1) * 1000).index, 0, 'shared phrases remain ambiguous');
const missing = new SetScoreFollower([{ id: 'a', contour: a }, { id: 'none', contour: '' }]);
assert.equal(step(missing, b.slice(0, 32), 1000).index, 0);
assert.equal(step(missing, b.slice(16, 48), 2000).index, 0);
console.log('Set follow tracks rows, confirms adjacent transitions and holds on repeats, shared phrases, stale or ambiguous evidence.');
