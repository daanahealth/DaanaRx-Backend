// Reports + insight-card endpoints for the MASS MVP.
//
// Implements the spec's "Reports Dashboard" (Expiring Soon, Lots Approaching
// Capacity, High-Use Medications, Recently Removed, Inventory Edits,
// Transaction Log) plus the home-page "Recently Checked Out" insight card.
//
// All endpoints are read-only; they query the platform-generic
// `items`, `locations`, and `transactions` tables described in
// migrations/002_core_inventory_platform.sql. Medication-specific fields
// (medication_name, dose, form) live in the JSONB `items.attributes` column
// per the MASS domain pack.
//
// IMPORTANT: 002_core_inventory_platform.sql is NOT YET APPLIED. These
// endpoints will function once the migration lands; until then they are
// dead-code wired into Express. The platform-integration branch is the
// integration point.
//
// ---------------------------------------------------------------------------
// Index usage (relied upon by the queries below)
// ---------------------------------------------------------------------------
//   items(status)                           -- /capacity, /expiring filters
//   items(expiry_date)                      -- /expiring FEFO ordering
//   items(removed_at)                       -- /recently-removed sort
//   transactions(item_id, created_at DESC)  -- /high-use, /recently-checked-out,
//                                              /inventory-edits, /transactions
//   transactions(action, created_at DESC)   -- /high-use, /inventory-edits filter
//
// If the latter composite index does not exist after the migration ships,
// add it explicitly; the high-use query is the worst offender (full scan
// over `transactions` filtered by action and 30-day window).

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseServer } from '../utils/supabase';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns an ISO-8601 timestamp `nDays` days from now (negative = past). */
export function daysFromNow(nDays: number, base = Date.now()): string {
  return new Date(base + nDays * 24 * 60 * 60 * 1000).toISOString();
}

/** Returns the date-only (YYYY-MM-DD) component of an ISO timestamp. */
export function isoDate(ts: string): string {
  return ts.slice(0, 10);
}

/**
 * Pulls medication_name/dose/form out of items.attributes safely. MASS uses
 * these keys; future item types may not. Callers should treat missing keys
 * as null rather than throwing.
 */
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

/**
 * The `transactions` table has no foreign key to `items` (it's a legacy+core
 * merged table — PK `transaction_id`, no `item_id -> items.id` FK), so PostgREST
 * cannot embed `items` onto a transaction ("Could not find a relationship…").
 * Every transaction already snapshots the item in new_value/old_value, so read
 * the item from there. This is also more robust — the snapshot survives even if
 * the underlying item row is later edited or removed.
 */
function itemFromTx(row: any): {
  item_id: string | null;
  unit_code: string | null;
  medication_name: string | null;
  dose: string | null;
  form: string | null;
  location: { code: string | null; specialty: string | null } | null;
} | null {
  const snap = (row?.new_value ?? row?.old_value) as Record<string, any> | null;
  if (!snap || typeof snap !== 'object') return null;
  const loc = snap.location as Record<string, any> | undefined;
  return {
    item_id: snap.id ?? row?.item_id ?? null,
    unit_code: snap.unit_code ?? null,
    ...pluckMedFields(snap.attributes),
    location: loc ? { code: loc.code ?? null, specialty: loc.specialty ?? null } : null,
  };
}

/**
 * Diff two JSONB blobs (typically items.attributes or a status object) into
 * a list of field-level changes for the /reports/inventory-edits payload.
 */
