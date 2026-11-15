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
