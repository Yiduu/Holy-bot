-- 05_update_mentor_applications.sql
ALTER TABLE mentor_applications ADD COLUMN IF NOT EXISTS sex TEXT;
ALTER TABLE mentor_applications ADD COLUMN IF NOT EXISTS educational_background TEXT;
ALTER TABLE mentor_applications ADD COLUMN IF NOT EXISTS about_me TEXT;
