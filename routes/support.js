'use strict';

const express = require('express');

module.exports = function supportRoutes(supabase, requireAuth, io, onlineUsers) {
  const router = express.Router();

  // POST /api/support – create ticket
  router.post('/', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { subject, description, category } = req.body;
    if (!subject || !description) return res.status(400).json({ error: 'subject and description required' });

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('support_tickets')
      .insert({
        telegram_id,
        subject,
        description,
        category: category || null,
        status: 'open',
        reply_count: 0,
        last_reply_at: now,
        created_at: now,
        updated_at: now
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Notify admins via socket
    if (io) {
      io.emit('new_ticket', { id: data.id, subject: data.subject, telegram_id });
    }

    res.status(201).json(data);
  });

  // GET /api/support – user's own tickets
  router.get('/', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const { data: tickets, error } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('telegram_id', telegram_id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    if (!tickets || tickets.length === 0) {
      return res.json([]);
    }

    // Attach latest reply preview if replies exist in ticket_replies
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
        reply_count: t.reply_count || thread.length,
        last_reply_preview: lastReply ? lastReply.content : (t.admin_reply || null),
        last_reply_sender: lastReply ? lastReply.sender_type : (t.admin_reply ? 'admin' : null),
        last_reply_at: lastReply ? lastReply.created_at : (t.last_reply_at || t.created_at)
      };
    });

    res.json(result);
  });

  // GET /api/support/:id – single ticket with reply thread
  router.get('/:id', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const ticketId = req.params.id;

    const { data: ticket, error: ticketErr } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('id', ticketId)
      .single();

    if (ticketErr || !ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (String(ticket.telegram_id) !== String(telegram_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { data: replies, error: repliesErr } = await supabase
      .from('ticket_replies')
      .select('*')
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: true });

    if (repliesErr) return res.status(500).json({ error: repliesErr.message });

    res.json({
      ticket,
      replies: replies || []
    });
  });

  // POST /api/support/:id/reply – add user reply
  router.post('/:id/reply', requireAuth, async (req, res) => {
    const { id: telegram_id } = req.telegramUser;
    const ticketId = req.params.id;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Reply content required' });
    }

    const { data: ticket, error: ticketErr } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('id', ticketId)
      .single();

    if (ticketErr || !ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (String(ticket.telegram_id) !== String(telegram_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (ticket.status === 'closed') {
      return res.status(400).json({ error: 'Cannot reply to a closed ticket' });
    }

    const now = new Date().toISOString();

    // Insert into ticket_replies
    const { data: reply, error: replyErr } = await supabase
      .from('ticket_replies')
      .insert({
        ticket_id: ticketId,
        sender_type: 'user',
        sender_id: telegram_id,
        content: content.trim(),
        created_at: now
      })
      .select()
      .single();

    if (replyErr) return res.status(500).json({ error: replyErr.message });

    // Update support_tickets table
    const newReplyCount = (ticket.reply_count || 0) + 1;
    const newStatus = ticket.status === 'resolved' ? 'open' : ticket.status;

    await supabase
      .from('support_tickets')
      .update({
        last_reply_at: now,
        reply_count: newReplyCount,
        status: newStatus,
        updated_at: now
      })
      .eq('id', ticketId);

    // Notify admins real-time
    if (io) {
      io.emit('new_ticket_reply', {
        ticket_id: ticketId,
        sender_type: 'user',
        sender_id: telegram_id,
        content: content.trim(),
        created_at: now
      });
    }

    res.status(201).json(reply);
  });

  return router;
};
