import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabaseServer } from '../utils/supabase';

const router = Router();

// POST /feedback
router.post('/feedback', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const clinic = (req as any).clinic;
    const { feedbackType, feedbackMessage } = req.body;

    if (!feedbackType || !feedbackMessage) {
      return res.status(400).json({ error: 'feedbackType and feedbackMessage required' });
    }

    const validTypes = ['Feature_Request', 'Bug', 'Other'];
    if (!validTypes.includes(feedbackType)) {
      return res.status(400).json({ error: `feedbackType must be one of: ${validTypes.join(', ')}` });
    }

    const { data: feedback, error } = await supabaseServer
      .from('feedback')
      .insert({
        clinic_id: clinic.clinicId,
        user_id: user.userId,
        feedback_type: feedbackType,
        feedback_message: feedbackMessage,
      })
      .select()
      .single();

    if (error || !feedback) {
      throw new Error(`Failed to create feedback: ${error?.message}`);
    }

    res.status(201).json({
      feedbackId: feedback.feedback_id,
      clinicId: feedback.clinic_id,
      userId: feedback.user_id,
      feedbackType: feedback.feedback_type,
      feedbackMessage: feedback.feedback_message,
      createdAt: feedback.created_at,
      updatedAt: feedback.updated_at,
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
