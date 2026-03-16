import { Router, Request, Response } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { supabaseServer, supabaseAuth } from '../utils/supabase';
import { generateToken } from '../utils/auth';

const router = Router();

function formatInvitation(data: any) {
  return {
    invitationId: data.invitation_id, email: data.email, clinicId: data.clinic_id,
    invitedBy: data.invited_by, userRole: data.user_role, status: data.status,
    invitationToken: data.invitation_token,
    createdAt: data.created_at, expiresAt: data.expires_at, acceptedAt: data.accepted_at,
    clinic: data.clinic ? {
      clinicId: data.clinic.clinic_id, name: data.clinic.name,
      primaryColor: data.clinic.primary_color, secondaryColor: data.clinic.secondary_color,
      logoUrl: data.clinic.logo_url, createdAt: data.clinic.created_at, updatedAt: data.clinic.updated_at,
    } : undefined,
    invitedByUser: data.invitedByUser ? {
      userId: data.invitedByUser.user_id, username: data.invitedByUser.username, email: data.invitedByUser.email,
    } : undefined,
  };
}

// GET /invitations - list all invitations for clinic
router.get('/', requireAuth, requireRole('admin', 'superadmin'), async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { data: invitations, error } = await supabaseServer
      .from('invitations')
      .select(`*, invitedByUser:invited_by(user_id, username, email), clinic:clinic_id(clinic_id, name, primary_color, secondary_color, logo_url, created_at, updated_at)`)
      .eq('clinic_id', clinic.clinicId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json((invitations || []).map(formatInvitation));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /invitations/token/:token - get invitation by token (public)
router.get('/token/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { data: invitation, error } = await supabaseServer
      .from('invitations')
      .select(`*, invitedByUser:invited_by(user_id, username, email), clinic:clinic_id(clinic_id, name, primary_color, secondary_color, logo_url, created_at, updated_at)`)
      .eq('invitation_token', token)
      .single();
    if (error || !invitation) return res.status(404).json({ error: 'Invitation not found' });

    if (new Date(invitation.expires_at) < new Date()) {
      await supabaseServer.from('invitations').update({ status: 'expired' }).eq('invitation_id', invitation.invitation_id);
      return res.status(410).json({ error: 'This invitation has expired.' });
    }

    res.json(formatInvitation(invitation));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /invitations - send invitation
router.post('/', requireAuth, requireRole('admin', 'superadmin'), async (req: Request, res: Response) => {
  try {
    const { email, userRole } = req.body;
    const clinic = (req as any).clinic;
    const invitedByUser = (req as any).user;

    if (!email || !userRole) return res.status(400).json({ error: 'email and userRole required' });
    if (!['admin', 'employee'].includes(userRole)) return res.status(400).json({ error: 'userRole must be admin or employee' });

    // Check if user already in clinic
    const { data: existingUser } = await supabaseServer.from('users').select('user_id, email, clinic_ids').eq('email', email).single();
    if (existingUser?.clinic_ids?.includes(clinic.clinicId)) throw new Error('User already exists in this clinic.');

    // Check for existing pending invitation
    const { data: existing } = await supabaseServer.from('invitations')
      .select('*').eq('email', email).eq('clinic_id', clinic.clinicId).eq('status', 'invited').single();

    let invitation: any;
    if (existing) {
      const { data: updated } = await supabaseServer.from('invitations').update({
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString(),
      }).eq('invitation_id', existing.invitation_id).select('*').single();
      invitation = updated;
    } else {
      const { data: created, error } = await supabaseServer.from('invitations').insert({
        email, clinic_id: clinic.clinicId, invited_by: invitedByUser.userId, user_role: userRole, status: 'invited',
      }).select('*').single();
      if (error) throw new Error(error.message);
      invitation = created;
    }

    // Log invitation URL
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    console.log(`\nInvitation for ${email}: ${appUrl}/auth/signup?invitation=${invitation.invitation_token}\n`);

    const { data: withJoins } = await supabaseServer.from('invitations')
      .select(`*, invitedByUser:invited_by(user_id, username, email), clinic:clinic_id(clinic_id, name, primary_color, secondary_color, logo_url, created_at, updated_at)`)
      .eq('invitation_id', invitation.invitation_id).single();

    res.json(formatInvitation(withJoins || invitation));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST /invitations/:id/resend
router.post('/:id/resend', requireAuth, requireRole('admin', 'superadmin'), async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { id } = req.params;

    const { data: invitation, error } = await supabaseServer.from('invitations')
      .select('*').eq('invitation_id', id).eq('clinic_id', clinic.clinicId).single();
    if (error || !invitation) return res.status(404).json({ error: 'Invitation not found' });
    if (invitation.status !== 'invited') return res.status(400).json({ error: 'Cannot resend an accepted or expired invitation' });

    const { data: updated } = await supabaseServer.from('invitations').update({
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    }).eq('invitation_id', id).select('*').single();

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    console.log(`\nResent invitation for ${updated?.email}: ${appUrl}/auth/signup?invitation=${updated?.invitation_token}\n`);

    const { data: withJoins } = await supabaseServer.from('invitations')
      .select(`*, invitedByUser:invited_by(user_id, username, email), clinic:clinic_id(clinic_id, name, primary_color, secondary_color, logo_url, created_at, updated_at)`)
      .eq('invitation_id', id).single();

    res.json(formatInvitation(withJoins || updated));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /invitations/:id
router.delete('/:id', requireAuth, requireRole('admin', 'superadmin'), async (req: Request, res: Response) => {
  try {
    const clinic = (req as any).clinic;
    const { id } = req.params;
    const { error } = await supabaseServer.from('invitations').delete().eq('invitation_id', id).eq('clinic_id', clinic.clinicId);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST /invitations/accept (public)
router.post('/accept', async (req: Request, res: Response) => {
  try {
    const { invitationToken, password } = req.body;
    if (!invitationToken || !password) return res.status(400).json({ error: 'invitationToken and password required' });

    const { data: invRow, error: invError } = await supabaseServer.from('invitations')
      .select(`*, invitedByUser:invited_by(user_id, username, email), clinic:clinic_id(clinic_id, name, primary_color, secondary_color, logo_url, created_at, updated_at)`)
      .eq('invitation_token', invitationToken).single();
    if (invError || !invRow) return res.status(404).json({ error: 'Invalid invitation token.' });
    if (new Date(invRow.expires_at) < new Date()) return res.status(410).json({ error: 'This invitation has expired.' });
    if (invRow.status !== 'invited') return res.status(400).json({ error: 'This invitation has already been used.' });

    const clinicId = invRow.clinic_id;
    const { data: existingUser } = await supabaseServer.from('users').select('*').eq('email', invRow.email).single();

    let user: any;
    if (existingUser) {
      const { error: signInError } = await supabaseAuth.auth.signInWithPassword({ email: invRow.email, password });
      if (signInError) throw new Error('Invalid password. Please use your existing account password.');
      user = existingUser;
      const { error: addErr } = await supabaseServer.rpc('add_user_to_clinic', { p_user_id: user.user_id, p_clinic_id: clinicId });
      if (addErr) throw new Error(`Failed to add to clinic: ${addErr.message}`);
    } else {
      const { data: authData, error: authError } = await supabaseServer.auth.admin.createUser({ email: invRow.email, password, email_confirm: true });
      if (authError) throw new Error(`Failed to create user: ${authError.message}`);

      const { data: newUser, error: userError } = await supabaseServer.from('users').insert({
        user_id: authData.user.id, email: invRow.email, username: invRow.email.split('@')[0],
        clinic_id: clinicId, active_clinic_id: clinicId, clinic_ids: [clinicId], user_role: invRow.user_role,
      }).select('*').single();

      if (userError) {
        await supabaseServer.auth.admin.deleteUser(authData.user.id);
        throw new Error(`Failed to create user record: ${userError.message}`);
      }
      user = newUser;
      await supabaseServer.rpc('add_user_to_clinic', { p_user_id: authData.user.id, p_clinic_id: clinicId });
    }

    await supabaseServer.from('invitations').update({ status: 'accepted', accepted_at: new Date().toISOString() }).eq('invitation_id', invRow.invitation_id);

    const { data: clinic } = await supabaseServer.from('clinics').select('*').eq('clinic_id', clinicId).single();
    const { data: updatedUser } = await supabaseServer.from('users').select('*').eq('user_id', user.user_id).single();

    const token = generateToken({ userId: updatedUser.user_id, clinicId, userRole: invRow.user_role });
    res.json({
      token,
      user: {
        userId: updatedUser.user_id, username: updatedUser.username, email: updatedUser.email,
        clinicId, activeClinicId: clinicId, userRole: invRow.user_role,
        createdAt: updatedUser.created_at, updatedAt: updatedUser.updated_at,
      },
      clinic: {
        clinicId: clinic.clinic_id, name: clinic.name, primaryColor: clinic.primary_color,
        secondaryColor: clinic.secondary_color, logoUrl: clinic.logo_url,
        createdAt: clinic.created_at, updatedAt: clinic.updated_at,
      },
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
