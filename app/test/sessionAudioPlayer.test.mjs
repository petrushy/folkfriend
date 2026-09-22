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
export let __clip = null;
export function __setClip(c) { __clip = c; }
export const __clipCalls = [];
export async function buildClip(sessionId, from, to) {
    __clipCalls.push([sessionId, from, to]);
    return __clip;
}
export let __tracks = [];
export function __setTracks(t) { __tracks = t; }
export function trackRanges() { return __tracks; }
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
    vm.__realPlayFrom = vm.playFrom;
    vm.playFrom = (seconds) => { vm.playRequests.push(seconds); return Promise.resolve(); };
    return vm;
}

// One saved stretch, then a hole where a segment could not be stored, then
// recording resumed.
// --- a fake Web Audio surface ---------------------------------------------
//
// Only what the channel probe and the playback repair touch: decoding a few
// seconds to PCM (which needs no user gesture, hence an OfflineAudioContext),
// and a gain node in front of the destination.

const audioEnv = {
    decoded: null,          // the AudioBuffer decodeAudioData resolves
    decodeError: null,      // or the error it rejects with
    contexts: [],
    sourceNodes: 0,
    // WebKit-style: remix the decoded buffer down to the decoding context's
    // own channel count.
    remixToContext: false,
};

function fakeBuffer(channels) {
    return {
        numberOfChannels: channels.length,
        getChannelData: (i) => channels[i],
    };
}

// A channel carrying music, and one that is exactly dead.
const LOUD = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i / 4) * 0.4);
const DEAD = new Float32Array(512);
// Not silent, just recorded in a quiet room: still orders of magnitude above
// the threshold.
const QUIET = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i / 4) * 0.002);

// Models the WebKit behaviour the probe must not depend on: decoded data
// remixed to the DECODING CONTEXT's channel count rather than kept at the
// file's. A fake that hands back whatever the test set, whatever the context
// was built with, cannot see a probe that decodes through a one-channel
// context — it echoes the answer the test wanted, exactly as the container
// fake once echoed back the requested mimeType.
class FakeOfflineAudioContext {
    constructor(channels) { this.channelCount = channels; }
    decodeAudioData(bytes, ok, fail) {
        setTimeout(() => {
            if (audioEnv.decodeError) { fail(audioEnv.decodeError); return; }
            const decoded = audioEnv.decoded;
            if (decoded && audioEnv.remixToContext &&
                decoded.numberOfChannels > this.channelCount) {
                const kept = [];
                for (let i = 0; i < this.channelCount; i++) kept.push(decoded.getChannelData(i));
                ok(fakeBuffer(kept));
                return;
            }
            ok(decoded);
        }, 0);
    }
}

class FakeGain {
    constructor() {
        this.channelCount = 2;
        this.channelCountMode = 'max';
        this.channelInterpretation = 'speakers';
        this.gain = { value: 1 };
        this.connectedTo = null;
    }
    connect(node) { this.connectedTo = node; }
}

class FakeAudioContext {
    constructor() {
        this.state = 'running';
        this.destination = { id: 'destination' };
        this.gains = [];
        audioEnv.contexts.push(this);
    }
    createMediaElementSource() {
        audioEnv.sourceNodes++;
        return { connect: (node) => { this.sourceTarget = node; } };
    }
    createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
}

globalThis.window = {
    OfflineAudioContext: FakeOfflineAudioContext,
    AudioContext: FakeAudioContext,
};

function resetAudioEnv() {
    audioEnv.decoded = null;
    audioEnv.decodeError = null;
    audioEnv.contexts = [];
    audioEnv.sourceNodes = 0;
    audioEnv.remixToContext = false;
}

// A player sitting on a recording whose decoded audio is `channels`.
async function mountProbed(channels, { manifestChannels = null, remixToContext = false } = {}) {
    resetAudioEnv();
    // AFTER the reset, which is what wipes it — setting it at the call site
    // before mountProbed() leaves the flag off and the test passes against
    // the bug it exists to catch.
    audioEnv.remixToContext = remixToContext;
    const vm = await mountPlayer({
        sessionId: 's1',
        totalSeconds: 180,
        mimeType: 'audio/mp4',
        channels: manifestChannels,
        tracks: [{ index: 0, startSeconds: 0, durationSeconds: 180 }],
        segments: [{ index: 0, trackIndex: 0, startSeconds: 0, durationSeconds: 180 }],
    });
    store.__setTracks([{ index: 0, startSeconds: 0, endSeconds: 180, durationSeconds: 180 }]);
    store.__setClip({ blob: new Blob(['audio']), mimeType: 'audio/mp4', startSeconds: 0, endSeconds: 4 });
    if (channels) audioEnv.decoded = fakeBuffer(channels);
    vm.$refs.audio = { play: () => Promise.resolve(), pause() {} };
    await vm._probeChannels();
    return vm;
}

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

