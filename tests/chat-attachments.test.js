// Run: node tests/chat-attachments.test.js   (needs devDependency jsdom, Node >= 18)
// Covers the Mini App voice / file sending: the upload route (real multer + Express,
// fake Supabase / Telegram bot) and the client in frontend/chat-media.js (jsdom).
process.env.ADMIN_TELEGRAM_ID = '999';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { JSDOM } = require('jsdom');
const ok = n => console.log('  ✓', n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ═══ Server: POST /api/messages/upload ═══════════════════════════════════ */
function fakeSupabase(state) {
  let n = 0;
  const from = (table) => {
    const q = { table, _row: null };
    const chain = () => q;
    for (const m of ['select', 'or', 'eq', 'in', 'lt', 'limit', 'order', 'update', 'is']) q[m] = chain;
    q.insert = (row) => { q._row = row; return q; };
    q.single = async () => {
      if (table === 'messages' && q._row) {
        state.inserts.push({ ...q._row });
        if (state.failWaveformOnce && q._row.waveform) { state.failWaveformOnce = false; return { data: null, error: { message: 'column "waveform" does not exist' } }; }
        return { data: { id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, created_at: new Date().toISOString(), is_read: false, ...q._row }, error: null };
      }
      return { data: null, error: null };
    };
    q.then = (res, rej) => Promise.resolve({
      data: table === 'mentorship_assignments' ? (state.noMentorship ? [] : [{ id: 1 }]) : table === 'users' ? [{ anonymous_id: 'Warrior_X' }] : [],
      error: null,
    }).then(res, rej);
    return q;
  };
  return { from };
}

function fakeBot(state) {
  const rec = (name) => async (chatId, stream, opts, fileOpts) => {
    state.calls.push({ name, chatId, opts, fileOpts, readable: typeof stream.pipe === 'function' });
    const reply = state.replies[name];
    if (!reply) throw new Error(`${name} rejected`);
    return reply;
  };
  return Object.fromEntries(['sendVoice', 'sendAudio', 'sendVideo', 'sendPhoto', 'sendDocument'].map(m => [m, rec(m)]));
}

async function startServer(state) {
  const messageRoutes = require('../routes/messages');
  const emitted = [];
  const io = {
    sockets: { adapter: { rooms: new Map([['user:2', new Set(['sock'])]]) } },
    to: (room) => ({
      timeout: () => ({ emit: (ev, payload, cb) => { emitted.push({ room, ev, payload }); cb(null); } }),
      except: () => ({ emit: (ev, payload) => emitted.push({ room, ev, payload, sender: true }) }),
    }),
  };
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => { req.telegramUser = { id: 1 }; next(); };
  app.use('/api/messages', messageRoutes(fakeSupabase(state), requireAuth, io, new Map(), fakeBot(state)));
  app.use((err, req, res, next) => res.status(500).json({ error: 'Internal server error' }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, emitted };
}

async function post(base, fields, file, query = 'to_id=2&client_id=c1') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('file', new Blob([file.data], { type: file.type }), file.name);
  const res = await fetch(`${base}/api/messages/upload?${query}`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const tmpLeft = () => {
  try { return fs.readdirSync(path.join(os.tmpdir(), 'holy-uploads')).length; } catch { return 0; }
};

async function serverTests() {
  const state = { calls: [], inserts: [], replies: {}, noMentorship: false };
  const { server, base, emitted } = await startServer(state);
  const reset = () => { state.calls.length = 0; state.inserts.length = 0; state.replies = {}; state.noMentorship = false; state.failWaveformOnce = false; emitted.length = 0; };
  try {
    // A WebM recording: Telegram refuses it as a voice note and as audio, accepts it as a document.
    reset();
    state.replies = { sendDocument: { document: { file_id: 'DOC1', file_size: 321 } } };
    let r = await post(base, { kind: 'voice', mime_type: 'audio/webm', file_name: 'voice.webm', duration: '7', waveform: '0123456789abcdefghijklmnopqrstuv0123' },
      { data: Buffer.alloc(321, 1), type: 'audio/webm;codecs=opus', name: 'voice.webm' }, 'to_id=2&client_id=v1');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(state.calls.map(c => c.name), ['sendVoice', 'sendAudio', 'sendDocument']);
    assert.ok(state.calls.every(c => c.readable), 'every attempt gets a fresh readable stream');
    assert.ok(state.calls.every(c => String(c.chatId) === '999'), 'stored in the ADMIN_TELEGRAM_ID chat');
    assert.ok(state.calls.every(c => c.opts.disable_notification === true), 'admin phone is not buzzed');
    assert.equal(r.body.file_type, 'voice'); assert.equal(r.body.file_id, 'DOC1'); assert.equal(r.body.duration, 7);
    assert.equal(r.body.waveform, '0123456789abcdefghijklmnopqrstuv0123'); assert.equal(r.body.client_id, 'v1');
    assert.equal(r.body.from_id, 1); assert.equal(r.body.to_id, 2); assert.equal(r.body.file_name, null);
    ok('voice: falls back sendVoice → sendAudio → sendDocument, stored as a voice message');
    assert.ok(emitted.some(e => e.room === 'user:2' && e.ev === 'new_message' && e.payload.file_id === 'DOC1')); ok('recipient gets it live over the socket');
    assert.ok(emitted.some(e => e.sender && e.ev === 'message_sent')); ok("sender's other devices get message_sent");
    assert.equal(tmpLeft(), 0); ok('temp upload file deleted afterwards');

    // OGG/Opus goes through sendVoice directly
    reset();
    state.replies = { sendVoice: { voice: { file_id: 'V1', file_size: 99, duration: 5, mime_type: 'audio/ogg' } } };
    r = await post(base, { kind: 'voice', mime_type: 'audio/ogg', duration: '5' }, { data: Buffer.alloc(99, 2), type: 'audio/ogg', name: 'voice.ogg' }, 'to_id=2&client_id=v2');
    assert.equal(r.status, 201); assert.deepEqual(state.calls.map(c => c.name), ['sendVoice']); assert.equal(r.body.file_id, 'V1');
    ok('ogg voice message is sent as a real Telegram voice note');

    // duplicate retry (same client_id) must not store the file twice
    const before = state.calls.length;
    r = await post(base, { kind: 'voice', mime_type: 'audio/ogg', duration: '5' }, { data: Buffer.alloc(99, 2), type: 'audio/ogg', name: 'voice.ogg' }, 'to_id=2&client_id=v2');
    assert.equal(r.status, 201); assert.equal(r.body.file_id, 'V1'); assert.equal(state.calls.length, before);
    ok('retry with the same client_id returns the stored message, no second upload');

    // photo → sendPhoto; largest size wins; no file name stored
    reset();
    state.replies = { sendPhoto: { photo: [{ file_id: 'p-small', file_size: 10 }, { file_id: 'p-big', file_size: 50 }] } };
    r = await post(base, { kind: 'photo', mime_type: 'image/png', file_name: 'cat.png', caption: 'look' }, { data: Buffer.alloc(50, 3), type: 'image/png', name: 'cat.png' }, 'to_id=2&client_id=p1');
    assert.equal(r.status, 201); assert.equal(r.body.file_type, 'photo'); assert.equal(r.body.file_id, 'p-big'); assert.equal(r.body.content, 'look'); assert.equal(r.body.file_name, null);
    ok('photo: largest size kept, caption stored');

    // a "photo" that isn't an image Telegram can compress is sent as a document
    reset();
    state.replies = { sendDocument: { document: { file_id: 'D2', file_size: 5 } } };
    r = await post(base, { kind: 'photo', mime_type: 'image/svg+xml', file_name: 'a.svg' }, { data: Buffer.alloc(5), type: 'image/svg+xml', name: 'a.svg' }, 'to_id=2&client_id=p2');
    assert.equal(r.status, 201); assert.deepEqual(state.calls.map(c => c.name), ['sendDocument']); assert.equal(r.body.file_type, 'document'); assert.equal(r.body.file_name, 'a.svg');
    ok('non-compressible image is sent as a file, keeping its name');

    // blocked extension
    reset();
    r = await post(base, { kind: 'document', file_name: 'setup.exe' }, { data: Buffer.alloc(5), type: 'application/octet-stream', name: 'setup.exe' }, 'to_id=2&client_id=x1');
    assert.equal(r.status, 415); assert.equal(state.calls.length, 0); await sleep(50); /* the temp file is removed just after the reply is sent */ assert.equal(tmpLeft(), 0); ok('executables are refused (415) and nothing reaches Telegram');

    // UTF-8 (Amharic) file name from the form field wins over multer's latin1 decoding
    reset();
    state.replies = { sendDocument: { document: { file_id: 'D3', file_size: 5 } } };
    r = await post(base, { kind: 'document', file_name: 'ሰላም.pdf' }, { data: Buffer.alloc(5), type: 'application/pdf', name: 'x.pdf' }, 'to_id=2&client_id=n1');
    assert.equal(r.body.file_name, 'ሰላም.pdf'); ok('Amharic file name preserved');

    // too large (stopped by multer, not buffered)
    reset();
    r = await post(base, { kind: 'document', file_name: 'big.bin' }, { data: Buffer.alloc(21 * 1024 * 1024), type: 'application/octet-stream', name: 'big.bin' }, 'to_id=2&client_id=big');
    assert.equal(r.status, 413); assert.equal(state.calls.length, 0); assert.equal(tmpLeft(), 0); ok('over 20 MB → 413, temp file cleaned up');

    // no active mentorship → 403 before any upload happens
    reset(); state.noMentorship = true;
    // (a different recipient: the route caches a positive mentorship check for 15 s)
    r = await post(base, { kind: 'document', file_name: 'a.txt' }, { data: Buffer.alloc(5), type: 'text/plain', name: 'a.txt' }, 'to_id=3&client_id=m1');
    assert.equal(r.status, 403); assert.equal(state.calls.length, 0); ok('no mentorship → 403, nothing stored');

    // Telegram rejects every method → 502, retry allowed afterwards (dedupe entry cleared)
    reset(); state.replies = {};
    r = await post(base, { kind: 'document', file_name: 'a.txt' }, { data: Buffer.alloc(5), type: 'text/plain', name: 'a.txt' }, 'to_id=2&client_id=f1');
    assert.equal(r.status, 502); assert.equal(state.inserts.length, 0);
    state.replies = { sendDocument: { document: { file_id: 'D4', file_size: 5 } } };
    r = await post(base, { kind: 'document', file_name: 'a.txt' }, { data: Buffer.alloc(5), type: 'text/plain', name: 'a.txt' }, 'to_id=2&client_id=f1');
    assert.equal(r.status, 201); assert.equal(tmpLeft(), 0); ok('Telegram failure → 502 and nothing saved; the retry then succeeds');

    // waveform column not migrated yet → stored without it
    reset(); state.failWaveformOnce = true;
    state.replies = { sendVoice: { voice: { file_id: 'V9', file_size: 9, duration: 3 } } };
    r = await post(base, { kind: 'voice', mime_type: 'audio/ogg', duration: '3', waveform: '0123456789abcdef' }, { data: Buffer.alloc(9), type: 'audio/ogg', name: 'v.ogg' }, 'to_id=2&client_id=w1');
    assert.equal(r.status, 201); assert.equal(state.inserts.length, 2); assert.ok(!('waveform' in state.inserts[1])); ok('works before the waveform migration is applied');

    // garbage in waveform / parent_id fields is ignored, not stored
    reset();
    state.replies = { sendVoice: { voice: { file_id: 'V10', file_size: 9, duration: 3 } } };
    r = await post(base, { kind: 'voice', mime_type: 'audio/ogg', waveform: '<script>', parent_id: "1' or '1'='1" }, { data: Buffer.alloc(9), type: 'audio/ogg', name: 'v.ogg' }, 'to_id=2&client_id=g1');
    assert.equal(r.status, 201); assert.equal(r.body.waveform, undefined); assert.equal(r.body.parent_id, null); ok('invalid waveform / parent_id are dropped');

    // a hostile mime type / file name can't smuggle markup to the recipient
    reset();
    state.replies = { sendDocument: { document: { file_id: 'D5', file_size: 5 } } };
    r = await post(base, { kind: 'document', mime_type: 'x"onmouseover="alert(1)', file_name: 'a"onmouseover="alert(1)<b>.txt' }, { data: Buffer.alloc(5), type: 'text/plain', name: 'a.txt' }, 'to_id=2&client_id=h1');
    assert.equal(r.status, 201); assert.equal(r.body.mime_type, 'application/octet-stream'); assert.ok(!/["<>]/.test(r.body.file_name)); ok('hostile mime type / file name are neutralised on the server');

    // missing to_id
    r = await post(base, { kind: 'document' }, { data: Buffer.alloc(5), type: 'text/plain', name: 'a.txt' }, 'client_id=z');
    assert.equal(r.status, 400); ok('missing to_id → 400');
  } finally {
    server.close();
  }
}

/* ═══ Client: frontend/chat-media.js ══════════════════════════════════════ */
function bootClient() {
  const dom = new JSDOM(`<body>
    <div id="page-chat"><div id="chatMessages"></div>
    <div id="chatInputRow" class="chat-input-row"><div id="chatComposer" class="chat-input-wrapper">
      <textarea id="chatInput"></textarea>
      <div id="recordBar" class="hidden"><span id="recTime"></span><button id="recTrash" class="hidden"></button><canvas id="recWave" class="hidden"></canvas><div id="recHint"></div></div>
      <button id="chatSendBtn" data-mode="mic"></button><div id="recLock" class="hidden"></div></div>
      <div id="emojiPicker" class="hidden"></div><div id="attachMenu" class="hidden"></div>
      <input type="file" id="attachInputMedia"/><input type="file" id="attachInputFile"/></div></div></body>`,
    { runScripts: 'dangerously', url: 'https://app.test/', pretendToBeVisual: true });
  const w = dom.window;
  const log = { added: [], replaced: [], toasts: [], xhrs: [], emitted: [] };
  w.CSS = { escape: s => String(s).replace(/"/g, '\\"') };
  w.URL.createObjectURL = () => 'blob:fake'; w.URL.revokeObjectURL = () => { };
  w.eval(`
    var API = 'https://app.test';
    var $ = id => document.getElementById(id);
    var socket = { connected: true, id: 'sock1', emit: (...a) => window.__log.emitted.push(a) };
    var currentUser = { telegram_id: 1 };
    var getTelegramData = () => ({ initData: 'init', user: { id: 1 } });
    var haptic = () => {};
    var showToast = (m, k) => window.__log.toasts.push([m, k]);
    var t = k => k;
    var escapeHtml = s => { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; };
    var syncChatInputHeight = () => {};
    var cancelReply = () => { window.replyToId = null; };
    var openImageLightbox = () => {};
    window.chatState = { with: 2 };
    var renderThread = (msgs) => msgs.map(m => '<div class="message-thread" data-msg-id="' + m.id + '"><div class="message-bubble ' + (m.file_type ? 'has-media' : '') + '">' + (m.file_type ? renderFileAttachment(m) : '') + '</div></div>').join('');
    var addMessageToChat = (m) => { window.__log.added.push(m); window._chatMessagesMap = window._chatMessagesMap || new Map(); window._chatMessagesMap.set(String(m.id), m); $('chatMessages').insertAdjacentHTML('beforeend', renderThread([m])); };
    var replaceOptimisticBubble = (c, tempId, msg) => { window.__log.replaced.push([tempId, msg]); return true; };
    window.FakeXHR = class { constructor() { this.upload = {}; this.headers = {}; window.__log.xhrs.push(this); } open(m, u) { this.method = m; this.url = u; } setRequestHeader(k, v) { this.headers[k] = v; } send(b) { this.body = b; } abort() { this.aborted = true; this.onabort && this.onabort(); } };
    XMLHttpRequest = window.FakeXHR;
  `);
  w.__log = log;
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat-media.js'), 'utf8');
  const s = w.document.createElement('script'); s.textContent = src; w.document.body.appendChild(s);
  return { w, log, dom };
}

async function clientTests() {
  const { w, log } = bootClient();
  const run = (code) => w.eval(code);

  // helpers
  assert.equal(run("cmFmtDur(65)"), '1:05'); assert.equal(run("cmFmtSize(1536)"), '1.5 KB'); assert.equal(run("cmFmtSize(5*1048576)"), '5.0 MB'); ok('duration / size formatting');
  const wave = run("cmEncodeWave([0,0.1,0.5,1,0.2,0.05,0.9,0.3,0.7,0.4])");
  assert.equal(wave.length, 40); assert.ok(/^[0-9a-v]{40}$/.test(wave)); ok('waveform encodes to 40 base-32 characters (matches the server pattern)');
  assert.equal(run("cmWaveValues({waveform:'" + wave + "'}).length"), 40);
  assert.equal(run("cmWaveValues({file_id:'abc'}).length"), 40);
  assert.deepEqual(run("JSON.stringify(cmWaveValues({file_id:'abc'}))"), run("JSON.stringify(cmWaveValues({file_id:'abc'}))")); ok('messages without a stored waveform get a stable generated one');

  // rendering
  const voice = run("renderFileAttachment({id:'m1',file_type:'voice',file_id:'F1',duration:7,mime_type:'audio/ogg',waveform:'" + wave + "'})");
  assert.ok(voice.includes('cm-voice-btn') && voice.includes('data-file-id="F1"') && voice.includes('0:07') && (voice.match(/<i /g) || []).length === 40); ok('voice bubble: play button, 40 bars, duration');
  const uploading = run("renderFileAttachment({id:'t1',file_type:'voice',file_id:'',duration:7,_local:{status:'uploading',url:''}})");
  assert.ok(uploading.includes('cm-ring') && uploading.includes('data-act="cancel"') && !uploading.includes('cm-voice-btn')); ok('uploading voice: progress ring with cancel instead of play');
  const failed = run("renderFileAttachment({id:'t1',file_type:'document',file_name:'a.pdf',_local:{status:'failed',url:''}})");
  assert.ok(failed.includes('data-act="retry"') && failed.includes('is-failed')); ok('failed upload shows a retry ring');
  const evil = run(`renderFileAttachment({id:'m2',file_type:'document',file_name:'" onmouseover="alert(1)"><img src=x onerror=alert(1)>.pdf',file_id:'a"b',mime_type:'x" onclick="y',file_size:2048})`);
  const probe = w.document.createElement('div'); probe.innerHTML = evil;
  assert.ok(!probe.querySelector('img'), 'no injected element');
  assert.ok(![...probe.querySelectorAll('*')].some(el => [...el.attributes].some(a => /^on/i.test(a.name))), 'no injected event-handler attribute');
  assert.equal(probe.querySelector('.cm-file').dataset.name, '" onmouseover="alert(1)"><img src=x onerror=alert(1)>.pdf'); ok('hostile file name / id / mime cannot break out of attributes or inject markup');
  const photo = run("renderFileAttachment({id:'m3',file_type:'photo',file_id:'P1',mime_type:'image/jpeg'})");
  assert.ok(photo.includes('msg-photo') && photo.includes('data-file-id="P1"')); ok('photo bubble placeholder');
  const localPhoto = run("renderFileAttachment({id:'t2',file_type:'photo',_local:{status:'uploading',url:'blob:abc'}})");
  assert.ok(localPhoto.includes('src="blob:abc"') && localPhoto.includes('cm-media-overlay')); ok('uploading photo shows the local image with a ring overlay');
  assert.equal(run("attachmentLabel({file_type:'voice'})"), 'Voice message');
  const qh = run("attachmentPreviewHtml({file_type:'voice'})");
  assert.ok(qh.startsWith('<svg class="cm-inline-ico"') && qh.includes('<rect x="9" y="2.8"') && qh.endsWith('Voice message') && !/[\u{1F300}-\u{1FAFF}]/u.test(qh));
  assert.ok(run("attachmentPreviewHtml({file_type:'document', file_name:'<b>x</b>.pdf'})").includes('&lt;b&gt;x&lt;/b&gt;.pdf'));
  ok('reply banner / quote label: SVG mic icon (no emoji), file names escaped');

  // waveform timeline seeking & dragging
  const vBox = w.document.createElement('div');
  vBox.innerHTML = run("renderFileAttachment({id:'v9',file_type:'voice',file_id:'V9',duration:20})");
  const vEl = vBox.firstElementChild;
  w.document.body.appendChild(vEl);
  run("cmPaintWaveProgress(document.querySelector('.cm-voice[data-mid=\"v9\"]'), 0.5)");
  const barsOn = vEl.querySelectorAll('.cm-wave i.on').length;
  const totalBars = vEl.querySelectorAll('.cm-wave i').length;
  assert.equal(barsOn, Math.round(totalBars * 0.5));
  assert.equal(vEl.querySelector('.cm-voice-time').textContent, '0:10');
  ok('voice timeline drag / seek updates waveform bars and time display');
  vEl.remove();

  // composer mode: mic ⇄ send ⇄ edit
  const btn = w.document.getElementById('chatSendBtn'); const input = w.document.getElementById('chatInput');
  run('updateComposerMode()'); assert.equal(btn.dataset.mode, 'mic');
  input.value = 'hello'; run('updateComposerMode()'); assert.equal(btn.dataset.mode, 'send');
  input.value = '   '; run('updateComposerMode()'); assert.equal(btn.dataset.mode, 'mic');
  w.editingMessageId = 'x'; run('updateComposerMode()'); assert.equal(btn.dataset.mode, 'edit'); w.editingMessageId = null;
  ok('round button: mic when empty, send with text, check while editing');

  // upload: bubble first, progress, success
  const blob = new w.Blob([new Uint8Array(1000)], { type: 'audio/ogg' });
  w.__blob = blob;
  run("cmQueueItems([{blob: __blob, name:'voice.ogg', mime:'audio/ogg', kind:'voice', size:1000, duration:7, waveform:'0123456789abcdef'}], '', 2)");
  assert.equal(log.added.length, 1); assert.equal(log.added[0].file_type, 'voice'); assert.equal(log.added[0].is_sending, true); assert.equal(log.added[0].content, '');
  ok('sending shows the bubble immediately (optimistic)');
  await sleep(5);
  assert.equal(log.xhrs.length, 1);
  const x = log.xhrs[0], tempId = log.added[0].id;
  assert.ok(x.url.includes('/api/messages/upload?to_id=2&client_id=' + tempId)); assert.equal(x.headers['x-telegram-init-data'], 'init'); assert.equal(x.headers['x-socket-id'], 'sock1');
  assert.equal(x.body.get('kind'), 'voice'); assert.equal(x.body.get('duration'), '7'); assert.equal(x.body.get('waveform'), '0123456789abcdef'); assert.ok(x.body.get('file'));
  ok('multipart upload carries kind, duration, waveform, file, auth and socket id');
  x.upload.onprogress({ loaded: 500, total: 1000, lengthComputable: true });
  const arc = w.document.querySelector('.cm-ring-arc');
  assert.ok(arc && /^65\.9/.test(arc.style.strokeDasharray)); ok('progress ring follows the upload (50% → half the circle)');
  assert.ok(log.emitted.some(e => e[0] === 'typing' && e[1].action === 'upload')); ok('peer is told "sending a file…"');
  x.status = 201; x.response = { id: 'real1', file_id: 'FID', file_type: 'voice', client_id: tempId }; x.onload();
  await sleep(5);
  assert.equal(log.replaced.length, 1); assert.equal(log.replaced[0][0], tempId); assert.equal(log.replaced[0][1].file_id, 'FID'); ok('on success the temporary bubble is replaced by the server message');
  assert.ok(run("cmMediaCache.has('FID')")); ok("the sender's own recording is cached, so playing it needs no download");

  // failure → retry ring + Remove; retry re-uses the same client_id; cancel aborts
  run("cmQueueItems([{blob: __blob, name:'a.pdf', mime:'application/pdf', kind:'document', size:1000}], 'doc caption', 2)");
  await sleep(5);
  const x2 = log.xhrs[1], id2 = log.added[1].id;
  assert.equal(log.added[1].content, 'doc caption'); assert.equal(x2.body.get('caption'), 'doc caption');
  x2.onerror(); await sleep(5);
  assert.ok(w.document.querySelector(`[data-msg-id="${id2}"] .cm-ring.is-failed`)); assert.ok(w.document.querySelector(`[data-msg-id="${id2}"] .failed-status`)); ok('network failure → "Not sent" with retry ring + Remove');
  run(`cmRetryUpload('${id2}')`); await sleep(5);
  assert.equal(log.xhrs.length, 3); assert.ok(log.xhrs[2].url.includes('client_id=' + id2)); ok('retry re-sends with the SAME client_id (server de-duplicates)');
  run(`cmCancelUpload('${id2}')`);
  assert.ok(log.xhrs[2].aborted); assert.ok(!w.document.querySelector(`[data-msg-id="${id2}"]`)); ok('✕ aborts the upload and removes the bubble');

  // definitive server refusal drops the bubble instead of offering a pointless retry
  run("cmQueueItems([{blob: __blob, name:'a.txt', mime:'text/plain', kind:'document', size:10}], '', 2)");
  await sleep(5);
  const x3 = log.xhrs[3], id3 = log.added[2].id; x3.status = 413; x3.response = { error: 'too big' }; x3.onload(); await sleep(5);
  assert.ok(!w.document.querySelector(`[data-msg-id="${id3}"]`)); assert.ok(log.toasts.some(t => /cm_too_large|too large/i.test(t[0]))); ok('413 → bubble removed with a "too large" message');

  // queue order: several files upload one after another
  const n = log.xhrs.length;
  run("cmQueueItems([{blob:__blob,name:'1.txt',mime:'text/plain',kind:'document',size:1},{blob:__blob,name:'2.txt',mime:'text/plain',kind:'document',size:1}], 'cap', 2)");
  await sleep(5);
  assert.equal(log.xhrs.length, n + 1); assert.equal(log.xhrs[n].body.get('caption'), 'cap');
  log.xhrs[n].status = 201; log.xhrs[n].response = { id: 'r1', file_id: 'A' }; log.xhrs[n].onload(); await sleep(5);
  assert.equal(log.xhrs.length, n + 2); assert.equal(log.xhrs[n + 1].body.get('caption'), null); ok('several files: uploaded in order, caption only on the first');

  // chat switched while picking → nothing is sent
  w.chatState.with = 5; const before = log.added.length;
  run("cmQueueItems([{blob:__blob,name:'z.txt',mime:'text/plain',kind:'document',size:1}], '', 2)");
  assert.equal(log.added.length, before); ok('refuses to send into a different chat than the one it was picked in');
  w.chatState.with = 2;

  // picking files: oversize + blocked are filtered before the sheet opens
  const big = new w.File([new Uint8Array(1)], 'big.bin'); Object.defineProperty(big, 'size', { value: 25 * 1048576 });
  run('cmCloseSheet()'); log.toasts.length = 0;
  w.__files = [big]; run('cmOpenSheet(__files)');
  assert.ok(!w.document.querySelector('.cm-sheet')); assert.ok(log.toasts.length); ok('files over 20 MB never open the sheet');
  w.__files = [new w.File(['x'], 'virus.exe')]; run('cmOpenSheet(__files)'); assert.ok(!w.document.querySelector('.cm-sheet')); ok('blocked file types never open the sheet');
  w.__files = [new w.File(['hello'], 'notes.txt', { type: 'text/plain' })]; run('cmOpenSheet(__files)');
  const sheet = w.document.querySelector('.cm-sheet'); assert.ok(sheet && sheet.textContent.includes('notes.txt'));
  sheet.querySelector('.cm-sheet-caption').value = 'for you';
  const before2 = log.added.length;
  sheet.querySelector('[data-cm="send"]').click();
  assert.equal(log.added.length, before2 + 1); assert.equal(log.added[before2].content, 'for you'); assert.ok(!w.document.querySelector('.cm-sheet')); ok('preview sheet: caption + Send queues the file and closes');

  // ── recorder gestures with a fake microphone ───────────────────────────
  const mic = { calls: 0, stopped: 0, delay: 0 };
  w.__mic = mic;
  w.eval(`
    window.MediaRecorder = class { static isTypeSupported(m) { return m === 'audio/webm;codecs=opus'; }
      constructor(stream, o) { this.stream = stream; this.mimeType = o.mimeType; this.state = 'inactive'; }
      start() { this.state = 'recording'; } stop() { this.state = 'inactive'; this.ondataavailable && this.ondataavailable({ data: new Blob([new Uint8Array(400)]) }); this.onstop && this.onstop(); } };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
      window.__mic.calls++;
      if (window.__mic.delay) await new Promise(r => setTimeout(r, window.__mic.delay));
      const track = { enabled: true, readyState: 'live', stop: () => window.__mic.stopped++ };
      return { getTracks: () => [track], getAudioTracks: () => [track] }; } } });
  `);
  const press = () => run("cmStartRecording({clientX:100,clientY:100,pointerId:1})");
  const sentBefore = () => log.added.length;
  const composer = w.document.getElementById('chatComposer');

  let n0 = sentBefore(); mic.stopped = 0; mic.calls = 0;
  await press();
  assert.equal(run('cmRec.state'), 'recording'); assert.ok(composer.classList.contains('is-recording')); assert.ok(!w.document.getElementById('recordBar').classList.contains('hidden'));
  assert.equal(run('cmRec.mime'), 'audio/webm;codecs=opus'); ok('hold → recording starts, the bar replaces the text field');
  assert.equal(mic.calls, 1);
  run('cmRec.startedAt -= 3000; cmEndHold()'); await sleep(5);
  assert.equal(sentBefore(), n0 + 1); const vm = log.added[n0]; assert.equal(vm.file_type, 'voice'); assert.equal(vm.duration, 3); assert.equal(vm.mime_type, 'audio/webm'); assert.ok(/\.webm$/.test(vm.file_name || 'x.webm'));
  assert.equal(run('cmRec.state'), 'idle'); assert.ok(!composer.classList.contains('is-recording')); ok('release → voice message sent, bar gone');

  // Back-to-back recordings reuse the open stream, so the permission is not asked again
  await press();
  assert.equal(mic.calls, 1); ok('second recording reuses permission without calling getUserMedia again');
  n0 = sentBefore(); log.toasts.length = 0;
  run('cmEndHold()'); // released straight away
  assert.equal(sentBefore(), n0); assert.ok(log.toasts.some(x => /Hold the mic/.test(x[0]))); ok('a quick tap sends nothing and explains "hold to record"');

  n0 = sentBefore();
  await press(); run('cmRec.startedAt -= 3000; cmMoveHold({clientX: -50, clientY: 100})');
  assert.equal(sentBefore(), n0); assert.equal(run('cmRec.state'), 'idle'); ok('slide left past the threshold → cancelled, nothing sent');

  n0 = sentBefore();
  await press(); run('cmRec.startedAt -= 4000; cmMoveHold({clientX: 100, clientY: 10})');
  assert.equal(run('cmRec.locked'), true); assert.equal(btn.dataset.mode, 'send'); assert.ok(!w.document.getElementById('recTrash').classList.contains('hidden'));
  run('cmEndHold()'); assert.equal(run('cmRec.state'), 'recording'); ok('slide up → locked: finger can lift, the button becomes Send, trash appears');
  run('cmFinishRecording(true)'); await sleep(5);
  assert.equal(sentBefore(), n0 + 1); ok('locked recording is sent by tapping Send');

  n0 = sentBefore();
  await press(); run('cmRec.startedAt -= 4000; cmMoveHold({clientX: 100, clientY: 10})'); run('cancelRecording()');
  assert.equal(sentBefore(), n0); assert.equal(run('cmRec.state'), 'idle'); ok('trash / leaving the chat cancels a locked recording');

  // page hidden completely releases hardware stream
  run('cmReleaseAudioStream(true)');
  assert.equal(mic.stopped, mic.calls); ok('every microphone stream that was opened has been stopped');

  // finger lifted (or OS permission sheet ate the touch) before the mic opened
  n0 = sentBefore(); mic.delay = 30; log.toasts.length = 0;
  const pending = press(); run('cmEndHold()'); await pending; mic.delay = 0;
  assert.equal(run('cmRec.state'), 'idle'); assert.equal(sentBefore(), n0); assert.ok(log.toasts.length); ok('released before the microphone opened → no recording');

  // recording is refused while editing / without an open chat
  w.editingMessageId = 'x'; await press(); assert.equal(run('cmRec.state'), 'idle'); w.editingMessageId = null; ok('cannot record while editing a message');

  // recording without a microphone API shows the notice, never throws
  w.eval("cmReleaseAudioStream(true); Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })");
  await run("cmStartRecording({clientX:0,clientY:0,pointerId:1})");
  assert.ok(w.document.querySelector('.cm-notice')); assert.equal(run('cmRec.state'), 'idle'); ok('no microphone support → friendly notice, recorder stays idle');
}

(async () => {
  console.log('Server: upload route');
  await serverTests();
  console.log('Client: chat-media.js');
  await clientTests();
  console.log('\nALL CHAT-ATTACHMENT CHECKS PASSED');
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e); process.exit(1); });
