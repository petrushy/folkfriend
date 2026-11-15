export function setsForTune(sets, tuneID) {
    return sets.filter(set => !set.deleted).map(set => ({
        id: set.id, name: set.name,
        entries: set.entries.filter(e => String(e.result.setting.tune_id) === String(tuneID)),
    })).filter(set => set.entries.length);
}
