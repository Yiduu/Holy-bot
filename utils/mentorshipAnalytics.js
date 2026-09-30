'use strict';

// Pure aggregation for the admin "Mentorship Analytics" tab. Kept free of
// database code so it can be tested on its own.
//
// rows: mentorship_assignments rows { user_id, mentor_id, is_active,
//       assigned_at, ended_at, ended_by }.   user_id = the mentee.
// sinceMs: only count matches made / mentorships ended at or after this time
//          (0 = all time).
//
// "Unique" always means distinct people, not distinct mentorships: a mentee
// who was matched three times counts once.

const ENDED_BY_KEYS = ['mentee', 'mentor', 'admin', 'system', 'unknown'];

function summarize(rows, sinceMs = 0) {
  const t = (v) => (v ? new Date(v).getTime() : NaN);
  const inRange = (v) => sinceMs === 0 || t(v) >= sinceMs;

  const matchedRows = rows.filter(r => inRange(r.assigned_at));
  const endedRows = rows.filter(r => r.is_active === false && r.ended_at && inRange(r.ended_at));

  const uniq = (list, pick) => new Set(list.map(pick)).size;

  const matchedPeople = new Set();
  for (const r of matchedRows) { matchedPeople.add(String(r.user_id)); matchedPeople.add(String(r.mentor_id)); }

  const endedPeople = new Set();
  for (const r of endedRows) { endedPeople.add(String(r.user_id)); endedPeople.add(String(r.mentor_id)); }

  const by = {};
  for (const k of ENDED_BY_KEYS) by[k] = { endings: 0, unique_mentees: 0, unique_mentors: 0 };
  const buckets = Object.fromEntries(ENDED_BY_KEYS.map(k => [k, []]));
  for (const r of endedRows) {
    const key = ENDED_BY_KEYS.includes(r.ended_by) ? r.ended_by : 'unknown';
    buckets[key].push(r);
  }
  for (const k of ENDED_BY_KEYS) {
    by[k] = {
      endings: buckets[k].length,
      unique_mentees: uniq(buckets[k], r => r.user_id),
      unique_mentors: uniq(buckets[k], r => r.mentor_id),
    };
  }

  return {
    matched: {
      unique_users: matchedPeople.size,
      unique_mentees: uniq(matchedRows, r => r.user_id),
      unique_mentors: uniq(matchedRows, r => r.mentor_id),
      total_matches: matchedRows.length,
      active_now: rows.filter(r => r.is_active === true).length,
    },
    ended: {
      total: endedRows.length,
      unique_users: endedPeople.size,
      unique_mentees: uniq(endedRows, r => r.user_id),
      unique_mentors: uniq(endedRows, r => r.mentor_id),
      by,
    },
  };
}

module.exports = { summarize, ENDED_BY_KEYS };
