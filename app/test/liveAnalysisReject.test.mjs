// Tests for rejecting a tune from the live session, and for the short-detection
// filter as it is actually wired into the live pipeline.
//
// Run with:  node app/test/liveAnalysisReject.test.mjs
//
// The service is loaded for real — with its browser-facing imports (microphone,
// backend, geolocation, store, event bus) rewritten to fakes — because the
// interesting behaviour is entirely in how rejection, re-clustering and the
// collapse of consecutive same-tune rows compose. A reimplementation of that
// composition would prove nothing about the code that ships.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import { loadSessionAnalysisModule, sessionAnalysisTmpDir } from './helpers/loadSessionAnalysis.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-live-analysis');

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

const FAKE_MIC = `export default {
    audioCtx: null,
    async startContinuous() {},
    async stopContinuous() {},
    async ensureMicHealthy() {},
    getContinuousAudio() { return new Float32Array(0); },
    currentLevel: 0,
};`;
const FAKE_BACKEND = `export default { async transcribeAndQueryPCMSignal() { return { results: [] }; } };`;
const FAKE_GEO = `export default { beginSession() {}, async getFix() { return null; } };`;
const FAKE_RECORDER = `
// Session audio is a separate concern from what these tests cover; the real
// recorder needs a MediaRecorder and a quota API that node has neither of.
export const __notes = [];
export default {
    isRecording: false, isActive: false, audioSeconds: null, keepTunesOnly: false,
    noteAnalysed(stamp, info) { __notes.push({ stamp, ...info }); },
    async begin() { return false; }, async resume() { return false; },
    async stop() {}, async end() {}, async discard() {},
    ensureRecording() { return Promise.resolve(false); },
};`;

const FAKE_STORE = `export default { userSettings: {}, state: { indexLoaded: true }, async addSighting() {} };`;
const FAKE_EVENTBUS = `
export const __emits = [];
export default { $emit(name, payload) { __emits.push({ name, payload }); }, $on() {}, $off() {} };
`;

