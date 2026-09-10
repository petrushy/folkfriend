// App Folder bytes and account quota are different measures: count file
// metadata for the former; use Dropbox's account/team allocation for the latter.
const bytes = value => Number.isSafeInteger(value) && value >= 0;
export function availableDropboxBytes(usage) {
    const allocation = usage?.allocation;
    if (!allocation || !bytes(allocation.allocated)) return null;
    if (allocation['.tag'] === 'individual') {
        return bytes(usage.used) ? Math.max(0, allocation.allocated - usage.used) : null;
    }
    if (allocation['.tag'] !== 'team' || !bytes(allocation.used)) return null;
    const shared = Math.max(0, allocation.allocated - allocation.used);
    const limitType = allocation.user_within_team_space_limit_type;
    if ((limitType?.['.tag'] || limitType) === 'stop_sync' && allocation.user_within_team_space_allocated > 0) {
        if (!bytes(allocation.user_within_team_space_allocated) || !bytes(allocation.user_within_team_space_used_cached)) return null;
        return Math.min(shared, Math.max(0, allocation.user_within_team_space_allocated - allocation.user_within_team_space_used_cached));
    }
    return shared;
}
export async function readDropboxStorage(client) {
    // Root is the app folder, not the user's entire Dropbox. Pagination must
    // finish before publishing a total; an interrupted read isn't zero usage.
    let page = await client.request('files/list_folder', { path: '', recursive: true, include_deleted: false });
    const files = new Map();
    for (;;) {
        if (!Array.isArray(page.entries)) throw new Error('Dropbox storage usage is unavailable.');
        for (const entry of page.entries) {
            const key = entry.path_lower;
            if (typeof key !== 'string') throw new Error('Dropbox returned unfamiliar file metadata.');
            if (entry['.tag'] === 'deleted') files.delete(key);
            else if (entry['.tag'] === 'file') {
                if (!bytes(entry.size)) throw new Error('Dropbox returned an invalid file size.');
                files.set(key, entry.size);
            }
        }
        if (!page.has_more) break;
        page = await client.request('files/list_folder/continue', { cursor: page.cursor });
    }
    const result = { storedBytes: [...files.values()].reduce((sum, n) => sum + n, 0),
        availableBytes: null, quotaState: 'unavailable', checkedAt: Date.now() };
    try {
        result.availableBytes = availableDropboxBytes(await client.request('users/get_space_usage', null));
        result.quotaState = result.availableBytes === null ? 'unavailable' : 'ok';
    } catch (e) {
        // Optional quota access must never disconnect an otherwise working
        // audio connection. Expired authorization still needs reconnecting.
        if (e.code === 'auth') throw e;
        result.quotaState = e.code === 'scope' ? 'permission' : 'unavailable';
    }
    return result;
}
