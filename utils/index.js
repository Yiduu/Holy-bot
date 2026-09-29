const jwt = require('jsonwebtoken');

/**
 * Generate a Jitsi JWT token for a given room.
 * Returns null if the required env variables are missing (public Jitsi domain).
 *
 * @param {string} roomName - The Jitsi room name.
 * @param {object} userInfo - User context (e.g., { displayName, moderator }).
 * @returns {string|null} Signed JWT token.
 */
function generateJitsiJWT(roomName, userInfo) {
  const appId = process.env.JITSI_APP_ID;
  const secret = process.env.JITSI_JWT_SECRET;
  const domain = process.env.JITSI_DOMAIN || 'meet.jit.si';

  // If no secret/appId or using public domain, skip token generation.
  if (!appId || !secret || domain === 'meet.jit.si') {
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
 * @param {{reason?: string, endedBy?: 'mentee'|'mentor'|'system'}} [opts]
 * @returns {Promise<object|null>} the Supabase error, or null on success
 */
async function closeAssignment(supabase, assignmentId, { reason = null, endedBy = null } = {}) {
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
  return error || null;
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
  generateJitsiJWT, supabaseQuery, emitToUser, emitToUserRoom,
  closeAssignment, recordMentorRating, endMenteeSideOnPromotion
};


