// Guest for mentors ("try the app as a mentee").
//
// A mentor taps "Guest" in the Home header and the app switches straight to the
// real mentee screens (find a mentor, requests, chat, goals, sessions, streak,
// journal). apiFetch (app.js) sends every call to /api/guest/*, which only
// reads and writes an in-memory sandbox. Nothing here can create a real
// request, message or notification. The "Test guide" sheet lets the mentor play
// the other side (accept, reply, set goals, start a live session) so every
// feature can be tried end to end. Exit restores the mentor account.
//
// Loaded after app.js and goals.js. Uses window.__holyBridge from app.js.
(function () {
  'use strict';

  const STR = {
    en: {
      bar: 'Guest',
      exit: 'Exit', accepted: 'Your mentor accepted. Chat and goals are now unlocked.',
      goalTitle: 'Set a goal as the mentor', done: 'Done',
      blocked: 'Not available in guest.', failed: "Couldn't start guest",
      ending: 'Exit guest?', endBody: 'Everything you tried here will be cleared.',
      guestBtn: 'Guest',
      guide: 'Test guide',
      s1: 'Send a mentor request', s1d: 'Pick a mentor from the list and send a request.', s1b: 'Find a mentor',
      s2: 'Mentor responds', s2d: 'You are the mentor now. Accept or decline.', s2done: 'Accepted by {n}', s2lock: 'Send a request first.',
      acceptB: 'Accept', declineB: 'Decline', declined: 'Request declined.',
      s3: 'Chat', s3d: 'Message your mentor, or write as the mentor below.', s3b: 'Open chat',
      mentorPh: 'Write as your mentor…', send: 'Send', sent: 'Sent as your mentor.',
      s4: 'Goals', s4d: 'Set a goal as the mentor, then tick it off as the mentee.', s4b: 'Set a goal', goalsN: '{n} set',
      s5: 'Live session', s5d: 'Start a call as the mentor and join it as the mentee.', startNow: 'Start now', in10: 'In 10 min',
      openSessions: 'Open Sessions', mentorSide: 'Open mentor side', endSession: 'End session', sessionLive: 'Live now', sessionSoon: 'Scheduled',
      locked: 'Unlocks after your request is accepted.',
    },
    am: {
      bar: 'እንግዳ',
      exit: 'ውጣ', accepted: 'አማካሪዎ ተቀብለዋል። ውይይት እና ግቦች ተከፍተዋል።',
      goalTitle: 'እንደ አማካሪ ግብ አዘጋጅ', done: 'ተጠናቀቀ',
      blocked: 'በእንግዳ ውስጥ አይገኝም።', failed: 'እንግዳን መጀመር አልተቻለም',
      ending: 'ከእንግዳ ይውጡ?', endBody: 'እዚህ የሞከሩት ሁሉ ይጸዳል።',
      guestBtn: 'እንግዳ',
      guide: 'የሙከራ መመሪያ',
      s1: 'የአማካሪ ጥያቄ ይላኩ', s1d: 'ከዝርዝሩ አማካሪ መርጠው ጥያቄ ይላኩ።', s1b: 'አማካሪ ፈልግ',
      s2: 'አማካሪው ምላሽ ይሰጣል', s2d: 'አሁን እርስዎ አማካሪው ነዎት። ይቀበሉ ወይም ውድቅ ያድርጉ።', s2done: 'በ{n} ተቀባይነት አግኝቷል', s2lock: 'መጀመሪያ ጥያቄ ይላኩ።',
      acceptB: 'ተቀበል', declineB: 'ውድቅ አድርግ', declined: 'ጥያቄው ውድቅ ሆኗል።',
      s3: 'ውይይት', s3d: 'ለአማካሪዎ መልእክት ይላኩ፣ ወይም ከታች እንደ አማካሪ ይጻፉ።', s3b: 'ውይይት ክፈት',
      mentorPh: 'እንደ አማካሪዎ ይጻፉ…', send: 'ላክ', sent: 'እንደ አማካሪዎ ተልኳል።',
      s4: 'ግቦች', s4d: 'እንደ አማካሪ ግብ ያዘጋጁ፣ ከዚያ እንደ ተመካሪ ምልክት ያድርጉ።', s4b: 'ግብ አዘጋጅ', goalsN: '{n} ተዘጋጅቷል',
      s5: 'ቀጥታ ክፍለ ጊዜ', s5d: 'እንደ አማካሪ ጥሪ ይጀምሩና እንደ ተመካሪ ይቀላቀሉ።', startNow: 'አሁን ጀምር', in10: 'በ10 ደቂቃ',
      openSessions: 'ክፍለ ጊዜዎችን ክፈት', mentorSide: 'የአማካሪውን ጎን ክፈት', endSession: 'ክፍለ ጊዜውን ጨርስ', sessionLive: 'አሁን ቀጥታ', sessionSoon: 'ተይዟል',
      locked: 'ጥያቄዎ ከተቀበለ በኋላ ይከፈታል።',
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

  document.addEventListener('click', e => {
    if (e.target.closest('#guestHeaderBtn')) { G.enter(); return; }
    if (e.target.closest('#guestExitBtn')) { confirmExit(); return; }
    if (e.target.closest('#guestGuideBtn')) { openGuide(); return; }
    if (e.target.closest('#guestGuideClose') || e.target.id === 'guestGuide') { closeGuide(); return; }
    const act = e.target.closest('[data-guest-act]');
    if (act) { runAction(act.dataset.guestAct, act); return; }
    if (e.target.closest('#guestGoalClose')) { closeGoalSheet(); return; }
  });

  // ── Entry button in the Home header ─────────────────────────────────────
  // Shown only to mentors, and hidden while a preview is running (the preview
  // bar has its own Exit). app.js calls G.syncEntry() whenever the role changes.
  function syncEntry() {
    const btn = $('guestHeaderBtn');
    if (!btn) return;
    const mentor = bridge()?.getUser?.()?.role === 'mentor';
    btn.style.display = mentor && !G.active ? 'inline-flex' : 'none';
    const lbl = $('guestHeaderLbl');
    if (lbl) lbl.textContent = tr('guestBtn');
    btn.setAttribute('aria-label', tr('guestBtn'));
  }
  G.syncEntry = syncEntry;

  // ── Enter / exit ────────────────────────────────────────────────────────
  G.enter = async function () {
    if (G.active || G._starting) return;
    const b = bridge();
    const me = b?.getUser();
    if (!b || me?.role !== 'mentor') return toast(tr('blocked'), 'error');
    G._starting = true;
    try {
      const { user } = await apiFetch('/api/guest/start', { method: 'POST', body: { sex: G.sex, lang: localStorage.getItem('language') === 'am' ? 'am' : 'en' } });
      G._mentorUser = me;
      G.active = true;
      b.setUser(user);
      muteSocket(true);
      document.body.classList.add('guest-mode');
      syncEntry();
      b.resetViews();
      mountBar();
      b.navigate('dashboard');
      refreshBar();
      G._poll = setInterval(refreshBar, 2000);
    } catch (e) {
      toast(e.message || tr('failed'), 'error');
    } finally {
      G._starting = false;
    }
  };

  G.exit = async function () {
    if (!G.active) return;
    clearInterval(G._poll); G._poll = null;
    closeGoalSheet(); closeGuide();
    try { await apiFetch('/api/guest/end', { method: 'POST' }); } catch { /* sandbox expires on its own */ }
    G.active = false;
    muteSocket(false);
    const b = bridge();
    b.setUser(G._mentorUser); G._mentorUser = null;
    document.body.classList.remove('guest-mode');
    document.body.style.removeProperty('--guest-bar-h');
    $('guestBar')?.remove();
    b.resetViews();
    syncEntry();
    b.navigate('my-mentees');
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
    document.body.style.setProperty('--guest-bar-h', 'calc(var(--safe-top, 0px) + 44px)');
  }
  async function refreshBar() {
    const bar = $('guestBar');
    if (!bar || !G.active || G._busy) return;
    G._busy = true;
    let st = null;
    try { st = await apiFetch('/api/guest/state'); } catch { G._busy = false; return; }
    G._busy = false;
    if (!G.active) return;
    if (!st?.active) { G.exit(); return; } // sandbox expired
    G._state = st;
    replay(st.events || []);
    const needs = st.pending?.length || 0;
    const key = needs + ':' + tr('guide');
    if (bar.dataset.key !== key) {
      bar.dataset.key = key;
      bar.innerHTML = `
        <div class="guest-bar-main">
          <span class="guest-dot" aria-hidden="true"></span>
          <span class="guest-bar-text"><b>${tr('bar')}</b></span>
          <button type="button" class="guest-act guest-guide-btn" id="guestGuideBtn">${tr('guide')}${needs ? `<i class="guest-badge" aria-hidden="true">${needs}</i>` : ''}</button>
          <button type="button" class="guest-exit" id="guestExitBtn">${tr('exit')}</button>
        </div>`;
    }
    if ($('guestGuide')) paintGuide();
  }

  // Replay simulated mentor events through the app's own socket handlers, so
  // the mentee screens react exactly as they do to a real mentor.
  function replay(events) {
    const sock = bridge()?.getSocket?.();
    for (const { event, payload } of events) {
      if (event === 'mentorship_request_updated' && payload?.status === 'rejected') toast(tr('declined'), 'info');
      try { (sock?.listeners?.(event) || []).forEach(fn => fn(payload)); } catch (e) { console.warn('[guest] replay failed', event, e); }
    }
  }

  // ── Test guide: play the mentor's side of every step ────────────────────
  const post = (path, body) => apiFetch('/api/guest/' + path, { method: 'POST', body: body || {} });
  const fill = (k, v) => tr(k).replace('{n}', v);

  function openGuide() {
    if ($('guestGuide')) return;
    const el = document.createElement('div');
    el.id = 'guestGuide';
    el.className = 'guest-pick';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
      <div class="guest-pick-card guest-guide-card">
        <div class="guest-guide-head">
          <div class="guest-entry-title">${tr('guide')}</div>
          <button type="button" class="guest-act" id="guestGuideClose">${tr('done')}</button>
        </div>
        <div id="guestSteps" class="guest-steps"></div>
      </div>`;
    document.body.appendChild(el);
    paintGuide(true);
  }
  function closeGuide() { $('guestGuide')?.remove(); }

  function paintGuide(force) {
    const box = $('guestSteps'), st = G._state;
    if (!box || !st) return;
    // Don't rebuild while the tester is typing a mentor message.
    const typing = box.querySelector('#guestMentorMsg');
    const key = JSON.stringify([st.requested, st.pending?.length, st.has_mentor, st.goals, st.session?.status, st.session?.id, st.rejected, tr('guide')]);
    if (!force && box.dataset.key === key) return;
    const draft = typing?.value || '';
    box.dataset.key = key;
    const has = st.has_mentor, asked = st.requested > 0 || has;
    const btn = (act, label, cls) => `<button type="button" class="guest-act${cls ? ' ' + cls : ''}" data-guest-act="${act}">${label}</button>`;
    const step = (n, title, desc, state, body) => `
      <div class="guest-step is-${state}">
        <span class="guest-step-n" aria-hidden="true">${state === 'done' ? '✓' : n}</span>
        <div class="guest-step-main">
          <div class="guest-step-title">${title}</div>
          <div class="guest-step-desc">${desc}</div>
          ${body ? `<div class="guest-step-body">${body}</div>` : ''}
        </div>
      </div>`;
    const ses = st.session;
    const steps = [
      step(1, tr('s1'), tr('s1d'), asked ? 'done' : 'now', asked ? '' : btn('find', tr('s1b'), 'is-primary')),
      step(2, tr('s2'), has ? fill('s2done', esc(st.mentor_name || '')) : (st.pending?.length ? tr('s2d') : tr('s2lock')),
        has ? 'done' : (st.pending?.length ? 'now' : 'locked'),
        st.pending?.length ? btn('accept', tr('acceptB'), 'is-primary') + btn('decline', tr('declineB')) : ''),
      step(3, tr('s3'), has ? tr('s3d') : tr('locked'), has ? 'now' : 'locked', has ? `
        ${btn('chat', tr('s3b'))}
        <div class="guest-compose"><input id="guestMentorMsg" class="guest-input" type="text" maxlength="500" placeholder="${esc(tr('mentorPh'))}" />${btn('say', tr('send'), 'is-primary')}</div>` : ''),
      step(4, tr('s4'), has ? (st.goals ? fill('goalsN', st.goals) : tr('s4d')) : tr('locked'), has ? (st.goals ? 'done' : 'now') : 'locked',
        has ? btn('goal', tr('s4b'), st.goals ? '' : 'is-primary') : ''),
      step(5, tr('s5'), has ? (ses ? `${ses.status === 'active' ? tr('sessionLive') : tr('sessionSoon')} · ${esc(ses.title)}` : tr('s5d')) : tr('locked'),
        has ? (ses ? 'done' : 'now') : 'locked',
        !has ? '' : ses
          ? btn('sessions', tr('openSessions'), 'is-primary') + btn('mentor-side', tr('mentorSide')) + btn('end-session', tr('endSession'))
          : btn('start-now', tr('startNow'), 'is-primary') + btn('start-10', tr('in10'))),
    ];
    box.innerHTML = steps.join('');
    const again = box.querySelector('#guestMentorMsg');
    if (again && draft) again.value = draft;
  }

  async function runAction(act, el) {
    const st = G._state || {};
    if (el) el.disabled = true;
    const b = bridge();
    try {
      if (act === 'find') { closeGuide(); b.navigate('mentors'); }
      else if (act === 'accept') { await simulateAccept(); }
      else if (act === 'decline') {
        const first = st.pending?.[0];
        if (first) { await post('sim/decline', { request_id: first.id }); toast(tr('declined'), 'info'); await refreshBar(); closeGuide(); b.resetViews(); b.navigate('mentors'); }
      }
      else if (act === 'chat') { closeGuide(); b.navigate('chat'); }
      else if (act === 'say') {
        const input = $('guestMentorMsg'); const text = input?.value.trim();
        if (text) { await post('sim/message', { content: text }); input.value = ''; toast(tr('sent'), 'success'); }
      }
      else if (act === 'goal') { closeGuide(); openGoalSheet(); }
      else if (act === 'start-now' || act === 'start-10') {
        await post('sim/session', { in_minutes: act === 'start-10' ? 10 : 0 });
        await refreshBar();
      }
      else if (act === 'sessions') { closeGuide(); b.navigate('sessions'); }
      else if (act === 'mentor-side' && st.session?.mentor_link) {
        const tg = window.Telegram?.WebApp;
        if (tg?.openLink) { try { tg.openLink(st.session.mentor_link); } catch { window.open(st.session.mentor_link, '_blank'); } }
        else window.open(st.session.mentor_link, '_blank');
      }
      else if (act === 'end-session') { await post('sim/session/end'); await refreshBar(); if (typeof window.loadSessions === 'function') window.loadSessions(); }
    } catch (e) { toast(e.message || tr('failed'), 'error'); }
    finally { if (el?.isConnected) el.disabled = false; }
  }

  async function simulateAccept() {
    const first = G._state?.pending?.[0];
    if (!first) return;
    try {
      await apiFetch('/api/guest/simulate-accept', { method: 'POST', body: { request_id: first.id } });
      toast(tr('accepted'), 'success');
      await refreshBar();
      bridge().resetViews();
      if (typeof window.updateMessageBadge === 'function') window.updateMessageBadge();
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
    // "New goal" opens the app's own goal page (#page-goal-new). This sheet is a
    // full-screen overlay, so it would cover that page until Done. Step aside
    // while the page is open and come back when it closes.
    const page = $('page-goal-new');
    if (page) {
      G._goalObs = new MutationObserver(() => { sheet.style.display = page.classList.contains('active') ? 'none' : ''; });
      G._goalObs.observe(page, { attributes: true, attributeFilter: ['class'] });
    }
  }
  function closeGoalSheet() {
    const sheet = $('guestGoalSheet');
    if (!sheet) return;
    G._goalObs?.disconnect(); G._goalObs = null;
    sheet.remove();
    // The goal page closes to the mentor's list underneath; land on the mentee
    // dashboard and redraw its goals card with whatever was just created.
    if (G.active) {
      bridge()?.navigate('dashboard');
      if (typeof window.loadDashboard === 'function') window.loadDashboard();
    }
  }

  document.addEventListener('DOMContentLoaded', syncEntry);
  syncEntry();
  if (typeof window.toggleLanguage === 'function') {
    const origToggle = window.toggleLanguage;
    window.toggleLanguage = function () { const r = origToggle.apply(this, arguments); setTimeout(syncEntry, 50); return r; };
  }
  console.log('[guest] guest-mode.js loaded; header button:', !!$('guestHeaderBtn'));
})();
