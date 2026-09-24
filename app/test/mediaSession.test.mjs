// Unit tests for the lock-screen "Now Playing" rules (src/js/mediaSession.mjs).
//
// Run with:  node app/test/mediaSession.test.mjs

import assert from 'node:assert/strict';
import {
    nowPlayingInfo, adjacentTune, applyMetadata, applyPosition, applyActionHandlers,
    clearMediaSession, RESTART_THRESHOLD_SECONDS,
} from '../src/js/mediaSession.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) {
        failed++;
        console.error(`  ✗ ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`);
    }
}

class FakeMetadata { constructor(init) { Object.assign(this, init); } }
function fakeNav() {
    const handlers = {};
    return {
        handlers, positions: [],
        mediaSession: {
            metadata: null, playbackState: 'none',
            setActionHandler(action, fn) {
                if (action === 'seekto-unknown') throw new TypeError('unsupported');
                handlers[action] = fn;
            },
            setPositionState(state) { this.last = state; },
        },
    };
}

console.log('\nmediaSession — what the lock screen says is playing');

test('the tune is the title and the session the album', () => {
    assert.deepEqual(nowPlayingInfo({ detection: { title: 'The Kesh' }, sessionName: 'Tuesday' }),
        { title: 'The Kesh', artist: 'FolkFriend', album: 'Tuesday' });
});

test('between tunes it names the session rather than keeping the last tune', () => {
    assert.deepEqual(nowPlayingInfo({ detection: null, sessionName: 'Tuesday' }),
        { title: 'Tuesday', artist: 'FolkFriend', album: '' });
    assert.equal(nowPlayingInfo({}).title, 'Session recording');
    assert.equal(nowPlayingInfo({ detection: { title: '' } }).title, 'Unknown tune');
});

const spans = [{ from: 20 }, { from: 140 }, { from: 300 }];

test('next is the first tune starting after the playhead', () => {
    assert.equal(adjacentTune(spans, 150, 1).from, 300);
    assert.equal(adjacentTune(spans, 0, 1).from, 20);
    assert.equal(adjacentTune(spans, 140, 1).from, 300, 'a tune just jumped to is not next again');
    assert.equal(adjacentTune(spans, 310, 1), null);
});

test('previous restarts the current tune, or goes back one near its start', () => {
    assert.equal(adjacentTune(spans, 140 + RESTART_THRESHOLD_SECONDS + 1, -1).from, 140);
    assert.equal(adjacentTune(spans, 142, -1).from, 20);
    assert.equal(adjacentTune(spans, 22, -1).from, 20, 'the first tune has nothing before it');
    assert.equal(adjacentTune(spans, 5, -1).from, 20, 'before the first tune');
    assert.equal(adjacentTune([], 5, -1), null);
});

test('metadata is only rebuilt when it changes', () => {
    const nav = fakeNav();
    const info = nowPlayingInfo({ detection: { title: 'The Kesh' } });
    const first = applyMetadata(nav, FakeMetadata, info, null);
    const set = nav.mediaSession.metadata;
    assert.equal(set.title, 'The Kesh');
    assert.ok(set.artwork.length > 0);
    applyMetadata(nav, FakeMetadata, { ...info }, first);
    assert.equal(nav.mediaSession.metadata, set, 'same tune: the same object, no artwork re-fetch');
});

test('position is clamped, and skipped without a duration', () => {
    const nav = fakeNav();
    applyPosition(nav, { duration: 0, position: 5 });
    assert.equal(nav.mediaSession.last, undefined);
    applyPosition(nav, { duration: 100, position: 140, playbackRate: 0 });
    assert.deepEqual(nav.mediaSession.last, { duration: 100, position: 100, playbackRate: 1 });
});

test('an unsupported action is skipped alone, and nothing throws without the API', () => {
    const nav = fakeNav();
    const play = () => {};
    applyActionHandlers(nav, { 'seekto-unknown': () => {}, play });
    assert.equal(nav.handlers.play, play);
    clearMediaSession(nav);
    assert.equal(nav.handlers.play, null);
    assert.equal(nav.mediaSession.playbackState, 'none');
    for (const n of [null, {}, { mediaSession: {} }]) {
        applyMetadata(n, FakeMetadata, nowPlayingInfo({}), null);
        applyPosition(n, { duration: 10, position: 1 });
        applyActionHandlers(n, { play });
        clearMediaSession(n);
    }
    assert.equal(applyMetadata(fakeNav(), undefined, nowPlayingInfo({}), null), null,
        'no MediaMetadata constructor: nothing set');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
