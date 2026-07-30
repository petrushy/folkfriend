// Unit tests for microphone capture health and recovery.
//
// Run with:  node app/test/mic.test.mjs
//
// The failure these cover is "switch to another app and back, and the app
// silently stops hearing anything". There are two independent causes with the
// same symptom — a suspended AudioContext, and a MediaStreamTrack that the OS
// ended or muted when it handed the microphone to another app — and only the
// first is fixed by resuming. mic.js is loaded from source with its imports
// rewritten to in-memory fakes, and the Web Audio / getUserMedia surface it
// touches is faked here, so no browser is required.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src', 'services');
const tmpDir = path.join(here, '.tmp-mic');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`);
    }
}

// --- fake modules ---------------------------------------------------------

const fakeBackendSource = `
export const calls = [];
export default {
    async setSampleRate(rate) { calls.push(['setSampleRate', rate]); },
    async feedSinglePCMWindow(w) { calls.push(['feedSinglePCMWindow', w.length]); },
};
`;

const fakeEventBusSource = `
export const emitted = [];
export default { $emit(name, detail) { emitted.push([name, detail]); } };
`;

const fakeStoreSource = `
export const searchStates = { READY: 'ready', RECORDING: 'recording', WORKING: 'working', LISTENING: 'listening' };
const store = {
    searchStates,
    searchState: searchStates.READY,
    state: {},
    userSettings: { autoGainControl: false, recordingTimeLimitSecs: 10 },
    setSearchState(s) { this.searchState = s; },
    isReady() { return this.searchState === searchStates.READY; },
    isRecording() { return this.searchState === searchStates.RECORDING; },
    isWorking() { return this.searchState === searchStates.WORKING; },
    isListening() { return this.searchState === searchStates.LISTENING; },
};
export default store;
`;

// --- fake browser audio surface -------------------------------------------

const env = {
    streams: [],
    contexts: [],
    // Set to an Error to make the next getUserMedia call reject.
    gumFailure: null,
    // Extra delay (ms) before getUserMedia resolves, for racing tests.
    gumDelayMs: 0,
    visibility: 'visible',
    visibilityListeners: [],
};

class FakeTrack {
    constructor() {
        this.readyState = 'live';
        this.muted = false;
        this._listeners = {};
    }
    addEventListener(name, fn) {
        (this._listeners[name] = this._listeners[name] || []).push(fn);
    }
    stop() { this.readyState = 'ended'; }
    // Simulate the OS handing the microphone to another app.
    endFromOs() {
        this.readyState = 'ended';
        (this._listeners['ended'] || []).forEach(fn => fn());
    }
    muteFromOs() {
        this.muted = true;
        (this._listeners['mute'] || []).forEach(fn => fn());
    }
}

class FakeStream {
    constructor() { this.track = new FakeTrack(); }
    getAudioTracks() { return [this.track]; }
    getTracks() { return [this.track]; }
}

class FakeAudioContext {
    constructor() {
        this.state = 'running';
        this.sampleRate = 48000;
        this.destination = {};
        this.processor = null;
        env.contexts.push(this);
    }
    createScriptProcessor(bufferSize) {
        this.processor = { bufferSize, onaudioprocess: null, connect() {}, disconnect() {} };
        return this.processor;
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async resume() { if (this.state !== 'closed') this.state = 'running'; }
    async close() { this.state = 'closed'; }

    // Test helper: push `count` buffers of audio through the graph.
    deliver(count = 1, value = 0.5) {
        if (!this.processor || !this.processor.onaudioprocess) return 0;
        if (this.state !== 'running') return 0;
        const data = new Float32Array(this.processor.bufferSize).fill(value);
        for (let i = 0; i < count; i++) {
            this.processor.onaudioprocess({ inputBuffer: { getChannelData: () => data } });
        }
        return count;
    }
}

function installGlobals() {
    globalThis.AudioContext = FakeAudioContext;
    globalThis.alert = () => {};
    // Node exposes a getter-only `navigator`, so plain assignment throws.
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: {
            mediaDevices: {
                async getUserMedia() {
                    if (env.gumDelayMs) await new Promise(r => setTimeout(r, env.gumDelayMs));
                    if (env.gumFailure) throw env.gumFailure;
                    const stream = new FakeStream();
                    env.streams.push(stream);
                    return stream;
                },
            },
        },
    });
    globalThis.document = {
        get visibilityState() { return env.visibility; },
        addEventListener(name, fn) {
            if (name === 'visibilitychange') env.visibilityListeners.push(fn);
        },
        removeEventListener() {},
    };
}

function resetEnv() {
    env.streams = [];
    env.contexts = [];
    env.gumFailure = null;
    env.gumDelayMs = 0;
    env.visibility = 'visible';
    env.visibilityListeners = [];
}

function setVisibility(state) {
    env.visibility = state;
    env.visibilityListeners.forEach(fn => fn());
}

// --- module loading -------------------------------------------------------

// Each load gets its own copy of every fake under a unique filename. A query
// string alone would not do: mic.js imports its dependencies by bare path, so
// they would be shared across loads and state would leak between tests.
let loadCounter = 0;

async function loadMic() {
    resetEnv();
    installGlobals();

    const n = ++loadCounter;
    const names = {
        backend: `fake-backend-${n}.mjs`,
        bus: `fake-eventbus-${n}.mjs`,
        store: `fake-store-${n}.mjs`,
    };
    await writeFile(path.join(tmpDir, names.backend), fakeBackendSource);
    await writeFile(path.join(tmpDir, names.bus), fakeEventBusSource);
    await writeFile(path.join(tmpDir, names.store), fakeStoreSource);

    let source = await readFile(path.join(srcDir, 'mic.js'), 'utf8');
    const replacements = [
        ["from '@/services/backend.js'", `from './${names.backend}'`],
        ["from '@/eventBus.js'", `from './${names.bus}'`],
        ["from './store'", `from './${names.store}'`],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in mic.js`);
        source = source.split(from).join(to);
    }
    const out = path.join(tmpDir, `mic-${n}.mjs`);
    await writeFile(out, source);

    const mod = await import(out);
    const backend = await import(path.join(tmpDir, names.backend));
    const bus = await import(path.join(tmpDir, names.bus));
    const store = await import(path.join(tmpDir, names.store));
    return { mic: mod.default, backend, bus, store: store.default };
}

