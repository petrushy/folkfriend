// Unit tests for recording a session's audio alongside its tune list.
//
// Run with:  node app/test/sessionAudio.test.mjs
//
// Three things here are worth pinning, and none of them is "does it record".
//
//  1. THE STORE NEVER LEAVES A HALF-PLAYABLE RECORDING. An append writes the
//     payload before the manifest that names it, and a delete drops the
//     manifest before the segments — so an interruption at any point costs
//     wasted space (which reclaimOrphans() gets back), never a manifest
//     pointing at audio that is not there. Same discipline as the tune index
//     store, for the same reason: the failure is invisible until the user
//     tries to play it back, which is long after they could do anything.
//
//  2. THE AUDIO CLOCK AGREES WITH THE RECORDING. Detections are stamped with
//     it, so if it counts time the recorder did not capture — a pause, a
//     microphone the OS took away — every marker after that point is shifted
//     and the ▶ on a tune plays the wrong tune. This is the whole reason the
//     clock is not liveAnalysis's elapsedSeconds.
//
//  3. RUNNING OUT OF STORAGE STOPS THE RECORDING, NOT THE SESSION. Audio is
//     the expendable half. The tune list must survive a full disk, and what
//     has already been recorded must survive it intact.
//
// The store and the recorder are loaded from source with their imports
// rewritten to in-memory fakes, following mic.test.mjs and liveSessions.test.mjs.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadSessionAnalysisModule, sessionAnalysisTmpDir } from './helpers/loadSessionAnalysis.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-session-audio');

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
        console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n      ') : e}`);
    }
}

// --- fakes ------------------------------------------------------------------

const FAKE_IDB = `
export const __db = new Map();
export const __failWrites = new Set();
export const __failDeletes = new Set();
// Read faults matter as much as write faults here: the orphan sweep feeds its
// reads straight into a delete, so a read that fails must never look like a
// manifest that does not exist.
export const __failReads = new Set();
export function __reset() {
    __db.clear(); __failWrites.clear(); __failDeletes.clear();
    __failReads.clear(); __slowWrites.clear();
}
export async function get(key) {
    if (__failReads.has(key)) throw new Error('read failed');
    return __db.get(key);
}
// Keys whose write takes a REAL tick, so the payload-then-manifest window is
// wide enough for a sweep to land inside it. Without this the two writes finish
// in one microtask drain and the race the gate exists to prevent never happens
// — a fake too tidy to fail.
export const __slowWrites = new Set();
export async function set(key, value) {
    if (__failWrites.has(key)) throw new Error('QuotaExceededError');
    if (__slowWrites.has(key)) await new Promise(r => setTimeout(r, 5));
    // A real transaction yields before committing; without this gap two
    // interleaved writers pass against code that has no serialisation at all.
    await Promise.resolve();
    __db.set(key, value);
}
export async function del(key) {
    if (__failDeletes.has(key)) throw new Error('delete failed');
    __db.delete(key);
}
export async function keys() { return [...__db.keys()]; }
`;

const FAKE_EVENTBUS = `
export const __emits = [];
export function __reset() { __emits.length = 0; }
export default { $emit(name, payload) { __emits.push({ name, payload }); }, $on() {}, $off() {} };
`;

// Models the real mechanism rather than a boolean: the recording branch is a
// CLONE of the capture track with its own \`enabled\` flag, and the tests below
// assert on the two tracks separately. A fake that merely remembered "muted"
// could not tell a mute that silences the recording from one that also
// silences detection, which is the entire distinction being built.
const FAKE_MIC = `
export const __state = { stream: null, recordingStream: null, generation: 0, cloneable: true };
let __muted = false;
export function __setStream() {
    __state.stream = { __track: { enabled: true } };
    __state.recordingStream = __state.cloneable
        ? { __track: { enabled: !__muted }, getTracks() { return [this.__track]; } }
        : null;
    __state.generation++;
}
export function __reset() {
    __state.stream = null; __state.recordingStream = null;
    __state.generation = 0; __state.cloneable = true; __muted = false;
}
export function __setCloneable(v) { __state.cloneable = v; }
// The track the ANALYSIS path reads. Mute must never touch it.
export function __captureTrack() { return __state.stream && __state.stream.__track; }
export function __recordingTrack() { return __state.recordingStream && __state.recordingStream.__track; }
export default {
    get stream() { return __state.stream; },
    get recordingStream() { return __state.recordingStream || __state.stream; },
    get recordingMuteSupported() { return !!__state.recordingStream; },
    get recordingMuted() { return !!__state.recordingStream && __muted; },
    get streamGeneration() { return __state.generation; },
    setRecordingMuted(muted) {
        __muted = !!muted;
        if (__state.recordingStream) {
            for (const track of __state.recordingStream.getTracks()) track.enabled = !__muted;
        }
        return this.recordingMuted;
    },
};
`;

async function loadModules() {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'fake-idb.mjs'), FAKE_IDB);
    await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);
    await writeFile(path.join(tmpDir, 'fake-mic.mjs'), FAKE_MIC);

    let storeSource = await readFile(path.join(srcDir, 'services', 'sessionAudioStore.js'), 'utf8');
    assert.ok(storeSource.includes("from 'idb-keyval'"));
    storeSource = storeSource.split("from 'idb-keyval'").join("from './fake-idb.mjs'");
    await writeFile(path.join(tmpDir, 'sessionAudioStore.mjs'), storeSource);

    let recorderSource = await readFile(path.join(srcDir, 'services', 'sessionRecorder.js'), 'utf8');
    for (const [from, to] of [
        ["from './mic.js'", "from './fake-mic.mjs'"],
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from './sessionAudioStore.js'", "from './sessionAudioStore.mjs'"],
    ]) {
        assert.ok(recorderSource.includes(from), `expected ${from} in sessionRecorder.js`);
        recorderSource = recorderSource.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'sessionRecorder.mjs'), recorderSource);

    const idb = await import(path.join(tmpDir, 'fake-idb.mjs'));
    const bus = await import(path.join(tmpDir, 'fake-eventbus.mjs'));
    const mic = await import(path.join(tmpDir, 'fake-mic.mjs'));
    const store = await import(path.join(tmpDir, 'sessionAudioStore.mjs'));
    return { idb, bus, mic, store };
}

// A fresh recorder module instance, so each test starts from a clean singleton.
async function freshRecorder() {
    const mod = await import(`${path.join(tmpDir, 'sessionRecorder.mjs')}?v=${Math.random()}`);
    return mod.default;
}

// --- fake browser surface ---------------------------------------------------

let fakeNow = 0;
globalThis.performance = { now: () => fakeNow };

const recorders = [];

class FakeMediaRecorder {
    static supported = ['audio/mp4;codecs=mp4a.40.2'];
    // Set by a test to make the encoder disagree with the request.
    static actualMimeType = null;
    static actualBitsPerSecond = 0;
    static isTypeSupported(type) { return FakeMediaRecorder.supported.includes(type); }

    constructor(stream, options = {}) {
        this.stream = stream;
        // A real MediaRecorder reports the container it will ACTUALLY produce,
        // which need not be the one requested — a browser may fall back to its
        // own. Modelling that is what makes the manifest-format test real:
        // without it the fake echoes the request back and the test passes
        // against code that never records what the encoder chose.
        this.mimeType = FakeMediaRecorder.actualMimeType ||
            options.mimeType || 'audio/mp4';
        this.audioBitsPerSecond = FakeMediaRecorder.actualBitsPerSecond ||
            options.audioBitsPerSecond || 0;
        this.state = 'inactive';
        this.ondataavailable = null;
        this.onstop = null;
        this.onerror = null;
        // What the test will emit when stop() flushes.
        this.tailChunk = null;
        recorders.push(this);
    }

    start() { this.state = 'recording'; }

    stop() {
        this.state = 'inactive';
        if (this.tailChunk && this.ondataavailable) {
            this.ondataavailable({ data: this.tailChunk });
        }
        if (this.onstop) this.onstop();
    }

    // Test helper: deliver one timeslice of encoded audio.
    emit(text, seconds = 1) {
        fakeNow += seconds * 1000;
        if (this.ondataavailable) this.ondataavailable({ data: new Blob([text]) });
    }
}