export function diffValues(
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

// Standard supabase select fragment that joins an item + its location.
const ITEM_WITH_LOCATION = `
  id,
  type_id,
  status,
  location_id,
  expiry_date,
  unit_code,
  attributes,
  created_at,
  created_by,
  last_edited_at,
  last_edited_by,
  removed_at,
  removed_by,
  removed_reason,
  location:locations(id, code, specialty, capacity)
`;

// ---------------------------------------------------------------------------
// 1. GET /reports/expiring
// ---------------------------------------------------------------------------
//
// Query params:
//   window: 30 | 60 | 90 (default 30)
//
// If `window` is omitted entirely, returns all three buckets so the Reports
// dashboard can render the 30/60/90 panes in one round-trip.
//
// Returns active items expiring within the window, FEFO-ordered.
// Index: items(status) + items(expiry_date).
router.get('/expiring', requireAuth, async (req: Request, res: Response) => {
  try {
    const rawWindow = req.query.window as string | undefined;
    const now = new Date().toISOString();

    async function bucket(days: number) {
      const cutoff = daysFromNow(days);
      const { data, error, count } = await supabaseServer
        .from('items')
        .select(ITEM_WITH_LOCATION, { count: 'exact' })
        .eq('status', 'active')
        .gte('expiry_date', isoDate(now))
        .lte('expiry_date', isoDate(cutoff))
        .order('expiry_date', { ascending: true })
        .order('created_at', { ascending: true })
        .order('unit_code', { ascending: true })
        .limit(25);
      if (error) throw new Error(error.message);
      return {
        window_days: days,
        count: count ?? data?.length ?? 0,
        items: (data || []).map((row: any) => ({
          ...pluckMedFields(row.attributes),
          item_id: row.id,
          unit_code: row.unit_code,
          status: row.status,
          expiry_date: row.expiry_date,
          location: row.location
            ? { id: row.location.id, code: row.location.code, specialty: row.location.specialty }
            : null,
        })),
      };
    }

    if (rawWindow === undefined || rawWindow === '') {
      const [w30, w60, w90] = await Promise.all([bucket(30), bucket(60), bucket(90)]);
      return res.json({ windows: [w30, w60, w90] });
    }

    const windowDays = parseInt(rawWindow, 10);
    if (![30, 60, 90].includes(windowDays)) {
      return res.status(400).json({ error: 'window must be 30, 60, or 90' });
    }
    return res.json(await bucket(windowDays));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 2. GET /reports/capacity
// ---------------------------------------------------------------------------
//
// Returns every location at >=90% of its configured capacity. A unit
// counts toward capacity if it is `active`, `in_cart`, or `pending_approval`
// (i.e. physically present in the bin).
//
// Each row: { location: {id, code, specialty, capacity}, used, percent }.
// Sorted by percent desc.
//
// Index: items(status), items(location_id) implicit via primary key.
router.get('/capacity', requireAuth, async (_req: Request, res: Response) => {
  try {
    const { data: locations, error: locErr } = await supabaseServer
      .from('locations')
      .select('id, code, specialty, capacity, deactivated_at');
    if (locErr) throw new Error(locErr.message);

    // Pull all in-bin items in one shot then bucket by location_id. This is
    // cheaper than N round-trips to count(*) per location for the bin counts
    // we expect at MASS (~20 bins). If bins balloon, push this to an RPC.
    const { data: items, error: itemErr } = await supabaseServer
      .from('items')
      .select('id, location_id, status')
      .in('status', ['active', 'in_cart', 'pending_approval']);
    if (itemErr) throw new Error(itemErr.message);

    const counts = new Map<string, number>();
    for (const it of items || []) {
      if (!it.location_id) continue;
      counts.set(it.location_id, (counts.get(it.location_id) ?? 0) + 1);
    }

    const flagged = (locations || [])
      .filter((l: any) => !l.deactivated_at)
      .map((l: any) => {
        const used = counts.get(l.id) ?? 0;
        const capacity = l.capacity ?? 50;
        const percent = capacity > 0 ? used / capacity : 0;
        return {
          location: { id: l.id, code: l.code, specialty: l.specialty, capacity },
          used,
          percent: Math.round(percent * 1000) / 1000, // 0.0–1.0, three decimals
        };
      })
      .filter((r) => r.percent >= 0.9)
      .sort((a, b) => b.percent - a.percent);

    res.json({ threshold: 0.9, count: flagged.length, locations: flagged });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 3. GET /reports/high-use
// ---------------------------------------------------------------------------
//
// Ranks medications by checkout frequency over the past 30 days. Groups
// transactions where action='check_out' AND created_at >= now()-30d by
// items.attributes->>'medication_name'.
//
// Returns top 25. Each row: { medication_name, count, sample_dose, sample_form }.
//
// Index: transactions(action, created_at), transactions(item_id, created_at).
router.get('/high-use', requireAuth, async (_req: Request, res: Response) => {
  try {
    const since = daysFromNow(-30);
    const { data, error } = await supabaseServer
      .from('transactions')
      .select('transaction_id, item_id, created_at, new_value, old_value')
      .eq('action', 'check_out')
      .gte('created_at', since);
    if (error) throw new Error(error.message);

    const buckets = new Map<
      string,
      { count: number; sample_dose: string | null; sample_form: string | null }
    >();
    for (const row of (data as any[]) || []) {
      const med = pluckMedFields((row.new_value ?? row.old_value)?.attributes);
      const key = med.medication_name || '(unknown)';
      const cur = buckets.get(key);
      if (cur) {
        cur.count += 1;
      } else {
        buckets.set(key, { count: 1, sample_dose: med.dose, sample_form: med.form });
      }
    }

    const ranked = Array.from(buckets.entries())
      .map(([medication_name, v]) => ({ medication_name, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);

    res.json({ window_days: 30, count: ranked.length, medications: ranked });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 4. GET /reports/recently-removed
// ---------------------------------------------------------------------------
//
// items where status='removed' AND removed_at >= now()-30d. Sorted desc.
// Limit 100. Each row includes the removal reason for the dashboard chip.
//
// Index: items(status), items(removed_at).
router.get('/recently-removed', requireAuth, async (_req: Request, res: Response) => {
  try {
    const since = daysFromNow(-30);
    const { data, error } = await supabaseServer
      .from('items')
      .select(ITEM_WITH_LOCATION)
      .eq('status', 'removed')
      .gte('removed_at', since)
      .order('removed_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);

    res.json({
      count: data?.length ?? 0,
      items: (data || []).map((row: any) => ({
        ...pluckMedFields(row.attributes),
        item_id: row.id,
        unit_code: row.unit_code,
        removed_at: row.removed_at,
        removed_by: row.removed_by,
        removed_reason: row.removed_reason,
        location: row.location
          ? { id: row.location.id, code: row.location.code, specialty: row.location.specialty }
          : null,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 5. GET /reports/inventory-edits
// ---------------------------------------------------------------------------
//
// transactions where action='edit' from the past 30 days. Sorted desc.
// Each row carries a synthesized field-level diff from old_value/new_value.
//
// Index: transactions(action, created_at), transactions(item_id, created_at).
router.get('/inventory-edits', requireAuth, async (_req: Request, res: Response) => {
  try {
    const since = daysFromNow(-30);
    const { data, error } = await supabaseServer
      .from('transactions')
      .select('transaction_id, action, created_at, actor_id, old_value, new_value, reason, note, item_id')
      .eq('action', 'edit')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    res.json({
      count: data?.length ?? 0,
      edits: (data || []).map((row: any) => ({
        transaction_id: row.transaction_id,
        timestamp: row.created_at,
        actor_id: row.actor_id,
        reason: row.reason,
        note: row.note,
        item: itemFromTx(row),
        changes: diffValues(row.old_value, row.new_value),
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 6. GET /reports/recently-checked-out  (home-page insight card)
// ---------------------------------------------------------------------------
//
// Spec wording (verbatim): "last 25 transactions or last 7 days, whichever
// is larger." We resolve that as: pull every check_out tx from the past 7
// days; if that returns fewer than 25 rows, top up by also returning the
// 25 most recent check_out transactions overall. Sorted desc.
//
// Index: transactions(action, created_at DESC).
router.get('/recently-checked-out', requireAuth, async (_req: Request, res: Response) => {
  try {
    const sevenDays = daysFromNow(-7);

    const sel = `transaction_id, action, created_at, actor_id, reason, note, item_id, new_value, old_value`;

    const { data: weekRows, error: weekErr } = await supabaseServer
      .from('transactions')
      .select(sel)
      .eq('action', 'check_out')
      .gte('created_at', sevenDays)
      .order('created_at', { ascending: false });
    if (weekErr) throw new Error(weekErr.message);

    let rows = weekRows || [];
    if (rows.length < 25) {
      const { data: topRows, error: topErr } = await supabaseServer
        .from('transactions')
        .select(sel)
        .eq('action', 'check_out')
        .order('created_at', { ascending: false })
        .limit(25);
      if (topErr) throw new Error(topErr.message);
      rows = topRows || [];
    }

    res.json({
      count: rows.length,
      transactions: rows.map((row: any) => ({
        transaction_id: row.transaction_id,
        timestamp: row.created_at,
        actor_id: row.actor_id,
        reason: row.reason,
        note: row.note,
        item: itemFromTx(row),
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

// ---------------------------------------------------------------------------
// /transactions (full transaction log)
// ---------------------------------------------------------------------------
//
// Exported as a second router so it can be mounted on a distinct path
// (`app.use('/transactions', transactionLogRoutes)`) per the task brief.
//
// Spec fields: date/time, action_type, medication_name, dose, form, location,
// drx_code (= unit_code), user (actor_id), reason, notes.
//
// Query params:
//   date_from   ISO timestamp inclusive
//   date_to     ISO timestamp exclusive
//   action_type CSV list of TransactionAction values
//   actor_id    uuid (filter to one user)
//   item_id     uuid (filter to one item's history)
//   q           medication-name substring search (case-insensitive)
//   cursor      base64-encoded {ts, id} from a previous response
//   limit       default 50, capped at 200
//
// Index: transactions(item_id, created_at DESC) +
//        transactions(action, created_at DESC).
export const transactionLogRoutes = Router();

transactionLogRoutes.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10) || 50, 200);
    const dateFrom = req.query.date_from as string | undefined;
    const dateTo = req.query.date_to as string | undefined;
    const actionType = req.query.action_type as string | undefined;
    const actorId = req.query.actor_id as string | undefined;
    const itemId = req.query.item_id as string | undefined;
    const q = req.query.q as string | undefined;
    const cursor = req.query.cursor as string | undefined;

    let query = supabaseServer
      .from('transactions')
      .select('transaction_id, action, created_at, actor_id, old_value, new_value, reason, note, item_id')
      .order('created_at', { ascending: false })
      .order('transaction_id', { ascending: false })
      .limit(limit + 1); // +1 so we can detect "has more"

    if (dateFrom) query = query.gte('created_at', dateFrom);
    if (dateTo) query = query.lt('created_at', dateTo);
    if (actionType) {
      const types = actionType
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (types.length === 1) query = query.eq('action', types[0]);
      else if (types.length > 1) query = query.in('action', types);
    }
    if (actorId) query = query.eq('actor_id', actorId);
    if (itemId) query = query.eq('item_id', itemId);

    // Cursor pagination: {ts, id}. The order is (created_at desc, id desc) so
    // we walk the keyset by asking for rows strictly older than the cursor.
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        if (decoded.ts) query = query.lt('created_at', decoded.ts);
      } catch {
        return res.status(400).json({ error: 'Invalid cursor' });
      }
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    let rows = (data as any[]) || [];

    // medication_name search applied in-app: supabase-js doesn't support
    // ilike on JSONB->>'medication_name' nested through a join without an
    // explicit RPC. The result-set is small (<= limit+1) so this is cheap.
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter((r) => {
        const med = itemFromTx(r)?.medication_name;
        return typeof med === 'string' && med.toLowerCase().includes(needle);
      });
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && page.length > 0
        ? Buffer.from(
            JSON.stringify({ ts: page[page.length - 1].created_at, id: page[page.length - 1].transaction_id }),
          ).toString('base64')
        : null;

    res.json({
      count: page.length,
      next_cursor: nextCursor,
      transactions: page.map((row: any) => {
        const it = itemFromTx(row);
        return {
          transaction_id: row.transaction_id,
          timestamp: row.created_at,
          action_type: row.action,
          medication_name: it?.medication_name ?? null,
          dose: it?.dose ?? null,
          form: it?.form ?? null,
          location: it?.location ?? null,
          drx_code: it?.unit_code ?? null,
          item_id: row.item_id,
          user: row.actor_id,
          reason: row.reason,
          notes: row.note,
          changes: row.action === 'edit' ? diffValues(row.old_value, row.new_value) : undefined,
        };
      }),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Test-only exports.
export const __testing = {
  daysFromNow,
  diffValues,
  pluckMedFields,
};
