import { Router, Request, Response } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { supabaseServer } from '../utils/supabase';

const router = Router();

function formatLocation(location: any) {
  const temp = location.temp === 'room temp' ? 'room_temp' : location.temp;
  return {
    locationId: location.location_id, name: location.name, temp,
    clinicId: location.clinic_id, createdAt: location.created_at, updatedAt: location.updated_at,
  };
}

// GET /locations
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { data: locations, error } = await supabaseServer.from('locations')
      .select('*').eq('clinic_id', clinic.clinicId).order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json((locations || []).map(formatLocation));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /locations/:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { data: location, error } = await supabaseServer.from('locations')
      .select('*').eq('location_id', req.params.id).eq('clinic_id', clinic.clinicId).single();
    if (error || !location) return res.status(404).json({ error: 'Location not found' });
    res.json(formatLocation(location));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /locations
router.post('/', requireAuth, requireRole('admin', 'superadmin'), async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { name, temp } = req.body;
    if (!name || !temp) return res.status(400).json({ error: 'name and temp required' });
    const dbTemp = temp === 'room_temp' ? 'room temp' : temp;
    const { data: location, error } = await supabaseServer.from('locations')
      .insert({ name, temp: dbTemp, clinic_id: clinic.clinicId }).select().single();
    if (error || !location) throw new Error(`Failed to create: ${error?.message}`);
    res.status(201).json(formatLocation(location));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /locations/:id
router.put('/:id', requireAuth, requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { name, temp } = req.body;
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (temp !== undefined) updateData.temp = temp === 'room_temp' ? 'room temp' : temp;
    const { data: location, error } = await supabaseServer.from('locations')
      .update(updateData).eq('location_id', req.params.id).eq('clinic_id', clinic.clinicId).select().single();
    if (error || !location) throw new Error(`Failed to update: ${error?.message}`);
    res.json(formatLocation(location));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /locations/:id
router.delete('/:id', requireAuth, requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { data: lots } = await supabaseServer.from('lots').select('lot_id').eq('location_id', req.params.id).limit(1);
    if (lots && lots.length > 0) return res.status(400).json({ error: 'Cannot delete location with associated lots.' });
    const { error } = await supabaseServer.from('locations').delete().eq('location_id', req.params.id).eq('clinic_id', clinic.clinicId);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
