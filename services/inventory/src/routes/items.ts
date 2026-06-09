// Items API — built against the new core inventory platform schema
// (migrations/002_core_inventory_platform.sql). Implements:
//
//   POST   /items                 — Check in
//   GET    /items                 — Search (FEFO sort)
//   GET    /items/:id             — Single item + last 10 transactions
//   PATCH  /items/:id             — Edit (status changes go through state machine)
//   POST   /items/:id/remove      — Soft delete with reason
//   GET    /items/:id/transactions— Full transaction history
//
// All status changes flow through `assertTransition` from the platform's
// inventory-core state machine. Every mutation appends a row to
// `transactions`. No `DELETE FROM items` ever happens; `removed` is a
// soft-delete status.
//
// FEFO sort is performed in SQL for performance:
//   ORDER BY expiry_date ASC NULLS LAST, created_at ASC, unit_code ASC
// matching the semantics of `compareFEFO` in @daana-health/inventory-core.
//
// NOTE: this file targets schema 002 (items, item_types, locations,
// transactions, code_counters). It is added ALONGSIDE the legacy units/
// lots/drugs routes; consumer migration is handled separately.

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseServer } from '../utils/supabase';
import type { ItemStatus, TransactionAction } from '@daana-health/inventory-core';
import { assertTransition, InvalidStatusTransitionError } from '@daana-health/inventory-core';
import { renderCodeTemplate } from '@daana-health/inventory-core';

const router = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REMOVE_REASONS = [
  'expired',
  'damaged',
  'duplicate_entry',
  'incorrect_entry',
  'lost_or_missing',
  'disposed',
  'other',
] as const;
type RemoveReason = (typeof REMOVE_REASONS)[number];

