'use strict';

const express = require('express');

module.exports = function mentorRoutes(supabase, requireAuth) {
  const router = express.Router();

  // GET /api/mentors – list available mentors
  router.get('/', requireAuth, async (req, res) => {
    let { topic_id, topic } = req.query;
  if (topic && !topic_id) topic_id = topic;
    
    let query = supabase
      .from('users')
      .select('telegram_id, anonymous_id, user_settings(bio, specialization, max_mentees, display_name)')
      .eq('role', 'mentor')
      .eq('is_banned', false);
    
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

    // Enrich with mentee counts
    const enriched = await Promise.all((data || []).map(async (mentor) => {
      const { count } = await supabase.from('mentorship_assignments').select('id', { count: 'exact', head: true }).eq('mentor_id', mentor.telegram_id).eq('is_active', true);
      return { ...mentor, mentee_count: count || 0 };
    }));

    res.json(enriched);
  });

  // POST /api/mentors/request – request mentorship
  router.post('/request', requireAuth, async (req, res) => {
    const { id: user_id } = req.telegramUser;
    const { mentor_id, message } = req.body;
    if (!mentor_id) return res.status(400).json({ error: 'mentor_id required' });

    // Check user has no active mentor
    const { data: activeAssign } = await supabase.from('mentorship_assignments').select('id').eq('user_id', user_id).eq('is_active', true).single();
    if (activeAssign) return res.status(409).json({ error: 'You already have an active mentor' });

    // Check no pending request to same mentor
    const { data: pending } = await supabase.from('mentorship_requests').select('id').eq('user_id', user_id).eq('mentor_id', mentor_id).eq('status', 'pending').single();
    if (pending) return res.status(409).json({ error: 'Request already pending' });

    const { data, error } = await supabase.from('mentorship_requests').insert({ user_id, mentor_id, message }).select().single();
    if (error) return res.status(500).json({ error: error.message });

    // Notify mentor
    const { data: requester } = await supabase.from('users').select('anonymous_id, user_settings(display_name)').eq('telegram_id', user_id).single();
    const requesterName = requester?.user_settings?.display_name || requester?.anonymous_id || 'A user';
    
    const { notifyMentorshipRequest } = require('../bot');
    await notifyMentorshipRequest(mentor_id, requesterName);

    res.status(201).json(data);
  });

  // GET /api/mentors/my-requests – mentor sees incoming requests
  router.get('/my-requests', requireAuth, async (req, res) => {
    const { id: mentor_id } = req.telegramUser;
    const { data, error } = await supabase
      .from('mentorship_requests')
      .select('*, user:user_id(anonymous_id, user_settings(display_name))')
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

    const { data: reqData, error: reqErr } = await supabase
      .from('mentorship_requests')
      .update({ status: action, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('mentor_id', mentor_id)
      .select()
      .single();

    if (reqErr) return res.status(500).json({ error: reqErr.message });

    // If accepted → create assignment with resolved topic_id
    if (action === 'accepted') {
      let topic_id = reqData.topic_id;
      if (!topic_id) {
        const [userTopicsRes, mentorTopicsRes] = await Promise.all([
          supabase.from('user_topics').select('topic_id').eq('telegram_id', reqData.user_id),
          supabase.from('mentor_topics').select('topic_id').eq('telegram_id', mentor_id)
        ]);
        const uTids = (userTopicsRes.data || []).map(t => t.topic_id);
        const mTids = (mentorTopicsRes.data || []).map(t => t.topic_id);
        const common = uTids.filter(id => mTids.includes(id));
        if (common.length > 0) {
          topic_id = common[0];
        } else if (uTids.length > 0) {
          topic_id = uTids[0];
        } else if (mTids.length > 0) {
          topic_id = mTids[0];
        }
      }
      await supabase.from('mentorship_assignments').insert({
        user_id: reqData.user_id,
        mentor_id,
        topic_id: topic_id || null,
        is_active: true,
        assigned_at: new Date().toISOString()
      });
    }

    // Notify user
    const { data: mentor } = await supabase.from('users').select('anonymous_id, user_settings(display_name)').eq('telegram_id', mentor_id).single();
    const mentorName = mentor?.user_settings?.display_name || mentor?.anonymous_id || 'Your mentor';
    
    const { notifyMentorshipAccepted, notifyMentorshipRejected } = require('../bot');
    if (action === 'accepted') {
      await notifyMentorshipAccepted(reqData.user_id, mentorName);
    } else {
      await notifyMentorshipRejected(reqData.user_id, mentorName);
    }

    res.json(reqData);
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
    const { data: assignments } = await supabase.from('mentorship_assignments').select('user_id').eq('mentor_id', mentor_id).eq('is_active', true);
    if (!assignments) return res.json({});
    const stats = {};
    for (const a of assignments) {
      const { count } = await supabase.from('session_participants').select('session_id', { count: 'exact', head: true }).eq('telegram_id', a.user_id);
      stats[a.user_id] = count || 0;
    }
    res.json(stats);
  });

  // POST /api/mentors/notes – add/update private note
  router.post('/notes', requireAuth, async (req, res) => {
    const { id: mentor_id } = req.telegramUser;
    const { mentee_id, content } = req.body;
    const { data, error } = await supabase.from('mentor_notes').upsert({ mentor_id, mentee_id, content, updated_at: new Date().toISOString() }, { onConflict: 'mentor_id,mentee_id' }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // GET /api/mentors/notes/:mentee_id – get private note
  router.get('/notes/:mentee_id', requireAuth, async (req, res) => {
    const { id: mentor_id } = req.telegramUser;
    const { data } = await supabase.from('mentor_notes').select('content').eq('mentor_id', mentor_id).eq('mentee_id', req.params.mentee_id).single();
    res.json(data || { content: '' });
  });

  // DELETE /api/mentors/end-mentorship/:assignment_id
  router.delete('/end-mentorship/:assignment_id', requireAuth, async (req, res) => {
    const { id: mentor_id } = req.telegramUser;
    const { error } = await supabase.from('mentorship_assignments').update({ is_active: false, ended_at: new Date().toISOString() }).eq('id', req.params.assignment_id).eq('mentor_id', mentor_id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  return router;
};