const openContexts = () => env.contexts.filter(c => c.state !== 'closed');
const liveStreams = () => env.streams.filter(s => s.track.readyState === 'live');
const emittedNames = (bus) => bus.emitted.map(e => e[0]);

console.log('\nmicService capture health');

await rm(tmpDir, { recursive: true, force: true });
await mkdir(tmpDir, { recursive: true });

// Keep the expected console noise out of the test output.
console.debug = () => {};
const realWarn = console.warn;
console.warn = () => {};

await test('a healthy capture is left completely alone', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    env.contexts[0].deliver(3);

    assert.equal(await mic.ensureMicHealthy(), true);
    assert.equal(env.streams.length, 1, 'must not re-acquire a working microphone');
    assert.equal(env.contexts.length, 1);

    await mic.stopContinuous();
});

await test('no capture open: health check is a no-op and never opens the mic', async () => {
    const { mic } = await loadMic();
    assert.equal(await mic.ensureMicHealthy(), true);
    assert.equal(env.streams.length, 0);
});

await test('a track ended by another app is re-acquired', async () => {
    const { mic, bus } = await loadMic();
    await mic.startContinuous(10);
    const first = env.streams[0];
    env.contexts[0].deliver(2);

    // iOS ends our track when it gives the microphone to another app.
    first.track.readyState = 'ended';

    assert.equal(await mic.ensureMicHealthy(), true);
    assert.equal(env.streams.length, 2, 'expected a fresh getUserMedia');
    assert.equal(liveStreams().length, 1);
    assert.equal(openContexts().length, 1, 'the dead AudioContext must be closed');
    assert.ok(emittedNames(bus).includes('micRecovered'));

    // ...and the rebuilt pipeline actually delivers audio again.
    const before = mic.getContinuousAudio().length;
    openContexts()[0].deliver(2);
    assert.ok(mic.getContinuousAudio().length > before, 'new audio must flow after recovery');

    await mic.stopContinuous();
});

