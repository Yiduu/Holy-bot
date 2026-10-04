// Run: node tests/session-room.client.test.js   (needs devDependency jsdom)
const { JSDOM } = require('jsdom'); const fs = require('fs'); const assert = require('assert');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'frontend', 'session-room.js'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = n => console.log('  ✓', n);

function boot({ isHost, api }) {
  const dom = new JSDOM(`<body><div id="page-video"><h2 id="callTitle"></h2><button id="shareScreenBtn" class="hidden"></button>
    <div id="sessionLobby" class="hidden"></div><div id="callStage" class="hidden"><span id="callDot"></span><span id="callState"></span><span id="callPeers"></span><span id="callTimer"></span><div id="callBanner" class="hidden"></div><div id="jitsiContainer"></div></div></div></body>`,
    { runScripts: 'outside-only', url: 'https://app.test/' });
  const w = dom.window; const log = { nav: [], toasts: [], calls: [], jitsi: [], loadSessions: 0, closeConfirm: [] };
  w.$ = id => w.document.getElementById(id);
  w.haptic = () => {}; w.showToast = (m, k) => log.toasts.push([m, k]); w.navigate = p => log.nav.push(p);
  w.escapeHtml = x => x.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  w.formatDateTime = x => 'DT'; w.t = k => k; w.currentUser = { role: isHost ? 'mentor' : 'user' };
  w.loadSessions = () => log.loadSessions++;
  w.Telegram = { WebApp: { enableClosingConfirmation: () => log.closeConfirm.push(1), disableClosingConfirmation: () => log.closeConfirm.push(0), openLink: u => log.opened = u } };
  w.apiFetch = async (path, o = {}) => { log.calls.push([o.method || 'GET', path, o.body]); return api(path, o); };
  w.JitsiMeetExternalAPI = function (domain, opts) {
    const handlers = {}; log.jitsi.push({ domain, opts });
    this.addEventListener = (e, f) => (handlers[e] = f); this.emit = (e, a) => handlers[e] && handlers[e](a);
    this.executeCommand = (...a) => (log.cmd = a); this.dispose = () => (log.disposed = (log.disposed || 0) + 1);
    this.getNumberOfParticipants = () => (w.__peers ?? 2); w.__jitsi = this;
  };
  w.eval(src); return { w, log, dom };
}
const base = (o = {}) => ({ session_id: 's1', room_name: 'holy-x', room_password: 'PW123', jitsi_domain: 'meet.example.org', display_name: 'Warrior_2', is_moderator: false, title: 'Check-in', is_group: false, scheduled_at: new Date().toISOString(), status: 'active', host_name: 'Shepherd_1', host_present: false, ...o });

