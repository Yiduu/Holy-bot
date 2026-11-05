'use strict';
// Client side of guest mode: entry card, switching to the mentee user and back,
// and the guard that stops direct fetch/XHR writes to real endpoints.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = '<!doctype html><body><div id="app"><div class="page-content"><div id="menteeStats"></div><div id="menteesList"></div></div><div id="chatInputRow"></div></div></body>';
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;

const mentor = { telegram_id: 1, role: 'mentor' };
const guestUser = { telegram_id: 9000000000001, role: 'user', is_guest: true };
let user = mentor, resets = 0; const navs = [], api = [], realFetches = [];
w.__holyBridge = { getUser: () => user, setUser: u => { user = u; }, getSocket: () => null, resetViews: () => { resets++; }, navigate: p => navs.push(p) };
w.showToast = () => {};
w.Telegram = { WebApp: { showConfirm: (_m, cb) => cb(true) } };
w.apiFetch = async (p, o = {}) => {
  api.push([o.method || 'GET', p]);
  if (p === '/api/guest/start') return { user: guestUser };
  if (p === '/api/guest/state') return { active: true, has_mentor: false, pending: [{ id: 'r1' }] };
  return { success: true };
};
w.fetch = async (url, init) => { realFetches.push([url, init?.method || 'GET']); return { ok: true, status: 200 }; };
w.Response = function (body, init) { return { status: init.status, json: async () => JSON.parse(body) }; };

w.eval(fs.readFileSync(path.join(__dirname, '../frontend/guest-mode.js'), 'utf8'));
const G = w.HolyGuest;

(async () => {
  await new Promise(r => setTimeout(r, 20));   // DOMContentLoaded
  // Entry card is on the mentees page and lets the mentor pick a persona.
  const card = w.document.getElementById('guestEntryCard');
  assert.ok(card, 'entry card rendered');
  assert.strictEqual(w.document.getElementById('menteesList').children.length, 0, 'does not touch the mentees list');
  w.document.querySelector('[data-guest-sex="F"]').click();
  assert.strictEqual(G.sex, 'F');
  assert.ok(w.document.querySelector('[data-guest-sex="F"]').classList.contains('is-on'));

  // Nothing is blocked before the preview starts.
  await w.fetch('/api/mentors/request', { method: 'POST' });
  assert.deepStrictEqual(realFetches.pop(), ['/api/mentors/request', 'POST']);

  // Start: swaps to the guest mentee, shows the bar, navigates to the dashboard.
  await G.enter();
  assert.strictEqual(G.active, true);
  assert.strictEqual(user.is_guest, true);
  assert.ok(w.document.body.classList.contains('guest-mode'));
  assert.ok(w.document.getElementById('guestBar'));
  assert.deepStrictEqual(navs, ['dashboard']);
  assert.ok(api.some(([m, p]) => m === 'POST' && p === '/api/guest/start'));
  await new Promise(r => setTimeout(r, 20));
  assert.ok(w.document.getElementById('guestAcceptBtn'), 'pending request shows "Simulate acceptance"');
  assert.ok(!w.document.getElementById('guestGoalBtn'), 'goal button only after a mentor accepts');

  // Direct writes to real endpoints are refused while active; guest + read-only media pass.
  const blocked = await w.fetch('/api/avatar', { method: 'POST' });
  assert.strictEqual(blocked.status, 403);
  await w.fetch('/api/guest/streaks/mark', { method: 'POST' });
  await w.fetch('/api/avatar/5?v=1');
  assert.deepStrictEqual(realFetches.map(x => x[0]), ['/api/guest/streaks/mark', '/api/avatar/5?v=1']);
  assert.ok(!realFetches.some(([u, m]) => u === '/api/avatar' && m === 'POST'), 'real avatar upload never reached the network');

  // Exit: mentor account restored, bar removed.
  await G.exit();
  assert.strictEqual(G.active, false);
  assert.strictEqual(user, mentor);
  assert.ok(!w.document.body.classList.contains('guest-mode'));
  assert.ok(!w.document.getElementById('guestBar'));
  assert.strictEqual(navs[navs.length - 1], 'my-mentees');
  assert.ok(resets >= 2);
  // After exit real writes work again.
  realFetches.length = 0;
  await w.fetch('/api/mentors/request', { method: 'POST' });
  assert.strictEqual(realFetches.length, 1);

  // The real apiFetch (app.js) must rewrite /api/* to /api/guest/* while active.
  {
    const src = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
    const start = src.indexOf('async function apiFetch(');
    const end = src.indexOf('// Fetch a binary attachment', start);
    const sent = [];
    const sandbox = new JSDOM('', { runScripts: 'outside-only', url: 'http://localhost/' }).window;
    sandbox.API = ''; sandbox.socket = null;
    sandbox.getTelegramData = () => ({ initData: 'x', user: { id: 1 } });
    sandbox.fetch = async u => { sent.push(u); return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) }; };
    sandbox.eval(src.slice(start, end) + '\nwindow.apiFetch = apiFetch;');
    sandbox.HolyGuest = { active: false };
    await sandbox.apiFetch('/api/mentors/request', { method: 'POST', body: {} });
    sandbox.HolyGuest.active = true;
    await sandbox.apiFetch('/api/mentors/request', { method: 'POST', body: {} });
    await sandbox.apiFetch('/api/goals/mine');
    await sandbox.apiFetch('/api/guest/state');
    assert.deepStrictEqual(sent, ['/api/mentors/request', '/api/guest/mentors/request', '/api/guest/goals/mine', '/api/guest/state']);
  }

  console.log('guest-mode.ui.test.js: ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
