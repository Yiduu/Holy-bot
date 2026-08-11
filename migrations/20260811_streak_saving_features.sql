BEGIN;

-- Streak Savers ("freezes"): users bank one every 7-day milestone (max 2 banked).
-- If exactly one day is missed and a freeze is available, it auto-consumes to
-- protect current_streak instead of resetting to 1.
ALTER TABLE bible_streaks ADD COLUMN IF NOT EXISTS freezes_available INT DEFAULT 0;
ALTER TABLE bible_streaks ADD COLUMN IF NOT EXISTS last_freeze_awarded_streak INT DEFAULT 0;

-- Per-day read log — powers the weekly progress strip on the streak card and
-- lets us retroactively mark a freeze-covered day, rather than relying only
-- on the single last_read_date pointer.
CREATE TABLE IF NOT EXISTS streak_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  read_date DATE NOT NULL,
  used_freeze BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(telegram_id, read_date)
);
CREATE INDEX IF NOT EXISTS idx_streak_log_telegram_date ON streak_log(telegram_id, read_date DESC);

-- Opt-in evening reminder so a streak isn't lost simply because someone forgot.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_streak_reminder BOOLEAN DEFAULT true;

COMMIT;
