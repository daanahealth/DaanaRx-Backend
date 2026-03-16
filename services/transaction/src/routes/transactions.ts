import { Router, Request, Response } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { supabaseServer } from '../utils/supabase';

const router = Router();

function formatTransaction(transaction: any): any {
  const formatted: any = {
    transactionId: transaction.transaction_id, timestamp: transaction.timestamp,
    type: transaction.type, quantity: transaction.quantity, unitId: transaction.unit_id,
    patientName: transaction.patient_name, patientReferenceId: transaction.patient_reference_id,
    userId: transaction.user_id, notes: transaction.notes, clinicId: transaction.clinic_id,
  };
  if (transaction.user) {
    formatted.user = { userId: transaction.user.user_id, username: transaction.user.username, email: transaction.user.email, userRole: transaction.user.user_role };
  }
  if (transaction.unit) {
    formatted.unit = { unitId: transaction.unit.unit_id, totalQuantity: transaction.unit.total_quantity, availableQuantity: transaction.unit.available_quantity, expiryDate: transaction.unit.expiry_date, optionalNotes: transaction.unit.optional_notes, lotId: transaction.unit.lot_id, drugId: transaction.unit.drug_id, clinicId: transaction.unit.clinic_id };
    if (transaction.unit.drug) {
      formatted.unit.drug = { drugId: transaction.unit.drug.drug_id, medicationName: transaction.unit.drug.medication_name, genericName: transaction.unit.drug.generic_name, strength: transaction.unit.drug.strength, strengthUnit: transaction.unit.drug.strength_unit, ndcId: transaction.unit.drug.ndc_id, form: transaction.unit.drug.form };
    }
    if (transaction.unit.lot) {
      formatted.unit.lot = { lotId: transaction.unit.lot.lot_id, source: transaction.unit.lot.source, note: transaction.unit.lot.note, locationId: transaction.unit.lot.location_id };
      if (transaction.unit.lot.location) {
        const temp = transaction.unit.lot.location.temp === 'room temp' ? 'room_temp' : transaction.unit.lot.location.temp;
        formatted.unit.lot.location = { locationId: transaction.unit.lot.location.location_id, name: transaction.unit.lot.location.name, temp };
      }
    }
  }
  return formatted;
}

const TX_SELECT = `*, unit:units!transactions_unit_id_fkey(*, drug:drugs(*), lot:lots!units_lot_id_fkey(*, location:locations!lots_location_id_fkey(*))), user:users(*)`;

// GET / - list transactions
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 50;
    const search = req.query.search as string;
    const unitId = req.query.unitId as string;
    const from = (page - 1) * pageSize;

    let query = supabaseServer.from('transactions').select(TX_SELECT, { count: 'exact' }).eq('clinic_id', clinic.clinicId);
    if (unitId) query = query.eq('unit_id', unitId);
    query = query.range(from, from + pageSize - 1).order('timestamp', { ascending: false });
    const { data: transactions, error, count } = await query;
    if (error) throw new Error(error.message);

    let filtered = transactions || [];
    if (search) {
      const sl = search.toLowerCase();
      filtered = filtered.filter((tx: any) =>
        tx.notes?.toLowerCase().includes(sl) || tx.patient_reference_id?.toLowerCase().includes(sl) ||
        tx.type?.toLowerCase().includes(sl) || tx.quantity?.toString().includes(sl) ||
        tx.user?.username?.toLowerCase().includes(sl) || tx.user?.email?.toLowerCase().includes(sl) ||
        tx.unit?.drug?.medication_name?.toLowerCase().includes(sl) || tx.unit?.drug?.generic_name?.toLowerCase().includes(sl)
      );
    }
    res.json({ transactions: filtered.map(formatTransaction), total: search ? filtered.length : (count || 0), page, pageSize });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /all - all transactions with filters
