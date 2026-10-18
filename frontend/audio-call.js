/*
 * audio-call.js — the built-in 1-on-1 audio call (phone to phone, no video server).
 *
 *   const call = HolyAudioCall.create({ isHost, ice, signal, onStatus, onLevel, onFail, onAutoplayBlocked });
 *   await call.start();            // asks for the microphone, then connects
 *   call.handleSignal(msg);        // feed every `call_signal` the server pushes
 *   call.setMuted(true|false); call.retry(); call.stop();
 *
 * How two people find each other: the HOST makes the offer, the MENTEE asks for
 * it ("hello") until it arrives. Every offer carries a new `epoch`, and every
 * message is tagged with it, so a late message from an old attempt is ignored.
 * Messages travel through the server (`signal`) — it knows who the other person
 * is, so nothing here ever holds the other person's Telegram ID.
 *
 * onStatus(kind, info): 'connecting' | 'live' | 'weak' | 'reconnecting' | 'closed'
 * onFail(reason):       'blocked' | 'nomic' | 'unsupported' | 'error'  (fatal for audio)
 */
(function (root) {
  'use strict';

  const HELLO_EVERY_MS = 2000;
  const RE_OFFER_MIN_MS = 3000;
  const RESTART_AFTER_MS = 3000;     // "disconnected" must last this long before we restart ICE
  const CONNECT_GIVE_UP_MS = 25000;
  const STATS_EVERY_MS = 3000;
  const ANSWER_WAIT_MS = 8000;
  const MAX_BITRATE = 32000;         // plenty for speech, and kind to weak networks

  function create(opts) {
    const o = Object.assign({
      isHost: false,
      ice: async () => [],
      signal: async () => {},
      onStatus() {}, onLevel() {}, onFail() {}, onAutoplayBlocked() {},
      PC: root.RTCPeerConnection,
      getUserMedia: (c) => root.navigator.mediaDevices.getUserMedia(c),
      AudioContext: root.AudioContext || root.webkitAudioContext,
      document: root.document,
    }, opts || {});

    let stream = null, pc = null, epoch = 0, stopped = false, muted = false;
    let iceServers = null, helloTimer = null, lastOfferAt = 0, connectTimer = null, restartTimer = null;
    let answerTimer = null, statsTimer = null, levelTimer = null, audioEl = null, status = '', weak = 0, good = 0, lastIn = null;
    let pendingCandidates = [];       // candidates that arrived before their offer
    let actx = null, localAn = null, remoteAn = null, remoteStreamForMeter = null;

    const setStatus = (k, info) => { if (status !== k) { status = k; try { o.onStatus(k, info); } catch (_) { /* ui */ } } };
    const send = (kind, data) => Promise.resolve().then(() => o.signal(kind, data)).catch(() => { /* retried by hello / restart */ });

    function reason(e) {
      const n = e && e.name;
      if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'blocked';
      if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return 'nomic';
      return 'error';
    }

    async function start() {
      if (!o.PC || !(root.navigator && root.navigator.mediaDevices && root.navigator.mediaDevices.getUserMedia) && !opts.getUserMedia) {
        o.onFail('unsupported'); return false;
      }
      setStatus('connecting');
      try {
        stream = await o.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      } catch (e) { o.onFail(reason(e)); return false; }
      if (stopped) { stopTracks(); return false; }
      stream.getAudioTracks().forEach(t => { t.enabled = !muted; });
      meterLocal();
      try { iceServers = await o.ice(); } catch (_) { iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }]; }
      if (stopped) return false;
      if (o.isHost) { /* wait for the mentee's hello (also covers a mentee who joined first) */ }
      else sayHello();
      armGiveUp();
      return true;
    }

    // ── mentee: ask until an offer arrives ───────────────────────────────────
    function sayHello() {
      clearInterval(helloTimer);
      const go = () => { if (!stopped && !(pc && pc.connectionState === 'connected')) send('hello', { t: Date.now() }); };
      go(); helloTimer = setInterval(go, HELLO_EVERY_MS);
    }

    function armGiveUp() {
      clearTimeout(connectTimer);
      connectTimer = setTimeout(() => { if (!stopped && status !== 'live' && status !== 'weak') o.onFail('error'); }, CONNECT_GIVE_UP_MS);
    }

    function newPeer() {
      closePeer();
      pc = new o.PC({ iceServers: iceServers || [] });
      const mine = pc;
      stream.getTracks().forEach(t => mine.addTrack(t, stream));
      try {
        const s = mine.getSenders().find(x => x.track && x.track.kind === 'audio');
        if (s && s.getParameters) {
          const p = s.getParameters(); p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
          p.encodings[0].maxBitrate = MAX_BITRATE; s.setParameters(p).catch(() => {});
        }
      } catch (_) { /* optional */ }
      mine.onicecandidate = (ev) => {
        if (pc !== mine || !ev.candidate) return;
        send('candidate', { epoch, c: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate });
      };
      mine.ontrack = (ev) => { if (pc === mine) playRemote(ev.streams && ev.streams[0] ? ev.streams[0] : new root.MediaStream([ev.track])); };
      mine.onconnectionstatechange = () => { if (pc === mine) onState(mine.connectionState); };
      return mine;
    }

    function onState(s) {
      if (s === 'connected') {
        clearInterval(helloTimer); clearTimeout(connectTimer); clearTimeout(restartTimer); clearTimeout(answerTimer);
        weak = good = 0; lastIn = null;
        setStatus('live'); startStats();
      } else if (s === 'disconnected' || s === 'failed') {
        setStatus('reconnecting');
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => restart(), s === 'failed' ? 0 : RESTART_AFTER_MS);
      } else if (s === 'closed') { /* we did it */ }
    }

    // Host makes a fresh offer; the mentee asks the host to.
    function restart() {
      if (stopped) return;
      if (o.isHost) offer(); else { send('hello', { t: Date.now(), again: true }); sayHello(); }
      armGiveUp();
    }

    // Every attempt is a brand-new connection with a new epoch (simple, and it
    // survives the other phone reloading). If no answer comes, try once more.
    async function offer() {
      if (stopped || !stream) return;
      lastOfferAt = Date.now();
      epoch = Math.max(Date.now(), epoch + 1);
      const mine = newPeer();
      clearTimeout(answerTimer);
      try {
        const d = await mine.createOffer();
        await mine.setLocalDescription(d);
        send('offer', { epoch, sdp: mine.localDescription.sdp });
        answerTimer = setTimeout(() => { if (!stopped && pc === mine && mine.signalingState === 'have-local-offer') offer(); }, ANSWER_WAIT_MS);
      } catch (e) { o.onFail('error'); }
    }

    async function handleSignal(msg) {
      if (stopped || !msg) return;
      const { kind, data } = msg;
      try {
        if (kind === 'hello') {
          if (!o.isHost || !stream || !iceServers) return;
          if (Date.now() - lastOfferAt < RE_OFFER_MIN_MS) return;
          // The mentee only says hello while it has no working call, so always start fresh.
          await offer();
          return;
        }
        if (kind === 'offer') {
          if (o.isHost || !stream || !iceServers || !data || !data.sdp) return;
          if (data.epoch < epoch) return;                    // older attempt
          epoch = data.epoch;
          clearInterval(helloTimer);                          // the offer is here; stop asking
          const mine = newPeer();
          await mine.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          await drain(mine);
          const ans = await mine.createAnswer();
          await mine.setLocalDescription(ans);
          send('answer', { epoch, sdp: mine.localDescription.sdp });
          return;
        }
        if (kind === 'answer') {
          if (!o.isHost || !pc || !data || data.epoch !== epoch) return;
          if (pc.signalingState !== 'have-local-offer') return;
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
          await drain(pc);
          return;
        }
        if (kind === 'candidate') {
          if (!data || !data.c) return;
          if (!pc || !pc.remoteDescription || data.epoch !== epoch) {
            // Could be for an offer that has not arrived yet. Keep a few, drop stale ones later.
            if (pendingCandidates.length < 60) pendingCandidates.push(data);
            return;
          }
          await pc.addIceCandidate(data.c).catch(() => {});
          return;
        }
        if (kind === 'bye') { setStatus('closed'); return; }
      } catch (e) { /* a bad message must not kill the call */ }
    }

    async function drain(p) {
      const list = pendingCandidates; pendingCandidates = [];
      for (const d of list) if (d.epoch === epoch) await p.addIceCandidate(d.c).catch(() => {});
    }

    // ── sound ────────────────────────────────────────────────────────────────
    function playRemote(rs) {
      if (!audioEl) {
        audioEl = o.document.createElement('audio');
        audioEl.autoplay = true; audioEl.setAttribute('playsinline', '');
        audioEl.style.display = 'none';
        (o.document.body || o.document.documentElement).appendChild(audioEl);
      }
      audioEl.srcObject = rs;
      remoteStreamForMeter = rs; meterRemote();
      const p = audioEl.play && audioEl.play();
      if (p && p.catch) p.catch(() => { try { o.onAutoplayBlocked(); } catch (_) { /* ui */ } });
    }
    function listen() { // call from a tap when the browser blocked autoplay
      const p = audioEl && audioEl.play && audioEl.play();
      return p && p.then ? p.then(() => true, () => false) : Promise.resolve(!!audioEl);
    }

    function ctx() { if (!actx && o.AudioContext) { try { actx = new o.AudioContext(); } catch (_) { /* no meters */ } } return actx; }
    function analyser(s) {
      const c = ctx(); if (!c || !s) return null;
      try { const a = c.createAnalyser(); a.fftSize = 256; c.createMediaStreamSource(s).connect(a); return a; } catch (_) { return null; }
    }
    function meterLocal() { localAn = analyser(stream); startLevels(); }
    function meterRemote() { remoteAn = analyser(remoteStreamForMeter); startLevels(); }
    function level(a) {
      if (!a) return 0;
      const buf = new Uint8Array(a.fftSize); a.getByteTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      return Math.min(1, Math.sqrt(sum / buf.length) * 4);
    }
    function startLevels() {
      if (levelTimer || !(localAn || remoteAn)) return;
      levelTimer = setInterval(() => { try { o.onLevel({ local: muted ? 0 : level(localAn), remote: level(remoteAn) }); } catch (_) { /* ui */ } }, 120);
    }

    // ── quality: switch to "weak" only after two bad readings, back after two good ──
    function startStats() {
      clearInterval(statsTimer);
      statsTimer = setInterval(async () => {
        if (!pc || stopped || pc.connectionState !== 'connected') return;
        let lost = 0, recv = 0, rtt = 0;
        try {
          (await pc.getStats()).forEach(r => {
            if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) { lost = r.packetsLost || 0; recv = r.packetsReceived || 0; }
            if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded') && r.currentRoundTripTime) rtt = r.currentRoundTripTime;
          });
        } catch (_) { return; }
        let pct = 0;
        if (lastIn) { const dl = lost - lastIn.lost, dr = recv - lastIn.recv; if (dl + dr > 0) pct = Math.max(0, dl) / (dl + dr) * 100; }
        lastIn = { lost, recv };
        const bad = pct > 15 || rtt > 0.8, ok = pct < 8 && rtt < 0.5;
        if (bad) { weak++; good = 0; } else if (ok) { good++; weak = 0; }
        if (weak >= 2 && status === 'live') setStatus('weak', { loss: pct, rtt });
        else if (good >= 2 && status === 'weak') setStatus('live', { loss: pct, rtt });
      }, STATS_EVERY_MS);
    }

    function setMuted(m) {
      muted = !!m;
      if (stream) stream.getAudioTracks().forEach(t => { t.enabled = !muted; });
    }

    function closePeer() {
      if (pc) { const p = pc; pc = null; try { p.onicecandidate = p.ontrack = p.onconnectionstatechange = null; p.close(); } catch (_) { /* gone */ } }
    }
    function stopTracks() { if (stream) { stream.getTracks().forEach(t => { try { t.stop(); } catch (_) { /* gone */ } }); stream = null; } }

    function stop(notify) {
      if (stopped) return;
      if (notify !== false) send('bye', {});
      stopped = true;
      [helloTimer, statsTimer, levelTimer].forEach(clearInterval);
      [connectTimer, restartTimer, answerTimer].forEach(clearTimeout);
      closePeer(); stopTracks();
      if (audioEl) { try { audioEl.srcObject = null; audioEl.remove(); } catch (_) { /* gone */ } audioEl = null; }
      if (actx) { try { actx.close(); } catch (_) { /* gone */ } actx = null; }
      setStatus('closed');
    }

    // "Try again now": a clean restart from our side.
    function retry() { if (stopped || !stream) return; weak = good = 0; setStatus('reconnecting'); restart(); }

    return { start, handleSignal, setMuted, retry, stop, listen, get muted() { return muted; } };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HolyAudioCall = api;
})(typeof window !== 'undefined' ? window : globalThis);
