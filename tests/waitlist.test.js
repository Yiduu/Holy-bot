// Run: node tests/waitlist.test.js   (no network, no Supabase needed)
// Real utils.notifyMentorWaitlist against an in-memory Supabase fake, plus the
// mentor-card helpers pulled straight out of frontend/app.js.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const ok = n => console.log('  ✓', n);

const db = { users: [], mentorship_assignments: [], mentor_waitlist: [] };
function from(table) {
  let op = 'select', filters = [], single = false, head = false, lim = null, order = null;
  const q = {
    select(_c, o) { head = !!(o && o.head); q._count = !!(o && o.count); return q; },
    eq(c, v) { filters.push(r => String(r[c]) === String(v)); return q; },
    in(c, a) { filters.push(r => a.map(String).includes(String(r[c]))); return q; },
    order(c, o) { order = [c, o && o.ascending !== false]; return q; },
    limit(n) { lim = n; return q; }, single() { single = true; return q; },
    delete() { op = 'delete'; return q; },
    then(res, rej) { return Promise.resolve(run()).then(res, rej); },
  };
  function run() {
    let rows = db[table].filter(r => filters.every(f => f(r)));
    if (op === 'delete') { db[table] = db[table].filter(r => !rows.includes(r)); return { data: rows, error: null }; }
    if (order) rows = rows.slice().sort((a, b) => (a[order[0]] > b[order[0]] ? 1 : -1) * (order[1] ? 1 : -1));
    if (lim) rows = rows.slice(0, lim);
    if (head) return { data: null, error: null, count: rows.length };
    if (single) return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'none' } };
    return { data: rows, error: null };
  }
  return q;
}
const supabase = { from };
const { notifyMentorWaitlist } = require(root + '/utils');

const sent = []; let failFor = new Set();
const deps = {
  getUserLang: async (id) => (id === 20 ? 'am' : 'en'),
  safeSend: async (id, text, extra) => { if (failFor.has(id)) return undefined; sent.push({ id, text, extra }); return { message_id: 1 }; },
};
const reset = () => { sent.length = 0; failFor = new Set(); db.mentor_waitlist = []; db.mentorship_assignments = []; };
const wait = (id, user, t) => db.mentor_waitlist.push({ id, mentor_id: 1, user_id: user, created_at: t });

