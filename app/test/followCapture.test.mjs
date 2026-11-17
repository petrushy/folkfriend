import assert from 'node:assert/strict';
import { FollowCapture, encodeWavInt16, CAPTURE_TARGET_RATE } from '../src/js/followCapture.mjs';

let clock = 1000;
const now = () => clock;

// 48 kHz is decimated by 3 to 16 kHz, 44.1 kHz by 2 to 22.05 kHz.
{
    const c = new FollowCapture({ now });
    c.addAudio(new Float32Array(4800).fill(0.5), 48000);
    assert.equal(c.rate, 16000);
    assert.equal(c.audioSeconds, 0.1, 'the clock is seconds of audio captured');
    const pcm = c.pcm();
    assert.equal(pcm.length, 1600);
    assert.ok(Math.abs(pcm[0] - 0.5 * 0x7fff) <= 1);
    const d = new FollowCapture({ now });
    d.addAudio(new Float32Array(441), 44100);
    assert.equal(d.rate, 22050);
    assert.ok(CAPTURE_TARGET_RATE <= d.rate);
}

// Chunks that do not divide by the factor lose nothing: the remainder carries.
{
    const c = new FollowCapture({ now });
    for (let i = 0; i < 3; i++) c.addAudio(new Float32Array(1000), 48000); // 3000 samples = 1000 out
    assert.equal(c.pcm().length, 1000);
}

// Events carry the audio clock, so a replay can line the log up with the WAV.
{
    clock = 1000;
    const c = new FollowCapture({ now, meta: { kind: 'set-follow' } });
    c.event('start', { index: 0 });
    c.addAudio(new Float32Array(48000), 48000);
    clock = 2000;
    c.event('window', { contour: 'abc' });
    const log = c.log();
    assert.equal(log.kind, 'set-follow');
    assert.deepEqual(log.events.map(e => [e.type, e.audioSeconds, e.wallMs]), [['start', 0, 0], ['window', 1, 1000]]);
}

// Over the size limit the AUDIO stops and says where; the log carries on.
{
    const c = new FollowCapture({ now, maxBytes: 16000 * 2 }); // one second at 16 kHz
    c.addAudio(new Float32Array(48000), 48000);
    c.addAudio(new Float32Array(48000), 48000);
    assert.equal(c.truncatedAt, 1);
    c.event('shown', { index: 1 });
    const types = c.log().events.map(e => e.type);
    assert.deepEqual(types, ['audio-stopped', 'shown']);
    assert.equal(c.pcm().length, 16000);
}

// A microphone that comes back on another rate cannot share one WAV.
{
    const c = new FollowCapture({ now });
    c.addAudio(new Float32Array(4800), 48000);
    c.addAudio(new Float32Array(4410), 44100);
    assert.equal(c.truncatedAt, 0.1);
    assert.equal(c.log().events[0].reason, 'sample rate changed');
}

// The WAV is a plain 16-bit mono file at the capture's rate.
{
    const buf = encodeWavInt16(new Int16Array([0, 1000, -1000]), 16000);
    const v = new DataView(buf);
    const tag = o => String.fromCharCode(...new Uint8Array(buf, o, 4));
    assert.equal(tag(0), 'RIFF'); assert.equal(tag(8), 'WAVE'); assert.equal(tag(36), 'data');
    assert.equal(v.getUint16(22, true), 1);
    assert.equal(v.getUint32(24, true), 16000);
    assert.equal(v.getUint32(40, true), 6);
    assert.equal(v.getInt16(46, true), 1000);
    assert.equal(buf.byteLength, 50);
}
console.log('Follow capture decimates on one audio clock, caps its size, survives rate changes and writes a plain WAV.');
