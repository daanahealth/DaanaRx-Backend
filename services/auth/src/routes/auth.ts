import { Router, Request, Response } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { supabaseServer, supabaseAuth } from '../utils/supabase';
import { generateToken } from '../utils/auth';

const router = Router();

// ---- helpers ----

function formatUser(user: any) {
  return {
    userId: user.user_id, username: user.username, email: user.email,
    clinicId: user.clinic_id, activeClinicId: user.active_clinic_id || user.clinic_id,
    userRole: user.user_role, createdAt: user.created_at, updatedAt: user.updated_at,
  };
}

function formatClinic(clinic: any) {
  return {
    clinicId: clinic.clinic_id, name: clinic.name,
    primaryColor: clinic.primary_color, secondaryColor: clinic.secondary_color,
    logoUrl: clinic.logo_url, requireLotLocation: clinic.require_lot_location,
    createdAt: clinic.created_at, updatedAt: clinic.updated_at,
  };
}

// ---- Auth routes ----

router.post('/signup', async (req: Request, res: Response) => {
  try {
    const { email, password, clinicName } = req.body;
    if (!email || !password || !clinicName) return res.status(400).json({ error: 'email, password, clinicName required' });

    const { data: authData, error: authError } = await supabaseServer.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (authError || !authData.user) throw new Error(`Sign up failed: ${authError?.message}`);

    const userId = authData.user.id;
    try {
      const { data: clinic, error: clinicError } = await supabaseServer.from('clinics').insert({ name: clinicName }).select().single();
      if (clinicError || !clinic) throw new Error(`Failed to create clinic: ${clinicError?.message}`);

      const username = email.split('@')[0];
      const { data: user, error: userError } = await supabaseServer.from('users').insert({
        user_id: userId, username, email,
        clinic_id: clinic.clinic_id, active_clinic_id: clinic.clinic_id,
        clinic_ids: [clinic.clinic_id], user_role: 'superadmin',
      }).select().single();
      if (userError || !user) throw new Error(`Failed to create user: ${userError?.message}`);

      const token = generateToken({ userId: user.user_id, clinicId: clinic.clinic_id, userRole: 'superadmin' });
      return res.json({ token, user: formatUser(user), clinic: formatClinic(clinic) });
    } catch (err) {
      await supabaseServer.auth.admin.deleteUser(userId);
      throw err;
    }
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/signin', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const normalizedEmail = email.trim().toLowerCase();
    const { data: authData, error: authError } = await supabaseAuth.auth.signInWithPassword({ email: normalizedEmail, password });
    if (authError || !authData?.user) throw new Error(`Sign in failed: ${authError?.message || 'Invalid credentials'}`);

    const { data: user, error: userError } = await supabaseServer.from('users').select('*').eq('user_id', authData.user.id).single();
    if (userError || !user) throw new Error('User record not found');

    const effectiveClinicId = user.active_clinic_id || user.clinic_id;
    const { data: clinic, error: clinicError } = await supabaseServer.from('clinics').select('*').eq('clinic_id', effectiveClinicId).single();
    if (clinicError || !clinic) throw new Error('Clinic not found');

    const token = generateToken({ userId: user.user_id, clinicId: effectiveClinicId, userRole: user.user_role });
    return res.json({ token, user: formatUser(user), clinic: formatClinic(clinic) });
  } catch (error: any) {
    res.status(401).json({ error: error.message });
  }
});

