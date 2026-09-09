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
    async feedSinglePCMWindow(w) { calls.push(['feedSinglePCMWindow', w.length, w[0]]); },
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
    // Every constraints object getUserMedia was called with.
    gumConstraints: [],
    // What the fake device reports back from track.getSettings().
    appliedSettings: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000 },
};

class FakeTrack {
    constructor(applied = {}) {
        this.readyState = 'live';
        this.muted = false;
        // What a mute button actually sets. A disabled audio track emits
        // silence by spec, which is what silences the recording branch while
        // the capture the analysis reads carries on.
        this.enabled = true;
        this._listeners = {};
        this._applied = applied;
        this.clones = [];
    }
    // A cloned track shares the microphone but carries its OWN enabled flag.
    // That independence is the entire mechanism behind muting the recording
    // without muting detection.
    clone() {
        const copy = new FakeTrack(this._applied);
        copy.origin = this;
        this.clones.push(copy);
        return copy;
    }
    getSettings() { return this._applied; }
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
    constructor(tracks) {
        this.track = tracks && tracks.length ? tracks[0] : new FakeTrack(env.appliedSettings);
        this._tracks = tracks || [this.track];
    }
    getAudioTracks() { return this._tracks; }
    getTracks() { return this._tracks; }
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
    createMediaStreamSource(stream) {
        this.sourceTrack = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
        return { connect() {}, disconnect() {} };
    }
    async resume() { if (this.state !== 'closed') this.state = 'running'; }
    async close() { this.state = 'closed'; }

    // Test helper: push `count` buffers of audio through the graph.
    deliver(count = 1, value = 0.5) {
        if (!this.processor || !this.processor.onaudioprocess) return 0;
        if (this.state !== 'running') return 0;
        // A disabled MediaStreamTrack emits silence by spec. Modelling that is
        // load-bearing: without it a fake happily delivers real audio through a
        // muted capture track, and a test asserting "detection still hears
        // things" passes against code that silenced the wrong branch.
        const captureTrack = this.sourceTrack;
        const level = (captureTrack && captureTrack.enabled === false) ? 0 : value;
        const data = new Float32Array(this.processor.bufferSize).fill(level);
        for (let i = 0; i < count; i++) {
            this.processor.onaudioprocess({ inputBuffer: { getChannelData: () => data } });
        }
        return count;
    }
}

function installGlobals() {
    globalThis.AudioContext = FakeAudioContext;
    globalThis.MediaStream = FakeStream;
    globalThis.alert = () => {};
    // Node exposes a getter-only `navigator`, so plain assignment throws.
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: {
            mediaDevices: {
                async getUserMedia(constraints) {
                    env.gumConstraints.push(constraints);
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
    env.appliedSettings = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000 };
    env.gumConstraints = [];
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

await test('speech processing is asked to be off, as an ideal not a requirement', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);

    const asked = env.gumConstraints[0].audio;
    assert.equal(asked.echoCancellation, false);
    assert.equal(asked.noiseSuppression, false,
        'noise suppression is a speech-band gate and this app is feeding music to a pitch tracker');
    // Bare values are IDEAL per the spec. Sending them as `exact` would make
    // getUserMedia reject outright on a browser that cannot honour them, which
    // would trade damaged audio for no microphone at all.
    assert.equal(typeof asked.noiseSuppression, 'boolean', 'not an {exact: …} requirement');

    await mic.stopContinuous();
});

await test('what the device actually applied is recorded, not what was asked', async () => {
    // Asking and getting are different things, and iOS decides much of this
    // from its own audio session. Safari also reports a narrower set than
    // Chrome, so an absent key must read as "not reported", never as "off".
    const { mic } = await loadMic();
    // After loadMic, which resets the environment.
    env.appliedSettings = { echoCancellation: false, autoGainControl: true, sampleRate: 44100 };
    await mic.startContinuous(10);

    assert.equal(mic.appliedAudioSettings.autoGainControl, true,
        'the device overrode what was asked, and the app knows');
    assert.equal(mic.appliedAudioSettings.noiseSuppression, undefined,
        'a browser that will not say must not be shown as "off"');
    assert.equal(mic.appliedAudioSettings.sampleRate, 44100);

    await mic.stopContinuous();
});

await test('a capture delivering nothing but silence is re-acquired', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    env.contexts[0].deliver(2, 0.5);

    // The failure every other check misses. Another app takes the microphone
    // and the OS hands back a track that is still live, still UNMUTED, on a
    // running context, delivering digital silence for ever. Chunks keep
    // arriving on schedule, so the stall test is happy; track.muted is the flag
    // browsers set least reliably, so the fault test is happy too.
    env.contexts[0].deliver(20, 0);
    assert.equal(env.streams[0].track.muted, false, 'nothing declares itself broken');
    assert.equal(env.streams[0].track.readyState, 'live');

    // Not condemned straight away — a silent moment is not a dead microphone.
    assert.equal(await mic.ensureMicHealthy(), true);
    assert.equal(env.streams.length, 1, 'a short silence is left alone');

    // Sustained past the window, it is.
    mic._lastSoundAt = Date.now() - 11_000;
    assert.equal(await mic.ensureMicHealthy(), true);
    assert.equal(env.streams.length, 2, 'the capture is rebuilt');

    await mic.stopContinuous();
});

