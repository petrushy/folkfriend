// What the phone's lock screen / Control Centre says is playing.
//
// Without this the system "Now Playing" card for a session recording reads
// only "FolkFriend", with a scrubber over whichever 3-minute CLIP happens to be
// in the <audio> element — neither the tune nor where in the evening it is.
// The Media Session API is how a web page fills that card in (iOS 15+,
// Chrome, Firefox), and it is also how the card's buttons reach the page.
//
// Pure: the navigator and the MediaMetadata constructor are passed in, so the
// rules can be tested without a browser. Every call degrades to a no-op where
// the API is missing, and never throws — a lock-screen nicety must not be able
// to break playback.

// "Previous" restarts the current tune when this far into it, and only goes
// back a tune from nearer its start — the convention every music player uses.
export const RESTART_THRESHOLD_SECONDS = 5;

const ARTWORK = [
    { src: '/img/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
    { src: '/img/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
];

// { title, artist, album } for the card.
//
// The tune is the title because it is the thing the user is looking at the
// card to find out. Between tunes (talk, tuning up, a stretch nothing was
// recognised in) it says so rather than keeping the previous tune's name.
export function nowPlayingInfo({ detection, sessionName } = {}) {
    const session = String(sessionName || '').trim();
    const title = detection
        ? (String(detection.title || '').trim() || 'Unknown tune')
        : (session || 'Session recording');
    return {
        title,
        artist: 'FolkFriend',
        album: detection ? (session || 'Session recording') : '',
    };
}

// The tune a "next" / "previous" press should land on, or null for none.
//
// `detections` are the playable ones, each with its span `{ from, to }` in
// session seconds (already resolved by the player, which owns that rule).
export function adjacentTune(spans, currentSeconds, direction) {
    const sorted = spans.slice().sort((a, b) => a.from - b.from);
    if (direction > 0) {
        // Strictly after the playhead, with a hair of tolerance so that a tune
        // just jumped to (which starts AT the playhead) is not "next" again.
        return sorted.find(s => s.from > currentSeconds + 0.5) || null;
    }
    const started = sorted.filter(s => s.from <= currentSeconds + 0.5);
    if (!started.length) return sorted[0] || null;
    const current = started[started.length - 1];
    if (currentSeconds - current.from > RESTART_THRESHOLD_SECONDS) return current;
    return started.length > 1 ? started[started.length - 2] : current;
}

function sessionOf(nav) {
    return nav && nav.mediaSession ? nav.mediaSession : null;
}

// Metadata only changes when the tune does, so the caller passes the previous
// info and nothing is rebuilt (and no artwork re-fetched) on every timeupdate.
export function applyMetadata(nav, MediaMetadataCtor, info, previous) {
    const session = sessionOf(nav);
    if (!session || typeof MediaMetadataCtor !== 'function' || !info) return previous;
    if (previous && previous.title === info.title && previous.album === info.album
        && previous.artist === info.artist) return previous;
    try {
        session.metadata = new MediaMetadataCtor({ ...info, artwork: ARTWORK });
    } catch (e) {
        return previous;
    }
    return info;
}

export function applyPlaybackState(nav, playing) {
    const session = sessionOf(nav);
    if (!session) return;
    try { session.playbackState = playing ? 'playing' : 'paused'; } catch (e) { /* ignore */ }
}

// The scrubber on the card, on the SESSION's timeline rather than the loaded
// clip's — otherwise it shows a three-minute piece of an evening and a drag
// on it means nothing the user can predict.
export function applyPosition(nav, { duration, position, playbackRate = 1 }) {
    const session = sessionOf(nav);
    if (!session || typeof session.setPositionState !== 'function') return;
    if (!(duration > 0) || !Number.isFinite(duration)) return;
    try {
        session.setPositionState({
            duration,
            position: Math.min(duration, Math.max(0, position || 0)),
            playbackRate: playbackRate > 0 ? playbackRate : 1,
        });
    } catch (e) { /* a browser that rejects the values keeps its own */ }
}

// `handlers` maps a MediaSessionAction to a function; null clears it. An
// action the browser does not know throws, and is skipped on its own.
export function applyActionHandlers(nav, handlers) {
    const session = sessionOf(nav);
    if (!session || typeof session.setActionHandler !== 'function') return;
    for (const [action, handler] of Object.entries(handlers)) {
        try { session.setActionHandler(action, handler || null); } catch (e) { /* unsupported */ }
    }
}

export const MEDIA_ACTIONS = ['play', 'pause', 'seekbackward', 'seekforward', 'seekto',
    'previoustrack', 'nexttrack'];

export function clearMediaSession(nav) {
    const session = sessionOf(nav);
    if (!session) return;
    applyActionHandlers(nav, Object.fromEntries(MEDIA_ACTIONS.map(a => [a, null])));
    try { session.metadata = null; } catch (e) { /* ignore */ }
    try { session.playbackState = 'none'; } catch (e) { /* ignore */ }
}
