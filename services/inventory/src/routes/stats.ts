import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseServer } from '../utils/supabase';

const router = Router();

const UNIT_SELECT_FULL = `*, drug:drugs(*), lot:lots!units_lot_id_fkey(*, location:locations!lots_location_id_fkey(*)), user:users(*)`;

function formatUnit(unit: any) {
  const formatted: any = {
    unitId: unit.unit_id, totalQuantity: unit.total_quantity, availableQuantity: unit.available_quantity,
    lotId: unit.lot_id, expiryDate: unit.expiry_date, dateCreated: unit.date_created,
    userId: unit.user_id, drugId: unit.drug_id, qrCode: unit.qr_code,
    optionalNotes: unit.optional_notes, clinicId: unit.clinic_id,
  };
  if (unit.drug) formatted.drug = { drugId: unit.drug.drug_id, medicationName: unit.drug.medication_name, genericName: unit.drug.generic_name, strength: unit.drug.strength, strengthUnit: unit.drug.strength_unit, ndcId: unit.drug.ndc_id, form: unit.drug.form };
  if (unit.lot) formatted.lot = { lotId: unit.lot.lot_id, source: unit.lot.source, lotCode: unit.lot.lot_code, note: unit.lot.note, locationId: unit.lot.location_id };
  return formatted;
}

// GET /stats
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

// GET /expiry/medications?days=30
router.get('/expiry/medications', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const days = parseInt(req.query.days as string) || 30;
    const today = new Date();
    const futureDate = new Date(); futureDate.setDate(futureDate.getDate() + days);

    const { data: units, error } = await supabaseServer.from('units').select(UNIT_SELECT_FULL)
      .eq('clinic_id', clinic.clinicId)
      .gte('expiry_date', today.toISOString().split('T')[0])
      .lte('expiry_date', futureDate.toISOString().split('T')[0])
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

// GET /expiry/report
router.get('/expiry/report', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const today = new Date();
    const { data: units, error } = await supabaseServer.from('units').select(UNIT_SELECT_FULL)
      .eq('clinic_id', clinic.clinicId).gt('available_quantity', 0).order('expiry_date', { ascending: true });
    if (error) throw new Error(error.message);

    const date7 = new Date(today); date7.setDate(date7.getDate() + 7);
    const date30 = new Date(today); date30.setDate(date30.getDate() + 30);
    const date60 = new Date(today); date60.setDate(date60.getDate() + 60);
    const date90 = new Date(today); date90.setDate(date90.getDate() + 90);
    let expired = 0, expiring7Days = 0, expiring30Days = 0, expiring60Days = 0, expiring90Days = 0;
    const medicationMap = new Map<string, any>();

    (units || []).forEach((unit: any) => {
      const expiryDate = new Date(unit.expiry_date);
      if (expiryDate < today) expired++;
      else if (expiryDate <= date7) expiring7Days++;
      else if (expiryDate <= date30) expiring30Days++;
      else if (expiryDate <= date60) expiring60Days++;
      else if (expiryDate <= date90) expiring90Days++;

      const key = `${unit.drug_id}-${unit.expiry_date}`;
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

export default router;
