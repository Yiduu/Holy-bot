-- Migration to add avatar_url column to users table (profile photo support)
ALTER TABLE users ADD COLUMN avatar_url TEXT;
