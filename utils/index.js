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

module.exports = { generateJitsiJWT, supabaseQuery, emitToUser };

