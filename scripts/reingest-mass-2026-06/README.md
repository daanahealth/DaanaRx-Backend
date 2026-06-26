# MASS clinic re-ingestion — 2026-06 export

Full-replace load of the MASS clinic's inventory from the new `DRX-DATA` export,
**preserving the clinic's already-assigned 8-char codes** so physical units stay
findable. Loads **unit-level** (1 row = 1 physical unit, `quantity` 1).

- **Clinic:** `f6e0c90c-1d7a-4257-a11f-bd1da860bcd2` ("MASS Clinic", kim@massclinic.org)
- **Item type:** `98d7c841-…` (`medication`)
- **Result:** 1,760 items across 27 specialty bins (CARDS 686 + PSYCH 314 + BOTTLES 760).

## What the SQL does (`reingest.sql`, transactional)
1. Upserts the 27 specialty-bin `locations` (lot # → specialty via the SPECIALTY
   LOCATION sheet; lot is **not** stored as a user field).
2. Deletes the clinic's current items (FK order: `cart_items` → `transactions` → `items`).
3. Inserts 1,760 items with `unit_code = DRX-MASS-<their id>` (verbatim).
4. Resets `code_counters` for the clinic so future check-ins start clean.
5. `SELECT count(*)` sanity check, then `COMMIT`.

## Run it (via Supabase MCP / SQL editor — NOT auto-run)
This is a destructive production change. Run deliberately:

1. **Verify** `CLINIC_ID` / `MASS_TYPE_ID` in `generate.py` against the live DB.
2. **Back up** (snapshot the clinic's `items`/`locations` or take a PITR marker).
3. Paste `reingest.sql` into the Supabase SQL editor **or** run via
   `mcp__supabase__execute_sql`. It is wrapped in `BEGIN … COMMIT`.
4. Before the `COMMIT`, confirm the `inserted` count ≈ **1760**. If anything looks
   off, `ROLLBACK`.

## Regenerate
```bash
python3 generate.py --data-dir "/path/to/DRX-DATA csvs" --out reingest.sql
```

## Caveats / follow-ups
- **Medication names are loaded verbatim** (UPPERCASE, clinic spellings) — typos
  like `METROPROL`, `MIDORINE`, `MDTHOCARBAMOL` are **not** fixed here. Run the
  `daanarx-mass-import` normalization afterward if you want them cleaned.
- **`code` is globally unique** in the schema. The 27 codes are upserted with
  `ON CONFLICT (code) DO NOTHING`; if a code is owned by a *different* clinic the
  item lookup returns null and the transaction fails safely (rollback) — adjust
  the location strategy if that happens.
- Future check-ins use the new specialty-based template (see DaanaRx-Backend
  PR for `migrations/003` + the engine PR daana-inventory#2). These preserved
  codes don't follow the counter pattern, so they won't collide with future
  generated codes.
- Sides (L/R, A–D) are intentionally dropped — location is the bare specialty bin.
