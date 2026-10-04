'use strict';
/*
 * session-room.js — join → lobby → call → leave, for mentors and mentees.
 *
 * Design rules (each one fixes a real failure in the previous flow):
 *  1. The session's lifecycle belongs to the SERVER, not to the host's tab.
 *     Leaving a call never ends the session; only an explicit "End for
 *     everyone" (or the server's sweeper) does. A dropped connection is
 *     therefore recoverable: just rejoin.
 *  2. One Jitsi server for everyone. The domain always comes from the server,
 *     so the embedded call and the "open in browser" fallback share a room.
 *  3. Nobody is dropped into a blank frame. There's a lobby (mic/camera choice,
 *     "waiting for your mentor", device warnings) and clear in-call status.
 *  4. No blocking confirm()/prompt() — they are unreliable in Telegram WebViews.
 *
 * Depends on globals from app.js: $, apiFetch, haptic, showToast, navigate,
 * escapeHtml, formatDateTime, t, currentUser, loadSessions.
 */
(function () {
  // ── helpers ────────────────────────────────────────────────────────────────
  const HEARTBEAT_LOBBY_MS = 8000;
  const HEARTBEAT_CALL_MS = 25000;
  const CONNECT_TIMEOUT_MS = 20000;
  const PREFS_KEY = 'holy_call_prefs';

  // Translatable with a `sr_<key>` entry in locales.js; falls back to English.
  function sr(key, fallback, vars) {
    let s = fallback;
    try {
      const v = typeof t === 'function' ? t('sr_' + key) : null;
      if (v && v !== 'sr_' + key) s = v;
    } catch (_) { /* fall back */ }
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), v);
    return s;
  }
  const esc = (x) => (typeof escapeHtml === 'function' ? escapeHtml(String(x ?? '')) : String(x ?? ''));
  const tg = () => window.Telegram?.WebApp;

  // One mutable state object for the room we're currently in (or null).
  let A = null;
  let hbTimer = null, tickTimer = null, connectTimer = null, wakeLock = null;
  let joining = false, creating = false, hiddenAt = 0;

  // ── server clock ───────────────────────────────────────────────────────────
  // The Join button must open at the server's idea of "5 min before start", not
  // the phone's. Skew is measured once in a while and applied in getSessionState.
  window.serverSkewMs = 0;
  let lastClockSync = 0;
  window.serverNow = () => Date.now() + (window.serverSkewMs || 0);
  window.syncServerClock = async function () {
    if (Date.now() - lastClockSync < 5 * 60 * 1000) return;
    try {
      const t0 = Date.now();
      const { now } = await apiFetch('/api/sessions/clock', { retry: false, timeout: 4000 });
      const t1 = Date.now();
      window.serverSkewMs = new Date(now).getTime() - (t0 + t1) / 2;
      lastClockSync = Date.now();
    } catch (_) { /* keep previous skew */ }
  };

  // ── call preferences (remembered between sessions) ─────────────────────────
  function loadPrefs(isHost) {
    // Anonymous platform → mentees default to camera OFF (one tap to turn on).
    const def = { mic: true, cam: !!isHost };
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
      if (saved && typeof saved.mic === 'boolean' && typeof saved.cam === 'boolean') return saved;
    } catch (_) { /* ignore */ }
    return def;
  }
  function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) { /* ignore */ } }

  // ── bottom sheet (replaces confirm()/alert()) ──────────────────────────────
  function closeSheet() { document.getElementById('srSheet')?.remove(); }
  function sheet({ title, body = '', actions = [], dismissible = true }) {
    closeSheet();
    const el = document.createElement('div');
    el.id = 'srSheet';
    el.className = 'sr-overlay';
    el.innerHTML = `
      <div class="sr-sheet" role="dialog" aria-modal="true">
        <div class="sr-sheet-title">${esc(title)}</div>
        ${body ? `<div class="sr-sheet-body">${body}</div>` : ''}
        <div class="sr-sheet-actions">
          ${actions.map((a, i) => `<button class="btn ${a.kind === 'danger' ? 'btn-danger' : a.kind === 'ghost' ? 'btn-outline' : 'btn-primary'}" data-i="${i}">${esc(a.label)}</button>`).join('')}
        </div>
      </div>`;
    el.addEventListener('click', (ev) => {
      if (ev.target === el && dismissible) return closeSheet();
      const b = ev.target.closest('button[data-i]');
      if (!b) return;
      const a = actions[Number(b.dataset.i)];
      closeSheet();
      if (a && a.onClick) a.onClick();
    });
    document.body.appendChild(el);
    return el;
  }

  // Small tappable banner (invites, "someone is waiting"). Auto-hides.
  function banner({ text, actionLabel, onAction, ttl = 20000 }) {
    document.getElementById('srToast')?.remove();
    const el = document.createElement('div');
    el.id = 'srToast';
    el.className = 'sr-toast';
    el.innerHTML = `<span>${esc(text)}</span>${actionLabel ? `<button class="btn btn-primary btn-sm">${esc(actionLabel)}</button>` : ''}`;
    el.querySelector('button')?.addEventListener('click', () => { el.remove(); onAction && onAction(); });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ttl);
  }

  // ── environment checks (unchanged logic, kept for the fallback prompt) ─────
  window.detectUnreliableSessionEnvironment = function () {
    const ua = navigator.userAgent || '';
    const wrapper = /Plus|TelegramPlus|Nicegram|OWM|Bookmarks/i.test(ua);
    const hasWebRTC = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
    return wrapper || !hasWebRTC || typeof window.RTCPeerConnection !== 'function';
  };
  window.isIOSDevice = function () {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  };
  window.supportsScreenShare = () => !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');

  // The external-browser URL always uses the server-issued domain (previously the
  // embed was hardcoded to a different server, so the two sides never met).
  window.buildExternalSessionUrl = function (data, prefs) {
    const buttons = ['microphone', 'camera', 'desktop', 'chat', 'raisehand', 'tileview', 'fullscreen', 'hangup', 'security'];
    const p = prefs || loadPrefs(data.is_moderator);
    const params = [
      'config.disableDeepLinking=true',
      `config.toolbarButtons=${encodeURIComponent(JSON.stringify(buttons))}`,
      `config.startWithAudioMuted=${!p.mic}`,
      `config.startWithVideoMuted=${!p.cam}`,
      'config.prejoinConfig.enabled=false',
      'interfaceConfig.MOBILE_APP_PROMO=false',
      'interfaceConfig.SHOW_JITSI_WATERMARK=false',
      `userInfo.displayName=${encodeURIComponent(data.display_name)}`,
    ];
    if (data.jitsi_token) params.push(`jwt=${data.jitsi_token}`);
    return `https://${data.jitsi_domain}/${data.room_name}#${params.join('&')}`;
  };

  function openExternalUrl(url) {
    // Telegram's openLink hands the URL to the phone's real browser; window.open
    // after an async fetch is often blocked as an unrequested popup.
    if (tg()?.openLink) { try { tg().openLink(url, { try_instant_view: false }); return; } catch (_) { /* fall through */ } }
    window.open(url, '_blank');
  }

  // ── entry points used by the sessions list / deep links ────────────────────
  window.joinSession = async function (sessionId, opts = {}) {
    if (joining) return;
    if (A && A.sessionId === sessionId && A.phase !== 'external') { navigate('video'); return; } // already in it
    joining = true;
    haptic('medium');
    const btn = window.event?.target?.closest?.('button');
    if (btn) { btn.disabled = true; btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="sr-spin"></span>'; }
    try {
      await window.syncServerClock();
      const via = opts.external ? '?via=external' : '';
      const data = await apiFetch(`/api/sessions/${sessionId}/join${via}`, { retry: false });
      await enter(data, opts);
    } catch (e) {
      handleJoinError(e);
    } finally {
      joining = false;
      if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = btn.dataset.label; }
    }
  };

  window.openSessionInBrowser = (sessionId) => window.joinSession(sessionId, { external: true });

  function handleJoinError(e) {
    haptic('error');
    const code = e?.data?.code || e?.code;
    if (code === 'too_early') {
      const at = e.data?.opens_at ? formatDateTime(e.data.opens_at) : '';
      showToast(sr('too_early', 'The room opens at {time}.', { time: at }), 'info');
    } else if (code === 'ended' || code === 'expired') {
      showToast(e.message, 'info');
      if (typeof loadSessions === 'function') loadSessions();
    } else {
      showToast(e.message || 'Could not join the session.', 'error');
    }
  }

  window.createSession = async function (is_group = false, mentee_id = null, scheduled_at = null, customTitle = null, participant_ids = []) {
    if (creating) return;
    if (!is_group && !mentee_id && currentUser?.role === 'mentor') {
      haptic('error'); showToast('Please select a mentee first.', 'error'); return;
    }
    creating = true;
    haptic('light');
    try {
      const title = customTitle || (is_group ? 'Group Session' : 'Private session');
      const finalScheduled = scheduled_at || new Date().toISOString();
      const data = await apiFetch('/api/sessions/create', {
        method: 'POST',
        body: { is_group, title, scheduled_at: finalScheduled, mentee_id: mentee_id || null, participant_ids: participant_ids.length ? participant_ids : undefined },
      });
      haptic('success');
      showToast(is_group ? 'Group session created!' : 'Private session created!', 'success');
      const startsNow = new Date(finalScheduled).getTime() <= window.serverNow() + 30000;
      if (startsNow) {
        creating = false;
        // Go through the normal join so the server knows the host is live.
        await window.joinSession(data.session.id, { skipLobby: true });
      } else if (typeof loadSessions === 'function') {
        loadSessions();
      }
    } catch (e) {
      haptic('error'); showToast(e.message, 'error');
    } finally {
      creating = false;
    }
  };

  // ── entering a room ────────────────────────────────────────────────────────
  async function enter(data, opts) {
    teardown({ keepNav: true });
    A = {
      sessionId: data.session_id, data, isHost: !!data.is_moderator,
      phase: 'lobby', hostPresent: !!data.host_present, presentCount: 1,
      prefs: loadPrefs(data.is_moderator), connected: false, startedAt: 0, ending: false,
      external: !!opts.external, api: null, waitedMs: 0,
    };
    window.activeSession = { sessionId: A.sessionId, isModerator: A.isHost, joinData: data, connected: false };
    navigate('video');
    $('callTitle').textContent = data.title || 'Live Session';
    toggleShareScreenButtonVisibility(false);
    tg()?.enableClosingConfirmation?.();
    startHeartbeat();

    if (opts.external) return openExternal();
    if (opts.skipLobby && A.isHost) return startCall();
    renderLobby();
  }

  // ── lobby ──────────────────────────────────────────────────────────────────
  // While the call is on screen the app chrome (bottom nav, FAB) must get out of
  // the way. The stage is also moved to <body>: inside #page-video it is trapped by
  // ancestors that break position:fixed on phones — .page is transformed +
  // overflow:hidden (containing block), and #app has its own z-index stacking
  // context. On <body> it is always measured against the real screen.
  let stageHome = null;
  function setCallChrome(on) {
    document.body.classList.toggle('in-call', !!on);
    const stage = $('callStage');
    if (!stage) return;
    if (on) {
      if (!stageHome) stageHome = stage.parentElement;
      if (stage.parentElement !== document.body) document.body.appendChild(stage);
    } else if (stageHome && stage.parentElement !== stageHome) {
      stage.classList.add('hidden');
      stageHome.appendChild(stage);
    }
  }

  function showStage(which) {
    $('sessionLobby').classList.toggle('hidden', which !== 'lobby');
    $('callStage').classList.toggle('hidden', which !== 'call');
    setCallChrome(which === 'call');
  }

  function renderLobby() {
    if (!A) return;
    showStage('lobby');
    const { data, isHost, hostPresent, prefs } = A;
    const waiting = Math.max(0, A.presentCount - 1);
    const canEnter = isHost || hostPresent;
    const unreliable = window.detectUnreliableSessionEnvironment();

    // Heartbeats re-render this every few seconds; skip when nothing visible changed.
    const key = JSON.stringify([hostPresent, waiting, prefs.mic, prefs.cam, A.waitedMs > 20000]);
    if (A.lobbyKey === key && $('sessionLobby').firstChild) return;
    A.lobbyKey = key;

    let status;
    if (isHost) {
      status = waiting > 0
        ? `<div class="sr-status sr-ok">${esc(sr('n_waiting', '{n} waiting for you', { n: waiting }))}</div>`
        : `<div class="sr-status">${esc(sr('host_ready', 'You\'re the host — others will be notified when you start.'))}</div>`;
    } else if (hostPresent) {
      status = `<div class="sr-status sr-ok">${esc(sr('host_here', '{name} is here. You can join now.', { name: data.host_name }))}</div>`;
    } else {
      status = `<div class="sr-status sr-wait"><span class="sr-spin"></span>${esc(sr('host_wait', 'Waiting for {name} to arrive… we\'ll let you in the moment they do.', { name: data.host_name }))}</div>`;
    }

    const primary = isHost
      ? sr('start', 'Start session')
      : (hostPresent ? sr('join_now', 'Join now') : sr('waiting', 'Waiting for your mentor…'));

    $('sessionLobby').innerHTML = `
      <div class="sr-card">
        <div class="sr-eyebrow">${data.is_group ? 'Group session' : '1-on-1 session'}</div>
        <div class="sr-title">${esc(data.title || 'Live Session')}</div>
        <div class="sr-sub">${esc(formatDateTime(data.scheduled_at))}${isHost ? '' : ' · ' + esc(data.host_name)}</div>
        ${status}
        <div class="sr-toggles">
          <button class="sr-toggle ${prefs.mic ? 'on' : ''}" onclick="SR.toggle('mic')" aria-pressed="${prefs.mic}">
            <span class="sr-ico">${prefs.mic ? '🎙️' : '🔇'}</span><span>${prefs.mic ? esc(sr('mic_on', 'Mic on')) : esc(sr('mic_off', 'Mic off'))}</span>
          </button>
          <button class="sr-toggle ${prefs.cam ? 'on' : ''}" onclick="SR.toggle('cam')" aria-pressed="${prefs.cam}">
            <span class="sr-ico">${prefs.cam ? '📷' : '🚫'}</span><span>${prefs.cam ? esc(sr('cam_on', 'Camera on')) : esc(sr('cam_off', 'Camera off'))}</span>
          </button>
        </div>
        ${prefs.cam ? '' : `<div class="sr-hint">${esc(sr('cam_hint', 'Camera is optional — you can turn it on any time during the call.'))}</div>`}
        ${unreliable ? `<div class="sr-warn">${esc(sr('unreliable', 'This app may not support video calls reliably. Opening in your phone\'s browser is recommended.'))}</div>` : ''}
        <button class="btn btn-primary sr-primary" ${canEnter ? '' : 'disabled'} onclick="SR.start()">${esc(primary)}</button>
        ${(!isHost && !hostPresent && A.waitedMs > 20000) ? `<button class="btn btn-outline sr-secondary" onclick="SR.start()">${esc(sr('join_anyway', 'Mentor not showing as online? Join anyway'))}</button>` : ''}
        <button class="btn ${unreliable ? 'btn-primary' : 'btn-outline'} sr-secondary" onclick="SR.external()">${esc(sr('open_browser', 'Open in browser instead'))}</button>
        <button class="sr-link" onclick="SR.cancelLobby()">${esc(sr('not_now', 'Not now'))}</button>
      </div>`;
  }

  // ── external-browser mode ──────────────────────────────────────────────────
  function openExternal() {
    A.phase = 'external';
    A.external = true;
    window.activeSession.connected = true;
    openExternalUrl(window.buildExternalSessionUrl(A.data, A.prefs));
    showStage('lobby');
    const pw = A.data.room_password;
    $('sessionLobby').innerHTML = `
      <div class="sr-card">
        <div class="sr-eyebrow">${esc(sr('ext_eyebrow', 'Opened in your browser'))}</div>
        <div class="sr-title">${esc(A.data.title || 'Live Session')}</div>
        <div class="sr-sub">${esc(sr('ext_sub', 'Your call is running in your phone\'s browser. Come back here when you\'re done.'))}</div>
        ${pw ? `<div class="sr-pass"><div class="sr-pass-label">${esc(sr('pass_label', 'If you\'re asked for a password'))}</div>
          <div class="sr-pass-row"><code>${esc(pw)}</code><button class="btn btn-outline btn-sm" onclick="SR.copyPass()">${esc(sr('copy', 'Copy'))}</button></div></div>` : ''}
        <button class="btn btn-outline sr-secondary" onclick="SR.reopenExternal()">${esc(sr('open_again', 'Open again'))}</button>
        <button class="btn btn-primary sr-primary" onclick="SR.leave()">${esc(sr('im_done', 'I\'m done — leave session'))}</button>
      </div>`;
  }

  // ── the call ───────────────────────────────────────────────────────────────
  function loadJitsiScript(domain) {
    if (window.JitsiMeetExternalAPI) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://${domain}/external_api.js`; // same server as the room
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the video engine'));
      document.head.appendChild(s);
    });
  }

  async function startCall() {
    if (!A || A.phase === 'call') return;
    haptic('medium');
    A.phase = 'call';
    showStage('call');
    $('callStage').classList.add('in-call');
    A.micMuted = !A.prefs.mic; A.camMuted = !A.prefs.cam; A.sharing = false; A.hand = false; A.tiles = false;
    $('ctlFlip').classList.toggle('hidden', !isTouchDevice());
    renderControls();
    setStatus('connecting');
    toggleShareScreenButtonVisibility(A.isHost);
    acquireWakeLock();
    try {
      await loadJitsiScript(A.data.jitsi_domain);
    } catch (e) {
      haptic('error');
      A.phase = 'lobby';
      showToast(sr('engine_fail', 'Could not load the video engine. Check your connection and try again.'), 'error');
      return renderLobby();
    }
    if (!A) return; // user left while the script loaded

    const { data, isHost, prefs } = A;
    const container = $('jitsiContainer');
    container.innerHTML = '';
    const opts = {
      roomName: data.room_name,
      width: '100%', height: '100%', parentNode: container,
      userInfo: { displayName: data.display_name },
      iframeAttributes: { allow: 'camera; microphone; display-capture; autoplay; clipboard-write; fullscreen', allowFullScreen: true },
      configOverwrite: {
        startWithAudioMuted: !prefs.mic,
        startWithVideoMuted: !prefs.cam,
        prejoinConfig: { enabled: false },   // our lobby replaces Jitsi's pre-join page
        prejoinPageEnabled: false,
        enableClosePage: false,
        disableDeepLinking: true,
        requireDisplayName: false,
        disableRemoteMute: !isHost,
        disableKick: !isHost,
        desktopSharingFrameRate: { min: 5, max: 15 },
        // Our own control bar (below) replaces Jitsi's auto-hiding toolbar.
        toolbarButtons: [],
        hideConferenceSubject: true,
      },
      interfaceConfigOverwrite: {
        SHOW_JITSI_WATERMARK: false,
        MOBILE_APP_PROMO: false,
      },
      ...(data.jitsi_token ? { jwt: data.jitsi_token } : {}),
    };

    try { A.api?.dispose(); } catch (_) { /* ignore */ }
    const api = new window.JitsiMeetExternalAPI(data.jitsi_domain, opts);
    A.api = api; window.jitsiApi = api;

    // If we haven't connected in time, offer the browser fallback — in-app, non-blocking.
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      if (A && !A.connected) {
        haptic('error');
        sheet({
          title: sr('slow_title', 'Taking longer than usual'),
          body: esc(sr('slow_body', 'The call hasn\'t connected yet. Your browser may handle it better.')),
          actions: [
            { label: sr('open_browser', 'Open in browser instead'), onClick: () => window.SR.external() },
            { label: sr('keep_waiting', 'Keep waiting'), kind: 'ghost' },
          ],
        });
      }
    }, CONNECT_TIMEOUT_MS);

    api.addEventListener('videoConferenceJoined', () => {
      if (!A) return;
      A.connected = true; A.startedAt = Date.now();
      window.activeSession.connected = true;
      clearTimeout(connectTimer); closeSheet();
      setStatus('live'); refreshPeers();
      startTick();
      haptic('success');
      if (isHost && data.room_password) { try { api.executeCommand('password', data.room_password); } catch (_) { /* best effort */ } }
    });
    api.addEventListener('audioMuteStatusChanged', (e) => { A.micMuted = !!e.muted; renderControls(); });
    api.addEventListener('videoMuteStatusChanged', (e) => { A.camMuted = !!e.muted; renderControls(); });
    api.addEventListener('screenSharingStatusChanged', (e) => { A.sharing = !!e.on; renderControls(); });
    api.addEventListener('raiseHandUpdated', (e) => { if (e && e.handRaised !== undefined) { A.hand = !!e.handRaised; } });
    api.addEventListener('tileViewChanged', (e) => { A.tiles = !!e.enabled; });
    api.addEventListener('passwordRequired', () => { if (data.room_password) api.executeCommand('password', data.room_password); });
    api.addEventListener('participantJoined', () => { refreshPeers(); hideBanner(); });
    api.addEventListener('participantLeft', refreshPeers);
    api.addEventListener('cameraError', () => showToast(sr('cam_err', 'Camera unavailable — you can continue with audio only.'), 'info'));
    api.addEventListener('micError', () => showToast(sr('mic_err', 'Microphone unavailable — check your permissions.'), 'error'));
    api.addEventListener('errorOccurred', (err) => {
      console.error('[Jitsi] errorOccurred:', err);
      if (err?.error?.isFatal) setStatus('problem');
    });
    // Hang-up from Jitsi's own toolbar.
    const onHangup = () => { if (A && !A.ending && A.phase === 'call') handleHangup(); };
    api.addEventListener('videoConferenceLeft', onHangup);
    api.addEventListener('readyToClose', onHangup);
  }

  // ── call controls ──────────────────────────────────────────────────────────
  function isTouchDevice() { return (navigator.maxTouchPoints || 0) > 0; }

  function renderControls() {
    if (!A) return;
    const set = (id, on, icoOn, icoOff, lblOn, lblOff) => {
      const b = $(id); if (!b) return;
      b.classList.toggle('off', !on);
      b.setAttribute('aria-pressed', String(on));
      b.querySelector('.ctl-ico').textContent = on ? icoOn : icoOff;
      b.querySelector('.ctl-lbl').textContent = on ? lblOn : lblOff;
    };
    set('ctlMic', !A.micMuted, '🎙️', '🔇', sr('mic', 'Mic'), sr('unmute', 'Unmute'));
    set('ctlCam', !A.camMuted, '📷', '🚫', sr('camera', 'Camera'), sr('start_video', 'Start'));
    $('ctlShare')?.classList.toggle('active', !!A.sharing);
  }

  function cmd(name, ...args) {
    if (!A?.api) return false;
    try { A.api.executeCommand(name, ...args); return true; }
    catch (e) { console.error('[Call] command failed:', name, e); return false; }
  }

  function moreSheet() {
    const items = [
      { label: sr('devices', 'Audio & video settings'), onClick: devicesSheet },
      { label: A.hand ? sr('lower_hand', 'Lower hand') : sr('raise_hand', 'Raise hand'), onClick: () => { A.hand = !A.hand; cmd('toggleRaiseHand'); } },
      { label: sr('participants', 'Participants'), onClick: () => cmd('toggleParticipantsPane', true) },
      { label: A.tiles ? sr('speaker_view', 'Speaker view') : sr('tile_view', 'Grid view'), onClick: () => { A.tiles = !A.tiles; cmd('toggleTileView'); } },
    ];
    if (A.isHost) items.push({ label: sr('mute_all', 'Mute everyone'), onClick: () => { cmd('muteEveryone'); showToast(sr('muted_all', 'Everyone has been muted.'), 'success'); } });
    items.push({ label: sr('open_browser', 'Open in browser instead'), onClick: () => window.SR.external() });
    sheet({ title: sr('more', 'More'), actions: items.map(i => ({ ...i, kind: 'ghost' })) });
  }

  // Pick microphone / camera / speaker (Jitsi device list via the IFrame API).
  async function devicesSheet() {
    if (!A?.api) return;
    let list = {}, cur = {};
    try { list = await A.api.getAvailableDevices(); } catch (_) { /* may be unsupported */ }
    try { cur = await A.api.getCurrentDevices(); } catch (_) { /* ignore */ }
    const field = (key, label, kind) => {
      const opts = list[key] || [];
      if (!opts.length) return '';
      const sel = cur[key]?.deviceId;
      return `<label class="sr-field"><span>${esc(label)}</span><select data-kind="${kind}">` +
        opts.map(d => `<option value="${esc(d.deviceId)}" data-label="${esc(d.label)}" ${d.deviceId === sel ? 'selected' : ''}>${esc(d.label || 'Default')}</option>`).join('') +
        '</select></label>';
    };
    const html = field('audioInput', sr('microphone', 'Microphone'), 'audioInput') +
      field('videoInput', sr('camera_lbl', 'Camera'), 'videoInput') +
      field('audioOutput', sr('speaker', 'Speaker'), 'audioOutput');
    const el = sheet({
      title: sr('devices', 'Audio & video settings'),
      body: html || esc(sr('no_devices', 'No devices found. Check that camera and microphone permissions are allowed.')),
      actions: [{ label: sr('done', 'Done'), kind: 'ghost' }],
    });
    el.addEventListener('change', (ev) => {
      const s = ev.target.closest('select[data-kind]'); if (!s || !A?.api) return;
      const opt = s.selectedOptions[0]; const label = opt.dataset.label, id = s.value;
      try {
        if (s.dataset.kind === 'audioInput') A.api.setAudioInputDevice(label, id);
        else if (s.dataset.kind === 'videoInput') A.api.setVideoInputDevice(label, id);
        else A.api.setAudioOutputDevice(label, id);
        haptic('selection');
      } catch (e) { showToast(sr('device_fail', 'Could not switch that device.'), 'error'); }
    });
  }

  function refreshPeers() {
    if (!A?.api) return;
    let n = 1;
    try { n = A.api.getNumberOfParticipants(); } catch (_) { /* ignore */ }
    A.peers = n;
    const el = $('callPeers');
    if (el) el.textContent = n > 1 ? sr('peers', '{n} in call', { n }) : '';
    if (A.connected && n <= 1) showBanner(A.isHost
      ? sr('alone_host', 'Waiting for others to join…')
      : sr('alone_mentee', 'Your mentor stepped out. Stay here — you\'ll reconnect automatically when they\'re back.'));
    else hideBanner();
  }

  function setStatus(kind) {
    const dot = $('callDot'), label = $('callState');
    if (!dot || !label) return;
    dot.className = 'call-dot ' + kind;
    label.textContent = ({
      connecting: sr('connecting', 'Connecting…'),
      live: sr('live', 'Live'),
      offline: sr('offline', 'You\'re offline — reconnecting…'),
      problem: sr('problem', 'Connection problem'),
    })[kind] || '';
  }

  function startTick() {
    clearInterval(tickTimer);
    const el = $('callTimer');
    const render = () => {
      if (!A || !A.startedAt) return;
      const s = Math.floor((Date.now() - A.startedAt) / 1000);
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
      if (el) el.textContent = (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(ss).padStart(2, '0');
    };
    render(); tickTimer = setInterval(render, 1000);
  }

  function showBanner(text) { const b = $('callBanner'); if (b) { b.textContent = text; b.classList.remove('hidden'); } }
  function hideBanner() { $('callBanner')?.classList.add('hidden'); }

  // ── heartbeat: presence + live state (works even when the socket is down) ──
  function startHeartbeat() {
    stopHeartbeat();
    const tick = async () => {
      if (!A) return;
      try {
        const st = await apiFetch(`/api/sessions/${A.sessionId}/heartbeat`, { method: 'POST', body: { in_room: true }, retry: false, timeout: 8000 });
        if (!A) return;
        if (st.ended) return remoteEnded('ended');
        const was = A.hostPresent;
        A.hostPresent = !!st.host_present || A.isHost;
        A.presentCount = st.present_count || 1;
        if (A.phase === 'lobby') {
          A.waitedMs += HEARTBEAT_LOBBY_MS;
          if (!was && A.hostPresent) haptic('success');
          renderLobby();
        } else if (A.phase === 'call' && !A.isHost && A.hostPresent) hideBanner();
        if (A.phase === 'call' && A.connected) setStatus('live');
      } catch (e) {
        if (e.status === 404 || e.status === 403) return remoteEnded('ended');
        if (A?.phase === 'call') setStatus(navigator.onLine ? 'problem' : 'offline');
      }
      if (A) hbTimer = setTimeout(tick, A.phase === 'lobby' ? HEARTBEAT_LOBBY_MS : HEARTBEAT_CALL_MS);
    };
    hbTimer = setTimeout(tick, 0);
  }
  function stopHeartbeat() { clearTimeout(hbTimer); hbTimer = null; }

  // ── leaving ────────────────────────────────────────────────────────────────
  async function postLeave(end) {
    if (!A) return;
    try { await apiFetch(`/api/sessions/${A.sessionId}/leave`, { method: 'POST', body: { end: !!end }, retry: false, timeout: 8000 }); }
    catch (e) { console.error('[Session] leave failed:', e.message); }
  }

  function summary(a) {
    if (!a?.startedAt) return '';
    const mins = Math.max(1, Math.round((Date.now() - a.startedAt) / 60000));
    return sr('duration', 'You were in the call for {n} min.', { n: mins });
  }

  // Host pressed Leave, or Jitsi's hang-up: offer "keep open" vs "end for everyone".
  function hostLeaveSheet(alreadyLeft) {
    sheet({
      title: sr('host_leave_title', 'Leave the session?'),
      body: esc(sr('host_leave_body', 'You can leave and come back — the session stays open for others. Or end it for everyone.')),
      dismissible: !alreadyLeft,
      actions: [
        { label: sr('leave_open', 'Leave, keep session open'), onClick: () => finish({ end: false }) },
        { label: sr('end_all', 'End for everyone'), kind: 'danger', onClick: () => finish({ end: true }) },
        { label: alreadyLeft ? sr('rejoin', 'Rejoin the call') : sr('stay', 'Stay in call'), kind: 'ghost', onClick: () => { if (alreadyLeft) rejoin(); } },
      ],
    });
  }

  function handleHangup() {
    try { A.api?.dispose(); } catch (_) { /* ignore */ }
    A.api = null; window.jitsiApi = null; A.phase = 'left';
    if (A.isHost) { showStage('lobby'); $('sessionLobby').innerHTML = ''; hostLeaveSheet(true); }
    else finish({ end: false });
  }

  async function rejoin() {
    const id = A?.sessionId; if (!id) return;
    const opts = { skipLobby: true };
    A = null; await window.joinSession(id, opts);
  }

  window.leaveCurrentSession = function () {
    haptic('medium');
    if (!A) { navigate('sessions'); return; }
    if (A.phase === 'call' && A.isHost) return hostLeaveSheet(false);
    if (A.phase === 'external' && A.isHost) return hostLeaveSheet(false);
    finish({ end: false });
  };

  async function finish({ end }) {
    if (!A || A.ending) return;
    A.ending = true;
    const a = A;
    const wasLive = a.connected;
    await postLeave(end);
    teardown();
    navigate('sessions');
    if (wasLive) {
      sheet({
        title: end ? sr('ended_title', 'Session ended') : sr('left_title', 'You left the session'),
        body: esc(summary(a)),
        actions: [{ label: sr('done', 'Done'), kind: 'ghost' }],
      });
    }
    if (typeof loadSessions === 'function') loadSessions();
  }

  // The server (or the host) ended it while we're still inside.
  function remoteEnded(reason) {
    if (!A || A.ending) return;
    const a = A;
    A.ending = true;
    teardown();
    navigate('sessions');
    haptic('warning');
    sheet({
      title: sr('ended_title', 'Session ended'),
      body: esc([a.isHost ? '' : sr('ended_by_host', 'The session has been ended.'), summary(a)].filter(Boolean).join(' ')),
      actions: [{ label: sr('done', 'Done'), kind: 'ghost' }],
    });
    if (typeof loadSessions === 'function') loadSessions();
  }

  function teardown(opts = {}) {
    stopHeartbeat();
    clearInterval(tickTimer); tickTimer = null;
    clearTimeout(connectTimer); connectTimer = null;
    try { A?.api?.dispose(); } catch (_) { /* ignore */ }
    window.jitsiApi = null;
    releaseWakeLock();
    tg()?.disableClosingConfirmation?.();
    hideBanner();
    closeSheet();
    toggleShareScreenButtonVisibility(false);
    $('callStage')?.classList.remove('in-call');
    setCallChrome(false);
    const c = $('jitsiContainer'); if (c) c.innerHTML = '';
    const l = $('sessionLobby'); if (l) l.innerHTML = '';
    const timer = $('callTimer'); if (timer) timer.textContent = '00:00';
    window.activeSession = null;
    A = null;
  }

  // ── keep the screen awake + recover from backgrounding ─────────────────────
  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (_) { /* unsupported or denied — fine */ }
  }
  function releaseWakeLock() { try { wakeLock?.release(); } catch (_) { /* ignore */ } wakeLock = null; }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (!A) return;
    if (A.phase === 'call') acquireWakeLock();
    startHeartbeat(); // immediate state refresh after returning
    if (A.phase === 'external' && hiddenAt && Date.now() - hiddenAt > 15000 && !document.getElementById('srSheet')) {
      sheet({
        title: sr('back_title', 'Back from your browser?'),
        body: esc(sr('back_body', 'Is your session finished, or are you still in the call?')),
        actions: [
          { label: sr('still_in', 'I\'m still in the call'), kind: 'ghost' },
          ...(A.isHost ? [{ label: sr('end_all', 'End for everyone'), kind: 'danger', onClick: () => finish({ end: true }) }] : []),
          { label: sr('leave', 'Leave session'), onClick: () => finish({ end: false }) },
        ],
      });
    }
  });
  window.addEventListener('offline', () => { if (A?.phase === 'call') setStatus('offline'); });
  window.addEventListener('online', () => { if (A) { startHeartbeat(); if (A.phase === 'call') setStatus('live'); } });

  // ── screen share (host) ────────────────────────────────────────────────────
  window.toggleShareScreenButtonVisibility = function (show) {
    $('shareScreenBtn')?.classList.add('hidden'); // header button is covered by the full-screen call; the bar has its own
    $('ctlShare')?.classList.toggle('hidden', !show);
  };
  window.toggleScreenShare = function () {
    if (!A?.api) return;
    haptic('medium');
    if (!window.supportsScreenShare()) {
      if (window.isIOSDevice()) {
        showToast(sr('ios_share', 'Screen sharing over the web needs iOS 17 or later. Camera and mic still work fine.'), 'info');
        return;
      }
      return sheet({
        title: sr('share_title', 'Screen sharing isn\'t available here'),
        body: esc(sr('share_body', 'Open the session in your phone\'s browser to share your screen.')),
        actions: [{ label: sr('open_browser', 'Open in browser instead'), onClick: () => window.SR.external() }, { label: sr('cancel', 'Cancel'), kind: 'ghost' }],
      });
    }
    try { A.api.executeCommand('toggleShareScreen'); }
    catch (e) { console.error(e); showToast(sr('share_fail', 'Could not start screen sharing on this device.'), 'error'); }
  };

  // ── realtime events (wired from app.js socket handlers) ────────────────────
  window.SRsocket = {
    hostJoined(sessionId) {
      if (A && A.sessionId === sessionId) { A.hostPresent = true; hideBanner(); if (A.phase === 'lobby') { haptic('success'); renderLobby(); } }
    },
    hostLeft(sessionId) {
      if (A && A.sessionId === sessionId && A.phase === 'call') showBanner(sr('alone_mentee', 'Your mentor stepped out. Stay here — you\'ll reconnect automatically when they\'re back.'));
    },
    ended(sessionId, reason) { if (A && A.sessionId === sessionId) remoteEnded(reason); },
    waiting(sessionId, name) {
      if (A && A.sessionId === sessionId) return; // already there
      haptic('success');
      banner({ text: sr('waiting_banner', '{name} is waiting for you', { name: name || 'Someone' }), actionLabel: sr('join', 'Join'), onAction: () => window.joinSession(sessionId, { skipLobby: true }) });
    },
    invite(sessionId, title) {
      banner({ text: `${sr('invite', 'New session')}: ${title || ''}`, actionLabel: sr('view', 'View'), onAction: () => navigate('sessions'), ttl: 12000 });
    },
  };

  // ── handlers for inline onclick in the lobby ───────────────────────────────
  window.SR = {
    mic() { haptic('selection'); if (!cmd('toggleAudio')) showToast(sr('ctl_fail', 'Controls are not ready yet.'), 'info'); },
    cam() { haptic('selection'); if (!cmd('toggleVideo')) showToast(sr('ctl_fail', 'Controls are not ready yet.'), 'info'); },
    flip() {
      haptic('selection');
      if (!cmd('toggleCamera')) devicesSheet(); // fall back to the camera picker
    },
    chat() { haptic('selection'); cmd('toggleChat'); },
    more() { haptic('light'); if (A) moreSheet(); },
    toggle(which) {
      if (!A) return;
      A.prefs[which] = !A.prefs[which]; savePrefs(A.prefs); haptic('selection'); renderLobby();
    },
    start() { if (A && (A.isHost || A.hostPresent || A.waitedMs > 20000)) startCall(); },
    async external() {
      if (!A) return;
      const a = A;
      closeSheet(); clearTimeout(connectTimer);
      a.phase = 'switching'; // so disposing the embed isn't mistaken for a hang-up
      try { a.api?.dispose(); } catch (_) { /* ignore */ }
      a.api = null; window.jitsiApi = null;
      // Re-register as an external participant: Jitsi's own page can't heartbeat.
      try { a.data = await apiFetch(`/api/sessions/${a.sessionId}/join?via=external`, { retry: false }); } catch (_) { /* keep existing credentials */ }
      if (A === a) openExternal();
    },
    reopenExternal() { if (A) openExternalUrl(window.buildExternalSessionUrl(A.data, A.prefs)); },
    leave() { if (A?.isHost) hostLeaveSheet(false); else finish({ end: false }); },
    async cancelLobby() { if (!A) return navigate('sessions'); await postLeave(false); teardown(); navigate('sessions'); },
    async copyPass() {
      const pw = A?.data?.room_password; if (!pw) return;
      try { await navigator.clipboard.writeText(pw); showToast(sr('copied', 'Copied'), 'success'); }
      catch (_) { showToast(pw, 'info'); }
    },
  };
})();
