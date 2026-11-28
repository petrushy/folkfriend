// Adding tunes and sets to a session's plan, and finding the sessions a plan
// can go on. The rules are in js/sessionPlan.mjs; this is the wiring to the
// index (aliases, key, type) and the store.
//
// ffBackend is only ever reached inside functions: this module is imported
// by App.vue's dialog, and backend.js sits in an import cycle with the router
// (see "Practice follow" in CLAUDE.md), so a value captured at evaluation
// time could be undefined.

import store from './store.js';
import ffBackend from './backend.js';
import { settingsForSetTune } from './setSearch.mjs';
import { makeTuneItem, makeSetItem, appendItems } from '@/js/sessionPlan.mjs';

async function aliasesFor(tuneID) {
    if (tuneID == null) return [];
    try {
        const aliases = await ffBackend.aliasesFromTuneID(tuneID);
        return Array.isArray(aliases) ? aliases : [];
    } catch (e) {
        return [];
    }
}

// tune: { tuneID, settingID, title, dataset, setting? }. The setting, when a
// caller has it (a favourite, a set entry), saves a lookup; otherwise it is
// found in the index, and a tune the index does not hold is still planned,
// by name, with no key or type.
async function resolveTune(tune, favourites) {
    let setting = tune.setting || null;
    let settingID = tune.settingID == null ? null : tune.settingID;
    if ((!setting || !setting.mode) && tune.tuneID != null) {
        try {
            const options = await settingsForSetTune(ffBackend, tune.tuneID, tune.title, favourites);
            const hit = options.find(o => String(o.setting_id) === String(settingID)) || options[0];
            if (hit) {
                setting = hit.setting;
                if (settingID == null) settingID = hit.setting_id;
            }
        } catch (e) { /* planned by name only */ }
    }
    return {
        tuneID: tune.tuneID != null ? tune.tuneID : (setting && setting.tune_id),
        settingID,
        title: tune.title,
        dataset: tune.dataset || (setting && setting.dataset) || null,
        aliases: await aliasesFor(tune.tuneID != null ? tune.tuneID : (setting && setting.tune_id)),
        mode: setting && setting.mode,
        meter: setting && setting.meter,
        type: setting && setting.dance,
    };
}

function setEntryTune(entry) {
    const r = entry.result || {};
    return { tuneID: r.setting && r.setting.tune_id, settingID: r.settingID, title: r.displayName, setting: r.setting };
}

// Appends to the END of the plan, in the order given: loose tunes first, then
// each set as its own block. Tunes already in the plan are skipped.
// Returns { added, skipped }.
export async function addToSessionPlan(sessionID, { tunes = [], sets = [] } = {}) {
    let favourites = [];
    try { favourites = await store.getFavourites(); } catch (e) { favourites = []; }
    const items = (await Promise.all(tunes.map(t => resolveTune(t, favourites)))).map(makeTuneItem);
    for (const set of sets) {
        const resolved = await Promise.all((set.entries || []).map(e => resolveTune(setEntryTune(e), favourites)));
        items.push(makeSetItem({ setID: set.id, title: set.name, tunes: resolved }));
    }
    let counts = { added: 0, skipped: 0 };
    await store.updateSessionPlan(sessionID, plan => {
        const result = appendItems(plan, items);
        counts = { added: result.added, skipped: result.skipped };
        return result.plan;
    });
    return counts;
}

// The sessions a plan can be added to: the one open now (whatever its state)
// and every planned one, most recently planned first.
export async function planDestinations(openSessionID) {
    const sessions = await store.getNamedLiveSessions();
    const open = openSessionID ? sessions.find(s => s.id === openSessionID) : null;
    const planned = sessions.filter(s => s.planned && s.id !== openSessionID)
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return { open, planned };
}
