// The one line Settings shows about favourites sync. Signed in is not the
// same as synced — that confusion is how two devices drifted apart behind a
// green light — so every state the sync layer can be in has its own words.
//
// Run with:  node app/test/favouriteSyncStatus.test.mjs

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { describeFavouriteSync } = await import(path.join(here, '..', 'src', 'js', 'favouriteSyncStatus.mjs'));

let passed = 0;
let failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) {
        failed++; console.error(`  ✗ ${name}\n      ${e.message}`);
    }
}

const NOW = 1_800_000_000_000;

console.log('\nfavourites sync status');

test('all synced names the count and when it was confirmed', () => {
    const d = describeFavouriteSync({ serverSeen: true, confirmedAt: NOW - 5 * 60000 }, { total: 312, now: NOW });
    assert.equal(d.level, 'ok');
    assert.equal(d.text, 'All 312 favourites synced · confirmed 5 min ago.');
    assert.equal(d.retry, false);
});

test('a refused write says how many, why, and that they are safe', () => {
    const d = describeFavouriteSync({ pending: 10, lastError: 'invalid-argument', serverSeen: true }, { total: 312 });
    assert.equal(d.level, 'error');
    assert.match(d.text, /^10 favourites not synced/);
    assert.match(d.text, /invalid-argument/);
    assert.match(d.text, /safe on this device/);
    assert.equal(d.retry, true);
});

test('one is singular', () => {
    assert.match(describeFavouriteSync({ pending: 1, lastError: 'x' }).text, /^1 favourite not synced/);
});

test('offline is waiting, not failing', () => {
    const d = describeFavouriteSync({ pending: 3, serverSeen: true }, { online: false });
    assert.equal(d.level, 'pending');
    assert.equal(d.text, '3 favourites not synced yet — this device is offline.');
});

test('in flight offers a retry but is not an error', () => {
    const d = describeFavouriteSync({ pending: 2, serverSeen: true });
    assert.equal(d.level, 'pending');
    assert.equal(d.retry, true);
});

test('never claims "all synced" before the account has answered', () => {
    // An app relaunched offline has heard nothing from the server; zero
    // pending there means "not known", not "fine".
    const d = describeFavouriteSync({ pending: 0, serverSeen: false }, { total: 40 });
    assert.equal(d.level, 'unknown');
    assert.doesNotMatch(d.text, /synced\./);
});

test('a dead listener outranks everything else', () => {
    const d = describeFavouriteSync({ listenerError: 'permission-denied', pending: 4, lastError: 'x' });
    assert.equal(d.level, 'error');
    assert.match(d.text, /not connected \(permission-denied\)/);
    assert.match(d.text, /4 favourites not synced/);
});

test('a change from another device that could not be stored is an error too', () => {
    const d = describeFavouriteSync({ localError: 'QuotaExceededError', serverSeen: true });
    assert.equal(d.level, 'error');
    assert.match(d.text, /QuotaExceededError/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
