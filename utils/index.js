const jwt = require('jsonwebtoken');
const { HTML, card, goldKeyboard } = require('./notifyStyle');

/**
 * Generate a Jitsi JWT token for a given room.
 * Returns null if the required env variables are missing (public Jitsi domain).
 *
 * @param {string} roomName - The Jitsi room name.
 * @param {object} userInfo - User context (e.g., { displayName, moderator }).
 * @returns {string|null} Signed JWT token.
 */
// ── Single source of truth for the Jitsi server ─────────────────────────────
// The mini app's embedded call and its "open in browser" fallback MUST use the
// same server, otherwise the two sides of a session end up in different rooms.
// The default matches the server the embedded client has always connected to.
const JITSI_DOMAIN = process.env.JITSI_DOMAIN || 'meet.opensuse.org';
const PUBLIC_JITSI_DOMAINS = ['meet.jit.si', 'meet.opensuse.org'];
function isPublicJitsi(domain = JITSI_DOMAIN) {
  return PUBLIC_JITSI_DOMAINS.includes(domain);
}

function generateJitsiJWT(roomName, userInfo) {
  const appId = process.env.JITSI_APP_ID;
  const secret = process.env.JITSI_JWT_SECRET;
  const domain = JITSI_DOMAIN;

  // If no secret/appId or using a public domain, skip token generation.
  if (!appId || !secret || isPublicJitsi(domain)) {
    return null;
  }

  const payload = {
    context: { user: userInfo },
    aud: appId,
    iss: appId,
    sub: domain,
    room: roomName,
    exp: Math.floor(Date.now() / 1000) + 4 * 60 * 60, // 4h expiry
  };

  return jwt.sign(payload, secret, { algorithm: 'HS256' });
}

/**
 * Retry wrapper for Supabase queries.
 * Automatically retries on transient errors with exponential backoff.
 *
 * @param {Function} fn       - A function that returns a Supabase query promise.
 * @param {number}   retries  - Max retry attempts (default 3).
 * @param {number}   delay    - Base delay in ms, multiplied by attempt index (default 1000).
 * @returns {Promise<*>}      - Resolves with `data` from the Supabase response.
 * @throws                    - Throws the last Supabase/network error after all retries.
 */
async function supabaseQuery(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await fn();
      if (result.error) throw result.error;
      return result.data;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
}

/**
 * Push a Socket.IO event to a specific user, if they currently have a
 * live connection. Reads `global.io` / `global.onlineUsers`, which
 * server.js sets up once at startup — this lets modules that don't
 * receive `io` directly (e.g. bot.js, whose scheduler and callback-query
 * handler run outside the Express request lifecycle) still push
 * real-time updates without a circular require on server.js.
 *
 * Best-effort: silently no-ops if the socket layer isn't ready yet or
 * the user isn't currently connected (their next page load / reconnect
 * will simply fetch the fresh row via the REST endpoint instead).
 *
 * @param {string|number} telegram_id
 * @param {string} event
 * @param {object} payload
 */
function emitToUser(telegram_id, event, payload) {
  if (!global.io || !global.onlineUsers || !telegram_id) return;
  const socketId = global.onlineUsers.get(String(telegram_id));
  if (socketId) global.io.to(socketId).emit(event, payload);
}

/**
 * Close a mentorship assignment and record why it ended.
 * If the end_reason / ended_by columns haven't been migrated yet, falls back
 * to the original two-column update so nothing breaks before the SQL is run.
 *
 * @param {object} supabase
 * @param {string} assignmentId
 * @param {{reason?: string, endedBy?: 'mentee'|'mentor'|'admin'|'system'}} [opts]
 * @returns {Promise<object|null>} the Supabase error, or null on success
 */