await test('real audio keeps a quiet capture alive', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);

    mic._lastSoundAt = Date.now() - 11_000;
    env.contexts[0].deliver(1, 0.5);   // one chunk with something in it

    assert.equal(await mic.ensureMicHealthy(), true);
    assert.equal(env.streams.length, 1,
        'a working microphone must never be torn down for being briefly quiet');

    await mic.stopContinuous();
});

await test('a freshly opened capture is given time before it is judged', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);

    // No buffer has been delivered yet at all. Judging the pipeline now would
    // condemn every capture at the moment it opens.
    assert.equal(await mic.ensureMicHealthy(), true);
    assert.equal(env.streams.length, 1);

    await mic.stopContinuous();
});

await test('a rebuild that does not restore sound waits longer before the next', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    env.contexts[0].deliver(2, 0.5);

    mic._lastSoundAt = Date.now() - 11_000;
    await mic.ensureMicHealthy();
    assert.equal(env.streams.length, 2);

    // Still silent after the rebuild. A fixed window would reacquire the
    // microphone every ten seconds for ever — a genuinely silent input (a
    // muted interface, a noise gate in a quiet room) would never settle.
    mic._lastSoundAt = Date.now() - 11_000;
    await mic.ensureMicHealthy();
    assert.equal(env.streams.length, 2, 'the window has escalated past ten seconds');

    mic._lastSoundAt = Date.now() - 31_000;
    await mic.ensureMicHealthy();
    assert.equal(env.streams.length, 3, 'and it does try again, later');

    await mic.stopContinuous();
});

await test('a microphone that stays silent through a rebuild is reported', async () => {
    const { mic, bus } = await loadMic();
    await mic.startContinuous(10);
    env.contexts[0].deliver(2, 0.5);

    // First detection: rebuild quietly, the user need not know.
    mic._lastSoundAt = Date.now() - 11_000;
    await mic.ensureMicHealthy();
    assert.ok(!bus.emitted.some(([name]) => name === 'micLost'), 'a self-healing blip stays quiet');

    // Still nothing after the rebuild. It is not going to fix itself, and an
    // app claiming to listen while it hears nothing is the whole problem.
    mic._lastSoundAt = Date.now() - 31_000;
    await mic.ensureMicHealthy();
    const lost = bus.emitted.find(([name]) => name === 'micLost');
    assert.ok(lost, 'the user is told the microphone is delivering nothing');
    assert.match(lost[1].reason, /no signal/);

    // And told when it comes back.
    env.contexts[env.contexts.length - 1].deliver(1, 0.5);
    assert.ok(bus.emitted.some(([name]) => name === 'micRecovered'));

    await mic.stopContinuous();
});

