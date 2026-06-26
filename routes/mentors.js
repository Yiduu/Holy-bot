'use strict';

const express = require('express');

module.exports = function mentorRoutes(supabase, requireAuth) {
  const router = express.Router();

  // GET /api/mentors – list available mentors
  router.get('/', requireAuth, async (req, res) => {
    let { topic_id, topic } = req.query;
    if (topic && !topic_id) topic_id = topic;

    // Get user's sex for same‑sex matching
    const { data: userData } = await supabase
      .from('users')
      .select('sex')
      .eq('telegram_id', req.telegramUser.id)
      .single();

    const userSex = userData?.sex;

    let query = supabase
      .from('users')
      .select('telegram_id, anonymous_id, sex, user_settings(bio, specialization, max_mentees, display_name)')
      .eq('role', 'mentor')
      .eq('is_banned', false);

    if (userSex && userSex !== 'prefer_not') {
      query = query.or(`preferred_mentee_sex.eq.${userSex},preferred_mentee_sex.eq.both`);
    }

    // Resolve topic identifier (can be ID, slug, or name)
    if (topic_id) {
      // If not a pure number, look up the numeric ID from topics table
      if (isNaN(Number(topic_id))) {
        const { data: topicData, error: topicErr } = await supabase
          .from('topics')
          .select('id')
          .or(`slug.eq.${topic_id},name.eq.${topic_id}`)
          .single();
        if (topicErr) {
          // If lookup fails, return empty list (invalid topic)
          return res.json([]);
        }
        topic_id = topicData.id;
      }
      // Filter mentors linked to this topic via mentor_topics
      const { data: mentorIds, error: mentorErr } = await supabase
        .from('mentor_topics')
        .select('telegram_id')
        .eq('topic_id', topic_id);
      if (mentorErr) return res.status(500).json({ error: mentorErr.message });
      const ids = (mentorIds || []).map(m => m.telegram_id);
      if (ids.length === 0) return res.json([]);
      query = query.in('telegram_id', ids);
    }

    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });

    // Enrich with mentee counts and expertise topics
    const enriched = await Promise.all((data || []).map(async (mentor) => {
      const { count } = await supabase.from('mentorship_assignments')
        .select('id', { count: 'exact', head: true })
        .eq('mentor_id', mentor.telegram_id)
        .eq('is_active', true);

      // Fetch mentor's topic IDs
      const { data: mtRows } = await supabase.from('mentor_topics')
        .select('topic_id')
        .eq('telegram_id', mentor.telegram_id);
      const topicIds = (mtRows || []).map(t => t.topic_id);

      let expertise_topics = [];
      if (topicIds.length) {
        const { data: topics } = await supabase.from('topics')
          .select('name')
          .in('id', topicIds);
        expertise_topics = (topics || []).map(t => t.name);
      }

      return {
        ...mentor,
        mentee_count: count || 0,
        expertise_topics,
      };
    }));

    res.json(enriched);
  });

  // POST /api/mentors/request – request mentorship
  router.post('/request', requireAuth, async (req, res) => {
    const { id: user_id } = req.telegramUser;
    const { mentor_id, message } = req.body;
    if (!mentor_id) return res.status(400).json({ error: 'mentor_id required' });

    // Check user has no active mentor
    const { data: activeAssign } = await supabase
      .from('mentorship_assignments')
      .select('id')
      .eq('user_id', user_id)
      .eq('is_active', true)
      .single();
    if (activeAssign) return res.status(409).json({ error: 'You already have an active mentor' });

    // Check for existing pending request
    const { data: existingPending } = await supabase
      .from('mentorship_requests')
      .select('id')
      .eq('user_id', user_id)
      .eq('mentor_id', mentor_id)
      .eq('status', 'pending')
      .single();
    if (existingPending) return res.status(409).json({ error: 'Request already pending' });

    // Determine topic_id for the request
    let topic_id = req.body.topic_id;
    if (!topic_id) {
      const [userTopicsRes, mentorTopicsRes] = await Promise.all([
        supabase.from('user_topics').select('topic_id').eq('telegram_id', user_id),
        supabase.from('mentor_topics').select('topic_id').eq('telegram_id', mentor_id)
      ]);
      const userTids = (userTopicsRes.data || []).map(t => t.topic_id);
      const mentorTids = (mentorTopicsRes.data || []).map(t => t.topic_id);
      const common = userTids.filter(id => mentorTids.includes(id));
      if (common.length === 0) {
        return res.status(400).json({ error: 'User and mentor have no overlapping topics' });
      }
      topic_id = common[0];
    }

    // Check for existing rejected request – update it instead of inserting
    const { data: existingAny } = await supabase
      .from('mentorship_requests')
      .select('id, status')
      .eq('user_id', user_id)
      .eq('mentor_id', mentor_id)
      .maybeSingle();

    let result;
    if (existingAny) {
      if (existingAny.status === 'pending') {
        return res.status(409).json({ error: 'Request already pending' });
      }
      // Re‑activate a rejected or accepted request (so we don't cause duplicate key)
      result = await supabase
        .from('mentorship_requests')
        .update({
          status: 'pending',
          message,
          topic_id,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingAny.id)
        .select()
        .single();
    } else {
      // Insert a completely new request
      result = await supabase
        .from('mentorship_requests')
        .insert({ user_id, mentor_id, message, topic_id })
        .select()
        .single();
    }
    console.log('[Mentorship Request]', { user_id, mentor_id, topic_id, existingAny, result });
    if (result.error) return res.status(500).json({ error: result.error.message });

    // Get mentee details and topic name for notification
    const { data: mentee } = await supabase
      .from('users')
      .select('anonymous_id, sex, age_range')
      .eq('telegram_id', user_id)
      .single();
    const { data: topicData } = await supabase
      .from('topics')
      .select('name')
      .eq('id', topic_id)
      .single();

    const { notifyMentorshipRequest } = require('../bot');
    await notifyMentorshipRequest(mentor_id, user_id, mentee?.anonymous_id, mentee?.sex, mentee?.age_range, topicData?.name);

    res.status(201).json(result.data);
  });

  // GET /api/mentors/my-requests – mentor sees incoming requests
  router.get('/my-requests', requireAuth, async (req, res) => {
    const { id: mentor_id } = req.telegramUser;
    const { data, error } = await supabase
      .from('mentorship_requests')
      .select('*, user:user_id(anonymous_id, sex, age_range, user_settings(display_name)), topic:topic_id(name)')
      .eq('mentor_id', mentor_id)
      .eq('status', 'pending');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // PATCH /api/mentors/request/:id – accept/reject
  router.patch('/request/:id', requireAuth, async (req, res) => {
    const { id: mentor_id } = req.telegramUser;
    const { action } = req.body; // 'accepted' | 'rejected'

    if (!['accepted', 'rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    // First, get the request to ensure it exists and belongs to this mentor
    const { data: reqData, error: fetchErr } = await supabase
      .from('mentorship_requests')
      .select('*')
      .eq('id', req.params.id)
      .eq('mentor_id', mentor_id)
      .single();
    if (fetchErr) return res.status(404).json({ error: 'Request not found' });

        if (action === 'accepted') {
      console.log(`[Accept] Trying to accept request ${req.params.id} by mentor ${mentor_id}`);
      // Call the new robust RPC (we'll create it in Step 2)
      const { data, error: rpcErr } = await supabase.rpc('accept_mentorship_request_v2', {
        p_request_id: req.params.id,
        p_mentor_id: mentor_id
      });

      if (rpcErr) {
        console.error('[Accept] RPC error:', rpcErr);
        return res.status(500).json({ error: rpcErr.message });
      }
      if (data && data.error) {
        const status = data.error.includes('already has an active mentor') ? 409 : 400;
        return res.status(status).json({ error: data.error });
      }

      // Auto-reject other pending requests
      try {
        const { rejectOtherPendingRequestsForUser } = require('../bot');
        await rejectOtherPendingRequestsForUser(reqData.user_id, mentor_id, req.params.id);
      } catch (rejectErr) {
        console.error('[mentors] auto-reject error (non-fatal):', rejectErr.message);
      }
    } else {
      // Reject path stays the same
      const { error: updateErr } = await supabase
        .from('mentorship_requests')
        .update({ status: action, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);
      if (updateErr) return res.status(500).json({ error: updateErr.message });
    }

    // Notify user — wrapped in try/catch so a bot/Telegram failure never blocks the HTTP response
    try {
      const { data: mentor } = await supabase
        .from('users')
        .select('anonymous_id, user_settings(display_name)')
        .eq('telegram_id', mentor_id)
        .single();
      const mentorName = mentor?.user_settings?.display_name || mentor?.anonymous_id || 'Your mentor';

      const { notifyMentorshipAccepted, notifyMentorshipRejected } = require('../bot');
      if (action === 'accepted') {
        await notifyMentorshipAccepted(reqData.user_id, mentorName);
      } else {
        await notifyMentorshipRejected(reqData.user_id, mentorName);
      }
    } catch (notifyErr) {
      console.error('[mentors] notification error (non-fatal):', notifyErr.message);
    }

    // Emit socket event so the mini app refreshes in real-time
    try {
      const io = req.app.get('io');
      if (io) {
        io.to(String(mentor_id)).emit('mentorship_request_updated', {
          requestId: req.params.id,
          status: action
        });
      }
    } catch (socketErr) {
      console.error('[mentors] socket emit error (non-fatal):', socketErr.message);
    }

    res.json({ success: true, status: action });
  });

  // GET /api/mentors/my-mentees – list active mentees
  router.get('/my-mentees', requireAuth, async (req, res) => {
    const { id: mentor_id } = req.telegramUser;
    const { data, error } = await supabase
      .from('mentorship_assignments')
      .select('*, user:user_id(telegram_id, anonymous_id, last_active, user_settings(display_name))')
      .eq('mentor_id', mentor_id)
      .eq('is_active', true);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // GET /api/mentors/my-mentees/stats – session counts per mentee
  router.get('/my-mentees/stats', requireAuth, async (req, res) => {
    const { id: mentor_id } = req.telegramUser;
    const { data: assignments } = await supabase
      .from('mentorship_assignments')
      .select('user_id')
      .eq('mentor_id', mentor_id)
      .eq('is_active', true);
    if (!assignments) return res.json({});
    const stats = {};
    for (const a of assignments) {
      const { count } = await supabase
        .from('session_participants')
        .select('session_id', { count: 'exact', head: true })
        .eq('telegram_id', a.user_id);
      stats[a.user_id] = count || 0;
    }
    res.json(stats);
  });

  // POST /api/mentors/notes – add/update private note
  router.post('/notes', requireAuth, async (req, res) => {
    const { id: mentor_id } = req.telegramUser;
    const { mentee_id, content } = req.body;
    const { data, error } = await supabase
      .from('mentor_notes')
      .upsert({ mentor_id, mentee_id, content, updated_at: new Date().toISOString() }, { onConflict: 'mentor_id,mentee_id' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // GET /api/mentors/notes/:mentee_id – get private note
  router.get('/notes/:mentee_id', requireAuth, async (req, res) => {
    const { id: mentor_id } = req.telegramUser;
    const { data } = await supabase
      .from('mentor_notes')
      .select('content')
      .eq('mentor_id', mentor_id)
      .eq('mentee_id', req.params.mentee_id)
      .single();
    res.json(data || { content: '' });
  });

  // POST /api/mentors/transfer – transfer mentorship request or active assignment
  router.post('/transfer', requireAuth, async (req, res) => {
    const { id: current_mentor_id } = req.telegramUser;
    const { type, id, target_mentor_id } = req.body;

    if (!type || !id || !target_mentor_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const targetTid = parseInt(target_mentor_id);
    if (isNaN(targetTid)) return res.status(400).json({ error: 'Invalid target mentor ID' });

    try {
      if (type === 'request') {
        const { data: request, error: fetchErr } = await supabase
          .from('mentorship_requests')
          .select('*')
          .eq('id', id)
          .eq('mentor_id', current_mentor_id)
          .single();

        if (fetchErr || !request) return res.status(404).json({ error: 'Request not found or not assigned to you' });

        const { error: updateErr } = await supabase
          .from('mentorship_requests')
          .update({ mentor_id: targetTid, updated_at: new Date().toISOString() })
          .eq('id', id);

        if (updateErr) return res.status(500).json({ error: updateErr.message });

        // Get mentee details and topic name
        const { data: mentee } = await supabase
          .from('users')
          .select('anonymous_id, sex, age_range')
          .eq('telegram_id', request.user_id)
          .single();
        const { data: topicData } = await supabase
          .from('topics')
          .select('name')
          .eq('id', request.topic_id)
          .single();

        const { notifyMentorshipRequest } = require('../bot');
        await notifyMentorshipRequest(targetTid, request.user_id, mentee?.anonymous_id, mentee?.sex, mentee?.age_range, topicData?.name);

        return res.json({ success: true });

      } else if (type === 'assignment') {
        const { data: assignment, error: fetchErr } = await supabase
          .from('mentorship_assignments')
          .select('*')
          .eq('id', id)
          .eq('mentor_id', current_mentor_id)
          .eq('is_active', true)
          .single();

        if (fetchErr || !assignment) return res.status(404).json({ error: 'Active assignment not found' });

        const { error: updateErr } = await supabase
          .from('mentorship_assignments')
          .update({ mentor_id: targetTid })
          .eq('id', id);

        if (updateErr) return res.status(500).json({ error: updateErr.message });

        const [{ data: user }, { data: newMentor }] = await Promise.all([
          supabase.from('users').select('chat_id').eq('telegram_id', assignment.user_id).single(),
          supabase.from('users').select('anonymous_id, user_settings(display_name)').eq('telegram_id', targetTid).single()
        ]);

        const newMentorName = newMentor?.user_settings?.display_name || newMentor?.anonymous_id || 'Your new mentor';
        const { safeSend, getUserLang } = require('../bot');
        if (user?.chat_id) {
          const lang = await getUserLang(assignment.user_id);
          const text = lang === 'am'
            ? `📋 የምክር አገልግሎትዎ ወደ አማካሪ *${newMentorName}* ተላልፏል።`
            : `📋 Your mentorship has been transferred to mentor *${newMentorName}*.`;
          await safeSend(user.chat_id, text);
        }

        const { data: menteeUser } = await supabase
          .from('users')
          .select('anonymous_id, user_settings(display_name)')
          .eq('telegram_id', assignment.user_id)
          .single();
        const menteeName = menteeUser?.user_settings?.display_name || menteeUser?.anonymous_id || 'A mentee';

        const targetLang = await getUserLang(targetTid);
        const targetText = targetLang === 'am'
          ? `📋 አዲስ ተመካሪ በዝውውር ቀርቦልዎታል፡ *${menteeName}*`
          : `📋 A new mentee has been transferred to you: *${menteeName}*`;
        await safeSend(targetTid, targetText);

        return res.json({ success: true });
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    res.status(400).json({ error: 'Invalid type' });
  });

  // DELETE /api/mentors/end-mentorship/:assignment_id
  router.delete('/end-mentorship/:assignment_id', requireAuth, async (req, res) => {
    const { id: mentor_id } = req.telegramUser;
    const { error } = await supabase
      .from('mentorship_assignments')
      .update({ is_active: false, ended_at: new Date().toISOString() })
      .eq('id', req.params.assignment_id)
      .eq('mentor_id', mentor_id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  return router;
};