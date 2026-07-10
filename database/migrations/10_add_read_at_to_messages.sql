-- Migration: Add read_at column to messages
ALTER TABLE messages ADD COLUMN read_at TIMESTAMPTZ;
