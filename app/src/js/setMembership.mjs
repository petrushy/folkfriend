export function indexSetsBySetting(sets) {
    const result = Object.create(null);
    for (const set of sets) {
        if (set.deleted) continue;
        const seen = new Set();
        for (const entry of set.entries) {
            const id = String(entry.result.settingID);
            if (seen.has(id)) continue;
            seen.add(id);
            if (!result[id]) result[id] = [];
            result[id].push({ id: set.id, name: set.name });
        }
    }
    return result;
}

// Membership by TUNE, for a session's tune list: the setting a detection
// carries is whichever scored best in that window, so exact-setting
// membership would almost never show for it. "This tune is already in a set"
// is the question there.
export function indexSetsByTune(sets) {
    const result = Object.create(null);
    for (const set of sets) {
        if (set.deleted) continue;
        const seen = new Set();
        for (const entry of set.entries) {
            const tuneID = entry.result && entry.result.setting && entry.result.setting.tune_id;
            if (tuneID == null) continue;
            const id = String(tuneID);
            if (seen.has(id)) continue;
            seen.add(id);
            if (!result[id]) result[id] = [];
            result[id].push({ id: set.id, name: set.name });
        }
    }
    return result;
}
