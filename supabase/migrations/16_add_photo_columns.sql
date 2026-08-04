-- Migration: add profile photo columns (Telegram-storage based).
--
-- Deliberately uses new column names (photo_file_id / photo_updated_at)
-- rather than reviving avatar_url / avatar_file_id / avatar_preset from
-- migrations 12-15. Those were renamed back and forth across storage
-- backends and the app code never caught up with the final rename,
-- which is what caused the earlier breakage — none of the app code
-- (routes, bot.js, frontend) currently reads or writes them. This
-- migration is purely additive and does not touch those columns.
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_file_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMPTZ;
