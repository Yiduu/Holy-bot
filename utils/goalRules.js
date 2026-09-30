'use strict';

// Shared rule for follow-up goals: once a goal's due date has passed, it is
// closed. It can no longer be marked done (or un-done). A mentor can reopen
// it by setting a new due date.
//
// "Today" is the date in Ethiopia, the same reference the nightly
// missed-goal job in bot.js uses, so both always agree on what "passed" means.

function ethiopiaToday() {
  // en-CA formats as YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Addis_Ababa' });
}

// dueDate may be 'YYYY-MM-DD' or a full timestamp string; null/empty = no due date.
function isGoalPastDue(dueDate, today = ethiopiaToday()) {
  if (!dueDate) return false;
  return String(dueDate).substring(0, 10) < today;
}

module.exports = { ethiopiaToday, isGoalPastDue };
