'use strict';

const express = require('express');

// ─── Stats cache (1 hour TTL) ─────────────────────────────────────────────────
let statsCache = null;
let statsCacheTime = 0;
const STATS_TTL = 60 * 60 * 1000; // 1 hour

module.exports = function userRoutes(supabase, requireAuth) {
  const router = express.Router();

  // GET /api/users/stats – dashboard counters
  router.get('/stats', requireAuth, async (req, res) => {
    // Return cached result if still fresh
    if (statsCache && Date.now() - statsCacheTime < STATS_TTL) {
      return res.json(statsCache);
    }

    const today = new Date(); today.setHours(0, 0, 0, 0);

    const [usersRes, mentorsRes, sessionsRes] = await Promise.all([
      supabase.from('users').select('telegram_id', { count: 'exact', head: true }).eq('is_banned', false),
      supabase.from('users').select('telegram_id', { count: 'exact', head: true }).eq('role', 'mentor').eq('is_banned', false),
      supabase.from('video_sessions').select('id', { count: 'exact', head: true }).eq('status', 'ended').gte('ended_at', today.toISOString()),
    ]);

    statsCache = {
      total_users: usersRes.count || 0,
      active_mentors: mentorsRes.count || 0,
      sessions_today: sessionsRes.count || 0,
    };
    statsCacheTime = Date.now();

    res.json(statsCache);
  });


  // GET /api/users/settings
  router.get('/settings', requireAuth, async (req, res) => {
    const { id } = req.telegramUser;
    const [settingsRes, userRes] = await Promise.all([
      supabase.from('user_settings').select('*').eq('telegram_id', id).single(),
      supabase.from('users').select('accepting_requests, preferred_mentee_sex').eq('telegram_id', id).single()
    ]);
    if (settingsRes.error) return res.status(500).json({ error: settingsRes.error.message });
    const merged = {
      ...settingsRes.data,
      accepting_requests: userRes.data ? userRes.data.accepting_requests !== false : true,
      preferred_mentee_sex: userRes.data?.preferred_mentee_sex || 'prefer_not'
    };
    res.json(merged);
  });

  // PATCH /api/users/settings
  router.patch('/settings', requireAuth, async (req, res) => {
    const { id } = req.telegramUser;
    const allowed = ['display_name', 'notify_messages', 'notify_sessions', 'notify_daily_verse',
      'availability_start', 'availability_end', 'max_mentees', 'bio', 'specialization'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date().toISOString();

    const promises = [
      supabase.from('user_settings').update(updates).eq('telegram_id', id).select().single()
    ];

    if (req.body.accepting_requests !== undefined) {
      promises.push(
        supabase.from('users').update({ accepting_requests: req.body.accepting_requests }).eq('telegram_id', id)
      );
    }

    if (req.body.preferred_mentee_sex !== undefined) {
      const valid = ['M', 'F', 'prefer_not'];
      if (!valid.includes(req.body.preferred_mentee_sex)) {
        return res.status(400).json({ error: 'Invalid preferred_mentee_sex value' });
      }
      promises.push(
        supabase.from('users').update({ preferred_mentee_sex: req.body.preferred_mentee_sex }).eq('telegram_id', id)
      );
    }

    const results = await Promise.all(promises);
    const settingsResult = results[0];
    if (settingsResult.error) return res.status(500).json({ error: settingsResult.error.message });

    const merged = {
      ...settingsResult.data,
      accepting_requests: req.body.accepting_requests !== undefined
        ? req.body.accepting_requests
        : (await supabase.from('users').select('accepting_requests').eq('telegram_id', id).single()).data?.accepting_requests !== false,
      preferred_mentee_sex: req.body.preferred_mentee_sex !== undefined
        ? req.body.preferred_mentee_sex
        : (await supabase.from('users').select('preferred_mentee_sex').eq('telegram_id', id).single()).data?.preferred_mentee_sex || 'prefer_not'
    };
    res.json(merged);
  });

  // POST /api/users/apply-mentor
  router.post('/apply-mentor', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { sex, educational_background, about_me, answer_q1, answer_q2, answer_q3 } = req.body;

    // Support both formats seamlessly
    const finalSex = sex || answer_q1;
    const finalEdu = educational_background || answer_q2;
    const finalAbout = about_me || answer_q3;

    if (!finalSex || !finalEdu) return res.status(400).json({ error: 'Answers required' });

    // Check not already a mentor
    const { data: user } = await supabase.from('users').select('role').eq('telegram_id', telegram_id).single();
    if (user?.role === 'mentor') return res.status(409).json({ error: 'Already a mentor' });

    // Check no pending application
    const { data: existing } = await supabase.from('mentor_applications').select('id').eq('telegram_id', telegram_id).eq('status', 'pending').single();
    if (existing) return res.status(409).json({ error: 'Application pending' });

    const { data, error } = await supabase.from('mentor_applications').insert({
      telegram_id,
      sex: finalSex,
      educational_background: finalEdu,
      about_me: finalAbout,
      answer_q1: finalSex,
      answer_q2: finalEdu,
      answer_q3: finalAbout
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  });

  // GET /api/users/my-mentor
  router.get('/my-mentor', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data, error } = await supabase
      .from('mentorship_assignments')
      .select('*, mentor:mentor_id(telegram_id, anonymous_id, photo_file_id, photo_updated_at, user_settings(bio, specialization, display_name))')
      .eq('user_id', telegram_id)
      .eq('is_active', true)
      .single();

    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
    res.json(data || null);
  });

  // GET /api/users/chat-partner – returns current user's partner(s)
  router.get('/chat-partner', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;

    const { data: user } = await supabase.from('users').select('role').eq('telegram_id', telegram_id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.role === 'mentor') {
      const { data: mentees, error } = await supabase
        .from('mentorship_assignments')
        .select('user:user_id(telegram_id, anonymous_id, last_active, photo_file_id, photo_updated_at, user_settings(display_name))')
        .eq('mentor_id', telegram_id)
        .eq('is_active', true);

      if (error) return res.status(500).json({ error: error.message });

      if (!mentees || mentees.length === 0) {
        return res.json({ type: 'none' });
      } else if (mentees.length === 1) {
        const m = mentees[0].user;
        return res.json({
          type: 'single',
          partner: {
            telegram_id: m.telegram_id,
            anonymous_id: m.anonymous_id,
            display_name: m.user_settings?.display_name || m.anonymous_id,
            last_active: m.last_active,
            photo_file_id: m.photo_file_id,
            photo_updated_at: m.photo_updated_at
          }
        });
      } else {
        const list = mentees.map(m => ({
          telegram_id: m.user.telegram_id,
          anonymous_id: m.user.anonymous_id,
          display_name: m.user.user_settings?.display_name || m.user.anonymous_id,
          last_active: m.user.last_active,
          photo_file_id: m.user.photo_file_id,
          photo_updated_at: m.user.photo_updated_at
        }));
        return res.json({ type: 'multiple', mentees: list });
      }
    } else {
      const { data: assignment, error } = await supabase
        .from('mentorship_assignments')
        .select('mentor:mentor_id(telegram_id, anonymous_id, last_active, photo_file_id, photo_updated_at, user_settings(display_name))')
        .eq('user_id', telegram_id)
        .eq('is_active', true)
        .single();

      if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
      if (!assignment) return res.json({ type: 'none' });

      const m = assignment.mentor;
      return res.json({
        type: 'single',
        partner: {
          telegram_id: m.telegram_id,
          anonymous_id: m.anonymous_id,
          display_name: m.user_settings?.display_name || m.anonymous_id,
          last_active: m.last_active,
          photo_file_id: m.photo_file_id,
          photo_updated_at: m.photo_updated_at
        }
      });
    }
  });

  // GET /api/users/weekly-activity
  router.get('/weekly-activity', requireAuth, async (req, res) => {
    const days = 7;
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0);
      const next = new Date(d); next.setDate(next.getDate() + 1);
      const { count: msgCount } = await supabase.from('messages').select('id', { count: 'exact', head: true }).gte('created_at', d.toISOString()).lt('created_at', next.toISOString());
      const { count: sessCount } = await supabase.from('video_sessions').select('id', { count: 'exact', head: true }).gte('created_at', d.toISOString()).lt('created_at', next.toISOString());
      result.push({ date: d.toLocaleDateString('en', { weekday: 'short' }), messages: msgCount || 0, sessions: sessCount || 0 });
    }
    res.json(result);
  });

  // POST /api/users/end-mentorship
  router.post('/end-mentorship', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;

    try {
      // Find active assignment where user is the mentee
      const { data: assignment, error } = await supabase
        .from('mentorship_assignments')
        .select('id, mentor_id')
        .eq('user_id', telegram_id)
        .eq('is_active', true)
        .single();

      if (error || !assignment) {
        return res.status(404).json({ error: 'No active mentorship found' });
      }

      // Fetch mentor's display name for the mini app's rating popup
      const { data: mentor } = await supabase
        .from('users')
        .select('telegram_id, anonymous_id, user_settings(display_name)')
        .eq('telegram_id', assignment.mentor_id)
        .single();

      // Update assignment
      const { error: updateErr } = await supabase
        .from('mentorship_assignments')
        .update({ is_active: false, ended_at: new Date().toISOString() })
        .eq('id', assignment.id);

      if (updateErr) {
        return res.status(500).json({ error: updateErr.message });
      }

      // Call bot's endMentorship to handle notifications and rating prompts
      const { endMentorship: botEndMentorship } = require('../bot');
      await botEndMentorship(telegram_id, assignment.mentor_id, 'mentee');

      res.json({
        success: true,
        mentor: {
          telegram_id: assignment.mentor_id,
          display_name: mentor?.user_settings?.display_name || mentor?.anonymous_id || 'Your mentor'
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/users/pending-rating – checks whether the caller has a recently
  // ended mentorship (ended by the mentor) that they haven't rated yet, so the
  // mini app can pop the rating modal open as soon as they next load it.
  router.get('/pending-rating', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: assignment, error } = await supabase
      .from('mentorship_assignments')
      .select('id, mentor_id, ended_at, mentor:mentor_id(telegram_id, anonymous_id, user_settings(display_name))')
      .eq('user_id', telegram_id)
      .eq('is_active', false)
      .gte('ended_at', sevenDaysAgo)
      .order('ended_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !assignment) return res.json(null);

    const { data: existingRating } = await supabase
      .from('mentor_ratings')
      .select('id')
      .eq('mentor_id', assignment.mentor_id)
      .eq('user_id', telegram_id)
      .gte('created_at', assignment.ended_at)
      .maybeSingle();

    if (existingRating) return res.json(null);

    const m = assignment.mentor;
    res.json({
      mentor_id: assignment.mentor_id,
      display_name: m?.user_settings?.display_name || m?.anonymous_id || 'Your mentor'
    });
  });

  return router;
};