-- 06_reset_topics.sql

-- Delete all existing topics and re‑seed with the exact list you provided
TRUNCATE TABLE topics RESTART IDENTITY CASCADE;

INSERT INTO topics (name, slug, description) VALUES
  ('Identity Crisis / የማንነት ቀውስ', 'identity_crisis', ''),
  ('Depression/anxiety / ድብርት/ጭንቀት', 'depression_anxiety', ''),
  ('Alcohol/drug addiction / አልኮል/አደንዛዥ ዕፅ ሱሰኝነት', 'alcohol_drug_addition', ''),
  ('Pre-marital sex/ sexual issues / ጋብቻ በፊት ወሲብ/የወሲብ ችግሮች', 'pre_marital_sexual_issues', ''),
  ('Porn/masterbation / ፖርን/ማስተርቤሽን', 'porn_masterbation', ''),
  ('Social media addiction / ማህበራዊ ሚዲያ ሱሰኝነት', 'social_media_addiction', ''),
  ('Losing faith/ spiritual life / እምነት ማጣት/መንፈሳዊ ሕይወት', 'losing_faith_spiritual_life', ''),
  ('Time management / ጊዜ አጠቃቀም', 'time_management', ''),
  ('Loneliness / ብቸኝነት', 'loneliness', ''),
  ('Family issues / የቤተሰብ ጉዳዮች', 'family_issues', ''),
  ('Relationship issues / የፍቅር ግንኙነት ጉዳዮች', 'relationship_issues', ''),
  ('Academic counseling / የትምህርት ጉዳይ ምክር', 'academic_counseling', ''),
  ('Other / ሌላ', 'other', '');
