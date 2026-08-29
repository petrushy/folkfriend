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
};`;
const FAKE_BACKEND = `export default { async transcribeAndQueryPCMSignal() { return { results: [] }; } };`;
const FAKE_GEO = `export default { beginSession() {}, async getFix() { return null; } };`;
const FAKE_STORE = `export default { userSettings: {}, async addSighting() {} };`;
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
    await writeFile(path.join(tmpDir, 'fake-store.mjs'), FAKE_STORE);
    await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);

    let source = await readFile(path.join(srcDir, 'services', 'liveAnalysis.js'), 'utf8');
    const sessionAnalysisCopy = path.join(sessionAnalysisTmpDir, 'sessionAnalysis.mjs');
    const biasModule = path.join(srcDir, 'js', 'biasResults.mjs');
    const replacements = [
        ["from './mic.js'", "from './fake-mic.mjs'"],
        ["from './backend.js'", "from './fake-backend.mjs'"],
        ["from './geo.js'", "from './fake-geo.mjs'"],
        ["from './store.js'", "from './fake-store.mjs'"],
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        // Deliberately the real modules: clustering and the short-detection
        // filter are the far side of the wiring under test.
        ["from '@/js/sessionAnalysis.js'", `from '${sessionAnalysisCopy}'`],
        ["from '@/js/biasResults.mjs'", `from '${biasModule}'`],
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

await rm(tmpDir, { recursive: true, force: true });
await rm(sessionAnalysisTmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
