// items-next-code.ts — peek-only counter endpoint, added by
// feature/be-contract-patch to close the FE checkin-rebuild contract drift
// documented in docs/merge-strategy.md §4.
//
// Why a standalone router?
//   • The full Items CRUD lives in routes/items.ts on feature/be-items-api.
//     This branch is based on feature/be-checkout-cart and intentionally
//     does not re-define items.ts (avoids a textual conflict during the
//     merge).
//   • Express allows multiple routers to be mounted on the same `/items`
//     prefix; once feature/be-items-api lands, this router and that one
//     co-exist and the gateway dispatches by path. The `/next-code` path
//     is not defined on items.ts so there is no overlap.
//   • At a future cleanup pass this single route can be folded into items.ts.
//
// Endpoint:
//   GET /items/next-code?location=<code>&type_id=<uuid>
//   Returns: { unit_code: 'DRX-MASS-XXX-00042' }
//
// Critical: this endpoint MUST NOT increment `code_counters.next_value`.
// It is a read-only preview used by the FE check-in flow to render
// DrxCodePreview before the user submits. The atomic allocation happens
// in POST /items (items.ts) via the SECURITY DEFINER RPC
// `increment_code_counter`.

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseServer } from '../utils/supabase';
import { renderCodeTemplate } from '@daana-health/inventory-core';
import { deriveMassCodeAttributes } from '../utils/mass-codes';

const router = Router();

router.get('/next-code', requireAuth, async (req: Request, res: Response) => {
  try {
    const locationCode = (req.query.location as string | undefined)?.trim();
    const typeIdParam = (req.query.type_id as string | undefined)?.trim();
    // The specialty-based template renders from the medication's own fields, so
    // an exact preview needs them. Both are optional: without them the derive
    // helper falls back to placeholder initials rather than failing.
    const medicationName = (req.query.medication_name as string | undefined)?.trim() ?? '';
    const dosage = (req.query.dosage as string | undefined)?.trim() ?? '';

    if (!locationCode) {
      return res.status(400).json({ error: 'location (code) query param required' });
    }

    // 1. Resolve the location by code so we can also fetch its default type.
    //    Scoped to the caller's clinic — bin codes (PSYCH1, NSAID2, …) are only
    //    unique per clinic, so an unscoped lookup can preview another clinic's bin.
    const clinicId = (req as any).clinic?.clinicId;
    let locQuery = supabaseServer
      .from('locations')
      .select('id, code, item_type_id, deactivated_at')
      .eq('code', locationCode);
    if (clinicId) locQuery = locQuery.eq('clinic_id', clinicId);
    const locRes = await locQuery.maybeSingle();
    if (locRes.error) return res.status(500).json({ error: locRes.error.message });
    if (!locRes.data) return res.status(404).json({ error: 'Unknown location code' });
    if (locRes.data.deactivated_at) {
      return res.status(409).json({ error: 'Location is deactivated' });
    }

    const typeId = typeIdParam ?? locRes.data.item_type_id;
    if (!typeId) {
      return res.status(400).json({
        error: 'type_id required (location has no default item_type_id)',
      });
    }

    // 2. Load the item type for its code-format template.
    const typeRes = await supabaseServer
      .from('item_types')
      .select('id, name, code_format_template')
      .eq('id', typeId)
      .maybeSingle();
    if (typeRes.error) return res.status(500).json({ error: typeRes.error.message });
    if (!typeRes.data) return res.status(404).json({ error: 'Unknown item type' });

    // 3. Peek the counter WITHOUT incrementing. If no row exists yet the
    //    next value is 1.
    const counterRes = await supabaseServer
      .from('code_counters')
      .select('next_value')
      .eq('item_type_id', typeRes.data.id)
      .eq('location_code', locRes.data.code)
      .maybeSingle();
    if (counterRes.error) return res.status(500).json({ error: counterRes.error.message });
    const counter: number = counterRes.data?.next_value ?? 1;

    // 4. Render via the inventory-core helper for parity with POST /items.
    //    The medication template is specialty-based
    //    (DRX-MASS-{attr.specialty_code}{attr.specialty_num}{attr.med_initial}
    //     {attr.dose_initial}{counter:03d}), so the same attributes POST /items
    //    merges in must be derived here too. Rendering with `{}` throws
    //    CodeTemplateError — that produced a "code cannot be generated" error on
    //    every check-in while POST /items went on to mint a valid code.
    const renderAttributes =
      typeRes.data.name === 'medication'
        ? deriveMassCodeAttributes({
            specialtyBin: locRes.data.code,
            medicationName,
            dosage,
          })
        : {};

    let unitCode: string;
    try {
      unitCode = renderCodeTemplate(typeRes.data.code_format_template, {
        itemTypeId: typeRes.data.id,
        itemTypeName: typeRes.data.name,
        locationCode: locRes.data.code,
        counter,
        attributes: renderAttributes,
      });
    } catch (err: any) {
      return res.status(500).json({ error: `Code template render failed: ${err.message}` });
    }

    return res.json({
      unit_code: unitCode,
      counter,
      location_code: locRes.data.code,
      type_id: typeRes.data.id,
      // True only when the caller supplied the fields the template reads, i.e.
      // when this preview will match the code POST /items actually mints.
      exact: typeRes.data.name !== 'medication' || Boolean(medicationName && dosage),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? 'Internal error' });
  }
});

export default router;
