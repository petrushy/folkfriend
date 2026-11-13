// Unit tests for the whole-session export (js/sessionExport.mjs + mp3Encoder.mjs).
//
// Run with:  node app/test/sessionExport.test.mjs
//
// The decoder and the clip builder are faked; the MP3 encoder is the real
// lamejs, and the output is checked by walking its frame headers — so "the
// file is as long as the parts put together" is measured in the bytes, not
// asserted from the bookkeeping.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src', 'js');
const {
    exportPlan, exportSession, mixToMono, leadingPaddingSeconds, mp3KbpsFor,
    canExportWholeSession, applyFades, ExportCancelled, JOIN_FADE_SECONDS,
} = await import(path.join(src, 'sessionExport.mjs'));
const { createMp3Encoder, floatToInt16 } = await import(path.join(src, 'mp3Encoder.mjs'));
const { recordingParts } = await import(path.join(src, 'clipWindow.mjs'));
const { Mp3Encoder } = await import(path.join(here, '..', 'node_modules', '@breezystack', 'lamejs', 'dist', 'lamejs.js'));

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

const RATE = 8000;   // small, so the fakes stay cheap; the encoder test uses 44.1k

// A manifest of `spec` = [[trackIndex, start, duration], ...] segments.
function manifestOf(spec, { tracks = null, bitsPerSecond = 64000 } = {}) {
    const segments = spec.map(([trackIndex, startSeconds, durationSeconds], index) =>
        ({ index, trackIndex, startSeconds, durationSeconds, bytes: 1000 }));
    const trackIDs = [...new Set(spec.map(s => s[0]))];
    return {
        bitsPerSecond,
        segments,
        tracks: tracks || trackIDs.map(index => {
            const mine = segments.filter(s => s.trackIndex === index);
            const start = Math.min(...mine.map(s => s.startSeconds));
            const end = Math.max(...mine.map(s => s.startSeconds + s.durationSeconds));
            return { index, startSeconds: start, durationSeconds: end - start };
        }),
    };
}

function sine(n, amplitude = 0.5) {
    return Float32Array.from({ length: n }, (_, i) => Math.sin(i / 3) * amplitude);
}

// buildClip/decode fakes: a clip carries the range it was cut for, and decodes
// to that many seconds of a tone on the LEFT channel and nothing on the right
// — the one-sided recording iOS makes.
function fakes({ failMidTrack = false, padFromOrigin = false, manifest = null } = {}) {
    const calls = { clips: [], decodes: 0 };
    const trackStartAt = (from) => {
        const t = manifest && manifest.tracks.find(t => from >= t.startSeconds - 0.01 &&
            from < t.startSeconds + t.durationSeconds);
        return t ? t.startSeconds : 0;
    };
    return {
        calls,
        buildClip: async (from, to) => { calls.clips.push([from, to]); return { blob: { from, to } }; },
        decode: async ({ from, to }) => {
            calls.decodes++;
            const origin = trackStartAt(from);
            if (failMidTrack && from > origin + 0.01) throw new Error('mid-track clip refused');
            const seconds = padFromOrigin ? to - origin : to - from;
            const n = Math.round(seconds * RATE);
            const left = sine(n);
            return { sampleRate: RATE, numberOfChannels: 2, getChannelData: i => (i ? new Float32Array(n) : left) };
        },
    };
}

function recordingEncoder() {
    const chunks = [];
    return {
        chunks,
        finished: false,
        encode(samples) { chunks.push(samples); },
        finish() { this.finished = true; return 'done'; },
        get length() { return chunks.reduce((n, c) => n + c.length, 0); },
    };
}

// Walks MPEG-1 Layer III frame headers; returns { frames, seconds }.
function mp3Duration(bytes) {
    const rates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const sampleRates = [44100, 48000, 32000];
    let at = 0;
    let frames = 0;
    let sampleRate = 44100;
    while (at + 4 <= bytes.length) {
        if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) { at++; continue; }
        const bitrate = rates[(bytes[at + 2] >> 4) & 0xf] * 1000;
        sampleRate = sampleRates[(bytes[at + 2] >> 2) & 0x3];
        const padding = (bytes[at + 2] >> 1) & 1;
        if (!bitrate || !sampleRate) { at++; continue; }
        frames++;
        at += Math.floor(144 * bitrate / sampleRate) + padding;
    }
    return { frames, seconds: frames * 1152 / sampleRate };
}

