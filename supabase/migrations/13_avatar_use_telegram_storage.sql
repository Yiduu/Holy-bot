-- Migration: switch avatar storage from a Supabase Storage bucket
-- (which requires manually creating a bucket) to Telegram's own file
-- storage — we keep only the Telegram file_id and proxy the image
-- through the bot API on demand.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'avatar_url') THEN
    ALTER TABLE users RENAME COLUMN avatar_url TO avatar_file_id;
  ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'avatar_file_id') THEN
    ALTER TABLE users ADD COLUMN avatar_file_id TEXT;
  END IF;
END $$;
