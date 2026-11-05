// Guest mode for mentors ("try the app as a mentee").
//
// A mentor taps "Try guest mode" on the Home page and the app switches to the
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
      title: 'Preview as a mentee', sub: 'See the app exactly as a mentee does. Find a mentor, send a request, set up goals and try every feature. Nothing is sent to real people.',
      pick: 'Preview as', m: 'Male', f: 'Female', n: 'Not specified', start: 'Start preview',
      note: 'Mentors only see you if their mentee preference matches the option you pick.',
      bar: 'Guest preview', barSub: 'Nothing here is real',
      exit: 'Exit', accept: 'Simulate acceptance', setGoal: 'Set a goal as my mentor',
      accepted: 'Your mentor accepted (preview). Chat and goals are now unlocked.',
      goalTitle: 'Set a goal as the mentor', done: 'Done',
      blocked: 'Not available in guest preview.', starting: 'Starting…', failed: "Couldn't start the preview",
      ending: 'Exit guest preview?', endBody: 'Everything you tried here will be cleared.', stay: 'Stay', leave: 'Exit',
      guestBtn: 'Guest mode', pickTitle: 'Preview as a mentee', cancel: 'Cancel',
      homeEyebrow: 'For mentors', homeTitle: 'Experience Holy Helper as a mentee',
      homeSub: 'Run the full journey in a safe sandbox. Nobody is contacted and nothing is saved.',
      homeCta: 'Try guest mode', f1: 'Request', f2: 'Chat', f3: 'Goals', f4: 'Live session',
      guide: 'Test guide', guideSub: 'Play both sides to try every feature.',
      s1: 'Send a mentor request', s1d: 'Pick a mentor from the list and send a request.', s1b: 'Find a mentor',
      s2: 'Mentor responds', s2d: 'You are the mentor now. Accept or decline.', s2done: 'Accepted by {n}', s2lock: 'Send a request first.',
      acceptB: 'Accept', declineB: 'Decline', declined: 'Request declined (preview).',
      s3: 'Chat', s3d: 'Message your mentor. They reply on their own, or write as the mentor below.', s3b: 'Open chat',
      mentorPh: 'Write as your mentor…', send: 'Send', sent: 'Sent as your mentor.',
      s4: 'Goals', s4d: 'Set a goal as the mentor, then tick it off as the mentee.', s4b: 'Set a goal', goalsN: '{n} set',
      s5: 'Live session', s5d: 'Start a call as the mentor and join it as the mentee.', startNow: 'Start now', in10: 'In 10 min',
      openSessions: 'Open Sessions', mentorSide: 'Open mentor side', endSession: 'End session', sessionLive: 'Live now', sessionSoon: 'Scheduled',
      sessionHint: 'Open the mentor side on another device to see a real two-person call.',
      locked: 'Unlocks after your request is accepted.', sessionInvite: 'Your mentor started a live session.',
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
      guestBtn: 'የእንግዳ ሁነታ', pickTitle: 'እንደ ተመካሪ ቅድመ እይታ', cancel: 'ተው',
      homeEyebrow: 'ለአማካሪዎች', homeTitle: 'ሆሊ ሄልፐርን እንደ ተመካሪ ይለማመዱ',
      homeSub: 'ሙሉውን ጉዞ ደህንነቱ በተጠበቀ ሙከራ ውስጥ ይሞክሩ። ማንም አይደወልም፣ ምንም አይቀመጥም።',
      homeCta: 'የእንግዳ ሁነታን ሞክር', f1: 'ጥያቄ', f2: 'ውይይት', f3: 'ግቦች', f4: 'ቀጥታ ክፍለ ጊዜ',
      guide: 'የሙከራ መመሪያ', guideSub: 'ሁሉንም ባህሪያት ለመሞከር ሁለቱንም ወገን ይጫወቱ።',
      s1: 'የአማካሪ ጥያቄ ይላኩ', s1d: 'ከዝርዝሩ አማካሪ መርጠው ጥያቄ ይላኩ።', s1b: 'አማካሪ ፈልግ',
      s2: 'አማካሪው ምላሽ ይሰጣል', s2d: 'አሁን እርስዎ አማካሪው ነዎት። ይቀበሉ ወይም ውድቅ ያድርጉ።', s2done: 'በ{n} ተቀባይነት አግኝቷል', s2lock: 'መጀመሪያ ጥያቄ ይላኩ።',
      acceptB: 'ተቀበል', declineB: 'ውድቅ አድርግ', declined: 'ጥያቄው ውድቅ ሆኗል (ቅድመ እይታ)።',
      s3: 'ውይይት', s3d: 'ለአማካሪዎ መልእክት ይላኩ። እሱ በራሱ ይመልሳል፣ ወይም ከታች እንደ አማካሪ ይጻፉ።', s3b: 'ውይይት ክፈት',
      mentorPh: 'እንደ አማካሪዎ ይጻፉ…', send: 'ላክ', sent: 'እንደ አማካሪዎ ተልኳል።',
      s4: 'ግቦች', s4d: 'እንደ አማካሪ ግብ ያዘጋጁ፣ ከዚያ እንደ ተመካሪ ምልክት ያድርጉ።', s4b: 'ግብ አዘጋጅ', goalsN: '{n} ተዘጋጅቷል',
      s5: 'ቀጥታ ክፍለ ጊዜ', s5d: 'እንደ አማካሪ ጥሪ ይጀምሩና እንደ ተመካሪ ይቀላቀሉ።', startNow: 'አሁን ጀምር', in10: 'በ10 ደቂቃ',
      openSessions: 'ክፍለ ጊዜዎችን ክፈት', mentorSide: 'የአማካሪውን ጎን ክፈት', endSession: 'ክፍለ ጊዜውን ጨርስ', sessionLive: 'አሁን ቀጥታ', sessionSoon: 'ተይዟል',
      sessionHint: 'እውነተኛ የሁለት ሰው ጥሪ ለማየት የአማካሪውን ጎን በሌላ መሳሪያ ይክፈቱ።',
      locked: 'ጥያቄዎ ከተቀበለ በኋላ ይከፈታል።', sessionInvite: 'አማካሪዎ ቀጥታ ክፍለ ጊዜ ጀምሯል።',
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
    if (e.target.closest('#guestHeaderBtn')) { openPicker(); return; }
    const pick = e.target.closest('[data-guest-pick]');
    if (pick) { G.sex = pick.dataset.guestPick; paintPicker(); return; }
    if (e.target.closest('#guestPickStart')) { closePicker(); G.enter(); return; }
    if (e.target.closest('#guestPickCancel') || e.target.id === 'guestPickSheet') { closePicker(); return; }
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
    btn.setAttribute('aria-label', tr('title'));
  }
  G.syncEntry = syncEntry;

  function paintPicker() {
    const box = $('guestPickChips');
    if (!box) return;
    const opt = (v, k) => `<button type="button" class="guest-chip${G.sex === v ? ' is-on' : ''}" data-guest-pick="${v}" aria-pressed="${G.sex === v}">${tr(k)}</button>`;
    box.innerHTML = opt('M', 'm') + opt('F', 'f') + opt('prefer_not', 'n');
  }
  function openPicker() {
    if (G.active || $('guestPickSheet')) return;
    const sheet = document.createElement('div');
    sheet.id = 'guestPickSheet';
    sheet.className = 'guest-pick';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.innerHTML = `
      <div class="guest-pick-card">
        <div class="guest-entry-title">${tr('pickTitle')}</div>
        <div class="guest-entry-sub">${tr('sub')}</div>
        <div class="guest-entry-label" style="margin-top:14px">${tr('pick')}</div>
        <div class="guest-chips" id="guestPickChips" role="group"></div>
        <div class="guest-entry-note">${tr('note')}</div>
        <div class="guest-pick-actions">
          <button type="button" class="btn btn-primary" id="guestPickStart">${tr('start')}</button>
          <button type="button" class="guest-act" id="guestPickCancel">${tr('cancel')}</button>
        </div>
      </div>`;
    document.body.appendChild(sheet);
    paintPicker();
  }
  function closePicker() { $('guestPickSheet')?.remove(); }

  // ── Enter / exit ────────────────────────────────────────────────────────
  G.enter = async function () {
    if (G.active) return;
    const b = bridge();
    const me = b?.getUser();
    if (!b || me?.role !== 'mentor') return toast(tr('blocked'), 'error');
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
          <span class="guest-bar-text"><b>${tr('bar')}</b><span> · ${tr('barSub')}</span></span>
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
          <div><div class="guest-entry-title">${tr('guide')}</div><div class="guest-entry-sub">${tr('guideSub')}</div></div>
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
          ? btn('sessions', tr('openSessions'), 'is-primary') + btn('mentor-side', tr('mentorSide')) + btn('end-session', tr('endSession')) + `<div class="guest-step-hint">${tr('sessionHint')}</div>`
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
  }
  function closeGoalSheet() {
    const sheet = $('guestGoalSheet');
    if (!sheet) return;
    sheet.remove();
    // Redraw the mentee's own goals card with whatever was just created.
    if (G.active && typeof window.loadDashboard === 'function') window.loadDashboard();
  }

  document.addEventListener('DOMContentLoaded', syncEntry);
  syncEntry();
  if (typeof window.toggleLanguage === 'function') {
    const origToggle = window.toggleLanguage;
    window.toggleLanguage = function () { const r = origToggle.apply(this, arguments); setTimeout(syncEntry, 50); return r; };
  }
  console.log('[guest] guest-mode.js loaded; header button:', !!$('guestHeaderBtn'));
})();