function concat(chunks) {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

console.log('sessionExport');

await test('MP3 bitrate follows the recording, between 64 and 128', () => {
    assert.equal(mp3KbpsFor(32000), 64);
    assert.equal(mp3KbpsFor(64000), 64);
    assert.equal(mp3KbpsFor(90000), 96);
    assert.equal(mp3KbpsFor(160000), 128);
    assert.equal(mp3KbpsFor(undefined), 96);
});

await test('an imported file keeps its own export; a recording gets the joined one', () => {
    const recorded = manifestOf([[0, 0, 60]]);
    assert.equal(canExportWholeSession(recorded, recordingParts(recorded)), true);
    const imported = manifestOf([[0, 0, 60]], { tracks: [{ index: 0, startSeconds: 0, durationSeconds: 60, wholeFile: true }] });
    assert.equal(canExportWholeSession(imported, recordingParts(imported)), false);
    assert.equal(canExportWholeSession(null, []), false);
});

await test('windows group whole segments within a part and never cross a part', () => {
    // Track 0: 0–360 contiguous, then a pruned hole, then 420–480.
    // Track 1 (after a pause): 500–620.
    const m = manifestOf([
        [0, 0, 60], [0, 60, 60], [0, 120, 60], [0, 180, 60], [0, 240, 60], [0, 300, 60],
        [0, 420, 60],
        [1, 500, 60], [1, 560, 60],
    ]);
    const plan = exportPlan(m, recordingParts(m), { maxWindowSeconds: 150 });
    assert.equal(plan.length, 3);
    assert.deepEqual(plan[0].windows.map(w => [w.fromSeconds, w.toSeconds]),
        [[0, 120], [120, 240], [240, 360]]);
    assert.deepEqual(plan[1].windows.map(w => [w.fromSeconds, w.toSeconds]), [[420, 480]]);
    assert.deepEqual(plan[2].windows.map(w => [w.fromSeconds, w.toSeconds]), [[500, 620]]);
});

await test('a segment longer than the window is still one window', () => {
    const m = manifestOf([[0, 0, 180], [0, 180, 180]]);
    const plan = exportPlan(m, recordingParts(m), { maxWindowSeconds: 60 });
    assert.deepEqual(plan[0].windows.map(w => [w.fromSeconds, w.toSeconds]), [[0, 180], [180, 360]]);
});

await test('a dead channel is dropped, not averaged in at half level', () => {
    const left = sine(100);
    const mono = mixToMono([left, new Float32Array(100)]);
    assert.deepEqual(Array.from(mono), Array.from(left));
    assert.notEqual(mono, left, 'a copy, so it can be transferred');
    const both = mixToMono([Float32Array.of(1, 0.5), Float32Array.of(0, 0.5)]);
    assert.deepEqual(Array.from(both), [0.5, 0.5]);
});

await test('leading padding is cut only when the decoder clearly padded to the track origin', () => {
    const w = { fromSeconds: 600, toSeconds: 900 };
    assert.equal(leadingPaddingSeconds(900, w, 0), 600);
    assert.equal(leadingPaddingSeconds(300, w, 0), 0);
    // Wall-clock drift is not padding.
    assert.equal(leadingPaddingSeconds(310, w, 0), 0);
    // A window at the track's own start can have no padding.
    assert.equal(leadingPaddingSeconds(300, { fromSeconds: 0, toSeconds: 300 }, 0), 0);
});

await test('fades shape only the ends asked for', () => {
    const s = new Float32Array(RATE).fill(1);
    applyFades(s, RATE, { fadeIn: true });
    assert.equal(s[0], 0);
    assert.equal(s[s.length - 1], 1);
    applyFades(s, RATE, { fadeOut: true });
    assert.equal(s[s.length - 1], 0);
    assert.equal(s[Math.round(JOIN_FADE_SECONDS * RATE) + 5], 1);
});

await test('every part reaches the encoder in order, back to back, with fades only at part joins', async () => {
    const m = manifestOf([[0, 0, 10], [0, 10, 10], [1, 100, 5]]);
    const f = fakes({ manifest: m });
    const encoder = recordingEncoder();
    const progress = [];
    const { seconds, parts } = await exportSession({
        manifest: m, parts: recordingParts(m), buildClip: f.buildClip, decode: f.decode, encoder,
        maxWindowSeconds: 10, onProgress: (d, t) => progress.push([d, t]),
    });
    assert.equal(parts, 2);
    assert.deepEqual(f.calls.clips, [[0, 10], [10, 20], [100, 105]]);
    assert.equal(encoder.length, 25 * RATE, 'no silence for the 80 s gap');
    assert.equal(seconds, 25);
    assert.ok(encoder.finished);
    const [w1, w2, w3] = encoder.chunks;
    // The very start and end of the file are not faded; the join is.
    assert.notEqual(w1[1], 0);
    assert.equal(w2[w2.length - 1], 0, 'faded out into the join');
    assert.equal(w3[0], 0, 'faded in after the join');
    // A window boundary INSIDE a part is continuous audio: untouched.
    assert.equal(w1[w1.length - 1], sine(10 * RATE)[10 * RATE - 1]);
    assert.notEqual(w2[1], 0);
    assert.deepEqual(progress[progress.length - 1], [25, 25]);
});

await test('a mid-track window the browser refuses falls back to decoding the part whole', async () => {
    const m = manifestOf([[0, 0, 10], [0, 10, 10], [0, 20, 10]]);
    const f = fakes({ manifest: m, failMidTrack: true });
    const encoder = recordingEncoder();
    const { seconds } = await exportSession({
        manifest: m, parts: recordingParts(m), buildClip: f.buildClip, decode: f.decode, encoder,
        maxWindowSeconds: 10,
    });
    // First window decoded alone, then the whole part, of which the last 20 s are used.
    assert.deepEqual(f.calls.clips, [[0, 10], [10, 20], [0, 30]]);
    assert.equal(encoder.length, 30 * RATE);
    assert.equal(seconds, 30);
});

await test('a refused window in a part too long to decode whole is an error naming the part', async () => {
    const m = manifestOf([[0, 0, 10], [1, 50, 10], [1, 60, 10]]);
    const f = fakes({ manifest: m, failMidTrack: true });
    await assert.rejects(exportSession({
        manifest: m, parts: recordingParts(m), buildClip: f.buildClip, decode: f.decode,
        encoder: recordingEncoder(), maxWindowSeconds: 10, fallbackMaxPartSeconds: 15,
    }), /part 2 could not be decoded: mid-track clip refused/);
});

await test('a decoder that pads a window back to the track origin is trimmed', async () => {
    const m = manifestOf([[0, 0, 10], [0, 10, 10]]);
    const f = fakes({ manifest: m, padFromOrigin: true });
    const encoder = recordingEncoder();
    await exportSession({
        manifest: m, parts: recordingParts(m), buildClip: f.buildClip, decode: f.decode, encoder,
        maxWindowSeconds: 10,
    });
    assert.equal(encoder.length, 20 * RATE);
});

await test('cancelling stops before the next window and never finishes the file', async () => {
    const m = manifestOf([[0, 0, 10], [0, 10, 10], [0, 20, 10]]);
    const f = fakes({ manifest: m });
    const encoder = recordingEncoder();
    let cancelled = false;
    const run = exportSession({
        manifest: m, parts: recordingParts(m), buildClip: f.buildClip, decode: f.decode, encoder,
        maxWindowSeconds: 10, isCancelled: () => cancelled,
        onProgress: (done) => { if (done >= 10) cancelled = true; },
    });
    await assert.rejects(run, (e) => e instanceof ExportCancelled);
    assert.equal(encoder.chunks.length, 1);
    assert.equal(encoder.finished, false);
});

await test('a missing stretch is an error, not a silently shorter file', async () => {
    const m = manifestOf([[0, 0, 10], [1, 50, 10]]);
    const f = fakes({ manifest: m });
    await assert.rejects(exportSession({
        manifest: m, parts: recordingParts(m),
        buildClip: async (from, to) => { if (from === 50) throw new Error('Some audio for this part is missing'); return f.buildClip(from, to); },
        decode: f.decode, encoder: recordingEncoder(),
    }), /part 2 could not be decoded: Some audio for this part is missing/);
});

await test('the real encoder produces an MP3 as long as the parts put together', async () => {
    const rate = 44100;
    const m = manifestOf([[0, 0, 4], [0, 4, 3], [1, 60, 5]], { bitsPerSecond: 160000 });
    const encoder = createMp3Encoder(Mp3Encoder, { sampleRate: rate, kbps: mp3KbpsFor(m.bitsPerSecond) });
    const { result, seconds } = await exportSession({
        manifest: m, parts: recordingParts(m),
        buildClip: async (from, to) => ({ blob: { from, to } }),
        decode: async ({ from, to }) => {
            const n = Math.round((to - from) * rate);
            const tone = Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 440 * i / rate) * 0.5);
            return { sampleRate: rate, numberOfChannels: 2, getChannelData: i => (i ? new Float32Array(n) : tone) };
        },
        encoder,
        maxWindowSeconds: 4,
    });
    assert.equal(seconds, 12);
    const bytes = concat(result);
    const { seconds: mp3Seconds } = mp3Duration(bytes);
    // lamejs adds encoder delay and padding: up to a couple of frames.
    assert.ok(Math.abs(mp3Seconds - 12) < 0.1, `MP3 is ${mp3Seconds} s`);
    // 128 kbps for 12 s is ~192 kB.
    assert.ok(Math.abs(bytes.length - 192000) < 8000, `${bytes.length} bytes`);
});

await test('float to 16-bit clamps rather than wrapping', () => {
    assert.deepEqual(Array.from(floatToInt16(Float32Array.of(2, -2, 0, 1, -1))), [32767, -32768, 0, 32767, -32768]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
