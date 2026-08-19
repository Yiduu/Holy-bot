/* ============================================================
   Recovery App – Main App Logic
   ============================================================ */

const API = window.location.origin;
let socket = null;
let currentUser = null;
let currentPage = 'dashboard';
let jitsiApi = null;

// ─── Viewport height (Telegram-aware) ───────────────────────────
// Raw `100vh` is what was driving the chat input box under the bottom
// nav: Telegram's WebView visible area (viewportStableHeight) is often
// shorter than the CSS layout viewport (100vh) — most obviously once the
// on-screen keyboard opens for typing, but also just from Telegram's own
// header/safe-area chrome. Every place in styles.css that sized the app
// shell off `100vh` computed against the wrong, taller number, so the
// fixed bottom nav (anchored to the *real* viewport bottom) ended up
// drawn on top of content — including the chat input — that assumed it
// had that extra space. `--app-height` tracks the real visible height and
// updates live as Telegram resizes it (keyboard open/close, etc).
function applyAppHeight() {
  const tg = window.Telegram?.WebApp;
  const h = tg?.viewportStableHeight || tg?.viewportHeight || window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--app-height', h + 'px');
}
applyAppHeight();
window.Telegram?.WebApp?.onEvent?.('viewportChanged', applyAppHeight);
window.addEventListener('resize', applyAppHeight);
window.addEventListener('orientationchange', applyAppHeight);
window.visualViewport?.addEventListener('resize', applyAppHeight);
window.visualViewport?.addEventListener('scroll', applyAppHeight);

// ─── Helpers ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// Haptic Feedback Helper
function haptic(type = 'light') {
  const tg = window.Telegram?.WebApp;
  if (!tg?.HapticFeedback) return;
  try {
    if (type === 'light' || type === 'medium' || type === 'heavy') {
      tg.HapticFeedback.impactOccurred(type);
    } else if (type === 'success' || type === 'warning' || type === 'error') {
      tg.HapticFeedback.notificationOccurred(type);
    } else if (type === 'selection') {
      tg.HapticFeedback.selectionChanged();
    }
  } catch (e) { console.warn('Haptic error:', e); }
}

function getTelegramData() {
  if (window.Telegram?.WebApp) {
    return {
      initData: window.Telegram.WebApp.initData,
      user: window.Telegram.WebApp.initDataUnsafe?.user,
    };
  }
  // Dev fallback
  return { initData: '', user: { id: 12345, first_name: 'Dev' } };
}

async function apiFetch(path, opts = {}) {
  const { initData } = getTelegramData();
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-init-data': initData,
      'x-telegram-id': getTelegramData().user?.id || '',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.error || `HTTP ${res.status}`);
    if (err.nickname_taken) e.nickname_taken = true;
    throw e;
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/csv')) return res.blob();
  return res.json();
}

