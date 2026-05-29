-- Bible Reading Streaks
CREATE TABLE IF NOT EXISTS bible_streaks (
  telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  current_streak INT DEFAULT 0,
  longest_streak INT DEFAULT 0,
  last_read_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Journal Entries
CREATE TABLE IF NOT EXISTS journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for journal entries
CREATE INDEX idx_journal_entries_user ON journal_entries(telegram_id, created_at DESC);

-- Add verse_time to user_settings
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS verse_time INT DEFAULT 7;
