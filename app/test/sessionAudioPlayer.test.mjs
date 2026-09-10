// Unit tests for the session audio player's seeking rules.
//
// Run with:  node app/test/sessionAudioPlayer.test.mjs
//
// The player is where "which audio is where" turns into something the user
// presses, and both rules here exist because a recording is NOT necessarily a
// single continuous stretch: a segment that could not be stored leaves a real
// hole, and the clock steps past it so later audio does not overwrite what came
// before. Every seek has to be expressed in terms of the stretches that
// actually exist.
//
// Same harness as tuneBackgroundDialog.test.mjs and liveScoreFollowComponent:
// lift the SFC's <script> block, rewrite its imports to fakes, and drive
// data()/computed/methods against a plain object. No Vue runtime, no browser.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const tmpDir = path.join(here, '.tmp-session-audio-player');

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

const FAKE_EVENTBUS = `export default { $emit() {}, $on() {}, $off() {} };`;
const FAKE_MDI = `export const mdiPlay = 'play'; export const mdiPause = 'pause';`;
const FAKE_SESSION_ANALYSIS = `
export function formatSecondsAsDuration(s) { return String(Math.round(s)); }`;
let store;
const FAKE_AUDIO_STORE = `
export let __manifest = null;
export function __setManifest(m) { __manifest = m; }
export async function playbackReadManifest() { return __manifest; }
export async function buildClip() { return null; }
export function trackRanges() { return []; }
export function formatBytes(n) { return String(n); }
export function fileExtensionFor() { return 'm4a'; }`;

async function loadPlayer() {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'fake-eventbus.mjs'), FAKE_EVENTBUS);
    await writeFile(path.join(tmpDir, 'fake-mdi.mjs'), FAKE_MDI);
    await writeFile(path.join(tmpDir, 'fake-session-analysis.mjs'), FAKE_SESSION_ANALYSIS);
    await writeFile(path.join(tmpDir, 'fake-audio-store.mjs'), FAKE_AUDIO_STORE);

    const sfc = await readFile(path.join(srcDir, 'components', 'SessionAudioPlayer.vue'), 'utf8');
    const open = sfc.indexOf('<script>');
    const close = sfc.indexOf('</script>');
    assert.ok(open !== -1 && close > open, 'expected a <script> block in the SFC');
    let source = sfc.slice(open + '<script>'.length, close);

    for (const [from, to] of [
        ["from '@/eventBus.js'", "from './fake-eventbus.mjs'"],
        ["from '@mdi/js'", "from './fake-mdi.mjs'"],
        ["from '@/js/sessionAnalysis.js'", "from './fake-session-analysis.mjs'"],
        ["from '@/services/sessionAudioStore.js'", "from './fake-audio-store.mjs'"],
    ]) {
        assert.ok(source.includes(from), `expected ${JSON.stringify(from)} in the SFC`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, 'player.mjs'), source);

    const mod = await import(`${path.join(tmpDir, 'player.mjs')}?v=${Math.random()}`);
    store = await import(`${path.join(tmpDir, 'fake-audio-store.mjs')}`);
    return mod.default;
}

// A player sitting on a given manifest, with playFrom() recorded rather than
// performed — what matters is the OFFSET it is asked for.
async function mountPlayer(manifest) {
    const component = await loadPlayer();
    const vm = { $refs: {}, sessionId: 's1', detections: [], listening: false };
    for (const [name, fn] of Object.entries(component.methods)) vm[name] = fn.bind(vm);
    Object.assign(vm, component.data.call(vm));
    for (const [name, fn] of Object.entries(component.computed || {})) {
        Object.defineProperty(vm, name, { get: fn.bind(vm), configurable: true });
    }
    vm.manifest = manifest;
    vm.playRequests = [];
    vm.playFrom = (seconds) => { vm.playRequests.push(seconds); return Promise.resolve(); };
    return vm;
}

// One saved stretch, then a hole where a segment could not be stored, then
// recording resumed.
const GAPPY = {
    sessionId: 's1',
    totalSeconds: 540,
    mimeType: 'audio/mp4',
    tracks: [{ index: 0, startSeconds: 0, durationSeconds: 540 }],
    segments: [
        { index: 0, trackIndex: 0, startSeconds: 0, durationSeconds: 180 },
        // 180–360 was lost.
        { index: 2, trackIndex: 0, startSeconds: 360, durationSeconds: 180 },
    ],
};

await rm(tmpDir, { recursive: true, force: true });

console.log('\nSessionAudioPlayer — seeking around holes in the recording');

