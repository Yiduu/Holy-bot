// Run: node tests/chat-floating-date.test.js   (needs devDependency jsdom)
// The floating date pill: shows the date of the top-most visible messages while
// scrolling, is pushed up by the next date, and fades out when scrolling stops.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const { JSDOM } = require('jsdom');
const ok = n => console.log('  ✓', n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dom = new JSDOM(`<body><div id="page-chat" class="page active"><div id="chatMessages">
  <div class="chat-date-divider" id="d1"><span>Monday</span></div><div class="message-thread"></div>
  <div class="chat-date-divider" id="d2"><span>Today</span></div><div class="message-thread"></div></div>
  <div id="chatInputRow"><div id="chatComposer"><button id="chatSendBtn"></button></div></div></div></body>`,
  { runScripts: 'dangerously', url: 'https://app.test/', pretendToBeVisual: true });
const w = dom.window, doc = w.document;
w.eval(`var $ = id => document.getElementById(id); var t = k => k; var socket = {}; window.chatState = { with: 2 };
  var haptic = () => {}; var showToast = () => {}; var escapeHtml = s => String(s); var syncChatInputHeight = () => {};`);
const s = doc.createElement('script'); s.textContent = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat-media.js'), 'utf8'); doc.body.appendChild(s);

const rect = (top, h = 28) => ({ top, bottom: top + h, left: 0, right: 300, width: 300, height: h });
const box = doc.getElementById('chatMessages'), d1 = doc.getElementById('d1'), d2 = doc.getElementById('d2'), page = doc.getElementById('page-chat');
let pos = { box: 100, d1: -200, d2: 400 };                       // viewport tops
box.getBoundingClientRect = () => rect(pos.box, 600); page.getBoundingClientRect = () => rect(60, 700);
d1.getBoundingClientRect = () => rect(pos.d1); d2.getBoundingClientRect = () => rect(pos.d2);
const pillEl = () => doc.getElementById('chatFloatingDate');
Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { get() { return this.id === 'chatFloatingDate' ? 26 : 0; } });
Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { get() { return page; } });
const scroll = async () => { box.dispatchEvent(new w.Event('scroll')); await sleep(40); };

(async () => {
  await sleep(30);
  assert.ok(pillEl(), 'pill element exists inside the chat page'); assert.ok(!pillEl().classList.contains('show')); ok('pill is created inside the chat page and starts hidden');

  await scroll();
  assert.ok(pillEl().classList.contains('show')); assert.equal(pillEl().textContent.trim(), 'Monday');
  assert.equal(pillEl().style.top, '48px'); assert.equal(pillEl().style.transform, ''); ok('scrolling shows the date of the messages at the top, below the header');

  pos.d2 = 100 + 8 + 26 + 8 - 15;                                // next date arrives 15 px into the pill's zone
  await scroll(); assert.equal(pillEl().textContent.trim(), 'Monday'); assert.equal(pillEl().style.transform, 'translateY(-15px)');
  ok('the next date pushes the pill up instead of overlapping it');

  pos.d2 = 100;                                                  // next date reached the top → it takes over
  await scroll(); assert.equal(pillEl().textContent.trim(), 'Today'); assert.equal(pillEl().style.transform, ''); ok('then the new date takes over');

  pos.d1 = 150; pos.d2 = 600; pillEl().classList.remove('show'); // first date still on screen: nothing floating
  await scroll(); assert.ok(!pillEl().classList.contains('show')); ok('no floating pill while the first in-place date is still visible');

  pos.d1 = -200; pos.d2 = 400; await scroll(); assert.ok(pillEl().classList.contains('show'));
  await sleep(1550); assert.ok(!pillEl().classList.contains('show')); ok('fades out after scrolling stops');

  page.classList.remove('active'); await scroll(); assert.ok(!pillEl().classList.contains('show')); ok('nothing is shown while another page is open');

  box.innerHTML = '<div class="chat-date-divider"><span>New</span></div>'; assert.ok(pillEl().isConnected); ok('re-rendering the message list does not remove the pill');
  console.log('\nALL FLOATING-DATE CHECKS PASSED'); process.exit(0);
})().catch(e => { console.error('\nFAILED:', e); process.exit(1); });
