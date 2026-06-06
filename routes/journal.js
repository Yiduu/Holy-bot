'use strict';

const express = require('express');

module.exports = function journalRoutes(supabase, requireAuth) {
  const router = express.Router();

  // GET /api/journal
  router.get('/', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, content, mood, created_at')
      .eq('telegram_id', telegram_id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // POST /api/journal
  router.post('/', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { content, mood } = req.body;
    if (!content) return res.status(400).json({ error: 'Content is required' });

    const { data, error } = await supabase
      .from('journal_entries')
      .insert({ telegram_id, content, mood: mood || 'neutral' })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  });

  // PUT /api/journal/:id
  router.put('/:id', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { id: entryId } = req.params;
    const { content, mood } = req.body;
    if (!content) return res.status(400).json({ error: 'Content is required' });

    const { data, error } = await supabase
      .from('journal_entries')
      .update({ content, mood, updated_at: new Date().toISOString() })
      .eq('id', entryId)
      .eq('telegram_id', telegram_id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // DELETE /api/journal/:id
  router.delete('/:id', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { id: entryId } = req.params;

    const { error } = await supabase
      .from('journal_entries')
      .delete()
      .eq('id', entryId)
      .eq('telegram_id', telegram_id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });
  // GET /api/journal/by-date?date=YYYY-MM-DD
  router.get('/by-date', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });

    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    const { data, error } = await supabase
      .from('journal_entries')
      .select('*')
      .eq('telegram_id', telegram_id)
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString())
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });
  return router;
};
