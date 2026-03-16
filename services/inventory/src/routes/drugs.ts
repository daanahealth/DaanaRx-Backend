import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseServer } from '../utils/supabase';

const router = Router();

function normalizeNDC(ndc: string): string {
  return ndc.replace(/[^0-9]/g, '');
}

function formatDrug(drug: any) {
  return {
    drugId: drug.drug_id, medicationName: drug.medication_name, genericName: drug.generic_name,
    strength: drug.strength, strengthUnit: drug.strength_unit, ndcId: drug.ndc_id, form: drug.form,
  };
}

// GET /drugs/search?q=
router.get('/search', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const query = req.query.q as string;
    if (!query || query.trim().length < 2) return res.json([]);

    const normalizedQuery = query.trim();
    const normalizedNDC = normalizeNDC(normalizedQuery);
    const results: any[] = [];
    const seenNDCs = new Set<string>();

    const { data: inventoryDrugs } = await supabaseServer
      .from('units')
      .select('unit_id, drug:drugs(drug_id, medication_name, generic_name, strength, strength_unit, ndc_id, form)')
      .eq('clinic_id', clinic.clinicId).gt('available_quantity', 0);

    if (inventoryDrugs) {
      for (const unit of inventoryDrugs) {
        if (!unit.drug) continue;
        const drug = unit.drug as any;
        const ndcMatch = normalizeNDC(drug.ndc_id || '').includes(normalizedNDC);
        const nameMatch = drug.medication_name.toLowerCase().includes(normalizedQuery.toLowerCase()) ||
          (drug.generic_name && drug.generic_name.toLowerCase().includes(normalizedQuery.toLowerCase()));
        if ((ndcMatch || nameMatch) && !seenNDCs.has(drug.ndc_id)) {
          seenNDCs.add(drug.ndc_id);
          results.push({ ...formatDrug(drug), inInventory: true });
        }
      }
    }

    const { data: allDrugs } = await supabaseServer.from('drugs').select('*')
      .or(`ndc_id.ilike.%${normalizedNDC || normalizedQuery}%,medication_name.ilike.%${normalizedQuery}%,generic_name.ilike.%${normalizedQuery}%`)
      .limit(20);

    if (allDrugs) {
      for (const drug of allDrugs) {
        if (!seenNDCs.has(drug.ndc_id)) {
          seenNDCs.add(drug.ndc_id);
          results.push({ ...formatDrug(drug), inInventory: false });
        }
      }
    }

    res.json(results.slice(0, 10));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /drugs/medications?q=
router.get('/medications', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const query = req.query.q as string;
    if (!query || query.trim().length < 2) return res.json([]);

    const normalizedQuery = query.trim().toLowerCase();
    const results: any[] = [];
    const seenMedications = new Set<string>();

    const { data: inventoryDrugs } = await supabaseServer
      .from('units')
      .select('unit_id, drug:drugs(drug_id, medication_name, generic_name, strength, strength_unit, ndc_id, form)')
      .eq('clinic_id', clinic.clinicId).gt('available_quantity', 0);

    if (inventoryDrugs) {
      for (const unit of inventoryDrugs) {
        if (!unit.drug) continue;
        const drug = unit.drug as any;
        const nameMatch = drug.medication_name.toLowerCase().includes(normalizedQuery) ||
          (drug.generic_name && drug.generic_name.toLowerCase().includes(normalizedQuery));
        if (nameMatch) {
          const key = `${drug.medication_name.toLowerCase()}-${drug.strength}-${drug.strength_unit}`;
          if (!seenMedications.has(key)) {
            seenMedications.add(key);
            results.push({ ...formatDrug(drug), inInventory: true });
          }
        }
      }
    }

    const { data: allDrugs } = await supabaseServer.from('drugs').select('*')
      .or(`medication_name.ilike.%${normalizedQuery}%,generic_name.ilike.%${normalizedQuery}%`).limit(30);

    if (allDrugs) {
      for (const drug of allDrugs) {
        const key = `${drug.medication_name.toLowerCase()}-${drug.strength}-${drug.strength_unit}`;
        if (!seenMedications.has(key)) {
          seenMedications.add(key);
          results.push({ ...formatDrug(drug), inInventory: false });
        }
      }
    }

    results.sort((a, b) => {
      if (a.inInventory && !b.inInventory) return -1;
      if (!a.inInventory && b.inInventory) return 1;
      return a.medicationName.localeCompare(b.medicationName);
    });

    res.json(results.slice(0, 15));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /drugs/ndc/:ndc
router.get('/ndc/:ndc', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { ndc } = req.params;
    const normalizedNDC = normalizeNDC(ndc);

    const { data: invUnit } = await supabaseServer
      .from('units')
      .select('drug:drugs(drug_id, medication_name, generic_name, strength, strength_unit, ndc_id, form)')
      .eq('clinic_id', clinic.clinicId).gt('available_quantity', 0).limit(1).single();

    if (invUnit?.drug) {
      const drug = invUnit.drug as any;
      if (normalizeNDC(drug.ndc_id || '') === normalizedNDC) {
        return res.json({ ...formatDrug(drug), inInventory: true });
      }
    }

    const { data: drug } = await supabaseServer.from('drugs').select('*').eq('ndc_id', ndc).single();
    if (drug) return res.json({ ...formatDrug(drug), inInventory: false });

    res.status(404).json({ error: 'Drug not found' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
