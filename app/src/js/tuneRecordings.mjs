// Which saved sessions hold a recording of a given tune — the ▶ on a favourite.
//
// Matched by TUNE, not setting: a favourite is one setting, but the session
// that recognised the tune may have matched a different setting of it, and
// "play me the evening we played this" is about the tune.
//
// Pure, so the matching can be tested without IndexedDB or a player. The view
// builds the index once per load; a per-row scan of every session would run
// on every keystroke in the name filter.

// A tune occurrence counts only when it carries an audio offset: that is what
// says a recording was running when it was heard. Sessions recorded before
// audio existed, or with recording off, have none.
function hasAudio(tune) {
    return !!tune && typeof tune.audioStartSeconds === 'number';
}

function spanOf(tune) {
    const from = typeof tune.audioAnchorSeconds === 'number' ? tune.audioAnchorSeconds : tune.audioStartSeconds;
    const to = typeof tune.audioEndSeconds === 'number' ? tune.audioEndSeconds : tune.audioStartSeconds;
    return Math.max(0, to - from);
}

// The rows the player needs, with the same ids the Session Analysis view gives
// a stored session's rows, so the two agree on what "the current tune" is.
export function sessionDetections(session) {
    return (session.tunes || []).map((tune, index) => ({ ...tune, id: `saved-${index}` }));
}

export function formatSessionDate(ms) {
    return new Date(ms).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
}

export function sessionLabel(session) {
    const date = formatSessionDate(session.startedAt);
    return session.name || (session.placeName ? `${date} · ${session.placeName}` : date);
}

// tuneId (string) → [{ sessionId, sessionName, startedAt, detectionId }],
// newest session first, one entry per session.
//
// `playable(sessionId)` says whether this device can actually play that
// session's audio. A tune stamped with an offset only says a recording existed
// somewhere — possibly on another device, possibly since deleted — and a ▶ that
// can only ever fail is worse than none.
//
// A tune heard twice in one session gets ONE entry, for its longest hearing:
// the picker asks "which session", and two rows for the same evening would
// read as two evenings.
export function indexRecordingsByTune(sessions, playable = () => true) {
    const index = new Map();
    for (const session of sessions || []) {
        if (!session || !session.id || !Array.isArray(session.tunes)) continue;
        if (!session.tunes.some(hasAudio) || !playable(session.id)) continue;
        const best = new Map();
        session.tunes.forEach((tune, i) => {
            if (!hasAudio(tune) || tune.tuneId === undefined || tune.tuneId === null || tune.tuneId === '') return;
            const key = String(tune.tuneId);
            const current = best.get(key);
            if (!current || spanOf(tune) > spanOf(current.tune)) best.set(key, { tune, i });
        });
        for (const [key, { i }] of best) {
            if (!index.has(key)) index.set(key, []);
            index.get(key).push({
                sessionId: session.id,
                sessionName: sessionLabel(session),
                startedAt: session.startedAt || 0,
                detectionId: `saved-${i}`,
            });
        }
    }
    for (const entries of index.values()) entries.sort((a, b) => b.startedAt - a.startedAt);
    return index;
}
