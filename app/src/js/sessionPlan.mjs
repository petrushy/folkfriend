// A session's PLAN: what the leader means to play, in order, and which of it
// has been played. Pure rules; no Vue, no store, no clock.
//
// The plan is stored on the session record (`session.plan`). What has been
// played is NOT stored on it: it is derived every time from the session's
// own tune list (`planProgress`). That is what makes a rejected or corrected
// detection un-cross its plan item with no bookkeeping — the tune list is
// the single record of what was played, and the plan only ever reads it.
// The one stored judgement is the user's own override (`done`), which wins.
//
// "Played" means the same TUNE, not the same setting: a planned thesession
// setting is crossed off by any other setting of it, and by a copy of the
// tune in another dataset with the same name (the audience does not want to
// hear it twice). Tune ids never match across datasets, so names are the
// bridge — captured as normalised aliases when the item is added, so the
// check is synchronous and works with no index loaded.
//
// Item shapes:
//   tune: { id, kind: 'tune', tuneID, settingID, title, dataset, mode, meter, type, names, done }
//   set:  { id, kind: 'set', setID, title, tunes: [ { id, tuneID, settingID, title, dataset, names, done } ] }
// `done` is null (automatic), true or false (the user said so).

import { matchableNames } from './tuneNames.mjs';

export const MAX_PLAN_ITEMS = 300;

function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// `type` is the tune type (reel, polska, …), which the index calls `dance`;
// either name is accepted.
function tuneFields({ tuneID, settingID, title, dataset, aliases, names, mode, meter, type, dance }) {
    const tuneType = type || dance;
    return {
        id: newId(),
        tuneID: tuneID == null ? null : String(tuneID),
        settingID: settingID == null || settingID === '' ? null : Number(settingID),
        title: String(title || '').slice(0, 200),
        dataset: dataset || null,
        // What a leader glances at mid-session: kept on the item (a few bytes)
        // so it shows on any device, index loaded or not. The ABC is not: it
        // is looked up for display, keeping the synced record small.
        mode: mode ? String(mode).slice(0, 40) : null,
        meter: meter ? String(meter).slice(0, 20) : null,
        type: tuneType ? String(tuneType).slice(0, 40) : null,
        names: matchableNames([title, ...(aliases || []), ...(names || [])]),
        done: null,
    };
}

export function makeTuneItem(tune) {
    return { ...tuneFields(tune), kind: 'tune' };
}

// `tunes` are already resolved: [{ tuneID, settingID, title, dataset, aliases }].
export function makeSetItem({ setID, title, tunes }) {
    return {
        id: newId(),
        kind: 'set',
        setID: setID || null,
        title: String(title || 'Set').slice(0, 200),
        tunes: (tunes || []).map(tuneFields),
    };
}

// Defensive read of a stored plan: it arrives over sync and from backups, so
// anything not shaped like an item is dropped rather than trusted.
export function sanitisePlan(plan) {
    if (!Array.isArray(plan)) return [];
    const okTune = t => t && typeof t === 'object' && typeof t.id === 'string';
    return plan.filter(item => okTune(item) && (item.kind === 'tune'
        || (item.kind === 'set' && Array.isArray(item.tunes))))
        .map(item => item.kind === 'set' ? { ...item, tunes: item.tunes.filter(okTune) } : item);
}

// Every tune in the plan, flattened, in order, with the set it belongs to.
export function planTunes(plan) {
    const out = [];
    for (const item of sanitisePlan(plan)) {
        if (item.kind === 'set') for (const t of item.tunes) out.push({ tune: t, set: item });
        else out.push({ tune: item, set: null });
    }
    return out;
}

function sameTune(a, aNames, b, bNames) {
    if (a.tuneID != null && b.tuneID != null && String(a.tuneID) === String(b.tuneID)) return true;
    if (!aNames.length || !bNames.length) return false;
    const set = new Set(aNames);
    return bNames.some(n => set.has(n));
}

// Is this tune already somewhere in the plan? Used to skip duplicates when
// adding, by the same rule that crosses things off.
export function planContains(plan, tune) {
    const names = matchableNames([tune.title, ...(tune.aliases || []), ...(tune.names || [])]);
    const candidate = { tuneID: tune.tuneID == null ? null : String(tune.tuneID) };
    return planTunes(plan).some(({ tune: t }) => sameTune(t, t.names || [], candidate, names));
}

// Appends, skipping tunes already planned (and tunes repeated within the
// batch). A set is appended as a block with its duplicates removed, and
// dropped entirely if nothing is left in it. Returns { plan, added, skipped }.
export function appendItems(plan, items) {
    let next = sanitisePlan(plan).slice();
    let added = 0;
    let skipped = 0;
    for (const item of items || []) {
        if (next.length >= MAX_PLAN_ITEMS) { skipped += item.kind === 'set' ? item.tunes.length : 1; continue; }
        if (item.kind === 'set') {
            const tunes = [];
            for (const t of item.tunes) {
                const probe = [...next, { ...item, tunes }];
                if (planContains(probe, t)) skipped++;
                else tunes.push(t);
            }
            if (tunes.length) { next.push({ ...item, tunes }); added += tunes.length; }
        } else if (planContains(next, item)) {
            skipped++;
        } else {
            next.push(item);
            added++;
        }
    }
    return { plan: next, added, skipped };
}

