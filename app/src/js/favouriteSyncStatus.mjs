// Turns the favourites sync state (sync.js getFavouritesSyncState) into the
// one line Settings shows. Pure, so every wording is tested without Vue.
//
// `level` is what colours it: 'ok', 'pending' (waiting, nothing wrong yet),
// 'error' (needs attention) or 'unknown' (not yet checked with the account).
// `retry` says whether a Retry button makes sense.

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function describeFavouriteSync(state, { total = null, online = true, now = Date.now() } = {}) {
    const s = state || {};
    const pending = Number(s.pending) || 0;
    const count = plural(pending, 'favourite', 'favourites');

    if (s.listenerError) {
        return {
            level: 'error',
            retry: false,
            text: `Favourites sync is not connected (${s.listenerError}). ` +
                'Changes are kept on this device; sign out and in again to reconnect.' +
                (pending ? ` ${count} not synced.` : ''),
        };
    }
    if (s.localError) {
        return {
            level: 'error',
            retry: false,
            text: `Changes from your other devices could not be saved here (${s.localError}).`,
        };
    }
    if (pending && s.lastError) {
        return {
            level: 'error',
            retry: true,
            text: `${count} not synced — your account refused the change (${s.lastError}). ` +
                'They are safe on this device.',
        };
    }
    if (pending && !online) {
        return { level: 'pending', retry: false, text: `${count} not synced yet — this device is offline.` };
    }
    if (pending) {
        return { level: 'pending', retry: true, text: `${count} waiting to sync…` };
    }
    if (!s.serverSeen) {
        return {
            level: 'unknown',
            retry: false,
            text: online ? 'Checking favourites with your account…'
                : 'Offline — favourites will be checked with your account when you reconnect.',
        };
    }
    const all = total == null ? 'All favourites' : `All ${plural(total, 'favourite', 'favourites')}`;
    return { level: 'ok', retry: false, text: `${all} synced${confirmedSuffix(s.confirmedAt, now)}.` };
}

function confirmedSuffix(at, now) {
    if (!at) return '';
    const mins = Math.round((now - at) / 60000);
    if (mins < 1) return ' · confirmed just now';
    if (mins < 60) return ` · confirmed ${mins} min ago`;
    return ` · confirmed ${new Date(at).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}`;
}
