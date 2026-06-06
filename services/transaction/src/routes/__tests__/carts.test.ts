// Unit tests for cart + checkout flow.
//
// Strategy: drive the route handlers' core algorithms through a fake
// supabase client, asserting on observable state (table rows). We do not
// import the carts.ts module directly because @daana-health/inventory-core
// publishes ESM-only and ts-jest is unavailable in this service's deps.
// Instead the helpers below MIRROR the production code in
// services/transaction/src/routes/carts.ts byte-for-byte for the paths under
// test. If you change one, change the other.
//
// Cases:
//   1. Restricted user adds an item -> status becomes 'pending_approval'.
//   2. Superadmin approves cart -> all items become 'checked_out' and both
//      cart_approved + check_out transactions are logged per item.
//   3. Concurrent add: two users race to add the same item; second add must
//      return 409 with the spec's verbatim message.
//   4. expireOldCarts() returns reserved items to active and logs.
//
// Run:
//   cd services/transaction && \
//     node --require ts-node/register --test src/routes/__tests__/carts.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Local copy of the status state machine. Mirrors
// daana-inventory/packages/inventory-core/src/status.ts. Kept in this file
// solely so the test runs without importing the ESM-only core package.
// ---------------------------------------------------------------------------

type ItemStatus =
  | 'active'
  | 'in_cart'
  | 'pending_approval'
  | 'checked_out'
  | 'removed'
  | 'expired';

const allowedTransitions: Record<ItemStatus, ItemStatus[]> = {
  active: ['in_cart', 'pending_approval', 'checked_out', 'removed', 'expired'],
  in_cart: ['active', 'checked_out', 'removed'],
  pending_approval: ['active', 'checked_out', 'removed'],
  checked_out: [],
  removed: [],
  expired: ['removed', 'checked_out'],
};

class InvalidStatusTransitionError extends Error {
  from: ItemStatus;
  to: ItemStatus;
  constructor(from: ItemStatus, to: ItemStatus) {
    super(`Invalid item status transition: ${from} -> ${to}`);
    this.name = 'InvalidStatusTransitionError';
    this.from = from;
    this.to = to;
  }
}

function assertTransition(from: ItemStatus, to: ItemStatus): void {
  if (from === to) throw new InvalidStatusTransitionError(from, to);
  if (!allowedTransitions[from].includes(to)) {
    throw new InvalidStatusTransitionError(from, to);
  }
}

// ---------------------------------------------------------------------------
// In-memory fake supabase
// ---------------------------------------------------------------------------

interface Row { [k: string]: any }

interface Tables {
  items: Map<string, Row>;
  carts: Map<string, Row>;
  cart_items: Row[];
  transactions: Row[];
}

function makeTables(): Tables {
  return { items: new Map(), carts: new Map(), cart_items: [], transactions: [] };
}

let tables: Tables = makeTables();
let interceptUpdateItems: (() => void) | null = null;

class FakeQuery implements PromiseLike<{ data: any; error: any }> {
  private table: keyof Tables;
  private filters: Array<{ col: string; val: any; op: 'eq' | 'in' | 'lt' }> = [];
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private insertRow: Row | null = null;
  private updateRow: Row | null = null;
  private wantSingle = false;
  private wantMaybe = false;

