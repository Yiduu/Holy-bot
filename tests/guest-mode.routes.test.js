'use strict';
// Guest mode: mentor-only access, sandbox isolation, and that the real
// mentee/goal behaviour is mirrored without ever touching the database writes.
const assert = require('assert');
const http = require('http');
const express = require('express');
const R = require('../utils/goalRules');
const guestRoutes = require('../routes/guest');

const writes = [];
function fakeSupabase(role) {
  const mentor = { telegram_id: 77, anonymous_id: 'Mentor_77', sex: 'M', age_range: '35-44', rating: 4.5, rating_count: 3,
    accepting_requests: true, role: 'mentor', is_banned: false, user_settings: { display_name: 'Mentor Joe', max_mentees: 3 } };
  const q = table => {
    const st = { table, filters: {} };
    const api = {
      select: () => api, eq: (k, v) => { st.filters[k] = v; return api; }, in: () => api, order: () => api,
      insert: () => { writes.push(['insert', table]); return api; }, update: () => { writes.push(['update', table]); return api; },
      delete: () => { writes.push(['delete', table]); return api; },
      maybeSingle: async () => {
        if (table === 'users' && st.filters.telegram_id === 1) return { data: { role, is_banned: false } };
        if (table === 'users' && st.filters.telegram_id === 77) return { data: mentor };
        return { data: null };
      },
      then: (res) => res({ data: [], count: 0, error: null }),
    };
    return api;
  };
  return { from: q };
}

async function boot(role) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, _res, next) => { req.telegramUser = { id: Number(req.headers['x-id'] || 1) }; next(); };
  const mentorsRouter = express.Router();
  mentorsRouter.get('/', (req, res) => res.json({ guest: req.guestContext }));
  app.use('/api/guest', guestRoutes(fakeSupabase(role), requireAuth, mentorsRouter));
  const srv = http.createServer(app);
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/api/guest`;
  const call = async (method, p, body, id = 1) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-id': String(id) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { call, close: () => srv.close() };
}

(async () => {
  // Non-mentors are refused everywhere.
  let s = await boot('user');
  assert.strictEqual((await s.call('POST', '/start', { sex: 'M' })).status, 403);
  assert.strictEqual((await s.call('GET', '/auth/me')).status, 403);
  s.close();

  s = await boot('mentor');
  // Needs a running sandbox first.
  assert.strictEqual((await s.call('GET', '/streaks')).status, 409);

  const start = await s.call('POST', '/start', { sex: 'F' });
  assert.strictEqual(start.status, 200);
  assert.strictEqual(start.body.user.role, 'user');
  assert.strictEqual(start.body.user.sex, 'F');
  assert.ok(start.body.user.telegram_id > 9e12, 'guest id must not collide with real Telegram ids');

  // Mentor directory is the real one, filtered for the persona.
  const list = await s.call('GET', '/mentors');
  assert.strictEqual(list.body.guest.sex, 'F');
  assert.strictEqual(list.body.guest.selfId, 1);

  // Request → pending → duplicate refused → no goals before acceptance.
  const req1 = await s.call('POST', '/mentors/request', { mentor_id: 77, topic_id: 1 });
  assert.strictEqual(req1.status, 201);
  assert.strictEqual((await s.call('POST', '/mentors/request', { mentor_id: 77 })).status, 409);
  assert.strictEqual((await s.call('POST', '/mentors/request', { mentor_id: 1 })).status, 400, 'cannot request yourself');
  assert.strictEqual((await s.call('POST', '/goals', { type: 'one_time', title: 'x' })).status, 403);
  const st = await s.call('GET', '/state');
  assert.strictEqual(st.body.pending.length, 1);

  // Simulated acceptance unlocks mentor, chat and goals.
  assert.strictEqual((await s.call('POST', '/simulate-accept', { request_id: req1.body.id })).status, 200);
  assert.strictEqual((await s.call('GET', '/users/my-mentor')).body.mentor.telegram_id, 77);
  assert.strictEqual((await s.call('GET', '/users/chat-partner')).body.type, 'single');
  assert.ok((await s.call('GET', '/messages/77')).body.length >= 1);

  // Goal: created as the mentor, ticked as the mentee, same rules as production.
  const today = R.ethiopiaToday();
  const g = await s.call('POST', '/goals', { type: 'challenge', title: 'Pray', start_date: today, end_date: R.addDays(today, 2), task_template: [{ title: 'Pray' }] });
  assert.strictEqual(g.status, 201);
  assert.strictEqual(g.body.tasks.length, 3);
  const future = g.body.tasks.find(t => t.due_date > today);
  assert.strictEqual((await s.call('PATCH', `/goals/tasks/${future.id}`, { done: true })).status, 409, "future day is locked for mentees");
  const todayTask = g.body.tasks.find(t => t.due_date === today);
  const ticked = await s.call('PATCH', `/goals/tasks/${todayTask.id}`, { done: true, note: 'felt good' });
  assert.strictEqual(ticked.body.stats.done, 1);
  assert.strictEqual((await s.call('GET', '/goals/mine')).body.length, 1);

  // Streak + journal live only in the sandbox.
  assert.strictEqual((await s.call('POST', '/streaks/mark')).body.current_streak, 1);
  const j = await s.call('POST', '/journal', { content: 'hello', mood: 'ok' });
  assert.strictEqual(j.status, 201);
  assert.strictEqual((await s.call('GET', '/journal')).body.length, 1);

  // Unmapped writes are refused; unmapped reads are harmless.
  assert.strictEqual((await s.call('POST', '/avatar')).status, 403);
  assert.strictEqual((await s.call('POST', '/messages', { to_id: 77, content: 'hi' })).status, 403);
  assert.strictEqual((await s.call('GET', '/something/else')).status, 200);

  // Sandboxes are per mentor and discarded on exit.
  assert.strictEqual((await s.call('GET', '/state', null, 2)).status, 403, 'a different, non-mentor id gets no sandbox');
  await s.call('POST', '/end');
  assert.strictEqual((await s.call('GET', '/state')).body.active, false);
  assert.strictEqual((await s.call('GET', '/streaks')).status, 409);

  // The whole run never wrote to the database.
  assert.deepStrictEqual(writes, [], 'guest mode must not write to the database');
  s.close();
  console.log('guest-mode.routes.test.js: ok');
})().catch(e => { console.error(e); process.exit(1); });
