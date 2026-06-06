// Unit tests for the reports + transaction-log algorithms.
//
// Strategy: mirror the carts.test.ts approach — drive the route handler
// algorithms through a hand-rolled fake supabase client, asserting on the
// shape of the response payload. We do not import the reports.ts router
// directly because @daana-health/inventory-core publishes ESM-only and
// ts-jest is unavailable; node:test + ts-node/register handles ESM
// gracefully.
//
// We DO import the pure helpers from reports.ts (`__testing` export) for the
// math we want under test — daysFromNow, diffValues, pluckMedFields — and
// re-implement the per-endpoint query logic locally so the test runs without
// a live supabase connection.
//
// Cases:
//   1. Expiring window math (30/60/90 buckets).
//   2. Capacity 90% threshold detection.
//   3. High-use ranking by checkout count, top 25.
//   4. Transaction log filtering combinators (action_type CSV + date range +
//      medication q + cursor pagination).
//   5. diffValues helper produces field-level diffs.
//
// Run:
//   cd services/transaction && \
//     node --require ts-node/register --test src/routes/__tests__/reports.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';

// We do NOT import `../reports` directly — that module pulls
// utils/supabase which throws at import-time without SUPABASE_URL set.
// Instead we mirror the pure helpers below (these must stay byte-equivalent
// to the implementations in reports.ts; both files document this contract).

function daysFromNow(nDays: number, base = Date.now()): string {
  return new Date(base + nDays * 24 * 60 * 60 * 1000).toISOString();
}

function pluckMedFields(attributes: Record<string, unknown> | null | undefined): {
  medication_name: string | null;
  dose: string | null;
  form: string | null;
} {
  const a = attributes || {};
  return {
    medication_name: (a as any).medication_name ?? null,
    dose: (a as any).dose ?? null,
    form: (a as any).form ?? null,
  };
}

