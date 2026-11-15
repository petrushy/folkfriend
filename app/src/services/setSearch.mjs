function searchName(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
}

// Name search returns one representative per tune, without setting IDs or ABC.
// Resolve settings, then include matching saved favourites even if their
// database is unavailable. A favourite identifies a particular setting.
export async function searchSetSettings(backend, query, { favourites = [], indexReady = true } = {}) {
    const tunes = indexReady ? await backend.runNameQuery(query) : [];
    const unique = [...new Map(tunes.map(r => [String(r.setting.tune_id), r])).values()];
    const groups = await Promise.all(unique.map(async tune => {
        const settings = await backend.settingsFromTuneID(tune.setting.tune_id);
        return settings.map(setting => ({
            setting_id: setting.setting_id,
            setting,
            display_name: tune.display_name,
        }));
    }));
    const byID = new Map(groups.flat().map(r => [String(r.setting_id), r]));
    const favouriteTuneIDs = new Set();
    const wanted = searchName(query.trim());
    for (const favourite of favourites) {
        const r = favourite.result;
        if (!r || r.settingID == null || !r.setting || !r.setting.abc) continue;
        const tuneID = String(r.setting.tune_id);
        favouriteTuneIDs.add(tuneID);
        if (!byID.has(String(r.settingID)) && !unique.some(t => String(t.setting.tune_id) === tuneID) &&
            !searchName(r.displayName).includes(wanted)) continue;
        byID.set(String(r.settingID), {
            setting_id: r.settingID, setting: r.setting, display_name: r.displayName, favourite: true,
        });
    }
    // Prefer the actual starred version, then other settings of favourite
    // tunes. Keep the database's relevance order within each group.
    const rank = r => r.favourite ? 0 : favouriteTuneIDs.has(String(r.setting.tune_id)) ? 1 : 2;
    return [...byID.values()].sort((a, b) => rank(a) - rank(b));
}