function locate(plan, id) {
    for (let i = 0; i < plan.length; i++) {
        if (plan[i].id === id) return { list: plan, index: i, parent: null };
        if (plan[i].kind === 'set') {
            const j = plan[i].tunes.findIndex(t => t.id === id);
            if (j >= 0) return { list: plan[i].tunes, index: j, parent: plan[i] };
        }
    }
    return null;
}

function cloneDeep(plan) {
    return sanitisePlan(plan).map(item => item.kind === 'set'
        ? { ...item, tunes: item.tunes.map(t => ({ ...t })) } : { ...item });
}

// Moves an item one place up (-1) or down (+1) within its own list: a whole
// set among the top-level items, or a tune within its set.
export function moveItem(plan, id, delta) {
    const next = cloneDeep(plan);
    const at = locate(next, id);
    if (!at) return next;
    const to = at.index + delta;
    if (to < 0 || to >= at.list.length) return next;
    const [item] = at.list.splice(at.index, 1);
    at.list.splice(to, 0, item);
    return next;
}

// Removes a tune or a whole set. A set left with no tunes goes too.
export function removeItem(plan, id) {
    const next = cloneDeep(plan);
    const at = locate(next, id);
    if (!at) return next;
    at.list.splice(at.index, 1);
    if (at.parent && !at.parent.tunes.length) next.splice(next.indexOf(at.parent), 1);
    return next;
}

export function setManualDone(plan, id, value) {
    const next = cloneDeep(plan);
    const at = locate(next, id);
    if (at) at.list[at.index] = { ...at.list[at.index], done: value === true || value === false ? value : null };
    return next;
}

// What a tap on a tune's state should set it to: flip what is shown, and a
// second tap hands it back to the automatic rule.
export function nextManualState(item, entry) {
    if (item.done === true || item.done === false) return null;
    return !(entry && entry.done);
}

// How long a tune must have been heard before it counts as played: a tune
// recognised for a few seconds (someone tried a phrase, a misdetection
// before the right tune won) has not been "played" for the audience.
export const DEFAULT_MIN_PLAYED_SECONDS = 45;

// Seconds a row was heard for. A row with no span (an older record, an
// import without end times) is taken as played in full — it is in the list,
// and there is nothing to measure it against.
function heardSeconds(row) {
    return typeof row.startSeconds === 'number' && typeof row.endSeconds === 'number'
        ? Math.max(0, row.endSeconds - row.startSeconds) : Infinity;
}

// played: the session's tune rows [{ tuneId, title, startSeconds, endSeconds, startedAtMs }].
// playedAliases: Map(tuneId string -> alias array), optional.
// minPlayedSeconds: the time, summed over every row of that tune, before it
// counts as played.
// Returns { byId: Map(itemId -> { done, auto, manual, playedAt, playedAtMs, heardSeconds }),
//           nextId, doneCount, total }.
export function planProgress(plan, played, playedAliases, { minPlayedSeconds = DEFAULT_MIN_PLAYED_SECONDS } = {}) {
    const rows = (played || []).filter(r => r && (r.tuneId != null || r.title)).map(r => ({
        row: r,
        tune: { tuneID: r.tuneId == null ? null : String(r.tuneId) },
        names: matchableNames([r.title, ...((playedAliases && playedAliases.get(String(r.tuneId))) || [])]),
    }));
    const byId = new Map();
    let nextId = null;
    let doneCount = 0;
    let total = 0;
    const judge = t => {
        const hits = rows.filter(r => sameTune(t, t.names || [], r.tune, r.names));
        const heard = hits.reduce((sum, r) => sum + heardSeconds(r.row), 0);
        const auto = hits.length > 0 && heard >= (Number(minPlayedSeconds) || 0);
        const manual = t.done === true || t.done === false ? t.done : null;
        const first = hits[0];
        const entry = {
            done: manual == null ? auto : manual,
            auto,
            manual,
            playedAt: first ? first.row.startSeconds : null,
            playedAtMs: first ? (first.row.startedAtMs || null) : null,
            // Heard, but not yet for long enough: "playing now", not played.
            heardSeconds: hits.length ? heard : 0,
        };
        byId.set(t.id, entry);
        total++;
        if (entry.done) doneCount++;
        else if (nextId == null) nextId = t.id;
        return entry;
    };
    for (const item of sanitisePlan(plan)) {
        if (item.kind === 'set') {
            const entries = item.tunes.map(judge);
            byId.set(item.id, {
                done: entries.length > 0 && entries.every(e => e.done),
                auto: entries.length > 0 && entries.every(e => e.auto),
                manual: null,
                playedAt: null,
                playedAtMs: null,
                heardSeconds: 0,
            });
        } else {
            judge(item);
        }
    }
    return { byId, nextId, doneCount, total };
}
