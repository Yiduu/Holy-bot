-- 04_add_topics.sql

-- 1. Topics table
CREATE TABLE IF NOT EXISTS topics (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed topics
INSERT INTO topics (name, slug, description) VALUES
('Identity Crisis / የማንነት ቀውስ', 'identity_crisis', ''),
('Depression/anxiety / ድብርት/ጭንቀት', 'depression_anxiety', ''),
('Alcohol/drug addiction / አልኮል/አደንዛዥ ዕፅ ሱሰኝነት', 'alcohol_drug_addiction', ''),
('Pre-marital sex/ sexual issues / ጋብቻ በፊት ወሲብ/የወሲብ ችግሮች', 'pre_marital_sexual_issues', ''),
('Porn/masterbation / ፖርን/ማስተርቤሽን', 'porn_masterbation', ''),
('Social media addiction / ማህበራዊ ሚዲያ ሱሰኝነት', 'social_media_addiction', ''),
('Losing faith/ spiritual life / እምነት ማጣት/መንፈሳዊ ሕይወት', 'losing_faith_spiritual_life', ''),
('Time management / ጊዜ አጠቃቀም', 'time_management', ''),
('Loneliness / ብቸኝነት', 'loneliness', ''),
('Family issues / የቤተሰብ ጉዳዮች', 'family_issues', ''),
('Relationship issues / የፍቅር ግንኙነት ጉዳዮች', 'relationship_issues', ''),
('Academic counseling / የትምህርት ጉዳይ ምክር', 'academic_counseling', ''),
('Other / ሌላ', 'other', '')
ON CONFLICT (slug) DO NOTHING;

-- 2. User Topics (Struggles)
CREATE TABLE IF NOT EXISTS user_topics (
  telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
  topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (telegram_id, topic_id)
);

-- 3. Mentor Topics (Expertise)
CREATE TABLE IF NOT EXISTS mentor_topics (
  telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
  topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (telegram_id, topic_id)
);

-- 4. Update Assignments and Sessions
ALTER TABLE mentorship_assignments ADD COLUMN IF NOT EXISTS topic_id INTEGER REFERENCES topics(id);
ALTER TABLE video_sessions ADD COLUMN IF NOT EXISTS topic_id INTEGER REFERENCES topics(id);

-- 5. Bible Streaks (Ensuring it exists as per prompt request)
CREATE TABLE IF NOT EXISTS bible_streaks (
  telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  current_streak INT DEFAULT 0,
  longest_streak INT DEFAULT 0,
  last_read_date DATE
);

-- 6. Journal Entries (Ensuring it exists as per prompt request)
CREATE TABLE IF NOT EXISTS journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. User Settings Update
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS verse_time INTEGER DEFAULT 7;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';
