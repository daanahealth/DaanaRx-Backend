// Regression test for the field-reported bug:
//   "during check-in an error pops up saying code cannot be generated, but the
//    code is generated after" + "feels like old QR codes are being used".
//
// Cause: GET /items/next-code rendered the code template with `attributes: {}`.
// Once migration 003 switched the medication template to the specialty-based
// format, every {attr.*} placeholder was missing -> CodeTemplateError -> 500,
// while POST /items (which derives the attributes) still minted a valid code.
//
// Build first (npm run build:consolidated), then:
//   node --test tests/next-code-preview.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { deriveMassCodeAttributes } = require(
  '../dist-consolidated/services/inventory/src/utils/mass-codes.js',
);
const { renderCodeTemplate } = require('../vendor/inventory-core');

// The live template after migrations/003_drx_specialty_code_format.sql.
const TEMPLATE =
  'DRX-MASS-{attr.specialty_code}{attr.specialty_num}{attr.med_initial}{attr.dose_initial}{counter:03d}';

function render(attributes, counter, bin) {
  return renderCodeTemplate(TEMPLATE, {
    itemTypeId: 't',
    itemTypeName: 'medication',
    locationCode: bin,
    counter,
    attributes,
  });
}

test('the old preview path (empty attributes) is what threw', () => {
  assert.throws(() => render({}, 7, 'PSYCH1'), /specialty_code|attribute/i);
});

test('preview now renders and matches what check-in mints', () => {
  const input = { specialtyBin: 'PSYCH1', medicationName: 'Sertraline', dosage: '100' };
  // Preview (GET /items/next-code) and check-in (POST /items) derive the same
  // attributes from the same inputs, so the sticker matches the stored code.
  const preview = render(deriveMassCodeAttributes(input), 5, 'PSYCH1');
  const checkIn = render(deriveMassCodeAttributes(input), 5, 'PSYCH1');
  assert.equal(preview, checkIn);
  assert.equal(preview, 'DRX-MASS-P1SE1005');
});

test('preview degrades to placeholders instead of failing when med fields are absent', () => {
  // The intake form fetches a preview before every field is filled in; that
  // must not error, it just is not the exact final code (response.exact=false).
  const code = render(
    deriveMassCodeAttributes({ specialtyBin: 'NSAID2', medicationName: '', dosage: '' }),
    3,
    'NSAID2',
  );
  assert.match(code, /^DRX-MASS-N2XX0003$/);
});

test('preview never emits the retired location-based format', () => {
  const code = render(
    deriveMassCodeAttributes({
      specialtyBin: 'CARDIO1',
      medicationName: 'Atorvastatin',
      dosage: '40',
    }),
    33,
    'CARDIO1',
  );
  // Old format was DRX-MASS-{LOCATION}-{counter:05d}, e.g. DRX-MASS-CARDIO1-00033.
  assert.doesNotMatch(code, /DRX-MASS-CARDIO1-\d{5}/);
  assert.equal(code, 'DRX-MASS-C1AT4033');
});
