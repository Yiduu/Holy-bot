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
      pick_title: 'What kind of goal is this?', pick_sub: 'Pick one. You will fill in the details on the next page.',
      how_title: 'How it works',
      one_hero: 'One clear action, finished by one day.',
      one_h1: 'Name the task.', one_h2: 'Pick the day it is due (or leave it open).', one_h3: 'Your mentee ticks it off when it is done.',
      prog_hero: 'A habit built one step at a time.',
      prog_h1: 'Say what to do.', prog_h2: 'Choose how many times it should be done.', prog_h3: 'Each time gets ticked off and counted.',
      chal_hero: 'A daily practice from a start day to an end day.',
      chal_h1: 'Choose the dates.', chal_h2: 'Set the tasks for each day.', chal_h3: 'Your mentee ticks them off every day and builds a streak.',
      back: 'Back',
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
      f_dur: 'Length', days_n: '{n} days', mode_same: 'Same every day', mode_custom: 'Different each day',
      plan_title: 'Plan each day', planned_n: '{n} of {m} days planned', apply_all: 'Copy to all days',
      apply_empty: 'Copy to empty days', clear_day: 'Clear (rest day)', rest_day: 'Rest day', no_tasks: 'No tasks on this day.',
      prev_month: 'Previous month', next_month: 'Next month', plan_dates_first: 'Pick valid start and end dates first (up to 120 days).',
      plan_empty: 'Add tasks for at least one day',
      t_add: 'Add task', t_remove: 'Remove task', t_max: 'Up to {n} tasks per day', t_planned: 'Planned',
      rest_note: 'Rest day. Nothing is assigned. Switch off to add tasks.', copy_to: "Copy this day's tasks to",
      copy_empty: 'Empty days', copy_all: 'All days', copy_need: 'Add a task to this day first, then you can copy it.',
      copied_n: 'Copied to {n} days', undo: 'Undo', rename: 'Rename', tick_when_done: 'Tick when finished', actions: 'Actions',
      remind_add: 'Remind', remind_at: 'Reminder at {t}', remind_title: 'Task reminder',
      rp_morning: 'Morning', rp_noon: 'Noon', rp_evening: 'Evening', rp_night: 'Night',
      rp_custom: 'Or pick a custom time', rp_save: 'Save reminder', rp_off: 'Remove', rp_close: 'Close',
      rp_copy: 'Include reminder times',
      rp_last: 'Last reminder for unfinished tasks: 11:00 PM',
    },
    am: {
      new_goal: 'አዲስ ግብ', type_one: 'ነጠላ ተግባር', type_prog: 'ደረጃ በደረጃ የሚከናወን', type_chal: 'ቻሌንጅ',
      type_one_d: 'በተወሰነ ቀን ተከናውኖ የሚጠናቀቅ አንድ ተግባር', type_prog_d: 'በተወሰነ ድግግሞሽ ደረጃ በደረጃ የሚከናወን ግብ',
      type_chal_d: 'ከተወሰነ መጀመሪያ እስከ መጨረሻ ቀን በየዕለቱ የሚከናወን ልምምድ',
      pick_title: 'ምን ዓይነት ግብ ነው?', pick_sub: 'አንዱን ይምረጡ። ዝርዝሩን በሚቀጥለው ገጽ ይሞላሉ።',
      how_title: 'እንዴት ይሠራል',
      one_hero: 'አንድ ግልጽ ተግባር፣ በአንድ ቀን የሚጠናቀቅ።',
      one_h1: 'ተግባሩን ይሰይሙ።', one_h2: 'የሚጠናቀቅበትን ቀን ይምረጡ (ወይም ክፍት ይተዉት)።', one_h3: 'ተመካሪዎ ሲጨርስ ምልክት ያደርጋል።',
      prog_hero: 'ደረጃ በደረጃ የሚገነባ ልምድ።',
      prog_h1: 'ምን መደረግ እንዳለበት ይጻፉ።', prog_h2: 'ስንት ጊዜ መከናወን እንዳለበት ይወስኑ።', prog_h3: 'እያንዳንዱ ጊዜ ምልክት ተደርጎበት ይቆጠራል።',
      chal_hero: 'ከመጀመሪያ ቀን እስከ መጨረሻ ቀን የሚደረግ የየዕለት ልምምድ።',
      chal_h1: 'ቀናቱን ይምረጡ።', chal_h2: 'ለእያንዳንዱ ቀን ተግባሮችን ያዘጋጁ።', chal_h3: 'ተመካሪዎ በየቀኑ ምልክት ያደርጋል፤ ተከታታይ ቀናትንም ይገነባል።',
      back: 'ተመለስ',
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
      f_dur: 'ርዝመት', days_n: '{n} ቀን', mode_same: 'በየቀኑ ተመሳሳይ', mode_custom: 'ለእያንዳንዱ ቀን የተለያየ',
      plan_title: 'የእያንዳንዱን ቀን እቅድ', planned_n: '{n} ከ{m} ቀናት ታቅደዋል', apply_all: 'ለሁሉም ቀናት ቅዳ',
      apply_empty: 'ለባዶ ቀናት ቅዳ', clear_day: 'አጽዳ (የእረፍት ቀን)', rest_day: 'የእረፍት ቀን', no_tasks: 'ለዚህ ቀን ተግባር የለም።',
      prev_month: 'ያለፈው ወር', next_month: 'የሚቀጥለው ወር', plan_dates_first: 'መጀመሪያ ትክክለኛ የመጀመሪያና የመጨረሻ ቀን ይምረጡ (እስከ 120 ቀን)።',
      plan_empty: 'ቢያንስ ለአንድ ቀን ተግባር ይጨምሩ',
      t_add: 'ተግባር ጨምር', t_remove: 'ተግባሩን አስወግድ', t_max: 'በቀን እስከ {n} ተግባራት', t_planned: 'የታቀደ',
      rest_note: 'የእረፍት ቀን ነው። ምንም ተግባር አልተሰጠም። ተግባር ለመጨመር ማብሪያውን ያጥፉ።', copy_to: 'የዚህን ቀን ተግባራት ቅዳ ለ',
      copy_empty: 'ባዶ ቀናት', copy_all: 'ሁሉም ቀናት', copy_need: 'መጀመሪያ ለዚህ ቀን ተግባር ይጨምሩ፣ ከዚያ መቅዳት ይችላሉ።',
      copied_n: 'ለ{n} ቀናት ተቀድቷል', undo: 'ቀልብስ', rename: 'ስም ቀይር', tick_when_done: 'ሲጨርሱ ምልክት ያድርጉ', actions: 'ተግባራት',
      remind_add: 'አስታውስ', remind_at: 'ማስታወሻ በ{t}', remind_title: 'የተግባር ማስታወሻ',
      rp_morning: 'ጠዋት', rp_noon: 'ቀትር', rp_evening: 'ምሽት', rp_night: 'ሌሊት',
      rp_custom: 'ወይም የራስዎን ሰዓት ይምረጡ', rp_save: 'ማስታወሻውን አስቀምጥ', rp_off: 'አስወግድ', rp_close: 'ዝጋ',
      rp_copy: 'የማስታወሻ ሰዓቶችንም ቅዳ',
      rp_last: 'ላልተጠናቀቁ ተግባራት የመጨረሻ ማስታወሻ፦ 11:00 PM',
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

  // Reminder times are 'HH:MM' strings in Ethiopia local time, same as the server.
  const hm = v => (v ? String(v).substring(0, 5) : '');
  const fmtHM = v => { const [h, m] = hm(v).split(':').map(Number); return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(currentLanguage === 'am' ? 'am-ET' : 'en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }); };
  const I_CLOCK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const PRESETS = [['rp_morning', '06:00'], ['rp_noon', '12:00'], ['rp_evening', '18:00'], ['rp_night', '21:00']];

  const CHK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const ICO = p => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const ICO_SKIP = ICO('<path d="M5 5l9 7-9 7z"/><path d="M19 5v14"/>');
  const ICO_RESTORE = ICO('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>');

  // ⋯ action menu. Reuses the app's click-toggle dropdown (app.js: [data-dropdown],
  // [data-dropdown-toggle], .dropdown-item), which also closes it after a pick or an
  // outside tap. Items keep their data-act hooks, so the delegated click handler
  // below treats them exactly like the old inline buttons.
  const menuItem = (act, attrs, icon, label, danger) =>
    `<button type="button" class="dropdown-item hg-item${danger ? ' hg-item-danger' : ''}" role="menuitem" data-act="${act}" ${attrs}>${icon}<span>${label}</span></button>`;
  const skipItem = t => menuItem('skip', `data-task="${t.id}"`, t.status === 'skipped' ? ICO_RESTORE : ICO_SKIP, tr(t.status === 'skipped' ? 'restore' : 'skip'));
  const menu = items => `<div class="premium-dropdown hg-menu" data-dropdown>
      <button type="button" class="hg-menu-btn" data-dropdown-toggle aria-haspopup="menu" aria-label="${tr('actions')}" title="${tr('actions')}">${menteeIcon('more', 18)}</button>
      <div class="premium-dropdown-menu" data-dropdown-menu role="menu">${items.join('')}</div></div>`;
  // One-time goal with its single task: the task is the goal, so it gets no row of its own actions.
  const isSingle = g => g.type === 'one_time' && g.tasks.length === 1;

  // ── state ──────────────────────────────────────────────────────────────
  const store = { mentor: {}, mine: null };   // goals by mentee id / for the signed-in mentee
  const ui = { sel: {}, edit: {}, note: {}, form: {}, ftype: {}, month: {}, fd: {}, ren: {}, step: {} };
  const MAX_DAYS = 120, MAX_TASKS = 4;   // keep in step with utils/goalRules.js
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
    else if (g.type !== 'challenge' && t.due_date && !on) sub = fmt(t.due_date, { month: 'short', day: 'numeric' });
    else if (role === 'mentee' && t.remind_at && !on) sub = tr('remind_at', { t: fmtHM(t.remind_at) });
    if (role === 'mentor' && ui.ren[t.id]) {
      return `<div class="hg-trow hg-ren"><input type="text" maxlength="200" data-ren="${t.id}" value="${esc(t.title)}">
        <button type="button" class="hg-btn hg-btn-sm" data-act="saveren" data-task="${t.id}">${tr('save')}</button></div>`;
    }
    // A one-time goal has exactly one task and it IS the goal, so its title is
    // never shown a second time (the goal title above already says it). Its
    // actions (edit / skip / delete) all live in the goal's own menu instead.
    const single = isSingle(g);
    const label = single ? (on ? tr('done') : tr('tick_when_done')) : esc(t.title);
    const tools = role === 'mentor' && !single ? menu([
      menuItem('rename', `data-task="${t.id}"`, menteeIcon('pencil', 14), tr('rename')),
      skipItem(t),
      menuItem('deltask', `data-task="${t.id}"`, menteeIcon('trash', 14), tr('del'), true),
    ]) : '';
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
        <span class="hg-tcol"><span class="hg-tt">${label}</span><span class="hg-sub">${sub}</span></span>
      </button>${tools}</div>${remindRow(g, t, role)}${note}`;
  }

  // Mentor: a time chip under an upcoming task of a challenge. Opens the reminder sheet.
  function remindRow(g, t, role) {
    if (role !== 'mentor' || g.type !== 'challenge' || t.status !== 'pending' || !t.due_date || d10(t.due_date) < today()) return '';
    return `<div class="hg-rrow">${chipHtml(hm(t.remind_at), `data-act="rsheet" data-scope="task" data-task="${t.id}"`)}</div>`;
  }
  // No reminder: just a clock icon (keeps rows tidy). With one: the time.
  const chipHtml = (at, attrs) => `<button type="button" class="hg-rchip${at ? ' on' : ''}" aria-label="${at ? tr('remind_at', { t: fmtHM(at) }) : tr('remind_add')}" ${attrs}>${I_CLOCK}${at ? `<span>${esc(fmtHM(at))}</span>` : ''}</button>`;

  function dayInfo(g, date) {
    const ts = g.tasks.filter(t => d10(t.due_date) === date && t.status !== 'skipped');
    const done = ts.filter(t => t.status === 'done').length;
    return { ts, done, all: ts.length > 0 && done === ts.length };
  }

  function defaultSel(g) {
    const td = today(), s = d10(g.start_date), e = d10(g.end_date);
    return td < s ? s : td > e ? e : td;
  }

  // Months touched by s..e ('YYYY-MM').
  function monthsOf(s, e) {
    const out = [];
    for (let d = s; d <= e; d = addDays(d, 1)) { const m = d.substring(0, 7); if (out[out.length - 1] !== m) out.push(m); }
    return out;
  }

  // One month is visible at a time (prev/next arrows) so a long challenge never
  // pushes the day's tasks off a phone screen. All months stay in the DOM,
  // hidden, which keeps painting simple and makes day cells easy to reach.
  function grids(key, s, e, ref, cell) {
    const months = monthsOf(s, e);
    const ov = ui.month[key], r7 = ref.substring(0, 7);
    const active = months.includes(ov) ? ov : months.includes(r7) ? r7 : months[0];
    const i = months.indexOf(active);
    const nav = (m, label, aria) => `<button type="button" class="hg-mnav" data-act="mnav" data-key="${key}" data-m="${m || ''}" aria-label="${aria}"${m ? '' : ' disabled'}>${label}</button>`;
    const head = `<div class="hg-nav">${months.length > 1 ? nav(months[i - 1], '‹', tr('prev_month')) : '<span></span>'}
      <span class="hg-month">${fmt(`${active}-01`, { month: 'long', year: 'numeric' })}</span>
      ${months.length > 1 ? nav(months[i + 1], '›', tr('next_month')) : '<span></span>'}</div>`;
    const wd = Array.from({ length: 7 }, (_, k) => `<div class="hg-w">${fmt(`2024-01-0${k + 1}`, { weekday: 'narrow' })}</div>`).join('');
    const body = months.map(m => {
      const first = `${m}-01`, from = first < s ? s : first;
      let cells = '<div class="hg-d x"></div>'.repeat((new Date(utc(from)).getUTCDay() + 6) % 7);
      for (let d = from; d <= e && d.substring(0, 7) === m; d = addDays(d, 1)) cells += cell(d);
      return `<div class="hg-cal"${m === active ? '' : ' hidden'}>${wd}${cells}</div>`;
    }).join('');
    return head + body;
  }

  function calendar(g) {
    const td = today(), sel = ui.sel[g.id] || defaultSel(g);
    return grids(g.id, d10(g.start_date), d10(g.end_date), sel, d => {
      const info = dayInfo(g, d);
      let cls = 'sk';
      if (info.ts.length) cls = d === td ? 'n' : info.all ? 'k' : d > td ? 'f' : info.done ? 'pt' : 's';
      const mark = info.all ? CHK : (cls === 's' ? '<b></b>' : '');
      return `<button type="button" class="hg-d ${cls}${d === sel ? ' sel' : ''}" data-act="day" data-goal="${g.id}" data-date="${d}" aria-label="${fmt(d, { month: 'long', day: 'numeric' })}"><span>${Number(d.substring(8))}</span>${mark}</button>`;
    });
  }

  function dayPanel(g, role) {
    const td = today(), sel = ui.sel[g.id] || defaultSel(g);
    const info = dayInfo(g, sel);
    const tasks = g.tasks.filter(t => d10(t.due_date) === sel);
    let st = ['', tr('upcoming')];
    if (!tasks.length) st = ['', tr('rest_day')];
    else if (info.all) st = ['ok', tr('done')];
    else if (sel < td) st = info.done ? ['go', tr('partial')] : ['bad', tr('missed')];
    else if (sel === td) st = ['go', tr('in_progress')];
    const n = diff(d10(g.start_date), sel) + 1;
    let hint = '';
    if (!tasks.length) hint = '';
    else if (sel > td) hint = tr('hint_future');
    else if (sel < td) hint = role === 'mentor' ? tr('hint_mentor_past') : tr('hint_closed');
    const add = role === 'mentor' ? `<div class="hg-addrow"><input type="text" maxlength="200" data-addtask="${g.id}" placeholder="${tr('add_task')}"><button type="button" class="hg-btn hg-btn-sm" data-act="addtask" data-goal="${g.id}">${tr('add')}</button></div>` : '';
    return `<div class="hg-day">
      <div class="hg-day-head"><div><div class="hg-eyebrow">${tr('day')} ${n}${sel === td ? ' · ' + tr('today') : ''}</div>
      <div class="hg-day-title">${fmt(sel, { weekday: 'long', month: 'long', day: 'numeric' })}</div></div>
      <span class="hg-chip ${st[0]}">${st[1]}</span></div>
      ${tasks.length ? `<div class="hg-eyebrow">${tr('n_of_m', { n: info.done, m: info.ts.length })}</div>` : `<div class="hg-hint">${tr('no_tasks')}</div>`}
      ${tasks.map(t => taskRow(g, t, role)).join('')}${add}
      ${hint ? `<div class="hg-hint">${hint}</div>` : ''}</div>`;
  }

  function editPanel(g) {
    return `<div class="hg-form">
      <label>${tr('f_title')}<input type="text" maxlength="200" data-f="title" value="${esc(g.title)}"></label>
      <label>${tr('f_end')}<input type="date" data-f="end" value="${g.end_date ? d10(g.end_date) : ''}"${g.type === 'one_time' || g.type === 'progressive' ? '' : ' min="' + d10(g.start_date) + '"'}></label>
      ${g.type === 'challenge' ? `<label>${tr('f_reminder')}<input type="time" data-f="reminder" value="${g.reminder_time ? String(g.reminder_time).substring(0, 5) : ''}"></label><div class="hg-hint">${tr('rp_daily_note')} ${tr('rp_last')}</div>` : ''}
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
    const tools = role === 'mentor' ? menu([
      menuItem('edit', `data-goal="${g.id}"`, menteeIcon('pencil', 14), tr('edit')),
      isSingle(g) ? skipItem(g.tasks[0]) : '',
      menuItem('delgoal', `data-goal="${g.id}"`, menteeIcon('trash', 14), tr('del'), true),
    ]) : '';
    const body = g.type === 'challenge'
      ? `<div class="hg-calwrap">${calendar(g)}</div>${dayPanel(g, role)}`
      : `<div class="hg-list">${g.tasks.map(t => taskRow(g, t, role)).join('')}</div>`;
    return `<section class="hg-goal${g.status === 'completed' ? ' fin' : ''}" data-goal-id="${g.id}">
      <header class="hg-head"><div class="hg-headtxt"><div class="hg-headrow"><span class="hg-chip">${typeLbl}</span>${tools}</div>
      <h4 class="hg-title">${esc(g.title)}</h4><div class="hg-meta">${meta.join(' · ')}${g.status === 'completed' ? ' · ' + tr('finished') : ''}</div></div></header>
      <div class="hg-bar"><i style="transform:scaleX(${s.pct / 100})"></i></div>
      ${ui.edit[g.id] ? editPanel(g) : ''}${body}</section>`;
  }

  // ── new-goal form state ──────────────────────────────────────────────
  // Kept in ui.fd so switching type, month or day never wipes what was typed.
  const newFd = () => {
    const td = today(); return {
      title: '', due: '', target: '5', deadline: '', start: td, end: addDays(td, 29),
      reminder: '20:00', mode: 'same', same: [''], sameRemind: [], plan: {}, remind: {}, rest: {}, undo: null, day: null, copyRemind: true
    };
  };
  const fd = mid => ui.fd[mid] || (ui.fd[mid] = newFd());
  const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const rangeOf = d => (isDay(d.start) && isDay(d.end) && d.end >= d.start && diff(d.start, d.end) + 1 <= MAX_DAYS) ? [d.start, d.end] : null;
  const filled = list => (list || []).map(v => String(v).trim()).filter(Boolean);

  // Copy what is currently typed in the form into ui.fd (runs on every input).
  function snap(root) {
    const form = root.querySelector('.hg-new');
    if (!form) return;
    const d = fd(root.dataset.mentee);
    for (const k of ['title', 'due', 'target', 'deadline', 'start', 'end', 'reminder']) {
      const el = form.querySelector(`[data-f="${k}"]`);
      if (el) d[k] = el.value;
    }
    const same = form.querySelectorAll('[data-tpl] input');
    if (same.length) d.same = [...same].map(i => i.value);
    const ed = form.querySelector('[data-dayedit]');
    const dayIns = ed ? [...ed.querySelectorAll('.hg-pt input')] : [];
    if (dayIns.length) d.plan[ed.dataset.dayedit] = dayIns.map(i => i.value);
  }

  // small inline icons for the planner
  const SV = p => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const I_PLUS = SV('<path d="M12 5v14M5 12h14"/>'), I_X = SV('<path d="M6 6l12 12M18 6 6 18"/>');
  const I_MOON = SV('<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>');
  const I_COPY = SV('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>');

  // One task row = number, field, remove. One add button under the list. Used by both modes.
  const taskRows = (vals, remAct, rems, scope, day) => vals.map((v, i) => `<div class="hg-pt"><span class="hg-num">${i + 1}</span>
    <input type="text" maxlength="200" placeholder="${tr('f_daily_ph')}" value="${esc(v)}">
    ${chipHtml(hm(rems?.[i]), `data-act="rsheet" data-scope="${scope}" data-i="${i}"${day ? ` data-date="${day}"` : ''}`)}
    ${vals.length > 1 ? `<button type="button" class="hg-x" data-act="${remAct}" data-i="${i}" aria-label="${tr('t_remove')}">${I_X}</button>` : ''}</div>`).join('');
  const addTask = (act, n) => n < MAX_TASKS
    ? `<button type="button" class="hg-pt-add" data-act="${act}">${I_PLUS}<span>${tr('t_add')}</span><em>${n}/${MAX_TASKS}</em></button>`
    : `<div class="hg-pt-max">${tr('t_max', { n: MAX_TASKS })}</div>`;
  // A day's non-empty titles with the reminder time that sits on the same row.
  const pairsOf = (d, day) => {
    const titles = [], rems = [];
    (d.plan[day] || []).forEach((v, i) => { const t = String(v).trim(); if (t) { titles.push(t); rems.push(hm(d.remind?.[day]?.[i])); } });
    return { titles, rems };
  };
  const dayOf = (d, r) => d.day && d.day >= r[0] && d.day <= r[1] ? d.day : r[0];

  function planStats(d, r, sel) {
    const isRest = x => !!d.rest?.[x], hasTasks = x => !isRest(x) && filled(d.plan[x]).length > 0;
    let planned = 0, nEmpty = 0, nAll = 0;
    for (let x = r[0]; x <= r[1]; x = addDays(x, 1)) {
      if (isRest(x) || hasTasks(x)) planned++;
      if (x !== sel) { nAll++; if (!isRest(x) && !hasTasks(x)) nEmpty++; }
    }
    return { planned, nEmpty, nAll, total: diff(r[0], r[1]) + 1, rest: isRest(sel), hasSel: hasTasks(sel) };
  }
  const planLabel = st => `${tr('plan_title')} · ${tr('planned_n', { n: st.planned, m: st.total })}`;
  const copyBox = (st, d) => `<div class="hg-copy">
          <div class="hg-copy-l">${I_COPY}<span>${tr('copy_to')}</span></div>
          <div class="hg-copy-b">
            <button type="button" class="hg-cb" data-act="pfill" data-scope="empty"${st.hasSel && st.nEmpty ? '' : ' disabled'}><span>${tr('copy_empty')}</span><b>${st.nEmpty}</b></button>
            <button type="button" class="hg-cb" data-act="pfill" data-scope="all"${st.hasSel && st.nAll ? '' : ' disabled'}><span>${tr('copy_all')}</span><b>${st.nAll}</b></button></div>
          <label class="hg-copy-rem"><input type="checkbox" data-act="pcopyrem"${d.copyRemind !== false ? ' checked' : ''}><span>${tr('rp_copy')}</span></label>
          ${st.hasSel || st.rest ? '' : `<div class="hg-copy-h">${tr('copy_need')}</div>`}
        </div>`;

  // Typing doesn't repaint, so keep the day dot, the "x of y planned" line and the copy box in step with it.
  function syncPlan(root) {
    const d = ui.fd[root.dataset.mentee], ed = root.querySelector('[data-dayedit]'), r = d && rangeOf(d);
    if (!ed || !r) return;
    const sel = ed.dataset.dayedit, st = planStats(d, r, sel);
    const cell = root.querySelector('.hg-d.sel');
    if (cell && !st.rest) { cell.classList.toggle('has', st.hasSel); if (st.hasSel && !cell.querySelector('b')) cell.insertAdjacentHTML('beforeend', '<b></b>'); if (!st.hasSel) cell.querySelector('b')?.remove(); }
    const eb = root.querySelector('.hg-plan > .hg-eyebrow'); if (eb) eb.textContent = planLabel(st);
    const box = root.querySelector('.hg-copy'); if (box) box.outerHTML = copyBox(st, d);
  }

  function planner(mid, d) {
    const r = rangeOf(d);
    if (!r) return `<div class="hg-hint">${tr('plan_dates_first')}</div>`;
    const [s, e] = r;
    d.rest = d.rest || {};
    const sel = dayOf(d, r);
    const isRest = x => !!d.rest[x], hasTasks = x => !isRest(x) && filled(d.plan[x]).length > 0;
    const cal = grids('form:' + mid, s, e, sel, x => {
      const cls = isRest(x) ? ' rest' : hasTasks(x) ? ' has' : '';
      const mark = isRest(x) ? I_MOON : hasTasks(x) ? '<b></b>' : '';
      return `<button type="button" class="hg-d${cls}${x === sel ? ' sel' : ''}" data-act="fday" data-date="${x}" aria-label="${fmt(x, { month: 'long', day: 'numeric' })}"><span>${Number(x.substring(8))}</span>${mark}</button>`;
    });
    const st = planStats(d, r, sel);
    const rest = isRest(sel);
    const list = d.plan[sel]?.length ? d.plan[sel] : [''];
    const body = rest
      ? `<div class="hg-restnote">${I_MOON}<span>${tr('rest_note')}</span></div>`
      : `<div class="hg-tasks">${taskRows(list, 'prem', d.remind?.[sel], 'day', sel)}</div>${addTask('padd', list.length)}`;
    return `<div class="hg-plan">
      <div class="hg-eyebrow">${planLabel(st)}</div>
      <div class="hg-calwrap">${cal}</div>
      <div class="hg-legend"><span><i></i>${tr('t_planned')}</span><span><i class="m"></i>${tr('rest_day')}</span></div>
      <div class="hg-dayedit" data-dayedit="${sel}">
        <div class="hg-dayhead">
          <div class="hg-day-title">${tr('day')} ${diff(s, sel) + 1}<small>${fmt(sel, { weekday: 'long', month: 'short', day: 'numeric' })}</small></div>
          <button type="button" class="hg-rest${rest ? ' on' : ''}" role="switch" aria-checked="${rest}" data-act="prest"><span>${tr('rest_day')}</span><span class="hg-sw"><i></i></span></button>
        </div>
        ${body}
        ${copyBox(st, d)}
        ${d.undo ? `<div class="hg-undo" role="status"><span>${tr('copied_n', { n: d.undo.n })}</span><button type="button" data-act="pundo">${tr('undo')}</button></div>` : ''}
      </div></div>`;
  }

  const TI = {
    one_time: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
    progressive: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    challenge: '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/>'
  };
  const TK = { one_time: ['type_one', 'type_one_d', 'one'], progressive: ['type_prog', 'type_prog_d', 'prog'], challenge: ['type_chal', 'type_chal_d', 'chal'] };
  const icon = (v, s = 22) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TI[v]}</svg>`;

  // Page 1: choose the type. Each card opens that type's own page.
  function pickerHtml() {
    const card = v => `<button type="button" class="hg-type hg-pick" data-act="pick" data-type="${v}">
      <span class="hg-type-ico">${icon(v)}</span>
      <span class="hg-type-txt"><b>${tr(TK[v][0])}</b><small>${tr(TK[v][1])}</small></span>
      <span class="hg-chev" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></span></button>`;
    return `<div class="hg-pagehead"><h2>${tr('pick_title')}</h2><p>${tr('pick_sub')}</p></div>
      <div class="hg-types">${card('one_time')}${card('progressive')}${card('challenge')}</div>`;
  }

  // Page 2: one page per type, with its own explanation and fields.
  function formHtml(menteeId) {
    const type = ui.ftype[menteeId] || 'challenge';
    const d = fd(menteeId), td = today();
    const k = TK[type][2];
    let fields = '';
    if (type === 'one_time') fields = `<label>${tr('f_due')}<input type="date" data-f="due" min="${td}" value="${esc(d.due)}"></label>`;
    if (type === 'progressive') fields = `<label>${tr('f_target')}<input type="number" data-f="target" min="1" max="50" value="${esc(d.target)}" inputmode="numeric"></label>
      <label>${tr('f_deadline')}<input type="date" data-f="deadline" min="${td}" value="${esc(d.deadline)}"></label>`;
    if (type === 'challenge') {
      const len = rangeOf(d) ? diff(d.start, d.end) + 1 : 0;
      const chips = [7, 14, 21, 30, 40].map(n => `<button type="button" class="hg-pill${len === n ? ' on' : ''}" data-act="dur" data-n="${n}">${tr('days_n', { n })}</button>`).join('');
      const sameList = d.same.length ? d.same : [''];
      const same = `<div class="hg-tpl"><span>${tr('f_daily')}</span><div data-tpl>${taskRows(sameList, 'trem', d.sameRemind, 'tpl')}</div>${addTask('addtpl', sameList.length)}</div>`;
      fields = `<div class="hg-row2"><label>${tr('f_start')}<input type="date" data-f="start" min="${td}" value="${esc(d.start)}"></label>
        <label>${tr('f_end')}<input type="date" data-f="end" min="${esc(d.start || td)}" value="${esc(d.end)}"></label></div>
        <div class="hg-chips" role="group" aria-label="${tr('f_dur')}">${chips}</div>
        <div class="hg-seg" role="group">
          <button type="button" class="${d.mode === 'same' ? 'on' : ''}" data-act="fmode" data-mode="same">${tr('mode_same')}</button>
          <button type="button" class="${d.mode === 'custom' ? 'on' : ''}" data-act="fmode" data-mode="custom">${tr('mode_custom')}</button></div>
        ${d.mode === 'custom' ? planner(menteeId, d) : same}
        <label>${tr('f_reminder')}<input type="time" data-f="reminder" value="${esc(d.reminder)}"></label>
        <div class="hg-hint hg-last">${I_CLOCK}<span>${tr('rp_last')}</span></div>`;
    }
    return `<div class="hg-hero"><span class="hg-type-ico hg-hero-ico">${icon(type, 28)}</span>
        <div><h2>${tr(TK[type][0])}</h2><p>${tr(k + '_hero')}</p></div></div>
      <div class="hg-how"><div class="hg-eyebrow">${tr('how_title')}</div>
        <ol><li>${tr(k + '_h1')}</li><li>${tr(k + '_h2')}</li><li>${tr(k + '_h3')}</li></ol></div>
      <div class="hg-form hg-new">
      <label>${tr('f_title')}<input type="text" maxlength="200" data-f="title" value="${esc(d.title)}"></label>${fields}
      <div class="hg-actions"><button type="button" class="hg-btn hg-btn-ghost" data-act="back">${tr('back')}</button>
      <button type="button" class="hg-btn" data-act="create">${tr('create')}</button></div></div>`;
  }

  // ── the goal pages (#page-goal-new) ───────────────────────────────────
  const pageRoot = () => document.getElementById('goalPageBody');

  function paintPage(root) {
    const mid = root.dataset.mentee;
    root.innerHTML = (ui.step[mid] || 'pick') === 'pick' ? pickerHtml() : formHtml(mid);
    if (!document.activeElement?.closest?.('.hg-root')) typingOff();
  }

  function goStep(mid, step) {
    const root = pageRoot();
    if (!root) return;
    root.classList.add('hg-root');
    root.dataset.role = 'mentor';
    root.dataset.page = '1';
    root.dataset.mentee = mid;
    bind(root);
    ui.step[mid] = step;
    paintPage(root);
    if (currentPage !== 'goal-new') showAppPageQuiet('goal-new', 'nav-my-mentees');
    const sc = root.closest('.page-content');
    if (sc) sc.scrollTop = 0;
    haptic('light');
  }

  function closePage() {
    const root = pageRoot(), mid = root?.dataset.mentee;
    if (mid) { delete ui.fd[mid]; delete ui.step[mid]; }
    if (currentPage === 'goal-new') showAppPageQuiet('my-mentees', 'nav-my-mentees');
    repaintAll();
  }

  // Back: type page -> type list -> mentees. Returns true when it handled the press.
  function back() {
    if (currentPage !== 'goal-new') return false;
    const root = pageRoot(), mid = root?.dataset.mentee;
    if (mid && ui.step[mid] && ui.step[mid] !== 'pick') { snap(root); goStep(mid, 'pick'); }
    else closePage();
    return true;
  }

  function paint(root, force) {
    if (root.dataset.page) return paintPage(root);
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
    if (!document.activeElement?.closest?.('.hg-root')) typingOff(); // a repaint can drop focus without a blur event
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
    snap(root);
    const d = fd(menteeId);
    const type = ui.ftype[menteeId] || 'challenge';
    const body = { mentee_id: menteeId, type, title: d.title.trim() };
    if (type === 'one_time') body.due_date = d.due || null;
    if (type === 'progressive') { body.target_count = parseInt(d.target, 10); body.end_date = d.deadline || null; }
    if (type === 'challenge') {
      body.start_date = d.start; body.end_date = d.end; body.reminder_time = d.reminder || null;
      if (d.mode === 'custom') {
        const r = rangeOf(d);
        const plan = {};
        if (r) for (const x of Object.keys(d.plan)) {
          if (x < r[0] || x > r[1] || d.rest?.[x]) continue;
          const { titles, rems } = pairsOf(d, x);
          if (titles.length) plan[x] = titles.map((title, i) => rems[i] ? { title, remind_at: rems[i] } : title);
        }
        if (!Object.keys(plan).length) return { error: tr('plan_empty') };
        body.day_plan = plan;
      } else {
        const tpl = [];
        d.same.forEach((v, i) => { const title = String(v).trim(); if (title) tpl.push(hm(d.sameRemind?.[i]) ? { title, remind_at: hm(d.sameRemind[i]) } : title); });
        body.task_template = tpl.length ? tpl : [body.title];
      }
    }
    return body;
  }

  function onClick(root, e) {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const act = el.dataset.act, mid = root.dataset.mentee, gid = el.dataset.goal, tid = el.dataset.task;
    switch (act) {
      case 'tick': return tick(root, tid);
      case 'day': ui.sel[gid] = el.dataset.date; delete ui.month[gid]; return paint(root, true);
      case 'mnav': ui.month[el.dataset.key] = el.dataset.m; return paint(root, true);
      case 'new': return goStep(mid, 'pick');
      case 'pick': ui.ftype[mid] = el.dataset.type; return goStep(mid, el.dataset.type);
      case 'back': return back();
      case 'cancel-new': return closePage();
      case 'fmode': fd(mid).mode = el.dataset.mode; return paint(root, true);
      case 'fday': fd(mid).undo = null; fd(mid).day = el.dataset.date; delete ui.month['form:' + mid]; return paint(root, true);
      case 'dur': { const d = fd(mid); if (isDay(d.start)) d.end = addDays(d.start, Number(el.dataset.n) - 1); return paint(root, true); }
      case 'addtpl': {
        const d = fd(mid); if (d.same.length < MAX_TASKS) d.same.push('');
        paint(root, true);
        const ins = root.querySelectorAll('[data-tpl] input'); return ins[ins.length - 1]?.focus();
      }
      case 'trem': {
        const d = fd(mid); d.same.splice(Number(el.dataset.i), 1); (d.sameRemind || []).splice(Number(el.dataset.i), 1); if (!d.same.length) d.same = [''];
        return paint(root, true);
      }
      case 'rsheet': return openReminderSheet(root, el);
      case 'pcopyrem': { const d = fd(mid); d.copyRemind = el.checked; return; }
      case 'padd': {
        const d = fd(mid), r = rangeOf(d); if (!r) return;
        const day = dayOf(d, r), cur = d.plan[day]?.length ? d.plan[day] : [''];
        if (cur.length < MAX_TASKS) d.plan[day] = [...cur, ''];
        d.undo = null; paint(root, true);
        const ins = root.querySelectorAll('[data-dayedit] .hg-pt input'); return ins[ins.length - 1]?.focus();
      }
      case 'prem': {
        const d = fd(mid), r = rangeOf(d); if (!r) return;
        const day = dayOf(d, r), cur = [...(d.plan[day] || [''])];
        cur.splice(Number(el.dataset.i), 1); d.plan[day] = cur.length ? cur : ['']; (d.remind?.[day] || []).splice(Number(el.dataset.i), 1);
        d.undo = null; return paint(root, true);
      }
      case 'prest': {   // rest day is a switch: tasks typed for the day are kept, just hidden and not sent
        const d = fd(mid), r = rangeOf(d); if (!r) return;
        const day = dayOf(d, r); d.rest = d.rest || {};
        if (d.rest[day]) delete d.rest[day]; else d.rest[day] = true;
        d.undo = null; return paint(root, true);
      }
      case 'pfill': {
        const d = fd(mid), r = rangeOf(d); if (!r) return;
        const day = dayOf(d, r), { titles: src, rems } = d.rest?.[day] ? { titles: [], rems: [] } : pairsOf(d, day);
        if (!src.length) return;
        const before = { plan: JSON.parse(JSON.stringify(d.plan)), remind: JSON.parse(JSON.stringify(d.remind || {})), rest: { ...d.rest } };   // for Undo
        let n = 0; d.rest = d.rest || {}; d.remind = d.remind || {};
        for (let x = r[0]; x <= r[1]; x = addDays(x, 1)) {
          if (x === day) continue;
          if (el.dataset.scope === 'empty' && (d.rest[x] || filled(d.plan[x]).length)) continue;
          d.plan[x] = [...src]; d.remind[x] = d.copyRemind !== false ? [...rems] : []; delete d.rest[x]; n++;
        }
        d.undo = n ? { ...before, n } : null;
        return paint(root, true);
      }
      case 'pundo': {
        const d = fd(mid); if (!d.undo) return;
        d.plan = d.undo.plan; d.remind = d.undo.remind; d.rest = d.undo.rest; d.undo = null;
        return paint(root, true);
      }
      case 'create': {
        const body = readForm(root, mid);
        if (body.error) return showToast(body.error, 'error');
        if (!body.title) return root.querySelector('.hg-new [data-f="title"]').focus();
        el.disabled = true;
        return apiFetch('/api/goals', { method: 'POST', body }).then(g => {
          applyGoal(g); showToast(tr('created'), 'success'); closePage();
        }).catch(err => { el.disabled = false; fail(err); });
      }
      case 'rename': ui.ren[tid] = true; return paint(root, true);
      case 'saveren': {
        const title = root.querySelector(`[data-ren="${tid}"]`).value.trim();
        delete ui.ren[tid];
        return title ? call(`/api/goals/tasks/${tid}`, 'PATCH', { title }) : paint(root, true);
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

  // ── keep the field being typed in above the on-screen keyboard ─────────
  // The fixed bottom nav and the keyboard both sit over the lower part of the
  // scrolling page, so a field near the bottom of the goal form ended up hidden.
  // While a goals field has focus we (1) hide the nav, (2) add scroll room under
  // the form, and (3) scroll the field into the visible area, again whenever the
  // keyboard finishes resizing the viewport.
  let kbField = null, kbTimer = 0, kbRaf = 0, kbWasOpen = false, baseH = 0;
  const viewH = () => window.visualViewport?.height || window.innerHeight;
  const typingOff = () => { kbField = null; kbWasOpen = false; document.body.classList.remove('hg-typing'); };
  function reveal(el) {
    if (!el || !el.isConnected) return;
    const sc = el.closest('.page-content');
    if (!sc) { el.scrollIntoView({ block: 'center' }); return; }
    const vv = window.visualViewport;
    const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const r = el.getBoundingClientRect();
    const top = Math.max(sc.getBoundingClientRect().top, 0);
    if (r.bottom > bottom - 24 || r.top < top + 24) sc.scrollTop += r.top - (top + (bottom - top) * 0.33);
  }
  function onFieldFocus(e) {
    const el = e.target;
    if (!el.matches || !el.matches('input:not([type="checkbox"]):not([type="radio"]), textarea')) return;
    kbField = el;
    document.body.classList.add('hg-typing');
    clearTimeout(kbTimer);
    kbTimer = setTimeout(() => reveal(kbField), 280); // after the keyboard animation; resize events cover the rest
  }
  function onFieldBlur() {
    kbField = null;
    clearTimeout(kbTimer);
    kbTimer = setTimeout(() => { // a tap on another field fires focusin right after focusout
      if (!kbField && !document.activeElement?.closest?.('.hg-root')) typingOff();
    }, 120);
  }
  // Viewport changes arrive many times per frame while the keyboard animates: handle once per frame.
  function onViewport() {
    if (kbRaf) return;
    kbRaf = requestAnimationFrame(() => {
      kbRaf = 0;
      const h = viewH();
      if (!kbField && !document.body.classList.contains('hg-typing')) { baseH = Math.max(baseH, h); return; }
      const open = baseH - h > 100;
      if (open) { kbWasOpen = true; reveal(kbField); }
      else if (kbWasOpen) { // keyboard was dismissed (back button / swipe) without the field blurring
        document.activeElement?.blur?.();
        typingOff();
      }
    });
  }
  baseH = viewH();
  window.visualViewport?.addEventListener('resize', onViewport);
  window.Telegram?.WebApp?.onEvent?.('viewportChanged', onViewport);

  // ── reminder sheet ──────────────────────────────────────────────────────
  // Bottom sheet for one task's reminder: on/off, quick times, and the phone's
  // own time picker (same <input type="time"> the live-session scheduler uses).
  // Sits on <body> so it is never clipped by the page it opened from. Max 85% of
  // the screen high with only the middle scrolling, so Save is always visible.
  let rsEl = null, rsKey = null;
  function closeReminderSheet() {
    if (!rsEl) return;
    document.removeEventListener('keydown', rsKey);
    rsEl.remove(); rsEl = null;
  }
  function openReminderSheet(root, el) {
    closeReminderSheet();
    const scope = el.dataset.scope, mid = root.dataset.mentee, i = Number(el.dataset.i), date = el.dataset.date;
    let title = '', at = '';
    if (scope === 'tpl') { const d = fd(mid); title = String(d.same[i] || '').trim(); at = hm(d.sameRemind?.[i]); }
    else if (scope === 'day') { const d = fd(mid); title = String(d.plan[date]?.[i] || '').trim(); at = hm(d.remind?.[date]?.[i]); }
    else { const f = findTask(el.dataset.task, root); if (!f) return; title = f.t.title; at = hm(f.t.remind_at); }
    let time = at;
    const ov = document.createElement('div');
    ov.className = 'hg-rs-ov';
    rsEl = ov;
    const draw = () => {
      ov.innerHTML = `<div class="hg-rs" role="dialog" aria-modal="true" aria-label="${tr('remind_title')}">
        <div class="hg-rs-head"><h3>${esc(title) || tr('remind_title')}</h3>
          <button type="button" class="hg-x" data-rs="close" aria-label="${tr('rp_close')}">${I_X}</button></div>
        <div class="hg-rs-body">
          <div class="hg-rs-presets" role="group">${PRESETS.map(([k, v]) => `<button type="button" class="hg-pill${time === v ? ' on' : ''}" data-rs="p" data-at="${v}"><b>${tr(k)}</b> ${esc(fmtHM(v))}</button>`).join('')}</div>
          <label class="hg-rs-custom">${tr('rp_custom')}<input type="time" data-rs="t" value="${time}"></label>
        </div>
        <div class="hg-rs-foot">${at ? `<button type="button" class="hg-btn hg-btn-ghost" data-rs="off">${tr('rp_off')}</button>` : ''}
          <button type="button" class="hg-btn" data-rs="save"${time ? '' : ' disabled'}>${tr('rp_save')}</button></div></div>`;
    };
    draw();
    const apply = val => {
      closeReminderSheet();
      if (scope === 'task') return call(`/api/goals/tasks/${el.dataset.task}`, 'PATCH', { remind_at: val });
      const d = fd(mid);
      if (scope === 'tpl') { d.sameRemind = d.sameRemind || []; d.sameRemind[i] = val; }
      else { d.remind = d.remind || {}; d.remind[date] = d.remind[date] || []; d.remind[date][i] = val; }
      paint(root, true);
    };
    ov.addEventListener('click', e => {
      if (e.target === ov) return closeReminderSheet();
      const b = e.target.closest('[data-rs]');
      if (!b) return;
      const k = b.dataset.rs;
      if (k === 'close') return closeReminderSheet();
      if (k === 'p') { time = b.dataset.at; return draw(); }
      if (k === 'off') return apply('');
      if (k === 'save' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) apply(time);
    });
    ov.addEventListener('input', e => {   // the native picker: a custom time replaces the preset highlight
      if (e.target.dataset.rs !== 't') return;
      time = e.target.value;
      ov.querySelectorAll('[data-rs="p"]').forEach(p => p.classList.toggle('on', p.dataset.at === time));
      const sv = ov.querySelector('[data-rs="save"]'); if (sv) sv.disabled = !time;
    });
    rsKey = e => { if (e.key === 'Escape') closeReminderSheet(); };
    document.addEventListener('keydown', rsKey);
    document.body.appendChild(ov);
    haptic('light');
    ov.querySelector('.hg-rs')?.focus?.();
  }

  function bind(root) {
    if (root._hg) return;
    root._hg = true;
    root.addEventListener('focusin', onFieldFocus);
    root.addEventListener('focusout', onFieldBlur);
    root.addEventListener('click', e => { if (e.target.closest('[data-act]') && root.querySelector('.hg-new')) snap(root); onClick(root, e); });
    root.addEventListener('input', e => {
      if (!e.target.closest('.hg-new')) return;
      snap(root); syncPlan(root);
      const d = ui.fd[root.dataset.mentee]; if (d?.undo) { d.undo = null; root.querySelector('.hg-undo')?.remove(); }
    });
    root.addEventListener('change', e => {
      if (!e.target.closest('.hg-new')) return;
      snap(root);
      if (['start', 'end'].includes(e.target.dataset.f)) paint(root, true); // planner + length chips follow the dates
    });
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

  window.HolyGoals = { mountMentor, mountMentee, onRealtime, onRealtimeDeleted, back };
})();