// Fetch a binary attachment (voice/audio/video/photo/document) through our
// own authenticated proxy route. Used instead of apiFetch because the result
// is a Blob, not JSON, and because <audio>/<img>/<a> elements can't carry
// custom auth headers themselves — we fetch the bytes ourselves and hand the
// element a local blob: URL instead.
async function fetchAuthedBlob(path) {
  const { initData } = getTelegramData();
  const res = await fetch(`${API}${path}`, {
    headers: {
      'x-telegram-init-data': initData,
      'x-telegram-id': getTelegramData().user?.id || '',
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

// ─── Mentor/User Avatar Rendering ───────────────────────────────────────────
const avatarUrlCache = new Map();
const avatarInflight = new Map();

function renderAvatar(m, letter) {
  const safeLetter = escapeHtml(letter || '?');
  if (m?.photo_file_id) {
    return `<div class="mentor-avatar has-photo" data-avatar-tid="${m.telegram_id}" data-avatar-v="${m.photo_updated_at || ''}" onclick="viewAvatar(this)">${safeLetter}</div>`;
  }
  return `<div class="mentor-avatar">${safeLetter}</div>`;
}

async function loadAvatarUrl(tid, v) {
  const key = `${tid}:${v}`;
  if (avatarUrlCache.has(key)) return avatarUrlCache.get(key);
  if (avatarInflight.has(key)) return avatarInflight.get(key);

  const promise = fetchAuthedBlob(`/api/avatar/${tid}?v=${v}`)
    .then(blob => {
      const url = URL.createObjectURL(blob);
      avatarUrlCache.set(key, url);
      return url;
    })
    .finally(() => avatarInflight.delete(key));

  avatarInflight.set(key, promise);
  return promise;
}

function hydrateAvatars(container) {
  if (!container) return;
  const els = container.querySelectorAll('[data-avatar-tid]:not(.avatar-loaded)');
  els.forEach(async el => {
    el.classList.add('avatar-loaded');
    const tid = el.dataset.avatarTid;
    const v = el.dataset.avatarV || '';
    try {
      const url = await loadAvatarUrl(tid, v);
      const img = document.createElement('img');
      img.alt = '';
      img.onerror = () => { el.classList.remove('avatar-loaded', 'has-photo'); img.remove(); };
      img.src = url;
      el.innerHTML = '';
      el.appendChild(img);
      el.classList.add('has-photo');
    } catch (e) {
      el.classList.remove('avatar-loaded', 'has-photo');
    }
  });
}

function viewAvatar(el) {
  const img = el?.querySelector('img');
  if (!img || !img.src) return;
  openImageLightbox(img.src);
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return t('time_just_now');
  if (diff < 3600000) return t('time_minutes_ago', { count: Math.floor(diff / 60000) });
  if (diff < 86400000) return t('time_hours_ago', { count: Math.floor(diff / 3600000) });
  return t('time_days_ago', { count: Math.floor(diff / 86400000) });
}

function formatTime(dateStr) {
  const tz = 'Africa/Addis_Ababa';
  try {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: tz });
  } catch (e) {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

function formatDateTime(dateStr) {
  const tz = 'Africa/Addis_Ababa';
  try {
    return new Date(dateStr).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', timeZone: tz });
  } catch (e) {
    return new Date(dateStr).toLocaleString();
  }
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// ─── Support / Ticket Icon Set ──────────────────────────────────────────────
// Stroke-based, single-color SVGs (inherit currentColor) so they theme with
// the rest of the app. Used in place of emoji throughout the support system.
const TICKET_ICONS = {
  ticket: '<path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1a2 2 0 0 0 0 4v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1a2 2 0 0 0 0-4z"/><path d="M9 7v10" stroke-dasharray="2.5 2.5"/>',
  chat: '<path d="M21 12a8.5 8.5 0 0 1-8.5 8.5 8.4 8.4 0 0 1-3.8-.9L3 21l1.4-4.7A8.4 8.4 0 0 1 3.5 12 8.5 8.5 0 0 1 12 3.5 8.5 8.5 0 0 1 21 12z"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M16 2.5v4M8 2.5v4M3 9.5h18"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.9 3.6-7 8-7s8 3.1 8 7"/>',
  shield: '<path d="M12 2l8 3.2v6c0 5-3.4 8.7-8 10.8-4.6-2.1-8-5.8-8-10.8v-6z"/><path d="m9 12 2 2 4-4"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/>',
  reopen: '<path d="M3 12a9 9 0 1 1 3 6.7"/><path d="M3 21v-5h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.3 2"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 4.2 1.5 6 2 7H4c.5-1 2-2.8 2-7z"/><path d="M9.5 19a2.5 2.5 0 0 0 5 0"/>',
  inbox: '<path d="M3 12h4l2 3h6l2-3h4"/><path d="M5 5h14l2 7v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7z"/>'
};
function ticketIcon(name, size = 15) {
  const body = TICKET_ICONS[name] || '';
  return `<svg class="ticket-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// ─── Mentee Follow-up Icon Set ──────────────────────────────────────────────
// Same stroke-based, single-color SVG technique as TICKET_ICONS above — used
// in place of emoji on the My Mentees page (goal checklist).
const MENTEE_ICONS = {
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18"/><path d="M8 3v3"/><path d="M16 3v3"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
};
function menteeIcon(name, size = 14) {
  const body = MENTEE_ICONS[name] || '';
  return `<svg class="ticket-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
// ─── Voice / File Attachment Rendering ─────────────────────────────────────

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined || isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FILE_TYPE_ICONS = { document: '📄', audio: '🎵', video: '🎬', photo: '🖼️', voice: '🎙️' };

// Builds the markup for a single attachment based on msg.file_type. Text
// messages (file_type === null/undefined) never call this — renderThread()
// only invokes it when msg.file_type is set, so plain text rendering is
// completely unaffected.
function renderFileAttachment(msg) {
  const fileId = escapeHtml(msg.file_id || '');

  switch (msg.file_type) {
    case 'voice':
    case 'audio':
      return `
        <div class="msg-voice">
          <button class="msg-voice-play" data-file-id="${fileId}" onclick="playVoiceMessage(this)" aria-label="Play ${msg.file_type === 'voice' ? 'voice message' : 'audio'}">▶️</button>
          <div class="msg-voice-info">
            <div class="msg-voice-label">${FILE_TYPE_ICONS[msg.file_type]} ${msg.file_type === 'voice' ? 'Voice message' : escapeHtml(msg.file_name || 'Audio')}</div>
            <div class="msg-voice-track" data-duration="${msg.duration || 0}">
              <div class="msg-voice-progress">
                <div class="msg-voice-progress-fill"></div>
                <div class="msg-voice-progress-handle"></div>
              </div>
            </div>
            <div class="msg-voice-time">
              <span class="msg-voice-elapsed">0:00</span>
              <span class="msg-voice-total">${formatDuration(msg.duration)}</span>
            </div>
          </div>
          <audio class="msg-voice-audio" style="display:none" preload="none"></audio>
        </div>`;

    case 'video':
      return `
        <div class="msg-video" data-file-id="${fileId}">
          <button class="msg-video-play" onclick="playChatVideo(this)">▶️ Play video${msg.duration ? ` (${formatDuration(msg.duration)})` : ''}</button>
        </div>`;

    case 'photo':
      return `
        <div class="msg-photo" data-file-id="${fileId}">
          <div class="msg-photo-placeholder">🖼️ Loading photo…</div>
        </div>`;

    case 'document':
    default:
      return `
        <div class="msg-file">
          <div class="msg-file-icon">${FILE_TYPE_ICONS[msg.file_type] || '📎'}</div>
          <div class="msg-file-meta">
            <div class="msg-file-name">${escapeHtml(msg.file_name || 'File')}</div>
            <div class="msg-file-size">${formatFileSize(msg.file_size)}</div>
          </div>
          <button class="msg-file-download" data-state="download" data-file-id="${fileId}" data-file-name="${escapeHtml(msg.file_name || 'file')}" onclick="handleFileAction(this)" aria-label="Download file">⬇️</button>
        </div>`;
  }
}

// Fetches the actual image bytes for every not-yet-loaded photo bubble in
// `container` and swaps the placeholder for a real <img>. Called after any
// HTML containing message bubbles is inserted into the DOM. Voice/video/
// document attachments are intentionally NOT auto-fetched here — those stay
// lazy (fetched on tap) to avoid burning bandwidth on media the person may
// never open.
function hydratePhotoMessages(container) {
  if (!container) return;
  const els = container.querySelectorAll('.msg-photo[data-file-id]:not(.msg-photo-loaded)');
  els.forEach(async el => {
    el.classList.add('msg-photo-loaded'); // mark immediately so we never double-fetch
    const fileId = el.dataset.fileId;
    try {
      const blob = await fetchAuthedBlob(`/api/messages/file/${fileId}`);
      const url = URL.createObjectURL(blob);
      el.innerHTML = `<img src="${url}" class="msg-photo-img" alt="Photo attachment" onclick="openImageLightbox('${url}')" />`;
    } catch (e) {
      el.innerHTML = '<div class="msg-photo-error">⚠️ Failed to load photo</div>';
    }
  });
}

// Full-screen in-app image viewer. We deliberately avoid window.open() here
// — inside Telegram's mobile in-app browser, window.open() on a blob: URL is
// frequently blocked (desktop works fine, which is why the bug only showed
// up on phones). A DOM overlay always works because it never leaves the page.
function openImageLightbox(url) {
  closeImageLightbox();
  const overlay = document.createElement('div');
  overlay.className = 'img-lightbox-overlay';
  overlay.id = 'imgLightboxOverlay';
  overlay.onclick = closeImageLightbox;
  overlay.innerHTML = `
    <button class="img-lightbox-close" onclick="event.stopPropagation(); closeImageLightbox()" aria-label="Close">✕</button>
    <img src="${url}" alt="Photo attachment" onclick="event.stopPropagation()" />
  `;
  document.body.appendChild(overlay);
  haptic('light');
}

function closeImageLightbox() {
  const overlay = document.getElementById('imgLightboxOverlay');
  if (overlay) overlay.remove();
}

async function playVoiceMessage(btn) {
  const fileId = btn.dataset.fileId;
  const container = btn.closest('.msg-voice');
  const audioEl = container.querySelector('audio');
  const track = container.querySelector('.msg-voice-track');
  const fill = container.querySelector('.msg-voice-progress-fill');
  const handle = container.querySelector('.msg-voice-progress-handle');
  const elapsedEl = container.querySelector('.msg-voice-elapsed');
  const totalEl = container.querySelector('.msg-voice-total');

  if (!audioEl.src) {
    btn.disabled = true;
    btn.textContent = '↓';
    btn.classList.add('loading');
    container.classList.add('msg-voice-downloading');
    try {
      const blob = await fetchAuthedBlob(`/api/messages/file/${fileId}`);
      audioEl.src = URL.createObjectURL(blob);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '▶️';
      btn.classList.remove('loading');
      container.classList.remove('msg-voice-downloading');
      haptic('error');
      showToast('Failed to load voice message', 'error');
      return;
    }
    btn.disabled = false;
    btn.classList.remove('loading');
    container.classList.remove('msg-voice-downloading');

    audioEl.onloadedmetadata = () => {
      if (isFinite(audioEl.duration) && audioEl.duration > 0) {
        totalEl.textContent = formatDuration(audioEl.duration);
      }
    };
    audioEl.ontimeupdate = () => {
      const dur = audioEl.duration || parseFloat(track.dataset.duration) || 0;
      const pct = dur ? Math.min(100, (audioEl.currentTime / dur) * 100) : 0;
      fill.style.width = `${pct}%`;
      handle.style.left = `${pct}%`;
      elapsedEl.textContent = formatDuration(audioEl.currentTime);
    };
    audioEl.onended = () => {
      btn.textContent = '▶️';
      fill.style.width = '0%';
      handle.style.left = '0%';
      elapsedEl.textContent = '0:00';
    };

    const seek = (evt) => {
      if (!audioEl.duration) return;
      const rect = track.getBoundingClientRect();
      const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
      const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      audioEl.currentTime = pct * audioEl.duration;
    };
    track.addEventListener('click', seek);
    track.addEventListener('touchstart', seek, { passive: true });
  }

  if (audioEl.paused) {
    audioEl.play();
    btn.textContent = '⏸️';
    haptic('light');
  } else {
    audioEl.pause();
    btn.textContent = '▶️';
  }
}

async function playChatVideo(btn) {
  const container = btn.closest('.msg-video');
  const fileId = container.dataset.fileId;
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = '⏳ Loading…';
  try {
    const blob = await fetchAuthedBlob(`/api/messages/file/${fileId}`);
    const url = URL.createObjectURL(blob);
    container.innerHTML = `<video class="msg-video-player" src="${url}" controls autoplay playsinline></video>`;
  } catch (e) {
    btn.disabled = false;
    btn.textContent = originalLabel;
    haptic('error');
    showToast('Failed to load video', 'error');
  }
}

// Opens a fetched blob so it works on desktop AND inside Telegram's mobile
// in-app browser. window.open() on a blob: URL is unreliable in Telegram's
// mobile WebView — it's silently blocked as a popup on Android and simply
// does nothing on iOS — which is exactly why "Open" worked on desktop but
// tapping did nothing on phone. We try window.open() first (desktop still
// gets an inline preview tab when the browser supports it) and fall back to
// a programmatic download link, which uses the browser's native
// save/open handling instead of a blocked popup.
function openBlobFile(url, fileName) {
  const win = window.open(url, '_blank');
  if (!win) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'file';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

// Document attachments start as a "⬇️ Download" button. First tap fetches
// the file and flips the button into "📂 Open" (mirroring Telegram's own
// download-then-open flow); a second tap opens the file via openBlobFile()
// above, which works reliably on both desktop and mobile.
async function handleFileAction(btn) {
  const state = btn.dataset.state || 'download';

  if (state === 'open') {
    haptic('light');
    if (btn.dataset.blobUrl) openBlobFile(btn.dataset.blobUrl, btn.dataset.fileName);
    return;
  }

  const fileId = btn.dataset.fileId;
  haptic('light');
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '⏳';

  try {
    const blob = await fetchAuthedBlob(`/api/messages/file/${fileId}`);
    const url = URL.createObjectURL(blob);
    btn.dataset.blobUrl = url;
    btn.dataset.state = 'open';
    btn.classList.remove('msg-file-download');
    btn.classList.add('msg-file-open');
    btn.innerHTML = '📂';
    btn.setAttribute('aria-label', 'Open file');
    haptic('success');
  } catch (e) {
    btn.innerHTML = originalHtml;
    haptic('error');
    showToast('Failed to download file', 'error');
  } finally {
    btn.disabled = false;
  }
}

function buildMessageTree(messages) {
  const map = new Map();
  const roots = [];
  messages.forEach(msg => {
    map.set(msg.id, { ...msg, replies: [] });
  });
  messages.forEach(msg => {
    const parentMsg = msg.parent_id ? map.get(msg.parent_id) : null;
    if (parentMsg && !parentMsg.is_deleted) {
      parentMsg.replies.push(map.get(msg.id));
    } else {
      const mappedMsg = map.get(msg.id);
      if (mappedMsg) {
        // Fallback for missing/deleted parent messages: treat as root
        mappedMsg.parent_id = null;
        roots.push(mappedMsg);
      }
    }
  });
  roots.forEach(root => {
    root.replies.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  });
  return roots;
}

/* ── SVG icon constants ──────────────────────────────────────── */
const ICON_REPLY = `<svg class="msg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`;
const ICON_MORE = `<svg class="msg-icon" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>`;

function getLocalDateParts(date, timezone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    });
    const formatted = formatter.format(date); // "M/D/YYYY"
    const [m, d, y] = formatted.split('/');
    return { year: parseInt(y), month: parseInt(m) - 1, day: parseInt(d) };
  } catch (e) {
    return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
  }
}

function getDateGroupHeader(dateStr) {
  const tz = currentUser?.user_settings?.timezone || 'Africa/Addis_Ababa';
  const msgDate = new Date(dateStr);
  const now = new Date();

  const msgParts = getLocalDateParts(msgDate, tz);
  const nowParts = getLocalDateParts(now, tz);

  const msgLocalMidnight = new Date(msgParts.year, msgParts.month, msgParts.day).getTime();
  const nowLocalMidnight = new Date(nowParts.year, nowParts.month, nowParts.day).getTime();

  const diffDays = Math.round((nowLocalMidnight - msgLocalMidnight) / (24 * 60 * 60 * 1000));

  if (diffDays === 0) {
    return t('Today') || 'Today';
  } else if (diffDays === 1) {
    return t('Yesterday') || 'Yesterday';
  } else if (diffDays > 1 && diffDays < 7) {
    try {
      return msgDate.toLocaleDateString([], { weekday: 'long', timeZone: tz });
    } catch (e) {
      return msgDate.toLocaleDateString([], { weekday: 'long' });
    }
  } else {
    try {
      return msgDate.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric', timeZone: tz });
    } catch (e) {
      return msgDate.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
    }
  }
}

function renderThread(messages, isRoot = true) {
  if (!messages || !messages.length) return '';

  let html = '';
  let lastGroupHeader = '';

  for (const msg of messages) {
    if (msg.is_deleted) continue;

    if (isRoot) {
      const groupHeader = getDateGroupHeader(msg.created_at);
      if (groupHeader !== lastGroupHeader) {
        html += `<div class="chat-date-divider"><span>${escapeHtml(groupHeader)}</span></div>`;
        lastGroupHeader = groupHeader;
      }
    }

    const isSent = msg.from_id === currentUser?.telegram_id;
    const editedMark = msg.edited_at
      ? '<span class="msg-edited">edited</span>'
      : '';
    const hasReplies = msg.replies && msg.replies.filter(r => !r.is_deleted).length > 0;

    html += `
      <div class="message-thread ${isSent ? 'thread-sent' : 'thread-received'}" data-msg-id="${msg.id}">
        <div class="message-bubble ${isSent ? 'sent' : 'received'}">
          <div class="message-text">${msg.file_type ? renderFileAttachment(msg) : ''}${msg.content ? `<div class="${msg.file_type ? 'message-caption' : ''}">${escapeHtml(msg.content)}</div>` : ''}${editedMark}</div>
          <div class="message-footer">
            <span class="message-time">${formatTime(msg.created_at)}</span>
            <span class="msg-footer-actions">
              ${isSent ? `
                <button class="msg-action-btn" onclick="toggleMsgMenu('${msg.id}', event)" aria-label="Options">${ICON_MORE}</button>
                <div class="msg-context-menu" id="msg-menu-${msg.id}">
                  <button class="msg-menu-item" onclick="editMessageInline('${msg.id}');closeMsgMenu()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    Edit
                  </button>
                  <button class="msg-menu-item danger" onclick="deleteMessageInline('${msg.id}');closeMsgMenu()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                    Delete
                  </button>
                </div>
              ` : ''}
              <button class="msg-action-btn" onclick="setReplyTo('${msg.id}')" aria-label="Reply">${ICON_REPLY}</button>
            </span>
          </div>
        </div>
        ${hasReplies ? `<div class="replies-container">${renderThread(msg.replies, false)}</div>` : ''}
      </div>
    `;
  }

  return html;
}

function addMessageToChat(msg) {
  const container = $('chatMessages');
  if (!container) return;

  if (!window._chatMessagesMap) window._chatMessagesMap = new Map();
  window._chatMessagesMap.set(String(msg.id), msg);

  // Check if already exists (by ID)
  const existing = container.querySelector(`.message-thread[data-msg-id="${msg.id}"]`);
  if (existing) return;

  const html = renderThread([msg], false);

  if (msg.parent_id) {
    const parentThread = container.querySelector(`.message-thread[data-msg-id="${msg.parent_id}"]`);
    if (parentThread) {
      let repliesContainer = parentThread.querySelector('.replies-container');
      if (!repliesContainer) {
        repliesContainer = document.createElement('div');
        repliesContainer.className = 'replies-container';
        parentThread.appendChild(repliesContainer);
      }
      repliesContainer.insertAdjacentHTML('beforeend', html);

      // If temporary sending message, style the bubble
      if (msg.is_sending) {
        const tempEl = repliesContainer.querySelector(`.message-thread[data-msg-id="${msg.id}"]`);
        if (tempEl) {
          const bubble = tempEl.querySelector('.message-bubble');
          if (bubble) bubble.classList.add('sending');
        }
      }

      hydratePhotoMessages(repliesContainer);
      container.scrollTop = container.scrollHeight;
      return;
    }
  }

  const groupHeader = getDateGroupHeader(msg.created_at);
  const dividers = container.querySelectorAll('.chat-date-divider span');
  const lastDividerText = dividers.length > 0 ? dividers[dividers.length - 1].textContent.trim() : '';

  let finalHtml = '';
  if (groupHeader !== lastDividerText) {
    finalHtml += `<div class="chat-date-divider"><span>${escapeHtml(groupHeader)}</span></div>`;
  }
  finalHtml += html;

  container.insertAdjacentHTML('beforeend', finalHtml);

  // If temporary sending message, style the bubble
  if (msg.is_sending) {
    const tempEl = container.querySelector(`.message-thread[data-msg-id="${msg.id}"]`);
    if (tempEl) {
      const bubble = tempEl.querySelector('.message-bubble');
      if (bubble) bubble.classList.add('sending');
    }
  }

  hydratePhotoMessages(container);
  container.scrollTop = container.scrollHeight;
}

/* ── Inline context-menu helpers ────────────────────────────── */
function toggleMsgMenu(msgId, e) {
  e.stopPropagation();
  const menu = document.getElementById(`msg-menu-${msgId}`);
  if (!menu) return;
  const isOpen = menu.classList.contains('open');
  closeMsgMenu(); // close any other open menu first
  if (!isOpen) {
    menu.classList.add('open');
    // close on next outside tap
    setTimeout(() => document.addEventListener('click', closeMsgMenu, { once: true }), 0);
  }
}

function closeMsgMenu() {
  document.querySelectorAll('.msg-context-menu.open').forEach(m => m.classList.remove('open'));
}

/* ── Chat Partner Dropdown helpers ──────────────────────────── */
function isUserOnline(lastActive) {
  if (!lastActive) return false;
  return Date.now() - new Date(lastActive).getTime() < 5 * 60 * 1000;
}

/* ── Chat header: avatar photo/initials + real online status ───── */
function setChatPeerHeader(displayName, lastActive, telegramId, photoFileId, photoUpdatedAt) {
  const avatarEl = $('chatPeerAvatar');
  if (avatarEl) {
    const initials = (displayName || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map(w => w[0]?.toUpperCase() || '')
      .join('');
    avatarEl.textContent = initials || '?';
    avatarEl.classList.remove('avatar-loaded', 'has-photo');
    delete avatarEl.dataset.avatarTid;
    delete avatarEl.dataset.avatarV;

    if (photoFileId && telegramId) {
      avatarEl.dataset.avatarTid = telegramId;
      avatarEl.dataset.avatarV = photoUpdatedAt || '';
      avatarEl.classList.add('has-photo');
      hydrateAvatars(avatarEl.parentElement || document);
    }
  }

  const statusEl = $('chatPeerStatus');
  if (statusEl) {
    // Stash the real last-active value so the typing indicator (which
    // temporarily overwrites this element) can restore the correct
    // Online/hidden state once the person stops typing.
    window.chatPeerLastActive = lastActive;
    renderPeerStatus();
  }
}

// Renders the peer's real presence (Online, or hidden if not recently
// active) into the status line under their name. Also used to restore
// that line after a "Typing…" state clears.
function renderPeerStatus() {
  const statusEl = $('chatPeerStatus');
  if (!statusEl) return;
  statusEl.classList.remove('typing');
  if (isUserOnline(window.chatPeerLastActive)) {
    statusEl.textContent = 'Online';
    statusEl.classList.remove('offline');
    statusEl.style.display = 'block';
  } else {
    // No confident "last seen X ago" without a reliable timestamp source,
    // so we just hide the line rather than show a stale/guessed status.
    statusEl.style.display = 'none';
  }
}

/* ── Chat header: overflow menu (Refresh / Reset / Clear) ────── */
function toggleChatHeaderMenu(e) {
  e.stopPropagation();
  const menu = $('chatHeaderMenu');
  if (!menu) return;
  menu.classList.toggle('open');
}

function closeChatHeaderMenu() {
  const menu = $('chatHeaderMenu');
  if (menu) menu.classList.remove('open');
}

document.addEventListener('click', (e) => {
  const menu = $('chatHeaderMenu');
  if (menu && menu.classList.contains('open') && !menu.contains(e.target)) {
    menu.classList.remove('open');
  }
});

function toggleChatPartnerDropdown(e) {
  e.stopPropagation();
  const menu = $('chatPartnerDropdownMenu');
  if (!menu) return;
  const isOpen = menu.classList.contains('open');
  closeChatPartnerDropdown();
  if (!isOpen) {
    menu.classList.add('open');
    setTimeout(() => document.addEventListener('click', closeChatPartnerDropdown, { once: true }), 0);
  }
}

function closeChatPartnerDropdown() {
  $('chatPartnerDropdownMenu')?.classList.remove('open');
}


function editMessageInline(msgId) {
  currentMessageId = msgId;
  closeMessageOptions();
  cancelReply();

  window.editingMessageId = msgId;

  // Retrieve message text from cache or DOM
  let content = '';
  if (window._chatMessagesMap && window._chatMessagesMap.has(String(msgId))) {
    content = window._chatMessagesMap.get(String(msgId)).content || '';
  }
  if (!content) {
    const threadEl = document.querySelector(`.message-thread[data-msg-id="${msgId}"]`);
    if (threadEl) {
      const captionEl = threadEl.querySelector('.message-caption');
      if (captionEl) {
        content = captionEl.textContent;
      } else {
        const textEl = threadEl.querySelector('.message-text');
        if (textEl) {
          const clone = textEl.cloneNode(true);
          clone.querySelectorAll('.msg-edited, .chat-attachment-card').forEach(el => el.remove());
          content = clone.textContent.trim();
        }
      }
    }
  }

  const input = $('chatInput');
  if (input) {
    input.value = content;
    autoResizeChatInput();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  const editIndicator = $('editIndicator');
  if (editIndicator) editIndicator.classList.remove('hidden');
  const preview = $('editIndicatorPreview');
  if (preview) {
    preview.textContent = content.length > 60 ? content.substring(0, 60) + '…' : content;
  }
  document.querySelector('.chat-input-wrapper')?.classList.add('editing');

  $('chatSendIcon')?.classList.add('hidden');
  $('chatSendEditIcon')?.classList.remove('hidden');
  $('chatSendBtn')?.setAttribute('title', 'Save edit');

  syncChatInputHeight();
  haptic('selection');
}

function cancelEditMessage() {
  window.editingMessageId = null;
  currentMessageId = null;
  const editIndicator = $('editIndicator');
  if (editIndicator) editIndicator.classList.add('hidden');
  const preview = $('editIndicatorPreview');
  if (preview) preview.textContent = '';
  document.querySelector('.chat-input-wrapper')?.classList.remove('editing');

  $('chatSendIcon')?.classList.remove('hidden');
  $('chatSendEditIcon')?.classList.add('hidden');
  $('chatSendBtn')?.removeAttribute('title');

  const input = $('chatInput');
  if (input) {
    input.value = '';
    autoResizeChatInput();
  }
  syncChatInputHeight();
}

async function deleteMessageInline(msgId) {
  currentMessageId = msgId;
  await deleteMessage();
}

// Turns the main composer into a reply box for `messageId`, Telegram-style:
// shows the reply banner above the textarea instead of a per-message form.
function setReplyTo(messageId) {
  cancelEditMessage(); // reply and edit are mutually exclusive

  const msg = window._chatMessagesMap?.get(String(messageId));
  if (!msg) return;

  window.replyToId = messageId;

  const isSent = msg.from_id === currentUser?.telegram_id;
  const senderLabel = isSent ? 'You' : (window.chatState?.name || 'them');

  let preview = (msg.content || '').trim();
  if (!preview && msg.file_type) {
    preview = msg.file_type === 'photo' ? '📷 Photo'
      : msg.file_type === 'voice' ? '🎤 Voice message'
      : `📎 ${msg.file_type}`;
  }
  if (preview.length > 60) preview = preview.substring(0, 60) + '…';

  const label = $('replyIndicatorLabel');
  if (label) label.textContent = `Replying to ${senderLabel}`;
  const replyText = $('replyText');
  if (replyText) replyText.textContent = preview;

  $('replyIndicator')?.classList.remove('hidden');

  const input = $('chatInput');
  if (input) input.focus();

  syncChatInputHeight();
  haptic('selection');
}
window.setReplyTo = setReplyTo;

let currentMessageId = null;

function showMessageOptions(messageId) {
  // Legacy: kept for any external callers; routes to inline menu flow
  currentMessageId = messageId;
  document.getElementById('messageOptionsModal').classList.add('open');
}

function closeMessageOptions() {
  currentMessageId = null;
  document.getElementById('messageOptionsModal').classList.remove('open');
}

function editMessage() {
  if (!currentMessageId) return;
  const msgId = currentMessageId;
  closeMessageOptions();
  editMessageInline(msgId);
}

async function deleteMessage() {
  if (!currentMessageId) return;
  if (!confirm('Delete this message for everyone?')) return;
  try {
    await apiFetch(`/api/messages/${currentMessageId}`, { method: 'DELETE' });
    closeMessageOptions();
    loadMessages(window.chatState.with);
    haptic('medium');
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}
function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  t.style.cssText = `
    position:fixed;top:16px;left:50%;transform:translateX(-50%);
    background:${type === 'error' ? 'var(--danger)' : type === 'success' ? 'var(--success)' : 'var(--bg3)'};
    color:#fff;padding:10px 20px;border-radius:8px;z-index:9999;
    font-size:.85rem;font-weight:700;animation:fadeIn .2s ease;
    max-width:90vw;text-align:center;
  `;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── Theme ────────────────────────────────────────────────────
const THEME_ICON_SUN = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/></svg>';
const THEME_ICON_MOON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.4A8.4 8.4 0 1 1 9.6 3.5a6.8 6.8 0 0 0 10.9 10.9z"/></svg>';
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const icon = theme === 'light' ? THEME_ICON_MOON : THEME_ICON_SUN;
  $$('.theme-btn span').forEach(s => s.innerHTML = icon);
}
function toggleTheme() {
  haptic('light');
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  setTheme(cur === 'dark' ? 'light' : 'dark');
}
setTheme(localStorage.getItem('theme') || 'dark');

// ─── Init ─────────────────────────────────────────────────────
async function init() {
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  applyAppHeight();
  // tg.expand() doesn't resize the WebView synchronously — Telegram
  // reports the new viewportStableHeight a little later via its own
  // 'viewportChanged' event (already listened for above), but that event
  // isn't guaranteed on every client/version. Re-measuring a couple of
  // frames later catches the post-expand size even when it isn't, so the
  // chat input row's reserved space (#page-chat.active) doesn't stay
  // pinned to the pre-expand (shorter) height and end up hidden behind
  // the bottom nav.
  requestAnimationFrame(() => requestAnimationFrame(applyAppHeight));
  setTimeout(applyAppHeight, 300);

  try {
    const data = await apiFetch('/api/auth/me');
    window.ADMIN_ID = data.admin_id;
    if (!data.registered) {
      showOnboarding();
    } else {
      currentUser = data.user;
      if (currentUser.is_banned) {
        document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#E05C5C;font-family:Cinzel,serif;font-size:1.2rem;">Account suspended.<br><br>Contact support.</div>';
        return;
      }
      startApp();
      handleDeepLink();
    }
  } catch (e) {
    console.error(e);
    showToast('Connection error', 'error');
    showOnboarding();
  }

  $('loadingScreen')?.classList.add('hidden');
}

function handleDeepLink() {
  const tg = window.Telegram?.WebApp;
  const startParam = tg?.initDataUnsafe?.start_param;

  if (startParam) {
    if (startParam.startsWith('session_')) {
      const sessionId = startParam.replace('session_', '');
      setTimeout(() => joinSession(sessionId), 100);
      return;
    }
    if (startParam.startsWith('chat_')) {
      const partnerId = startParam.replace('chat_', '');
      setTimeout(() => {
        window.pendingChatPartner = partnerId;
        navigate('chat');
      }, 100);
      return;
    }
    if (startParam.startsWith('goal_')) {
      const goalId = startParam.replace('goal_', '');
      setTimeout(() => openGoalDeepLink(goalId), 100);
      return;
    }
  }

  // Fallback for direct browser testing
  const urlParams = new URLSearchParams(window.location.search);
  const browserStart = urlParams.get('start');
  if (browserStart) {
    if (browserStart.startsWith('session_')) {
      const sessionId = browserStart.replace('session_', '');
      setTimeout(() => joinSession(sessionId), 100);
    } else if (browserStart.startsWith('chat_')) {
      const partnerId = browserStart.replace('chat_', '');
      setTimeout(() => {
        window.pendingChatPartner = partnerId;
        navigate('chat');
      }, 100);
    } else if (browserStart.startsWith('goal_')) {
      const goalId = browserStart.replace('goal_', '');
      setTimeout(() => openGoalDeepLink(goalId), 100);
    }
  }
}

// Deep link from a goal Telegram notification (new goal / due reminder) —
// jumps to the dashboard and gives the specific goal a brief highlight
// pulse so the mentee can find it immediately in the (possibly scrolling)
// ticker list rather than hunting for it.
async function openGoalDeepLink(goalId) {
  navigate('dashboard');
  await loadMyGoalsWidget();
  const item = document.querySelector(`#myGoalsList [data-goal-id="${goalId}"]`);
  if (item) {
    myGoalsTicker?.stop();
    item.scrollIntoView({ block: 'center', behavior: 'smooth' });
    item.classList.add('goal-pulse');
    setTimeout(() => {
      item.classList.remove('goal-pulse');
      myGoalsTicker?.start();
    }, 1600);
  }
}

// ─── Socket Setup ─────────────────────────────────────────────
let chatPollingInterval = null;

function startChatPolling() {
  if (chatPollingInterval) return;
  chatPollingInterval = setInterval(() => {
    if (currentPage === 'chat' && window.chatState?.with) {
      // Only poll if socket is not connected
      if (!socket?.connected) {
        loadMessages(window.chatState.with);
      }
    }
  }, 15000);
}

function stopChatPolling() {
  if (chatPollingInterval) {
    clearInterval(chatPollingInterval);
    chatPollingInterval = null;
  }
}
// ─── Global refresh for requests & sessions (fallback when socket is down) ──
let refreshTimer = null;

function startGlobalRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (currentPage === 'requests') loadRequests();
    if (currentPage === 'sessions') loadSessions();
    updateRequestsBadge();
    updateSessionsBadge();
    updateMessageBadge();
    checkPendingRating();
  }, 30000); // every 30 seconds
}

// ─── Mentor Rating ────────────────────────────────────────────
let ratingModalOpen = false;

async function checkPendingRating() {
  if (ratingModalOpen || currentUser?.role !== 'user') return;
  try {
    const pending = await apiFetch('/api/users/pending-rating');
    if (pending && pending.mentor_id) {
      openRatingModal(pending.mentor_id, pending.display_name);
    }
  } catch (e) { /* silent — non-critical */ }
}

function renderStars(rating, count, size = 11) {
  const r = rating || 0;
  const full = Math.floor(r);
  const half = (r - full) >= 0.5;
  let svgs = '';
  for (let i = 0; i < 5; i++) {
    if (i < full) {
      svgs += `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="#C9A84C"><path d="M12 .587l3.668 7.568 8.332 1.151-6.064 5.828 1.48 8.279-7.416-4.045-7.416 4.045 1.48-8.279-6.064-5.828 8.332-1.151z"/></svg>`;
    } else if (i === full && half) {
      svgs += `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="url(#ratingHalfGrad)"><path d="M12 .587l3.668 7.568 8.332 1.151-6.064 5.828 1.48 8.279-7.416-4.045-7.416 4.045 1.48-8.279-6.064-5.828 8.332-1.151z"/></svg>`;
    } else {
      svgs += `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#867F76" stroke-width="1.5"><path d="M12 .587l3.668 7.568 8.332 1.151-6.064 5.828 1.48 8.279-7.416-4.045-7.416 4.045 1.48-8.279-6.064-5.828 8.332-1.151z"/></svg>`;
    }
  }
  if (!count) {
    return `<div class="rating-row"><span class="no-rating">${t('no_ratings_yet') || 'No ratings yet'}</span></div>`;
  }
  return `<div class="rating-row"><span class="stars">${svgs}</span><span class="rating-num">${r.toFixed(1)}</span><span class="rating-count">(${count})</span></div>`;
}

function openRatingModal(mentorId, mentorName) {
  ratingModalOpen = true;
  let selected = 0;
  const overlay = document.createElement('div');
  overlay.id = 'ratingModalOverlay';
  overlay.className = 'rating-modal-overlay';
  overlay.innerHTML = `
    <svg width="0" height="0" style="position:absolute">
      <defs><linearGradient id="ratingHalfGrad" x1="0" x2="1" y1="0" y2="0">
        <stop offset="50%" stop-color="#C9A84C"/><stop offset="50%" stop-color="#2A2E3A"/>
      </linearGradient></defs>
    </svg>
    <div class="rating-modal">
      <div class="rating-modal-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="#C9A84C"><path d="M12 .587l3.668 7.568 8.332 1.151-6.064 5.828 1.48 8.279-7.416-4.045-7.416 4.045 1.48-8.279-6.064-5.828 8.332-1.151z"/></svg>
      </div>
      <div class="rating-modal-title">${t('rate_mentor_title') || 'Rate your mentor'}</div>
      <div class="rating-modal-sub">${(t('rate_mentor_sub') || 'Your mentorship with {name} just ended. Tap a star to rate your experience.').replace('{name}', escapeHtml(mentorName))}</div>
      <div class="big-stars" id="ratingBigStars"></div>
      <div class="card-actions" style="display:flex;gap:8px;margin-top:4px;">
        <button class="btn btn-outline btn-sm flex-1" onclick="closeRatingModal()">${t('btn_skip') || 'Skip'}</button>
        <button class="btn btn-sm flex-1" id="ratingSubmitBtn" style="background:var(--gold);color:#1a1408;border-color:var(--gold);opacity:0.5;pointer-events:none;" onclick="submitMentorRating(${mentorId})">${t('btn_submit') || 'Submit rating'}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const starsWrap = overlay.querySelector('#ratingBigStars');
  const paintStars = (n) => {
    starsWrap.innerHTML = [1, 2, 3, 4, 5].map(i => `
      <svg width="30" height="30" viewBox="0 0 24 24" data-star="${i}"
        fill="${i <= n ? '#C9A84C' : 'none'}" stroke="${i <= n ? 'none' : '#867F76'}" stroke-width="1.5">
        <path d="M12 .587l3.668 7.568 8.332 1.151-6.064 5.828 1.48 8.279-7.416-4.045-7.416 4.045 1.48-8.279-6.064-5.828 8.332-1.151z"/>
      </svg>`).join('');
    starsWrap.querySelectorAll('svg').forEach(svg => {
      svg.style.cursor = 'pointer';
      svg.onclick = () => {
        selected = parseInt(svg.dataset.star); paintStars(selected);
        const btn = $('ratingSubmitBtn'); btn.style.opacity = '1'; btn.style.pointerEvents = 'auto';
      };
    });
  };
  paintStars(0);
}

function closeRatingModal() {
  ratingModalOpen = false;
  document.getElementById('ratingModalOverlay')?.remove();
}

async function submitMentorRating(mentorId) {
  const overlay = document.getElementById('ratingModalOverlay');
  const stars = overlay?.querySelectorAll('#ratingBigStars svg[fill="#C9A84C"]').length || 0;
  if (!stars) return;
  haptic('medium');
  try {
    await apiFetch('/api/mentors/rate', { method: 'POST', body: { mentor_id: mentorId, stars } });
    haptic('success');
    showToast(t('rating_submitted') || 'Thanks for your feedback!', 'success');
    closeRatingModal();
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}

function stopGlobalRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

let _socketInitialized = false;

function connectSocket() {
  if (socket || _socketInitialized) return;
  _socketInitialized = true;
  socket = io(API, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    // Always send auth as a string to match server-side Map key type
    const userId = String(currentUser?.telegram_id || getTelegramData().user?.id || '');
    socket.emit('auth', userId);
    $('reconnectBanner')?.classList.remove('show');
    // Stop polling fallback — socket is live
    stopChatPolling();
    stopGlobalRefresh();
    setGoalsLiveStatus(true);
    console.log('[Socket] Connected, authed as', userId);
  });

  socket.on('disconnect', (reason) => {
    console.warn('[Socket] Disconnected:', reason);
    $('reconnectBanner')?.classList.add('show');
    startChatPolling();      // keep message polling
    startGlobalRefresh();    // 👈 new: refresh requests & sessions
    setGoalsLiveStatus(false);
  });

  socket.on('reconnect', () => {
    console.log('[Socket] Reconnected');
    stopChatPolling();
    $('reconnectBanner')?.classList.remove('show');
    setGoalsLiveStatus(true);
    // Re-auth on reconnect
    const userId = String(currentUser?.telegram_id || getTelegramData().user?.id || '');
    socket.emit('auth', userId);
    if (currentPage === 'chat' && window.chatState?.with) {
      loadMessages(window.chatState.with);
    }
  });

  socket.on('new_message', (msg) => {
    if (currentPage === 'chat' && window.chatState?.with && String(window.chatState.with) === String(msg.from_id)) {
      addMessageToChat(msg);
      // Mark as read silently
      apiFetch(`/api/messages/${msg.from_id}`).then(() => updateMessageBadge()).catch(() => { });
    } else {
      updateMessageBadge();
      showToast('💬 New message received');
      haptic('medium');
    }
  });

  socket.on('chat_cleared', ({ by_id }) => {
    if (currentPage === 'chat' && window.chatState?.with && String(window.chatState.with) === String(by_id)) {
      loadMessages(window.chatState.with);
    }
  });

  socket.on('session_invite', (session) => {
    haptic('success');
    showToast(`${t('session_invite_toast')}: ${session.title}`, 'info');
    updateSessionsBadge();
    if (confirm('A new session has been scheduled. Go to Sessions page to join?')) {
      navigate('sessions');
    }
  });

  socket.on('broadcast', ({ message }) => {
    showToast(`📢 ${message}`);
  });

  socket.on('typing', ({ from_id }) => {
    if (window.chatState?.with && String(window.chatState.with) === String(from_id)) {
      const statusEl = $('chatPeerStatus');
      if (statusEl) {
        statusEl.innerHTML = `Typing <span class="typing-dots"><span></span><span></span><span></span></span>`;
        statusEl.classList.add('typing');
        statusEl.classList.remove('offline');
        statusEl.style.display = 'block';
      }
      clearTimeout(window.typingTimeout);
      window.typingTimeout = setTimeout(renderPeerStatus, 3000);
    }
  });

  socket.on('new_mentorship_request', () => {
    haptic('success');
    showToast('New mentorship request received! 🙏', 'success');
    updateRequestsBadge();
    if (currentPage === 'requests') loadRequests();
  });

  socket.on('ticket_reply', (data) => {
    haptic('success');
    const msg = data.reply
      ? `Admin replied to your support request: "${data.subject || 'Support'}"`
      : `Your support request "${data.subject || 'Support'}" is now ${data.status_label || data.status}`;
    showToast(msg, 'info');
    updateSupportBadge();
    if (currentPage === 'support') {
      loadUserTickets();
    } else if (currentPage === 'ticket-detail' && window.activeTicketId === data.ticket_id) {
      loadTicketDetail(data.ticket_id);
      hideTicketTyping();
    }
  });

  // Support chat typing indicator (admin → user direction only here)
  socket.on('ticket_typing', ({ ticket_id, sender_type } = {}) => {
    if (sender_type !== 'admin') return;
    if (currentPage !== 'ticket-detail' || String(window.activeTicketId) !== String(ticket_id)) return;
    const el = $('ticketTypingIndicator');
    if (!el) return;
    el.style.display = 'flex';
    clearTimeout(window.ticketTypingTimeout);
    window.ticketTypingTimeout = setTimeout(hideTicketTyping, 3000);
  });

  // Fired when a request is accepted or rejected — from the mini app OR the bot
  socket.on('mentorship_request_updated', ({ requestId, status } = {}) => {
    updateRequestsBadge();
    if (currentPage === 'requests') {
      loadRequests();
    } else if (status === 'accepted') {
      haptic('success');
      showToast('A mentorship request was accepted \u2713', 'success');
    }
  });

  socket.on('message_edited', (editedMsg) => {
    if (currentPage === 'chat' && window.chatState?.with) {
      loadMessages(window.chatState.with);
    }
  });

  socket.on('message_deleted', ({ id }) => {
    if (currentPage === 'chat' && window.chatState?.with) {
      loadMessages(window.chatState.with);
    }
  });

  // Fired the instant a session actually goes live (first participant/host
  // joins). Pings everyone else invited so they know it's time to hop in —
  // separate from the bot's 10-minutes-before reminder.
  socket.on('session_started', ({ session_id, title } = {}) => {
    haptic('success');
    showToast(`🔴 The session has started${title ? `: ${title}` : ''} — join please!`, 'success');
    updateSessionsBadge();
    if (currentPage === 'sessions') {
      loadSessions();
    }
  });

  // Fired by the server when the host ends a session — refresh the sessions
  // page immediately so the Join button disappears for all participants.
  socket.on('session_ended', ({ session_id } = {}) => {
    haptic('warning');
    showToast('The session has ended.', 'info');
    updateSessionsBadge();
    if (currentPage === 'sessions') {
      loadSessions();
    }
  });

  // Fired when a mentor clears their session list — mentees' lists are also
  // cleared server-side, so refresh to reflect the removal immediately.
  socket.on('session_cleared', ({ message } = {}) => {
    haptic('light');
    showToast(message || 'A session was removed by your mentor.', 'info');
    updateSessionsBadge();
    if (currentPage === 'sessions') {
      loadSessions();
    }
  });

  // Multi-device sync: fired on the sender's OTHER devices/tabs when they send
  socket.on('message_sent', (msg) => {
    if (currentPage === 'chat' && window.chatState?.with && String(window.chatState.with) === String(msg.to_id)) {
      addMessageToChat(msg);
    }
  });

  // ─── Follow-up goals: real-time on both sides ─────────────────
  // Mentee dashboard gets a fully animated in-place update via
  // applyMyGoalRealtime(). The mentor's "My Mentees" goal panel gets
  // the same slide-in/pulse/slide-out treatment via applyMentorGoalRealtime()
  // — both are idempotent, so they're also safe to call for actions the
  // current user just triggered themselves (the HTTP response already
  // patched the DOM; the echoed socket event is a no-op reconciliation).
  socket.on('goal_created', (goal) => {
    if (document.querySelector(`.goal-item[data-goal-id="${goal.id}"], .my-goal-item[data-goal-id="${goal.id}"]`)) return;
    if (String(goal.mentee_id) === String(currentUser?.telegram_id)) {
      haptic('light');
      applyMyGoalRealtime('added', goal);
    }
    applyMentorGoalRealtime('added', goal, goal.mentee_id);
  });

  socket.on('goal_updated', (goal) => {
    if (String(goal.mentee_id) === String(currentUser?.telegram_id)) {
      applyMyGoalRealtime('updated', goal);
    }
    applyMentorGoalRealtime('updated', goal, goal.mentee_id);
  });

  socket.on('goal_deleted', ({ id, mentee_id, mentor_id } = {}) => {
    if (String(mentee_id) === String(currentUser?.telegram_id)) {
      applyMyGoalRealtime('deleted', { id });
    }
    applyMentorGoalRealtime('deleted', { id, mentee_id, mentor_id }, mentee_id);
  });
}

// ─── Navigation ───────────────────────────────────────────────
function navigate(page) {
  haptic('selection');

  // Stop the sessions refresh timer whenever we leave the sessions page
  if (currentPage === 'sessions' && page !== 'sessions') stopSessionTimer();

  currentPage = page;
  $$('.page').forEach(p => p.classList.remove('active'));
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $(`page-${page}`)?.classList.add('active');
  const navEl = $(`nav-${page}`);
  navEl?.classList.add('active');
  // Always scroll the active tab into view so the indicator shows correctly
  navEl?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });

  // Load page data
  switch (page) {
    case 'dashboard': loadDashboard(); break;
    case 'mentors':
      loadMentorTopics();   // load the dropdown only once
      loadMentors();        // load mentors (filter will work)
      break;
    case 'sessions': loadSessions(); break;
    case 'chat': loadChat(); requestAnimationFrame(syncChatInputHeight); break;
    case 'support': loadUserTickets(); break;
    case 'requests': loadRequests(); break;
    case 'settings': loadSettings(); break;
    case 'my-mentees': loadMyMentees(); break;
    case 'journal':
      journalView = 'list';
      loadJournalEntries();
      $('journalViewToggle').innerHTML = ICON_CALENDAR + ' ' + t('Calendar');
      break;
  }
  updateSessionsBadge();
}

function toggleChatInput(visible) {
  const row = $('chatInputRow');
  if (!row) return;
  if (visible) {
    row.classList.remove('hidden');
    row.style.display = 'flex';
  } else {
    row.classList.add('hidden');
    row.style.display = 'none';
  }
  syncChatInputHeight();
}

// ─── Chat input height sync ──────────────────────────────────
// .chat-input-row is position:fixed (see styles.css), so #chatMessages
// needs its own bottom padding to avoid the last message(s) sitting
// underneath it. That padding is driven by the --chat-input-h CSS var,
// updated here from the row's *actual* rendered height (reply banner
// shown/hidden, multi-line message typed, hidden entirely, etc) rather
// than a guessed constant, so it always exactly matches.
function syncChatInputHeight() {
  const row = $('chatInputRow');
  const messages = $('chatMessages');
  if (!row || !messages) return;
  const h = row.classList.contains('hidden') ? 0 : row.offsetHeight;
  if (row._lastSyncedH !== h) {
    row._lastSyncedH = h;
    messages.style.setProperty('--chat-input-h', h + 'px');
  }
}
window.addEventListener('resize', syncChatInputHeight);
window.visualViewport?.addEventListener('resize', syncChatInputHeight);

// ─── Onboarding ───────────────────────────────────────────────
const ONBOARDING_TOTAL_STEPS = 7;
let onboardingStep = 0;
let onboardingTopicsCache = [];

const ICON_CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
const ICON_WARN_SVG = '<svg class="err-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="12" y1="8" x2="12" y2="13"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';

async function showOnboarding() {
  $('loadingScreen')?.classList.add('hidden');
  $('onboarding').style.display = 'flex';
  applyLanguage();

  // Reset selection state in case onboarding is re-entered
  $('regSex').value = '';
  $('regAge').value = '';
  $('regEdu').value = '';
  $('regNickname').value = '';
  onNicknameInput();
  $$('.sex-option-btn, .segmented-option').forEach(btn => btn.classList.remove('active'));

  const chipsContainer = $('regTopicsChips');
  const emptyState = $('regTopicsEmpty');
  const searchInput = $('regTopicsSearch');
  const select = $('regTopicsSelect');

  onboardingTopicsCache = [];
  if (searchInput) searchInput.value = '';
  if (select) select.innerHTML = '';
  emptyState?.classList.add('hidden');
  if (chipsContainer) {
    chipsContainer.classList.remove('hidden');
    chipsContainer.innerHTML = `
      <div class="topics-loading-state">
        <span class="loading-spinner" style="width:20px;height:20px;margin:0"></span>
        <span>${t('topics_loading')}</span>
      </div>`;
  }

  loadOnboardingTopics();
  showStep(0);
}

async function loadOnboardingTopics() {
  const chipsContainer = $('regTopicsChips');
  const emptyState = $('regTopicsEmpty');
  const select = $('regTopicsSelect');
  if (!chipsContainer) return;

  emptyState?.classList.add('hidden');
  chipsContainer.classList.remove('hidden');
  chipsContainer.innerHTML = `
    <div class="topics-loading-state">
      <span class="loading-spinner" style="width:20px;height:20px;margin:0"></span>
      <span>${t('topics_loading')}</span>
    </div>`;

  try {
    const topics = await apiFetch('/api/topics');
    onboardingTopicsCache = Array.isArray(topics) ? topics : [];

    if (select) {
      select.innerHTML = onboardingTopicsCache
        .map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
        .join('');
    }

    if (!onboardingTopicsCache.length) {
      chipsContainer.classList.add('hidden');
      if (emptyState) {
        $('regTopicsEmptyText').textContent = t('topics_none_setup');
        emptyState.classList.remove('hidden');
      }
      return;
    }

    renderOnboardingTopicChips(onboardingTopicsCache);
    renderOnboardingSelectedTags();
  } catch (e) {
    console.error('Failed to load topics for onboarding:', e);
    chipsContainer.classList.add('hidden');
    if (emptyState) {
      $('regTopicsEmptyText').textContent = e.message || t('topics_none_available');
      emptyState.classList.remove('hidden');
    }
  }
}

/* ── Topic icons (Halo Grid) ────────────────────────────────────
   Keyed by the topics.slug column (see database/migrations/04_add_topics.sql).
   Kept in the same stroke-based visual language as the rest of the app's
   icon set. Falls back to a generic "more" glyph for any topic added
   later without a matching slug, so new admin-created topics never
   render blank. */
const TOPIC_ICONS = {
  identity_crisis: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/><path d="M8 12l2.5 2.5L16 9"/>',
  depression_anxiety: '<path d="M8 16c1.2-2 2.3-2 3-2s1.8 0 3 2"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="12" cy="12" r="9"/>',
  alcohol_drug_addiction: '<path d="M12 2.5S6 9 6 13.5a6 6 0 0 0 12 0C18 9 12 2.5 12 2.5z"/>',
  alcohol_drug_addition: '<path d="M12 2.5S6 9 6 13.5a6 6 0 0 0 12 0C18 9 12 2.5 12 2.5z"/>',
  pre_marital_sexual_issues: '<path d="M12 21s-7-4.6-9.3-9C1 8 2.4 4.8 5.6 4.2 8 3.7 10.3 5 12 7c1.7-2 4-3.3 6.4-2.8 3.2.6 4.6 3.8 2.9 7.8C19 16.4 12 21 12 21z"/><path d="M9 11l2 2 4-4"/>',
  porn_masterbation: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><line x1="3" y1="3" x2="21" y2="21"/>',
  social_media_addiction: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="10" y1="19" x2="14" y2="19"/>',
  losing_faith_spiritual_life: '<line x1="12" y1="2.5" x2="12" y2="21.5"/><line x1="6" y1="8" x2="18" y2="8"/>',
  time_management: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  loneliness: '<circle cx="12" cy="8" r="4"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/>',
  family_issues: '<path d="M3 11l9-7 9 7"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/>',
  relationship_issues: '<path d="M12.5 19s-5.5-3.5-7.6-7C3.5 9.6 4.4 7 6.7 6.6c1.7-.3 3.1.6 4 1.9.9-1.3 2.3-2.2 4-1.9 2.3.4 3.2 3 1.8 5.4-2.1 3.5-4 4.7-4 4.7"/><path d="M17 3.3c1.3.3 2.1 1.8 1.6 3.2"/>',
  academic_counseling: '<path d="M2 5.5C4 4 8 4 10 5.5v13C8 17 4 17 2 18.5z"/><path d="M22 5.5C20 4 16 4 14 5.5v13c2-1.5 6-1.5 8 0z"/>',
  other: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>'
};
const TOPIC_ICON_FALLBACK = TOPIC_ICONS.other;
function topicIconSvg(slug) {
  const path = TOPIC_ICONS[slug] || TOPIC_ICON_FALLBACK;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

function renderOnboardingTopicChips(topics) {
  const chipsContainer = $('regTopicsChips');
  const select = $('regTopicsSelect');
  if (!chipsContainer || !select) return;

  const selectedIds = new Set(Array.from(select.selectedOptions).map(o => Number(o.value)));

  if (!topics.length) {
    chipsContainer.innerHTML = '<p class="form-helper-ob" style="margin:4px 0;grid-column:1/-1">No topics match your search.</p>';
    return;
  }

  chipsContainer.innerHTML = topics.map(t => `
    <div class="topic-chip${selectedIds.has(t.id) ? ' active' : ''}" id="onb-topic-${t.id}"
      onclick="toggleOnboardingTopicChip(${t.id})">
      <span class="chip-check-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </span>
      <span class="chip-icon">${topicIconSvg(t.slug)}</span>
      <span class="chip-name">${escapeHtml(t.name)}</span>
    </div>
  `).join('');
}

function renderOnboardingSelectedTags() {
  const wrap = $('regTopicsSelectedTags');
  const select = $('regTopicsSelect');
  if (!wrap || !select) return;

  const selected = Array.from(select.selectedOptions);
  if (!selected.length) {
    wrap.innerHTML = '';
    wrap.classList.add('hidden');
    return;
  }

  wrap.classList.remove('hidden');
  wrap.innerHTML = selected.map(o => `
    <span class="topic-tag-pill">
      ${escapeHtml(o.textContent)}
      <button type="button" class="topic-tag-remove" aria-label="Remove ${escapeHtml(o.textContent)}"
        onclick="toggleOnboardingTopicChip(${Number(o.value)})">×</button>
    </span>
  `).join('');
}

function filterOnboardingTopics(query) {
  const q = (query || '').trim().toLowerCase();
  const filtered = q
    ? onboardingTopicsCache.filter(t => t.name.toLowerCase().includes(q))
    : onboardingTopicsCache;
  renderOnboardingTopicChips(filtered);
}

function toggleOnboardingTopicChip(id) {
  haptic('light');
  const select = $('regTopicsSelect');
  if (!select) return;

  const option = Array.from(select.options).find(o => Number(o.value) === id);
  if (!option) return;

  option.selected = !option.selected;

  const chip = $(`onb-topic-${id}`);
  chip?.classList.toggle('active', option.selected);
  renderOnboardingSelectedTags();
  if (select.selectedOptions.length > 0) clearFieldError('group-regTopics');
}

function showStep(step) {
  haptic('light');
  onboardingStep = step;

  const fill = $('ob-step-line-fill');
  if (fill) {
    fill.style.width = (step / (ONBOARDING_TOTAL_STEPS - 1) * 100) + '%';
  }

  $$('.stepper-dot').forEach((d, i) => {
    d.classList.toggle('active', i === step);
    d.classList.toggle('done', i < step);
  });

  const count = $('obStepCount');
  if (count) count.textContent = `${step + 1}/${ONBOARDING_TOTAL_STEPS}`;

  const backBtn = $('obBackBtn');
  if (backBtn) backBtn.classList.toggle('hidden', step === 0);

  $$('.onboarding-step').forEach((s, i) => s.classList.toggle('hidden', i !== step));
  clearAllFieldErrors();
}

function prevStep() {
  if (onboardingStep > 0) showStep(onboardingStep - 1);
}

// Dots only allow jumping backward to a step already completed — forward
// progress always goes through the Continue buttons so each step is validated.
function goToStepIfValid(step) {
  if (step <= onboardingStep) {
    showStep(step);
  }
}

function showInlineError(targetId, message) {
  const el = $(targetId);
  if (!el) return;

  const isGroup = el.id && el.id.startsWith('group-');
  if (!isGroup) el.classList.add('is-invalid');

  const parent = isGroup ? el : (el.closest('.form-group-ob') || el.parentNode);
  parent.classList.add('is-invalid-group');

  let errorDiv = parent.querySelector('.inline-error');
  if (!errorDiv) {
    errorDiv = document.createElement('div');
    errorDiv.className = 'inline-error';
    parent.appendChild(errorDiv);
  }
  errorDiv.innerHTML = `${ICON_WARN_SVG}<span>${escapeHtml(message)}</span>`;
}

function clearFieldError(targetId) {
  const el = $(targetId);
  if (!el) return;
  el.classList.remove('is-invalid');

  const isGroup = el.id && el.id.startsWith('group-');
  const parent = isGroup ? el : (el.closest('.form-group-ob') || el.parentNode);
  parent.classList.remove('is-invalid-group');

  const errorDiv = parent.querySelector('.inline-error');
  if (errorDiv) errorDiv.remove();
}

function clearAllFieldErrors() {
  $$('.inline-error').forEach(el => el.remove());
  $$('.form-control-ob').forEach(el => el.classList.remove('is-invalid'));
  $$('.is-invalid-group').forEach(el => el.classList.remove('is-invalid-group'));
}

function selectSex(value) {
  haptic('light');
  $('regSex').value = value;
  clearFieldError('group-regSex');
  $$('#group-regSex .sex-option-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

function selectAge(value) {
  haptic('light');
  $('regAge').value = value;
  clearFieldError('group-regAge');
  $$('#group-regAge .segmented-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

function selectEdu(value) {
  haptic('light');
  $('regEdu').value = value;
  clearFieldError('group-regEdu');
  $$('#group-regEdu .segmented-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

function onNicknameInput() {
  clearFieldError('regNickname');
  const val = $('regNickname')?.value || '';
  const counter = $('nicknameCounter');
  if (counter) counter.textContent = `${val.length}/20`;
}

// Generic per-step validator: validates the field(s) owned by `step`,
// then advances to `step + 1`. Steps with nothing required (e.g. Topics)
// simply pass through.
function validateAndGoNext(step) {
  clearAllFieldErrors();
  let ok = true;

  if (step === 1) {
    if (!$('regSex').value) {
      showInlineError('group-regSex', t('err_select_sex'));
      ok = false;
    }
  } else if (step === 2) {
    if (!$('regAge').value) {
      showInlineError('group-regAge', t('err_select_age'));
      ok = false;
    }
  } else if (step === 3) {
    if (!$('regEdu').value) {
      showInlineError('group-regEdu', t('err_select_edu'));
      ok = false;
    }
  } else if (step === 4) {
    const nickname = $('regNickname').value.trim();
    const nickRegex = /^[a-zA-Z0-9_]{3,20}$/;
    if (!nickname) {
      showInlineError('regNickname', t('err_nickname_required'));
      ok = false;
    } else if (!nickRegex.test(nickname)) {
      showInlineError('regNickname', t('err_nickname_format'));
      ok = false;
    }
  } else if (step === 5) {
    const select = $('regTopicsSelect');
    const selectedCount = select ? select.selectedOptions.length : 0;
    if (selectedCount === 0) {
      showInlineError('group-regTopics', t('err_select_topic'));
      ok = false;
    }
  }

  if (!ok) {
    haptic('error');
    return;
  }

  showStep(step + 1);
}

async function completeRegistration() {
  const sex = $('regSex').value;
  const age_range = $('regAge').value;
  const education_level = $('regEdu').value;
  const nickname = $('regNickname').value.trim();
  const nickRegex = /^[a-zA-Z0-9_]{3,20}$/;

  clearAllFieldErrors();

  let hasError = false;
  let firstErrorStep = null;
  if (!sex) { hasError = true; firstErrorStep = firstErrorStep ?? 1; }
  if (!age_range) { hasError = true; firstErrorStep = firstErrorStep ?? 2; }
  if (!education_level) { hasError = true; firstErrorStep = firstErrorStep ?? 3; }
  if (!nickname || !nickRegex.test(nickname)) { hasError = true; firstErrorStep = firstErrorStep ?? 4; }
  const selectedTopicCount = $('regTopicsSelect')?.selectedOptions.length || 0;
  if (selectedTopicCount === 0) { hasError = true; firstErrorStep = firstErrorStep ?? 5; }

  if (hasError) {
    haptic('error');
    showStep(firstErrorStep);
    if (!sex) showInlineError('group-regSex', t('err_sex_required'));
    if (!age_range) showInlineError('group-regAge', t('err_age_required'));
    if (!education_level) showInlineError('group-regEdu', t('err_edu_required'));
    if (!nickname) {
      showInlineError('regNickname', t('err_nickname_required_anon'));
    } else if (!nickRegex.test(nickname)) {
      showInlineError('regNickname', t('err_nickname_format'));
    }
    if (selectedTopicCount === 0) showInlineError('group-regTopics', t('err_select_topic'));
    showToast(t('err_correct_below'), 'error');
    return;
  }

  const regBtn = $('regBtn');
  regBtn.disabled = true;
  regBtn.innerHTML = `<span>${t('btn_joining')}</span>`;

  try {
    const data = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: {
        sex,
        age_range,
        education_level,
        nickname,
        chat_id: getTelegramData().user?.id,
        topic_ids: Array.from($('regTopicsSelect').selectedOptions).map(o => Number(o.value))
      },
    });
    haptic('success');
    currentUser = data.user;
    $('onboarding').style.display = 'none';
    startApp();
    showToast(t('registration_success'), 'success');
  } catch (e) {
    haptic('error');
    if (e.message.toLowerCase().includes('taken')) {
      showStep(4);
      showInlineError('regNickname', t('err_nickname_taken'));
    } else {
      showToast(e.message, 'error');
    }
  } finally {
    if (regBtn) {
      regBtn.disabled = false;
      regBtn.innerHTML = `<span>${t('btn_agree_join')}</span><span class="btn-arrow">→</span>`;
    }
  }
}

// ─── Start App ────────────────────────────────────────────────
function startApp() {
  $('app').classList.remove('hidden');
  connectSocket();
  keepAlive();
  navigate('dashboard');
  updateMessageBadge();
  updateRequestsBadge();
  updateSessionsBadge();
  checkPendingRating();


  if (String(currentUser?.telegram_id) === String(window.ADMIN_ID)) {
    $('adminBtn')?.classList.remove('hidden');
  }

  if (currentUser?.role === 'mentor') {
    $('nav-requests')?.classList.remove('hidden');
    $('nav-my-mentees')?.style.setProperty('display', 'flex');
    document.querySelectorAll('.mentor-hidden').forEach(el => el.style.display = 'none');
  }

  applyLanguage();
}

function keepAlive() {
  setInterval(() => fetch(`${API}/health`).catch(() => { }), 4 * 60 * 1000);
}

// ─── Dashboard ────────────────────────────────────────────────
window.loadDashboard = async function loadDashboard() {
  try {
    const verse = await apiFetch('/api/auth/verse');
    $('verseText').textContent = verse.text;
    $('verseRef').textContent = verse.reference;

    // Once-a-day invitation to actually read the verse, gated purely
    // on the calendar date so it never shows more than once per day.
    const todayStr = new Date().toISOString().split('T')[0];
    if (verse?.text && localStorage.getItem('last_verse_popup_date') !== todayStr) {
      localStorage.setItem('last_verse_popup_date', todayStr);
      showEngagementPopup({
        id: 'daily_verse_invite',
        icon: ENGAGEMENT_ICONS.book,
        title: t('daily_verse_invite_title'),
        message: t('daily_verse_invite_message', { verse: escapeHtml(verse.text) }),
        buttonText: t('btn_read_now'),
        secondaryText: t('btn_remind_later'),
        variant: 'info',
        onAction: () => {
          if (currentPage !== 'dashboard') navigate('dashboard');
          requestAnimationFrame(() => {
            $('verseText')?.closest('.verse-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        },
        onSecondary: () => {
          // Free to show again on the next dashboard load today.
          localStorage.removeItem('last_verse_popup_date');
        },
      });
    }
  } catch { }

  try {
    const stats = await apiFetch('/api/users/stats');
    $('statUsers').textContent = stats.total_users;
    $('statMentors').textContent = stats.active_mentors;
    $('statSessions').textContent = stats.sessions_today;
  } catch { }

  loadStreak();

  if (currentUser?.role === 'user') loadMyGoalsWidget();

  if (String(currentUser?.telegram_id) === String(window.ADMIN_ID)) {
    $('adminBtn')?.classList.remove('hidden');
  }
  updateSessionsBadge();

  // Rating popup can also fire from a week of activity — left disabled
  // for now; enable once we have a real signal for "a week of activity".
  // checkAndShowRatingPopup();
}

// ─── Streaks ──────────────────────────────────────────────────

// Stroke-style icon set matching the flame/mood-face icon language elsewhere
// in this file — 24x24 viewBox, currentColor stroke, rounded caps.
const STREAK_ICON_CHECK = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4.5 4.5L19 7"/></svg>';
const STREAK_ICON_SHIELD_SM = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 4.5 6v6c0 5 3.2 8.6 7.5 10 4.3-1.4 7.5-5 7.5-10V6L12 2.5z"/></svg>';
const STREAK_ICON_TROPHY = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M8 5H5a3 3 0 0 0 3 5M16 5h3a3 3 0 0 1-3 5"/><path d="M12 13v3M9 20h6M10 16h4v4h-4z"/></svg>';

const WEEK_DAY_INITIALS = {
  en: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
  am: ['እ', 'ሰ', 'ማ', 'ረ', 'ሐ', 'ዓ', 'ቅ'],
};

function renderStreakWeek(week) {
  const el = $('streakWeek');
  if (!el || !Array.isArray(week)) return;

  el.innerHTML = week.map(day => {
    const d = new Date(day.date + 'T00:00:00');
    const initials = WEEK_DAY_INITIALS[currentLanguage] || WEEK_DAY_INITIALS.en;
    const label = initials[d.getDay()];

    let dotClass = 'streak-week-dot';
    let icon = '';
    if (day.used_freeze) {
      dotClass += ' is-frozen';
      icon = STREAK_ICON_SHIELD_SM;
    } else if (day.read) {
      dotClass += ' is-read';
      icon = STREAK_ICON_CHECK;
    }
    if (day.is_today) dotClass += ' is-today';

    return `<div class="streak-week-item">
      <div class="${dotClass}">${icon}</div>
      <span class="streak-week-label">${label}</span>
    </div>`;
  }).join('');
}

async function loadStreak() {
  try {
    const s = await apiFetch('/api/streaks');
    $('streakCount').textContent = s.current_streak;

    const longestEl = $('streakLongest');
    if (longestEl) {
      const isBest = s.current_streak > 0 && s.current_streak === s.longest_streak;
      longestEl.innerHTML = isBest
        ? `<span class="streak-best-badge">${STREAK_ICON_TROPHY} ${t('streak_best_badge')}</span>`
        : t('streak_longest_label', { longest: s.longest_streak || 0 });
    }

    const freezeBadge = $('streakFreezeBadge');
    const freezeCount = s.freezes_available || 0;
    if (freezeBadge) {
      freezeBadge.classList.toggle('hidden', freezeCount < 1);
      $('streakFreezeCount').textContent = freezeCount;
    }

    renderStreakWeek(s.week);

    // Nudge users who haven't opted into the evening reminder yet — only
    // once they actually have a streak worth protecting.
    const nudge = $('streakReminderNudge');
    if (nudge) {
      nudge.classList.toggle('hidden', s.notify_streak_reminder !== false || s.current_streak < 1);
    }

    // Check if already read today (Ethiopia time)
    const etNow = new Date(new Date().getTime() + (3 * 60 * 60 * 1000));
    const today = etNow.toISOString().split('T')[0];

    const btn = $('markReadBtn');
    if (s.last_read_date === today) {
      btn.textContent = t('streak_already_read');
      btn.disabled = true;
      $('streakCard').classList.add('is-done-today');
    } else {
      btn.textContent = t('btn_mark_read');
      btn.disabled = false;
      $('streakCard').classList.remove('is-done-today');
    }
  } catch (e) { console.error('Streak error:', e); }
}
const loadDashboard = window.loadDashboard;

async function markStreakRead() {
  if ($('markReadBtn').disabled) return;
  haptic('medium');
  try {
    const s = await apiFetch('/api/streaks/mark', { method: 'POST' });
    haptic('success');

    if (s.milestone) {
      showEngagementPopup({
        id: `streak_milestone_${s.current_streak}`,
        icon: ENGAGEMENT_ICONS.flame,
        title: t('streak_milestone_title', { count: s.current_streak }),
        message: t('streak_milestone_message', { count: s.current_streak }),
        buttonText: t('btn_lets_go'),
        variant: 'gold',
        onAction: () => checkAndShowRatingPopup(),
      });
      const card = $('streakCard');
      card.classList.add('streak-celebrate');
      setTimeout(() => card.classList.remove('streak-celebrate'), 1200);
    } else if (s.freeze_used) {
      showToast(t('streak_saver_used'), 'success');
    } else if (s.was_reset) {
      showToast(t('streak_fresh_start'), 'info');
    } else {
      showToast(t('streak_marked'), 'success');
    }
    loadStreak();
  } catch (e) { showToast(e.message, 'error'); }
}

// One-tap opt-in from the card itself — no need to dig into Settings.
async function enableStreakReminder(event) {
  event?.stopPropagation();
  haptic('light');
  try {
    await apiFetch('/api/users/settings', {
      method: 'PATCH',
      body: { notify_streak_reminder: true },
    });
    $('streakReminderNudge')?.classList.add('hidden');
    const toggle = $('toggleStreak');
    if (toggle) toggle.classList.add('on');
    showToast(t('streak_reminder_enabled'), 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// ─── Goal list "live ticker" auto-scroll ────────────────────────
// Continuous, one-directional auto-scroll for a goals list — a real
// stock-ticker loop, not a bounce. `el` is the CONTENT element (the
// real, still-queryable `.my-goals-list` / `.goal-panel-items` node —
// every other function in this file keeps reading/writing it exactly
// as before). Its immediate parent is the fixed-height, overflow:hidden
// "viewport" that actually scrolls.
//
// The trick: a hidden clone of the content is mirrored directly below
// it inside the viewport, so the viewport's scrollable height is
// exactly 2x the real content. We scroll straight down forever; the
// instant we've scrolled past one full content-height, we subtract
// that height back off scrollTop. Because the clone is pixel-identical
// to the content it follows, that wrap is invisible — the list just
// keeps gliding, no snap-back, no pause-and-reverse.
//
// Pauses on hover/touch, and briefly (resetting to the top) whenever a
// new item lands so the user actually sees it arrive. Respects
// prefers-reduced-motion (never autoplays) and skips work entirely
// while its element isn't visible (a different page/tab of the mini
// app is showing) or the document is backgrounded.
const GOAL_TICKER_REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

window.tickerPaused = false;
window._tickerResumeTimeout = null;

function pauseTicker() {
  window.tickerPaused = true;
  if (window._tickerResumeTimeout) {
    clearTimeout(window._tickerResumeTimeout);
    window._tickerResumeTimeout = null;
  }
}

function resumeTicker() {
  if (window._tickerResumeTimeout) {
    clearTimeout(window._tickerResumeTimeout);
    window._tickerResumeTimeout = null;
  }
  window.tickerPaused = false;
}

class GoalTicker {
  constructor(el, opts = {}) {
    this.content = el;
    this.viewport = el.parentElement;
    this.speed = opts.speed ?? 1;              // ~1px per frame at 60fps
    this.newItemPauseMs = opts.newItemPauseMs ?? 2000; // pause after a goal is added
    this.minItemsToRun = opts.minItemsToRun ?? 2;
    this.hovered = false;
    this.pausedUntil = 0;
    this._raf = null;
    this.clone = null;

    this._onEnter = () => { this.hovered = true; };
    this._onLeave = () => { this.hovered = false; };
    this._onTouchStart = () => { this.hovered = true; };
    this._onTouchEnd = () => { setTimeout(() => { this.hovered = false; }, 500); };
    this.viewport.addEventListener('mouseenter', this._onEnter);
    this.viewport.addEventListener('mouseleave', this._onLeave);
    this.viewport.addEventListener('touchstart', this._onTouchStart, { passive: true });
    this.viewport.addEventListener('touchend', this._onTouchEnd, { passive: true });
    this.viewport.addEventListener('touchcancel', this._onTouchEnd, { passive: true });

    this.refresh();
  }

  // Call after any DOM mutation to the content (add/update/delete) so
  // the mirrored clone stays pixel-identical and scrollTop stays sane.
  refresh() {
    const itemCount = this.content.children.length;
    const contentH = this.content.scrollHeight;
    const viewportH = this.viewport?.clientHeight || 0;
    const shouldLoop = !GOAL_TICKER_REDUCED_MOTION && itemCount >= this.minItemsToRun && viewportH > 0 && contentH > viewportH + 4;

    if (!shouldLoop) {
      if (this.clone) {
        this.clone.remove();
        this.clone = null;
      }
      if (this.viewport) this.viewport.scrollTop = 0;
      return;
    }

    if (!this.clone) {
      this.clone = document.createElement('div');
      this.clone.className = `${this.content.className} goal-ticker-clone`;
      this.clone.setAttribute('aria-hidden', 'true');
      this.viewport.appendChild(this.clone);
    }
    this.clone.innerHTML = this.content.innerHTML;
    if (contentH > 0 && this.viewport.scrollTop >= contentH) {
      this.viewport.scrollTop = this.viewport.scrollTop % contentH;
    }
  }

  // Call right after a new item is inserted — snaps back to the top so
  // the arrival is visible, then briefly holds the ticker still before
  // resuming its downward glide.
  notifyNewItem() {
    this.refresh();
    this.viewport.scrollTop = 0;
    pauseTicker();
    if (window._tickerResumeTimeout) clearTimeout(window._tickerResumeTimeout);
    window._tickerResumeTimeout = setTimeout(resumeTicker, this.newItemPauseMs ?? 2000);
  }

  start() {
    if (this._raf || GOAL_TICKER_REDUCED_MOTION) return;
    const step = () => {
      this._raf = requestAnimationFrame(step);
      if (document.hidden || this.hovered || this.viewport.offsetParent === null || window.tickerPaused) return;
      if (Date.now() < this.pausedUntil) return;

      const itemCount = this.content.children.length;
      const contentH = this.content.scrollHeight;
      const viewportH = this.viewport?.clientHeight || 0;
      if (itemCount < this.minItemsToRun || viewportH === 0 || contentH <= viewportH + 4) return; // nothing worth looping

      this.viewport.scrollTop += this.speed;
      if (this.viewport.scrollTop >= contentH) {
        this.viewport.scrollTop -= contentH; // seamless wrap — clone picks up exactly where content left off
      }
    };
    this._raf = requestAnimationFrame(step);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  destroy() {
    this.stop();
    this.viewport.removeEventListener('mouseenter', this._onEnter);
    this.viewport.removeEventListener('mouseleave', this._onLeave);
    this.viewport.removeEventListener('touchstart', this._onTouchStart);
    this.viewport.removeEventListener('touchend', this._onTouchEnd);
    this.viewport.removeEventListener('touchcancel', this._onTouchEnd);
    this.clone?.remove();
    this.clone = null;
  }
}

// ─── My Goals (mentee dashboard widget) ─────────────────────────
// Read-only follow-up goals set by the mentee's mentor — the mentee
// can toggle completion here, but adding/editing/removing a goal is
// still done from the mentor's "My Mentees" panel. Updates arrive
// live over Socket.IO (goal_created / goal_updated / goal_deleted),
// wired up in connectSocket() above, so this widget never needs to
// poll or be manually refreshed.
let myGoalsCache = [];
let myGoalsTicker = null;

// Green/red pulsing dot next to the "My Goals" title — reflects the
// live socket.io connection state. Also touches the mentor-side "My
// Mentees" live dot if one is rendered on the currently open panel.
function setGoalsLiveStatus(connected) {
  document.querySelectorAll('.live-dot').forEach(dot => {
    dot.classList.toggle('live-dot--live', connected);
    dot.classList.toggle('live-dot--offline', !connected);
    dot.title = connected ? 'Live' : 'Reconnecting…';
  });
}

function myGoalsProgress() {
  const total = myGoalsCache.length;
  const done = myGoalsCache.filter(g => g.is_done).length;
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
}

function renderMyGoalItem(g) {
  const missed = !g.is_done && g.is_missed;
  const due = g.due_date
    ? `<div class="goal-item-due">${t('mentee_goal_due')} ${new Date(g.due_date).toLocaleDateString()}${missed ? ` <span class="goal-missed-badge">${t('mentee_goal_missed')}</span>` : ''}</div>`
    : '';
  return `
    <div class="my-goal-item ${g.is_done ? 'done' : ''} ${missed ? 'missed' : ''}" data-goal-id="${g.id}">
      <label class="premium-checkbox">
        <input type="checkbox" ${g.is_done ? 'checked' : ''} onchange="toggleMyGoalDone('${g.id}', this.checked)">
        <span class="premium-checkbox-box">
          <svg class="premium-checkbox-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
        </span>
      </label>
      <div class="my-goal-item-title">${escapeHtml(g.title)}${due}</div>
    </div>`;
}

function updateMyGoalsProgressBar() {
  const { total, done, pct } = myGoalsProgress();
  const fill = $('myGoalsProgressFill');
  const label = $('myGoalsProgressLabel');
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = t('my_goals_progress_label', { done, total });
}

async function loadMyGoalsWidget() {
  const card = $('myGoalsCard');
  const list = $('myGoalsList');
  if (!card || !list || !currentUser?.telegram_id) return;
  try {
    const goals = await apiFetch(`/api/mentors/goals/${currentUser.telegram_id}`);
    myGoalsCache = goals || [];
    if (!myGoalsCache.length) {
      card.classList.add('hidden');
      myGoalsTicker?.stop();
      return;
    }
    card.classList.remove('hidden');
    list.innerHTML = myGoalsCache.map(renderMyGoalItem).join('');
    // Staggered reveal so a freshly (re)loaded list still feels alive
    // instead of popping in all at once.
    [...list.children].forEach((el, i) => {
      el.classList.add('goal-enter');
      el.style.animationDelay = `${Math.min(i, 8) * 45}ms`;
      el.addEventListener('animationend', () => { el.classList.remove('goal-enter'); el.style.animationDelay = ''; }, { once: true });
    });
    updateMyGoalsProgressBar();

    if (!myGoalsTicker) myGoalsTicker = new GoalTicker(list);
    myGoalsTicker.refresh();
    myGoalsTicker.start();
  } catch (e) {
    console.error('My Goals load error:', e);
  }
}

async function toggleMyGoalDone(goalId, isDone) {
  haptic('light');
  document.querySelectorAll(`.my-goal-item[data-goal-id="${goalId}"]`).forEach(item => {
    item.classList.toggle('done', isDone);
    item.classList.add('goal-pulse');
    setTimeout(() => item?.classList.remove('goal-pulse'), 500);
    const cb = item.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = isDone;
  });

  const cached = myGoalsCache.find(g => String(g.id) === String(goalId));
  if (cached) cached.is_done = isDone;
  updateMyGoalsProgressBar();

  try {
    // The server also echoes this back over the goal_updated socket
    // event (to reconcile fields like completed_at) — this call just
    // persists the change; the optimistic UI update already happened.
    await apiFetch(`/api/mentors/goals/${goalId}`, { method: 'PATCH', body: { is_done: isDone } });
  } catch (e) {
    showToast(e.message, 'error');
    await loadMyGoalsWidget(); // roll back to server truth on failure
  }
}

// Applies a goal_created/goal_updated/goal_deleted socket payload to the
// mentee-side widget with the matching enter/update/exit animation.
function applyMyGoalRealtime(type, payload) {
  const card = $('myGoalsCard');
  const list = $('myGoalsList');
  if (!card || !list) return;

  if (type === 'added') {
    if (myGoalsCache.some(g => String(g.id) === String(payload.id)) || list.querySelector(`[data-goal-id="${payload.id}"]`)) return; // already applied
    myGoalsCache.unshift(payload);
    card.classList.remove('hidden');
    list.insertAdjacentHTML('afterbegin', renderMyGoalItem(payload));
    const el = list.firstElementChild;
    el?.classList.add('goal-enter');
    el?.addEventListener('animationend', () => el.classList.remove('goal-enter'), { once: true });
    if (!myGoalsTicker) myGoalsTicker = new GoalTicker(list);
    myGoalsTicker.notifyNewItem();
    myGoalsTicker.start();
  }

  if (type === 'updated') {
    const idx = myGoalsCache.findIndex(g => String(g.id) === String(payload.id));
    if (idx !== -1) {
      if (JSON.stringify(myGoalsCache[idx]) === JSON.stringify(payload)) { updateMyGoalsProgressBar(); return; }
      myGoalsCache[idx] = payload;
    } else {
      myGoalsCache.push(payload);
    }
    const existing = list.querySelector(`[data-goal-id="${payload.id}"]`);
    if (existing) {
      existing.outerHTML = renderMyGoalItem(payload);
      const fresh = list.querySelector(`[data-goal-id="${payload.id}"]`);
      fresh?.classList.add('goal-pulse');
      setTimeout(() => fresh?.classList.remove('goal-pulse'), 500);
    } else {
      card.classList.remove('hidden');
      list.insertAdjacentHTML('afterbegin', renderMyGoalItem(payload));
    }
  }

  if (type === 'deleted') {
    myGoalsCache = myGoalsCache.filter(g => String(g.id) !== String(payload.id));
    const el = list.querySelector(`[data-goal-id="${payload.id}"]`);
    if (el) {
      el.classList.add('goal-exit');
      el.addEventListener('animationend', () => {
        el.remove();
        myGoalsTicker?.refresh();
        if (!myGoalsCache.length) { card.classList.add('hidden'); myGoalsTicker?.stop(); }
      }, { once: true });
    }
  }

  myGoalsTicker?.refresh();
  updateMyGoalsProgressBar();
}

const MENTOR_ICON_AGE = '<svg class="mentor-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/><path d="M2 21h20"/><line x1="7" y1="8" x2="7" y2="4"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="17" y1="8" x2="17" y2="4"/></svg>';

// ─── Mentors ──────────────────────────────────────────────────
async function loadMentors() {
  const container = $('mentorsList');
  const filterSelect = $('mentorTopicSelect');
  const selectedTopic = filterSelect ? filterSelect.value : '';

  container.innerHTML = window.skeletonHTML ? skeletonHTML(3) : '<div class="loading-spinner" style="margin:40px auto"></div>';

  try {
    // 1. Fetch active mentor for the user (if any) – keep as is
    let activeMentorHtml = '';
    let hasActiveMentor = false;
    if (currentUser?.role === 'user') {
      try {
        const activeAssignment = await apiFetch('/api/users/my-mentor');
        if (activeAssignment && activeAssignment.mentor) {
          hasActiveMentor = true;
          const m = activeAssignment.mentor;
          const name = m.user_settings?.display_name || m.anonymous_id;
          const bio = m.user_settings?.bio || 'No bio provided';
          const letter = name.charAt(0).toUpperCase();
          const sexLabel = m.sex === 'M' ? t('sex_male') : m.sex === 'F' ? t('sex_female') : '';
          const pillsHtml = (sexLabel || m.age_range) ? `
              <div class="mentor-pill-row">
                ${sexLabel ? `<span class="mentor-pill">${escapeHtml(sexLabel)}</span>` : ''}
                ${m.age_range ? `<span class="mentor-pill mentor-pill-age">${MENTOR_ICON_AGE} ${escapeHtml(m.age_range)}</span>` : ''}
              </div>` : '';
          activeMentorHtml = `
            <div class="card gold-border mb-16" style="border: 2px solid var(--gold);">
              <div class="text-xs font-bold uppercase tracking-wider mb-8" style="color:var(--gold)" data-i18n="your_active_mentor">
                ${t('your_active_mentor') || 'Your Active Mentor'}
              </div>
              <div class="mentor-header mb-8">
                ${renderAvatar(m, letter)}
                <div class="mentor-header-info">
                  <div class="mentor-id">${escapeHtml(name)}</div>
                  ${pillsHtml}
                </div>
              </div>
              <div class="mentor-bio mb-12">${escapeHtml(bio)}</div>
              <div class="flex gap-8">
                <button class="btn btn-outline btn-sm flex-1" onclick="openChat('${m.telegram_id}')" data-i18n="btn_message">${t('btn_message') || 'Message'}</button>
                <button class="btn btn-danger btn-sm" onclick="endMentorship()" data-i18n="btn_end">${t('btn_end') || 'End Mentorship'}</button>
              </div>
            </div>`;
        }
      } catch (err) {
        console.error('Error fetching active mentor:', err);
      }
    }

    // 2. Fetch mentors from API, optionally filtered by topic_id
    let url = '/api/mentors';
    if (selectedTopic && selectedTopic !== '') {
      url += `?topic_id=${selectedTopic}`;
    }
    let mentors = await apiFetch(url);
    // No client‑side filtering needed – API already filtered.

    // 3. Render mentor cards – store selectedTopic for the request button
    let mentorsListHtml = '';
    if (!mentors.length) {
      let message = 'No mentors available';
      if (selectedTopic && selectedTopic !== '') {
        const topicName = filterSelect?.options[filterSelect.selectedIndex]?.text || selectedTopic;
        message = `No mentors available for "${topicName}"`;
      }
      mentorsListHtml = `<div class="empty-state"><span>${message}</span></div>`;
    } else {
      mentorsListHtml = mentors.map(m => {
        const name = m.user_settings?.display_name || m.anonymous_id;
        const bio = m.user_settings?.bio || 'No bio provided';
        const spec = m.user_settings?.specialization || '';
        const letter = name.charAt(0).toUpperCase();
        const sexLabel = m.sex === 'M' ? t('sex_male') : m.sex === 'F' ? t('sex_female') : '';
        const pillsHtml = (sexLabel || m.age_range) ? `
              <div class="mentor-pill-row">
                ${sexLabel ? `<span class="mentor-pill">${escapeHtml(sexLabel)}</span>` : ''}
                ${m.age_range ? `<span class="mentor-pill mentor-pill-age">${MENTOR_ICON_AGE} ${escapeHtml(m.age_range)}</span>` : ''}
              </div>` : '';
        const mentees = m.mentee_count || 0;
        const max = m.user_settings?.max_mentees || 5;
        const canRequest = !hasActiveMentor && mentees < max;

        // Pass selectedTopic (topic ID) to the request function
        const topicIdParam = selectedTopic && selectedTopic !== '' ? `, ${selectedTopic}` : '';

        return `
          <div class="mentor-card">
            <div class="mentor-header">
              ${renderAvatar(m, letter)}
              <div class="mentor-header-info">
                <div class="mentor-id">${escapeHtml(name)}</div>
                ${renderStars(m.rating, m.rating_count)}
                ${pillsHtml}
              </div>
            </div>
            <div class="mentor-bio">${escapeHtml(bio)}</div>
            <div class="mentor-meta">
              ${spec ? `<span class="mentor-badge badge-spec">${escapeHtml(spec)}</span>` : ''}
              <span class="mentor-badge badge-mentees">${mentees}/${max} ${t('role_mentees')}</span>
              ${m.accepting_requests === false ? `<span class="mentor-badge" style="background:rgba(224,92,92,0.1);color:var(--danger);border:1px solid rgba(224,92,92,0.2);">Not Accepting</span>` : ''}
            </div>
            ${currentUser?.role === 'mentor' ? '' : (m.request_pending ? `
              <button class="btn btn-outline btn-sm btn-pending" disabled title="${t('request_pending_tooltip')}">
                ${MENTOR_ICON_PENDING} ${t('btn_request_pending')}
              </button>
            ` : (mentees >= max ? `
              <button class="btn btn-outline btn-sm" disabled style="opacity:0.5;cursor:not-allowed;background:var(--bg3);color:var(--text3);" title="${t('capacity_full_tooltip')}">
                ${t('capacity_full')}
              </button>
            ` : (m.accepting_requests === false ? `
              <button class="btn btn-outline btn-sm" disabled style="opacity:0.5;cursor:not-allowed;background:var(--bg3);color:var(--text3);" title="This mentor is not accepting new requests at this time.">
                ${t('btn_request')}
              </button>
            ` : `
              <button class="btn btn-outline btn-sm" data-mentor-name="${escapeHtml(name)}"
                onclick="requestMentorship(event, ${m.telegram_id}${topicIdParam})" ${!canRequest ? 'disabled' : ''}>
                ${t('btn_request')}
              </button>
            `)))}
          </div>`;
      }).join('');
    }

    container.innerHTML = activeMentorHtml + mentorsListHtml;
    applyLanguage();
    hydrateAvatars(container);
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><span>${e.message}</span></div>`;
  }
}
async function loadMentorTopics() {
  try {
    const topics = await apiFetch('/api/topics');
    const select = $('mentorTopicSelect');
    if (select) {
      select.innerHTML = '<option value="">All Topics</option>' +
        topics.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    }
  } catch (e) {
    console.error('Failed to load topics for filter:', e);
  }
}
// Small stroke-style hourglass icon for the Pending button state.
const MENTOR_ICON_PENDING = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px"><path d="M6 3h12M6 21h12M6 3c0 5 4 6 6 9-2 3-6 4-6 9M18 3c0 5-4 6-6 9 2 3 6 4 6 9"/></svg>';

async function requestMentorship(event, mentor_id, topic_id = null) {
  haptic('medium');
  const btn = event?.currentTarget || null;
  const mentorName = btn?.dataset?.mentorName || '';
  const originalHtml = btn ? btn.innerHTML : '';

  // Optimistic update — the button flips to Pending immediately so the user
  // never wonders whether their tap registered, even before the network
  // round-trip finishes.
  if (btn) {
    btn.disabled = true;
    btn.classList.add('btn-pending');
    btn.innerHTML = `${MENTOR_ICON_PENDING} ${t('btn_request_pending')}`;
  }

  try {
    const body = { mentor_id, message: 'I would like your mentorship.' };
    if (topic_id) {
      body.topic_id = parseInt(topic_id, 10);
    }
    await apiFetch('/api/mentors/request', { method: 'POST', body });
    haptic('success');
    openMentorRequestSentModal(mentorName);
    loadMentors();
  } catch (e) {
    haptic('error');
    // Roll back the optimistic state — the request didn't actually go through.
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('btn-pending');
      btn.innerHTML = originalHtml;
    }
    showToast(e.message, 'error');
  }
}

// ─── Mentorship Request Confirmation Modal ─────────────────────
function openMentorRequestSentModal(mentorName) {
  showEngagementPopup({
    id: 'request_sent',
    icon: ENGAGEMENT_ICONS.check,
    title: t('request_sent_title'),
    message: mentorName
      ? t('request_sent_body_named', { name: `<strong>${escapeHtml(mentorName)}</strong>` })
      : t('request_sent_body'),
    buttonText: t('btn_got_it'),
    variant: 'success',
    onAction: () => {},
  });
}

// Kept as a no-op fallback: the old #mentorRequestSentModal markup in
// index.html is no longer opened above, but leaving this defined means
// nothing breaks if anything else still calls it.
function closeMentorRequestSentModal() {
  $('mentorRequestSentModal')?.classList.remove('open');
}

// ─── Mentorship Requests ──────────────────────────────────────
async function loadRequests() {
  const container = $('requestsList');
  if (!container) return;
  container.innerHTML = window.skeletonHTML ? skeletonHTML(3) : '<div class="loading-spinner" style="margin:40px auto"></div>';
  try {
    const requests = await apiFetch('/api/mentors/my-requests');
    if (!requests.length) {
      container.innerHTML = `<div class="empty-state"><span>${t('no_pending_requests')}</span></div>`;
      return;
    }
    container.innerHTML = requests.map(r => {
      const name = r.user?.user_settings?.display_name || r.user?.anonymous_id || 'Anonymous';
      const sex = r.user?.sex === 'M' ? 'Male' : (r.user?.sex === 'F' ? 'Female' : 'Not specified');
      const age = r.user?.age_range || 'Not specified';
      const topic = r.topic?.name || 'General';
      return `
        <div class="mentor-card">
          <div class="mentor-info">
            <div class="mentor-id">${escapeHtml(name)}</div>
            <div class="text-xs text-dim mt-1">${sex} · ${age} · Topic: ${escapeHtml(topic)}</div>
            <div class="mentor-bio" style="margin-top:4px">${escapeHtml(r.message || 'No message provided')}</div>
          </div>
          <div class="flex gap-8 mt-12">
            <button class="btn btn-primary btn-sm flex-1" onclick="respondToRequest('${r.id}', 'accepted')">${t('btn_accept')}</button>
            <button class="btn btn-outline btn-sm flex-1" onclick="respondToRequest('${r.id}', 'rejected')">${t('btn_reject')}</button>
          </div>
        </div>`;
    }).join('');
    updateRequestsBadge();  // ensure badge updates after loading
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><span>${e.message}</span></div>`;
  }
}

async function respondToRequest(requestId, action) {
  haptic('medium');
  try {
    await apiFetch(`/api/mentors/request/${requestId}`, {
      method: 'PATCH',
      body: { action }
    });
    haptic('success');
    showToast(`Request ${action}`, 'success');
    loadRequests();
    updateRequestsBadge();   // refresh badge after action
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}

// ─── Sessions ─────────────────────────────────────────────────

// How long after the scheduled time a session is still joinable
const SESSION_GRACE_PERIOD_MS = 60 * 60 * 1000; // 60 minutes

// Timer that refreshes session labels every 30 s while on the sessions page
let sessionTimerInterval = null;

// Last fetched session data — used for label-only refreshes without API calls
let _cachedSessionData = { my: [], upcoming: [] };

/** Cancel the sessions auto-refresh timer (called on page navigation). */
function stopSessionTimer() {
  clearInterval(sessionTimerInterval);
  sessionTimerInterval = null;
}

/**
 * Returns { isJoinable, label, labelClass } for a session based on current time.
 * Works for both private (from /my) and group (from /upcoming) sessions.
 *
 * Join buttons are disabled until the exact scheduled start time.
 * No countdown is shown — just a static "Starts at [time]" message.
 */
function getSessionState(scheduledAt, status) {
  const now = Date.now();
  const start = new Date(scheduledAt).getTime();
  const elapsed = now - start; // positive = past, negative = future

  // Explicitly ended by host → always done
  if (status === 'ended' || status === 'cleared') {
    return { isJoinable: false, label: t('session_ended_status'), labelClass: 'chip chip-muted' };
  }

  // Grace period expired even if status is still 'scheduled' or 'active'
  if (elapsed > SESSION_GRACE_PERIOD_MS) {
    return { isJoinable: false, label: '✓ Done', labelClass: 'chip chip-muted' };
  }

  // Future session: not joinable until the exact scheduled time arrives
  if (elapsed < 0) {
    // Show a static "Starts at [time]" message; buttons will be disabled
    const formattedTime = formatDateTime(scheduledAt);
    const startsAtText = t('starts_at').replace('{time}', formattedTime);
    return {
      isJoinable: false,
      label: startsAtText,
      labelClass: 'chip chip-muted session-not-yet',
    };
  }

  // Scheduled time has passed (within grace period) — show the Join button.
  return {
    isJoinable: true,
    label: '',
    labelClass: ''
  };
}

/**
 * Refresh only the status labels / buttons on already-rendered session cards
 * using the cached data — no API call. Called every 30 s by the timer.
 */
function refreshSessionLabels() {
  let activeSessionCount = 0;

  // Private sessions
  const privateContainer = document.getElementById('privateSessionsList');
  if (privateContainer) {
    const items = privateContainer.querySelectorAll('.session-item[data-session-id]');
    items.forEach(item => {
      const scheduledAt = item.dataset.scheduledAt;
      const status = item.dataset.status;
      if (!scheduledAt) return;
      const { isJoinable, label, labelClass } = getSessionState(scheduledAt, status);

      if (isJoinable) {
        activeSessionCount++;
      }

      const labelEl = item.querySelector('.session-live-label');
      const actionEl = item.querySelector('.session-action');
      if (labelEl) {
        if (label) {
          labelEl.className = labelClass;
          labelEl.textContent = label;
          labelEl.style.display = '';
        } else {
          labelEl.textContent = '';
          labelEl.style.display = 'none';
        }
      }
      if (actionEl) {
        const sid = item.dataset.sessionId;
        const status = item.dataset.status;
        if (isJoinable) {
          actionEl.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:6px;">
              <button class="btn btn-primary btn-sm" onclick="joinSession('${sid}')">${joinSessionBtnLabel()}</button>
              <button class="btn btn-outline btn-sm"  onclick="openSessionInBrowser('${sid}')">Join via Browser</button>
            </div>`;
        } else if (labelClass === 'chip chip-muted session-not-yet') {
          // Scheduled but too early — show disabled buttons + "Starts at" text
          actionEl.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:6px;">
              <button class="btn btn-primary btn-sm" disabled style="opacity:.45;cursor:not-allowed;">${joinSessionBtnLabel()}</button>
              <button class="btn btn-outline btn-sm"  disabled style="opacity:.45;cursor:not-allowed;">Join via Browser</button>
              <span class="${labelClass}" style="font-size:.72rem;margin-top:2px;">${label}</span>
            </div>`;
        } else {
          actionEl.innerHTML = `<span class="${labelClass}">${label}</span>`;
        }
      }
    });
  }

  // Group sessions
  const groupContainer = document.getElementById('upcomingSessions');
  if (groupContainer) {
    const items = groupContainer.querySelectorAll('.session-item[data-session-id]');
    items.forEach(item => {
      const scheduledAt = item.dataset.scheduledAt;
      const status = item.dataset.status;
      if (!scheduledAt) return;
      const { isJoinable, label, labelClass } = getSessionState(scheduledAt, status);

      if (isJoinable) {
        activeSessionCount++;
      }

      const labelEl = item.querySelector('.session-live-label');
      const actionEl = item.querySelector('.session-action');
      if (labelEl) { labelEl.className = labelClass; labelEl.textContent = label; }
      if (actionEl) {
        const sid = item.dataset.sessionId;
        if (isJoinable) {
          actionEl.innerHTML = `<button class="btn btn-primary btn-sm" onclick="joinSession('${sid}')">${joinSessionBtnLabel()}</button>`;
        } else if (labelClass === 'chip chip-muted session-not-yet') {
          // Scheduled but too early — show disabled button + "Starts at" text
          actionEl.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:6px;">
              <button class="btn btn-primary btn-sm" disabled style="opacity:.45;cursor:not-allowed;">${joinSessionBtnLabel()}</button>
              <span class="${labelClass}" style="font-size:.72rem;margin-top:2px;">${label}</span>
            </div>`;
        } else {
          actionEl.innerHTML = `<span class="${labelClass}">${label}</span>`;
        }
      }
    });
  }

  updateSessionsBadge(activeSessionCount);
}

