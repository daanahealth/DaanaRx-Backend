-- 003_drx_specialty_code_format.sql
--
-- Adopt the NEW specialty-based DRX code format for FUTURE check-ins.
-- The clinic moved their barcode scheme from lot-based to specialty-based:
--
--   OLD:  DRX-MASS-{LOCATION}-{counter:05d}                                   (location format)
--   NEW:  DRX-MASS-{specialty_code}{specialty_num}{med_initial}{dose_initial}{counter:03d}
--         e.g. DRX-MASS-D2ME5001  (Diabetes-2, Metformin, 500 mg, unit 001)
--
-- The four embedded attributes are derived server-side at check-in
-- (services/inventory/src/utils/mass-codes.ts, mirroring
-- @daana-health/domain-mass/specialty-codes). Existing units keep their
-- already-assigned codes — they are NOT regenerated.

UPDATE item_types
SET code_format_template =
  'DRX-MASS-{attr.specialty_code}{attr.specialty_num}{attr.med_initial}{attr.dose_initial}{counter:03d}'
WHERE name = 'medication';
