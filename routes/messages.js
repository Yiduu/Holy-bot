'use strict';

const express = require('express');
const axios = require('axios');

const PROFANITY_LIST = ['fuck', 'shit', 'ass', 'bitch', 'damn', 'crap', 'bastard', 'hell', 'piss'];

function containsProfanity(text) {
  const lower = text.toLowerCase();
  return PROFANITY_LIST.some(word => lower.includes(word));
}

// Tiny in-memory TTL cache. Render's free tier runs a single instance, so a
// process-local cache is safe here and saves Supabase round-trips.
function makeTtlCache(ttlMs, max = 2000) {
  const m = new Map();
  return {
    get(k) {
      const e = m.get(k);
      if (!e) return undefined;
      if (e.exp < Date.now()) { m.delete(k); return undefined; }
      return e.v;
    },
    set(k, v) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, { v, exp: Date.now() + ttlMs });
    },
    delete(k) { m.delete(k); },
  };
}

// Express 4 does not catch rejected promises from async handlers: an
// exception left the request hanging forever (client spinner, input locked).
// This forwards them to the global error handler so the client gets a 500.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const assignmentCache = makeTtlCache(15 * 1000);          // authorised pairs
const senderNameCache = makeTtlCache(10 * 60 * 1000);     // telegram_id → anonymous_id
const filePathCache = makeTtlCache(30 * 60 * 1000, 500);  // file_id → telegram file_path
const sendDedupe = makeTtlCache(2 * 60 * 1000, 5000);     // from:client_id → insert promise

