'use strict';

// Pure rules for the admin "Needs attention" list and "Mentor health" table.
// No database code here, so every rule can be tested on its own.
//
// Words used below:
//   assignment  = one active mentor <-> mentee pairing { mentor_id, user_id, assigned_at }
//                 (user_id is the mentee, as everywhere in this app)
//   message     = { from_id, to_id, created_at }
//   quiet       = no message either way

const DAY = 24 * 60 * 60 * 1000;

// ── Thresholds: change them here, nowhere else ────────────────────────────────
const SLOW_REPLY_HOURS = 48;     // a mentor who usually takes longer than this is "slow"
const LEFT_RECENTLY = 2;         // this many mentees leaving in 90 days is worth a look
const STUCK_MANY = 2;            // this many quiet mentorships for one mentor is worth a look

const ms = (v) => (v ? new Date(v).getTime() : NaN);

// Messages between each active pair, oldest first, tagged by who sent them.
function indexMessages(assignments, messages) {
  const byPair = new Map();            // "mentor:mentee" -> [{ t, fromMentor }]
  for (const a of assignments) byPair.set(`${a.mentor_id}:${a.user_id}`, []);
  for (const m of messages) {
    const t = ms(m.created_at);
    if (Number.isNaN(t)) continue;
    let key = `${m.from_id}:${m.to_id}`, fromMentor = true;
    if (!byPair.has(key)) { key = `${m.to_id}:${m.from_id}`; fromMentor = false; }
    const list = byPair.get(key);
    if (list) list.push({ t, fromMentor });
  }
  for (const [key, list] of byPair) {
    const a = assignments.find(x => `${x.mentor_id}:${x.user_id}` === key);
    const since = ms(a && a.assigned_at);
    // Only what was said during THIS mentorship (the pair may have been together before).
    byPair.set(key, list.filter(x => Number.isNaN(since) || x.t >= since).sort((p, q) => p.t - q.t));
  }
  return byPair;
}

// Mentorships where nobody has written for `days` days or more, longest quiet first.
//   windowStartMs: how far back `messages` reaches. If a mentorship is older than that and
//   has no message inside it, we only know "at least this long" (at_least = true).
function findStuck(assignments, messages, { now = Date.now(), days = 7, windowStartMs = 0 } = {}) {
  const idx = indexMessages(assignments, messages);
  const out = [];
  for (const a of assignments) {
    const list = idx.get(`${a.mentor_id}:${a.user_id}`) || [];
    const last = list[list.length - 1] || null;
    const assignedMs = ms(a.assigned_at);

    let sinceMs, atLeast = false;
    if (last) sinceMs = last.t;
    else if (!Number.isNaN(assignedMs) && assignedMs >= windowStartMs) sinceMs = assignedMs;
    else { sinceMs = windowStartMs; atLeast = true; }

    const quietDays = Math.floor((now - sinceMs) / DAY);
    if (quietDays < days) continue;

    // Whoever did NOT speak last owes the next message. Nobody spoke yet → the mentor should start.
    const waitingOn = !last ? 'mentor' : (last.fromMentor ? 'mentee' : 'mentor');
    out.push({
      mentor_id: a.mentor_id,
      mentee_id: a.user_id,
      assigned_at: a.assigned_at,
      last_message_at: last ? new Date(last.t).toISOString() : null,
      last_from: last ? (last.fromMentor ? 'mentor' : 'mentee') : null,
      quiet_days: quietDays,
      at_least: atLeast,
      waiting_on: waitingOn,
    });
  }
  return out.sort((x, y) => y.quiet_days - x.quiet_days);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// How long a mentor takes to answer: from a mentee's message to the mentor's next one.
function replyHours(list, sinceMs) {
  const waits = [];
  let pending = null;
  for (const m of list) {
    if (!m.fromMentor) { if (pending === null) pending = m.t; }
    else if (pending !== null) { if (pending >= sinceMs) waits.push((m.t - pending) / 3600000); pending = null; }
  }
  return waits;
}

// One row per mentor.
//   mentors:  [{ telegram_id, anonymous_id, max_mentees, suspended, rating }]
//   active:   active assignments            ended: assignments that ended in the last 90 days
//   messages: last 30+ days                 sessions: [{ host_id, started_at }] in the last 30 days
function mentorHealth({ mentors, active, ended = [], messages, sessions = [], now = Date.now(), stuckDays = 7 }) {
  const idx = indexMessages(active, messages);
  const stuck = findStuck(active, messages, { now, days: stuckDays, windowStartMs: now - 30 * DAY });
  const stuckBy = {}; stuck.forEach(s => { stuckBy[s.mentor_id] = (stuckBy[s.mentor_id] || 0) + 1; });

  return mentors.map(m => {
    const mine = active.filter(a => String(a.mentor_id) === String(m.telegram_id));
    const lists = mine.map(a => idx.get(`${a.mentor_id}:${a.user_id}`) || []);
    const sent7 = lists.reduce((t, l) => t + l.filter(x => x.fromMentor && now - x.t <= 7 * DAY).length, 0);
    const waits = lists.flatMap(l => replyHours(l, now - 30 * DAY));
    const med = median(waits);
    const left90 = ended.filter(e => String(e.mentor_id) === String(m.telegram_id) && e.ended_by === 'mentee').length;
    const sessions30 = sessions.filter(s => String(s.host_id) === String(m.telegram_id)).length;
    const stuckCount = stuckBy[m.telegram_id] || 0;
    const capacity = m.max_mentees || 0;

    // Status: the first rule that applies wins. The reason is plain words for the admin.
    let status = 'good', reason = 'Doing well';
    if (m.suspended) { status = 'suspended'; reason = 'Suspended by an admin'; }
    else if (mine.length === 0) { status = 'idle'; reason = 'No mentees yet'; }
    else if (stuckCount > 0 && sent7 === 0) { status = 'attention'; reason = `Has not messaged in ${stuckDays} days`; }
    else if (med !== null && med > SLOW_REPLY_HOURS) { status = 'attention'; reason = `Slow to reply (about ${Math.round(med / 24)} days)`; }
    else if (left90 >= LEFT_RECENTLY) { status = 'attention'; reason = `${left90} mentees left in 3 months`; }
    else if (stuckCount >= STUCK_MANY) { status = 'attention'; reason = `${stuckCount} quiet mentorships`; }
    else if (capacity && mine.length >= capacity) { status = 'full'; reason = 'At capacity'; }

    return {
      mentor_id: m.telegram_id,
      anonymous_id: m.anonymous_id,
      status, reason,
      active_mentees: mine.length,
      capacity,
      median_reply_hours: med === null ? null : Math.round(med * 10) / 10,
      messages_7d: sent7,
      sessions_30d: sessions30,
      quiet_mentorships: stuckCount,
      left_90d: left90,
      rating: m.rating || 0,
    };
  });
}

const ORDER = { attention: 0, full: 1, good: 2, idle: 3, suspended: 4 };
const sortByNeed = (rows) => [...rows].sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || (b.active_mentees - a.active_mentees));

module.exports = { findStuck, mentorHealth, sortByNeed, indexMessages, replyHours, median, SLOW_REPLY_HOURS, LEFT_RECENTLY, STUCK_MANY };