(async () => {
  // ── MENTEE: arrives first → waits → host arrives → joins
  let hostHere = false;
  let { w, log } = boot({ isHost: false, api: async (p) => p.includes('/join') ? base({ host_present: false }) : p.includes('heartbeat') ? { ended: false, host_present: hostHere, present_count: 1 } : {} });
  await w.joinSession('s1'); await sleep(30);
  assert.deepEqual(log.nav, ['video']); assert.ok(log.closeConfirm.includes(1)); ok('mentee: navigates to video page + enables close-confirmation');
  let lobby = w.$('sessionLobby'); assert.ok(!lobby.classList.contains('hidden'));
  assert.ok(lobby.textContent.includes('Waiting for Shepherd_1')); ok('mentee: lobby says waiting for the mentor');
  assert.ok(lobby.querySelector('.sr-primary').disabled); ok('mentee: Join button disabled until host is present');
  assert.ok(lobby.textContent.includes('Camera off')); ok('mentee: camera defaults OFF (anonymity-first), mic on');
  w.SR.toggle('cam'); assert.ok(w.$('sessionLobby').textContent.includes('Camera on')); assert.equal(JSON.parse(w.localStorage.getItem('holy_call_prefs')).cam, true); ok('toggle works and persists');
  w.SRsocket.hostJoined('s1'); assert.ok(!w.$('sessionLobby').querySelector('.sr-primary').disabled); ok('socket host_joined unlocks lobby instantly');
  w.SR.start(); await sleep(10);
  await sleep(20);
  assert.equal(log.jitsi.length, 1); const j = log.jitsi[0];
  assert.equal(j.domain, 'meet.example.org'); ok('embed uses the SERVER-issued domain (was hardcoded)');
  assert.equal(j.opts.configOverwrite.startWithVideoMuted, false); assert.equal(j.opts.configOverwrite.startWithAudioMuted, false);
  assert.equal(j.opts.configOverwrite.prejoinConfig.enabled, false); ok('Jitsi starts with the lobby choices; its own pre-join is off');
  w.__jitsi.emit('videoConferenceJoined'); assert.equal(w.$('callState').textContent, 'Live'); ok('status → Live once connected');
  w.__peers = 1; w.__jitsi.emit('participantLeft'); assert.ok(!w.$('callBanner').classList.contains('hidden')); assert.ok(w.$('callBanner').textContent.includes('mentor stepped out')); ok('mentee sees "mentor stepped out" banner when alone');
  w.__peers = 2; w.__jitsi.emit('participantJoined'); assert.ok(w.$('callBanner').classList.contains('hidden')); ok('banner clears when mentor returns');

  // mentee hangs up → leave called (NOT end), post-call sheet shown
  w.__jitsi.emit('readyToClose'); await sleep(20);
  const leave = log.calls.find(c => c[1].endsWith('/leave')); assert.ok(leave && leave[2].end === false); ok('mentee hang-up → POST /leave {end:false}');
  assert.ok(w.document.getElementById('srSheet').textContent.includes('You left the session')); ok('mentee gets a post-call summary sheet');
  assert.ok(log.closeConfirm.includes(0) && w.activeSession === null); ok('teardown: closing-confirmation off, state cleared');

  // ── HOST: leaves without ending; can end explicitly; can rejoin
  ({ w, log } = boot({ isHost: true, api: async (p) => p.includes('/join') ? base({ is_moderator: true, host_present: true }) : { ended: false, host_present: true, present_count: 2 } }));
  await w.joinSession('s1', { skipLobby: true }); await sleep(40);
  assert.equal(log.jitsi.length, 1); ok('host: instant session skips lobby and goes straight into the call');
  assert.equal(log.jitsi[0].opts.configOverwrite.startWithVideoMuted, false); ok('host: camera defaults ON');
  w.__jitsi.emit('videoConferenceJoined'); assert.deepEqual(log.cmd, ['password', 'PW123']); ok('host sets the room password on join');
  w.leaveCurrentSession(); const sh = w.document.getElementById('srSheet');
  assert.ok(sh.textContent.includes('Leave, keep session open') && sh.textContent.includes('End for everyone')); ok('host Leave → choice sheet (keep open / end for everyone)');
  sh.querySelectorAll('button')[0].click(); await sleep(20);
  assert.equal(log.calls.filter(c => c[1].endsWith('/leave')).pop()[2].end, false); ok('"keep open" → POST /leave {end:false}: session survives');

  ({ w, log } = boot({ isHost: true, api: async (p) => p.includes('/join') ? base({ is_moderator: true, host_present: true }) : { ended: false, host_present: true, present_count: 2 } }));
  await w.joinSession('s1', { skipLobby: true }); await sleep(40); w.__jitsi.emit('videoConferenceJoined');
  w.__jitsi.emit('videoConferenceLeft'); await sleep(5); // Jitsi's own hang-up button
  const s2 = w.document.getElementById('srSheet'); assert.ok(s2.textContent.includes('Rejoin the call')); assert.ok(log.calls.every(c => !c[1].endsWith('/end')));
  ok('host Jitsi hang-up does NOT end the session (was: instantly ended for everyone); offers Rejoin');
  s2.querySelectorAll('button')[1].click(); await sleep(20);
  assert.equal(log.calls.filter(c => c[1].endsWith('/leave')).pop()[2].end, true); ok('"End for everyone" → POST /leave {end:true}');

  // ── remote end while in call
  ({ w, log } = boot({ isHost: false, api: async (p) => p.includes('/join') ? base({ host_present: true }) : { ended: false, host_present: true, present_count: 2 } }));
  await w.joinSession('s1'); await sleep(20); w.SR.start(); await sleep(30); w.__jitsi.emit('videoConferenceJoined');
  w.SRsocket.ended('s1', 'host'); assert.ok(w.document.getElementById('srSheet').textContent.includes('Session ended')); assert.ok(log.disposed >= 1); ok('host ends session → mentee is taken out of the dead room with a clear message');

  // ── heartbeat reports ended (socket down)
  ({ w, log } = boot({ isHost: false, api: async (p) => p.includes('/join') ? base({ host_present: false }) : { ended: true } }));
  await w.joinSession('s1'); await sleep(40); assert.ok(w.document.getElementById('srSheet')?.textContent.includes('Session ended')); ok('lobby heartbeat detects an ended session even with no socket');

  // ── errors
  ({ w, log } = boot({ isHost: false, api: async () => { const e = new Error('Session has not started yet.'); e.data = { code: 'too_early', opens_at: 'x' }; throw e; } }));
  await w.joinSession('s1'); assert.ok(log.toasts[0][0].includes('opens at')); assert.equal(log.nav.length, 0); ok('too early → friendly "room opens at …" toast, no navigation');
  ({ w, log } = boot({ isHost: false, api: async () => { const e = new Error('This session has ended.'); e.data = { code: 'ended' }; throw e; } }));
  await w.joinSession('s1'); assert.equal(log.loadSessions, 1); ok('ended → list refreshes');

  // ── external browser
  ({ w, log } = boot({ isHost: false, api: async (p) => base({ host_present: true }) }));
  await w.joinSession('s1', { external: true }); await sleep(20);
  assert.ok(log.calls[log.calls.length - 1][1].includes('?via=external') || log.calls.some(c => c[1].includes('via=external'))); ok('browser mode registers as external on the server');
  assert.ok(log.opened.startsWith('https://meet.example.org/holy-x#')); ok('external URL uses the same server-issued domain as the embed');
  assert.ok(w.$('sessionLobby').textContent.includes('PW123')); ok('password shown + copyable in browser mode (was: user stuck on a password prompt)');

  console.log('\nALL CLIENT CHECKS PASSED'); process.exit(0);
})().catch(e => { console.error('\nFAIL:', e.message, '\n', e.stack.split('\n').slice(1, 4).join('\n')); process.exit(1); });
