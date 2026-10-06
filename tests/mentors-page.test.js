// Run: node tests/mentors-page.test.js   (needs devDependency jsdom)
// Mentors page: fixed search bar, and the language switch redrawing JS-drawn content.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const ok = n => console.log('  ✓', n);
const app = fs.readFileSync(path.join(root, 'frontend/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const loc = fs.readFileSync(path.join(root, 'frontend/locales.js'), 'utf8');

// ── layout: search + chips are a sibling ABOVE the scrolling area, not inside it
const doc = new JSDOM(html).window.document;
const page = doc.getElementById('page-mentors');
const bar = page.querySelector('.mc-sticky'); const scroller = page.querySelector('.page-content');
assert.ok(bar && scroller && bar.parentElement === page && scroller.parentElement === page); ok('search bar + chips sit outside the scrolling list (siblings under the page)');
assert.ok(bar.contains(doc.getElementById('mentorSearchInput')) && bar.contains(doc.getElementById('mentorTopicChips')) && bar.contains(doc.getElementById('mentorFilterBtn'))); ok('search, filter button and topic chips are all in the fixed bar');
assert.ok(bar.compareDocumentPosition(scroller) & 4); ok('fixed bar comes before the scrolling list');
assert.equal(doc.getElementById('mentorSearchInput').getAttribute('data-i18n'), 'search_mentors_placeholder'); ok('search placeholder is translatable');

// ── language: the new key exists in both languages
const amAt = loc.indexOf('  am: {');
for (const k of ['mentor_default_bio', 'search_mentors_placeholder', 'mentor_chip_all']) assert.ok(loc.slice(0, amAt).includes(`"${k}"`) && loc.slice(amAt).includes(`"${k}"`), k);
ok('default-bio, placeholder and "All" chip strings exist in English and Amharic');
assert.ok(!/I'm here as a mentor to walk alongside you/.test(app)); ok('no hardcoded English default bio left in the mentor card/profile');

// ── refreshLanguageContent: redraws the mentors page; leaves chat/settings alone
const grab = (name) => { const i = app.indexOf('function ' + name); let d = 0, j = app.indexOf('{', i); for (let k = j; k < app.length; k++) { if (app[k] === '{') d++; if (app[k] === '}' && --d === 0) return app.slice(i, k + 1); } };
function run(page, sheetOpen, sheetId) {
  const calls = [];
  const names = ['renderMentorTopicChips', 'updateFilterActiveIndicators', 'renderActiveMentorCard', 'renderMentorsList', 'openMentorSheet', 'loadSessions', 'loadRequests', 'loadUserTickets', 'loadJournalEntries', 'flushMentorNotes', 'loadMyMentees'];
  const stubs = names.map(n => `const ${n} = (...a) => calls.push(['${n}', ...a]);`).join('\n');
  new Function('calls', 'currentPage', '$', 'openMentorSheetId', `${stubs}\n${grab('refreshLanguageContent')}\nrefreshLanguageContent();`)(
    calls, page, () => ({ classList: { contains: () => sheetOpen } }), sheetId);
  return calls.map(c => c[0]);
}
assert.deepEqual(run('mentors', false, null), ['renderMentorTopicChips', 'updateFilterActiveIndicators', 'renderActiveMentorCard', 'renderMentorsList']); ok('mentors: chips, filter tags, active-mentor card and list are all redrawn');
assert.deepEqual(run('mentors', true, 42), ['renderMentorTopicChips', 'updateFilterActiveIndicators', 'renderActiveMentorCard', 'renderMentorsList', 'openMentorSheet']); ok('mentors: an open profile sheet is redrawn too');
assert.deepEqual(run('sessions', false, null), ['loadSessions']); assert.deepEqual(run('my-mentees', false, null), ['flushMentorNotes', 'loadMyMentees']); ok('other list pages reload (mentor notes are saved first)');
assert.deepEqual(run('chat', false, null), []); assert.deepEqual(run('settings', false, null), []); ok('chat and settings are left alone (unsaved typing is safe)');
assert.ok(/applyLanguage\(\);\s*refreshLanguageContent\(\);/.test(grab('toggleLanguage')) && /applyLanguage\(\);\s*refreshLanguageContent\(\);/.test(grab('changeLanguage'))); ok('both language switches (header button + settings) call it');

console.log('\nALL MENTORS-PAGE CHECKS PASSED'); process.exit(0);