(async () => {
  db.users.push({ telegram_id: 1, accepting_requests: true, anonymous_id: 'Shepherd_1', user_settings: { display_name: 'Pastor_Sam*<b>', max_mentees: 2 } });

  // the card is sent as HTML: names with _ * < > must arrive intact and escaped
  reset(); wait(1, 10, 1);
  assert.equal(await notifyMentorWaitlist(supabase, 1, deps), 1);
  assert.ok(sent[0].text.includes('Pastor_Sam*&lt;b&gt;') && !sent[0].text.includes('<b>Pastor') && sent[0].extra.parse_mode === 'HTML'); ok('mentor name is HTML-escaped in a card');
  assert.equal(sent[0].extra.reply_markup.inline_keyboard[0][0].web_app.url.endsWith('?start=mentors') && sent[0].extra.reply_markup.inline_keyboard[0][0].style === 'success', true); ok('message carries a green "Open mentors" button that deep-links to the Mentors page');
  assert.equal(db.mentor_waitlist.length, 0); ok('notified person is removed from the list');

  // Amharic users get Amharic
  reset(); wait(1, 20, 1); await notifyMentorWaitlist(supabase, 1, deps);
  assert.ok(/ክፍት ቦታ/.test(sent[0].text) && sent[0].extra.reply_markup.inline_keyboard[0][0].text === 'አማካሪዎችን ክፈት'); ok('Amharic message + button for Amharic users');

  // one message per free spot, oldest first
  reset(); wait(1, 10, 1); wait(2, 11, 2); wait(3, 12, 3);
  db.mentorship_assignments.push({ id: 1, mentor_id: 1, user_id: 99, is_active: true });   // max 2, 1 taken -> 1 free
  assert.equal(await notifyMentorWaitlist(supabase, 1, deps), 1); assert.deepEqual(sent.map(s => s.id), [10]);
  assert.deepEqual(db.mentor_waitlist.map(w => w.user_id), [11, 12]); ok('one person per free spot, oldest first; the rest keep their place');

  // full / paused: nobody is told
  reset(); wait(1, 10, 1); db.mentorship_assignments.push({ id: 1, mentor_id: 1, user_id: 98, is_active: true }, { id: 2, mentor_id: 1, user_id: 99, is_active: true });
  assert.equal(await notifyMentorWaitlist(supabase, 1, deps), 0); assert.equal(db.mentor_waitlist.length, 1); ok('still full → no message, list untouched');
  reset(); wait(1, 10, 1); db.users[0].accepting_requests = false;
  assert.equal(await notifyMentorWaitlist(supabase, 1, deps), 0); assert.equal(db.mentor_waitlist.length, 1); db.users[0].accepting_requests = true; ok('requests paused → no message');

  // failed delivery: stays on the list, next person still gets the spot
  reset(); wait(1, 10, 1); wait(2, 11, 2); failFor.add(10);
  assert.equal(await notifyMentorWaitlist(supabase, 1, deps), 1);
  assert.deepEqual(sent.map(s => s.id), [11]);
  assert.deepEqual(db.mentor_waitlist.map(w => w.user_id), [10]); ok('undeliverable person keeps their place and does not block the next one');

  // someone who already found a mentor is dropped without a message
  reset(); wait(1, 10, 1); wait(2, 11, 2); db.mentorship_assignments.push({ id: 5, mentor_id: 7, user_id: 10, is_active: true });
  await notifyMentorWaitlist(supabase, 1, deps); assert.deepEqual(sent.map(s => s.id), [11]); assert.equal(db.mentor_waitlist.length, 0); ok('mentee who already has a mentor is cleared quietly');

  // settings route triggers it
  const users = fs.readFileSync(path.join(root, 'routes/users.js'), 'utf8');
  assert.ok(/max_mentees !== undefined \|\| req\.body\.accepting_requests !== undefined\) \{\s*notifyMentorWaitlist\(supabase, id\)/.test(users)); ok('saving a higher limit / turning requests on triggers the waitlist');

  // ── mentor card helpers from app.js
  const app = fs.readFileSync(path.join(root, 'frontend/app.js'), 'utf8');
  const grab = (name) => { const i = app.indexOf('function ' + name); let d = 0, j = app.indexOf('{', i); for (let k = j; k < app.length; k++) { if (app[k] === '{') d++; if (app[k] === '}' && --d === 0) return app.slice(i, k + 1); } };
  const ctx = new Function('t', 'escapeHtml', `${grab('renderModernRating')}\n${grab('mentorSubLine')}\nreturn { renderModernRating, mentorSubLine };`)(
    (k, v) => (k === 'reviews_count' ? `${v.n} reviews` : k === 'reviews_count_one' ? '1 review' : k), x => String(x).replace(/</g, '&lt;'));
  const html = ctx.renderModernRating(4.6, 12);
  assert.ok(html.includes('<span class="rc-full">12 reviews</span>') && html.includes('<span class="rc-short">(12)</span>')); ok('rating shows "12 reviews" (no brackets)');
  const row = html.match(/<div class="mentor-stats-row">([\s\S]*)<\/div>\s*$/)[1];
  assert.ok(row.includes('mentor-stats-stars') && row.includes('mentor-rating-val') && row.includes('mentor-reviews-count') && !html.includes('mentor-rating-block')); ok('stars, score and review count are in ONE horizontal row');
  assert.ok(ctx.renderModernRating(5, 1).includes('1 review')); ok('singular "1 review"');
  assert.equal(ctx.mentorSubLine({ user_settings: { specialization: 'Marriage <b>' }, topics: [{ id: 1, name: 'Grief' }, { id: 2, name: 'Faith' }] }), '<div class="mc-sub">Marriage &lt;b></div>'); ok('card shows specialization only; topics are gone from the card');
  assert.equal(ctx.mentorSubLine({ user_settings: {}, topics: [{ id: 1, name: 'Grief' }] }), ''); ok('no specialization → no sub line (topics stay in the full profile)');

  console.log('\nALL WAITLIST + CARD CHECKS PASSED'); process.exit(0);
})().catch(e => { console.error('\nFAIL:', e.message, '\n', (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
