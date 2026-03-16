import { Router, Request, Response } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { supabaseServer } from '../utils/supabase';
import { generateQRCode, parseDosage } from '../utils/qrCode';

const router = Router();

const UNIT_SELECT = `*, drug:drugs(*), lot:lots!units_lot_id_fkey(*, location:locations!lots_location_id_fkey(*)), user:users(*)`;

function formatUnit(unit: any) {
  const formatted: any = {
    unitId: unit.unit_id, totalQuantity: unit.total_quantity, availableQuantity: unit.available_quantity,
    patientReferenceId: unit.patient_reference_id, lotId: unit.lot_id,
    expiryDate: unit.expiry_date, dateCreated: unit.date_created,
    userId: unit.user_id, drugId: unit.drug_id, qrCode: unit.qr_code,
    optionalNotes: unit.optional_notes, manufacturerLotNumber: unit.manufacturer_lot_number,
    clinicId: unit.clinic_id,
  };
  if (unit.drug) {
    formatted.drug = {
      drugId: unit.drug.drug_id, medicationName: unit.drug.medication_name,
      genericName: unit.drug.generic_name, strength: unit.drug.strength,
      strengthUnit: unit.drug.strength_unit, ndcId: unit.drug.ndc_id, form: unit.drug.form,
    };
  }
  if (unit.lot) {
    formatted.lot = {
      lotId: unit.lot.lot_id, source: unit.lot.source, lotCode: unit.lot.lot_code,
      note: unit.lot.note, dateCreated: unit.lot.date_created,
      locationId: unit.lot.location_id, clinicId: unit.lot.clinic_id,
    };
    if (unit.lot.location) {
      const temp = unit.lot.location.temp === 'room temp' ? 'room_temp' : unit.lot.location.temp;
      formatted.lot.location = { locationId: unit.lot.location.location_id, name: unit.lot.location.name, temp, clinicId: unit.lot.location.clinic_id };
    }
  }
  if (unit.user) {
    formatted.user = { userId: unit.user.user_id, username: unit.user.username, email: unit.user.email, userRole: unit.user.user_role };
  }
  return formatted;
}

async function getOrCreateDrug(drugData: any): Promise<string> {
  if (drugData.ndcId) {
    const { data: existing } = await supabaseServer.from('drugs').select('drug_id').eq('ndc_id', drugData.ndcId).single();
    if (existing) return existing.drug_id;
  }
  const genericName = drugData.genericName || drugData.medicationName;
  const { data: similar } = await supabaseServer.from('drugs').select('drug_id')
    .ilike('medication_name', drugData.medicationName).eq('strength', drugData.strength)
    .eq('strength_unit', drugData.strengthUnit).eq('form', drugData.form).single();
  if (similar) return similar.drug_id;
  const { data: newDrug, error } = await supabaseServer.from('drugs').insert({
    medication_name: drugData.medicationName, generic_name: genericName,
    strength: drugData.strength, strength_unit: drugData.strengthUnit,
    ndc_id: drugData.ndcId || null, form: drugData.form,
  }).select('drug_id').single();
  if (error) throw new Error(`Failed to create drug: ${error.message}`);
  return newDrug.drug_id;
}

// GET /units
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 50;
    const search = req.query.search as string;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    let query = supabaseServer.from('units').select(UNIT_SELECT, { count: 'exact' }).eq('clinic_id', clinic.clinicId);
    query = query.range(from, to).order('date_created', { ascending: false });
    const { data: units, error, count } = await query;
    if (error) throw new Error(error.message);
    let filtered = units || [];
    if (search) {
      const sl = search.toLowerCase();
      filtered = filtered.filter((u: any) =>
        u.optional_notes?.toLowerCase().includes(sl) ||
        u.drug?.medication_name?.toLowerCase().includes(sl) ||
        u.drug?.generic_name?.toLowerCase().includes(sl) ||
        u.drug?.ndc_id?.toLowerCase().includes(sl) ||
        u.lot?.source?.toLowerCase().includes(sl) ||
        u.unit_id?.toLowerCase().includes(sl) ||
        u.user?.username?.toLowerCase().includes(sl)
      );
    }
    res.json({ units: filtered.map(formatUnit), total: search ? filtered.length : (count || 0), page, pageSize });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /units/search?q=
