import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseServer } from '../utils/supabase';

const router = Router();

// Per-clinic editable settings. Currently: the medication classification guide.
// Stored as a JSONB blob in public.clinic_settings.classification, keyed by
// clinic_id. When a clinic has no overrides yet, GET returns the static default
// below (a copy of @daana-health/domain-mass MASS_CLASSIFICATION_GUIDE — kept
// inline because the domain pack is not vendored into this service).

interface ClassificationEntry {
  class_name: string;
  common_examples: string[];
  location_code: string;
  two_digit_code: string;
  supervisor_review: boolean;
}

const DEFAULT_CLASSIFICATION: ClassificationEntry[] = [
  { class_name: 'CARDIO', common_examples: ['Lisinopril', 'Metoprolol', 'Amlodipine', 'Furosemide'], location_code: 'CARDIO', two_digit_code: 'CD', supervisor_review: false },
  { class_name: 'LIPID', common_examples: ['Atorvastatin', 'Rosuvastatin', 'Simvastatin'], location_code: 'LIPID', two_digit_code: 'LD', supervisor_review: false },
  { class_name: 'PSYCH', common_examples: ['Sertraline', 'Escitalopram', 'Quetiapine', 'Lithium'], location_code: 'PSYCH', two_digit_code: 'PS', supervisor_review: true },
  { class_name: 'PULM', common_examples: ['Albuterol', 'Fluticasone', 'Montelukast'], location_code: 'PULM', two_digit_code: 'PU', supervisor_review: false },
  { class_name: 'ENDOCRINE', common_examples: ['Metformin', 'Glipizide', 'Levothyroxine'], location_code: 'ENDOCRINE', two_digit_code: 'EN', supervisor_review: false },
  { class_name: 'INFECT', common_examples: ['Amoxicillin', 'Azithromycin', 'Fluconazole'], location_code: 'INFECT', two_digit_code: 'ID', supervisor_review: false },
  { class_name: 'PAINFLAM', common_examples: ['Ibuprofen', 'Naproxen', 'Meloxicam', 'Gabapentin'], location_code: 'PAINFLAM', two_digit_code: 'NS', supervisor_review: false },
  { class_name: 'GASTRO', common_examples: ['Omeprazole', 'Ondansetron', 'Lactulose'], location_code: 'GASTRO', two_digit_code: 'GI', supervisor_review: false },
  { class_name: 'UROL', common_examples: ['Tamsulosin', 'Oxybutynin', 'Finasteride'], location_code: 'UROL', two_digit_code: 'UR', supervisor_review: false },
  { class_name: 'NEPHRO', common_examples: ['Sevelamer', 'Sodium bicarbonate', 'Calcitriol'], location_code: 'NEPHRO', two_digit_code: 'NP', supervisor_review: true },
  { class_name: 'SLEEP', common_examples: ['Zolpidem', 'Melatonin', 'Trazodone'], location_code: 'SLEEP', two_digit_code: 'SL', supervisor_review: true },
  { class_name: 'NEURO', common_examples: ['Donepezil', 'Memantine', 'Rivastigmine', 'Topiramate', 'Levetiracetam'], location_code: 'NEURO', two_digit_code: 'NE', supervisor_review: true },
  { class_name: 'VITSUP', common_examples: ['Vitamin D', 'B12', 'Iron', 'Folic acid', 'Fish oil'], location_code: 'VITSUP', two_digit_code: 'VS', supervisor_review: false },
  { class_name: 'Hold', common_examples: [], location_code: 'Hold', two_digit_code: 'XX', supervisor_review: true },
];

function clinicIdFrom(req: Request): string | null {
  return (req as any).user?.activeClinicId || (req as any).clinic?.clinicId || null;
}

/**
 * GET /settings/classification
 * Returns { entries: ClassificationEntry[] } — the clinic's stored overrides,
 * or the static default when none exist.
 */
router.get('/classification', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinicId = clinicIdFrom(req);
    if (!clinicId) return res.json({ entries: DEFAULT_CLASSIFICATION });
    const { data, error } = await supabaseServer
      .from('clinic_settings')
      .select('classification')
      .eq('clinic_id', clinicId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    const entries =
      data && Array.isArray(data.classification) ? data.classification : DEFAULT_CLASSIFICATION;
    return res.json({ entries });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /settings/classification  { entries: ClassificationEntry[] }
 * Upserts the clinic's classification overrides. Returns { entries }.
 */
router.patch('/classification', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinicId = clinicIdFrom(req);
    if (!clinicId) return res.status(400).json({ error: 'No active clinic for this user' });
    const entries = req.body?.entries;
    if (!Array.isArray(entries)) {
      return res.status(400).json({ error: 'Request body must include an `entries` array' });
    }
    const { error } = await supabaseServer
      .from('clinic_settings')
      .upsert(
        { clinic_id: clinicId, classification: entries, updated_at: new Date().toISOString() },
        { onConflict: 'clinic_id' },
      );
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ entries });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
