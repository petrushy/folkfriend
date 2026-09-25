// Turning an analysed recording file into a Past Session.
//
// Pure — no Vue, no storage — so the rules for what an imported session looks
// like are testable on their own. The orchestration (write the record, keep the
// audio, nudge the backup) is services/sessionImport.js.
//
// An imported session is an ordinary session record. It shares the shape
// liveAnalysis._persistSession() writes, so Past Sessions, sync, export and
// the Dropbox backup all handle it without knowing where it came from. The
// only additions are `source: 'import'` and the original file name, both
// informational.

// Plausible file dates. Before this, a timestamp is a default (0, or a camera
// that was never set); after "now" by more than a little, a clock is wrong.
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);
const CLOCK_SLACK_MS = 60 * 1000;

// When the recording most likely STARTED.
//
// A recorder writes its file as it goes, so the file's modification time is
// when recording ended, and the start is that minus the length. It is a guess —
// a file copied or re-saved since carries the copy's date — which is why the
// view shows it in an editable field rather than just using it.
export function defaultImportStart(file, durationSeconds, now = Date.now()) {
    const modified = Number(file && file.lastModified);
    const end = Number.isFinite(modified) && modified >= EARLIEST_PLAUSIBLE_MS && modified <= now + CLOCK_SLACK_MS
        ? modified
        : now;
    return Math.round(end - Math.max(0, Number(durationSeconds) || 0) * 1000);
}

// The file name without its extension, as a starting point for a session name.
export function nameFromFileName(fileName) {
    return String(fileName || '').replace(/\.[^./\\]+$/, '').trim();
}

// A `<input type="datetime-local">` value for a time, in LOCAL time — which is
// what that input displays and returns. toISOString() would be UTC and put the
// session hours away from when it happened.
export function toDateTimeLocal(ms) {
    const at = new Date(ms);
    if (Number.isNaN(at.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
        `T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// The reverse, or NaN for anything that is not a complete date and time.
export function fromDateTimeLocal(text) {
    const match = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return Number.NaN;
    const [, y, mo, d, h, mi, s] = match.map(Number);
    const at = new Date(y, mo - 1, d, h, mi, s || 0);
    // new Date() rolls 31 February into March rather than refusing it.
    if (at.getMonth() !== mo - 1 || at.getDate() !== d) return Number.NaN;
    return at.getTime();
}

const numberOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// The tune list to store, from the rows on screen.
//
// From the rows rather than from the service's detections, because the rows
// carry the user's corrections: a different tune chosen from the dropdown, and
// an edited start time. Both are what they are looking at when they press
// Save, so both are what gets saved.
//
// An edited start moves the tune in the LIST and keeps its length. The audio
// offsets are left as analysed: they say where the tune was heard in the file,
// which an edit to the displayed time does not change.
export function importedTunes(rows, parseClockTime) {
    return (rows || []).map(row => {
        const analysedStart = Number(row.startSeconds) || 0;
        const length = Math.max(0, (Number(row.endSeconds) || analysedStart) - analysedStart);
        const edited = parseClockTime ? parseClockTime(row.editableTime) : Number.NaN;
        const startSeconds = Number.isFinite(edited) && edited >= 0 ? edited : analysedStart;
        return {
            tuneId: row.selectedTuneId || row.tuneId,
            settingId: row.selectedSettingId || row.settingId,
            title: row.selectedTitle || row.title,
            sourceUrl: row.selectedSourceUrl || row.sourceUrl || '',
            dataset: row.dataset || '',
            startSeconds,
            endSeconds: startSeconds + length,
            audioStartSeconds: numberOrNull(row.audioStartSeconds),
            audioEndSeconds: numberOrNull(row.audioEndSeconds),
            audioAnchorSeconds: numberOrNull(row.audioAnchorSeconds),
            bestScore: row.bestScore || 0,
            alternatives: row.alternatives || [],
        };
    }).sort((a, b) => a.startSeconds - b.startSeconds);
}

export function newImportedSessionId(now = Date.now(), random = Math.random) {
    // The same form liveAnalysis mints, which the Dropbox layer validates.
    return `session-${now}-${random().toString(36).slice(2, 8)}`;
}

// The session record itself.
//
// Finished on arrival (`endedAt` set): nothing will be appended to it, and a
// session with no end reads as still in progress everywhere that asks —
// including the Dropbox whole-file copy, which waits for one.
export function importedSessionRecord({
    id, name = '', startedAt, durationSeconds, fileName = '', tunes = [], now = Date.now(),
}) {
    const seconds = Math.max(0, Number(durationSeconds) || 0);
    const trimmed = String(name || '').trim().slice(0, 160);
    return {
        id,
        startedAt,
        // With no name given, the store labels it by date (and place), exactly
        // as it does a live session — see store._liveSessionLabel().
        name: trimmed,
        customName: !!trimmed,
        placeName: '',
        endedAt: startedAt + Math.round(seconds * 1000),
        tunes,
        listenedSeconds: Math.round(seconds),
        lastActiveAt: now,
        lat: null,
        lon: null,
        accuracy: null,
        source: 'import',
        sourceFileName: String(fileName || ''),
    };
}
