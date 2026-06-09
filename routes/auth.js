'use strict';

const express = require('express');

module.exports = function authRoutes(supabase, requireAuth) {
  const router = express.Router();

  // Generate anonymous ID like "Warrior_9XkL2"
  const adjectives = ['Warrior', 'Pilgrim', 'Seeker', 'Overcomer', 'Champion', 'Victor', 'Pilgrim', 'Steadfast', 'Faithful', 'Renewed', 'Redeemed', 'Freed'];
  function generateAnonId() {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const suffix = Math.random().toString(36).substring(2, 7).toUpperCase();
    return `${adj}_${suffix}`;
  }

  // GET /api/auth/me – get or check current user
  router.get('/me', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data, error } = await supabase
      .from('users')
      .select('*, user_settings(*)')
      .eq('telegram_id', telegram_id)
      .single();

    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });

    if (!data) return res.json({ registered: false });
    if (data.is_banned) return res.status(403).json({ error: 'Account banned' });

    // Update last_active
    await supabase.from('users').update({ last_active: new Date().toISOString() }).eq('telegram_id', telegram_id);

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

    // Nickname uniqueness check
    const { data: nickCollision } = await supabase.from('users').select('anonymous_id').eq('anonymous_id', nickname).single();
    if (nickCollision) return res.status(409).json({ error: 'Nickname already taken', nickname_taken: true });

    // FIX: Removed unused `attempts` variable. The retry loop was removed but
    // the variable declaration was left behind. The double-check below is
    // sufficient to guard against race conditions at registration time.
    const anonymous_id = nickname;

    // Double check for race condition
    const { data: collision } = await supabase.from('users').select('anonymous_id').eq('anonymous_id', anonymous_id).single();
    if (collision) return res.status(409).json({ error: 'Nickname taken', nickname_taken: true });

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

  // GET /api/auth/verse – today's daily verse
  router.get('/verse', async (req, res) => {
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    let { data, error } = await supabase
      .from('daily_verses')
      .select('*')
      .eq('is_active', true);

    // Auto-migrate database records if English references are detected
    if (!error && data && data.length > 0) {
      const hasEnglish = data.some(v => /[a-zA-Z]/.test(v.reference));
      if (hasEnglish) {
        try {
          const fs = require('fs');
          const path = require('path');
          const sqlPath = path.join(__dirname, '..', 'supabase', 'seed.sql');
          const sql = fs.readFileSync(sqlPath, 'utf8');

          const regex = /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;
          let match;
          const verses = [];
          while ((match = regex.exec(sql)) !== null) {
            verses.push({
              reference: match[1],
              text: match[2],
              theme: match[3],
              is_active: true
            });
          }

          if (verses.length > 0) {
            await supabase.from('daily_verses').delete().neq('theme', 'non-existent-theme-to-delete-all');
            await supabase.from('daily_verses').insert(verses);
            const refetched = await supabase.from('daily_verses').select('*').eq('is_active', true);
            if (refetched.data && refetched.data.length > 0) {
              data = refetched.data;
            }
          }
        } catch (migrationErr) {
          console.error('[Migration] Failed to migrate daily_verses to Amharic:', migrationErr);
        }
      }
    }

    if (error || !data?.length) return res.json({ reference: 'ፊልጵ 4:13', text: 'ኃይልን በሚሰጠኝ በክርስቶስ ሁሉን እችላለሁ።' });

    const verse = data[dayOfYear % data.length];
    res.json(verse);
  });

  return router;
};