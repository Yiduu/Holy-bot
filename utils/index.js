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

module.exports = { generateJitsiJWT, supabaseQuery };

