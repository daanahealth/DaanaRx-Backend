// Unit test for the items API's enforcement of the platform state machine.
// This test covers the *state-machine* contract, not the route handlers
// (handlers wrap assertTransition + return 409). Integration tests against
// Supabase are deferred until migration 002 is applied.

import {
  assertTransition,
  InvalidStatusTransitionError,
  canTransition,
} from '@daana-health/inventory-core';
import type { ItemStatus } from '@daana-health/inventory-core';

describe('items API — state machine enforcement', () => {
  describe('assertTransition (allowed)', () => {
    test('active -> in_cart', () => {
      expect(() => assertTransition('active', 'in_cart')).not.toThrow();
    });
    test('active -> pending_approval', () => {
      expect(() => assertTransition('active', 'pending_approval')).not.toThrow();
    });
    test('active -> checked_out', () => {
      expect(() => assertTransition('active', 'checked_out')).not.toThrow();
    });
    test('active -> removed', () => {
      expect(() => assertTransition('active', 'removed')).not.toThrow();
    });
    test('active -> expired', () => {
      expect(() => assertTransition('active', 'expired')).not.toThrow();
    });
    test('in_cart -> active (cart cleared)', () => {
      expect(() => assertTransition('in_cart', 'active')).not.toThrow();
    });
    test('pending_approval -> checked_out (approved)', () => {
      expect(() => assertTransition('pending_approval', 'checked_out')).not.toThrow();
    });
    test('expired -> removed (superadmin confirms removal)', () => {
      expect(() => assertTransition('expired', 'removed')).not.toThrow();
    });
    test('expired -> checked_out (superadmin override)', () => {
      expect(() => assertTransition('expired', 'checked_out')).not.toThrow();
    });
  });

  describe('assertTransition (blocked)', () => {
    test('checked_out is terminal', () => {
      const targets: ItemStatus[] = [
        'active',
        'in_cart',
        'pending_approval',
        'removed',
        'expired',
      ];
      for (const t of targets) {
        expect(() => assertTransition('checked_out', t)).toThrow(InvalidStatusTransitionError);
      }
    });
    test('removed is terminal', () => {
      const targets: ItemStatus[] = [
        'active',
        'in_cart',
        'pending_approval',
        'checked_out',
        'expired',
      ];
      for (const t of targets) {
        expect(() => assertTransition('removed', t)).toThrow(InvalidStatusTransitionError);
      }
    });
    test('identity transitions rejected', () => {
      const all: ItemStatus[] = [
        'active',
        'in_cart',
        'pending_approval',
        'checked_out',
        'removed',
        'expired',
      ];
      for (const s of all) {
        expect(() => assertTransition(s, s)).toThrow(InvalidStatusTransitionError);
      }
    });
    test('in_cart cannot jump straight to expired', () => {
      expect(() => assertTransition('in_cart', 'expired')).toThrow(InvalidStatusTransitionError);
    });
    test('pending_approval cannot jump to expired', () => {
      expect(() => assertTransition('pending_approval', 'expired')).toThrow(
        InvalidStatusTransitionError,
      );
    });
  });

  describe('canTransition mirrors assertTransition', () => {
    test('returns true for allowed pairs', () => {
      expect(canTransition('active', 'removed')).toBe(true);
      expect(canTransition('expired', 'removed')).toBe(true);
    });
    test('returns false for blocked pairs (including identity)', () => {
      expect(canTransition('active', 'active')).toBe(false);
      expect(canTransition('removed', 'active')).toBe(false);
      expect(canTransition('checked_out', 'active')).toBe(false);
    });
  });
});

describe('items API — soft-delete contract (static check)', () => {
  // This is a sanity check that the items.ts route file does not contain any
  // hard-delete SQL against the items table. We intentionally read the source
  // file and pattern-match — cheap and high-signal.
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const routePath = path.join(__dirname, 'items.ts');
  const src = fs.readFileSync(routePath, 'utf8');

  // Strip line/block comments before regex-checking — we want to assert on
  // actual code, not on comments that legitimately mention "DELETE FROM items"
  // when documenting the soft-delete contract.
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  const code = stripComments(src);

  test('no DELETE FROM items in route source', () => {
    expect(code).not.toMatch(/delete\s+from\s+items/i);
  });
  test("no supabase .from('items').delete() in route source", () => {
    expect(code).not.toMatch(/from\(\s*['"]items['"]\s*\)\s*\.delete/);
  });
  test('every mutation handler calls insertTransaction', () => {
    // crude but effective: count distinct handler bodies and require at least
    // one insertTransaction call for each mutation method.
    const checkin = src.indexOf("router.post('/', requireAuth");
    const patch = src.indexOf("router.patch('/:id'");
    const remove = src.indexOf("router.post('/:id/remove'");
    const end = src.length;
    expect(checkin).toBeGreaterThan(-1);
    expect(patch).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(-1);
    // each handler body must include an insertTransaction call.
    const sections = [
      src.slice(checkin, patch),
      src.slice(patch, remove),
      src.slice(remove, end),
    ];
    for (const sec of sections) {
      expect(sec).toMatch(/insertTransaction\s*\(/);
    }
  });
});
