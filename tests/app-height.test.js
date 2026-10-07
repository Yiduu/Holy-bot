// Run: node tests/app-height.test.js
// Coming back from the home screen, Telegram's WebView can report a ~0 height;
// that must never be applied (it collapsed every page), and a forced re-measure
// must work even when a scheduled animation frame never fires.
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const vm = require('vm');
const ok = n => console.log('  ✓', n);
const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
const start = src.indexOf('let _lastAppHeight = 0;'), end = src.indexOf('applyAppHeight();\r\nwindow.Telegram');
const block = src.slice(start, end > 0 ? end : src.indexOf('applyAppHeight();\nwindow.Telegram'));

const make = (tg, innerHeight, rafNever) => {
  const props = {}; let raf = null;
  const ctx = {
    window: { Telegram: { WebApp: tg }, innerHeight, visualViewport: { height: innerHeight } },
    document: { documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } } },
    requestAnimationFrame: (f) => { if (!rafNever) raf = f; return 1; }, cancelAnimationFrame: () => { raf = null; }, Math, Number,
  };
  vm.createContext(ctx); vm.runInContext(block + '\nthis.api = { applyAppHeight, computeAppHeight };', ctx);
  return { api: ctx.api, props, flush: () => raf && raf() };
};

(() => {
  let t = make({ viewportStableHeight: 0, viewportHeight: 0 }, 0);
  t.api.applyAppHeight(true); assert.equal(t.props['--app-height'], undefined); ok('a 0 px reading from a just-woken WebView is ignored');

  t = make({ viewportStableHeight: 12, viewportHeight: 12 }, 700);
  t.api.applyAppHeight(true); assert.equal(t.props['--app-height'], '700px'); ok('implausibly small Telegram height → falls back to the real window height');

  t = make({ viewportStableHeight: 640, viewportHeight: 700 }, 800);
  t.api.applyAppHeight(true); assert.equal(t.props['--app-height'], '640px'); ok('normal reading is applied');

  t = make({ viewportStableHeight: 640 }, 800, true);       // frames never fire (suspended WebView)
  t.api.applyAppHeight(); t.api.applyAppHeight(true);
  assert.equal(t.props['--app-height'], '640px'); ok('forced re-measure works even if a scheduled frame never fires');

  console.log('\nALL APP-HEIGHT CHECKS PASSED');
})();
