// Unit tests for the recording check's verdict and report text.
//
// Run with:  node app/test/recordingCheck.test.mjs
//
// The report is what gets copied off a phone with no console, so what it says
// has to be right in the cases that matter: everything fine, damage the backup
// covers, and damage it does not. A verdict that called unrecoverable audio
// "fetched from the backup" would send the user away from the one moment they
// could still do something about it.

import assert from 'node:assert/strict';
import { summariseCheck, formatCheckReport, segmentReadable, segmentLine } from '../src/js/recordingCheck.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`);
    }
}

const good = (index, extra = {}) => ({
    index, trackIndex: 0, startSeconds: index * 180, durationSeconds: 180,
    expectedBytes: 1000, stored: 'bytes', size: 1000, readableBytes: 1000,
    error: null, shape: 'moof+mdat', inCloud: true, chunksMatch: true, ...extra,
});
const broken = (index, extra = {}) => good(index, {
    stored: 'blob', readableBytes: 256, error: 'NotReadableError', ...extra,
});
const report = segments => ({
    sessionId: 's1',
    checkedAt: Date.UTC(2026, 8, 24, 12, 0, 0),
    manifest: { state: 'ok', mimeType: 'audio/mp4', bitsPerSecond: 64000, totalSeconds: 540, bytes: 3000, finalized: true, stopped: null },
    tracks: [{ index: 0, startSeconds: 0, durationSeconds: 540, mimeType: 'audio/mp4', channels: 1,
        init: { stored: 'bytes', size: 700, readableBytes: 700, error: null, shape: 'ftyp+moov' } }],
    segments,
    cloud: { configured: true, state: 'ok', listed: segments.length },
    storage: { usage: 1024 * 1024, quota: 1024 * 1024 * 1024, persisted: true },
});

console.log('\nrecordingCheck');

test('a sound recording says so', () => {
    const s = summariseCheck(report([good(0), good(1), good(2)]));
    assert.equal(s.level, 'success');
    assert.match(s.verdict, /All 3 pieces/);
});

test('damage the backup covers is a warning, and says playback fetches it', () => {
    const s = summariseCheck(report([good(0), broken(1), good(2)]));
    assert.equal(s.level, 'warning');
    assert.equal(s.bad, 1);
    assert.equal(s.recoverable, 1);
    assert.match(s.verdict, /1 of 3 pieces cannot be read.*All of them are in the Dropbox backup/);
});

test('damage the backup does NOT cover is an error, and never claims a backup', () => {
    const s = summariseCheck(report([good(0), broken(1, { inCloud: false }), broken(2, { inCloud: null })]));
    assert.equal(s.level, 'error');
    assert.equal(s.lost, 2, 'an unknown backup state counts as not covered');
    assert.doesNotMatch(s.verdict, /playback fetches/);
});

test('a size that disagrees with the index is not readable, even if every byte reads', () => {
    assert.equal(segmentReadable(good(0, { size: 900, readableBytes: 900 })), false);
    assert.equal(segmentReadable(good(0, { stored: 'missing', size: 0, readableBytes: 0 })), false);
    assert.equal(segmentReadable(good(0)), true);
});

test('an unreadable part header is reported even when every piece reads', () => {
    const r = report([good(0)]);
    r.tracks[0].init = { stored: 'blob', size: 700, readableBytes: 0, error: 'NotReadableError', shape: '' };
    const s = summariseCheck(r);
    assert.equal(s.level, 'warning');
    assert.match(s.verdict, /header of one part/);
    assert.match(formatCheckReport(r), /header FAILS at 0 kB \(NotReadableError\)/);
});

test('no recording on this device is its own answer', () => {
    const s = summariseCheck({ manifest: { state: 'absent' }, segments: [] });
    assert.equal(s.level, 'error');
    assert.match(s.verdict, /no recording/);
});

test('a recording played from the backup says so, and is not called missing', () => {
    const r = report([
        good(0, { stored: 'cached bytes' }),
        good(1, { stored: 'not cached', size: 0, readableBytes: 0, shape: '' }),
        good(2, { stored: 'cached blob' }),
    ]);
    r.source = 'backup';
    r.manifest.state = 'backup';
    const s = summariseCheck(r);
    assert.equal(s.level, 'info');
    assert.match(s.verdict, /no copy of its own: it plays this recording from the Dropbox backup \(3 pieces, 2 downloaded/);
    assert.match(s.verdict, /1 downloaded piece is in the old format/);
    const text = formatCheckReport(r);
    assert.match(text, /Stored on this device: no \(played from the Dropbox backup\)/);
    assert.match(text, /#1 · part 1 · 3:00 · not cached · 1 kB in backup/);
    assert.doesNotMatch(text, /no recording/);
});

test('no local copy and an unreachable backup names the backup state', () => {
    const s = summariseCheck({ manifest: { state: 'absent' }, segments: [],
        cloud: { configured: true, state: 'unavailable: offline' } });
    assert.match(s.verdict, /Dropbox backup: unavailable: offline/);
});

test('the report text carries what is needed to diagnose it remotely', () => {
    const text = formatCheckReport(report([good(0), broken(1)]),
        { appVersion: '3.13.1', userAgent: 'iPhone test', canPlay: 'audio/mp4 maybe' });
    for (const expected of [
        'Session s1', 'App 3.13.1', 'Device iPhone test', 'Can play: audio/mp4 maybe',
        'audio/mp4, 64 kbps', 'Dropbox backup: ok (2 pieces)', 'protected',
        '1 piece is stored in the older format',
        'part 1 · from 0:00 · 9:00 · audio/mp4 · 1 ch · header bytes 1 kB ok ftyp+moov',
        '#1 · part 1 · 3:00 · blob · 1 kB · FAILS at 0 kB (NotReadableError) · moof+mdat · in backup',
    ]) assert.ok(text.includes(expected), `expected ${JSON.stringify(expected)} in:\n${text}`);
});

test('a missing piece line names it and never claims a size', () => {
    const line = segmentLine(good(4, { stored: 'missing', size: 0, readableBytes: 0, shape: '', inCloud: false }));
    assert.equal(line, '#4 · part 1 · 12:00 · missing · NOT READABLE · NOT in backup');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
