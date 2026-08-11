'use strict';

const express = require('express');

const MAX_FREEZES = 2;      // Max Streak Savers a user can bank at once
const FREEZE_EVERY = 7;     // Earn one every N-day milestone

module.exports = function streakRoutes(supabase, requireAuth) {
  const router = express.Router();

  function ethiopiaToday(offsetDays = 0) {
    const etNow = new Date(Date.now() + (3 * 60 * 60 * 1000) + offsetDays * 86400000);
    return etNow.toISOString().split('T')[0];
  }

  // GET /api/streaks — current streak + last 7 days + freeze/reminder state
  router.get('/', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const todayStr = ethiopiaToday();

    // Oldest -> newest, 7 days ending today
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(ethiopiaToday(-i));

    const [streakRes, logRes, settingsRes] = await Promise.all([
      supabase.from('bible_streaks').select('*').eq('telegram_id', telegram_id).single(),
      supabase.from('streak_log').select('read_date, used_freeze').eq('telegram_id', telegram_id).gte('read_date', days[0]),
      supabase.from('user_settings').select('notify_streak_reminder').eq('telegram_id', telegram_id).single(),
    ]);

    if (streakRes.error && streakRes.error.code !== 'PGRST116') {
      return res.status(500).json({ error: streakRes.error.message });
    }

    const s = streakRes.data || { current_streak: 0, longest_streak: 0, last_read_date: null, freezes_available: 0 };
    const logByDate = new Map((logRes.data || []).map(r => [r.read_date, r.used_freeze]));

    const week = days.map(date => ({
      date,
      is_today: date === todayStr,
      read: logByDate.has(date),
      used_freeze: logByDate.get(date) === true,
    }));

    res.json({
      current_streak: s.current_streak || 0,
      longest_streak: s.longest_streak || 0,
      last_read_date: s.last_read_date,
      freezes_available: s.freezes_available || 0,
      week,
      notify_streak_reminder: settingsRes.data ? settingsRes.data.notify_streak_reminder !== false : true,
    });
  });

  // POST /api/streaks/mark
  router.post('/mark', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const today = ethiopiaToday();

    async function logRead(date, usedFreeze = false) {
      await supabase.from('streak_log').upsert(
        { telegram_id, read_date: date, used_freeze: usedFreeze },
        { onConflict: 'telegram_id,read_date' }
      );
    }

    const { data: s } = await supabase.from('bible_streaks').select('*').eq('telegram_id', telegram_id).single();

    // First-ever read
    if (!s) {
      await logRead(today);
      const { data, error } = await supabase.from('bible_streaks').insert({
        telegram_id,
        current_streak: 1,
        longest_streak: 1,
        last_read_date: today,
        freezes_available: 0,
        last_freeze_awarded_streak: 0,
      }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ...data, milestone: false, freeze_used: false, was_reset: false });
    }

    // Already marked today
    if (s.last_read_date === today) {
      return res.json({ ...s, milestone: false, freeze_used: false, was_reset: false });
    }

    const yestStr = ethiopiaToday(-1);
    const twoDaysAgoStr = ethiopiaToday(-2);

    let n;
    let freezeUsed = false;
    let wasReset = false;

    if (s.last_read_date === yestStr) {
      // Consecutive day — normal continuation.
      n = s.current_streak + 1;
    } else if (s.last_read_date === twoDaysAgoStr && (s.freezes_available || 0) > 0) {
      // Exactly one day missed, and a Streak Saver covers it.
      n = s.current_streak + 1;
      freezeUsed = true;
      await logRead(yestStr, true); // backfill so the week strip shows a shield, not a gap
    } else {
      // Missed more than one day, or no freeze banked — fresh start.
      wasReset = (s.current_streak || 0) > 1;
      n = 1;
    }

    await logRead(today, false);

    let freezesAvailable = freezeUsed ? Math.max(0, (s.freezes_available || 0) - 1) : (s.freezes_available || 0);
    let lastFreezeAwardedStreak = s.last_freeze_awarded_streak || 0;
    let milestone = false;

    if (n > 0 && n % FREEZE_EVERY === 0 && n > lastFreezeAwardedStreak) {
      milestone = true;
      lastFreezeAwardedStreak = n;
      if (freezesAvailable < MAX_FREEZES) freezesAvailable += 1;
    }

    const { data, error } = await supabase.from('bible_streaks').update({
      current_streak: n,
      longest_streak: Math.max(n, s.longest_streak || 0),
      last_read_date: today,
      freezes_available: freezesAvailable,
      last_freeze_awarded_streak: lastFreezeAwardedStreak,
      updated_at: new Date().toISOString(),
    }).eq('telegram_id', telegram_id).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ...data, milestone, freeze_used: freezeUsed, was_reset: wasReset });
  });

  return router;
};
