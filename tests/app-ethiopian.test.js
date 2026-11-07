'use strict';
// frontend/app.js display helpers in Amharic vs English. app.js is too large to
// boot here, so the helper block is cut out of the source and run on its own.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
const a = src.indexOf('// Amharic = Ethiopian calendar (ዓ.ም) and Ethiopian clock');
const b = src.indexOf('function getRelativeTime') > a ? src.indexOf('function getRelativeTime') : -1;
const end = src.indexOf('\n}\n', src.indexOf('function formatDateTime')) + 3;
assert(a > 0 && end > a, 'helper block found');
const block = src.slice(a, end);

function run(lang) {
  const ctx = { currentLanguage: lang, window: {}, console };
  ctx.window.EthCal = require('../frontend/ethiopian-calendar.js');
  ctx.EthCal = ctx.window.EthCal;
  vm.createContext(ctx);
  vm.runInContext(`function getUserTimezone() { return 'Africa/Addis_Ababa'; }\n${block}`, ctx);
  return ctx;
}

const am = run('am'), en = run('en');
const AT = '2026-11-06T06:00:00Z'; // 09:00 in Addis

// Amharic: Ethiopian clock and calendar
assert.strictEqual(am.formatTime(AT), 'ጠዋት 3 ሰዓት');
assert.strictEqual(am.formatDateTime(AT), 'ጥቅምት 27 2019 ዓ.ም፣ ጠዋት 3 ሰዓት');
assert.strictEqual(am.fmtDueDate('2026-11-06'), 'ጥቅምት 27 2019 ዓ.ም');
assert.strictEqual(am.fmtDueDate('2026-11-06T00:00:00.000Z'), 'ጥቅምት 27 2019 ዓ.ም', 'a due-date timestamp is read as that day');
assert.strictEqual(am.fmtCalDate(AT), 'ጥቅምት 27 2019 ዓ.ም');
// 22:00Z is already the next day in Ethiopia (UTC+3)
assert.strictEqual(am.fmtCalDate('2026-11-06T22:00:00Z'), 'ጥቅምት 28 2019 ዓ.ም');

// English is unchanged
assert(/^0?9:00\s?AM$/i.test(en.formatTime(AT)), 'English clock stays 9:00 AM: ' + en.formatTime(AT));
assert(/Nov 6, 2026/.test(en.formatDateTime(AT)));
assert.strictEqual(en.ethOn(), false);

// Amharic without the module loaded falls back to the old behaviour instead of throwing
const noMod = run('am'); noMod.window.EthCal = undefined; noMod.EthCal = undefined;
assert.strictEqual(noMod.ethOn(), false);
assert.doesNotThrow(() => noMod.formatTime(AT));

console.log('app.js Ethiopian display helpers test passed');
