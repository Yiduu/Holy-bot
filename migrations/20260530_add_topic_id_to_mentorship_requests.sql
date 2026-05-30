BEGIN;
-- 1. Add nullable column
ALTER TABLE mentorship_requests ADD COLUMN topic_id INTEGER REFERENCES topics(id);
-- 2. Backfill existing rows with a default topic (use first topic id)
DO $$
DECLARE default_topic INTEGER;
BEGIN
  SELECT id INTO default_topic FROM topics ORDER BY id LIMIT 1;
  IF default_topic IS NOT NULL THEN
    UPDATE mentorship_requests SET topic_id = default_topic WHERE topic_id IS NULL;
  END IF;
END $$;
-- 3. Enforce NOT NULL constraint now that column is populated
ALTER TABLE mentorship_requests ALTER COLUMN topic_id SET NOT NULL;
COMMIT;