async function loadSessions() {
  // Stop any previous timer, start a fresh 30-second label refresh
  stopSessionTimer();
  sessionTimerInterval = setInterval(refreshSessionLabels, 30 * 1000);

  let activeSessionCount = 0;

  // ── Private / assigned sessions ──────────────────────────────
  try {
    const mySessions = await apiFetch('/api/sessions/my');
    const privateContainer = document.getElementById('privateSessionsList');
    if (privateContainer) {
      if (mySessions.length === 0) {
        privateContainer.innerHTML = `<div class="empty-state">${t('no_active_sessions')}</div>`;
      } else {
        privateContainer.innerHTML = mySessions.map(s => {
          const session = s.session;
          if (!session) return '';
          const isGroup = session.is_group;
          const title = session.title || (isGroup ? 'Group Session' : 'Private Session');
          const scheduled = formatDateTime(session.scheduled_at);
          const { isJoinable, label, labelClass } = getSessionState(session.scheduled_at, session.status);

          if (isJoinable) {
            activeSessionCount++;
          }

          // Check if the current user is the host and the session is not already ended/cleared
          const isHost = String(session.host_id) === String(currentUser?.telegram_id);
          const canEnd = isHost && session.status !== 'ended' && session.status !== 'cleared';

          const actionHtml = isJoinable
            ? `<div style="display:flex; flex-direction:column; gap:6px;">
                <button class="btn btn-primary btn-sm" onclick="joinSession('${session.id}')">${joinSessionBtnLabel()}</button>
                <button class="btn btn-outline btn-sm" onclick="openSessionInBrowser('${session.id}')">Join via Browser</button>
                ${canEnd ? `<button class="btn btn-danger btn-sm" onclick="endSession('${session.id}')">End Session</button>` : ''}
              </div>`
            : (labelClass === 'chip chip-muted session-not-yet'
              ? `<div style="display:flex; flex-direction:column; gap:6px;">
                  <button class="btn btn-primary btn-sm" disabled style="opacity:.45;cursor:not-allowed;">${joinSessionBtnLabel()}</button>
                  <button class="btn btn-outline btn-sm" disabled style="opacity:.45;cursor:not-allowed;">Join via Browser</button>
                  ${canEnd ? `<button class="btn btn-danger btn-sm" onclick="endSession('${session.id}')">End Session</button>` : ''}
                  <span class="${labelClass}" style="font-size:.72rem;margin-top:2px;">${label}</span>
                </div>`
              : `<span class="${labelClass}">${label}</span>`);

          return `
            <div class="session-item"
                data-session-id="${session.id}"
                data-scheduled-at="${session.scheduled_at}"
                data-status="${session.status}">
              <div class="session-icon">${isGroup ? '👥' : '👤'}</div>
              <div class="session-body">
                <div class="session-title">${escapeHtml(title)}</div>
                <div class="session-sub">${scheduled}</div>
                ${(label && isJoinable) ? `<div class="session-live-label ${labelClass}" style="margin-top:4px;font-size:.75rem;">${label}</div>` : ''}
              </div>
              <div class="session-action">${actionHtml}</div>
            </div>`;
        }).filter(Boolean).join('');
      }
    }
  } catch (e) { console.error('Error loading private sessions', e); }

  // ── Public / group sessions ────────────────────────────────────
  try {
    const upcoming = await apiFetch('/api/sessions/upcoming');
    const container = document.getElementById('upcomingSessions');
    if (container) {
      if (!upcoming.length) {
        container.innerHTML = `<div class="empty-state"><span>${t('no_upcoming_group_sessions')}</span></div>`;
      } else {
        container.innerHTML = upcoming.map(s => {
          const { isJoinable, label, labelClass } = getSessionState(s.scheduled_at, s.status);
          if (isJoinable) {
            activeSessionCount++;
          }

          // Check if the current user is the host and the session is not already ended/cleared
          const isHost = String(s.host_id) === String(currentUser?.telegram_id);
          const canEnd = isHost && s.status !== 'ended' && s.status !== 'cleared';

          // Build action buttons
          let actionHtml;
          if (isJoinable) {
            actionHtml = `<div style="display:flex; flex-direction:column; gap:6px;">
                <button class="btn btn-primary btn-sm" onclick="joinSession('${s.id}')">${joinSessionBtnLabel()}</button>
                ${canEnd ? `<button class="btn btn-danger btn-sm" onclick="endSession('${s.id}')">End Session</button>` : ''}
              </div>`;
          } else if (labelClass === 'chip chip-muted session-not-yet') {
            actionHtml = `<div style="display:flex; flex-direction:column; gap:6px;">
                <button class="btn btn-primary btn-sm" disabled style="opacity:.45;cursor:not-allowed;">${joinSessionBtnLabel()}</button>
                ${canEnd ? `<button class="btn btn-danger btn-sm" onclick="endSession('${s.id}')">End Session</button>` : ''}
                <span class="${labelClass}" style="font-size:.72rem;margin-top:2px;">${label}</span>
              </div>`;
          } else {
            actionHtml = `<span class="${labelClass}">${label}</span>`;
            // Even if the session is already done, host can still end it? Actually, if it's done, the button is not needed.
            // But we keep it simple: only show if canEnd is true.
            if (canEnd) {
              actionHtml += `<button class="btn btn-danger btn-sm" onclick="endSession('${s.id}')" style="margin-top:4px;">End Session</button>`;
            }
          }

          return `
            <div class="session-item"
                data-session-id="${s.id}"
                data-scheduled-at="${s.scheduled_at}"
                data-status="${s.status}">
              <div class="session-icon">👥</div>
              <div class="session-body">
                <div class="session-title">${escapeHtml(s.title)}</div>
                <div class="session-sub">${formatDateTime(s.scheduled_at)}</div>
                ${(label && isJoinable) ? `<div class="session-live-label ${labelClass}" style="margin-top:4px;font-size:.75rem;">${label}</div>` : ''}
              </div>
              <div class="session-action">${actionHtml}</div>
            </div>`;
        }).join('');
      }
    }
  } catch (e) {
    const el = document.getElementById('upcomingSessions');
    if (el) el.innerHTML = `<div class="empty-state"><span>${e.message}</span></div>`;
  }

  updateSessionsBadge(activeSessionCount);
}

