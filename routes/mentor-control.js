'use strict';

const express = require('express');

// Localized copy for the Telegram notifications this module sends. Mirrors
// the pattern used in routes/admin.js (CONTACT_PREFIX) and bot.js.
const MSG = {
  suspended: {
    en: (reason) => `Mentor Account Suspended\n\nYour mentor status has been temporarily suspended by the admin team${reason ? `:\n\n"${reason}"` : '.'}\n\nYou will not appear in mentor search and will not receive new mentorship requests until this is lifted. Any mentees you are already paired with are unaffected. Contact support if you have questions.`,
    am: (reason) => `የአማካሪ አካውንት ታግዷል\n\nየአማካሪነት ሁኔታዎ በአስተዳደር ቡድን ለጊዜው ታግዷል${reason ? `፦\n\n"${reason}"` : '።'}\n\nይህ እስኪነሳ ድረስ በአማካሪ ፍለጋ ውስጥ አይታዩም እንዲሁም አዲስ ጥያቄዎችን አይቀበሉም። ቀድሞ የተጣመሩ ተመካሪዎች አይነኩም። ጥያቄ ካለዎት ድጋፍን ያነጋግሩ።`,
  },
  reactivated: {
    en: 'Mentor Account Reactivated\n\nYour mentor status has been restored. You are visible in mentor search again and can receive new mentorship requests.',
    am: 'የአማካሪ አካውንት ተመልሷል\n\nየአማካሪነት ሁኔታዎ ተመልሷል። በአማካሪ ፍለጋ ውስጥ እንደገና ይታያሉ እና አዲስ ጥያቄዎችን መቀበል ይችላሉ።',
  },
  unassignedMentor: {
    en: (name) => `An administrator has ended your mentorship pairing with ${name}.`,
    am: (name) => `አስተዳዳሪ ከ${name} ጋር የነበረዎትን የምክር ግንኙነት አቁሟል።`,
  },
  unassignedMentee: {
    en: (name) => `An administrator has ended your mentorship pairing with ${name}.`,
    am: (name) => `አስተዳዳሪ ከ${name} ጋር የነበረዎትን የምክር ግንኙነት አቁሟል።`,
  },
  ADMIN_MESSAGE_PREFIX: {
    en: 'Message from the Admin Team',
    am: 'መልእክት ከአስተዳደር ቡድን',
  },
};

