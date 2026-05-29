'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
// FIX: Moved require() calls to the top of the file (out of route handlers)
// and corrected the relative path from routes/sessions.js → bot.js at project root.
const { notifySessionInvite } = require('../bot');

module.exports = function sessionRoutes(supabase, requireAuth, io, onlineUsers) {
  const router = express.Router();

  function generateRoomPassword(length = 12) {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  function generateJitsiJWT(roomName, userInfo) {
    if (!process.env.JITSI_JWT_SECRET) return null;
    return jwt.sign({
      context: { user: userInfo },
      aud: 'jitsi',
      iss: process.env.JITSI_APP_ID || 'holy-app',
      sub: 'meet.jit.si',
      room: roomName,
    }, process.env.JITSI_JWT_SECRET, { expiresIn: '4h' });
  }

  // POST /api/sessions/create – mentor creates a session
  router.post('/create', requireAuth, async (req, res) => {
    console.log('Session create request:', req.body);
    const { id: host_id } = req.telegramUser;
    const { is_group, title, scheduled_at, mentee_id } = req.body;

    // Verify host is a mentor
    const { data: hostUser } = await supabase.from('users').select('role, anonymous_id').eq('telegram_id', host_id).single();
    if (!hostUser || hostUser.role !== 'mentor') return res.status(403).json({ error: 'Only mentors can create sessions' });

    // If mentee_id provided, verify assignment
    if (mentee_id) {
      const { data: assignment } = await supabase
        .from('mentorship_assignments')
        .select('id')
        .eq('mentor_id', host_id)
        .eq('user_id', mentee_id)
        .eq('is_active', true)
        .single();
      if (!assignment) return res.status(403).json({ error: 'User is not your active mentee' });
    }

    const roomName = `holy-${uuidv4()}`;
    const roomPassword = generateRoomPassword();

    const { data: session, error } = await supabase.from('video_sessions').insert({
      room_name: roomName,
      room_password: roomPassword,
      host_id,
      is_group: !!is_group,
      max_participants: is_group ? 10 : 2,
      title: title || (is_group ? 'Group Session' : '1-on-1 Session'),
      scheduled_at: scheduled_at || new Date().toISOString(),
      status: 'scheduled',
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Add host as participant
    await supabase.from('session_participants').insert({ session_id: session.id, telegram_id: host_id });

    // Add mentee if provided (private session)
    if (mentee_id && !is_group) {
      await supabase.from('session_participants').insert({ session_id: session.id, telegram_id: mentee_id });
      
      const sock = onlineUsers.get(String(mentee_id));
      if (sock) {
        io.to(sock).emit('session_invite', {
          session_id: session.id,
          room_name: roomName,
          room_password: roomPassword,
          host: hostUser.anonymous_id,
          title: session.title,
          scheduled_at: session.scheduled_at,
        });
      }

      await notifySessionInvite(mentee_id, {
        session_id: session.id,
        host: hostUser.anonymous_id,
        title: session.title,
        scheduled_at: session.scheduled_at,
      });
    }

    // Handle group session participants if provided
    if (is_group && Array.isArray(req.body.participant_ids)) {
      for (const tid of req.body.participant_ids) {
        // Skip host if they are in the list
        if (String(tid) === String(host_id)) continue;

        await supabase.from('session_participants').upsert({ session_id: session.id, telegram_id: tid }, { onConflict: 'session_id,telegram_id' });

        // Notify via bot
        await notifySessionInvite(tid, {
          session_id: session.id,
          host: hostUser.anonymous_id,
          title: session.title,
          scheduled_at: session.scheduled_at,
        });

        // Notify via socket if online
        const sock = onlineUsers.get(String(tid));
        if (sock) {
          io.to(sock).emit('session_invite', {
            session_id: session.id,
            room_name: roomName,
            room_password: roomPassword,
            host: hostUser.anonymous_id,
            title: session.title,
            scheduled_at: session.scheduled_at,
          });
        }
      }
    }

    const jitsiToken = generateJitsiJWT(roomName, { displayName: hostUser.anonymous_id, moderator: true });
    res.status(201).json({
      session,
      room_name: roomName,
      room_password: roomPassword,
      jitsi_token: jitsiToken,
      jitsi_domain: process.env.JITSI_DOMAIN || 'meet.jit.si'
    });
  });

  // GET /api/sessions/my – sessions I'm part of
  router.get('/my', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data, error } = await supabase
      .from('session_participants')
      .select('*, session:session_id(*, host:host_id(anonymous_id, user_settings(display_name)))')
      .eq('telegram_id', telegram_id)
      .order('session(scheduled_at)', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // GET /api/sessions/upcoming – upcoming group sessions (public)
  router.get('/upcoming', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('video_sessions')
      .select('*, host:host_id(anonymous_id, user_settings(display_name))')
      .eq('is_group', true)
      .in('status', ['scheduled'])
      .gte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(20);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // GET /api/sessions/:id/join – get room credentials
  router.get('/:id/join', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data: session, error } = await supabase
      .from('video_sessions')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) return res.status(404).json({ error: 'Session not found' });

    // Check participant or group
    if (!session.is_group) {
      const { data: part } = await supabase.from('session_participants').select('telegram_id').eq('session_id', session.id).eq('telegram_id', telegram_id).single();
      if (!part) return res.status(403).json({ error: 'Not a participant' });
    } else {
      // Join group session – add participant
      await supabase.from('session_participants').upsert({ session_id: session.id, telegram_id }, { onConflict: 'session_id,telegram_id' });
    }

    // Mark joined
    await supabase.from('session_participants').update({ joined_at: new Date().toISOString() }).eq('session_id', session.id).eq('telegram_id', telegram_id);

    // Activate session if not already
    if (session.status === 'scheduled') {
      await supabase.from('video_sessions').update({ status: 'active', started_at: new Date().toISOString() }).eq('id', session.id);
    }

    const { data: user } = await supabase.from('users').select('anonymous_id').eq('telegram_id', telegram_id).single();
    const isModerator = session.host_id === telegram_id;
    const jitsiToken = generateJitsiJWT(session.room_name, { displayName: user?.anonymous_id || 'Anonymous', moderator: isModerator });

    res.json({
      room_name: session.room_name,
      room_password: session.room_password,
      jitsi_token: jitsiToken,
      jitsi_domain: process.env.JITSI_DOMAIN || 'meet.jit.si',
      display_name: user?.anonymous_id || 'Anonymous',
      is_moderator: isModerator,
    });
  });

  // PATCH /api/sessions/:id/end
  router.patch('/:id/end', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data: session } = await supabase.from('video_sessions').select('host_id').eq('id', req.params.id).single();
    if (!session || session.host_id !== telegram_id) return res.status(403).json({ error: 'Only host can end session' });

    await supabase.from('video_sessions').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', req.params.id);
    await supabase.from('session_participants').update({ left_at: new Date().toISOString() }).eq('session_id', req.params.id).is('left_at', null);

    res.json({ success: true });
  });

  // DELETE /api/sessions/my – clear session history (remove self from ended sessions)
  router.delete('/my', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    console.log('[Sessions] Clearing history for:', telegram_id);

    // Step 1: Find all session IDs this user participated in
    const { data: participations, error: partErr } = await supabase
      .from('session_participants')
      .select('session_id')
      .eq('telegram_id', telegram_id);

    if (partErr) return res.status(500).json({ error: partErr.message });
    if (!participations?.length) {
      console.log('[Sessions] User has no session participation records.');
      return res.json({ success: true, count: 0 });
    }

    const participatedIds = participations.map(p => p.session_id);

    // Step 2: Of those, find which sessions have an ended status
    const { data: endedSessions, error: sessErr } = await supabase
      .from('video_sessions')
      .select('id')
      .in('id', participatedIds)
      .in('status', ['ended', 'completed', 'cancelled', 'expired']);

    if (sessErr) return res.status(500).json({ error: sessErr.message });
    if (!endedSessions?.length) {
      console.log('[Sessions] No ended sessions found for user:', telegram_id);
      return res.json({ success: true, count: 0 });
    }

    const endedIds = endedSessions.map(s => s.id);
    console.log(`[Sessions] Removing user from ${endedIds.length} ended session(s).`);

    // Step 3: Delete participant rows for those ended sessions
    const { data: deleted, error: delErr } = await supabase
      .from('session_participants')
      .delete()
      .eq('telegram_id', telegram_id)
      .in('session_id', endedIds)
      .select();

    if (delErr) return res.status(500).json({ error: delErr.message });
    res.json({ success: true, count: deleted?.length || 0 });
  });

  return router;
};