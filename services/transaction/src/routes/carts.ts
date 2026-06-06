// Cart + checkout routes for the MASS MVP.
//
// Implements the spec's "Check Out Flow", "Cart Reservation and Expiry",
// "Concurrent Checkout Conflict", and "Expired Override" flows.
//
// State machine: every status change is gated by assertTransition() from
// @daana-health/inventory-core. Invalid transitions return HTTP 409.
//
// Concurrent-conflict safety: the cart-add path runs as a conditional UPDATE
// (".eq('status', 'active')"). If a competing writer flipped the row first,
// the conditional update returns zero rows and we surface the spec's literal
// message: "This medication has just been checked out. Please refresh and
// select another unit."
//
// NOTE: The 002_core_inventory_platform.sql migration is NOT YET APPLIED. This
// file targets the schema described in
// /Users/rithik/Code/daana-inventory/docs/architecture.md §8 (items, carts,
// cart_items, transactions). Once the migration lands and SECURITY DEFINER RPCs
// are added, the atomic blocks below should be ported to a single RPC call.

import { Router, Request, Response } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { supabaseServer } from '../utils/supabase';
import {
  assertTransition,
  InvalidStatusTransitionError,
} from '@daana-health/inventory-core';
import type { ItemStatus, TransactionAction } from '@daana-health/inventory-core';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CART_TTL_MS = 24 * 60 * 60 * 1000;

function newExpiry(): string {
  return new Date(Date.now() + CART_TTL_MS).toISOString();
}

function isSuperadmin(user: any): boolean {
  return user?.userRole === 'superadmin';
}

function isRestricted(user: any): boolean {
  return user?.userRole === 'restricted_user' || user?.userRole === 'restricted';
}

/**
 * Append a transactions-table row. Returns the inserted row or throws.
 * Centralised so every status change writes a uniform audit entry.
 */
async function logTransaction(params: {
  itemId: string;
  action: TransactionAction;
  actorId: string | null;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  reason?: string | null;
  note?: string | null;
}) {
  const { itemId, action, actorId, oldValue, newValue, reason, note } = params;
  const { data, error } = await supabaseServer
    .from('transactions')
    .insert({
      item_id: itemId,
      action,
      actor_id: actorId,
      old_value: oldValue ?? null,
      new_value: newValue ?? null,
      reason: reason ?? null,
      note: note ?? null,
    })
    .select('*')
    .single();
  if (error) {
    throw new Error(`Failed to log transaction: ${error.message}`);
  }
  return data;
}

/**
 * Conditional status flip. Returns the updated row if the status was still
 * `expectedFrom` at the moment of UPDATE, or null if the race was lost.
 *
 * This is the supabase-js equivalent of "UPDATE items SET status = ? WHERE
 * id = ? AND status = ? RETURNING *" — atomic in Postgres, single statement.
 * When the migration RPCs land this should move into a SECURITY DEFINER fn
 * with explicit SELECT ... FOR UPDATE; for now this pattern is sufficient
 * because Postgres locks the row for the duration of the UPDATE.
 */
async function casItemStatus(
  itemId: string,
  expectedFrom: ItemStatus,
  to: ItemStatus,
  actorId: string | null,
) {
  // Validate the transition before touching the DB — saves a round trip and
  // gives a clear 409 for impossible transitions.
  assertTransition(expectedFrom, to);

  const { data, error } = await supabaseServer
    .from('items')
    .update({
      status: to,
      last_edited_at: new Date().toISOString(),
      last_edited_by: actorId,
    })
    .eq('id', itemId)
    .eq('status', expectedFrom)
    .select('*')
    .maybeSingle();

  if (error) throw new Error(`Failed to update item status: ${error.message}`);
  return data;
}

async function getItem(itemId: string) {
  const { data, error } = await supabaseServer
    .from('items')
    .select('*')
    .eq('id', itemId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load item: ${error.message}`);
  return data;
}

async function getCart(cartId: string) {
  const { data, error } = await supabaseServer
    .from('carts')
    .select('*')
    .eq('id', cartId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load cart: ${error.message}`);
  return data;
}

async function getCartItems(cartId: string) {
  const { data, error } = await supabaseServer
    .from('cart_items')
    .select('*, item:items(*)')
    .eq('cart_id', cartId);
  if (error) throw new Error(`Failed to load cart items: ${error.message}`);
  return data || [];
}

