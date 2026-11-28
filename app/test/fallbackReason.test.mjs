// The Tune view's "saved copy" banner names the real cause (src/js/fallbackReason.mjs).
//
// Run with:  node app/test/fallbackReason.test.mjs

import assert from 'node:assert/strict';
import { fallbackReason } from '../src/js/fallbackReason.mjs';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

const base = { dataset: 'norbeck', label: 'Norbeck', usable: true, status: 'ready',
    loaded: ['thesession'], missing: [], errors: {}, offline: false };

test('a dataset that failed to load is named, with its reason, and not blamed on the internet', () => {
    const r = fallbackReason({ ...base, missing: ['norbeck'], errors: { norbeck: 'not published' } });
    assert.equal(r.kind, 'dataset-missing');
    assert.match(r.text, /Norbeck database is not loaded right now \(not published\)/);
    assert.doesNotMatch(r.text, /internet/);
});

test('a dataset that is not selected says so', () => {
    const r = fallbackReason(base);
    assert.equal(r.kind, 'dataset-off');
    assert.doesNotMatch(r.text, /internet/);
});

test('a loaded dataset without the tune says the tune was not found', () => {
    const r = fallbackReason({ ...base, loaded: ['thesession', 'norbeck'] });
    assert.equal(r.kind, 'not-found');
});

test('only a device that is offline with no index is told to connect', () => {
    const offline = fallbackReason({ ...base, usable: false, status: 'unavailable', offline: true });
    assert.equal(offline.kind, 'offline');
    assert.match(offline.text, /Connect to the internet/);
    const online = fallbackReason({ ...base, usable: false, status: 'unavailable', offline: false });
    assert.equal(online.kind, 'unavailable');
    assert.doesNotMatch(online.text, /internet/);
});

test('a database still loading says it will update', () => {
    assert.equal(fallbackReason({ ...base, usable: false, status: 'loading' }).kind, 'loading');
    assert.equal(fallbackReason({ ...base, usable: false, status: 'downloading' }).kind, 'loading');
});

console.log(`\n${passed} passed`);
