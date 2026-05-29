'use strict';

const express = require('express');

module.exports = function streakRoutes(supabase, requireAuth) {
  const router = express.Router();

  // GET /api/streaks
  router.get('/', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data, error } = await supabase.from('bible_streaks').select('*').eq('telegram_id', telegram_id).single();
    
    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
    
    res.json(data || { current_streak: 0, longest_streak: 0, last_read_date: null });
  });

  // POST /api/streaks/mark
  router.post('/mark', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const now = new Date();
    // Offset for Ethiopia (UTC+3)
    const etNow = new Date(now.getTime() + (3 * 60 * 60 * 1000));
    const today = etNow.toISOString().split('T')[0];

    const { data: s } = await supabase.from('bible_streaks').select('*').eq('telegram_id', telegram_id).single();

    if (!s) {
      const { data, error } = await supabase.from('bible_streaks').insert({
        telegram_id,
        current_streak: 1,
        longest_streak: 1,
        last_read_date: today
      }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json(data);
    } else {
      if (s.last_read_date === today) {
        return res.json(s); // Already marked
      }

      const yest = new Date(etNow);
      yest.setDate(yest.getDate() - 1);
      const yestStr = yest.toISOString().split('T')[0];

      const consecutive = s.last_read_date === yestStr;
      const n = consecutive ? s.current_streak + 1 : 1;

      const { data, error } = await supabase.from('bible_streaks').update({
        current_streak: n,
        longest_streak: Math.max(n, s.longest_streak || 0),
        last_read_date: today,
        updated_at: new Date().toISOString()
      }).eq('telegram_id', telegram_id).select().single();

      if (error) return res.status(500).json({ error: error.message });
      return res.json(data);
    }
  });

  return router;
};
