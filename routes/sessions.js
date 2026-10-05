'use strict';

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { notifySessionInvite, notifySessionStarted, notifySessionWaiting } = require('../bot');
const { generateJitsiJWT, emitToUserRoom, JITSI_DOMAIN, isPublicJitsi } = require('../utils');

// ── Lifecycle tuning ─────────────────────────────────────────────────────────
const EARLY_JOIN_MS       = 5 * 60 * 1000;                                   // lobby opens 5 min before start
const SCHEDULED_EXPIRY_MS = 2 * 60 * 60 * 1000;                              // never-started sessions expire after 2 h
const MAX_SESSION_MS      = (parseFloat(process.env.SESSION_MAX_HOURS) || 4) * 60 * 60 * 1000;
const EMPTY_ROOM_END_MS   = 10 * 60 * 1000;                                  // everyone gone this long → close the session
const WAITING_PING_EVERY  = 5 * 60 * 1000;                                   // throttle "someone is waiting" pushes
const PRESENCE_TTL_MS     = 90 * 1000;                                       // no heartbeat for this long → treated as gone
const FINISHED = ['ended', 'cleared', 'cancelled'];

// Columns safe to show in list endpoints. room_name / room_password are
// deliberately excluded: they are only handed out by GET /:id/join, after the
// participant + time checks have passed.
const SESSION_PUBLIC_COLS = 'id, title, is_group, host_id, max_participants, scheduled_at, started_at, ended_at, status';
const HOST_JOIN = 'host:host_id(anonymous_id, user_settings(display_name))';

