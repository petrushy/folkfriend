// The Sets list's "Find a set" box. A set is shown when the text matches its
// name, the name of a tune in it, or a tag — the set's own tags or the
// favourite tags of a tune in it — and the matches are listed in that order:
// sets matched by name first, then by a tune name, then by a tag. Within a
// tier the incoming order (most recently edited first) is kept.
//
// Pure: favourite tags are passed in, indexed by settingID and tune ID, so a
// tag the user put on any starred setting of a tune counts for that tune.

export const MATCH_NAME = 0;
export const MATCH_TUNE = 1;
export const MATCH_TAG = 2;

// Case- and accent-insensitive, so "gardebylaten" finds Gärdebylåten.
export function foldText(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();
}

export function indexFavouriteTags(favourites) {
    const bySetting = new Map();
    const byTune = new Map();
    const add = (map, key, tags) => {
        if (key === undefined || key === null || key === '') return;
        const k = String(key);
        const set = map.get(k) || new Set();
        tags.forEach(t => set.add(t));
        map.set(k, set);
    };
    for (const fav of favourites || []) {
        const tags = Array.isArray(fav?.tags) ? fav.tags.filter(t => typeof t === 'string' && t) : [];
        if (!tags.length) continue;
        add(bySetting, fav.result?.settingID, tags);
        add(byTune, fav.result?.setting?.tune_id, tags);
    }
    return { bySetting, byTune };
}

export function entryTags(entry, tagIndex) {
    const out = new Set();
    const settingID = entry?.result?.settingID;
    const tuneID = entry?.result?.setting?.tune_id;
    if (tagIndex) {
        (tagIndex.bySetting.get(String(settingID)) || []).forEach(t => out.add(t));
        (tagIndex.byTune.get(String(tuneID)) || []).forEach(t => out.add(t));
    }
    return [...out];
}

// Returns [{ set, tier, tunes, tags }]: `tunes` the display names of tunes
// whose name matched, `tags` the tags (set or tune) that matched — what the
// row shows to explain why a set is listed.
export function matchSets(sets, query, { tagIndex = null, activeTags = [], displayName = n => n } = {}) {
    const q = foldText(query).trim();
    const matched = [];
    for (const set of sets || []) {
        if (!activeTags.every(t => (set.tags || []).includes(t))) continue;
        if (!q) { matched.push({ set, tier: MATCH_NAME, tunes: [], tags: [] }); continue; }
        const hit = text => foldText(text).includes(q);
        const entries = set.entries || [];
        const tunes = [...new Set(entries.map(e => displayName(e?.result?.displayName || '')).filter(n => n && hit(n)))];
        const tags = [...new Set([...(set.tags || []), ...entries.flatMap(e => entryTags(e, tagIndex))].filter(hit))];
        const tier = hit(set.name) ? MATCH_NAME : tunes.length ? MATCH_TUNE : tags.length ? MATCH_TAG : -1;
        if (tier >= 0) matched.push({ set, tier, tunes, tags });
    }
    // Array.prototype.sort is stable, so each tier keeps the incoming order.
    return matched.sort((a, b) => a.tier - b.tier);
}
