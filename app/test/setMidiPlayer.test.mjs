import assert from 'node:assert/strict';
import { SetMidiPlayer, repetitionsFor } from '../src/js/setMidiPlayer.mjs';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function harness(counts, prepareOverride = null) {
    const events = [], handles = [], states = [];
    const player = new SetMidiPlayer({ entries: counts.map(repetitions => ({ repetitions })),
        prepare: async index => {
            events.push(['prepare', index]);
            if (prepareOverride) await prepareOverride(index);
            const handle = { callback: null, disposed: 0,
                start(callback) { this.callback = callback; events.push(['start', index]); },
                pause() { events.push(['pause', index]); },
                resume(callback) { this.callback = callback; events.push(['resume', index]); },
                dispose() { this.disposed++; events.push(['dispose', index]); },
                progress() { return { line: 0 }; },
            };
            handles[index] = handle; return handle;
        }, onState: state => states.push(state),
    });
    return { player, handles, events, states };
}
assert.equal(repetitionsFor({}), 2);
for (const repetitions of [0, -1, 1.5, 100, null, '', NaN]) assert.throws(() => repetitionsFor({ repetitions }), /whole number/);
const h = harness([2, 1, 3]);
await h.player.start(); await settle();
assert.deepEqual(h.events.filter(e => e[0] === 'prepare').map(e => e[1]), [0, 1], 'only current and next are primed');
h.handles[0].callback(); await settle();
assert.equal(h.player.index, 0); assert.equal(h.player.repetition, 2);
h.handles[0].callback(); await settle();
assert.equal(h.player.index, 1); assert.equal(h.player.repetition, 1);
h.handles[1].callback(); await settle();
for (let i = 0; i < 3; i++) { h.handles[2].callback(); await settle(); }
assert.deepEqual(h.events.filter(e => e[0] === 'start').map(e => e[1]), [0, 0, 1, 2, 2, 2]);
assert.equal(h.player.status, 'complete');
assert.ok(h.handles.every(handle => handle.disposed === 1));

const pause = harness([2]); await pause.player.start();
const beforePause = pause.handles[0].callback;
pause.player.pause(); beforePause();
assert.equal(pause.player.status, 'paused'); assert.equal(pause.player.repetition, 1);
pause.player.resume(); beforePause();
assert.equal(pause.player.repetition, 1, 'a stale end event cannot advance after resume');
pause.handles[0].callback(); await settle();
assert.equal(pause.player.repetition, 2);
const late = pause.handles[0].callback; pause.player.stop(); late(); await settle();
assert.equal(pause.player.status, 'idle');
assert.equal(pause.events.filter(e => e[0] === 'start').length, 2);

let release;
const delayed = harness([2], () => new Promise(resolve => { release = resolve; }));
const starting = delayed.player.start(); await settle(); delayed.player.stop(); release(); await starting;
assert.equal(delayed.player.status, 'idle');
assert.equal(delayed.events.filter(e => e[0] === 'start').length, 0);
assert.equal(delayed.handles[0].disposed, 1, 'stopped preparation disposes its late buffer');
const failure = harness([1, 1], async index => { if (index === 1) throw new Error('sample unavailable'); });
await failure.player.start(); await settle(); failure.handles[0].callback(); await settle();
assert.equal(failure.player.status, 'error');
assert.match(failure.states.at(-1).error, /Tune 2: sample unavailable/);
const stopped = harness([1, 1]); await stopped.player.start(); await settle(); stopped.player.stop();
assert.ok(stopped.handles.every(handle => handle.disposed === 1), 'stopping also disposes the primed next tune');
console.log('Whole-set MIDI playback counts runs, advances in order, pauses, cancels stale work and bounds primed buffers.');
