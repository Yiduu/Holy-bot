# Running the database migrations

The migrations for this project ended up split across three folders as the
schema grew. They still need to be applied in the right order, so here it is,
spelled out. Run each file's SQL in the Supabase SQL editor in this sequence:

1. `supabase/01_schema.sql`
2. `supabase/02_add_features.sql`
3. `supabase/seed.sql`
4. `database/migrations/03_add_features.sql`
5. `database/migrations/04_add_topics.sql`
6. `database/migrations/05_update_mentor_applications.sql`
7. `database/migrations/06_reset_topics.sql`
8. `database/migrations/07_add_admin_note_to_mentorship_requests.sql`
9. `database/migrations/08_add_preferred_mentee_sex_to_users.sql`
10. `database/migrations/09_backfill_and_correction.sql`
11. `database/migrations/10_add_read_at_to_messages.sql`
12. `database/migrations/11_add_accepting_requests.sql`
13. `database/migrations/12_add_ticket_replies.sql`
14. `database/migrations/13_add_ticket_category.sql`
15. `supabase/migrations/12_add_avatar_url.sql`
16. `supabase/migrations/13_avatar_use_telegram_storage.sql`
17. `supabase/migrations/14_avatar_use_supabase_storage.sql`
18. `supabase/migrations/15_avatar_use_preset.sql`
19. `supabase/migrations/16_add_photo_columns.sql`
20. Everything in `migrations/`, in filename order (they're dated, so just
    run them top to bottom as `ls` shows them)

A couple of notes on why this looks the way it does:

- `database/migrations/11_add_accepting_requests.sql` and
  `supabase/migrations/11_add_accepting_requests.sql` are the same file —
  it got copied into both folders at some point. Only run it once (step 12
  above covers it).
- `supabase/migrations/` picks up the avatar/profile-photo work starting at
  12, which branched off after 11 and never got renumbered to follow
  `database/migrations/13`. It doesn't touch the same tables as 12/13 in
  `database/migrations/`, so the two don't conflict, but the shared numbers
  are confusing if you're not expecting it.
- The dated files in `migrations/` are the most recent convention and are
  self-ordering by filename.

This works as-is, but the three-folder split should get collapsed into a
single ordered migration history the next time someone has a spare afternoon
and a scratch Supabase project to test against.

## Live-session lifecycle (2026-10-04)

`migrations/20261004_session_lifecycle.sql` must be applied **before** deploying
the matching code. It adds `session_participants.last_seen_at` and `via_external`
(presence tracking), and widens the `video_sessions.status` CHECK to allow
`'cleared'` (which the old code wrote but the constraint rejected).

