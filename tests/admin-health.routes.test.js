// Run: node tests/admin-health.routes.test.js   (no network, no Supabase)
// Runs the REAL routes/admin.js "needs attention", "mentor health" and "nudge" endpoints on fake tables.
const path = require('path'); const assert = require('assert'); const express = require('express');
const root = path.join(__dirname, '..');
const cards = [];
require.cache[require.resolve(root + '/bot')] = { id: 'bot', filename: 'bot', loaded: true, exports: { sendCard: async (id, c) => cards.push([id, c]), broadcastToAll: async () => ({ sent: 0, failed: 0 }) } };
const DAY = 86400000, ago = (d) => new Date(Date.now() - d * DAY).toISOString();

const db = {
  users: [
    { telegram_id: 1, anonymous_id: 'Shepherd_1', role: 'mentor', rating: 4.5, user_settings: { max_mentees: 2 }, mentors: { suspended_by_admin: false } },
    { telegram_id: 2, anonymous_id: 'Shepherd_2', role: 'mentor', rating: 0, user_settings: null, mentors: { suspended_by_admin: false } },
    { telegram_id: 10, anonymous_id: 'Warrior_10', role: 'mentee' }, { telegram_id: 11, anonymous_id: 'Warrior_11', role: 'mentee' }, { telegram_id: 12, anonymous_id: 'Warrior_12', role: 'mentee' },
  ],
  mentorship_assignments: [
    { mentor_id: 1, user_id: 10, is_active: true, assigned_at: ago(40) },
    { mentor_id: 1, user_id: 11, is_active: true, assigned_at: ago(40) },
    { mentor_id: 2, user_id: 12, is_active: true, assigned_at: ago(3) },
    { mentor_id: 2, user_id: 13, is_active: false, ended_by: 'mentee', ended_at: ago(20), assigned_at: ago(90) },
  ],
  messages: [
    { from_id: 10, to_id: 1, created_at: ago(12) },      // mentee wrote 12 days ago, mentor never answered
    { from_id: 11, to_id: 1, created_at: ago(1) }, { from_id: 1, to_id: 11, created_at: ago(0.9) },
  ],
  video_sessions: [{ host_id: 1, started_at: ago(5) }],
  audit_logs: [],
};
function from(table) {
  let rows = db[table], filters = [], op = 'select', payload, lim = null, one = false, rng = null;
  const q = {
    select() { return q; }, order() { return q; }, limit(n) { lim = n; return q; },
    eq(c, v) { filters.push(r => String(r[c]) === String(v)); return q; },
    in(c, a) { filters.push(r => a.map(String).includes(String(r[c]))); return q; },
    gte(c, v) { filters.push(r => r[c] >= v); return q; },
    range(a, b) { rng = [a, b]; return q; },
    maybeSingle() { one = true; return q; },
    insert(p) { op = 'insert'; payload = p; return q; },
    then(res, rej) {
      let data;
      if (op === 'insert') { const row = { id: db[table].length + 1, created_at: new Date().toISOString(), ...payload }; db[table].push(row); data = [row]; }
      else { data = rows.filter(r => filters.every(f => f(r))); if (rng) data = data.slice(rng[0], rng[1] + 1); if (lim) data = data.slice(0, lim); }
      return Promise.resolve(one ? { data: data[0] || null, error: null } : { data, error: null }).then(res, rej);
    },
  };
  return q;
}
const supabase = { from };
const requireAuth = (req, res, next) => { req.telegramUser = { id: 999 }; next(); };
const app = express(); app.use(express.json());
app.use('/a', require(root + '/routes/admin')(supabase, requireAuth, (q, r, n) => n(), { emit() {} }));
const ok = (n) => console.log('  ✓', n);
const call = async (m, u, b) => { const r = await fetch(`http://127.0.0.1:${port}/a${u}`, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
let port;
(async () => {
  const srv = app.listen(0); port = srv.address().port;

  let r = await call('GET', '/mentorships/needs-attention?days=7');
  assert.equal(r.status, 200); assert.equal(r.body.items.length, 1);
  const it = r.body.items[0];
  assert.equal(it.mentor_name, 'Shepherd_1'); assert.equal(it.mentee_name, 'Warrior_10'); assert.equal(it.waiting_on, 'mentor'); assert.equal(it.quiet_days, 12);
  assert.ok(!JSON.stringify(r.body).includes('"telegram_id"')); ok('lists only the quiet pair, says the mentor owes a reply, uses anonymous names');
  r = await call('GET', '/mentorships/needs-attention?days=1'); assert.ok(r.body.items.length >= 2); ok('the days filter changes the list');

  r = await call('GET', '/mentors/health'); assert.equal(r.status, 200);
  const m1 = r.body.mentors.find(m => m.mentor_id === 1), m2 = r.body.mentors.find(m => m.mentor_id === 2);
  assert.equal(m1.active_mentees, 2); assert.equal(m1.capacity, 2); assert.equal(m1.sessions_30d, 1); assert.equal(m2.capacity, 3);
  assert.equal(m1.quiet_mentorships, 1); ok('health rows: workload, capacity (default 3), sessions, quiet mentorships');
  assert.equal(m2.left_90d, 1); ok('counts mentees who left');

  r = await call('POST', '/mentorships/nudge', { mentor_id: 1, mentee_id: 10, who: 'mentor' });
  assert.equal(r.status, 200); assert.equal(cards.length, 1); assert.equal(cards[0][0], 1); assert.equal(db.audit_logs.length, 1); ok('nudge reaches the mentor and is logged');
  r = await call('POST', '/mentorships/nudge', { mentor_id: 1, mentee_id: 10, who: 'mentor' }); assert.equal(r.status, 429); assert.equal(cards.length, 1); ok('the same person is not reminded twice in a day');
  r = await call('POST', '/mentorships/nudge', { mentor_id: 2, mentee_id: 99, who: 'mentee' }); assert.equal(r.status, 404); ok('no reminder for a pairing that is not active');
  r = await call('POST', '/mentorships/nudge', { mentor_id: 1, mentee_id: 10, who: 'admin' }); assert.equal(r.status, 400); ok('bad request is rejected');
  r = await call('POST', '/mentorships/nudge', { mentor_id: 1, mentee_id: 11, who: 'mentee' }); assert.equal(r.status, 200); assert.equal(cards[1][0], 11); ok('nudge can go to the mentee too');
  console.log('\nALL ADMIN HEALTH ROUTE CHECKS PASSED'); srv.close(); setTimeout(() => process.exit(0), 50);
})().catch(e => { console.error('\nFAIL:', e.message, (e.stack || '').split('\n')[1]); process.exit(1); });