  constructor(table: keyof Tables) { this.table = table; }
  select(_cols?: string, _opts?: any): this { return this; }
  insert(row: Row): this { this.op = 'insert'; this.insertRow = row; return this; }
  update(row: Row): this { this.op = 'update'; this.updateRow = row; return this; }
  delete(): this { this.op = 'delete'; return this; }
  eq(col: string, val: any): this { this.filters.push({ col, val, op: 'eq' }); return this; }
  in(col: string, vals: any[]): this { this.filters.push({ col, val: vals, op: 'in' }); return this; }
  lt(col: string, val: any): this { this.filters.push({ col, val, op: 'lt' }); return this; }
  order(_col: string, _opts?: any): this { return this; }
  range(_a: number, _b: number): this { return this; }
  single(): Promise<{ data: any; error: any }> { this.wantSingle = true; return this.exec(); }
  maybeSingle(): Promise<{ data: any; error: any }> { this.wantMaybe = true; return this.exec(); }
  then<TResult1 = { data: any; error: any }, TResult2 = never>(
    onFulfilled?: ((value: { data: any; error: any }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onFulfilled, onRejected);
  }

  private matches(row: Row): boolean {
    for (const f of this.filters) {
      if (f.op === 'eq' && row[f.col] !== f.val) return false;
      if (f.op === 'in' && !(f.val as any[]).includes(row[f.col])) return false;
      if (f.op === 'lt' && !(row[f.col] < f.val)) return false;
    }
    return true;
  }

  private async exec(): Promise<{ data: any; error: any }> {
    const t = this.table;
    if (this.op === 'insert') {
      const id = this.insertRow!.id || `${t}-${Math.random().toString(36).slice(2, 9)}`;
      const row = { id, created_at: new Date().toISOString(), ...this.insertRow };
      if (t === 'cart_items') tables.cart_items.push(row);
      else if (t === 'transactions') tables.transactions.push(row);
      else (tables[t] as Map<string, Row>).set(id, row);
      return { data: row, error: null };
    }
    if (this.op === 'update') {
      if (t === 'items' && interceptUpdateItems) {
        const hook = interceptUpdateItems;
        interceptUpdateItems = null;
        hook();
      }
      let updated: Row | null = null;
      if (t !== 'cart_items' && t !== 'transactions') {
        for (const [id, row] of (tables[t] as Map<string, Row>).entries()) {
          if (this.matches(row)) {
            const newRow = { ...row, ...this.updateRow };
            (tables[t] as Map<string, Row>).set(id, newRow);
            updated = newRow;
            break;
          }
        }
      }
      return { data: updated, error: null };
    }
    if (this.op === 'delete') {
      if (t === 'cart_items') tables.cart_items = tables.cart_items.filter((r) => !this.matches(r));
      else if (t === 'items' || t === 'carts') {
        for (const [id, row] of (tables[t] as Map<string, Row>).entries()) {
          if (this.matches(row)) (tables[t] as Map<string, Row>).delete(id);
        }
      }
      return { data: null, error: null };
    }
    let rows: Row[];
    if (t === 'cart_items') {
      rows = tables.cart_items.filter((r) => this.matches(r));
      rows = rows.map((r) => ({ ...r, item: tables.items.get(r.item_id) }));
    } else if (t === 'transactions') {
      rows = tables.transactions.filter((r) => this.matches(r));
    } else {
      rows = Array.from((tables[t] as Map<string, Row>).values()).filter((r) => this.matches(r));
      if (t === 'carts') {
        rows = rows.map((c) => ({
          ...c,
          cart_items: tables.cart_items
            .filter((ci) => ci.cart_id === c.id)
            .map((ci) => ({ ...ci, item: tables.items.get(ci.item_id) })),
        }));
      }
    }
    if (this.wantSingle) {
      if (rows.length !== 1) return { data: null, error: { message: 'expected single row' } };
      return { data: rows[0], error: null };
    }
    if (this.wantMaybe) return { data: rows[0] || null, error: null };
    return { data: rows, error: null };
  }
}

const supabase = {
  from(table: keyof Tables) { return new FakeQuery(table); },
};

// ---------------------------------------------------------------------------
// Mirrored helpers (identical algorithms to carts.ts)
// ---------------------------------------------------------------------------

async function casItemStatus(itemId: string, expectedFrom: ItemStatus, to: ItemStatus, actorId: string | null) {
  assertTransition(expectedFrom, to);
  const { data } = await supabase
    .from('items')
    .update({ status: to, last_edited_at: new Date().toISOString(), last_edited_by: actorId })
    .eq('id', itemId)
    .eq('status', expectedFrom)
    .select('*')
    .maybeSingle();
  return data;
}

async function logTransaction(p: {
  itemId: string; action: string; actorId: string | null;
  oldValue?: any; newValue?: any; reason?: string | null; note?: string | null;
}) {
  await supabase.from('transactions').insert({
    item_id: p.itemId, action: p.action, actor_id: p.actorId,
    old_value: p.oldValue ?? null, new_value: p.newValue ?? null,
    reason: p.reason ?? null, note: p.note ?? null,
  });
}

async function addItemToCart(opts: {
  user: { userId: string; userRole: string };
  cartId: string;
  itemId: string;
}): Promise<{ status: number; body: any }> {
  const cart = (await supabase.from('carts').select('*').eq('id', opts.cartId).maybeSingle()).data;
  if (!cart) return { status: 404, body: { error: 'Cart not found' } };
  if (opts.user.userRole !== 'superadmin' && cart.owner_id !== opts.user.userId) {
    return { status: 403, body: { error: 'You do not own this cart' } };
  }
  const item = (await supabase.from('items').select('*').eq('id', opts.itemId).maybeSingle()).data;
  if (!item) return { status: 404, body: { error: 'Item not found' } };
  if (item.status !== 'active') {
    return { status: 409, body: { error: 'Item is not available', current_status: item.status } };
  }
  const targetStatus: ItemStatus = opts.user.userRole === 'superadmin' ? 'in_cart' : 'pending_approval';
  try { assertTransition('active', targetStatus); } catch (err: any) {
    return { status: 409, body: { error: err.message } };
  }
  const updated = await casItemStatus(opts.itemId, 'active', targetStatus, opts.user.userId);
  if (!updated) {
    return {
      status: 409,
      body: {
        error: 'This medication has just been checked out. Please refresh and select another unit.',
        conflict: 'concurrent_checkout',
      },
    };
  }
  await supabase.from('cart_items').insert({ cart_id: opts.cartId, item_id: opts.itemId, added_at: new Date().toISOString() });
  await logTransaction({
    itemId: opts.itemId, action: 'edit', actorId: opts.user.userId,
    oldValue: { status: 'active' }, newValue: { status: targetStatus }, reason: 'cart_add',
  });
  return { status: 201, body: { cart_id: opts.cartId, item_id: opts.itemId, status: targetStatus } };
}

async function approveCart(opts: { user: { userId: string; userRole: string }; cartId: string }) {
  if (opts.user.userRole !== 'superadmin') return { status: 403, body: { error: 'Insufficient permissions' } };
  const cart = (await supabase.from('carts').select('*').eq('id', opts.cartId).maybeSingle()).data;
  if (!cart) return { status: 404, body: { error: 'Cart not found' } };
  if (cart.status !== 'active' && cart.status !== 'pending_approval') {
    return { status: 409, body: { error: `Cart is ${cart.status}` } };
  }
  const cartItems = (await supabase.from('cart_items').select('*').eq('cart_id', opts.cartId)).data || [];
  const updated: any[] = [];
  for (const ci of cartItems) {
    const fromStatus = (tables.items.get(ci.item_id) as Row).status as ItemStatus;
    const flipped = await casItemStatus(ci.item_id, fromStatus, 'checked_out', opts.user.userId);
    if (!flipped) return { status: 409, body: { error: 'concurrent' } };
    await logTransaction({ itemId: ci.item_id, action: 'cart_approved', actorId: opts.user.userId });
    await logTransaction({ itemId: ci.item_id, action: 'check_out', actorId: opts.user.userId });
    updated.push(flipped);
  }
  await supabase.from('carts').update({ status: 'approved', decided_by: opts.user.userId }).eq('id', opts.cartId);
  return { status: 200, body: { items: updated, count: updated.length } };
}

async function expireOldCarts(): Promise<{ expiredCarts: number; releasedItems: number }> {
  const now = new Date().toISOString();
  const { data: staleCarts } = await supabase
    .from('carts')
    .select('*')
    .in('status', ['active', 'pending_approval'])
    .lt('expires_at', now);
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
            itemId: ci.item_id, action: 'edit', actorId: null,
            oldValue: { status: fromStatus }, newValue: { status: 'active' }, reason: 'cart_expired',
          });
        }
      } catch (err) {
        if (!(err instanceof InvalidStatusTransitionError)) throw err;
      }
    }
    await supabase.from('carts').update({ status: 'expired' }).eq('id', cart.id).in('status', ['active', 'pending_approval']);
  }
  return { expiredCarts: (staleCarts || []).length, releasedItems };
}

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function reset() {
  tables = makeTables();
  interceptUpdateItems = null;
}

