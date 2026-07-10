'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const logger = require('./utils/logger');

// ─── Sentry (optional – only active when SENTRY_DSN is set) ──────────────────
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'production',
      tracesSampleRate: 0.2,
    });
    logger.info('Sentry error tracking initialized');
  } catch (e) {
    logger.warn('Sentry package not installed — skipping error tracking', { error: e.message });
    Sentry = null;
  }
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

// Sentry request handler must be first middleware if enabled
if (Sentry) app.use(Sentry.Handlers.requestHandler());

app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`);
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

  socket.on('messages_read', ({ to_id }) => {
    const targetSocket = onlineUsers.get(String(to_id));
    if (targetSocket && socket.data.telegram_id) {
      io.to(targetSocket).emit('messages_read', { by_id: socket.data.telegram_id });
    }
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

// ─── Health check (enhanced – probes DB connection) ──────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { error } = await supabase
      .from('users')
      .select('telegram_id', { count: 'exact', head: true })
      .limit(1);
    if (error) throw error;
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (e) {
    logger.error('Health check failed', { error: e.message });
    res.status(503).json({ status: 'unhealthy', error: e.message });
  }
});

// ─── SPA Catch-all ────────────────────────────────────────────────────────────
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(require('path').join(__dirname, 'frontend', 'index.html'));
});

// ─── Sentry error handler (must be before generic error handler) ──────────────
if (Sentry) app.use(Sentry.Handlers.errorHandler());

// ─── Generic error handler ────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error('Unhandled express error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
const httpServer = server.listen(PORT, () => logger.info(`Server running on port ${PORT}`));

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  httpServer.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  // Force-kill if server hasn't closed within 10 s
  setTimeout(() => {
    logger.warn('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Unhandled promise rejections ────────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', { reason: String(reason), promise: String(promise) });
  if (Sentry) Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

// ─── Uncaught exceptions ──────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — exiting', { error: err.message, stack: err.stack });
  if (Sentry) Sentry.captureException(err);
  process.exit(1);
});