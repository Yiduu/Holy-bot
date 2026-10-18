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

  // Brand line icons (24px grid, 1.8 stroke — same family as the bottom-nav icons).
  const ICO = {
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line class="ico-slash" x1="3" y1="3" x2="21" y2="21"/>',
    cam: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/><line class="ico-slash" x1="3" y1="3" x2="21" y2="21"/>',
  };
  const ico = (name, off) => `<svg class="ico${off ? ' is-off' : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICO[name]}</svg>`;

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
      haptic('error'); showToast(sr('select_mentee_first', 'Please select a mentee first.'), 'error'); return;
    }
    creating = true;
    haptic('light');
    try {
      const title = customTitle || (is_group ? sr('group_session_default', 'Group Session') : sr('private_session_default', 'Private session'));
      const finalScheduled = scheduled_at || new Date().toISOString();
      const data = await apiFetch('/api/sessions/create', {
        method: 'POST',
        body: { is_group, title, scheduled_at: finalScheduled, mentee_id: mentee_id || null, participant_ids: participant_ids.length ? participant_ids : undefined },
      });
      haptic('success');
      showToast(is_group ? sr('group_session_created', 'Group session created!') : sr('private_session_created', 'Private session created!'), 'success');
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
    $('callTitle').textContent = data.title || sr('live_session_title', 'Live Session');
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
    const unreliable = window.detectUnreliableSessionEnvironment() && data.call_mode !== 'audio';
    const audioMode = data.call_mode === 'audio' && !!window.HolyAudioCall;
    // The mentor can choose a plain audio call in a 1-on-1 session.
    const canAudio = isHost && !data.is_group && !!window.HolyAudioCall && !!window.RTCPeerConnection;

    // Heartbeats re-render this every few seconds; skip when nothing visible changed.
    const key = JSON.stringify([hostPresent, waiting, prefs.mic, prefs.cam, A.waitedMs > 20000, data.call_mode]);
    if (A.lobbyKey === key && $('sessionLobby').firstChild) return;
    A.lobbyKey = key;

    // One calm message, one big button. Everything else lives under "Having trouble?".
    let tone, headline, line;
    if (isHost) {
      tone = waiting > 0 ? 'ok' : 'wait';
      headline = waiting > 0 ? sr('n_waiting', '{n} waiting for you', { n: waiting }) : sr('host_ready_title', 'Ready when you are');
      line = sr('host_ready', 'You\'re the host — others will be notified when you start.');
    } else if (hostPresent) {
      tone = 'ok';
      headline = sr('host_here_title', 'Your mentor is here');
      line = sr('host_here_short', 'Check your mic, then tap Join.');
    } else {
      tone = 'wait';
      headline = sr('host_wait_title', 'Waiting for your mentor');
      line = sr('host_wait_short', 'You will be let in the moment they arrive. You can keep this screen open.');
    }
    const heroIcon = tone === 'ok'
      ? '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 12 10 17 19 7"/></svg>'
      : '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>';

    const primary = isHost
      ? (canAudio ? sr('start_video_session', 'Start video session') : sr('start', 'Start session'))
      : (hostPresent ? sr('join_now', 'Join now') : sr('join_session', 'Join session'));
    const badge = data.is_group ? sr('group_session_badge', 'Group session')
      : audioMode ? sr('audio_badge', 'Audio call') : sr('1on1_session_badge', '1-on-1 session');

    $('sessionLobby').innerHTML = `
      <div class="sr-card sr-lobby">
        <div class="sr-eyebrow">${esc(badge)} · ${esc(formatDateTime(data.scheduled_at))}</div>
        <div class="sr-hero sr-hero--${tone}" aria-hidden="true"><span class="sr-hero-core">${heroIcon}</span></div>
        <div class="sr-title" role="status" aria-live="polite">${esc(headline)}</div>
        <div class="sr-sub">${esc(line)}</div>
        <div class="sr-toggles">
          <button class="sr-toggle ${prefs.mic ? 'on' : ''}" onclick="SR.toggle('mic')" aria-pressed="${prefs.mic}">
            <span class="sr-ico">${ico('mic', !prefs.mic)}</span><span>${prefs.mic ? esc(sr('mic_on', 'Mic on')) : esc(sr('mic_off', 'Mic off'))}</span>
          </button>
          ${audioMode ? '' : `<button class="sr-toggle ${prefs.cam ? 'on' : ''}" onclick="SR.toggle('cam')" aria-pressed="${prefs.cam}">
            <span class="sr-ico">${ico('cam', !prefs.cam)}</span><span>${prefs.cam ? esc(sr('cam_on', 'Camera on')) : esc(sr('cam_off', 'Camera off'))}</span>
          </button>`}
        </div>
        <div class="sr-hint">${esc(audioMode ? sr('audio_hint', 'This is an audio call — no camera needed.') : sr('cam_hint', 'Camera is optional — you can turn it on any time during the call.'))}</div>
        <button class="btn btn-primary sr-primary" ${canEnter ? '' : 'disabled'} onclick="SR.start()">${esc(primary)}</button>
        ${canAudio ? `<button class="btn btn-outline sr-secondary" onclick="SR.startAudio()">${esc(sr('start_audio', 'Start audio call'))}</button>` : ''}
        ${unreliable
          ? `<button class="btn btn-outline sr-secondary" onclick="SR.external()">${esc(sr('open_browser_rec', 'Open in browser (recommended)'))}</button>`
          : `<button class="sr-link" onclick="SR.trouble()">${esc(sr('having_trouble', 'Having trouble?'))}</button>`}
      </div>`;
  }

  // ── hand-off page: browser / Jitsi Meet app ────────────────────────────────
  // The old flow opened the browser immediately, which buried this screen — so
  // the room password (Jitsi's own page asks for it) was never seen or copied.
  // Now NOTHING opens until the person taps the button, and the password with a
  // Copy button is the first thing on the page.
  //   mode 'browser' → Jitsi in the phone/desktop browser
  //   mode 'app'     → the free Jitsi Meet mobile app (the only way to share a
  //                    phone screen: mobile browsers have no getDisplayMedia)
  const STORE_ANDROID = 'https://play.google.com/store/apps/details?id=org.jitsi.meet';
  const STORE_IOS = 'https://apps.apple.com/app/jitsi-meet/id1165103905';

  window.buildAppSessionUrl = function (data) {
    return `org.jitsi.meet://${data.jitsi_domain}/${data.room_name}` + (data.jitsi_token ? `?jwt=${data.jitsi_token}` : '');
  };
  // https page (frontend/open-app.html) that launches the app from a real browser.
  // Values go in the #fragment so the room token never reaches a server log.
  window.buildAppLauncherUrl = function (data) {
    const p = [`d=${encodeURIComponent(data.jitsi_domain)}`, `r=${encodeURIComponent(data.room_name)}`];
    if (data.jitsi_token) p.push(`j=${encodeURIComponent(data.jitsi_token)}`);
    return `${window.location.origin}/open-app.html#${p.join('&')}`;
  };

  async function copyText(text) {
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (_) { /* try the fallback */ }
    // Some WebViews have no async clipboard — fall back to a selected textarea.
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy'); ta.remove();
      return !!ok;
    } catch (_) { return false; }
  }

  function openHandoff(mode) {
    A.phase = 'external';
    A.external = true;
    A.handoff = mode === 'app' ? 'app' : 'browser';
    A.handoffOpened = false;
    A.passCopied = false;
    window.activeSession.connected = true;
    renderHandoff();
  }
  const openExternal = () => openHandoff('browser');

  function renderHandoff() {
    if (!A) return;
    showStage('lobby');
    const { data, isHost } = A;
    const isApp = A.handoff === 'app';
    const pw = data.room_password;
    const opened = !!A.handoffOpened;
    const touch = isTouchDevice();
    const ios = window.isIOSDevice();
    const android = /Android/i.test(navigator.userAgent || '');

    const openLabel = opened
      ? sr('open_again', 'Open again')
      : (isApp ? sr('open_app_btn', 'Open Jitsi Meet app') : sr('open_browser_btn', 'Open browser'));
    const copyLabel = A.passCopied ? sr('copied_btn', 'Copied ✓') : sr('copy_pass', 'Copy password');
    // One calm column: icon, title, one line, the password (small), one big button.
    // No numbered steps and no repeated hints: the button already says what happens next.
    const passStep = pw ? `
      <div class="sr-pass">
        <div class="sr-pass-label">${esc(sr('pass_label', 'If you are asked for a password'))}</div>
        <div class="sr-pass-row"><code>${esc(pw)}</code>
          <button class="btn btn-primary btn-sm sr-copy-btn ${A.passCopied ? 'is-done' : ''}" onclick="SR.copyPass()">${esc(copyLabel)}</button></div>
      </div>` : '';

    const openStep = `<button class="btn btn-primary sr-primary" onclick="SR.openHandoff()">${esc(openLabel)}</button>`;

    // App mode: install links (the app is a separate download) + a way to carry on elsewhere.
    const installLinks = isApp ? `
      <div class="sr-install">${esc(sr('install_app', 'Don\'t have the app yet?'))}
        ${(!ios ? `<button class="sr-link" onclick="SR.store('android')">${esc(sr('install_android', 'Google Play'))}</button>` : '')}
        ${(!android ? `<button class="sr-link" onclick="SR.store('ios')">${esc(sr('install_ios', 'App Store'))}</button>` : '')}
      </div>
      <button class="sr-link" onclick="SR.copyLink()">${esc(sr('share_copy_link', 'Copy link to open on a computer'))}</button>` : '';

    const shareNote = (!isApp && isHost && touch) ? `
      <button class="btn btn-outline sr-secondary" onclick="SR.shareApp()">${esc(sr('share_phone', 'Share my phone screen (Jitsi Meet app)'))}</button>` : '';
    // Telegram sometimes opens the link in its own built-in browser, which Jitsi calls "a browser
    // we don't fully support" (no reliable microphone). A real browser fixes it, so make that one tap away.
    const browserHelp = !isApp ? `
      <div class="sr-hint">${esc(sr('browser_help', 'Seeing "browser we don\'t fully support"? Copy the link and open it in Chrome or Safari.'))}</div>
      <button class="sr-link" onclick="SR.copyLink()">${esc(sr('copy_link_browser', 'Copy link for Chrome or Safari'))}</button>` : '';
    const switchToBrowser = isApp ? `<button class="btn btn-outline sr-secondary" onclick="SR.external()">${esc(sr('open_browser', 'Open in browser instead'))}</button>` : '';

    $('sessionLobby').innerHTML = `
      <div class="sr-card sr-handoff">
        <div class="sr-ho-icon" aria-hidden="true">${isApp
          ? '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>'
          : '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/></svg>'}</div>
        <div class="sr-title">${esc(data.title || sr('live_session_title', 'Live Session'))}</div>
        <div class="sr-sub">${esc(opened
          ? sr('ext_sub', 'Tap Join on the page that opened. Come back here when you\'re done.')
          : (pw ? sr('hand_sub_pw', 'Copy the password first — it won\'t be visible once the next app opens.')
                : sr('hand_sub_nopw', 'Tap the button below when you\'re ready.')))}</div>
        ${passStep}
        ${openStep}
        ${shareNote}
        ${installLinks}
        ${switchToBrowser}
        ${browserHelp}
        <button class="${opened ? 'btn btn-primary sr-primary' : 'btn btn-outline sr-secondary sr-cancel'}" onclick="SR.leave()">${esc(opened ? sr('im_done', 'I\'m done — leave session') : sr('cancel', 'Cancel'))}</button>
      </div>`;
  }

  // Takes the person out of the embedded call and onto the hand-off page.
  async function switchToHandoff(mode) {
    if (!A) return;
    const a = A;
    closeSheet(); clearTimeout(connectTimer);
    a.phase = 'switching'; // so disposing the embed isn't mistaken for a hang-up
    try { a.api?.dispose(); } catch (_) { /* ignore */ }
    a.api = null; window.jitsiApi = null;
    // Re-register as an external participant: Jitsi's own page / app can't heartbeat.
    try { a.data = await apiFetch(`/api/sessions/${a.sessionId}/join?via=external`, { retry: false }); } catch (_) { /* keep existing credentials */ }
    if (A === a) openHandoff(mode);
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
    renderControls();
    setStatus('connecting');
    toggleShareScreenButtonVisibility(A.isHost && A.data.call_mode !== 'audio');
    acquireWakeLock();
    if (A.data.call_mode === 'audio' && window.HolyAudioCall) return startAudio();
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
      // The lobby said "Mic on", but the room can start people muted (a moderator's
      // "everyone starts muted" setting). Check once, after the server's policy has
      // been applied, and unmute so nobody sits silent without knowing.
      if (prefs.mic) {
        setTimeout(async () => {
          if (!A || A.api !== api || A.micTouched) return;
          try { if (await api.isAudioMuted()) api.executeCommand('toggleAudio'); } catch (_) { /* ignore */ }
        }, 1500);
      }
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
    // A dead microphone used to fail quietly. Say it, and offer the browser, which
    // handles microphone permission far better than a phone's in-app WebView.
    const micTrouble = () => banner({
      text: sr('mic_dead', 'Your microphone isn\'t working here, so others can\'t hear you.'),
      actionLabel: sr('open_browser_short', 'Open in browser'),
      onAction: () => window.SR.external(),
      ttl: 30000,
    });
    api.addEventListener('micError', micTrouble);
    api.addEventListener('noAudioInputDetected', micTrouble);
    api.addEventListener('errorOccurred', (err) => {
      console.error('[Jitsi] errorOccurred:', err);
      if (err?.error?.isFatal) setStatus('problem');
    });
    // Hang-up from Jitsi's own toolbar.
    const onHangup = () => { if (A && !A.ending && A.phase === 'call') handleHangup(); };
    api.addEventListener('videoConferenceLeft', onHangup);
    api.addEventListener('readyToClose', onHangup);
  }

  // ── built-in audio call (1-on-1) ───────────────────────────────────────────
  // Same stage, same status bar and Leave button as the video call; only the middle
  // is different. Anything that stops audio from working offers the video room, and
  // switching is session-wide (the server tells the other phone) so both people
  // always end up in the same kind of call.
  const APPLY_STATUS = { live: 'live', weak: 'weak', reconnecting: 'connecting', connecting: 'connecting' };
  function audioPanel() {
    const who = A.isHost ? sr('audio_mentee', 'Your mentee') : sr('audio_mentor', 'Your mentor');
    $('jitsiContainer').innerHTML = `
      <div class="ac-panel" id="acPanel">
        <div class="ac-rings"><div class="ac-ring ac-ring--out"><div class="ac-ring ac-ring--mid"><div class="ac-avatar" id="acAvatar">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </div></div></div></div>
        <div class="ac-who">${esc(who)}</div>
        <div class="ac-line" id="acLine" role="status" aria-live="polite">${esc(sr('audio_connecting', 'Connecting…'))}</div>
        <div class="ac-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="ac-actions" id="acActions"></div>
      </div>`;
  }
  function acLine(text, actions) {
    const l = $('acLine'); if (l) l.textContent = text || '';
    const a = $('acActions'); if (!a) return;
    a.innerHTML = (actions || []).map(x => `<button class="btn ${x.primary ? 'btn-primary' : 'btn-outline'} sr-secondary" onclick="${x.on}">${esc(x.label)}</button>`).join('');
  }
  async function startAudio() {
    const stage = $('callStage');
    stage.classList.add('is-audio');
    A.audio = true;
    audioPanel();
    renderControls();
    const sid = A.sessionId;
    const call = window.HolyAudioCall.create({
      isHost: A.isHost,
      ice: async () => (await apiFetch(`/api/sessions/${sid}/ice`, { retry: false, timeout: 8000 })).iceServers,
      signal: (kind, data) => apiFetch(`/api/sessions/${sid}/signal`, { method: 'POST', body: { kind, data }, retry: false, timeout: 8000 }),
      onStatus: (k) => {
        if (!A || A.call !== call) return;
        if (k === 'closed') return;
        const live = k === 'live' || k === 'weak';
        if (live && !A.connected) { A.connected = true; A.startedAt = Date.now(); window.activeSession.connected = true; startTick(); haptic('success'); }
        if (live) {
          acLine(k === 'weak' ? sr('audio_weak', 'Your internet is slow. The call is saving data to keep your voice clear.') : '',
            k === 'weak' ? [{ label: sr('try_now', 'Try again now'), on: 'SR.audioRetry()' }] : []);
        } else if (k === 'reconnecting') acLine(sr('audio_reconnecting', 'Reconnecting… stay on this screen.'), [{ label: sr('try_now', 'Try again now'), on: 'SR.audioRetry()' }]);
        else acLine(A.isHost ? sr('audio_wait_peer', 'Waiting for the other person…') : sr('audio_connecting', 'Connecting…'));
        setStatus(k === 'weak' ? 'weak' : (live ? 'live' : (k === 'reconnecting' ? 'reconnecting' : 'connecting')));
      },
      onLevel: ({ local, remote }) => {
        const p = $('acPanel'); if (!p) return;
        p.style.setProperty('--ac-remote', remote.toFixed(2)); p.style.setProperty('--ac-local', local.toFixed(2));
        p.classList.toggle('is-speaking', remote > 0.08);
      },
      onAutoplayBlocked: () => acLine(sr('audio_tap_hear', 'Tap to hear the call'), [{ label: sr('audio_hear', 'Tap to hear'), primary: true, on: 'SR.audioListen()' }]),
      onFail: (why) => audioFailed(why),
    });
    A.call = call;
    call.setMuted(A.micMuted);
    renderControls();
    const ok = await call.start();
    if (!ok && A && A.call === call) return; // onFail already told the person
  }
  function audioFailed(why) {
    if (!A || !A.audio) return;
    haptic('error');
    const body = why === 'blocked' ? sr('audio_blocked', 'Your phone is blocking the microphone inside this app. Allow it, or use the video call, which works in more places.')
      : why === 'nomic' ? sr('audio_nomic', 'We could not find a microphone on this device.')
      : why === 'unsupported' ? sr('audio_unsupported', 'Calls with sound are not supported here. The video call should work.')
      : sr('audio_failed', 'We could not connect the call.');
    setStatus('problem');
    acLine(body, [
      ...(why === 'blocked' || why === 'error' ? [{ label: sr('audio_allow', 'Try again'), primary: true, on: 'SR.audioRestart()' }] : []),
      { label: sr('audio_use_video', 'Use the video call instead'), on: 'SR.useVideo()' },
    ]);
  }
  function stopAudio(notify) {
    const c = A && A.call; if (!c) return;
    A.call = null; A.audio = false;
    try { c.stop(notify); } catch (_) { /* ignore */ }
    $('callStage')?.classList.remove('is-audio');
  }
  // The mentor's choice (or a "use video" switch) arrived from the server or a heartbeat.
  function followMode(mode) {
    if (!A || A.data.call_mode === mode || (mode !== 'audio' && mode !== 'video')) return;
    if (A.phase === 'call') { if (mode === 'video') switchToVideo(false); return; }
    A.data.call_mode = mode; A.lobbyKey = '';
    if (A.phase === 'lobby') renderLobby();
  }
  // Whole session moves to the video room. `tell` = we are the one who asked.
  async function switchToVideo(tell) {
    if (!A || A.data.call_mode !== 'audio') return;
    const sid = A.sessionId;
    if (tell) { try { await apiFetch(`/api/sessions/${sid}/call-mode`, { method: 'POST', body: { mode: 'video' }, retry: false, timeout: 8000 }); } catch (_) { /* heartbeat tells the other phone */ } }
    if (!A || A.sessionId !== sid) return;
    stopAudio(false);
    A.data.call_mode = 'video'; A.connected = false; A.startedAt = 0; A.phase = 'lobby'; A.lobbyKey = '';
    showToast(sr('audio_to_video', 'Switched to the video call.'), 'info');
    startCall();
  }

  // ── call controls ──────────────────────────────────────────────────────────
  function isTouchDevice() { return (navigator.maxTouchPoints || 0) > 0; }

  function renderControls() {
    if (!A) return;
    // Icons are static inline SVGs in index.html; only the state and label change.
    const set = (id, on, lblOn, lblOff) => {
      const b = $(id); if (!b) return;
      b.classList.toggle('off', !on);
      b.setAttribute('aria-pressed', String(on));
      const lbl = b.querySelector('.ctl-lbl');
      if (lbl) lbl.textContent = on ? lblOn : lblOff;
    };
    set('ctlMic', !A.micMuted, sr('mute', 'Mute'), sr('unmute', 'Unmute'));
    set('ctlCam', !A.camMuted, sr('camera', 'Camera'), sr('start_video', 'Start'));
    $('ctlCam')?.classList.toggle('hidden', !!A.audio);
    $('ctlChat')?.classList.toggle('hidden', !!A.audio);
    const setLbl = (id, lbl) => { const el = $(id)?.querySelector('.ctl-lbl'); if (el) el.textContent = lbl; };
    setLbl('ctlFlip', sr('flip', 'Flip'));
    setLbl('ctlShare', sr('share', 'Share'));
    setLbl('ctlChat', sr('chat', 'Chat'));
    setLbl('ctlMore', sr('more_btn', 'More'));
    setLbl('ctlLeave', sr('leave_btn', 'Leave'));
    $('ctlShare')?.classList.toggle('active', !!A.sharing);
  }

  function cmd(name, ...args) {
    if (!A?.api) return false;
    try { A.api.executeCommand(name, ...args); return true; }
    catch (e) { console.error('[Call] command failed:', name, e); return false; }
  }

  function moreSheet() {
    if (A.audio) {
      return sheet({ title: sr('more', 'More'), actions: [
        { label: sr('audio_use_video', 'Use the video call instead'), kind: 'ghost', onClick: () => switchToVideo(true) },
        { label: sr('having_trouble', 'Having trouble?'), kind: 'ghost', onClick: troubleSheet },
        { label: sr('close', 'Close'), kind: 'ghost' },
      ] });
    }
    const items = [
      { label: sr('devices', 'Audio & video settings'), onClick: devicesSheet },
      { label: A.hand ? sr('lower_hand', 'Lower hand') : sr('raise_hand', 'Raise hand'), onClick: () => { A.hand = !A.hand; cmd('toggleRaiseHand'); } },
      { label: sr('participants', 'Participants'), onClick: () => cmd('toggleParticipantsPane', true) },
      { label: A.tiles ? sr('speaker_view', 'Speaker view') : sr('tile_view', 'Grid view'), onClick: () => { A.tiles = !A.tiles; cmd('toggleTileView'); } },
    ];
    if (A.isHost) items.push({ label: sr('mute_all', 'Mute everyone'), onClick: () => { cmd('muteEveryone'); showToast(sr('muted_all', 'Everyone has been muted.'), 'success'); } });
    if (isTouchDevice()) items.unshift({ label: sr('flip_camera', 'Flip camera'), onClick: () => window.SR.flip() });
    if (A.isHost) items.unshift({ label: A.sharing ? sr('stop_share', 'Stop sharing') : sr('share_screen', 'Share screen'), onClick: () => window.toggleScreenShare() });
    items.push({ label: sr('having_trouble', 'Having trouble?'), onClick: troubleSheet });
    sheet({ title: sr('more', 'More'), actions: items.map(i => ({ ...i, kind: 'ghost' })) });
  }

  // "Having trouble?" — every fallback in one place, in the order to try them.
  function troubleSheet() {
    if (!A) return;
    const pw = A.data.room_password;
    const passHtml = pw ? `
      <div class="sr-pass sr-trouble-pass">
        <div class="sr-pass-label">${esc(sr('pass_label', 'If you are asked for a password'))}</div>
        <div class="sr-pass-row"><code>${esc(pw)}</code>
          <button class="btn btn-primary btn-sm sr-copy-btn" onclick="SR.copyPass()">${esc(sr('copy_short', 'Copy'))}</button></div>
      </div>` : '';
    const actions = [
      { label: sr('try_again', 'Try again'), onClick: () => window.SR.retry() },
      { label: sr('open_browser_btn2', 'Open in your browser'), kind: 'ghost', onClick: () => window.SR.external() },
      { label: sr('use_jitsi_app', 'Use the Jitsi Meet app'), kind: 'ghost', onClick: () => window.SR.shareApp() },
    ];
    if (!A.isHost && !A.hostPresent && A.phase === 'lobby') actions.push({ label: sr('join_anyway_short', 'Join anyway'), kind: 'ghost', onClick: () => window.SR.start() });
    actions.push({ label: sr('close', 'Close'), kind: 'ghost' });
    sheet({ title: sr('cant_connect', 'Can\'t connect?'), body: `<span class="sr-trouble-lead">${esc(sr('try_one', 'Try these, one at a time.'))}</span>` + passHtml, actions });
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
      live: sr('connected', 'Connected'),
      weak: sr('weak_conn', 'Weak connection'),
      reconnecting: sr('reconnecting', 'Reconnecting…'),
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
        if (st.call_mode) followMode(st.call_mode);
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
    try { A?.call?.stop(); } catch (_) { /* ignore */ }
    $('callStage')?.classList.remove('is-audio');
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
    // Only ask "back from your browser?" once the browser/app was really opened —
    // not when someone merely locked their phone on the hand-off page.
    if (A.phase === 'external' && A.handoffOpened && hiddenAt && Date.now() - hiddenAt > 15000 && !document.getElementById('srSheet')) {
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
  // Phone browsers and in-app WebViews do not expose getDisplayMedia, so no web page
  // (ours or Jitsi's) can share a phone screen — only the native Jitsi Meet app can.
  // Explain that once, then hand off to a page with the password + an Open-app button.
  function screenShareUnavailable() {
    const touch = isTouchDevice();
    const actions = [];
    if (touch) actions.push({ label: sr('share_continue', 'Continue — share from the app'), onClick: () => window.SR.shareApp() });
    actions.push({
      label: sr('share_copy_link', 'Copy link to open on a computer'),
      kind: 'ghost',
      onClick: async () => {
        const ok = await copyText(window.buildExternalSessionUrl(A.data, A.prefs));
        showToast(ok ? sr('copied', 'Copied') : sr('copy_fail', 'Could not copy — long-press the password to copy it.'), ok ? 'success' : 'info');
      },
    });
    actions.push({ label: sr('cancel', 'Cancel'), kind: 'ghost' });
    sheet({
      title: touch ? sr('share_title', 'Share your phone screen') : sr('share_title_desktop', 'Screen sharing isn\'t available here'),
      body: esc(touch
        ? sr('share_body', 'Phone browsers can\'t share the screen — only the free Jitsi Meet app can. We\'ll take you to a page with the room password and a button to open the app.')
        : sr('share_body_desktop', 'This browser can\'t share the screen. Try Chrome, Edge or Firefox on a computer.')),
      actions,
    });
  }
  window.toggleScreenShare = function () {
    if (!A?.api) return;
    haptic('medium');
    if (!window.supportsScreenShare()) return screenShareUnavailable();
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
    signal(msg) { if (A && A.call && msg && msg.session_id === A.sessionId) A.call.handleSignal(msg); },
    modeChanged(sessionId, mode) { if (A && A.sessionId === sessionId) followMode(mode); },
    waiting(sessionId, name) {
      if (A && A.sessionId === sessionId) return; // already there
      haptic('success');
      banner({ text: sr('waiting_banner', '{name} is waiting for you', { name: name || 'Someone' }), actionLabel: sr('join', 'Join'), onAction: () => window.joinSession(sessionId, { skipLobby: true }) });
    },
    invite(sessionId, title) {
      banner({ text: `${sr('invite', 'New session')}: ${title || ''}`, actionLabel: sr('view', 'View'), onAction: () => navigate('sessions'), ttl: 12000 });
    },
    // Same banner for any other in-app notification (mentee requests, referrals).
    notify(opts) { banner(opts || {}); },
  };

  // ── handlers for inline onclick in the lobby ───────────────────────────────
  window.SR = {
    audioRetry() { A?.call?.retry(); },
    audioListen() { A?.call?.listen().then(ok => { if (ok && A) acLine(''); }); },
    audioRestart() { if (!A) return; stopAudio(false); A.phase = 'lobby'; startCall(); },
    useVideo() { switchToVideo(true); },
    // Mentor picks the call type. The server stores it so the mentee follows.
    async startAudio() {
      if (!A || !A.isHost) return;
      if (!window.RTCPeerConnection) return showToast(sr('audio_unsupported', 'Calls with sound are not supported here. The video call should work.'), 'info');
      try { await apiFetch(`/api/sessions/${A.sessionId}/call-mode`, { method: 'POST', body: { mode: 'audio' }, retry: false, timeout: 8000 }); }
      catch (e) { return showToast(sr('audio_pick_fail', 'Could not start the audio call. Try again, or start the video session.'), 'error'); }
      if (!A) return;
      A.data.call_mode = 'audio'; A.lobbyKey = '';
      startCall();
    },
    mic() {
      if (A && A.audio) { haptic('selection'); A.micMuted = !A.micMuted; A.call?.setMuted(A.micMuted); renderControls(); return; }
      haptic('selection'); if (A) A.micTouched = true; if (!cmd('toggleAudio')) showToast(sr('ctl_fail', 'Controls are not ready yet.'), 'info'); },
    cam() { haptic('selection'); if (!cmd('toggleVideo')) showToast(sr('ctl_fail', 'Controls are not ready yet.'), 'info'); },
    flip() {
      haptic('selection');
      if (!cmd('toggleCamera')) devicesSheet(); // fall back to the camera picker
    },
    chat() { haptic('selection'); cmd('toggleChat'); },
    more() { haptic('light'); if (A) moreSheet(); },
    trouble() { haptic('light'); troubleSheet(); },
    retry() {
      if (!A) return;
      closeSheet();
      if (A.phase === 'call') return rejoin();
      if (A.isHost || A.hostPresent) return startCall();
      startHeartbeat();
      showToast(sr('checking_again', 'Checking again…'), 'info');
    },
    toggle(which) {
      if (!A) return;
      A.prefs[which] = !A.prefs[which]; savePrefs(A.prefs); haptic('selection'); renderLobby();
    },
    async start() {
      if (!A || !(A.isHost || A.hostPresent || A.waitedMs > 20000)) return;
      // Mentor chose audio earlier but now wants video: tell the server first.
      if (A.isHost && A.data.call_mode === 'audio') {
        try { await apiFetch(`/api/sessions/${A.sessionId}/call-mode`, { method: 'POST', body: { mode: 'video' }, retry: false, timeout: 8000 }); } catch (_) { /* join gives the mode anyway */ }
        if (!A) return; A.data.call_mode = 'video';
      }
      startCall();
    },
    // "Open in browser instead" → hand-off page (nothing opens until the button there is tapped).
    external() { return switchToHandoff('browser'); },
    // Phone screen share → hand-off page for the Jitsi Meet app.
    shareApp() { return switchToHandoff('app'); },
    // The big button on the hand-off page. It is a tap, so copying + opening are both allowed.
    async openHandoff() {
      if (!A || A.phase !== 'external') return;
      const pw = A.data.room_password;
      // Best effort: put the password on the clipboard too, in case they skipped step 1.
      if (pw && !A.passCopied) { A.passCopied = await copyText(pw); }
      if (!A) return;
      if (A.handoff === 'app') {
        // Never navigate THIS page to org.jitsi.meet:// — Telegram's WebView shows an
        // error page for unknown schemes. A small launcher page opened in the phone's
        // real browser starts the app (and falls back to the store if it is missing).
        openExternalUrl(window.buildAppLauncherUrl(A.data));
      } else {
        openExternalUrl(window.buildExternalSessionUrl(A.data, A.prefs));
      }
      A.handoffOpened = true;
      renderHandoff();
    },
    store(which) { openExternalUrl(which === 'ios' ? STORE_IOS : STORE_ANDROID); },
    async copyLink() {
      if (!A) return;
      const ok = await copyText(window.buildExternalSessionUrl(A.data, A.prefs));
      showToast(ok ? sr('copied', 'Copied') : sr('copy_fail', 'Could not copy — long-press the password to copy it.'), ok ? 'success' : 'info');
    },
    leave() { if (A?.isHost) hostLeaveSheet(false); else finish({ end: false }); },
    async cancelLobby() { if (!A) return navigate('sessions'); await postLeave(false); teardown(); navigate('sessions'); },
    async copyPass() {
      const pw = A?.data?.room_password; if (!pw) return;
      const ok = await copyText(pw);
      if (!A) return;
      A.passCopied = ok;
      if (ok) { haptic('success'); showToast(sr('copied', 'Copied'), 'success'); if (A.phase === 'external') renderHandoff(); }
      else showToast(sr('copy_fail', 'Could not copy — long-press the password to copy it.'), 'info');
    },
  };
})();