await test('the recorded stretches are the segments, contiguous runs merged', async () => {
    const vm = await mountPlayer(GAPPY);
    assert.deepEqual(vm.recordedRanges, [{ from: 0, to: 180 }, { from: 360, to: 540 }]);
});

await test('the gap is drawn, not left looking like ordinary audio', async () => {
    const vm = await mountPlayer(GAPPY);
    assert.equal(vm.gapBlocks.length, 1);
    // 180–360 of 540 → a third of the way across, a third wide.
    assert.ok(vm.gapBlocks[0].left.startsWith('33.3'));
    assert.ok(vm.gapBlocks[0].width.startsWith('33.3'));
});

await test('a tune just after a hole is not sought INTO the hole', async () => {
    // Anchored at 360 exactly here; the point is that nothing before the
    // stretch's own start is ever requested.
    const vm = await mountPlayer(GAPPY);
    await vm.playTune({ audioStartSeconds: 365, audioAnchorSeconds: 360 });
    assert.deepEqual(vm.playRequests, [360], 'clamped to the start of its own stretch');
});

await test('playback starts at the tune\'s stored anchor', async () => {
    // The anchor is the analysed window's MIDPOINT, computed at detection time.
    // audioStartSeconds is where that window ended, so the audio behind the
    // match runs from a window earlier; the midpoint is the one place the tune
    // is certainly playing, where the window's start can still be the tune
    // before it.
    const vm = await mountPlayer(GAPPY);
    await vm.playTune({ audioStartSeconds: 450, audioAnchorSeconds: 445 });
    assert.deepEqual(vm.playRequests, [445]);
});

await test('the anchor scales with the window the session was analysed with', async () => {
    // Which is the whole reason it is stored rather than subtracted at
    // playback: a fixed offset is wrong the moment that setting changes, and
    // cannot be recovered for a session already saved.
    const vm = await mountPlayer(GAPPY);
    await vm.playTune({ audioStartSeconds: 450, audioAnchorSeconds: 435 });  // 30 s window
    assert.deepEqual(vm.playRequests, [435]);
});

await test('a session saved before anchors existed falls back to half a window', async () => {
    // Not the old 12 s: that landed ~2 s BEFORE the analysed window began,
    // which is what made it feel early. Those sessions were almost all
    // recorded at the 10 s default, so half of that is the right guess.
    const vm = await mountPlayer(GAPPY);
    await vm.playTune({ audioStartSeconds: 450 });
    assert.deepEqual(vm.playRequests, [445]);
});

await test('an anchor is still clamped into the tune\'s own stretch', async () => {
    // A long window puts the anchor before a hole that the tune sits just
    // after. The clamp is what stops it seeking into audio that is not there.
    const vm = await mountPlayer(GAPPY);
    await vm.playTune({ audioStartSeconds: 365, audioAnchorSeconds: 350 });
    assert.deepEqual(vm.playRequests, [360]);
});

await test('a tune at the very start of the recording is not sought below zero', async () => {
    const vm = await mountPlayer(GAPPY);
    await vm.playTune({ audioStartSeconds: 4, audioAnchorSeconds: 0 });
    assert.deepEqual(vm.playRequests, [0]);
    // And with no anchor at all, where the fallback would go negative.
    vm.playRequests.length = 0;
    await vm.playTune({ audioStartSeconds: 4 });
    assert.deepEqual(vm.playRequests, [0]);
});

await test('a tune inside the hole is not sought at all', async () => {
    // Its name claimed this and it only checked _rangeContaining, which is not
    // the same assertion: playTune() went on to seek anyway. A tune just inside
    // a hole is the dangerous case — start - 12 s lands in the PRECEDING
    // stretch, so it plays unrelated audio rather than failing.
    //
    // The view does not render a button here, but it decides from state that
    // can be a moment stale while a segment is being written, so the player has
    // to refuse on its own terms.
    const vm = await mountPlayer(GAPPY);
    assert.equal(vm._rangeContaining(250), null);

    await vm.playTune({ audioStartSeconds: 250 });
    assert.deepEqual(vm.playRequests, [], 'no seek was attempted');

    // Just inside the hole, where the preroll would reach back into real audio.
    await vm.playTune({ audioStartSeconds: 185 });
    assert.deepEqual(vm.playRequests, []);
    assert.match(vm.error, /not recorded/);
});

