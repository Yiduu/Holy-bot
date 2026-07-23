'use strict';

const express = require('express');
const axios = require('axios');

const PROFANITY_LIST = ['fuck', 'shit', 'ass', 'bitch', 'damn', 'crap', 'bastard', 'hell', 'piss'];

function containsProfanity(text) {
  const lower = text.toLowerCase();
  return PROFANITY_LIST.some(word => lower.includes(word));
}

module.exports = function messageRoutes(supabase, requireAuth, io, onlineUsers) {
  const router = express.Router();

  // GET /api/messages/unread/count
  // NOTE: This route must be defined BEFORE /:with to avoid "unread" being
  // captured as a :with param.
  //
  // Only count unread messages from currently ACTIVE mentorship partners.
  // The user may appear as a mentee (user_id column) or as a mentor
  // (mentor_id column), so we look at both sides of every active assignment.
  router.get('/unread/count', requireAuth, async (req, res) => {
    const { id } = req.telegramUser;

    // Fetch all active assignments where this user is involved (either role).
    const { data: assignments } = await supabase
      .from('mentorship_assignments')
      .select('user_id, mentor_id')
      .eq('is_active', true)
      .or(`user_id.eq.${id},mentor_id.eq.${id}`);

    if (!assignments || assignments.length === 0) {
      return res.json({ count: 0 });
    }

    // Build the list of partner IDs (the other person in each assignment).
    const partnerIds = assignments.map(a =>
      a.user_id === id ? a.mentor_id : a.user_id
    );

    // Count unread messages sent TO this user FROM one of the active partners.
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('to_id', id)
      .eq('is_read', false)
      .in('from_id', partnerIds);

    res.json({ count: count || 0 });
  });

  // GET /api/messages/file/:file_id – stream a voice/file attachment
  // NOTE: This route must be defined BEFORE /:with for the same reason as
  // /unread/count above — but since it has two path segments ("file" + the
  // id) it can never actually collide with the single-segment /:with route.
  // It's placed here anyway to keep all the "must come first" routes together.
  //
  // The mini app can't call Telegram's file API directly because that would
  // require exposing our bot token to the client (Telegram's file URLs are
  // literally https://api.telegram.org/file/bot<TOKEN>/<path>). Instead we
  // resolve the file_path server-side and stream the bytes back through our
  // own authenticated endpoint, so the token never leaves the server.
  router.get('/file/:file_id', requireAuth, async (req, res) => {
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
      // Attachments are static once uploaded to Telegram, so it's safe to let
      // the mini app cache them for a while.
      res.setHeader('Cache-Control', 'private, max-age=86400');

      fileRes.data.pipe(res);
    } catch (err) {
      console.error('[GET /messages/file/:file_id] Error:', err.message);
      res.status(500).json({ error: 'Failed to fetch file' });
    }
  });

  // GET /api/messages/:with – conversation with a user
  router.get('/:with', requireAuth, async (req, res) => {
    const { id: my_id } = req.telegramUser;
    const other_id = parseInt(req.params.with);

    // FIX: Use a single compound .or() so the query correctly finds a row
    // where (user_id=me AND mentor_id=other) OR (user_id=other AND mentor_id=me).
    // The original two chained .or() calls were AND-ed together, which could
    // never match a single assignment row.
    const { data: assign } = await supabase
      .from('mentorship_assignments')
      .select('id')
      .or(`and(user_id.eq.${my_id},mentor_id.eq.${other_id}),and(user_id.eq.${other_id},mentor_id.eq.${my_id})`)
      .eq('is_active', true)
      .single();

    if (!assign) return res.status(403).json({ error: 'No active mentorship with this user' });

    // select('*') already returns file_id, file_type, file_size, mime_type,
    // duration and file_name once those columns exist on the table (see the
    // migration script), so no changes are needed here for the mini app to
    // receive attachment metadata alongside regular text messages.
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .or(`and(from_id.eq.${my_id},to_id.eq.${other_id}),and(from_id.eq.${other_id},to_id.eq.${my_id})`)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ error: error.message });

    const ordered = (data || []).slice().reverse();

    // Mark as read and update read_at
    try {
      await supabase
        .from('messages')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('to_id', my_id)
        .eq('from_id', other_id)
        .is('read_at', null);
    } catch (e) {
      console.error('Error marking messages as read:', e);
    }

    res.json(ordered);
  });

  // POST /api/messages – send message
  router.post('/', requireAuth, async (req, res) => {
    const { id: from_id } = req.telegramUser;
    const { to_id, content, parent_id } = req.body;

    if (!to_id || !content?.trim()) return res.status(400).json({ error: 'to_id and content required' });
    if (content.length > 2000) return res.status(400).json({ error: 'Message too long' });

    // FIX: Same compound .or() fix applied here for consistency and correctness.
    const { data: assign } = await supabase
      .from('mentorship_assignments')
      .select('id')
      .or(`and(user_id.eq.${from_id},mentor_id.eq.${to_id}),and(user_id.eq.${to_id},mentor_id.eq.${from_id})`)
      .eq('is_active', true)
      .single();

    if (!assign) return res.status(403).json({ error: 'No active mentorship with this user' });

    const is_flagged = containsProfanity(content);

    const { data: msg, error } = await supabase
      .from('messages')
      .insert({ from_id, to_id, content: content.trim(), is_flagged, parent_id: parent_id || null })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Real-time push to recipient
    const recipientSocket = onlineUsers.get(String(to_id));
    if (recipientSocket) {
      io.to(recipientSocket).emit('new_message', msg);
    }

    // Also push to sender's other devices/tabs
    const senderSocket = onlineUsers.get(String(from_id));
    if (senderSocket && senderSocket !== recipientSocket) {
      io.to(senderSocket).emit('message_sent', msg);
    }

    const { data: sender } = await supabase.from('users').select('anonymous_id').eq('telegram_id', from_id).single();
    if (sender && !onlineUsers.has(String(to_id))) {
      const { notifyMessage } = require('../bot');
      // Pass the actual message content (clean, no prefix) and the sender's id
      await notifyMessage(to_id, sender.anonymous_id, content, from_id);
    }

    res.status(201).json(msg);
  });

  // PATCH /api/messages/:id – edit a message
  router.patch('/:id', requireAuth, async (req, res) => {
    const { id: user_id } = req.telegramUser;
    const { content } = req.body;
    const messageId = req.params.id;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Content cannot be empty' });
    }
    if (content.length > 2000) {
      return res.status(400).json({ error: 'Message too long' });
    }

    const { data: msg, error: fetchErr } = await supabase
      .from('messages')
      .select('from_id, to_id, created_at, is_deleted')
      .eq('id', messageId)
      .single();

    if (fetchErr) return res.status(404).json({ error: 'Message not found' });
    if (msg.from_id !== user_id) return res.status(403).json({ error: 'Not your message' });
    if (msg.is_deleted) return res.status(400).json({ error: 'Cannot edit deleted message' });

    const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
    if (Date.now() - new Date(msg.created_at).getTime() > TWO_DAYS) {
      return res.status(403).json({ error: 'Edit time limit exceeded (2 days)' });
    }

    const { data, error } = await supabase
      .from('messages')
      .update({ content: content.trim(), edited_at: new Date().toISOString() })
      .eq('id', messageId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const recipientSocket = onlineUsers.get(String(msg.to_id));
    if (recipientSocket) io.to(recipientSocket).emit('message_edited', data);
    const senderSocket = onlineUsers.get(String(user_id));
    if (senderSocket && senderSocket !== recipientSocket) io.to(senderSocket).emit('message_edited', data);

    res.json(data);
  });

  // DELETE /api/messages/:id – soft delete / clear conversation
  router.delete('/:id', requireAuth, async (req, res) => {
    const { id: user_id } = req.telegramUser;
    const messageId = req.params.id;

    // Check if messageId is a UUID
    const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(messageId);

    if (!isUuid) {
      // It's a conversation clear request!
      const partner_id = parseInt(messageId);
      if (isNaN(partner_id)) {
        return res.status(400).json({ error: 'Invalid partner ID' });
      }

      // Soft delete all messages between user_id and partner_id
      const { error } = await supabase
        .from('messages')
        .update({ is_deleted: true })
        .or(`and(from_id.eq.${user_id},to_id.eq.${partner_id}),and(from_id.eq.${partner_id},to_id.eq.${user_id})`);

      if (error) return res.status(500).json({ error: error.message });

      // Notify the partner via socket if online
      const recipientSocket = onlineUsers.get(String(partner_id));
      if (recipientSocket) {
        io.to(recipientSocket).emit('chat_cleared', { by_id: user_id });
      }

      return res.json({ success: true, message: 'Conversation cleared' });
    }

    const { data: msg, error: fetchErr } = await supabase
      .from('messages')
      .select('from_id, to_id, is_deleted')
      .eq('id', messageId)
      .single();

    if (fetchErr) return res.status(404).json({ error: 'Message not found' });
    if (msg.from_id !== user_id) return res.status(403).json({ error: 'Not your message' });
    if (msg.is_deleted) return res.status(400).json({ error: 'Already deleted' });

    const { error } = await supabase
      .from('messages')
      .update({ is_deleted: true, edited_at: null })
      .eq('id', messageId);

    if (error) return res.status(500).json({ error: error.message });

    const placeholder = { id: messageId, is_deleted: true };
    const recipientSocket = onlineUsers.get(String(msg.to_id));
    if (recipientSocket) io.to(recipientSocket).emit('message_deleted', placeholder);
    const senderSocket = onlineUsers.get(String(user_id));
    if (senderSocket && senderSocket !== recipientSocket) io.to(senderSocket).emit('message_deleted', placeholder);

    res.json({ success: true });
  });

  return router;
};