globalThis.MediaRecorder = FakeMediaRecorder;

// Node exposes a getter-only `navigator`, so it has to be redefined rather
// than assigned.
function installNavigator(value) {
    Object.defineProperty(globalThis, 'navigator', {
        value, configurable: true, writable: true,
    });
}

function setQuota(quota, usage) {
    installNavigator({ storage: { estimate: async () => ({ quota, usage }) } });
}

function noQuotaApi() { installNavigator({}); }

// Mutes at the microphone layer, bypassing the recorder — models the flag
// having been left set by anything other than the session about to start.
function micMuteDirectly(muted) { mic.default.setRecordingMuted(muted); }

// Feeds `count` one-second chunks named c0, c1, ... to the active recorder.
function feed(recorder, count, prefix = 'c') {
    for (let i = 0; i < count; i++) recorder.emit(`${prefix}${i}`);
}

// --- tests ------------------------------------------------------------------

const { idb, bus, mic, store } = await loadModules();

// Async because several writes are deliberately fire-and-forget (mute ranges,
// the stop marker, the format patch). Clearing the database synchronously lets
// one of those land AFTERWARDS, in the next test's supposedly empty store —
// which surfaced the moment begin() started refusing to overwrite an existing
// manifest. Draining first makes each test genuinely start from nothing.
async function resetAll() {
    await new Promise(resolve => setTimeout(resolve, 0));
    idb.__reset();
    bus.__reset();
    mic.__reset();
    recorders.length = 0;
    fakeNow = 0;
    FakeMediaRecorder.supported = ['audio/mp4;codecs=mp4a.40.2'];
    FakeMediaRecorder.actualMimeType = null;
    FakeMediaRecorder.actualBitsPerSecond = 0;
    setQuota(10 * 1024 * 1024 * 1024, 0);
}

console.log('\nsessionAudioStore — container and sizing');

await test('picks the portable container when the browser offers it', () => {
    FakeMediaRecorder.supported = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus'];
    assert.equal(store.pickMimeType(FakeMediaRecorder), 'audio/mp4;codecs=mp4a.40.2');
});

await test('falls back to webm when mp4 is not offered', () => {
    FakeMediaRecorder.supported = ['audio/webm;codecs=opus'];
    assert.equal(store.pickMimeType(FakeMediaRecorder), 'audio/webm;codecs=opus');
    FakeMediaRecorder.supported = ['audio/mp4;codecs=mp4a.40.2'];
});

await test('no MediaRecorder reads as unavailable, not as an empty choice', () => {
    // The two answers are different and drive different UI: null means "this
    // browser cannot record", '' means "record in whatever it defaults to".
    const saved = globalThis.MediaRecorder;
    globalThis.MediaRecorder = undefined;
    try {
        assert.equal(store.pickMimeType(), null);
    } finally {
        globalThis.MediaRecorder = saved;
    }
    // A MediaRecorder with no isTypeSupported is still worth trying.
    assert.equal(store.pickMimeType({}), '');
});

await test('sizing figures match the bitrate the user picked', () => {
    // 64 kbps = 8 kB/s; three hours is the session length this exists for.
    assert.equal(store.bytesPerHour(64), 28800000);
    assert.equal(Math.round(store.bytesPerHour(64) * 3 / 1e6), 86);
    assert.equal(Math.round(store.bytesPerHour(32) * 3 / 1e6), 43);
    assert.equal(Math.round(store.bytesPerHour(160) * 3 / 1e6), 216);
});

await test('file extension follows the container, so exports open elsewhere', () => {
    assert.equal(store.fileExtensionFor('audio/mp4;codecs=mp4a.40.2'), 'm4a');
    assert.equal(store.fileExtensionFor('audio/webm;codecs=opus'), 'webm');
});

console.log('\nsessionAudioStore — the reserve that protects the tune index');

await test('headroom is what is free MINUS the reserve, never the raw free space', async () => {
    await resetAll();
    setQuota(1000 * 1024 * 1024, 500 * 1024 * 1024);
    const headroom = await store.headroomBytes();
    assert.equal(headroom, (500 * 1024 * 1024) - store.STORAGE_RESERVE_BYTES);
});

await test('headroom goes negative once the reserve is breached', async () => {
    await resetAll();
    setQuota(1000 * 1024 * 1024, 900 * 1024 * 1024);
    assert.ok((await store.headroomBytes()) < 0);
});

await test('a browser that will not report quota answers null, not zero', async () => {
    // Zero would read as "no room" and disable recording outright on every
    // browser without estimate(); null means "cannot tell", and the recorder
    // proceeds and relies on catching the write failure instead.
    await resetAll();
    noQuotaApi();
    assert.equal(await store.headroomBytes(), null);
    setQuota(10 * 1024 * 1024 * 1024, 0);
});

console.log('\nsessionAudioStore — commit ordering');

async function seedManifest(sessionId = 's1') {
    await store.putManifest(sessionId, store.createManifest({
        sessionId, mimeType: 'audio/mp4', bitsPerSecond: 64000,
    }));
}

function segment(index, trackIndex, startSeconds, chunkTexts, { firstIsInit = false } = {}) {
    let offset = 0;
    const chunks = chunkTexts.map((text, i) => {
        const entry = {
            startSeconds: startSeconds + i,
            bytes: text.length,
            ...(firstIsInit && i === 0 ? { init: true } : {}),
        };
        offset += text.length;
        return entry;
    });
    return {
        index,
        trackIndex,
        startSeconds,
        durationSeconds: chunkTexts.length,
        bytes: offset,
        chunks,
        blob: new Blob([chunkTexts.join('')]),
    };
}

await test('a manifest names only segments already on disk', async () => {
    await resetAll();
    await seedManifest();
    await store.appendSegment('s1', segment(0, 0, 0, ['aaa', 'bbb']), {
        index: 0, startSeconds: 0, durationSeconds: 2, init: new Blob(['INIT']),
    });
    const manifest = await store.readManifest('s1');
    assert.equal(manifest.segments.length, 1);
    assert.ok(await store.readSegment('s1', 0));
    assert.equal(manifest.bytes, 6);
    assert.equal(manifest.totalSeconds, 2);
});

await test('a failed manifest write leaves the PREVIOUS recording intact', async () => {
    // The bug this forbids: writing the manifest first, so an interrupted
    // append leaves a manifest naming a segment that is not there — a player
    // that breaks partway through an evening, which the user cannot fix.
    await resetAll();
    await seedManifest();
    await store.appendSegment('s1', segment(0, 0, 0, ['aaa']), {
        index: 0, startSeconds: 0, durationSeconds: 1, init: new Blob(['INIT']),
    });

    idb.__failWrites.add(store.manifestKey('s1'));
    await assert.rejects(() => store.appendSegment('s1', segment(1, 0, 1, ['bbb'])));
    idb.__failWrites.clear();

    const manifest = await store.readManifest('s1');
    assert.equal(manifest.segments.length, 1, 'the manifest still describes only what it did before');
    for (const meta of manifest.segments) {
        assert.ok(await store.readSegment('s1', meta.index), 'every named segment is on disk');
    }
});

await test('a failed PAYLOAD write never leaves the manifest naming missing audio', async () => {
    // The invariant, stated directly: every segment a manifest names is on
    // disk, wherever an append died. Writing the manifest first breaks it —
    // and the damage is invisible until the user tries to play the recording
    // back, which is days later and nowhere near a fix.
    await resetAll();
    await seedManifest();
    idb.__failWrites.add(store.segmentKey('s1', 0));
    await assert.rejects(() => store.appendSegment('s1', segment(0, 0, 0, ['aaa']), {
        index: 0, startSeconds: 0, durationSeconds: 1, init: new Blob(['INIT']),
    }));
    idb.__failWrites.clear();

    const manifest = await store.readManifest('s1');
    for (const meta of manifest.segments) {
        assert.ok(await store.readSegment('s1', meta.index),
            `manifest names segment ${meta.index} but it is not on disk`);
    }
});