await test('a seek into a mid-track clip is measured from the TRACK\'s start', async () => {
    // A clip is a track's initialisation bytes followed by chunks carrying
    // that track's own timestamps, so a clip cut an hour into a track begins,
    // as far as the container is concerned, an hour in. Seeking as though it
    // began at zero is what made the timeline work near the start of a session
    // and not further in — and it cannot be measured out of `seekable`, which
    // Chromium reports as [0, Infinity] for exactly these clips.
    const vm = await mountPlayer(GAPPY);
    const seeks = [];
    vm.$refs.audio = {
        seekable: { length: 1, start: () => 0, end: () => Infinity },
        duration: Infinity,
        load() {},
        set currentTime(v) { seeks.push(v); },
        get currentTime() { return seeks[seeks.length - 1] || 0; },
    };
    store.__setClip({
        blob: new Blob(['audio']), mimeType: 'audio/mp4',
        startSeconds: 360, endSeconds: 540, trackStartSeconds: 0,
    });
    await vm._loadSegment(GAPPY.segments[1], 400, false);
    vm.onLoadedMetadata();
    assert.equal(seeks[seeks.length - 1], 400,
        'the track starts at 0, so session time IS media time');

    // A track that itself began ten minutes into the session.
    store.__setClip({
        blob: new Blob(['audio']), mimeType: 'audio/mp4',
        startSeconds: 1200, endSeconds: 1380, trackStartSeconds: 600,
    });
    await vm._loadSegment({ index: 5, trackIndex: 1, startSeconds: 1200, durationSeconds: 180 },
        1260, false);
    vm.onLoadedMetadata();
    assert.equal(seeks[seeks.length - 1], 660, '1260 s into the session, 660 s into the track');

    // And the clock the user reads is the inverse of it.
    vm.$refs.audio.currentTime = 700;
    vm.onTimeUpdate();
    assert.equal(vm.currentSeconds, 1300);
});

await test('a tap on a stretch that was never recorded says so', async () => {
    // Returning silently is indistinguishable from a timeline that does not
    // respond to taps at all, which is how this was reported.
    const vm = await mountPlayer(GAPPY);
    // The real playFrom, not mountPlayer()'s recording stub: what this test
    // is about is the answer it gives.
    vm.playFrom = vm.__realPlayFrom;
    vm.$refs.strip = { getBoundingClientRect: () => ({ left: 0, width: 540 }) };
    vm.onStripClick({ clientX: 270 });          // 270 s — inside the hole
    assert.ok(vm.error, 'the tap is answered');
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
    vm.trackStartSeconds = 0;
    vm._clipMediaEndSeconds = 180;      // the manifest claims 180 s
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
    vm.trackStartSeconds = 0;
    vm._clipMediaEndSeconds = 180;
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
    vm.trackStartSeconds = 0;
    vm._clipMediaEndSeconds = 180;
    vm.pendingSeekSeconds = null;

    vm.onLoadedMetadata();
    assert.equal(vm.driftRatio, 1);
    vm._seekWithin(60);
    assert.equal(seeks[seeks.length - 1], 60);
});

console.log('\nSessionAudioPlayer — a recording that plays out of one speaker');

await test('a dead second channel is measured, not taken from the manifest', async () => {
    // The manifest says two channels and is telling the truth; the file is
    // stereo by every label on it. What makes it play out of one speaker is
    // what the second channel CONTAINS, which only decoding can answer.
    const vm = await mountProbed([LOUD, DEAD], { manifestChannels: 2 });
    assert.deepEqual(vm.channelProbe, { channels: 2, oneSided: true });
    assert.equal(vm.channelsLabel, 'one channel only');
});

await test('playback of a one-sided recording is downmixed to both speakers', async () => {
    const vm = await mountProbed([LOUD, DEAD], { manifestChannels: 2 });
    vm._play();

    assert.equal(audioEnv.sourceNodes, 1, 'the element was routed through the graph');
    const mix = audioEnv.contexts[0].gains[0];
    assert.equal(mix.channelCount, 1);
    assert.equal(mix.channelCountMode, 'explicit', 'this is what forces the downmix');
    // (L + R) / 2 with R silent would cost 6 dB; with R at zero this is exactly L.
    assert.equal(mix.gain.value, 2);
    assert.equal(mix.connectedTo, audioEnv.contexts[0].destination);
    assert.equal(vm.channelRepair, true);
});

await test('a real stereo recording is never touched', async () => {
    // Once an element has a MediaElementAudioSourceNode its sound comes out of
    // the graph rather than the element, permanently — so the graph must never
    // be built speculatively.
    const vm = await mountProbed([LOUD, LOUD], { manifestChannels: 2 });
    assert.equal(vm.channelProbe.oneSided, false);
    assert.equal(vm.channelsLabel, 'stereo');
    vm._play();
    assert.equal(audioEnv.sourceNodes, 0, 'no graph was built');
    assert.equal(vm.channelRepair, false);
});

await test('a quietly recorded room is not mistaken for a dead channel', async () => {
    // Both channels below the threshold is a quiet recording, not a one-sided
    // one. "Correcting" it would be a claim about audio nobody has heard yet.
    const vm = await mountProbed([DEAD, DEAD], { manifestChannels: 2 });
    assert.equal(vm.channelProbe.oneSided, false);
    // And a genuinely quiet one really is stereo.
    const quiet = await mountProbed([QUIET, QUIET], { manifestChannels: 2 });
    assert.equal(quiet.channelProbe.oneSided, false);
    assert.equal(quiet.channelsLabel, 'stereo');
});

