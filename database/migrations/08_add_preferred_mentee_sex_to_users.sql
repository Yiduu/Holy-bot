-- 08_add_preferred_mentee_sex_to_users.sql
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS preferred_mentee_sex TEXT DEFAULT 'both' 
CHECK (preferred_mentee_sex IN ('M', 'F', 'both'));
