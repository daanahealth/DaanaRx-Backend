// Enrich aggregated MASS rows into core `items` shape USING the
// @daana-health/domain-mass package as the source of truth for:
//   - the medication attribute schema (required: medication_name, dosage, unit,
//     form, specialty_class) and the valid `form` enum (MEDICATION_FORMS)
//   - the classification guide (valid specialty_class values) + suggestLocationForClass
//   - the DRX code template (DRX_CODE_TEMPLATE) rendered via inventory-core
//
// Run from the daana-inventory monorepo root so the workspace packages resolve:
//   node enrich_mass_items.mjs <agg_rows.json> <out.json>
//
// Input  : { records: [{sheet_form, bin, med, dosage, unit, quantity}] }
// Output : { locations: [{code, specialty_class}], records: [{unit_code,
//            location_code, specialty_class, expiry_date, attributes}] }

import { readFileSync, writeFileSync } from "node:fs";
import {
  MEDICATION_FORMS,
  MASS_CLASSIFICATION_GUIDE,
  suggestLocationForClass,
  DRX_CODE_TEMPLATE,
  MASS_ITEM_TYPE_NAME,
} from "@daana-health/domain-mass";
import { renderCodeTemplate } from "@daana-health/inventory-core";

const [, , inPath, outPath] = process.argv;
const { records } = JSON.parse(readFileSync(inPath, "utf8"));

const VALID_CLASSES = new Set(MASS_CLASSIFICATION_GUIDE.map((e) => e.class_name));
const HIGH_RISK = new Set(
  MASS_CLASSIFICATION_GUIDE.filter((e) => e.supervisor_review).map((e) => e.class_name),
);
const FORMS = new Set(MEDICATION_FORMS);

// MASS physical bin label -> classification-guide class_name
const BIN_CLASS = {
  "NSAID 1": "PAINFLAM", "NSAID 2": "PAINFLAM", "NSAID 3": "PAINFLAM",
  "CARDIO 1": "CARDIO", "CARDIO 3": "CARDIO", "CARDIO 4": "CARDIO",
  "GI 1": "GASTRO", "GI 2": "GASTRO", "GI 3": "GASTRO",
  "NEURO 1": "NEURO", "NEURO 3": "NEURO",
  "UROLOGY": "UROL", "UROLOGY 1": "UROL", "UROLOGY 2": "UROL",
  "ENDOCRINE": "ENDOCRINE", "THYROID": "ENDOCRINE", "DIABETES 1": "ENDOCRINE",
  "PSYCH 1": "PSYCH", "PSYCH 2": "PSYCH", "PSYCH 3": "PSYCH",
  "OTC 1": "VITSUP", "OTC 2": "VITSUP", "OTC 4": "VITSUP", "OTC 7": "VITSUP",
  "OTC 9": "VITSUP", "OTC 10": "VITSUP", "OTC 11": "VITSUP",
  "OTC 3 ANTIBACTERIAL": "INFECT", "OTC 12 LIQUIDS": "GASTRO",
};
// physical "type" sheet -> spec `form` enum value ("Psych" is NOT a form)
const FORM_MAP = { Card: "Card", Bottle: "Bottle", Psych: "Other" };

const codeOf = (bin) => bin.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
// expiry fallback: medications require expiry; donor stock w/o date -> 10y forward
const EXPIRY = (() => {
  const d = new Date();
  return `${d.getFullYear() + 10}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

const counters = new Map();
const locations = new Map();
const out = [];
const review = [];

for (const r of records) {
  const form = FORM_MAP[r.sheet_form] ?? "Other";
  if (!FORMS.has(form)) throw new Error(`invalid form ${form}`);

  // specialty_class: bin map first; fall back to package classifier on the name
  let cls = BIN_CLASS[r.bin];
  if (!cls) {
    cls = suggestLocationForClass(r.med).entry.class_name;
    review.push(`${r.bin} / ${r.med} -> classified ${cls}`);
  }
  if (!VALID_CLASSES.has(cls)) cls = "Hold";

  const location_code = codeOf(r.bin) || "HOLD";
  locations.set(location_code, cls);

  const counter = (counters.get(location_code) ?? 0) + 1;
  counters.set(location_code, counter);
  const unit_code = renderCodeTemplate(DRX_CODE_TEMPLATE, {
    itemTypeId: "mass", itemTypeName: MASS_ITEM_TYPE_NAME,
    locationCode: location_code, counter, attributes: {},
  });

  const attributes = {
    medication_name: r.med,
    dosage: String(r.dosage),
    unit: r.unit,
    form,
    specialty_class: cls,
    quantity: r.quantity,
    notes: `Imported from ${"DRX-DATA 26.06.14"} (${r.sheet_form})`,
  };
  if (HIGH_RISK.has(cls)) attributes.supervisor_acknowledged = true;

  out.push({ unit_code, location_code, specialty_class: cls, expiry_date: EXPIRY, attributes });
}

writeFileSync(outPath, JSON.stringify({
  locations: [...locations].map(([code, specialty_class]) => ({ code, specialty_class })),
  records: out,
}, null, 2));

console.error(`items=${out.length} locations=${locations.size} ` +
  `total_qty=${out.reduce((s, x) => s + x.attributes.quantity, 0)} ` +
  `fallback_classified=${review.length}`);
if (review.length) console.error("REVIEW:\n  " + review.join("\n  "));
