// "Played in sets with…" — which order to suggest a tune's set partners in.
//
// The data (thesession.org member sets and recording tracks, built by the data
// repo's thesession_sets.py) says how often two tunes are played together.
// This decides what the user sees first, and it is pure so the rule can be
// tested without the worker or Vue.
//
// The rule, as asked for: a STARRED tune goes to the top, but only if it is
// commonly played with this one. A favourite that turned up together once in
// 130,000 sets is not a suggestion — putting it first would bury the tunes
// people actually play next. "Commonly" is relative to the strongest partner
// (COMMON_SHARE of it) with an absolute floor (COMMON_MIN), because counts
// range from thousands for The Kesh to a handful for an obscure slide.

export const COMMON_MIN = 3;
export const COMMON_SHARE = 0.15;

// A direction is only claimed when it is both seen several times and clearly
// the usual one. Most pairs are played in either order.
export const DIRECTION_MIN = 3;
export const DIRECTION_RATIO = 2;

export function partnerTotal(p) {
    return (Number(p.inSets) || 0) + (Number(p.onRecordings) || 0);
}

export function commonThreshold(partners) {
    const top = partners.reduce((m, p) => Math.max(m, partnerTotal(p)), 0);
    return Math.max(COMMON_MIN, Math.ceil(top * COMMON_SHARE));
}

// 'after' — the partner usually comes after this tune; 'before' — usually
// before it; '' — no clear order. A `precededBy` of null or undefined means the
// reverse count is UNKNOWN, not zero, and no direction can be claimed from one
// side alone.
export function partnerDirection(p) {
    if (p.precededBy === null || p.precededBy === undefined) return '';
    const after = Number(p.followedBy) || 0;
    const before = Number(p.precededBy) || 0;
    if (after >= DIRECTION_MIN && after >= DIRECTION_RATIO * before) return 'after';
    if (before >= DIRECTION_MIN && before >= DIRECTION_RATIO * after) return 'before';
    return '';
}

// `starredTuneIDs`: anything with .has(), holding tune ids as strings.
// Returns new objects with `total`, `starred`, `common` and `direction`, in
// display order: common starred tunes, then everything by how often it is
// played together, ties broken by tune id so the order never shuffles.
export function rankSetPartners(partners, starredTuneIDs = new Set()) {
    const list = Array.isArray(partners) ? partners : [];
    const threshold = commonThreshold(list);
    const ranked = list.map(p => {
        const total = partnerTotal(p);
        const starred = Boolean(starredTuneIDs && starredTuneIDs.has(String(p.tuneID)));
        return {
            ...p,
            total,
            starred,
            common: total >= threshold,
            direction: partnerDirection(p),
        };
    });
    ranked.sort((a, b) => {
        const ap = a.starred && a.common ? 1 : 0;
        const bp = b.starred && b.common ? 1 : 0;
        if (ap !== bp) return bp - ap;
        if (a.total !== b.total) return b.total - a.total;
        return String(a.tuneID).localeCompare(String(b.tuneID), undefined, { numeric: true });
    });
    return ranked;
}

// Plain-language count for a row: "in 106 sets · 2 recordings".
export function describeCounts(p) {
    const parts = [];
    const sets = Number(p.inSets) || 0;
    const recs = Number(p.onRecordings) || 0;
    if (sets) parts.push(`in ${sets} set${sets === 1 ? '' : 's'}`);
    if (recs) parts.push(`${recs} recording${recs === 1 ? '' : 's'}`);
    return parts.join(' · ');
}
