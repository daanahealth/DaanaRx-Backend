// Tests for the server-side specialty-based DRX code derivation + render.
// Build first (npm run build:consolidated), then: node --test tests/mass-codes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { deriveMassCodeAttributes, splitSpecialtyBin } = require(
  '../dist-consolidated/services/inventory/src/utils/mass-codes.js',
);
const { renderCodeTemplate } = require('../vendor/inventory-core');

const NEW_TEMPLATE =
  'DRX-MASS-{attr.specialty_code}{attr.specialty_num}{attr.med_initial}{attr.dose_initial}{counter:03d}';

function render(bin, name, dose, counter) {
  const attributes = deriveMassCodeAttributes({
    specialtyBin: bin,
    medicationName: name,
    dosage: dose,
  });
  return renderCodeTemplate(NEW_TEMPLATE, {
    itemTypeId: 't',
    itemTypeName: 'medication',
    locationCode: bin,
    counter,
    attributes,
  });
}

test('team example: Diabetes-2 Metformin 500mg -> DRX-MASS-D2ME5001', () => {
  assert.equal(render('DIABETES 2', 'Metformin', '500', 1), 'DRX-MASS-D2ME5001');
});

test('handles no-space bin codes (PSYCH1) the backend actually stores', () => {
  assert.equal(render('PSYCH1', 'Sertraline', '100', 5), 'DRX-MASS-P1SE1005');
  assert.equal(splitSpecialtyBin('PSYCH1').num, '1');
});

test('distinct specialty letters; counter zero-pads to 3', () => {
  assert.equal(render('NSAID1', 'Acetaminophen', '325', 7), 'DRX-MASS-N1AC3007');
  assert.equal(render('NEURO1', 'Donepezil', '10', 3), 'DRX-MASS-R1DO1003'); // R, not N
});
