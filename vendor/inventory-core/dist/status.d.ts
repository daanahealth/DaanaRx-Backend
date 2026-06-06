import type { ItemStatus } from "./types.js";
/**
 * Statuses an item is allowed to transition to from each origin status.
 * Empty array = terminal state.
 */
export declare const allowedTransitions: Readonly<Record<ItemStatus, readonly ItemStatus[]>>;
/**
 * Statuses that count as "in active inventory" — i.e. the unit is physically
 * in the bin and not dispensed/destroyed. Useful for capacity counts.
 *
 * Note: in_cart and pending_approval items are still PHYSICALLY in the bin,
 * but spec excludes them from "available for checkout" results.
 */
export declare function isActiveStatus(s: ItemStatus): boolean;
/**
 * True for statuses that mean the item is no longer in the bin (or never will be).
 */
export declare function isTerminalStatus(s: ItemStatus): boolean;
/**
 * True if the unit is available to a restricted user's search.
 * Only "active" qualifies — in_cart/pending_approval are hidden, expired flagged.
 */
export declare function isSearchableForRestrictedUser(s: ItemStatus): boolean;
export declare class InvalidStatusTransitionError extends Error {
    readonly from: ItemStatus;
    readonly to: ItemStatus;
    constructor(from: ItemStatus, to: ItemStatus);
}
/**
 * Throws InvalidStatusTransitionError if the transition is not allowed.
 * Identity transitions (from === to) are also rejected — they should not
 * produce a transaction row.
 */
export declare function assertTransition(from: ItemStatus, to: ItemStatus): void;
/**
 * Pure-function predicate version of assertTransition for use in
 * UI guards (disabling buttons, etc.).
 */
export declare function canTransition(from: ItemStatus, to: ItemStatus): boolean;
//# sourceMappingURL=status.d.ts.map