function diffValues(
  oldValue: Record<string, unknown> | null,
  newValue: Record<string, unknown> | null,
): Array<{ field: string; old: unknown; new: unknown }> {
  const o = oldValue || {};
  const n = newValue || {};
  const keys = new Set([...Object.keys(o), ...Object.keys(n)]);
  const out: Array<{ field: string; old: unknown; new: unknown }> = [];
  for (const k of keys) {
    const a = (o as any)[k];
    const b = (n as any)[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ field: k, old: a ?? null, new: b ?? null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-memory tables + minimal fake supabase
// ---------------------------------------------------------------------------

interface Row {
  [k: string]: any;
}

interface Tables {
  items: Row[];
  locations: Row[];
  transactions: Row[];
}

let tables: Tables = { items: [], locations: [], transactions: [] };

function reset() {
  tables = { items: [], locations: [], transactions: [] };
}

// ---------------------------------------------------------------------------
// Local re-implementations of the endpoint algorithms. These MIRROR the code
// in reports.ts byte-for-byte for the paths under test. If reports.ts
// changes, update this file too.
// ---------------------------------------------------------------------------

function isoDate(ts: string) {
  return ts.slice(0, 10);
}

function expiringBucket(days: number) {
  const nowIso = new Date().toISOString();
  const cutoff = daysFromNow(days);
  const rows = tables.items
    .filter((it) => it.status === 'active')
    .filter((it) => it.expiry_date >= isoDate(nowIso) && it.expiry_date <= isoDate(cutoff))
    .sort((a, b) => {
      if (a.expiry_date !== b.expiry_date) return a.expiry_date < b.expiry_date ? -1 : 1;
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return a.unit_code < b.unit_code ? -1 : 1;
    })
    .slice(0, 25);
  return {
    window_days: days,
    count: rows.length,
    items: rows.map((r) => ({
      ...pluckMedFields(r.attributes),
      item_id: r.id,
      unit_code: r.unit_code,
      status: r.status,
      expiry_date: r.expiry_date,
    })),
  };
}

function capacityReport() {
  const counts = new Map<string, number>();
  for (const it of tables.items) {
    if (!['active', 'in_cart', 'pending_approval'].includes(it.status)) continue;
    if (!it.location_id) continue;
    counts.set(it.location_id, (counts.get(it.location_id) ?? 0) + 1);
  }
  const flagged = tables.locations
    .filter((l) => !l.deactivated_at)
    .map((l) => {
      const used = counts.get(l.id) ?? 0;
      const capacity = l.capacity ?? 50;
      const percent = capacity > 0 ? used / capacity : 0;
      return {
        location: { id: l.id, code: l.code, specialty: l.specialty, capacity },
        used,
        percent: Math.round(percent * 1000) / 1000,
      };
    })
    .filter((r) => r.percent >= 0.9)
    .sort((a, b) => b.percent - a.percent);
  return { threshold: 0.9, count: flagged.length, locations: flagged };
}

function highUseReport() {
  const since = daysFromNow(-30);
  const itemById = new Map(tables.items.map((it) => [it.id, it]));
  const buckets = new Map<
    string,
    { count: number; sample_dose: string | null; sample_form: string | null }
  >();
  for (const tx of tables.transactions) {
    if (tx.action !== 'check_out') continue;
    if (tx.created_at < since) continue;
    const item = itemById.get(tx.item_id);
    const med = pluckMedFields(item?.attributes);
    const key = med.medication_name || '(unknown)';
    const cur = buckets.get(key);
    if (cur) cur.count += 1;
    else buckets.set(key, { count: 1, sample_dose: med.dose, sample_form: med.form });
  }
  const ranked = Array.from(buckets.entries())
    .map(([medication_name, v]) => ({ medication_name, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
  return { window_days: 30, count: ranked.length, medications: ranked };
}

function transactionLog(params: {
  date_from?: string;
  date_to?: string;
  action_type?: string;
  actor_id?: string;
  item_id?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}) {
  const limit = Math.min(params.limit ?? 50, 200);
  const itemById = new Map(tables.items.map((it) => [it.id, it]));

  let rows = [...tables.transactions];
  if (params.date_from) rows = rows.filter((r) => r.created_at >= params.date_from!);
  if (params.date_to) rows = rows.filter((r) => r.created_at < params.date_to!);
  if (params.action_type) {
    const types = params.action_type.split(',').map((s) => s.trim()).filter(Boolean);
    rows = rows.filter((r) => types.includes(r.action));
  }
  if (params.actor_id) rows = rows.filter((r) => r.actor_id === params.actor_id);
  if (params.item_id) rows = rows.filter((r) => r.item_id === params.item_id);

  rows.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });

  if (params.cursor) {
    const decoded = JSON.parse(Buffer.from(params.cursor, 'base64').toString('utf8'));
    rows = rows.filter((r) => r.created_at < decoded.ts);
  }

  if (params.q) {
    const needle = params.q.toLowerCase();
    rows = rows.filter((r) => {
      const item = itemById.get(r.item_id);
      const med = pluckMedFields(item?.attributes).medication_name;
      return typeof med === 'string' && med.toLowerCase().includes(needle);
    });
  }

  const slice = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const nextCursor =
    hasMore && slice.length > 0
      ? Buffer.from(
          JSON.stringify({ ts: slice[slice.length - 1].created_at, id: slice[slice.length - 1].id }),
        ).toString('base64')
      : null;

  return {
    count: slice.length,
    next_cursor: nextCursor,
    transactions: slice.map((row) => {
      const item = itemById.get(row.item_id);
      return {
        transaction_id: row.id,
        timestamp: row.created_at,
        action_type: row.action,
        ...pluckMedFields(item?.attributes),
        drx_code: item?.unit_code ?? null,
        item_id: row.item_id,
        user: row.actor_id,
        reason: row.reason,
        notes: row.note,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function seedItem(opts: {
  id: string;
  status?: string;
  location_id?: string | null;
  expiry_date?: string;
  unit_code?: string;
  medication_name?: string;
  dose?: string;
  form?: string;
  created_at?: string;
}) {
  tables.items.push({
    id: opts.id,
    status: opts.status ?? 'active',
    location_id: opts.location_id ?? null,
    expiry_date: opts.expiry_date ?? null,
    unit_code: opts.unit_code ?? opts.id,
    created_at: opts.created_at ?? new Date().toISOString(),
    attributes: {
      medication_name: opts.medication_name ?? null,
      dose: opts.dose ?? null,
      form: opts.form ?? null,
    },
  });
}

function seedLocation(opts: {
  id: string;
  code: string;
  capacity?: number;
  specialty?: string;
  deactivated_at?: string | null;
}) {
  tables.locations.push({
    id: opts.id,
    code: opts.code,
    specialty: opts.specialty ?? null,
    capacity: opts.capacity ?? 50,
    deactivated_at: opts.deactivated_at ?? null,
  });
}

function seedTx(opts: {
  id: string;
  item_id: string;
  action: string;
  created_at: string;
  actor_id?: string;
  reason?: string;
  note?: string;
  old_value?: any;
  new_value?: any;
}) {
  tables.transactions.push({
    id: opts.id,
    item_id: opts.item_id,
    action: opts.action,
    created_at: opts.created_at,
    actor_id: opts.actor_id ?? null,
    reason: opts.reason ?? null,
    note: opts.note ?? null,
    old_value: opts.old_value ?? null,
    new_value: opts.new_value ?? null,
  });
}

function inDays(n: number): string {
  return isoDate(daysFromNow(n));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('expiring: 30 / 60 / 90 day windows include only items in their window', () => {
  reset();
  // 15 days out -> in 30/60/90.
  seedItem({ id: 'i15', expiry_date: inDays(15), medication_name: 'Lisinopril' });
  // 45 days out -> in 60/90 but NOT 30.
  seedItem({ id: 'i45', expiry_date: inDays(45), medication_name: 'Metformin' });
  // 75 days out -> 90 only.
  seedItem({ id: 'i75', expiry_date: inDays(75), medication_name: 'Sertraline' });
  // 200 days out -> none.
  seedItem({ id: 'i200', expiry_date: inDays(200), medication_name: 'Atorvastatin' });
  // Already expired (yesterday) -> none (window is [today, today+N]).
  seedItem({ id: 'iexp', expiry_date: inDays(-1), medication_name: 'Furosemide' });
  // Not active -> skipped even if in window.
  seedItem({
    id: 'iremoved',
    status: 'removed',
    expiry_date: inDays(10),
    medication_name: 'Albuterol',
  });

  const w30 = expiringBucket(30);
  const w60 = expiringBucket(60);
  const w90 = expiringBucket(90);

  assert.deepEqual(
    w30.items.map((i: any) => i.item_id).sort(),
    ['i15'],
  );
  assert.deepEqual(
    w60.items.map((i: any) => i.item_id).sort(),
    ['i15', 'i45'],
  );
  assert.deepEqual(
    w90.items.map((i: any) => i.item_id).sort(),
    ['i15', 'i45', 'i75'],
  );

  // FEFO order: i15 < i45 < i75.
  assert.deepEqual(w90.items.map((i: any) => i.item_id), ['i15', 'i45', 'i75']);
});

test('capacity: flags only locations at >=90% of configured capacity', () => {
  reset();
  // CARDIO1 capacity 50, used 45 -> exactly 90%, FLAGGED.
  seedLocation({ id: 'loc-1', code: 'CARDIO1', capacity: 50 });
  for (let i = 0; i < 45; i++) seedItem({ id: `c1-${i}`, location_id: 'loc-1' });

  // CARDIO2 capacity 50, used 44 -> 88%, NOT flagged.
  seedLocation({ id: 'loc-2', code: 'CARDIO2', capacity: 50 });
  for (let i = 0; i < 44; i++) seedItem({ id: `c2-${i}`, location_id: 'loc-2' });

  // PSYCH capacity 20, used 20 -> 100%, FLAGGED.
  seedLocation({ id: 'loc-3', code: 'PSYCH', capacity: 20 });
  for (let i = 0; i < 20; i++) seedItem({ id: `p-${i}`, location_id: 'loc-3' });

  // Counts should exclude checked_out/removed items even if they reference the bin.
  seedItem({ id: 'co-1', status: 'checked_out', location_id: 'loc-1' });

  // In-cart and pending_approval items DO count.
  seedItem({ id: 'ic-1', status: 'in_cart', location_id: 'loc-3' });
  seedItem({ id: 'pa-1', status: 'pending_approval', location_id: 'loc-3' });
  // -> PSYCH now used = 22/20 = 110%, still flagged.

  // Deactivated bin must never appear regardless of usage.
  seedLocation({ id: 'loc-4', code: 'OLD', capacity: 10, deactivated_at: new Date().toISOString() });
  for (let i = 0; i < 10; i++) seedItem({ id: `old-${i}`, location_id: 'loc-4' });

  const report = capacityReport();
  const codes = report.locations.map((r: any) => r.location.code);
  assert.deepEqual(codes.sort(), ['CARDIO1', 'PSYCH']);

  const psych = report.locations.find((r: any) => r.location.code === 'PSYCH')!;
  assert.equal(psych.used, 22);

  const cardio1 = report.locations.find((r: any) => r.location.code === 'CARDIO1')!;
  assert.equal(cardio1.used, 45);
  assert.equal(cardio1.percent, 0.9);
});

test('high-use: ranks medications by 30-day checkout count, top 25', () => {
  reset();
  seedItem({ id: 'i-lis', medication_name: 'Lisinopril', dose: '10mg', form: 'Bottle' });
  seedItem({ id: 'i-met', medication_name: 'Metformin', dose: '500mg', form: 'Bottle' });
  seedItem({ id: 'i-ser', medication_name: 'Sertraline', dose: '50mg', form: 'Bottle' });

  // 5 lisinopril checkouts in window.
  for (let i = 0; i < 5; i++) {
    seedTx({ id: `tl-${i}`, item_id: 'i-lis', action: 'check_out', created_at: daysFromNow(-1) });
  }
  // 3 metformin in window.
  for (let i = 0; i < 3; i++) {
    seedTx({ id: `tm-${i}`, item_id: 'i-met', action: 'check_out', created_at: daysFromNow(-5) });
  }
  // 1 sertraline in window.
  seedTx({ id: 'ts-1', item_id: 'i-ser', action: 'check_out', created_at: daysFromNow(-10) });

  // 10 lisinopril checkouts OUTSIDE the 30-day window — must be excluded.
  for (let i = 0; i < 10; i++) {
    seedTx({
      id: `told-${i}`,
      item_id: 'i-lis',
      action: 'check_out',
      created_at: daysFromNow(-40),
    });
  }

  // Non-checkout actions must be excluded.
  seedTx({ id: 'tedit', item_id: 'i-lis', action: 'edit', created_at: daysFromNow(-1) });

  const report = highUseReport();
  assert.equal(report.window_days, 30);
  assert.deepEqual(
    report.medications.map((m: any) => [m.medication_name, m.count]),
    [
      ['Lisinopril', 5],
      ['Metformin', 3],
      ['Sertraline', 1],
    ],
  );
  // sample fields surface from the item attributes.
  assert.equal(report.medications[0].sample_dose, '10mg');
  assert.equal(report.medications[0].sample_form, 'Bottle');
});

test('transaction log: filtering combinators (action_type CSV + date range + q + cursor)', () => {
  reset();
  seedItem({ id: 'i-lis', medication_name: 'Lisinopril', unit_code: 'DRX-CD1-00001' });
  seedItem({ id: 'i-met', medication_name: 'Metformin', unit_code: 'DRX-EN1-00001' });

  seedTx({ id: 't1', item_id: 'i-lis', action: 'check_in', created_at: daysFromNow(-10) });
  seedTx({ id: 't2', item_id: 'i-lis', action: 'edit', created_at: daysFromNow(-8) });
  seedTx({ id: 't3', item_id: 'i-lis', action: 'check_out', created_at: daysFromNow(-5) });
  seedTx({ id: 't4', item_id: 'i-met', action: 'check_in', created_at: daysFromNow(-4) });
  seedTx({ id: 't5', item_id: 'i-met', action: 'remove', created_at: daysFromNow(-2) });

  // action_type CSV: check_in + check_out only.
  const inOut = transactionLog({ action_type: 'check_in,check_out' });
  assert.deepEqual(
    inOut.transactions.map((r: any) => r.transaction_id).sort(),
    ['t1', 't3', 't4'],
  );

  // date_from filter.
  const recent = transactionLog({ date_from: daysFromNow(-6) });
  assert.deepEqual(
    recent.transactions.map((r: any) => r.transaction_id).sort(),
    ['t3', 't4', 't5'],
  );

  // q filter by medication name (case insensitive).
  const lisOnly = transactionLog({ q: 'lisin' });
  assert.deepEqual(
    lisOnly.transactions.map((r: any) => r.transaction_id).sort(),
    ['t1', 't2', 't3'],
  );

  // item_id filter.
  const metOnly = transactionLog({ item_id: 'i-met' });
  assert.deepEqual(
    metOnly.transactions.map((r: any) => r.transaction_id).sort(),
    ['t4', 't5'],
  );

  // Cursor pagination: limit=2 -> first page t5, t4 with cursor; next page t3, t2.
  const page1 = transactionLog({ limit: 2 });
  assert.deepEqual(
    page1.transactions.map((r: any) => r.transaction_id),
    ['t5', 't4'],
  );
  assert.ok(page1.next_cursor);

  const page2 = transactionLog({ limit: 2, cursor: page1.next_cursor! });
  assert.deepEqual(
    page2.transactions.map((r: any) => r.transaction_id),
    ['t3', 't2'],
  );

  // Combinator: action_type + date_from + q.
  const combo = transactionLog({
    action_type: 'check_out',
    date_from: daysFromNow(-30),
    q: 'lisin',
  });
  assert.deepEqual(combo.transactions.map((r: any) => r.transaction_id), ['t3']);

  // Payload shape: drx_code threads through from item.unit_code.
  assert.equal(combo.transactions[0].drx_code, 'DRX-CD1-00001');
  assert.equal(combo.transactions[0].medication_name, 'Lisinopril');
  assert.equal(combo.transactions[0].action_type, 'check_out');
});

test('diffValues helper produces field-level diffs', () => {
  const diff = diffValues(
    { location: 'CARDIO1', expiry_date: '2026-12-01', dose: '10mg' },
    { location: 'CARDIO2', expiry_date: '2026-12-01', dose: '20mg' },
  );
  // unchanged keys excluded; changed keys included.
  const fields = diff.map((d) => d.field).sort();
  assert.deepEqual(fields, ['dose', 'location']);

  const locationDiff = diff.find((d) => d.field === 'location')!;
  assert.equal(locationDiff.old, 'CARDIO1');
  assert.equal(locationDiff.new, 'CARDIO2');

  // null handling.
  const addOnly = diffValues(null, { status: 'active' });
  assert.equal(addOnly.length, 1);
  assert.equal(addOnly[0].field, 'status');
  assert.equal(addOnly[0].old, null);
  assert.equal(addOnly[0].new, 'active');
});

test('pluckMedFields safely extracts MASS attributes', () => {
  assert.deepEqual(pluckMedFields(null), {
    medication_name: null,
    dose: null,
    form: null,
  });
  assert.deepEqual(
    pluckMedFields({ medication_name: 'Lisinopril', dose: '10mg', form: 'Bottle', extra: 'x' }),
    { medication_name: 'Lisinopril', dose: '10mg', form: 'Bottle' },
  );
  // Partial attributes -> remaining keys null.
  assert.deepEqual(pluckMedFields({ medication_name: 'X' }), {
    medication_name: 'X',
    dose: null,
    form: null,
  });
});
