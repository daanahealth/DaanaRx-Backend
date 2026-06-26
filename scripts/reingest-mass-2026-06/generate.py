#!/usr/bin/env python3
"""Generate the MASS clinic re-ingestion SQL from the clinic's DRX-DATA export.

This is a FULL REPLACE of the MASS clinic's items with the new export, while
PRESERVING the clinic's already-assigned 8-char codes (unit_code = DRX-MASS-<id>)
so physical units stay findable. Items are loaded UNIT-LEVEL (one row = one
physical unit, quantity 1). The lot number is mapped to a specialty location and
is NOT stored as a user-facing field.

Usage:
    python3 generate.py --data-dir "/path/to/DRX-DATA csvs" --out reingest.sql

Reads:  DRX-DATA - DATA-CARDS.csv, - DATA-PSYCH.csv, - DATA-BOTTLES.csv,
        DRX-DATA - SPECIALTY LOCATION.csv
Writes: a single transactional .sql to run via the Supabase SQL editor / MCP.

IMPORTANT: verify CLINIC_ID and MASS_TYPE_ID against the live DB before running.
"""
import argparse, csv, json, os, re, sys
from collections import Counter

# --- Live identifiers (VERIFY before running) -------------------------------
CLINIC_ID = "f6e0c90c-1d7a-4257-a11f-bd1da860bcd2"   # "MASS Clinic" (kim@massclinic.org)
MASS_TYPE_ID = "98d7c841-3ed7-47bb-8263-7ec435ff0efc"  # item_types.name = 'medication'
SOURCE_FILE = "DRX-DATA 2026-06"

SHEET_FORM = {"CARDS": "Card", "BOTTLES": "Bottle", "PSYCH": "Other"}

# Clinic specialty (first word) -> system classification_guide class, for the
# supervisor-review rules + UI. Unmapped -> "Hold".
SYSTEM_CLASS = {
    "CARDIO": "CARDIO", "CARDIOLOGY": "CARDIO", "GI": "GASTRO", "PSYCH": "PSYCH",
    "NSAID": "PAINFLAM", "NEURO": "NEURO", "NEUROLOGY": "NEURO", "UROLOGY": "UROL",
    "URO": "UROL", "OTC": "VITSUP", "DIABETES": "ENDOCRINE", "THYROID": "ENDOCRINE",
    "ENDOCRINE": "ENDOCRINE", "MISC": "Hold", "EYE": "Hold", "PAA": "Hold",
    "EPINEPHRINE": "Hold",
}


def q(s):
    """Quote a SQL string literal (double single-quotes)."""
    return "'" + str(s).replace("'", "''") + "'"


def jq(obj):
    """Quote a jsonb literal."""
    return "'" + json.dumps(obj, ensure_ascii=False).replace("'", "''") + "'::jsonb"


def load_locmap(data_dir):
    m = {}
    with open(os.path.join(data_dir, "DRX-DATA - SPECIALTY LOCATION.csv"), newline="") as f:
        rd = csv.reader(f); next(rd, None)
        for r in rd:
            if len(r) >= 2 and r[0].strip():
                m[r[0].strip().upper()] = r[1].strip()
    return m


def parse_lot(binc, numkeys):
    b = binc.strip().upper()
    if b.startswith("LOT "):
        b = b[4:].strip()
    if b[:1].isdigit():
        for k in numkeys:
            if b.startswith(k):
                return k
        return b
    return b[:1]