await test('the orphan a failed append leaves behind is reclaimed', async () => {
    await resetAll();
    await seedManifest();
    await store.appendSegment('s1', segment(0, 0, 0, ['aaa']), {
        index: 0, startSeconds: 0, durationSeconds: 1, init: new Blob(['INIT']),
    });
    idb.__failWrites.add(store.manifestKey('s1'));
    await assert.rejects(() => store.appendSegment('s1', segment(1, 0, 1, ['bbb'])));
    idb.__failWrites.clear();

    assert.ok(await store.readSegment('s1', 1), 'the orphan exists before the sweep');
    assert.equal(await store.reclaimOrphans(), 1);
    assert.equal(await store.readSegment('s1', 1), null);
    assert.ok(await store.readSegment('s1', 0), 'a claimed segment is never swept');
});

await test('a delete drops the manifest first, so nothing can reference a vanishing segment', async () => {
    await resetAll();
    await seedManifest();
    await store.appendSegment('s1', segment(0, 0, 0, ['aaa']), {
        index: 0, startSeconds: 0, durationSeconds: 1, init: new Blob(['INIT']),
    });
    // A delete that cannot remove the payload still removes the manifest: the
    // recording is gone as far as the app is concerned, and the bytes are
    // reclaimed on the next sweep.
    idb.__failDeletes.add(store.segmentKey('s1', 0));
    await store.deleteSessionAudio('s1');
    idb.__failDeletes.clear();

    assert.equal(await store.readManifest('s1'), null);
    assert.equal(await store.reclaimOrphans(), 1);
});

await test('deleting one session never touches another', async () => {
    await resetAll();
    await seedManifest('s1');
    await seedManifest('s2');
    await store.appendSegment('s1', segment(0, 0, 0, ['aaa']), { index: 0, startSeconds: 0, durationSeconds: 1, init: new Blob(['I1']) });
    await store.appendSegment('s2', segment(0, 0, 0, ['bbb']), { index: 0, startSeconds: 0, durationSeconds: 1, init: new Blob(['I2']) });

    await store.deleteSessionAudio('s1');
    assert.equal(await store.readManifest('s1'), null);
    const survivor = await store.readManifest('s2');
    assert.equal(survivor.segments.length, 1);
    assert.equal(await store.reclaimOrphans(), 0, 's2 keeps every segment its manifest claims');
});

await test('audio for sessions that no longer exist is reclaimed', async () => {
    await resetAll();
    await seedManifest('gone');
    await seedManifest('alive');
    await store.appendSegment('gone', segment(0, 0, 0, ['x']), { index: 0, startSeconds: 0, durationSeconds: 1, init: new Blob(['I']) });
    await store.appendSegment('alive', segment(0, 0, 0, ['y']), { index: 0, startSeconds: 0, durationSeconds: 1, init: new Blob(['I']) });

    assert.equal(await store.reclaimAudioForMissingSessions(['alive']), 1);
    assert.equal(await store.readManifest('gone'), null);
    assert.ok(await store.readManifest('alive'));
});

console.log('\nsessionAudioStore — clip assembly');

async function seedTwoSegments() {
    await resetAll();
    await seedManifest();
    // Chunk 0 of a track carries the container header AND its first second of
    // audio, so it is stored like any other chunk and marked init.
    await store.appendSegment('s1',
        segment(0, 0, 0, ['H0', 'a1', 'a2'], { firstIsInit: true }),
        { index: 0, startSeconds: 0, durationSeconds: 6, init: new Blob(['H0']) });
    await store.appendSegment('s1',
        segment(1, 0, 3, ['b3', 'b4', 'b5']),
        { index: 0, startSeconds: 0, durationSeconds: 6, init: new Blob(['H0']) });
}

await test('a clip from the start does NOT repeat the container header', async () => {
    // Prepending the init blob to a clip that already begins at chunk 0 writes
    // the header twice, which is not a file any decoder will accept.
    await seedTwoSegments();
    const clip = await store.buildClip('s1', 0, 3);
    assert.equal(await clip.blob.text(), 'H0a1a2');
    assert.equal(clip.startSeconds, 0);
});

await test('a clip from mid-stream is prefixed with the header', async () => {
    await seedTwoSegments();
    const clip = await store.buildClip('s1', 4, 6);
    assert.equal(await clip.blob.text(), 'H0b4b5');
    assert.equal(clip.startSeconds, 4, 'reports where the audio really begins');
});

await test('a cut lands on a chunk boundary and never later than asked', async () => {
    await seedTwoSegments();
    const clip = await store.buildClip('s1', 4.5, 5.2);
    assert.equal(clip.startSeconds, 4);
    assert.ok(clip.startSeconds <= 4.5);
});

await test('a clip spans segments within one track', async () => {
    await seedTwoSegments();
    const clip = await store.buildClip('s1', 2, 5);
    assert.equal(await clip.blob.text(), 'H0a2b3b4');
});

await test('a clip never crosses a track boundary', async () => {
    // Each track is its own MediaRecorder run with its own header; two of them
    // concatenated is not a playable file, so the range is clipped instead.
    await resetAll();
    await seedManifest();
    await store.appendSegment('s1', segment(0, 0, 0, ['H0', 'a1']),
        { index: 0, startSeconds: 0, durationSeconds: 2, init: new Blob(['H0']) });
    // Mark chunk 0 of track 0 as the init chunk.
    const first = await store.readSegment('s1', 0);
    first.chunks[0].init = true;
    idb.__db.set(store.segmentKey('s1', 0), first);

    await store.appendSegment('s1', segment(1, 1, 2, ['H1', 'b3'], { firstIsInit: true }),
        { index: 1, startSeconds: 2, durationSeconds: 2, init: new Blob(['H1']) });

    const clip = await store.buildClip('s1', 0, 4);
    assert.equal(await clip.blob.text(), 'H0a1', 'stops at the track boundary');
    assert.equal(clip.trackIndex, 0);

    const second = await store.buildClip('s1', 2, 4);
    assert.equal(await second.blob.text(), 'H1b3');
    assert.equal(second.trackIndex, 1);
});

await test('a clip stops at a missing segment rather than splicing a hole', async () => {
    await seedTwoSegments();
    await idb.del(store.segmentKey('s1', 1));
    const clip = await store.buildClip('s1', 0, 6);
    assert.equal(await clip.blob.text(), 'H0a1a2');
});

await test('export ranges are one per track', async () => {
    await resetAll();
    await seedManifest();
    await store.appendSegment('s1', segment(0, 0, 0, ['H0'], { firstIsInit: true }),
        { index: 0, startSeconds: 0, durationSeconds: 60, init: new Blob(['H0']) });
    await store.appendSegment('s1', segment(1, 1, 60, ['H1'], { firstIsInit: true }),
        { index: 1, startSeconds: 60, durationSeconds: 30, init: new Blob(['H1']) });
    const ranges = store.trackRanges(await store.readManifest('s1'));
    assert.equal(ranges.length, 2);
    assert.deepEqual(ranges.map(r => r.durationSeconds), [60, 30]);
});

console.log('\nsessionRecorder — the audio clock');

await test('the clock does not advance before a track starts', async () => {
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1', { bitrateKbps: 64 });
    fakeNow += 5000;
    assert.equal(recorder.audioSeconds, 0);
});

await test('the clock advances with the recording, not with wall clock', async () => {
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    const media = recorders[recorders.length - 1];
    feed(media, 10);
    assert.equal(Math.round(recorder.audioSeconds), 10);
});

await test('a pause and resume CONTINUES the clock rather than restarting it', async () => {
    // Restarting at zero would overwrite the first stretch's timeline, so every
    // tune from before the pause would seek into audio recorded after it.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], 10);
    await recorder.stop();

    // Time passes with the microphone released; none of it is recorded.
    fakeNow += 120_000;
    assert.equal(Math.round(recorder.audioSeconds), 10, 'a paused clock does not tick');

    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], 5);
    assert.equal(Math.round(recorder.audioSeconds), 15);
});

await test('a microphone outage does not put time into the recording that is not there', async () => {
    // The failure this forbids: counting the outage as recorded time, which
    // shifts every tune after it by however long the microphone was gone.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], 20);

    // The OS takes the microphone; mic.js reacquires and publishes a new stream.
    fakeNow += 45_000;
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], 10);

    assert.equal(Math.round(recorder.audioSeconds), 30,
        'only the 30 seconds actually captured are on the clock');
});

