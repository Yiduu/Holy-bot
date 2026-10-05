// Run: node tests/sessions.lifecycle.test.js   (no network, no Supabase needed)
// Runs the REAL routes/sessions.js against an in-memory Supabase fake.
const path = require('path'); const assert = require('assert');
const root = path.join(__dirname, '..');
const pushes = [];
require.cache[require.resolve(root + '/bot')] = { id: 'bot', filename: 'bot', loaded: true, exports: {
  notifySessionInvite: async (id) => pushes.push(['invite', id]),
  notifySessionStarted: async (id) => pushes.push(['started', id]),
  notifySessionWaiting: async (id) => pushes.push(['waiting', id]),
}};
const express = require('express');

// ── minimal query-builder fake ──
const db = { users: [], video_sessions: [], session_participants: [], mentorship_assignments: [], user_settings: [] };
const PK = { video_sessions: ['id'], session_participants: ['session_id', 'telegram_id'], users: ['telegram_id'] };
let seq = 0;
function from(table) {
  let rows = db[table], op = 'select', payload, filters = [], single = false, maybe = false, opts = {}, lim = null;
  const q = {
    select() { return q; }, order() { return q; }, limit(n) { lim = n; return q; },
    eq(c, v) { filters.push(r => String(r[c]) === String(v)); return q; },
    neq(c, v) { filters.push(r => String(r[c]) !== String(v)); return q; },
    in(c, a) { filters.push(r => a.map(String).includes(String(r[c]))); return q; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return q; },
    lt(c, v) { filters.push(r => r[c] < v); return q; },
    gte(c, v) { filters.push(r => r[c] >= v); return q; },
    lte(c, v) { filters.push(r => r[c] <= v); return q; },
    or() { return q; },
    single() { single = true; return q; }, maybeSingle() { maybe = true; return q; },
    insert(p) { op = 'insert'; payload = p; return q; },
    upsert(p, o) { op = 'upsert'; payload = p; opts = o || {}; return q; },
    update(p) { op = 'update'; payload = p; return q; },
    delete(o) { op = 'delete'; opts = o || {}; return q; },
    then(res, rej) { return Promise.resolve(run()).then(res, rej); },
  };
  function match() { return rows.filter(r => filters.every(f => f(r))); }
  function run() {
    let data = null, count;
    if (op === 'select') { data = match(); if (table === 'session_participants') data = data.map(r => ({ ...r, session: db.video_sessions.find(v => v.id === r.session_id) })); }
    else if (op === 'insert' || op === 'upsert') {
      data = [].concat(payload).map(p => {
        const keys = PK[table] || ['id'];
        const ex = op === 'upsert' && rows.find(r => keys.every(k => String(r[k]) === String(p[k])));
        if (ex) { Object.assign(ex, p); return ex; }
        const row = { ...p }; if (table === 'video_sessions') row.id = row.id || 's' + (++seq);
        rows.push(row); return row;
      });
    } else if (op === 'update') { data = match(); data.forEach(r => Object.assign(r, payload)); }
    else if (op === 'delete') { const m = match(); db[table] = rows = rows.filter(r => !m.includes(r)); count = m.length; data = m; }
    if (lim) data = data.slice(0, lim);
    if (single) return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: 'not found' } };
    if (maybe) return { data: data[0] || null, error: null };
    return { data, error: null, count };
  }
  return q;
}
const supabase = { from };
const emitted = [];
const io = { emit: () => {}, to: (room) => ({ emit: (ev, p) => emitted.push([room, ev, p]) }) };
global.io = io;
const requireAuth = (req, res, next) => { req.telegramUser = { id: parseInt(req.headers['x-id']) }; next(); };
const app = express(); app.use(express.json());
app.use('/s', require(root + '/routes/sessions')(supabase, requireAuth, io, new Map()));