function handleTransitionError(res: Response, err: unknown): boolean {
  if (err instanceof InvalidStatusTransitionError) {
    res.status(409).json({
      error: `Invalid status transition: ${err.from} -> ${err.to}`,
      from: err.from,
      to: err.to,
    });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Current-cart resolution (added by feature/be-contract-patch)
// ---------------------------------------------------------------------------

/**
 * Resolve (or create) the caller's "current" cart.
 *
 * Definition of "current": the caller's most-recent cart whose status is
 * `active` or `pending_approval` (i.e. open + not yet decided) and whose
 * `expires_at` is in the future. Newest `expires_at` wins so that a freshly
 * touched cart is always preferred — the cart-add path bumps `expires_at` on
 * every add, so this rule converges on the cart the user is actively editing.
 *
 * If no such cart exists this function lazily creates a fresh `active` cart
 * with a 24h TTL and returns it. Used by GET /carts/current and the
 * POST /carts/current/items alias.
 */
async function resolveCurrentCart(userId: string): Promise<any> {
  const nowIso = new Date().toISOString();
  const { data: existing, error } = await supabaseServer
    .from('carts')
    .select('*')
    .eq('owner_id', userId)
    .in('status', ['active', 'pending_approval'])
    .gt('expires_at', nowIso)
    .order('expires_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`Failed to resolve current cart: ${error.message}`);
  if (existing && existing.length > 0) return existing[0];

  // Auto-create.
  const { data: created, error: createErr } = await supabaseServer
    .from('carts')
    .insert({
      owner_id: userId,
      status: 'active',
      expires_at: newExpiry(),
    })
    .select('*')
    .single();
  if (createErr || !created) {
    throw new Error(`Failed to auto-create cart: ${createErr?.message}`);
  }
  return created;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /carts/current
 * Returns the caller's open cart (auto-creating one if none exists).
 * MUST be registered before GET /:id so Express doesn't treat "current"
 * as a cart id.
 *
 * Contract: matches the FE checkout-cart's optimistic-add flow — the FE
 * calls this on cart-sidebar mount to discover an existing cart or seed
 * a fresh one, then chains POST /carts/current/items.
 */
router.get('/current', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const cart = await resolveCurrentCart(user.userId);
    const items = await getCartItems(cart.id);
    res.json({
      id: cart.id,
      owner_id: cart.owner_id,
      status: cart.status,
      submitted_at: cart.submitted_at,
      decided_at: cart.decided_at,
      decided_by: cart.decided_by,
      expires_at: cart.expires_at,
      created_at: cart.created_at,
      items,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /carts?status=pending_approval
 * Superadmin only. Lists all carts in the given status across the system,
 * newest first, with the owner id and an item count attached.
 *
 * Used by the FE checkout-cart's "Pending Approvals" tab. Closes the contract
 * drift documented in docs/merge-strategy.md §4.
 */
router.get('/', requireAuth, requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string | undefined) ?? 'pending_approval';
    const allowed = ['active', 'pending_approval', 'approved', 'rejected', 'expired'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
    const { data, error } = await supabaseServer
      .from('carts')
      .select('*, cart_items(item_id)')
      .eq('status', status)
      .order('submitted_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    const rows = (data || []).map((c: any) => ({
      id: c.id,
      owner_id: c.owner_id,
      status: c.status,
      submitted_at: c.submitted_at,
      decided_at: c.decided_at,
      decided_by: c.decided_by,
      expires_at: c.expires_at,
      created_at: c.created_at,
      item_count: Array.isArray(c.cart_items) ? c.cart_items.length : 0,
    }));
    res.json({ carts: rows, count: rows.length, status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /carts/current/items
 * Convenience alias for POST /carts/:id/items, resolving (or auto-creating)
 * the caller's current cart first. Body: { item_id }.
 *
 * Concurrent-conflict semantics, expired-override gates, and transaction
 * logging match POST /:id/items byte-for-byte.
 *
 * MUST be registered before POST /:id/items so Express does not treat
 * "current" as a cart id.
 */
router.post('/current/items', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const itemId: string | undefined = req.body?.item_id;
    if (!itemId) return res.status(400).json({ error: 'item_id required' });

    const overrideFlag = req.query.override === 'true' || req.query.override === '1';
    const overrideNote = (req.query.note as string | undefined) || undefined;

    const cart = await resolveCurrentCart(user.userId);
    if (cart.status !== 'active' && cart.status !== 'pending_approval') {
      return res.status(409).json({
        error: `Cart is ${cart.status} and cannot accept new items`,
      });
    }

    const item = await getItem(itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    if (item.status === 'expired') {
      if (!isSuperadmin(user)) {
        return res.status(403).json({
          error: 'Expired medications cannot be added by restricted users',
        });
      }
      if (!overrideFlag) {
        return res.status(403).json({
          error: 'Expired medication requires superadmin override with a note',
          override_required: true,
        });
      }
      if (!overrideNote || overrideNote.trim().length === 0) {
        return res.status(400).json({
          error: 'A mandatory note is required to override an expired medication',
          override_required_note: true,
        });
      }
    } else if (item.status !== 'active') {
      return res.status(409).json({
        error: 'Item is not available (already reserved, checked out, removed, or expired)',
        current_status: item.status,
      });
    }

    const targetStatus: ItemStatus = isSuperadmin(user) ? 'in_cart' : 'pending_approval';
    const fromStatus: ItemStatus = item.status === 'expired' ? 'expired' : 'active';

    let updated;
    try {
      updated = await casItemStatus(itemId, fromStatus, targetStatus, user.userId);
    } catch (err) {
      if (handleTransitionError(res, err)) return;
      throw err;
    }
    if (!updated) {
      return res.status(409).json({
        error: 'This medication has just been checked out. Please refresh and select another unit.',
        conflict: 'concurrent_checkout',
      });
    }

    const { error: ciErr } = await supabaseServer
      .from('cart_items')
      .insert({ cart_id: cart.id, item_id: itemId, added_at: new Date().toISOString() });
    if (ciErr) {
      await supabaseServer
        .from('items')
        .update({ status: fromStatus })
        .eq('id', itemId)
        .eq('status', targetStatus);
      throw new Error(`Failed to add cart_item row: ${ciErr.message}`);
    }

    await supabaseServer
      .from('carts')
      .update({ expires_at: newExpiry() })
      .eq('id', cart.id);

    const action: TransactionAction = item.status === 'expired'
      ? 'expired_override'
      : 'edit';
    await logTransaction({
      itemId,
      action,
      actorId: user.userId,
      oldValue: { status: fromStatus },
      newValue: { status: targetStatus },
      reason: item.status === 'expired' ? 'expired_override_add' : 'cart_add',
      note: item.status === 'expired' ? (overrideNote ?? null) : null,
    });

    res.status(201).json({
      cart_id: cart.id,
      item_id: itemId,
      status: targetStatus,
      added_at: new Date().toISOString(),
      ...(item.status === 'expired' ? { override_note: overrideNote } : {}),
    });
  } catch (err: any) {
    if (handleTransitionError(res, err)) return;
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /carts
 * Create an empty cart for the current user. Returns { id, status, expires_at }.
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { data, error } = await supabaseServer
      .from('carts')
      .insert({
        owner_id: user.userId,
        status: 'active',
        expires_at: newExpiry(),
      })
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json({
      id: data.id,
      status: data.status,
      expires_at: data.expires_at,
      owner_id: data.owner_id,
      created_at: data.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /carts/:id
 * Return cart contents + status + expires_at.
 */
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const cart = await getCart(req.params.id);
    if (!cart) return res.status(404).json({ error: 'Cart not found' });
    const items = await getCartItems(cart.id);
    res.json({
      id: cart.id,
      owner_id: cart.owner_id,
      status: cart.status,
      submitted_at: cart.submitted_at,
      decided_at: cart.decided_at,
      decided_by: cart.decided_by,
      expires_at: cart.expires_at,
      created_at: cart.created_at,
      items,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /carts/:id/items
 * Body: { item_id }
 * Query: ?override=true&note=... (expired-medication superadmin override)
 *
 * Adds an item to the cart. Atomically flips item.status from `active` (or
 * `expired` when overriding) to `in_cart` (superadmin) or `pending_approval`
 * (restricted user). Touches cart.expires_at to now()+24h.
 */
router.post('/:id/items', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const cartId = req.params.id;
    const itemId: string | undefined = req.body?.item_id;
    if (!itemId) return res.status(400).json({ error: 'item_id required' });

    const overrideFlag = req.query.override === 'true' || req.query.override === '1';
    const overrideNote = (req.query.note as string | undefined) || undefined;

    // 1) Cart must exist and belong to caller (restricted users only edit their own).
    const cart = await getCart(cartId);
    if (!cart) return res.status(404).json({ error: 'Cart not found' });
    if (!isSuperadmin(user) && cart.owner_id !== user.userId) {
      return res.status(403).json({ error: 'You do not own this cart' });
    }
    if (cart.status !== 'active' && cart.status !== 'pending_approval') {
      return res.status(409).json({
        error: `Cart is ${cart.status} and cannot accept new items`,
      });
    }

    // 2) Item must exist.
    const item = await getItem(itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // 3) Expired-item override gate.
    if (item.status === 'expired') {
      if (!isSuperadmin(user)) {
        return res.status(403).json({
          error: 'Expired medications cannot be added by restricted users',
        });
      }
      if (!overrideFlag) {
        return res.status(403).json({
          error: 'Expired medication requires superadmin override with a note',
          override_required: true,
        });
      }
      if (!overrideNote || overrideNote.trim().length === 0) {
        return res.status(400).json({
          error: 'A mandatory note is required to override an expired medication',
          override_required_note: true,
        });
      }
    } else if (item.status !== 'active') {
      // 4) Any other non-active status -> already reserved/checked out/removed.
      return res.status(409).json({
        error: 'Item is not available (already reserved, checked out, removed, or expired)',
        current_status: item.status,
      });
    }

    // 5) Determine target status from role.
    const targetStatus: ItemStatus = isSuperadmin(user) ? 'in_cart' : 'pending_approval';
    const fromStatus: ItemStatus = item.status === 'expired' ? 'expired' : 'active';
    // For expired override the item moves directly to checked_out per spec, but
    // when ADDING to a cart we still gate through in_cart first so the
    // approval flow / log can run uniformly. The cart-approve step then drives
    // in_cart -> checked_out with an `expired_override` transaction action.
    //
    // assertTransition is called inside casItemStatus.

    // 6) Atomic flip: only succeeds if no concurrent writer has changed status.
    let updated;
    try {
      updated = await casItemStatus(itemId, fromStatus, targetStatus, user.userId);
    } catch (err) {
      if (handleTransitionError(res, err)) return;
      throw err;
    }
    if (!updated) {
      // Race lost — surface the spec's literal message verbatim.
      return res.status(409).json({
        error: 'This medication has just been checked out. Please refresh and select another unit.',
        conflict: 'concurrent_checkout',
      });
    }

    // 7) Insert cart_items row.
    const { error: ciErr } = await supabaseServer
      .from('cart_items')
      .insert({ cart_id: cartId, item_id: itemId, added_at: new Date().toISOString() });
    if (ciErr) {
      // Best-effort rollback: revert the item to whatever we came from.
      await supabaseServer
        .from('items')
        .update({ status: fromStatus })
        .eq('id', itemId)
        .eq('status', targetStatus);
      throw new Error(`Failed to add cart_item row: ${ciErr.message}`);
    }

    // 8) Touch cart.expires_at = now() + 24h. If restricted user is adding the
    //    first item to their cart we leave status alone (still 'active' until
    //    the explicit submit call); superadmin carts remain 'active' too.
    await supabaseServer
      .from('carts')
      .update({ expires_at: newExpiry() })
      .eq('id', cartId);

    // 9) Log transaction.
    const action: TransactionAction = item.status === 'expired'
      ? 'expired_override'
      : 'edit';
    await logTransaction({
      itemId,
      action,
      actorId: user.userId,
      oldValue: { status: fromStatus },
      newValue: { status: targetStatus },
      reason: item.status === 'expired' ? 'expired_override_add' : 'cart_add',
      note: item.status === 'expired' ? (overrideNote ?? null) : null,
    });

    res.status(201).json({
      cart_id: cartId,
      item_id: itemId,
      status: targetStatus,
      added_at: new Date().toISOString(),
      ...(item.status === 'expired' ? { override_note: overrideNote } : {}),
    });
  } catch (err: any) {
    if (handleTransitionError(res, err)) return;
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /carts/:id/items/:item_id
 * Remove an item from a cart, returning the unit to `active`.
 */
router.delete('/:id/items/:item_id', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { id: cartId, item_id: itemId } = req.params;

    const cart = await getCart(cartId);
    if (!cart) return res.status(404).json({ error: 'Cart not found' });
    if (!isSuperadmin(user) && cart.owner_id !== user.userId) {
      return res.status(403).json({ error: 'You do not own this cart' });
    }

    const item = await getItem(itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.status !== 'in_cart' && item.status !== 'pending_approval') {
      return res.status(409).json({
        error: `Item is in status ${item.status}; cannot remove from cart`,
      });
    }

    // Flip back to active.
    let updated;
    try {
      updated = await casItemStatus(itemId, item.status as ItemStatus, 'active', user.userId);
    } catch (err) {
      if (handleTransitionError(res, err)) return;
      throw err;
    }
    if (!updated) {
      return res.status(409).json({ error: 'Item status changed concurrently; please retry' });
    }

    const { error: delErr } = await supabaseServer
      .from('cart_items')
      .delete()
      .eq('cart_id', cartId)
      .eq('item_id', itemId);
    if (delErr) throw new Error(`Failed to delete cart_item: ${delErr.message}`);

    await logTransaction({
      itemId,
      action: 'edit',
      actorId: user.userId,
      oldValue: { status: item.status },
      newValue: { status: 'active' },
      reason: 'cart_remove',
    });

    res.json({ cart_id: cartId, item_id: itemId, status: 'active' });
  } catch (err: any) {
    if (handleTransitionError(res, err)) return;
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /carts/:id/submit
 * Restricted user submits cart for superadmin review.
 * Sets cart.status='pending_approval', submitted_at=now().
 */
router.post('/:id/submit', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const cart = await getCart(req.params.id);
    if (!cart) return res.status(404).json({ error: 'Cart not found' });
    if (cart.owner_id !== user.userId) {
      return res.status(403).json({ error: 'Only the cart owner can submit it' });
    }
    if (cart.status !== 'active') {
      return res.status(409).json({ error: `Cart is ${cart.status}, not active` });
    }

    const items = await getCartItems(cart.id);
    if (items.length === 0) {
      return res.status(400).json({ error: 'Cannot submit an empty cart' });
    }

    const { data, error } = await supabaseServer
      .from('carts')
      .update({
        status: 'pending_approval',
        submitted_at: new Date().toISOString(),
        expires_at: newExpiry(),
      })
      .eq('id', cart.id)
      .eq('status', 'active')
      .select('*')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(409).json({ error: 'Cart state changed concurrently' });

    // TODO: notify superadmins (push notification / email) once the
    // notification service exposes a publish endpoint. For now this is a
    // placeholder so the orchestrator can wire it later.

    res.json({
      id: data.id,
      status: data.status,
      submitted_at: data.submitted_at,
      expires_at: data.expires_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /carts/:id/approve
 * Superadmin approves a (pending or active) cart. Every cart_item transitions
 * to `checked_out`. Two transaction rows are written per item: a
 * `cart_approved` log and the `check_out` log itself.
 */
router.post('/:id/approve', requireAuth, requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const cart = await getCart(req.params.id);
    if (!cart) return res.status(404).json({ error: 'Cart not found' });
    if (cart.status !== 'active' && cart.status !== 'pending_approval') {
      return res.status(409).json({ error: `Cart is ${cart.status}; cannot approve` });
    }

    const cartItems = await getCartItems(cart.id);
    if (cartItems.length === 0) {
      return res.status(400).json({ error: 'Cart has no items to approve' });
    }

    const updatedItems: any[] = [];
    for (const ci of cartItems) {
      const fromStatus = ci.item.status as ItemStatus;
      if (fromStatus !== 'in_cart' && fromStatus !== 'pending_approval') {
        // Skip — item is no longer reservable. Caller can re-fetch cart.
        continue;
      }
      let flipped;
      try {
        flipped = await casItemStatus(ci.item_id, fromStatus, 'checked_out', user.userId);
      } catch (err) {
        if (handleTransitionError(res, err)) return;
        throw err;
      }
      if (!flipped) {
        return res.status(409).json({
          error: 'Item status changed concurrently during approval; please re-fetch',
          item_id: ci.item_id,
        });
      }
      await logTransaction({
        itemId: ci.item_id,
        action: 'cart_approved',
        actorId: user.userId,
        oldValue: { status: fromStatus },
        newValue: { status: 'checked_out' },
        reason: 'cart_approved',
      });
      await logTransaction({
        itemId: ci.item_id,
        action: 'check_out',
        actorId: user.userId,
        oldValue: { status: fromStatus },
        newValue: { status: 'checked_out' },
        reason: 'checkout_via_cart',
      });
      updatedItems.push(flipped);
    }

    const { data: updatedCart, error } = await supabaseServer
      .from('carts')
      .update({
        status: 'approved',
        decided_at: new Date().toISOString(),
        decided_by: user.userId,
      })
      .eq('id', cart.id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);

    res.json({
      cart: updatedCart,
      items: updatedItems,
      count: updatedItems.length,
    });
  } catch (err: any) {
    if (handleTransitionError(res, err)) return;
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /carts/:id/reject
 * Superadmin rejects a pending cart. Every cart_item's item is returned to
 * `active`. A `cart_rejected` transaction is logged per item.
 */
router.post('/:id/reject', requireAuth, requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const reason: string | undefined = req.body?.reason;
    const cart = await getCart(req.params.id);
    if (!cart) return res.status(404).json({ error: 'Cart not found' });
    if (cart.status !== 'active' && cart.status !== 'pending_approval') {
      return res.status(409).json({ error: `Cart is ${cart.status}; cannot reject` });
    }

    const cartItems = await getCartItems(cart.id);
    for (const ci of cartItems) {
      const fromStatus = ci.item.status as ItemStatus;
      if (fromStatus !== 'in_cart' && fromStatus !== 'pending_approval') continue;
      try {
        await casItemStatus(ci.item_id, fromStatus, 'active', user.userId);
      } catch (err) {
        if (handleTransitionError(res, err)) return;
        throw err;
      }
      await logTransaction({
        itemId: ci.item_id,
        action: 'cart_rejected',
        actorId: user.userId,
        oldValue: { status: fromStatus },
        newValue: { status: 'active' },
        reason: reason ?? 'cart_rejected',
      });
    }

    const { data: updatedCart, error } = await supabaseServer
      .from('carts')
      .update({
        status: 'rejected',
        decided_at: new Date().toISOString(),
        decided_by: user.userId,
      })
      .eq('id', cart.id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);

    res.json({ cart: updatedCart, reason: reason ?? null });
  } catch (err: any) {
    if (handleTransitionError(res, err)) return;
    res.status(500).json({ error: err.message });
  }
});

/**
 * Expire stale carts. Designed to be called by pg_cron or a node cron; the
 * route is here as a stop-gap so the orchestrator can wire the scheduler.
 *
 * Behavior:
 *   1. Select all carts with status IN ('active','pending_approval')
 *      AND expires_at < now().
 *   2. For each cart, return every reserved item to `active`.
 *   3. Log a transaction (action='edit', reason='cart_expired') per item.
 *   4. Mark cart.status='expired'.
 */
export async function expireOldCarts(): Promise<{
  expiredCarts: number;
  releasedItems: number;
}> {
  const now = new Date().toISOString();
  const { data: staleCarts, error } = await supabaseServer
    .from('carts')
    .select('*, cart_items(*, item:items(*))')
    .in('status', ['active', 'pending_approval'])
    .lt('expires_at', now);
  if (error) throw new Error(`Failed to find stale carts: ${error.message}`);

  let releasedItems = 0;
  for (const cart of staleCarts || []) {
    for (const ci of (cart.cart_items as any[]) || []) {
      const fromStatus = ci.item?.status as ItemStatus | undefined;
      if (fromStatus !== 'in_cart' && fromStatus !== 'pending_approval') continue;
      try {
        const flipped = await casItemStatus(ci.item_id, fromStatus, 'active', null);
        if (flipped) {
          releasedItems += 1;
          await logTransaction({
            itemId: ci.item_id,
            action: 'edit',
            actorId: null,
            oldValue: { status: fromStatus },
            newValue: { status: 'active' },
            reason: 'cart_expired',
          });
        }
      } catch (err) {
        // Invalid transitions on already-final items are ignored — we want
        // expiry to be idempotent and resilient.
        if (!(err instanceof InvalidStatusTransitionError)) throw err;
      }
    }
    await supabaseServer
      .from('carts')
      .update({ status: 'expired' })
      .eq('id', cart.id)
      .in('status', ['active', 'pending_approval']);
  }

  return {
    expiredCarts: (staleCarts || []).length,
    releasedItems,
  };
}

/**
 * POST /carts/expire-stale
 * Trigger the expiry sweep. Until pg_cron is wired up, the orchestrator (or a
 * node cron) calls this endpoint every ~5 minutes per the architecture ADR §7.
 */
router.post('/expire-stale', requireAuth, requireRole('superadmin'), async (_req: Request, res: Response) => {
  try {
    const result = await expireOldCarts();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

// Test-only exports. Production code should import the router only.
export const __testing = {
  expireOldCarts,
  casItemStatus,
  logTransaction,
};
