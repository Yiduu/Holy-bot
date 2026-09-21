-- Chat performance indexes. Safe to run more than once.
--
-- The conversation query matches messages in BOTH directions:
--   (from_id = me AND to_id = them) OR (from_id = them AND to_id = me)
-- ordered by created_at DESC. idx_messages_pair (from_id, to_id, created_at)
-- serves the first half; without the reverse index the second half has to
-- filter/sort more rows than necessary.
CREATE INDEX IF NOT EXISTS idx_messages_pair_rev
  ON messages (to_id, from_id, created_at DESC);

-- Unread badge counts and "mark as read" only ever touch unread rows.
CREATE INDEX IF NOT EXISTS idx_messages_unread
  ON messages (to_id, from_id)
  WHERE is_read = false;