router.get('/all', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const { type, startDate, endDate, medicationName } = req.query;
    const from = (page - 1) * pageSize;

    let query = supabaseServer.from('transactions')
      .select(`*, unit:units!transactions_unit_id_fkey(*, drug:drugs(*)), user:users(*)`, { count: 'exact' })
      .eq('clinic_id', clinic.clinicId);
    if (type) query = query.eq('type', type as string);
    if (startDate) query = query.gte('timestamp', startDate as string);
    if (endDate) {
      const endDateTime = new Date(endDate as string); endDateTime.setDate(endDateTime.getDate() + 1);
      query = query.lt('timestamp', endDateTime.toISOString());
    }
    query = query.range(from, from + pageSize - 1).order('timestamp', { ascending: false });
    const { data: transactions, error, count } = await query;
    if (error) throw new Error(error.message);

    let filtered = transactions || [];
    if (medicationName) {
      const sl = (medicationName as string).toLowerCase();
      filtered = filtered.filter((tx: any) =>
        tx.unit?.drug?.medication_name?.toLowerCase().includes(sl) || tx.unit?.drug?.generic_name?.toLowerCase().includes(sl)
      );
    }
    res.json({ transactions: filtered.map(formatTransaction), total: medicationName ? filtered.length : (count || 0), page, pageSize });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /checkout - check out single unit
router.post('/checkout', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const user = (req as any).user;
    const { unitId, quantity, notes } = req.body;
    if (!unitId || !quantity) return res.status(400).json({ error: 'unitId and quantity required' });

    const { data: unit, error: unitError } = await supabaseServer.from('units').select('*').eq('unit_id', unitId).eq('clinic_id', clinic.clinicId).single();
    if (unitError || !unit) return res.status(404).json({ error: 'Unit not found' });
    if (unit.available_quantity < quantity) return res.status(400).json({ error: `Insufficient quantity. Available: ${unit.available_quantity}` });

    const newQty = unit.available_quantity - quantity;
    const { error: updateError } = await supabaseServer.from('units').update({ available_quantity: newQty }).eq('unit_id', unitId).eq('clinic_id', clinic.clinicId);
    if (updateError) throw new Error(`Failed to update unit: ${updateError.message}`);

    const { data: transaction, error: txError } = await supabaseServer.from('transactions').insert({
      type: 'check_out', quantity, unit_id: unitId, user_id: user.userId, notes, clinic_id: clinic.clinicId,
    }).select('*').single();
    if (txError || !transaction) {
      await supabaseServer.from('units').update({ available_quantity: unit.available_quantity }).eq('unit_id', unitId).eq('clinic_id', clinic.clinicId);
      throw new Error(`Failed to create transaction: ${txError?.message}`);
    }

    const { data: complete } = await supabaseServer.from('transactions').select(`*, unit:units!transactions_unit_id_fkey(*, drug:drugs(*)), user:users(*)`).eq('transaction_id', transaction.transaction_id).single();
    res.json(formatTransaction(complete || transaction));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST /checkout/fefo
router.post('/checkout/fefo', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const user = (req as any).user;
    const { ndcId, medicationName, strength, strengthUnit, quantity, notes } = req.body;
    if (!ndcId && (!medicationName || !strength || !strengthUnit)) return res.status(400).json({ error: 'Provide ndcId or medicationName+strength+strengthUnit' });
    if (!quantity || quantity <= 0) return res.status(400).json({ error: 'quantity must be > 0' });

    let query = supabaseServer.from('units').select('*, drug:drugs(*)').eq('clinic_id', clinic.clinicId).gt('available_quantity', 0).order('expiry_date', { ascending: true });

    if (ndcId) {
      const { data: drug } = await supabaseServer.from('drugs').select('drug_id').eq('ndc_id', ndcId).single();
      if (!drug) return res.status(404).json({ error: `No medication found with NDC: ${ndcId}` });
      query = query.eq('drug_id', drug.drug_id);
    } else {
      const { data: drugs } = await supabaseServer.from('drugs').select('drug_id').ilike('medication_name', medicationName).eq('strength', strength).eq('strength_unit', strengthUnit);
      if (!drugs || drugs.length === 0) return res.status(404).json({ error: `No medication found: ${medicationName} ${strength}${strengthUnit}` });
      query = query.in('drug_id', drugs.map((d: any) => d.drug_id));
    }

    const { data: units, error: unitsError } = await query;
    if (unitsError) throw new Error(unitsError.message);
    if (!units || units.length === 0) return res.status(404).json({ error: 'No units available' });

    const totalAvailable = units.reduce((sum: number, u: any) => sum + u.available_quantity, 0);
    if (totalAvailable < quantity) return res.status(400).json({ error: `Insufficient quantity. Available: ${totalAvailable}, Requested: ${quantity}` });

    let remainingQty = quantity;
    const transactions: any[] = [];
    const unitsUsed: any[] = [];

    for (const unit of units) {
      if (remainingQty <= 0) break;
      const toTake = Math.min(remainingQty, unit.available_quantity);
      const newAvail = unit.available_quantity - toTake;

      const { error: updateErr } = await supabaseServer.from('units').update({ available_quantity: newAvail }).eq('unit_id', unit.unit_id).eq('clinic_id', clinic.clinicId);
      if (updateErr) {
        for (const used of unitsUsed) {
          const { data: rb } = await supabaseServer.from('units').select('available_quantity').eq('unit_id', used.unitId).eq('clinic_id', clinic.clinicId).single();
          if (rb) await supabaseServer.from('units').update({ available_quantity: rb.available_quantity + used.quantityTaken }).eq('unit_id', used.unitId).eq('clinic_id', clinic.clinicId);
        }
        throw new Error(`Failed to update unit: ${updateErr.message}`);
      }

      const { data: transaction } = await supabaseServer.from('transactions').insert({
        type: 'check_out', quantity: toTake, unit_id: unit.unit_id, user_id: user.userId,
        notes: notes || `FEFO checkout`, clinic_id: clinic.clinicId,
      }).select('*').single();

      if (transaction) {
        const { data: complete } = await supabaseServer.from('transactions').select(`*, unit:units!transactions_unit_id_fkey(*, drug:drugs(*)), user:users(*)`).eq('transaction_id', transaction.transaction_id).single();
        transactions.push(formatTransaction(complete || transaction));
      }
      unitsUsed.push({ unitId: unit.unit_id, quantityTaken: toTake, expiryDate: unit.expiry_date, medicationName: unit.drug?.medication_name });
      remainingQty -= toTake;
    }

    res.json({ transactions, totalQuantityDispensed: quantity, unitsUsed });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST /checkout/batch
router.post('/checkout/batch', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const user = (req as any).user;
    const { items, notes } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'items required' });
    if (items.length > 50) return res.status(400).json({ error: 'Cannot checkout more than 50 items' });

    const transactions: any[] = [];
    const completed: Array<{ unitId: string; originalQty: number }> = [];
    let totalQuantity = 0;

    try {
      for (const item of items) {
        const { data: unit, error: unitError } = await supabaseServer.from('units').select('*').eq('unit_id', item.unitId).eq('clinic_id', clinic.clinicId).single();
        if (unitError || !unit) throw new Error(`Unit not found: ${item.unitId}`);
        if (unit.available_quantity < item.quantity) throw new Error(`Insufficient quantity for ${item.unitId}. Available: ${unit.available_quantity}`);

        completed.push({ unitId: item.unitId, originalQty: unit.available_quantity });
        const { error: updateError } = await supabaseServer.from('units').update({ available_quantity: unit.available_quantity - item.quantity }).eq('unit_id', item.unitId).eq('clinic_id', clinic.clinicId);
        if (updateError) throw new Error(`Failed to update unit ${item.unitId}: ${updateError.message}`);

        const { data: transaction } = await supabaseServer.from('transactions').insert({
          type: 'check_out', quantity: item.quantity, unit_id: item.unitId, user_id: user.userId,
          notes: notes || `Batch checkout (${transactions.length + 1}/${items.length})`, clinic_id: clinic.clinicId,
        }).select('*').single();
        if (!transaction) throw new Error(`Failed to create transaction for ${item.unitId}`);

        const { data: complete } = await supabaseServer.from('transactions').select(`*, unit:units!transactions_unit_id_fkey(*, drug:drugs(*)), user:users(*)`).eq('transaction_id', transaction.transaction_id).single();
        transactions.push(formatTransaction(complete || transaction));
        totalQuantity += item.quantity;
      }
      res.json({ transactions, totalItems: items.length, totalQuantity });
    } catch (err: any) {
      for (const c of completed) {
        await supabaseServer.from('units').update({ available_quantity: c.originalQty }).eq('unit_id', c.unitId).eq('clinic_id', clinic.clinicId);
      }
      throw err;
    }
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// GET /:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { data: transaction, error } = await supabaseServer.from('transactions').select(TX_SELECT).eq('transaction_id', req.params.id).eq('clinic_id', clinic.clinicId).single();
    if (error || !transaction) return res.status(404).json({ error: 'Transaction not found' });
    res.json(formatTransaction(transaction));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /:id
router.put('/:id', requireAuth, requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { quantity, notes } = req.body;
    const updateData: any = {};
    if (quantity !== undefined) updateData.quantity = quantity;
    if (notes !== undefined) updateData.notes = notes;
    const { data: transaction, error } = await supabaseServer.from('transactions').update(updateData).eq('transaction_id', req.params.id).eq('clinic_id', clinic.clinicId).select(TX_SELECT).single();
    if (error || !transaction) throw new Error(`Failed to update: ${error?.message}`);
    res.json(formatTransaction(transaction));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
