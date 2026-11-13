// The Tune view's practice follow: listening for one setting without a
// session (js/practiceFollow.mjs), driven against fakes of the microphone,
// the backend, the live session and the clock.
//
// Run with:  node app/test/practiceFollow.test.mjs

import assert from 'node:assert/strict';
import { PracticeFollow, PRACTICE_FIRST_QUERY_SECONDS } from '../src/js/practiceFollow.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e && e.stack}`); }
}

// A clock the test advances; sleeps resolve when it passes their deadline.
function harness({ sessionListening = false, transcribe = null } = {}) {
    let now = 1_000_000;
    let sleepers = [];
    const events = [];
    const calls = { start: 0, stop: 0, transcribe: 0 };
    let listening = false;
    const mic = {
        sampleRate: 48000,
        async startContinuous() { calls.start++; listening = true; },
        async stopContinuous() { calls.stop++; listening = false; },
        async ensureMicHealthy() { return true; },
        getContinuousAudio() { return new Float32Array(48000 * 6); },
        isListening: () => listening,
    };
    const live = { isRunning: sessionListening, isPaused: false, scorePosition: null };
    const backend = {
        async transcribePCMSignal() {
            calls.transcribe++;
            return transcribe ? transcribe() : { error: null, contour: 'opqrstuvwxyzopqrst' };
        },
    };
    const follow = new PracticeFollow({
        mic, backend, live,
        emit: (event, payload) => events.push({ event, payload }),
        now: () => now,
        sleep: (ms) => new Promise(resolve => sleepers.push({ at: now + ms, resolve })),
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    async function advance(seconds) {
        const target = now + seconds * 1000;
        for (;;) {
            await settle();
            sleepers.sort((a, b) => a.at - b.at);
            const next = sleepers[0];
            if (!next || next.at > target) break;
            sleepers.shift();
            now = next.at;
            next.resolve();
        }
        now = target;
        await settle();
    }
    return { follow, mic, live, events, calls, advance, setListening: (v) => { listening = v; } };
}

console.log('practiceFollow');

await test('starting opens the microphone and publishes what was heard', async () => {
    const h = harness();
    await h.follow.start(42);
    assert.equal(h.calls.start, 1);
    assert.deepEqual(h.follow.state(), { active: true, settingId: 42, error: '' });
    assert.equal(h.follow.position, null, 'nothing before the first window');
    await h.advance(PRACTICE_FIRST_QUERY_SECONDS + 0.1);
    assert.equal(h.calls.transcribe, 1);
    assert.equal(h.follow.position.contour, 'opqrstuvwxyzopqrst');
    assert.equal(h.follow.position.windowSeconds, 6);
    assert.ok(h.events.some(e => e.event === 'practiceFollowPosition'));
    // And again each step.
    await h.advance(10);
    assert.ok(h.calls.transcribe >= 3, `transcribed ${h.calls.transcribe}`);
});

await test('stopping closes the microphone it opened and publishes nothing more', async () => {
    let release;
    const h = harness({ transcribe: () => new Promise(r => { release = r; }) });
    await h.follow.start(42);
    await h.advance(PRACTICE_FIRST_QUERY_SECONDS + 0.1);
    assert.equal(h.calls.transcribe, 1, 'a transcription is in flight');
    await h.follow.stop();
    assert.equal(h.calls.stop, 1);
    release({ error: null, contour: 'opqrstuvwxyzopqrst' });
    await h.advance(20);
    assert.equal(h.follow.position, null, 'the late answer is dropped');
    assert.equal(h.calls.transcribe, 1, 'and the loop has ended');
    assert.equal(h.follow.state().active, false);
});

await test('while a session is listening, its windows are used and nothing is transcribed twice', async () => {
    const h = harness({ sessionListening: true });
    await h.follow.start(7);
    assert.equal(h.calls.start, 0, 'the session already has the microphone');
    h.live.scorePosition = { contour: 'abcdefghijklmn', readAt: 5, windowSeconds: 10 };
    await h.advance(PRACTICE_FIRST_QUERY_SECONDS + 0.1);
    assert.equal(h.calls.transcribe, 0);
    assert.equal(h.follow.position.readAt, 5);
    await h.follow.stop();
    assert.equal(h.calls.stop, 0, "the session's microphone is left alone");
});

await test('a session started while practising keeps the microphone when practice stops', async () => {
    const h = harness();
    await h.follow.start(7);
    h.live.isRunning = true;
    await h.advance(PRACTICE_FIRST_QUERY_SECONDS + 0.1);
    await h.follow.stop();
    assert.equal(h.calls.stop, 0);
});

await test('even when practice stops before it has noticed the session', async () => {
    const h = harness();
    await h.follow.start(7);
    h.live.isRunning = true;
    await h.follow.stop();
    assert.equal(h.calls.stop, 0);
});

await test('a microphone someone else already had open is not practice\'s to close', async () => {
    const h = harness();
    h.setListening(true);
    await h.follow.start(7);
    assert.equal(h.calls.start, 0);
    await h.advance(PRACTICE_FIRST_QUERY_SECONDS + 0.1);
    assert.equal(h.calls.transcribe, 1, 'it still listens on it');
    await h.follow.stop();
    assert.equal(h.calls.stop, 0);
});

await test('a session that pauses hands the microphone back to practice', async () => {
    const h = harness({ sessionListening: true });
    await h.follow.start(7);
    await h.advance(PRACTICE_FIRST_QUERY_SECONDS + 0.1);
    // Pause releases the microphone.
    h.live.isPaused = true;
    h.setListening(false);
    await h.advance(5);
    assert.equal(h.calls.start, 1, 'reopened');
    assert.ok(h.calls.transcribe >= 1);
    await h.follow.stop();
    assert.equal(h.calls.stop, 1);
});

await test('a microphone that will not open leaves nothing running and says why', async () => {
    const h = harness();
    h.mic.startContinuous = async () => { throw new Error('Permission denied'); };
    await assert.rejects(h.follow.start(7), /Permission denied/);
    assert.deepEqual(h.follow.state(), { active: false, settingId: null, error: 'Permission denied' });
    await h.advance(20);
    assert.equal(h.calls.transcribe, 0);
});

await test('following another setting replaces the first, with one loop', async () => {
    const h = harness();
    await h.follow.start(1);
    await h.follow.start(2);
    assert.equal(h.follow.settingId, 2);
    await h.advance(PRACTICE_FIRST_QUERY_SECONDS + 0.1);
    assert.equal(h.calls.transcribe, 1, 'the first loop ended');
});

await test('a transcription error publishes nothing', async () => {
    const h = harness({ transcribe: () => ({ error: 'no audio', contour: '' }) });
    await h.follow.start(1);
    await h.advance(PRACTICE_FIRST_QUERY_SECONDS + 0.1);
    assert.equal(h.follow.position, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
