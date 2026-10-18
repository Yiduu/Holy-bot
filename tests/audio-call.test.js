// Run: node tests/audio-call.test.js   (no network, no browser)
// Two in-process "phones" with a fake RTCPeerConnection, wired through a fake signalling pipe.
const assert = require('assert');
const { create } = require('../frontend/audio-call.js');
const ice = require('../utils/callIce.js');
const ok = (n) => console.log('  ✓', n);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function makeDoc() { const el = () => ({ style: {}, setAttribute() {}, remove() {}, play: () => Promise.resolve() }); return { createElement: el, body: { appendChild() {} } }; }
const track = () => ({ kind: 'audio', enabled: true, stop() { this.stopped = true; } });
function phone(name, isHost, pipe, over = {}) {
  const log = { status: [], fail: [] };
  const peers = [];
  class PC {
    constructor() { this.connectionState = 'new'; this.signalingState = 'stable'; this.remoteDescription = null; this.cands = []; peers.push(this); }
    addTrack() {} getSenders() { return []; }
    async createOffer() { return { type: 'offer', sdp: 'offer-' + name }; }
    async createAnswer() { return { type: 'answer', sdp: 'answer-' + name }; }
    async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; if (d.type === 'answer') this.connect(); }
    async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = 'stable'; if (d.type === 'answer') this.connect(); }
    async addIceCandidate(c) { this.cands.push(c); }
    async getStats() { return new Map(); }
    connect() { this.connectionState = 'connected'; this.onconnectionstatechange && this.onconnectionstatechange(); }
    close() { this.connectionState = 'closed'; }
  }
  const t = track();
  const stream = { getTracks: () => [t], getAudioTracks: () => [t] };
  const c = create({
    isHost, PC, document: makeDoc(), AudioContext: null,
    getUserMedia: over.getUserMedia || (async () => stream),
    ice: async () => [{ urls: ['stun:x'] }],
    signal: async (kind, data) => { pipe.push({ from: name, kind, data: JSON.parse(JSON.stringify(data)) }); },
    onStatus: (k) => log.status.push(k), onFail: (w) => log.fail.push(w),
  });
  return { c, log, t, peers };
}

(async () => {
  // 1. normal call: mentee says hello → host offers → mentee answers → both live
  const pipe = []; let H, M;
  const deliver = () => { while (pipe.length) { const m = pipe.shift(); (m.from === 'H' ? M : H).c.handleSignal(m); } };
  H = phone('H', true, pipe); M = phone('M', false, pipe);
  await H.c.start(); await M.c.start();
  for (let i = 0; i < 6; i++) { deliver(); await wait(5); }
  assert.ok(H.log.status.includes('live') && M.log.status.includes('live')); ok('mentee hello → offer → answer → both phones connected');
  assert.ok(!pipe.some(m => m.kind === 'hello' && m.from === 'H'), 'host never says hello');

  // 2. mute only disables the local track
  M.c.setMuted(true); assert.equal(M.t.enabled, false); M.c.setMuted(false); assert.equal(M.t.enabled, true); ok('mute switches the microphone track off and on');

  // 3. late candidates before the offer are kept and applied
  const pipe2 = []; const M2 = phone('M2', false, pipe2); await M2.c.start();
  await M2.c.handleSignal({ kind: 'candidate', data: { epoch: 5, c: { candidate: 'early' } } });
  await M2.c.handleSignal({ kind: 'offer', data: { epoch: 5, sdp: 'o' } });
  assert.deepEqual(M2.peers[M2.peers.length - 1].cands.map(x => x.candidate), ['early']); ok('a candidate that beats its offer is not lost');
  await M2.c.handleSignal({ kind: 'offer', data: { epoch: 3, sdp: 'old' } });
  assert.equal(M2.peers.length, 1); ok('an older attempt is ignored');
  M2.c.stop(false);

  // 4. failures map to plain reasons
  for (const [name, why] of [['NotAllowedError', 'blocked'], ['NotFoundError', 'nomic'], ['AbortError', 'error']]) {
    const P = phone('X', true, [], { getUserMedia: async () => { const e = new Error(name); e.name = name; throw e; } });
    assert.equal(await P.c.start(), false); assert.deepEqual(P.log.fail, [why]);
  }
  ok('blocked / no microphone / other errors are told apart');
  const none = create({ PC: undefined, onFail: (w) => none.f = w }); await none.start(); assert.equal(none.f, 'unsupported'); ok('no WebRTC → "unsupported"');

  // 5. stop releases the microphone and tells the other side
  const before = pipe.length; H.c.stop(); await wait(5); assert.equal(H.t.stopped, true); assert.ok(pipe.slice(before).some(m => m.kind === 'bye')); ok('leaving stops the mic and says bye');

  // 6. ICE server provider
  ice.resetCache();
  assert.equal(ice.provider({}), 'stun'); assert.equal(ice.provider({ CF_TURN_KEY_ID: 'a', CF_TURN_API_TOKEN: 'b' }), 'cloudflare');
  assert.equal(ice.provider({ METERED_TURN_APP: 'a', METERED_TURN_API_KEY: 'b' }), 'metered'); ok('relay provider is picked from the environment');
  const http = { post: async () => ({ data: { iceServers: [{ urls: ['stun:s:3478', 'turn:t:53?transport=udp', 'turn:t:3478?transport=udp'], username: 'u', credential: 'c' }] } }) };
  let list = await ice.getIceServers({ CF_TURN_KEY_ID: 'a', CF_TURN_API_TOKEN: 'b' }, http, 1000);
  assert.ok(!JSON.stringify(list).includes(':53')); assert.ok(list[0].credential); ok('Cloudflare credentials used; port-53 URLs dropped');
  ice.resetCache();
  list = await ice.getIceServers({ CF_TURN_KEY_ID: 'a', CF_TURN_API_TOKEN: 'b' }, { post: async () => { throw new Error('down'); } }, 1000);
  assert.deepEqual(list, ice.STUN_ONLY); ok('relay outage falls back to STUN, never throws');
  console.log('\nALL AUDIO CALL CHECKS PASSED'); process.exit(0);
})().catch(e => { console.error('\nFAIL:', e.message, e.stack.split('\n')[1]); process.exit(1); });
