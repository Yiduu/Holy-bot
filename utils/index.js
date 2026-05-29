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

module.exports = { generateJitsiJWT };
