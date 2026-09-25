// Staying connected to Dropbox past the four-hour access token.
//
// Run with:  node app/test/dropboxAuth.test.mjs
//
// The property that matters is in the first two groups: a refresh that FAILS
// on the network keeps the credentials, and only Dropbox refusing the grant
// ends the connection. Getting that backwards would turn every plane flight
// into a reconnect — the behaviour this module exists to remove.

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
    authFromTokenResponse, createTokenSource, credentialsUsable, REFRESH_MARGIN_MS, TOKEN_URL,
} from '../src/services/dropboxAuth.mjs';
import { DropboxClient } from '../src/services/dropboxClient.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

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

const NOW = 1_800_000_000_000;
const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
});

// A token source over a mutable store, with a scriptable token endpoint that
// records every request it is sent.
function harness(stored, respond) {
    const calls = [];
    const box = { auth: stored };
    const source = createTokenSource({
        appKey: 'app-key',
        load: () => box.auth,
        save: next => { box.auth = next; },
        now: () => NOW,
        fetcher: async (url, init) => {
            calls.push({ url, params: Object.fromEntries(init.body) });
            return respond(calls.length);
        },
    });
    return { source, calls, box };
}

const expired = { accessToken: 'old', expiresAt: NOW - 1000, refreshToken: 'refresh-1' };

console.log('\ndropboxAuth — credentials');

await test('a refresh token keeps a device connected after its access token expires', () => {
    assert.equal(credentialsUsable(expired, NOW), true);
    assert.equal(credentialsUsable({ accessToken: 'a', expiresAt: NOW - 1 }, NOW), false,
        'an online-only grant that has expired genuinely needs a reconnect');
    assert.equal(credentialsUsable(null, NOW), false);
});

await test('a refresh response keeps the refresh token it was not sent again', () => {
    const next = authFromTokenResponse({ access_token: 'new', expires_in: 14400 }, NOW, expired);
    assert.deepEqual(next, { accessToken: 'new', expiresAt: NOW + 14400 * 1000, refreshToken: 'refresh-1' });
    const connect = authFromTokenResponse({ access_token: 'a', expires_in: 10, refresh_token: 'r2' }, NOW);
    assert.equal(connect.refreshToken, 'r2');
    assert.throws(() => authFromTokenResponse({ expires_in: 10 }, NOW));
});

console.log('\ndropboxAuth — refreshing');

await test('a fresh token is used as it is, with no request', async () => {
    const fresh = { ...expired, accessToken: 'live', expiresAt: NOW + REFRESH_MARGIN_MS + 60000 };
    const { source, calls } = harness(fresh, () => json(200, {}));
    assert.equal((await source.token()).accessToken, 'live');
    assert.equal(calls.length, 0);
});

await test('a token near its end is refreshed, with only the public key and the refresh token', async () => {
    const { source, calls, box } = harness(expired,
        () => json(200, { access_token: 'new', expires_in: 14400 }));
    const auth = await source.token();
    assert.equal(auth.accessToken, 'new');
    assert.equal(calls[0].url, TOKEN_URL);
    assert.deepEqual(calls[0].params,
        { grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'app-key' },
        'no app secret — this runs in a browser');
    assert.equal(box.auth.accessToken, 'new', 'and it is saved for next time');
});

await test('callers that find the token stale together share ONE refresh', async () => {
    let release;
    const { source, calls } = harness(expired, () => new Promise(resolve => {
        release = () => resolve(json(200, { access_token: 'new', expires_in: 14400 }));
    }));
    const all = Promise.all([source.token(), source.token(), source.token()]);
    await Promise.resolve();
    release();
    const results = await all;
    assert.equal(calls.length, 1);
    assert.ok(results.every(r => r.accessToken === 'new'));
});

await test('a refresh that fails on the NETWORK keeps the credentials and says it will retry', async () => {
    const { source, box } = harness(expired, () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(source.token(), e => e.code === 'network');
    assert.equal(box.auth.refreshToken, 'refresh-1', 'offline is not a reason to forget the grant');
});

await test('a busy or failing Dropbox is transient too', async () => {
    for (const status of [429, 500, 503]) {
        const { source, box } = harness(expired, () => json(status, {}));
        await assert.rejects(source.token(), e => ['rate', 'network'].includes(e.code), `HTTP ${status}`);
        assert.equal(box.auth.refreshToken, 'refresh-1');
    }
});

await test('only Dropbox refusing the grant asks for a reconnect', async () => {
    for (const status of [400, 401]) {
        const { source } = harness(expired, () => json(status, { error: 'invalid_grant' }));
        await assert.rejects(source.token(), e => e.code === 'auth', `HTTP ${status}`);
    }
});

await test('a refresh landing after a disconnect does not bring the credentials back', async () => {
    let release;
    const { source, box } = harness(expired, () => new Promise(resolve => {
        release = () => resolve(json(200, { access_token: 'new', expires_in: 14400 }));
    }));
    const pending = source.token();
    await Promise.resolve();
    box.auth = null;                 // the user disconnected meanwhile
    release();
    await pending;
    assert.equal(box.auth, null);
});

await test('an online-only grant from before this change works until it expires, then stops', async () => {
    const live = { accessToken: 'a', expiresAt: NOW + 60000 };
    assert.equal((await harness(live, () => json(200, {})).source.token()).accessToken, 'a');
    const gone = { accessToken: 'a', expiresAt: NOW - 1 };
    assert.equal(await harness(gone, () => json(200, {})).source.token(), null);
});

console.log('\ndropboxClient — a rejected access token');

await test('a 401 is retried once with refreshed credentials instead of asking to reconnect', async () => {
    const seen = [];
    let current = { accessToken: 'stale', expiresAt: Date.now() + 3600000 };
    const client = new DropboxClient({
        token: async ({ force } = {}) => {
            if (force) current = { accessToken: 'fresh', expiresAt: Date.now() + 3600000 };
            return current;
        },
        fetcher: async (url, init) => {
            seen.push(init.headers.Authorization);
            return init.headers.Authorization === 'Bearer stale' ? json(401, {}) : json(200, { ok: true });
        },
    });
    assert.deepEqual(await client.request('files/get_metadata', { path: '/x' }), { ok: true });
    assert.deepEqual(seen, ['Bearer stale', 'Bearer fresh']);
});

await test('a second 401 is the real answer, not a loop', async () => {
    let n = 0;
    const client = new DropboxClient({
        token: async () => ({ accessToken: `t${n++}`, expiresAt: Date.now() + 3600000 }),
        fetcher: async () => json(401, {}),
    });
    await assert.rejects(client.request('files/get_metadata', { path: '/x' }), e => e.code === 'auth');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
