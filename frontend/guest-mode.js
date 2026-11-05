// Guest mode for mentors ("preview as a mentee").
//
// A mentor taps "Start preview" on the My Mentees page and the app switches to
// the real mentee screens (dashboard, find a mentor, requests, goals, streak,
// journal). apiFetch (app.js) sends every call to /api/guest/*, which only
// reads and writes an in-memory sandbox. Nothing here can create a real
// request, message or notification. Exit restores the mentor account.
//
// Loaded after app.js and goals.js. Uses window.__holyBridge from app.js.
(function () {
  'use strict';

  const STR = {
    en: {
      title: 'Preview as a mentee', sub: 'See the app exactly as a mentee does. Find a mentor, send a request, set up goals and try every feature. Nothing is sent to real people.',
      pick: 'Preview as', m: 'Male', f: 'Female', n: 'Not specified', start: 'Start preview',
      note: 'Mentors only see you if their mentee preference matches the option you pick.',
      bar: 'Guest preview', barSub: 'Nothing here is real',
      exit: 'Exit', accept: 'Simulate acceptance', setGoal: 'Set a goal as my mentor',
      accepted: 'Your mentor accepted (preview). Chat and goals are now unlocked.',
      goalTitle: 'Set a goal as the mentor', done: 'Done',
      blocked: 'Not available in guest preview.', starting: 'Starting…', failed: "Couldn't start the preview",
      ending: 'Exit guest preview?', endBody: 'Everything you tried here will be cleared.', stay: 'Stay', leave: 'Exit',
      readOnlyChat: 'Chat is read-only in the preview.',
    },
    am: {
      title: 'እንደ ተመካሪ ቅድመ እይታ', sub: 'መተግበሪያውን ተመካሪ እንደሚያየው ይመልከቱ። አማካሪ ይፈልጉ፣ ጥያቄ ይላኩ፣ ግቦችን ያዘጋጁ እና ሁሉንም ባህሪያት ይሞክሩ። ለእውነተኛ ሰዎች ምንም አይላክም።',
      pick: 'እንደ', m: 'ወንድ', f: 'ሴት', n: 'ያልተገለጸ', start: 'ቅድመ እይታ ጀምር',
      note: 'አማካሪዎች የሚያዩዎት የተመካሪ ምርጫቸው ከመረጡት አማራጭ ጋር ሲዛመድ ብቻ ነው።',
      bar: 'የእንግዳ ቅድመ እይታ', barSub: 'እዚህ ያለው ምንም እውነተኛ አይደለም',
      exit: 'ውጣ', accept: 'ተቀባይነትን አስመስል', setGoal: 'እንደ አማካሪዬ ግብ አዘጋጅ',
      accepted: 'አማካሪዎ ተቀብለዋል (ቅድመ እይታ)። ውይይት እና ግቦች ተከፍተዋል።',
      goalTitle: 'እንደ አማካሪ ግብ አዘጋጅ', done: 'ተጠናቀቀ',
      blocked: 'በእንግዳ ቅድመ እይታ ውስጥ አይገኝም።', starting: 'በመጀመር ላይ…', failed: 'ቅድመ እይታውን መጀመር አልተቻለም',
      ending: 'ከእንግዳ ቅድመ እይታ ይውጡ?', endBody: 'እዚህ የሞከሩት ሁሉ ይጸዳል።', stay: 'ቆይ', leave: 'ውጣ',
      readOnlyChat: 'በቅድመ እይታው ውይይት ለማንበብ ብቻ ነው።',
    },
  };
  const tr = k => (STR[localStorage.getItem('language')] || STR.en)[k] || STR.en[k] || k;
  const esc = s => (window.escapeHtml ? window.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const $ = id => document.getElementById(id);
  const bridge = () => window.__holyBridge;
  const toast = (m, type) => (window.showToast ? window.showToast(m, type || 'info') : console.log(m));

  const G = window.HolyGuest = { active: false, sex: 'prefer_not', _mentorUser: null, _poll: null };

  // ── Hard guard: while the preview runs, nothing may write to real endpoints ──
  // apiFetch already rewrites to /api/guest; this catches the direct fetch/XHR
  // paths (avatar upload, chat attachments) so they can never reach real data.
  function isRealApiWrite(url, method) {
    let path = '';
    try { path = new URL(url, location.origin).pathname; } catch { return false; }
    if (!path.startsWith('/api/') || path.startsWith('/api/guest/')) return false;
    if (/^\/api\/(avatar\/|messages\/file\/)/.test(path) && (!method || method === 'GET')) return false; // read-only media
    return true;
  }
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (G.active) {
      const url = typeof input === 'string' ? input : input?.url;
      const method = String(init?.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
      if (isRealApiWrite(url, method)) {
        return Promise.resolve(new Response(JSON.stringify({ error: tr('blocked'), code: 'guest_blocked' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }));
      }
    }
    return realFetch(input, init);
  };
  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (G.active && isRealApiWrite(url, String(method).toUpperCase())) {
      this.__blocked = true;
      return realOpen.call(this, method, 'about:blank', ...rest);
    }
    return realOpen.call(this, method, url, ...rest);
  };
  const realSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    if (this.__blocked) { setTimeout(() => { try { this.onerror && this.onerror(new Error('blocked')); } catch { } }, 0); return; }
    return realSend.apply(this, a);
  };

  // Real-time events belong to the real account; ignore them during the preview
  // so a live message or request can't be drawn inside the mentee screens.
  function muteSocket(on) {
    try {
      const sock = window.__holyBridge?.getSocket?.();
      if (!sock) return;
      if (on && !sock.__origOnevent) {
        sock.__origOnevent = sock.onevent;
        sock.onevent = function (packet) { if (!G.active) return sock.__origOnevent.call(this, packet); };
      } else if (!on && sock.__origOnevent) {
        sock.onevent = sock.__origOnevent; delete sock.__origOnevent;
      }
    } catch (e) { console.warn('[guest] socket mute failed', e); }
  }

  // ── Entry card on the My Mentees page ───────────────────────────────────
  function mountEntryCard() {
    const stats = $('menteeStats');
    if (!stats || $('guestEntryCard')) return;
    const card = document.createElement('div');
    card.id = 'guestEntryCard';
    card.className = 'card mb-16 guest-entry';
    stats.parentNode.insertBefore(card, stats);
    paintEntry();
  }
  function paintEntry() {
    const card = $('guestEntryCard');
    if (!card) return;
    const opt = (v, k) => `<button type="button" class="guest-chip${G.sex === v ? ' is-on' : ''}" data-guest-sex="${v}" aria-pressed="${G.sex === v}">${tr(k)}</button>`;
    card.innerHTML = `
      <div class="guest-entry-head">
        <span class="guest-entry-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </span>
        <div><div class="guest-entry-title">${tr('title')}</div><div class="guest-entry-sub">${tr('sub')}</div></div>
      </div>
      <div class="guest-entry-label">${tr('pick')}</div>
      <div class="guest-chips" role="group">${opt('M', 'm')}${opt('F', 'f')}${opt('prefer_not', 'n')}</div>
      <div class="guest-entry-note">${tr('note')}</div>
      <button type="button" class="btn btn-primary guest-start" id="guestStartBtn">${tr('start')}</button>`;
  }
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-guest-sex]');
    if (chip) { G.sex = chip.dataset.guestSex; paintEntry(); return; }
    if (e.target.closest('#guestStartBtn')) { G.enter(); return; }
    if (e.target.closest('#guestExitBtn')) { confirmExit(); return; }
    if (e.target.closest('#guestAcceptBtn')) { simulateAccept(); return; }
    if (e.target.closest('#guestGoalBtn')) { openGoalSheet(); return; }
    if (e.target.closest('#guestGoalClose')) { closeGoalSheet(); return; }
  });

  // ── Enter / exit ────────────────────────────────────────────────────────
  G.enter = async function () {
    if (G.active) return;
    const b = bridge();
    const me = b?.getUser();
    if (!b || me?.role !== 'mentor') return toast(tr('blocked'), 'error');
    const btn = $('guestStartBtn');
    if (btn) { btn.disabled = true; btn.textContent = tr('starting'); }
    try {
      const { user } = await apiFetch('/api/guest/start', { method: 'POST', body: { sex: G.sex } });
      G._mentorUser = me;
      G.active = true;
      b.setUser(user);
      muteSocket(true);
      document.body.classList.add('guest-mode');
      b.resetViews();
      mountBar();
      b.navigate('dashboard');
      refreshBar();
      G._poll = setInterval(refreshBar, 4000);
    } catch (e) {
      toast(e.message || tr('failed'), 'error');
      if (btn) { btn.disabled = false; btn.textContent = tr('start'); }
    }
  };

  G.exit = async function () {
    if (!G.active) return;
    clearInterval(G._poll); G._poll = null;
    closeGoalSheet();
    try { await apiFetch('/api/guest/end', { method: 'POST' }); } catch { /* sandbox expires on its own */ }
    G.active = false;
    muteSocket(false);
    const b = bridge();
    b.setUser(G._mentorUser); G._mentorUser = null;
    document.body.classList.remove('guest-mode');
    $('guestBar')?.remove();
    b.resetViews();
    b.navigate('my-mentees');
    paintEntry();
  };

  function confirmExit() {
    const tg = window.Telegram?.WebApp;
    if (tg?.showConfirm) { tg.showConfirm(`${tr('ending')}\n${tr('endBody')}`, ok => { if (ok) G.exit(); }); return; }
    if (window.confirm(`${tr('ending')}\n${tr('endBody')}`)) G.exit();
  }

  // ── Preview bar ─────────────────────────────────────────────────────────
  function mountBar() {
    if ($('guestBar')) return;
    const bar = document.createElement('div');
    bar.id = 'guestBar';
    bar.className = 'guest-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', tr('bar'));
    document.body.appendChild(bar);
  }
  async function refreshBar() {
    const bar = $('guestBar');
    if (!bar || !G.active) return;
    let st = null;
    try { st = await apiFetch('/api/guest/state'); } catch { return; }
    if (!st?.active) { G.exit(); return; } // sandbox expired
    G._state = st;
    const actions = [];
    if (st.pending?.length) actions.push(`<button type="button" class="guest-act" id="guestAcceptBtn">${tr('accept')}</button>`);
    if (st.has_mentor) actions.push(`<button type="button" class="guest-act" id="guestGoalBtn">${tr('setGoal')}</button>`);
    bar.innerHTML = `
      <div class="guest-bar-main">
        <span class="guest-dot" aria-hidden="true"></span>
        <span class="guest-bar-text"><b>${tr('bar')}</b><span> · ${tr('barSub')}</span></span>
        <button type="button" class="guest-exit" id="guestExitBtn">${tr('exit')}</button>
      </div>
      ${actions.length ? `<div class="guest-bar-actions">${actions.join('')}</div>` : ''}`;
  }

  async function simulateAccept() {
    const first = G._state?.pending?.[0];
    if (!first) return;
    try {
      await apiFetch('/api/guest/simulate-accept', { method: 'POST', body: { request_id: first.id } });
      toast(tr('accepted'), 'success');
      await refreshBar();
      bridge().resetViews();
      bridge().navigate('dashboard');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ── "Set a goal as my mentor": the real mentor goal composer, aimed at the sandbox ──
  function openGoalSheet() {
    if (!window.HolyGoals || $('guestGoalSheet')) return;
    const me = bridge().getUser();
    const sheet = document.createElement('div');
    sheet.id = 'guestGoalSheet';
    sheet.className = 'guest-sheet';
    sheet.innerHTML = `
      <div class="guest-sheet-head">
        <div class="guest-sheet-title">${tr('goalTitle')}</div>
        <button type="button" class="guest-act" id="guestGoalClose">${tr('done')}</button>
      </div>
      <div class="guest-sheet-body"><div id="guestGoalPanel"></div></div>`;
    document.body.appendChild(sheet);
    window.HolyGoals.mountMentor($('guestGoalPanel'), me.telegram_id);
  }
  function closeGoalSheet() {
    const sheet = $('guestGoalSheet');
    if (!sheet) return;
    sheet.remove();
    // Redraw the mentee's own goals card with whatever was just created.
    if (G.active && typeof window.loadDashboard === 'function') window.loadDashboard();
  }

  // The chat composer is hidden by CSS in guest mode; this is the matching server-side no-op.
  document.addEventListener('DOMContentLoaded', mountEntryCard);
  if (document.readyState !== 'loading') mountEntryCard();
})();
