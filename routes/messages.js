'use strict';

const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { normalizeVoice } = require('../utils/voice');

// ─── Attachment uploads ───────────────────────────────────────────────────────
// Telegram lets a bot UPLOAD up to 50 MB but only DOWNLOAD (getFile) up to
// 20 MB, and GET /file/:file_id below is a getFile download. A bigger upload
// would send fine and then never be playable, so 20 MB is the real ceiling.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;   // Telegram's sendPhoto limit
const MAX_CAPTION = 1024;                   // Telegram's media caption limit
const MAX_MEDIA_SECONDS = 60 * 60;
// Windows executables / scripts / Android packages. Telegram itself allows
// them, but this app pairs vulnerable people with strangers, so they are
// refused. Edit freely.
const BLOCKED_FILE_EXT = /\.(exe|bat|cmd|com|scr|msi|vbs|ps1|pif|cpl|dll|apk|jar)$/i;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Uploads are spooled to disk, not held in RAM: a few people sending 20 MB
// files at once would otherwise exhaust a small (512 MB) Render instance.
const UPLOAD_DIR = path.join(os.tmpdir(), 'holy-uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* surfaced on first upload */ }

// Normally every temp file is deleted in a `finally`; this only catches the
// leftovers from a process that was killed mid-upload.
function sweepUploadDir() {
  fs.readdir(UPLOAD_DIR, (err, names) => {
    if (err) return;
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const n of names) {
      const p = path.join(UPLOAD_DIR, n);
      fs.stat(p, (e, st) => { if (!e && st.mtimeMs < cutoff) fs.unlink(p, () => { }); });
    }
  });
}
sweepUploadDir();
setInterval(sweepUploadDir, 30 * 60 * 1000).unref();