const ITEM_COLUMNS = `
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
  location:locations(code)
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Minimal JSON-Schema validator. Supports the subset emitted by
 * @daana-health/inventory-core AttributeSchema:
 *   - type: "object" with properties + required
 *   - leaf types: string | number | integer | boolean | array | object | null
 *   - string enum
 *   - number/integer minimum/maximum
 *   - object with nested properties + required
 *   - array items
 *
 * Returns an array of human-readable issues. Empty array = valid.
 *
 * This is intentionally bare-bones because neither `ajv` nor `zod` is a
 * declared dependency of this service. Status report flags this so a future
 * agent can swap in ajv if richer validation is needed.
 */
function validateAttributes(schema: any, value: any, path = 'attributes'): string[] {
  const issues: string[] = [];
  if (!schema || typeof schema !== 'object') return issues;

  const t = schema.type;
  if (t === 'object') {
    if (!isPlainObject(value)) {
      issues.push(`${path}: expected object`);
      return issues;
    }
    const props = (schema.properties || {}) as Record<string, any>;
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value)) issues.push(`${path}.${key}: required`);
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in value) {
        issues.push(...validateAttributes(propSchema, (value as any)[key], `${path}.${key}`));
      }
    }
    return issues;
  }

  if (t === 'string') {
    if (typeof value !== 'string') {
      issues.push(`${path}: expected string`);
      return issues;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      issues.push(`${path}: must be one of ${schema.enum.join(', ')}`);
    }
    return issues;
  }

  if (t === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      issues.push(`${path}: expected integer`);
      return issues;
    }
  } else if (t === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      issues.push(`${path}: expected number`);
      return issues;
    }
  }
  if (t === 'number' || t === 'integer') {
    if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) {
      issues.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) {
      issues.push(`${path}: must be <= ${schema.maximum}`);
    }
    return issues;
  }

  if (t === 'boolean') {
    if (typeof value !== 'boolean') issues.push(`${path}: expected boolean`);
    return issues;
  }

  if (t === 'array') {
    if (!Array.isArray(value)) {
      issues.push(`${path}: expected array`);
      return issues;
    }
    if (schema.items) {
      value.forEach((v, i) =>
        issues.push(...validateAttributes(schema.items, v, `${path}[${i}]`)),
      );
    }
    return issues;
  }

  if (t === 'null') {
    if (value !== null) issues.push(`${path}: expected null`);
    return issues;
  }

  return issues;
}

/**
 * Atomically allocate the next code counter for (type_id, location_code).
 *
 * Prefers an RPC `increment_code_counter(p_type_id, p_location_code)`
 * supplied by the new migration (SECURITY DEFINER, single-statement
 * UPDATE ... RETURNING). Falls back to a best-effort upsert+read for
 * environments where the RPC is not yet present — the fallback is NOT
 * race-safe across concurrent writers and is intentionally noisy in logs
 * so it is replaced as soon as the migration lands.
 */
async function allocateNextCounter(typeId: string, locationCode: string): Promise<number> {
  const rpc = await supabaseServer.rpc('increment_code_counter', {
    p_type_id: typeId,
    p_location_code: locationCode,
  });
  if (!rpc.error && typeof rpc.data === 'number') {
    return rpc.data;
  }
  // Fallback (NOT race-safe — emit a warning so operators notice)
  // eslint-disable-next-line no-console
  console.warn(
    '[items] increment_code_counter RPC unavailable, falling back to non-atomic update. ' +
      `rpc error: ${rpc.error?.message ?? 'none'}`,
  );
  const existing = await supabaseServer
    .from('code_counters')
    .select('next_value')
    .eq('item_type_id', typeId)
    .eq('location_code', locationCode)
    .maybeSingle();
  const current = existing.data?.next_value ?? 1;
  const updated = await supabaseServer
    .from('code_counters')
    .upsert(
      {
        item_type_id: typeId,
        location_code: locationCode,
        next_value: current + 1,
      },
      { onConflict: 'item_type_id,location_code' },
    )
    .select('next_value')
    .single();
  if (updated.error || !updated.data) {
    throw new Error(`Failed to allocate counter: ${updated.error?.message}`);
  }
  return current;
}

async function insertTransaction(
  itemId: string,
  action: TransactionAction,
  actorId: string | null,
  payload: {
    old_value?: Record<string, unknown> | null;
    new_value?: Record<string, unknown> | null;
    reason?: string | null;
    note?: string | null;
  } = {},
): Promise<void> {
  const { error } = await supabaseServer.from('transactions').insert({
    item_id: itemId,
    action,
    actor_id: actorId,
    old_value: payload.old_value ?? null,
    new_value: payload.new_value ?? null,
    reason: payload.reason ?? null,
    note: payload.note ?? null,
  });
  if (error) {
    throw new Error(`Failed to write transaction log: ${error.message}`);
  }
}

function actorId(req: Request): string | null {
  const u = (req as any).user;
  return u?.userId ?? null;
}

// ---------------------------------------------------------------------------
// POST /items  — Check in
// ---------------------------------------------------------------------------

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    // Accept BOTH the id-based contract (type_id/location_id/expiry_date) and
    // the human-readable identifiers the check-in UI naturally has
    // (typeName/locationCode/expiryDate). The latter is resolved server-side,
    // consistent with GET /items/next-code which already resolves by code.
    const body = (req.body ?? {}) as Record<string, any>;
    const { type_id, typeName, location_id, locationCode, attributes } = body;
    const expiry_date = body.expiry_date ?? body.expiryDate ?? null;

    if (!isPlainObject(attributes)) {
      return res.status(400).json({ error: 'attributes must be an object' });
    }
    if (!type_id && !typeName) {
      return res.status(400).json({ error: 'type_id or typeName required' });
    }
    if (!location_id && !locationCode) {
      return res.status(400).json({ error: 'location_id or locationCode required' });
    }

    // 1. Look up item type (by id or name) for its schema + code template.
    let typeQuery = supabaseServer
      .from('item_types')
      .select('id, name, code_format_template, attribute_schema');
    typeQuery = type_id ? typeQuery.eq('id', type_id) : typeQuery.eq('name', typeName);
    const typeRes = await typeQuery.maybeSingle();
    if (typeRes.error || !typeRes.data) {
      return res.status(404).json({ error: 'Unknown item type' });
    }
    const itemType = typeRes.data;

    // 2. Validate attributes against the type's JSON schema.
    const issues = validateAttributes(itemType.attribute_schema, attributes);
    if (issues.length > 0) {
      return res.status(400).json({ error: 'Invalid attributes', issues });
    }

    // 3. Look up location (by id, or by code scoped to the caller's clinic)
    //    for the code template.
    const clinicId = (req as any).clinic?.clinicId;
    let locQuery = supabaseServer.from('locations').select('id, code');
    if (location_id) {
      locQuery = locQuery.eq('id', location_id);
    } else {
      locQuery = locQuery.eq('code', locationCode);
      if (clinicId) locQuery = locQuery.eq('clinic_id', clinicId);
    }
    const locRes = await locQuery.maybeSingle();
    if (locRes.error || !locRes.data) {
      return res.status(404).json({ error: 'Unknown location' });
    }
    const location = locRes.data;

    // 4. Atomically allocate the next counter for this (type, location).
    const counter = await allocateNextCounter(itemType.id, location.code);

    // 5. Render unit_code from the type's template.
    let unitCode: string;
    try {
      unitCode = renderCodeTemplate(itemType.code_format_template, {
        itemTypeId: itemType.id,
        itemTypeName: itemType.name,
        locationCode: location.code,
        counter,
        attributes,
      });
    } catch (err: any) {
      return res.status(500).json({ error: `Code template render failed: ${err.message}` });
    }

    // 6. Insert item with status='active'.
    const actor = actorId(req);
    const insertRes = await supabaseServer
      .from('items')
      .insert({
        type_id: itemType.id,
        status: 'active' satisfies ItemStatus,
        location_id: location.id,
        expiry_date: expiry_date ?? null,
        unit_code: unitCode,
        attributes,
        created_by: actor,
      })
      .select(ITEM_COLUMNS)
      .single();
    if (insertRes.error || !insertRes.data) {
      return res
        .status(500)
        .json({ error: `Failed to insert item: ${insertRes.error?.message}` });
    }
    const item = insertRes.data;

    // 7. Log the check-in transaction.
    await insertTransaction(item.id, 'check_in', actor, { new_value: item as any });

    return res.status(201).json({ item, unit_code: unitCode });
  } catch (error: any) {
    return res.status(500).json({ error: error.message ?? 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// GET /items  — Search with FEFO sort
// ---------------------------------------------------------------------------

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string | undefined) ?? undefined;
    // `status` may be a single value or a comma-separated list (e.g. the
    // superadmin checkout search requests "active,expired"). Split + use .in().
    const statuses = ((req.query.status as string | undefined) ?? 'active')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const locationId = req.query.location_id as string | undefined;
    const typeId = req.query.type_id as string | undefined;
    const expiryBefore = req.query.expiry_before as string | undefined;
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10) || 50, 200);

    let query = supabaseServer.from('items').select(ITEM_COLUMNS);
    query = statuses.length > 1 ? query.in('status', statuses) : query.eq('status', statuses[0] ?? 'active');

    if (typeId) query = query.eq('type_id', typeId);
    if (locationId) query = query.eq('location_id', locationId);
    if (expiryBefore) query = query.lte('expiry_date', expiryBefore);
    if (q && q.trim().length > 0) {
      // substring search on attributes->>'medication_name'
      query = query.ilike('attributes->>medication_name', `%${q.trim()}%`);
    }

    // FEFO at the SQL layer: expiry asc nulls last, created asc, unit_code asc.
    // PostgREST exposes nullsfirst/nullslast via .order options.
    query = query
      .order('expiry_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .order('unit_code', { ascending: true })
      .limit(limit);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ items: data ?? [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message ?? 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// GET /items/:id  — Single item + recent transactions
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const itemRes = await supabaseServer
      .from('items')
      .select(ITEM_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (itemRes.error) return res.status(500).json({ error: itemRes.error.message });
    if (!itemRes.data) return res.status(404).json({ error: 'Item not found' });

    const txRes = await supabaseServer
      .from('transactions')
      .select('*')
      .eq('item_id', id)
      .order('created_at', { ascending: false })
      .limit(10);

    return res.json({ item: itemRes.data, transactions: txRes.data ?? [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message ?? 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /items/:id  — Edit
// ---------------------------------------------------------------------------

/**
 * Editable top-level columns (per spec "Editable Fields").
 *
 *   - location_id
 *   - expiry_date
 *   - status         (subject to state machine)
 *
 * Editable attribute keys (deep-merged into items.attributes):
 *
 *   - medication_name
 *   - dosage
 *   - unit
 *   - form
 *   - quantity
 *   - notes
 */
const EDITABLE_ATTR_KEYS = ['medication_name', 'dosage', 'unit', 'form', 'quantity', 'notes'] as const;

router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;

    // 1. Load existing.
    const existingRes = await supabaseServer
      .from('items')
      .select(ITEM_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (existingRes.error) return res.status(500).json({ error: existingRes.error.message });
    if (!existingRes.data) return res.status(404).json({ error: 'Item not found' });
    const existing = existingRes.data as any;

    // 2. Build update.
    const update: Record<string, unknown> = {};
    if ('location_id' in body) update.location_id = body.location_id;
    if ('expiry_date' in body) update.expiry_date = body.expiry_date ?? null;

    // status change must pass the state machine.
    if ('status' in body) {
      const next = body.status as ItemStatus;
      try {
        assertTransition(existing.status as ItemStatus, next);
      } catch (err) {
        if (err instanceof InvalidStatusTransitionError) {
          return res.status(409).json({ error: err.message, code: 'INVALID_STATUS_TRANSITION' });
        }
        throw err;
      }
      update.status = next;
    }

    // attribute-level edits merge into existing attributes.
    const incomingAttrs = isPlainObject(body.attributes) ? (body.attributes as Record<string, unknown>) : {};
    const mergedAttrs: Record<string, unknown> = { ...(existing.attributes ?? {}) };
    let attrsTouched = false;
    for (const key of EDITABLE_ATTR_KEYS) {
      if (key in incomingAttrs) {
        mergedAttrs[key] = incomingAttrs[key];
        attrsTouched = true;
      }
      // also accept top-level keys for ergonomics (e.g. body.medication_name)
      if (key in body) {
        mergedAttrs[key] = body[key];
        attrsTouched = true;
      }
    }
    if (attrsTouched) update.attributes = mergedAttrs;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No editable fields provided' });
    }

    const actor = actorId(req);
    update.last_edited_at = new Date().toISOString();
    update.last_edited_by = actor;

    // 3. Apply update.
    const updateRes = await supabaseServer
      .from('items')
      .update(update)
      .eq('id', id)
      .select(ITEM_COLUMNS)
      .single();
    if (updateRes.error || !updateRes.data) {
      return res.status(500).json({ error: updateRes.error?.message ?? 'update failed' });
    }
    const updated = updateRes.data;

    // 4. Log edit transaction.
    await insertTransaction(id, 'edit', actor, {
      old_value: existing,
      new_value: updated as any,
    });

    return res.json({ item: updated });
  } catch (error: any) {
    return res.status(500).json({ error: error.message ?? 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// POST /items/:id/remove  — Soft delete
// ---------------------------------------------------------------------------

router.post('/:id/remove', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason, note } = (req.body ?? {}) as { reason?: string; note?: string };

    if (!reason || !(REMOVE_REASONS as readonly string[]).includes(reason)) {
      return res.status(400).json({
        error: `reason required; must be one of: ${REMOVE_REASONS.join(', ')}`,
      });
    }

    const existingRes = await supabaseServer
      .from('items')
      .select(ITEM_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (existingRes.error) return res.status(500).json({ error: existingRes.error.message });
    if (!existingRes.data) return res.status(404).json({ error: 'Item not found' });
    const existing = existingRes.data as any;

    // Enforce state machine.
    try {
      assertTransition(existing.status as ItemStatus, 'removed');
    } catch (err) {
      if (err instanceof InvalidStatusTransitionError) {
        return res.status(409).json({ error: err.message, code: 'INVALID_STATUS_TRANSITION' });
      }
      throw err;
    }

    const actor = actorId(req);
    const now = new Date().toISOString();

    // Soft delete — NEVER `DELETE FROM items`.
    const updateRes = await supabaseServer
      .from('items')
      .update({
        status: 'removed' satisfies ItemStatus,
        removed_at: now,
        removed_by: actor,
        removed_reason: reason as RemoveReason,
      })
      .eq('id', id)
      .select(ITEM_COLUMNS)
      .single();
    if (updateRes.error || !updateRes.data) {
      return res.status(500).json({ error: updateRes.error?.message ?? 'remove failed' });
    }
    const removed = updateRes.data;

    await insertTransaction(id, 'remove', actor, {
      old_value: existing,
      new_value: removed as any,
      reason: reason as RemoveReason,
      note: note ?? null,
    });

    return res.json({ item: removed });
  } catch (error: any) {
    return res.status(500).json({ error: error.message ?? 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// GET /items/:id/transactions  — Full history, paginated
// ---------------------------------------------------------------------------

router.get('/:id/transactions', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const page = Math.max(parseInt((req.query.page as string) || '1', 10) || 1, 1);
    const pageSize = Math.min(
      Math.max(parseInt((req.query.pageSize as string) || '50', 10) || 50, 1),
      200,
    );
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await supabaseServer
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('item_id', id)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({
      transactions: data ?? [],
      page,
      pageSize,
      total: count ?? 0,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message ?? 'Internal error' });
  }
});

export default router;
