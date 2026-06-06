// First-Expiry-First-Out comparator.
//
// Spec (Check Out > FEFO Logic and Sort Order):
//   1. Expiry date, earliest first. Nulls last (a unit with no expiry sorts
//      AFTER all dated units — never picked over an expiring one).
//   2. Tiebreaker: created_at (date received) ascending.
//   3. Final tiebreaker: unit_code ascending (string compare).
/**
 * Total order over items implementing FEFO.
 *
 * Returns a negative number if `a` should appear before `b`,
 * positive if after, 0 if exactly equal across all three keys.
 *
 * Safe to use directly with Array.prototype.sort.
 */
export function compareFEFO(a, b) {
    // 1. expiry_date ascending, nulls last
    const aExp = a.expiryDate;
    const bExp = b.expiryDate;
    if (aExp !== bExp) {
        if (aExp === null)
            return 1; // a has no expiry -> a after b
        if (bExp === null)
            return -1; // b has no expiry -> a before b
        if (aExp < bExp)
            return -1;
        if (aExp > bExp)
            return 1;
    }
    // 2. created_at ascending
    if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? -1 : 1;
    }
    // 3. unit_code ascending (lexicographic)
    if (a.unitCode !== b.unitCode) {
        return a.unitCode < b.unitCode ? -1 : 1;
    }
    return 0;
}
/**
 * Convenience wrapper: returns a new array sorted by FEFO. Does not mutate input.
 */
export function sortFEFO(items) {
    return [...items].sort(compareFEFO);
}
//# sourceMappingURL=fefo.js.map