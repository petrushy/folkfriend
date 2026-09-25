// Saves an analysed recording file as a Past Session, with its audio.
//
// Session Tools analyses an imported file in fileSessionAnalysis.js; this is
// the step after it. The result is indistinguishable, to everything else in the
// app, from a session recorded live: a record in 'liveSessions' (so it is in
// Past Sessions and syncs through Firebase) and, when the audio is kept, a
// recording in sessionAudioStore (so it plays, seeks from the tune list, and is
// picked up by the Dropbox backup on its next pass).
//
// ORDER: the record first, then the audio. The tune list is the part the user
// cannot get back without re-running the analysis; the audio is a copy of a
// file they already have. So a failure to keep the audio — no room, a file too
// large to hold — leaves a saved session without a recording and says why,
// rather than saving nothing. The reverse order would leave audio no record
// points at, which is the largest orphan this app can produce.

import store from './store.js';
import { importAudioFile } from './sessionAudioStore.js';
import { syncDropbox } from './dropbox.js';
import { parseClockTime } from '@/js/sessionAnalysis.js';
import {
    importedSessionRecord,
    importedTunes,
    newImportedSessionId,
} from '@/js/sessionImport.mjs';

// Returns { session, audio: { kept, error, code } }. Throws only when the
// session record itself could not be saved, in which case nothing was stored.
export async function saveImportedSession({
    file, rows, durationSeconds, startedAt, name = '', keepAudio = true,
}) {
    if (!file) throw new Error('No recording is selected.');
    if (!(durationSeconds > 0)) throw new Error('Analyse the recording before saving it.');
    if (!Number.isFinite(startedAt)) throw new Error('Enter when the session was recorded.');

    const id = newImportedSessionId();
    const record = importedSessionRecord({
        id,
        name,
        startedAt,
        durationSeconds,
        fileName: file.name,
        tunes: importedTunes(rows, parseClockTime),
    });
    const session = await store.upsertLiveSession(record);

    const audio = { kept: false, error: '', code: '' };
    if (keepAudio) {
        try {
            await importAudioFile(id, file, { durationSeconds });
            audio.kept = true;
        } catch (e) {
            audio.error = (e && e.message) || String(e);
            audio.code = (e && e.code) || '';
        }
    }
    // Not awaited and never fatal: the backup is its own loop, runs whatever
    // happens here, and is a no-op unless the user has connected Dropbox.
    if (audio.kept) {
        try { Promise.resolve(syncDropbox()).catch(() => {}); } catch (e) { /* next pass */ }
    }
    return { session: session || record, audio };
}