async function loadService() {
    await mkdir(tmpDir, { recursive: true });
    // Loading this first writes the rewritten copy of sessionAnalysis.js that
    // the service's own import is redirected to below.
    await loadSessionAnalysisModule();

    await writeFile(path.join(tmpDir, 'fake-mic.mjs'), FAKE_MIC);
    await writeFile(path.join(tmpDir, 'fake-backend.mjs'), FAKE_BACKEND);
    await writeFile(path.join(tmpDir, 'fake-geo.mjs'), FAKE_GEO);
    await writeFile(path.join(tmpDir, 'fake-recorder.mjs'), FAKE_RECORDER);
    await writeFile(path.join(tmpDir, 'fake-store.mjs'), FAKE_STORE);
    await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);

    let source = await readFile(path.join(srcDir, 'services', 'liveAnalysis.js'), 'utf8');
    const sessionAnalysisCopy = path.join(sessionAnalysisTmpDir, 'sessionAnalysis.mjs');
    const biasModule = path.join(srcDir, 'js', 'biasResults.mjs');
    const replacements = [
        ["from './mic.js'", "from './fake-mic.mjs'"],
        ["from './backend.js'", "from './fake-backend.mjs'"],
        ["from './geo.js'", "from './fake-geo.mjs'"],
        ["from './sessionRecorder.js'", "from './fake-recorder.mjs'"],
        ["from './store.js'", "from './fake-store.mjs'"],
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        // Deliberately the real modules: clustering and the short-detection
        // filter are the far side of the wiring under test.
        ["from '@/js/sessionAnalysis.js'", `from '${sessionAnalysisCopy}'`],
        ["from '@/js/biasResults.mjs'", `from '${biasModule}'`],
        ["from '@/js/detectionFreshness.mjs'", `from '${path.join(srcDir, 'js', 'detectionFreshness.mjs')}'`],
        ["from '@/js/tuneCapture.mjs'", `from '${path.join(srcDir, 'js', 'tuneCapture.mjs')}'`],
        ["from '@/js/liveCadence.mjs'", `from '${path.join(srcDir, 'js', 'liveCadence.mjs')}'`],
        ["from '@/js/audioKeep.mjs'", `from '${path.join(srcDir, 'js', 'audioKeep.mjs')}'`],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in liveAnalysis.js`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'liveAnalysis.mjs'), source);

    const bus = await import(path.join(tmpDir, 'fake-eventbus.mjs'));
    bus.__emits.length = 0;
    const mod = await import(`${path.join(tmpDir, 'liveAnalysis.mjs')}?v=${Math.random()}`);
    const service = mod.default;

    // The state start() would have set, without touching a microphone.
    service.options = {
        windowSeconds: 10,
        stepSeconds: 5,
        mergeGapSeconds: 10,
        minTopScore: 0.4,
        minClusterHits: 2,
        maxAlternatives: 3,
        previousTuneBiasDelta: 0.15,
    };
    service._windowMatches = [];
    service.detections = [];
    service.elapsedSeconds = 0;
    service._rejectedTunes.clear();

    return { service, bus };
}

// One window match, as _runLoop would push it.
function match(tuneId, startSeconds, score = 0.7) {
    return {
        startSeconds,
        tuneId,
        settingId: String(tuneId * 10),
        sourceUrl: '',
        dataset: '',
        displayName: `tune-${tuneId}`,
        score,
        alternatives: [],
    };
}

// Feeds a run of consecutive windows for one tune, at the service's step.
function play(service, tuneId, fromSeconds, windowCount, score = 0.7) {
    for (let i = 0; i < windowCount; i++) {
        service._windowMatches.push(
            match(tuneId, fromSeconds + i * service.options.stepSeconds, score));
    }
    service.elapsedSeconds =
        fromSeconds + (windowCount - 1) * service.options.stepSeconds;
    service._recluster();
}

await mkdir(tmpDir, { recursive: true });

console.log('\nshort detections leaving the live tune list');

await test('a one-window blip drops off once the next tune starts', async () => {
    const { service } = await loadService();

    play(service, 1, 0, 6);          // 25s+window: a real tune
    play(service, 2, 40, 1);         // one spurious window
    assert.deepEqual(service.detections.map(d => d.tuneId), [1, 2],
        'while it is the tune being played it must still be shown');

    play(service, 3, 60, 6);
    assert.deepEqual(service.detections.map(d => d.tuneId), [1, 3],
        'once another tune starts, the blip is not a tune that was played');
});

await test('a blip in the middle of a tune lets the two halves merge', async () => {
    const { service } = await loadService();

    play(service, 1, 0, 6);
    play(service, 2, 40, 1);         // blip
    play(service, 1, 60, 6);         // same tune resumes
    play(service, 3, 120, 6);        // and then a genuine change

    assert.deepEqual(service.detections.map(d => d.tuneId), [1, 3],
        'the filter runs before the collapse, so tune 1 is one row, not two');
});

console.log('\nrejecting the tune on screen');

await test('rejecting drops the tune from the list and reverts to the previous one', async () => {
    const { service, bus } = await loadService();

    play(service, 1, 0, 6);
    play(service, 2, 40, 6);
    assert.deepEqual(service.detections.map(d => d.tuneId), [1, 2]);

    bus.__emits.length = 0;
    service.rejectTune(2);

    assert.deepEqual(service.detections.map(d => d.tuneId), [1],
        'the wrong tune leaves the list, and the previous detection is current again');
    assert.ok(bus.__emits.some(e => e.name === 'liveAnalysisUpdate'),
        'the view has to be told');
});

await test('a rejected tune does not come straight back from the same audio', async () => {
    const { service } = await loadService();

    play(service, 1, 0, 6);
    play(service, 2, 40, 6);
    service.rejectTune(2);

    // The very next cycle still matches it — that is the whole problem.
    const results = [
        { setting: { tune_id: 2 }, setting_id: 20, score: 0.8, display_name: 'tune-2' },
        { setting: { tune_id: 1 }, setting_id: 10, score: 0.7, display_name: 'tune-1' },
    ];
    const usable = service._withoutRejectedTunes(results);
    assert.deepEqual(usable.map(r => r.setting.tune_id), [1],
        'the rejected tune is filtered out and the next best is promoted');
});

await test('the rejection lapses, so the tune is findable later in the evening', async () => {
    const { service } = await loadService();

    play(service, 1, 0, 6);
    play(service, 2, 40, 6);
    service.rejectTune(2);

    const results = [{ setting: { tune_id: 2 }, setting_id: 20, score: 0.8, display_name: 'tune-2' }];
    assert.equal(service._withoutRejectedTunes(results).length, 0);

    service.elapsedSeconds += 200;
    assert.equal(service._withoutRejectedTunes(results).length, 1,
        'after the cooldown a genuine performance of that tune must be detectable');
    assert.equal(service._rejectedTunes.size, 0, 'and the lapsed entry is dropped');
});

await test('rejecting clears every trailing cluster of that tune', async () => {
    const { service } = await loadService();

    // Tune 2 matched, then a silent stretch, then matched again. That is two
    // clusters too far apart to merge, which collapseConsecutiveSameTune then
    // shows as ONE row spanning only the later cluster — so removeDetection
    // drops only the later cluster's matches and the earlier one becomes the
    // new tail. Rejecting once has to see that through, or the overlay sits on
    // the same wrong tune and the button looks broken.
    play(service, 1, 0, 6);
    play(service, 2, 40, 6);
    service.elapsedSeconds = 110;            // a gap with no matches at all
    play(service, 2, 120, 6);
    assert.deepEqual(service.detections.map(d => d.tuneId), [1, 2],
        'the two tune-2 clusters read as one row');

    service.rejectTune(2);
    assert.deepEqual(service.detections.map(d => d.tuneId), [1],
        'both trailing clusters go, and the previous tune is current again');
});

await test('rejecting keeps an earlier hearing that another tune separates', async () => {
    const { service } = await loadService();

    play(service, 2, 0, 6);
    play(service, 3, 40, 6);
    play(service, 2, 80, 6);
    assert.deepEqual(service.detections.map(d => d.tuneId), [2, 3, 2]);

    service.rejectTune(2);
    assert.deepEqual(service.detections.map(d => d.tuneId), [2, 3],
        'an earlier hearing with a different tune after it is a separate claim and stays');
});

await test('rejecting a tune that is not on the list still suppresses it', async () => {
    const { service, bus } = await loadService();

    play(service, 1, 0, 6);
    bus.__emits.length = 0;
    service.rejectTune(99);

    assert.deepEqual(service.detections.map(d => d.tuneId), [1]);
    const results = [{ setting: { tune_id: 99 }, setting_id: 990, score: 0.9, display_name: 'x' }];
    assert.equal(service._withoutRejectedTunes(results).length, 0);
    assert.ok(bus.__emits.some(e => e.name === 'liveAnalysisUpdate'));
});

await test('rejecting the only tune leaves an empty list rather than throwing', async () => {
    const { service } = await loadService();

    play(service, 1, 0, 6);
    service.rejectTune(1);
    assert.deepEqual(service.detections, []);
});

await test('a null tuneId is ignored', async () => {
    const { service } = await loadService();
    play(service, 1, 0, 6);
    service.rejectTune(null);
    assert.deepEqual(service.detections.map(d => d.tuneId), [1]);
    assert.equal(service._rejectedTunes.size, 0);
});

// ---- the detection LED ----------------------------------------------------
//
// The service half of the indicator. It is derived from _windowMatches rather
// than tracked in a field of its own, and these are the two cases that
// distinguishes: a rejection and a silence both have to move it, and a field
// updated in the loop moves for neither.

await test('the LED follows the last accepted window match', async () => {
    const { service } = await loadService();
    service.isRunning = true;
    play(service, 1, 0, 6);
    service.elapsedSeconds = 30;

    const led = service.detectionFreshness();
    assert.equal(led.level, 'green');
    assert.equal(led.score, 0.7);
});

await test('silence after the last match takes the LED to red', async () => {
    const { service } = await loadService();
    service.isRunning = true;
    play(service, 1, 0, 6);
    // Twenty minutes of talking, with the loop finding nothing to accept.
    service.elapsedSeconds = 30 + 20 * 60;

    assert.equal(service.detectionFreshness().level, 'red');
});

await test('rejecting the tune takes its matches — and the LED — with it', async () => {
    // The reason this is derived rather than stored: a field written by the
    // loop would still be reporting a confident green for a tune the user has
    // just told the app was wrong.
    const { service } = await loadService();
    service.isRunning = true;
    play(service, 1, 0, 6);
    service.elapsedSeconds = 30;
    assert.equal(service.detectionFreshness().level, 'green');

    service.rejectTune(1);
    assert.equal(service.lastWindowMatch(), null);
    assert.equal(service.detectionFreshness().level, 'idle');
});

await test('a paused session shows the LED off rather than red', async () => {
    const { service } = await loadService();
    service.isRunning = false;
    play(service, 1, 0, 6);
    service.elapsedSeconds = 30 + 20 * 60;

    assert.equal(service.detectionFreshness().level, 'off');
});

console.log('\nliveAnalysis — evidence for a "tunes only" recording');

await test('every analysed window is reported, judged on the RAW best score', async () => {
    const { service } = await loadService();
    const recorder = await import(path.join(tmpDir, 'fake-recorder.mjs'));
    const store = (await import(path.join(tmpDir, 'fake-store.mjs'))).default;
    recorder.__notes.length = 0;
    store.userSettings.sessionAudioTunesOnly = true;
    const result = (tuneId, score) => ({ score, setting: { tune_id: tuneId } });
    // A rejected tune is still a tune being played: the evidence ignores
    // rejections, which only decide what is LISTED.
    service._rejectedTunes.set('7', 0);
    service._reportAnalysedWindow(100, { results: [result(7, 0.5)] }, service.options);
    service._reportAnalysedWindow(105, { results: [result(8, 0.2)] }, service.options);
    service._reportAnalysedWindow(110, { results: [] }, service.options);
    assert.deepEqual(recorder.__notes.map(n => [n.stamp, n.music, n.windowSeconds]),
        [[100, true, 10], [105, false, 10], [110, false, 10]]);
    assert.equal(recorder.default.keepTunesOnly, true, 'the setting reaches the recorder');
});

await test('a window that was not really analysed is never reported as a break', async () => {
    const { service } = await loadService();
    const recorder = await import(path.join(tmpDir, 'fake-recorder.mjs'));
    const store = (await import(path.join(tmpDir, 'fake-store.mjs'))).default;
    recorder.__notes.length = 0;
    service._reportAnalysedWindow(100, { error: 'analysis timeout', results: [] }, service.options);
    service._reportAnalysedWindow(null, { results: [] }, service.options);
    store.state.indexLoaded = false;
    service._reportAnalysedWindow(105, { results: [] }, service.options);
    store.state.indexLoaded = true;
    assert.deepEqual(recorder.__notes, []);
});

console.log('\nrecord this tune');

// A recorder fake that really turns on and off, so the reconcile path is the
// real one and only the MediaRecorder underneath is pretend.
async function loadCaptureService() {
    const { service, bus } = await loadService();
    const recorder = (await import(path.join(tmpDir, 'fake-recorder.mjs'))).default;
    const store = (await import(path.join(tmpDir, 'fake-store.mjs'))).default;
    store.userSettings = {};
    recorder.isActive = false;
    recorder.error = '';
    recorder.__fail = false;
    recorder.resume = async function () { if (!this.__fail) this.isActive = true; return !this.__fail; };
    recorder.end = async function () { this.isActive = false; };
    recorder.stop = async function () {};
    service.sessionId = 'sess-1';
    service.isRunning = true;
    service.tuneCapture = null;
    return { service, bus, recorder, store };
}

await test('capturing starts the recorder and binds to the tune being played', async () => {
    const { service, recorder } = await loadCaptureService();
    play(service, 1, 0, 6);
    const result = await service.captureTune();
    assert.deepEqual(result, { ok: true });
    assert.equal(recorder.isActive, true);
    assert.equal(service.tuneCapture.tuneId, '1');
});

await test('the recording stops by itself once the next tune is confirmed', async () => {
    const { service, recorder, bus } = await loadCaptureService();
    play(service, 1, 0, 6);
    await service.captureTune();
    play(service, 2, 40, 1);
    service._checkTuneCapture();
    await service._recorderSync;
    assert.equal(recorder.isActive, true, 'a single stray window does not end it');
    play(service, 2, 40, 3);
    service._checkTuneCapture();
    await service._recorderSync;
    assert.equal(service.tuneCapture, null);
    assert.equal(recorder.isActive, false, 'off again without anyone touching it');
    const ended = bus.__emits.filter(e => e.name === 'liveAnalysisCaptureState').pop();
    assert.equal(ended.payload.endedReason, 'next-tune');
});

await test('not clickable while audio is already being recorded', async () => {
    const { service, recorder, store } = await loadCaptureService();
    recorder.isActive = true;
    assert.equal(service.tuneCaptureAvailability(), 'recording');
    assert.equal((await service.captureTune()).ok, false);
    assert.equal(service.tuneCapture, null);
    recorder.isActive = false;
    store.userSettings = { recordSessionAudio: true };
    assert.equal(service.tuneCaptureAvailability(), 'recording');
});

await test('a recorder that cannot start leaves no capture behind', async () => {
    const { service, recorder } = await loadCaptureService();
    recorder.__fail = true;
    recorder.error = 'Not enough free storage to record audio.';
    const result = await service.captureTune();
    assert.equal(result.ok, false);
    assert.match(result.error, /storage/);
    assert.equal(service.tuneCapture, null);
});

await test('a Pause ends the capture, so Resume does not record again', async () => {
    const { service, recorder } = await loadCaptureService();
    play(service, 1, 0, 6);
    await service.captureTune();
    await service.stop();
    assert.equal(service.tuneCapture, null);
    service.isRunning = true;
    await service._syncRecorderToSetting({ resuming: true });
    assert.equal(recorder.isActive, false);
});

await test('rejecting the captured tune re-binds rather than stopping the recording', async () => {
    const { service, recorder } = await loadCaptureService();
    play(service, 1, 0, 6);
    play(service, 2, 40, 6);
    await service.captureTune();
    assert.equal(service.tuneCapture.tuneId, '2');
    service.rejectTune(2);
    assert.equal(service.tuneCapture.tuneId, null, 'unbound, to adopt the right tune next');
    service._checkTuneCapture();
    await service._recorderSync;
    assert.equal(recorder.isActive, true, 'the tune tail reverting to 1 must not end it');
});

await test('correcting the captured tune renames it rather than ending it', async () => {
    const { service, recorder } = await loadCaptureService();
    play(service, 1, 0, 6);
    await service.captureTune();
    const tail = service.detections[service.detections.length - 1];
    service.applyCorrection(tail.id, { tuneId: 9, settingId: '90', title: 'tune-9' });
    assert.equal(service.tuneCapture.tuneId, '9');
    service._checkTuneCapture();
    await service._recorderSync;
    assert.equal(recorder.isActive, true);
});

await test("the session page's switch supersedes a capture", async () => {
    const { service, recorder, store } = await loadCaptureService();
    play(service, 1, 0, 6);
    await service.captureTune();
    store.userSettings.recordSessionAudio = false;
    await service.syncAudioRecording();
    assert.equal(service.tuneCapture, null);
    assert.equal(recorder.isActive, false, 'switch OFF stops it, captured tune included');
});

await test('the record button shows the level being RECORDED, a whole-session recording included', async () => {
    const { service, recorder } = await loadCaptureService();
    const mic = (await import(path.join(tmpDir, 'fake-mic.mjs'))).default;
    recorder.isRecording = false;
    mic.currentLevel = 0.3;
    assert.equal(service.recordingLevel(), null, 'nothing recorded: no meter at all, not a silent one');

    // No one-tune capture: the session page's switch is recording.
    recorder.isRecording = true;
    recorder.muted = false;
    mic.currentLevel = Math.pow(10, -5 / 20);
    assert.equal(service.recordingLevel(), 1, 'loud');
    mic.currentLevel = Math.pow(10, -27.5 / 20);
    assert.ok(Math.abs(service.recordingLevel() - 0.5) < 1e-9, 'mid-scale on the meter\'s dB range');
    mic.currentLevel = 0;
    assert.equal(service.recordingLevel(), 0, 'recording, but no sound arriving');
    mic.currentLevel = 0.3;
    recorder.muted = true;
    assert.equal(service.recordingLevel(), 0, 'a muted recording keeps silence');
});

await rm(tmpDir, { recursive: true, force: true });
await rm(sessionAnalysisTmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
