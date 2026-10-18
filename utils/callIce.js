'use strict';
/*
 * callIce.js — ICE servers (STUN + TURN relay) for the built-in audio call.
 *
 * Most calls connect straight from phone to phone through STUN. Some mobile
 * networks block that, and those calls need a TURN relay. We support, in order:
 *   1. Cloudflare Realtime TURN   CF_TURN_KEY_ID + CF_TURN_API_TOKEN
 *   2. Metered (Open Relay)       METERED_TURN_APP + METERED_TURN_API_KEY
 *   3. Your own coturn            TURN_URLS (comma separated) + TURN_USERNAME + TURN_CREDENTIAL
 * With none of them set the call still works for most people (STUN only).
 *
 * The secrets stay on the server; the browser only ever receives short-lived
 * credentials, and only after /api/sessions/:id/ice has checked the session.
 */
const axios = require('axios');

const STUN_ONLY = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];
const CACHE_MS = 30 * 60 * 1000;   // reuse one set of credentials for 30 min
const TTL_SECONDS = 24 * 60 * 60;  // credentials stay valid for a day (calls are short)

let cache = { at: 0, key: '', servers: null };

// Port 53 URLs time out in browsers (Cloudflare's own advice) — drop them.
function cleanUrls(urls) {
  return (Array.isArray(urls) ? urls : [urls]).filter(u => typeof u === 'string' && !/:53(\?|$)/.test(u));
}
function cleanServers(list) {
  return (Array.isArray(list) ? list : [])
    .map(s => ({ ...s, urls: cleanUrls(s.urls) }))
    .filter(s => s.urls.length);
}

function provider(env = process.env) {
  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) return 'cloudflare';
  if (env.METERED_TURN_APP && env.METERED_TURN_API_KEY) return 'metered';
  if (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL) return 'static';
  return 'stun';
}

async function fetchServers(env = process.env, http = axios) {
  const kind = provider(env);
  if (kind === 'cloudflare') {
    const { data } = await http.post(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
      { ttl: TTL_SECONDS },
      { headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 5000 },
    );
    return cleanServers(data && data.iceServers);
  }
  if (kind === 'metered') {
    const { data } = await http.get(
      `https://${encodeURIComponent(env.METERED_TURN_APP)}.metered.live/api/v1/turn/credentials`,
      { params: { apiKey: env.METERED_TURN_API_KEY }, timeout: 5000 },
    );
    return cleanServers(data);
  }
  if (kind === 'static') {
    return [
      ...STUN_ONLY,
      { urls: env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL },
    ];
  }
  return STUN_ONLY;
}

// Never throws: a relay outage must not stop a call that could connect directly.
async function getIceServers(env = process.env, http = axios, now = Date.now()) {
  const key = provider(env) + ':' + (env.CF_TURN_KEY_ID || env.METERED_TURN_APP || env.TURN_URLS || '');
  if (cache.servers && cache.key === key && now - cache.at < CACHE_MS) return cache.servers;
  try {
    const servers = await fetchServers(env, http);
    if (servers.length) {
      // Always keep a STUN entry so direct connections are tried first.
      const hasStun = servers.some(s => s.urls.some(u => u.startsWith('stun:')));
      const list = hasStun ? servers : [...STUN_ONLY, ...servers];
      cache = { at: now, key, servers: list };
      return list;
    }
  } catch (e) {
    console.error('[CallIce] could not fetch relay credentials:', e.message);
  }
  return STUN_ONLY;
}

function resetCache() { cache = { at: 0, key: '', servers: null }; }

module.exports = { getIceServers, provider, resetCache, STUN_ONLY };
