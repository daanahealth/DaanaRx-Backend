import type { Item } from "./types.js";
/**
 * Total order over items implementing FEFO.
 *
 * Returns a negative number if `a` should appear before `b`,
 * positive if after, 0 if exactly equal across all three keys.
 *
 * Safe to use directly with Array.prototype.sort.
 */
export declare function compareFEFO(a: Item, b: Item): number;
/**
 * Convenience wrapper: returns a new array sorted by FEFO. Does not mutate input.
 */
export declare function sortFEFO(items: readonly Item[]): Item[];
//# sourceMappingURL=fefo.d.ts.map