// Change the signed-in user's password. Verifies the current password by
// attempting a sign-in, then updates via the admin API. Client path through
// the gateway: POST /auth/account/password.
router.post('/account/password', requireAuth, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const user = (req as any).user;
    if (!user?.email || !user?.userId) return res.status(401).json({ error: 'Authentication required' });

    // Verify the current password.
    const { error: signInError } = await supabaseAuth.auth.signInWithPassword({
      email: String(user.email).trim().toLowerCase(),
      password: currentPassword,
    });
    if (signInError) return res.status(401).json({ error: 'Current password is incorrect' });

    // Update to the new password.
    const { error: updateError } = await supabaseServer.auth.admin.updateUserById(user.userId, {
      password: newPassword,
    });
    if (updateError) throw new Error(updateError.message);

    return res.json({ ok: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const clinic = (req as any).clinic;
    res.json({ user, clinic });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/check-email', async (req: Request, res: Response) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });

    const { data } = await supabaseServer.from('users').select('email').eq('email', (email as string).trim().toLowerCase()).single();
    if (data) return res.json({ exists: true, message: 'An account with this email already exists.' });
    return res.json({ exists: false, message: 'Email is available.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/users', requireAuth, requireRole('admin', 'superadmin'), async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { data: users, error } = await supabaseServer.from('users').select('*').eq('clinic_id', clinic.clinicId).order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json(users.map(formatUser));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/clinics', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { data: userRow } = await supabaseServer.from('users').select('clinic_ids').eq('user_id', user.userId).single();
    const clinicIds = userRow?.clinic_ids || [];
    if (clinicIds.length === 0) return res.json([]);
    const { data: clinics, error } = await supabaseServer.from('clinics').select('*').in('clinic_id', clinicIds);
    if (error) throw new Error(error.message);
    res.json((clinics || []).map(formatClinic));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/clinic', requireAuth, async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    res.json(clinic);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/clinic', requireAuth, requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { clinicName } = req.body;
    if (!clinicName) return res.status(400).json({ error: 'clinicName required' });

    const { data: clinic, error: clinicError } = await supabaseServer.from('clinics').insert({ name: clinicName }).select().single();
    if (clinicError || !clinic) throw new Error(`Failed to create clinic: ${clinicError?.message}`);

    const { error: addClinicError } = await supabaseServer.rpc('add_user_to_clinic', {
      p_user_id: user.userId, p_clinic_id: clinic.clinic_id,
    });
    if (addClinicError) {
      await supabaseServer.from('clinics').delete().eq('clinic_id', clinic.clinic_id);
      throw new Error(`Failed to add user to clinic: ${addClinicError.message}`);
    }

    const token = generateToken({ userId: user.userId, clinicId: clinic.clinic_id, userRole: 'superadmin' });
    const updatedUser = { ...user, clinicId: clinic.clinic_id, activeClinicId: clinic.clinic_id, userRole: 'superadmin' };
    res.json({ token, user: updatedUser, clinic: formatClinic(clinic) });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/clinic', requireAuth, requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { name, primaryColor, secondaryColor, requireLotLocation } = req.body;
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (primaryColor !== undefined) updateData.primary_color = primaryColor;
    if (secondaryColor !== undefined) updateData.secondary_color = secondaryColor;
    if (requireLotLocation !== undefined) updateData.require_lot_location = requireLotLocation;

    const { data: updated, error } = await supabaseServer.from('clinics').update(updateData).eq('clinic_id', clinic.clinicId).select().single();
    if (error || !updated) throw new Error(`Failed to update clinic: ${error?.message}`);
    res.json(formatClinic(updated));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/clinic/:clinicId', requireAuth, requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { clinicId } = req.params;

    const { data: userRow } = await supabaseServer.from('users').select('clinic_ids').eq('user_id', user.userId).single();
    if (!userRow?.clinic_ids?.includes(clinicId)) throw new Error('You do not have access to this clinic');

    const { error: removeError } = await supabaseServer.rpc('remove_user_from_clinic', { p_user_id: user.userId, p_clinic_id: clinicId });
    if (removeError) throw new Error(`Failed to remove user from clinic: ${removeError.message}`);

    const { data: clinicRow } = await supabaseServer.from('clinics').select('user_ids').eq('clinic_id', clinicId).single();
    if (!clinicRow?.user_ids || clinicRow.user_ids.length === 0) {
      await supabaseServer.from('clinics').delete().eq('clinic_id', clinicId);
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/clinic/switch', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { clinicId } = req.body;
    if (!clinicId) return res.status(400).json({ error: 'clinicId required' });

    const { data: userRow } = await supabaseServer.from('users').select('*').eq('user_id', user.userId).single();
    if (!userRow?.clinic_ids?.includes(clinicId)) throw new Error('You do not have access to this clinic');

    const { error: switchError } = await supabaseServer.rpc('switch_active_clinic', { p_user_id: user.userId, p_clinic_id: clinicId });
    if (switchError) throw new Error(`Failed to switch clinic: ${switchError.message}`);

    const { data: clinic } = await supabaseServer.from('clinics').select('*').eq('clinic_id', clinicId).single();
    if (!clinic) throw new Error('Clinic not found');

    const userRole = userRow.clinic_id === clinicId ? userRow.user_role : 'admin';
    const token = generateToken({ userId: user.userId, clinicId: clinic.clinic_id, userRole });
    res.json({ token, user: { ...formatUser(userRow), clinicId: clinic.clinic_id, activeClinicId: clinic.clinic_id, userRole }, clinic: formatClinic(clinic) });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Legacy invite endpoint (kept for backwards compat)
router.post('/invite', requireAuth, requireRole('superadmin'), async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { email, username, userRole } = req.body;
    if (!email || !username || !userRole) return res.status(400).json({ error: 'email, username, userRole required' });

    const tempPassword = Math.random().toString(36).slice(-12);
    const { data: authData, error: authError } = await supabaseServer.auth.admin.createUser({ email, password: tempPassword, email_confirm: true });
    if (authError || !authData.user) throw new Error(`Failed to create user: ${authError?.message}`);

    const userId = authData.user.id;
    try {
      const { data: user, error: userError } = await supabaseServer.from('users').insert({
        user_id: userId, username, email, clinic_id: clinic.clinicId, user_role: userRole,
      }).select().single();
      if (userError || !user) throw new Error(`Failed to create user record: ${userError?.message}`);
      res.json(formatUser(user));
    } catch (err) {
      await supabaseServer.auth.admin.deleteUser(userId);
      throw err;
    }
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
