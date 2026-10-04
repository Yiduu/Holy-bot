BEGIN;

-- 'cleared' was being written by DELETE /api/sessions/my, but the original
-- CHECK constraint only allowed scheduled/active/ended/cancelled, so that
-- update silently failed and cleared group sessions stayed in /upcoming.
ALTER TABLE video_sessions DROP CONSTRAINT IF EXISTS video_sessions_status_check;
ALTER TABLE video_sessions ADD CONSTRAINT video_sessions_status_check
  CHECK (status IN ('scheduled','active','ended','cancelled','cleared'));

-- Heartbeat timestamp: lets the server tell "still in the call" from "WebView was
-- killed and never said goodbye", so rooms and seats free themselves.
ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- People who join via "open in browser" can't heartbeat from Jitsi's own page.
ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS via_external BOOLEAN NOT NULL DEFAULT false;

-- Used by the lifecycle sweeper (active sessions whose rooms went empty).
CREATE INDEX IF NOT EXISTS idx_sessions_active_started ON video_sessions(status, started_at);
CREATE INDEX IF NOT EXISTS idx_session_participants_presence ON session_participants(session_id, left_at);

COMMIT;