await test('a track muted by another app is re-acquired', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    env.contexts[0].deliver(2);

    // Coming back from a call, iOS often leaves the track live but muted —
    // onaudioprocess keeps firing and delivers silence forever.
    env.streams[0].track.muted = true;

    assert.equal(await mic.ensureMicHealthy(), true);
    assert.equal(env.streams.length, 2);
    assert.equal(env.streams[1].track.muted, false);

    await mic.stopContinuous();
});

await test('the track "ended" event triggers recovery on its own', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    env.streams[0].track.endFromOs();

    // The listener kicks off an async recovery; give it a turn to finish.
    await mic.ensureMicHealthy();
    assert.equal(liveStreams().length, 1);

    await mic.stopContinuous();
});

await test('a merely suspended context is resumed, not re-acquired', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    const ctx = env.contexts[0];
    ctx.deliver(2);

    // Backgrounding suspends the context; the track is still perfectly good.
    ctx.state = 'suspended';
    // Pretend enough time passed with no buffers for the stall check to trip.
    mic._lastChunkAt = Date.now() - 60_000;
    // Audio starts flowing again shortly after the resume, as it should.
    setTimeout(() => ctx.deliver(1), 40);

    assert.equal(await mic.ensureMicHealthy(), true);
    assert.equal(ctx.state, 'running');
    assert.equal(env.streams.length, 1, 'resuming was enough — must not re-acquire');

    await mic.stopContinuous();
});

await test('a live-but-silent capture is re-acquired after the grace period', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    env.contexts[0].deliver(2);

    // Everything *claims* to be fine — this is the case resumeIfSuspended
    // alone could never detect.
    assert.equal(env.contexts[0].state, 'running');
    assert.equal(env.streams[0].track.readyState, 'live');
    assert.equal(env.streams[0].track.muted, false);
    mic._lastChunkAt = Date.now() - 60_000;

    assert.equal(await mic.ensureMicHealthy(), true);
    assert.equal(env.streams.length, 2, 'silent capture must be rebuilt');

    await mic.stopContinuous();
});

await test('audio captured before the loss is preserved across recovery', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    env.contexts[0].deliver(5);
    const before = mic.getContinuousAudio().length;
    assert.equal(before, 5 * 1024);

    env.streams[0].track.readyState = 'ended';
    await mic.ensureMicHealthy();

    assert.equal(mic.getContinuousAudio().length, before,
        'the ring buffer is the analysis window — recovery must not empty it');

    await mic.stopContinuous();
});

await test('recovery failure emits micLost once and keeps retrying', async () => {
    const { mic, bus } = await loadMic();
    await mic.startContinuous(10);
    env.streams[0].track.readyState = 'ended';

    env.gumFailure = new Error('NotAllowedError');
    assert.equal(await mic.ensureMicHealthy(), false);
    assert.equal(emittedNames(bus).filter(n => n === 'micLost').length, 1);
    assert.equal(liveStreams().length, 0, 'a failed attempt must not leak a stream');

    // Backoff: an immediate retry must not hammer getUserMedia.
    assert.ok(mic._nextRecoveryAt > Date.now(), 'a failed attempt must back off');
    const attempts = env.streams.length;
    assert.equal(await mic.ensureMicHealthy(), false);
    assert.equal(env.streams.length, attempts, 'backoff must suppress the retry');

    // Once the backoff elapses we try again — and must not spam the user with
    // a second snackbar for the same outage.
    mic._nextRecoveryAt = 0;
    assert.equal(await mic.ensureMicHealthy(), false);
    assert.equal(emittedNames(bus).filter(n => n === 'micLost').length, 1);

    // The capture is still "wanted", so once the other app lets go we recover.
    env.gumFailure = null;
    mic._nextRecoveryAt = 0;
    assert.equal(await mic.ensureMicHealthy(), true);
    assert.ok(emittedNames(bus).includes('micRecovered'));
    assert.equal(mic._nextRecoveryAt, 0, 'backoff must reset on success');

    await mic.stopContinuous();
});

