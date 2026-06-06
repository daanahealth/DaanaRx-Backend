// Unit test for GET /items/next-code — the peek-only counter endpoint added
// by feature/be-contract-patch. See routes/items-next-code.ts for the route
// implementation and docs/merge-strategy.md §4 for the contract drift this
// closes.
//
// Strategy: mirror the production algorithm against an in-memory fake
// supabase. We do NOT import the route module directly because
// @daana-health/inventory-core publishes as ESM and ts-jest is unavailable
// in this service's deps (same constraint that drove
// services/transaction/src/routes/__tests__/carts.test.ts to use
// `node:test`).
//
// Cases:
//   1. Returns the next counter value WITHOUT incrementing.
//   2. Returns counter=1 when no row exists yet for (type, location).
//   3. 400 when `location` query param is missing.
//   4. 404 when location code is unknown.
//   5. 409 when location is deactivated.
//
// Run:
//   cd services/inventory && \
//     node --require ts-node/register --test src/routes/__tests__/items-next-code.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Local renderCodeTemplate mirror.
//
// The production handler imports renderCodeTemplate from
// @daana-health/inventory-core. We re-implement the same {placeholder}
// substitution + zero-padded counter format here so the test runs without
// loading the ESM-only core package.
// ---------------------------------------------------------------------------

interface TemplateInputs {
  itemTypeId: string;
  itemTypeName: string;
  locationCode: string;
  counter: number;
  attributes: Record<string, unknown>;
}

function renderCodeTemplate(template: string, inputs: TemplateInputs): string {
  return template.replace(/\{(\w+)(?::0(\d+))?\}/g, (_m, key: string, pad?: string) => {
    let v: unknown;
    if (key === 'counter') v = inputs.counter;
    else if (key === 'locationCode') v = inputs.locationCode;
    else if (key === 'itemTypeName') v = inputs.itemTypeName;
    else if (key === 'itemTypeId') v = inputs.itemTypeId;
    else v = (inputs.attributes as any)[key];
    if (v === undefined || v === null) throw new Error(`Missing template var: ${key}`);
    if (pad && typeof v === 'number') return String(v).padStart(parseInt(pad, 10), '0');
    return String(v);
  });
}

// ---------------------------------------------------------------------------
// In-memory fake supabase tables
// ---------------------------------------------------------------------------

interface Tables {
  locations: Map<string, any>; // keyed by code
  item_types: Map<string, any>; // keyed by id
  code_counters: Map<string, any>; // keyed by `${typeId}|${locationCode}`
}

function makeTables(): Tables {
  return {
    locations: new Map(),
    item_types: new Map(),
    code_counters: new Map(),
  };
}

let tables: Tables = makeTables();

function reset() {
  tables = makeTables();
}

// ---------------------------------------------------------------------------
// Mirror of the route handler
// ---------------------------------------------------------------------------

async function getNextCode(query: {
  location?: string;
  type_id?: string;
}): Promise<{ status: number; body: any }> {
  const locationCode = query.location?.trim();
  const typeIdParam = query.type_id?.trim();

  if (!locationCode) {
    return { status: 400, body: { error: 'location (code) query param required' } };
  }

  const loc = tables.locations.get(locationCode);
  if (!loc) return { status: 404, body: { error: 'Unknown location code' } };
  if (loc.deactivated_at) {
    return { status: 409, body: { error: 'Location is deactivated' } };
  }

  const typeId = typeIdParam ?? loc.item_type_id;
  if (!typeId) {
    return {
      status: 400,
      body: { error: 'type_id required (location has no default item_type_id)' },
    };
  }

  const itemType = tables.item_types.get(typeId);
  if (!itemType) return { status: 404, body: { error: 'Unknown item type' } };

  const counterKey = `${itemType.id}|${loc.code}`;
  const counterRow = tables.code_counters.get(counterKey);
  const counter: number = counterRow?.next_value ?? 1;

  let unitCode: string;
  try {
    unitCode = renderCodeTemplate(itemType.code_format_template, {
      itemTypeId: itemType.id,
      itemTypeName: itemType.name,
      locationCode: loc.code,
      counter,
      attributes: {},
    });
  } catch (err: any) {
    return { status: 500, body: { error: `Code template render failed: ${err.message}` } };
  }

  return {
    status: 200,
    body: { unit_code: unitCode, counter, location_code: loc.code, type_id: itemType.id },
  };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedLocation(code: string, item_type_id: string | null = null, deactivated = false) {
  const row = {
    id: `loc-${code}`,
    code,
    item_type_id,
    deactivated_at: deactivated ? new Date().toISOString() : null,
  };
  tables.locations.set(code, row);
  return row;
}

function seedItemType(id: string, template = 'DRX-MASS-{locationCode}-{counter:05}') {
  const row = { id, name: 'MASS', code_format_template: template };
  tables.item_types.set(id, row);
  return row;
}

function seedCounter(typeId: string, locationCode: string, next_value: number) {
  tables.code_counters.set(`${typeId}|${locationCode}`, {
    type_id: typeId,
    location_code: locationCode,
    next_value,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('GET /items/next-code returns next value without incrementing', async () => {
  reset();
  seedItemType('type-mass');
  seedLocation('XXX', 'type-mass');
  seedCounter('type-mass', 'XXX', 42);

  const res = await getNextCode({ location: 'XXX' });
  assert.equal(res.status, 200);
  assert.equal(res.body.unit_code, 'DRX-MASS-XXX-00042');
  assert.equal(res.body.counter, 42);

  // Side-effect-free: the counter row is unchanged.
  assert.equal(tables.code_counters.get('type-mass|XXX')!.next_value, 42);
});

test('GET /items/next-code defaults counter to 1 when no row exists', async () => {
  reset();
  seedItemType('type-mass');
  seedLocation('YYY', 'type-mass');

  const res = await getNextCode({ location: 'YYY' });
  assert.equal(res.status, 200);
  assert.equal(res.body.unit_code, 'DRX-MASS-YYY-00001');
  assert.equal(res.body.counter, 1);
  // Still no counter row inserted (read-only).
  assert.equal(tables.code_counters.size, 0);
});

test('GET /items/next-code 400 when location query param is missing', async () => {
  reset();
  const res = await getNextCode({});
  assert.equal(res.status, 400);
});

test('GET /items/next-code 404 when location code is unknown', async () => {
  reset();
  const res = await getNextCode({ location: 'NOPE' });
  assert.equal(res.status, 404);
});

test('GET /items/next-code 409 when location is deactivated', async () => {
  reset();
  seedItemType('type-mass');
  seedLocation('OLD', 'type-mass', true);
  const res = await getNextCode({ location: 'OLD' });
  assert.equal(res.status, 409);
});

test('GET /items/next-code 400 when location has no default type and none provided', async () => {
  reset();
  seedLocation('NUL', null);
  const res = await getNextCode({ location: 'NUL' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /type_id required/);
});

test('GET /items/next-code uses explicit type_id when provided', async () => {
  reset();
  seedItemType('type-explicit', 'DRX-EX-{locationCode}-{counter:03}');
  seedLocation('ZZZ', null);
  seedCounter('type-explicit', 'ZZZ', 7);

  const res = await getNextCode({ location: 'ZZZ', type_id: 'type-explicit' });
  assert.equal(res.status, 200);
  assert.equal(res.body.unit_code, 'DRX-EX-ZZZ-007');
});