await test('silence is ignored while the tab is in the background', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    env.contexts[0].deliver(2, 0.5);

    setVisibility('hidden');
    mic._lastSoundAt = Date.now() - 61_000;

    // A hidden tab legitimately delivers nothing, and re-acquiring there would
    // either fail or take the microphone from whatever the user switched to.
    assert.equal(await mic.ensureMicHealthy(), true);
    assert.equal(env.streams.length, 1);

    setVisibility('visible');
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
// --- muting the recording without muting detection ---------------------------
//
// The whole point of the mute button is that it is NOT a pause: the microphone
// stays open, the analysis loop keeps getting audio, and tunes keep being
// recognised — only what reaches the recorder is silenced. Every test here
// exists to hold that line, because the obvious implementations (stopping the
// track, disabling the capture track itself) all break detection silently.

console.log('\nmic.js — the muteable recording branch');

await test('the recorder gets a CLONE, not the capture stream itself', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    assert.notEqual(mic.recordingStream, mic.micStream);
    assert.equal(mic.recordingMuteSupported, true);
    await mic.stopContinuous();
});

await test('muting silences the recording branch ONLY', async () => {
    // The failure this forbids: disabling the capture track, which silences
    // the ScriptProcessor too and stops tune detection dead — while the UI
    // still says "Listening".
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    const captureTrack = mic.micStream.getAudioTracks()[0];
    const recordTrack = mic.recordingStream.getAudioTracks()[0];

    mic.setRecordingMuted(true);
    assert.equal(recordTrack.enabled, false, 'the recording branch is silenced');
    assert.equal(captureTrack.enabled, true, 'capture is untouched, so detection continues');
    await mic.stopContinuous();
});

await test('detection keeps receiving audio while muted', async () => {
    // Directly: the analysis path is fed by the AudioContext, and muting must
    // not interrupt a single buffer of it.
    const { mic, backend } = await loadMic();
    await mic.startRecording();
    const before = backend.calls.filter(c => c[0] === 'feedSinglePCMWindow').length;
    mic.setRecordingMuted(true);
    env.contexts[env.contexts.length - 1].deliver(4);
    const fed = backend.calls.filter(c => c[0] === 'feedSinglePCMWindow');
    assert.equal(fed.length - before, 4, 'every buffer still reached the backend');
    // And carrying real audio, not silence — the sample value is what
    // distinguishes "detection continued" from "detection was silenced too".
    assert.ok(fed.slice(before).every(c => c[2] !== 0),
        'the analysis path is still hearing the room');
    await mic.stopRecording();
});

await test('unmuting restores the recording branch', async () => {
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    const recordTrack = mic.recordingStream.getAudioTracks()[0];
    mic.setRecordingMuted(true);
    mic.setRecordingMuted(false);
    assert.equal(recordTrack.enabled, true);
    assert.equal(mic.recordingMuted, false);
    await mic.stopContinuous();
});

await test('a microphone reacquired while muted comes back MUTED', async () => {
    // The one failure here that cannot be undone. If a recovery silently
    // un-mutes, the app records a conversation the user believes is private,
    // and they have no way to know it happened.
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    mic.setRecordingMuted(true);

    env.streams[env.streams.length - 1].track.endFromOs();
    await mic.ensureMicHealthy();

    assert.equal(mic.recordingMuted, true, 'the mute survived the rebuild');
    assert.equal(mic.recordingStream.getAudioTracks()[0].enabled, false);
    await mic.stopContinuous();
});

await test('the clone is stopped on teardown', async () => {
    // The clone holds its own reference to the microphone, so leaving it
    // running keeps the OS recording indicator lit after the session stops.
    const { mic } = await loadMic();
    await mic.startContinuous(10);
    const recordTrack = mic.recordingStream.getAudioTracks()[0];
    await mic.stopContinuous();
    assert.equal(recordTrack.readyState, 'ended');
});

await test('a browser that cannot clone loses the CONTROL, not the recording', async () => {
    const { mic } = await loadMic();
    const saved = FakeTrack.prototype.clone;
    delete FakeTrack.prototype.clone;
    try {
        await mic.startContinuous(10);
        assert.equal(mic.recordingMuteSupported, false);
        assert.equal(mic.setRecordingMuted(true), false, 'never claims to have muted');
        assert.ok(mic.recordingStream, 'recording still has a stream to use');
        assert.equal(mic.recordingStream, mic.micStream);
    } finally {
        FakeTrack.prototype.clone = saved;
        await mic.stopContinuous();
    }
});

await rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
