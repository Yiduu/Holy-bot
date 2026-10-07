// Goals v2 UI: one-time, progressive and challenge goals with a calendar and
// per-day tick lists. Used in two places:
//   - the mentor's mentee card (HolyGoals.mountMentor)
//   - the mentee's dashboard card (HolyGoals.mountMentee)
// Plain DOM, one delegated click handler per mount, no libraries. Runs after
// app.js and borrows its globals (apiFetch, escapeHtml, showToast, haptic,
// menteeIcon, currentUser, currentLanguage).
(function () {
  'use strict';

  const L = {
    en: {
      new_goal: 'New goal', type_one: 'One-time task', type_prog: 'Progressive', type_chal: 'Challenge',
      type_one_d: 'A single action with a due date', type_prog_d: 'Repeat it several times, track each',
      type_chal_d: 'Start to end date, tasks every day',
      f_title: 'Title', f_due: 'Due date (optional)', f_deadline: 'Deadline (optional)', f_target: 'How many times',
      f_start: 'Start', f_end: 'End', f_daily: 'Daily tasks', f_daily_ph: 'Daily task', f_more: 'Add another task',
      f_reminder: 'Daily reminder', create: 'Create', cancel: 'Cancel', save: 'Save', edit: 'Edit', del: 'Delete',
      today: 'Today', day: 'Day', done: 'Done', missed: 'Missed', partial: 'Partial', upcoming: 'Upcoming',
      in_progress: 'In progress', skipped: 'Skipped', skip: 'Skip', restore: 'Restore', finished: 'Completed',
      n_of_m: '{n} of {m} done', streak: 'Streak', missed_n: 'Missed', add_task: 'Add a task for this day',
      add: 'Add', hint_future: 'Tasks unlock on the day.', hint_closed: 'This day has passed and is closed. Ask your mentor to reopen it.',
      hint_mentor_past: 'Past day. Ticking reopens it.', note_ph: 'Add a note (optional)', save_note: 'Save note',
      confirm_del: 'Delete this goal and all its tasks?', empty: 'No goals yet. Add one to guide this mentee.',
      err: "Couldn't load goals", goals_n: 'Goals', active_n: '{n} active', add_goal: 'Add a goal',
      toast_done: 'Done! Streak: {n}', toast_done1: 'Done!', created: 'Goal created',
    },
    am: {
      new_goal: 'አዲስ ግብ', type_one: 'ነጠላ ተግባር', type_prog: 'ደረጃ በደረጃ የሚከናወን', type_chal: 'ቻሌንጅ',
      type_one_d: 'በተወሰነ ቀን ተከናውኖ የሚጠናቀቅ አንድ ተግባር', type_prog_d: 'በተወሰነ ድግግሞሽ ደረጃ በደረጃ የሚከናወን ግብ',
      type_chal_d: 'ከተወሰነ መጀመሪያ እስከ መጨረሻ ቀን በየዕለቱ የሚከናወን ልምምድ',
      f_title: 'የግቡ ርዕስ', f_due: 'የማጠናቀቂያ ቀን (አማራጭ)', f_deadline: 'የመጨረሻ ቀን (አማራጭ)', f_target: 'የድግግሞሽ ብዛት',
      f_start: 'የመጀመሪያ ቀን', f_end: 'የማብቂያ ቀን', f_daily: 'የዕለት ተግባራት', f_daily_ph: 'የዕለት ተግባር (ምሳሌ፡ የጠዋት ጸሎት)', f_more: 'ተጨማሪ ተግባር ጨምር',
      f_reminder: 'የዕለት ማስታወሻ ሰዓት', create: 'ግቡን መዝግብ', cancel: 'ሰርዝ', save: 'አስቀምጥ', edit: 'አስተካክል', del: 'አስወግድ',
      today: 'ዛሬ', day: 'ቀን', done: 'ተጠናቋል', missed: 'ያመለጠ', partial: 'በከፊል የተከናወነ', upcoming: 'በቀጣይ',
      in_progress: 'በሂደት ላይ', skipped: 'የተዘለለ', skip: 'ዝለል', restore: 'ወደ ነበረበት መልስ', finished: 'በተሟላ ሁኔታ ተጠናቋል',
      n_of_m: '{n} ከ{m} ተከናውኗል', streak: 'ተከታታይ ቀናት', missed_n: 'ያመለጡ ቀናት', add_task: 'ለዚህ ቀን አዲስ ተግባር ጨምር',
      add: 'ጨምር', hint_future: 'የዚህ ቀን ተግባራት የሚከፈቱት በቀኑ ሲደረስ ነው።', hint_closed: 'ይህ ቀን አልፏል። እንደገና እንዲከፈት አማካሪዎን ይጠይቁ።',
      hint_mentor_past: 'ያለፈ ቀን ነው። ምልክት ሲያደርጉበት እንደገና ይከፈታል።', note_ph: 'ስለ አፈጻጸሙ ማስታወሻ ይጻፉ (አማራጭ)', save_note: 'ማስታወሻውን መዝግብ',
      confirm_del: 'ይህ ግብ እና ተግባራቱ ሁሉ ይሰረዙ?', empty: 'እስካሁን የተቀመጠ ግብ የለም። ተመካሪዎን ለመምራት አዲስ ግብ ያስቀምጡ።',
      err: 'ግቦችን መጫን አልተቻለም', goals_n: 'የእድገት ግቦች', active_n: '{n} በሂደት ላይ', add_goal: 'አዲስ ግብ መድብ',
      toast_done: 'ተከናውኗል! {n} ተከታታይ ቀናት', toast_done1: 'ተከናውኗል!', created: 'ግቡ በተሳካ ሁኔታ ተመዝግቧል',
    },
  };
  const tr = (k, r) => {
    let s = (L[currentLanguage] || L.en)[k] || L.en[k] || k;
    if (r) for (const [a, b] of Object.entries(r)) s = s.replace(`{${a}}`, b);
    return s;
  };
  const esc = s => escapeHtml(String(s ?? ''));

  // ── dates (UTC math on YYYY-MM-DD strings; "today" is Ethiopia's date) ──
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Addis_Ababa' });
  const d10 = s => String(s).substring(0, 10);
  const utc = s => { const [y, m, d] = d10(s).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const addDays = (s, n) => new Date(utc(s) + n * 864e5).toISOString().substring(0, 10);
  const diff = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
  const fmt = (s, o) => new Date(utc(s)).toLocaleDateString(currentLanguage === 'am' ? 'am-ET' : 'en-US', { timeZone: 'UTC', ...o });

  const CHK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  // ── state ──────────────────────────────────────────────────────────────
  const store = { mentor: {}, mine: null };   // goals by mentee id / for the signed-in mentee
  const ui = { sel: {}, edit: {}, note: {}, form: {}, ftype: {} };
  const mounts = { mentor: {}, mentee: null };

  // Lookups are scoped to the list that was clicked, so the same goal shown in
  // two lists can never resolve to the other list's copy.
  const goalsOf = root => root.dataset.role === 'mentor' ? (store.mentor[root.dataset.mentee] || []) : (store.mine || []);
  const findGoal = (id, root) => goalsOf(root).find(g => g.id === id);
  const findTask = (id, root) => { for (const g of goalsOf(root)) { const t = g.tasks.find(x => x.id === id); if (t) return { g, t }; } return null; };

  function upsert(list, goal) {
    const i = list.findIndex(g => g.id === goal.id);
    if (i >= 0) list[i] = goal; else list.unshift(goal);
  }
  function applyGoal(goal) {
    if (!goal?.id) return;
    const mid = String(goal.mentee_id);
    if (store.mentor[mid]) upsert(store.mentor[mid], goal);
    if (store.mine && mid === String(currentUser?.telegram_id)) upsert(store.mine, goal);
  }

  // ── rules mirrored from utils/goalRules.js (server is the authority) ──
  function lock(role, g, t) {
    const td = today();
    if (t.status === 'skipped') return 'skipped';
    if (role === 'mentor') return g.type === 'challenge' && t.due_date && d10(t.due_date) > td ? 'future' : null;
    if (g.status === 'archived' || t.status === 'missed') return 'closed';
    if (!t.due_date) return null;
    const due = d10(t.due_date);
    if (due < td) return 'closed';
    return g.type === 'challenge' && due > td ? 'future' : null;
  }

  // ── rendering ──────────────────────────────────────────────────────────
  function taskRow(g, t, role) {
    const lk = lock(role, g, t);
    const on = t.status === 'done';
    let sub = '';
    if (t.status === 'missed') sub = tr('missed');
    else if (t.status === 'skipped') sub = tr('skipped');
    else if (lk === 'future') sub = tr('upcoming');
    else if (g.type !== 'challenge' && t.due_date && !on) sub = fmt(t.due_date, { month: 'short', day: 'numeric' });
    const tools = role === 'mentor' ? `
      <button type="button" class="hg-mini" data-act="skip" data-task="${t.id}">${tr(t.status === 'skipped' ? 'restore' : 'skip')}</button>
      <button type="button" class="hg-mini hg-mini-ic" data-act="deltask" data-task="${t.id}" aria-label="${tr('del')}">${menteeIcon('trash', 13)}</button>` : '';
    let note = '';
    if (role === 'mentee' && ui.note[t.id] && on && !lk) {
      note = `<div class="hg-note"><textarea maxlength="500" rows="2" data-note="${t.id}" placeholder="${tr('note_ph')}">${esc(t.note || '')}</textarea>
        <button type="button" class="hg-btn hg-btn-sm" data-act="savenote" data-task="${t.id}">${tr('save_note')}</button></div>`;
    } else if (t.note) {
      note = `<div class="hg-note-view">${esc(t.note)}</div>`;
    }
    return `<div class="hg-trow">
      <button type="button" class="hg-task${on ? ' dn' : ''}${t.status === 'missed' ? ' ms' : ''}" data-act="tick" data-task="${t.id}" aria-pressed="${on}"${lk ? ' disabled' : ''}>
        <span class="hg-ck${on ? ' on' : ''}">${on ? CHK : ''}</span>
        <span class="hg-tt">${esc(t.title)}</span><span class="hg-sub">${sub}</span>
      </button>${tools}</div>${note}`;
  }

  function dayInfo(g, date) {
    const ts = g.tasks.filter(t => d10(t.due_date) === date && t.status !== 'skipped');
    const done = ts.filter(t => t.status === 'done').length;
    return { ts, done, all: ts.length > 0 && done === ts.length };
  }

  function defaultSel(g) {
    const td = today(), s = d10(g.start_date), e = d10(g.end_date);
    return td < s ? s : td > e ? e : td;
  }

  function calendar(g) {
    const td = today(), sel = ui.sel[g.id] || defaultSel(g);
    const s = d10(g.start_date), e = d10(g.end_date);
    const wd = Array.from({ length: 7 }, (_, i) => `<div class="hg-w">${fmt(`2024-01-0${i + 1}`, { weekday: 'narrow' })}</div>`).join('');
    let html = '';
    const months = [];
    for (let d = s; d <= e; d = addDays(d, 1)) if (!months.includes(d.substring(0, 7))) months.push(d.substring(0, 7));
    for (const m of months) {
      const first = `${m}-01`;
      const from = first < s ? s : first;
      let cells = '';
      const lead = (new Date(utc(from)).getUTCDay() + 6) % 7;
      cells += '<div class="hg-d x"></div>'.repeat(lead);
      for (let d = from; d <= e && d.substring(0, 7) === m; d = addDays(d, 1)) {
        const info = dayInfo(g, d);
        let cls = 'sk';
        if (info.ts.length) cls = d === td ? 'n' : info.all ? 'k' : d > td ? 'f' : info.done ? 'pt' : 's';
        const mark = info.all ? CHK : (cls === 's' ? '<b></b>' : '');
        cells += `<button type="button" class="hg-d ${cls}${d === sel ? ' sel' : ''}" data-act="day" data-goal="${g.id}" data-date="${d}" aria-label="${fmt(d, { month: 'long', day: 'numeric' })}"><span>${Number(d.substring(8))}</span>${mark}</button>`;
      }
      html += `<div class="hg-month">${fmt(from, { month: 'long', year: 'numeric' })}</div><div class="hg-cal">${wd}${cells}</div>`;
    }
    return html;
  }

  function dayPanel(g, role) {
    const td = today(), sel = ui.sel[g.id] || defaultSel(g);
    const info = dayInfo(g, sel);
    const tasks = g.tasks.filter(t => d10(t.due_date) === sel);
    let st = ['', tr('upcoming')];
    if (info.all) st = ['ok', tr('done')];
    else if (sel < td) st = info.done ? ['go', tr('partial')] : ['bad', tr('missed')];
    else if (sel === td) st = ['go', tr('in_progress')];
    const n = diff(d10(g.start_date), sel) + 1;
    let hint = '';
    if (sel > td) hint = tr('hint_future');
    else if (sel < td) hint = role === 'mentor' ? tr('hint_mentor_past') : tr('hint_closed');
    const add = role === 'mentor' ? `<div class="hg-addrow"><input type="text" maxlength="200" data-addtask="${g.id}" placeholder="${tr('add_task')}"><button type="button" class="hg-btn hg-btn-sm" data-act="addtask" data-goal="${g.id}">${tr('add')}</button></div>` : '';
    return `<div class="hg-day">
      <div class="hg-day-head"><div><div class="hg-eyebrow">${tr('day')} ${n}${sel === td ? ' · ' + tr('today') : ''}</div>
      <div class="hg-day-title">${fmt(sel, { weekday: 'long', month: 'long', day: 'numeric' })}</div></div>
      <span class="hg-chip ${st[0]}">${st[1]}</span></div>
      <div class="hg-eyebrow">${tr('n_of_m', { n: info.done, m: info.ts.length })}</div>
      ${tasks.map(t => taskRow(g, t, role)).join('')}${add}
      ${hint ? `<div class="hg-hint">${hint}</div>` : ''}</div>`;
  }

  function editPanel(g) {
    return `<div class="hg-form">
      <label>${tr('f_title')}<input type="text" maxlength="200" data-f="title" value="${esc(g.title)}"></label>
      <label>${tr('f_end')}<input type="date" data-f="end" value="${g.end_date ? d10(g.end_date) : ''}"${g.type === 'one_time' || g.type === 'progressive' ? '' : ' min="' + d10(g.start_date) + '"'}></label>
      ${g.type === 'challenge' ? `<label>${tr('f_reminder')}<input type="time" data-f="reminder" value="${g.reminder_time ? String(g.reminder_time).substring(0, 5) : ''}"></label>` : ''}
      <div class="hg-actions"><button type="button" class="hg-btn hg-btn-ghost" data-act="cancel-edit" data-goal="${g.id}">${tr('cancel')}</button>
      <button type="button" class="hg-btn" data-act="save-edit" data-goal="${g.id}">${tr('save')}</button></div></div>`;
  }

  function goalHtml(g, role) {
    const s = g.stats || { done: 0, total: 0, pct: 0, streak: 0, missed: 0 };
    const meta = [];
    if (g.type === 'challenge') meta.push(`${fmt(g.start_date, { month: 'short', day: 'numeric' })} – ${fmt(g.end_date, { month: 'short', day: 'numeric' })}`);
    else if (g.end_date) meta.push(fmt(g.end_date, { month: 'short', day: 'numeric' }));
    meta.push(tr('n_of_m', { n: s.done, m: s.total }));
    if (g.type === 'challenge') { meta.push(`${tr('streak')} ${s.streak}`); if (s.missed) meta.push(`${tr('missed_n')} ${s.missed}`); }
    const typeLbl = tr(g.type === 'one_time' ? 'type_one' : g.type === 'progressive' ? 'type_prog' : 'type_chal');
    const tools = role === 'mentor' ? `
      <button type="button" class="hg-mini hg-mini-ic" data-act="edit" data-goal="${g.id}" aria-label="${tr('edit')}">${menteeIcon('pencil', 13)}</button>
      <button type="button" class="hg-mini hg-mini-ic" data-act="delgoal" data-goal="${g.id}" aria-label="${tr('del')}">${menteeIcon('trash', 13)}</button>` : '';
    const body = g.type === 'challenge'
      ? `<div class="hg-calwrap">${calendar(g)}</div>${dayPanel(g, role)}`
      : `<div class="hg-list">${g.tasks.map(t => taskRow(g, t, role)).join('')}</div>`;
    return `<section class="hg-goal${g.status === 'completed' ? ' fin' : ''}" data-goal-id="${g.id}">
      <header class="hg-head"><div class="hg-headtxt"><span class="hg-chip">${typeLbl}</span>
      <h4 class="hg-title">${esc(g.title)}</h4><div class="hg-meta">${meta.join(' · ')}${g.status === 'completed' ? ' · ' + tr('finished') : ''}</div></div>${tools}</header>
      <div class="hg-bar"><i style="transform:scaleX(${s.pct / 100})"></i></div>
      ${ui.edit[g.id] ? editPanel(g) : ''}${body}</section>`;
  }

  function formHtml(menteeId) {
    const type = ui.ftype[menteeId] || 'challenge';
    const td = today();
    const opt = (v, k, d) => `<button type="button" class="hg-type${type === v ? ' on' : ''}" data-act="ftype" data-type="${v}"><b>${tr(k)}</b><small>${tr(d)}</small></button>`;
    let fields = '';
    if (type === 'one_time') fields = `<label>${tr('f_due')}<input type="date" data-f="due" min="${td}"></label>`;
    if (type === 'progressive') fields = `<label>${tr('f_target')}<input type="number" data-f="target" min="1" max="50" value="5" inputmode="numeric"></label>
      <label>${tr('f_deadline')}<input type="date" data-f="deadline" min="${td}"></label>`;
    if (type === 'challenge') fields = `<div class="hg-row2"><label>${tr('f_start')}<input type="date" data-f="start" min="${td}" value="${td}"></label>
      <label>${tr('f_end')}<input type="date" data-f="end" min="${td}" value="${addDays(td, 29)}"></label></div>
      <div class="hg-tpl"><span>${tr('f_daily')}</span><div data-tpl><input type="text" maxlength="200" placeholder="${tr('f_daily_ph')}"></div>
      <button type="button" class="hg-link" data-act="addtpl">+ ${tr('f_more')}</button></div>
      <label>${tr('f_reminder')}<input type="time" data-f="reminder" value="20:00"></label>`;
    return `<div class="hg-form hg-new">
      <div class="hg-types">${opt('one_time', 'type_one', 'type_one_d')}${opt('progressive', 'type_prog', 'type_prog_d')}${opt('challenge', 'type_chal', 'type_chal_d')}</div>
      <label>${tr('f_title')}<input type="text" maxlength="200" data-f="title"></label>${fields}
      <div class="hg-actions"><button type="button" class="hg-btn hg-btn-ghost" data-act="cancel-new">${tr('cancel')}</button>
      <button type="button" class="hg-btn" data-act="create">${tr('create')}</button></div></div>`;
  }

  function paint(root, force) {
    const a = document.activeElement;
    if (!force && a && root.contains(a) && a.matches('textarea,input')) return; // never repaint under a typing user
    const role = root.dataset.role, mid = root.dataset.mentee;
    const goals = goalsOf(root);
    let html = '';
    if (role === 'mentor') {
      html += ui.form[mid] ? formHtml(mid)
        : `<button type="button" class="hg-add" data-act="new">${menteeIcon('plus', 13)}<span>${tr('new_goal')}</span></button>`;
    }
    html += goals.length ? goals.map(g => goalHtml(g, role)).join('') : (role === 'mentor' ? `<div class="hg-empty">${tr('empty')}</div>` : '');
    root.innerHTML = html;
    if (role === 'mentor') updateBadge(root, goals);
    else updateMenteeCard(goals);
  }

  function updateBadge(root, goals) {
    const btn = root.previousElementSibling;
    if (!btn?.classList.contains('goal-toggle-btn')) return;
    const active = goals.filter(g => g.status === 'active').length;
    btn.querySelector('span').innerHTML = `${menteeIcon('target', 14)}${esc(active ? `${tr('goals_n')} · ${tr('active_n', { n: active })}` : tr('add_goal'))}`;
  }

  function updateMenteeCard(goals) {
    const m = mounts.mentee;
    if (!m) return;
    m.card.classList.toggle('hidden', !goals.length);
    const live = goals.flatMap(g => g.tasks).filter(t => t.status !== 'skipped');
    const td = today();
    const todays = live.filter(t => t.due_date && d10(t.due_date) === td);
    const set = todays.length ? todays : live;
    const label = document.getElementById('myGoalsProgressLabel');
    if (label) label.textContent = `${set.filter(t => t.status === 'done').length}/${set.length}`;
    const ring = document.getElementById('myGoalsProgressTrack');
    if (ring) ring.innerHTML = '';
  }

  const repaintAll = () => {
    Object.values(mounts.mentor).forEach(r => r.isConnected && paint(r));
    if (mounts.mentee?.list.isConnected) paint(mounts.mentee.list);
  };

  // ── actions ────────────────────────────────────────────────────────────
  const fail = e => showToast(e?.message || tr('err'), 'error');
  const ask = (msg, ok) => {
    const tg = window.Telegram?.WebApp;
    if (tg?.showConfirm) tg.showConfirm(msg, y => y && ok()); else if (window.confirm(msg)) ok();
  };

  async function tick(root, taskId) {
    const f = findTask(taskId, root);
    if (!f) return;
    const { g, t } = f;
    const role = root.dataset.role;
    if (lock(role, g, t)) return;
    const prev = { status: t.status, completed_at: t.completed_at };
    const want = t.status !== 'done';
    t.status = want ? 'done' : (t.due_date && d10(t.due_date) < today() ? 'missed' : 'pending'); // optimistic
    if (want && role === 'mentee') ui.note[t.id] = true;
    haptic('light');
    paint(root, true);
    try {
      const goal = await apiFetch(`/api/goals/tasks/${taskId}`, { method: 'PATCH', body: { done: want } });
      applyGoal(goal);
      if (want && role === 'mentee') showToast(goal.stats?.streak && g.type === 'challenge' ? tr('toast_done', { n: goal.stats.streak }) : tr('toast_done1'), 'success');
    } catch (e) {
      Object.assign(t, prev);
      delete ui.note[t.id];
      fail(e);
    }
    repaintAll();
  }

  async function call(path, method, body) {
    try { const g = await apiFetch(path, { method, body }); if (g?.id) applyGoal(g); repaintAll(); return g; }
    catch (e) { fail(e); return null; }
  }

  function readForm(root, menteeId) {
    const form = root.querySelector('.hg-new');
    const v = k => form.querySelector(`[data-f="${k}"]`)?.value || '';
    const type = ui.ftype[menteeId] || 'challenge';
    const body = { mentee_id: menteeId, type, title: v('title').trim() };
    if (type === 'one_time') body.due_date = v('due') || null;
    if (type === 'progressive') { body.target_count = parseInt(v('target'), 10); body.end_date = v('deadline') || null; }
    if (type === 'challenge') {
      body.start_date = v('start'); body.end_date = v('end'); body.reminder_time = v('reminder') || null;
      body.task_template = [...form.querySelectorAll('[data-tpl] input')].map(i => i.value.trim()).filter(Boolean);
      if (!body.task_template.length) body.task_template = [body.title];
    }
    return body;
  }

  function onClick(root, e) {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const act = el.dataset.act, mid = root.dataset.mentee, gid = el.dataset.goal, tid = el.dataset.task;
    switch (act) {
      case 'tick': return tick(root, tid);
      case 'day': ui.sel[gid] = el.dataset.date; return paint(root, true);
      case 'new': ui.form[mid] = true; return paint(root, true);
      case 'cancel-new': ui.form[mid] = false; return paint(root, true);
      case 'ftype': ui.ftype[mid] = el.dataset.type; return paint(root, true);
      case 'addtpl': {
        const box = root.querySelector('[data-tpl]');
        if (box.children.length < 4) { const i = document.createElement('input'); i.type = 'text'; i.maxLength = 200; i.placeholder = tr('f_daily_ph'); box.appendChild(i); i.focus(); }
        return;
      }
      case 'create': {
        const body = readForm(root, mid);
        if (!body.title) return root.querySelector('.hg-new [data-f="title"]').focus();
        el.disabled = true;
        return apiFetch('/api/goals', { method: 'POST', body }).then(g => {
          applyGoal(g); ui.form[mid] = false; showToast(tr('created'), 'success'); repaintAll();
        }).catch(err => { el.disabled = false; fail(err); });
      }
      case 'edit': ui.edit[gid] = true; return paint(root, true);
      case 'cancel-edit': ui.edit[gid] = false; return paint(root, true);
      case 'save-edit': {
        const sec = el.closest('.hg-goal'), g = findGoal(gid, root);
        const v = k => sec.querySelector(`[data-f="${k}"]`)?.value;
        const body = {};
        if (v('title') && v('title').trim() !== g.title) body.title = v('title').trim();
        if (v('end') && v('end') !== (g.end_date ? d10(g.end_date) : '')) body.end_date = v('end');
        if (v('reminder') !== undefined && g.type === 'challenge' && v('reminder') !== (g.reminder_time ? String(g.reminder_time).substring(0, 5) : '')) body.reminder_time = v('reminder') || null;
        ui.edit[gid] = false;
        return Object.keys(body).length ? call(`/api/goals/${gid}`, 'PATCH', body) : paint(root, true);
      }
      case 'delgoal': return ask(tr('confirm_del'), async () => {
        try {
          const g = findGoal(gid, root);
          await apiFetch(`/api/goals/${gid}`, { method: 'DELETE' });
          if (g) removeGoal(gid, g.mentee_id);
          repaintAll();
        } catch (err) { fail(err); }
      });
      case 'addtask': {
        const inp = root.querySelector(`[data-addtask="${gid}"]`);
        const title = inp.value.trim();
        if (!title) return inp.focus();
        inp.value = '';
        return call(`/api/goals/${gid}/tasks`, 'POST', { title, due_date: ui.sel[gid] || defaultSel(findGoal(gid, root)) });
      }
      case 'skip': {
        const f = findTask(tid, root);
        return call(`/api/goals/tasks/${tid}`, 'PATCH', { status: f.t.status === 'skipped' ? 'restore' : 'skipped' });
      }
      case 'deltask': return call(`/api/goals/tasks/${tid}`, 'DELETE');
      case 'savenote': {
        const text = root.querySelector(`[data-note="${tid}"]`).value;
        delete ui.note[tid];
        return call(`/api/goals/tasks/${tid}`, 'PATCH', { note: text });
      }
    }
  }

  function removeGoal(id, menteeId) {
    const mid = String(menteeId);
    if (store.mentor[mid]) store.mentor[mid] = store.mentor[mid].filter(g => g.id !== id);
    if (store.mine) store.mine = store.mine.filter(g => g.id !== id);
  }

  function bind(root) {
    if (root._hg) return;
    root._hg = true;
    root.addEventListener('click', e => onClick(root, e));
    // Enter in the add-task box adds the task
    root.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('[data-addtask]')) { e.preventDefault(); root.querySelector(`[data-act="addtask"][data-goal="${e.target.dataset.addtask}"]`)?.click(); }
    });
  }

  // ── public API ─────────────────────────────────────────────────────────
  async function mountMentor(panel, menteeId) {
    const mid = String(menteeId);
    panel.classList.add('hg-root');
    panel.dataset.role = 'mentor';
    panel.dataset.mentee = mid;
    mounts.mentor[mid] = panel;
    bind(panel);
    if (store.mentor[mid]) paint(panel, true);
    else panel.innerHTML = '<div class="loading-spinner" style="margin:12px auto;width:20px;height:20px"></div>';
    try {
      store.mentor[mid] = await apiFetch(`/api/goals/mentee/${mid}`);
      paint(panel, true);
    } catch (e) {
      if (!store.mentor[mid]) panel.innerHTML = `<div class="hg-empty">${tr('err')}</div>`;
    }
  }

  async function mountMentee(card, list) {
    list.classList.add('hg-root');
    list.dataset.role = 'mentee';
    card.classList.add('hg-mounted');
    mounts.mentee = { card, list };
    bind(list);
    try {
      store.mine = await apiFetch('/api/goals/mine');
      paint(list, true);
    } catch (e) { console.error('Goals load error:', e); }
  }

  function onRealtime(goal) { applyGoal(goal); repaintAll(); }
  function onRealtimeDeleted({ id, mentee_id } = {}) { removeGoal(id, mentee_id); repaintAll(); }

  window.HolyGoals = { mountMentor, mountMentee, onRealtime, onRealtimeDeleted };
})();
