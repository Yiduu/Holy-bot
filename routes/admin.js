'use strict';

const express = require('express');
const axios = require('axios');

// Prefix shown above an admin's custom message, localized by the applicant's
// preferred language (user_settings.language). Falls back to English.
const CONTACT_PREFIX = {
  en: '📋 *Message from the Mentorship Team*\nRegarding your mentor application:',
  am: '📋 *መልእክት ከአማካሪ ቡድን*\nስለ አማካሪነት ማመልከቻዎ:',
};

module.exports = function adminRoutes(supabase, requireAuth, requireAdmin, io) {
  const router = express.Router();
  router.use(requireAuth, requireAdmin);

  async function logAudit(admin_id, action, target_id, target_type, details = {}) {
    await supabase.from('audit_logs').insert({ admin_id, action, target_id, target_type, details });
  }

  // ==================== STATS ====================
  router.get('/stats', async (req, res) => {
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const [total, todayUsers, mentors, pendingApps, flaggedMsgs, openTickets] = await Promise.all([
      supabase.from('users').select('telegram_id', { count: 'exact', head: true }),
      supabase.from('users').select('telegram_id', { count: 'exact', head: true }).gte('created_at', today.toISOString()),
      supabase.from('users').select('telegram_id', { count: 'exact', head: true }).eq('role', 'mentor'),
      supabase.from('mentor_applications').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('messages').select('id', { count: 'exact', head: true }).eq('is_flagged', true),
      supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    ]);

    res.json({
      total_users: total.count || 0,
      new_today: todayUsers.count || 0,
      active_mentors: mentors.count || 0,
      pending_applications: pendingApps.count || 0,
      flagged_messages: flaggedMsgs.count || 0,
      open_tickets: openTickets.count || 0,
    });
  });

  // ==================== ACTIVITY CHART ====================
  router.get('/activity', async (req, res) => {
    const { data, error } = await supabase.rpc('get_daily_active_users', { days: 7 });
    if (error) return res.status(500).json({ error: error.message });
    // Transform to { labels: [], counts: [] } for frontend
    const labels = data.map(d => d.date);
    const counts = data.map(d => d.active);
    res.json({ labels, counts });
  });

  // ==================== USER DETAILS ====================
  router.get('/users/:id', async (req, res) => {
    const { id } = req.params;
    const { data, error } = await supabase.from('users').select('*').eq('telegram_id', id).single();
    if (error) return res.status(404).json({ error: 'User not found' });
    res.json(data);
  });

  router.get('/users/:id/messages', async (req, res) => {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .or(`from_id.eq.${id},to_id.eq.${id}`)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ messages: data || [] });
  });

  router.get('/users/:id/sessions', async (req, res) => {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('video_sessions')
      .select('*')
      .eq('host_id', id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ sessions: data || [] });
  });

  // ==================== USERS LIST (paginated) ====================
  router.get('/users', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    let query = supabase.from('users').select('*, user_settings(display_name, bio)', { count: 'exact' });

    if (req.query.search) query = query.ilike('anonymous_id', `%${req.query.search}%`);
    if (req.query.role) query = query.eq('role', req.query.role);

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ users: data || [], total: count || 0, page, pages: Math.ceil((count || 0) / limit) });
  });

  // ==================== USER ACTIONS ====================
  router.patch('/users/:id/role', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const telegram_id = parseInt(req.params.id);
    const { role } = req.body;

    if (!['user', 'mentor'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    await supabase.from('users').update({ role }).eq('telegram_id', telegram_id);

    if (role === 'mentor') {
      await supabase.from('mentors').upsert({ telegram_id }, { onConflict: 'telegram_id' });
      await supabase.from('user_settings').upsert({ telegram_id }, { onConflict: 'telegram_id' });
    }

    await logAudit(admin_id, 'change_role', telegram_id, 'user', { new_role: role });
    res.json({ success: true });
  });

  router.patch('/users/:id/ban', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const telegram_id = parseInt(req.params.id);
    const { banned } = req.body;

    await supabase.from('users').update({ is_banned: !!banned }).eq('telegram_id', telegram_id);
    await logAudit(admin_id, banned ? 'ban_user' : 'unban_user', telegram_id, 'user');
    res.json({ success: true });
  });

  router.delete('/users/:id/delete', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const telegram_id = parseInt(req.params.id);

    const { data: user } = await supabase.from('users').select('anonymous_id').eq('telegram_id', telegram_id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { error } = await supabase.from('users').delete().eq('telegram_id', telegram_id);
    if (error) return res.status(500).json({ error: error.message });

    await logAudit(admin_id, 'delete_user', telegram_id, 'user', { anonymous_id: user.anonymous_id });
    res.json({ success: true });
  });

  // ==================== MENTOR APPLICATIONS ====================
  router.get('/applications', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;
    const status = req.query.status === 'all' ? null : (req.query.status || 'pending');

    let query = supabase
      .from('mentor_applications')
      .select('*, user:users(anonymous_id, sex, age_range, created_at)', { count: 'exact' });

    if (status) query = query.eq('status', status);

    const { data, count, error } = await query
      .order('submitted_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });

    res.json({ applications: data || [], total: count || 0, page, pages: Math.ceil((count || 0) / limit) });
  });

  router.patch('/applications/:id', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const { action, admin_note } = req.body;
    if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const { data: app, error: appErr } = await supabase
      .from('mentor_applications')
      .update({ status: action, admin_note, reviewed_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();

    if (appErr) return res.status(500).json({ error: appErr.message });

    if (action === 'approved') {
      // IMPORTANT: users.sex is the mentor's biological sex — never overwrite it.
      // The sex value from the application is the mentor's MENTEE PREFERENCE
      // (which mentees they want to serve). Store it in preferred_mentee_sex.
      const updateData = { role: 'mentor' };
      if (app.sex) {
        // 'M' → only male mentees  |  'F' → only female mentees  |  'prefer_not' → both
        updateData.preferred_mentee_sex = app.sex;
      }

      await supabase.from('users').update(updateData).eq('telegram_id', app.telegram_id);
      await supabase.from('mentors').upsert({ telegram_id: app.telegram_id }, { onConflict: 'telegram_id' });
      const { notifyMentorApproved } = require('../bot');
      await notifyMentorApproved(app.telegram_id);
    } else {
      const { notifyMentorRejected } = require('../bot');
      await notifyMentorRejected(app.telegram_id);
    }

    await logAudit(admin_id, `application_${action}`, app.telegram_id, 'mentor_application', { app_id: app.id });
    res.json({ success: true, application: app });
  });

  router.post('/applications/:id/contact', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

    const { data: app, error: appErr } = await supabase
      .from('mentor_applications')
      .select('telegram_id')
      .eq('id', req.params.id)
      .single();

    if (appErr || !app) return res.status(404).json({ error: 'Application not found' });

    const { data: settings } = await supabase
      .from('user_settings')
      .select('language')
      .eq('telegram_id', app.telegram_id)
      .single();
    const lang = settings?.language || 'en';
    const prefix = CONTACT_PREFIX[lang] || CONTACT_PREFIX.en;

    const { safeSend } = require('../bot');
    await safeSend(app.telegram_id, `${prefix}\n\n${message.trim()}`);

    await logAudit(admin_id, 'application_contact', app.telegram_id, 'mentor_application', {
      app_id: req.params.id,
      message: message.trim().substring(0, 300),
    });

    res.json({ success: true });
  });

  // ==================== MESSAGES ====================
  router.get('/messages', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    let query = supabase.from('messages').select('*', { count: 'exact' });
    if (req.query.flagged === 'true') query = query.eq('is_flagged', true);

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ messages: data || [], total: count || 0, page, pages: Math.ceil((count || 0) / limit) });
  });

  router.patch('/messages/:id/unflag', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const { id } = req.params;
    const { error } = await supabase
      .from('messages')
      .update({ is_flagged: false })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    await logAudit(admin_id, 'unflag_message', id, 'message');
    res.json({ success: true });
  });

  router.delete('/messages/:id', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const { id } = req.params;
    const { error } = await supabase
      .from('messages')
      .delete()
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    await logAudit(admin_id, 'delete_message', id, 'message');
    res.json({ success: true });
  });

  // ==================== CONVERSATIONS ====================
  router.get('/conversations', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;

    const { mentor_id, mentee_id, mentor_search, mentee_search } = req.query;

    let query = supabase
      .from('mentorship_assignments')
      .select('*, mentor:mentor_id(telegram_id, anonymous_id), mentee:user_id(telegram_id, anonymous_id)', { count: 'exact' });

    if (mentor_id) {
      query = query.eq('mentor_id', mentor_id);
    }
    if (mentee_id) {
      query = query.eq('user_id', mentee_id);
    }

    if (mentor_search) {
      const { data: mentors, error: mErr } = await supabase
        .from('users')
        .select('telegram_id')
        .ilike('anonymous_id', `%${mentor_search}%`);
      if (!mErr && mentors) {
        query = query.in('mentor_id', mentors.map(m => m.telegram_id));
      }
    }

    if (mentee_search) {
      const { data: mentees, error: meErr } = await supabase
        .from('users')
        .select('telegram_id')
        .ilike('anonymous_id', `%${mentee_search}%`);
      if (!meErr && mentees) {
        query = query.in('user_id', mentees.map(m => m.telegram_id));
      }
    }

    const { data: assignmentsRaw, count, error } = await query
      .order('assigned_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    // Dedupe: a mentor/mentee pair can have multiple assignment rows
    // (e.g. ended + re-matched), but they share the same message thread,
    // so only keep the most recent assignment per pair.
    const seen = new Set();
    const assignments = (assignmentsRaw || []).filter(a => {
      const key = `${a.mentor_id}_${a.user_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (!assignments || assignments.length === 0) {
      return res.json({ conversations: [], total: 0, page, pages: 0 });
    }

    // Fetch stats and last message details in parallel
    const conversations = await Promise.all(assignments.map(async (a) => {
      const { data: msgs } = await supabase
        .from('messages')
        .select('content, created_at, is_read, from_id, to_id')
        .or(`and(from_id.eq.${a.mentor_id},to_id.eq.${a.user_id}),and(from_id.eq.${a.user_id},to_id.eq.${a.mentor_id})`)
        .order('created_at', { ascending: false })
        .limit(1000);

      const last_msg = msgs && msgs[0];
      const total_msgs = msgs ? msgs.length : 0;
      const total_unread = msgs ? msgs.filter(m => !m.is_read).length : 0;

      return {
        mentor_id: a.mentor_id,
        mentor_anonymous_id: a.mentor?.anonymous_id || `Mentor_${a.mentor_id}`,
        mentee_id: a.user_id,
        mentee_anonymous_id: a.mentee?.anonymous_id || `Mentee_${a.user_id}`,
        last_message: last_msg ? last_msg.content : null,
        last_message_time: last_msg ? last_msg.created_at : null,
        message_count: total_msgs,
        unread_count: total_unread
      };
    }));

    // Sort by activity time descending (most recent first)
    conversations.sort((x, y) => {
      const timeX = x.last_message_time ? new Date(x.last_message_time).getTime() : 0;
      const timeY = y.last_message_time ? new Date(y.last_message_time).getTime() : 0;
      return timeY - timeX;
    });

    // Paginate in memory
    const paginatedConvs = conversations.slice(offset, offset + limit);

    res.json({
      conversations: paginatedConvs,
      total: count || conversations.length,
      page,
      pages: Math.ceil((count || conversations.length) / limit)
    });
  });

  router.get('/conversations/:mentor_id/:mentee_id/messages', async (req, res) => {
    const { mentor_id, mentee_id } = req.params;
    const limit = Math.min(100, parseInt(req.query.limit) || 100);
    const before = req.query.before;

    const { data: users } = await supabase
      .from('users')
      .select('telegram_id, anonymous_id')
      .in('telegram_id', [mentor_id, mentee_id]);

    const userMap = {};
    users?.forEach(u => {
      userMap[u.telegram_id] = u.anonymous_id;
    });

    let query = supabase
      .from('messages')
      .select('*')
      .or(`and(from_id.eq.${mentor_id},to_id.eq.${mentee_id}),and(from_id.eq.${mentee_id},to_id.eq.${mentor_id})`);

    if (before) {
      query = query.lt('created_at', before);
    }

    const { data: messages, error } = await query
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    if (error) return res.status(500).json({ error: error.message });

    const has_more = messages.length > limit;
    const sliced = messages.slice(0, limit);

    const responseMessages = sliced.map(m => ({
      id: m.id,
      from_id: m.from_id,
      to_id: m.to_id,
      from_anonymous_id: userMap[m.from_id] || `User_${m.from_id}`,
      to_anonymous_id: userMap[m.to_id] || `User_${m.to_id}`,
      content: m.content,
      created_at: m.created_at,
      is_read: m.is_read,
      is_flagged: m.is_flagged,
      edited_at: m.edited_at,
      is_deleted: m.is_deleted,
      file_id: m.file_id || null,
      file_type: m.file_type || null,
      file_name: m.file_name || null,
      file_size: m.file_size || null,
      mime_type: m.mime_type || null,
      duration: m.duration || null
    }));

    res.json({
      messages: responseMessages,
      has_more
    });
  });

  // GET /api/admin/messages/file/:file_id – stream a voice/photo/document
  // attachment for admin review. Mirrors the same proxy pattern used by
  // /api/messages/file/:file_id (routes/messages.js): the bot token never
  // leaves the server, we just resolve Telegram's file_path and pipe the
  // bytes through. Already admin-gated by the router.use(requireAuth,
  // requireAdmin) at the top of this file — no extra check needed here.
  router.get('/messages/file/:file_id', async (req, res) => {
    const { file_id } = req.params;
    const token = process.env.TELEGRAM_BOT_TOKEN;

    try {
      const { data } = await axios.get(`https://api.telegram.org/bot${token}/getFile`, {
        params: { file_id }
      });

      if (!data.ok || !data.result?.file_path) {
        return res.status(404).json({ error: 'File not found' });
      }

      const fileUrl = `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
      const fileRes = await axios.get(fileUrl, { responseType: 'stream' });

      if (fileRes.headers['content-type']) res.setHeader('Content-Type', fileRes.headers['content-type']);
      if (fileRes.headers['content-length']) res.setHeader('Content-Length', fileRes.headers['content-length']);
      res.setHeader('Cache-Control', 'private, max-age=86400');

      fileRes.data.pipe(res);
    } catch (err) {
      console.error('[GET /admin/messages/file/:file_id] Error:', err.message);
      res.status(500).json({ error: 'Failed to fetch file' });
    }
  });

  router.get('/search/users', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.json([]);
    const { data, error } = await supabase
      .from('users')
      .select('telegram_id, anonymous_id, role')
      .ilike('anonymous_id', `%${q}%`)
      .limit(10);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ==================== SUPPORT TICKETS ====================
  router.get('/tickets', async (req, res) => {
    const { status } = req.query;
    let query = supabase
      .from('support_tickets')
      .select('*, user:telegram_id(anonymous_id)');

    if (status) {
      query = query.eq('status', status);
    } else {
      query = query.in('status', ['open', 'in_progress', 'resolved', 'closed']);
    }

    const { data: tickets, error } = await query.order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    if (!tickets || tickets.length === 0) return res.json([]);

    // Fetch reply threads metadata for counts and preview
    const ticketIds = tickets.map(t => t.id);
    const { data: replies } = await supabase
      .from('ticket_replies')
      .select('*')
      .in('ticket_id', ticketIds)
      .order('created_at', { ascending: true });

    const replyMap = {};
    if (replies) {
      for (const r of replies) {
        if (!replyMap[r.ticket_id]) replyMap[r.ticket_id] = [];
        replyMap[r.ticket_id].push(r);
      }
    }

    const result = tickets.map(t => {
      const thread = replyMap[t.id] || [];
      const lastReply = thread.length > 0 ? thread[thread.length - 1] : null;
      return {
        ...t,
        reply_count: thread.length || t.reply_count || 0,
        last_reply_at: lastReply ? lastReply.created_at : (t.last_reply_at || t.created_at),
        last_reply_sender: lastReply ? lastReply.sender_type : (t.admin_reply ? 'admin' : null),
        last_reply_preview: lastReply ? lastReply.content : (t.admin_reply || null)
      };
    });

    res.json(result);
  });

  // GET /api/admin/tickets/:id/replies – get all replies for a ticket
  router.get('/tickets/:id/replies', async (req, res) => {
    const { data, error } = await supabase
      .from('ticket_replies')
      .select('*')
      .eq('ticket_id', req.params.id)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  router.patch('/tickets/:id', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const { admin_reply, reply, status } = req.body;
    const replyText = (reply || admin_reply || '').trim();

    // Fetch target ticket first
    const { data: ticket, error: fetchErr } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !ticket) return res.status(404).json({ error: 'Ticket not found' });

    const now = new Date().toISOString();
    const updatedStatus = status || ticket.status;
    const statusChanged = updatedStatus !== ticket.status;
    let newReplyCount = ticket.reply_count || 0;

    if (replyText) {
      // Save in ticket_replies
      const { error: replyErr } = await supabase
        .from('ticket_replies')
        .insert({
          ticket_id: req.params.id,
          sender_type: 'admin',
          sender_id: admin_id,
          content: replyText,
          created_at: now
        });
      if (replyErr) console.error('[admin] Failed to insert ticket_reply:', replyErr.message);

      newReplyCount += 1;
    }

    const { data, error } = await supabase
      .from('support_tickets')
      .update({
        admin_reply: replyText || ticket.admin_reply,
        status: updatedStatus,
        last_reply_at: (replyText || statusChanged) ? now : (ticket.last_reply_at || now),
        reply_count: newReplyCount,
        updated_at: now
      })
      .eq('id', req.params.id)
      .select('*, user:telegram_id(anonymous_id)')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await logAudit(admin_id, 'ticket_reply', null, 'support_ticket', { ticket_id: req.params.id, status: updatedStatus });

    // Notify the user on any reply OR status change — not just when text was typed
    if (replyText || statusChanged) {
      const STATUS_LABEL = { open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', closed: 'Closed' };
      const statusLabel = STATUS_LABEL[updatedStatus] || updatedStatus;

      // 1. Socket.IO notification to online user
      const onlineUsers = global.onlineUsers || req.app.get('onlineUsers');
      const targetSocketId = onlineUsers?.get(String(ticket.telegram_id));
      if (io && targetSocketId) {
        io.to(targetSocketId).emit('ticket_reply', {
          ticket_id: ticket.id,
          subject: ticket.subject,
          reply: replyText || null,
          status: updatedStatus,
          status_label: statusLabel,
          created_at: now
        });
      }

      // 2. Telegram Bot notification via safeSend — clean, professional copy
      try {
        const { safeSend } = require('../bot');
        let msgText = `📩 *Support Request Update*\n\n*Subject:* ${ticket.subject}\n*Status:* ${statusLabel}`;
        if (replyText) {
          const preview = replyText.length > 300 ? replyText.substring(0, 300) + '…' : replyText;
          msgText += `\n\n${preview}`;
        }
        msgText += updatedStatus === 'closed'
          ? `\n\nThis request has been closed. Open the app if you need to review the conversation.`
          : `\n\nOpen the app to view the full conversation or send a follow-up.`;
        await safeSend(ticket.telegram_id, msgText);
      } catch (botErr) {
        console.error('[admin] Failed to send Telegram notification for ticket update:', botErr.message);
      }
    }

    res.json(data);
  });

  // ==================== BROADCAST ====================
  router.post('/broadcast', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const { message, role_filter } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    let query = supabase.from('users').select('telegram_id, chat_id').eq('is_banned', false);
    if (role_filter) query = query.eq('role', role_filter);
    const { data: users } = await query;

    io.emit('broadcast', { message, from: 'admin' });
    const { broadcastToAll } = require('../bot');
    await broadcastToAll(message, role_filter);

    await logAudit(admin_id, 'broadcast', null, 'all', { message: message.substring(0, 100), role_filter });
    res.json({ sent_to: users?.length || 0 });
  });

  // ==================== AUDIT LOGS ====================
  router.get('/audit-logs', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    let query = supabase.from('audit_logs').select('*', { count: 'exact' });
    if (req.query.action) query = query.eq('action', req.query.action);

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ logs: data || [], total: count || 0, page, pages: Math.ceil((count || 0) / limit) });
  });

  // ==================== EXPORT CSV ====================
  router.get('/export/:table', async (req, res) => {
    const allowed = ['users', 'messages', 'video_sessions', 'mentor_applications', 'support_tickets'];
    if (!allowed.includes(req.params.table)) return res.status(400).json({ error: 'Table not exportable' });

    const { data, error } = await supabase.from(req.params.table).select('*').limit(10000);
    if (error) return res.status(500).json({ error: error.message });
    if (!data?.length) return res.json([]);

    const headers = Object.keys(data[0]).join(',');
    const rows = data.map(row => Object.values(row).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const csv = `${headers}\n${rows}`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.table}-export.csv"`);
    res.send(csv);
  });

  // ==================== MENTORSHIP ====================
  router.get('/mentorship', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = 20;
      const offset = (page - 1) * limit;
      const search = req.query.search || '';

      let query = supabase
        .from('users')
        .select(`
          telegram_id,
          anonymous_id,
          user_settings(bio),
          mentorship_assignments!mentor_id(
            assigned_at,
            is_active,
            mentee:user_id(
              telegram_id,
              anonymous_id,
              last_active,
              session_participants(session_id)
            )
          )
        `, { count: 'exact' })
        .eq('role', 'mentor');

      if (search) {
        query = query.ilike('anonymous_id', `%${search}%`);
      }

      const { data: mentors, count, error } = await query
        .order('anonymous_id', { ascending: true })
        .range(offset, offset + limit - 1);

      if (error) return res.status(500).json({ error: error.message });

      const formattedMentors = (mentors || []).map(m => {
        const activeAssignments = (m.mentorship_assignments || []).filter(a => a.is_active && a.mentee);
        return {
          mentor_id: m.telegram_id,
          mentor_anonymous_id: m.anonymous_id,
          mentor_bio: m.user_settings?.bio || null,
          mentees: activeAssignments.map(a => ({
            mentee_id: a.mentee.telegram_id,
            mentee_anonymous_id: a.mentee.anonymous_id,
            assigned_at: a.assigned_at,
            last_active: a.mentee.last_active,
            session_count: a.mentee.session_participants ? a.mentee.session_participants.length : 0
          }))
        };
      });

      res.json({
        mentors: formattedMentors,
        total: count || 0,
        page,
        pages: Math.ceil((count || 0) / limit)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== DISQUALIFY MENTOR ====================
  router.patch('/mentors/:id/disqualify', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const telegram_id = parseInt(req.params.id);

    await supabase.from('users').update({ role: 'user' }).eq('telegram_id', telegram_id);
    await supabase.from('mentors').update({ is_active: false }).eq('telegram_id', telegram_id);
    await supabase.from('mentorship_assignments')
      .update({ is_active: false, ended_at: new Date().toISOString() })
      .eq('mentor_id', telegram_id)
      .eq('is_active', true);

    await logAudit(admin_id, 'disqualify_mentor', telegram_id, 'mentor');
    res.json({ success: true });
  });

  // ==================== MENTORSHIP REQUEST LOG ====================
  router.get('/mentorship-requests', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.max(1, parseInt(req.query.limit) || 20);
      const offset = (page - 1) * limit;
      const status = (req.query.status && req.query.status !== 'all') ? req.query.status : null;

      let query = supabase
        .from('mentorship_requests')
        .select(`
          id,
          status,
          message,
          created_at,
          updated_at,
          mentor:mentor_id(telegram_id, anonymous_id, user_settings(display_name)),
          mentee:user_id(telegram_id, anonymous_id, user_settings(display_name)),
          topic:topic_id(name)
        `, { count: 'exact' });

      if (status) query = query.eq('status', status);

      const [
        { data, count, error },
        pendingCount,
        acceptedCount,
        rejectedCount,
        cancelledCount,
      ] = await Promise.all([
        query.order('created_at', { ascending: false }).range(offset, offset + limit - 1),
        supabase.from('mentorship_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('mentorship_requests').select('id', { count: 'exact', head: true }).eq('status', 'accepted'),
        supabase.from('mentorship_requests').select('id', { count: 'exact', head: true }).eq('status', 'rejected'),
        supabase.from('mentorship_requests').select('id', { count: 'exact', head: true }).eq('status', 'cancelled'),
      ]);

      if (error) return res.status(500).json({ error: error.message });

      res.json({
        requests: data || [],
        total: count || 0,
        page,
        pages: Math.ceil((count || 0) / limit),
        stats: {
          pending: pendingCount.count || 0,
          accepted: acceptedCount.count || 0,
          rejected: rejectedCount.count || 0,
          cancelled: cancelledCount.count || 0,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};