await test('a reacquired stream opens a NEW track', async () => {
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    const before = recorders.length;
    feed(recorders[recorders.length - 1], 5);

    mic.__setStream();
    await recorder.ensureRecording();
    assert.equal(recorders.length, before + 1, 'a new MediaRecorder for the new stream');
});

await test('a recorder still on the live stream is left alone', async () => {
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    const count = recorders.length;
    await recorder.ensureRecording();
    await recorder.ensureRecording();
    assert.equal(recorders.length, count, 'ensureRecording is safe to call every cycle');
});

console.log('\nsessionRecorder — writing');

await test('a segment is written once it holds SEGMENT_SECONDS of audio', async () => {
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;

    const manifest = await store.readManifest('s1');
    assert.equal(manifest.segments.length, 1);
    assert.equal(manifest.segments[0].startSeconds, 0);
    assert.ok(await store.readSegment('s1', 0));
});

await test('the first chunk of a track is marked as the header', async () => {
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;

    const segmentRecord = await store.readSegment('s1', 0);
    assert.equal(segmentRecord.chunks[0].init, true);
    assert.equal(segmentRecord.chunks[1].init, undefined);
});

await test('the tail of a track is not lost when the session pauses', async () => {
    // MediaRecorder only flushes its last chunk during stop(), and that chunk
    // is the audio of whatever tune was playing when Pause was tapped.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    const media = recorders[recorders.length - 1];
    feed(media, 3);
    media.tailChunk = new Blob(['TAIL']);
    await recorder.stop();
    await recorder._writeChain;

    const segmentRecord = await store.readSegment('s1', 0);
    assert.ok((await segmentRecord.blob.text()).endsWith('TAIL'));
});

await test('a resumed session appends rather than overwriting its stored segments', async () => {
    await resetAll();
    const first = await freshRecorder();
    await first.begin('s1');
    mic.__setStream();
    await first.ensureRecording();
    feed(recorders[recorders.length - 1], 5);
    await first.stop();
    await first._writeChain;

    // A reload: a brand new recorder over storage the previous one wrote.
    const second = await freshRecorder();
    await second.resume('s1');
    assert.equal(Math.round(second.audioSeconds), 5, 'the clock continues from what is stored');

    mic.__setStream();
    await second.ensureRecording();
    feed(recorders[recorders.length - 1], 4);
    await second.stop();
    await second._writeChain;

    const manifest = await store.readManifest('s1');
    assert.equal(manifest.segments.length, 2);
    assert.deepEqual(manifest.segments.map(s => s.index), [0, 1]);
    assert.equal(Math.round(manifest.totalSeconds), 9);
});

console.log('\nsessionRecorder — running out of storage');

await test('a full disk stops the recording and keeps what was already written', async () => {
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;

    // The reserve is now breached.
    setQuota(1000, 999);
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;

    assert.equal(recorder.stoppedReason, 'storage');
    assert.equal(recorder.isRecording, false);
    const manifest = await store.readManifest('s1');
    assert.equal(manifest.segments.length, 1, 'the first segment is untouched');
    assert.ok(await store.readSegment('s1', 0));
});

await test('the manifest records WHY recording stopped, and where', async () => {
    // A player that silently runs out of audio halfway through an evening is
    // indistinguishable from a bug.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;
    setQuota(1000, 999);
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;
    await new Promise(resolve => setTimeout(resolve, 0));

    const manifest = await store.readManifest('s1');
    assert.equal(manifest.stopped.reason, 'storage');
    assert.ok(manifest.stopped.atSeconds > 0);
});

await test('begin() refuses up front when there is already no room', async () => {
    await resetAll();
    setQuota(1000, 999);
    const recorder = await freshRecorder();
    const ok = await recorder.begin('s1');
    assert.equal(ok, false);
    assert.equal(recorder.isActive, false, 'no manifest, no writes, nothing half-started');
    assert.equal(await store.readManifest('s1'), null);
});

await test('a browser with no quota API still records', async () => {
    await resetAll();
    noQuotaApi();
    const recorder = await freshRecorder();
    assert.equal(await recorder.begin('s1'), true);
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;
    assert.equal((await store.readManifest('s1')).segments.length, 1);
    setQuota(10 * 1024 * 1024 * 1024, 0);
});

await test('a write that fails anyway stops cleanly instead of throwing', async () => {
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    idb.__failWrites.add(store.segmentKey('s1', 0));
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;
    idb.__failWrites.clear();

    assert.equal(recorder.stoppedReason, 'storage');
    assert.equal((await store.readManifest('s1')).segments.length, 0);
});

await test('resuming after a storage stop tries again rather than latching off', async () => {
    // Latching would mean a session that once filled the disk could never
    // record again even after the user freed space, with nothing on screen to
    // explain why.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    setQuota(1000, 999);
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;
    assert.equal(recorder.stoppedReason, 'storage');
    await recorder.end();

    setQuota(10 * 1024 * 1024 * 1024, 0);
    const next = await freshRecorder();
    await next.resume('s1');
    assert.equal(next.stoppedReason, null);
    mic.__setStream();
    await next.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await next._writeChain;
    assert.equal((await store.readManifest('s1')).segments.length, 1);
});

console.log('\nsessionRecorder — availability and teardown');

await test('a browser that cannot record reports it instead of failing later', async () => {
    await resetAll();
    const saved = globalThis.MediaRecorder;
    globalThis.MediaRecorder = undefined;
    const recorder = await freshRecorder();
    assert.equal(recorder.available, false);
    assert.equal(await recorder.begin('s1'), false);
    assert.equal(recorder.stoppedReason, 'unsupported');
    globalThis.MediaRecorder = saved;
});

await test('discard() deletes the recording', async () => {
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;

    await recorder.discard('s1');
    assert.equal(await store.readManifest('s1'), null);
    assert.equal(recorder.isActive, false);
    assert.equal(await store.reclaimOrphans(), 0, 'the segments went too');
});

await test('end() flushes the last segment before closing', async () => {
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], 20);
    await recorder.end();

    const manifest = await store.readManifest('s1');
    assert.equal(manifest.segments.length, 1);
    assert.equal(Math.round(manifest.totalSeconds), 20);
});

await test('the recorder announces its state so the UI cannot disagree with it', async () => {
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    const events = bus.__emits.filter(e => e.name === 'sessionAudioState');
    assert.ok(events.length >= 2);
    assert.equal(events[events.length - 1].payload.recording, true);
    assert.equal(events[events.length - 1].payload.sessionId, 's1');
});


// --- the link between a tune and a position in the recording ----------------
//
// This is the half of the feature that cannot be seen in storage: a detection
// has to carry WHERE in the audio it was heard, and that stamp has to come from
// the recorder's clock rather than from the analysis timer.

const FAKE_LA_MIC = `
export let __pcm = new Float32Array(0);
export function __setPcm(n) { __pcm = new Float32Array(n); }
export function __reset() { __pcm = new Float32Array(0); }
export default {
    audioCtx: null,
    sampleRate: 44100,
    stream: null,
    streamGeneration: 0,
    async startContinuous() {},
    async stopContinuous() {},
    async ensureMicHealthy() { return true; },
    getContinuousAudio() { return __pcm; },
};`;

const FAKE_LA_RECORDER = `
export const __state = { recording: false, seconds: 0, active: false, discarded: [], ended: 0 };
export function __reset() {
    __state.recording = false; __state.seconds = 0; __state.active = false;
    __state.discarded.length = 0; __state.ended = 0;
}
export default {
    get isRecording() { return __state.recording; },
    get isActive() { return __state.active; },
    get audioSeconds() { return __state.seconds; },
    async begin() { __state.active = true; return true; },
    async resume() { __state.active = true; return true; },
    async stop() { __state.recording = false; },
    async end() { __state.active = false; __state.recording = false; __state.ended++; },
    async discard(id) { __state.discarded.push(id); },
    ensureRecording() { return Promise.resolve(true); },
};`;

