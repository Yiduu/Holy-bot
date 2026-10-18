BEGIN;

-- Audio vs video calls, for the admin Live Sessions page.
--
-- Every session is one Jitsi room and the camera is optional, so nothing used
-- to record whether a call was an audio call or a video call. The host's
-- in-room client now reports the host's camera state on its heartbeat
-- (POST /api/sessions/:id/heartbeat { cam }), and the server stores it here:
--
--   'video'  the host had their camera on (once video, always video: turning
--            the camera off later does not turn the call back into audio)
--   'audio'  the host joined with the camera off and never turned it on
--   NULL     not known yet: the host has not entered the call, joined from an
--            external browser (which cannot heartbeat), or the session predates
--            this migration
--
-- The server and the admin API tolerate this column being absent, so this file
-- can be run before or after the code is deployed.
ALTER TABLE video_sessions ADD COLUMN IF NOT EXISTS call_type TEXT;

ALTER TABLE video_sessions DROP CONSTRAINT IF EXISTS video_sessions_call_type_check;
ALTER TABLE video_sessions
  ADD CONSTRAINT video_sessions_call_type_check
  CHECK (call_type IS NULL OR call_type IN ('audio', 'video'));

-- Speeds up the admin filters (status = 'active' / call_type = 'video' | 'audio').
CREATE INDEX IF NOT EXISTS idx_sessions_call_type ON video_sessions(status, call_type);

COMMIT;
