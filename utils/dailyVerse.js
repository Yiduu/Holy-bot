'use strict';

// Today's daily verse. Shared by GET /api/auth/verse and guest mode
// (GET /api/guest/auth/verse), so guest shows exactly the verse everyone else sees.
//
// IMPORTANT: this must use the exact same "which day is it" and "which row is
// today's" formulas as bot.js (handleDailyVerse / the hourly verse scheduler),
// or the mini app and the bot will show two different verses on the same day.
// bot.js uses days-since-epoch, not day-of-year, so that's what we use here too.

const FALLBACK = { reference: 'ፊልጵ 4:13', text: 'ኃይልን በሚሰጠኝ በክርስቶስ ሁሉን እችላለሁ።' };

module.exports = function createDailyVerse(supabase) {
  let cache = { dayIndex: -1, verse: null };

  return async function getDailyVerse() {
    const dayIndex = Math.floor(Date.now() / 86400000);
    if (cache.verse && cache.dayIndex === dayIndex) return cache.verse;

    let { data, error } = await supabase
      .from('daily_verses')
      .select('*')
      .eq('is_active', true)
      .order('id', { ascending: true });

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
            const refetched = await supabase.from('daily_verses').select('*').eq('is_active', true).order('id', { ascending: true });
            if (refetched.data && refetched.data.length > 0) {
              data = refetched.data;
            }
          }
        } catch (migrationErr) {
          console.error('[Migration] Failed to migrate daily_verses to Amharic:', migrationErr);
        }
      }
    }

    if (error || !data?.length) return FALLBACK;

    const verse = data[dayIndex % data.length];
    cache = { dayIndex, verse };
    return verse;
  };
};
