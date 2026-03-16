import { Request, Response, NextFunction } from 'express';
import { verifyToken, extractToken } from '../utils/auth';
import { supabaseServer } from '../utils/supabase';

async function getUserById(userId: string) {
  const { data: user } = await supabaseServer.from('users').select('*').eq('user_id', userId).single();
  if (!user) return null;
  return {
    userId: user.user_id, username: user.username, email: user.email,
    clinicId: user.clinic_id, activeClinicId: user.active_clinic_id || user.clinic_id,
    userRole: user.user_role, createdAt: new Date(user.created_at), updatedAt: new Date(user.updated_at),
  };
}

async function getClinicById(clinicId: string) {
  const { data: clinic } = await supabaseServer.from('clinics').select('*').eq('clinic_id', clinicId).single();
  if (!clinic) return null;
  return {
    clinicId: clinic.clinic_id, name: clinic.name, primaryColor: clinic.primary_color,
    secondaryColor: clinic.secondary_color, logoUrl: clinic.logo_url,
    requireLotLocation: clinic.require_lot_location,
    createdAt: new Date(clinic.created_at), updatedAt: new Date(clinic.updated_at),
  };
}

async function verifyUserClinicAccess(userId: string, clinicId: string): Promise<boolean> {
  const { data: userRow } = await supabaseServer.from('users').select('clinic_id, clinic_ids').eq('user_id', userId).single();
  if (!userRow) return false;
  return clinicId === userRow.clinic_id || ((userRow.clinic_ids as string[]) || []).includes(clinicId);
}

export async function authMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req.headers.authorization);
    const requestedClinicId = req.headers['x-clinic-id'] as string | undefined;
    if (token) {
      const payload = verifyToken(token);
      const user = await getUserById(payload.userId);
      if (user) {
        let clinic = null;
        if (requestedClinicId && await verifyUserClinicAccess(user.userId, requestedClinicId)) {
          clinic = await getClinicById(requestedClinicId);
        }
        if (!clinic && payload.clinicId && await verifyUserClinicAccess(user.userId, payload.clinicId)) {
          clinic = await getClinicById(payload.clinicId);
        }
        if (!clinic && user.activeClinicId && await verifyUserClinicAccess(user.userId, user.activeClinicId)) {
          clinic = await getClinicById(user.activeClinicId);
        }
        if (!clinic) clinic = await getClinicById(user.clinicId);
        if (clinic) {
          (req as any).user = user;
          (req as any).clinic = clinic;
          (req as any).token = token;
        }
      }
    }
    next();
  } catch { next(); }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!(req as any).user) { res.status(401).json({ error: 'Authentication required' }); return; }
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user;
    if (!user || !roles.includes(user.userRole)) { res.status(403).json({ error: 'Insufficient permissions' }); return; }
    next();
  };
}
