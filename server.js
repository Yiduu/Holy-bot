'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// FIX: Added rate limiting. Run: npm install express-rate-limit
// This protects all API endpoints — especially /broadcast and /messages —
// from abuse. Limits each IP to 100 requests per 15-minute window by default,
// with a tighter 20 req/min limit on auth endpoints.
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Ensure local uploads directory exists
const uploadsDir = path.join(__dirname, 'frontend', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const { createClient } = require('@supabase/supabase-js');
const { bot, notifyMessage, notifySessionInvite, notifyMentorApproved, broadcastToAll } = require('./bot');

// ─── Supabase Client ──────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // Trust Render's proxy
const server = http.createServer(app);

app.use((req, res, next) => {
  console.log(`[Server] ${req.method} ${req.url}`);
  next();
});

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static('frontend'));

// ─── Rate Limiters ────────────────────────────────────────────────────────────

// General API limiter: 500 requests per 15 minutes per IP (increased to prevent blocking users on CGNAT or active sessions)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Strict limiter for auth/registration: 20 requests per minute per IP
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please slow down.' },
});

// Very strict limiter for broadcast: 5 requests per minute per IP
const broadcastLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Broadcast rate limit exceeded.' },
});

// Apply general limiter to all /api routes
app.use('/api', generalLimiter);
// Tighter limits on specific sensitive routes
app.use('/api/auth/register', authLimiter);
app.use('/api/admin/broadcast', broadcastLimiter);

// ─── Socket.IO (presence + typing) ────────────────────────────────────────────
const io = new Server(server, { cors: { origin: '*' } });
const onlineUsers = new Map(); // telegram_id → socket_id
global.io = io;
global.onlineUsers = onlineUsers;

io.on('connection', (socket) => {
  socket.on('auth', (telegram_id) => {
    onlineUsers.set(String(telegram_id), socket.id);
    socket.data.telegram_id = String(telegram_id);
    io.emit('presence', { telegram_id, online: true });
  });

  socket.on('typing', ({ to_id }) => {
    const targetSocket = onlineUsers.get(String(to_id));
    if (targetSocket) io.to(targetSocket).emit('typing', { from_id: socket.data.telegram_id });
  });

  socket.on('disconnect', () => {
    if (socket.data.telegram_id) {
      onlineUsers.delete(socket.data.telegram_id);
      io.emit('presence', { telegram_id: socket.data.telegram_id, online: false });
    }
  });
});

// Export for routes
app.set('supabase', supabase);
app.set('io', io);
global._io = io
app.set('onlineUsers', onlineUsers);

// ─── Telegram initData validation ─────────────────────────────────────────────
function validateTelegramData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    // Use deterministic byte-order (ASCII) sorting to ensure consistency across environments
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a > b ? 1 : -1))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest();

    const computedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (computedHash !== hash) return null;

    // Check auth date (allow up to 24 hours per Telegram guidelines, plus 5-minute clock skew window)
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    const age = Date.now() / 1000 - authDate;
    if (age > 86400 || age < -300) return null;

    const userJson = params.get('user');
    return userJson ? JSON.parse(userJson) : null;
  } catch {
    return null;
  }
}

// Auth middleware
function requireAuth(req, res, next) {
  // In development/testing mode allow bypass
  if (process.env.NODE_ENV === 'development') {
    req.telegramUser = { id: parseInt(req.headers['x-telegram-id'] || '0') };
    return next();
  }

  const initData = req.headers['x-telegram-init-data'];
  if (!initData) return res.status(401).json({ error: 'Missing initData' });

  const user = validateTelegramData(initData);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });

  req.telegramUser = user;
  next();
}

function requireAdmin(req, res, next) {
  if (String(req.telegramUser.id) !== String(process.env.ADMIN_TELEGRAM_ID)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth')(supabase, requireAuth));
app.use('/api/users', require('./routes/users')(supabase, requireAuth));
app.use('/api/mentors', require('./routes/mentors')(supabase, requireAuth));
app.use('/api/sessions', require('./routes/sessions')(supabase, requireAuth, io, onlineUsers));
app.use('/api/messages', require('./routes/messages')(supabase, requireAuth, io, onlineUsers));
app.use('/api/admin', require('./routes/admin')(supabase, requireAuth, requireAdmin, io));
app.use('/api/support', require('./routes/support')(supabase, requireAuth));
app.use('/api/topics', require('./routes/topics')(supabase, requireAuth, requireAdmin));
app.use('/api/streaks', require('./routes/streaks')(supabase, requireAuth));
app.use('/api/journal', require('./routes/journal')(supabase, requireAuth));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── SPA Catch-all ────────────────────────────────────────────────────────────
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(require('path').join(__dirname, 'frontend', 'index.html'));
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));