await test('a continuous recording has no gaps and no clamping', async () => {
    const vm = await mountPlayer({
        sessionId: 's1', totalSeconds: 360, mimeType: 'audio/mp4',
        tracks: [{ index: 0, startSeconds: 0, durationSeconds: 360 }],
        segments: [
            { index: 0, trackIndex: 0, startSeconds: 0, durationSeconds: 180 },
            { index: 1, trackIndex: 0, startSeconds: 180, durationSeconds: 180 },
        ],
    });
    assert.deepEqual(vm.recordedRanges, [{ from: 0, to: 360 }]);
    assert.deepEqual(vm.gapBlocks, []);
    await vm.playTune({ audioStartSeconds: 200, audioAnchorSeconds: 195 });
    assert.deepEqual(vm.playRequests, [195]);
});

await test('a refresh only ever adds to what is known', async () => {
    // The read answers a failed IndexedDB lookup with null exactly as it
    // answers "there is no recording", so assigning that result took the whole
    // player off the screen mid-session on one transient hiccup. A refresh runs
    // on every segment write and on every Dropbox status change, which makes it
    // the most frequently executed read in the feature.
    const vm = await mountPlayer(GAPPY);
    store.__setManifest(GAPPY);
    assert.ok(vm.manifest);

    store.__setManifest(null);          // the read comes back empty
    await vm.refreshManifest();
    assert.ok(vm.manifest, 'the player is still there');
    assert.deepEqual(vm.recordedRanges, [{ from: 0, to: 180 }, { from: 360, to: 540 }]);

    // And a manifest that really has grown is still adopted.
    const grown = { ...GAPPY, totalSeconds: 720,
        segments: [...GAPPY.segments, { index: 3, trackIndex: 0, startSeconds: 540, durationSeconds: 180 }] };
    store.__setManifest(grown);
    await vm.refreshManifest();
    assert.equal(vm.manifest.totalSeconds, 720);
});

await test('a seek is scaled to the audio\'s REAL length, not the manifest\'s', async () => {
    // The manifest's times come from the recorder's clock, sampled when chunks
    // arrive. If a clip decodes to a different length than the manifest claims
    // — an encoder that stalled, a muted track that yielded less data than the
    // wall clock expected — then a position two thirds through the manifest is
    // NOT two thirds through the audio, and every ▶ lands late by a growing
    // margin. The audio element is the authority on its own timeline.
    const vm = await mountPlayer(GAPPY);
    const seeks = [];
    vm.$refs.audio = {
        seekable: { length: 1, start: () => 0, end: () => 90 },   // really 90 s
        duration: 90,
        set currentTime(v) { seeks.push(v); },
        get currentTime() { return seeks[seeks.length - 1] || 0; },
    };
    vm.segmentIndex = 0;
    vm.segmentStartSeconds = 0;
    vm._segmentDurationSeconds = 180;      // the manifest claims 180 s
    vm.pendingSeekSeconds = null;

    vm.onLoadedMetadata();
    assert.equal(vm.driftRatio, 0.5, 'measured against what the manifest promised');
    assert.equal(vm.driftSeconds, -90);

    vm._seekWithin(60);
    assert.equal(seeks[seeks.length - 1], 30, 'a third of the way in, on the real timeline');
});

await test('an implausible measurement is ignored rather than trusted', async () => {
    // Metadata that is not fully parsed, or a container reporting nonsense,
    // would otherwise scale every seek by a wild factor — far worse than not
    // scaling at all.
    const vm = await mountPlayer(GAPPY);
    const seeks = [];
    vm.$refs.audio = {
        seekable: { length: 1, start: () => 0, end: () => 2 },    // absurd for a 180 s clip
        duration: 2,
        set currentTime(v) { seeks.push(v); },
        get currentTime() { return 0; },
    };
    vm.segmentIndex = 0;
    vm.segmentStartSeconds = 0;
    vm._segmentDurationSeconds = 180;
    vm.pendingSeekSeconds = null;

    vm.onLoadedMetadata();
    assert.equal(vm.driftRatio, 1, 'left alone');
    vm._seekWithin(60);
    assert.equal(seeks[seeks.length - 1], 60);
});

await test('audio that matches the manifest is not scaled at all', async () => {
    const vm = await mountPlayer(GAPPY);
    const seeks = [];
    vm.$refs.audio = {
        seekable: { length: 1, start: () => 0, end: () => 180 },
        duration: 180,
        set currentTime(v) { seeks.push(v); },
        get currentTime() { return 0; },
    };
    vm.segmentIndex = 0;
    vm.segmentStartSeconds = 0;
    vm._segmentDurationSeconds = 180;
    vm.pendingSeekSeconds = null;

    vm.onLoadedMetadata();
    assert.equal(vm.driftRatio, 1);
    vm._seekWithin(60);
    assert.equal(seeks[seeks.length - 1], 60);
});

await rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
