---
name: daanarx-mass-import
description: Import a MASS clinic medication data export (.xlsx or .csv) into the DaanaRX Supabase database so it appears in the app's Inventory. Use when the user wants to load, update, refresh, or re-ingest MASS clinic inventory from a spreadsheet ("update Mass clinic data", "import this CSV", "new clinic data export", "ingest the DRX-DATA file", "I don't see the data in inventory"). Parses + normalizes the messy export, fixes medication-name typos, aggregates by bin with quantity = count of repeats, classifies + shapes each item via the @daana-health/domain-mass npm package, then loads into the core `items` schema via the Supabase MCP.
---

> 🧭 Routing / where-to-start / cross-repo work: see the **daana-engineer** skill — it decomposes the ask and delegates to the right skill.

# DaanaRX MASS data import

Turns a clinic's raw medication export into DaanaRX inventory the app actually
shows. The live MASS app (`daanahealth-gateway`) reads the **core `items`
schema** via `GET /inventory/items` — NOT the legacy `units` schema. Loading
`units` will NOT appear in the Inventory page. Always target `items`.

## Source data

Each data sheet/file has **no header**, six columns:
`lot_code, specialty_label, medication, strength, unit, 8-digit-id`.
An `.xlsx` has one sheet per type (`DATA-CARDS`→Card, `DATA-BOTTLES`→Bottle,
`DATA-PSYCH`) + reference sheets `SPECIALTY LOCATION` / `MAP`.

## Target = `items` core schema (single-tenant)

- `item_types.name='medication'` — id `98d7c841-3ed7-47bb-8263-7ec435ff0efc`,
  code template `DRX-MASS-{LOCATION}-{counter:05d}`. **Verify the id each run.**
- The MASS attribute schema is defined by **`@daana-health/domain-mass`** (in the
  `daana-inventory` monorepo). Required `attributes`: `medication_name, dosage,
  unit, form, specialty_class`. `form` MUST be in MEDICATION_FORMS
  (Bottle/Card/Cream/Nasal Spray/Insulin Pen/Injection/Other — **"Psych" is not
  a form**; map the Psych sheet to "Other"). `specialty_class` MUST be a
  classification-guide class (CARDIO, PAINFLAM, GASTRO, NEURO, UROL, ENDOCRINE,
  PSYCH, INFECT, VITSUP, …). High-risk classes (PSYCH/NEURO/NEPHRO/SLEEP/Hold)
  set `supervisor_acknowledged: true`.
- `items.expiry_date` is required for medications; donor stock w/o expiry → the
  domain fallback **10 years forward** from today.
- `locations.id`, `.code`, `.specialty` are **GENERATED columns**
  (id=location_id, code=name, specialty=temp). Insert only `name` (=the bin code,
  e.g. `CARDIO1`) + `temp='room temp'`. `code` is globally UNIQUE → skip codes
  that already exist (`WHERE NOT EXISTS`), don't `ON CONFLICT (code)`.

## The real MASS clinic

There are several MASS-named clinics (dev clones). The legacy `units` rows are
clinic-scoped; the core `items` schema is single-tenant (no clinic_id) so every
active item shows in the one app. Real clinic = `kim@massclinic.org`
(`f6e0c90c-1d7a-4257-a11f-bd1da860bcd2`, superadmin user
`24b5d2b2-b27f-4316-b48e-f0ad7d71fe3d`). Re-verify ids each run.

## Procedure (items pipeline)

1. **Aggregate + typo-fix** (Python, needs `openpyxl`):
   ```bash
   python3 scripts/aggregate_for_items.py "<INPUT.xlsx>" --out <WORK>/agg_rows.json
   ```
   Aggregates per (form, bin, medication, dosage, unit), quantity = count;
   corrects medication-name typos (Methocarbamol, Escitalopram, Amantadine, …).
2. **Classify + shape via the package** (Node, run from the `daana-inventory`
   monorepo so the workspace packages resolve; if `node_modules/@daana-health`
   is missing, `ln -s` the two packages or `pnpm install`):
   ```bash
   node scripts/enrich_mass_items.mjs <WORK>/agg_rows.json <WORK>/items_load.json
   ```
   Imports `@daana-health/domain-mass` (MEDICATION_FORMS, classification guide,
   suggestLocationForClass, DRX template) + `inventory-core` (renderCodeTemplate)
   to set specialty_class, validate form, and render each `unit_code`.
3. **Generate SQL**:
   ```bash
   python3 scripts/generate_items_sql.py <WORK>/items_load.json --outdir <WORK>
   ```
   → `items_01_stage.sql` (staging INSERT) + `items_02_load.sql` (locations +
   items + counters, with `notes`/`expiry` built in SQL).
4. **Load via Supabase MCP** (`execute_sql`): confirm `items`/`active` counts
   first; if existing test items sit in MASS locations, delete them (+ their
   `cart_items` and `transactions` rows — `cart_items.item_id` is the only hard
   FK). Run `items_01_stage.sql`, check `count(*)/sum(qty)`, then
   `items_02_load.sql`. Verify `items` count == record count and `total_qty` ==
   source physical-row count.
5. **Confirm in-app** as `kim@massclinic.org` (the inventory page caps results;
   default limit 50, max 200 — that's pagination, not missing data).

## Legacy `units` path (secondary)

`generate_legacy_load_compact.py` loads the same data into the clinic-scoped
legacy `units`/`drugs`/`lots` schema (per-lot, matching the old CSV_IMPORT seed).
Only needed if something still reads `units`. Gotchas: `drugs.strength`,
`.strength_unit`, `.ndc_id` all NOT NULL; `ndc_id` UNIQUE → `'PRELIM-<16hex>'`;
`lots` has no lot_code (use `source`/`note`); `units.expiry_date` NOT NULL →
`'2099-12-31'`.

## Connectivity

This env can't DNS-resolve `*.supabase.co` directly — use the Supabase MCP
`execute_sql`. A just-resumed (free-tier) project may read empty mid-restore;
re-query. Confirm which project prod uses via Render gateway logs
(`mcp__render__list_logs`, text=`supabase`). Gateway:
`https://daanahealth-gateway.onrender.com` (`srv-d8i9dij7uimc73ahc1v0`),
Supabase project `cnjajswnqmzzhzoyadqa`. See `references/SCHEMA.md`.
