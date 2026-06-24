'use strict';

const express = require('express');

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
  router.get('/unread/count', requireAuth, async (req, res) => {
    const { id } = req.telegramUser;
    const { count } = await supabase.from('messages').select('id', { count: 'exact', head: true }).eq('to_id', id).eq('is_read', false);
    res.json({ count: count || 0 });
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

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .or(`and(from_id.eq.${my_id},to_id.eq.${other_id}),and(from_id.eq.${other_id},to_id.eq.${my_id})`)
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) return res.status(500).json({ error: error.message });

    // Mark as read
    await supabase.from('messages').update({ is_read: true }).eq('to_id', my_id).eq('from_id', other_id).eq('is_read', false);

    res.json(data || []);
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

    const { data: sender } = await supabase.from('users').select('anonymous_id').eq('telegram_id', from_id).single();
    if (sender && !onlineUsers.has(String(to_id))) {
      const { notifyMessage } = require('../bot');
      // Pass the actual message content (clean, no prefix)
      await notifyMessage(to_id, sender.anonymous_id, content);
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

  // DELETE /api/messages/:id – soft delete
  router.delete('/:id', requireAuth, async (req, res) => {
    const { id: user_id } = req.telegramUser;
    const messageId = req.params.id;

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