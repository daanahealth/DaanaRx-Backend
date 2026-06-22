#!/usr/bin/env python3
"""
Turn parser output (mass_items_load.json + locations.csv) into idempotent SQL
for the DaanaRX `items` core schema. Emits three files into --outdir:

  01_inspect.sql   counts BEFORE touching anything (run first, eyeball)
  02_delete.sql    hard-delete existing MASS items (+ dependent rows; FKs RESTRICT)
  03_load.sql      ensure item_type, upsert locations, insert items, bump counters

The core schema is single-tenant (no clinic_id), so "MASS items" == all rows in
`items`. Run each file via the Supabase MCP execute_sql, in order, reviewing 01
before running 02/03.
"""
import argparse, csv, json, os

TYPE_NAME = "medication"
TEMPLATE = "DRX-MASS-{LOCATION}-{counter:05d}"


def sql_str(s):
    return "'" + str(s).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--indir", default=".")
    ap.add_argument("--outdir", default=".")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    data = json.load(open(os.path.join(args.indir, "mass_items_load.json")))
    records = data["records"]
    locs = list(csv.DictReader(open(os.path.join(args.indir, "locations.csv"))))

    # 01 inspect
    with open(os.path.join(args.outdir, "01_inspect.sql"), "w") as f:
        f.write(
            "-- Inspect current core-schema state BEFORE any change.\n"
            "SELECT 'item_types' t, count(*) FROM item_types\n"
            "UNION ALL SELECT 'locations', count(*) FROM locations\n"
            "UNION ALL SELECT 'items', count(*) FROM items\n"
            "UNION ALL SELECT 'items_active', count(*) FROM items WHERE status='active'\n"
            "UNION ALL SELECT 'transactions', count(*) FROM transactions\n"
            "UNION ALL SELECT 'cart_items', count(*) FROM cart_items;\n\n"
            "SELECT id, name, code_format_template FROM item_types;\n"
            "SELECT code, specialty, capacity FROM locations ORDER BY code;\n"
        )

    # 02 delete (dependents first because FKs are ON DELETE RESTRICT)
    with open(os.path.join(args.outdir, "02_delete.sql"), "w") as f:
        f.write(
            "-- HARD DELETE existing MASS items. Single-tenant schema => all items.\n"
            "-- transactions.item_id and cart_items.item_id are ON DELETE RESTRICT,\n"
            "-- so clear them first. Records are test/superseded data.\n"
            "BEGIN;\n"
            "DELETE FROM cart_items;\n"
            "DELETE FROM transactions;\n"
            "DELETE FROM items;\n"
            "DELETE FROM code_counters;\n"
            "COMMIT;\n"
        )

    # 03 load
    with open(os.path.join(args.outdir, "03_load.sql"), "w") as f:
        f.write("BEGIN;\n\n")
        f.write("-- 1. Ensure the medication item_type exists.\n")
        f.write(
            f"INSERT INTO item_types (name, code_format_template, attribute_schema)\n"
            f"VALUES ({sql_str(TYPE_NAME)}, {sql_str(TEMPLATE)}, '{{}}'::jsonb)\n"
            f"ON CONFLICT (name) DO NOTHING;\n\n"
        )
        f.write("-- 2. Upsert locations.\n")
        f.write("INSERT INTO locations (code, specialty, capacity, item_type_id)\n")
        f.write("SELECT v.code, v.specialty, v.capacity::int, mt.id\n")
        f.write("FROM (VALUES\n")
        rows = [f"  ({sql_str(l['location_code'])}, {sql_str(l['specialty'])}, {l['capacity']})"
                for l in locs]
        f.write(",\n".join(rows))
        f.write("\n) AS v(code, specialty, capacity)\n")
        f.write(f"CROSS JOIN (SELECT id FROM item_types WHERE name={sql_str(TYPE_NAME)}) mt\n")
        f.write("ON CONFLICT (code) DO UPDATE SET specialty=EXCLUDED.specialty;\n\n")

        f.write(f"-- 3. Insert {len(records)} aggregated medication items.\n")
        f.write("INSERT INTO items (type_id, status, location_id, expiry_date, unit_code, attributes)\n")
        f.write("SELECT mt.id, 'active'::item_status, loc.id, NULL::date, v.unit_code, v.attributes::jsonb\n")
        f.write("FROM (VALUES\n")
        vals = []
        for r in records:
            attrs = json.dumps(r["attributes"], separators=(",", ":"))
            vals.append(f"  ({sql_str(r['location_code'])}, {sql_str(r['unit_code'])}, {sql_str(attrs)})")
        f.write(",\n".join(vals))
        f.write("\n) AS v(location_code, unit_code, attributes)\n")
        f.write(f"CROSS JOIN (SELECT id FROM item_types WHERE name={sql_str(TYPE_NAME)}) mt\n")
        f.write("JOIN locations loc ON loc.code = v.location_code;\n\n")

        # 4. seed code_counters so future check-ins continue after our codes
        counts = {}
        for r in records:
            counts[r["location_code"]] = counts.get(r["location_code"], 0) + 1
        f.write("-- 4. Advance per-location counters past the seeded codes.\n")
        f.write("INSERT INTO code_counters (item_type_id, location_code, next_value)\n")
        f.write("SELECT mt.id, v.code, v.nextval::int\n")
        f.write("FROM (VALUES\n")
        crows = [f"  ({sql_str(code)}, {n + 1})" for code, n in sorted(counts.items())]
        f.write(",\n".join(crows))
        f.write("\n) AS v(code, nextval)\n")
        f.write(f"CROSS JOIN (SELECT id FROM item_types WHERE name={sql_str(TYPE_NAME)}) mt\n")
        f.write("ON CONFLICT (item_type_id, location_code) DO UPDATE SET next_value=EXCLUDED.next_value;\n\n")

        f.write("COMMIT;\n\n")
        f.write(
            "-- Verify:\n"
            "SELECT (SELECT count(*) FROM items) items,\n"
            "       (SELECT sum((attributes->>'quantity')::int) FROM items) total_qty,\n"
            "       (SELECT count(*) FROM locations) locations;\n"
        )
    print(f"wrote 01_inspect.sql, 02_delete.sql, 03_load.sql to {args.outdir}/")
    print(f"records: {len(records)}  locations: {len(locs)}")


if __name__ == "__main__":
    main()
