'use strict';

const express = require('express');

module.exports = function supportRoutes(supabase, requireAuth) {
  const router = express.Router();

  // POST /api/support – create ticket
  router.post('/', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { subject, description } = req.body;
    if (!subject || !description) return res.status(400).json({ error: 'subject and description required' });

    const { data, error } = await supabase.from('support_tickets').insert({ telegram_id, subject, description }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  });

  // GET /api/support – user's own tickets
  router.get('/', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data, error } = await supabase.from('support_tickets').select('*').eq('telegram_id', telegram_id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  return router;
};
