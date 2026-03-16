import { Router, Request, Response } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { supabaseServer } from '../utils/supabase';

const router = Router();

function formatLot(lot: any) {
  return {
    lotId: lot.lot_id, source: lot.source || undefined, lotCode: lot.lot_code || undefined,
    note: lot.note, dateCreated: lot.date_created, locationId: lot.location_id,
    clinicId: lot.clinic_id, maxCapacity: lot.max_capacity,
    currentCapacity: lot.currentCapacity, availableCapacity: lot.availableCapacity,
  };
}

async function getLotCurrentCapacity(lotId: string): Promise<number> {
  const { data: units } = await supabaseServer.from('units').select('total_quantity').eq('lot_id', lotId);
  return (units || []).reduce((sum, u) => sum + (u.total_quantity || 0), 0);
}

// GET /lots
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { data: lots, error } = await supabaseServer.from('lots')
      .select('*').eq('clinic_id', clinic.clinicId).order('date_created', { ascending: false });
    if (error) throw new Error(error.message);
    const lotsWithCapacity = await Promise.all((lots || []).map(async (lot) => {
      const currentCapacity = await getLotCurrentCapacity(lot.lot_id);
      return { ...formatLot(lot), currentCapacity, availableCapacity: lot.max_capacity ? lot.max_capacity - currentCapacity : null };
    }));
    res.json(lotsWithCapacity);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /lots/:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { data: lot, error } = await supabaseServer.from('lots')
      .select('*').eq('lot_id', req.params.id).eq('clinic_id', clinic.clinicId).single();
    if (error || !lot) return res.status(404).json({ error: 'Lot not found' });
    const currentCapacity = await getLotCurrentCapacity(lot.lot_id);
    res.json({ ...formatLot(lot), currentCapacity, availableCapacity: lot.max_capacity ? lot.max_capacity - currentCapacity : null });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /lots
router.post('/', requireAuth, requireRole('admin', 'superadmin'), async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { source, lotCode, note, locationId, maxCapacity } = req.body;
    if (!lotCode || !locationId) return res.status(400).json({ error: 'lotCode and locationId required' });

    if (!lotCode || lotCode.length < 1 || lotCode.length > 2) return res.status(400).json({ error: 'Lot code must be 1-2 characters' });
    const normalizedLotCode = lotCode.toUpperCase();
    if (!/^[A-Z]/.test(normalizedLotCode)) return res.status(400).json({ error: 'Lot code must start with A-Z' });
    if (normalizedLotCode.length === 2 && !/^[A-Z][LR]$/.test(normalizedLotCode)) return res.status(400).json({ error: 'Second character must be L or R' });
    if (maxCapacity !== undefined && maxCapacity <= 0) return res.status(400).json({ error: 'maxCapacity must be positive' });

    const { data: location } = await supabaseServer.from('locations').select('location_id').eq('location_id', locationId).eq('clinic_id', clinic.clinicId).single();
    if (!location) return res.status(404).json({ error: 'Location not found' });

    const { data: lot, error } = await supabaseServer.from('lots').insert({
      source: source || null, lot_code: normalizedLotCode, location_id: locationId,
      clinic_id: clinic.clinicId, note, max_capacity: maxCapacity,
    }).select().single();
    if (error || !lot) throw new Error(`Failed to create lot: ${error?.message}`);
    res.status(201).json(formatLot(lot));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