module.exports = function messageRoutes(supabase, requireAuth, io, onlineUsers) {
  const router = express.Router();

  const userRoom = (id) => `user:${id}`;

  // Is there an active mentorship between these two users (either direction)?
  // Positive answers are cached for 15 s: this check ran on EVERY send and
  // EVERY history load. Trade-off: after a mentorship ends, messaging can
  // still pass this check for up to 15 s.
  async function hasActiveMentorship(a, b) {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (assignmentCache.get(key)) return true;
    const { data, error } = await supabase
      .from('mentorship_assignments')
      .select('id')
      .or(`and(user_id.eq.${a},mentor_id.eq.${b}),and(user_id.eq.${b},mentor_id.eq.${a})`)
      .eq('is_active', true)
      .limit(1);
    if (error) throw error;
    const ok = !!(data && data.length);
    if (ok) assignmentCache.set(key, true);
    return ok;
  }

  async function getSenderName(id) {
    const cached = senderNameCache.get(id);
    if (cached) return cached;
    const { data } = await supabase.from('users').select('anonymous_id').eq('telegram_id', id).limit(1);
    const name = data?.[0]?.anonymous_id || null;
    if (name) senderNameCache.set(id, name);
    return name;
  }

  // Telegram notification for a recipient who isn't connected. Fire-and-forget:
  // this used to be awaited INSIDE the send request, so every message to an
  // offline user waited on 2 DB queries + a Telegram API call (often 1-3 s,
  // more when Telegram rate-limits) before the sender saw it as sent.
  function notifyOffline(toId, fromId, content) {
    (async () => {
      const name = await getSenderName(fromId);
      if (!name) return;
      const { notifyMessage } = require('../bot');
      await notifyMessage(toId, name, content, fromId);
    })().catch((err) => console.error('[messages] offline notification failed:', err.message));
  }

  // Push to the recipient's devices and require an ack from the client. If
  // nobody is connected — or a zombie connection never acks within 4 s — fall
  // back to the Telegram notification so the message can't silently vanish.
  function deliverToRecipient(toId, payload, onUndelivered) {
    const room = userRoom(toId);
    const sockets = io.sockets.adapter.rooms.get(room);
    if (!sockets || sockets.size === 0) return onUndelivered();
    io.to(room).timeout(4000).emit('new_message', payload, (err) => {
      if (err) onUndelivered();
    });
  }

  // GET /api/messages/unread/count
  // NOTE: This route must be defined BEFORE /:with to avoid "unread" being
  // captured as a :with param.
  //
  // Only count unread messages from currently ACTIVE mentorship partners.
  // The user may appear as a mentee (user_id column) or as a mentor
  // (mentor_id column), so we look at both sides of every active assignment.
  router.get('/unread/count', requireAuth, wrap(async (req, res) => {
    const { id } = req.telegramUser;

    // Fetch all active assignments where this user is involved (either role).
    const { data: assignments, error: aErr } = await supabase
      .from('mentorship_assignments')
      .select('user_id, mentor_id')
      .eq('is_active', true)
      .or(`user_id.eq.${id},mentor_id.eq.${id}`);
    if (aErr) throw aErr;

    if (!assignments || assignments.length === 0) {
      return res.json({ count: 0 });
    }

    // Build the list of partner IDs (the other person in each assignment).
    const partnerIds = assignments.map(a =>
      a.user_id === id ? a.mentor_id : a.user_id
    );

    // Count unread messages sent TO this user FROM one of the active partners.
    const { count, error: cErr } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('to_id', id)
      .eq('is_read', false)
      .in('from_id', partnerIds);
    if (cErr) throw cErr;

    res.json({ count: count || 0 });
  }));

  // GET /api/messages/file/:file_id – stream a voice/file attachment
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
      // file_path is stable for ~1 h, so cache it instead of a getFile call
      // per request (chats with photos re-requested these constantly).
      let filePath = filePathCache.get(file_id);
      if (!filePath) {
        const { data } = await axios.get(`https://api.telegram.org/bot${token}/getFile`, {
          params: { file_id },
          timeout: 10000,
        });
        if (!data.ok || !data.result?.file_path) {
          return res.status(404).json({ error: 'File not found' });
        }
        filePath = data.result.file_path;
        filePathCache.set(file_id, filePath);
      }

      const fileRes = await axios.get(`https://api.telegram.org/file/bot${token}/${filePath}`, {
        responseType: 'stream',
        timeout: 20000,
      });

      if (fileRes.headers['content-type']) res.setHeader('Content-Type', fileRes.headers['content-type']);
      if (fileRes.headers['content-length']) res.setHeader('Content-Length', fileRes.headers['content-length']);
      // Attachments are static once uploaded to Telegram, so it's safe to let
      // the mini app cache them for a while.
      res.setHeader('Cache-Control', 'private, max-age=86400');

      fileRes.data.on('error', () => res.destroy());
      res.on('close', () => fileRes.data.destroy()); // client went away → stop streaming
      fileRes.data.pipe(res);
    } catch (err) {
      console.error('[GET /messages/file/:file_id] Error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch file' });
    }
  });

  // POST /api/messages/read/:with – mark everything from :with as read.
  // Lightweight replacement for the client re-downloading the whole
  // conversation (GET /:with) on every incoming message just to trigger the
  // mark-as-read side effect.
  router.post('/read/:with', requireAuth, wrap(async (req, res) => {
    const { id: my_id } = req.telegramUser;
    const other_id = parseInt(req.params.with, 10);
    if (!Number.isSafeInteger(other_id)) return res.status(400).json({ error: 'Invalid partner ID' });

    const { error } = await supabase
      .from('messages')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('to_id', my_id)
      .eq('from_id', other_id)
      .is('read_at', null);
    if (error) throw error;

    res.json({ success: true });
  }));

  // GET /api/messages/:with – conversation with a user
  router.get('/:with', requireAuth, wrap(async (req, res) => {
    const { id: my_id } = req.telegramUser;
    const other_id = parseInt(req.params.with, 10);
    if (!Number.isSafeInteger(other_id)) return res.status(400).json({ error: 'Invalid partner ID' });

    // Authorisation check and history fetch are independent, so run them
    // together (they were sequential: two round-trips to Supabase in a row).
    //
    // select('*') already returns file_id, file_type, file_size, mime_type,
    // duration and file_name once those columns exist on the table, so the
    // mini app gets attachment metadata alongside regular text messages.
    // Soft-deleted rows are filtered here so the "last 100" window stays
    // meaningful. `is_deleted` predates its own tracked migration, so older
    // rows may have it NULL rather than false — match both.
    const [allowed, historyRes] = await Promise.all([
      hasActiveMentorship(my_id, other_id),
      supabase
        .from('messages')
        .select('*')
        .or(`and(from_id.eq.${my_id},to_id.eq.${other_id}),and(from_id.eq.${other_id},to_id.eq.${my_id})`)
        .or('is_deleted.eq.false,is_deleted.is.null')
        .order('created_at', { ascending: false })
        .limit(100),
    ]);

    if (!allowed) return res.status(403).json({ error: 'No active mentorship with this user' });
    if (historyRes.error) throw historyRes.error;

    const data = historyRes.data || [];
    const ordered = data.slice().reverse();

    // Only write when there is actually something to mark. Most loads (tab
    // switches, reconnects) have nothing unread, so this skips a DB write.
    const hasUnread = data.length >= 100 || data.some(m => Number(m.to_id) === my_id && !m.read_at);
    if (hasUnread) {
      const { error: readErr } = await supabase
        .from('messages')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('to_id', my_id)
        .eq('from_id', other_id)
        .is('read_at', null);
      if (readErr) console.error('Error marking messages as read:', readErr.message);
    }

    res.json(ordered);
  }));

  // POST /api/messages – send message
  router.post('/', requireAuth, wrap(async (req, res) => {
    const { id: from_id } = req.telegramUser;
    const { content, parent_id, client_id } = req.body;
    const to_id = Number(req.body.to_id);

    if (!Number.isSafeInteger(to_id) || !content?.trim()) {
      return res.status(400).json({ error: 'to_id and content required' });
    }
    if (content.length > 2000) return res.status(400).json({ error: 'Message too long' });

    // client_id makes retries idempotent. The client retries failed sends;
    // without this, a request that actually succeeded (but whose response was
    // lost, or that errored after the insert) was inserted AGAIN on retry —
    // duplicate messages. Same (sender, client_id) within 2 min → same message.
    const safeClientId = typeof client_id === 'string' && /^[\w-]{1,64}$/.test(client_id) ? client_id : null;
    const dedupeKey = safeClientId ? `${from_id}:${safeClientId}` : null;
    const withClientId = (m) => (safeClientId ? { ...m, client_id: safeClientId } : m);

    if (dedupeKey) {
      const prior = sendDedupe.get(dedupeKey);
      if (prior) return res.status(201).json(withClientId(await prior));
    }

    if (!(await hasActiveMentorship(from_id, to_id))) {
      return res.status(403).json({ error: 'No active mentorship with this user' });
    }

    const is_flagged = containsProfanity(content);
    const trimmed = content.trim();

    const insertPromise = (async () => {
      const { data: row, error } = await supabase
        .from('messages')
        .insert({ from_id, to_id, content: trimmed, is_flagged, parent_id: parent_id || null })
        .select()
        .single();
      if (error) throw error;
      return row;
    })();
    if (dedupeKey) sendDedupe.set(dedupeKey, insertPromise);

    let msg;
    try {
      msg = await insertPromise;
    } catch (err) {
      if (dedupeKey) sendDedupe.delete(dedupeKey); // let a retry try again
      throw err;
    }

    const payload = withClientId(msg);

    // Real-time push to every device the recipient has open (with fallback).
    deliverToRecipient(to_id, payload, () => notifyOffline(to_id, from_id, trimmed));

    // Also push to the sender's OTHER devices/tabs. The originating socket is
    // excluded (x-socket-id) — before, it received its own message back over
    // the socket while the HTTP response was still in flight, so the bubble
    // appeared twice for a moment and then one vanished: the visible "blink".
    const originSocket = req.get('x-socket-id');
    io.to(userRoom(from_id)).except(originSocket || []).emit('message_sent', payload);

    // Respond immediately — nothing above waits on Telegram.
    res.status(201).json(payload);
  }));

  // PATCH /api/messages/:id – edit a message
  router.patch('/:id', requireAuth, wrap(async (req, res) => {
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

    io.to([userRoom(msg.to_id), userRoom(user_id)]).emit('message_edited', data);

    res.json(data);
  }));

  // DELETE /api/messages/:id – soft delete / clear conversation
  router.delete('/:id', requireAuth, wrap(async (req, res) => {
    const { id: user_id } = req.telegramUser;
    const messageId = req.params.id;

    // Check if messageId is a UUID
    const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(messageId);

    if (!isUuid) {
      // It's a conversation clear request!
      const partner_id = parseInt(messageId, 10);
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
      io.to(userRoom(partner_id)).emit('chat_cleared', { by_id: user_id });

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

    io.to([userRoom(msg.to_id), userRoom(user_id)]).emit('message_deleted', { id: messageId, is_deleted: true });

    res.json({ success: true });
  }));

  return router;
};