async function clearSessionHistory() {
  if (!confirm('Clear all sessions from your list?')) return;
  haptic('medium');
  try {
    const res = await apiFetch('/api/sessions/my', { method: 'DELETE' });
    haptic('success');
    showToast(`Cleared ${res.count || 0} sessions from history`, 'success');
    loadSessions();
  } catch (e) { haptic('error'); showToast(e.message, 'error'); }
}

// ── Live-session compatibility guard ────────────────────────────────
// Some in-app browsers (Plus Messenger, Nicegram, older Telegram WebViews,
// some embedded Android WebViews) either lack WebRTC entirely or block it,
// which is what causes Jitsi's own "your browser doesn't support..." error
// page and silent video/audio failures. Rather than embed the call and let
// that fail, we check up front and — whenever the current environment
// looks unreliable — offer the external-browser link, which always works.
function detectUnreliableSessionEnvironment() {
  const ua = navigator.userAgent || '';
  const isKnownUnreliableWrapper = /Plus|TelegramPlus|Nicegram|OWM|Bookmarks/i.test(ua);
  const hasWebRTC = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
  const hasRTCPeerConnection = typeof window.RTCPeerConnection === 'function';
  return isKnownUnreliableWrapper || !hasWebRTC || !hasRTCPeerConnection;
}

