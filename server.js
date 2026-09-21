'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const compression = require('compression');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
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
// Free-tier Supabase can stall for a long time (cold project, noisy neighbour).
// Without a timeout a stalled query leaves the HTTP request hanging forever,
// which is what makes the chat "spin" and never send. Failing fast (15 s)
// lets the client retry instead.
const SUPABASE_TIMEOUT_MS = 15000;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: (url, opts = {}) =>
        fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(SUPABASE_TIMEOUT_MS) }),
    },
  }
);

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // Trust Render's proxy
const server = http.createServer(app);

// Sentry request handler must be first middleware if enabled
if (Sentry) app.use(Sentry.Handlers.requestHandler());

// Log only what matters. Logging every request (incl. every static file and
// every poll) burns CPU on Render's 0.1 vCPU free instance; slow and failing
// requests are the ones worth seeing.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (res.statusCode >= 500 || ms > 1500) {
      logger.warn(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// gzip: app.js (~315 KB), styles.css (~218 KB) and index.html (~133 KB) were
// being sent uncompressed. Skips Socket.IO's own traffic automatically.
app.use(compression());

// Origin is locked down via ALLOWED_ORIGIN in production. Falls back to '*'
// only when that var isn't set, so local dev keeps working out of the box.
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10kb' }));
// HTML/JS/CSS: always revalidate (cheap 304 via ETag) so deploys reach users
// immediately; images: cache for a week.
app.use(express.static('frontend', {
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(png|jpg|jpeg|webp|svg|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ─── Rate Limiters ────────────────────────────────────────────────────────────

// Key limits by the verified Telegram user, NOT by IP. Ethiopian mobile
// carriers put many subscribers behind one shared (CGNAT) IP, so an IP-based
// limit lets a handful of active chatters exhaust the budget for everyone on
// that IP — the "message failed to send" symptom under load. Falls back to IP
// only for requests without valid initData (which 401 anyway).
function limiterKey(req) {
  const initData = req.headers['x-telegram-init-data'];
  if (initData) {
    const u = validateTelegramData(initData);
    if (u?.id) return `u:${u.id}`;
  }
  if (process.env.NODE_ENV === 'development' && req.headers['x-telegram-id']) {
    return `u:${req.headers['x-telegram-id']}`;
  }
  return `ip:${ipKeyGenerator(req.ip)}`;
}

const limiterBase = {
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: limiterKey,
};

// General API limiter: 240 requests/minute per user (only stops runaway loops)
const generalLimiter = rateLimit({
  ...limiterBase,
  windowMs: 60 * 1000,
  max: 240,
  message: { error: 'Too many requests, please try again later.' },
});

// Registration: 20 per minute per user
const authLimiter = rateLimit({
  ...limiterBase,
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts, please slow down.' },
});

// Sending chat messages: 60 per minute per user (spam guard; POST only)
const sendMessageLimiter = rateLimit({
  ...limiterBase,
  windowMs: 60 * 1000,
  max: 60,
  skip: (req) => req.method !== 'POST',
  message: { error: 'You are sending messages too fast, please slow down.' },
});

// Very strict limiter for broadcast: 5 requests per minute per user
const broadcastLimiter = rateLimit({
  ...limiterBase,
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Broadcast rate limit exceeded.' },
});

// Apply general limiter to all /api routes
app.use('/api', generalLimiter);
// Tighter limits on specific sensitive routes
app.use('/api/auth/register', authLimiter);
app.use('/api/messages', sendMessageLimiter);
app.use('/api/admin/broadcast', broadcastLimiter);

// ─── Socket.IO (real-time messages + typing) ─────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*' },
  // A dead mobile connection (app backgrounded, network switch) used to be
  // treated as "online" for up to 85 s (25 s + 60 s). Messages sent in that
  // window went into the void AND skipped the Telegram fallback notification.
  pingInterval: 20000,
  pingTimeout: 20000,
  // If a client drops for < 2 min, Socket.IO restores its rooms and replays
  // the events it missed on reconnect (built into Socket.IO ≥ 4.6).
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: true },
});
const onlineUsers = new Map(); // telegram_id → most recent socket_id (legacy lookups in other routes)
global.io = io;
global.onlineUsers = onlineUsers;

// SECURITY: the old code trusted a client-supplied telegram_id in an 'auth'
// event, so anyone could connect and receive another user's private counseling
// messages. The identity now comes from Telegram-signed initData, verified in
// the handshake — the same check the REST API uses.
io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  let user = null;
  if (auth.initData) {
    user = validateTelegramData(auth.initData);
  } else if (process.env.NODE_ENV === 'development' && auth.telegram_id) {
    user = { id: parseInt(auth.telegram_id, 10) };
  }
  if (!user?.id) return next(new Error('unauthorized'));
  socket.data.telegram_id = String(user.id);
  next();
});

io.on('connection', (socket) => {
  const myId = socket.data.telegram_id;

  // One room per user: reaches every device/tab the user has open, instead of
  // only whichever socket connected last.
  socket.join(`user:${myId}`);
  onlineUsers.set(myId, socket.id);

  // Legacy clients emitted 'auth'; identity is now taken from the handshake.
  socket.on('auth', () => { });

  socket.on('typing', ({ to_id } = {}) => {
    if (to_id == null) return;
    socket.to(`user:${to_id}`).emit('typing', { from_id: myId });
  });

  // Support ticket typing indicator — broadcast to everyone else (the ticket
  // owner + every admin dashboard). Cheap and stateless by design.
  socket.on('ticket_typing', ({ ticket_id, sender_type } = {}) => {
    if (!ticket_id || (sender_type !== 'user' && sender_type !== 'admin')) return;
    socket.broadcast.emit('ticket_typing', { ticket_id, sender_type });
  });

  socket.on('disconnect', () => {
    // Only touch the map if it still points at THIS socket. Previously an old
    // socket timing out AFTER the user had reconnected deleted the fresh
    // entry, so the user looked offline and stopped receiving live messages.
    if (onlineUsers.get(myId) !== socket.id) return;
    const remaining = io.sockets.adapter.rooms.get(`user:${myId}`);
    if (remaining && remaining.size > 0) {
      onlineUsers.set(myId, remaining.values().next().value);
    } else {
      onlineUsers.delete(myId);
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
app.use('/api/mentors', require('./routes/mentors')(supabase, requireAuth, io, onlineUsers));
app.use('/api/sessions', require('./routes/sessions')(supabase, requireAuth, io, onlineUsers));
app.use('/api/messages', require('./routes/messages')(supabase, requireAuth, io, onlineUsers));
app.use('/api/admin', require('./routes/admin')(supabase, requireAuth, requireAdmin, io));
app.use('/api/admin/mentor-control', require('./routes/mentor-control')(supabase, requireAuth, requireAdmin));
app.use('/api/support', require('./routes/support')(supabase, requireAuth, io, onlineUsers));
app.use('/api/topics', require('./routes/topics')(supabase, requireAuth, requireAdmin));
app.use('/api/streaks', require('./routes/streaks')(supabase, requireAuth));
app.use('/api/journal', require('./routes/journal')(supabase, requireAuth));
app.use('/api/avatar', require('./routes/avatar')(supabase, requireAuth, bot));

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

// Render's load balancer keeps idle connections open longer than Node's
// default 5 s keep-alive. When Node closes one just as the browser reuses it,
// the request dies with ECONNRESET — an intermittent "failed to send" that
// no amount of app code can explain. Node's timeouts must exceed the proxy's.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

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
process.on('SIGINT', () => shutdown('SIGINT'));

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