await test('recovery is not attempted while the tab is in the background', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);

    setVisibility('hidden');
    env.streams[0].track.endFromOs();   // happens *because* we were backgrounded

    // The watchdog must not grab the microphone back from whatever the user
    // switched to. Nothing here should re-acquire.
    await new Promise(r => setTimeout(r, 50));
    assert.equal(env.streams.length, 1);

    await mic.stopContinuous();
});

await test('returning to the foreground repairs the capture', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    env.contexts[0].deliver(2);

    // Background: context suspends and the OS takes the track away.
    setVisibility('hidden');
    env.contexts[0].state = 'suspended';
    env.streams[0].track.readyState = 'ended';
    await new Promise(r => setTimeout(r, 20));
    assert.equal(env.streams.length, 1, 'nothing happens while hidden');

    // Foreground again: this is the moment the user says "it stopped working".
    setVisibility('visible');
    await mic.ensureMicHealthy();

    assert.equal(env.streams.length, 2);
    assert.equal(liveStreams().length, 1);
    assert.equal(openContexts().length, 1);
    assert.equal(openContexts()[0].state, 'running');

    await mic.stopContinuous();
});

await test('manual recording recovers and keeps feeding the backend', async () => {
    const { mic, backend } = await loadMic();
    await mic.startRecording();
    env.contexts[0].deliver(3);
    assert.equal(backend.calls.filter(c => c[0] === 'feedSinglePCMWindow').length, 3);

    env.streams[0].track.readyState = 'ended';
    assert.equal(await mic.ensureMicHealthy(), true);
    assert.equal(env.streams.length, 2, 'expected a fresh getUserMedia');
    assert.equal(openContexts().length, 1);

    openContexts()[0].deliver(2);
    assert.equal(backend.calls.filter(c => c[0] === 'feedSinglePCMWindow').length, 5,
        'the rebuilt pipeline must keep feeding the same recording buffer');

    await mic.stopRecording();
    assert.equal(mic._mode, null);
});

await test('stopping mid-recovery leaves no microphone open', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    env.streams[0].track.readyState = 'ended';

    // Recovery is in flight (getUserMedia is slow) when the user stops.
    env.gumDelayMs = 60;
    const recovery = mic.ensureMicHealthy();
    await new Promise(r => setTimeout(r, 10));
    await mic.stopContinuous();
    await recovery;

    assert.equal(mic._mode, null);
    assert.equal(liveStreams().length, 0, 'no orphaned microphone may survive a stop');
    assert.equal(openContexts().length, 0);
});

await test('stopping clears state so the next session starts clean', async () => {
    const { mic, store } = await loadMic();
    await mic.startContinuous(10);
    env.contexts[0].deliver(4);
    await mic.stopContinuous();

    assert.equal(mic._mode, null);
    assert.equal(mic.getContinuousAudio().length, 0);
    assert.equal(store.searchState, store.searchStates.READY);
    assert.equal(openContexts().length, 0);
    assert.equal(liveStreams().length, 0);

    // And a health check after stopping stays a no-op.
    assert.equal(await mic.ensureMicHealthy(), true);
    assert.equal(env.streams.length, 1);
});

console.warn = realWarn;
await rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
