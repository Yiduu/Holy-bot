'use strict';

const express = require('express');
const createDailyVerse = require('../utils/dailyVerse');

module.exports = function authRoutes(supabase, requireAuth) {
  const router = express.Router();

  // Generate anonymous ID like "Warrior_9XkL2"
  const adjectives = ['Warrior', 'Pilgrim', 'Seeker', 'Overcomer', 'Champion', 'Victor', 'Pilgrim', 'Steadfast', 'Faithful', 'Renewed', 'Redeemed', 'Freed'];
  function generateAnonId() {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const suffix = Math.random().toString(36).substring(2, 7).toUpperCase();
    return `${adj}_${suffix}`;
  }

  // Escape LIKE wildcards: '_' and '%' in a nickname must match literally
  // (otherwise "Hope_Seeker" would also match "HopeXSeeker" under ilike).
  const escapeLike = (v) => String(v).replace(/[\\%_]/g, '\\$&');

  // True when the nickname is already used as an anonymous ID or display name.
  async function isNicknameTaken(nick) {
    const pattern = escapeLike(nick);
    const [{ data: userCollision }, { data: settingsCollision }] = await Promise.all([
      supabase.from('users').select('telegram_id').ilike('anonymous_id', pattern).limit(1).maybeSingle(),
      supabase.from('user_settings').select('telegram_id').ilike('display_name', pattern).limit(1).maybeSingle()
    ]);
    return !!(userCollision || settingsCollision);
  }

  // GET /api/auth/nickname-available?nickname=abc – lets onboarding check the name
  // when the user presses Continue on the nickname step (register still re-checks).
  router.get('/nickname-available', requireAuth, async (req, res) => {
    const nick = typeof req.query.nickname === 'string' ? req.query.nickname.trim() : '';
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(nick)) {
      return res.status(400).json({ error: 'Invalid nickname', available: false });
    }
    try {
      res.json({ available: !(await isNicknameTaken(nick)) });
    } catch (e) {
      res.status(500).json({ error: 'Could not check nickname' });
    }
  });

  // GET /api/auth/me – get or check current user
  router.get('/me', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data, error } = await supabase
      .from('users')
      .select('*, user_settings(*)')
      .eq('telegram_id', telegram_id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    if (!data) return res.json({ registered: false });
    if (data.is_banned) return res.status(403).json({ error: 'Account banned' });

    // Update last_active
    supabase.from('users').update({ last_active: new Date().toISOString() }).eq('telegram_id', telegram_id).then(() => {}, () => {});

    res.json({ registered: true, user: data, admin_id: process.env.ADMIN_TELEGRAM_ID });
  });

  // POST /api/auth/register
  router.post('/register', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { sex, age_range, education_level, nickname, chat_id } = req.body;

    // Validate
    if (!sex || !age_range || !education_level || !nickname) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if already registered
    const { data: existing } = await supabase.from('users').select('telegram_id').eq('telegram_id', telegram_id).single();
    if (existing) return res.status(409).json({ error: 'Already registered' });

    const trimmedNick = typeof nickname === 'string' ? nickname.trim() : '';
    if (!trimmedNick) {
      return res.status(400).json({ error: 'Nickname cannot be empty' });
    }

    // Nickname uniqueness check against both users.anonymous_id and user_settings.display_name
    if (await isNicknameTaken(trimmedNick)) {
      return res.status(409).json({ error: 'Nickname already taken', nickname_taken: true });
    }

    const anonymous_id = trimmedNick;

    const { data: user, error } = await supabase
      .from('users')
      .insert({ telegram_id, anonymous_id, sex, age_range, education_level, chat_id: chat_id || telegram_id })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Create default settings with nickname as display_name and default timezone
    await supabase.from('user_settings').insert({ telegram_id, display_name: anonymous_id, timezone: 'Africa/Addis_Ababa' });

    // Save topics if provided
    const { topic_ids } = req.body;
    if (Array.isArray(topic_ids) && topic_ids.length > 0) {
      const inserts = topic_ids.map(tid => ({ telegram_id, topic_id: parseInt(tid) }));
      const { error: topicErr } = await supabase.from('user_topics').insert(inserts);
      if (topicErr) console.error('[Register] Topics insert error:', topicErr.message);
    }

    res.status(201).json({ user });
  });

  // GET /api/auth/verse – today's daily verse (shared with guest mode)
  const getDailyVerse = createDailyVerse(supabase);
  router.get('/verse', async (req, res) => res.json(await getDailyVerse()));

  return router;
};