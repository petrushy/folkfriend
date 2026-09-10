// Browser-only Dropbox transport. App Folder access is configured in Dropbox's
// app console; all paths here are relative to that folder. No app secret.
export class DropboxError extends Error {
    constructor(message, code, retryAfter = 0) { super(message); this.code = code; this.retryAfter = retryAfter; }
}
export const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function contentHash(blob) {
    const hashes = [];
    for (let offset = 0; offset < blob.size; offset += 4194304) {
        hashes.push(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.slice(offset, offset + 4194304).arrayBuffer())));
    }
    const joined = new Uint8Array(hashes.length * 32);
    hashes.forEach((hash, i) => joined.set(hash, i * 32));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', joined)), b => b.toString(16).padStart(2, '0')).join('');
}
export class DropboxClient {
    constructor({ token, fetcher = (...args) => fetch(...args) }) { this.token = token; this.fetcher = fetcher; }
    async request(endpoint, args, body) {
        const token = this.token();
        if (!token || token.expiresAt <= Date.now() + 30000) throw new DropboxError('Reconnect Dropbox to continue.', 'auth');
        const content = endpoint === 'files/download' || endpoint === 'files/upload';
        const headers = { Authorization: `Bearer ${token.accessToken}` };
        if (content) {
            headers['Dropbox-API-Arg'] = JSON.stringify(args).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
            if (body) headers['Content-Type'] = 'application/octet-stream';
        } else headers['Content-Type'] = 'application/json';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        try {
            const response = await this.fetcher(`https://${content ? 'content' : 'api'}.dropboxapi.com/2/${endpoint}`, {
                method: 'POST', headers, body: content ? body : JSON.stringify(args), signal: controller.signal,
            });
            if (!response.ok) {
                const detail = await response.text();
                const code = response.status === 401 ? 'auth' : response.status === 429 ? 'rate' :
                    /insufficient_space/.test(detail) ? 'full' : /not_found/.test(detail) ? 'missing' :
                    response.status === 409 ? 'conflict' : 'network';
                throw new DropboxError(({ auth: 'Reconnect Dropbox to continue.', full: 'Dropbox full. Free space and retry.',
                    conflict: 'Dropbox has a conflicting copy. No files were overwritten.', missing: 'This Dropbox file is missing.',
                    rate: 'Dropbox is busy. Backup will retry.', network: 'Dropbox is unavailable. Backup will retry.' })[code], code,
                Number(response.headers.get('Retry-After')) || 0);
            }
            if (endpoint === 'files/download') return { blob: await response.blob(), metadata: JSON.parse(response.headers.get('Dropbox-API-Result')) };
            return response.json();
        } finally { clearTimeout(timer); }
    }
    async metadata(path) {
        try { return await this.request('files/get_metadata', { path }); }
        catch (e) { if (e.code === 'missing') return null; throw e; }
    }
    async json(path) {
        try {
            const result = await this.request('files/download', { path });
            if (result.blob.size > 20 * 1024 * 1024) throw new DropboxError('Dropbox manifest is too large.', 'unsupported');
            return { value: JSON.parse(await result.blob.text()), rev: result.metadata.rev };
        } catch (e) { if (e.code === 'missing') return null; throw e; }
    }
    async upload(path, blob, previous = null) {
        const hash = await contentHash(blob);
        if (previous && previous.content_hash === hash) return previous;
        const result = await this.request('files/upload', { path, mode: previous ? { '.tag': 'update', update: previous.rev } : 'add',
            autorename: false, strict_conflict: true, mute: true }, blob);
        if (result.size !== blob.size || result.content_hash !== hash) throw new DropboxError('Dropbox upload verification failed.', 'integrity');
        return result;
    }
    async immutable(path, blob) {
        const existing = await this.metadata(path);
        if (existing) {
            if (existing.size !== blob.size || existing.content_hash !== await contentHash(blob)) throw new DropboxError('Dropbox audio conflicts with this device. No files were overwritten.', 'conflict');
            return existing;
        }
        return this.upload(path, blob);
    }
    async folders() {
        let page;
        try { page = await this.request('files/list_folder', { path: '/sessions' }); }
        catch (e) { if (e.code === 'missing') return []; throw e; }
        const entries = [...page.entries];
        while (page.has_more) { page = await this.request('files/list_folder/continue', { cursor: page.cursor }); entries.push(...page.entries); }
        return entries.filter(e => e['.tag'] === 'folder');
    }
}