module.exports = function mentorControlRoutes(supabase, requireAuth, requireAdmin) {
  const router = express.Router();
  router.use(requireAuth, requireAdmin);

  async function logAudit(admin_id, action, target_id, target_type, details = {}) {
    await supabase.from('audit_logs').insert({ admin_id, action, target_id, target_type, details });
  }

  const DEFAULT_MAX_MENTEES = parseInt(process.env.MAX_MENTEES_DEFAULT || '3');

  // ==================== OVERVIEW ====================
  // Snapshot stats for a "Mentor Control" dashboard header.
  router.get('/overview', async (req, res) => {
    try {
      const [
        totalMentors,
        suspendedMentors,
        notAccepting,
        activeAssignments,
        pendingApps,
      ] = await Promise.all([
        supabase.from('users').select('telegram_id', { count: 'exact', head: true }).eq('role', 'mentor'),
        supabase.from('mentors').select('telegram_id', { count: 'exact', head: true }).eq('suspended_by_admin', true),
        supabase.from('users').select('telegram_id', { count: 'exact', head: true }).eq('role', 'mentor').eq('accepting_requests', false),
        supabase.from('mentorship_assignments').select('id', { count: 'exact', head: true }).eq('is_active', true),
        supabase.from('mentor_applications').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      ]);

      const { data: ratingRows } = await supabase.from('users').select('rating, rating_count').eq('role', 'mentor').gt('rating_count', 0);
      const avgRating = ratingRows && ratingRows.length
        ? ratingRows.reduce((sum, r) => sum + (r.rating || 0), 0) / ratingRows.length
        : null;

      res.json({
        total_mentors: totalMentors.count || 0,
        suspended_mentors: suspendedMentors.count || 0,
        paused_by_self: notAccepting.count || 0,
        active_mentees: activeAssignments.count || 0,
        pending_applications: pendingApps.count || 0,
        avg_rating: avgRating !== null ? Math.round(avgRating * 100) / 100 : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== MENTOR LIST ====================
  // status: all | active | suspended | paused | full
  router.get('/mentors', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.max(1, parseInt(req.query.limit) || 20);
      const offset = (page - 1) * limit;
      const search = req.query.search || '';
      const status = req.query.status || 'all';

      let query = supabase
        .from('users')
        .select(`
          telegram_id, anonymous_id, rating, rating_count, accepting_requests, created_at, last_active,
          user_settings(display_name, bio, specialization, max_mentees),
          mentors(is_active, suspended_by_admin, suspended_at, suspended_reason, admin_notes, joined_at, max_clients)
        `, { count: 'exact' })
        .eq('role', 'mentor');

      if (search) query = query.ilike('anonymous_id', `%${search}%`);
      // Note: 'suspended' and 'full' can't be pushed down to this query (they
      // depend on the embedded mentors row / a separate mentee-count query),
      // so they're applied in-memory below. 'paused' is a plain users column
      // and safe to filter at the DB level.
      if (status === 'paused') query = query.eq('accepting_requests', false);

      const { data, count, error } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) return res.status(500).json({ error: error.message });

      const mentors = data || [];
      const ids = mentors.map(m => m.telegram_id);

      // Active mentee counts, batched with one query instead of N.
      const counts = {};
      if (ids.length) {
        const { data: assigns } = await supabase
          .from('mentorship_assignments')
          .select('mentor_id')
          .eq('is_active', true)
          .in('mentor_id', ids);
        (assigns || []).forEach(a => { counts[a.mentor_id] = (counts[a.mentor_id] || 0) + 1; });
      }

      let formatted = mentors.map(m => {
        const maxMentees = m.user_settings?.max_mentees || DEFAULT_MAX_MENTEES;
        const menteeCount = counts[m.telegram_id] || 0;
        return {
          telegram_id: m.telegram_id,
          anonymous_id: m.anonymous_id,
          display_name: m.user_settings?.display_name || null,
          bio: m.user_settings?.bio || null,
          specialization: m.user_settings?.specialization || null,
          rating: m.rating || 0,
          rating_count: m.rating_count || 0,
          accepting_requests: m.accepting_requests !== false,
          suspended_by_admin: !!m.mentors?.suspended_by_admin,
          suspended_at: m.mentors?.suspended_at || null,
          suspended_reason: m.mentors?.suspended_reason || null,
          has_admin_notes: !!(m.mentors?.admin_notes && m.mentors.admin_notes.trim()),
          joined_at: m.mentors?.joined_at || m.created_at,
          last_active: m.last_active,
          max_mentees: maxMentees,
          mentee_count: menteeCount,
          at_capacity: menteeCount >= maxMentees,
        };
      });

      if (status === 'active') formatted = formatted.filter(m => !m.suspended_by_admin);
      if (status === 'suspended') formatted = formatted.filter(m => m.suspended_by_admin);
      if (status === 'full') formatted = formatted.filter(m => m.at_capacity);

      res.json({
        mentors: formatted,
        total: count || 0,
        page,
        pages: Math.ceil((count || 0) / limit),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== MENTOR DETAIL ====================
  router.get('/mentors/:id', async (req, res) => {
    try {
      const telegram_id = parseInt(req.params.id);

      const { data: mentor, error } = await supabase
        .from('users')
        .select(`
          telegram_id, anonymous_id, rating, rating_count, accepting_requests, created_at, last_active, sex, preferred_mentee_sex,
          user_settings(display_name, bio, specialization, max_mentees, availability_start, availability_end),
          mentors(is_active, suspended_by_admin, suspended_at, suspended_reason, admin_notes, joined_at, max_clients)
        `)
        .eq('telegram_id', telegram_id)
        .eq('role', 'mentor')
        .single();

      if (error || !mentor) return res.status(404).json({ error: 'Mentor not found' });

      const [{ data: mtRows }, { data: activeAssignments }, { data: pastAssignments }] = await Promise.all([
        supabase.from('mentor_topics').select('topic_id, topics(name)').eq('telegram_id', telegram_id),
        supabase.from('mentorship_assignments')
          .select('id, assigned_at, mentee:user_id(telegram_id, anonymous_id, last_active)')
          .eq('mentor_id', telegram_id)
          .eq('is_active', true),
        supabase.from('mentorship_assignments')
          .select('id', { count: 'exact', head: true })
          .eq('mentor_id', telegram_id)
          .eq('is_active', false),
      ]);

      const { data: recentAudit } = await supabase
        .from('audit_logs')
        .select('action, admin_id, details, created_at')
        .eq('target_id', telegram_id)
        .eq('target_type', 'mentor')
        .order('created_at', { ascending: false })
        .limit(20);

      const maxMentees = mentor.user_settings?.max_mentees || DEFAULT_MAX_MENTEES;

      res.json({
        telegram_id: mentor.telegram_id,
        anonymous_id: mentor.anonymous_id,
        display_name: mentor.user_settings?.display_name || null,
        bio: mentor.user_settings?.bio || null,
        specialization: mentor.user_settings?.specialization || null,
        availability_start: mentor.user_settings?.availability_start || null,
        availability_end: mentor.user_settings?.availability_end || null,
        rating: mentor.rating || 0,
        rating_count: mentor.rating_count || 0,
        accepting_requests: mentor.accepting_requests !== false,
        suspended_by_admin: !!mentor.mentors?.suspended_by_admin,
        suspended_at: mentor.mentors?.suspended_at || null,
        suspended_reason: mentor.mentors?.suspended_reason || null,
        admin_notes: mentor.mentors?.admin_notes || '',
        joined_at: mentor.mentors?.joined_at || mentor.created_at,
        last_active: mentor.last_active,
        max_mentees: maxMentees,
        expertise_topics: (mtRows || []).map(t => t.topics?.name).filter(Boolean),
        mentees: (activeAssignments || []).filter(a => a.mentee).map(a => ({
          assignment_id: a.id,
          telegram_id: a.mentee.telegram_id,
          anonymous_id: a.mentee.anonymous_id,
          last_active: a.mentee.last_active,
          assigned_at: a.assigned_at,
        })),
        mentee_count: (activeAssignments || []).length,
        past_mentee_count: pastAssignments?.count || 0,
        recent_actions: recentAudit || [],
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== SUSPEND / REACTIVATE ====================
  // Reversible, admin-driven control distinct from "disqualify" (which
  // permanently demotes the mentor back to a regular user). Suspension
  // hides the mentor from discovery and blocks new requests, but keeps
  // existing mentee relationships intact.
  router.patch('/mentors/:id/suspend', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const telegram_id = parseInt(req.params.id);
    const reason = (req.body?.reason || '').trim().substring(0, 500);

    const { data: user } = await supabase.from('users').select('role').eq('telegram_id', telegram_id).single();
    if (!user || user.role !== 'mentor') return res.status(404).json({ error: 'Mentor not found' });

    const { error } = await supabase.from('mentors').update({
      suspended_by_admin: true,
      suspended_at: new Date().toISOString(),
      suspended_reason: reason || null,
      is_active: false,
    }).eq('telegram_id', telegram_id);
    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('users').update({ accepting_requests: false }).eq('telegram_id', telegram_id);

    try {
      const { safeSend, getUserLang } = require('../bot');
      const lang = await getUserLang(telegram_id);
      const text = (MSG.suspended[lang] || MSG.suspended.en)(reason);
      await safeSend(telegram_id, text);
    } catch (notifyErr) {
      console.error('[mentor-control] Failed to notify mentor of suspension:', notifyErr.message);
    }

    await logAudit(admin_id, 'suspend_mentor', telegram_id, 'mentor', { reason: reason || null });
    res.json({ success: true });
  });

  router.patch('/mentors/:id/reactivate', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const telegram_id = parseInt(req.params.id);

    const { data: user } = await supabase.from('users').select('role').eq('telegram_id', telegram_id).single();
    if (!user || user.role !== 'mentor') return res.status(404).json({ error: 'Mentor not found' });

    const { error } = await supabase.from('mentors').update({
      suspended_by_admin: false,
      suspended_at: null,
      suspended_reason: null,
      is_active: true,
    }).eq('telegram_id', telegram_id);
    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('users').update({ accepting_requests: true }).eq('telegram_id', telegram_id);

    try {
      const { safeSend, getUserLang } = require('../bot');
      const lang = await getUserLang(telegram_id);
      await safeSend(telegram_id, MSG.reactivated[lang] || MSG.reactivated.en);
    } catch (notifyErr) {
      console.error('[mentor-control] Failed to notify mentor of reactivation:', notifyErr.message);
    }

    await logAudit(admin_id, 'reactivate_mentor', telegram_id, 'mentor');
    res.json({ success: true });
  });

  // ==================== CAPACITY OVERRIDE ====================
  // user_settings.max_mentees is the value mentors edit themselves and what
  // the mentor card / capacity checks (routes/mentors.js) actually read —
  // so that's the field an admin override has to write to.
  router.patch('/mentors/:id/capacity', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const telegram_id = parseInt(req.params.id);
    const max_mentees = parseInt(req.body?.max_mentees);

    if (!Number.isInteger(max_mentees) || max_mentees < 0 || max_mentees > 100) {
      return res.status(400).json({ error: 'max_mentees must be an integer between 0 and 100' });
    }

    const { data: user } = await supabase.from('users').select('role').eq('telegram_id', telegram_id).single();
    if (!user || user.role !== 'mentor') return res.status(404).json({ error: 'Mentor not found' });

    const { error } = await supabase.from('user_settings')
      .upsert({ telegram_id, max_mentees }, { onConflict: 'telegram_id' });
    if (error) return res.status(500).json({ error: error.message });

    // Best-effort mirror onto mentors.max_clients for consistency; not the
    // source of truth, so failures here shouldn't fail the request.
    await supabase.from('mentors').update({ max_clients: max_mentees }).eq('telegram_id', telegram_id);

    await logAudit(admin_id, 'set_mentor_capacity', telegram_id, 'mentor', { max_mentees });
    res.json({ success: true, max_mentees });
  });

  // ==================== ADMIN NOTES ====================
  // Private notes, never surfaced to the mentor or mentees.
  router.put('/mentors/:id/notes', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const telegram_id = parseInt(req.params.id);
    const notes = (req.body?.notes || '').substring(0, 4000);

    const { error } = await supabase.from('mentors')
      .upsert({ telegram_id, admin_notes: notes }, { onConflict: 'telegram_id' });
    if (error) return res.status(500).json({ error: error.message });

    await logAudit(admin_id, 'update_mentor_notes', telegram_id, 'mentor');
    res.json({ success: true });
  });

  // ==================== DIRECT MESSAGE TO MENTOR ====================
  router.post('/mentors/:id/message', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const telegram_id = parseInt(req.params.id);
    const message = (req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'message required' });

    const { data: user } = await supabase.from('users').select('role').eq('telegram_id', telegram_id).single();
    if (!user || user.role !== 'mentor') return res.status(404).json({ error: 'Mentor not found' });

    const { safeSend, getUserLang } = require('../bot');
    const lang = await getUserLang(telegram_id);
    const prefix = MSG.ADMIN_MESSAGE_PREFIX[lang] || MSG.ADMIN_MESSAGE_PREFIX.en;
    await safeSend(telegram_id, `${prefix}\n\n${message}`);

    await logAudit(admin_id, 'mentor_direct_message', telegram_id, 'mentor', { message: message.substring(0, 300) });
    res.json({ success: true });
  });

  // ==================== FORCE-UNASSIGN ONE MENTEE ====================
  // Ends a single mentor↔mentee pairing without disqualifying the mentor —
  // for cases like a reported conflict with one specific mentee, as opposed
  // to the mentor as a whole.
  router.patch('/mentors/:id/mentees/:menteeId/unassign', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const mentor_id = parseInt(req.params.id);
    const mentee_id = parseInt(req.params.menteeId);

    const { data: assignment, error: fetchErr } = await supabase
      .from('mentorship_assignments')
      .select('id')
      .eq('mentor_id', mentor_id)
      .eq('user_id', mentee_id)
      .eq('is_active', true)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!assignment) return res.status(404).json({ error: 'Active pairing not found' });

    const { error } = await supabase.from('mentorship_assignments')
      .update({ is_active: false, ended_at: new Date().toISOString() })
      .eq('id', assignment.id);
    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('messages')
      .update({ is_read: true })
      .or(`and(from_id.eq.${mentor_id},to_id.eq.${mentee_id}),and(from_id.eq.${mentee_id},to_id.eq.${mentor_id})`)
      .eq('is_read', false);

    try {
      const { safeSend, getUserLang } = require('../bot');
      const [{ data: mentor }, { data: mentee }] = await Promise.all([
        supabase.from('users').select('anonymous_id, user_settings(display_name)').eq('telegram_id', mentor_id).single(),
        supabase.from('users').select('anonymous_id, user_settings(display_name)').eq('telegram_id', mentee_id).single(),
      ]);
      const mentorName = mentor?.user_settings?.display_name || mentor?.anonymous_id || 'your mentor';
      const menteeName = mentee?.user_settings?.display_name || mentee?.anonymous_id || 'your mentee';

      const menteeLang = await getUserLang(mentee_id);
      await safeSend(mentee_id, (MSG.unassignedMentor[menteeLang] || MSG.unassignedMentor.en)(mentorName));

      const mentorLang = await getUserLang(mentor_id);
      await safeSend(mentor_id, (MSG.unassignedMentee[mentorLang] || MSG.unassignedMentee.en)(menteeName));
    } catch (notifyErr) {
      console.error('[mentor-control] Failed to notify parties of forced unassign:', notifyErr.message);
    }

    await logAudit(admin_id, 'admin_unassign_mentee', mentor_id, 'mentor', { mentee_id, assignment_id: assignment.id });
    res.json({ success: true });
  });

  return router;
};
