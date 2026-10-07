-- ============================================================================
-- Chat attachments from the Mini App (voice messages, photos, videos, files)
-- ============================================================================
-- Idempotent: safe to run on a database that already has some or all of these
-- columns (the older "add attachments" script in database/migrations/ added the
-- first six; it was never listed in MIGRATIONS.md, so they are repeated here).
--
-- `waveform` is new. It holds the loudness bars Telegram shows inside a voice
-- bubble, as a short string of base-32 digits (one character per bar, 0-v,
-- ~40 bars). The app still works without it: if the column is missing the
-- server stores the message without a waveform and voice bubbles fall back to
-- a generated one.
-- ============================================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS file_id   text,
  ADD COLUMN IF NOT EXISTS file_type text,      -- 'voice' | 'audio' | 'document' | 'photo' | 'video'
  ADD COLUMN IF NOT EXISTS file_size integer,   -- bytes
  ADD COLUMN IF NOT EXISTS mime_type text,      -- e.g. 'audio/ogg', 'image/jpeg'
  ADD COLUMN IF NOT EXISTS duration  integer,   -- seconds, for voice/audio/video
  ADD COLUMN IF NOT EXISTS file_name text,      -- original filename, for documents
  ADD COLUMN IF NOT EXISTS waveform  text;      -- voice-message loudness bars (base-32, one char per bar)

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_file_type_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_file_type_check
  CHECK (file_type IS NULL OR file_type IN ('voice', 'audio', 'document', 'photo', 'video'));

CREATE INDEX IF NOT EXISTS idx_messages_file_type
  ON messages (file_type) WHERE file_type IS NOT NULL;
