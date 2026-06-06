// Re-export shared platform types & helpers from @daana-health/inventory-core.
// Subsequent backend agents import from this module so the dependency path
// is centralized.
export type {
  Item,
  ItemStatus,
  ItemType,
  Location,
  Transaction,
  Cart,
  CartStatus,
  TransactionAction,
} from '@daana-health/inventory-core';

export {
  compareFEFO,
  isActiveStatus,
  assertTransition,
} from '@daana-health/inventory-core';
