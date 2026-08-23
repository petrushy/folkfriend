// Progressive rendering budget for long favourite lists.
//
// A FavouriteRow is not cheap: a v-checkbox, a v-menu, two v-btns and — in the
// flat list — a full ABCJS engraving of the first few bars. Rendering three
// hundred of them in one synchronous pass is what makes the Favourites view
// take several seconds to appear on an older iPad.
//
// So the view renders a budget of rows and grows it as the user scrolls. This
// module is the pure part of that: given the groups the view wants to show and
// a budget, decide what is actually rendered. It is deliberately free of Vue
// and of the DOM so the boundary arithmetic can be tested directly.
//
// Only *rendering* is windowed. Selection, "select all", sharing and export all
// run off the full row lists, so a row that has not been rendered yet is still
// selectable via the group or select-all checkboxes and still exported.

// Enough to fill the first screen on any device with a little to spare.
export const INITIAL_ROW_BUDGET = 24;
// How much the budget grows each time the sentinel comes into view. Small
// enough that one growth step never blocks the main thread for long.
export const ROW_BUDGET_STEP = 24;

/**
 * Slice a flat row list to the budget.
 * @returns {{rows: Array, shown: number, total: number, hasMore: boolean}}
 */
export function windowRows(rows, budget) {
    const all = rows || [];
    if (!Number.isFinite(budget)) {
        return { rows: all, shown: all.length, total: all.length, hasMore: false };
    }
    const limit = Math.max(0, budget);
    const shown = Math.min(all.length, limit);
    return {
        rows: shown === all.length ? all : all.slice(0, shown),
        shown,
        total: all.length,
        hasMore: shown < all.length,
    };
}

/**
 * Spend a single budget across groups, in order.
 *
 * A collapsed group renders no rows, so it must not consume budget — otherwise
 * collapsing the top group would leave the ones below it stuck empty. Its rows
 * are still carried through untouched, because the header shows their count and
 * the group checkbox selects them.
 *
 * Groups past the budget are dropped entirely rather than kept with zero rows:
 * a heading with nothing under it reads as an empty group, which is a different
 * claim from "not loaded yet".
 *
 * @param groups  [{ rows: [...], collapsed?: boolean, ... }]
 * @returns {{groups: Array, shown: number, total: number, hasMore: boolean}}
 */
export function windowGroups(groups, budget) {
    const all = groups || [];
    const total = all.reduce((n, g) => n + ((g.rows && g.rows.length) || 0), 0);
    if (!Number.isFinite(budget)) {
        return { groups: all, shown: total, total, hasMore: false };
    }

    let remaining = Math.max(0, budget);
    let shown = 0;
    const out = [];
    for (const group of all) {
        const rows = group.rows || [];
        if (group.collapsed) {
            // Renders nothing, so it costs nothing — but it still belongs in
            // the output, header and all.
            out.push(group);
            continue;
        }
        if (remaining <= 0) continue;
        const take = Math.min(rows.length, remaining);
        remaining -= take;
        shown += take;
        out.push(take === rows.length ? group : { ...group, rows: rows.slice(0, take) });
    }
    return { groups: out, shown, total, hasMore: shown < countExpanded(all) };
}

function countExpanded(groups) {
    return groups.reduce((n, g) => n + (g.collapsed ? 0 : ((g.rows && g.rows.length) || 0)), 0);
}
