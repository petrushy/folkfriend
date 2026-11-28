// Why the Tune view is showing the copy saved in favourites/sets instead of
// the tune index. Pure: the view passes in what it knows.
//
// The banner used to say "Connect to the internet" in every case. That was
// wrong more often than right. Reported from the field (November 2026): an
// imported Norbeck tune on a phone with a working connection. The internet
// cannot fix a dataset the app does not host, a dataset switched off in
// Settings, or one whose saved copy did not load at this launch. A message
// that names the wrong cause sends the user to fix the wrong thing.
//
//   dataset   the tune's dataset id ('thesession', 'norbeck', ...)
//   label     its display name
//   loaded    dataset ids searchable right now (store.state.indexDatasets)
//   missing   selected dataset ids that are not loaded
//   errors    { id: reason } for datasets that failed
//   usable    whether any index is loaded (store.state.indexLoaded)
//   status    'loading' | 'downloading' | 'ready' | 'unavailable'
//   offline   navigator.onLine === false
export function fallbackReason({
    dataset = '', label = '', loaded = [], missing = [], errors = {},
    usable = false, status = '', offline = false,
} = {}) {
    const name = label || dataset || 'tune';
    const saved = 'Showing your saved copy of this tune.';

    if (!usable) {
        if (status === 'loading' || status === 'downloading') {
            return { kind: 'loading',
                text: `The tune database is still loading. ${saved} `
                    + 'It will update by itself when the database is ready.' };
        }
        if (offline) {
            return { kind: 'offline',
                text: `You are offline and no tune database is loaded. ${saved} `
                    + 'Connect to the internet to see all settings for this tune.' };
        }
        return { kind: 'unavailable',
            text: `The tune database could not be loaded. ${saved} `
                + 'Settings → Offline Tune Database shows what went wrong.' };
    }

    if (dataset && missing.includes(dataset)) {
        const why = errors[dataset];
        return { kind: 'dataset-missing',
            text: `The ${name} database is not loaded right now`
                + (why ? ` (${why})` : '') + `. ${saved} `
                + 'Settings → Offline Tune Database shows its state.' };
    }

    if (dataset && !loaded.includes(dataset)) {
        return { kind: 'dataset-off',
            text: `The ${name} database is not in use. ${saved} `
                + 'You can turn it on in Settings → Offline Tune Database.' };
    }

    return { kind: 'not-found',
        text: `This tune was not found in the ${name} database that is loaded. `
            + `${saved}` };
}
