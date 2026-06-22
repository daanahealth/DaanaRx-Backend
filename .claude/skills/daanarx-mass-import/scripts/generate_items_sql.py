#!/usr/bin/env python3
"""
From enrich_mass_items.mjs output (items_load.json), emit SQL to load the core
`items` schema via a staging table. Three files:
  items_01_stage.sql  CREATE _items_stg + INSERT rows (the big one)
  items_02_load.sql   upsert locations, insert items (unit_code + attributes
                      built in SQL), seed code_counters, verify, drop staging

Run the staged INSERT, sanity-check count/sum, then run the load.
"""
import argparse, json, os

TYPE_ID = "98d7c841-3ed7-47bb-8263-7ec435ff0efc"   # item_types.name='medication'
CLINIC = "f6e0c90c-1d7a-4257-a11f-bd1da860bcd2"


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("items_json")
    ap.add_argument("--outdir", default=".")
    args = ap.parse_args()
    d = json.load(open(args.items_json))
    recs, locs = d["records"], d["locations"]

    # staging
    expiry = recs[0]["expiry_date"] if recs else "2099-12-31"
    src = d.get("source", "import")
    rows = []
    for r in recs:
        a = r["attributes"]
        rows.append("  (" + ", ".join([
            q(r["location_code"]), q(a["medication_name"]), q(a["dosage"]),
            q(a["unit"]), q(a["form"]), q(a["specialty_class"]),
            str(a["quantity"]),
            "true" if a.get("supervisor_acknowledged") else "false",
        ]) + ")")
    stage = ("DROP TABLE IF EXISTS _items_stg;\n"
             "CREATE TABLE _items_stg (location_code text, med text, dosage text, unit text,"
             " form text, specialty_class text, qty int, sup_ack bool);\n"
             "INSERT INTO _items_stg (location_code, med, dosage, unit, form, specialty_class, qty, sup_ack) VALUES\n"
             + ",\n".join(rows) + ";\n"
             "SELECT count(*) rows, sum(qty) total_qty, count(DISTINCT location_code) locs FROM _items_stg;\n")
    open(os.path.join(args.outdir, "items_01_stage.sql"), "w").write(stage)

    # locations upsert (small)
    locvals = ",\n".join(f"  ({q(l['code'])}, {q(l['specialty_class'])})" for l in locs)
    load = f"""BEGIN;
-- 1. Create v2 locations (one per bin). NOTE: locations.id/code/specialty are
-- GENERATED columns (id=location_id, code=name, specialty=temp), so only set
-- name (=the code) + temp. code is globally UNIQUE -> skip codes that exist.
INSERT INTO locations (name, temp, clinic_id, capacity, item_type_id)
SELECT v.code, 'room temp', {q(CLINIC)}::uuid, 100, {q(TYPE_ID)}::uuid
FROM (VALUES
{locvals}
) AS v(code, cls)
WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.code = v.code);

-- 2. Insert items. unit_code = DRX-MASS-{{CODE}}-{{00001}} (counter per location).
WITH numbered AS (
  SELECT s.*, row_number() OVER (PARTITION BY s.location_code ORDER BY s.med, s.dosage, s.unit) AS n
  FROM _items_stg s
)
INSERT INTO items (id, type_id, status, location_id, expiry_date, unit_code, attributes, created_by)
SELECT gen_random_uuid(), {q(TYPE_ID)}::uuid, 'active', loc.id, {q(expiry)}::date,
       'DRX-MASS-' || n.location_code || '-' || lpad(n.n::text, 5, '0'),
       jsonb_strip_nulls(jsonb_build_object(
         'medication_name', n.med, 'dosage', n.dosage, 'unit', n.unit, 'form', n.form,
         'specialty_class', n.specialty_class, 'quantity', n.qty,
         'notes', 'Imported from {src} (' || n.form || ')',
         'supervisor_acknowledged', CASE WHEN n.sup_ack THEN true ELSE NULL END)),
       NULL
FROM numbered n JOIN locations loc ON loc.code = n.location_code;

-- 3. Seed per-location code counters so future check-ins continue past these.
INSERT INTO code_counters (item_type_id, location_code, next_value)
SELECT {q(TYPE_ID)}::uuid, location_code, count(*) + 1 FROM _items_stg GROUP BY location_code
ON CONFLICT (item_type_id, location_code) DO UPDATE SET next_value = EXCLUDED.next_value;

DROP TABLE _items_stg;
COMMIT;

SELECT (SELECT count(*) FROM items) items,
       (SELECT sum((attributes->>'quantity')::int) FROM items) total_qty,
       (SELECT count(*) FROM items WHERE status='active') active,
       (SELECT count(DISTINCT location_id) FROM items) locations;
"""
    open(os.path.join(args.outdir, "items_02_load.sql"), "w").write(load)
    print(f"items={len(recs)} locations={len(locs)} -> items_01_stage.sql, items_02_load.sql")


if __name__ == "__main__":
    main()
