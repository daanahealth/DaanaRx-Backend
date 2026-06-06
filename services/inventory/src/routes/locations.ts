import { Router, Request, Response } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { supabaseServer } from '../utils/supabase';

const router = Router();

// ---------------------------------------------------------------------------
// Core-schema locations (added by feature/be-contract-patch).
//
// The existing endpoints below target the LEGACY `locations` table
// (location_id / clinic_id / name / temp). The new core schema introduced
// by migrations/002_core_inventory_platform.sql defines `locations` with
// columns (id, code, specialty, capacity, item_type_id, deactivated_at).
// FE feature/fe-inventory-table calls GET /api/locations expecting the
// NEW shape. We mount the new endpoint at `/v2` so the legacy contract is
// preserved during migration; the gateway / FE will collapse these to a
// single `/locations` once the legacy table is retired.
//
// Closes the `/api/locations` contract drift documented in
// docs/merge-strategy.md §4.
// ---------------------------------------------------------------------------

/**
 * GET /locations/v2
 * Lists active locations (deactivated_at IS NULL) from the core schema.
 *
 * Query params:
 *   - type_id  — filter to a single item_type_id
 *   - q        — substring (case-insensitive) on `code` or `specialty`
 *
 * Response: { locations: [{ id, code, specialty, capacity, item_type_id }] }
 */
router.get('/v2', requireAuth, async (req: Request, res: Response) => {
  try {
    const typeId = req.query.type_id as string | undefined;
    const q = (req.query.q as string | undefined)?.trim();

    let query = supabaseServer
      .from('locations')
      .select('id, code, specialty, capacity, item_type_id, deactivated_at')
      .is('deactivated_at', null);

    if (typeId) query = query.eq('item_type_id', typeId);
    if (q && q.length > 0) {
      // Match either code OR specialty substring, case-insensitive.
      query = query.or(`code.ilike.%${q}%,specialty.ilike.%${q}%`);
    }

    query = query.order('code', { ascending: true });

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    const rows = (data ?? []).map((r: any) => ({
      id: r.id,
      code: r.code,
      specialty: r.specialty,
      capacity: r.capacity,
      item_type_id: r.item_type_id,
    }));
    return res.json({ locations: rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? 'Internal error' });
  }
});

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
