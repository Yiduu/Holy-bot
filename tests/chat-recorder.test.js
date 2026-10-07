// Run: node tests/chat-recorder.test.js   (needs devDependency jsdom)
// Hold-to-record gestures and microphone permission in frontend/chat-media.js:
// slide LEFT cancels, slide UP locks, a curved thumb doesn't trigger the wrong one,
// the microphone is asked for only once, and a press eaten by the first-time
// permission sheet is kept instead of thrown away.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const { JSDOM } = require('jsdom');
const ok = n => console.log('  ✓', n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boot({ micDelayMs = 0 } = {}) {
  const dom = new JSDOM(`<body>
    <div id="page-chat"><div id="chatMessages"></div>
    <div id="chatInputRow"><div id="chatComposer">
      <textarea id="chatInput"></textarea>
      <div id="recordBar" class="hidden"><span id="recTime"></span><button id="recTrash" class="hidden"></button><canvas id="recWave" class="hidden"></canvas><div id="recHint"></div></div>
      <button id="chatSendBtn" data-mode="mic"></button><div id="recLock" class="hidden"></div></div>
      <div id="emojiPicker" class="hidden"></div><div id="attachMenu" class="hidden"></div>
      <input type="file" id="attachInputMedia"/><input type="file" id="attachInputFile"/></div></div></body>`,
    { runScripts: 'dangerously', url: 'https://app.test/', pretendToBeVisual: true });
  const w = dom.window;
  const log = { added: [], toasts: [], mic: { requests: 0, stops: 0 }, swipes: [] };
  w.__log = log;
  w.URL.createObjectURL = () => 'blob:fake'; w.URL.revokeObjectURL = () => { };
  w.Telegram = { WebApp: { disableVerticalSwipes: () => log.swipes.push('off'), enableVerticalSwipes: () => log.swipes.push('on') } };
  w.navigator.mediaDevices = {
    getUserMedia: async () => {
      log.mic.requests++;
      if (micDelayMs) await sleep(micDelayMs);                      // the permission sheet
      const tr = { readyState: 'live', enabled: true, stop() { this.readyState = 'ended'; log.mic.stops++; } };
      return { getTracks: () => [tr], getAudioTracks: () => [tr] };
    },
  };
  w.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor(s, o) { this.mimeType = (o && o.mimeType) || 'audio/webm'; this.state = 'inactive'; }
    start() { this.state = 'recording'; setTimeout(() => this.ondataavailable && this.ondataavailable({ data: new w.Blob(['voice']) }), 5); }
    stop() { this.state = 'inactive'; setTimeout(() => this.onstop && this.onstop(), 5); }
  };
  w.eval(`
    var API = 'https://app.test'; var $ = id => document.getElementById(id);
    var socket = { connected: true, id: 's', emit() {} }; var currentUser = { telegram_id: 1 };
    var getTelegramData = () => ({ initData: 'i', user: { id: 1 } });
    var haptic = () => {}; var showToast = (m) => window.__log.toasts.push(m); var t = k => k;
    var escapeHtml = s => String(s); var syncChatInputHeight = () => {}; var cancelReply = () => {};
    var openImageLightbox = () => {}; window.chatState = { with: 2 };
    var renderThread = () => ''; var addMessageToChat = (m) => window.__log.added.push(m);
    var replaceOptimisticBubble = () => true;
    var sendMessage = () => window.__log.sent = (window.__log.sent || 0) + 1;
    XMLHttpRequest = class { constructor() { this.upload = {}; } open() {} setRequestHeader() {} send() {} abort() {} };
  `);
  const s = w.document.createElement('script');
  s.textContent = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat-media.js'), 'utf8');
  w.document.body.appendChild(s);
  return { w, log };
}

