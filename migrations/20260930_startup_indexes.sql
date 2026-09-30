-- Indexes for the hottest queries on app open. Safe to run more than once.
-- Run in Supabase: SQL Editor -> paste -> Run.

-- GET /api/sessions/my filters session_participants by telegram_id only, but
-- the primary key is (session_id, telegram_id), which can't serve that filter.
CREATE INDEX IF NOT EXISTS idx_session_participants_user
  ON session_participants (telegram_id);

-- Chat conversation query (both directions) and unread badge counts.
-- (These were in holy-chat-performance.patch but the migration file in the
-- repo was empty, so they may never have been created.)
CREATE INDEX IF NOT EXISTS idx_messages_pair_rev
  ON messages (to_id, from_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_unread
  ON messages (to_id, from_id)
  WHERE is_read = false;

-- Session reminder scheduler runs every minute.
CREATE INDEX IF NOT EXISTS idx_video_sessions_reminder
  ON video_sessions (scheduled_at)
  WHERE status = 'scheduled' AND reminder_sent = false;

ANALYZE session_participants;
ANALYZE messages;
