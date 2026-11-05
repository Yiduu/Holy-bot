'use strict';

// Guest mode for mentors: "preview the app as a mentee".
//
// Mounted at /api/guest. The client (frontend/guest-mode.js) rewrites every
// /api/<x> call to /api/guest/<x> while guest mode is on, so the real mentee
// screens run unchanged but can only ever talk to this file. Everything here
// reads/writes the in-memory sandbox (utils/guestSandbox.js). The only real
// data touched is READ-ONLY: the real mentor directory and the topic list.
// No notifications, no bot messages, no real requests are ever created.

const express = require('express');
const sandbox = require('../utils/guestSandbox');
const { JITSI_DOMAIN, isPublicJitsi, generateJitsiJWT } = require('../utils');

const SAMPLE_VERSE = {
  text: 'Your word is a lamp to my feet and a light to my path.',
  reference: 'Psalm 119:105',
};

module.exports = (supabase, requireAuth, mentorsRouter) => {
  const router = express.Router();
  const fail = (res, e) => res.status(e.status || 500).json({ error: e.message || e.error || 'Server error' });
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => fail(res, e));

  // Only mentors may use guest mode. Re-checked on every call.
  const mentorOnly = wrap(async (req, res, next) => {
    const { data } = await supabase.from('users').select('role, is_banned')
      .eq('telegram_id', req.telegramUser.id).maybeSingle();
    if (!data || data.role !== 'mentor' || data.is_banned) {
      return res.status(403).json({ error: 'Guest mode is only available to mentors.' });
    }
    next();
  });
  router.use(requireAuth, mentorOnly);

  const sb = req => sandbox.get(req.telegramUser.id);
  // Routes below need a running sandbox.
  const needSandbox = (req, res, next) => {
    const s = sb(req);
    if (!s) return res.status(409).json({ error: 'Guest mode is not active.', code: 'guest_inactive' });
    req.sbx = s;
    next();
  };

  // ── lifecycle ─────────────────────────────────────────────────────────
  router.post('/start', (req, res) => {
    const s = sandbox.start(req.telegramUser.id, req.body?.sex, req.body?.lang);
    res.json({ user: sandbox.userView(s) });
  });
  router.post('/end', (req, res) => { sandbox.end(req.telegramUser.id); res.json({ success: true }); });
  // Polled by the preview bar. Besides the checklist state it hands back any
  // simulated mentor events that have come due (typing, replies, invites).
  router.get('/state', (req, res) => {
    const s = sb(req);
    if (!s) return res.json({ active: false, user: null, has_mentor: false, pending: [], events: [] });
    const events = sandbox.flushDue(s);
    const ses = sandbox.sessionView(s);
    const mentorName = s.assignment ? (s.assignment.mentor.user_settings?.display_name || s.assignment.mentor.anonymous_id) : null;
    res.json({
      active: true, user: sandbox.userView(s), has_mentor: !!s.assignment, mentor_name: mentorName,
      pending: s.requests.filter(r => r.status === 'pending').map(r => ({
        id: r.id, mentor_name: r.mentor.user_settings?.display_name || r.mentor.anonymous_id })),
      requested: s.requests.length, rejected: s.requests.filter(r => r.status === 'rejected').length,
      goals: s.goals.length, messages_sent: s.messages.filter(m => m.from_id === s.persona.telegram_id).length,
      session: ses && ses.status !== 'ended' ? { id: ses.id, title: ses.title, status: ses.status, scheduled_at: ses.scheduled_at,
        mentor_link: mentorLink(s) } : null,
      events,
    });
  });

  // The mentor's side of the demo room, so a tester can open it on a second
  // device and see a real two-person call. Same private room as the mentee.
  function mentorLink(s) {
    const ses = s.session;
    if (!ses) return null;
    const name = s.assignment?.mentor.user_settings?.display_name || s.assignment?.mentor.anonymous_id || 'Mentor';
    const jwt = isPublicJitsi() ? null : generateJitsiJWT(ses.room_name, { displayName: name, moderator: true });
    const params = ['config.disableDeepLinking=true', 'config.prejoinConfig.enabled=false',
      `userInfo.displayName=${encodeURIComponent(name)}`, ...(jwt ? [`jwt=${jwt}`] : [])];
    return `https://${JITSI_DOMAIN}/${ses.room_name}#${params.join('&')}`;
  }

  router.use(needSandbox);

  // ── identity, dashboard ──────────────────────────────────────────────
  router.get('/auth/me', (req, res) => res.json({ registered: true, user: sandbox.userView(req.sbx), admin_id: null }));
  router.get('/auth/verse', (req, res) => res.json(SAMPLE_VERSE));
  router.get('/users/stats', wrap(async (req, res) => {
    const [u, m] = await Promise.all([
      supabase.from('users').select('telegram_id', { count: 'exact', head: true }).eq('is_banned', false),
      supabase.from('users').select('telegram_id', { count: 'exact', head: true }).eq('role', 'mentor').eq('is_banned', false),
    ]);
    res.json({ total_users: u.count || 0, active_mentors: m.count || 0, sessions_today: 0 });
  }));
  router.get('/users/settings', (req, res) => res.json({ ...req.sbx.settings, telegram_id: req.sbx.persona.telegram_id }));
  router.patch('/users/settings', (req, res) => {
    const ok = ['display_name', 'notify_messages', 'notify_sessions', 'notify_daily_verse', 'notify_streak_reminder'];
    for (const k of ok) if (req.body?.[k] !== undefined) req.sbx.settings[k] = req.body[k];
    res.json({ ...req.sbx.settings });
  });
  router.get('/users/pending-rating', (req, res) => res.json(null));
  router.post('/users/skip-rating', (req, res) => res.json({ success: true }));
  router.get('/users/my-mentor', (req, res) => {
    const a = req.sbx.assignment;
    res.json(a ? { id: a.id, user_id: req.sbx.persona.telegram_id, mentor_id: a.mentor.telegram_id,
      is_active: true, started_at: a.started_at, mentor: a.mentor } : null);
  });
  router.get('/users/chat-partner', (req, res) => {
    const a = req.sbx.assignment;
    if (!a) return res.json({ type: 'none' });
    const m = a.mentor;
    const unread = req.sbx.messages.filter(x => !x.is_read && x.from_id === m.telegram_id).length;
    res.json({ type: 'single', partner: { telegram_id: m.telegram_id, anonymous_id: m.anonymous_id,
      display_name: m.user_settings?.display_name || m.anonymous_id, last_active: new Date().toISOString(),
      photo_file_id: m.photo_file_id, photo_updated_at: m.photo_updated_at, unread_count: unread } });
  });
  router.post('/users/end-mentorship', (req, res) => { sandbox.endAssignment(req.sbx); res.json({ success: true }); });
  router.post('/users/end-mentorship-and-rate', (req, res) => { sandbox.endAssignment(req.sbx); res.json({ success: true }); });

  // ── topics (read-only real list; the guest's own choice is sandboxed) ──
  router.get('/topics', wrap(async (req, res) => {
    const { data, error } = await supabase.from('topics').select('*').eq('is_active', true).order('name', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  }));
  router.get('/topics/my', wrap(async (req, res) => {
    const ids = req.sbx.topics;
    if (!ids.length) return res.json([]);
    const { data } = await supabase.from('topics').select('*').in('id', ids);
    res.json((data || []).map(t => ({ topic_id: t.id, topics: t })));
  }));
  router.post('/topics/my', (req, res) => {
    const ids = Array.isArray(req.body?.topic_ids) ? req.body.topic_ids.map(Number).filter(Number.isFinite).slice(0, 20) : [];
    req.sbx.topics = ids;
    res.json({ success: true });
  });

  // ── mentor discovery + requests ───────────────────────────────────────
  // The real directory, filtered for the guest persona (see routes/mentors.js).
  router.get('/mentors', (req, res, next) => {
    req.guestContext = {
      sex: req.sbx.persona.sex,
      selfId: req.telegramUser.id,
      pendingIds: [...sandbox.pendingMentorIds(req.sbx)],
      waitlistIds: [...req.sbx.waitlist],
    };
    req.url = '/';
    mentorsRouter.handle(req, res, next);
  });

  router.post('/mentors/request', wrap(async (req, res) => {
    const mentorId = Number(req.body?.mentor_id);
    if (!mentorId) return res.status(400).json({ error: 'mentor_id required' });
    if (String(mentorId) === String(req.telegramUser.id)) return res.status(400).json({ error: "You can't request yourself." });

    // Same eligibility checks as the real endpoint (read-only), so the
    // preview shows the real "full" / "not accepting" errors.
    const { data: mentor } = await supabase.from('users')
      .select('telegram_id, anonymous_id, sex, age_range, rating, rating_count, photo_file_id, photo_updated_at, accepting_requests, role, is_banned, user_settings(bio, specialization, display_name, max_mentees)')
      .eq('telegram_id', mentorId).maybeSingle();
    if (!mentor || mentor.role !== 'mentor' || mentor.is_banned) return res.status(404).json({ error: 'Mentor not found' });
    if (mentor.accepting_requests === false) return res.status(409).json({ error: 'This mentor is not accepting new requests at this time.' });
    const max = mentor.user_settings?.max_mentees || parseInt(process.env.MAX_MENTEES_DEFAULT || '3', 10);
    const { count } = await supabase.from('mentorship_assignments').select('id', { count: 'exact', head: true })
      .eq('mentor_id', mentorId).eq('is_active', true);
    if ((count || 0) >= max) return res.status(409).json({ error: 'Mentor is at full capacity. Please try another mentor.' });

    const { accepting_requests, role, is_banned, ...snapshot } = mentor;
    const r = sandbox.addRequest(req.sbx, snapshot, req.body?.topic_id);
    if (r.error) return fail(res, r);
    res.status(201).json({ id: r.request.id, status: 'pending', preview: true });
  }));

  router.post('/simulate-accept', (req, res) => {
    const r = sandbox.simulateAccept(req.sbx, String(req.body?.request_id || ''));
    if (r.error) return fail(res, r);
    res.json({ success: true });
  });
  // ── "Act as my mentor" controls (each one only touches the sandbox) ────
  router.post('/sim/decline', (req, res) => {
    const r = sandbox.simulateDecline(req.sbx, String(req.body?.request_id || ''), req.body?.reason);
    if (r.error) return fail(res, r);
    res.json({ success: true });
  });
  router.post('/sim/message', (req, res) => {
    const r = sandbox.mentorSays(req.sbx, req.body?.content);
    if (r.error) return fail(res, r);
    res.json({ success: true });
  });
  router.post('/sim/session', (req, res) => {
    const r = sandbox.startSession(req.sbx, { inMinutes: req.body?.in_minutes, title: req.body?.title });
    if (r.error) return fail(res, r);
    res.status(201).json({ session: r.session, mentor_link: mentorLink(req.sbx) });
  });
  router.post('/sim/session/end', (req, res) => {
    const r = sandbox.endSession(req.sbx);
    if (r.error) return fail(res, r);
    res.json({ success: true });
  });
  router.post('/mentors/waitlist', (req, res) => { req.sbx.waitlist.add(Number(req.body?.mentor_id)); res.json({ success: true }); });
  router.delete('/mentors/waitlist/:id', (req, res) => { req.sbx.waitlist.delete(Number(req.params.id)); res.json({ success: true }); });
  router.get('/mentors/my-requests', (req, res) => res.json([]));
  router.get('/mentors/referrals', (req, res) => res.json([]));
  router.post('/mentors/rate', (req, res) => res.json({ success: true }));

  // ── goals (mentee view + the "act as my mentor" composer) ──────────────
  router.get('/goals/mine', (req, res) => res.json(req.sbx.assignment ? sandbox.listGoals(req.sbx) : []));
  router.get('/goals/mentee/:id', (req, res) => res.json(sandbox.listGoals(req.sbx)));
  router.post('/goals', (req, res) => {
    const r = sandbox.createGoal(req.sbx, req.body || {});
    if (r.error) return fail(res, r);
    res.status(201).json(r.goal);
  });
  router.patch('/goals/tasks/:id', (req, res) => {
    const r = sandbox.setTaskDone(req.sbx, req.params.id, req.body || {});
    if (r.error) return fail(res, r);
    res.json(r.goal);
  });
  router.delete('/goals/:id', (req, res) => {
    if (!sandbox.deleteGoal(req.sbx, req.params.id)) return res.status(404).json({ error: 'Goal not found' });
    res.json({ success: true });
  });

  // ── streak ────────────────────────────────────────────────────────────
  router.get('/streaks', (req, res) => res.json(sandbox.streakView(req.sbx)));
  router.post('/streaks/mark', (req, res) => res.json(sandbox.markStreak(req.sbx)));

  // ── journal ───────────────────────────────────────────────────────────
  router.get('/journal', (req, res) => res.json(req.sbx.journal));
  router.get('/journal/by-date', (req, res) => {
    const d = String(req.query.date || '').slice(0, 10);
    res.json(req.sbx.journal.filter(e => e.created_at.slice(0, 10) === d));
  });
  router.post('/journal', (req, res) => {
    const r = sandbox.addJournal(req.sbx, req.body || {});
    if (r.error) return fail(res, r);
    res.status(201).json(r.entry);
  });
  router.put('/journal/:id', (req, res) => {
    const r = sandbox.updateJournal(req.sbx, req.params.id, req.body || {});
    if (r.error) return fail(res, r);
    res.json(r.entry);
  });
  router.delete('/journal/:id', (req, res) => {
    if (!sandbox.deleteJournal(req.sbx, req.params.id)) return res.status(404).json({ error: 'Entry not found' });
    res.json({ success: true });
  });

  // ── messages: a real chat against the sandbox ─────────────────────────
  // The simulated mentor answers a few seconds after each message (see
  // sandbox.menteeSendMessage); replies reach the screen through /state events.
  router.get('/messages/unread/count', (req, res) =>
    res.json({ count: req.sbx.messages.filter(m => !m.is_read && m.from_id !== req.sbx.persona.telegram_id).length }));
  router.post('/messages/read/:id', (req, res) => {
    const now = new Date().toISOString();
    req.sbx.messages.forEach(m => { if (m.from_id !== req.sbx.persona.telegram_id) { m.is_read = true; m.read_at = m.read_at || now; } });
    res.json({ success: true });
  });
  router.post('/messages', (req, res) => {
    const r = sandbox.menteeSendMessage(req.sbx, req.body || {});
    if (r.error) return fail(res, r);
    res.status(201).json(r.message);
  });
  router.patch('/messages/:id', (req, res) => {
    const r = sandbox.editMessage(req.sbx, req.params.id, req.body?.content);
    if (r.error) return fail(res, r);
    res.json(r.message);
  });
  router.delete('/messages/:id', (req, res) => {
    if (!sandbox.deleteMessage(req.sbx, req.params.id)) return res.status(404).json({ error: 'Message not found' });
    res.json({ success: true });
  });
  router.get('/messages/:id', (req, res) => {
    if (!req.sbx.assignment) return res.status(403).json({ error: 'No active mentorship with this user' });
    const now = new Date().toISOString();
    req.sbx.messages.forEach(m => { if (m.from_id !== req.sbx.persona.telegram_id) { m.is_read = true; m.read_at = m.read_at || now; } });
    res.json(req.sbx.messages);
  });

  // ── sessions: one demo live session the "mentor" can start ─────────────
  const EARLY_JOIN_MS = 5 * 60 * 1000;
  const sesById = (req, res) => {
    const v = sandbox.sessionView(req.sbx);
    if (!v || v.id !== req.params.id) { res.status(404).json({ error: 'We could not find this session', code: 'not_found' }); return null; }
    if (v.status === 'ended') { res.status(410).json({ error: 'This session has already ended.', code: 'ended' }); return null; }
    return v;
  };
  router.get('/sessions/clock', (req, res) => res.json({ now: new Date().toISOString() }));
  router.get('/sessions/my', (req, res) => {
    const v = sandbox.sessionView(req.sbx);
    res.json(v ? [{ session_id: v.id, telegram_id: req.sbx.persona.telegram_id, joined_at: null, left_at: null, session: v }] : []);
  });
  router.get('/sessions/upcoming', (req, res) => res.json([]));
  router.delete('/sessions/my', (req, res) => {
    if (req.sbx.session && sandbox.sessionView(req.sbx).status === 'ended') req.sbx.session = null;
    res.json({ success: true, count: 0 });
  });
  router.get('/sessions/:id/join', (req, res) => {
    const v = sesById(req, res); if (!v) return;
    const startMs = new Date(v.scheduled_at).getTime();
    if (v.status === 'scheduled' && startMs - Date.now() > EARLY_JOIN_MS) {
      return res.status(403).json({ error: 'This session has not started yet. Please wait a little.', code: 'too_early',
        starts_at: v.scheduled_at, opens_at: new Date(startMs - EARLY_JOIN_MS).toISOString(), server_time: new Date().toISOString() });
    }
    const ses = req.sbx.session;
    const me = req.sbx.settings.display_name || req.sbx.persona.anonymous_id;
    const jwt = isPublicJitsi() ? null : generateJitsiJWT(ses.room_name, { displayName: me, moderator: false });
    res.json({ session_id: v.id, room_name: ses.room_name, room_password: ses.room_password, ...(jwt && { jitsi_token: jwt }),
      jitsi_domain: JITSI_DOMAIN, display_name: me, is_moderator: false, title: v.title, is_group: false,
      scheduled_at: v.scheduled_at, status: 'active', host_name: v.host.user_settings.display_name,
      host_present: true, call_mode: ses.call_mode || 'video', server_time: new Date().toISOString() });
  });
  router.post('/sessions/:id/heartbeat', (req, res) => {
    const v = sandbox.sessionView(req.sbx);
    if (!v || v.id !== req.params.id) return res.status(404).json({ error: 'We could not find this session' });
    res.json({ status: v.status, ended: v.status === 'ended', host_present: true, present_count: 2,
      call_mode: req.sbx.session.call_mode || 'video', server_time: new Date().toISOString() });
  });
  router.post('/sessions/:id/leave', (req, res) => res.json({ success: true, ended: false }));
  router.post('/sessions/:id/call-mode', (req, res) => {
    if (req.sbx.session && ['audio', 'video'].includes(req.body?.mode)) req.sbx.session.call_mode = req.body.mode;
    res.json({ success: true, mode: req.sbx.session?.call_mode || 'video' });
  });
  router.get('/sessions/:id/ice', (req, res) => res.json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }));
  router.post('/sessions/:id/signal', (req, res) => res.json({ success: true }));

  // ── support: nothing is ever sent to the real support team ─────────────
  router.get('/support', (req, res) => res.json([]));

  // Anything else: harmless empty read, refused write. A guest can never
  // reach a real endpoint through this prefix.
  router.use((req, res) => {
    if (req.method === 'GET') return res.json([]);
    res.status(403).json({ error: 'Not available in guest preview.', code: 'guest_blocked' });
  });

  return router;
};