(async () => {
  let { w, log } = boot();
  await sleep(50); // let the page finish loading so the button is wired up
  const btn = w.document.getElementById('chatSendBtn'), bar = w.document.getElementById('recordBar');
  const input = w.document.getElementById('chatInput');
  const mode = () => btn.dataset.mode;
  const recording = () => !bar.classList.contains('hidden');
  const locked = () => !w.document.getElementById('recTrash').classList.contains('hidden');
  let pid = 0;
  const fire = (type, x, y, id, target) => {
    const e = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: id }); Object.defineProperty(e, 'pointerType', { value: 'touch' });
    (target || btn).dispatchEvent(e);
  };
  const press = (x = 300, y = 500) => { const id = ++pid; fire('pointerdown', x, y, id); return id; };
  const slide = async (id, pts) => { for (const [x, y] of pts) { fire('pointermove', x, y, id); await sleep(5); } };
  const sent = () => log.added.filter(m => m.file_type === 'voice').length;

  // 1 — hold + release sends
  let id = press(); await sleep(60); assert.ok(recording());
  await sleep(1100); fire('pointerup', 300, 500, id); await sleep(80);
  assert.equal(sent(), 1); assert.ok(!recording()); ok('hold, release → voice message sent');

  // 2 — permission asked once, even when the page is hidden WHILE holding
  //     (Telegram's own permission / system sheets hide the page)
  id = press(); await sleep(60);
  w.Object.defineProperty(w.document, 'hidden', { value: true, configurable: true });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  w.Object.defineProperty(w.document, 'hidden', { value: false, configurable: true });
  fire('pointerup', 300, 500, id); await sleep(80); assert.ok(!recording(), 'the held recording is dropped when hidden');
  id = press(); await sleep(60); await sleep(1100); fire('pointerup', 300, 500, id); await sleep(80);
  assert.equal(sent(), 2); assert.equal(log.mic.requests, 1, 'microphone requested once');
  assert.equal(log.mic.stops, 0, 'microphone not shut down by backgrounding'); ok('microphone asked for once; hiding the page no longer drops the permission');

  // 3 — slide left cancels (a little upward drift is fine)
  id = press(300, 500); await sleep(60);
  await slide(id, [[285, 498], [250, 492], [225, 490]]); assert.ok(recording(), 'not yet');
  await slide(id, [[205, 488]]); await sleep(40);
  assert.ok(!recording(), 'cancelled'); fire('pointerup', 205, 488, id); await sleep(80);
  assert.equal(sent(), 2); ok('slide left → cancelled, nothing sent');

  // 4 — slide up locks; keeps recording after the finger is lifted; send button sends
  id = press(300, 500); await sleep(60); await sleep(1100);
  await slide(id, [[299, 480], [298, 450], [298, 425]]);
  assert.ok(locked(), 'locked'); assert.equal(mode(), 'send');
  fire('pointerup', 298, 425, id); await sleep(30); assert.ok(recording() && locked()); assert.equal(sent(), 2);
  const id2 = ++pid; fire('pointerdown', 0, 0, id2); fire('pointerup', 0, 0, id2); await sleep(80);   // jsdom has no layout: the button is at 0,0
  assert.equal(sent(), 3); assert.ok(!recording()); ok('slide up → locked → send button sends it');

  // 5 — the thumb arc: up AND left, mostly up → locks, does not cancel
  id = press(300, 500); await sleep(60); await sleep(1100);
  await slide(id, [[290, 480], [270, 455], [240, 430]]);   // dx=-60, dy=-70
  assert.ok(locked(), 'locked, not cancelled'); assert.equal(sent(), 3);
  w.document.getElementById('recTrash').click(); fire('pointerup', 240, 430, id); await sleep(80);
  ok('curved slide (mostly up, a bit left) → lock, not cancel');

  // 6 — mostly left with a bit of up → cancel, not lock
  id = press(300, 500); await sleep(60); await sleep(300);
  await slide(id, [[270, 490], [230, 480], [205, 470]]);   // dx=-95, dy=-30
  assert.ok(!recording() && !locked()); fire('pointerup', 205, 470, id); await sleep(80); assert.equal(sent(), 3);
  ok('curved slide (mostly left, a bit up) → cancel, not lock');

  // 7 — release after sliding half way → still sends normally
  id = press(300, 500); await sleep(60); await sleep(1100);
  await slide(id, [[290, 495], [270, 490]]); assert.ok(recording());
  fire('pointerup', 270, 490, id); await sleep(80); assert.equal(sent(), 4);
  ok('small slide then release → sends');

  // 8 — slide that leaves the button is still followed (events only reach window)
  id = press(300, 500); await sleep(60); await sleep(1100);
  for (const [x, y] of [[298, 470], [297, 425]]) fire('pointermove', x, y, id, w);
  assert.ok(locked()); w.document.getElementById('recTrash').click(); fire('pointerup', 297, 425, id, w); await sleep(80);
  ok('slide outside the button keeps working');

  // 9 — quick tap
  log.toasts.length = 0; id = press(); await sleep(40); fire('pointerup', 300, 500, id); await sleep(80);
  assert.equal(sent(), 4); assert.ok(log.toasts.some(m => /rec_hold_hint|Hold/.test(m))); assert.ok(!recording());
  ok('quick tap → hint, nothing sent');

  // 10 — OS takes the touch (pointercancel) mid-recording → locked, not lost/sent
  id = press(); await sleep(60); await sleep(1100); fire('pointercancel', 300, 500, id); await sleep(30);
  assert.ok(recording() && locked()); assert.equal(sent(), 4);
  w.document.getElementById('recTrash').click(); await sleep(80);
  ok('touch taken by the system → recording locked instead of cancelled');

  // 11 — bin discards; text mode turns the button into send
  id = press(); await sleep(60); await sleep(1100); await slide(id, [[298, 440], [298, 420]]);
  w.document.getElementById('recTrash').click(); fire('pointerup', 298, 420, id); await sleep(80);
  assert.equal(sent(), 4); assert.ok(!recording());
  input.value = 'hello'; w.eval('updateComposerMode()'); assert.equal(mode(), 'send');
  input.value = ''; w.eval('updateComposerMode()'); ok('bin discards; button swaps mic ⇄ send');

  // 12 — Telegram's swipe-to-close is switched off while holding and back on afterwards
  assert.ok(log.swipes.includes('off') && log.swipes[log.swipes.length - 1] === 'on'); ok('Telegram vertical swipe disabled during a hold, restored after');

  // 13 — first-ever press: the permission sheet takes ~700 ms and eats the touch
  ({ w, log } = boot({ micDelayMs: 700 }));
  await sleep(50);
  const btn2 = w.document.getElementById('chatSendBtn'), bar2 = w.document.getElementById('recordBar');
  const f2 = (type, x, y, id) => { const e = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }); Object.defineProperty(e, 'pointerId', { value: id }); btn2.dispatchEvent(e); };
  f2('pointerdown', 300, 500, 1); await sleep(100); f2('pointercancel', 300, 500, 1);   // touch swallowed by the sheet
  await sleep(900);
  assert.ok(!bar2.classList.contains('hidden'), 'recording kept');
  assert.ok(!w.document.getElementById('recTrash').classList.contains('hidden'), 'and locked, so nothing is lost');
  assert.equal(log.mic.requests, 1); assert.equal(log.added.length, 0);
  w.document.getElementById('recTrash').click(); await sleep(80);
  ok('first press eaten by the permission sheet → kept as a locked recording (no second press needed)');

  console.log('\nALL RECORDER CHECKS PASSED'); process.exit(0);
})().catch(e => { console.error('\nFAILED:', e); process.exit(1); });
