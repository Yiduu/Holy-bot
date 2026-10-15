'use strict';
// Chat History (mentor, read-only): the privacy rules.
//   node tests/chat-history.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const mentorRoutes = require('../routes/mentors');

// Minimal chainable stand-in for the supabase client: every builder call returns
// itself, and awaiting it resolves with whatever `respond(table, calls)` says.
function fakeSupabase(respond) {
  const log = [];
  return {
    log,
    from(table) {
      const calls = [];
      const b = new Proxy({}, {
        get(_, prop) {
          if (prop === 'then') {
            return (ok, bad) => {
              log.push({ table, calls });
              return Promise.resolve(respond(table, calls)).then(ok, bad);
            };
          }
          return (...args) => { calls.push([String(prop), ...args]); return b; };
        },
      });
      return b;
    },
  };
}

async function serve(supabase) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, _res, next) => { req.telegramUser = { id: 100 }; next(); };
  app.use('/api/mentors', mentorRoutes(supabase, requireAuth, { to() { return { emit() {} }; } }, new Map()));
  const server = await new Promise(r => { const s = http.createServer(app).listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/mentors`;
  return { base, close: () => server.close() };
}

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const A3 = '33333333-3333-4333-8333-333333333333';
const user = (id) => ({ telegram_id: id, anonymous_id: 'U' + id, user_settings: { display_name: 'Mentee ' + id } });
const asg = (id, uid, allowed) => ({ id, user_id: uid, assigned_at: '2026-01-01T00:00:00Z', ended_at: '2026-02-01T00:00:00Z', ended_by: 'mentor', history_allowed: allowed, user: user(uid) });

(async () => {
  // 1) list: private chats are hidden, empty chats are skipped, chats group under their mentee
  {
    const sb = fakeSupabase((table, calls) => {
      if (table === 'mentorship_assignments') return { data: [asg(A1, 7, true), asg(A2, 7, true), asg(A3, 8, false)], error: null };
      // messages count: A1 has 5, A2 has none
      const gte = calls.find(c => c[0] === 'gte');
      return { count: 5, error: null, _gte: gte };
    });
    // make A2 empty: respond by call order instead (A1 then A2)
    let n = 0;
    const sb2 = fakeSupabase((table) => {
      if (table === 'mentorship_assignments') return { data: [asg(A1, 7, true), asg(A2, 7, true), asg(A3, 8, false)], error: null };
      n += 1;
      return { count: n === 1 ? 5 : 0, error: null };
    });
    const s = await serve(sb2);
    const body = await (await fetch(s.base + '/chat-history')).json();
    assert.strictEqual(body.length, 1, 'only the mentee with a shared, non-empty chat');
    assert.strictEqual(body[0].mentee.telegram_id, 7);
    assert.deepStrictEqual(body[0].chats.map(c => c.id), [A1]);
    assert.strictEqual(body[0].chats[0].message_count, 5);
    assert.strictEqual(sb2.log.filter(l => l.table === 'messages').length, 2, 'the private chat (A3) is never even counted');
    s.close(); void sb;
  }

  // 2) column not migrated yet: nothing is shared
  {
    const sb = fakeSupabase(() => ({ data: null, error: { message: 'column mentorship_assignments.history_allowed does not exist' } }));
    const s = await serve(sb);
    assert.deepStrictEqual(await (await fetch(s.base + '/chat-history')).json(), []);
    s.close();
  }

  // 3) one chat: the mentee switched it off -> 403 and the messages are never read
  {
    const sb = fakeSupabase((table) => table === 'mentorship_assignments'
      ? { data: asg(A1, 7, false), error: null } : { data: [], error: null });
    const s = await serve(sb);
    const r = await fetch(`${s.base}/chat-history/${A1}`);
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await r.json()).code, 'HISTORY_PRIVATE');
    assert.strictEqual(sb.log.filter(l => l.table === 'messages').length, 0, 'no message query for a private chat');
    s.close();
  }

  // 4) not the caller's mentorship / still active -> 404; bad id -> 400; bad cursor -> 400
  {
    const sb = fakeSupabase(() => ({ data: null, error: null }));
    const s = await serve(sb);
    assert.strictEqual((await fetch(`${s.base}/chat-history/${A1}`)).status, 404);
    assert.strictEqual((await fetch(`${s.base}/chat-history/not-a-uuid`)).status, 400);
    assert.strictEqual((await fetch(`${s.base}/chat-history/${A1}?before=nope`)).status, 400);
    s.close();
  }

  // 5) allowed chat: oldest -> newest, has_more when there is another page
  {
    const rows = Array.from({ length: 101 }, (_, i) => ({ id: 'm' + i, created_at: new Date(Date.UTC(2026, 0, 2, 0, 0, 200 - i)).toISOString(), content: 'x' + i }));
    const sb = fakeSupabase((table) => table === 'mentorship_assignments'
      ? { data: asg(A1, 7, true), error: null } : { data: rows, error: null });
    const s = await serve(sb);
    const body = await (await fetch(`${s.base}/chat-history/${A1}`)).json();
    assert.strictEqual(body.messages.length, 100);
    assert.strictEqual(body.has_more, true);
    assert.ok(body.messages[0].created_at < body.messages[99].created_at, 'oldest first');
    const q = sb.log.find(l => l.table === 'messages').calls;
    assert.ok(q.some(c => c[0] === 'gte') && q.some(c => c[0] === 'lte'), 'limited to the mentorship window');
    s.close();
  }

  console.log('chat-history: ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
