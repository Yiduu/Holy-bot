'use strict';

// Per-task reminders and the 11:00 PM last reminder. Kept apart from bot.js
// (the Telegram sender and the database are passed in) so the scheduling
// rules can be unit-tested with a fake database.
//
//  - sendTaskReminders: a pending task of today with remind_at is sent once,
//    from its time until REMINDER_GRACE_MIN later. It is claimed
//    (task_reminder_sent_on = today) with a conditional UPDATE BEFORE it is
//    sent, so overlapping runs, retries and restarts can't send it twice.
//  - sendFinalReminders: from FINAL_REMINDER_TIME, once per goal per day, for
//    goals that use per-task reminders today, listing only unfinished tasks.
//
// The bot runs both every minute (see bot.js), so a reminder lands on its
// minute instead of up to five minutes late.

const R = require('./goalRules');

function makeGoalReminders({ supabase, notifyTaskReminder, notifyFinalReminder, now = R.ethiopiaTimeHM, log = console }) {
  async function sendTaskReminders(today) {
    const nowHM = now();
    const notClaimed = `task_reminder_sent_on.is.null,task_reminder_sent_on.neq.${today}`;
    const { data: rows, error } = await supabase
      .from('goal_tasks')
      .select('id, goal_id, mentee_id, title, remind_at, goals!inner(id, title, type, status)')
      .eq('status', 'pending')
      .eq('goals.status', 'active')
      .eq('due_date', today)
      .not('remind_at', 'is', null)
      .or(notClaimed);
    if (error) throw error;

    const due = (rows || []).filter(r => R.isTaskReminderDue(String(r.remind_at).substring(0, 5), nowHM));
    if (!due.length) return 0;

    const { data: claimed } = await supabase.from('goal_tasks')
      .update({ task_reminder_sent_on: today }).in('id', due.map(r => r.id)).or(notClaimed).select('id');
    const ok = new Set((claimed || []).map(r => r.id));

    let sent = 0;
    for (const r of due.filter(r => ok.has(r.id))) {
      try { await notifyTaskReminder(r.mentee_id, r.goals, r); sent++; }
      catch (e) { log.error('[Scheduler] Task reminder failed:', e.message); }
    }
    if (sent) log.log(`[Scheduler] Sent ${sent} per-task reminder(s).`);
    return sent;
  }

  async function sendFinalReminders(today) {
    if (now() < R.FINAL_REMINDER_TIME) return 0;
    const { data: withRemind, error } = await supabase
      .from('goal_tasks')
      .select('goal_id, goals!inner(status)')
      .eq('goals.status', 'active')
      .eq('due_date', today)
      .not('remind_at', 'is', null);
    if (error) throw error;
    const goalIds = [...new Set((withRemind || []).map(r => r.goal_id))];
    if (!goalIds.length) return 0;

    const { data: pending, error: pErr } = await supabase
      .from('goal_tasks')
      .select('id, goal_id, mentee_id, title, goals!inner(id, title, type, status, final_reminder_sent_on)')
      .eq('status', 'pending')
      .eq('due_date', today)
      .in('goal_id', goalIds)
      .order('position', { ascending: true });
    if (pErr) throw pErr;

    const byGoal = new Map();
    for (const t of pending || []) {
      if (String(t.goals.final_reminder_sent_on || '').substring(0, 10) === today) continue;
      if (!byGoal.has(t.goal_id)) byGoal.set(t.goal_id, { goal: t.goals, menteeId: t.mentee_id, tasks: [] });
      byGoal.get(t.goal_id).tasks.push(t);
    }
    if (!byGoal.size) return 0;

    const { data: claimed } = await supabase.from('goals')
      .update({ final_reminder_sent_on: today }).in('id', [...byGoal.keys()])
      .or(`final_reminder_sent_on.is.null,final_reminder_sent_on.neq.${today}`).select('id');
    let sent = 0;
    for (const g of claimed || []) {
      const { goal, menteeId, tasks } = byGoal.get(g.id);
      try { await notifyFinalReminder(menteeId, goal, tasks); sent++; }
      catch (e) { log.error('[Scheduler] Final reminder failed:', e.message); }
    }
    if (sent) log.log(`[Scheduler] Sent ${sent} last reminder(s).`);
    return sent;
  }

  return { sendTaskReminders, sendFinalReminders };
}

module.exports = { makeGoalReminders };