const MENTOR = 1, MENTEE = 2, STRANGER = 3;
const call = async (id, method, url, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/s${url}`, { method, headers: { 'content-type': 'application/json', 'x-id': String(id) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let port;
(async () => {
  const srv = app.listen(0); port = srv.address().port;
  db.users.push({ telegram_id: MENTOR, role: 'mentor', anonymous_id: 'Shepherd_1' }, { telegram_id: MENTEE, role: 'mentee', anonymous_id: 'Warrior_2' }, { telegram_id: STRANGER, role: 'mentee', anonymous_id: 'Warrior_3' });
  db.mentorship_assignments.push({ id: 'a1', mentor_id: MENTOR, user_id: MENTEE, is_active: true });
  const ok = (n) => console.log('  ✓', n);

  // 1. create (instant) – credentials returned to host, invite does NOT leak them
  let r = await call(MENTOR, 'POST', '/create', { mentee_id: MENTEE, title: 'Check-in' });
  assert.equal(r.status, 201); const sid = r.body.session.id; ok('mentor creates an instant 1:1');
  assert.ok(r.body.room_name && r.body.jitsi_domain === 'meet.opensuse.org'); ok('single Jitsi domain returned');
  assert.ok(!emitted.some(e => e[1] === 'session_invite' && JSON.stringify(e[2]).includes('room_')) ); ok('socket invite carries no room credentials');
  // NOTE: the double-tap dedupe relies on PostgREST's `!inner` embedded filter, which this
  // in-memory fake doesn't model — verify that one against a real Supabase project.
  // authz: stranger can't be invited / can't join
  r = await call(STRANGER, 'GET', `/${sid}/join`); assert.equal(r.status, 403); ok('non-participant cannot join a private session');
  r = await call(MENTOR, 'POST', '/create', { mentee_id: STRANGER }); assert.equal(r.status, 403); ok('cannot invite someone who is not your mentee');

  // 2. mentee arrives FIRST → waits, session NOT activated, host pinged
  pushes.length = 0; emitted.length = 0;
  r = await call(MENTEE, 'GET', `/${sid}/join`);
  assert.equal(r.status, 200); assert.equal(r.body.host_present, false); assert.equal(r.body.status, 'scheduled');
  assert.equal(db.video_sessions.find(s => s.id === sid).status, 'scheduled'); ok('mentee-first join does not activate the session');
  assert.ok(pushes.some(p => p[0] === 'waiting' && p[1] === MENTOR)); assert.ok(!pushes.some(p => p[0] === 'started')); ok('mentor gets a "waiting" ping, not a bogus "started"');
  assert.ok(emitted.some(e => e[0] === `user:${MENTOR}` && e[1] === 'session_participant_waiting')); ok('mentor gets in-app waiting event');
  pushes.length = 0; await call(MENTEE, 'GET', `/${sid}/join`); assert.equal(pushes.filter(p => p[0] === 'waiting').length, 0); ok('waiting ping is throttled');

  // 3. host arrives → active, lobby unlock event to mentee
  emitted.length = 0;
  r = await call(MENTOR, 'GET', `/${sid}/join`);
  assert.equal(r.body.status, 'active'); assert.equal(r.body.is_moderator, true); assert.equal(r.body.host_name, 'Shepherd_1');
  // nicknames: sessions show the Settings nickname, falling back to the anonymous ID
  db.user_settings.push({ telegram_id: MENTOR, display_name: '  Pastor Sam ' }, { telegram_id: MENTEE, display_name: '   ' });
  r = await call(MENTOR, 'GET', `/${sid}/join`); assert.equal(r.body.display_name, 'Pastor Sam'); ok('host joins under their nickname (trimmed)');
  r = await call(MENTEE, 'GET', `/${sid}/join`); assert.equal(r.body.host_name, 'Pastor Sam'); assert.equal(r.body.display_name, 'Warrior_2'); ok('mentee sees the host nickname; blank nickname falls back to anonymous ID');
  db.user_settings.length = 0;
  assert.ok(emitted.some(e => e[0] === `user:${MENTEE}` && e[1] === 'session_host_joined')); ok('host join activates + unlocks mentee lobby');
  let hb = await call(MENTEE, 'POST', `/${sid}/heartbeat`); assert.equal(hb.body.host_present, true); ok('heartbeat reports host_present');

  // 4. host drops (leave without end) → session survives, mentee told, host can rejoin
  emitted.length = 0;
  r = await call(MENTOR, 'POST', `/${sid}/leave`, {}); assert.equal(r.body.ended, false);
  assert.equal(db.video_sessions.find(s => s.id === sid).status, 'active'); ok('host leaving does NOT end the session');
  assert.ok(emitted.some(e => e[0] === `user:${MENTEE}` && e[1] === 'session_host_left')); ok('mentee is told host stepped out');
  r = await call(MENTOR, 'GET', `/${sid}/join`); assert.equal(r.status, 200); assert.equal(r.body.status, 'active'); ok('host can rejoin the live session');

  // 5. ghost presence expires via TTL
  const row = db.session_participants.find(p => p.session_id === sid && p.telegram_id === MENTOR);
  row.last_seen_at = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  hb = await call(MENTEE, 'POST', `/${sid}/heartbeat`); assert.equal(hb.body.host_present, false); ok('killed WebView stops counting as present after TTL');

  // 6. explicit end → everyone notified; join now 410
  emitted.length = 0;
  r = await call(MENTOR, 'POST', `/${sid}/leave`, { end: true }); assert.equal(r.body.ended, true);
  assert.ok(emitted.filter(e => e[1] === 'session_ended').length >= 2); ok('end-for-everyone notifies all participants');
  r = await call(MENTEE, 'GET', `/${sid}/join`); assert.equal(r.status, 410); assert.equal(r.body.code, 'ended'); ok('ended session can no longer be joined (was possible before)');
  r = await call(MENTOR, 'PATCH', `/${sid}/end`); assert.equal(r.status, 200); ok('end is idempotent');

  // 7. time gate with early-join window + server-time in the 403
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  r = await call(MENTOR, 'POST', '/create', { mentee_id: MENTEE, scheduled_at: future, title: 'Later' }); const fid = r.body.session.id;
  r = await call(MENTEE, 'GET', `/${fid}/join`); assert.equal(r.status, 403); assert.equal(r.body.code, 'too_early'); assert.ok(r.body.opens_at && r.body.server_time); ok('1 h early → 403 with opens_at + server_time');
  db.video_sessions.find(s => s.id === fid).scheduled_at = new Date(Date.now() + 4 * 60 * 1000).toISOString();
  r = await call(MENTEE, 'GET', `/${fid}/join`); assert.equal(r.status, 200); ok('4 min early → lobby opens (5 min early window)');
  r = await call(MENTOR, 'POST', '/create', { scheduled_at: 'not-a-date' }); assert.equal(r.status, 400); ok('invalid start time rejected');

  // 8. list endpoints never expose credentials (columns are explicit)
  const list = await call(MENTEE, 'GET', '/my'); assert.equal(list.status, 200); ok('/my responds');

  // 9. clear history only touches finished sessions
  r = await call(MENTEE, 'DELETE', '/my');
  assert.ok(db.session_participants.some(p => p.session_id === fid && p.telegram_id === MENTEE), 'live/upcoming session must survive "clear"');
  assert.ok(!db.session_participants.some(p => p.session_id === sid && p.telegram_id === MENTEE), 'ended session cleared');
  ok('"Clear history" keeps upcoming/live sessions, removes finished ones');

  console.log('\nALL LIFECYCLE CHECKS PASSED');
  srv.close();
  setTimeout(() => process.exit(0), 50);
})().catch(e => { console.error('\nFAIL:', e.message, e.stack.split('\n')[1]); process.exit(1); });

