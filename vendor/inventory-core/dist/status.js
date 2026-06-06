"use strict";
// Inventory item status state machine.
// The allowed transitions encode the rules in the MASS MVP spec:
//   active -> in_cart | pending_approval | checked_out | removed | expired
//   in_cart -> active (cart cleared/expired) | checked_out (approved) | removed
//   pending_approval -> active (rejected/expired) | checked_out (approved) | removed
//   checked_out -> (terminal — no further transitions)
//   removed -> (terminal — no further transitions, soft-deleted)
//   expired -> removed (confirm removal) | checked_out (superadmin override)
//
// Concurrent-checkout safety, role gating, and audit logging are enforced at
// the RPC layer (SQL SECURITY DEFINER functions). This module is the pure
// in-memory state machine that the API + UI consult.
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvalidStatusTransitionError = exports.allowedTransitions = void 0;
exports.isActiveStatus = isActiveStatus;
exports.isTerminalStatus = isTerminalStatus;
exports.isSearchableForRestrictedUser = isSearchableForRestrictedUser;
exports.assertTransition = assertTransition;
exports.canTransition = canTransition;
/**
 * Statuses an item is allowed to transition to from each origin status.
 * Empty array = terminal state.
 */
exports.allowedTransitions = {
    active: ["in_cart", "pending_approval", "checked_out", "removed", "expired"],
    in_cart: ["active", "checked_out", "removed"],
    pending_approval: ["active", "checked_out", "removed"],
    checked_out: [],
    removed: [],
    expired: ["removed", "checked_out"],
};
/**
 * Statuses that count as "in active inventory" — i.e. the unit is physically
 * in the bin and not dispensed/destroyed. Useful for capacity counts.
 *
 * Note: in_cart and pending_approval items are still PHYSICALLY in the bin,
 * but spec excludes them from "available for checkout" results.
 */
function isActiveStatus(s) {
    return s === "active" || s === "in_cart" || s === "pending_approval";
}
/**
 * True for statuses that mean the item is no longer in the bin (or never will be).
 */
function isTerminalStatus(s) {
    return s === "checked_out" || s === "removed";
}
/**
 * True if the unit is available to a restricted user's search.
 * Only "active" qualifies — in_cart/pending_approval are hidden, expired flagged.
 */
function isSearchableForRestrictedUser(s) {
    return s === "active";
}
class InvalidStatusTransitionError extends Error {
    constructor(from, to) {
        super(`Invalid item status transition: ${from} -> ${to}`);
        this.name = "InvalidStatusTransitionError";
        this.from = from;
        this.to = to;
    }
}
exports.InvalidStatusTransitionError = InvalidStatusTransitionError;
/**
 * Throws InvalidStatusTransitionError if the transition is not allowed.
 * Identity transitions (from === to) are also rejected — they should not
 * produce a transaction row.
 */
function assertTransition(from, to) {
    if (from === to) {
        throw new InvalidStatusTransitionError(from, to);
    }
    const allowed = exports.allowedTransitions[from];
    if (!allowed.includes(to)) {
        throw new InvalidStatusTransitionError(from, to);
    }
}
/**
 * Pure-function predicate version of assertTransition for use in
 * UI guards (disabling buttons, etc.).
 */
function canTransition(from, to) {
    if (from === to)
        return false;
    return exports.allowedTransitions[from].includes(to);
}
//# sourceMappingURL=status.js.map