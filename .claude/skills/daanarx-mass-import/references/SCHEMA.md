# DaanaRX `items` core schema (migration 002_core_inventory_platform.sql)

Single-tenant (no `clinic_id`). DDL summary:

## item_types
- `id` uuid PK
- `name` text NOT NULL UNIQUE  — live MASS type is `medication` (verify; tests use `MASS`)
- `code_format_template` text NOT NULL — e.g. `DRX-MASS-{LOCATION}-{counter:05d}`
- `attribute_schema` jsonb NOT NULL DEFAULT `{}`

Template vars rendered by `renderCodeTemplate`: `{LOCATION}`/`{locationCode}`,
`{TYPE}`/`{itemTypeName}`, `{counter:05d}` (zero-padded). Result e.g.
`DRX-MASS-CARDIO1-00042`.

## locations
- `id` uuid PK
- `code` text NOT NULL UNIQUE  — no spaces, uppercase (e.g. `CARDIO1`, `NSAID1`)
- `specialty` text  — human label hint
- `capacity` int NOT NULL DEFAULT 50 CHECK (capacity > 0)
- `item_type_id` uuid → item_types (ON DELETE RESTRICT)
- `deactivated_at` timestamptz, `created_at` timestamptz

## items
- `id` uuid PK
- `type_id` uuid NOT NULL → item_types (RESTRICT)
- `status` item_status NOT NULL DEFAULT `active`
  — enum: `active | in_cart | pending_approval | checked_out | removed | expired`
- `location_id` uuid → locations (RESTRICT)
- `expiry_date` date NULL
- `unit_code` text NOT NULL UNIQUE
- `attributes` jsonb NOT NULL DEFAULT `{}`
  — MASS medication attrs: `medication_name, dosage, unit, form, quantity,
    notes`; this importer also stores `lot_codes`, `source_ids`, `source_file`
- `created_at`, `created_by` (→auth.users SET NULL), `last_edited_*`, `removed_*`

## transactions (core)
- `id`, `item_id` NOT NULL → items (**RESTRICT** — must delete before items),
  `action` enum (`check_in|check_out|edit|remove|cart_approved|cart_rejected|expired_override`),
  `actor_id`, `old_value` jsonb, `new_value` jsonb, `reason`, `note`, `created_at`

## carts / cart_items
- `cart_items.item_id` → items (**RESTRICT** — delete before items)

## code_counters
- PK (`item_type_id`, `location_code`), `next_value` int >= 1
- RPC `increment_code_counter(p_type_id, p_location_code)` atomically returns+bumps.

## Delete order (FKs are ON DELETE RESTRICT)
`cart_items` → `transactions` → `items` (→ optionally `code_counters`).

## Live deployment
- Gateway (consolidated monolith): `https://daanahealth-gateway.onrender.com`
- Supabase project ref: `cnjajswnqmzzhzoyadqa` (URL `https://cnjajswnqmzzhzoyadqa.supabase.co`)