router.get('/search', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const query = req.query.q as string;
    if (!query || query.trim().length < 2) return res.json([]);
    const trimmedQuery = query.trim();
    const queryLower = trimmedQuery.toLowerCase();
    const isNumeric = !isNaN(Number(queryLower)) && queryLower.length > 0;
    const numericValue = isNumeric ? Number(queryLower) : null;
    const looksLikeUnitId = trimmedQuery.length >= 8 && /^[a-f0-9-]+$/i.test(trimmedQuery);

    let qb = supabaseServer.from('units').select(`*, drug:drugs(*), lot:lots!units_lot_id_fkey(*), user:users(*)`).eq('clinic_id', clinic.clinicId).gt('available_quantity', 0);
    if (looksLikeUnitId) qb = qb.ilike('unit_id', `%${trimmedQuery}%`);
    else qb = qb.order('date_created', { ascending: false });
    const { data: units } = await qb.limit(looksLikeUnitId ? 50 : 100);

    const filtered = (units || []).filter((unit: any) => {
      const drug = unit.drug;
      if (!drug) return false;
      const unitIdMatch = unit.unit_id?.toLowerCase().includes(queryLower);
      const medicationMatch = drug.medication_name?.toLowerCase().includes(queryLower);
      const genericMatch = drug.generic_name?.toLowerCase().includes(queryLower);
      let strengthMatch = false;
      if (numericValue !== null) strengthMatch = drug.strength === numericValue || String(drug.strength).includes(queryLower);
      else if (drug.strength != null) strengthMatch = String(drug.strength).includes(queryLower) || queryLower.includes(String(drug.strength));
      return unitIdMatch || medicationMatch || genericMatch || strengthMatch;
    });
    res.json(filtered.slice(0, 20).map(formatUnit));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /units/advanced
router.get('/advanced', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { expiryDateFrom, expiryDateTo, locationIds, minStrength, maxStrength, strengthUnit,
      expirationWindow, medicationName, genericName, ndcId, sortBy, sortOrder } = req.query;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 50;
    const today = new Date().toISOString().split('T')[0];

    let query = supabaseServer.from('units').select(UNIT_SELECT, { count: 'exact' }).eq('clinic_id', clinic.clinicId);

    if (expirationWindow) {
      switch (expirationWindow) {
        case 'EXPIRED': query = query.lt('expiry_date', today); break;
        case 'EXPIRING_7_DAYS': { const d = new Date(); d.setDate(d.getDate() + 7); query = query.gte('expiry_date', today).lte('expiry_date', d.toISOString().split('T')[0]); break; }
        case 'EXPIRING_30_DAYS': { const d = new Date(); d.setDate(d.getDate() + 30); query = query.gte('expiry_date', today).lte('expiry_date', d.toISOString().split('T')[0]); break; }
        case 'EXPIRING_60_DAYS': { const d = new Date(); d.setDate(d.getDate() + 60); query = query.gte('expiry_date', today).lte('expiry_date', d.toISOString().split('T')[0]); break; }
        case 'EXPIRING_90_DAYS': { const d = new Date(); d.setDate(d.getDate() + 90); query = query.gte('expiry_date', today).lte('expiry_date', d.toISOString().split('T')[0]); break; }
      }
    }
    if (expiryDateFrom) query = query.gte('expiry_date', expiryDateFrom as string);
    if (expiryDateTo) query = query.lte('expiry_date', expiryDateTo as string);

    const sf = (sortBy as string) || 'EXPIRY_DATE';
    const ascending = (sortOrder as string) !== 'DESC';
    switch (sf) {
      case 'CREATED_DATE': query = query.order('date_created', { ascending }); break;
      case 'QUANTITY': query = query.order('available_quantity', { ascending }); break;
      default: query = query.order('expiry_date', { ascending });
    }

    const from = (page - 1) * pageSize;
    query = query.range(from, from + pageSize - 1);
    const { data: units, error, count } = await query;
    if (error) throw new Error(error.message);

    let filtered = (units || []).filter((unit: any) => {
      if (locationIds) {
        const ids = (locationIds as string).split(',');
        if (!unit.lot || !ids.includes(unit.lot.location_id)) return false;
      }
      if (unit.drug) {
        if (minStrength !== undefined && unit.drug.strength < Number(minStrength)) return false;
        if (maxStrength !== undefined && unit.drug.strength > Number(maxStrength)) return false;
        if (strengthUnit && unit.drug.strength_unit !== strengthUnit) return false;
        if (medicationName && !unit.drug.medication_name.toLowerCase().includes((medicationName as string).toLowerCase())) return false;
        if (genericName && !unit.drug.generic_name?.toLowerCase().includes((genericName as string).toLowerCase())) return false;
        if (ndcId && unit.drug.ndc_id !== ndcId) return false;
      }
      return true;
    });

    if (sf === 'MEDICATION_NAME') filtered.sort((a: any, b: any) => ascending ? (a.drug?.medication_name || '').localeCompare(b.drug?.medication_name || '') : (b.drug?.medication_name || '').localeCompare(a.drug?.medication_name || ''));
    else if (sf === 'STRENGTH') filtered.sort((a: any, b: any) => ascending ? (a.drug?.strength || 0) - (b.drug?.strength || 0) : (b.drug?.strength || 0) - (a.drug?.strength || 0));

    res.json({ units: filtered.map(formatUnit), total: count || 0, page, pageSize });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /units/by-location/:locationId
router.get('/by-location/:locationId', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { data: units, error } = await supabaseServer.from('units').select(UNIT_SELECT).eq('clinic_id', clinic.clinicId).gt('available_quantity', 0).order('expiry_date', { ascending: true });
    if (error) throw new Error(error.message);
    const filtered = (units || []).filter((u: any) => u.lot?.location_id === req.params.locationId);
    res.json(filtered.map(formatUnit));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /units/stats (dashboard stats)
router.get('/stats', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const clinicId = clinic.clinicId;
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];
    const thirtyDays = new Date(); thirtyDays.setDate(thirtyDays.getDate() + 30);
    const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [{ count: totalUnits }, { count: expiringSoon }, { count: recentCheckIns }, { count: recentCheckOuts }, { data: allUnits }] = await Promise.all([
      supabaseServer.from('units').select('*', { count: 'exact', head: true }).eq('clinic_id', clinicId).gt('available_quantity', 0),
      supabaseServer.from('units').select('*', { count: 'exact', head: true }).eq('clinic_id', clinicId).gte('expiry_date', todayDate).lte('expiry_date', thirtyDays.toISOString().split('T')[0]).gt('available_quantity', 0),
      supabaseServer.from('transactions').select('*', { count: 'exact', head: true }).eq('clinic_id', clinicId).eq('type', 'check_in').gte('timestamp', sevenDaysAgo.toISOString()),
      supabaseServer.from('transactions').select('*', { count: 'exact', head: true }).eq('clinic_id', clinicId).eq('type', 'check_out').gte('timestamp', sevenDaysAgo.toISOString()),
      supabaseServer.from('units').select('total_quantity, available_quantity').eq('clinic_id', clinicId).gt('available_quantity', 0),
    ]);
    const lowStockAlerts = (allUnits || []).filter((u: any) => u.available_quantity < u.total_quantity * 0.1).length;
    res.json({ totalUnits: totalUnits || 0, unitsExpiringSoon: expiringSoon || 0, recentCheckIns: recentCheckIns || 0, recentCheckOuts: recentCheckOuts || 0, lowStockAlerts });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /units/expiry/medications?days=30
router.get('/expiry/medications', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const days = parseInt(req.query.days as string) || 30;
    const today = new Date();
    const futureDate = new Date(); futureDate.setDate(futureDate.getDate() + days);
    const { data: units, error } = await supabaseServer.from('units').select(UNIT_SELECT).eq('clinic_id', clinic.clinicId)
      .gte('expiry_date', today.toISOString().split('T')[0]).lte('expiry_date', futureDate.toISOString().split('T')[0])
      .gt('available_quantity', 0).order('expiry_date', { ascending: true });
    if (error) throw new Error(error.message);

    const medicationMap = new Map<string, any>();
    (units || []).forEach((unit: any) => {
      const key = `${unit.drug_id}-${unit.expiry_date}`;
      if (!medicationMap.has(key)) {
        const daysUntil = Math.ceil((new Date(unit.expiry_date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        medicationMap.set(key, { drugId: unit.drug.drug_id, medicationName: unit.drug.medication_name, genericName: unit.drug.generic_name, strength: unit.drug.strength, strengthUnit: unit.drug.strength_unit, ndcId: unit.drug.ndc_id, totalUnits: 0, totalQuantity: 0, expiryDate: unit.expiry_date, daysUntilExpiry: daysUntil, units: [] });
      }
      const med = medicationMap.get(key);
      med.totalUnits += 1; med.totalQuantity += unit.available_quantity; med.units.push(formatUnit(unit));
    });
    res.json(Array.from(medicationMap.values()));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /units/expiry/report
router.get('/expiry/report', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const today = new Date();
    const { data: units, error } = await supabaseServer.from('units').select(UNIT_SELECT).eq('clinic_id', clinic.clinicId).gt('available_quantity', 0).order('expiry_date', { ascending: true });
    if (error) throw new Error(error.message);

    const date7 = new Date(today); date7.setDate(date7.getDate() + 7);
    const date30 = new Date(today); date30.setDate(date30.getDate() + 30);
    const date60 = new Date(today); date60.setDate(date60.getDate() + 60);
    const date90 = new Date(today); date90.setDate(date90.getDate() + 90);
    let expired = 0, expiring7Days = 0, expiring30Days = 0, expiring60Days = 0, expiring90Days = 0;
    const medicationMap = new Map<string, any>();

    (units || []).forEach((unit: any) => {
      const expiryDate = new Date(unit.expiry_date);
      const key = `${unit.drug_id}-${unit.expiry_date}`;
      if (expiryDate < today) expired++;
      else if (expiryDate <= date7) expiring7Days++;
      else if (expiryDate <= date30) expiring30Days++;
      else if (expiryDate <= date60) expiring60Days++;
      else if (expiryDate <= date90) expiring90Days++;

      if (!medicationMap.has(key)) {
        const daysUntil = Math.ceil((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        medicationMap.set(key, { drugId: unit.drug.drug_id, medicationName: unit.drug.medication_name, genericName: unit.drug.generic_name, strength: unit.drug.strength, strengthUnit: unit.drug.strength_unit, ndcId: unit.drug.ndc_id, totalUnits: 0, totalQuantity: 0, expiryDate: unit.expiry_date, daysUntilExpiry: daysUntil, units: [] });
      }
      const med = medicationMap.get(key);
      med.totalUnits += 1; med.totalQuantity += unit.available_quantity; med.units.push(formatUnit(unit));
    });

    res.json({ summary: { expired, expiring7Days, expiring30Days, expiring60Days, expiring90Days, total: units?.length || 0 }, medications: Array.from(medicationMap.values()) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /units/:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { data: unit, error } = await supabaseServer.from('units').select(UNIT_SELECT).eq('unit_id', req.params.id).eq('clinic_id', clinic.clinicId).single();
    if (error || !unit) return res.status(404).json({ error: 'Unit not found' });
    res.json(formatUnit(unit));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /units
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const user = (req as any).user;
    const { totalQuantity, availableQuantity, lotId, expiryDate, drugId, drugData, optionalNotes, manufacturerLotNumber } = req.body;
    if (!totalQuantity || !availableQuantity || !lotId || !expiryDate) return res.status(400).json({ error: 'totalQuantity, availableQuantity, lotId, expiryDate required' });

    let resolvedDrugId = drugId;
    if (drugData && !resolvedDrugId) resolvedDrugId = await getOrCreateDrug(drugData);
    if (!resolvedDrugId) return res.status(400).json({ error: 'Either drugId or drugData required' });

    const { data: lot } = await supabaseServer.from('lots').select('*').eq('lot_id', lotId).eq('clinic_id', clinic.clinicId).single();
    if (!lot) return res.status(404).json({ error: 'Lot not found' });

    if (lot.max_capacity !== null && lot.max_capacity !== undefined) {
      const { data: unitsList } = await supabaseServer.from('units').select('total_quantity').eq('lot_id', lotId);
      const currentCap = (unitsList || []).reduce((s: number, u: any) => s + (u.total_quantity || 0), 0);
      if (currentCap + totalQuantity > lot.max_capacity) return res.status(400).json({ error: `Exceeds lot capacity. Current: ${currentCap}/${lot.max_capacity}` });
    }

    const { data: unit, error } = await supabaseServer.from('units').insert({
      total_quantity: totalQuantity, available_quantity: availableQuantity, lot_id: lotId,
      expiry_date: expiryDate, user_id: user.userId, drug_id: resolvedDrugId,
      optional_notes: optionalNotes, manufacturer_lot_number: manufacturerLotNumber, clinic_id: clinic.clinicId,
    }).select('*').single();
    if (error || !unit) throw new Error(`Failed to create unit: ${error?.message}`);

    await supabaseServer.from('units').update({ qr_code: unit.unit_id }).eq('unit_id', unit.unit_id);
    await supabaseServer.from('transactions').insert({ type: 'check_in', quantity: totalQuantity, unit_id: unit.unit_id, user_id: user.userId, notes: 'Initial check-in', clinic_id: clinic.clinicId });

    const { data: complete } = await supabaseServer.from('units').select(UNIT_SELECT).eq('unit_id', unit.unit_id).single();
    res.status(201).json(formatUnit(complete || unit));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /units/:id
router.put('/:id', requireAuth, requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { totalQuantity, availableQuantity, expiryDate, optionalNotes } = req.body;
    const updateData: any = {};
    if (totalQuantity !== undefined) updateData.total_quantity = totalQuantity;
    if (availableQuantity !== undefined) updateData.available_quantity = availableQuantity;
    if (expiryDate !== undefined) updateData.expiry_date = expiryDate;
    if (optionalNotes !== undefined) updateData.optional_notes = optionalNotes;
    const { data: unit, error } = await supabaseServer.from('units').update(updateData).eq('unit_id', req.params.id).eq('clinic_id', clinic.clinicId).select(UNIT_SELECT).single();
    if (error || !unit) throw new Error(`Failed to update: ${error?.message}`);
    res.json(formatUnit(unit));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST /units/batch
router.post('/batch', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const user = (req as any).user;
    const { lotId, medicationName, dosage, quantity, expiryDate, manufacturerLotNumber } = req.body;
    if (!lotId || !medicationName || !dosage || !quantity) return res.status(400).json({ error: 'lotId, medicationName, dosage, quantity required' });
    if (quantity < 1 || quantity > 100) return res.status(400).json({ error: 'Quantity must be between 1 and 100' });

    const { data: lot } = await supabaseServer.from('lots').select('*').eq('lot_id', lotId).eq('clinic_id', clinic.clinicId).single();
    if (!lot) return res.status(404).json({ error: 'Lot not found' });

    if (lot.max_capacity !== null && lot.max_capacity !== undefined) {
      const { data: unitsList } = await supabaseServer.from('units').select('total_quantity').eq('lot_id', lotId);
      const currentCap = (unitsList || []).reduce((s: number, u: any) => s + (u.total_quantity || 0), 0);
      if (currentCap + quantity > lot.max_capacity) return res.status(400).json({ error: `Exceeds lot capacity. Current: ${currentCap}/${lot.max_capacity}` });
    }

    const { strength, strengthUnit } = parseDosage(dosage);
    const drugId = await getOrCreateDrug({ medicationName, genericName: medicationName, strength, strengthUnit, ndcId: null, form: 'Tablet' });

    const lotCode = lot.lot_code || 'XX';
    const today = new Date();
    const createdUnits: any[] = [];

    for (let i = 1; i <= quantity; i++) {
      const qrCode = generateQRCode(lotCode, today, medicationName, dosage, i);
      const { data: unit } = await supabaseServer.from('units').insert({
        total_quantity: 1, available_quantity: 1, lot_id: lotId, expiry_date: expiryDate || null,
        user_id: user.userId, drug_id: drugId, qr_code: qrCode,
        manufacturer_lot_number: manufacturerLotNumber || null, clinic_id: clinic.clinicId,
      }).select('*').single();
      if (unit) {
        await supabaseServer.from('transactions').insert({ type: 'check_in', quantity: 1, unit_id: unit.unit_id, user_id: user.userId, notes: `Batch check-in (${i}/${quantity})`, clinic_id: clinic.clinicId });
        const { data: complete } = await supabaseServer.from('units').select(UNIT_SELECT).eq('unit_id', unit.unit_id).single();
        if (complete) createdUnits.push(formatUnit(complete));
      }
    }

    res.status(201).json(createdUnits);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
