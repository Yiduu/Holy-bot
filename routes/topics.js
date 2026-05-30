'use strict';

const express = require('express');

module.exports = function topicRoutes(supabase, requireAuth, requireAdmin) {
  const router = express.Router();

  // GET /api/topics - list all active topics
  router.get('/', async (req, res) => {
    const { data, error } = await supabase
      .from('topics')
      .select('*')
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // GET /api/topics/admin - list all topics including inactive
  router.get('/admin', requireAuth, requireAdmin, async (req, res) => {
    const { data, error } = await supabase
      .from('topics')
      .select('*')
      .order('name', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // POST /api/topics - create a new topic
  router.post('/', requireAuth, requireAdmin, async (req, res) => {
    const { name, slug, description } = req.body;
      const { data, error } = await supabase
        .from('topics')
        .upsert({ name, slug, description }, { onConflict: 'slug' })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  });

  // PUT /api/topics/:id - update a topic
  router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
    const { name, slug, description, is_active } = req.body;
    const { data, error } = await supabase
      .from('topics')
      .update({ name, slug, description, is_active })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // DELETE /api/topics/:id - soft delete
  router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
    const { error } = await supabase
      .from('topics')
      .update({ is_active: false })
      .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  // GET /api/topics/stats - topic popularity stats
  router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
    const { data, error } = await supabase
      .from('mentorship_assignments')
      .select('topic_id, topics(name)');

    if (error) return res.status(500).json({ error: error.message });
    
    const stats = data.reduce((acc, curr) => {
      const name = curr.topics?.name || 'Unknown';
      acc[name] = (acc[name] || 0) + 1;
      return acc;
    }, {});

    res.json(stats);
  });

  // GET /api/topics/my - returns topics user is struggling with
  router.get('/my', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data, error } = await supabase
      .from('user_topics')
      .select('topic_id, topics(*)')
      .eq('telegram_id', telegram_id);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // POST /api/topics/my - replaces user's struggle topics
  router.post('/my', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { topic_ids } = req.body;
    if (!Array.isArray(topic_ids)) return res.status(400).json({ error: 'topic_ids must be an array' });

    // Delete old topics
    const { error: delErr } = await supabase.from('user_topics').delete().eq('telegram_id', telegram_id);
    if (delErr) return res.status(500).json({ error: delErr.message });

    if (topic_ids.length > 0) {
      const inserts = topic_ids.map(tid => ({ telegram_id, topic_id: parseInt(tid) }));
      const { error: insErr } = await supabase.from('user_topics').insert(inserts);
      if (insErr) return res.status(500).json({ error: insErr.message });
    }
    res.json({ success: true });
  });

  // GET /api/topics/my-expertise - returns mentor expertise topics
  router.get('/my-expertise', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data, error } = await supabase
      .from('mentor_topics')
      .select('topic_id, topics(*)')
      .eq('telegram_id', telegram_id);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // POST /api/topics/my-expertise - replaces mentor's expertise topics
  router.post('/my-expertise', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { topic_ids } = req.body;
    if (!Array.isArray(topic_ids)) return res.status(400).json({ error: 'topic_ids must be an array' });

    // Delete old expertise topics
    const { error: delErr } = await supabase.from('mentor_topics').delete().eq('telegram_id', telegram_id);
    if (delErr) return res.status(500).json({ error: delErr.message });

    if (topic_ids.length > 0) {
      const inserts = topic_ids.map(tid => ({ telegram_id, topic_id: parseInt(tid) }));
      const { error: insErr } = await supabase.from('mentor_topics').insert(inserts);
      if (insErr) return res.status(500).json({ error: insErr.message });
    }
    res.json({ success: true });
  });

  return router;
};