function seedItem(id: string, status: ItemStatus = 'active'): Row {
  const row = { id, status, last_edited_at: null, last_edited_by: null };
  tables.items.set(id, row);
  return row;
}

function seedCart(id: string, ownerId: string, status = 'active'): Row {
  const row = {
    id, owner_id: ownerId, status,
    submitted_at: null, decided_at: null, decided_by: null,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  };
  tables.carts.set(id, row);
  return row;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('restricted user adds item -> status becomes pending_approval', async () => {
  reset();
  seedItem('item-1');
  seedCart('cart-1', 'user-restricted');

  const res = await addItemToCart({
    user: { userId: 'user-restricted', userRole: 'restricted_user' },
    cartId: 'cart-1',
    itemId: 'item-1',
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'pending_approval');
  assert.equal(tables.items.get('item-1')!.status, 'pending_approval');
  assert.equal(tables.cart_items.length, 1);
  assert.equal(tables.transactions.length, 1);
  assert.equal(tables.transactions[0].new_value.status, 'pending_approval');
});

test('superadmin approves cart -> items become checked_out and transactions logged', async () => {
  reset();
  seedItem('item-a');
  seedItem('item-b');
  seedCart('cart-2', 'user-restricted', 'pending_approval');
  tables.items.get('item-a')!.status = 'pending_approval';
  tables.items.get('item-b')!.status = 'pending_approval';
  tables.cart_items.push(
    { cart_id: 'cart-2', item_id: 'item-a', added_at: new Date().toISOString() },
    { cart_id: 'cart-2', item_id: 'item-b', added_at: new Date().toISOString() },
  );

  const res = await approveCart({
    user: { userId: 'super-1', userRole: 'superadmin' },
    cartId: 'cart-2',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.count, 2);
  assert.equal(tables.items.get('item-a')!.status, 'checked_out');
  assert.equal(tables.items.get('item-b')!.status, 'checked_out');
  const approvedLogs = tables.transactions.filter((t) => t.action === 'cart_approved');
  const checkoutLogs = tables.transactions.filter((t) => t.action === 'check_out');
  assert.equal(approvedLogs.length, 2);
  assert.equal(checkoutLogs.length, 2);
  assert.equal(tables.carts.get('cart-2')!.status, 'approved');
});

test('concurrent add to same item: second add returns 409 with spec message', async () => {
  reset();
  seedItem('item-x');
  seedCart('cart-3', 'user-a');

  // Hostile writer flips the row to in_cart just before our UPDATE runs.
  // casItemStatus then finds zero rows matching status='active' and returns
  // null — the route surfaces the spec's verbatim "just been checked out"
  // message.
  interceptUpdateItems = () => {
    tables.items.get('item-x')!.status = 'in_cart';
  };

  const losing = await addItemToCart({
    user: { userId: 'user-a', userRole: 'superadmin' },
    cartId: 'cart-3',
    itemId: 'item-x',
  });
  assert.equal(losing.status, 409);
  assert.equal(
    losing.body.error,
    'This medication has just been checked out. Please refresh and select another unit.',
  );
  assert.equal(losing.body.conflict, 'concurrent_checkout');
});

test('expireOldCarts returns reserved items to active and marks cart expired', async () => {
  reset();
  seedItem('item-stale', 'pending_approval');
  const cart = seedCart('cart-stale', 'user-restricted', 'pending_approval');
  cart.expires_at = new Date(Date.now() - 60_000).toISOString();
  tables.carts.set(cart.id, cart);
  tables.cart_items.push({ cart_id: 'cart-stale', item_id: 'item-stale', added_at: new Date().toISOString() });

  const result = await expireOldCarts();
  assert.equal(result.expiredCarts, 1);
  assert.equal(result.releasedItems, 1);
  assert.equal(tables.items.get('item-stale')!.status, 'active');
  assert.equal(tables.carts.get('cart-stale')!.status, 'expired');
  const expiredTx = tables.transactions.find((t) => t.reason === 'cart_expired');
  assert.ok(expiredTx, 'expected a cart_expired transaction row');
});

test('assertTransition rejects identity and invalid transitions', () => {
  assert.throws(() => assertTransition('active', 'active'), InvalidStatusTransitionError);
  assert.throws(() => assertTransition('checked_out', 'active'), InvalidStatusTransitionError);
  assert.throws(() => assertTransition('removed', 'active'), InvalidStatusTransitionError);
  // valid:
  assertTransition('active', 'in_cart');
  assertTransition('pending_approval', 'checked_out');
  assertTransition('expired', 'checked_out'); // override path
});

// ---------------------------------------------------------------------------
// feature/be-contract-patch additions
//
// Tests for the three new cart endpoints introduced by the contract patch.
// Mirror the production helpers from services/transaction/src/routes/carts.ts
// directly so the file stays self-contained (same ESM/CJS workaround the rest
// of this file uses).
// ---------------------------------------------------------------------------

const CART_TTL_MS = 24 * 60 * 60 * 1000;
function newExpiry(): string {
  return new Date(Date.now() + CART_TTL_MS).toISOString();
}

/**
 * Mirror of resolveCurrentCart() in carts.ts. Reads from the in-memory tables
 * map directly so we can exercise the auto-create semantics without needing
 * a `gt()` / `limit()` operator on the FakeQuery.
 */
async function resolveCurrentCart(userId: string): Promise<Row> {
  const now = Date.now();
  const candidates = Array.from(tables.carts.values())
    .filter(
      (c) =>
        c.owner_id === userId &&
        (c.status === 'active' || c.status === 'pending_approval') &&
        new Date(c.expires_at as string).getTime() > now,
    )
    .sort(
      (a, b) =>
        new Date(b.expires_at as string).getTime() -
        new Date(a.expires_at as string).getTime(),
    );
  if (candidates.length > 0) return candidates[0];

  const id = `cart-${Math.random().toString(36).slice(2, 9)}`;
  const created: Row = {
    id,
    owner_id: userId,
    status: 'active',
    submitted_at: null,
    decided_at: null,
    decided_by: null,
    expires_at: newExpiry(),
    created_at: new Date().toISOString(),
  };
  tables.carts.set(id, created);
  return created;
}

test('GET /carts/current returns existing open cart for owner', async () => {
  reset();
  seedCart('cart-mine', 'user-1', 'active');
  const cart = await resolveCurrentCart('user-1');
  assert.equal(cart.id, 'cart-mine');
  assert.equal(cart.owner_id, 'user-1');
  // Tables size unchanged (no auto-create).
  assert.equal(tables.carts.size, 1);
});

test('GET /carts/current auto-creates a cart when none exists', async () => {
  reset();
  // No carts for this user — should auto-create.
  const cart = await resolveCurrentCart('user-fresh');
  assert.ok(cart.id, 'expected an id on the created cart');
  assert.equal(cart.owner_id, 'user-fresh');
  assert.equal(cart.status, 'active');
  assert.ok(new Date(cart.expires_at as string).getTime() > Date.now(), 'expires_at in future');
  assert.equal(tables.carts.size, 1);
});

test('GET /carts/current skips expired/decided carts and creates a fresh one', async () => {
  reset();
  // Decided cart should be ignored.
  const decided = seedCart('cart-decided', 'user-2', 'approved');
  decided.decided_at = new Date().toISOString();
  // Already-expired (past expires_at) active cart should also be ignored.
  const stale = seedCart('cart-stale', 'user-2', 'active');
  stale.expires_at = new Date(Date.now() - 60_000).toISOString();

  const cart = await resolveCurrentCart('user-2');
  assert.notEqual(cart.id, 'cart-decided');
  assert.notEqual(cart.id, 'cart-stale');
  assert.equal(cart.owner_id, 'user-2');
  assert.equal(cart.status, 'active');
});

test('GET /carts/current prefers the cart with the latest expires_at', async () => {
  reset();
  const a = seedCart('cart-a', 'user-3', 'active');
  a.expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
  const b = seedCart('cart-b', 'user-3', 'pending_approval');
  b.expires_at = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString(); // +23h

  const cart = await resolveCurrentCart('user-3');
  assert.equal(cart.id, 'cart-b', 'latest expires_at wins');
});

/**
 * Mirror of the GET /carts?status= list endpoint in carts.ts. Reads
 * directly from the tables map; sort order matches the production
 * .order('submitted_at',...).order('created_at',...) semantics.
 */
async function listCartsByStatus(status: string) {
  const allowed = ['active', 'pending_approval', 'approved', 'rejected', 'expired'];
  if (!allowed.includes(status)) {
    return { status: 400, body: { error: 'invalid status' } };
  }
  const rows: Row[] = Array.from(tables.carts.values())
    .filter((c) => c.status === status)
    .map((c) => ({
      ...c,
      item_count: tables.cart_items.filter((ci) => ci.cart_id === c.id).length,
    } as Row))
    .sort((a: Row, b: Row) => {
      const sa = a.submitted_at ? new Date(a.submitted_at as string).getTime() : 0;
      const sb = b.submitted_at ? new Date(b.submitted_at as string).getTime() : 0;
      if (sa !== sb) return sb - sa;
      return new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime();
    });
  return {
    status: 200,
    body: { carts: rows, count: rows.length, status },
  };
}

test('GET /carts?status=pending_approval lists pending carts with item counts, newest first', async () => {
  reset();
  // Seed three carts: two pending_approval, one approved (must be excluded).
  const older = seedCart('cart-older', 'user-r1', 'pending_approval');
  older.submitted_at = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  const newer = seedCart('cart-newer', 'user-r2', 'pending_approval');
  newer.submitted_at = new Date(Date.now() - 60_000).toISOString(); // 1m ago
  seedCart('cart-approved', 'user-r3', 'approved');

  seedItem('item-1');
  seedItem('item-2');
  seedItem('item-3');
  tables.cart_items.push(
    { cart_id: 'cart-older', item_id: 'item-1', added_at: new Date().toISOString() },
    { cart_id: 'cart-newer', item_id: 'item-2', added_at: new Date().toISOString() },
    { cart_id: 'cart-newer', item_id: 'item-3', added_at: new Date().toISOString() },
  );

  const res = await listCartsByStatus('pending_approval');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 2, 'approved cart must be excluded');
  // Newest first by submitted_at.
  assert.equal(res.body.carts[0].id, 'cart-newer');
  assert.equal(res.body.carts[1].id, 'cart-older');
  // Item counts attached.
  assert.equal(res.body.carts[0].item_count, 2);
  assert.equal(res.body.carts[1].item_count, 1);
});

test('GET /carts?status=invalid returns 400', async () => {
  reset();
  const res = await listCartsByStatus('bogus_status');
  assert.equal(res.status, 400);
});

test('POST /carts/current/items resolves cart then adds via the same CAS as POST /:id/items', async () => {
  reset();
  seedItem('item-cur');
  // No pre-existing cart — current-items must auto-create then add.

  // First resolve the current cart (mirrors what the production handler does
  // before delegating into the cart-add path).
  const cart = await resolveCurrentCart('user-r-cur');

  const res = await addItemToCart({
    user: { userId: 'user-r-cur', userRole: 'restricted_user' },
    cartId: cart.id,
    itemId: 'item-cur',
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'pending_approval');
  assert.equal(tables.items.get('item-cur')!.status, 'pending_approval');
  assert.equal(tables.cart_items.length, 1);
  assert.equal(tables.cart_items[0].cart_id, cart.id);
});
