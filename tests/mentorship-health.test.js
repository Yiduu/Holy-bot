// Run: node tests/mentorship-health.test.js   (no database needed)
const assert = require('assert');
const { findStuck, mentorHealth, sortByNeed, replyHours, median } = require('../utils/mentorshipHealth');
const ok = (n) => console.log('  ✓', n);
const DAY = 86400000, now = Date.parse('2026-10-19T12:00:00Z');
const ago = (d) => new Date(now - d * DAY).toISOString();
const msg = (from, to, d) => ({ from_id: from, to_id: to, created_at: ago(d) });
const A = (mentor, mentee, d) => ({ mentor_id: mentor, user_id: mentee, assigned_at: ago(d) });
const opts = { now, days: 7, windowStartMs: now - 60 * DAY };

// 1. who owes the next message
let s = findStuck([A(1, 10, 40)], [msg(10, 1, 9)], opts);
assert.equal(s.length, 1); assert.equal(s[0].waiting_on, 'mentor'); assert.equal(s[0].last_from, 'mentee'); assert.equal(s[0].quiet_days, 9); ok('mentee wrote last → the mentor owes a reply');
s = findStuck([A(1, 10, 40)], [msg(1, 10, 8)], opts); assert.equal(s[0].waiting_on, 'mentee'); ok('mentor wrote last → the mentee owes a reply');
s = findStuck([A(1, 10, 12)], [], opts); assert.equal(s[0].waiting_on, 'mentor'); assert.equal(s[0].last_message_at, null); assert.equal(s[0].quiet_days, 12); ok('nobody has written yet → counted from the match date, mentor should start');

// 2. fresh ones are left out
assert.equal(findStuck([A(1, 10, 40)], [msg(1, 10, 2)], opts).length, 0); ok('a recent message means not stuck');
assert.equal(findStuck([A(1, 10, 3)], [], opts).length, 0); ok('a brand-new match is not stuck');

// 3. exactly at the limit counts; one day short does not
assert.equal(findStuck([A(1, 10, 40)], [msg(1, 10, 7)], opts).length, 1);
assert.equal(findStuck([A(1, 10, 40)], [msg(1, 10, 6)], opts).length, 0); ok('7 days counts, 6 days does not');

// 4. older than we looked → "at least"
s = findStuck([A(1, 10, 200)], [], opts); assert.equal(s[0].at_least, true); assert.equal(s[0].quiet_days, 60); ok('very old and silent → "60+ days", not a made-up number');

// 5. chats from before this mentorship, and other pairs, are ignored
s = findStuck([A(1, 10, 20)], [msg(1, 10, 30), msg(1, 11, 1), msg(10, 2, 1)], opts);
assert.equal(s[0].last_message_at, null); assert.equal(s[0].quiet_days, 20); ok('only messages from this pair, after the match, count');

// 6. longest quiet first
s = findStuck([A(1, 10, 30), A(1, 11, 30)], [msg(10, 1, 9), msg(11, 1, 20)], opts); assert.deepEqual(s.map(x => x.mentee_id), [11, 10]); ok('sorted by longest quiet');

// 7. reply time
const L = (arr) => arr.map(([d, fm]) => ({ t: now - d * DAY, fromMentor: fm })).sort((a, b) => a.t - b.t);
let w = replyHours(L([[5, false], [4.5, true]]), now - 30 * DAY); assert.equal(w.length, 1); assert.equal(Math.round(w[0]), 12); ok('reply time = mentee message → next mentor message');
w = replyHours(L([[5, false], [4.9, false], [4, true]]), 0); assert.equal(w.length, 1); assert.equal(Math.round(w[0]), 24); ok('several mentee messages in a row count from the first');
assert.equal(replyHours(L([[5, false]]), 0).length, 0); ok('an unanswered message is not a reply time');
assert.equal(median([1, 2, 9]), 2); assert.equal(median([1, 3]), 2); assert.equal(median([]), null); ok('median');

// 8. mentor status
const mentors = [1, 2, 3, 4, 5, 6].map(id => ({ telegram_id: id, anonymous_id: 'M' + id, max_mentees: 2, suspended: id === 6 }));
const active = [A(1, 11, 50), A(2, 12, 50), A(2, 13, 50), A(3, 14, 50), A(4, 15, 50), A(4, 16, 50), A(6, 17, 50)];
const messages = [
  msg(11, 1, 2), msg(1, 11, 1.9),                        // mentor 1: quick replies, active
  msg(12, 2, 20), msg(13, 2, 19),                        // mentor 2: silent for 19+ days
  msg(14, 3, 10), msg(3, 14, 6),                         // mentor 3: replies take 4 days
  msg(15, 4, 1), msg(4, 15, 0.9), msg(16, 4, 1), msg(4, 16, 0.8), // mentor 4: fine but full
];
const ended = [{ mentor_id: 5, ended_by: 'mentee' }, { mentor_id: 5, ended_by: 'mentee' }, { mentor_id: 1, ended_by: 'admin' }];
const rows = Object.fromEntries(mentorHealth({ mentors, active, ended, messages, sessions: [{ host_id: 1 }, { host_id: 1 }], now }).map(r => [r.mentor_id, r]));
assert.equal(rows[1].status, 'good'); assert.equal(rows[1].sessions_30d, 2); ok('mentor 1: doing well');
assert.equal(rows[2].status, 'attention'); assert.match(rows[2].reason, /not messaged/); ok('mentor 2: silent mentees waiting → needs a look');
assert.equal(rows[3].status, 'attention'); assert.match(rows[3].reason, /Slow to reply/); ok('mentor 3: slow replies → needs a look');
assert.equal(rows[4].status, 'full'); ok('mentor 4: fine but at capacity');
assert.equal(rows[5].status, 'idle'); assert.equal(rows[5].left_90d, 2); ok('mentor 5: no mentees now (leavers are shown but not flagged as idle)');
assert.equal(rows[6].status, 'suspended'); ok('mentor 6: suspended wins over everything');
const order = sortByNeed(Object.values(rows)).map(r => r.mentor_id);
assert.deepEqual(order.slice(0, 2).sort(), [2, 3]); assert.equal(order[order.length - 1], 6); ok('needs-a-look first, suspended last');

// 9. leavers flag a mentor who still has mentees
const r2 = mentorHealth({ mentors: [mentors[0]], active: [A(1, 11, 50)], ended: ended.slice(0, 2).map(e => ({ ...e, mentor_id: 1 })), messages: [msg(11, 1, 2), msg(1, 11, 1.9)], now })[0];
assert.equal(r2.status, 'attention'); assert.match(r2.reason, /2 mentees left/); ok('two mentees left in 3 months → needs a look');
console.log('\nALL MENTORSHIP HEALTH CHECKS PASSED');
