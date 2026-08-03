-- Migration: switch avatar storage back to Supabase Storage.
-- Handles all prior states: avatar_file_id (from migration 13),
-- avatar_url already present (migration 12 never followed by 13), or
-- neither column existing yet.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'avatar_file_id') THEN
    ALTER TABLE users RENAME COLUMN avatar_file_id TO avatar_url;
  ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'avatar_url') THEN
    ALTER TABLE users ADD COLUMN avatar_url TEXT;
  END IF;
END $$;