const receiveFile = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `up-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 12, fieldSize: 8 * 1024 },
}).single('file');

// The storage chat is the admin's own Telegram chat, the same one profile
// photos already go to (see routes/avatar.js).
function storageChatId() {
  return String(process.env.ADMIN_TELEGRAM_ID || '').split(',')[0].trim();
}

function cleanFileName(raw, fallback) {
  // multer decodes the multipart filename as latin1, which mangles Amharic
  // names, so the client also sends the name as a normal (UTF-8) form field.
  let n = String(raw || '').normalize('NFC').replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, '_').trim().replace(/^\.+/, '');
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n || fallback;
}

// What we call the upload, decided from the real mime type, not just the
// client's hint — e.g. a "photo" that isn't a JPEG/PNG/WebP is sent as a file.
function classifyUpload(hint, mime, size) {
  let kind = ['voice', 'photo', 'video', 'audio', 'document'].includes(hint) ? hint : 'document';
  if (kind === 'voice' && !(mime.startsWith('audio/') || mime === 'video/webm' || mime === 'video/mp4')) kind = 'document';
  if (kind === 'audio' && !mime.startsWith('audio/')) kind = 'document';
  if (kind === 'video' && !mime.startsWith('video/')) kind = 'document';
  if (kind === 'photo' && (!/^image\/(jpeg|png|webp)$/.test(mime) || size > MAX_PHOTO_BYTES)) kind = 'document';
  return kind;
}

// Try the richest Telegram method first and degrade (e.g. a WebM recording that
// sendVoice refuses becomes sendAudio, then a plain document). A stream can only
// be read once, so every attempt opens the temp file afresh.
async function pushToStorage(bot, chatId, kind, filePath, { fileName, mime, duration, caption }) {
  const fileOpts = { filename: fileName, contentType: mime || 'application/octet-stream' };
  // disable_notification: the admin's phone must not buzz for every upload.
  const base = { disable_notification: true, caption };
  const plans = {
    voice: [['sendVoice', { duration }], ['sendAudio', { duration }], ['sendDocument', {}]],
    audio: [['sendAudio', { duration }], ['sendDocument', {}]],
    video: [['sendVideo', { duration, supports_streaming: true }], ['sendDocument', {}]],
    photo: [['sendPhoto', {}], ['sendDocument', {}]],
    document: [['sendDocument', { disable_content_type_detection: true }]],
  };
  let lastErr;
  for (const [method, extra] of plans[kind]) {
    const stream = fs.createReadStream(filePath);
    // A rejected attempt may never consume its stream; if the temp file is then
    // deleted the stream emits 'error', and an unhandled 'error' event kills the
    // process. Swallow it and always close the stream.
    stream.on('error', () => { });
    try {
      return await bot[method](chatId, stream, { ...base, ...extra }, fileOpts);
    } catch (e) {
      lastErr = e;
    } finally {
      stream.destroy();
    }
  }
  throw lastErr;
}

// What Telegram actually stored (it may differ from what was asked for).
function describeSent(sent) {
  const pick = (o, type) => ({
    type, file_id: o.file_id, file_size: o.file_size || null,
    duration: o.duration || null, mime: o.mime_type || null,
  });
  if (sent.voice) return pick(sent.voice, 'voice');
  if (sent.audio) return pick(sent.audio, 'audio');
  if (sent.video) return pick(sent.video, 'video');
  if (sent.animation) return pick(sent.animation, 'video');   // before `document`: animations carry both
  if (sent.photo?.length) return pick(sent.photo[sent.photo.length - 1], 'photo');
  if (sent.document) return pick(sent.document, 'document');
  return null;
}

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

module.exports = function messageRoutes(supabase, requireAuth, io, onlineUsers, bot) {
  const router = express.Router();
  // Resolved lazily so requiring this file never drags the bot in by itself.
  const getBot = () => bot || require('../bot').bot;

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
  function notifyOffline(toId, fromId, content, messageId) {
    (async () => {
      const name = await getSenderName(fromId);
      if (!name) return;
      const { notifyMessage } = require('../bot');
      await notifyMessage(toId, name, content, fromId, messageId);
    })().catch((err) => console.error('[messages] offline notification failed:', err.message));
  }

  // Same idea for an attachment: the recipient's Telegram gets the file itself
  // (re-served from its file_id, so nothing is uploaded again) with an
  // "Open Chat" button.
  function notifyOfflineFile(toId, fromId, row, tgType) {
    (async () => {
      const name = await getSenderName(fromId);
      if (!name) return;
      const { notifyFileMessage } = require('../bot');
      await notifyFileMessage(toId, name, row.file_type, tgType, row.file_id, row.content, fromId, row.id);
    })().catch((err) => console.error('[messages] offline file notification failed:', err.message));
  }

  // Quoted-message previews for replies whose original isn't in the payload the
  // client already has (older than the last-100 window, or a reply arriving live
  // to an old message). Restricted to THIS conversation and to non-deleted rows,
  // so a forged parent_id can't leak a message from anywhere else. Best-effort:
  // any failure just means the client shows "unavailable", as before.
  async function fetchParentPreviews(parentIds, a, b) {
    const ids = [...new Set((parentIds || []).filter(Boolean).map(String))];
    if (!ids.length) return new Map();
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('id, from_id, to_id, content, file_type, created_at')
        .in('id', ids)
        .or(`and(from_id.eq.${a},to_id.eq.${b}),and(from_id.eq.${b},to_id.eq.${a})`)
        .or('is_deleted.eq.false,is_deleted.is.null');
      if (error) throw error;
      return new Map((data || []).map(m => [String(m.id), {
        id: m.id, from_id: m.from_id, content: m.content, file_type: m.file_type || null
      }]));
    } catch (e) {
      console.error('[messages] parent preview lookup failed:', e.message);
      return new Map();
    }
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
      // A message the sender unsent before it was read must not keep the
      // badge lit. `is_deleted` can be NULL on older rows, so accept both.
      .or('is_deleted.eq.false,is_deleted.is.null')
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
    // Soft-deleted rows are filtered here so the window stays
    // meaningful. `is_deleted` predates its own tracked migration, so older
    // rows may have it NULL rather than false — match both.
    let historyQuery = supabase
      .from('messages')
      .select('*')
      .or(`and(from_id.eq.${my_id},to_id.eq.${other_id}),and(from_id.eq.${other_id},to_id.eq.${my_id})`)
      .or('is_deleted.eq.false,is_deleted.is.null');

    if (req.query.before) {
      historyQuery = historyQuery.lt('created_at', req.query.before);
    }
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 100));
    historyQuery = historyQuery.order('created_at', { ascending: false }).limit(limit);

    const [allowed, historyRes] = await Promise.all([
      hasActiveMentorship(my_id, other_id),
      historyQuery,
    ]);

    if (!allowed) return res.status(403).json({ error: 'No active mentorship with this user' });
    if (historyRes.error) throw historyRes.error;

    const data = historyRes.data || [];
    const ordered = data.slice().reverse();

    // A reply can quote a message older than this 100-message window. The admin
    // panel loads everything, but here the client only has the window, so it
    // showed "Original message unavailable". Send the missing originals' previews.
    const inWindow = new Set(data.map(m => String(m.id)));
    const missingParents = ordered.filter(m => m.parent_id && !inWindow.has(String(m.parent_id))).map(m => m.parent_id);
    if (missingParents.length) {
      const previews = await fetchParentPreviews(missingParents, my_id, other_id);
      ordered.forEach(m => {
        const p = m.parent_id && previews.get(String(m.parent_id));
        if (p) m.parent_preview = p;
      });
    }

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

    // Started now so it overlaps the insert instead of adding to send latency.
    const parentPreviewPromise = parent_id
      ? fetchParentPreviews([parent_id], from_id, to_id)
      : Promise.resolve(new Map());

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
    const parentPreview = msg.parent_id ? (await parentPreviewPromise).get(String(msg.parent_id)) : null;
    if (parentPreview) payload.parent_preview = parentPreview;

    // Real-time push to every device the recipient has open (with fallback).
    deliverToRecipient(to_id, payload, () => notifyOffline(to_id, from_id, trimmed, msg.id));

    // Also push to the sender's OTHER devices/tabs. The originating socket is
    // excluded (x-socket-id) — before, it received its own message back over
    // the socket while the HTTP response was still in flight, so the bubble
    // appeared twice for a moment and then one vanished: the visible "blink".
    const originSocket = req.get('x-socket-id');
    io.to(userRoom(from_id)).except(originSocket || []).emit('message_sent', payload);

    // Respond immediately — nothing above waits on Telegram.
    res.status(201).json(payload);
  }));

  // POST /api/messages/upload?to_id=…&client_id=… – send a voice message,
  // photo, video or file (multipart: `file` plus the text fields read below).
  //
  // The bytes are pushed to the admin's Telegram chat only to obtain a
  // permanent file_id; just that id and the metadata are stored, and
  // GET /file/:file_id streams it back. `to_id` and `client_id` travel in the
  // query string so the mentorship check and the duplicate check can run
  // BEFORE the (up to 20 MB) body is accepted.
  async function uploadPrecheck(req, res, next) {
    const from_id = req.telegramUser.id;
    const to_id = Number(req.query.to_id);
    if (!Number.isSafeInteger(to_id)) return res.status(400).json({ error: 'to_id required' });

    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_UPLOAD_BYTES + 256 * 1024) {
      return res.status(413).json({ error: 'File too large (max 20 MB)', code: 'too_large' });
    }
    if (!storageChatId()) {
      console.error('[POST /messages/upload] ADMIN_TELEGRAM_ID is not configured');
      return res.status(503).json({ error: 'File storage is not configured' });
    }
    if (!(await hasActiveMentorship(from_id, to_id))) {
      return res.status(403).json({ error: 'No active mentorship with this user' });
    }

    // A retry of an upload that actually went through returns the stored
    // message instead of storing the file twice.
    const cid = typeof req.query.client_id === 'string' && /^[\w-]{1,64}$/.test(req.query.client_id) ? req.query.client_id : null;
    if (cid) {
      const prior = sendDedupe.get(`${from_id}:${cid}`);
      if (prior) return res.status(201).json({ ...(await prior), client_id: cid });
    }
    req.uploadTo = to_id;
    req.uploadClientId = cid;
    next();
  }

  function receiveUpload(req, res, next) {
    receiveFile(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large (max 20 MB)', code: 'too_large' });
      }
      console.error('[POST /messages/upload] receive failed:', err.message);
      res.status(400).json({ error: 'Upload failed' });
    });
  }

  router.post('/upload', requireAuth, wrap(uploadPrecheck), receiveUpload, wrap(async (req, res) => {
    const from_id = req.telegramUser.id;
    const to_id = req.uploadTo;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });

    const removeTemp = () => fs.unlink(file.path, () => { });
    try {
      const body = req.body || {};
      // The mime type is echoed to other users' browsers, so accept only a plain type/subtype.
      let mime = String(body.mime_type || file.mimetype || '').split(';')[0].trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/.test(mime)) mime = 'application/octet-stream';
      const fileName = cleanFileName(body.file_name || file.originalname, 'file');
      if (BLOCKED_FILE_EXT.test(fileName)) {
        return res.status(415).json({ error: 'This type of file cannot be sent', code: 'blocked_type' });
      }
      if (!file.size) return res.status(400).json({ error: 'The file is empty' });

      const caption = String(body.caption || '').trim().slice(0, MAX_CAPTION);
      const kind = classifyUpload(body.kind, mime, file.size);
      const clientDuration = Math.max(0, Math.min(MAX_MEDIA_SECONDS, Math.round(Number(body.duration) || 0)));
      const waveform = typeof body.waveform === 'string' && /^[0-9a-v]{8,128}$/.test(body.waveform) ? body.waveform : null;
      const parent_id = typeof body.parent_id === 'string' && UUID_RE.test(body.parent_id) ? body.parent_id : null;
      const is_flagged = caption ? containsProfanity(caption) : false;
      const safeClientId = req.uploadClientId;
      const withClientId = (m) => (safeClientId ? { ...m, client_id: safeClientId } : m);
      const dedupeKey = safeClientId ? `${from_id}:${safeClientId}` : null;

      const pipeline = (async () => {
        // Voice recordings are re-encoded to a loudness-normalised AAC .m4a so
        // they are audible and playable everywhere (see utils/voice.js). On any
        // failure the original recording is sent unchanged.
        let sendPath = file.path, sendName = fileName, sendMime = mime, converted = null;
        if (kind === 'voice') {
          converted = await normalizeVoice(file.path, {
            onError: (e) => console.error('[POST /messages/upload] voice transcode failed, sending original:', e.message),
          });
          if (converted) {
            sendPath = converted.path; sendMime = converted.mime;
            sendName = `${path.basename(fileName, path.extname(fileName)) || 'voice'}.${converted.ext}`;
          }
        }
        let sent;
        try {
          sent = await pushToStorage(getBot(), storageChatId(), kind, sendPath, {
            fileName: sendName, mime: sendMime, duration: clientDuration || undefined, caption: `chat-file ${from_id}>${to_id}`,
          });
        } finally {
          if (converted) fs.unlink(converted.path, () => { });
        }
        const tg = describeSent(sent);
        if (!tg?.file_id) throw new Error('Telegram did not return a file');

        // A voice recording that Telegram stored as audio/document is still a
        // voice message to us; anything else follows what Telegram made of it.
        const fileType = kind === 'voice' || kind === 'audio' ? kind : tg.type;
        const needsDuration = fileType === 'voice' || fileType === 'audio' || fileType === 'video';
        const row = {
          from_id, to_id, content: caption, is_flagged, parent_id,
          file_id: tg.file_id,
          file_type: fileType,
          file_size: tg.file_size || (converted ? converted.size : file.size),
          mime_type: sendMime,
          duration: needsDuration ? (clientDuration || tg.duration || null) : null,
          file_name: fileType === 'voice' || fileType === 'photo' ? null : sendName,
        };
        if (waveform && fileType === 'voice') row.waveform = waveform;

        let ins = await supabase.from('messages').insert(row).select().single();
        if (ins.error && row.waveform && /waveform/i.test(ins.error.message || '')) {
          delete row.waveform;           // column not migrated yet — send without it
          ins = await supabase.from('messages').insert(row).select().single();
        }
        if (ins.error) throw ins.error;
        return { msg: ins.data, tgType: tg.type };
      })();
      if (dedupeKey) {
        const shared = pipeline.then(r => r.msg);
        shared.catch(() => { });         // a failure is handled below; don't also report it as unhandled
        sendDedupe.set(dedupeKey, shared);
      }

      let result;
      try {
        result = await pipeline;
      } catch (err) {
        if (dedupeKey) sendDedupe.delete(dedupeKey);   // let a retry try again
        console.error('[POST /messages/upload] failed:', err.response?.body?.description || err.message);
        return res.status(502).json({ error: 'Could not send the file. Please try again.' });
      }

      const { msg, tgType } = result;
      const payload = withClientId(msg);
      if (msg.parent_id) {
        const preview = (await fetchParentPreviews([msg.parent_id], from_id, to_id)).get(String(msg.parent_id));
        if (preview) payload.parent_preview = preview;
      }

      deliverToRecipient(to_id, payload, () => notifyOfflineFile(to_id, from_id, msg, tgType));
      const originSocket = req.get('x-socket-id');
      io.to(userRoom(from_id)).except(originSocket || []).emit('message_sent', payload);

      res.status(201).json(payload);
    } finally {
      removeTemp();
    }
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

    // Also update the bot's Telegram copy, if one was sent. Fire-and-forget.
    getSenderName(user_id)
      .then(name => name && require('../bot').syncNotificationEdit(messageId, name, data.content, user_id))
      .catch(() => { });

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

      // Telegram notifications for this conversation, so they can be removed
      // too. (Table missing / query failing just means nothing is synced.)
      const { data: notifs } = await supabase
        .from('message_tg_notifications')
        .select('message_id')
        .or(`and(from_id.eq.${user_id},to_id.eq.${partner_id}),and(from_id.eq.${partner_id},to_id.eq.${user_id})`)
        .limit(500);

      // Soft delete all messages between user_id and partner_id
      const { error } = await supabase
        .from('messages')
        .update({ is_deleted: true })
        .or(`and(from_id.eq.${user_id},to_id.eq.${partner_id}),and(from_id.eq.${partner_id},to_id.eq.${user_id})`);

      if (error) return res.status(500).json({ error: error.message });

      // Notify the partner via socket if online
      io.to([userRoom(partner_id), userRoom(user_id)]).emit('chat_cleared', { by_id: user_id });

      if (notifs?.length) {
        require('../bot').syncNotificationDelete(notifs.map(n => n.message_id)).catch(() => { });
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

    io.to([userRoom(msg.to_id), userRoom(user_id)]).emit('message_deleted', {
      id: messageId,
      is_deleted: true,
      from_id: msg.from_id,
      to_id: msg.to_id,
    });

    // Also remove the bot's Telegram copy, if one was sent. Fire-and-forget.
    require('../bot').syncNotificationDelete([messageId]).catch(() => { });

    res.json({ success: true });
  }));

  return router;
};
