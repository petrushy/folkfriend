// Dropbox access that outlives an access token.
//
// The first version asked for `token_access_type: 'online'`: a four-hour
// access token and nothing to renew it with. Every device therefore dropped
// to "Reconnect required" a few hours after connecting — silently, from the
// user's side — and while it sat there nothing was backed up and no other
// device could fetch its audio. Reported from the field as "the audio did not
// sync to the phone", which it could not have: neither device was connected.
//
// So connect asks for OFFLINE access, which adds a refresh token, and this
// module trades it for a fresh access token whenever the current one is near
// its end. PKCE makes that possible from a browser with no app secret: the
// refresh request carries only the refresh token and the public app key.
//
// Two rules decide whether this is robust or merely new:
//
//  1. "Could not refresh" is not "not allowed to". A refresh that fails on the
//     network — offline, a captive portal, Dropbox briefly down — keeps the
//     credentials and reports a transient error, so the next pass tries again.
//     Only Dropbox explicitly refusing the refresh token (400/401, which is
//     what a revoked or expired grant returns) ends the connection. Throwing
//     the token away on a network failure would reintroduce exactly the
//     reconnect-every-few-hours behaviour this replaces, on every plane.
//  2. One refresh at a time. A backup pass, a playback download and a storage
//     read can all find the token stale in the same instant; they share one
//     request. Dropbox refresh tokens are not rotated, so two TABS refreshing
//     concurrently is harmless — each simply gets a valid access token.

import { DropboxError } from './dropboxClient.mjs';

export const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

// Refresh this long before expiry, so a request that starts just inside the
// window does not run out part way through a slow upload.
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 20 * 1000;
// What the transport already treats as expired.
const EXPIRY_SLACK_MS = 30 * 1000;

// Whether these credentials can still reach Dropbox, possibly after a refresh.
// A stored refresh token counts even when the access token beside it has long
// expired — that is the whole point of having one.
export function credentialsUsable(auth, now = Date.now()) {
    if (!auth) return false;
    if (auth.refreshToken) return true;
    return !!auth.accessToken && auth.expiresAt > now + EXPIRY_SLACK_MS;
}

// Stored credentials from a token response. A REFRESH response carries no
// refresh token of its own, so the previous one is kept.
export function authFromTokenResponse(result, now = Date.now(), previous = null) {
    if (!result || !result.access_token || !(result.expires_in > 0)) {
        throw new Error('Invalid Dropbox authorization response.');
    }
    return {
        accessToken: result.access_token,
        expiresAt: now + result.expires_in * 1000,
        refreshToken: result.refresh_token || (previous && previous.refreshToken) || null,
    };
}

// `load()` returns the current credentials (or null when disconnected);
// `save(next)` persists refreshed ones. Both are the caller's, because the
// caller owns where credentials live and what "disconnected" means.
export function createTokenSource({ appKey, load, save, fetcher = (...args) => fetch(...args), now = () => Date.now() }) {
    let inFlight = null;

    async function refresh(auth) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
        let response;
        try {
            response = await fetcher(TOKEN_URL, {
                method: 'POST',
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: auth.refreshToken,
                    client_id: appKey,
                }),
                signal: controller.signal,
            });
        } catch (e) {
            throw new DropboxError('Dropbox is unavailable. Backup will retry.', 'network');
        } finally {
            clearTimeout(timer);
        }
        // 400 invalid_grant / 401: the grant itself is gone (revoked in the
        // Dropbox account, or the app's access removed). Nothing but a new
        // connection can fix that, so say so.
        if (response.status === 400 || response.status === 401) {
            throw new DropboxError('Reconnect Dropbox to continue.', 'auth');
        }
        if (!response.ok) {
            throw new DropboxError(response.status === 429
                ? 'Dropbox is busy. Backup will retry.'
                : 'Dropbox is unavailable. Backup will retry.',
            response.status === 429 ? 'rate' : 'network',
            Number(response.headers && response.headers.get && response.headers.get('Retry-After')) || 0);
        }
        let next;
        try {
            next = authFromTokenResponse(await response.json(), now(), auth);
        } catch (e) {
            throw new DropboxError('Dropbox is unavailable. Backup will retry.', 'network');
        }
        // Persisted only if these are still the credentials in use: a
        // disconnect, or a reconnect to another account, while the refresh was
        // in flight must not be undone by it landing.
        const current = load();
        if (current && current.refreshToken === auth.refreshToken) save(next);
        return next;
    }

    return {
        // Credentials with an access token good for at least REFRESH_MARGIN_MS,
        // or null when there are none. `force` refreshes regardless — used
        // after Dropbox rejected an access token that looked unexpired.
        // `auth` overrides load(), for a disconnect that needs one last token
        // to revoke with after the connection is already switched off.
        async token({ force = false, auth: override = null } = {}) {
            const auth = override || load();
            if (!auth) return null;
            const fresh = auth.accessToken && auth.expiresAt > now() + REFRESH_MARGIN_MS;
            if (fresh && !force) return auth;
            if (!auth.refreshToken) {
                // An online-only grant from before this change: usable until it
                // expires, and then a reconnect is the only way on.
                return auth.accessToken && auth.expiresAt > now() + EXPIRY_SLACK_MS ? auth : null;
            }
            if (!inFlight) inFlight = refresh(auth).finally(() => { inFlight = null; });
            return inFlight;
        },
    };
}
