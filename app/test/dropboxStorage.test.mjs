import assert from 'node:assert/strict';
import { readDropboxStorage, availableDropboxBytes } from '../src/services/dropboxStorage.mjs';
import { DropboxClient } from '../src/services/dropboxClient.mjs';
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
const file = (path, size) => ({ '.tag': 'file', path_lower: path, size });
await test('counts all pages of app-folder files, without downloading audio', async () => {
    const calls = [];
    const result = await readDropboxStorage({ async request(endpoint, args) {
        calls.push(endpoint);
        if (endpoint === 'files/list_folder') { assert.equal(args.path, ''); assert.equal(args.recursive, true); return { entries: [file('/sessions/a/audio', 100), { '.tag': 'folder', path_lower: '/sessions' }], has_more: true, cursor: 'next' }; }
        if (endpoint === 'files/list_folder/continue') { assert.equal(args.cursor, 'next'); return { entries: [file('/sessions/a/manifest', 20), file('/sessions/b/audio', 300)], has_more: false }; }
        assert.equal(endpoint, 'users/get_space_usage'); assert.equal(args, null);
        return { used: 800, allocation: { '.tag': 'individual', allocated: 1000 } };
    } });
    assert.equal(result.storedBytes, 420); assert.equal(result.availableBytes, 200); assert.equal(calls.length, 3);
});
await test('empty folder reports zero and full accounts report zero available', async () => {
    const result = await readDropboxStorage({ async request(endpoint) {
        return endpoint === 'files/list_folder' ? { entries: [], has_more: false } : { used: 200, allocation: { '.tag': 'individual', allocated: 100 } };
    } });
    assert.equal(result.storedBytes, 0); assert.equal(result.availableBytes, 0);
});
await test('failed pagination never returns a partial total', async () => {
    await assert.rejects(readDropboxStorage({ async request(endpoint) {
        if (endpoint === 'files/list_folder') return { entries: [file('/a', 100)], has_more: true, cursor: 'next' };
        throw new Error('offline');
    } }), /offline/);
});
await test('updates and deletions across pages do not double count files', async () => {
    const result = await readDropboxStorage({ async request(endpoint) {
        if (endpoint === 'files/list_folder') return { entries: [file('/a', 100), file('/b', 200)], has_more: true, cursor: 'next' };
        if (endpoint === 'files/list_folder/continue') return { entries: [file('/a', 150), { '.tag': 'deleted', path_lower: '/b' }], has_more: false };
        throw Object.assign(new Error('permission'), { code: 'scope' });
    } });
    assert.equal(result.storedBytes, 150); assert.equal(result.availableBytes, null); assert.equal(result.quotaState, 'permission');
});
await test('optional quota failure does not hide successfully counted bytes', async () => {
    const result = await readDropboxStorage({ async request(endpoint) {
        if (endpoint === 'files/list_folder') return { entries: [file('/a', 100)], has_more: false };
        throw new Error('offline');
    } });
    assert.equal(result.storedBytes, 100); assert.equal(result.quotaState, 'unavailable');
});
await test('team space uses shared usage and respects enforced member limits', async () => {
    const allocation = { '.tag': 'team', allocated: 1000, used: 800 };
    assert.equal(availableDropboxBytes({ used: 20, allocation }), 200);
    Object.assign(allocation, { user_within_team_space_allocated: 100, user_within_team_space_used_cached: 70, user_within_team_space_limit_type: { '.tag': 'stop_sync' } });
    assert.equal(availableDropboxBytes({ used: 20, allocation }), 30);
    allocation.user_within_team_space_limit_type = { '.tag': 'alert_only' };
    assert.equal(availableDropboxBytes({ used: 20, allocation }), 200);
});
await test('unknown quota and invalid file metadata are not presented as zero', async () => {
    assert.equal(availableDropboxBytes({ used: 5, allocation: { '.tag': 'new-format', allocated: 100 } }), null);
    await assert.rejects(readDropboxStorage({ async request() { return { entries: [file('/a', -1)], has_more: false }; } }), /invalid file size/);
});
await test('missing optional scope is distinguished from expired authorization', async () => {
    const client = new DropboxClient({ token: () => ({ accessToken: 'fake', expiresAt: Date.now() + 100000 }),
        fetcher: async () => new Response('{"error":{".tag":"missing_scope","required_scope":"account_info.read"}}', { status: 401 }) });
    await assert.rejects(client.request('users/get_space_usage', null), e => e.code === 'scope');
});
console.log(`\n${passed} Dropbox storage tests passed`);