module.exports = function sessionRoutes(supabase, requireAuth, io, onlineUsers) {
  const router = express.Router();
  const waitingPings = new Map(); // `${sessionId}:${telegramId}` → last ping ts

  const nowIso = () => new Date().toISOString();
  const same = (a, b) => String(a) === String(b);

  function generateRoomPassword(length = 12) {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    return Array.from({ length }, () => chars[crypto.randomInt(chars.length)]).join('');
  }

  // Fire-and-forget: a slow/failed Telegram push must never block or fail the
  // request the mentor is waiting on.
  function background(tasks) {
    Promise.allSettled(tasks).then(rs => rs.forEach(r => {
      if (r.status === 'rejected') console.error('[Sessions] background task failed:', r.reason?.message || r.reason);
    }));
  }

  // The name shown in calls: the nickname set in Settings, else the anonymous ID
  // (same rule as the rest of the app). Returns Map<String(telegram_id), name>.
  async function displayNames(ids) {
    const names = new Map();
    const [{ data: users }, { data: settings }] = await Promise.all([
      supabase.from('users').select('telegram_id, anonymous_id').in('telegram_id', ids),
      supabase.from('user_settings').select('telegram_id, display_name').in('telegram_id', ids),
    ]);
    (users || []).forEach(u => names.set(String(u.telegram_id), u.anonymous_id));
    (settings || []).forEach(u => { const n = (u.display_name || '').trim(); if (n) names.set(String(u.telegram_id), n); });
    return names;
  }

  function jitsiTokenFor(roomName, displayName, moderator) {
    if (isPublicJitsi()) return null;
    return generateJitsiJWT(roomName, { displayName, moderator });
  }

  // Present = joined, hasn't left, and is still heartbeating. The TTL is what
  // frees rooms/seats when a WebView is killed and never says goodbye.
  // People who chose "open in browser" are in Jitsi's own page and cannot
  // heartbeat, so they count as present until they leave (or the session cap).
  const isPresent = p => !!p.joined_at && !p.left_at &&
    (Date.now() - new Date(p.last_seen_at || p.joined_at).getTime()) < (p.via_external ? MAX_SESSION_MS : PRESENCE_TTL_MS);

  async function getParticipants(sessionId) {
    const { data } = await supabase
      .from('session_participants')
      .select('telegram_id, joined_at, left_at, last_seen_at, via_external')
      .eq('session_id', sessionId);
    return data || [];
  }

  // Ends a session and tells everyone. Idempotent.
  async function finishSession(sessionId, reason = 'host') {
    const { data: updated } = await supabase
      .from('video_sessions')
      .update({ status: 'ended', ended_at: nowIso() })
      .eq('id', sessionId)
      .in('status', ['scheduled', 'active'])
      .select('id');
    if (!updated || !updated.length) return false; // already finished

    await supabase.from('session_participants').update({ left_at: nowIso() }).eq('session_id', sessionId).is('left_at', null);
    const participants = await getParticipants(sessionId);
    participants.forEach(p => emitToUserRoom(p.telegram_id, 'session_ended', { session_id: sessionId, reason }));
    io.emit('admin:session_activity', { type: 'ended', session_id: sessionId, reason, at: nowIso() });
    return true;
  }

  // ── POST /api/sessions/create ──────────────────────────────────────────────
  router.post('/create', requireAuth, async (req, res) => {
    try {
      const { id: host_id } = req.telegramUser;
      const { is_group, title, scheduled_at, mentee_id } = req.body || {};

      const { data: hostUser } = await supabase.from('users').select('role, anonymous_id').eq('telegram_id', host_id).single();
      if (!hostUser || hostUser.role !== 'mentor') return res.status(403).json({ error: 'Only mentors can create sessions' });
      const hostName = (await displayNames([host_id])).get(String(host_id)) || hostUser.anonymous_id;

      // Normalise the start time. Past/missing → "now"; garbage → 400.
      let scheduledDate = scheduled_at ? new Date(scheduled_at) : new Date();
      if (isNaN(scheduledDate.getTime())) return res.status(400).json({ error: 'Invalid start time' });
      if (scheduledDate.getTime() < Date.now()) scheduledDate = new Date();
      if (scheduledDate.getTime() - Date.now() > 90 * 24 * 60 * 60 * 1000) return res.status(400).json({ error: 'That start time is too far ahead. Please choose an earlier date.' });

      // Work out who is invited — and only ever the host's own active mentees.
      let inviteeIds = [];
      if (is_group) {
        const requested = (Array.isArray(req.body.participant_ids) ? req.body.participant_ids : [])
          .map(x => parseInt(x, 10)).filter(n => !isNaN(n) && !same(n, host_id));
        if (requested.length) {
          const { data: owned } = await supabase.from('mentorship_assignments').select('user_id')
            .eq('mentor_id', host_id).eq('is_active', true).in('user_id', requested);
          inviteeIds = [...new Set((owned || []).map(a => a.user_id))];
        }
      } else if (mentee_id != null && mentee_id !== '') {
        const menteeId = parseInt(mentee_id, 10);
        if (isNaN(menteeId)) return res.status(400).json({ error: 'Invalid mentee' });
        const { data: assignment } = await supabase.from('mentorship_assignments').select('id')
          .eq('mentor_id', host_id).eq('user_id', menteeId).eq('is_active', true).maybeSingle();
        if (!assignment) return res.status(403).json({ error: 'User is not your active mentee' });
        inviteeIds = [menteeId];

        // Idempotency: a double-tap on "Start session" must not create two rooms
        // and two invites for the same mentee.
        const lo = new Date(scheduledDate.getTime() - 2 * 60 * 1000).toISOString();
        const hi = new Date(scheduledDate.getTime() + 2 * 60 * 1000).toISOString();
        const { data: dupes } = await supabase
          .from('video_sessions')
          .select('*, session_participants!inner(telegram_id)')
          .eq('host_id', host_id).eq('is_group', false)
          .in('status', ['scheduled', 'active'])
          .gte('scheduled_at', lo).lte('scheduled_at', hi)
          .eq('session_participants.telegram_id', menteeId)
          .limit(1);
        if (dupes && dupes.length) {
          const d = dupes[0];
          return res.status(200).json({
            session: { id: d.id, title: d.title, status: d.status, scheduled_at: d.scheduled_at, is_group: false, host_id: d.host_id },
            room_name: d.room_name, room_password: d.room_password,
            jitsi_domain: JITSI_DOMAIN, server_time: nowIso(), deduped: true,
          });
        }
      }

      const roomName = `holy-${uuidv4()}`;
      const roomPassword = generateRoomPassword();

      // Skip the "starting within 10 minutes" reminder when there's no lead time.
      const skipStartingSoonReminder = scheduledDate.getTime() - Date.now() < 10 * 60 * 1000;

      const { data: session, error } = await supabase.from('video_sessions').insert({
        room_name: roomName,
        room_password: roomPassword,
        host_id,
        is_group: !!is_group,
        max_participants: is_group ? 10 : 2,
        title: (title && String(title).trim().slice(0, 120)) || (is_group ? 'Group Session' : '1-on-1 Session'),
        scheduled_at: scheduledDate.toISOString(),
        status: 'scheduled',
        reminder_sent: skipStartingSoonReminder,
      }).select().single();
      if (error) return res.status(500).json({ error: error.message });

      // One round-trip for host + everyone invited.
      const rows = [host_id, ...inviteeIds].map(telegram_id => ({ session_id: session.id, telegram_id }));
      const { error: partErr } = await supabase.from('session_participants').upsert(rows, { onConflict: 'session_id,telegram_id' });
      if (partErr) {
        await supabase.from('video_sessions').delete().eq('id', session.id); // don't leave an orphan room behind
        return res.status(500).json({ error: partErr.message });
      }

      io.emit('admin:session_activity', {
        type: 'created', session_id: session.id, host: hostName,
        title: session.title, is_group: !!is_group, at: nowIso(),
      });

      // Invites go out in the background; the mentor gets their response now.
      const invite = { session_id: session.id, host: hostName, title: session.title, scheduled_at: session.scheduled_at };
      background(inviteeIds.map(async id => {
        // No room credentials over the socket — they're issued by /join only.
        emitToUserRoom(id, 'session_invite', { session_id: session.id, host: hostName, title: session.title, scheduled_at: session.scheduled_at });
        await notifySessionInvite(id, invite);
      }));

      const jitsiToken = jitsiTokenFor(roomName, hostName, true);
      res.status(201).json({
        session,
        room_name: roomName,
        room_password: roomPassword,
        ...(jitsiToken && { jitsi_token: jitsiToken }),
        jitsi_domain: JITSI_DOMAIN,
        server_time: nowIso(),
      });
    } catch (e) {
      console.error('[Sessions] create failed:', e);
      res.status(500).json({ error: 'Could not create the session. Please try again.' });
    }
  });

  // ── GET /api/sessions/clock – lets clients compute their clock skew so the
  // "Join" button opens at the right moment even if the phone's clock is off.
  router.get('/clock', requireAuth, (req, res) => res.json({ now: nowIso() }));

  // ── GET /api/sessions/my ───────────────────────────────────────────────────
  router.get('/my', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data, error } = await supabase
      .from('session_participants')
      .select(`*, session:session_id(${SESSION_PUBLIC_COLS}, ${HOST_JOIN})`)
      .eq('telegram_id', telegram_id)
      .order('session(scheduled_at)', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ── GET /api/sessions/upcoming – group sessions ────────────────────────────
  // Live sessions stay listed for as long as they're active (previously a call
  // that ran past 60 min vanished from everyone's list, so nobody could rejoin).
  router.get('/upcoming', requireAuth, async (req, res) => {
    const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('video_sessions')
      .select(`${SESSION_PUBLIC_COLS}, ${HOST_JOIN}`)
      .eq('is_group', true)
      .in('status', ['scheduled', 'active'])
      .or(`scheduled_at.gte.${windowStart},status.eq.active`)
      .order('scheduled_at', { ascending: true })
      .limit(20);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ── GET /api/sessions/:id/join – the ONLY place credentials are issued ─────
  router.get('/:id/join', requireAuth, async (req, res) => {
    try {
      const { id: telegram_id } = req.telegramUser;
      const { data: session, error } = await supabase.from('video_sessions').select('*').eq('id', req.params.id).single();
      if (error || !session) return res.status(404).json({ error: 'We could not find this session', code: 'not_found' });

      const now = Date.now();
      const startMs = new Date(session.scheduled_at).getTime();

      if (FINISHED.includes(session.status)) {
        return res.status(410).json({ error: 'This session has already ended.', code: 'ended' });
      }
      if (session.status === 'scheduled') {
        if (now - startMs > SCHEDULED_EXPIRY_MS) {
          return res.status(410).json({ error: 'This session has already expired.', code: 'expired' });
        }
        if (startMs - now > EARLY_JOIN_MS) {
          return res.status(403).json({
            error: 'This session has not started yet. Please wait a little.', code: 'too_early',
            starts_at: session.scheduled_at,
            opens_at: new Date(startMs - EARLY_JOIN_MS).toISOString(),
            server_time: nowIso(),
          });
        }
      }

      const isHost = same(session.host_id, telegram_id);
      const external = req.query.via === 'external';
      const participants = await getParticipants(session.id);
      const me = participants.find(p => same(p.telegram_id, telegram_id));

      if (!session.is_group && !me && !isHost) return res.status(403).json({ error: 'Not a participant', code: 'forbidden' });

      const present = participants.filter(isPresent);
      if (session.is_group && !me && present.length >= (session.max_participants || 10)) {
        return res.status(409).json({ error: 'Sorry, this session is full.', code: 'full' });
      }

      const hostWasPresent = participants.some(p => same(p.telegram_id, session.host_id) && isPresent(p));

      // Record presence. Re-joining clears left_at, so a dropped call can be resumed.
      await supabase.from('session_participants').upsert({
        session_id: session.id, telegram_id,
        joined_at: me?.joined_at || nowIso(), left_at: null, last_seen_at: nowIso(), via_external: external,
      }, { onConflict: 'session_id,telegram_id' });

      // Only the HOST starting the room makes it "live". A mentee arriving first
      // is waiting in the lobby; it must not flip the session to active or send the
      // mentor a "session started" push for their own session.
      let status = session.status;
      const firstStart = isHost && session.status === 'scheduled';
      if (firstStart) {
        status = 'active';
        await supabase.from('video_sessions').update({ status, started_at: nowIso() }).eq('id', session.id).eq('status', 'scheduled');
      }

      const names = await displayNames([telegram_id, session.host_id]);
      const myName = names.get(String(telegram_id)) || 'Anonymous';
      const hostName = names.get(String(session.host_id)) || 'Your mentor';

      const others = participants.filter(p => !same(p.telegram_id, telegram_id));

      if (isHost && !hostWasPresent) {
        // Tell everyone the host is here — lobbies unlock instantly.
        others.forEach(p => emitToUserRoom(p.telegram_id, 'session_host_joined', { session_id: session.id, title: session.title }));
        if (firstStart) {
          // Telegram push only for people who haven't opened the app for this session yet.
          background(others.filter(p => !p.joined_at).map(p => {
            emitToUserRoom(p.telegram_id, 'session_started', { session_id: session.id, title: session.title });
            return notifySessionStarted(p.telegram_id, { session_id: session.id, title: session.title });
          }));
        }
      } else if (!isHost && !hostWasPresent) {
        // Someone is waiting and the host isn't in the room: nudge the host (throttled).
        emitToUserRoom(session.host_id, 'session_participant_waiting', { session_id: session.id, title: session.title, name: myName });
        const key = `${session.id}:${telegram_id}`;
        if (now - (waitingPings.get(key) || 0) > WAITING_PING_EVERY) {
          waitingPings.set(key, now);
          background([notifySessionWaiting(session.host_id, { session_id: session.id, title: session.title, waiting_name: myName })]);
        }
      }

      io.emit('admin:session_activity', { type: 'participant_joined', session_id: session.id, telegram_id, anonymous_id: myName, at: nowIso() });

      const jitsiToken = jitsiTokenFor(session.room_name, myName, isHost);
      res.json({
        session_id: session.id,
        room_name: session.room_name,
        room_password: session.room_password,
        ...(jitsiToken && { jitsi_token: jitsiToken }),
        jitsi_domain: JITSI_DOMAIN,
        display_name: myName,
        is_moderator: isHost,
        title: session.title,
        is_group: session.is_group,
        scheduled_at: session.scheduled_at,
        status,
        host_name: hostName,
        host_present: isHost || hostWasPresent,
        server_time: nowIso(),
      });
    } catch (e) {
      console.error('[Sessions] join failed:', e);
      res.status(500).json({ error: 'Could not join the session. Please try again.' });
    }
  });

  // ── POST /api/sessions/:id/heartbeat ───────────────────────────────────────
  // Called every ~25 s by the lobby and the in-call screen. It (a) proves the
  // client is still there, and (b) returns live state, so the lobby unlocks and
  // an ended session is noticed even if the socket is down.
  router.post('/:id/heartbeat', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data: session } = await supabase.from('video_sessions').select('id, host_id, status, is_group').eq('id', req.params.id).single();
    if (!session) return res.status(404).json({ error: 'We could not find this session' });

    const participants = await getParticipants(session.id);
    const me = participants.find(p => same(p.telegram_id, telegram_id));
    if (!me && !same(session.host_id, telegram_id)) return res.status(403).json({ error: 'Not a participant' });

    // in_room:true re-asserts presence (e.g. after a premature left_at), so a
    // client that is demonstrably still in the room never gets stranded.
    const inRoom = !!req.body?.in_room;
    if (me && me.joined_at && !FINISHED.includes(session.status) && (inRoom || !me.left_at)) {
      await supabase.from('session_participants')
        .update({ last_seen_at: nowIso(), ...(inRoom ? { left_at: null } : {}) })
        .eq('session_id', session.id).eq('telegram_id', telegram_id);
      me.last_seen_at = nowIso();
      if (inRoom) me.left_at = null;
    }
    res.json({
      status: session.status,
      ended: FINISHED.includes(session.status),
      host_present: participants.some(p => same(p.telegram_id, session.host_id) && isPresent(p)),
      present_count: participants.filter(isPresent).length,
      server_time: nowIso(),
    });
  });

  // ── POST /api/sessions/:id/leave – leave WITHOUT ending the session ────────
  // Body { end: true } (host only) ends it for everyone. Leaving is how a mentor
  // survives a dropped connection: the room stays open and they can rejoin.
  router.post('/:id/leave', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data: session } = await supabase.from('video_sessions').select('id, host_id, status').eq('id', req.params.id).single();
    if (!session) return res.status(404).json({ error: 'We could not find this session' });

    await supabase.from('session_participants').update({ left_at: nowIso() })
      .eq('session_id', session.id).eq('telegram_id', telegram_id).is('left_at', null);

    let ended = false;
    if (req.body?.end && same(session.host_id, telegram_id)) ended = await finishSession(session.id, 'host');
    else if (!FINISHED.includes(session.status)) {
      const others = (await getParticipants(session.id)).filter(p => !same(p.telegram_id, telegram_id));
      if (same(session.host_id, telegram_id)) {
        others.filter(isPresent).forEach(p => emitToUserRoom(p.telegram_id, 'session_host_left', { session_id: session.id }));
      }
    }
    res.json({ success: true, ended });
  });

  // ── PATCH /api/sessions/:id/end – host ends for everyone ───────────────────
  router.patch('/:id/end', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data: session } = await supabase.from('video_sessions').select('host_id').eq('id', req.params.id).single();
    if (!session || !same(session.host_id, telegram_id)) return res.status(403).json({ error: 'Only host can end session' });
    await finishSession(req.params.id, 'host');
    res.json({ success: true });
  });

  // ── DELETE /api/sessions/my – clear FINISHED sessions from my list ─────────
  // Previously this wiped every participant row, including for sessions that
  // were live or scheduled, which locked mentees out mid-call and silently
  // cancelled upcoming sessions. It now only touches finished/expired ones.
  router.delete('/my', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const expiredBefore = Date.now() - SCHEDULED_EXPIRY_MS;
    const isDone = s => FINISHED.includes(s.status) || (s.status === 'scheduled' && new Date(s.scheduled_at).getTime() < expiredBefore);

    const { data: mine, error } = await supabase
      .from('session_participants')
      .select('session_id, session:session_id(id, host_id, status, scheduled_at)')
      .eq('telegram_id', telegram_id);
    if (error) return res.status(500).json({ error: error.message });

    const finished = (mine || []).filter(r => r.session && isDone(r.session));
    const finishedIds = finished.map(r => r.session_id);
    if (!finishedIds.length) return res.json({ success: true, count: 0 });

    // A mentor clearing history removes their finished sessions from mentees' lists too.
    const hostedIds = finished.filter(r => same(r.session.host_id, telegram_id)).map(r => r.session_id);
    let total = 0;
    if (hostedIds.length) {
      const { count, error: e1 } = await supabase.from('session_participants').delete({ count: 'exact' }).in('session_id', hostedIds);
      if (e1) return res.status(500).json({ error: e1.message });
      total += count || 0;
      await supabase.from('video_sessions').update({ status: 'cleared' }).in('id', hostedIds).neq('status', 'cleared');
    }
    const rest = finishedIds.filter(id => !hostedIds.includes(id));
    if (rest.length) {
      const { count, error: e2 } = await supabase.from('session_participants').delete({ count: 'exact' }).eq('telegram_id', telegram_id).in('session_id', rest);
      if (e2) return res.status(500).json({ error: e2.message });
      total += count || 0;
    }
    res.json({ success: true, count: total });
  });

  // ── Lifecycle sweeper ──────────────────────────────────────────────────────
  // Rooms must close even if the host's client never got to say goodbye.
  let sweeping = false;
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      const now = Date.now();

      // 1. Live sessions: too long, or empty for EMPTY_ROOM_END_MS.
      const { data: live } = await supabase
        .from('video_sessions')
        .select('id, started_at, session_participants(joined_at, left_at, last_seen_at, via_external)')
        .eq('status', 'active');
      for (const s of live || []) {
        const parts = s.session_participants || [];
        const tooLong = s.started_at && now - new Date(s.started_at).getTime() > MAX_SESSION_MS;
        const anyoneHere = parts.some(isPresent);
        const lastActivity = Math.max(0, ...parts.flatMap(p => [p.joined_at, p.left_at, p.last_seen_at]).filter(Boolean).map(d => new Date(d).getTime()));
        const emptyTooLong = !anyoneHere && lastActivity && now - lastActivity > EMPTY_ROOM_END_MS;
        if (tooLong || emptyTooLong) await finishSession(s.id, tooLong ? 'max_duration' : 'empty');
      }

      // 2. Scheduled sessions nobody started within the expiry window.
      const cutoff = new Date(now - SCHEDULED_EXPIRY_MS).toISOString();
      const { data: stale } = await supabase.from('video_sessions').select('id').eq('status', 'scheduled').lt('scheduled_at', cutoff);
      for (const s of stale || []) await finishSession(s.id, 'expired');

      for (const [k, ts] of waitingPings) if (now - ts > WAITING_PING_EVERY * 2) waitingPings.delete(k);
    } catch (e) {
      console.error('[Sessions] sweep failed:', e.message);
    } finally {
      sweeping = false;
    }
  }
  const sweepTimer = setInterval(sweep, 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();

  return router;
};