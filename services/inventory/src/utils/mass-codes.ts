// Server-side derivation for the NEW specialty-based DRX code format.
//
// Mirrors @daana-health/domain-mass/specialty-codes (the canonical, unit-tested
// source). Duplicated here only because the backend consumes inventory-core but
// not domain-mass; keep the two in sync. The new code template
// (DRX-MASS-{attr.specialty_code}{attr.specialty_num}{attr.med_initial}{attr.dose_initial}{counter:03d})
// reads these four fields from `attributes`, so they must be merged in before
// renderCodeTemplate runs at check-in.

/** Base specialty (uppercased, no bin number) -> single-letter code. DRAFT map. */
export const SPECIALTY_LETTERS: Readonly<Record<string, string>> = {
  CARDIO: 'C',
  CARDIOLOGY: 'C',
  GI: 'G',
  PSYCH: 'P',
  NSAID: 'N',
  NEURO: 'R',
  NEUROLOGY: 'R',
  UROLOGY: 'U',
  URO: 'U',
  OTC: 'O',
  DIABETES: 'D',
  THYROID: 'T',
  ENDOCRINE: 'E',
  MISC: 'M',
  EYE: 'Y',
  OPTHO: 'Y',
  ANTIVIRAL: 'A',
  BACT: 'A',
  PAA: 'Q',
  EPINEPHRINE: 'X',
};

export const UNMAPPED_SPECIALTY_LETTER = 'Z';

export interface MassCodeAttributes {
  specialty_code: string;
  specialty_num: string;
  med_initial: string;
  dose_initial: string;
}

export function splitSpecialtyBin(bin: string): { base: string; num: string } {
  const raw = (bin ?? '').trim().toUpperCase();
  const numMatch = raw.match(/(\d+)\s*$/);
  const num = numMatch?.[1] ?? '1';
  const word = raw
    .replace(/\d+\s*$/, '')
    .split(/[\s/]+/)
    .filter(Boolean)[0];
  return { base: word ?? '', num };
}

export function medInitial(name: string): string {
  const letters = (name ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  return letters.slice(0, 2) || 'XX';
}

export function doseInitial(dosage: string): string {
  const m = (dosage ?? '').match(/\d/);
  return m?.[0] ?? '0';
}

/** Derive the four NEW-format code attributes for a unit. */
export function deriveMassCodeAttributes(input: {
  specialtyBin: string;
  medicationName: string;
  dosage: string;
}): MassCodeAttributes {
  const { base, num } = splitSpecialtyBin(input.specialtyBin);
  return {
    specialty_code: SPECIALTY_LETTERS[base] ?? UNMAPPED_SPECIALTY_LETTER,
    specialty_num: num,
    med_initial: medInitial(input.medicationName),
    dose_initial: doseInitial(input.dosage),
  };
}