await test('a mono recording needs no correction at all', async () => {
    // Which is the whole point of recording mono: one channel is played
    // through both speakers by every player there is.
    const vm = await mountProbed([LOUD], { manifestChannels: 1 });
    assert.equal(vm.channelProbe.oneSided, false);
    assert.equal(vm.channelsLabel, 'mono');
    vm._play();
    assert.equal(audioEnv.sourceNodes, 0);
});

await test('a browser that cannot decode leaves playback exactly as it was', async () => {
    // Not knowing is a perfectly good answer: the probe only ever ADDS a
    // correction, so a failed one costs the correction and nothing else.
    const vm = await mountProbed(null, { manifestChannels: 2 });
    audioEnv.decodeError = new Error('unsupported');
    vm._channelProbeFor = null;
    await vm._probeChannels();

    assert.equal(vm.channelProbe, null);
    assert.equal(vm.channelsLabel, 'stereo', 'the manifest still answers what it can');
    vm._play();
    assert.equal(audioEnv.sourceNodes, 0);
    assert.equal(vm.channelRepair, false);
});

await test('the probe runs once per session, not on every manifest refresh', async () => {
    // A live session re-reads its manifest every few seconds, and decoding
    // audio on each of those would be a real cost for an answer that cannot
    // change.
    const vm = await mountProbed([LOUD, DEAD], { manifestChannels: 2 });
    const calls = store.__clipCalls.length;
    await vm._probeChannels();
    await vm._probeChannels();
    assert.equal(store.__clipCalls.length, calls, 'no further decoding');
});


await test('a one-sided recording is still found when decoding remixes to the context', async () => {
    // WebKit has a long history of remixing decoded data to the DECODING
    // context's channel count. Decoding through a one-channel context then
    // hands back one channel whatever the file holds — so the probe counts one
    // channel, concludes there is nothing to correct, and reports the very
    // recording it was asked to examine as healthy. The symptom is silent and
    // permanent: one speaker, no explanation, no correction.
    const vm = await mountProbed([LOUD, DEAD], { manifestChannels: 2, remixToContext: true });
    assert.equal(vm.channelProbe.channels, 2, 'the FILE has two channels');
    assert.equal(vm.channelProbe.oneSided, true, 'and one of them is dead');
});

await test('the probe never builds the audio graph — only a user gesture does', async () => {
    // _probeChannels() runs from reload() and refreshManifest(), neither of
    // which is a gesture. On iOS an AudioContext built outside one starts
    // suspended and cannot be resumed without one — and an element that has
    // been given a MediaElementAudioSourceNode outputs through the graph
    // PERMANENTLY. So building it here does not merely fail to correct the
    // audio, it can take playback to silent for the whole session.
    const vm = await mountProbed([LOUD, DEAD], { manifestChannels: 2 });
    assert.equal(vm.channelProbe.oneSided, true, 'the finding is recorded');
    assert.equal(audioEnv.sourceNodes, 0, 'but nothing was routed through a graph');
    assert.equal(audioEnv.contexts.length, 0, 'and no AudioContext was created');

    vm._play();
    assert.equal(audioEnv.sourceNodes, 1, 'the gesture is what applies it');
    assert.equal(vm.channelRepair, true);
});

await test('a probe that could not answer says so rather than going quiet', async () => {
    // "Nothing to correct" and "could not work out whether to correct" sound
    // completely different coming out of a phone, and console.debug is
    // unreadable on the device this feature is used on.
    const vm = await mountProbed(null, { manifestChannels: 2 });
    audioEnv.decodeError = new Error('unsupported');
    vm._channelProbeFor = null;
    await vm._probeChannels();
    assert.equal(vm.channelProbeFailed, true);
    assert.equal(vm.channelRepair, false, 'and playback is left exactly as it was');

    // A probe that DID answer never shows it, whatever the answer was.
    const fine = await mountProbed([LOUD, LOUD], { manifestChannels: 2 });
    assert.equal(fine.channelProbeFailed, false);
});

await test('a refused clip reports WHICH failure, not just "not supported"', async () => {
    // play() rejects with NotSupportedError for every reason the element could
    // not use the clip. That message alone sends anyone reading it to the
    // wrong half of the system; the element's own error code and the clip's
    // container are what decide it.
    const vm = await mountProbed([LOUD, LOUD], { manifestChannels: 2 });
    vm.clipMimeType = 'audio/mp4';
    vm.clipBytes = 2048;
    vm.$refs.audio = {
        error: { code: 4 },
        play: () => Promise.reject(new Error('The operation is not supported.')),
        pause() {},
    };
    vm._play();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(vm.error.includes('format not supported'), vm.error);
    assert.ok(vm.error.includes('audio/mp4'), vm.error);
    assert.ok(vm.error.includes('2 kB'), vm.error);
});


await rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
