'use strict';

const express = require('express');

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

  // ==================== SUPPORT TICKETS ====================
  router.get('/tickets', async (req, res) => {
    const { data, error } = await supabase
      .from('support_tickets')
      .select('*, user:telegram_id(anonymous_id)')
      .in('status', ['open', 'in_progress'])
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  router.patch('/tickets/:id', async (req, res) => {
    const admin_id = req.telegramUser.id;
    const { admin_reply, status } = req.body;
    const { data, error } = await supabase
      .from('support_tickets')
      .update({ admin_reply, status: status || 'resolved', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    await logAudit(admin_id, 'ticket_reply', null, 'support_ticket', { ticket_id: req.params.id });
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

  return router;
};