def loc_code(specialty_label):
    """First word + trailing number, alnum only (e.g. 'OTC 12 LIQUIDS' -> 'OTC12')."""
    s = specialty_label.upper().strip()
    num = ""
    mnum = re.search(r"(\d+)", s)
    if mnum:
        num = mnum.group(1)
    word = re.split(r"[\s/]+", s)[0]
    word = re.sub(r"[^A-Z0-9]", "", word)
    return (word + num) if num and not word[-1:].isdigit() else word


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--out", default="reingest.sql")
    args = ap.parse_args()

    locmap = load_locmap(args.data_dir)
    numkeys = sorted([k for k in locmap if k.isdigit()], key=lambda x: -len(x))

    sheets = {
        "CARDS": "DRX-DATA - DATA-CARDS.csv",
        "PSYCH": "DRX-DATA - DATA-PSYCH.csv",
        "BOTTLES": "DRX-DATA - DATA-BOTTLES.csv",
    }
    items = []           # (code, med, dose, unit, form, specialty_label, system_class, lot)
    locations = {}       # code -> specialty_label
    skipped = 0
    for sheet, fname in sheets.items():
        form = SHEET_FORM[sheet]
        with open(os.path.join(args.data_dir, fname), newline="") as f:
            for r in csv.reader(f):
                if not r or all(c.strip() == "" for c in r):
                    continue
                r = (r + [""] * 6)[:6]
                binc, _spec, med, dose, unit, drx = [c.strip() for c in r]
                if not med or not drx:
                    skipped += 1
                    continue
                lot = parse_lot(binc, numkeys)
                label = locmap.get(lot)
                if not label:
                    skipped += 1
                    continue
                code = loc_code(label)
                locations.setdefault(code, label)
                base = re.split(r"[\s/]+", label.upper())[0]
                items.append({
                    "code": "DRX-MASS-" + drx.upper(),
                    "med": med, "dose": dose, "unit": unit, "form": form,
                    "label": label, "sys": SYSTEM_CLASS.get(base, "Hold"),
                    "lot": binc, "src": drx.upper(),
                })

    # uniqueness guard
    codes = Counter(i["code"] for i in items)
    dups = [c for c, n in codes.items() if n > 1]
    assert not dups, f"DUPLICATE unit_codes (cannot preserve): {dups[:10]}"

    out = []
    w = out.append
    w("-- MASS clinic re-ingestion (FULL REPLACE, preserved codes, unit-level).")
    w(f"-- Generated from {SOURCE_FILE}. {len(items)} units across {len(locations)} bins.")
    w("-- Review, then run via the Supabase SQL editor / MCP. Transactional.")
    w("BEGIN;")
    w("")
    w("-- 1. Ensure the specialty-bin locations exist for this clinic.")
    for code, label in sorted(locations.items()):
        # `temp` is a constrained storage-temp field (must be 'room temp'); the
        # bin's identity is its `code`/`name`. (Specialty label for reference: {label})
        w(
            "INSERT INTO locations (name, temp, clinic_id, item_type_id, capacity) "
            f"VALUES ({q(code)}, 'room temp', {q(CLINIC_ID)}, {q(MASS_TYPE_ID)}, 100) "
            f"ON CONFLICT (code) DO NOTHING;  -- {label}"
        )
    w("")
    w("-- 2. Remove the clinic's current items (FK order: cart_items, transactions, items).")
    scope = (
        "SELECT i.id FROM items i JOIN locations l ON i.location_id = l.id "
        f"WHERE l.clinic_id = {q(CLINIC_ID)}"
    )
    w(f"DELETE FROM cart_items   WHERE item_id IN ({scope});")
    w(f"DELETE FROM transactions WHERE item_id IN ({scope});")
    w(f"DELETE FROM items        WHERE id      IN ({scope});")
    w("")
    w(f"-- 3. Insert {len(items)} unit-level items with preserved codes.")
    CHUNK = 400
    for start in range(0, len(items), CHUNK):
        chunk = items[start:start + CHUNK]
        w("INSERT INTO items (type_id, status, location_id, expiry_date, unit_code, attributes) VALUES")
        rows = []
        for it in chunk:
            attrs = {
                "medication_name": it["med"], "dosage": it["dose"], "unit": it["unit"],
                "form": it["form"], "quantity": 1, "specialty_class": it["sys"],
                "source_id": it["src"], "source_file": SOURCE_FILE,
                "notes": f"Re-ingested {SOURCE_FILE} (lot {it['lot']} -> {it['label']})",
            }
            rows.append(
                f"  ({q(MASS_TYPE_ID)}, 'active', "
                f"(SELECT id FROM locations WHERE clinic_id = {q(CLINIC_ID)} AND code = {q(loc_code(it['label']))}), "
                f"NULL, {q(it['code'])}, {jq(attrs)})"
            )
        w(",\n".join(rows) + ";")
        w("")
    w("-- 4. Reset code counters for this clinic so future check-ins start fresh.")
    w(
        "DELETE FROM code_counters WHERE location_code IN "
        f"(SELECT code FROM locations WHERE clinic_id = {q(CLINIC_ID)});"
    )
    w("")
    w("-- 5. Sanity check (should report the inserted count); then COMMIT or ROLLBACK.")
    w(
        f"SELECT count(*) AS inserted FROM items i JOIN locations l ON i.location_id = l.id "
        f"WHERE l.clinic_id = {q(CLINIC_ID)};"
    )
    w("COMMIT;")

    with open(args.out, "w") as f:
        f.write("\n".join(out) + "\n")
    print(f"Wrote {args.out}: {len(items)} items, {len(locations)} locations, {skipped} rows skipped.")
    print("Bins:", ", ".join(sorted(locations)))


if __name__ == "__main__":
    main()