const FAKE_LA_BACKEND = `
export default { async transcribeAndQueryPCMSignal() { return { results: [] }; } };`;
const FAKE_LA_GEO = `export default { beginSession() {}, async getFix() { return null; } };`;
const FAKE_LA_STORE = `
export const __sessions = [];
export const userSettings = { geoTagDetections: false, recordSessionAudio: true, sessionAudioBitrateKbps: 64 };
export function __reset() { __sessions.length = 0; }
export default {
    userSettings,
    async addSighting() {},
    async upsertLiveSession(session) {
        const record = { ...session };
        const i = __sessions.findIndex(s => s.id === record.id);
        if (i === -1) __sessions.unshift(record); else __sessions[i] = record;
        return record;
    },
    async deleteLiveSession() {},
    async getLiveSessions() { return __sessions.slice(); },
    async getLiveSessionsStrict() { return __sessions.slice(); },
    async setOpenLiveSession() {},
    async getOpenLiveSession() { return null; },
    async clearOpenLiveSession() {},
};`;

async function loadLiveAnalysis() {
    await loadSessionAnalysisModule();
    await writeFile(path.join(tmpDir, 'la-mic.mjs'), FAKE_LA_MIC);
    await writeFile(path.join(tmpDir, 'la-recorder.mjs'), FAKE_LA_RECORDER);
    await writeFile(path.join(tmpDir, 'la-backend.mjs'), FAKE_LA_BACKEND);
    await writeFile(path.join(tmpDir, 'la-geo.mjs'), FAKE_LA_GEO);
    await writeFile(path.join(tmpDir, 'la-store.mjs'), FAKE_LA_STORE);

    let source = await readFile(path.join(srcDir, 'services', 'liveAnalysis.js'), 'utf8');
    const replacements = [
        ["from './mic.js'", "from './la-mic.mjs'"],
        ["from './backend.js'", "from './la-backend.mjs'"],
        ["from './geo.js'", "from './la-geo.mjs'"],
        ["from './store.js'", "from './la-store.mjs'"],
        ["from './sessionRecorder.js'", "from './la-recorder.mjs'"],
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from '@/js/sessionAnalysis.js'", `from '${path.join(sessionAnalysisTmpDir, 'sessionAnalysis.mjs')}'`],
        ["from '@/js/biasResults.mjs'", `from '${path.join(srcDir, 'js', 'biasResults.mjs')}'`],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected ${from} in liveAnalysis.js`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'liveAnalysis.mjs'), source);

    const laStore = await import(path.join(tmpDir, 'la-store.mjs'));
    const laRecorder = await import(path.join(tmpDir, 'la-recorder.mjs'));
    laStore.__reset();
    laRecorder.__reset();
    const mod = await import(`${path.join(tmpDir, 'liveAnalysis.mjs')}?v=${Math.random()}`);
    return { service: mod.default, laStore, laRecorder };
}

const analysis = await loadSessionAnalysisModule();

function windowMatch(tuneId, startSeconds, audioSeconds) {
    return {
        startSeconds, tuneId, settingId: String(tuneId * 10), sourceUrl: '', dataset: '',
        displayName: `tune-${tuneId}`, score: 0.7, alternatives: [],
        ...(audioSeconds === undefined ? {} : { audioSeconds }),
    };
}

const CLUSTER_OPTIONS = { windowSeconds: 10, stepSeconds: 10, minClusterHits: 2, minTopScore: 0.4 };

console.log('\nsessionRecorder — the mute control');

await test('muting silences the RECORDING and leaves capture alone', async () => {
    // The whole point of the control: detection carries on through the
    // conversation being muted. Muting the capture track instead would stop
    // the tune list dead, which is not what "do not record this" means.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();

    recorder.setMuted(true);
    assert.equal(mic.__recordingTrack().enabled, false, 'the recorded branch is silenced');
    assert.equal(mic.__captureTrack().enabled, true, 'the analysis branch is untouched');

    recorder.setMuted(false);
    assert.equal(mic.__recordingTrack().enabled, true);
    assert.equal(mic.__captureTrack().enabled, true);
});

await test('the recording keeps running while muted, so the timeline stays intact', async () => {
    // Stopping instead would compress the timeline, and every tune offset
    // after a mute would point at the wrong moment in the recording.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], 60);
    recorder.setMuted(true);
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;

    assert.equal(recorder.isRecording, true);
    assert.equal((await store.readManifest('s1')).segments.length, 1);
    assert.equal(Math.round(recorder.audioSeconds), 240, 'the clock ran through the mute');
});

await test('muted stretches are recorded, so the player can explain the silence', async () => {
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], 30);
    recorder.setMuted(true);
    feed(recorders[recorders.length - 1], 20);
    recorder.setMuted(false);
    feed(recorders[recorders.length - 1], 10);
    await recorder._writeChain;
    await new Promise(resolve => setTimeout(resolve, 0));

    const manifest = await store.readManifest('s1');
    assert.equal(manifest.mutedRanges.length, 1);
    assert.equal(Math.round(manifest.mutedRanges[0].from), 30);
    assert.equal(Math.round(manifest.mutedRanges[0].to), 50);
});

await test('a mute still open when the session ends is closed, not left running for ever', async () => {
    // An open-ended range greys out everything after it, including audio a
    // later resumed stretch recorded.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], 20);
    recorder.setMuted(true);
    feed(recorders[recorders.length - 1], 10);
    await recorder.end();
    await new Promise(resolve => setTimeout(resolve, 0));

    const manifest = await store.readManifest('s1');
    assert.equal(manifest.mutedRanges.length, 1);
    assert.notEqual(manifest.mutedRanges[0].to, null);
    assert.equal(Math.round(manifest.mutedRanges[0].to), 30);
});

await test('a microphone reacquired while muted comes back MUTED', async () => {
    // The asymmetry that decides this: silently un-muting records something
    // the user believes is private and cannot be undone, while staying muted
    // loses audio the user can see is being lost.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    recorder.setMuted(true);

    // The OS takes the microphone; mic.js reacquires and rebuilds the branch.
    mic.__setStream();
    await recorder.ensureRecording();

    assert.equal(recorder.muted, true);
    assert.equal(mic.__recordingTrack().enabled, false);
});

await test('a session resumed after a reload comes back muted if it was muted', async () => {
    await resetAll();
    const first = await freshRecorder();
    await first.begin('s1');
    mic.__setStream();
    await first.ensureRecording();
    feed(recorders[recorders.length - 1], 10);
    first.setMuted(true);
    await first.stop();
    await first._writeChain;
    await new Promise(resolve => setTimeout(resolve, 0));

    // A reload. The order mirrors _startCapture: the microphone opens, then
    // the recorder resumes onto it.
    mic.__reset();
    const second = await freshRecorder();
    mic.__setStream();
    await second.resume('s1');
    assert.equal(second.muted, true, 'the open muted range is honoured');
});

await test('a NEW session starts recording, whatever the last one was doing', async () => {
    // Not a contradiction of the rule above: a resumed session is visibly the
    // same one, with the muted counter on screen. A new session has nothing
    // on screen connecting it to a button pressed hours earlier.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    recorder.setMuted(true);
    await recorder.end();

    await recorder.begin('s2');
    assert.equal(recorder.muted, false);
    assert.deepEqual(recorder.mutedRanges, []);

    // The microphone's mute flag is global and outlives any one session, so a
    // new session has to clear it rather than assume the previous end() did.
    await recorder.end();
    mic.__setStream();
    micMuteDirectly(true);
    await recorder.begin('s3');
    assert.equal(recorder.muted, false, 'a stale mute never carries into a new session');
});

await test('mute reports failure rather than pretending, on a browser that cannot clone', async () => {
    // Silently doing nothing would leave the user believing the room is not
    // being recorded when it is — the worst outcome this control can produce.
    await resetAll();
    mic.__setCloneable(false);
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();

    assert.equal(recorder.muteSupported, false);
    assert.equal(recorder.setMuted(true), false);
    assert.equal(recorder.muted, false);
});

await test('muting twice does not open a second range', async () => {
    // Double-tapping a control on a phone in a pub is normal. Two overlapping
    // ranges would double-count the muted total and draw the strip twice.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    recorder.setMuted(true);
    feed(recorders[recorders.length - 1], 5);
    recorder.setMuted(true);
    assert.equal(recorder.mutedRanges.length, 1);
});

await test('a session that ended UNMUTED resumes unmuted', async () => {
    // The other half of the restore rule: honouring a CLOSED range would leave
    // a session permanently muted after one mute earlier in the evening.
    await resetAll();
    const first = await freshRecorder();
    await first.begin('s1');
    mic.__setStream();
    await first.ensureRecording();
    feed(recorders[recorders.length - 1], 5);
    first.setMuted(true);
    feed(recorders[recorders.length - 1], 5);
    first.setMuted(false);
    await first.end();
    await new Promise(resolve => setTimeout(resolve, 0));

    mic.__reset();
    const second = await freshRecorder();
    mic.__setStream();
    await second.resume('s1');
    assert.equal(second.muted, false);
});

await test('the mute state is announced, so the session bar cannot disagree', async () => {
    // The bar renders from this event alone; if the state did not ride it, the
    // chip would keep saying REC over a silenced recording.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    bus.__reset();
    recorder.setMuted(true);
    const last = bus.__emits.filter(e => e.name === 'sessionAudioState').pop();
    assert.equal(last.payload.muted, true);
    assert.equal(last.payload.muteSupported, true);
    assert.ok(last.payload.mutedSeconds >= 0);
});

await test('muted time is reported while the mute is still open', async () => {
    // A mute the user forgot about is how a manual control loses an evening,
    // and a running counter is the only defence.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], 10);
    recorder.setMuted(true);
    feed(recorders[recorders.length - 1], 25);
    assert.equal(Math.round(recorder.mutedSeconds), 25);
});

// --- review findings ---------------------------------------------------------
//
// Six defects found in review, each of which looked correct and did the wrong
// thing quietly. Every case here fails against the code as it was.

console.log('\nsessionRecorder — honouring the setting and the encoder');

await test('a storage stop is cleared by an ordinary Pause and Resume', async () => {
    // The reset lived after resume()'s "already ours" early return, so the
    // same in-memory session could never record again after running out of
    // space — only a reload could clear it, which no user would guess.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    setQuota(1000, 999);
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;
    assert.equal(recorder.stoppedReason, 'storage');

    await recorder.stop();                      // Pause
    setQuota(10 * 1024 * 1024 * 1024, 0);       // the user frees space
    await recorder.resume('s1');                // Resume, same instance
    assert.equal(recorder.stoppedReason, null, 'it may try again');

    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;
    assert.equal((await store.readManifest('s1')).segments.length, 1);
});

await test('an encoder stop is NOT cleared by a resume', async () => {
    // 'storage' is a condition the user can change between two taps.
    // 'unsupported' and 'encoder' say something about the browser, and
    // retrying them every Resume would spin for the rest of the session.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    recorder._fail('encoder', 'no');
    await recorder.resume('s1');
    assert.equal(recorder.stoppedReason, 'encoder');
});

await test('the manifest names the container actually recorded', async () => {
    // The requested mimeType was stored and never corrected, so a fallback to
    // the browser's own container wrote WebM bytes that the export named .m4a
    // and the player handed to a decoder as MP4 — a mislabelled file that
    // presents as corrupt audio.
    await resetAll();
    const recorder = await freshRecorder();
    // The encoder will report a different container from the one requested.
    FakeMediaRecorder.actualMimeType = 'audio/webm;codecs=opus';
    FakeMediaRecorder.actualBitsPerSecond = 48000;
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    await new Promise(resolve => setTimeout(resolve, 0));

    const manifest = await store.readManifest('s1');
    assert.equal(manifest.mimeType, 'audio/webm;codecs=opus');
    assert.equal(store.fileExtensionFor(manifest.mimeType), 'webm');
});

console.log('\nsessionAudioStore — playback never guesses');

await test('a moment past the last stored segment has no segment', async () => {
    // Segments are written every few minutes, so a tune recognised just now is
    // real, stamped, and NOT yet on disk. Falling back to the last stored
    // segment played unrelated audio from minutes earlier.
    await resetAll();
    await seedManifest();
    await store.appendSegment('s1', segment(0, 0, 0, ['H0', 'a1'], { firstIsInit: true }),
        { index: 0, startSeconds: 0, durationSeconds: 2, init: new Blob(['H0']) });

    assert.equal(await store.buildClip('s1', 5, 7), null, 'nothing covers it');
    const inside = await store.buildClip('s1', 0, 2);
    assert.ok(inside, 'and what is stored still plays');
});

await test('a resumed session that falls back to another container keeps its old segments honest', async () => {
    // Rewriting the session-wide mimeType would relabel segments that really
    // are MP4 as WebM, and the export would hand a decoder bytes that are
    // neither. A clip never spans a track, so the track is the only level at
    // which "what format is this" has one answer.
    await resetAll();
    const first = await freshRecorder();
    await first.begin('s1');
    mic.__setStream();
    await first.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await first._writeChain;
    await first.end();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal((await store.readManifest('s1')).mimeType, 'audio/mp4;codecs=mp4a.40.2');

    // A later listening stretch on a browser whose encoder answers differently.
    FakeMediaRecorder.actualMimeType = 'audio/webm;codecs=opus';
    const second = await freshRecorder();
    await second.resume('s1');
    mic.__setStream();
    await second.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await second._writeChain;
    await new Promise(resolve => setTimeout(resolve, 0));

    const manifest = await store.readManifest('s1');
    assert.equal(manifest.mimeType, 'audio/mp4;codecs=mp4a.40.2',
        'the session keeps the container its existing audio is in');
    assert.equal(manifest.tracks[0].mimeType, 'audio/mp4;codecs=mp4a.40.2');
    assert.equal(manifest.tracks[1].mimeType, 'audio/webm;codecs=opus');

    // And each clip is labelled with what its own bytes actually are.
    const early = await store.buildClip('s1', 0, 10, manifest);
    const late = await store.buildClip('s1', store.SEGMENT_SECONDS + 5,
        store.SEGMENT_SECONDS + 10, manifest);
    assert.equal(store.fileExtensionFor(early.mimeType), 'm4a');
    assert.equal(store.fileExtensionFor(late.mimeType), 'webm');
});

console.log('\nthe orphan sweep is never allowed to guess');

await test('a failed manifest read abandons the sweep rather than deleting', async () => {
    // listManifests() turns a failed read into a MISSING manifest, and the
    // sweep deletes everything no manifest claims — so one transient error
    // would destroy a whole recording, silently, from a screen the user opened
    // to look at their sessions.
    await resetAll();
    await seedManifest('s1');
    await store.appendSegment('s1', segment(0, 0, 0, ['aaa'], { firstIsInit: true }),
        { index: 0, startSeconds: 0, durationSeconds: 1, init: new Blob(['H']) });

    idb.__failReads.add(store.manifestKey('s1'));
    const reclaimed = await store.reclaimOrphans();
    idb.__failReads.clear();

    assert.equal(reclaimed, 0);
    assert.ok(await store.readSegment('s1', 0), 'the recording is still there');
});

await test('a manifest from a NEWER build protects its audio', async () => {
    // Not recognised is not rubbish — it may be a later format this client
    // cannot read. Same rule as the tune index's read-side delete.
    await resetAll();
    await seedManifest('s1');
    await store.appendSegment('s1', segment(0, 0, 0, ['aaa'], { firstIsInit: true }),
        { index: 0, startSeconds: 0, durationSeconds: 1, init: new Blob(['H']) });
    const future = await idb.get(store.manifestKey('s1'));
    await idb.set(store.manifestKey('s1'), { ...future, schema: store.AUDIO_SCHEMA_VERSION + 1 });

    assert.equal(await store.reclaimOrphans(), 0);
    assert.ok(await store.readSegment('s1', 0));
});

await test('the sweep cannot delete a payload whose manifest is still in flight', async () => {
    // appendSegment writes the payload first and the manifest second. A sweep
    // in that window deletes the new payload, and the manifest then lands
    // naming audio that is gone — the precise state the ordering exists to
    // prevent.
    await resetAll();
    await seedManifest('s1');

    // The manifest write is held open, so the sweep runs while the payload is
    // on disk and unclaimed — the window the gate exists for.
    idb.__slowWrites.add(store.manifestKey('s1'));
    const append = store.appendSegment('s1', segment(0, 0, 0, ['aaa'], { firstIsInit: true }),
        { index: 0, startSeconds: 0, durationSeconds: 1, init: new Blob(['H']) });
    await new Promise(resolve => setTimeout(resolve, 0));
    const sweep = store.reclaimOrphans();
    await Promise.all([append, sweep]);
    idb.__slowWrites.clear();

    const manifest = await store.readManifest('s1');
    assert.equal(manifest.segments.length, 1);
    assert.ok(await store.readSegment('s1', 0),
        'the segment the manifest names is still on disk');
});

await test('a genuine orphan is still reclaimed', async () => {
    await resetAll();
    await seedManifest('s1');
    await idb.set(store.segmentKey('s1', 99), { blob: new Blob(['x']), chunks: [] });
    assert.equal(await store.reclaimOrphans(), 1);
});

console.log('\nsessionRecorder — recovering from a storage stop mid-recording');

await test('a resumed recording never lays new audio over old segments', async () => {
    // _fail() ends a track without going through _stopTrack(), so the clock was
    // never committed and the next track restarted at the FAILED track's start
    // — over segments already written there. The existing storage test runs out
    // of space on the very first segment, where restarting at zero is invisible.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();

    // One segment safely stored.
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;
    assert.equal((await store.readManifest('s1')).segments.length, 1);

    // The next one runs out of space.
    setQuota(1000, 999);
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;
    assert.equal(recorder.stoppedReason, 'storage');

    // The user frees space and resumes the same session.
    setQuota(10 * 1024 * 1024 * 1024, 0);
    await recorder.stop();
    await recorder.resume('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;

    const manifest = await store.readManifest('s1');
    assert.equal(manifest.segments.length, 2);
    const [first, second] = manifest.segments.slice().sort((a, b) => a.index - b.index);
    assert.ok(second.startSeconds >= first.startSeconds + first.durationSeconds,
        `segment ${second.index} starts at ${second.startSeconds}, inside segment ` +
        `${first.index} which runs to ${first.startSeconds + first.durationSeconds}`);
});

await test('a failure commits the clock, exactly as a normal stop does', async () => {
    // Pinned on its own because the resume-side recovery below covers the same
    // ground: with both in place either can regress unnoticed. This is the
    // primary fix — _fail() ends a track without going through _stopTrack().
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;
    setQuota(1000, 999);
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;

    assert.equal(recorder.stoppedReason, 'storage');
    assert.equal(Math.round(recorder._committedSeconds), 2 * store.SEGMENT_SECONDS,
        'the clock is where the audio stopped, not back at the failed track\'s start');
});

await test('a resume never starts behind what is already stored', async () => {
    // The independent half: whatever left the clock behind, reading disk is the
    // only authority on where new audio may safely begin.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;
    await recorder.stop();

    // A clock left behind by some other path.
    recorder._committedSeconds = 0;
    recorder._chunkCursorSeconds = 0;
    await recorder.resume('s1');

    assert.equal(Math.round(recorder._committedSeconds), store.SEGMENT_SECONDS);
});

await test('two segments never claim the same second', async () => {
    // The visible consequence of the rewind: _segmentFor picks whichever it
    // finds first, so a tune seeks into audio from a different part of the
    // evening.
    await resetAll();
    const recorder = await freshRecorder();
    await recorder.begin('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;
    setQuota(1000, 999);
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;
    setQuota(10 * 1024 * 1024 * 1024, 0);
    await recorder.stop();
    await recorder.resume('s1');
    mic.__setStream();
    await recorder.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await recorder._writeChain;

    const spans = (await store.readManifest('s1')).segments
        .map(s => [s.startSeconds, s.startSeconds + s.durationSeconds])
        .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
        assert.ok(spans[i][0] >= spans[i - 1][1],
            `overlap: ${JSON.stringify(spans[i - 1])} and ${JSON.stringify(spans[i])}`);
    }
});

await test('a reload after a storage failure does not fill the hole', async () => {
    // The in-memory recovery keeps the failed segment's elapsed time, but a new
    // recorder restores from the manifest — and manifest.totalSeconds is the end
    // of the last SAVED segment, which is where the hole begins. Starting there
    // hands the lost interval's timestamps to audio recorded after the reload,
    // so every tune from that interval plays something unrelated.
    await resetAll();
    const before = await freshRecorder();
    await before.begin('s1');
    mic.__setStream();
    await before.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await before._writeChain;
    setQuota(1000, 999);
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await before._writeChain;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(before.stoppedReason, 'storage');

    const manifest = await store.readManifest('s1');
    assert.equal(Math.round(manifest.totalSeconds), store.SEGMENT_SECONDS);
    assert.equal(Math.round(manifest.clockFloor), 2 * store.SEGMENT_SECONDS,
        'the manifest records where the recording actually reached');

    // A reload: a brand new recorder over the same storage.
    setQuota(10 * 1024 * 1024 * 1024, 0);
    const after = await freshRecorder();
    await after.resume('s1');
    assert.equal(Math.round(after._committedSeconds), 2 * store.SEGMENT_SECONDS,
        'new audio starts past the hole, not on top of it');
});

await test('the clock floor survives a retry that records nothing', async () => {
    // resume() clears the `stopped` marker so recording can be tried again, so
    // the marker cannot be the durable record. A second reload after a retry
    // that stored nothing would otherwise lose the hole entirely.
    await resetAll();
    const first = await freshRecorder();
    await first.begin('s1');
    mic.__setStream();
    await first.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await first._writeChain;
    setQuota(1000, 999);
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await first._writeChain;
    await new Promise(resolve => setTimeout(resolve, 0));

    setQuota(10 * 1024 * 1024 * 1024, 0);
    const second = await freshRecorder();
    await second.resume('s1');            // clears `stopped`
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal((await store.readManifest('s1')).stopped, null);

    const third = await freshRecorder();  // a second reload
    await third.resume('s1');
    assert.equal(Math.round(third._committedSeconds), 2 * store.SEGMENT_SECONDS);
});

console.log('\nan existing recording is never written over');

await test('a failed manifest read does NOT start a fresh recording over it', async () => {
    // readManifest() answers null for three different things: nothing stored,
    // the read failed, and a schema this build does not know. resume() read
    // that as "no recording exists" and called begin(), which writes an empty
    // manifest over the real one and orphans every segment it named. Same
    // "could not tell means it is gone" mistake as the orphan sweep, on the
    // write path this time.
    await resetAll();
    const first = await freshRecorder();
    await first.begin('s1');
    mic.__setStream();
    await first.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await first._writeChain;
    await first.end();
    await new Promise(resolve => setTimeout(resolve, 0));

    idb.__failReads.add(store.manifestKey('s1'));
    const second = await freshRecorder();
    const ok = await second.resume('s1');
    idb.__failReads.clear();

    assert.equal(ok, false, 'it refuses rather than guessing');
    assert.equal(second.stoppedReason, 'unreadable');
    // The MESSAGE is what pins resume's own guard: begin() refuses too (it
    // holds the invariant on its own terms), but it can only say "this session
    // already has a recording", which is wrong and unactionable for a
    // transient read failure. With both guards in place either could regress
    // unnoticed, so each is asserted by what only it can produce.
    assert.match(second.error, /Could not read/);
    const manifest = await store.readManifest('s1');
    assert.equal(manifest.segments.length, 1, 'the recording is untouched');
    assert.equal(await store.reclaimOrphans(), 0, 'and nothing was orphaned');
});

await test('a manifest from a NEWER build is not written over either', async () => {
    await resetAll();
    const first = await freshRecorder();
    await first.begin('s1');
    mic.__setStream();
    await first.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await first._writeChain;
    await first.end();
    await new Promise(resolve => setTimeout(resolve, 0));

    const stored = await idb.get(store.manifestKey('s1'));
    await idb.set(store.manifestKey('s1'),
        { ...stored, schema: store.AUDIO_SCHEMA_VERSION + 1 });

    const second = await freshRecorder();
    assert.equal(await second.resume('s1'), false);
    // Deliberately NOT 'unsupported': that reason is silent in the UI because
    // it means the browser cannot record at all, and this one has to be said.
    assert.equal(second.stoppedReason, 'manifest-unsupported');
    assert.match(second.error, /newer version/);
    const after = await idb.get(store.manifestKey('s1'));
    assert.equal(after.schema, store.AUDIO_SCHEMA_VERSION + 1, 'left exactly as it was');
    assert.equal(after.segments.length, 1);
});

await test('begin() refuses to create over an existing recording', async () => {
    // Held in begin() itself, not only at its caller, so no future caller can
    // reintroduce the overwrite.
    await resetAll();
    const first = await freshRecorder();
    await first.begin('s1');
    mic.__setStream();
    await first.ensureRecording();
    feed(recorders[recorders.length - 1], store.SEGMENT_SECONDS);
    await first._writeChain;
    await first.end();
    await new Promise(resolve => setTimeout(resolve, 0));

    const second = await freshRecorder();
    assert.equal(await second.begin('s1'), false);
    assert.equal((await store.readManifest('s1')).segments.length, 1);
});

await test('a genuinely new session still starts normally', async () => {
    // The refusals above must not cost the ordinary case.
    await resetAll();
    const recorder = await freshRecorder();
    assert.equal(await recorder.resume('brand-new'), true);
    assert.ok(await store.readManifest('brand-new'));
});

console.log('\nlinking detections to the recording');

await test('a cluster carries a playback anchor at its window midpoint', async () => {
    // audioStartSeconds is where the first matching window ENDED, so the audio
    // that produced the match runs from a window earlier. Seeking to the bare
    // offset lands past the opening; a fixed 12 s offset landed ~2 s BEFORE the
    // window began, which is what made playback feel early on a device.
    const matches = [
        windowMatch(7, 10, 100),
        windowMatch(7, 20, 110),
    ];
    const [detection] = analysis.clusterDetections(matches, CLUSTER_OPTIONS);
    assert.equal(detection.audioStartSeconds, 100);
    assert.equal(detection.audioAnchorSeconds, 95, 'half a window before the window end');
});

await test('the anchor follows the window size, not a constant', async () => {
    const wide = { ...CLUSTER_OPTIONS, windowSeconds: 30 };
    const [detection] = analysis.clusterDetections(
        [windowMatch(7, 10, 100), windowMatch(7, 20, 110)], wide);
    assert.equal(detection.audioAnchorSeconds, 85);
});

await test('the anchor is never negative', async () => {
    const [detection] = analysis.clusterDetections(
        [windowMatch(7, 10, 2), windowMatch(7, 20, 12)], CLUSTER_OPTIONS);
    assert.equal(detection.audioAnchorSeconds, 0);
});

await test('a cluster with no recorded audio has no anchor', async () => {
    const [detection] = analysis.clusterDetections(
        [windowMatch(7, 10), windowMatch(7, 20)], CLUSTER_OPTIONS);
    assert.equal(detection.audioAnchorSeconds, null);
});

await test('a cluster carries where it sits in the recording', async () => {
    const clusters = analysis.clusterDetections([
        windowMatch(1, 30, 30), windowMatch(1, 40, 40), windowMatch(1, 50, 50),
    ], CLUSTER_OPTIONS);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].audioStartSeconds, 30);
    assert.equal(clusters[0].audioEndSeconds, 60);
});

await test('the audio span follows the RECORDING clock, not the analysis timer', async () => {
    // The two diverge whenever the microphone was lost or the tab was
    // throttled. Reading startSeconds here would put the marker wherever the
    // timer drifted to, which is the wrong place in a three-hour file.
    const clusters = analysis.clusterDetections([
        windowMatch(1, 300, 120), windowMatch(1, 310, 130),
    ], CLUSTER_OPTIONS);
    assert.equal(clusters[0].startSeconds, 300);
    assert.equal(clusters[0].audioStartSeconds, 120);
});

await test('a cluster with no recorded audio offers none', async () => {
    const clusters = analysis.clusterDetections([
        windowMatch(1, 30), windowMatch(1, 40),
    ], CLUSTER_OPTIONS);
    assert.equal(clusters[0].audioStartSeconds, null);
    assert.equal(clusters[0].audioEndSeconds, null);
});

await test('a cluster only partly recorded still points at the part that was', async () => {
    // Audio can stop mid-session when storage runs out. The tune is still
    // playable up to that point, and dropping the ▶ entirely would be worse.
    const clusters = analysis.clusterDetections([
        windowMatch(1, 30, 30), windowMatch(1, 40), windowMatch(1, 50),
    ], CLUSTER_OPTIONS);
    assert.equal(clusters[0].audioStartSeconds, 30);
});

await test('a collapsed row points at where the tune BEGAN', async () => {
    // The displayed time column deliberately advances to the latest cluster so
    // the user can see it ticking. The audio offset must not: "play this tune"
    // means play it from the start, and keeping the earliest known offset is
    // also what keeps a partly-recorded row playable.
    const { service } = await loadLiveAnalysis();
    service.options = CLUSTER_OPTIONS;
    service._windowMatches = [
        windowMatch(1, 30, 30), windowMatch(1, 40, 40), windowMatch(1, 50, 50),
        windowMatch(1, 100, 100), windowMatch(1, 110, 110), windowMatch(1, 120, 120),
    ];
    service._recluster();
    assert.equal(service.detections.length, 1);
    assert.equal(service.detections[0].audioStartSeconds, 30);
    assert.equal(service.detections[0].audioEndSeconds, 130);
    assert.equal(service.detections[0].startSeconds, 100, 'the time column still advances');
});

await test('the stamp is only taken while audio is actually being recorded', async () => {
    const { service, laRecorder } = await loadLiveAnalysis();
    service.options = CLUSTER_OPTIONS;
    service.sessionId = 'sX';
    service.isRunning = true;

    laRecorder.__state.recording = false;
    laRecorder.__state.seconds = 999;
    // The loop reads sessionRecorder.isRecording before the clock, so a
    // recorder that is set up but not running must contribute nothing —
    // otherwise every detection during a storage stop or a microphone outage
    // is stamped with the same frozen offset.
    assert.equal(laRecorder.default.isRecording, false);

    laRecorder.__state.recording = true;
    laRecorder.__state.seconds = 42;
    assert.equal(laRecorder.default.audioSeconds, 42);
});

await test('the saved session record carries the audio offsets', async () => {
    // Without this the ▶ works only until the app is reloaded, which is
    // exactly when someone wants to listen back.
    const { service, laStore } = await loadLiveAnalysis();
    service.options = CLUSTER_OPTIONS;
    service.sessionId = 'sY';
    service._sessionStartedAt = Date.now();
    service._windowMatches = [windowMatch(1, 30, 30), windowMatch(1, 40, 40)];
    service._recluster();
    await service._persistSession();

    const saved = laStore.__sessions.find(s => s.id === 'sY');
    assert.equal(saved.tunes.length, 1);
    assert.equal(saved.tunes[0].audioStartSeconds, 30);
    assert.equal(saved.tunes[0].audioEndSeconds, 50);
    // The anchor too: it depends on the window the session was analysed with,
    // so a saved session that lost it could never recover the right one.
    assert.equal(saved.tunes[0].audioAnchorSeconds, 25);
});

await test('a session with no recording stores nulls, not undefined', async () => {
    // An undefined field is dropped by structured cloning AND rejected by
    // Firestore, so a session recorded without audio would fail to sync.
    const { service, laStore } = await loadLiveAnalysis();
    service.options = CLUSTER_OPTIONS;
    service.sessionId = 'sZ';
    service._sessionStartedAt = Date.now();
    service._windowMatches = [windowMatch(1, 30), windowMatch(1, 40)];
    service._recluster();
    await service._persistSession();

    const saved = laStore.__sessions.find(s => s.id === 'sZ');
    assert.equal(saved.tunes[0].audioStartSeconds, null);
    assert.ok('audioEndSeconds' in saved.tunes[0]);
});

await test('deleting a session discards its recording', async () => {
    const { service, laRecorder } = await loadLiveAnalysis();
    service.options = CLUSTER_OPTIONS;
    service.sessionId = 'sDel';
    service._sessionStartedAt = Date.now();
    await service.deleteSession();
    assert.deepEqual(laRecorder.__state.discarded, ['sDel']);
});

await test('finishing a session closes the recording', async () => {
    const { service, laRecorder } = await loadLiveAnalysis();
    service.options = CLUSTER_OPTIONS;
    service.sessionId = 'sFin';
    service._sessionStartedAt = Date.now();
    laRecorder.__state.active = true;
    const result = await service.finish();
    assert.equal(result.ok, true);
    assert.ok(laRecorder.__state.ended >= 1);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