async function closeAssignment(supabase, assignmentId, { reason = null, endedBy = null } = {}) {
  // Remember whose spot this frees so the waitlist can be told afterwards.
  let mentorId = null;
  try {
    const { data } = await supabase.from('mentorship_assignments').select('mentor_id').eq('id', assignmentId).maybeSingle();
    mentorId = data?.mentor_id ?? null;
  } catch (_) { /* best effort */ }
  const endedAt = new Date().toISOString();
  let { error } = await supabase
    .from('mentorship_assignments')
    .update({ is_active: false, ended_at: endedAt, end_reason: reason, ended_by: endedBy })
    .eq('id', assignmentId);
  if (error && /end_reason|ended_by/i.test(error.message || '')) {
    ({ error } = await supabase
      .from('mentorship_assignments')
      .update({ is_active: false, ended_at: endedAt })
      .eq('id', assignmentId));
  }
  if (!error && mentorId) notifyMentorWaitlist(supabase, mentorId).catch(() => {});
  return error || null;
}

const APP_URL = process.env.MINI_APP_URL || 'https://holy-bot-etvy.onrender.com';

// Legacy Telegram Markdown breaks on a lone _ * ` or [ - and anonymous IDs
// like "Shepherd_1" contain underscores, so an unescaped name made Telegram
// reject the whole message and nobody on the waitlist was ever told.
const mdSafe = (str) => String(str ?? '').replace(/([_*`\[])/g, '\\$1');

/**
 * When a mentor has free spots, message the oldest people on their waitlist
 * (one per free spot) and take them off it. Called whenever a spot can open:
 * a mentorship ends, the mentor raises their limit, or turns requests back on.
 *
 * Someone whose message could not be delivered stays on the list for next
 * time; someone who has found a mentor in the meantime is dropped quietly.
 * Best-effort and never throws, so the action that triggered it never fails.
 *
 * @param {object} [deps] test hook: { safeSend, getUserLang }
 * @returns {Promise<number>} how many people were notified
 */
async function notifyMentorWaitlist(supabase, mentorId, deps = {}) {
  try {
    const { data: mentor } = await supabase
      .from('users')
      .select('accepting_requests, anonymous_id, user_settings(display_name, max_mentees)')
      .eq('telegram_id', mentorId).single();
    if (!mentor || mentor.accepting_requests === false) return 0;

    const max = mentor.user_settings?.max_mentees || parseInt(process.env.MAX_MENTEES_DEFAULT || '3');
    const { count } = await supabase
      .from('mentorship_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('mentor_id', mentorId).eq('is_active', true);
    const free = max - (count || 0);
    if (free <= 0) return 0;

    const { data: waiting } = await supabase
      .from('mentor_waitlist').select('id, user_id')
      .eq('mentor_id', mentorId).order('created_at', { ascending: true }).limit(50);
    if (!waiting || !waiting.length) return 0;

    const { data: busy } = await supabase
      .from('mentorship_assignments').select('user_id')
      .eq('is_active', true).in('user_id', waiting.map(w => w.user_id));
    const hasMentor = new Set((busy || []).map(r => String(r.user_id)));

    const { safeSend, getUserLang } = deps.safeSend ? deps : require('../bot');
    const name = mentor.user_settings?.display_name || mentor.anonymous_id || 'A mentor';
    const finished = [];
    let sent = 0;
    for (const w of waiting) {
      if (hasMentor.has(String(w.user_id))) { finished.push(w.id); continue; }
      if (sent >= free) break;
      const lang = await getUserLang(w.user_id).catch(() => 'en');
      const am = lang === 'am';
      const text = card({
        icon: '🎉',
        title: am ? 'ክፍት ቦታ ተገኝቷል' : 'A Spot Just Opened Up',
        body: am
          ? `${name} ክፍት ቦታ አለው። መገለጫቸውን ለማየትና ጥያቄ ለመላክ ከታች ያለውን ቁልፍ ይጫኑ።`
          : `${name} has a spot open now. Tap below to see their profile and send a request.`,
        footer: am ? 'ቦታው ከመሞላቱ በፊት ፍጠኑ 💛' : 'Be quick before it fills up 💛',
      });
      const ok = await safeSend(w.user_id, text, { ...HTML, reply_markup: goldKeyboard(am ? 'አማካሪዎችን ክፈት' : 'Open mentors', `${APP_URL}?start=mentors`) });
      if (ok) { sent++; finished.push(w.id); }
    }
    if (finished.length) await supabase.from('mentor_waitlist').delete().in('id', finished);
    return sent;
  } catch (e) {
    console.error('[waitlist] notify failed (non-fatal):', e.message);
    return 0;
  }
}

/**
 * Save a 1-5 star rating for a mentor and keep users.rating / rating_count in
 * step. Re-rating replaces the earlier score instead of adding a second one,
 * same as POST /api/mentors/rate and the bot's submitRating.
 *
 * @returns {Promise<{rating:number, rating_count:number}>}
 */
async function recordMentorRating(supabase, mentorId, userId, stars) {
  const { data: mentor, error: mentorErr } = await supabase
    .from('users').select('rating, rating_count').eq('telegram_id', mentorId).single();
  if (mentorErr || !mentor) throw new Error('Mentor not found');

  const { data: existing } = await supabase
    .from('mentor_ratings').select('stars')
    .eq('mentor_id', mentorId).eq('user_id', userId).maybeSingle();

  const oldCount = mentor.rating_count || 0;
  const oldRating = mentor.rating || 0;
  let newCount, newRating;
  if (existing) {
    newCount = oldCount;
    newRating = oldCount > 0 ? (oldRating * oldCount - existing.stars + stars) / oldCount : stars;
  } else {
    newCount = oldCount + 1;
    newRating = (oldRating * oldCount + stars) / newCount;
  }

  const { error: updErr } = await supabase
    .from('users').update({ rating: newRating, rating_count: newCount }).eq('telegram_id', mentorId);
  if (updErr) throw new Error(updErr.message);

  const { error: upErr } = await supabase
    .from('mentor_ratings')
    .upsert({ mentor_id: mentorId, user_id: userId, stars, created_at: new Date().toISOString() },
      { onConflict: 'mentor_id,user_id' });
  if (upErr) throw new Error(upErr.message);

  return { rating: newRating, rating_count: newCount };
}

/**
 * Safety net for the moment someone becomes a mentor (application approved or
 * an admin flips their role). The mini app already makes applicants end and
 * rate their mentorship first, but a user can still get matched while an
 * application is pending, and older pending applications predate the check.
 * Ends any active mentorship where they are the mentee and cancels their
 * pending mentor requests so they don't keep a mentee side.
 *
 * @returns {Promise<{assignmentId:string, mentorId:number}|null>} the mentorship that was ended, if any
 */
async function endMenteeSideOnPromotion(supabase, telegramId) {
  const { data: active } = await supabase
    .from('mentorship_assignments').select('id, mentor_id')
    .eq('user_id', telegramId).eq('is_active', true).maybeSingle();

  let ended = null;
  if (active) {
    const err = await closeAssignment(supabase, active.id, {
      reason: 'Became a mentor (ended automatically)',
      endedBy: 'system'
    });
    if (!err) ended = { assignmentId: active.id, mentorId: active.mentor_id };
  }

  // One row at a time: UNIQUE(user_id, mentor_id, status) can reject a bulk
  // pending -> cancelled update if a cancelled row already exists for that pair.
  const { data: pending } = await supabase
    .from('mentorship_requests').select('id')
    .eq('user_id', telegramId).eq('status', 'pending');
  for (const r of pending || []) {
    await supabase.from('mentorship_requests')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', r.id);
  }

  return ended;
}

/**
 * Push an event to every device a user has open (their `user:<id>` room).
 * emitToUser() above only reaches the most recent socket. Best-effort, like it.
 */
function emitToUserRoom(telegram_id, event, payload) {
  const io = global.io || global._io;
  if (!io || !telegram_id) return;
  io.to(`user:${telegram_id}`).emit(event, payload);
}

module.exports = {
  generateJitsiJWT, JITSI_DOMAIN, isPublicJitsi, supabaseQuery, emitToUser, emitToUserRoom,
  closeAssignment, notifyMentorWaitlist, recordMentorRating, endMenteeSideOnPromotion
};


