// Unit tests for the @daana-health/inventory-core engine (the vendored build
// the backend actually ships). Pure logic, no I/O. Run with:
//   node --test tests/engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../vendor/inventory-core');

const {
  compareFEFO, sortFEFO,
  assertTransition, canTransition, allowedTransitions,
  isActiveStatus, isTerminalStatus, isSearchableForRestrictedUser, InvalidStatusTransitionError,
  renderCodeTemplate, createTemplateCodeGenerator, CodeTemplateError,
  ValidatorRegistry, ok, fail,
} = core;

// ---------------------------------------------------------------- FEFO
test('FEFO: earliest expiry first', () => {
  const a = { expiryDate: '2027-01-01', createdAt: '2026-01-01', unitCode: 'A' };
  const b = { expiryDate: '2026-06-01', createdAt: '2026-01-01', unitCode: 'B' };
  assert.ok(compareFEFO(a, b) > 0);
  assert.ok(compareFEFO(b, a) < 0);
});

test('FEFO: null expiry sorts last', () => {
  const dated = { expiryDate: '2030-01-01', createdAt: '2026-01-01', unitCode: 'A' };
  const undated = { expiryDate: null, createdAt: '2026-01-01', unitCode: 'B' };
  assert.ok(compareFEFO(undated, dated) > 0, 'undated after dated');
  assert.ok(compareFEFO(dated, undated) < 0, 'dated before undated');
});

test('FEFO: tiebreak created_at then unit_code', () => {
  const e = '2027-01-01';
  const a = { expiryDate: e, createdAt: '2026-02-01', unitCode: 'Z' };
  const b = { expiryDate: e, createdAt: '2026-03-01', unitCode: 'A' };
  assert.ok(compareFEFO(a, b) < 0, 'earlier created_at wins');
  const c = { expiryDate: e, createdAt: '2026-02-01', unitCode: 'A' };
  assert.ok(compareFEFO(c, a) < 0, 'unit_code lexicographic tiebreak');
});

test('FEFO: sortFEFO produces full order and does not mutate input', () => {
  const items = [
    { expiryDate: null, createdAt: '2026-01-01', unitCode: 'N' },
    { expiryDate: '2026-09-15', createdAt: '2026-02-11', unitCode: 'B' },
    { expiryDate: '2026-03-01', createdAt: '2026-05-10', unitCode: 'A' },
  ];
  const copy = JSON.parse(JSON.stringify(items));
  const sorted = sortFEFO(items);
  assert.deepEqual(sorted.map((i) => i.unitCode), ['A', 'B', 'N']);
  assert.deepEqual(items, copy, 'input unchanged');
});

// ------------------------------------------------------ status machine
test('status: valid transitions from active', () => {
  for (const to of ['in_cart', 'pending_approval', 'checked_out', 'removed', 'expired']) {
    assert.doesNotThrow(() => assertTransition('active', to));
    assert.equal(canTransition('active', to), true);
  }
});

test('status: terminal states have no exits', () => {
  assert.deepEqual([...allowedTransitions.checked_out], []);
  assert.deepEqual([...allowedTransitions.removed], []);
  assert.equal(canTransition('checked_out', 'active'), false);
  assert.throws(() => assertTransition('removed', 'active'), InvalidStatusTransitionError);
});

test('status: identity transition is rejected', () => {
  assert.equal(canTransition('active', 'active'), false);
  assert.throws(() => assertTransition('active', 'active'), InvalidStatusTransitionError);
});

test('status: expired can recover to checked_out or removed only', () => {
  assert.equal(canTransition('expired', 'checked_out'), true);
  assert.equal(canTransition('expired', 'removed'), true);
  assert.equal(canTransition('expired', 'active'), false);
});

test('status: predicates', () => {
  assert.equal(isActiveStatus('active'), true);
  assert.equal(isActiveStatus('in_cart'), true);
  assert.equal(isActiveStatus('checked_out'), false);
  assert.equal(isTerminalStatus('removed'), true);
  assert.equal(isTerminalStatus('active'), false);
  assert.equal(isSearchableForRestrictedUser('active'), true);
  assert.equal(isSearchableForRestrictedUser('in_cart'), false);
});

// ----------------------------------------------------- code generation
const ctx = (over = {}) => ({ itemTypeId: 't', itemTypeName: 'medication', locationCode: 'CARDIO1', counter: 42, attributes: {}, ...over });

test('code: DRX-MASS Option 1 format with zero padding', () => {
  assert.equal(renderCodeTemplate('DRX-MASS-{LOCATION}-{counter:05d}', ctx()), 'DRX-MASS-CARDIO1-00042');
});

test('code: {TYPE} and bare {counter}', () => {
  assert.equal(renderCodeTemplate('{TYPE}-{counter}', ctx({ counter: 7 })), 'medication-7');
});

test('code: {attr.x} substitution', () => {
  assert.equal(renderCodeTemplate('X-{attr.specialty_code}', ctx({ attributes: { specialty_code: 'CD' } })), 'X-CD');
});

test('code: unknown placeholder throws CodeTemplateError', () => {
  assert.throws(() => renderCodeTemplate('a-{OOPS}', ctx()), CodeTemplateError);
});

test('code: missing attribute throws CodeTemplateError', () => {
  assert.throws(() => renderCodeTemplate('a-{attr.missing}', ctx()), CodeTemplateError);
});

test('code: createTemplateCodeGenerator returns a working generator', () => {
  const gen = createTemplateCodeGenerator('DRX-MASS-{LOCATION}-{counter:05d}');
  assert.equal(gen.format, 'DRX-MASS-{LOCATION}-{counter:05d}');
  assert.equal(gen.generate(ctx({ counter: 1 })), 'DRX-MASS-CARDIO1-00001');
});

// -------------------------------------------------------- validators
test('validators: registry aggregates issues and short-circuits nothing', () => {
  const reg = new ValidatorRegistry();
  reg.register('medication', (item) => (item.expiryDate ? ok : fail({ path: 'expiryDate', message: 'required' })));
  reg.register('medication', (item) => (item.unitCode ? ok : fail({ path: 'unitCode', message: 'required' })));
  const bad = reg.validate('medication', { expiryDate: null, unitCode: '' });
  assert.equal(bad.ok, false);
  assert.equal(bad.issues.length, 2);
  const good = reg.validate('medication', { expiryDate: '2030-01-01', unitCode: 'X' });
  assert.equal(good.ok, true);
  assert.equal(good.issues.length, 0);
});

test('validators: unknown type returns no issues', () => {
  const reg = new ValidatorRegistry();
  assert.deepEqual(reg.validate('unknown', {}), { ok: true, issues: [] });
});
