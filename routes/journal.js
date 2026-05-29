'use strict';

const express = require('express');

module.exports = function journalRoutes(supabase, requireAuth) {
  const router = express.Router();

  // GET /api/journal
  router.get('/', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, content, created_at')
      .eq('telegram_id', telegram_id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // POST /api/journal
  router.post('/', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content is required' });

    const { data, error } = await supabase
      .from('journal_entries')
      .insert({ telegram_id, content })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
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

  return router;
};
