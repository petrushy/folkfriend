// Name search returns one representative per tune, without setting IDs or ABC.
// Resolve the tune's settings before offering anything that can be saved.
export async function searchSetSettings(backend, query) {
    const tunes = await backend.runNameQuery(query);
    const unique = [...new Map(tunes.map(r => [String(r.setting.tune_id), r])).values()];
    const groups = await Promise.all(unique.map(async tune => {
        const settings = await backend.settingsFromTuneID(tune.setting.tune_id);
        return settings.map(setting => ({
            setting_id: setting.setting_id,
            setting,
            display_name: tune.display_name,
        }));
    }));
    return groups.flat();
}