function isIOSDevice() {
  const ua = navigator.userAgent || '';
  // Modern iPadOS reports as "Mac" UA with touch support — distinguish
  // it from an actual Mac laptop/desktop.
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

// Builds the fallback URL used when we send someone to open the session in
// their phone's own browser instead of our embedded mini-app view.
//
// Jitsi's web client hides the screen-share ("desktop") toolbar button on
// mobile browsers by default and nudges people to install the native app
// instead — that's why "share screen" previously looked unavailable on
// mobile even when the browser itself could technically support it. These
// URL-hash config overrides force the button to show and disable that
// app-install nudge, so screen sharing actually works in-browser wherever
// the underlying platform supports it (modern Android Chrome/Firefox; iOS
// Safari only from iOS 17 onward — that's an Apple platform limitation no
// config can work around).
function buildExternalSessionUrl(data) {
  const forcedToolbarButtons = ['microphone', 'camera', 'desktop', 'chat', 'raisehand', 'tileview', 'fullscreen', 'hangup', 'security'];
  const params = [
    'config.disableDeepLinking=true',
    `config.toolbarButtons=${encodeURIComponent(JSON.stringify(forcedToolbarButtons))}`,
    'interfaceConfig.MOBILE_APP_PROMO=false',
    'interfaceConfig.SHOW_JITSI_WATERMARK=false',
    `userInfo.displayName=${encodeURIComponent(data.display_name)}`,
  ];
  if (data.jitsi_token) params.push(`jwt=${data.jitsi_token}`);
  return `https://${data.jitsi_domain}/${data.room_name}#${params.join('&')}`;
}

async function joinSession(session_id) {
  haptic('medium');
  try {
    const data = await apiFetch(`/api/sessions/${session_id}/join`);

    if (detectUnreliableSessionEnvironment()) {
      if (confirm("⚠️ Your current app may not support video calls reliably.\nOpen in your phone's browser instead? (Recommended)")) {
        window.open(buildExternalSessionUrl(data), '_blank');
        return;
      }
      // User chose to try anyway — fall through and attempt the embedded call.
    }

    launchJitsi(data.room_name, data.room_password, data.display_name, data.jitsi_token, data.is_moderator, data.session_id || null, data);
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}
async function openSessionInBrowser(session_id) {
  try {
    const data = await apiFetch(`/api/sessions/${session_id}/join`);
    const url = `https://${data.jitsi_domain}/${data.room_name}#config.disableDeepLinking=true&userInfo.displayName=${encodeURIComponent(data.display_name)}`;
    window.open(url, '_blank');
  } catch (e) {
    showToast(e.message, 'error');
  }
}
async function createSession(is_group = false, mentee_id = null, scheduled_at = null, customTitle = null, participant_ids = []) {
  haptic('light');
  try {
    // mentee_id is always resolved before createSession is called for 1-on-1 sessions.
    // If somehow still missing (e.g. called programmatically), just show an error.
    if (!is_group && !mentee_id && currentUser?.role === 'mentor') {
      haptic('error');
      showToast('Please select a mentee first.', 'error');
      return;
    }

    const title = customTitle || (is_group ? prompt('Session title (or leave blank):') : 'Private session');
    const finalScheduled = scheduled_at || new Date().toISOString();

    const data = await apiFetch('/api/sessions/create', {
      method: 'POST',
      body: {
        is_group,
        title,
        scheduled_at: finalScheduled,
        mentee_id: mentee_id || null,
        participant_ids: participant_ids.length ? participant_ids : undefined
      }
    });

    haptic('success');
    showToast(is_group ? 'Group session created!' : 'Private session created!', 'success');
    if (new Date(finalScheduled) <= new Date()) {
      // Creator is always the host/moderator when launching immediately
      const joinData = {
        room_name: data.room_name,
        jitsi_domain: data.jitsi_domain,
        jitsi_token: data.jitsi_token,
        display_name: currentUser.anonymous_id,
      };
      launchJitsi(data.room_name, data.room_password, currentUser.anonymous_id, data.jitsi_token, true, data.session.id, joinData);
    } else {
      loadSessions();
    }
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}
// ─── End a session (mentor/host only) ─────────────────────────────
async function endSession(session_id) {
  if (!confirm('End this session for all participants? This action cannot be undone.')) return;
  haptic('medium');
  try {
    await apiFetch(`/api/sessions/${session_id}/end`, { method: 'PATCH' });
    haptic('success');
    showToast('Session ended.', 'success');
    // Reload the sessions list so the status updates immediately
    loadSessions();
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}
function showScheduleModal(is_group, mentee_id = null) {
  haptic('light');
  const modal = document.getElementById('scheduleModal');
  const titleField = document.getElementById('groupTitleField');
  const participantField = document.getElementById('groupParticipantsField');
  const menteeList = document.getElementById('menteeCheckboxes');
  const modalTitle = document.getElementById('scheduleModalTitle');
  const btn = document.getElementById('scheduleBtn');

  if (!modal) return;

  modalTitle.textContent = is_group ? 'Schedule Group Session' : 'Schedule 1-on-1 Session';
  // The title field now applies to both session types — the host can name
  // a 1-on-1 session too (e.g. "Career Check-in"), not just group sessions.
  titleField.classList.remove('hidden');
  const titleInput = document.getElementById('scheduleTitle');
  if (titleInput) {
    titleInput.placeholder = is_group ? 'e.g. Weekly Group Study' : 'e.g. Bible Study (optional)';
    titleInput.value = '';
  }
  participantField.classList.toggle('hidden', !is_group);

  if (is_group && menteeList) {
    menteeList.innerHTML = '<div class="text-xs text-dim">Loading mentees...</div>';
    apiFetch('/api/mentors/my-mentees').then(mentees => {
      if (!mentees.length) {
        menteeList.innerHTML = `<div class="text-xs text-dim">${t('no_mentees_to_invite')}</div>`;
        return;
      }
      menteeList.innerHTML = mentees.map(m => `
        <label class="flex items-center gap-8 mb-4" style="cursor:pointer">
          <input type="checkbox" name="invite_mentee" value="${m.user.telegram_id}" />
          <span class="text-sm">${escapeHtml(m.user.anonymous_id)}</span>
        </label>
      `).join('');
    }).catch(e => {
      menteeList.innerHTML = `<div class="text-danger text-xs">${e.message}</div>`;
    });
  }

  const now = new Date();
  now.setHours(now.getHours() + 1);
  document.getElementById('scheduleDate').value = now.toISOString().split('T')[0];
  document.getElementById('scheduleTime').value = now.toTimeString().slice(0, 5);

  modal.classList.add('open');

  btn.onclick = () => {
    haptic('medium');
    const date = document.getElementById('scheduleDate').value;
    const time = document.getElementById('scheduleTime').value;
    const title = document.getElementById('scheduleTitle').value || (is_group ? 'Group Session' : '1-on-1 Session');

    if (!date || !time) {
      haptic('error');
      showToast('Please pick date and time', 'error');
      return;
    }

    const participant_ids = [];
    if (is_group) {
      document.querySelectorAll('input[name="invite_mentee"]:checked').forEach(cb => {
        participant_ids.push(cb.value);
      });
    }

    // Build a local Date (year, month-1, day, hour, minute) to avoid UTC conversion issues
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    const scheduledAtObj = new Date(year, month - 1, day, hour, minute);
    if (isNaN(scheduledAtObj.getTime())) {
      haptic('error');
      showToast('Invalid date or time selected', 'error');
      return;
    }

    const scheduledAt = scheduledAtObj.toISOString();
    closeScheduleModal();
    createSession(is_group, mentee_id, scheduledAt, title, participant_ids);
  };
}

function closeScheduleModal() {
  haptic('light');
  document.getElementById('scheduleModal')?.classList.remove('open');
}

function openMenteeSelectModal() {
  haptic('light');
  const modal = $('menteeSelectModal');
  const list = $('menteeSelectList');
  if (!modal || !list) return;
  list.innerHTML = '<div class="loading-spinner" style="margin:20px auto"></div>';
  modal.classList.add('open');

  apiFetch('/api/mentors/my-mentees').then(mentees => {
    if (!mentees.length) {
      list.innerHTML = '<p class="text-center py-20">No active mentees.</p>';
      return;
    }
    list.innerHTML = mentees.map(m => `
      <button class="btn btn-outline btn-full" style="text-align:left;justify-content:flex-start;display:block;height:auto;padding:12px" onclick="startPrivateSession('${m.user.telegram_id}')">
        <div class="font-bold">${escapeHtml(m.user.anonymous_id)}</div>
        <div class="text-xs text-dim">Joined ${new Date(m.assigned_at).toLocaleDateString()}</div>
      </button>
    `).join('');
  }).catch(e => {
    list.innerHTML = `<p class="text-danger">${e.message}</p>`;
  });
}

function closeMenteeSelectModal() {
  haptic('light');
  $('menteeSelectModal')?.classList.remove('open');
}

function startPrivateSession(menteeId) {
  closeMenteeSelectModal();
  showScheduleModal(false, menteeId);
}

/**
 * Entry point for the 1-on-1 schedule button.
 * Checks how many mentees the mentor has FIRST so the user always picks
 * a mentee before seeing the date/time picker — not after.
 */
async function openPrivateSessionFlow() {
  haptic('light');
  try {
    const res = await apiFetch('/api/users/chat-partner');
    if (res.type === 'none') {
      haptic('error');
      showToast('No active mentees to start a session with.', 'error');
    } else if (res.type === 'single') {
      // Only one mentee — go straight to the schedule picker with them pre-selected
      showScheduleModal(false, res.partner.telegram_id);
    } else {
      // Multiple mentees — show the mentee picker first; selecting one
      // will call startPrivateSession() → showScheduleModal(false, menteeId)
      openMenteeSelectModal();
    }
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}

// Detects whether the current browser/WebView can plausibly do screen
// sharing (getDisplayMedia). Even when it can't, we still show the button
// for the host — Jitsi itself will tell them if it fails — but we use this
// to decide whether to proactively suggest the "open in browser" fallback
// instead of a silent/broken attempt.
function supportsScreenShare() {
  return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
}

function launchJitsi(roomName, roomPassword, displayName, token, isModerator = false, sessionId = null, joinData = null) {
  navigate('video');
  const container = $('jitsiContainer');
  if (!container) return;
  container.innerHTML = '';

  window.activeSession = {
    sessionId,
    isModerator,
    joinData,
    connected: false,
  };

  toggleShareScreenButtonVisibility(isModerator);

  const initJitsi = () => {
    const options = {
      roomName,
      width: '100%',
      height: '100%',
      parentNode: container,
      userInfo: { displayName },
      // Explicitly grant the embedded iframe camera/mic/screen-share
      // permission delegation. Without this, some mobile WebViews (where
      // the host page never explicitly requests these permissions) never
      // pass them down to the Jitsi iframe, which is one of the ways
      // video/audio joining silently fails on mobile.
      iframeAttributes: {
        allow: 'camera; microphone; display-capture; autoplay; clipboard-write; fullscreen',
        allowFullScreen: true,
      },
      configOverwrite: {
        startWithAudioMuted: !isModerator,   // mentor joins unmuted by default
        startWithVideoMuted: !isModerator,   // mentor's video on by default
        enableClosePage: false,
        disableDeepLinking: true,
        // Disable Jitsi's "first joiner becomes moderator" behaviour.
        // On a self-hosted server with JWT this is enforced server-side;
        // on the public server we rely on the password so only the
        // mentor can start the room and naturally holds moderator status.
        requireDisplayName: false,
        enableUserRolesBasedOnToken: false,
        // Prevent participants from kicking / muting others
        disableRemoteMute: !isModerator,
        disableKick: !isModerator,
        // Let the host's screen-share attempt use the full desktop/tab
        // picker on platforms that support it (mainly helps on mobile
        // Chrome, which supports tab/whole-screen capture).
        desktopSharingFrameRate: { min: 5, max: 15 },
        ...(roomPassword ? { password: roomPassword } : {}),
      },
      interfaceConfigOverwrite: {
        TOOLBAR_BUTTONS: isModerator
          ? ['microphone', 'camera', 'desktop', 'chat', 'raisehand', 'fullscreen', 'tileview', 'hangup', 'mute-everyone', 'security']
          : ['microphone', 'camera', 'chat', 'raisehand', 'fullscreen', 'tileview', 'hangup'],
        SHOW_JITSI_WATERMARK: false,
        MOBILE_APP_PROMO: false,
      },
      ...(token ? { jwt: token } : {}),
    };

    if (window.jitsiApi) {
      try { window.jitsiApi.dispose(); } catch (e) { console.error(e); }
    }

    window.jitsiApi = new JitsiMeetExternalAPI('meet.opensuse.org', options);

    // ── Join watchdog ──────────────────────────────────────────────
    // If the call hasn't actually connected within 18s, don't leave the
    // user staring at a stuck/blank frame — this is what "sometimes video
    // or audio just fails" usually looks like from their side. Offer the
    // working external-browser fallback instead.
    const joinTimeout = setTimeout(() => {
      if (window.activeSession && !window.activeSession.connected) {
        haptic('error');
        const openExternally = joinData && confirm(
          "⚠️ The session is taking too long to connect — this browser may not support it well.\nOpen in your phone's browser instead? (Recommended)"
        );
        if (openExternally) {
          window.open(buildExternalSessionUrl(joinData), '_blank');
        } else {
          showToast('Still connecting… if audio/video doesn\u2019t start, try "Open in Browser".', 'info');
        }
      }
    }, 18000);

    window.jitsiApi.addEventListener('videoConferenceJoined', () => {
      if (window.activeSession) window.activeSession.connected = true;
      clearTimeout(joinTimeout);
      // If this user is the moderator, set the password so the room is
      // locked for anyone who doesn't already have it (extra guard on
      // public servers).
      if (isModerator && roomPassword) {
        window.jitsiApi.executeCommand('password', roomPassword);
      }
    });

    // Surfaces hard Jitsi-side failures (e.g. connection dropped, media
    // permission denied) with an actionable fallback instead of leaving
    // the call silently broken.
    window.jitsiApi.addEventListener('errorOccurred', (err) => {
      console.error('[Jitsi] errorOccurred:', err);
      haptic('error');
      const msg = err?.error?.message || err?.type || 'A connection problem occurred.';
      showToast(`Session issue: ${msg}. Try "Open in Browser" if this continues.`, 'error');
    });

    window.jitsiApi.addEventListener('videoConferenceLeft', async () => {
      clearTimeout(joinTimeout);
      if (isModerator && sessionId) {
        try {
          await apiFetch(`/api/sessions/${sessionId}/end`, { method: 'PATCH' });
        } catch (e) {
          console.error('Failed to end session:', e);
        }
      }
      window.activeSession = null;
      toggleShareScreenButtonVisibility(false);
      if (window.jitsiApi) {
        try { window.jitsiApi.dispose(); window.jitsiApi = null; } catch (e) { }
      }
      navigate('sessions');
    });
    window.jitsiApi.addEventListener('passwordRequired', () => {
      if (roomPassword) window.jitsiApi.executeCommand('password', roomPassword);
    });
  };

  if (window.JitsiMeetExternalAPI) {
    initJitsi();
  } else {
    const script = document.createElement('script');
    script.src = 'https://meet.jit.si/external_api.js';
    script.onload = initJitsi;
    script.onerror = () => {
      haptic('error');
      showToast('Could not load the video engine. Check your connection and try again.', 'error');
    };
    document.head.appendChild(script);
  }

  $('sessionPasswordDisplay').textContent = roomPassword ? `Password: ${roomPassword}` : '';
}

// ── Dedicated mobile-friendly "Share Screen" control ────────────────
// Jitsi's own screen-share ("desktop") toolbar button can end up buried
// under a "more options" overflow menu on small screens, making it hard
// for a host to find on a phone. This gives the host one obvious, always-
// visible button for it instead.
function toggleShareScreenButtonVisibility(show) {
  const btn = $('shareScreenBtn');
  if (!btn) return;
  btn.classList.toggle('hidden', !show);
}

function toggleScreenShare() {
  if (!window.jitsiApi) return;
  haptic('medium');
  if (!supportsScreenShare()) {
    const joinData = window.activeSession?.joinData;
    if (isIOSDevice()) {
      // Screen sharing over the web is an Apple platform limitation on
      // iOS below version 17 — no config or fallback link can work
      // around that, so be upfront about it instead of offering a link
      // that won't actually help.
      showToast('Screen sharing over the web needs iOS 17 or later on iPhone/iPad. Camera and mic still work fine.', 'info');
      return;
    }
    if (joinData && confirm(
      "⚠️ This browser may not support screen sharing here.\nOpen the session in your phone's browser to share your screen instead?"
    )) {
      window.open(buildExternalSessionUrl(joinData), '_blank');
      return;
    }
  }
  try {
    window.jitsiApi.executeCommand('toggleShareScreen');
  } catch (e) {
    console.error('Screen share failed:', e);
    const joinData = window.activeSession?.joinData;
    if (joinData && confirm('Could not start screen sharing here.\nOpen the session in your phone\u2019s browser instead?')) {
      window.open(buildExternalSessionUrl(joinData), '_blank');
    } else {
      showToast('Could not start screen sharing on this device.', 'error');
    }
  }
}

async function leaveCurrentSession() {
  haptic('medium');
  if (window.activeSession) {
    const { sessionId, isModerator } = window.activeSession;
    if (isModerator && sessionId) {
      if (confirm('End the session for all participants?')) {
        try {
          await apiFetch(`/api/sessions/${sessionId}/end`, { method: 'PATCH' });
        } catch (e) {
          console.error('Failed to end session:', e);
        }
      }
    }
  }
  if (window.jitsiApi) {
    try {
      window.jitsiApi.dispose();
      window.jitsiApi = null;
    } catch (e) {
      console.error(e);
    }
  }
  window.activeSession = null;
  navigate('sessions');
}

// ─── Chat ─────────────────────────────────────────────────────
window.chatState = {};
window.replyToId = null;

async function loadChat() {
  try {
    const targetId = window.pendingChatPartner;
    window.pendingChatPartner = null;

    const res = await apiFetch('/api/users/chat-partner');
    const partnerWrapper = $('chatPartnerWrapper');

    if (res.type === 'none') {
      $('chatMessages').innerHTML = `<div class="empty-state"><span>${t('no_active_mentorship')}</span></div>`;
      toggleChatInput(false);
      $('chatWith').style.display = 'block';
      $('chatWith').textContent = t('Messages');
      if (partnerWrapper) partnerWrapper.style.display = 'none';
      return;
    }

    if (res.type === 'single') {
      if (partnerWrapper) partnerWrapper.style.display = 'none';
      $('chatWith').style.display = 'block';
      $('chatWith').textContent = res.partner.display_name;
      setChatPeerHeader(res.partner.display_name, res.partner.last_active, res.partner.telegram_id, res.partner.photo_file_id, res.partner.photo_updated_at);
      window.chatState = { with: res.partner.telegram_id, name: res.partner.display_name || res.partner.anonymous_id };
      loadMessages(res.partner.telegram_id);
    } else {
      $('chatWith').style.display = 'none';
      if (partnerWrapper) partnerWrapper.style.display = 'block';

      const selectedId = targetId || res.mentees[0].telegram_id;
      const partner = res.mentees.find(m => String(m.telegram_id) === String(selectedId)) || res.mentees[0];

      // Update selected partner name in custom dropdown button
      const selectedNameEl = $('chatPartnerSelectedName');
      if (selectedNameEl) {
        selectedNameEl.textContent = partner.display_name;
      }

      // Render custom menu items
      const menu = $('chatPartnerDropdownMenu');
      if (menu) {
        menu.innerHTML = res.mentees.map(m => {
          const isSelected = String(m.telegram_id) === String(partner.telegram_id);
          const activeStyle = isSelected ? 'background: var(--surface); color: var(--gold);' : '';
          const isOnline = isUserOnline(m.last_active);
          const dotColor = isOnline ? 'var(--success)' : 'var(--text3)';
          const dotLabel = isOnline ? 'Online' : 'Offline';

          return `
            <button class="msg-menu-item" style="justify-content: space-between; align-items: center; ${activeStyle}" onclick="switchChatPartner('${m.telegram_id}'); closeChatPartnerDropdown()">
              <span style="font-weight: ${isSelected ? '700' : '500'};">${escapeHtml(m.display_name)}</span>
              <span style="width: 8px; height: 8px; border-radius: 50%; background: ${dotColor}; display: inline-block;" title="${dotLabel}"></span>
            </button>
          `;
        }).join('');
      }

      setChatPeerHeader(partner.display_name, partner.last_active, partner.telegram_id, partner.photo_file_id, partner.photo_updated_at);
      window.chatState = { with: partner.telegram_id, name: partner.display_name || partner.anonymous_id };
      loadMessages(partner.telegram_id);
    }

    toggleChatInput(true);

  } catch (e) {
    console.error('[Chat] Error:', e);
    $('chatMessages').innerHTML = `<div class="empty-state"><span>${e.message}</span></div>`;
    if (e.message.includes('No active mentorship')) {
      toggleChatInput(false);
    }
    $('chatWith').textContent = 'Error loading chat';
    const partnerWrapper = $('chatPartnerWrapper');
    if (partnerWrapper) partnerWrapper.style.display = 'none';
  }
}

function switchChatPartner(tid) {
  haptic('selection');
  cancelEditMessage();
  cancelReply();
  window.chatState.with = tid;
  toggleChatInput(true);
  loadMessages(tid);
  window.pendingChatPartner = tid;
  loadChat();
}

function openChat(partnerId) {
  window.pendingChatPartner = partnerId;
  navigate('chat');
}

async function loadMessages(with_id) {
  try {
    const messages = await apiFetch(`/api/messages/${with_id}`);
    const container = $('chatMessages');

    if (!window._chatMessagesMap) window._chatMessagesMap = new Map();
    function indexMessages(list) {
      if (!list || !list.length) return;
      for (const m of list) {
        window._chatMessagesMap.set(String(m.id), m);
        if (m.replies && m.replies.length) indexMessages(m.replies);
      }
    }
    indexMessages(messages);

    try {
      const messageTree = buildMessageTree(messages);
      container.innerHTML = renderThread(messageTree);
      hydratePhotoMessages(container);
    } catch (renderError) {
      console.error('[loadMessages] Render error:', renderError);
      // Fallback: show messages as a simple list without threading
      container.innerHTML = messages.map(m => `
        <div class="message-bubble ${m.from_id === currentUser?.telegram_id ? 'sent' : 'received'}">
          <div class="message-text">${escapeHtml(m.content)}</div>
          <div class="message-time">${formatTime(m.created_at)}</div>
        </div>
      `).join('');
    }

    container.scrollTop = container.scrollHeight;
    // The GET endpoint marks messages as read on the backend, so refresh the
    // badge immediately — no page reload required.
    updateMessageBadge();
  } catch (e) {
    console.error(e);
    throw e;
  }
}

// ─── Load messages with retry (new function, does not replace loadMessages) ──
async function loadMessagesWithRetry(with_id, retryCount = 0) {
  const container = document.getElementById('chatMessages');
  if (!container) return;

  try {
    // Call the existing loadMessages function
    await loadMessages(with_id);
    window._chatRetryCount = 0; // reset on success
  } catch (e) {
    console.error('[loadMessages] Error:', e);

    // If it's a 403 (no active mentorship), show a friendly message
    if (e.message.includes('403') || e.message.includes('No active mentorship')) {
      container.innerHTML = `
        <div class="empty-state">
          <span>${t('no_active_mentorship_with_user')}</span>
          <button class="btn btn-outline btn-sm mt-8" onclick="navigate('mentors')">${t('Find a Mentor')}</button>
        </div>
      `;
      return;
    }

    // Retry up to 3 times with exponential backoff
    if (retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
      container.innerHTML = `<div class="loading-spinner" style="margin:40px auto"></div><p style="text-align:center;color:var(--text3);">Retrying (${retryCount + 1}/3)...</p>`;
      setTimeout(() => loadMessagesWithRetry(with_id, retryCount + 1), delay);
      return;
    }

    // After retries, show error
    container.innerHTML = `
      <div class="empty-state">
        <span>Failed to load messages. Please try again.</span>
        <button class="btn btn-outline btn-sm mt-8" onclick="loadMessagesWithRetry('${with_id}')">Retry</button>
      </div>
    `;
  }
}

function refreshChat() {
  haptic('light');
  if (window.chatState?.with) {
    loadMessages(window.chatState.with);
  } else {
    loadChat();
  }
}





async function clearChatHistory() {
  if (!window.chatState?.with) return;
  if (!confirm('Clear all messages in this conversation? This cannot be undone.')) return;
  haptic('medium');
  try {
    await apiFetch(`/api/messages/${window.chatState.with}`, { method: 'DELETE' });
    haptic('success');
    showToast('Chat history cleared', 'success');
    loadMessages(window.chatState.with);
  } catch (e) { haptic('error'); showToast(e.message, 'error'); }
}

async function sendMessage() {
  haptic('light');
  const input = $('chatInput');
  const content = input.value.trim();
  if (!content || !window.chatState.with) return;

  // If in Edit Mode, update the existing message inline
  if (window.editingMessageId) {
    const editMsgId = window.editingMessageId;
    cancelEditMessage();
    try {
      await apiFetch(`/api/messages/${editMsgId}`, {
        method: 'PATCH',
        body: { content }
      });
      // Update local message cache
      if (window._chatMessagesMap && window._chatMessagesMap.has(String(editMsgId))) {
        const cached = window._chatMessagesMap.get(String(editMsgId));
        cached.content = content;
        cached.edited_at = new Date().toISOString();
      }
      // Optimistically update message bubble in DOM
      const threadEl = document.querySelector(`.message-thread[data-msg-id="${editMsgId}"]`);
      if (threadEl) {
        const captionEl = threadEl.querySelector('.message-caption');
        if (captionEl) {
          captionEl.textContent = content;
        } else {
          const textEl = threadEl.querySelector('.message-text');
          if (textEl) {
            textEl.innerHTML = escapeHtml(content) + '<span class="msg-edited">edited</span>';
          }
        }
      }
      haptic('light');
    } catch (e) {
      haptic('error');
      showToast(e.message, 'error');
      if (window.chatState?.with) loadMessages(window.chatState.with);
    }
    return;
  }

  const originalContent = content;
  input.value = '';
  autoResizeChatInput();
  $('emojiPicker')?.classList.add('hidden');
  const counter = $('charCounter');
  if (counter) { counter.textContent = '0 / 2000'; counter.classList.remove('danger'); }

  const sendBtn = document.querySelector('.chat-send-btn');
  if (sendBtn) sendBtn.disabled = true;
  if (sendBtn) sendBtn.classList.add('sending');

  // Generate temporary ID
  const tempId = 'temp_' + Date.now();

  // Create temporary message object
  const tempMsg = {
    id: tempId,
    from_id: currentUser?.telegram_id,
    to_id: window.chatState.with,
    content: originalContent,
    created_at: new Date().toISOString(),
    is_sending: true,
    is_deleted: false,
    parent_id: window.replyToId || null,
    replies: []
  };

  // Call addMessageToChat(tempMsg)
  addMessageToChat(tempMsg);

  // Disable the input field
  if (input) input.disabled = true;

  let attempts = 0;
  const maxAttempts = 3;
  let lastError = null;
  let msg = null;

  // Capture replyToId in case it changes before async operations finish
  const replyParentId = window.replyToId;

  while (attempts < maxAttempts) {
    try {
      msg = await apiFetch('/api/messages', {
        method: 'POST',
        body: {
          to_id: window.chatState.with,
          content: originalContent,
          parent_id: replyParentId || undefined
        }
      });
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      attempts++;
      if (attempts < maxAttempts) {
        const delay = attempts * 500;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // Re-enable input and button
  if (input) input.disabled = false;
  if (sendBtn) { sendBtn.disabled = false; sendBtn.classList.remove('sending'); }

  if (!lastError && msg) {
    // On success, replace the temp element with the real message
    const container = document.getElementById('chatMessages');
    if (container) {
      const existingReal = container.querySelector(`.message-thread[data-msg-id="${msg.id}"]`);
      const tempEl = container.querySelector(`.message-thread[data-msg-id="${tempId}"]`);
      if (existingReal) {
        tempEl?.remove();
      } else if (tempEl) {
        tempEl.outerHTML = renderThread([msg], false);
      }
    }
    // Clear reply state
    cancelReply();
  } else {
    // On failure, mark the temp message as failed (add a "Retry" button)
    haptic('error');
    showToast(t('msg_send_failed'), 'error');

    const container = document.getElementById('chatMessages');
    if (container) {
      const tempEl = container.querySelector(`.message-thread[data-msg-id="${tempId}"]`);
      if (tempEl) {
        const bubble = tempEl.querySelector('.message-bubble');
        if (bubble) {
          bubble.classList.remove('sending');
          bubble.classList.add('failed');
          // Add retry button if not already present
          if (!bubble.querySelector('.retry-btn')) {
            bubble.insertAdjacentHTML('beforeend', `
              <div class="failed-status" style="margin-top: 4px; display: flex; align-items: center; justify-content: flex-end; gap: 4px;">
                <span style="font-size: 0.75rem; color: var(--danger);">Failed</span>
                <button class="btn btn-danger btn-xs btn-outline retry-btn" onclick="retrySendMessage('${tempId}')" style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; border: 1px solid var(--danger);">Retry</button>
              </div>
            `);
          }
        }
      }
    }
  }
}

function retrySendMessage(tempId) {
  const container = document.getElementById('chatMessages');
  if (!container) return;

  const tempEl = container.querySelector(`.message-thread[data-msg-id="${tempId}"]`);
  if (!tempEl) return;

  const textEl = tempEl.querySelector('.message-text');
  if (!textEl) return;

  const content = textEl.textContent.trim();
  tempEl.remove();

  const input = document.getElementById('chatInput');
  if (input) {
    input.value = content;
    sendMessage();
  }
}

function cancelReply() {
  window.replyToId = null;
  document.getElementById('replyIndicator')?.classList.add('hidden');
  const replyText = document.getElementById('replyText');
  if (replyText) replyText.textContent = '';
  syncChatInputHeight();
}

function resetChatView() {
  if (!window.chatState?.with) return;
  cancelReply();
  loadMessages(window.chatState.with);
  showToast('Chat view reset', 'info');
  syncChatInputHeight();
}

function handleChatInputKeydown(event) {
  if (event.key === 'Escape' && window.editingMessageId) {
    event.preventDefault();
    cancelEditMessage();
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

// Premium SVG "join session" video icon — replaces the 📹 emoji, which
// renders inconsistently (or as a blank box) across devices. Reused by
// every "Join Session" button so its icon always looks identical.
const ICON_JOIN_SESSION_SVG = '<svg class="btn-icon-video" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';

function joinSessionBtnLabel() {
  return `${ICON_JOIN_SESSION_SVG}<span>${t('btn_join_session')}</span>`;
}

function autoResizeChatInput() {
  const input = $('chatInput');
  if (!input) return;
  input.style.height = 'auto';
  const targetH = Math.min(Math.max(input.scrollHeight, 38), 132);
  input.style.height = targetH + 'px';
  syncChatInputHeight();
}

function handleChatTyping() {
  if (socket && window.chatState.with) {
    socket.emit('typing', { to_id: window.chatState.with });
  }
  autoResizeChatInput();
  // Update live character counter
  const input = $('chatInput');
  const counter = $('charCounter');
  if (input && counter) {
    const len = input.value.length;
    const MAX = 2000;
    counter.textContent = `${len} / ${MAX}`;
    if (len > MAX) {
      counter.classList.add('danger');
    } else {
      counter.classList.remove('danger');
    }
  }
}

// ── Premium SVG emoji set ──────────────────────────────────────────
// Native emoji glyphs render inconsistently (or as blank "tofu" boxes)
// across older Android WebViews / Telegram's in-app browsers, which is
// exactly the kind of "sometimes just fails" inconsistency we want to
// eliminate from anything session/reaction related. These are custom,
// theme-matched SVG icons instead of relying on the OS's emoji font —
// they always look the same everywhere. The underlying value inserted
// into the message is still the plain unicode character, so sending,
// storing, searching and rendering messages elsewhere is unaffected.
const PREMIUM_EMOJI_ICONS = [
  { ch: '😊', svg: '<circle cx="12" cy="12" r="9" fill="url(#eg)"/><circle cx="8.5" cy="10.5" r="1.1" fill="#2a2114"/><circle cx="15.5" cy="10.5" r="1.1" fill="#2a2114"/><path d="M7.5 14c1 1.6 2.9 2.4 4.5 2.4s3.5-.8 4.5-2.4" fill="none" stroke="#2a2114" stroke-width="1.4" stroke-linecap="round"/>' },
  { ch: '😂', svg: '<circle cx="12" cy="12" r="9" fill="url(#eg)"/><path d="M7 9.5c.6-1 1.6-1.5 2.5-1.2M17 9.5c-.6-1-1.6-1.5-2.5-1.2" fill="none" stroke="#2a2114" stroke-width="1.3" stroke-linecap="round"/><path d="M7.5 13.5c1.2 2 3 3 4.5 3s3.3-1 4.5-3" fill="none" stroke="#2a2114" stroke-width="1.6" stroke-linecap="round"/><path d="M5.5 12c-.8 1-1 2.4-.6 3.4M18.5 12c.8 1 1 2.4.6 3.4" stroke="#8fd3ff" stroke-width="1.3" stroke-linecap="round"/>' },
  { ch: '🤣', svg: '<circle cx="12" cy="12" r="9" fill="url(#eg)" transform="rotate(-8 12 12)"/><path d="M6.5 9.8c.7-.9 1.7-1.2 2.4-.9M17.5 9.8c-.7-.9-1.7-1.2-2.4-.9" fill="none" stroke="#2a2114" stroke-width="1.3" stroke-linecap="round"/><path d="M7 13.5c1.3 2.2 3.1 3.2 5 3.2s3.7-1 5-3.2" fill="none" stroke="#2a2114" stroke-width="1.6" stroke-linecap="round"/><path d="M4.8 11.5c-.7 1.1-.8 2.6-.3 3.6M19.2 11.5c.7 1.1.8 2.6.3 3.6" stroke="#8fd3ff" stroke-width="1.3" stroke-linecap="round"/>' },
  { ch: '❤️', svg: '<path d="M12 19.2 4.9 12.4a4.6 4.6 0 0 1 0-6.6 4.9 4.9 0 0 1 7 0l.1.1.1-.1a4.9 4.9 0 0 1 7 0 4.6 4.6 0 0 1 0 6.6z" fill="#E05C5C"/>' },
  { ch: '👍', svg: '<path d="M9 21H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3m0 9V9m0 12 6.2-.1a2 2 0 0 0 1.9-1.4l2-6a1.5 1.5 0 0 0-1.4-2H14l.5-3.4A1.8 1.8 0 0 0 12.8 5c-.4 0-.7.2-.9.5L9 12" fill="none" stroke="var(--gold-light)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' },
  { ch: '🙏', svg: '<path d="M12 5v6m-4-4 4 4 4-4M8.5 12c-.5 3 .3 6 3.5 8 3.2-2 4-5 3.5-8" fill="none" stroke="var(--gold-light)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' },
  { ch: '🔥', svg: '<path d="M12 3c1 3-3 4-3 7.5A3.5 3.5 0 0 0 12 14a3.5 3.5 0 0 0 3-5.4c1.4 1 2 2.7 2 4.4a5 5 0 1 1-10 0C7 9.5 9.5 7.5 12 3z" fill="url(#fg)"/>' },
  { ch: '😍', svg: '<circle cx="12" cy="12" r="9" fill="url(#eg)"/><path d="M6.6 10.8a2 1.4 0 1 0 4 0 2 1.4 0 1 0-4 0Zm6.8 0a2 1.4 0 1 0 4 0 2 1.4 0 1 0-4 0Z" fill="#E05C5C"/><path d="M7.5 14c1 1.6 2.9 2.4 4.5 2.4s3.5-.8 4.5-2.4" fill="none" stroke="#2a2114" stroke-width="1.4" stroke-linecap="round"/>' },
  { ch: '😭', svg: '<circle cx="12" cy="12" r="9" fill="url(#eg)"/><path d="M8.5 10.8c0-1 .7-1.7 1.5-1.7s1.5.7 1.5 1.7M12.5 10.8c0-1 .7-1.7 1.5-1.7s1.5.7 1.5 1.7" fill="none" stroke="#2a2114" stroke-width="1.3"/><path d="M8 15.5c1.3-1.2 2.6-1.2 4-1.2s2.7 0 4 1.2" fill="none" stroke="#2a2114" stroke-width="1.4" stroke-linecap="round"/><path d="M7.8 12.5c-.6 1.6-.4 3 .3 4.3M16.2 12.5c.6 1.6.4 3-.3 4.3" stroke="#8fd3ff" stroke-width="1.4" stroke-linecap="round"/>' },
  { ch: '😘', svg: '<circle cx="12" cy="12" r="9" fill="url(#eg)"/><path d="M6.5 10.3c.6-.8 1.5-1 2.2-.7" fill="none" stroke="#2a2114" stroke-width="1.3" stroke-linecap="round"/><path d="M13.5 10.5c1.5-.6 3 .6 3 1.8-1 .4-2.3.2-3-1" fill="none" stroke="#2a2114" stroke-width="1.3" stroke-linecap="round"/><ellipse cx="8.6" cy="14.4" rx="1.3" ry="1" fill="#f4a3a3"/><path d="M7.5 14.5c1.4 1.6 3.2 2.1 4.5 2.1" fill="none" stroke="#2a2114" stroke-width="1.3" stroke-linecap="round"/>' },
  { ch: '😎', svg: '<circle cx="12" cy="12" r="9" fill="url(#eg)"/><rect x="5.8" y="9.6" width="5" height="3" rx="1" fill="#2a2114"/><rect x="13.2" y="9.6" width="5" height="3" rx="1" fill="#2a2114"/><path d="M10.8 11h2.4" stroke="#2a2114" stroke-width="1.2"/><path d="M8 15.4c1.2 1 2.6 1.4 4 1.4s2.8-.4 4-1.4" fill="none" stroke="#2a2114" stroke-width="1.4" stroke-linecap="round"/>' },
  { ch: '😢', svg: '<circle cx="12" cy="12" r="9" fill="url(#eg)"/><circle cx="8.5" cy="10.4" r="1" fill="#2a2114"/><circle cx="15.5" cy="10.4" r="1" fill="#2a2114"/><path d="M8.5 15.6c1-.8 2.2-1.1 3.5-1.1s2.5.3 3.5 1.1" fill="none" stroke="#2a2114" stroke-width="1.3" stroke-linecap="round"/><path d="M8.7 12.5c-.5 1.4-.3 2.7.3 3.9" stroke="#8fd3ff" stroke-width="1.3" stroke-linecap="round"/>' },
  { ch: '😡', svg: '<circle cx="12" cy="12" r="9" fill="url(#ag)"/><path d="M7 9.6 9.4 10.7M17 9.6 14.6 10.7" stroke="#3a1414" stroke-width="1.4" stroke-linecap="round"/><path d="M8.3 16c1.1-1.3 2.4-1.8 3.7-1.8s2.6.5 3.7 1.8" fill="none" stroke="#3a1414" stroke-width="1.4" stroke-linecap="round"/>' },
  { ch: '😱', svg: '<circle cx="12" cy="12" r="9" fill="url(#eg)"/><circle cx="8.6" cy="10.6" r="1.5" fill="#2a2114"/><circle cx="15.4" cy="10.6" r="1.5" fill="#2a2114"/><ellipse cx="12" cy="15.6" rx="2.2" ry="2.6" fill="#2a2114"/><path d="M6.2 8.4c.7-1 1.7-1.3 2.6-1M17.8 8.4c-.7-1-1.7-1.3-2.6-1" fill="none" stroke="#2a2114" stroke-width="1.2" stroke-linecap="round"/>' },
  { ch: '🤔', svg: '<circle cx="12" cy="12" r="9" fill="url(#eg)"/><circle cx="9" cy="10.8" r="1" fill="#2a2114"/><path d="M13.5 10.6c1-.8 2.6-.6 3 .6M9 15c1.3.9 3.6 1 5.2-.6" fill="none" stroke="#2a2114" stroke-width="1.3" stroke-linecap="round"/><path d="M13 7.6c.8-.9 2.3-.9 2.6.4.2 1-.7 1.3-1.2 2" fill="none" stroke="var(--gold-light)" stroke-width="1.1" stroke-linecap="round"/>' },
  { ch: '🙌', svg: '<path d="M7 10 5.6 6.4a1.1 1.1 0 1 1 2.1-.7L9 9M17 10l1.4-3.6a1.1 1.1 0 1 0-2.1-.7L15 9M7 10c0 3.5 2.2 6 5 6s5-2.5 5-6" fill="none" stroke="var(--gold-light)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' },
  { ch: '👏', svg: '<path d="M9 6.5 15 12l-2.4 2.4a2 2 0 0 1-2.8 0L6.4 11c-.7-.7-.7-1.9 0-2.6.8-.7 2-.7 2.7.1zM15 12l3.2 3.2c1.2 1.2 1.2 3.1 0 4.3-1.2 1.2-3.1 1.2-4.3 0L10.5 16" fill="none" stroke="var(--gold-light)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' },
  { ch: '🎉', svg: '<path d="M5 19 14 6l4 4L5 19Z" fill="url(#fg)"/><circle cx="17.5" cy="5" r="1" fill="var(--gold-light)"/><circle cx="20" cy="8.5" r="1" fill="var(--gold-light)"/><circle cx="6" cy="6" r=".9" fill="var(--gold-light)"/><path d="M10 4.5 10.7 6" stroke="var(--gold-light)" stroke-width="1.1" stroke-linecap="round"/>' },
  { ch: '🌟', svg: '<path d="M12 3.5 14 9l5.8.3-4.5 3.7 1.6 5.5L12 15.6l-4.9 2.9 1.6-5.5-4.5-3.7L10 9z" fill="url(#fg)"/>' },
  { ch: '💡', svg: '<path d="M9 15.5a5 5 0 1 1 6 0c-.6.5-1 1.2-1 2v.5H10v-.5c0-.8-.4-1.5-1-2Z" fill="url(#fg)"/><path d="M10 20.5h4" stroke="var(--gold-light)" stroke-width="1.4" stroke-linecap="round"/>' },
  { ch: '💯', svg: '<text x="12" y="15.5" font-size="8.5" font-weight="700" text-anchor="middle" fill="url(#fg)" font-family="Arial, sans-serif">100</text><path d="M4 18.5 20 5.5" stroke="var(--gold-light)" stroke-width="1.3" stroke-linecap="round"/>' },
  { ch: '🤝', svg: '<path d="M3 12h4l3-2 2 1.5M21 12h-4l-3-2-2 1.5M9.5 11.5l-2 2a1.3 1.3 0 0 0 1.8 1.8l1-1M12.5 12l-2.3 2.3a1.3 1.3 0 0 0 1.8 1.8l1-1" fill="none" stroke="var(--gold-light)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' },
  { ch: '🙄', svg: '<circle cx="12" cy="12" r="9" fill="url(#eg)"/><circle cx="8.7" cy="9" r="1.1" fill="#2a2114"/><circle cx="15.3" cy="9" r="1.1" fill="#2a2114"/><path d="M8 15c1.2-.9 2.6-1.2 4-1.2s2.8.3 4 1.2" fill="none" stroke="#2a2114" stroke-width="1.3" stroke-linecap="round"/>' },
  { ch: '💔', svg: '<path d="M12 19.2 4.9 12.4a4.6 4.6 0 0 1 0-6.6 4.9 4.9 0 0 1 7 0l.1.1.1-.1a4.9 4.9 0 0 1 7 0 4.6 4.6 0 0 1 0 6.6z" fill="none" stroke="#E05C5C" stroke-width="1.4"/><path d="M12 6.5 10 11l3 1.5-2 5" stroke="#E05C5C" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' },
];

// Shared gradient defs (gold "face" gradient, warm "flame" gradient, and
// an angry-red gradient) reused by every icon above via url(#id) refs.
const PREMIUM_EMOJI_DEFS = `<svg width="0" height="0" style="position:absolute">
  <defs>
    <linearGradient id="eg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--gold-light)"/><stop offset="1" stop-color="var(--gold)"/>
    </linearGradient>
    <linearGradient id="fg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--gold-light)"/><stop offset="1" stop-color="#E07B3A"/>
    </linearGradient>
    <linearGradient id="ag" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f0a4a4"/><stop offset="1" stop-color="var(--danger)"/>
    </linearGradient>
  </defs>
</svg>`;

function toggleEmojiPicker() {
  const picker = $('emojiPicker');
  if (!picker) return;

  if (picker.children.length === 0) {
    const defsHolder = document.getElementById('premiumEmojiDefs');
    if (!defsHolder) {
      const div = document.createElement('div');
      div.id = 'premiumEmojiDefs';
      div.innerHTML = PREMIUM_EMOJI_DEFS;
      document.body.appendChild(div);
    }
    picker.innerHTML = PREMIUM_EMOJI_ICONS.map(({ ch, svg }) =>
      `<button class="premium-emoji" onclick="insertEmoji('${ch}')" aria-label="${ch}" title="${ch}">
         <svg viewBox="0 0 24 24" width="22" height="22">${svg}</svg>
       </button>`
    ).join('');
  }

  picker.classList.toggle('hidden');
}

function insertEmoji(emoji) {
  const input = $('chatInput');
  if (!input) return;
  input.value += emoji;
  input.focus();
  handleChatTyping();
}

// Close emoji picker when clicking outside
document.addEventListener('click', (e) => {
  const picker = $('emojiPicker');
  const btn = document.querySelector('.emoji-btn');
  if (picker && !picker.classList.contains('hidden')) {
    if (!picker.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
      picker.classList.add('hidden');
    }
  }
});

async function updateMessageBadge() {
  try {
    const { count } = await apiFetch('/api/messages/unread/count');
    const badge = $('chatBadge');
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'flex' : 'none';
    }
  } catch { }
}
async function updateRequestsBadge() {
  if (currentUser?.role !== 'mentor') return;
  try {
    const requests = await apiFetch('/api/mentors/my-requests');
    const count = requests.length;
    const badge = $('requestsBadge');
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'flex' : 'none';
    }
  } catch (e) {
    console.error('Failed to load requests count:', e);
  }
}

async function updateSessionsBadge(directCount = null) {
  try {
    const badge = $('sessionsBadge');
    if (!badge) return;

    if (directCount !== null) {
      badge.textContent = directCount;
      badge.style.display = directCount > 0 ? 'flex' : 'none';
      return;
    }

    let count = 0;
    try {
      const mySessions = await apiFetch('/api/sessions/my');
      for (const s of mySessions) {
        const session = s.session;
        if (session) {
          const { isJoinable } = getSessionState(session.scheduled_at, session.status);
          if (isJoinable) count++;
        }
      }
    } catch (e) {
      console.error('Error loading private sessions for badge:', e);
    }

    try {
      const upcoming = await apiFetch('/api/sessions/upcoming');
      for (const s of upcoming) {
        const { isJoinable } = getSessionState(s.scheduled_at, s.status);
        if (isJoinable) count++;
      }
    } catch (e) {
      console.error('Error loading upcoming group sessions for badge:', e);
    }

    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  } catch (e) {
    console.error('Failed to update sessions badge:', e);
  }
}

// ─── Settings ─────────────────────────────────────────────────
async function loadSettings() {
  const nameInput = $('settingDisplayName');
  if (nameInput && !nameInput.dataset.errClearBound) {
    nameInput.dataset.errClearBound = '1';
    nameInput.addEventListener('input', () => clearFieldError('settingDisplayName'));
  }
  try {
    const s = await apiFetch('/api/users/settings');
    $('settingDisplayName').value = s.display_name || '';
    $('toggleMessages').classList.toggle('on', s.notify_messages !== false);
    $('toggleSessions').classList.toggle('on', s.notify_sessions !== false);
    $('toggleVerse').classList.toggle('on', s.notify_daily_verse !== false);
    $('toggleStreak').classList.toggle('on', s.notify_streak_reminder !== false);

    if (currentUser?.role === 'mentor') {
      $('mentorSettings').classList.remove('hidden');
      $('settingBio').value = s.bio || '';
      renderBioDisplay(s.bio || '');
      $('settingSpecialization').value = s.specialization || '';
      $('settingMaxMentees').value = s.max_mentees || 5;
      $('settingMenteeSex').value = s.preferred_mentee_sex || 'prefer_not';

      const acceptToggle = $('toggleAcceptingRequests');
      if (acceptToggle) {
        acceptToggle.classList.toggle('on', s.accepting_requests !== false);
      }
    }

    $('userAnonId').textContent = currentUser?.anonymous_id || '';
    $('userRole').textContent = currentUser?.role || '';
    loadProfilePhoto();
  } catch (e) { showToast(e.message, 'error'); }
}

function avatarInitials() {
  const name = currentUser?.user_settings?.display_name || currentUser?.anonymous_id || '?';
  const text = String(name || '?').trim();
  return text ? text.charAt(0).toUpperCase() : '?';
}

async function loadProfilePhoto() {
  const preview = $('settingsAvatarPreview');
  const removeBtn = $('removeAvatarBtn');
  if (!preview) return;

  preview.textContent = avatarInitials();
  preview.classList.remove('has-photo');
  removeBtn?.classList.add('hidden');

  if (!currentUser?.photo_file_id) return;

  preview.classList.add('avatar-loading');
  try {
    const url = await loadAvatarUrl(currentUser.telegram_id, currentUser.photo_updated_at || '');
    const img = document.createElement('img');
    img.alt = '';
    img.onerror = () => { preview.textContent = avatarInitials(); preview.classList.remove('has-photo'); removeBtn?.classList.add('hidden'); };
    img.src = url;
    preview.innerHTML = '';
    preview.appendChild(img);
    preview.classList.add('has-photo');
    removeBtn?.classList.remove('hidden');
  } catch (e) {
    console.error('Failed to load profile photo:', e);
  } finally {
    preview.classList.remove('avatar-loading');
  }
}

const cropState = { naturalW: 0, naturalH: 0, baseScale: 1, zoom: 100, offsetX: 0, offsetY: 0, stageSize: 320, dragging: false, startX: 0, startY: 0, startOffsetX: 0, startOffsetY: 0 };
const MIN_AVATAR_DIMENSION = 150;

function onAvatarFileSelected(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showToast('Please choose an image file', 'error');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('Image must be under 5MB', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onerror = () => showToast('Could not read that image', 'error');
  reader.onload = () => {
    const img = $('cropImage');
    img.onerror = () => showToast('Could not open that image', 'error');
    img.onload = () => {
      if (img.naturalWidth < MIN_AVATAR_DIMENSION || img.naturalHeight < MIN_AVATAR_DIMENSION) {
        showToast(`Please choose an image at least ${MIN_AVATAR_DIMENSION}×${MIN_AVATAR_DIMENSION}px`, 'error');
        return;
      }
      const stage = $('cropStage');
      cropState.stageSize = stage.clientWidth || 320;
      cropState.naturalW = img.naturalWidth;
      cropState.naturalH = img.naturalHeight;
      cropState.baseScale = Math.max(cropState.stageSize / img.naturalWidth, cropState.stageSize / img.naturalHeight);
      cropState.zoom = 100;
      cropState.offsetX = 0;
      cropState.offsetY = 0;
      $('cropZoom').value = 100;
      updateCropImagePosition();
      openCropModal();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function updateCropImagePosition() {
  const img = $('cropImage');
  const finalScale = cropState.baseScale * (cropState.zoom / 100);
  const drawnW = cropState.naturalW * finalScale;
  const drawnH = cropState.naturalH * finalScale;
  const maxOffsetX = Math.max(0, (drawnW - cropState.stageSize) / 2);
  const maxOffsetY = Math.max(0, (drawnH - cropState.stageSize) / 2);
  cropState.offsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, cropState.offsetX));
  cropState.offsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, cropState.offsetY));

  img.style.width = `${drawnW}px`;
  img.style.height = `${drawnH}px`;
  img.style.left = `${cropState.stageSize / 2 + cropState.offsetX - drawnW / 2}px`;
  img.style.top = `${cropState.stageSize / 2 + cropState.offsetY - drawnH / 2}px`;
}

function onCropZoom(value) {
  cropState.zoom = parseFloat(value);
  updateCropImagePosition();
}

function cropWheelZoom(e) {
  e.preventDefault();
  const next = Math.max(100, Math.min(300, cropState.zoom - e.deltaY * 0.2));
  cropState.zoom = next;
  $('cropZoom').value = next;
  updateCropImagePosition();
}

function cropPointerDown(e) {
  cropState.dragging = true;
  cropState.startX = e.clientX;
  cropState.startY = e.clientY;
  cropState.startOffsetX = cropState.offsetX;
  cropState.startOffsetY = cropState.offsetY;
  e.target.setPointerCapture?.(e.pointerId);
}

function cropPointerMove(e) {
  if (!cropState.dragging) return;
  cropState.offsetX = cropState.startOffsetX + (e.clientX - cropState.startX);
  cropState.offsetY = cropState.startOffsetY + (e.clientY - cropState.startY);
  updateCropImagePosition();
}

function cropPointerUp() {
  cropState.dragging = false;
}

function openCropModal() {
  const stage = $('cropStage');
  stage.addEventListener('pointerdown', cropPointerDown);
  stage.addEventListener('pointermove', cropPointerMove);
  stage.addEventListener('pointerup', cropPointerUp);
  stage.addEventListener('pointercancel', cropPointerUp);
  stage.addEventListener('wheel', cropWheelZoom, { passive: false });
  $('avatarCropModal').classList.add('open');
  requestAnimationFrame(() => {
    cropState.stageSize = stage.clientWidth || 320;
    updateCropImagePosition();
  });
}

function closeCropModal() {
  const stage = $('cropStage');
  stage.removeEventListener('pointerdown', cropPointerDown);
  stage.removeEventListener('pointermove', cropPointerMove);
  stage.removeEventListener('pointerup', cropPointerUp);
  stage.removeEventListener('pointercancel', cropPointerUp);
  stage.removeEventListener('wheel', cropWheelZoom);
  $('avatarCropModal').classList.remove('open');
  const img = $('cropImage');
  img.onerror = null;
  img.onload = null;
  img.src = '';
}

async function confirmAvatarCrop() {
  const btn = $('cropSaveBtn');
  btn.classList.add('loading');
  btn.disabled = true;
  try {
    const finalScale = cropState.baseScale * (cropState.zoom / 100);
    const drawnW = cropState.naturalW * finalScale;
    const drawnH = cropState.naturalH * finalScale;
    const left = cropState.stageSize / 2 + cropState.offsetX - drawnW / 2;
    const top = cropState.stageSize / 2 + cropState.offsetY - drawnH / 2;
    const sx = -left / finalScale;
    const sy = -top / finalScale;
    const sSize = cropState.stageSize / finalScale;

    const OUT = 480;
    const canvas = document.createElement('canvas');
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext('2d');
    ctx.drawImage($('cropImage'), sx, sy, sSize, sSize, 0, 0, OUT, OUT);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new Error('Could not process image');

    const { initData, user } = getTelegramData();
    const fd = new FormData();
    fd.append('avatar', blob, 'avatar.jpg');
    const res = await fetch(`${API}/api/avatar`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': initData, 'x-telegram-id': user?.id || '' },
      body: fd,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    currentUser.photo_file_id = data.photo_file_id;
    currentUser.photo_updated_at = data.photo_updated_at;

    haptic('success');
    showToast('Photo updated', 'success');
    closeCropModal();
    await loadProfilePhoto();
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

async function removeAvatar() {
  if (!confirm('Remove your profile photo?')) return;
  haptic('medium');
  try {
    await apiFetch('/api/avatar', { method: 'DELETE' });
    currentUser.photo_file_id = null;
    currentUser.photo_updated_at = null;
    haptic('success');
    showToast('Photo removed', 'success');
    await loadProfilePhoto();
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}

function renderBioDisplay(bio) {
  const textEl = $('bioDisplayText');
  if (!textEl) return;
  const trimmed = (bio || '').trim();
  if (trimmed) {
    textEl.textContent = trimmed;
    textEl.classList.remove('is-empty');
  } else {
    textEl.textContent = t('bio_empty_placeholder') !== 'bio_empty_placeholder'
      ? t('bio_empty_placeholder')
      : 'No bio yet — tap to share a bit about your journey.';
    textEl.classList.add('is-empty');
  }
}

function enterBioEditMode(event) {
  if (event) event.stopPropagation();
  haptic('selection');
  $('bioDisplayWrap').classList.add('hidden');
  $('bioEditWrap').classList.remove('hidden');
  const textarea = $('settingBio');
  textarea.focus();
  textarea.selectionStart = textarea.value.length;
}

function exitBioEditMode() {
  haptic('selection');
  renderBioDisplay($('settingBio').value);
  $('bioEditWrap').classList.add('hidden');
  $('bioDisplayWrap').classList.remove('hidden');
}

async function saveSettings() {
  haptic('medium');
  clearFieldError('settingDisplayName');
  const body = {
    display_name: $('settingDisplayName').value,
    notify_messages: $('toggleMessages').classList.contains('on'),
    notify_sessions: $('toggleSessions').classList.contains('on'),
    notify_daily_verse: $('toggleVerse').classList.contains('on'),
    notify_streak_reminder: $('toggleStreak').classList.contains('on'),
    bio: $('settingBio')?.value,
    specialization: $('settingSpecialization')?.value,
    max_mentees: parseInt($('settingMaxMentees')?.value) || 5,
  };
  if (currentUser?.role === 'mentor') {
    body.accepting_requests = $('toggleAcceptingRequests')?.classList.contains('on');
    body.preferred_mentee_sex = $('settingMenteeSex')?.value;
  }
  try {
    const updated = await apiFetch('/api/users/settings', { method: 'PATCH', body });
    if (currentUser) {
      currentUser.user_settings = { ...(currentUser.user_settings || {}), ...updated };
    }
    haptic('success');
    showToast(t('settings_saved') || 'Settings saved', 'success');
  } catch (e) {
    haptic('error');
    if (e.nickname_taken) {
      showInlineError('settingDisplayName', t('err_nickname_taken'));
    } else {
      showToast(e.message, 'error');
    }
  }
}

async function toggleAcceptingRequests() {
  haptic('light');
  const el = $('toggleAcceptingRequests');
  if (!el) return;
  const isCurrentlyOn = el.classList.contains('on');
  const nextValue = !isCurrentlyOn;
  el.classList.toggle('on', nextValue);

  try {
    await apiFetch('/api/users/settings', {
      method: 'PATCH',
      body: { accepting_requests: nextValue }
    });
    haptic('success');
    showToast('Request availability updated.', 'success');
  } catch (e) {
    haptic('error');
    el.classList.toggle('on', isCurrentlyOn); // revert on error
    showToast(e.message, 'error');
  }
}

function toggleNotif(id) {
  haptic('light');
  const el = $(id);
  el.classList.toggle('on');
}

// ─── Mentor Application ───────────────────────────────────────
function openApplyModal() {
  haptic('light');
  $('applySex').value = '';
  const selectedTextEl = $('applySexSelectedText');
  if (selectedTextEl) selectedTextEl.textContent = t('Select…') || 'Select…';
  $('applyEdu').value = '';
  $('applyAbout').value = '';
  $('applyModal').classList.add('open');
}

/* ── Mentor Application Dropdown helpers ────────────────────── */
function toggleApplySexDropdown(e) {
  e.preventDefault();
  e.stopPropagation();
  const menu = $('applySexDropdownMenu');
  if (!menu) return;
  const isOpen = menu.classList.contains('open');
  closeApplySexDropdown();
  if (!isOpen) {
    menu.classList.add('open');
    setTimeout(() => document.addEventListener('click', closeApplySexDropdown, { once: true }), 0);
  }
}

function closeApplySexDropdown() {
  $('applySexDropdownMenu')?.classList.remove('open');
}

function selectApplySex(val, text, e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  $('applySex').value = val;
  const btnText = $('applySexSelectedText');
  if (btnText) {
    const localText = t(val === 'prefer_not' ? 'sex_both' : val === 'M' ? 'sex_male' : 'sex_female');
    btnText.textContent = localText || text;
  }
  closeApplySexDropdown();
}
function closeApplyModal() {
  haptic('light');
  $('applyModal').classList.remove('open');
}
async function submitApplication() {
  haptic('medium');
  const sex = $('applySex').value;
  const edu = $('applyEdu').value.trim();
  const about = $('applyAbout').value.trim();

  if (!sex || !edu || !about) {
    haptic('error');
    showToast('Please answer all questions', 'error');
    return;
  }

  try {
    await apiFetch('/api/users/apply-mentor', {
      method: 'POST',
      body: {
        sex,
        educational_background: edu,
        about_me: about,
        answer_q1: sex,
        answer_q2: edu,
        answer_q3: about
      }
    });
    haptic('success');
    showToast('Application submitted! 🙏', 'success');
    closeApplyModal();
  } catch (e) { haptic('error'); showToast(e.message, 'error'); }
}

// ─── Support Tickets ──────────────────────────────────────────
window.activeTicketId = null;

async function loadUserTickets() {
  const container = $('userTicketsList');
  if (!container) return;
  container.innerHTML = '<div class="loading-spinner" style="margin:40px auto"></div>';

  try {
    const tickets = await apiFetch('/api/support');
    updateSupportBadge(tickets);

    if (!tickets || tickets.length === 0) {
      container.innerHTML = `
        <div class="empty-state card" style="text-align:center;padding:40px 20px;border-radius:18px;background:linear-gradient(135deg, rgba(var(--bg3-rgb),0.5), rgba(var(--bg2-rgb),0.7));border:1px dashed var(--border)">
          <div style="color:var(--gold-light);margin-bottom:10px">${ticketIcon('ticket', 42)}</div>
          <div class="font-bold text-base mb-4" style="color:var(--text)">${t('no_support_requests_found')}</div>
          <p class="text-xs text-dim mb-16" style="max-width:260px;margin-left:auto;margin-right:auto">${t('no_support_requests_desc')}</p>
          <button class="ticket-submit-btn" style="max-width:180px;margin:0 auto" onclick="toggleNewTicketModal(true)">
            <span>${t('new_request_btn')}</span>
          </button>
        </div>`;
      return;
    }

    container.innerHTML = tickets.map(t => {
      const status = t.status || 'open';
      const replyCount = t.reply_count || 0;
      const previewText = t.last_reply_preview ? escapeHtml(t.last_reply_preview) : escapeHtml(t.description);
      const lastSenderLabel = t.last_reply_sender === 'admin'
        ? `${ticketIcon('shield', 12)} Admin:`
        : (t.last_reply_sender === 'user' ? 'You:' : '');
      const categoryLabel = t.category
        ? `<span class="ticket-cat-label">${escapeHtml(t.category)}</span>`
        : '<span></span>';
      const resolvedStrip = t.resolved_by === 'user'
        ? `<div class="ticket-resolved-strip">${ticketIcon('check', 14)} <span>You marked this solved</span></div>`
        : '';

      return `
        <div class="ticket-card-premium status-${status}" onclick="openTicketDetail('${t.id}')">
          <div class="ticket-card-top">
            ${categoryLabel}
            <span class="status-pill status-pill-${status}">
              <span class="status-dot"></span>
              ${status.replace('_', ' ')}
            </span>
          </div>
          <h4 class="ticket-card-title">${escapeHtml(t.subject)}</h4>
          <p class="ticket-card-preview">
            <strong>${lastSenderLabel}</strong> ${previewText}
          </p>
          <div class="ticket-card-meta">
            <span class="ticket-meta-item">${ticketIcon('calendar', 12)} Submitted ${timeAgo(t.created_at)}</span>
            <span class="ticket-meta-replies">${ticketIcon('chat', 11)} ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>
          </div>
          ${resolvedStrip}
        </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = `<div class="card text-center text-sm" style="color:var(--danger)">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function updateSupportBadge(ticketsData) {
  const badge = $('supportBadge');
  if (!badge) return;

  if (Array.isArray(ticketsData)) {
    const activeCount = ticketsData.filter(t => t.status === 'open' || t.status === 'in_progress').length;
    if (activeCount > 0) {
      badge.textContent = activeCount;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  } else {
    apiFetch('/api/support').then(tickets => {
      const activeCount = (tickets || []).filter(t => t.status === 'open' || t.status === 'in_progress').length;
      if (activeCount > 0) {
        badge.textContent = activeCount;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }).catch(() => { });
  }
}

function openTicketDetail(ticketId) {
  window.activeTicketId = ticketId;
  navigate('ticket-detail');
  loadTicketDetail(ticketId);
}

async function loadTicketDetail(ticketId) {
  const threadContainer = $('ticketThreadList');
  if (!threadContainer) return;
  threadContainer.innerHTML = '<div class="loading-spinner" style="margin:20px auto"></div>';

  try {
    const data = await apiFetch(`/api/support/${ticketId}`);
    const ticket = data.ticket;
    const replies = data.replies || [];

    $('ticketDetailSubject').textContent = ticket.subject;
    $('ticketDetailDate').textContent = `Submitted: ${formatDateTime(ticket.created_at)}`;
    $('ticketDetailDesc').textContent = ticket.description;

    const status = ticket.status || 'open';
    const statusEl = $('ticketDetailStatus');
    statusEl.className = `status-pill status-pill-${status}`;
    statusEl.innerHTML = `<span class="status-dot"></span>${status.replace('_', ' ')}`;

    window.activeTicketStatus = status;

    // Handle closed state input locking
    const replyTextarea = $('userTicketReplyText');
    const replyBtn = $('sendTicketReplyBtn');

    if (ticket.status === 'closed') {
      replyTextarea.disabled = true;
      replyTextarea.placeholder = 'This support request has been marked as closed.';
      replyBtn.disabled = true;
      replyBtn.style.opacity = '0.5';
    } else {
      replyTextarea.disabled = false;
      replyTextarea.placeholder = 'Write a follow-up message...';
      replyBtn.disabled = false;
      replyBtn.style.opacity = '1';
    }

    renderTicketResolveBar(status, ticket.resolved_by);

    // Render original ticket message + reply thread
    let html = `
      <div class="ticket-bubble ticket-bubble-user" style="align-self:flex-start;width:100%;max-width:100%;margin-bottom:12px;background:linear-gradient(135deg, rgba(201,168,76,0.12) 0%, rgba(var(--bg2-rgb),0.85) 100%);border:1px solid rgba(201,168,76,0.25)">
        <div class="ticket-bubble-hdr">
          <span style="display:flex;align-items:center;gap:5px;color:var(--gold-light)">${ticketIcon('user', 13)} <strong>You</strong> (Original Issue)</span>
          <span style="font-weight:normal;color:var(--text3);font-size:0.7rem">${formatDateTime(ticket.created_at)}</span>
        </div>
        <div class="ticket-bubble-body">${escapeHtml(ticket.description)}</div>
      </div>`;

    if (replies.length === 0 && ticket.admin_reply) {
      html += `
        <div class="ticket-bubble ticket-bubble-admin" style="align-self:flex-start;width:100%;max-width:100%;margin-bottom:12px">
          <div class="ticket-bubble-hdr">
            <span style="display:flex;align-items:center;gap:5px;color:#7AA5FF">${ticketIcon('shield', 13)} <strong>Support Admin</strong></span>
            <span style="font-weight:normal;color:var(--text3);font-size:0.7rem">${formatDateTime(ticket.updated_at || ticket.created_at)}</span>
          </div>
          <div class="ticket-bubble-body">${escapeHtml(ticket.admin_reply)}</div>
        </div>`;
    }

    replies.forEach(r => {
      const isAdmin = r.sender_type === 'admin';
      const bubbleClass = isAdmin ? 'ticket-bubble-admin' : 'ticket-bubble-user';
      const titleText = isAdmin
        ? `${ticketIcon('shield', 13)} Support Admin`
        : `${ticketIcon('user', 13)} You`;

      html += `
        <div class="ticket-bubble ${bubbleClass}" style="margin-bottom:8px">
          <div class="ticket-bubble-hdr">
            <span style="display:flex;align-items:center;gap:5px">${titleText}</span>
            <span style="font-weight:normal;color:var(--text3);font-size:0.7rem">${formatDateTime(r.created_at)}</span>
          </div>
          <div class="ticket-bubble-body">${escapeHtml(r.content)}</div>
        </div>`;
    });

    threadContainer.innerHTML = html;
    threadContainer.scrollTop = threadContainer.scrollHeight;
  } catch (e) {
    threadContainer.innerHTML = `<div class="card text-center text-sm" style="color:var(--danger)">Error: ${escapeHtml(e.message)}</div>`;
  }
}

// Shows "Mark as solved" for an open/in-progress ticket, or a confirmation +
// reopen option once it's resolved. Hidden entirely once an admin closes it.
function renderTicketResolveBar(status, resolvedBy) {
  const bar = $('ticketResolveBar');
  if (!bar) return;

  if (status === 'closed') {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';

  if (status === 'resolved') {
    const byUser = resolvedBy === 'user';
    bar.innerHTML = `
      <span class="ticket-resolve-note">${ticketIcon('check', 15)} ${byUser ? 'You marked this solved' : 'Support marked this resolved'}</span>
      <button class="btn btn-ghost btn-sm ticket-reopen-btn" onclick="toggleTicketResolved(false)">${ticketIcon('reopen', 13)} Still need help?</button>`;
  } else {
    bar.innerHTML = `
      <span class="ticket-resolve-note">${ticketIcon('clock', 15)} Still open</span>
      <button class="btn btn-sm ticket-resolve-btn" onclick="toggleTicketResolved(true)">${ticketIcon('check', 13)} Mark as solved</button>`;
  }
}

let ticketTypingLastSent = 0;
function onTicketReplyTyping() {
  if (!window.activeTicketId || !socket?.connected) return;
  const now = Date.now();
  if (now - ticketTypingLastSent < 2500) return;
  ticketTypingLastSent = now;
  socket.emit('ticket_typing', { ticket_id: window.activeTicketId, sender_type: 'user' });
}

function hideTicketTyping() {
  const el = $('ticketTypingIndicator');
  if (el) el.style.display = 'none';
}

async function toggleTicketResolved(resolved) {
  if (!window.activeTicketId) return;
  haptic(resolved ? 'success' : 'medium');
  try {
    await apiFetch(`/api/support/${window.activeTicketId}/resolve`, {
      method: 'PATCH',
      body: { resolved }
    });
    showToast(resolved ? 'Marked as solved — thank you!' : 'Reopened. We\u2019ll take another look.', 'success');
    loadTicketDetail(window.activeTicketId);
    updateSupportBadge();
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}

async function submitTicketReply() {
  if (!window.activeTicketId) return;
  const replyInput = $('userTicketReplyText');
  const content = replyInput.value.trim();
  if (!content) {
    haptic('error');
    showToast('Please type a reply message', 'error');
    return;
  }

  haptic('medium');
  try {
    await apiFetch(`/api/support/${window.activeTicketId}/reply`, {
      method: 'POST',
      body: { content }
    });
    haptic('success');
    showToast('Reply sent', 'success');
    replyInput.value = '';
    updateSupportBadge();
    loadTicketDetail(window.activeTicketId);
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}

function toggleNewTicketModal(show) {
  haptic('selection');
  const modal = $('newTicketModal');
  if (!modal) return;
  modal.style.display = '';
  modal.classList.toggle('open', show);
}

async function submitModalTicket() {
  haptic('medium');
  const subject = $('modalTicketSubject').value.trim();
  const description = $('modalTicketDesc').value.trim();
  const category = $('modalTicketCategory')?.value || '';
  if (!subject || !description) {
    haptic('error');
    showToast('Fill in all fields', 'error');
    return;
  }

  try {
    await apiFetch('/api/support', { method: 'POST', body: { subject, description, category } });
    haptic('success');
    showToast('Support request submitted', 'success');
    $('modalTicketSubject').value = '';
    $('modalTicketDesc').value = '';
    if ($('modalTicketCategory')) $('modalTicketCategory').value = '';
    toggleNewTicketModal(false);
    if (currentPage === 'support') {
      loadUserTickets();
    } else {
      navigate('support');
    }
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}

// ─── Localization ─────────────────────────────────────────────
let currentLanguage = localStorage.getItem('language') || 'en';

function t(key, replacements = {}) {
  const dict = I18N[currentLanguage] || I18N.en;
  let str = dict[key] || key;
  for (const [k, v] of Object.entries(replacements)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return str;
}

function applyLanguage() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const translated = t(key);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = translated;
    } else {
      el.textContent = translated;
    }
  });
  const langSelect = $('settingLanguage');
  if (langSelect) langSelect.value = currentLanguage;

  document.querySelectorAll('.lang-toggle-btn').forEach(btn => {
    btn.textContent = currentLanguage.toUpperCase();
  });

  const toggleBtn = $('journalViewToggle');
  if (toggleBtn) {
    if (journalView === 'list') {
      toggleBtn.innerHTML = '📅 ' + t('Calendar');
    } else {
      toggleBtn.innerHTML = '📋 ' + t('List');
    }
  }
}

function changeLanguage(lang) {
  haptic('selection');
  currentLanguage = lang;
  localStorage.setItem('language', lang);
  applyLanguage();
  loadDashboard();
}

function toggleLanguage() {
  haptic('selection');
  const next = currentLanguage === 'en' ? 'am' : 'en';
  currentLanguage = next;
  localStorage.setItem('language', next);
  applyLanguage();
  loadDashboard();
}

// Kept for backward compatibility with any existing inline onclick handlers.
function toggleOnboardingLanguage() {
  toggleLanguage();
}

// ─── Mentor Management ────────────────────────────────────────
// Mentees inactive for at least this long are flagged as "needs follow-up".
const MENTEE_INACTIVITY_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// Persist the last chosen sort mode for the session ('recent' | 'followup').
let menteeSortMode = 'recent';
let _myMenteesCache = [];
let _myMenteesFollowupCache = {};
let _myMenteesStreakCache = {};

/** Builds the small "● Online now / Active 2h ago" status line + optional follow-up chip for a mentee. */
function renderMenteeStatusLine(user) {
  const lastActive = user.last_active;
  const online = isUserOnline(lastActive);
  const staleMs = lastActive ? Date.now() - new Date(lastActive).getTime() : Infinity;
  const needsFollowup = !online && staleMs >= MENTEE_INACTIVITY_THRESHOLD_MS;

  let dotClass = 'offline';
  let label;
  if (online) {
    dotClass = 'online';
    label = t('mentee_status_online');
  } else if (needsFollowup) {
    dotClass = 'stale';
    label = lastActive ? t('mentee_status_active_ago', { time: timeAgo(lastActive) }) : t('mentee_status_never_active');
  } else {
    label = lastActive ? t('mentee_status_active_ago', { time: timeAgo(lastActive) }) : t('mentee_status_never_active');
  }

  const chip = needsFollowup
    ? `<span class="chip chip-red" style="margin-left:6px">${t('mentee_needs_followup')}</span>`
    : '';

  return `<div class="mentee-status-line"><span class="mentee-status-dot ${dotClass}"></span>${escapeHtml(label)}${chip}</div>`;
}

// Small flame glyph, same gradient language as the mentee's own Bible Streak
// card, sized down for use as an inline badge on the My Mentees list.
const MENTEE_STREAK_FLAME = `<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
  <path fill="currentColor" d="M12.5 2c.6 2.4-.4 3.9-1.8 5.4C9 9.2 7 11 7 14a5 5 0 0 0 10 0c0-1.7-.7-2.7-1.4-3.7-.3 1.6-1.1 2.4-1.9 2.9.4-2.1-.3-3.6-1.6-5-1-1.1-1.3-2.3.4-4-.7 1.6.1 2.4 1 3.2C15 8.8 16 10.4 16 12.6a4.7 4.7 0 0 1-.4 1.9c1-1 1.4-2.3 1.4-3.8 0-3-2-4.6-3.4-6.4C13 3.5 12.8 2.8 12.5 2z"/>
</svg>`;

/** Builds a compact "🔥 5 day streak · best 12" badge for a mentee, or a muted no-streak state. */
function renderMenteeStreakBadge(menteeId) {
  const s = _myMenteesStreakCache[menteeId] || { current_streak: 0, longest_streak: 0 };
  const active = s.current_streak > 0;
  const best = s.longest_streak > s.current_streak
    ? `<span class="mentee-streak-best">${t('mentee_streak_best', { count: s.longest_streak })}</span>`
    : '';
  return `<div class="mentee-streak-badge ${active ? 'is-active' : 'is-idle'}">
    <span class="mentee-streak-flame">${MENTEE_STREAK_FLAME}</span>
    <span class="mentee-streak-count">${active ? t('mentee_streak_count', { count: s.current_streak }) : t('mentee_streak_none')}</span>
    ${best}
  </div>`;
}

function menteeIsStale(user) {
  const lastActive = user.last_active;
  if (isUserOnline(lastActive)) return false;
  const staleMs = lastActive ? Date.now() - new Date(lastActive).getTime() : Infinity;
  return staleMs >= MENTEE_INACTIVITY_THRESHOLD_MS;
}

function setMenteeSort(mode) {
  menteeSortMode = mode;
  $('menteeSortRecentBtn')?.classList.toggle('sort-active', mode === 'recent');
  $('menteeSortFollowupBtn')?.classList.toggle('sort-active', mode === 'followup');
  renderMenteesList();
}

function sortedMentees() {
  const list = _myMenteesCache.slice();
  if (menteeSortMode === 'followup') {
    // Most-inactive first (never-active mentees sort to the very top).
    list.sort((a, b) => {
      const aTime = a.user.last_active ? new Date(a.user.last_active).getTime() : -Infinity;
      const bTime = b.user.last_active ? new Date(b.user.last_active).getTime() : -Infinity;
      return aTime - bTime;
    });
  } else {
    // Most recently active first.
    list.sort((a, b) => {
      const aTime = a.user.last_active ? new Date(a.user.last_active).getTime() : -Infinity;
      const bTime = b.user.last_active ? new Date(b.user.last_active).getTime() : -Infinity;
      return bTime - aTime;
    });
  }
  return list;
}

async function loadMyMentees() {
  const container = $('menteesList');
  container.innerHTML = window.skeletonHTML ? skeletonHTML(3) : '<div class="loading-spinner" style="margin:40px auto"></div>';
  try {
    const [mentees, followup, streaks] = await Promise.all([
      apiFetch('/api/mentors/my-mentees'),
      apiFetch('/api/mentors/my-mentees/followup').catch(() => ({})),
      apiFetch('/api/mentors/my-mentees/streaks').catch(() => ({})),
    ]);

    _myMenteesCache = mentees || [];
    _myMenteesFollowupCache = followup || {};
    _myMenteesStreakCache = streaks || {};

    $('activeMenteeCount').textContent = _myMenteesCache.length;
    const followupCount = _myMenteesCache.filter(m => menteeIsStale(m.user)).length;
    const summaryEl = $('menteeFollowupSummary');
    if (summaryEl) {
      summaryEl.style.display = followupCount > 0 ? 'flex' : 'none';
      $('menteeFollowupCount').textContent = followupCount;
    }
    $('menteeSortRecentBtn')?.classList.toggle('sort-active', menteeSortMode === 'recent');
    $('menteeSortFollowupBtn')?.classList.toggle('sort-active', menteeSortMode === 'followup');

    if (!_myMenteesCache.length) {
      container.innerHTML = `<div class="empty-state"><span>${t('no_active_mentees_yet')}</span></div>`;
      return;
    }

    renderMenteesList();

    for (const m of _myMenteesCache) {
      const note = await apiFetch(`/api/mentors/notes/${m.user.telegram_id}`);
      if (note.content) { const el = $(`note-${m.user.telegram_id}`); if (el) el.value = note.content; }
    }
  } catch (e) { showToast(e.message, 'error'); }
}

function renderMenteesList() {
  const container = $('menteesList');
  const mentees = sortedMentees();

  // The list below is a full innerHTML rebuild, which detaches any
  // existing goal-panel DOM — destroy their tickers first so we don't
  // leak rAF loops pointed at nodes that no longer exist. Panels stay
  // closed after a rebuild (matches prior behavior); re-opening will
  // recreate a fresh ticker via toggleMenteeGoals -> refreshMenteeGoals.
  Object.keys(_mentorGoalTickers).forEach(id => { _mentorGoalTickers[id]?.destroy(); delete _mentorGoalTickers[id]; });
  Object.keys(_mentorGoalPanelOpen).forEach(id => { _mentorGoalPanelOpen[id] = false; });

  let html = '';
  for (const m of mentees) {
    const { user, assigned_at, id: assignId } = m;
    const displayName = user.user_settings?.display_name || user.anonymous_id;
    const letter = (displayName || '?').charAt(0).toUpperCase();
    const fu = _myMenteesFollowupCache[user.telegram_id] || { open_goals: 0, total_goals: 0 };
    const goalsLabel = fu.total_goals > 0
      ? t('mentee_goals_progress', { done: fu.total_goals - fu.open_goals, total: fu.total_goals })
      : t('mentee_goals_add');

    html += `
      <div class="card mb-12">
        <div class="flex justify-between items-start mb-8">
          <div class="flex items-center gap-8">
            ${renderAvatar(user, letter)}
            <div>
              <div class="font-bold" style="color:var(--gold)">${escapeHtml(displayName)}</div>
              <div class="text-xs text-dim">${t('Joined')} ${new Date(assigned_at).toLocaleDateString()}</div>
              ${renderMenteeStatusLine(user)}
              ${renderMenteeStreakBadge(user.telegram_id)}
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="endMentorship('${assignId}')">${t('btn_end')}</button>
        </div>
        <div class="flex gap-8 mb-8" style="flex-wrap:wrap">
          <button class="btn btn-outline btn-sm flex-1" onclick="openChat('${user.telegram_id}')">${t('btn_message')}</button>
          <!-- Transfer button: opens the Transfer Mentee modal -->
          <button class="btn btn-outline btn-sm" style="flex:0 0 auto;" onclick="openTransferModal('${assignId}', '${user.telegram_id}', '${escapeHtml(displayName)}')">${t('btn_transfer')}</button>
        </div>
        <button class="goal-toggle-btn" onclick="toggleMenteeGoals('${user.telegram_id}', this)">
          <span style="display:flex;align-items:center;gap:6px;">${menteeIcon('target', 14)}${goalsLabel}</span>
          <span class="goal-toggle-caret">${menteeIcon('chevronDown', 14)}</span>
        </button>
        <div id="goalPanel-${user.telegram_id}" class="goal-panel" style="display:none" data-mentee-id="${user.telegram_id}"></div>
        <div class="form-group mb-0" style="margin-top:8px">
          <textarea id="note-${user.telegram_id}" class="form-control text-sm" data-i18n="Private note about this mentee..." placeholder="${t('Private note about this mentee...')}" rows="2" onblur="saveMentorNote('${user.telegram_id}')"></textarea>
        </div>
      </div>`;
  }
  container.innerHTML = html;
  hydrateAvatars(container);
}

// ─── Follow-up goals checklist (mentor's "My Mentees" panel) ───
// Tracks which mentee goal panels are currently expanded, so live socket
// events know whether to patch the DOM or just update the badge counts,
// and so a socket reconnect knows which open panels to reconcile.
const _mentorGoalPanelOpen = {};
// Local cache of each open panel's goals, keyed by mentee id — lets the
// live socket handlers do idempotent inserts/updates/removals instead of
// re-fetching and flashing a loading spinner on every change.
const _mentorGoalsCache = {};
// One GoalTicker per open mentee panel, keyed by mentee id.
const _mentorGoalTickers = {};

// Starts/stops/re-targets the auto-scroll ticker for a mentee's goal panel
// based on current state: only runs while that panel is open AND has more
// than one goal (per spec — a single item has nothing to scroll to anyway).
function syncMentorGoalTicker(menteeId) {
  const panel = $(`goalPanel-${menteeId}`);
  const itemsWrap = panel?.querySelector('.goal-panel-items');
  const isOpen = !!(panel && panel.style.display !== 'none' && _mentorGoalPanelOpen[menteeId]);
  const count = _mentorGoalsCache[menteeId]?.length || 0;

  if (!isOpen || !itemsWrap || count < 2) {
    _mentorGoalTickers[menteeId]?.stop();
    return;
  }
  if (!_mentorGoalTickers[menteeId] || _mentorGoalTickers[menteeId].content !== itemsWrap) {
    _mentorGoalTickers[menteeId]?.destroy();
    _mentorGoalTickers[menteeId] = new GoalTicker(itemsWrap);
  }
  _mentorGoalTickers[menteeId].refresh();
  _mentorGoalTickers[menteeId].start();
}

function renderMentorGoalItem(g, menteeId) {
  const missed = !g.is_done && g.is_missed;
  const due = g.due_date
    ? `<div class="goal-item-due">${t('mentee_goal_due')} ${new Date(g.due_date).toLocaleDateString()}${missed ? ` <span class="goal-missed-badge">${t('mentee_goal_missed')}</span>` : ''}</div>`
    : '';
  return `
    <div class="goal-item ${g.is_done ? 'done' : ''} ${missed ? 'missed' : ''}" data-goal-id="${g.id}">
      <label class="premium-checkbox">
        <input type="checkbox" ${g.is_done ? 'checked' : ''} onchange="toggleMenteeGoalDone('${g.id}', '${menteeId}', this.checked)">
        <span class="premium-checkbox-box">
          <svg class="premium-checkbox-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
        </span>
      </label>
      <div class="goal-item-title">${escapeHtml(g.title)}${due}</div>
      <button class="goal-item-edit" onclick="openEditGoalModal('${g.id}', '${menteeId}')" title="${t('mentee_goal_edit')}">${menteeIcon('pencil', 13)}</button>
      <button class="goal-item-delete" onclick="deleteMenteeGoal('${g.id}', '${menteeId}')" title="${t('mentee_goal_delete')}">${menteeIcon('trash', 13)}</button>
    </div>`;
}

function updateMenteeGoalsBadge(menteeId) {
  const goals = _mentorGoalsCache[menteeId] || [];
  const total = goals.length;
  const open = goals.filter(g => !g.is_done).length;
  _myMenteesFollowupCache[menteeId] = { ..._myMenteesFollowupCache[menteeId], open_goals: open, total_goals: total };
  const panel = $(`goalPanel-${menteeId}`);
  const toggleBtn = panel?.previousElementSibling;
  if (toggleBtn?.classList.contains('goal-toggle-btn')) {
    const label = total > 0 ? t('mentee_goals_progress', { done: total - open, total }) : t('mentee_goals_add');
    toggleBtn.querySelector('span').innerHTML = `${menteeIcon('target', 14)}${escapeHtml(label)}`;
  }
}

async function toggleMenteeGoals(menteeId, btnEl) {
  const panel = $(`goalPanel-${menteeId}`);
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  if (isOpen) {
    panel.style.display = 'none';
    _mentorGoalPanelOpen[menteeId] = false;
    _mentorGoalTickers[menteeId]?.stop();
    if (btnEl) btnEl.querySelector('.goal-toggle-caret').innerHTML = menteeIcon('chevronDown', 14);
    return;
  }
  panel.style.display = 'block';
  _mentorGoalPanelOpen[menteeId] = true;
  if (btnEl) btnEl.querySelector('.goal-toggle-caret').innerHTML = menteeIcon('chevronUp', 14);
  await refreshMenteeGoals(menteeId);
}

// Full fetch + render — used only for the initial panel open (and to
// reconcile after a socket reconnect). Live changes afterwards go through
// applyMentorGoalRealtime() below so the panel never flashes a spinner
// mid-conversation.
async function refreshMenteeGoals(menteeId) {
  const panel = $(`goalPanel-${menteeId}`);
  if (!panel) return;
  panel.innerHTML = '<div class="loading-spinner" style="margin:12px auto;width:20px;height:20px"></div>';
  try {
    const goals = await apiFetch(`/api/mentors/goals/${menteeId}`);
    _mentorGoalsCache[menteeId] = goals || [];

    const itemsHtml = goals.length
      ? goals.map(g => renderMentorGoalItem(g, menteeId)).join('')
      : `<div class="text-xs text-dim goal-panel-empty" style="padding:4px 0">${t('mentee_goals_empty')}</div>`;

    panel.innerHTML = `
      <div class="goal-panel-viewport">
        <div class="goal-panel-items">${itemsHtml}</div>
      </div>
      <div class="goal-add-row">
        <textarea id="goalInput-${menteeId}" class="form-control text-sm goal-add-input" placeholder="${t('mentee_goal_placeholder')}" maxlength="200" rows="2"></textarea>
        <div class="goal-add-row-bottom">
          <div class="goal-date-field">
            <input type="date" id="goalDate-${menteeId}" class="form-control text-sm goal-add-date" oninput="this.classList.toggle('has-value', !!this.value)">
            <span class="goal-date-placeholder">${menteeIcon('calendar', 13)}<span>${t('mentee_goal_due_date_placeholder')}</span></span>
          </div>
          <button class="btn btn-outline btn-sm goal-add-btn" onclick="addMenteeGoal('${menteeId}')">${menteeIcon('plus', 13)}${t('mentee_goal_add_btn')}</button>
        </div>
      </div>`;

    // Staggered reveal on first open, same spirit as the mentee widget.
    const items = [...panel.querySelectorAll('.goal-panel-items > .goal-item')];
    items.forEach((el, i) => {
      el.classList.add('goal-enter');
      el.style.animationDelay = `${Math.min(i, 8) * 45}ms`;
      el.addEventListener('animationend', () => { el.classList.remove('goal-enter'); el.style.animationDelay = ''; }, { once: true });
    });

    updateMenteeGoalsBadge(menteeId);
    syncMentorGoalTicker(menteeId);
  } catch (e) {
    panel.innerHTML = `<div class="text-xs" style="color:var(--danger)">${escapeHtml(e.message)}</div>`;
  }
}

// Applies a goal_created/goal_updated/goal_deleted socket payload (or a
// just-confirmed HTTP response, from this mentor's own action) to an open
// goal panel with the matching enter/pulse/exit animation. Idempotent —
// safe to call twice for the same change (e.g. once from the HTTP response,
// once again from the echoed socket event).
function applyMentorGoalRealtime(type, payload, menteeId) {
  if (!menteeId) return;
  const cache = _mentorGoalsCache[menteeId];
  const panel = $(`goalPanel-${menteeId}`);
  const isOpen = !!(panel && panel.style.display !== 'none' && _mentorGoalPanelOpen[menteeId]);
  const itemsWrap = panel?.querySelector('.goal-panel-items');

  if (type === 'added') {
    if (cache) {
      if (cache.some(g => String(g.id) === String(payload.id))) return; // already applied
      cache.unshift(payload);
    }
    if (isOpen && itemsWrap) {
      if (itemsWrap.querySelector(`[data-goal-id="${payload.id}"]`)) return;
      itemsWrap.querySelector('.goal-panel-empty')?.remove();
      itemsWrap.insertAdjacentHTML('afterbegin', renderMentorGoalItem(payload, menteeId));
      const el = itemsWrap.firstElementChild;
      el?.classList.add('goal-enter');
      el?.addEventListener('animationend', () => el.classList.remove('goal-enter'), { once: true });
      syncMentorGoalTicker(menteeId);
      _mentorGoalTickers[menteeId]?.notifyNewItem();
    }
  }

  if (type === 'updated') {
    if (cache) {
      const idx = cache.findIndex(g => String(g.id) === String(payload.id));
      if (idx !== -1) {
        if (JSON.stringify(cache[idx]) === JSON.stringify(payload)) return; // already applied
        cache[idx] = payload;
      } else {
        cache.push(payload);
      }
    }
    if (isOpen && itemsWrap) {
      const existing = itemsWrap.querySelector(`[data-goal-id="${payload.id}"]`);
      if (existing) {
        existing.outerHTML = renderMentorGoalItem(payload, menteeId);
        const fresh = itemsWrap.querySelector(`[data-goal-id="${payload.id}"]`);
        fresh?.classList.add('goal-pulse');
        setTimeout(() => fresh?.classList.remove('goal-pulse'), 500);
      } else {
        itemsWrap.insertAdjacentHTML('afterbegin', renderMentorGoalItem(payload, menteeId));
      }
    }
  }

  if (type === 'deleted') {
    if (cache) {
      const had = cache.some(g => String(g.id) === String(payload.id));
      if (!had) return; // already applied
      _mentorGoalsCache[menteeId] = cache.filter(g => String(g.id) !== String(payload.id));
    }
    if (isOpen && itemsWrap) {
      const el = itemsWrap.querySelector(`[data-goal-id="${payload.id}"]`);
      if (el) {
        el.classList.add('goal-exit');
        el.addEventListener('animationend', () => {
          el.remove();
          if (!itemsWrap.children.length) {
            itemsWrap.innerHTML = `<div class="text-xs text-dim goal-panel-empty" style="padding:4px 0">${t('mentee_goals_empty')}</div>`;
          }
        }, { once: true });
      }
    }
  }

  updateMenteeGoalsBadge(menteeId);
  if (isOpen) _mentorGoalTickers[menteeId]?.refresh();
}

async function addMenteeGoal(menteeId) {
  const input = $(`goalInput-${menteeId}`);
  const dateInput = $(`goalDate-${menteeId}`);
  const title = input?.value.trim();
  if (!title) return;
  const btn = document.querySelector(`#goalPanel-${menteeId} .goal-add-btn`);
  if (btn) btn.disabled = true;
  try {
    const goal = await apiFetch('/api/mentors/goals', { method: 'POST', body: { mentee_id: menteeId, title, due_date: dateInput?.value || null } });
    haptic('light');
    if (input) input.value = '';
    if (dateInput) { dateInput.value = ''; dateInput.classList.remove('has-value'); }
    applyMentorGoalRealtime('added', goal, menteeId);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function toggleMenteeGoalDone(goalId, menteeId, isDone) {
  // Optimistic update: reflect the toggle immediately, revert + toast on failure.
  const item = document.querySelector(`#goalPanel-${menteeId} [data-goal-id="${goalId}"]`);
  item?.classList.toggle('done', isDone);
  const cached = _mentorGoalsCache[menteeId]?.find(g => String(g.id) === String(goalId));
  const prevDone = cached?.is_done;
  if (cached) cached.is_done = isDone;
  updateMenteeGoalsBadge(menteeId);

  try {
    const goal = await apiFetch(`/api/mentors/goals/${goalId}`, { method: 'PATCH', body: { is_done: isDone } });
    haptic('light');
    applyMentorGoalRealtime('updated', goal, menteeId);
  } catch (e) {
    showToast(e.message, 'error');
    item?.classList.toggle('done', prevDone);
    const box = item?.querySelector('input[type="checkbox"]');
    if (box) box.checked = !!prevDone;
    if (cached) cached.is_done = prevDone;
    updateMenteeGoalsBadge(menteeId);
  }
}

async function deleteMenteeGoal(goalId, menteeId) {
  // Optimistic removal: slide it out immediately, restore on failure.
  const cache = _mentorGoalsCache[menteeId];
  const removedGoal = cache?.find(g => String(g.id) === String(goalId));
  applyMentorGoalRealtime('deleted', { id: goalId }, menteeId);
  try {
    await apiFetch(`/api/mentors/goals/${goalId}`, { method: 'DELETE' });
  } catch (e) {
    showToast(e.message, 'error');
    if (removedGoal) applyMentorGoalRealtime('added', removedGoal, menteeId);
  }
}

// ─── Edit Goal (mentor only) ─────────────────────────────────────
// Reads the goal straight out of the already-loaded cache rather than
// threading its title/date through the onclick attribute — keeps quotes
// and unicode in goal titles from ever needing escaping in inline HTML.
let _editingGoal = null; // { id, menteeId }

function openEditGoalModal(goalId, menteeId) {
  const goal = _mentorGoalsCache[menteeId]?.find(g => String(g.id) === String(goalId));
  if (!goal) return;
  _editingGoal = { id: goalId, menteeId };
  haptic('selection');

  const titleInput = $('editGoalTitle');
  const dateInput = $('editGoalDate');
  if (titleInput) titleInput.value = goal.title || '';
  if (dateInput) dateInput.value = goal.due_date ? goal.due_date.substring(0, 10) : '';

  $('editGoalModal')?.classList.add('open');
  setTimeout(() => titleInput?.focus(), 150);
}

function closeEditGoalModal() {
  haptic('light');
  $('editGoalModal')?.classList.remove('open');
  _editingGoal = null;
}

async function saveEditGoal() {
  if (!_editingGoal) return;
  const { id: goalId, menteeId } = _editingGoal;
  const title = $('editGoalTitle')?.value.trim();
  const due_date = $('editGoalDate')?.value || null;
  if (!title) {
    haptic('error');
    showToast(t('mentee_goal_placeholder'), 'error');
    return;
  }

  const btn = $('editGoalSaveBtn');
  if (btn) btn.disabled = true;
  try {
    const goal = await apiFetch(`/api/mentors/goals/${goalId}`, { method: 'PATCH', body: { title, due_date } });
    haptic('medium');
    applyMentorGoalRealtime('updated', goal, menteeId);
    closeEditGoalModal();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}



async function saveMentorNote(menteeId) {
  const content = $(`note-${menteeId}`).value.trim();
  try {
    await apiFetch('/api/mentors/notes', { method: 'POST', body: { mentee_id: menteeId, content } });
    haptic('light');
  } catch (e) { showToast(e.message, 'error'); }
}

// ─── Transfer Mentee ──────────────────────────────────────────
// Module-level state for the transfer modal
let _transferAssignmentId = null;
let _transferMenteeId = null;

/**
 * Opens the Transfer Mentee modal for the given assignment.
 * @param {string} assignmentId  – the mentorship_assignments.id
 * @param {string} menteeId      – the mentee's telegram_id (unused by the API, kept for future use)
 * @param {string} menteeName    – the mentee's display name (shown in the modal)
 */
async function openTransferModal(assignmentId, menteeId, menteeName) {
  haptic('light');

  // Store state so confirmTransfer() can read it
  _transferAssignmentId = assignmentId;
  _transferMenteeId = menteeId;

  // Update the sub-label with the mentee's name
  const nameEl = $('transferMenteeName');
  if (nameEl) nameEl.textContent = `Transferring: ${escapeHtml(menteeName)}`;

  // Reset filter dropdown
  const topicSelect = $('transferTopicSelect');
  if (topicSelect) {
    topicSelect.innerHTML = '<option value="">All Topics (show all mentors)</option>';
  }

  // Hide the filter group until topics are loaded
  const filterGroup = $('transferTopicFilterGroup');
  if (filterGroup) {
    filterGroup.style.display = 'none';
  }

  // Reset target mentor list
  const select = $('transferMentorSelect');
  if (select) select.innerHTML = '<option value="">Loading mentors…</option>';

  // Show modal
  $('transferModal').classList.add('open');

  // Fetch mentee's struggle topics to populate the filter dropdown
  try {
    const topics = await apiFetch(`/api/mentors/mentee-topics/${menteeId}`);
    if (topics && topics.length > 0) {
      if (topicSelect) {
        topicSelect.innerHTML = '<option value="">All Topics (show all mentors)</option>' +
          topics.map(t => {
            const topic = t.topics;
            return `<option value="${topic.id}">${escapeHtml(topic.name)}</option>`;
          }).join('');
      }
      if (filterGroup) {
        filterGroup.style.display = 'block';
      }
    }
  } catch (e) {
    console.error('Failed to fetch mentee topics:', e);
  }

  // Initially load all mentors (no topic filter selected)
  loadTransferMentors();
}

/** Closes the Transfer Mentee modal and resets its state. */
function closeTransferModal() {
  haptic('light');
  $('transferModal')?.classList.remove('open');
  _transferAssignmentId = null;
  _transferMenteeId = null;
  const topicSelect = $('transferTopicSelect');
  if (topicSelect) topicSelect.value = '';
}

/**
 * Fetches all mentors from GET /api/mentors and populates the dropdown,
 * excluding the currently logged-in mentor (current user).
 * Supports filtering by topic_id.
 * @param {string} topicId - Optional topic ID to filter mentors by.
 */
async function loadTransferMentors(topicId = '') {
  const select = $('transferMentorSelect');
  if (!select) return;

  try {
    let url = '/api/mentors';
    if (topicId) {
      url += `?topic_id=${topicId}`;
    }
    const mentors = await apiFetch(url);
    const currentId = String(currentUser?.telegram_id || '');

    // Filter out the current mentor from the list
    const others = (mentors || []).filter(
      m => String(m.telegram_id) !== currentId
    );

    if (!others.length) {
      select.innerHTML = `<option value="">${topicId ? 'No mentors available for this topic' : 'No other mentors available'}</option>`;
      return;
    }

    // Check if any mentor is both accepting requests AND has available capacity
    const hasAcceptingAvailable = others.some(m => {
      const mentees = m.mentee_count || 0;
      const max = m.user_settings?.max_mentees || 5;
      return m.accepting_requests !== false && mentees < max;
    });

    if (topicId && !hasAcceptingAvailable) {
      select.innerHTML = '<option value="">No accepting mentors available for this topic.</option>';
      return;
    }

    select.innerHTML = others.map(m => {
      const name = m.user_settings?.display_name || m.anonymous_id || `Mentor ${m.telegram_id}`;
      const mentees = m.mentee_count || 0;
      const max = m.user_settings?.max_mentees || 5;
      const isFull = mentees >= max;
      const isNotAccepting = m.accepting_requests === false;

      const disabledAttr = (isFull || isNotAccepting) ? 'disabled' : '';

      let suffixText = '';
      if (isNotAccepting) suffixText += ' (Not Accepting)';
      if (isFull) suffixText += ' - At capacity';

      const statusText = isFull ? ' <span style="color:var(--danger);font-size:0.7rem;">full</span>' : '';

      return `<option value="${m.telegram_id}" ${disabledAttr}>${escapeHtml(name)}${suffixText} <sup>${mentees}/${max}</sup>${statusText}</option>`;
    }).join('');
  } catch (e) {
    if (select) select.innerHTML = '<option value="">Failed to load mentors</option>';
    showToast(e.message, 'error');
  }
}

/**
 * Event handler triggered when the topic filter dropdown value changes.
 * @param {string} topicId - The selected topic ID or empty string.
 */
async function onTransferTopicChange(topicId) {
  haptic('light');
  const select = $('transferMentorSelect');
  if (select) select.innerHTML = '<option value="">Loading mentors…</option>';
  await loadTransferMentors(topicId);
}

/**
 * Confirms the transfer by calling POST /api/mentors/transfer with
 * type='assignment', then refreshes the My Mentees list.
 */
async function confirmTransfer() {
  haptic('medium');

  const select = $('transferMentorSelect');
  const target_mentor_id = select?.value;

  if (!target_mentor_id) {
    haptic('error');
    showToast('Please select a mentor to transfer to.', 'error');
    return;
  }

  if (!_transferAssignmentId) {
    haptic('error');
    showToast('Transfer failed: missing assignment ID.', 'error');
    return;
  }

  try {
    await apiFetch('/api/mentors/transfer', {
      method: 'POST',
      body: {
        type: 'assignment',
        id: _transferAssignmentId,
        target_mentor_id
      }
    });

    haptic('success');
    showToast('Mentee transferred successfully! 🔀', 'success');
    closeTransferModal();
    loadMyMentees(); // Refresh the My Mentees list
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}

async function endMentorship(assignId) {
  if (assignId && typeof assignId === 'string') {
    // Mentor Flow (from My Mentees list)
    if (!confirm('End this mentorship assignment?')) return;
    haptic('medium');
    try {
      await apiFetch(`/api/mentors/end-mentorship/${assignId}`, { method: 'DELETE' });
      haptic('success');
      showToast(t('mentorship_ended'), 'success');
      // Refresh the badge — messages from this ended pairing no longer count.
      updateMessageBadge();
      loadMyMentees();
    } catch (e) { haptic('error'); showToast(e.message, 'error'); }
  } else {
    // Mentee Flow (from Mentors Page)
    if (!confirm(t('confirm_end_mentorship') || 'Are you sure you want to end your mentorship?')) return;
    haptic('medium');
    try {
      const result = await apiFetch('/api/users/end-mentorship', { method: 'POST' });
      haptic('success');
      showToast(t('mentorship_ended'), 'success');
      // Refresh the badge — messages from this ended pairing no longer count.
      updateMessageBadge();
      navigate('dashboard');
      if (result?.mentor?.telegram_id) {
        openRatingModal(result.mentor.telegram_id, result.mentor.display_name);
      }
    } catch (e) {
      haptic('error');
      showToast(e.message, 'error');
    }
  }
}

// ─── Topics ───────────────────────────────────────────────────
window.selectedTopics = [];
window.isTopicModalExpertise = false;
let allTopicsCache = [];

async function openTopicModal(isExpertise = false) {
  haptic('light');
  window.isTopicModalExpertise = isExpertise;
  const container = $('topicsList');
  container.innerHTML = '<div class="loading-spinner" style="margin:20px auto"></div>';

  const modalTitle = document.querySelector('#topicModal .modal-title');
  if (modalTitle) {
    modalTitle.textContent = isExpertise ? 'Select Expertise Topics' : 'Select Struggle Topics';
  }

  $('topicModal').classList.add('open');

  // Clear previous search
  const searchInput = $('topicSearch');
  if (searchInput) searchInput.value = '';

  try {
    const myTopicsPath = isExpertise ? '/api/topics/my-expertise' : '/api/topics/my';
    const [all, mine] = await Promise.all([
      apiFetch('/api/topics'),
      apiFetch(myTopicsPath)
    ]);
    allTopicsCache = all;
    window.selectedTopics = mine.map(t => t.topic_id);

    renderTopicList(allTopicsCache, window.selectedTopics);

    // Add search listener (if not already attached)
    if (searchInput && !searchInput._listenerAdded) {
      searchInput._listenerAdded = true;
      searchInput.oninput = () => {
        const filtered = allTopicsCache.filter(t => t.name.toLowerCase().includes(searchInput.value.toLowerCase()));
        renderTopicList(filtered, window.selectedTopics);
      };
    }
  } catch (e) { container.innerHTML = `<p class="text-danger">${e.message}</p>`; }
}

function renderTopicList(topics, selectedIds) {
  const container = $('topicsList');
  if (!container) return;
  if (!topics.length) {
    container.innerHTML = `<div class="empty-state"><span>${t('no_topics_found') || 'No topics found'}</span></div>`;
    return;
  }
  container.innerHTML = topics.map(topicItem => `
    <div id="topic-${topicItem.id}" class="topic-chip-card${selectedIds.includes(topicItem.id) ? ' active' : ''}" onclick="toggleTopic(${topicItem.id})">
      <span class="chip-check-icon">${ICON_CHECK_SVG}</span>
      <span class="chip-name">${escapeHtml(topicItem.name)}</span>
    </div>
  `).join('');
}

function toggleTopic(id) {
  haptic('light');
  const idx = window.selectedTopics.indexOf(id);
  const chip = $(`topic-${id}`);
  if (idx > -1) {
    window.selectedTopics.splice(idx, 1);
    if (chip) chip.classList.remove('active');
  } else {
    window.selectedTopics.push(id);
    if (chip) chip.classList.add('active');
  }
}

function closeTopicModal() {
  haptic('light');
  $('topicModal').classList.remove('open');
}

async function saveTopics() {
  haptic('medium');
  try {
    const savePath = window.isTopicModalExpertise ? '/api/topics/my-expertise' : '/api/topics/my';
    await apiFetch(savePath, { method: 'POST', body: { topic_ids: window.selectedTopics } });
    haptic('success');
    showToast(t('topics_updated') || 'Topics updated successfully', 'success');
    closeTopicModal();
  } catch (e) { showToast(e.message, 'error'); }
}

// ─── Journal ──────────────────────────────────────────────────
async function loadJournalEntries() {
  const container = $('journalEntriesList');
  container.innerHTML = window.skeletonHTML ? skeletonHTML(3) : '<div class="loading-spinner" style="margin:40px auto"></div>';
  try {
    const entries = await apiFetch('/api/journal');
    if (!entries.length) {
      container.innerHTML = `<div class="empty-state"><span>${t('journal_empty')}</span></div>`;
      return;
    }
    container.innerHTML = entries.map(e => `
      <div class="journal-item" onclick="openJournalEntry('${e.id}', \`${escapeHtml(e.content)}\`, '${e.mood || 'neutral'}')">
        <div class="journal-mood">${getMoodIcon(e.mood)}</div>
        <div class="journal-item-body">
          <div class="journal-date">${formatDateTime(e.created_at)}</div>
          <div class="journal-preview">${escapeHtml(e.content.substring(0, 80))}${e.content.length > 80 ? '…' : ''}</div>
        </div>
      </div>
    `).join('');
  } catch (e) { container.innerHTML = `<div class="empty-state"><span>${e.message}</span></div>`; }
}

const MOOD_SVG = {
  happy: '<svg class="mood-svg" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="0.9" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="0.9" fill="currentColor" stroke="none"/><path d="M8 14c1 1.4 2.4 2.1 4 2.1s3-.7 4-2.1" stroke-linejoin="round"/></svg>',
  neutral: '<svg class="mood-svg" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="0.9" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="0.9" fill="currentColor" stroke="none"/><path d="M8.3 15h7.4" stroke-linejoin="round"/></svg>',
  sad: '<svg class="mood-svg" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="0.9" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="0.9" fill="currentColor" stroke="none"/><path d="M8 16.1c1-1.4 2.4-2.1 4-2.1s3 .7 4 2.1" stroke-linejoin="round"/></svg>',
};
function getMoodIcon(mood) {
  return MOOD_SVG[mood] || MOOD_SVG.neutral;
}
window.currentJournalEntryId = null;

function showNewJournalEntry() {
  haptic('light');
  window.currentJournalEntryId = null;
  $('journalModalTitle').textContent = t('btn_new_entry') || 'New Entry';
  $('journalContent').value = '';
  $('journalContent').readOnly = false;
  $('journalMood').value = 'neutral';
  $('saveJournalBtn').classList.remove('hidden');
  $('updateJournalBtn').classList.add('hidden');
  $('deleteJournalBtn').classList.add('hidden');
  $('journalModal').classList.add('open');
}

function openJournalEntry(id, content, mood = 'neutral') {
  haptic('light');
  window.currentJournalEntryId = id;
  $('journalModalTitle').textContent = t('journal_title') || 'Edit Entry';
  $('journalContent').value = content;
  $('journalContent').readOnly = false;
  $('journalMood').value = mood;
  $('saveJournalBtn').classList.add('hidden');
  $('updateJournalBtn').classList.remove('hidden');
  $('deleteJournalBtn').classList.remove('hidden');
  $('journalModal').classList.add('open');
}

function closeJournalModal() {
  haptic('light');
  $('journalModal').classList.remove('open');
}

async function saveJournalEntry() {
  const content = $('journalContent').value.trim();
  const mood = $('journalMood').value;
  if (!content) return;
  haptic('medium');
  try {
    await apiFetch('/api/journal', { method: 'POST', body: { content, mood } });
    haptic('success');
    showToast(t('journal_saved') || 'Journal saved successfully', 'success');
    closeJournalModal();
    loadJournalEntries();
  } catch (e) { showToast(e.message, 'error'); }
}

async function updateJournalEntry() {
  const id = window.currentJournalEntryId;
  const content = $('journalContent').value.trim();
  const mood = $('journalMood').value;
  if (!content || !id) return;
  haptic('medium');
  try {
    await apiFetch(`/api/journal/${id}`, { method: 'PUT', body: { content, mood } });
    haptic('success');
    showToast('Journal entry updated', 'success');
    closeJournalModal();
    loadJournalEntries();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteJournalEntry() {
  const id = window.currentJournalEntryId;
  if (!id) return;
  if (!confirm('Are you sure you want to delete this journal entry?')) return;
  haptic('medium');
  try {
    await apiFetch(`/api/journal/${id}`, { method: 'DELETE' });
    haptic('success');
    showToast('Journal entry deleted', 'success');
    closeJournalModal();
    loadJournalEntries();
  } catch (e) { showToast(e.message, 'error'); }
}

function formatJournalText(action) {
  const textarea = $('journalContent');
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const selected = text.substring(start, end);

  let replacement = '';
  if (action === 'bold') {
    replacement = `**${selected}**`;
  } else if (action === 'italic') {
    replacement = `*${selected}*`;
  } else if (action === 'list') {
    replacement = selected.split('\n').map(line => line.startsWith('- ') ? line : `- ${line}`).join('\n');
  }

  textarea.value = text.substring(0, start) + replacement + text.substring(end);
  textarea.focus();
  textarea.selectionStart = start;
  textarea.selectionEnd = start + replacement.length;
}
let journalView = 'list'; // 'list' or 'calendar'

const ICON_CALENDAR = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
const ICON_LIST = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>';
function toggleJournalView() {
  if (journalView === 'list') {
    journalView = 'calendar';
    showJournalCalendar();
    $('journalViewToggle').innerHTML = ICON_LIST + ' ' + t('List');
  } else {
    journalView = 'list';
    loadJournalEntries();
    $('journalViewToggle').innerHTML = ICON_CALENDAR + ' ' + t('Calendar');
  }
}

async function showJournalCalendar() {
  $('journalEntriesList').innerHTML = '<div class="loading-spinner" style="margin:40px auto"></div>';
  const entries = await apiFetch('/api/journal');
  const entriesByDate = {};
  entries.forEach(e => {
    const date = new Date(e.created_at).toISOString().split('T')[0];
    if (!entriesByDate[date]) entriesByDate[date] = [];
    entriesByDate[date].push(e);
  });

  const today = new Date();
  let currentYear = today.getFullYear();
  let currentMonth = today.getMonth();

  function renderCalendar() {
    const firstDay = new Date(currentYear, currentMonth, 1);
    const startDay = firstDay.getDay(); // 0 = Sunday
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

    let html = `<div class="calendar-header">
      <button class="btn btn-sm btn-ghost" onclick="prevMonth()">◀</button>
      <span>${firstDay.toLocaleString('default', { month: 'long', year: 'numeric' })}</span>
      <button class="btn btn-sm btn-ghost" onclick="nextMonth()">▶</button>
    </div><div class="calendar-grid">`;
    const weekdays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    weekdays.forEach(d => html += `<div class="calendar-weekday">${d}</div>`);
    for (let i = 0; i < startDay; i++) html += `<div class="calendar-day empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const hasEntries = entriesByDate[dateStr] && entriesByDate[dateStr].length > 0;
      html += `<div class="calendar-day ${hasEntries ? 'has-entry' : ''}" onclick="showEntriesForDate('${dateStr}')">${d}</div>`;
    }
    html += `</div>`;
    $('journalEntriesList').innerHTML = html;
  }

  window.prevMonth = () => {
    if (currentMonth === 0) { currentMonth = 11; currentYear--; }
    else currentMonth--;
    renderCalendar();
  };
  window.nextMonth = () => {
    if (currentMonth === 11) { currentMonth = 0; currentYear++; }
    else currentMonth++;
    renderCalendar();
  };
  window.showEntriesForDate = async (dateStr) => {
    const entries = await apiFetch(`/api/journal/by-date?date=${dateStr}`);
    if (!entries.length) {
      showToast('No entries for this date', 'info');
      return;
    }
    $('journalEntriesList').innerHTML = entries.map(e => `
      <div class="journal-item" onclick="openJournalEntry('${e.id}', \`${escapeHtml(e.content)}\`, '${e.mood || 'neutral'}')">
        <div class="journal-date">${formatDateTime(e.created_at)}</div>
        <div class="journal-mood">${getMoodIcon(e.mood)}</div>
        <div class="journal-preview">${escapeHtml(e.content.substring(0, 80))}${e.content.length > 80 ? '…' : ''}</div>
      </div>
    `).join('');
    $('journalEntriesList').insertAdjacentHTML('afterbegin', `<button class="btn btn-sm btn-ghost" onclick="loadJournalEntries()">← Back to all entries</button>`);
  };
  renderCalendar();
}
// ─── Engagement Popup System ────────────────────────────────────
// Duolingo-style celebration / nudge layer. Renders on demand (no
// static HTML needed per popup) and sits alongside the existing
// showToast()/modal patterns rather than replacing them — those
// stay in place elsewhere as fallbacks. Every color comes from the
// same CSS variables as the rest of the app, so it's theme-aware
// for free under [data-theme].

// Small reusable set of premium, stroke-style SVG icons (currentColor,
// 24x24 viewBox) — no emoji, matching the icon language already used
// for streaks and mentorship elsewhere in this file.
const ENGAGEMENT_ICONS = {
  check: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
  flame: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.3c1.1 3-2.8 4.4-2.8 8A2.8 2.8 0 0 0 12 13a2.8 2.8 0 0 0 2.4-4.3c1.3.9 1.9 2.5 1.9 4a4.3 4.3 0 1 1-8.6 0c0-4.2 2.7-6.4 4.3-10.4z"/><path d="M9.2 16.8a2.8 2.8 0 0 0 5.6 0"/></svg>',
  heart: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.2s-7.4-4.6-9.9-9.3C.6 7.6 2 4 5.6 3.3c2-.4 3.9.5 5 2.1 1.1-1.6 3-2.5 5-2.1C19.2 4 20.6 7.6 19.1 10.9c-2.5 4.7-9.9 9.3-9.9 9.3z"/></svg>',
  pray: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v14.5"/><path d="M12 5.5C10.8 3.6 8.6 2.6 7 3.4 5 4.4 4.6 7 6 9c1 1.4 1 2.8.4 4.2-1 2.3-.3 4.7 1.7 6C9.4 20.2 10.7 20.8 12 21"/><path d="M12 5.5c1.2-1.9 3.4-2.9 5-2.1 2 1 2.4 3.6 1 5.6-1 1.4-1 2.8-.4 4.2 1 2.3.3 4.7-1.7 6-1.3 1-2.6 1.6-3.9 1.6"/></svg>',
  star: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8l2.7 5.7 6.2.7-4.6 4.3 1.2 6.2L12 16.7l-5.5 3 1.2-6.2-4.6-4.3 6.2-.7L12 2.8z"/></svg>',
  book: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5.5C10.3 4.2 7.7 3.6 4 4v13.8c3.7-.4 6.3.2 8 1.5 1.7-1.3 4.3-1.9 8-1.5V4c-3.7-.4-6.3.2-8 1.5z"/><path d="M12 5.5v13.8"/></svg>',
};

// Small persisted-state helpers so individual popups (daily verse
// invite, rating snooze, etc.) can remember cadence across sessions
// without every call site rolling its own localStorage key by hand.
function getPopupState(key) {
  try {
    const raw = localStorage.getItem(`engagement_${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setPopupState(key, value) {
  try {
    localStorage.setItem(`engagement_${key}`, JSON.stringify(value));
  } catch {
    // Private browsing / storage full — popup cadence just resets
    // next load instead of hard-failing.
  }
}

let engagementPopupKeydownHandler = null;

function closeEngagementPopup() {
  const overlay = $('engagementPopupOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  if (engagementPopupKeydownHandler) {
    document.removeEventListener('keydown', engagementPopupKeydownHandler);
    engagementPopupKeydownHandler = null;
  }
  setTimeout(() => overlay.remove(), 250);
}

// The main pop-up renderer. config:
//   id            – string identifying this popup (namespacing for any
//                   getPopupState/setPopupState calls made from the
//                   callbacks — not required to be globally unique)
//   icon          – SVG markup string, e.g. ENGAGEMENT_ICONS.flame
//   title         – headline text (already translated via t())
//   message       – body text (already translated via t())
//   buttonText    – primary button label
//   variant       – 'gold' | 'success' | 'info' — controls icon color
//   onAction      – called after the primary button is tapped
//   secondaryText – optional secondary button label (omit to hide it)
//   onSecondary   – called after the secondary button is tapped
function showEngagementPopup(config) {
  const {
    id = 'engagement',
    icon = ENGAGEMENT_ICONS.check,
    title = '',
    message = '',
    buttonText = t('btn_got_it'),
    variant = 'gold',
    onAction = () => {},
    secondaryText = null,
    onSecondary = null,
  } = config;

  // Only one engagement popup at a time — a new one replaces whatever
  // is already showing rather than stacking on top of it.
  $('engagementPopupOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'engagementPopupOverlay';
  overlay.className = 'engagement-popup-overlay';
  overlay.dataset.popupId = id;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);

  overlay.innerHTML = `
    <div class="engagement-popup">
      <button type="button" class="engagement-popup-close" aria-label="${t('btn_close')}">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l14 14M19 5L5 19"/></svg>
      </button>
      <div class="engagement-popup-icon engagement-popup-icon--${variant}">${icon}</div>
      <div class="engagement-popup-title">${title}</div>
      <p class="engagement-popup-message">${message}</p>
      <div class="engagement-popup-actions">
        <button type="button" class="btn btn-primary btn-full engagement-popup-primary">${buttonText}</button>
        ${secondaryText ? `<button type="button" class="btn btn-ghost btn-full engagement-popup-secondary">${secondaryText}</button>` : ''}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('.engagement-popup-close').addEventListener('click', closeEngagementPopup);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeEngagementPopup(); });
  overlay.querySelector('.engagement-popup-primary').addEventListener('click', () => {
    closeEngagementPopup();
    onAction();
  });
  if (secondaryText) {
    overlay.querySelector('.engagement-popup-secondary').addEventListener('click', () => {
      closeEngagementPopup();
      if (onSecondary) onSecondary();
    });
  }

  engagementPopupKeydownHandler = (e) => { if (e.key === 'Escape') closeEngagementPopup(); };
  document.addEventListener('keydown', engagementPopupKeydownHandler);

  // Add .open on the next frame so the CSS transition actually runs,
  // then move focus onto the popup for keyboard/screen-reader users.
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    overlay.querySelector('.engagement-popup-close').focus();
  });
}

// ─── App Rating Popup ────────────────────────────────────────────
// A friendly, low-pressure invitation to rate the app. Not called
// automatically on every load — see the (currently commented-out)
// call in loadDashboard() below, and the call after a streak
// milestone in markStreakRead(). Backs off for 3 days on "Maybe
// Later", and stops asking for good once the user engages with
// "Rate Now".
function checkAndShowRatingPopup() {
  if (localStorage.getItem('holy_rating_popup_shown') === 'true') return;

  const snoozeUntil = getPopupState('rating_snooze');
  if (snoozeUntil && Date.now() < snoozeUntil) return;

  showEngagementPopup({
    id: 'app_rating',
    icon: ENGAGEMENT_ICONS.star,
    title: t('app_rating_title'),
    message: t('app_rating_message'),
    buttonText: t('btn_rate_now'),
    secondaryText: t('btn_maybe_later'),
    variant: 'gold',
    onAction: () => {
      // The star-rating feedback modal isn't built yet — for now just
      // record that the user engaged so we don't ask again, and log
      // it for follow-up. TODO: open the real feedback modal here.
      console.log('[rating] user tapped Rate Now — feedback modal not yet implemented');
      localStorage.setItem('holy_rating_popup_shown', 'true');
    },
    onSecondary: () => {
      setPopupState('rating_snooze', Date.now() + 3 * 24 * 60 * 60 * 1000);
    },
  });
}

// ─── Boot ─────────────────────────────────────────────────────
window.loadDashboard = loadDashboard;
document.addEventListener('DOMContentLoaded', init);
/* ============================================================
   Organic UI Enhancements — additive, non-destructive
   Wraps loadJournalEntries()/loadMentors() (calls the originals
   unchanged, then layers classes onto the rendered DOM) instead
   of editing their bodies, and drives everything else through
   new listeners/observers. Nothing here removes or renames an
   existing global.
   ============================================================ */
(function () {
  // ── Background blobs: injected only if the static markup is
  //    missing (e.g. older cached index.html) ──
  function ensureBlobs() {
    if (document.querySelector('.bg-blobs')) return;
    const wrap = document.createElement('div');
    wrap.className = 'bg-blobs';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML =
      '<div class="bg-blob bg-blob-1"></div>' +
      '<div class="bg-blob bg-blob-2"></div>' +
      '<div class="bg-blob bg-blob-3"></div>';
    document.body.insertBefore(wrap, document.body.firstChild);
  }

  // ── Subtle parallax for the blobs (pointer + scroll) ──
  function initParallax() {
    let ticking = false;

    function apply(nx, ny) {
      document.querySelectorAll('.bg-blob').forEach((el, i) => {
        const depth = (i + 1) * 6; // px of travel per layer
        el.style.setProperty('--blob-x', (nx * depth).toFixed(1) + 'px');
        el.style.setProperty('--blob-y', (ny * depth).toFixed(1) + 'px');
      });
    }

    window.addEventListener('pointermove', (e) => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        apply(e.clientX / window.innerWidth - 0.5, e.clientY / window.innerHeight - 0.5);
        ticking = false;
      });
    }, { passive: true });

    // Any scrollable .page-content drives a gentle vertical drift too
    document.addEventListener('scroll', (e) => {
      const el = e.target;
      if (!el || !el.classList || !el.classList.contains('page-content')) return;
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const ny = Math.max(-0.5, Math.min(0.5, el.scrollTop / 1200 - 0.5));
        apply(0, ny * 0.6);
        ticking = false;
      });
    }, true);
  }

  // ── Ripple effect on presses (event delegation, no markup needed) ──
  function initRipple() {
    document.addEventListener('pointerdown', (e) => {
      const el = e.target.closest('.btn, .card, .journal-item, .mentor-card');
      if (!el) return;
      el.classList.add('ripple-container');

      const rect = el.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const ripple = document.createElement('span');
      ripple.className = 'ripple-effect';
      ripple.style.width = ripple.style.height = size + 'px';
      ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
      ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
      el.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    }, { passive: true });
  }

  // ── Staggered fade: restart the CSS animation whenever a
  //    .stagger-fade group becomes visible (page switch, or a
  //    fresh render of dynamic content) ──
  function retriggerStagger(root) {
    (root.matches?.('.stagger-fade') ? [root] : root.querySelectorAll('.stagger-fade'))
      .forEach((group) => {
        Array.from(group.children).forEach((child) => {
          child.style.animation = 'none';
          void child.offsetWidth; // force reflow to restart
          child.style.animation = '';
        });
      });
  }

  function initPageObserver() {
    const app = document.getElementById('app');
    if (!app) return;
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        if (m.type === 'attributes' && m.attributeName === 'class') {
          const el = m.target;
          if (el.classList.contains('page') && el.classList.contains('active')) {
            retriggerStagger(el);
          }
        }
      });
    });
    app.querySelectorAll('.page').forEach((p) =>
      observer.observe(p, { attributes: true, attributeFilter: ['class'] })
    );
  }

  // ── Layer stagger-fade onto dynamically rendered lists, without
  //    touching the functions that render them ──
  function wrap(fnName, after) {
    const original = window[fnName];
    if (typeof original !== 'function') return; // safe no-op if not loaded yet
    window[fnName] = function (...args) {
      const result = original.apply(this, args);
      if (result && typeof result.then === 'function') {
        return result.then((val) => { after(); return val; });
      }
      after();
      return result;
    };
  }

  function decorateJournalList() {
    const list = document.getElementById('journalEntriesList');
    if (list) {
      list.classList.add('stagger-fade');
      retriggerStagger(list);
    }
  }

  function decorateMentorList() {
    const list = document.getElementById('mentorsList');
    if (list) {
      list.classList.add('stagger-fade');
      retriggerStagger(list);
    }
  }

  // ── Mood picker: syncs the visual buttons with #journalMood ──
  function wireMoodPicker() {
    const select = document.getElementById('journalMood');
    const picker = document.getElementById('moodPicker');
    if (!select || !picker) return;

    picker.addEventListener('click', (e) => {
      const btn = e.target.closest('.mood-option');
      if (!btn) return;
      select.value = btn.dataset.mood;
      select.dispatchEvent(new Event('change'));
      if (typeof haptic === 'function') haptic('light');
      syncMoodPicker();
    });

    select.addEventListener('change', syncMoodPicker);
    syncMoodPicker();
  }

  function syncMoodPicker() {
    const select = document.getElementById('journalMood');
    const picker = document.getElementById('moodPicker');
    if (!select || !picker) return;
    picker.querySelectorAll('.mood-option').forEach((btn) => {
      btn.classList.toggle('selected', btn.dataset.mood === select.value);
    });
  }

  function watchJournalModal() {
    const modal = document.getElementById('journalModal');
    if (!modal) return;
    const observer = new MutationObserver(() => {
      if (modal.classList.contains('open')) syncMoodPicker();
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
  }

  function init() {
    ensureBlobs();
    initParallax();
    initRipple();
    initPageObserver();
    wireMoodPicker();
    watchJournalModal();
    wrap('loadJournalEntries', decorateJournalList);
    wrap('loadMentors', decorateMentorList);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();