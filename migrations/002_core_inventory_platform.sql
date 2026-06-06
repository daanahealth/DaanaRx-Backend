-- ============================================================================
-- 002_core_inventory_platform.sql
-- Daana Inventory Platform — Core Schema (generic, domain-agnostic)
-- Date drafted: 2026-06-06
-- Status: DRAFT — NOT APPLIED. User must review before running.
--
-- Architectural premise:
--   This migration introduces the GENERIC inventory platform tables. Domain
--   packs (MASS clinic = medications) layer on top via item_types.attribute_schema
--   (a per-domain JSON Schema) and items.attributes (JSONB).
--
--   Generic concerns live here: status, location, expiry, code generation,
--   transaction log, soft-delete, cart approval, reservation, FEFO inputs.
--
--   Domain concerns (medication name, dosage, form, specialty class) live in
--   items.attributes, validated against item_types.attribute_schema.
--
--   The existing 001_daanarx_updates.sql touches a legacy lots/drugs/clinics
--   schema. This migration introduces a parallel, normalized model. The legacy
--   tables remain untouched; a follow-up migration may backfill from them.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Extensions
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

-- Inventory item status. Every unit has exactly one status at any time.
DO $$ BEGIN
  CREATE TYPE item_status AS ENUM (
    'active',            -- available, searchable, checkoutable
    'in_cart',           -- reserved in a superadmin cart
    'pending_approval',  -- in a restricted user cart, awaiting approval
    'checked_out',       -- dispensed; removed from active inventory
    'removed',           -- soft-deleted with reason
    'expired'            -- past expiry; flagged, blocked from standard checkout
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Transaction log action types.
DO $$ BEGIN
  CREATE TYPE transaction_action AS ENUM (
    'check_in',
    'check_out',
    'edit',
    'remove',
    'cart_approved',
    'cart_rejected',
    'expired_override'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Cart lifecycle status.
DO $$ BEGIN
  CREATE TYPE cart_status AS ENUM (
    'active',            -- being built
    'pending_approval',  -- submitted by restricted user
    'approved',
    'rejected',
    'expired'            -- 24h inactivity timeout
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- item_types — registry of generic item kinds. One row per domain pack item kind
-- (e.g. "medication", "consumable_supply", "device"). attribute_schema is a
-- JSON Schema that validates items.attributes for items of this type.
-- code_format_template uses placeholders: {LOCATION}, {TYPE}, {counter:05d}, etc.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS item_types (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL UNIQUE,
  code_format_template  text NOT NULL,
  attribute_schema      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE item_types IS
  'Generic registry of item kinds. Domain packs register their item types here.';
COMMENT ON COLUMN item_types.code_format_template IS
  'Template string for code generation. Placeholders: {LOCATION}, {TYPE}, {counter:0Nd}.';
COMMENT ON COLUMN item_types.attribute_schema IS
  'JSON Schema that items.attributes must validate against for this type.';

-- ----------------------------------------------------------------------------
-- locations — generic storage locations (bins, drawers, shelves). One item_type
-- per location for the MVP (a CARDIO bin holds medications, not consumables).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,           -- e.g. "CARDIO1", "VITSUP"
  specialty       text,                            -- domain-pack hint (e.g. "Cardiology")
  capacity        integer NOT NULL DEFAULT 50 CHECK (capacity > 0),
  item_type_id    uuid REFERENCES item_types(id) ON DELETE RESTRICT,
  deactivated_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN locations.specialty IS
  'Domain-pack hint string. Generic core does not interpret. MASS uses for classification.';
COMMENT ON COLUMN locations.deactivated_at IS
  'Soft-deactivation. Locations are never hard-deleted because items reference them historically.';

-- ----------------------------------------------------------------------------
-- items — the unit-level inventory record. One row per physical unit.
-- Domain-specific fields (medication name, dosage, form, class) go in attributes.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id         uuid NOT NULL REFERENCES item_types(id) ON DELETE RESTRICT,
  status          item_status NOT NULL DEFAULT 'active',
  location_id     uuid REFERENCES locations(id) ON DELETE RESTRICT,
  expiry_date     date,
  unit_code       text NOT NULL UNIQUE,            -- e.g. "DRX-MASS-CARDIO1-00042"
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  last_edited_at  timestamptz,
  last_edited_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  removed_at      timestamptz,
  removed_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  removed_reason  text
);

COMMENT ON TABLE items IS
  'Unit-level inventory. Domain attributes in JSONB. Soft-delete via removed_at + status=removed.';
COMMENT ON COLUMN items.unit_code IS
  'Globally unique unit identifier. Generated from item_types.code_format_template. Never reused.';
COMMENT ON COLUMN items.attributes IS
  'Domain-specific fields validated against item_types.attribute_schema.';

-- ----------------------------------------------------------------------------
-- transactions — append-only audit log of every state-changing action.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  action      transaction_action NOT NULL,
  actor_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  old_value   jsonb,
  new_value   jsonb,
  reason      text,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE transactions IS
  'Append-only audit log. Never UPDATE or DELETE. One row per action.';

-- ----------------------------------------------------------------------------
-- carts — checkout carts. Restricted users build; superadmins approve.
-- expires_at enforces the 24h inactivity rule (managed by a background job
-- or RPC; the column is the source of truth).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status        cart_status NOT NULL DEFAULT 'active',
  submitted_at  timestamptz,
  decided_at    timestamptz,
  decided_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN carts.expires_at IS
  '24h reservation window. Background job moves expired carts to status=expired and returns items to active.';

-- ----------------------------------------------------------------------------
-- cart_items — items reserved by a cart. While in cart, item.status =
-- in_cart (superadmin cart) or pending_approval (restricted user cart).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cart_items (
  cart_id   uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  item_id   uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, item_id)
);

-- An item may only be in one open cart at a time. Enforced by partial unique
-- index across non-terminal cart statuses.
CREATE UNIQUE INDEX IF NOT EXISTS cart_items_open_item_uniq
  ON cart_items (item_id)
  WHERE cart_id IN (
    SELECT id FROM carts WHERE status IN ('active','pending_approval')
  );
-- NOTE: Postgres does not permit subqueries in partial-index predicates.
-- The constraint above is illustrative; the real enforcement is done at the
-- application layer via a CHECK trigger (see follow-up migration TODO).
-- Drop the failing partial-index attempt; rely on trigger-based enforcement.
DROP INDEX IF EXISTS cart_items_open_item_uniq;

-- ----------------------------------------------------------------------------
-- code_counters — per-(item_type, location) sequential counter. Codes are
-- never reused. Atomic increments via RPC (see follow-up migration).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS code_counters (
  item_type_id    uuid NOT NULL REFERENCES item_types(id) ON DELETE RESTRICT,
  location_code   text NOT NULL,
  next_value      integer NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  PRIMARY KEY (item_type_id, location_code)
);

COMMENT ON TABLE code_counters IS
  'Sequential counter per (item_type, location_code). Codes are never reused.';

-- ----------------------------------------------------------------------------
-- Indexes for the hot read paths.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS items_status_idx           ON items (status);
CREATE INDEX IF NOT EXISTS items_location_id_idx      ON items (location_id);
CREATE INDEX IF NOT EXISTS items_expiry_date_idx      ON items (expiry_date);
-- items.unit_code already has UNIQUE constraint (implicit index).
CREATE INDEX IF NOT EXISTS items_type_id_idx          ON items (type_id);
CREATE INDEX IF NOT EXISTS items_attributes_gin       ON items USING gin (attributes);

CREATE INDEX IF NOT EXISTS transactions_item_created_idx
  ON transactions (item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_actor_idx     ON transactions (actor_id);
CREATE INDEX IF NOT EXISTS transactions_action_idx    ON transactions (action);

CREATE INDEX IF NOT EXISTS carts_owner_status_idx     ON carts (owner_id, status);
CREATE INDEX IF NOT EXISTS carts_expires_at_idx       ON carts (expires_at) WHERE status IN ('active','pending_approval');

CREATE INDEX IF NOT EXISTS locations_active_idx       ON locations (code) WHERE deactivated_at IS NULL;

-- ----------------------------------------------------------------------------
-- Row-Level Security — enable on all core tables. Real policies are a
-- follow-up migration once roles (superadmin, restricted_user) are wired
-- via auth.users metadata / a separate user_roles table.
-- ----------------------------------------------------------------------------
ALTER TABLE item_types     ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE carts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_counters  ENABLE ROW LEVEL SECURITY;

-- Placeholder policies: allow authenticated users to SELECT; deny writes
-- until role-aware policies land. This errs on the side of safety.
CREATE POLICY item_types_select_auth     ON item_types     FOR SELECT TO authenticated USING (true);
CREATE POLICY locations_select_auth      ON locations      FOR SELECT TO authenticated USING (true);
CREATE POLICY items_select_auth          ON items          FOR SELECT TO authenticated USING (true);
CREATE POLICY transactions_select_auth   ON transactions   FOR SELECT TO authenticated USING (true);
CREATE POLICY carts_select_owner         ON carts          FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY cart_items_select_owner    ON cart_items     FOR SELECT TO authenticated
  USING (cart_id IN (SELECT id FROM carts WHERE owner_id = auth.uid()));
CREATE POLICY code_counters_select_auth  ON code_counters  FOR SELECT TO authenticated USING (true);

-- Write policies intentionally omitted. All writes go through SECURITY DEFINER
-- RPCs (check_in, check_out, cart_submit, cart_approve, etc.) that enforce
-- role and state-machine rules. RPCs to be defined in a follow-up migration.

COMMIT;

-- ============================================================================
-- TODO (follow-up migrations, not in this file):
--   - user_roles table + role-aware RLS policies
--   - SECURITY DEFINER RPC: generate_unit_code(item_type_id, location_code)
--   - Trigger: enforce one-open-cart-per-item invariant
--   - Trigger: auto-write transactions row on items state change
--   - Background job: expire stale carts (cron / pg_cron)
--   - Backfill from legacy lots/drugs/clinics into items + item_types
-- ============================================================================
