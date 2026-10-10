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
let _lastAppHeight = 0;
let _appHeightRaf = 0;
const MIN_PLAUSIBLE_APP_HEIGHT = 200;   // a real screen is never this short
// When Telegram wakes a minimised mini app its WebView can briefly report a
// height of ~0 and may never send a correcting event. Believing that value
// collapsed every page to nothing (only the header and the fixed bottom nav
// stayed visible), so implausible readings are ignored.
function computeAppHeight() {
  const tg = window.Telegram?.WebApp;
  const candidates = [tg?.viewportStableHeight, tg?.viewportHeight, window.visualViewport?.height, window.innerHeight];
  for (const c of candidates) {
    let h = Math.round(Number(c) || 0);
    if (h < MIN_PLAUSIBLE_APP_HEIGHT) continue;
    // After the app was minimised, Telegram's reported height can stay larger than
    // the window actually is, so the bottom of every page ran off the screen. With
    // no keyboard open the window height is the truth; never exceed it.
    const ae = document.activeElement;
    const typing = !!ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable);
    const real = Math.round(Number(window.innerHeight) || 0);
    if (!typing && real >= MIN_PLAUSIBLE_APP_HEIGHT && h > real + 24) h = real;
    return h;
  }
  return 0;
}
function applyAppHeightNow(force) {
  const h = computeAppHeight();
  if (!h) return;
  if (h === _lastAppHeight && !force) return;
  _lastAppHeight = h;
  document.documentElement.style.setProperty('--app-height', h + 'px');
}
function applyAppHeight(arg) {
  // visualViewport fires 'scroll'/'resize' many times per frame while the
  // keyboard animates. Each write to a root CSS variable invalidates styles
  // for the whole (very large) document, so coalesce to once per frame and
  // skip writes when the value hasn't changed.
  if (arg === true) {                      // forced: don't depend on a frame that may never come
    if (_appHeightRaf) { cancelAnimationFrame(_appHeightRaf); _appHeightRaf = 0; }
    applyAppHeightNow(true);
    return;
  }
  if (_appHeightRaf) return;
  _appHeightRaf = requestAnimationFrame(() => {
    _appHeightRaf = 0;
    applyAppHeightNow(false);
  });
}
applyAppHeight();
window.Telegram?.WebApp?.onEvent?.('viewportChanged', applyAppHeight);
window.addEventListener('resize', applyAppHeight);
window.addEventListener('orientationchange', applyAppHeight);
window.visualViewport?.addEventListener('resize', applyAppHeight);

// Coming back from the home screen / another app: re-measure (the size is often
// wrong for the first moments), and force the visible page to repaint, because
// Android WebViews can drop the GPU layers of the transformed .page elements
// while suspended and come back showing nothing.
let _resumeTimers = [];
function recoverAfterResume() {
  _resumeTimers.forEach(clearTimeout);
  const fix = () => {
    // The page can come back scrolled a little, which pushes the bottom bar and the
    // last items off-screen (the app itself never scrolls the window).
    try { window.scrollTo(0, 0); const se = document.scrollingElement; if (se) se.scrollTop = 0; } catch { }
    applyAppHeight(true);
    const page = document.querySelector('.page.active');
    if (page) {
      page.style.animation = 'none';
      page.style.display = 'none';
      void page.offsetHeight;              // force a reflow
      page.style.display = '';
      requestAnimationFrame(() => { page.style.animation = ''; });
    }
  };
  fix();
  _resumeTimers = [150, 500, 1500, 3000].map(ms => setTimeout(() => { try { window.scrollTo(0, 0); } catch { } applyAppHeight(true); }, ms));
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recoverAfterResume(); });
window.addEventListener('pageshow', recoverAfterResume);
window.addEventListener('focus', recoverAfterResume);
window.Telegram?.WebApp?.onEvent?.('activated', recoverAfterResume);

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

// Requests now have a timeout (previously a stalled request hung forever, which
// froze the chat input) and GETs get ONE automatic retry on a network error or
// 502/503/504 — the usual blips on Render's free tier (cold start, deploy,
// dropped keep-alive connection). POSTs are never retried here; callers that
// retry must do so idempotently (see sendMessage + client_id).
async function apiFetch(path, opts = {}) {
  const { timeout, retry, ...fetchOpts } = opts;
  const method = (fetchOpts.method || 'GET').toUpperCase();
  const timeoutMs = timeout ?? 20000;
  const canRetry = method === 'GET' && retry !== false;

  const attempt = async () => {
    const { initData } = getTelegramData();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(`${API}${path}`, {
        ...fetchOpts,
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-init-data': initData,
          'x-telegram-id': getTelegramData().user?.id || '',
          // Lets the server skip echoing our own message back to this socket.
          ...(socket?.id ? { 'x-socket-id': socket.id } : {}),
          ...(fetchOpts.headers || {}),
        },
        body: fetchOpts.body ? JSON.stringify(fetchOpts.body) : undefined,
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'Request timed out' : (e.message || 'Network error'));
    } finally {
      clearTimeout(timer);
    }
  };

  let res;
  try {
    res = await attempt();
    if (canRetry && [502, 503, 504].includes(res.status)) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    if (!canRetry) throw e;
    await new Promise(r => setTimeout(r, 700));
    res = await attempt();
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.error || `HTTP ${res.status}`);
    if (err.nickname_taken) e.nickname_taken = true;
    if (err.code) e.code = err.code;
    e.status = res.status;
    e.data = err;
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
    const cachedUrl = avatarUrlCache.get(`${m.telegram_id}:${m.photo_updated_at || ''}`);
    if (cachedUrl) {
      return `<div class="mentor-avatar has-photo avatar-loaded" data-avatar-tid="${m.telegram_id}" data-avatar-v="${m.photo_updated_at || ''}" onclick="viewAvatar(this)"><img alt="" src="${cachedUrl}" onerror="this.parentNode.classList.remove('avatar-loaded','has-photo');this.parentNode.textContent='${safeLetter}'"></div>`;
    }
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

function getUserTimezone() {
  try {
    return currentUser?.user_settings?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Addis_Ababa';
  } catch (_) {
    return 'Africa/Addis_Ababa';
  }
}

function formatTime(dateStr) {
  try {
    const tz = getUserTimezone();
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: tz });
  } catch (e) {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

function formatDateTime(dateStr) {
  try {
    const tz = getUserTimezone();
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
  transfer: '<path d="M7 3v14"/><path d="M3 7l4-4 4 4"/><path d="M17 21V7"/><path d="M21 17l-4 4-4-4"/>',
  userMinus: '<path d="M14 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 3 17.5V19"/><circle cx="8.5" cy="7.5" r="3.5"/><path d="M17 10h5"/>',
  more: '<circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  sliders: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="6" r="1.6" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="10" cy="18" r="1.6" fill="currentColor" stroke="none"/>',
};
function menteeIcon(name, size = 14) {
  const body = MENTEE_ICONS[name] || '';
  return `<svg class="ticket-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
// Attachment bubbles (voice, photo, video, file), the recorder, the attach menu
// and uploads live in chat-media.js. Only the full-screen image viewer stays
// here, because the profile-photo viewer uses it too.

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



/* ── Telegram-style replies ──────────────────────────────────────
   Messages are always rendered in ONE flat, chronological list. A reply is
   an ordinary bubble that carries a small quote of the message it answers
   (sender + snippet) at the top; tapping the quote jumps to the original.
   This replaced the old nested tree (buildMessageTree), which pulled every
   reply up underneath its parent and broke the real message order. */

// One-line description of a message: its text, or a label for attachments.
function getReplyPreviewText(msg, max = 100) {
  let preview = String(msg?.content || '').replace(/\s+/g, ' ').trim();
  if (!preview && msg?.file_type) {
    preview = typeof attachmentLabel === 'function' ? attachmentLabel(msg) : String(msg.file_type);
  }
  if (preview.length > max) preview = preview.substring(0, max) + '…';
  return preview;
}

// Same snippet as HTML: attachments get an inline SVG icon (mic for voice
// messages, etc.) instead of an emoji. All text is escaped here.
function getReplyPreviewHtml(msg, max = 100) {
  const text = String(msg?.content || '').replace(/\s+/g, ' ').trim();
  if (!text && msg?.file_type && typeof attachmentPreviewHtml === 'function') return attachmentPreviewHtml(msg, max);
  return escapeHtml(getReplyPreviewText(msg, max));
}

function getReplySenderLabel(msg, fallback = 'them') {
  const isSent = String(msg?.from_id) === String(currentUser?.telegram_id);
  return isSent ? 'You' : (window.chatState?.name || fallback);
}

const REPLY_QUOTE_UNAVAILABLE = 'Original message unavailable';

// The quoted snippet shown at the top of a reply bubble ('' for normal messages).
function renderReplyQuote(msg) {
  if (!msg?.parent_id) return '';
  const parentId = escapeHtml(String(msg.parent_id));
  const parent = window._chatMessagesMap?.get(String(msg.parent_id));

  // Original is older than the loaded history window: the server sends a small
  // preview with the reply. Shown as a plain quote (not tappable), since the
  // original isn't on screen to scroll to.
  if (!parent && msg.parent_preview) {
    const p = msg.parent_preview;
    return `<div class="reply-quote" style="cursor:default">
            <span class="reply-quote-name">${escapeHtml(getReplySenderLabel(p, 'Them'))}</span>
            <span class="reply-quote-text">${getReplyPreviewHtml(p)}</span>
          </div>`;
  }

  // Parent deleted (or no longer exists).
  if (!parent || parent.is_deleted) {
    return `<div class="reply-quote reply-quote-missing" data-reply-to="${parentId}"><span class="reply-quote-text">${REPLY_QUOTE_UNAVAILABLE}</span></div>`;
  }

  return `<div class="reply-quote" role="button" tabindex="0" data-reply-to="${parentId}">
            <span class="reply-quote-name">${escapeHtml(getReplySenderLabel(parent, 'Them'))}</span>
            <span class="reply-quote-text">${getReplyPreviewHtml(parent)}</span>
          </div>`;
}

// Scrolls the chat to a message and briefly highlights its bubble.
function scrollToMessage(msgId) {
  const container = $('chatMessages');
  if (!container) return false;
  const thread = container.querySelector(`.message-thread[data-msg-id="${CSS.escape(String(msgId))}"]`);
  if (!thread) {
    showToast('Original message is no longer available', 'info');
    return false;
  }
  // Scroll the message list itself (not scrollIntoView, which can also shift
  // the fixed-height page around it).
  const cRect = container.getBoundingClientRect();
  const tRect = thread.getBoundingClientRect();
  const target = container.scrollTop + (tRect.top - cRect.top) - (container.clientHeight - tRect.height) / 2;
  container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });

  const bubble = thread.querySelector('.message-bubble');
  if (bubble) {
    bubble.classList.add('msg-flash');
    setTimeout(() => bubble.classList.remove('msg-flash'), 1200);
  }
  haptic('selection');
  return true;
}

// One delegated listener covers every quote, including ones added later.
document.addEventListener('click', (e) => {
  const quote = e.target.closest?.('.reply-quote[data-reply-to]:not(.reply-quote-missing)');
  if (quote) scrollToMessage(quote.dataset.replyTo);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const quote = e.target.closest?.('.reply-quote[data-reply-to]:not(.reply-quote-missing)');
  if (quote) { e.preventDefault(); scrollToMessage(quote.dataset.replyTo); }
});

// Keep already-rendered quotes in sync when their original is edited/deleted.
function refreshReplyQuotesFor(msgId, updatedMsg) {
  const sel = `#chatMessages .reply-quote[data-reply-to="${CSS.escape(String(msgId))}"]`;
  document.querySelectorAll(sel).forEach((q) => {
    if (updatedMsg) {
      const textEl = q.querySelector('.reply-quote-text');
      if (textEl) textEl.innerHTML = getReplyPreviewHtml(updatedMsg);
    } else {
      q.classList.add('reply-quote-missing');
      q.removeAttribute('role');
      q.removeAttribute('tabindex');
      q.innerHTML = `<span class="reply-quote-text">${REPLY_QUOTE_UNAVAILABLE}</span>`;
    }
  });
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
  const tz = getUserTimezone();
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

    // An attachment that is still uploading has no server id yet, so it gets no
    // options menu; and one without a caption has no text to edit (the server
    // rejects empty text), so it can only be deleted.
    const showMenu = isSent && !msg._local;
    const canEdit = !msg.file_type || !!msg.content;

    html += `
      <div class="message-thread ${isSent ? 'thread-sent' : 'thread-received'}" data-msg-id="${msg.id}">
        <div class="message-bubble ${isSent ? 'sent' : 'received'}${msg.parent_id ? ' has-reply' : ''}${msg.file_type ? ' has-media' : ''}">
          ${renderReplyQuote(msg)}
          <div class="message-text">${msg.file_type ? renderFileAttachment(msg) : ''}${msg.content ? `<div class="${msg.file_type ? 'message-caption' : ''}">${escapeHtml(msg.content)}</div>` : ''}${editedMark}</div>
          <div class="message-footer">
            <span class="message-time">${formatTime(msg.created_at)}</span>
            <span class="msg-footer-actions">
              ${showMenu ? `
                <button class="msg-action-btn" onclick="toggleMsgMenu('${msg.id}', event)" aria-label="Options">${ICON_MORE}</button>
                <div class="msg-context-menu" id="msg-menu-${msg.id}">
                  ${canEdit ? `<button class="msg-menu-item" onclick="editMessageInline('${msg.id}');closeMsgMenu()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    Edit
                  </button>` : ''}
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
      </div>
    `;
  }

  return html;
}

// Swap our optimistic ("sending…") bubble for the confirmed server message.
// Done in place: the new bubble no longer replays the entrance animation, so
// the message you just sent doesn't fade out and back in ("blink").
function replaceOptimisticBubble(container, tempId, msg) {
  if (window._chatMessagesMap) {
    window._chatMessagesMap.delete(String(tempId));
    window._chatMessagesMap.set(String(msg.id), msg);
  }
  const tempEl = container.querySelector(`.message-thread[data-msg-id="${tempId}"]`);
  if (!tempEl) return false;
  if (container.querySelector(`.message-thread[data-msg-id="${msg.id}"]`)) {
    tempEl.remove(); // the real one already arrived another way
  } else {
    tempEl.outerHTML = renderThread([msg], false);
    hydratePhotoMessages(container);
  }
  return true;
}

// Placeholder shown in place of the message list while the two people have not
// written to each other yet. It lives inside #chatMessages so it takes the
// same space as the list and goes away the moment the first bubble arrives.
function chatEmptyStateHtml() {
  const name = window.chatState?.name;
  const sub = name
    ? t('chat_empty_sub').replace('{name}', () => escapeHtml(name))
    : t('chat_empty_sub_plain');
  return `
    <div class="chat-empty" id="chatEmpty">
      <div class="chat-empty-icon">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
      </div>
      <div class="chat-empty-title">${t('chat_empty_title')}</div>
      <p class="chat-empty-sub">${sub}</p>
    </div>`;
}

// Keep the placeholder in step with what is on screen: gone as soon as there is
// a message, back if the last one is deleted.
function syncChatEmptyState(container = $('chatMessages')) {
  if (!container) return;
  const hasMessages = !!container.querySelector('.message-thread');
  const empty = container.querySelector(':scope > .chat-empty');
  if (hasMessages && empty) empty.remove();
  else if (!hasMessages && !empty && window.chatState?.with) container.insertAdjacentHTML('beforeend', chatEmptyStateHtml());
}

function addMessageToChat(msg) {
  const container = $('chatMessages');
  if (!container) return;

  if (!window._chatMessagesMap) window._chatMessagesMap = new Map();
  window._chatMessagesMap.set(String(msg.id), msg);

  // Our own message echoed back (server sets client_id): reconcile with the
  // optimistic bubble rather than appending a duplicate next to it.
  if (msg.client_id && replaceOptimisticBubble(container, msg.client_id, msg)) return;

  // Check if already exists (by ID)
  const existing = container.querySelector(`.message-thread[data-msg-id="${msg.id}"]`);
  if (existing) return;

  // First message of the conversation: the "start messaging" placeholder makes way.
  container.querySelector(':scope > .chat-empty')?.remove();

  // Only auto-scroll if the user is already at the bottom (or it's their own
  // message). Previously every incoming message yanked the view to the bottom
  // even while the user was scrolled up reading history.
  const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
  const isMine = msg.is_sending || String(msg.from_id) === String(currentUser?.telegram_id);
  const stickToBottom = wasNearBottom || isMine;

  const html = renderThread([msg], false);

  const groupHeader = getDateGroupHeader(msg.created_at);
  const dividers = container.querySelectorAll('.chat-date-divider span');
  const lastDividerText = dividers.length > 0 ? dividers[dividers.length - 1].textContent.trim() : '';

  let finalHtml = '';
  if (groupHeader !== lastDividerText) {
    finalHtml += `<div class="chat-date-divider"><span>${escapeHtml(groupHeader)}</span></div>`;
  }
  finalHtml += html;

  container.insertAdjacentHTML('beforeend', finalHtml);

  const newThread = container.lastElementChild;
  newThread?.classList.add('msg-enter'); // entrance animation only for NEW messages

  // If temporary sending message, style the bubble
  if (msg.is_sending) {
    const bubble = newThread?.querySelector('.message-bubble');
    if (bubble) bubble.classList.add('sending');
  }

  hydratePhotoMessages(container);
  if (stickToBottom) container.scrollTop = container.scrollHeight;
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
    $('chatPartnerBackdrop')?.classList.add('open');
    setTimeout(() => document.addEventListener('click', closeChatPartnerDropdown, { once: true }), 0);
  }
}

function closeChatPartnerDropdown() {
  $('chatPartnerDropdownMenu')?.classList.remove('open');
  $('chatPartnerBackdrop')?.classList.remove('open');
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

  $('chatSendBtn')?.setAttribute('title', 'Save edit');
  updateComposerMode();

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

  $('chatSendBtn')?.removeAttribute('title');

  const input = $('chatInput');
  if (input) {
    input.value = '';
    autoResizeChatInput();
  }
  updateComposerMode();
  syncChatInputHeight();
}

async function deleteMessageInline(msgId) {
  currentMessageId = msgId;
  await deleteMessage();
}

// Turns the main composer into a reply box for `messageId`, Telegram-style:
// shows the reply banner above the textarea instead of a per-message form.
function setReplyTo(messageId) {
  // An unsent ("temp_…") bubble has no server id yet, so it can't be a parent.
  if (String(messageId).startsWith('temp_')) return;
  cancelEditMessage(); // reply and edit are mutually exclusive

  const msg = window._chatMessagesMap?.get(String(messageId));
  if (!msg) return;

  window.replyToId = messageId;

  const senderLabel = getReplySenderLabel(msg);
  const previewHtml = getReplyPreviewHtml(msg, 60);

  const label = $('replyIndicatorLabel');
  if (label) label.textContent = `Replying to ${senderLabel}`;
  const replyText = $('replyText');
  if (replyText) replyText.innerHTML = previewHtml;

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
  const deletingId = currentMessageId;
  try {
    await apiFetch(`/api/messages/${deletingId}`, { method: 'DELETE' });
    // Drop it from the cache now so replies re-rendered by the reload below
    // show "unavailable" instead of quoting a message that no longer exists.
    window._chatMessagesMap?.delete(String(deletingId));
    closeMessageOptions();
    loadMessages(window.chatState.with);
    haptic('medium');
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}
function showToast(msg, type = 'info', opts = {}) {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  if (opts.iconHtml) t.insertAdjacentHTML('afterbegin', opts.iconHtml);   // trusted inline SVG only
  t.appendChild(document.createTextNode(msg));
  t.style.cssText = `
    position:fixed;top:16px;left:50%;transform:translateX(-50%) translateZ(0);-webkit-transform:translateX(-50%) translateZ(0);
    background:${type === 'error' ? 'var(--danger)' : type === 'success' ? 'var(--success)' : 'var(--bg3)'};
    color:#fff;padding:10px 20px;border-radius:8px;z-index:9999;
    font-size:var(--fs-sm);font-weight:700;animation:fadeIn .2s ease;
    max-width:90vw;text-align:center;will-change:transform,opacity;
  `;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── Theme ────────────────────────────────────────────────────
const THEME_ICON_SUN = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/></svg>';
const THEME_ICON_MOON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.4A8.4 8.4 0 1 1 9.6 3.5a6.8 6.8 0 0 0 10.9 10.9z"/></svg>';
// Background colours must match --bg in styles.css. Also pushed to Telegram so
// its own header/bottom bars change with the theme instead of staying dark.
const THEME_BG = { dark: '#0D0F14', light: '#F4F1EA' };

function setTheme(theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  try { localStorage.setItem('theme', theme); } catch { }
  const icon = theme === 'light' ? THEME_ICON_MOON : THEME_ICON_SUN;
  document.querySelectorAll('.theme-btn .theme-icon-svg').forEach(el => el.innerHTML = icon);
  const tg = window.Telegram?.WebApp;
  if (tg) {
    const c = THEME_BG[theme] || THEME_BG.dark;
    try { tg.setHeaderColor?.(c); tg.setBackgroundColor?.(c); tg.setBottomBarColor?.(c); } catch { }
  }
  if (typeof rebuildChart === 'function') {
    requestAnimationFrame(rebuildChart);
  }
}

// The old toggle used document.startViewTransition (screenshots the whole
// page — very heavy with this much DOM/blur on phones) and a fallback that put
// a colour transition on EVERY element. Both are gone.
// Now: a single full-screen "veil" in the NEW background colour fades in
// (opacity only — cheap, GPU-composited), the theme flips underneath while
// it's opaque with transitions switched off (so nothing animates piecemeal),
// then the veil fades out to reveal the new theme.
let _themeBusy = false;
function toggleTheme() {
  if (_themeBusy) return;
  haptic('selection');
  const root = document.documentElement;
  const next = (root.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark';

  const flip = () => {
    root.classList.add('theme-switching');
    setTheme(next);
    void root.offsetWidth; // apply new values with transitions disabled
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  };

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { flip(); return; }

  _themeBusy = true;
  const veil = document.createElement('div');
  veil.className = 'theme-veil';
  veil.style.background = THEME_BG[next];
  document.body.appendChild(veil);
  void veil.offsetWidth;
  veil.style.transition = 'opacity .12s ease-out';
  veil.style.opacity = '1';
  setTimeout(() => {
    flip();
    veil.style.transition = 'opacity .18s ease-in';
    veil.style.opacity = '0';
    setTimeout(() => { veil.remove(); _themeBusy = false; }, 220);
  }, 130);
}
setTheme(localStorage.getItem('theme') || 'dark');

// ─── Telegram chrome: fullscreen + native Back button ────────────
// Close / minimise / ⋮ are drawn by Telegram, not by us. Fullscreen (Bot API 8.0+,
// phones only) lets the app run edge-to-edge underneath them; styles.css keeps
// content clear of them via --safe-top / --safe-bottom. To opt a user out of
// fullscreen: localStorage.setItem('holy_fullscreen', 'off').
function setupTelegramChrome(tg) {
  try { tg.disableVerticalSwipes?.(); } catch { }

  let want = true;
  try { want = localStorage.getItem('holy_fullscreen') !== 'off'; } catch { }
  const phone = tg.platform === 'android' || tg.platform === 'ios';
  if (want && phone && tg.isVersionAtLeast?.('8.0') && !tg.isFullscreen) {
    try { tg.requestFullscreen(); } catch { }
  }

  const sync = () => {
    document.documentElement.classList.toggle('tg-fullscreen', !!tg.isFullscreen);
    applyAppHeight(true);
  };
  ['fullscreenChanged', 'safeAreaChanged', 'contentSafeAreaChanged'].forEach(ev => tg.onEvent?.(ev, sync));
  sync();

  if (tg.BackButton && tg.isVersionAtLeast?.('6.1')) {
    tg.BackButton.onClick(handleTelegramBack);
    syncTelegramBack();
  }
}

// Back closes the top-most popup/sheet first, otherwise returns to Home.
function handleTelegramBack() {
  haptic('light');
  if ($('engagementPopupOverlay')) { closeEngagementPopup(); return; }
  const sheets = document.querySelectorAll('.modal-overlay.open');
  if (sheets.length) { sheets[sheets.length - 1].click(); return; }
  if (document.body.classList.contains('in-call')) return;
  if (currentPage === 'mentor-profile') { closeMentorProfile(); return; }
  if (currentPage !== 'dashboard') navigate('dashboard');
}

// Shows Telegram's "Back" (instead of "Close") on every page except Home.
function syncTelegramBack() {
  const bb = window.Telegram?.WebApp?.BackButton;
  if (!bb) return;
  try { currentPage !== 'dashboard' ? bb.show() : bb.hide(); } catch { }
}

// ─── Init ─────────────────────────────────────────────────────
let __initStarted = false;
async function init() {
  if (__initStarted) return;
  __initStarted = true;
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.ready(); tg.expand(); setupTelegramChrome(tg); }
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

  let failed = false;
  try {
    const data = await fetchMeWithRetry();
    window.ADMIN_ID = data.admin_id;
    if (!data.registered) {
      showOnboarding();
    } else {
      currentUser = data.user;
      if (currentUser.is_banned) {
        document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#E05C5C;font-family:inherit;font-size:var(--fs-lg);">Account suspended.<br><br>Contact support.</div>';
        return;
      }
      startApp();
      handleDeepLink();
    }
  } catch (e) {
    console.error(e);
    failed = true;
    showConnectionError(e);
  } finally {
    if (!failed) $('loadingScreen')?.classList.add('hidden');
  }
}

async function fetchMeWithRetry() {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await apiFetch('/api/auth/me', { timeout: 25000, retry: false });
    } catch (e) {
      lastErr = e;
      if (e.status && e.status < 500) throw e; // 401/403/429: retrying won't help
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

function showConnectionError(err) {
  const ls = $('loadingScreen');
  if (!ls) return;
  ls.classList.remove('hidden');
  const msg = err?.status === 401
    ? 'Session expired. Please close and reopen the app.'
    : 'Could not reach the server.';
  ls.innerHTML = `<div style="padding:32px;text-align:center;color:#D4AF37;font-family:inherit">
    <p style="margin-bottom:20px">${msg}</p>
    <button onclick="location.reload()" style="padding:12px 28px;border-radius:12px;border:1px solid #D4AF37;background:transparent;color:#D4AF37;font-family:inherit">Try again</button>
  </div>`;
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
    if (startParam === 'requests' || startParam.startsWith('requests') || startParam.startsWith('request_')) {
      const toReferred = startParam.includes('referred');
      setTimeout(() => {
        navigate('requests');
        if (toReferred) { _requestsTabChosen = true; setRequestsTab('referred', { byUser: false }); }
      }, 100);
      return;
    }
    if (startParam === 'mentors') {
      setTimeout(() => navigate('mentors'), 100);
      return;
    }
  }

  // Fallback for direct browser testing or web_app url query params
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
    } else if (browserStart === 'mentors') {
      setTimeout(() => navigate('mentors'), 100);
    } else if (browserStart === 'requests' || browserStart.startsWith('requests') || browserStart.startsWith('request_')) {
      setTimeout(() => navigate('requests'), 100);
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
      openRatingModal(pending.mentor_id, pending.display_name, pending.assignment_id);
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

function openRatingModal(mentorId, mentorName, assignmentId) {
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
        <button class="btn btn-outline btn-sm flex-1" id="ratingSkipBtn">${t('btn_skip') || 'Skip'}</button>
        <button class="btn btn-sm flex-1" id="ratingSubmitBtn" style="background:var(--gold);color:#1a1408;border-color:var(--gold);opacity:0.5;pointer-events:none;">${t('btn_submit') || 'Submit rating'}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Wired up here (closures over the real assignmentId/mentorId values)
  // rather than via inline onclick="..." attributes. assignmentId is a
  // UUID (mentorship_assignments.id), and interpolating a bare UUID into
  // an onclick string — onclick="skipRating(${assignmentId})" — produces
  // invalid JavaScript (e.g. skipRating(3fa85f64-5717-4562-...)), since a
  // UUID isn't a valid numeric literal. That silently broke the handler,
  // so the assignment id never reached skipRating() and the skip was
  // never persisted — the popup would then reappear next load. Passing
  // the value directly through a closure sidesteps string-escaping
  // entirely, so this works for UUIDs, numbers, or anything else.
  overlay.querySelector('#ratingSkipBtn').addEventListener('click', () => skipRating(assignmentId));
  overlay.querySelector('#ratingSubmitBtn').addEventListener('click', () => submitMentorRating(mentorId));

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
        const picked = parseInt(svg.dataset.star);
        selected = (picked === selected) ? 0 : picked;   // tap the same star again = undo
        paintStars(selected);
        const btn = $('ratingSubmitBtn');
        btn.style.opacity = selected ? '1' : '0.5';
        btn.style.pointerEvents = selected ? 'auto' : 'none';
      };
    });
  };
  paintStars(0);
}

function closeRatingModal() {
  ratingModalOpen = false;
  document.getElementById('ratingModalOverlay')?.remove();
}

// Skip: persist that this mentee dismissed rating for this specific
// mentorship assignment so /api/users/pending-rating stops surfacing it —
// otherwise the popup would just reappear on the next page load/session.
async function skipRating(assignmentId) {
  const skipBtn = document.getElementById('ratingSkipBtn');
  if (skipBtn) skipBtn.disabled = true;
  try {
    if (assignmentId) {
      await apiFetch('/api/users/skip-rating', { method: 'POST', body: { assignment_id: assignmentId } });
    }
  } catch (e) {
    // Non-fatal: worst case the popup can reappear next session. Still
    // dismiss it for the current one rather than trapping the user.
    console.error('[rating] failed to persist skip', e);
  } finally {
    closeRatingModal();
  }
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
  // Identity is proven with Telegram's signed initData (verified server-side).
  // A function is used so every reconnect sends fresh data.
  socket = io(API, {
    transports: ['websocket', 'polling'],
    auth: (cb) => {
      const { initData, user } = getTelegramData();
      cb({ initData, telegram_id: String(currentUser?.telegram_id || user?.id || '') });
    },
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });

  let _hasConnectedOnce = false;
  socket.on('connect', () => {
    $('reconnectBanner')?.classList.remove('show');
    // Stop polling fallback — socket is live
    stopChatPolling();
    stopGlobalRefresh();
    setGoalsLiveStatus(true);

    // On a RE-connect, anything sent while we were offline was missed (Socket.IO
    // only replays for short drops). Re-sync the open conversation and badges.
    if (_hasConnectedOnce && !socket.recovered) {
      if (currentPage === 'chat' && window.chatState?.with) loadMessages(window.chatState.with).catch(() => { });
      updateMessageBadge();
      updateRequestsBadge();
      updateSessionsBadge();
      checkPendingRating();
    }
    _hasConnectedOnce = true;
  });

  socket.on('connect_error', (err) => {
    console.warn('[Socket] connect_error:', err.message);
    $('reconnectBanner')?.classList.add('show');
    startChatPolling();
    startGlobalRefresh();
  });

  // Coming back from the background: phones suspend sockets silently, so the
  // connection can look alive while being dead. Reconnect if needed and, if we
  // were away a while, re-sync the open chat (cheap no-op if nothing changed).
  let _hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { _hiddenAt = Date.now(); return; }
    if (!socket) return;
    if (!socket.connected) socket.connect();
    if (_hiddenAt && Date.now() - _hiddenAt > 15000) {
      if (currentPage === 'chat' && window.chatState?.with) loadMessages(window.chatState.with).catch(() => { });
      updateMessageBadge();
    }
    _hiddenAt = 0;
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
    // Deletes/reads that happened while offline never reached us as events.
    updateMessageBadge();
    // Re-auth on reconnect
    const userId = String(currentUser?.telegram_id || getTelegramData().user?.id || '');
    socket.emit('auth', userId);
    if (currentPage === 'chat' && window.chatState?.with) {
      loadMessages(window.chatState.with);
    }
  });

  socket.on('new_message', (msg, ack) => {
    // Confirms receipt; the server falls back to a Telegram notification if
    // it doesn't get this (dead connection).
    if (typeof ack === 'function') ack();
    if (currentPage === 'chat' && window.chatState?.with && String(window.chatState.with) === String(msg.from_id)) {
      addMessageToChat(msg);
      // Mark as read. This used to call GET /api/messages/:id — downloading
      // the entire 100-message history (4 DB queries) for EVERY incoming
      // message just to trigger a side effect, then throwing the result away.
      apiFetch(`/api/messages/read/${msg.from_id}`, { method: 'POST' }).then(() => updateMessageBadge()).catch(() => { });
    } else {
      updateMessageBadge();
      // If the mentor is sitting on the chat page with a different mentee
      // open, refresh the picker's badges live instead of leaving them
      // stale until the dropdown is next reopened.
      refreshChatPartnerBadges();
      if (msg.file_type && typeof attachmentIconSvg === 'function') {
        const kind = ['photo', 'voice', 'video', 'audio'].includes(msg.file_type) ? msg.file_type : 'document';
        const text = kind === 'voice' ? 'Voice message received' : 'New message received';
        showToast(text, 'info', { iconHtml: attachmentIconSvg(kind) });
      } else {
        showToast('💬 New message received');
      }
      haptic('medium');
    }
  });

  socket.on('chat_cleared', ({ by_id }) => {
    // Cleared messages no longer count as unread, on any page.
    updateMessageBadge();
    refreshChatPartnerBadges();
    if (currentPage === 'chat' && window.chatState?.with && String(window.chatState.with) === String(by_id)) {
      loadMessages(window.chatState.with, { force: true }).catch(() => { });
    }
  });

  socket.on('session_invite', (session) => {
    haptic('success');
    updateSessionsBadge();
    if (currentPage === 'sessions') loadSessions();
    // Non-blocking, tappable banner (the old confirm() froze the app in some WebViews).
    window.SRsocket?.invite(session.session_id, session.title);
  });

  // The host arrived — unlock the lobby instantly.
  socket.on('session_host_joined', ({ session_id } = {}) => window.SRsocket?.hostJoined(session_id));
  socket.on('session_host_left', ({ session_id } = {}) => window.SRsocket?.hostLeft(session_id));
  // A mentee is waiting in the lobby and the mentor isn't in the room yet.
  socket.on('session_participant_waiting', ({ session_id, name } = {}) => window.SRsocket?.waiting(session_id, name));

  socket.on('broadcast', ({ message }) => {
    if (!message) return;
    showToast(`📢 ${message}`);
  });

  socket.on('typing', ({ from_id, action }) => {
    if (window.chatState?.with && String(window.chatState.with) === String(from_id)) {
      const statusEl = $('chatPeerStatus');
      if (statusEl) {
        const label = action === 'voice' ? (t('typing_voice') !== 'typing_voice' ? t('typing_voice') : 'Recording voice message')
          : action === 'upload' ? (t('typing_upload') !== 'typing_upload' ? t('typing_upload') : 'Sending a file')
          : 'Typing';
        statusEl.innerHTML = `${escapeHtml(label)} <span class="typing-dots"><span></span><span></span><span></span></span>`;
        statusEl.classList.add('typing');
        statusEl.classList.remove('offline');
        statusEl.style.display = 'block';
      }
      clearTimeout(window.typingTimeout);
      window.typingTimeout = setTimeout(renderPeerStatus, 3000);
    }
  });

  // In-app notification for the Requests page: plain text plus a "View" button,
  // the same banner the live-session invites use. `tab` picks the tab it opens on.
  const notifyRequests = (text, tab) => {
    const open = () => {
      _requestsTabChosen = true;
      navigate('requests');
      setRequestsTab(tab, { byUser: false });
    };
    if (window.SRsocket?.notify) {
      window.SRsocket.notify({ text, actionLabel: t('sr_view'), onAction: open, ttl: 12000 });
    } else {
      showToast(text, 'success');
    }
  };

  socket.on('new_mentorship_request', () => {
    haptic('success');
    notifyRequests(t('req_toast_new_request'), 'mentee');
    updateRequestsBadge();
    if (currentPage === 'requests') loadRequests();
  });

  // Another mentor referred one of their mentees to me
  socket.on('new_referral_request', () => {
    haptic('success');
    notifyRequests(t('req_toast_new_referral'), 'referred');
    updateRequestsBadge();
    if (currentPage === 'requests') loadRequests();
  });

  // A referral changed: the receiver answered it (sender sees the outcome), or it was cancelled
  socket.on('referral_updated', ({ status, role } = {}) => {
    updateRequestsBadge();
    if (currentPage === 'requests') loadRequests();
    if (role === 'sender') {
      haptic(status === 'accepted' ? 'success' : 'warning');
      showToast(t(status === 'accepted' ? 'req_toast_sender_accepted' : 'req_toast_sender_declined'), status === 'accepted' ? 'success' : 'info');
      if (currentPage === 'my-mentees') loadMyMentees();
    }
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

  // The other side ended the mentorship (or an admin did). Refresh what depends
  // on it, and pop the rating prompt for a mentee straight away instead of
  // waiting for their next app launch.
  socket.on('mentorship_ended', ({ by } = {}) => {
    haptic('warning');
    showToast(t('mentorship_ended') || 'Mentorship has ended.', 'info');
    updateMessageBadge();
    if (currentUser?.role === 'user') checkPendingRating();
    if (currentPage === 'chat') loadChat();
    else if (currentPage === 'mentors') loadMentors();
    else if (currentPage === 'my-mentees') loadMyMentees();
  });

  // Edits and deletes are applied to the bubble in place. They used to reload
  // and rebuild the entire conversation (for BOTH participants, and even when
  // the event belonged to a different chat).
  socket.on('message_edited', (editedMsg) => {
    if (!editedMsg?.id) return;
    const cached = window._chatMessagesMap?.get(String(editedMsg.id));
    if (cached) Object.assign(cached, editedMsg);
    if (currentPage !== 'chat' || !window.chatState?.with) return;
    refreshReplyQuotesFor(editedMsg.id, cached || editedMsg);
    const threadEl = document.querySelector(`#chatMessages .message-thread[data-msg-id="${editedMsg.id}"]`);
    if (!threadEl) return;
    const captionEl = threadEl.querySelector('.message-caption');
    const textEl = threadEl.querySelector('.message-text');
    if (captionEl) {
      captionEl.textContent = editedMsg.content;
    } else if (textEl) {
      textEl.innerHTML = escapeHtml(editedMsg.content) + '<span class="msg-edited">edited</span>';
    } else {
      loadMessages(window.chatState.with).catch(() => { });
    }
  });

  socket.on('message_deleted', ({ id } = {}) => {
    if (!id) return;
    window._chatMessagesMap?.delete(String(id));
    // The sender may unsend a message before the receiver ever opens the
    // chat. The server no longer counts it as unread, so re-sync the nav
    // badge (and the mentor's per-mentee badges) no matter which page is open.
    updateMessageBadge();
    refreshChatPartnerBadges();
    if (currentPage !== 'chat' || !window.chatState?.with) return;
    // Replies to the deleted message stay in place; their quote just updates.
    refreshReplyQuotesFor(id, null);
    document.querySelector(`#chatMessages .message-thread[data-msg-id="${id}"]`)?.remove();
    syncChatEmptyState();
  });

  // Fired the instant a session actually goes live (first participant/host
  // joins). Pings everyone else invited so they know it's time to hop in —
  // separate from the bot's 10-minutes-before reminder.
  socket.on('session_started', ({ session_id, title } = {}) => {
    haptic('success');
    showToast(`🔴 Your session has started${title ? `: ${title}` : ''}. Please join us now!`, 'success');
    updateSessionsBadge();
    if (currentPage === 'sessions') {
      loadSessions();
    }
  });

  // Fired by the server when the host ends a session — refresh the sessions
  // page immediately so the Join button disappears for all participants.
  socket.on('session_ended', ({ session_id, reason } = {}) => {
    // If we're inside that session's lobby/call, close it properly instead of
    // leaving the user stranded in a room that no longer exists.
    if (window.activeSession && String(window.activeSession.sessionId) === String(session_id)) {
      window.SRsocket?.ended(session_id, reason);
      return;
    }
    haptic('warning');
    showToast(t('The session has ended.'), 'info');
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
  // Goals v2: the server pushes the whole goal (tasks + stats) on every change.
  socket.on('goal2_updated', (goal) => window.HolyGoals?.onRealtime(goal));
  socket.on('goal2_deleted', (p) => window.HolyGoals?.onRealtimeDeleted(p));

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

  // Save any note the mentor is still typing before this page goes away
  if (currentPage === 'my-mentees' && page !== 'my-mentees') flushMentorNotes();

  currentPage = page;
  updateChatKeyboard();                    // leaving chat clears the docked-composer state
  $$('.page').forEach(p => p.classList.remove('active'));
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $(`page-${page}`)?.classList.add('active');
  window.updateScrollToBottomBtn?.();      // hide the chat's "jump to bottom" button on other pages
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

  // Update Floating Action Button (FAB) state
  updateFab();

  updateSessionsBadge();
  syncTelegramBack();
}

// ─── Floating Action Button (FAB) ────────────────────────────
const FAB_ICONS = {
  plus: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
  pencil: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>',
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>'
};

function updateFab() {
  const fab = $('fabMain');
  const icon = $('fabIcon');
  if (!fab || !icon) return;

  switch (currentPage) {
    case 'dashboard':
      fab.classList.remove('hidden');
      icon.innerHTML = FAB_ICONS.plus;
      fab.setAttribute('aria-label', t('btn_new_entry') || 'New Entry');
      break;
    case 'journal':
      fab.classList.remove('hidden');
      icon.innerHTML = FAB_ICONS.pencil;
      fab.setAttribute('aria-label', t('btn_new_entry') || 'New Entry');
      break;
    case 'mentors':
      fab.classList.remove('hidden');
      icon.innerHTML = FAB_ICONS.search;
      fab.setAttribute('aria-label', t('search_mentors_placeholder') || 'Search Mentors');
      break;
    default:
      // Hide on chat, sessions, my-mentees, support, requests, settings, etc.
      fab.classList.add('hidden');
      break;
  }
}

function handleFabClick() {
  haptic('medium');
  if (currentPage === 'dashboard' || currentPage === 'journal') {
    showNewJournalEntry();
  } else if (currentPage === 'mentors') {
    const input = $('mentorSearchInput');
    if (input) {
      input.focus();
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

function toggleChatInput(visible) {
  const row = $('chatInputRow');
  if (!row) return;
  if (visible) {
    row.classList.remove('hidden');
    row.style.display = 'flex';
  } else {
    // Never leave the microphone open behind a hidden composer.
    if (typeof cancelRecording === 'function') cancelRecording();
    if (typeof closeComposerPopups === 'function') closeComposerPopups();
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
  syncChatCoveredSpace();
  window.updateScrollToBottomBtn?.();
}

// The floating nav pill and the fixed input row sit on top of the message list.
// Instead of guessing how much of the list they hide (which depended on
// --app-height being exact and left the last message under the nav in
// fullscreen), measure the real overlap from the screen and pad by that.
function syncChatCoveredSpace() {
  const messages = $('chatMessages');
  const row = $('chatInputRow');
  if (!messages || messages.offsetHeight === 0) return;           // chat page not visible
  const mr = messages.getBoundingClientRect();
  let coverTop = Infinity;
  if (row && !row.classList.contains('hidden') && row.offsetHeight) coverTop = Math.min(coverTop, row.getBoundingClientRect().top);
  const nav = document.querySelector('.bottom-nav');
  if (nav && nav.offsetHeight && getComputedStyle(nav).display !== 'none') coverTop = Math.min(coverTop, nav.getBoundingClientRect().top);
  if (!isFinite(coverTop)) return;
  const covered = Math.max(0, Math.ceil(mr.bottom - coverTop)) + 14;   // + breathing room
  if (messages._lastCovered === covered) return;
  const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  messages._lastCovered = covered;
  messages.style.setProperty('--chat-covered', covered + 'px');
  if (atBottom) messages.scrollTop = messages.scrollHeight;      // keep the newest message in view
}
// ─── Chat: dock the composer when the keyboard is open ───────
// With the keyboard up, Telegram shrinks the viewport, so the fixed nav pill used
// to ride on top of the keyboard with the composer floating above it. While the
// keyboard is open on the chat page we hide the nav and sit the composer directly
// on the keyboard (body.chat-kb; see styles.css). When the keyboard closes the
// nav comes back and the composer docks on top of it again.
let _chatKbBase = 0;
function updateChatKeyboard() {
  const ae = document.activeElement;
  const typing = !!ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName);
  const h = window.visualViewport?.height || window.innerHeight;
  if (!typing || !_chatKbBase) _chatKbBase = h;       // nothing is shrinking the viewport: this is the full height
  const tg = window.Telegram?.WebApp;
  const tgDiff = tg ? (Number(tg.viewportStableHeight) || 0) - (Number(tg.viewportHeight) || 0) : 0;
  const open = typing && currentPage === 'chat' && (_chatKbBase - h > 120 || tgDiff > 120);
  if (document.body.classList.contains('chat-kb') === open) return;
  document.body.classList.toggle('chat-kb', open);
  requestAnimationFrame(() => {                       // nav gone / back: re-measure, keep the newest message in view
    syncChatInputHeight();
    const m = $('chatMessages');
    if (open && m) m.scrollTop = m.scrollHeight;
  });
}
{
  let _kbRaf = 0;
  const schedule = () => { if (_kbRaf) return; _kbRaf = requestAnimationFrame(() => { _kbRaf = 0; updateChatKeyboard(); }); };
  document.addEventListener('focusin', () => setTimeout(updateChatKeyboard, 60));
  document.addEventListener('focusout', () => setTimeout(updateChatKeyboard, 120));
  window.visualViewport?.addEventListener('resize', schedule);
  window.addEventListener('resize', schedule);
  try { window.Telegram?.WebApp?.onEvent?.('viewportChanged', schedule); } catch { }
}
window.addEventListener('resize', syncChatInputHeight);
window.visualViewport?.addEventListener('resize', syncChatInputHeight);
window.addEventListener('orientationchange', () => setTimeout(syncChatInputHeight, 250));
['fullscreenChanged', 'safeAreaChanged', 'contentSafeAreaChanged', 'viewportChanged'].forEach(ev => {
  try { window.Telegram?.WebApp?.onEvent?.(ev, () => requestAnimationFrame(syncChatInputHeight)); } catch { }
});
if (window.ResizeObserver) {
  const _chatRO = new ResizeObserver(() => syncChatInputHeight());
  const _watch = () => { ['chatInputRow', 'chatMessages'].forEach(id => { const el = $(id); if (el && !el._ro) { el._ro = 1; _chatRO.observe(el); } }); };
  _watch(); setTimeout(_watch, 800); setTimeout(_watch, 2500);
}

// ─── Every other field: lift it above the keyboard, smoothly ──
// The chat composer docks itself (above). For any other text field — profile,
// settings, forms inside sheets, onboarding — we do three things when the
// keyboard opens:
//   1. body.kb-open: the floating nav slides away instead of covering the field.
//   2. --kb-inset: how far the keyboard covers the layout viewport (0 where the
//      WebView already resizes to sit above it). Sheets and scrolling pages use
//      it to lift themselves, with a CSS transition.
//   3. The focused field is scrolled (smooth, once the keyboard has settled)
//      until it sits fully above the keyboard.
const _KB_NON_TEXT_INPUTS = /^(checkbox|radio|range|button|submit|reset|file|color|image|hidden)$/i;
let _kbBase = 0;
let _kbInset = 0;
let _kbScrollTimer = 0;

function isKeyboardField(el) {
  if (!el || !el.tagName) return false;
  if (el.closest?.('.chat-input-row')) return false;        // the composer has its own dock
  if (el.tagName === 'TEXTAREA') return !el.readOnly;
  if (el.tagName === 'INPUT') return !_KB_NON_TEXT_INPUTS.test(el.type || 'text') && !el.readOnly;
  return !!el.isContentEditable;
}

function keyboardScrollParent(el) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return document.scrollingElement || document.documentElement;
}

function scrollFieldAboveKeyboard(el) {
  if (!el || !el.isConnected || el !== document.activeElement || !isKeyboardField(el)) return;
  const vv = window.visualViewport;
  const viewTop = vv ? vv.offsetTop : 0;
  const viewBottom = viewTop + (vv ? vv.height : window.innerHeight);
  const r = el.getBoundingClientRect();
  const GAP = 24;                                           // breathing room above the keyboard
  let delta = 0;
  if (r.bottom > viewBottom - GAP) delta = r.bottom - (viewBottom - GAP);
  else if (r.top < viewTop + 8) delta = r.top - (viewTop + 8);
  if (Math.abs(delta) < 4) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  keyboardScrollParent(el).scrollBy({ top: delta, behavior: reduce ? 'auto' : 'smooth' });
}

// Debounced: the keyboard animation fires many viewport resizes; scroll once it
// has settled, so the page glides to the field instead of chasing it.
function scheduleFieldAboveKeyboard(el, delay = 140) {
  clearTimeout(_kbScrollTimer);
  _kbScrollTimer = setTimeout(() => scrollFieldAboveKeyboard(el), delay);
}

function updateKeyboardState() {
  const ae = document.activeElement;
  const typing = isKeyboardField(ae);
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  // The full (keyboard-less) height is only re-measured while no field is
  // focused, so a keyboard that is already half open can't become the baseline.
  if (!typing || !_kbBase) _kbBase = Math.max(h, window.innerHeight);
  const tg = window.Telegram?.WebApp;
  const tgDiff = tg ? (Number(tg.viewportStableHeight) || 0) - (Number(tg.viewportHeight) || 0) : 0;
  const covered = typing && vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
  const open = typing && (_kbBase - h > 120 || tgDiff > 120 || covered > 120);

  const inset = open ? covered : 0;
  if (inset !== _kbInset) {
    _kbInset = inset;
    document.documentElement.style.setProperty('--kb-inset', inset + 'px');
  }
  if (document.body.classList.contains('kb-open') !== open) document.body.classList.toggle('kb-open', open);
  if (open) scheduleFieldAboveKeyboard(ae);
}
{
  let _kbRaf2 = 0;
  const schedule = () => { if (_kbRaf2) return; _kbRaf2 = requestAnimationFrame(() => { _kbRaf2 = 0; updateKeyboardState(); }); };
  document.addEventListener('focusin', (e) => {
    setTimeout(updateKeyboardState, 60);
    // Keyboard already up (moving between fields): no resize will follow, so scroll now.
    if (document.body.classList.contains('kb-open') && isKeyboardField(e.target)) scheduleFieldAboveKeyboard(e.target, 80);
  });
  document.addEventListener('focusout', () => setTimeout(updateKeyboardState, 120));
  window.visualViewport?.addEventListener('resize', schedule);
  window.addEventListener('resize', schedule);
  try { window.Telegram?.WebApp?.onEvent?.('viewportChanged', schedule); } catch { }
}

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
        .map(t => `<option value="${t.id}">${escapeHtml(topicLabel(t))}</option>`)
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
      <span class="chip-name">${escapeHtml(topicLabel(t))}</span>
    </div>
  `).join('');
}

function renderOnboardingSelectedTags() {
  const wrap = $('regTopicsSelectedTags');
  const select = $('regTopicsSelect');
  if (!wrap || !select) return;

  const selected = Array.from(select.selectedOptions);
  const countPill = $('obTopicsCount');
  if (countPill) {
    countPill.textContent = selected.length;
    countPill.classList.toggle('hidden', !selected.length);
  }
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
    ? onboardingTopicsCache.filter(t => topicTextMatches(t, q))
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
// Nickname availability: checked when the user presses Continue on the nickname
// step (not only at "Agree & Join"). Results are cached per nickname.
const nicknameCheckCache = new Map(); // lowercase nickname -> true (free) | false (taken)
let nicknameChecking = false;

async function checkNicknameAvailable(nick) {
  const key = nick.toLowerCase();
  if (nicknameCheckCache.has(key)) return nicknameCheckCache.get(key);
  try {
    const r = await apiFetch(`/api/auth/nickname-available?nickname=${encodeURIComponent(nick)}`, { timeout: 8000, retry: false });
    const free = r?.available !== false;
    nicknameCheckCache.set(key, free);
    return free;
  } catch (e) {
    return true; // can't check right now: don't block the user, registration still verifies
  }
}

async function validateAndGoNext(step) {
  if (step === 1 && nicknameChecking) return;
  clearAllFieldErrors();
  let ok = true;

  if (step === 1) {
    const nickname = $('regNickname').value.trim();
    const nickRegex = /^[a-zA-Z0-9_]{3,20}$/;
    if (!nickname) {
      showInlineError('regNickname', t('err_nickname_required'));
      ok = false;
    } else if (!nickRegex.test(nickname)) {
      showInlineError('regNickname', t('err_nickname_format'));
      ok = false;
    }
  } else if (step === 2) {
    if (!$('regSex').value) {
      showInlineError('group-regSex', t('err_select_sex'));
      ok = false;
    }
  } else if (step === 3) {
    if (!$('regAge').value) {
      showInlineError('group-regAge', t('err_select_age'));
      ok = false;
    }
  } else if (step === 4) {
    if (!$('regEdu').value) {
      showInlineError('group-regEdu', t('err_select_edu'));
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

  if (step === 1) {
    nicknameChecking = true;
    const btn = document.querySelector('.onboarding-step:not(.hidden) .ob-btn-next');
    const btnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = `<span>${t('btn_checking')}</span>`; }
    let free = true;
    try {
      free = await checkNicknameAvailable($('regNickname').value.trim());
    } finally {
      nicknameChecking = false;
      if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
    }
    if (!free) {
      haptic('error');
      showInlineError('regNickname', t('err_nickname_taken'));
      return;
    }
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
  if (!nickname || !nickRegex.test(nickname)) { hasError = true; firstErrorStep = firstErrorStep ?? 1; }
  if (!sex) { hasError = true; firstErrorStep = firstErrorStep ?? 2; }
  if (!age_range) { hasError = true; firstErrorStep = firstErrorStep ?? 3; }
  if (!education_level) { hasError = true; firstErrorStep = firstErrorStep ?? 4; }
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
      showStep(1);
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
  // Non-critical: let the dashboard's own requests go first.
  setTimeout(updateMessageBadge, 800);
  setTimeout(updateRequestsBadge, 1600);
  setTimeout(updateSessionsBadge, 2400);
  setTimeout(checkPendingRating, 3200);


  if (String(currentUser?.telegram_id) === String(window.ADMIN_ID)) {
    $('adminBtn')?.classList.remove('hidden');
  }

  if (currentUser?.role === 'mentor') {
    $('nav-requests')?.classList.remove('hidden');
    $('nav-my-mentees')?.style.setProperty('display', 'flex');
    document.querySelectorAll('.mentor-hidden').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.mentor-only').forEach(el => el.classList.remove('hidden'));
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
        variant: 'gold',
        layout: 'sheet',
        hint: t('daily_verse_invite_hint'),
        onAction: async () => {
          // "Read Now" counts as reading: mark today's streak right away instead
          // of making the user tap "Mark as Read" a second time.
          if (currentPage !== 'dashboard') navigate('dashboard');
          requestAnimationFrame(() => {
            $('verseText')?.closest('.verse-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
          // Refresh first so we know whether today is already marked
          // (markStreakRead() does nothing when the button is disabled).
          await loadStreak();
          await markStreakRead();
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

function triggerStreakCelebration(cardEl) {
  if (!cardEl) cardEl = $('streakCard');
  if (cardEl) {
    cardEl.classList.remove('streak-celebrate');
    void cardEl.offsetWidth; // force DOM reflow
    cardEl.classList.add('streak-celebrate');
    setTimeout(() => cardEl?.classList.remove('streak-celebrate'), 1000);
  }

  let canvas = document.getElementById('streakConfettiCanvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'streakConfettiCanvas';
    document.body.appendChild(canvas);
  }

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const rect = cardEl ? cardEl.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0 };
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 3;

  const colors = ['#FFE896', '#F5D37B', '#C9A84C', '#FFFFFF', '#E2B94A', '#FFA500'];
  const symbols = ['★', '✦', '✧', '●', '■'];
  const particles = [];
  const particleCount = 42;

  for (let i = 0; i < particleCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 4 + Math.random() * 8;
    particles.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3.5,
      size: 9 + Math.random() * 9,
      color: colors[Math.floor(Math.random() * colors.length)],
      symbol: symbols[Math.floor(Math.random() * symbols.length)],
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 14,
      alpha: 1,
      decay: 0.015 + Math.random() * 0.018,
      gravity: 0.22,
    });
  }

  let animId;
  const startTime = performance.now();

  function animate(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let active = false;

    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= 0.98;
      p.rotation += p.rotSpeed;
      p.alpha -= p.decay;

      if (p.alpha > 0) {
        active = true;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.fillStyle = p.color;
        ctx.font = `bold ${p.size}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(201, 168, 76, 0.8)';
        ctx.shadowBlur = 8;
        ctx.fillText(p.symbol, 0, 0);
        ctx.restore();
      }
    });

    if (active && now - startTime < 2200) {
      animId = requestAnimationFrame(animate);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cancelAnimationFrame(animId);
    }
  }

  animId = requestAnimationFrame(animate);
}

async function markStreakRead() {
  if ($('markReadBtn').disabled) return;
  haptic('medium');
  try {
    const s = await apiFetch('/api/streaks/mark', { method: 'POST' });
    haptic('success');
    triggerStreakCelebration($('streakCard'));

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
    if (toggle) toggle.checked = true;
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

// A goal whose due date has passed is closed: its tick box is disabled. The
// server enforces the same rule (PATCH /goals/:id), this just reflects it.
// "Today" is Ethiopia's date, matching the server and the nightly missed-goal job.
function isGoalLocked(g) {
  if (!g?.due_date) return false;
  let today;
  try { today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Addis_Ababa' }); }
  catch { today = new Date().toISOString().substring(0, 10); }
  return String(g.due_date).substring(0, 10) < today;
}

function goalCheckboxAttrs(g) {
  return isGoalLocked(g)
    ? { cls: ' is-locked', title: ` title="${t('mentee_goal_locked')}"`, input: 'disabled' }
    : { cls: '', title: '', input: '' };
}

function renderMyGoalItem(g) {
  const missed = !g.is_done && (g.is_missed || isGoalLocked(g));
  const cb = goalCheckboxAttrs(g);
  const due = g.due_date
    ? `<div class="goal-item-due">${t('mentee_goal_due')} ${new Date(g.due_date).toLocaleDateString()}${missed ? ` <span class="goal-missed-badge">${t('mentee_goal_missed')}</span>` : ''}</div>`
    : '';
  return `
    <div class="my-goal-item ${g.is_done ? 'done' : ''} ${missed ? 'missed' : ''}" data-goal-id="${g.id}">
      <label class="premium-checkbox${cb.cls}"${cb.title}>
        <input type="checkbox" ${g.is_done ? 'checked' : ''} ${cb.input} onchange="toggleMyGoalDone('${g.id}', this.checked)">
        <span class="premium-checkbox-box">
          <svg class="premium-checkbox-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
        </span>
      </label>
      <div class="my-goal-item-title">${escapeHtml(g.title)}${due}</div>
    </div>`;
}

function renderProgressRing(percentage, size = 44) {
  const strokeWidth = 4;
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const cleanPct = Math.min(100, Math.max(0, Math.round(percentage || 0)));
  const offset = circumference - (cleanPct / 100) * circumference;

  return `
    <div class="progress-ring-wrapper" style="width:${size}px;height:${size}px;">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="progress-ring-svg">
        <circle
          class="progress-ring-circle-bg"
          cx="${center}"
          cy="${center}"
          r="${radius}"
          fill="none"
          stroke-width="${strokeWidth}"
        />
        <circle
          class="progress-ring-circle-fill"
          cx="${center}"
          cy="${center}"
          r="${radius}"
          fill="none"
          stroke-width="${strokeWidth}"
          stroke-linecap="round"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${offset}"
        />
      </svg>
      <span class="progress-ring-text">${cleanPct}%</span>
    </div>
  `;
}

function updateMyGoalsProgressBar() {
  const { total, done, pct } = myGoalsProgress();
  const track = $('myGoalsProgressTrack');
  const label = $('myGoalsProgressLabel');
  if (track) track.innerHTML = renderProgressRing(pct, 44);
  if (label) label.textContent = t('my_goals_progress_label', { done, total });
}

async function loadMyGoalsWidget() {
  const card = $('myGoalsCard');
  const list = $('myGoalsList');
  if (!card || !list || !currentUser?.telegram_id) return;
  if (window.HolyGoals) return window.HolyGoals.mountMentee(card, list); // goals v2 (goals.js)
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

let mentorsCache = [];
let mentorActiveTopicId = '';
let mentorActiveTab = 'browse';
let hasActiveMentorState = false;
let savedMentorsSet = new Set();
try {
  const savedArr = JSON.parse(localStorage.getItem('holy_saved_mentors') || '[]');
  savedMentorsSet = new Set(savedArr.map(String));
} catch (e) {
  savedMentorsSet = new Set();
}

function toggleSaveMentor(mentorId) {
  haptic('light');
  const idStr = String(mentorId);
  if (savedMentorsSet.has(idStr)) {
    savedMentorsSet.delete(idStr);
  } else {
    savedMentorsSet.add(idStr);
  }
  try {
    localStorage.setItem('holy_saved_mentors', JSON.stringify([...savedMentorsSet]));
  } catch (e) {}
  updateSavedMentorsBadge();
  renderMentorsList();
}

function updateSavedMentorsBadge() {
  const badge = $('savedMentorsBadge');
  if (!badge) return;
  const count = savedMentorsSet.size;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

// ─── Mentors Filter State & Controller ────────────────────────
let mentorFilters = {
  topic_id: '',
  topic_name: '',
  sex: '',         // '' (All), 'M' (Male), 'F' (Female)
  min_rating: 0,   // 0 (Any), 4.5, 4.0, 3.5
  availability: '',// '' (All), 'available' (Spots open), 'online' (Online now)
  search: ''
};
let mentorModalTempFilters = { ...mentorFilters };
let mentorTopicsCache = [];

function setMentorTab(tab) {
  mentorActiveTab = tab;
  const btnBrowse = $('mentorTabBrowse');
  const btnSaved = $('mentorTabSaved');
  if (btnBrowse) btnBrowse.classList.toggle('active', tab === 'browse');
  if (btnSaved) btnSaved.classList.toggle('active', tab === 'saved');
  renderMentorsList();
}

function handleMentorSearchInput(val) {
  mentorFilters.search = (val || '').trim();
  const clearBtn = $('mentorSearchClearBtn');
  if (clearBtn) {
    clearBtn.style.display = mentorFilters.search.length > 0 ? 'flex' : 'none';
  }
  renderMentorsList();
}

function clearMentorSearch() {
  const input = $('mentorSearchInput');
  if (input) input.value = '';
  handleMentorSearchInput('');
}

function selectMentorMainTopic(topicId, topicName) {
  haptic('selection');
  mentorFilters.topic_id = String(topicId || '');
  mentorFilters.topic_name = topicName || '';
  mentorActiveTopicId = mentorFilters.topic_id;

  const displayLabel = topicName || t('all_topics') || 'All Topics';

  const labelEl = $('mentorMainTopicDropdownLabel');
  if (labelEl) labelEl.textContent = displayLabel;

  const modalLabelEl = $('modalFilterTopicDropdownLabel');
  if (modalLabelEl) modalLabelEl.textContent = displayLabel;

  const modalInput = $('modalFilterTopicSelectedId');
  if (modalInput) modalInput.value = mentorFilters.topic_id;

  // Sync selected styling on both dropdowns
  ['mentorMainTopicDropdownMenu', 'modalFilterTopicDropdownMenu'].forEach(menuId => {
    const menu = $(menuId);
    if (menu) {
      menu.querySelectorAll('.dropdown-item').forEach(btn => {
        btn.classList.toggle('selected', String(btn.dataset.value || '') === String(mentorFilters.topic_id));
      });
    }
  });

  $('mentorMainTopicDropdown')?.removeAttribute('data-open');
  $('modalFilterTopicDropdown')?.removeAttribute('data-open');

  syncMentorTopicChips();
  updateFilterActiveIndicators();
  renderMentorsList();
}

function updateFilterActiveIndicators() {
  // keep the topic dropdown label in the current language after an EN/AM switch
  { const lbl = topicFilterLabel(mentorFilters);
    ['mentorMainTopicDropdownLabel', 'modalFilterTopicDropdownLabel'].forEach(id => { const el = $(id); if (el) el.textContent = lbl; }); }
  const isTopicActive = !!mentorFilters.topic_id;
  const isSexActive = !!mentorFilters.sex;
  const isRatingActive = Number(mentorFilters.min_rating) > 0;
  const isAvailActive = !!mentorFilters.availability;
  const hasActiveFilters = isSexActive || isRatingActive || isAvailActive;  // topic lives in the chip row

  // Filter button active badge
  const dot = $('mentorFilterActiveDot');
  const filterBtn = $('mentorFilterBtn');
  if (dot) dot.style.display = hasActiveFilters ? 'block' : 'none';
  if (filterBtn) filterBtn.classList.toggle('active', hasActiveFilters);

  // Active filter tags bar
  const tagsBar = $('mentorActiveFiltersBar');
  const tagsContainer = $('mentorActiveFilterTags');
  if (tagsBar && tagsContainer) {
    if (!hasActiveFilters) {
      tagsBar.style.display = 'none';
      tagsContainer.innerHTML = '';
      return;
    }

    tagsBar.style.display = 'flex';
    let tagsHtml = '';

    if (isSexActive) {
      const sexName = mentorFilters.sex === 'M' ? (t('sex_male') || 'Male') : (t('sex_female') || 'Female');
      tagsHtml += `
        <span class="active-filter-tag-pill" onclick="removeMentorFilter('sex')">
          <span>${sexName}</span>
          <span class="pill-x">✕</span>
        </span>`;
    }
    if (isRatingActive) {
      tagsHtml += `
        <span class="active-filter-tag-pill" onclick="removeMentorFilter('rating')">
          <span>★ ${mentorFilters.min_rating}+</span>
          <span class="pill-x">✕</span>
        </span>`;
    }
    if (isAvailActive) {
      const availName = mentorFilters.availability === 'available'
        ? (t('filter_spots_open_only') || 'Spots Open')
        : (t('filter_online_only') || 'Online');
      tagsHtml += `
        <span class="active-filter-tag-pill" onclick="removeMentorFilter('availability')">
          <span>${availName}</span>
          <span class="pill-x">✕</span>
        </span>`;
    }

    tagsContainer.innerHTML = tagsHtml;
  }
}

function removeMentorFilter(key) {
  haptic('light');
  if (key === 'topic') {
    selectMentorMainTopic('', '');
    return;
  }
  if (key === 'sex') mentorFilters.sex = '';
  if (key === 'rating') mentorFilters.min_rating = 0;
  if (key === 'availability') mentorFilters.availability = '';

  updateFilterActiveIndicators();
  renderMentorsList();
}

function resetAllMentorFilters() {
  haptic('light');
  mentorFilters.topic_id = '';
  mentorFilters.topic_name = '';
  mentorFilters.sex = '';
  mentorFilters.min_rating = 0;
  mentorFilters.availability = '';
  mentorActiveTopicId = '';
  syncMentorTopicChips();

  updateFilterActiveIndicators();
  renderMentorsList();
}

// ─── Filter Modal Dialog ──────────────────────────────────────
function openMentorFilterModal() {
  haptic('light');
  mentorModalTempFilters = { ...mentorFilters };

  // Sync Topic in modal dropdown
  const displayLabel = topicFilterLabel(mentorModalTempFilters);
  const modalLabelEl = $('modalFilterTopicDropdownLabel');
  if (modalLabelEl) modalLabelEl.textContent = displayLabel;

  const modalInput = $('modalFilterTopicSelectedId');
  if (modalInput) modalInput.value = mentorModalTempFilters.topic_id || '';

  // Sync Sex pills
  $$('#modalFilterSexGrid .filter-pill-btn').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.value || '') === (mentorModalTempFilters.sex || ''));
  });

  // Sync Rating pills
  $$('#modalFilterRatingGrid .filter-pill-btn').forEach(btn => {
    btn.classList.toggle('active', String(btn.dataset.value || '0') === String(mentorModalTempFilters.min_rating || 0));
  });

  // Sync Availability pills
  $$('#modalFilterAvailGrid .filter-pill-btn').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.value || '') === (mentorModalTempFilters.availability || ''));
  });

  $('modalFilterTopicDropdown')?.removeAttribute('data-open');
  $('mentorFilterModal')?.classList.add('open');
}

function closeMentorFilterModal() {
  haptic('light');
  $('modalFilterTopicDropdown')?.removeAttribute('data-open');
  $('mentorFilterModal')?.classList.remove('open');
}

function setFilterSex(val) {
  haptic('selection');
  mentorModalTempFilters.sex = val || '';
  $$('#modalFilterSexGrid .filter-pill-btn').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.value || '') === (mentorModalTempFilters.sex || ''));
  });
}

function setFilterRating(val) {
  haptic('selection');
  mentorModalTempFilters.min_rating = Number(val) || 0;
  $$('#modalFilterRatingGrid .filter-pill-btn').forEach(btn => {
    btn.classList.toggle('active', String(btn.dataset.value || '0') === String(mentorModalTempFilters.min_rating));
  });
}

function setFilterAvailability(val) {
  haptic('selection');
  mentorModalTempFilters.availability = val || '';
  $$('#modalFilterAvailGrid .filter-pill-btn').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.value || '') === (mentorModalTempFilters.availability || ''));
  });
}

function resetMentorFiltersInModal() {
  haptic('light');
  mentorModalTempFilters = {
    topic_id: '',
    topic_name: '',
    sex: '',
    min_rating: 0,
    availability: '',
    search: mentorFilters.search
  };

  const modalLabelEl = $('modalFilterTopicDropdownLabel');
  if (modalLabelEl) modalLabelEl.textContent = t('all_topics') || 'All Topics';

  const modalInput = $('modalFilterTopicSelectedId');
  if (modalInput) modalInput.value = '';

  $$('#modalFilterSexGrid .filter-pill-btn').forEach(btn => {
    btn.classList.toggle('active', !btn.dataset.value);
  });
  $$('#modalFilterRatingGrid .filter-pill-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === '0');
  });
  $$('#modalFilterAvailGrid .filter-pill-btn').forEach(btn => {
    btn.classList.toggle('active', !btn.dataset.value);
  });
}

function applyMentorFiltersFromModal() {
  haptic('medium');
  mentorFilters = { ...mentorModalTempFilters };
  mentorActiveTopicId = mentorFilters.topic_id;

  const displayLabel = topicFilterLabel(mentorFilters);
  const labelEl = $('mentorMainTopicDropdownLabel');
  if (labelEl) labelEl.textContent = displayLabel;

  closeMentorFilterModal();
  updateFilterActiveIndicators();
  renderMentorsList();
}

function renderHaloAvatar(m, letter, isOnline = false, percent = 0, isAccepting = true) {
  const safeLetter = escapeHtml(letter || '?');
  const r = 25;
  const c = 2 * Math.PI * r; // ~157.08
  const pct = Math.min(Math.max(percent, 0), 1);
  const isFull = pct >= 1;
  const strokeColor = !isAccepting ? 'rgba(201, 168, 76, 0.2)' : (isFull ? 'rgba(255,255,255,0.2)' : 'var(--gold, #CBA05C)');
  const dashoffset = c * (1 - pct);

  const photoAttr = m?.photo_file_id
    ? `data-avatar-tid="${m.telegram_id}" data-avatar-v="${m.photo_updated_at || ''}" onclick="viewAvatar(this)"`
    : '';
  const hasPhotoClass = m?.photo_file_id ? 'has-photo' : '';

  return `
    <div class="halo-avatar">
      <svg class="halo-ring" viewBox="0 0 60 60">
        <circle cx="30" cy="30" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2.2" />
        <circle cx="30" cy="30" r="${r}" fill="none" stroke="${strokeColor}" stroke-width="2.2" stroke-linecap="round"
          stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${dashoffset.toFixed(2)}"
          transform="rotate(-90 30 30)" />
      </svg>
      <div class="halo-inner ${hasPhotoClass}" ${photoAttr}>
        ${safeLetter}
      </div>
      ${isOnline ? '<div class="halo-online-dot"></div>' : ''}
    </div>`;
}

function renderModernRating(rating, count) {
  if (!count || !rating || count <= 0) {
    return `
      <div class="mentor-stats-row">
        <span class="no-rating">${t('no_ratings_yet') || 'No ratings yet'}</span>
      </div>`;
  }
  const r = Math.round(rating);
  let svgs = '';
  for (let n = 1; n <= 5; n++) {
    const fill = n <= r ? 'var(--gold-light, #F0D9A6)' : 'rgba(255,255,255,0.14)';
    svgs += `<svg width="12" height="12" viewBox="0 0 24 24" fill="${fill}" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  }
  // One horizontal line: stars, score, review count. Never wraps (the count
  // is the part that shortens with an ellipsis on a very narrow card).
  return `
    <div class="mentor-stats-row">
      <div class="mentor-stats-stars">${svgs}</div>
      <span class="mentor-rating-val">${Number(rating).toFixed(1)}</span>
      <span class="mentor-reviews-count"><span class="rc-full">${count === 1 ? t('reviews_count_one') : t('reviews_count', { n: count })}</span><span class="rc-short">(${count})</span></span>
    </div>`;
}

// Small stroke-style hourglass icon for the Pending button state.
const MENTOR_ICON_PENDING = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px"><path d="M6 3h12M6 21h12M6 3c0 5 4 6 6 9-2 3-6 4-6 9M18 3c0 5-4 6-6 9 2 3 6 4 6 9"/></svg>';

// ─── Mentors Loader ───────────────────────────────────────────
async function loadMentors() {
  const container = $('mentorsList');
  if (container) container.innerHTML = mentorSkeletonHTML(4);
  updateSavedMentorsBadge();

  try {
    hasActiveMentorState = false;
    activeMentorData = null;
    myMentorTopicIds = new Set();
    const activeContainer = $('activeMentorContainer');
    if (activeContainer) activeContainer.innerHTML = '';

    const isMentee = currentUser?.role === 'user';
    // Three independent requests, run together so the skeleton is up for one
    // round-trip instead of three.
    const [amRes, myTopics, list] = await Promise.all([
      isMentee
        ? apiFetch('/api/users/my-mentor').catch(err => { console.error('Error fetching active mentor:', err); return null; })
        : null,
      isMentee ? apiFetch('/api/topics/my').catch(() => []) : [],
      apiFetch('/api/mentors'),
    ]);

    if (amRes && amRes.mentor) {
      hasActiveMentorState = true;
      activeMentorData = amRes.mentor;
    }
    myMentorTopicIds = new Set((myTopics || []).map(x => Number(x.topic_id)));
    mentorsCache = list || [];

    renderActiveMentorCard();
    renderMentorsList();
  } catch (e) {
    if (container) container.innerHTML = `<div class="empty-state"><span>${escapeHtml(e.message)}</span></div>`;
  }
}

// ─── Mentors page helpers ─────────────────────────────────────
let myMentorTopicIds = new Set();   // topics the mentee picked; drives the match badge + sort
let activeMentorData = null;        // /api/users/my-mentor payload, if any

function mentorSkeletonHTML(n = 4) {
  return Array.from({ length: n }, () => '<div class="mc-skel" aria-hidden="true"></div>').join('');
}

function mentorNameOf(m) {
  return m.user_settings?.display_name || m.anonymous_id || '';
}

function mentorMax(m) {
  return m.user_settings?.max_mentees || 5;
}

// pending > paused > full > open. "pending" wins so a mentor you already
// asked never reads as unavailable.
function mentorState(m) {
  if (m.request_pending) return 'pending';
  if (m.accepting_requests === false) return 'paused';
  if ((m.mentee_count || 0) >= mentorMax(m)) return 'full';
  return 'open';
}

function isMentorUnavailable(m) {
  const s = mentorState(m);
  return s === 'paused' || s === 'full';
}

// How many of the mentor's topics are also the mentee's own topics.
function mentorMatchCount(m) {
  if (currentUser?.role !== 'user' || !myMentorTopicIds.size) return 0;
  return (m.topics || []).filter(tp => myMentorTopicIds.has(Number(tp.id))).length;
}

function mentorStatus(m) {
  const mentees = m.mentee_count || 0;
  if (m.accepting_requests === false) return { cls: 'paused', text: t('status_paused') };
  if (mentees >= mentorMax(m)) return { cls: 'full', text: t('fully_booked') };
  const open = Math.max(mentorMax(m) - mentees, 0);
  return { cls: '', text: open === 1 ? t('spot_open_one') : t('spots_open_n', { open }) };
}

function findMentorById(id) {
  const cached = (mentorsCache || []).find(x => String(x.telegram_id) === String(id));
  if (activeMentorData && String(activeMentorData.telegram_id) === String(id)) {
    return { ...activeMentorData, ...(cached || {}) };
  }
  return cached || null;
}

function mentorBioInline(bio) {
  const LIMIT = 100;
  if (bio.length <= LIMIT + 5) return escapeHtml(bio);
  const cut = bio.slice(0, LIMIT).replace(/\s+\S*$/, '');
  return `${escapeHtml(cut)}… <span class="mc-more">${t('btn_more')}</span>`;
}

// Card sub line: the mentor's specialization only. Their topics are in the
// full profile sheet, so repeating them here just crowded the card.
function mentorSubLine(m) {
  const spec = (m.user_settings?.specialization || '').trim();
  return spec ? `<div class="mc-sub">${escapeHtml(spec)}</div>` : '';
}

function mentorActionHtml(m, inSheet = false) {
  if (currentUser?.role === 'mentor') return '';
  const sz = inSheet ? '' : ' btn-sm';
  const id = m.telegram_id;
  switch (mentorState(m)) {
    case 'pending':
      return `<button class="btn btn-outline${sz} btn-pending" disabled>${MENTOR_ICON_PENDING} ${t('btn_waiting')}</button>`;
    case 'paused':
      return `<button class="btn btn-outline${sz} btn-not-accepting" disabled>${t('not_accepting')}</button>`;
    case 'full':
      return m.on_waitlist
        ? `<button class="btn btn-ghost${sz}" onclick="toggleMentorWaitlist(event, ${id})">${t('btn_on_waitlist')}</button>`
        : `<button class="btn btn-outline${sz}" onclick="toggleMentorWaitlist(event, ${id})">${t('btn_notify_me')}</button>`;
    default:
      return `<button class="btn btn-primary${sz} btn-mentor-request" data-mentor-name="${escapeHtml(mentorNameOf(m))}"
        onclick="${inSheet ? 'closeMentorSheet();' : ''}handleMentorRequestClick(event, '${id}')" ${hasActiveMentorState ? 'disabled' : ''}>${t('btn_request')}</button>`;
  }
}

const MC_ICON_MSG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const MC_ICON_BOOKMARK = (filled) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;

const MC_ICON_BOOK = '<svg class="mc-spec-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
const MC_ICON_USER = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
const MC_ICON_CHEV = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

function mentorMatchBadge(n) {
  return n ? `<div class="mc-match">✦ ${t('match_topics', { n })}</div>` : '';
}

function mentorCardHtml(m) {
  const id = m.telegram_id;
  const name = mentorNameOf(m);
  const bio = m.user_settings?.bio || t('mentor_default_bio');
  const unavailable = isMentorUnavailable(m);
  const isAccepting = m.accepting_requests !== false;
  const max = mentorMax(m);
  const pct = max > 0 ? (m.mentee_count || 0) / max : 0;
  const isSaved = savedMentorsSet.has(String(id));
  const st = mentorStatus(m);
  const halo = renderHaloAvatar(m, name.charAt(0).toUpperCase(), !!m.is_online, isAccepting ? pct : 1, isAccepting);

  const spec = (m.user_settings?.specialization || '').trim();
  const matchHtml = unavailable ? '' : mentorMatchBadge(mentorMatchCount(m));

  return `
    <div class="mc-card ${unavailable ? 'muted' : ''}" data-mentor-id="${id}" onclick="mentorCardClick(event, ${id})">
      <div class="mc-top">
        ${halo}
        <div class="mc-main">
          <div class="mc-name">${escapeHtml(name)}</div>
          ${renderModernRating(m.rating || null, m.rating_count || 0)}
        </div>
        <div class="mc-icons">
          <button class="mc-icon-btn ${isSaved ? 'saved' : ''}" onclick="toggleSaveMentor(${id})" aria-label="${t('tab_saved')}">${MC_ICON_BOOKMARK(isSaved)}</button>
          <button class="mc-icon-btn" onclick="openChat('${id}')" aria-label="${t('btn_message')}">${MC_ICON_MSG}</button>
        </div>
      </div>
      <div class="mc-body">
        ${spec ? `<div class="mc-spec">${MC_ICON_BOOK}<span>${escapeHtml(spec)}</span></div>` : ''}
        <p class="mc-bio">${mentorBioInline(bio)}</p>
      </div>
      <div class="mc-meta">
        <span class="mc-status ${st.cls}">${st.text}</span>
        ${matchHtml}
      </div>
      <div class="mc-footer">
        <button type="button" class="mc-view" onclick="openMentorSheet(${id})">
          <span class="mc-view-ico">${MC_ICON_USER}</span>
          <span class="mc-view-label">${t('btn_view_profile')}</span>
          <span class="mc-view-arrow">${MC_ICON_CHEV}</span>
        </button>
        ${mentorActionHtml(m)}
      </div>
    </div>`;
}

// Tap anywhere on the card opens the profile sheet, except on the small
// buttons and the avatar (which opens the photo viewer).
function mentorCardClick(event, id) {
  if (event.target.closest('button, a, [data-avatar-tid]')) return;
  openMentorSheet(id);
}

function renderActiveMentorCard() {
  const c = $('activeMentorContainer');
  if (!c) return;
  const am = activeMentorData;
  if (!am) { c.innerHTML = ''; return; }
  const name = mentorNameOf(am);
  const halo = renderHaloAvatar(am, name.charAt(0).toUpperCase(), !!am.is_online, 1, true);
  c.innerHTML = `
    <div class="mc-mine" onclick="mentorCardClick(event, ${am.telegram_id})">
      <div class="mc-eyebrow">${t('your_mentor_label')}<span>● ${t('active_mentorship_label')}</span></div>
      <div class="mc-top">
        ${halo}
        <div class="mc-main">
          <div class="mc-name">${escapeHtml(name)}</div>
          ${renderModernRating(am.rating || null, am.rating_count || 0)}
          <div class="mc-online">${am.is_online ? t('status_online') : t('status_offline')}</div>
        </div>
      </div>
      <div class="mc-mine-actions">
        <button class="btn btn-primary btn-sm" onclick="openChat('${am.telegram_id}')">${t('btn_message')}</button>
        <button class="btn btn-danger btn-sm" onclick="confirmEndMentorship()">${t('btn_end')}</button>
      </div>
    </div>`;
  hydrateAvatars(c);
}

// ─── Mentor full profile page ─────────────────────────────────
// Same visual language as the Profile page: gold glow, framed avatar, pill
// chips, gold segmented tabs, stacked rounded cards. (Was a bottom sheet.)
let openMentorSheetId = null;       // id of the mentor whose profile page is open
let mentorProfileTab = 'about';     // 'about' | 'topics'
let mentorsListScrollTop = 0;       // remembered so Back lands where you left

const MP_ICONS = {
  user:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  star:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  tag:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
  cake:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  people:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  book:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'
};

function mpInfoCard({ icon, label, text, gold = false, duo = false, trailing = '', iconClass = '' }) {
  return `
    <div class="profile-menu-item mp-info${gold ? ' pm-gold' : ''}${duo ? ' mp-info-duo' : ''}">
      <span class="profile-menu-icon ${iconClass}">${icon}</span>
      <span class="mp-info-body">
        <span class="mp-info-label">${escapeHtml(label)}</span>
        <span class="mp-info-text">${escapeHtml(text)}</span>
      </span>
      ${trailing}
    </div>`;
}

function renderMentorProfilePage(id) {
  const body = $('mentorProfileBody');
  const m = findMentorById(id);
  if (!body || !m) return;

  const isMine = !!activeMentorData && String(activeMentorData.telegram_id) === String(id);
  const name = mentorNameOf(m);
  const bio = m.user_settings?.bio || t('mentor_default_bio');
  const spec = (m.user_settings?.specialization || '').trim();
  const topics = (m.topics && m.topics.length)
    ? m.topics.map(x => ({ id: x.id, name: x.name, name_am: x.name_am }))
    : (m.expertise_topics || []).map(nm => ({ id: null, name: nm }));
  const st = mentorStatus(m);
  const n = (isMine || isMentorUnavailable(m)) ? 0 : mentorMatchCount(m);
  const sexLabel = m.sex === 'M' ? t('sex_male') : m.sex === 'F' ? t('sex_female') : '—';
  const max = mentorMax(m);
  const open = Math.max(max - (m.mentee_count || 0), 0);
  const ratingNum = Number(m.rating) || 0;
  const ratingCount = Number(m.rating_count) || 0;
  const isSaved = savedMentorsSet.has(String(id));
  const photoAttr = m.photo_file_id
    ? `data-avatar-tid="${m.telegram_id}" data-avatar-v="${m.photo_updated_at || ''}" onclick="viewAvatar(this)"`
    : '';
  const tab = (mentorProfileTab === 'topics' && topics.length) ? 'topics' : 'about';

  // header bookmark (lives in the static header)
  const saveBtn = $('mpSaveBtn');
  if (saveBtn) {
    saveBtn.classList.toggle('saved', isSaved);
    saveBtn.setAttribute('aria-label', t('tab_saved'));
    saveBtn.innerHTML = MC_ICON_BOOKMARK(isSaved);
    saveBtn.style.display = isMine ? 'none' : '';
  }

  const actions = isMine
    ? `<button class="btn btn-outline" onclick="openChat('${id}')">${MC_ICON_MSG} ${t('btn_message')}</button>
       <button class="btn btn-danger" onclick="confirmEndMentorship()">${t('btn_end')}</button>`
    : `<button class="btn btn-outline" onclick="openChat('${id}')">${MC_ICON_MSG} ${t('btn_message')}</button>
       ${mentorActionHtml(m, true)}`;

  const aboutCards = mpInfoCard({ icon: MP_ICONS.user, label: t('sheet_about'), text: bio, gold: true });

  const topicCards = topics.map(tp => {
    const mine = tp.id != null && myMentorTopicIds.has(Number(tp.id));
    return `
      <div class="profile-menu-item mp-info mp-topic${mine ? ' pm-gold' : ''}">
        <span class="profile-menu-icon">${mine ? MP_ICONS.check : MP_ICONS.tag}</span>
        <span class="profile-menu-label">${escapeHtml(topicLabel(tp))}</span>
        ${mine ? `<span class="mp-mine-chip">${t('mp_matches_you')}</span>` : ''}
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="profile-hero mp-hero">
      <div class="avatar-preview-wrap">
        <div class="avatar-preview avatar-preview-xl" ${photoAttr}>${escapeHtml(name.charAt(0).toUpperCase())}</div>
        ${m.is_online ? '<span class="mp-online-dot"></span>' : ''}
      </div>
      <div class="profile-hero-name">${escapeHtml(name)}</div>
      <div class="profile-hero-rating" style="display:flex">${renderProfileRating(ratingNum, ratingCount)}</div>
    </div>

    <nav class="profile-menu-list mp-panel" aria-label="${escapeHtml(t('mp_label_status'))}">
      <div class="mp-duo">
        ${mpInfoCard({ icon: MP_ICONS.pulse, label: t('mp_label_status'), text: m.is_online ? t('status_online') : t('status_offline'), duo: true, iconClass: m.is_online ? 'mp-ok' : '' })}
        ${mpInfoCard({ icon: MP_ICONS.people, label: t('mp_label_availability'), text: isMine ? t('active_mentorship_label') : st.text, duo: true })}
      </div>
      ${spec ? mpInfoCard({ icon: MP_ICONS.book, label: t('sheet_specialization'), text: spec }) : ''}
      ${n ? mpInfoCard({ icon: MP_ICONS.spark, label: t('mp_matches_you'), text: t('match_topics', { n }), gold: true }) : ''}
    </nav>

    <div class="mp-actions">${actions}</div>

    <div class="mp-stats">
      <div class="stat-card"><div class="stat-num">${ratingNum > 0 ? ratingNum.toFixed(1) : '—'}</div><div class="stat-label">${t('mp_stat_rating')}</div></div>
      <div class="stat-card"><div class="stat-num">${ratingCount}</div><div class="stat-label">${t('mp_stat_reviews')}</div></div>
      <div class="stat-card"><div class="stat-num">${m.mentee_count || 0}<span class="mp-stat-of">/${max}</span></div><div class="stat-label">${t('mp_stat_mentees')}</div></div>
    </div>

    ${topics.length ? `
    <div class="profile-tabs" role="tablist">
      <button type="button" id="mpTabAbout" class="profile-tab${tab === 'about' ? ' active' : ''}" role="tab" aria-selected="${tab === 'about'}" onclick="switchMentorProfileTab('about')">
        ${MP_ICONS.user.replace('<svg ', '<svg width="18" height="18" ')}<span>${t('sheet_about')}</span>
      </button>
      <button type="button" id="mpTabTopics" class="profile-tab${tab === 'topics' ? ' active' : ''}" role="tab" aria-selected="${tab === 'topics'}" onclick="switchMentorProfileTab('topics')">
        ${MP_ICONS.tag.replace('<svg ', '<svg width="18" height="18" ')}<span>${t('sheet_topics')}</span>
      </button>
    </div>` : ''}

    <div id="mpPaneAbout" class="profile-pane${tab === 'about' ? ' active' : ''}">
      <nav class="profile-menu-list" aria-label="${escapeHtml(t('sheet_about'))}">
        ${aboutCards}
        <div class="mp-duo">
          ${mpInfoCard({ icon: MP_ICONS.cake, label: t('sheet_age'), text: m.age_range || '—', duo: true })}
          ${mpInfoCard({ icon: MP_ICONS.people, label: t('sheet_gender'), text: sexLabel, duo: true })}
        </div>
      </nav>
    </div>

    ${topics.length ? `
    <div id="mpPaneTopics" class="profile-pane${tab === 'topics' ? ' active' : ''}">
      <nav class="profile-menu-list" aria-label="${escapeHtml(t('sheet_topics'))}">${topicCards}</nav>
    </div>` : ''}
  `;
  hydrateAvatars(body);
}

function switchMentorProfileTab(tab) {
  haptic('selection');
  mentorProfileTab = tab;
  $('mpTabAbout')?.classList.toggle('active', tab === 'about');
  $('mpTabTopics')?.classList.toggle('active', tab === 'topics');
  $('mpTabAbout')?.setAttribute('aria-selected', tab === 'about');
  $('mpTabTopics')?.setAttribute('aria-selected', tab === 'topics');
  $('mpPaneAbout')?.classList.toggle('active', tab === 'about');
  $('mpPaneTopics')?.classList.toggle('active', tab === 'topics');
}

// Switch pages without navigate()'s data loaders: the mentors list stays as it was.
function showAppPageQuiet(page, navId) {
  currentPage = page;
  $$('.page').forEach(p => p.classList.remove('active'));
  $$('.nav-item').forEach(nv => nv.classList.remove('active'));
  $(`page-${page}`)?.classList.add('active');
  $(navId)?.classList.add('active');
  updateFab();
  syncTelegramBack();
}

function openMentorSheet(id) {   // name kept: every "open this mentor" caller still works
  const m = findMentorById(id);
  if (!m || !$('mentorProfileBody')) return;
  haptic('light');
  const alreadyOpen = currentPage === 'mentor-profile';
  if (!alreadyOpen) {
    mentorsListScrollTop = document.querySelector('#page-mentors .page-content')?.scrollTop || 0;
    mentorProfileTab = 'about';
  }
  openMentorSheetId = id;
  renderMentorProfilePage(id);
  if (!alreadyOpen) {
    showAppPageQuiet('mentor-profile', 'nav-mentors');
    const pc = document.querySelector('#page-mentor-profile .page-content');
    if (pc) pc.scrollTop = 0;
  }
}

function closeMentorProfile() {
  if (currentPage !== 'mentor-profile') return;
  haptic('light');
  openMentorSheetId = null;
  showAppPageQuiet('mentors', 'nav-mentors');
  requestAnimationFrame(() => {
    const pc = document.querySelector('#page-mentors .page-content');
    if (pc) pc.scrollTop = mentorsListScrollTop;
  });
}

function toggleSaveMentorFromProfile() {
  if (openMentorSheetId != null) toggleSaveMentor(openMentorSheetId);  // re-renders the page too
}

// Only the small "end mentorship?" confirmation still uses the sheet.
function closeMentorSheet() {
  $('mentorSheet')?.classList.remove('open');
}

function confirmEndMentorship() {
  const body = $('mentorSheetBody');
  if (!body || !activeMentorData) return;
  haptic('light');
  body.innerHTML = `
    <div class="hb-confirm">
      <div class="hb-icon danger">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="11" x2="23" y2="11"/></svg>
      </div>
      <div class="modal-title">${escapeHtml(t('end_mentorship_title', { name: mentorNameOf(activeMentorData) }))}</div>
      <p class="hb-text">${t('end_mentorship_body')}</p>
      <div class="hb-actions">
        <button class="btn btn-outline" onclick="closeMentorSheet()">${t('btn_keep_mentor')}</button>
        <button class="btn btn-danger" onclick="closeMentorSheet();endMentorship(null, true)">${t('btn_end')}</button>
      </div>
    </div>`;
  $('mentorSheet')?.classList.add('open');
}

// "Notify me" on a full mentor: join/leave the waitlist. Optimistic, rolled
// back if the request fails.
async function toggleMentorWaitlist(event, mentorId) {
  event?.stopPropagation();
  haptic('light');
  const m = (mentorsCache || []).find(x => String(x.telegram_id) === String(mentorId));
  if (!m) return;
  const joining = !m.on_waitlist;
  const refresh = () => {
    renderMentorsList();   // also redraws the profile page when it is open
  };
  m.on_waitlist = joining;
  refresh();
  try {
    if (joining) await apiFetch('/api/mentors/waitlist', { method: 'POST', body: { mentor_id: m.telegram_id } });
    else await apiFetch(`/api/mentors/waitlist/${m.telegram_id}`, { method: 'DELETE' });
    showToast(t(joining ? 'waitlist_joined' : 'waitlist_left'), 'success');
  } catch (e) {
    m.on_waitlist = !joining;
    refresh();
    haptic('error');
    showToast(e.message, 'error');
  }
}

function renderMentorsList() {
  // Keep an open mentor profile page in sync (saved / waitlist / request state).
  if (currentPage === 'mentor-profile' && openMentorSheetId != null) renderMentorProfilePage(openMentorSheetId);
  const container = $('mentorsList');
  if (!container) return;

  const countBadge = $('mentorsAvailableCount');
  const query = (mentorFilters.search || '').trim().toLowerCase();
  const selectedTopic = mentorFilters.topic_id;
  const selectedSex = mentorFilters.sex;
  const minRating = Number(mentorFilters.min_rating) || 0;
  const availability = mentorFilters.availability;

  // The active-mentor card only belongs on the Browse tab.
  const activeContainer = $('activeMentorContainer');
  if (activeContainer) {
    activeContainer.style.display = (hasActiveMentorState && mentorActiveTab === 'browse') ? 'block' : 'none';
  }
  const activeId = activeMentorData ? String(activeMentorData.telegram_id) : null;

  const filtered = (mentorsCache || []).filter(m => {
    // Your own mentor already has the pinned card above the list.
    if (activeId && String(m.telegram_id) === activeId) return false;

    if (query) {
      const name = (m.user_settings?.display_name || m.anonymous_id || '').toLowerCase();
      const bio = (m.user_settings?.bio || '').toLowerCase();
      const spec = (m.user_settings?.specialization || '').toLowerCase();
      const topics = ((m.topics && m.topics.length) ? m.topics.map(x => `${x.name || ''} ${x.name_am || ''}`) : (m.expertise_topics || [])).join(' ').toLowerCase();
      if (!(name.includes(query) || bio.includes(query) || spec.includes(query) || topics.includes(query))) return false;
    }
    if (selectedTopic) {
      const topicMatches = (m.topics || []).some(tp => String(tp.id) === String(selectedTopic)) ||
                           (m.topic_ids || []).map(String).includes(String(selectedTopic));
      if (!topicMatches) return false;
    }
    if (selectedSex && m.sex !== selectedSex) return false;
    if (minRating > 0 && (Number(m.rating) || 0) < minRating) return false;
    if (availability === 'available') {
      if (mentorState(m) === 'paused' || mentorState(m) === 'full') return false;
    } else if (availability === 'online') {
      if (!m.is_online) return false;
    }
    return true;
  });

  const listToShow = (mentorActiveTab === 'saved'
    ? filtered.filter(m => savedMentorsSet.has(String(m.telegram_id)))
    : filtered
  ).slice().sort((a, b) =>
    (isMentorUnavailable(a) - isMentorUnavailable(b)) ||        // Full / Paused sink
    (mentorMatchCount(b) - mentorMatchCount(a)) ||               // best topic match first
    ((Number(b.rating) || 0) - (Number(a.rating) || 0)) ||
    ((b.rating_count || 0) - (a.rating_count || 0))
  );

  if (countBadge) {
    const countText = t('mentors_available_count', { count: listToShow.length });
    countBadge.textContent = hasActiveMentorState ? `${countText} · ${t('requests_paused_note')}` : countText;
  }

  if (!listToShow.length) {
    if (mentorActiveTab === 'saved') {
      container.innerHTML = `
        <div style="text-align:center;padding:48px 12px;color:var(--text3)">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:10px">
            <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path>
          </svg>
          <p style="font-size:var(--fs-md);color:var(--gold-light);margin:0 0 4px;font-weight:600">${t('no_saved_mentors_title')}</p>
          <p style="font-size:var(--fs-xs);margin:0;line-height:1.5">${t('no_saved_mentors_desc')}</p>
        </div>`;
    } else {
      let message = 'No mentors found with active filters';
      if (query) message = `No mentors matching "${escapeHtml(query)}"`;
      container.innerHTML = `
        <div class="empty-state" style="padding:40px 16px;text-align:center;">
          <p style="color:var(--text2);margin-bottom:12px;">${escapeHtml(message)}</p>
          <button class="btn btn-outline btn-sm" onclick="resetAllMentorFilters()">${t('btn_reset')}</button>
        </div>`;
    }
    return;
  }

  const cardHtmls = listToShow.map(mentorCardHtml);

  // Long lists paint an initial batch right away and stream the rest in, so
  // older phones stay responsive (same approach as before).
  const BATCH_THRESHOLD = 15;
  const BATCH_SIZE = 10;

  function finishMentorsRender() {
    applyLanguage();
    hydrateAvatars(container);
  }

  if (cardHtmls.length <= BATCH_THRESHOLD) {
    container.innerHTML = cardHtmls.join('');
    finishMentorsRender();
  } else {
    container.innerHTML = cardHtmls.slice(0, BATCH_SIZE).join('');
    finishMentorsRender();

    let i = BATCH_SIZE;
    (function renderNextBatch() {
      if (i >= cardHtmls.length) return;
      requestAnimationFrame(() => {
        container.insertAdjacentHTML('beforeend', cardHtmls.slice(i, i + BATCH_SIZE).join(''));
        i += BATCH_SIZE;
        finishMentorsRender();
        renderNextBatch();
      });
    })();
  }
}

// Topic chip row: "All" + one chip per topic. Built once; selection only
// toggles the active class so the row doesn't jump back to the start.
async function loadMentorTopics() {
  try {
    mentorTopicsCache = await apiFetch('/api/topics') || [];
    renderMentorTopicChips();
  } catch (e) {
    console.error('Failed to load topics for filter:', e);
  }
}

function renderMentorTopicChips() {
  const row = $('mentorTopicChips');
  if (!row) return;
  const chip = (id, label) =>
    `<button type="button" class="mc-chip" data-id="${escapeHtml(String(id))}" data-name="${escapeHtml(id === '' ? '' : label)}"
      onclick="selectMentorMainTopic(this.dataset.id, this.dataset.name)">${escapeHtml(label)}</button>`;
  row.innerHTML = chip('', t('mentor_chip_all')) + (mentorTopicsCache || []).map(tp => chip(tp.id, topicLabel(tp))).join('');
  syncMentorTopicChips();
}

function syncMentorTopicChips() {
  const row = $('mentorTopicChips');
  if (!row) return;
  row.querySelectorAll('.mc-chip').forEach(btn => {
    btn.classList.toggle('active', String(btn.dataset.id) === String(mentorFilters.topic_id || ''));
  });
}

function selectMentorModalTopic(topicId, topicName) {
  haptic('selection');
  mentorModalTempFilters.topic_id = String(topicId || '');
  mentorModalTempFilters.topic_name = topicName || '';

  const displayLabel = topicName || t('all_topics') || 'All Topics';
  const modalLabelEl = $('modalFilterTopicDropdownLabel');
  if (modalLabelEl) modalLabelEl.textContent = displayLabel;

  const modalInput = $('modalFilterTopicSelectedId');
  if (modalInput) modalInput.value = mentorModalTempFilters.topic_id;

  const modalMenu = $('modalFilterTopicDropdownMenu');
  if (modalMenu) {
    modalMenu.querySelectorAll('.dropdown-item').forEach(btn => {
      btn.classList.toggle('selected', String(btn.dataset.value || '') === String(mentorModalTempFilters.topic_id));
    });
  }

  $('modalFilterTopicDropdown')?.removeAttribute('data-open');
}

// ─── Mentorship Request with Premium Topic Picker Modal ─────────
let _rtMentorId = null;
let _rtMentorName = '';
let _rtSelectedTopicId = null;
let _rtSelectedTopicName = '';
let _rtSourceBtn = null;
let _rtSourceBtnHtml = '';
let _userStruggleTopicIds = null;
let _rtTopics = [];

/**
 * Triggered when tapping the "Request" button on a mentor card.
 */
function handleMentorRequestClick(event, mentorId) {
  // If user is currently filtering by a specific topic chip, send request directly with that topic
  if (mentorActiveTopicId) {
    requestMentorship(event, mentorId, mentorActiveTopicId);
    return;
  }

  // Find mentor from cache
  const m = (mentorsCache || []).find(x => String(x.telegram_id) === String(mentorId));
  const mentorName = m?.user_settings?.display_name || m?.anonymous_id || 'Mentor';
  const topics = m?.topics || [];

  // If mentor has 0 topics, request directly
  if (topics.length === 0) {
    requestMentorship(event, mentorId, null);
    return;
  }

  // Open the premium topic selection dropdown modal
  openRequestTopicModal(event, mentorId, topics, mentorName);
}

/**
 * Opens the topic picker modal with a premium dropdown.
 */
async function openRequestTopicModal(event, mentorId, mentorTopics, mentorName) {
  haptic('light');
  _rtMentorId = mentorId;
  _rtMentorName = mentorName || '';
  _rtSourceBtn = event?.currentTarget || null;
  _rtSourceBtnHtml = _rtSourceBtn ? _rtSourceBtn.innerHTML : '';

  // Fetch mentee's struggle topics
  try {
    const myTopics = await apiFetch('/api/topics/my');
    _userStruggleTopicIds = new Set((myTopics || []).map(t => Number(t.topic_id)));
  } catch (e) {
    _userStruggleTopicIds = new Set();
  }

  // Find the first shared topic if available, otherwise default to first mentor topic
  const firstShared = mentorTopics.find(tp => _userStruggleTopicIds.has(Number(tp.id)));
  const defaultTopic = firstShared || mentorTopics[0] || null;

  _rtSelectedTopicId = defaultTopic ? defaultTopic.id : null;
  _rtSelectedTopicName = defaultTopic ? topicLabel(defaultTopic) : '';

  // Update subtitle
  const subtitle = $('requestTopicSubtitle');
  if (subtitle) {
    const raw = t('select_topic_sub') || 'Choose the topic you would like mentorship on with {name}:';
    subtitle.innerHTML = raw.replace('{name}', `<strong>${escapeHtml(mentorName)}</strong>`);
  }

  _rtTopics = mentorTopics.map(tp => ({ id: tp.id, name: tp.name, name_am: tp.name_am }));
  const inputEl = $('requestTopicSelectedId');
  if (inputEl) inputEl.value = defaultTopic ? defaultTopic.id : '';
  renderRequestTopicCards();

  // Update warning visibility
  updateRequestTopicWarning();

  $('requestTopicModal')?.classList.add('open');
}

function updateRequestTopicWarning() {
  const warningEl = $('requestTopicWarning');
  if (!warningEl) return;

  if (_rtSelectedTopicId && _userStruggleTopicIds && !_userStruggleTopicIds.has(Number(_rtSelectedTopicId))) {
    const msg = t('topic_not_in_user_topics', { topic: _rtSelectedTopicName }) || `You did not select "${_rtSelectedTopicName}" in your topics. Please set it in your settings.`;
    warningEl.textContent = msg;
    warningEl.style.display = 'block';
  } else {
    warningEl.style.display = 'none';
  }
}

/**
 * Handles choosing an option from the premium dropdown.
 */
function selectRequestTopicDropdown(topicId) {   // name kept; now picks a card
  haptic('selection');
  const tp = _rtTopics.find(x => String(x.id) === String(topicId));
  _rtSelectedTopicId = topicId;
  _rtSelectedTopicName = tp ? topicLabel(tp) : '';
  const inputEl = $('requestTopicSelectedId');
  if (inputEl) inputEl.value = topicId;
  renderRequestTopicCards();
  updateRequestTopicWarning();
}

// Topic choices as the same stacked cards the Profile page uses. The chosen
// card turns golden; topics the mentee also struggles with carry a gold tag.
function renderRequestTopicCards() {
  const list = $('requestTopicList');
  if (!list) return;
  const tagIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
  list.innerHTML = _rtTopics.map(tp => {
    const sel = String(tp.id) === String(_rtSelectedTopicId);
    const shared = _userStruggleTopicIds && _userStruggleTopicIds.has(Number(tp.id));
    return `
      <button type="button" role="radio" aria-checked="${sel}" class="profile-menu-item rt-topic${sel ? ' pm-gold selected' : ''}" data-value="${tp.id}" onclick="selectRequestTopicDropdown(${tp.id})">
        <span class="profile-menu-icon">${tagIcon}</span>
        <span class="profile-menu-label rt-label">
          <span class="rt-name">${escapeHtml(topicLabel(tp))}</span>
          ${shared ? `<span class="mp-mine-chip">${t('mp_matches_you')}</span>` : ''}
        </span>
        <span class="rt-radio" aria-hidden="true"></span>
      </button>`;
  }).join('');
}

function closeRequestTopicModal() {
  haptic('light');
  $('requestTopicModal')?.classList.remove('open');
  const warningEl = $('requestTopicWarning');
  if (warningEl) warningEl.style.display = 'none';
  _rtMentorId = null;
  _rtMentorName = '';
  _rtSelectedTopicId = null;
  _rtSelectedTopicName = '';
  _rtSourceBtn = null;
  _rtSourceBtnHtml = '';
}

async function confirmMentorshipRequestWithTopic() {
  if (!_rtMentorId || !_rtSelectedTopicId) return;

  // Check if topic is shared in mentee's struggle topics
  if (_userStruggleTopicIds && !_userStruggleTopicIds.has(Number(_rtSelectedTopicId))) {
    haptic('error');
    const msg = t('topic_not_in_user_topics', { topic: _rtSelectedTopicName }) || `You did not select "${_rtSelectedTopicName}" in your topics. Please set it in your settings.`;
    showToast(msg, 'error');
    updateRequestTopicWarning();
    return;
  }

  haptic('medium');

  // Close modal
  $('requestTopicModal')?.classList.remove('open');

  const mentorId = _rtMentorId;
  const topicId = _rtSelectedTopicId;
  const mentorName = _rtMentorName;
  const btn = _rtSourceBtn;
  const originalHtml = _rtSourceBtnHtml;

  // Optimistic update on source button
  if (btn) {
    btn.disabled = true;
    btn.classList.add('btn-pending');
    btn.innerHTML = `${MENTOR_ICON_PENDING} ${t('btn_request_pending')}`;
  }

  // Clear state
  _rtMentorId = null;
  _rtMentorName = '';
  _rtSelectedTopicId = null;
  _rtSelectedTopicName = '';
  _rtSourceBtn = null;
  _rtSourceBtnHtml = '';

  try {
    await apiFetch('/api/mentors/request', {
      method: 'POST',
      body: { mentor_id: mentorId, topic_id: parseInt(topicId, 10), message: 'I would like your mentorship.' }
    });
    haptic('success');
    openMentorRequestSentModal(mentorName);
    loadMentors();
  } catch (e) {
    haptic('error');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('btn-pending');
      btn.innerHTML = originalHtml;
    }
    showToast(e.message, 'error');
  }
}

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
/* ═══════════════════════════════════════════════════════════════
   Requests page: mentee requests + referred mentees
   ═══════════════════════════════════════════════════════════════ */
let _requestsTab = 'mentee';              // 'mentee' | 'referred'
let _requestsTabChosen = false;           // user picked a tab by hand -> never auto-switch
let _reqData = { mentee: [], referred: [] };
let _reqRenderedSig = '';
const _reqBusy = new Set();
let _declineTarget = null;

const REQ_ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const REQ_ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const REQ_ICON_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const REQ_ICON_SWAP ='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3v14"/><path d="m3 7 4-4 4 4"/><path d="M17 21V7"/><path d="m21 17-4 4-4-4"/></svg>';

function reqPersonName(u) {
  return u?.user_settings?.display_name || u?.anonymous_id || 'Anonymous';
}

function reqChips(u, topic) {
  const chips = [];
  if (u?.sex === 'M') chips.push(`<span class="req-chip">${escapeHtml(t('sex_male'))}</span>`);
  else if (u?.sex === 'F') chips.push(`<span class="req-chip">${escapeHtml(t('sex_female'))}</span>`);
  if (u?.age_range) chips.push(`<span class="req-chip">${escapeHtml(u.age_range)}</span>`);
  if (topic) chips.push(`<span class="req-chip req-chip-topic">${escapeHtml(topic)}</span>`);
  return chips.length ? `<div class="req-chips">${chips.join('')}</div>` : '';
}

// Mentee note / referral note: plain text in a profile-style info row (icon tile + label),
// no quotation block, no quote bar.
function reqNoteHTML(label, text) {
  return `
      <div class="req-note">
        <span class="req-note-icon" aria-hidden="true">${REQ_ICON_NOTE}</span>
        <div class="req-note-body">
          <div class="req-note-label">${escapeHtml(label)}</div>
          <div class="req-note-text">${escapeHtml(text)}</div>
        </div>
      </div>`;
}

function renderRequestCard(r) {
  const name = reqPersonName(r.user);
  const topic = topicLabel(r.topic) || '';
  const msg = (r.message || '').trim();
  return `
    <article class="req-card" data-kind="request" data-id="${r.id}" data-name="${escapeHtml(name)}">
      <div class="req-top">
        <div class="req-avatar" aria-hidden="true">${escapeHtml(name.charAt(0).toUpperCase())}</div>
        <div class="req-id">
          <div class="req-name">${escapeHtml(name)}</div>
          <div class="req-time">${r.created_at ? escapeHtml(timeAgo(r.created_at)) : ''}</div>
        </div>
        <span class="req-pill">${escapeHtml(t('req_new'))}</span>
      </div>
      ${reqChips(r.user, topic)}
      ${msg ? reqNoteHTML(t('req_message_label'), msg) : ''}
      ${renderRequestActions('request', r.id)}
    </article>`;
}

function renderReferralCard(r) {
  const name = reqPersonName(r.mentee);
  const from = reqPersonName(r.from_mentor);
  const note = (r.note || '').trim();
  return `
    <article class="req-card req-card-referral" data-kind="referral" data-id="${r.id}" data-name="${escapeHtml(name)}" data-from="${escapeHtml(from)}">
      <div class="req-ribbon">${REQ_ICON_SWAP}<span>${escapeHtml(t('req_referred_by', { name: from }))}</span></div>
      <div class="req-top">
        <div class="req-avatar" aria-hidden="true">${escapeHtml(name.charAt(0).toUpperCase())}</div>
        <div class="req-id">
          <div class="req-name">${escapeHtml(name)}</div>
          <div class="req-time">${r.created_at ? escapeHtml(timeAgo(r.created_at)) : ''}</div>
        </div>
      </div>
      ${reqChips(r.mentee, '')}
      ${note ? reqNoteHTML(t('req_note_from', { name: from }), note) : ''}
      ${renderRequestActions('referral', r.id)}
    </article>`;
}

function renderRequestActions(kind, id) {
  return `
      <div class="req-actions">
        <button type="button" class="btn btn-primary req-btn req-btn-accept" onclick="answerRequest('${kind}', '${id}', 'accepted', this)">${REQ_ICON_CHECK}<span>${escapeHtml(t('btn_accept'))}</span></button>
        <button type="button" class="btn btn-danger req-btn req-btn-decline" onclick="askRequestDecline('${kind}', '${id}')">${REQ_ICON_X}<span>${escapeHtml(t('btn_reject'))}</span></button>
      </div>`;
}

function reqEmptyHTML(kind) {
  const key = kind === 'referral' ? 'req_empty_referred' : 'no_pending_requests';
  const sub = kind === 'referral' ? 'req_empty_referred_sub' : 'req_empty_mentee_sub';
  return `<div class="req-empty"><div class="req-empty-icon">${kind === 'referral' ? REQ_ICON_SWAP : REQ_ICON_CHECK}</div><div class="req-empty-title">${escapeHtml(t(key))}</div><div class="req-empty-sub">${escapeHtml(t(sub))}</div></div>`;
}

function updateRequestCounts() {
  const counts = { mentee: _reqData.mentee.length, referred: _reqData.referred.length };
  [['reqTabMenteeCount', counts.mentee], ['reqTabReferredCount', counts.referred]].forEach(([id, n]) => {
    const el = $(id);
    if (!el) return;
    el.textContent = n;
    el.hidden = n <= 0;
  });
  setRequestsBadgeCount(counts.mentee + counts.referred);
}

function setRequestsBadgeCount(count) {
  const badge = $('requestsBadge');
  if (!badge) return;
  badge.textContent = count;
  badge.style.display = count > 0 ? 'flex' : 'none';
}

function setRequestsTab(tab, { byUser = true } = {}) {
  if (byUser) { _requestsTabChosen = true; haptic('light'); }
  _requestsTab = tab === 'referred' ? 'referred' : 'mentee';
  const referred = _requestsTab === 'referred';
  $('reqTabMentee')?.classList.toggle('active', !referred);
  $('reqTabReferred')?.classList.toggle('active', referred);
  $('reqTabMentee')?.setAttribute('aria-selected', String(!referred));
  $('reqTabReferred')?.setAttribute('aria-selected', String(referred));
  const mBox = $('requestsList'), rBox = $('referralsList');
  if (mBox) mBox.hidden = referred;
  if (rBox) rBox.hidden = !referred;
  const intro = $('requestsIntro');
  if (intro) intro.textContent = t(referred ? 'req_intro_referred' : 'req_intro_mentee');
}

async function loadRequests() {
  const mBox = $('requestsList'), rBox = $('referralsList');
  if (!mBox || !rBox) return;
  // Skeleton only on the very first load; later refreshes update quietly so the
  // list never flashes while you are looking at it.
  const drawn = mBox.dataset.drawn === '1';
  if (!drawn) {
    const sk = window.skeletonHTML ? skeletonHTML(3) : '<div class="loading-spinner" style="margin:40px auto"></div>';
    mBox.innerHTML = sk;
    rBox.innerHTML = '';
  }
  try {
    const [requests, referrals] = await Promise.all([
      apiFetch('/api/mentors/my-requests'),
      apiFetch('/api/mentors/referrals').catch(() => []),
    ]);
    _reqData = { mentee: requests || [], referred: referrals || [] };

    const sig = JSON.stringify([currentLanguage, _reqData.mentee.map(r => r.id), _reqData.referred.map(r => r.id)]);
    if (drawn && sig === _reqRenderedSig) { updateRequestCounts(); return; }
    _reqRenderedSig = sig;

    mBox.innerHTML = _reqData.mentee.length ? _reqData.mentee.map(renderRequestCard).join('') : reqEmptyHTML('request');
    rBox.innerHTML = _reqData.referred.length ? _reqData.referred.map(renderReferralCard).join('') : reqEmptyHTML('referral');
    mBox.dataset.drawn = '1';

    // First time in: land on whichever tab actually has something waiting.
    if (!_requestsTabChosen && !_reqData.mentee.length && _reqData.referred.length) _requestsTab = 'referred';
    setRequestsTab(_requestsTab, { byUser: false });
    updateRequestCounts();
  } catch (e) {
    mBox.innerHTML = `<div class="empty-state"><span>${escapeHtml(e.message)}</span></div>`;
  }
}

function askRequestDecline(kind, id) {
  const card = document.querySelector(`.req-card[data-kind="${kind}"][data-id="${id}"]`);
  if (!card) return;
  haptic('light');
  _declineTarget = { kind, id };
  const name = `<strong>${escapeHtml(card.dataset.name || '')}</strong>`;
  const body = $('requestDeclineBody');
  if (body) {
    body.innerHTML = kind === 'referral'
      ? t('req_decline_body_referral', { name, from: `<strong>${escapeHtml(card.dataset.from || '')}</strong>` })
      : t('req_decline_body_request', { name });
  }
  const yes = $('requestDeclineYes');
  if (yes) { yes.disabled = false; yes.textContent = t('req_decline_yes'); }
  $('requestDeclineModal')?.classList.add('open');
}

function closeRequestDecline() {
  $('requestDeclineModal')?.classList.remove('open');
  _declineTarget = null;
}

async function confirmRequestDecline() {
  const target = _declineTarget;
  if (!target) return;
  const yes = $('requestDeclineYes');
  if (yes) yes.disabled = true;
  closeRequestDecline();
  await answerRequest(target.kind, target.id, 'rejected');
}

async function answerRequest(kind, id, action, btn) {
  const key = `${kind}:${id}`;
  if (_reqBusy.has(key)) return;
  const card = document.querySelector(`.req-card[data-kind="${kind}"][data-id="${id}"]`);
  _reqBusy.add(key);
  haptic('medium');
  card?.classList.add('is-busy');
  btn?.classList.add('is-loading');
  try {
    await apiFetch(kind === 'referral' ? `/api/mentors/referral/${id}` : `/api/mentors/request/${id}`, {
      method: 'PATCH',
      body: { action },
    });
    haptic(action === 'accepted' ? 'success' : 'light');
    const name = card?.dataset.name || '';
    showToast(
      action === 'accepted'
        ? (kind === 'referral' ? t('req_toast_referral_accepted', { name }) : t('req_toast_accepted'))
        : t('req_toast_declined'),
      action === 'accepted' ? 'success' : 'info'
    );
    removeRequestCard(card, kind, id);
    if (action === 'accepted') loadMyMentees?.();   // keep My Mentees in step (no-op if the page isn't drawn)
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
    card?.classList.remove('is-busy');
    btn?.classList.remove('is-loading');
    loadRequests();   // the request may have been answered elsewhere; resync quietly
  } finally {
    _reqBusy.delete(key);
  }
}

/** Collapses a card out of the list in place (no list rebuild, no flash). */
function removeRequestCard(card, kind, id) {
  const list = kind === 'referral' ? _reqData.referred : _reqData.mentee;
  const idx = list.findIndex(r => String(r.id) === String(id));
  if (idx >= 0) list.splice(idx, 1);
  _reqRenderedSig = JSON.stringify([currentLanguage, _reqData.mentee.map(r => r.id), _reqData.referred.map(r => r.id)]);
  updateRequestCounts();

  const box = kind === 'referral' ? $('referralsList') : $('requestsList');
  const finish = () => {
    card?.remove();
    if (box && !box.querySelector('.req-card')) box.innerHTML = reqEmptyHTML(kind);
  };
  if (!card) return finish();
  card.style.height = `${card.offsetHeight}px`;
  void card.offsetHeight;   // commit the fixed height so the collapse can animate
  card.classList.add('is-leaving');
  let done = false;
  const once = () => { if (done) return; done = true; finish(); };
  card.addEventListener('transitionend', e => { if (e.target === card && e.propertyName === 'height') once(); });
  setTimeout(once, 450);
}

// ─── Sessions ─────────────────────────────────────────────────

// How long after the scheduled time a session is still joinable
const SESSION_GRACE_PERIOD_MS = 2 * 60 * 60 * 1000; // 2 h — must match SCHEDULED_EXPIRY_MS in routes/sessions.js
const SESSION_EARLY_JOIN_MS = 5 * 60 * 1000;         // must match EARLY_JOIN_MS in routes/sessions.js

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
  // Use the server's clock: a phone that's a few minutes off used to show a Join
  // button the server then refused (or hide one that was already open).
  const now = (typeof window.serverNow === 'function') ? window.serverNow() : Date.now();
  const start = new Date(scheduledAt).getTime();
  const elapsed = now - start; // positive = past, negative = future

  if (status === 'ended' || status === 'cleared' || status === 'cancelled') {
    return { isJoinable: false, label: t('session_ended_status'), labelClass: 'chip chip-muted' };
  }

  // A live session stays joinable for as long as it is live — people must be
  // able to rejoin after a dropped connection, however long the call has run.
  if (status === 'active') {
    return { isJoinable: true, label: t('live_now') || '🔴 Live now', labelClass: 'chip chip-live' };
  }

  // Never-started sessions expire (matches the server's 2 h window).
  if (elapsed > SESSION_GRACE_PERIOD_MS) {
    return { isJoinable: false, label: t('session_done_status') || '✓ Done', labelClass: 'chip chip-muted' };
  }

  // More than 5 min early: not open yet.
  if (elapsed < -SESSION_EARLY_JOIN_MS) {
    const startsAtText = (t('starts_at') || 'Starts at {time}').replace('{time}', formatDateTime(scheduledAt));
    return { isJoinable: false, label: startsAtText, labelClass: 'chip chip-muted session-not-yet' };
  }

  // Lobby is open (5 min before start onward).
  if (elapsed < 0) {
    return { isJoinable: true, label: t('lobby_open_soon') || 'Lobby open — starting soon', labelClass: 'chip chip-soon' };
  }
  return { isJoinable: true, label: '', labelClass: '' };
}

// ─── Session cards (Live page) ───────────────────────────────
// One builder for private + group cards, used by loadSessions() and the 30 s
// refresh, so the buttons can never drift apart again.
const ICON_SESSION_END_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';
const ICON_SESSION_CLOCK_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>';

// The three parts of a card that change with time: status chip, status note, buttons.
function sessionCardParts(id, scheduledAt, status, { isHost, withBrowser }) {
  const st = getSessionState(scheduledAt, status);
  const notYet = st.labelClass === 'chip chip-muted session-not-yet';
  const canEnd = isHost && status !== 'ended' && status !== 'cleared' && status !== 'cancelled';
  const lobby = st.isJoinable && st.labelClass === 'chip chip-soon';

  let chip = '';
  if (notYet) chip = `<span class="chip chip-muted">${escapeHtml(t('session_upcoming') || 'Upcoming')}</span>`;
  else if (st.label && !lobby) chip = `<span class="${st.labelClass}">${escapeHtml(st.label)}</span>`;

  const note = lobby ? escapeHtml(st.label) : '';

  let actions = '';
  if (st.isJoinable) {
    actions = `<div class="sc-buttons">
        <button type="button" class="btn btn-primary sc-join" onclick="joinSession('${id}')">${joinSessionBtnLabel()}</button>
        ${withBrowser ? `<button type="button" class="btn btn-outline sc-browser" onclick="openSessionInBrowser('${id}')" aria-label="${escapeHtml(t('btn_join_browser') || 'Join via Browser')}">${ICON_JOIN_BROWSER_SVG}<span>${escapeHtml(t('btn_join_browser_short') || 'Browser')}</span></button>` : ''}
      </div>`;
  } else if (notYet) {
    actions = `<div class="sc-wait">${ICON_SESSION_CLOCK_SVG}<span>${escapeHtml(t('session_opens_hint') || 'Join opens 5 min before the start')}</span></div>`;
  }
  if (canEnd) {
    actions += `<button type="button" class="sc-end" onclick="endSession('${id}')">${ICON_SESSION_END_SVG}<span>${escapeHtml(t('btn_end_session') || 'End Session')}</span></button>`;
  }
  return { st, chip, note, actions };
}

function sessionCardHtml(s, { isGroup, withBrowser, title }) {
  const isHost = String(s.host_id) === String(currentUser?.telegram_id);
  const p = sessionCardParts(s.id, s.scheduled_at, s.status, { isHost, withBrowser });
  const cls = (s.status === 'active' ? ' is-live' : '') + (!p.st.isJoinable && !p.actions ? ' is-done' : '');
  return `
    <div class="session-item sc${cls}"
        data-session-id="${s.id}"
        data-scheduled-at="${s.scheduled_at}"
        data-status="${s.status}"
        data-host="${escapeHtml(String(s.host_id ?? ''))}"
        data-browser="${withBrowser ? 1 : 0}">
      <div class="sc-top">
        <div class="session-icon">${isGroup ? ICON_GROUP_SVG : ICON_USER_SVG}</div>
        <div class="session-body">
          <div class="session-title">${escapeHtml(title)}</div>
          <div class="session-sub">${formatDateTime(s.scheduled_at)}</div>
        </div>
        <div class="sc-chip">${p.chip}</div>
      </div>
      <div class="sc-note"${p.note ? '' : ' hidden'}>${p.note}</div>
      <div class="sc-actions"${p.actions ? '' : ' hidden'}>${p.actions}</div>
    </div>`;
}

/**
 * Refresh only the status chip / note / buttons on already-rendered session cards
 * using the cached data — no API call. Called every 30 s by the timer.
 */
function refreshSessionLabels() {
  let activeSessionCount = 0;
  ['privateSessionsList', 'upcomingSessions'].forEach(listId => {
    const list = document.getElementById(listId);
    if (!list) return;
    list.querySelectorAll('.session-item[data-session-id]').forEach(item => {
      const scheduledAt = item.dataset.scheduledAt;
      if (!scheduledAt) return;
      const p = sessionCardParts(item.dataset.sessionId, scheduledAt, item.dataset.status, {
        isHost: String(item.dataset.host) === String(currentUser?.telegram_id),
        withBrowser: item.dataset.browser === '1',
      });
      if (p.st.isJoinable) activeSessionCount++;
      const set = (sel, html) => {
        const el = item.querySelector(sel);
        if (!el) return;
        if (el.innerHTML !== html) el.innerHTML = html;
        if (el.hasAttribute('hidden') !== !html) el.toggleAttribute('hidden', !html);
      };
      set('.sc-chip', p.chip);
      set('.sc-note', p.note);
      set('.sc-actions', p.actions);
      item.classList.toggle('is-done', !p.st.isJoinable && !p.actions);
    });
  });
  updateSessionsBadge(activeSessionCount);
}

async function loadSessions() {
  if (typeof window.syncServerClock === 'function') await window.syncServerClock();
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
          if (getSessionState(session.scheduled_at, session.status).isJoinable) activeSessionCount++;
          const isGroup = session.is_group;
          const title = session.title || (isGroup ? 'Group Session' : 'Private Session');
          return sessionCardHtml(session, { isGroup, withBrowser: true, title });
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
          if (getSessionState(s.scheduled_at, s.status).isJoinable) activeSessionCount++;
          return sessionCardHtml(s, { isGroup: true, withBrowser: false, title: s.title });
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
  if (!confirm(t('Clear all sessions from your list?'))) return;
  haptic('medium');
  try {
    const res = await apiFetch('/api/sessions/my', { method: 'DELETE' });
    haptic('success');
    showToast(t('sessions_cleared', { count: res.count || 0 }), 'success');
    loadSessions();
  } catch (e) { haptic('error'); showToast(e.message, 'error'); }
}

// Join / create / launch / leave now live in session-room.js.
// ─── End a session (mentor/host only) ─────────────────────────────
async function endSession(session_id) {
  if (!confirm(t('End this session for all participants? This action cannot be undone.'))) return;
  haptic('medium');
  try {
    await apiFetch(`/api/sessions/${session_id}/end`, { method: 'PATCH' });
    haptic('success');
    showToast(t('Session ended.'), 'success');
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

  modalTitle.textContent = is_group ? t('Schedule Group Session') : t('Schedule 1-on-1 Session');
  if (btn) btn.textContent = t('btn_schedule_action');
  // The title field now applies to both session types — the host can name
  // a 1-on-1 session too (e.g. "Career Check-in"), not just group sessions.
  titleField.classList.remove('hidden');
  const titleInput = document.getElementById('scheduleTitle');
  if (titleInput) {
    titleInput.placeholder = is_group ? t('session_group_placeholder') : t('session_1on1_placeholder');
    titleInput.value = '';
  }
  participantField.classList.toggle('hidden', !is_group);

  if (is_group && menteeList) {
    menteeList.innerHTML = `<div class="text-xs text-dim">${escapeHtml(t('loading_mentees'))}</div>`;
    apiFetch('/api/mentors/my-mentees').then(mentees => {
      if (!mentees.length) {
        menteeList.innerHTML = `<div class="text-xs text-dim">${t('no_mentees_to_invite')}</div>`;
        return;
      }
      menteeList.innerHTML = mentees.map(m => {
        const nm = m.user?.user_settings?.display_name || m.user.anonymous_id || '–';
        return `
        <label class="sch-person">
          <input type="checkbox" name="invite_mentee" value="${m.user.telegram_id}" />
          ${renderAvatar(m.user, (nm || '?').charAt(0).toUpperCase())}
          <span class="sch-person-name">${escapeHtml(nm)}</span>
          <span class="rt-radio" aria-hidden="true"></span>
        </label>`;
      }).join('');
      hydrateAvatars(menteeList);
    }).catch(e => {
      menteeList.innerHTML = `<div class="text-danger text-xs">${escapeHtml(e.message)}</div>`;
    });
  }

  // Default to the current local date/time. (Was now + 1 h, and the date came from
  // toISOString() which is UTC — in Addis (UTC+3) that gives *yesterday* between
  // 00:00 and 03:00.) A start time that has already passed is clamped to "now" by
  // the server, so the default is safe to submit as-is.
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  document.getElementById('scheduleDate').value = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  document.getElementById('scheduleTime').value = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

  modal.classList.add('open');

  btn.onclick = () => {
    haptic('medium');
    const date = document.getElementById('scheduleDate').value;
    const time = document.getElementById('scheduleTime').value;
    const title = document.getElementById('scheduleTitle').value || (is_group ? t('Group Session') : t('1-on-1 Session'));

    if (!date || !time) {
      haptic('error');
      showToast(t('please_pick_datetime'), 'error');
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
      showToast(t('invalid_datetime_selected'), 'error');
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
      list.innerHTML = `<p class="text-center py-20 text-dim">${escapeHtml(t('no_active_mentees'))}</p>`;
      return;
    }
    const joinedLabel = t('Joined');
    const dateLocale = currentLanguage === 'am' ? 'am-ET' : undefined;
    list.innerHTML = mentees.map(m => {
      const displayName = m.user?.user_settings?.display_name || m.user?.anonymous_id || '–';
      const letter = (displayName || '?').charAt(0).toUpperCase();
      const dateStr = m.assigned_at ? new Date(m.assigned_at).toLocaleDateString(dateLocale) : '';
      return `
      <button type="button" class="profile-menu-item rt-topic sch-pick" onclick="startPrivateSession('${m.user.telegram_id}')">
        ${renderAvatar(m.user, letter)}
        <span class="profile-menu-label rt-label">
          <span class="rt-name">${escapeHtml(displayName)}</span>
          <span class="sch-sub">${escapeHtml(joinedLabel)} ${escapeHtml(dateStr)}</span>
        </span>
        <svg class="profile-menu-chevron" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
      </button>
    `;
    }).join('');
    hydrateAvatars(list);
  }).catch(e => {
    list.innerHTML = `<p class="text-danger">${escapeHtml(e.message)}</p>`;
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
      showToast(t('no_active_mentees_session'), 'error');
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

// Screen share + leave handling now live in session-room.js.

// ─── Chat ─────────────────────────────────────────────────────
window.chatState = {};
window.replyToId = null;

// A mentor's chat-partner dropdown otherwise resets to the first mentee
// every time the chat page is left and reopened (including a full app
// restart), since window.chatState is just an in-memory object. Persist
// the mentor's last-viewed mentee per-mentor in localStorage so loadChat()
// can restore it instead of always defaulting to mentees[0].
function getLastChatPartner(mentorId) {
  if (!mentorId) return null;
  try { return localStorage.getItem(`holy_last_mentee_${mentorId}`); } catch { return null; }
}
function setLastChatPartner(mentorId, partnerId) {
  if (!mentorId || !partnerId) return;
  try { localStorage.setItem(`holy_last_mentee_${mentorId}`, String(partnerId)); } catch { }
}

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
      window._menteesList = res.mentees;
      $('chatWith').style.display = 'none';
      if (partnerWrapper) partnerWrapper.style.display = 'block';

      // Priority: an explicit target (user just tapped a mentee) > the
      // mentor's last-viewed mentee from a previous visit > the first mentee.
      const storedId = targetId ? null : getLastChatPartner(currentUser?.telegram_id);
      const selectedId = targetId || storedId || res.mentees[0].telegram_id;
      const partner = res.mentees.find(m => String(m.telegram_id) === String(selectedId)) || res.mentees[0];
      setLastChatPartner(currentUser?.telegram_id, partner.telegram_id);

      // Update selected partner name in custom dropdown button
      const selectedNameEl = $('chatPartnerSelectedName');
      if (selectedNameEl) {
        selectedNameEl.textContent = partner.display_name;
      }

      // A dot on the collapsed button flags unread messages from any
      // OTHER mentee — the mentor can tell someone else messaged them
      // without opening the list or waiting on a notification.
      const hasOtherUnread = res.mentees.some(m => String(m.telegram_id) !== String(partner.telegram_id) && m.unread_count > 0);
      const badgeDot = $('chatPartnerBadgeDot');
      if (badgeDot) badgeDot.style.display = hasOtherUnread ? 'inline-block' : 'none';

      // Render custom menu items
      const menu = $('chatPartnerDropdownMenu');
      if (menu) {
        menu.innerHTML = res.mentees.map(m => {
          const isSelected = String(m.telegram_id) === String(partner.telegram_id);
          const isOnline = isUserOnline(m.last_active);
          const dotColor = isOnline ? 'var(--success)' : 'var(--text3)';
          const dotLabel = isOnline ? 'Online' : 'Offline';
          const badge = m.unread_count > 0
            ? `<span class="chat-partner-badge">${m.unread_count > 99 ? '99+' : m.unread_count}</span>`
            : `<span style="width: 8px; height: 8px; border-radius: 50%; background: ${dotColor}; display: inline-block;" title="${dotLabel}"></span>`;

          return `
            <button type="button" class="msg-menu-item chat-partner-item${isSelected ? ' active' : ''}" onclick="switchChatPartner('${m.telegram_id}'); closeChatPartnerDropdown()">
              <span class="chat-partner-item-name">${escapeHtml(m.display_name)}</span>
              ${badge}
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

// Re-fetches just the mentee list's unread badges — used when a
// 'new_message' socket event arrives for a mentee that ISN'T the one
// currently open in chat, so the dropdown/badge-dot update live instead
// of only refreshing the next time the mentor opens the picker.
// Deliberately does NOT touch window.chatState or call loadMessages, so
// it never marks anything as read or disturbs the open conversation.
async function refreshChatPartnerBadges() {
  if (currentPage !== 'chat') return;
  try {
    const res = await apiFetch('/api/users/chat-partner');
    if (res.type !== 'multiple') return;
    window._menteesList = res.mentees;

    const currentId = window.chatState?.with;
    const hasOtherUnread = res.mentees.some(m => String(m.telegram_id) !== String(currentId) && m.unread_count > 0);
    const badgeDot = $('chatPartnerBadgeDot');
    if (badgeDot) badgeDot.style.display = hasOtherUnread ? 'inline-block' : 'none';

    const menu = $('chatPartnerDropdownMenu');
    if (!menu) return;
    res.mentees.forEach(m => {
      const btn = menu.querySelector(`button[onclick*="switchChatPartner('${m.telegram_id}')"]`);
      if (!btn) return;
      const badgeEl = btn.querySelector('.chat-partner-badge');
      const dotEl = btn.querySelector('span[style*="border-radius: 50%"]');
      if (m.unread_count > 0) {
        const text = m.unread_count > 99 ? '99+' : String(m.unread_count);
        if (badgeEl) { badgeEl.textContent = text; }
        else if (dotEl) { dotEl.outerHTML = `<span class="chat-partner-badge">${text}</span>`; }
      } else if (badgeEl) {
        const isOnline = isUserOnline(m.last_active);
        const dotColor = isOnline ? 'var(--success)' : 'var(--text3)';
        badgeEl.outerHTML = `<span style="width: 8px; height: 8px; border-radius: 50%; background: ${dotColor}; display: inline-block;"></span>`;
      }
    });
  } catch { }
}

async function switchChatPartner(tid) {
  if (!tid || String(window.chatState?.with) === String(tid)) return;
  haptic('selection');
  cancelEditMessage();
  cancelReply();
  window.chatState.with = tid;
  toggleChatInput(true);
  setLastChatPartner(currentUser?.telegram_id, tid);

  // Update selected partner in memory and header immediately
  let partner = (window._menteesList || []).find(m => String(m.telegram_id) === String(tid));
  if (!partner) {
    try {
      const res = await apiFetch('/api/users/chat-partner');
      if (res.type === 'multiple') {
        window._menteesList = res.mentees;
        partner = res.mentees.find(m => String(m.telegram_id) === String(tid));
      }
    } catch { }
  }

  if (partner) {
    const selectedNameEl = $('chatPartnerSelectedName');
    if (selectedNameEl) selectedNameEl.textContent = partner.display_name;
    setChatPeerHeader(partner.display_name, partner.last_active, partner.telegram_id, partner.photo_file_id, partner.photo_updated_at);
    window.chatState.name = partner.display_name || partner.anonymous_id;
  }

  // Update active item styling in the custom dropdown menu
  const menu = $('chatPartnerDropdownMenu');
  if (menu) {
    menu.querySelectorAll('.msg-menu-item').forEach(btn => {
      const isSelected = btn.getAttribute('onclick')?.includes(`'${tid}'`);
      btn.style.background = isSelected ? 'var(--surface)' : '';
      btn.style.color = isSelected ? 'var(--gold)' : '';
      const span = btn.querySelector('span');
      if (span) span.style.fontWeight = isSelected ? '700' : '500';
    });
  }

  // Load messages directly for the newly selected mentee
  await loadMessages(tid);
  refreshChatPartnerBadges();
}

function openChat(partnerId) {
  window.pendingChatPartner = partnerId;
  navigate('chat');
}

function indexChatMessages(list) {
  if (!list || !list.length) return;
  if (!window._chatMessagesMap) window._chatMessagesMap = new Map();
  for (const m of list) {
    window._chatMessagesMap.set(String(m.id), m);
    if (m.replies && m.replies.length) indexChatMessages(m.replies);
  }
}

function getLoadEarlierHtml() {
  if (!window._hasEarlierMessages) return '';
  return `
    <div id="loadEarlierContainer" class="load-earlier-container">
      <button id="loadEarlierBtn" class="load-earlier-btn" onclick="loadEarlierMessages()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
        <span data-i18n="btn_load_earlier">${t('btn_load_earlier') || 'Load earlier messages'}</span>
      </button>
    </div>
  `;
}

async function loadEarlierMessages() {
  if (window._isLoadingEarlier || !window.chatState?.with || !window._chatEarliestDate) return;
  const btn = $('loadEarlierBtn');
  const container = $('chatMessages');
  if (!container) return;

  window._isLoadingEarlier = true;
  haptic('light');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = `<span class="loading-spinner" style="width:13px;height:13px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px"></span><span>${t('loading') || 'Loading…'}</span>`;
  }

  try {
    const with_id = window.chatState.with;
    const beforeParam = encodeURIComponent(window._chatEarliestDate);
    const olderMessages = await apiFetch(`/api/messages/${with_id}?before=${beforeParam}`);

    if (window.chatState?.with && String(window.chatState.with) !== String(with_id)) return;

    if (!olderMessages || !olderMessages.length) {
      window._hasEarlierMessages = false;
      $('loadEarlierContainer')?.remove();
      showToast(t('no_earlier_messages') || 'No earlier messages', 'info');
      return;
    }

    window._hasEarlierMessages = olderMessages.length >= 100;
    window._chatEarliestDate = olderMessages[0].created_at;

    indexChatMessages(olderMessages);

    // Save scroll position relative to content
    const prevScrollHeight = container.scrollHeight;
    const prevScrollTop = container.scrollTop;

    // Remove old load earlier button
    $('loadEarlierContainer')?.remove();

    // Prepend older messages with date headers
    const earlierHtml = getLoadEarlierHtml() + renderThread(olderMessages, true);
    container.insertAdjacentHTML('afterbegin', earlierHtml);
    hydratePhotoMessages(container);

    // Preserve exact scroll position so the view doesn't jump
    const newScrollHeight = container.scrollHeight;
    container.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
    haptic('selection');
  } catch (e) {
    console.error('Failed to load earlier messages:', e);
    showToast(e.message || 'Failed to load earlier messages', 'error');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
        <span data-i18n="btn_load_earlier">${t('btn_load_earlier') || 'Load earlier messages'}</span>
      `;
    }
  } finally {
    window._isLoadingEarlier = false;
  }
}

async function loadMessages(with_id, opts = {}) {
  const container = $('chatMessages');

  try {
    const messages = await apiFetch(`/api/messages/${with_id}`);
    if (!container) return;

    // A slow response for a conversation the user has already switched away
    // from must not overwrite the one they're looking at now.
    if (window.chatState?.with && String(window.chatState.with) !== String(with_id)) return;

    const sameChat = container.dataset.chatWith === String(with_id);

    // Track earliest date for pagination
    if (messages && messages.length) {
      if (!sameChat || !window._chatEarliestDate) {
        window._chatEarliestDate = messages[0].created_at;
        window._hasEarlierMessages = messages.length >= 100;
      }
    } else {
      window._chatEarliestDate = null;
      window._hasEarlierMessages = false;
    }

    if (!window._chatMessagesMap) window._chatMessagesMap = new Map();

    // Skip the re-render when nothing changed. Reconnect re-syncs, duplicate
    // socket events, badge refreshes and visibility changes all call this;
    // rebuilding up to 100 bubbles (and losing scroll position) each time was
    // a major source of flicker and lag. Compare what's on screen (ids + edit
    // state) with what the server returned.
    const renderedThreads = Array.from(container.querySelectorAll('.message-thread[data-msg-id]'));
    const domSig = renderedThreads
      .map(el => el.dataset.msgId)
      .filter(id => !String(id).startsWith('temp_'))
      .map(id => `${id}:${window._chatMessagesMap.get(String(id))?.edited_at || ''}`)
      .sort().join('|');
    const serverSig = messages.map(m => `${m.id}:${m.edited_at || ''}`).sort().join('|');

    // The "start messaging" placeholder must also match: an empty list that
    // has no placeholder yet (or a placeholder over real bubbles) needs a render.
    const hasEmptyEl = !!container.querySelector(':scope > .chat-empty');
    const emptyMatches = hasEmptyEl === (renderedThreads.length === 0);

    // If earlier messages have been prepended, do not collapse DOM back on non-forced refresh.
    // That shortcut needs a non-empty server list: with zero messages (a cleared
    // conversation) every signature "includes" the empty string, which used to
    // keep the old bubbles on screen instead of showing the empty state.
    if (!opts.force && sameChat && emptyMatches && (domSig === serverSig || (messages.length > 0 && renderedThreads.length > messages.length && domSig.includes(serverSig)))) {
      updateMessageBadge();
      return;
    }

    indexChatMessages(messages);

    // Keep the user's place: stick to the bottom only if they were already
    // there (or this is a fresh conversation); otherwise restore scroll.
    const prevTop = container.scrollTop;
    const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;

    // Bubbles still "sending…" aren't in the server response yet — keep them.
    const pending = !sameChat ? '' : Array.from(container.querySelectorAll(':scope > .message-thread[data-msg-id^="temp_"]'))
      .map(el => el.outerHTML).join('');

    try {
      // Flat, chronological list; replies carry a quote of their original.
      const threadsHtml = renderThread(messages);
      container.innerHTML = (!threadsHtml && !pending)
        ? chatEmptyStateHtml()
        : getLoadEarlierHtml() + threadsHtml + pending;
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

    container.dataset.chatWith = String(with_id);
    container.scrollTop = (!sameChat || wasNearBottom || opts.force) ? container.scrollHeight : prevTop;
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
    loadMessages(window.chatState.with, { force: true });
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
    // Show the empty state right away; don't make it wait on a second request.
    const box = $('chatMessages');
    if (box) {
      box.innerHTML = chatEmptyStateHtml();
      box.dataset.chatWith = String(window.chatState.with);
      box.scrollTop = 0;
    }
    window._chatMessagesMap?.clear();
    window._chatEarliestDate = null;
    window._hasEarlierMessages = false;
    // Then reconcile with the server (e.g. a message that arrived meanwhile).
    loadMessages(window.chatState.with, { force: true }).catch(() => { });
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
  closeComposerPopups();
  const counter = $('charCounter');
  if (counter) { counter.textContent = '0 / 2000'; counter.classList.remove('danger', 'visible'); }
  updateComposerMode();

  // The input is deliberately NOT disabled while sending. Disabling it blurred
  // the textarea, which collapsed the phone keyboard and re-opened it when
  // re-enabled — a visible jump on every message — and stopped people typing
  // their next message while one was in flight. Keep focus so the keyboard stays.
  try { input.focus({ preventScroll: true }); } catch { }

  // Unique per message. Also sent to the server as client_id, which makes
  // retries idempotent (no duplicate messages if a response was lost).
  window._sendSeq = (window._sendSeq || 0) + 1;
  const tempId = `temp_${Date.now()}_${window._sendSeq}`;

  // Capture reply target now and clear the reply banner immediately, so the
  // NEXT message isn't accidentally sent as a reply too.
  const replyParentId = window.replyToId || null;
  cancelReply();

  const toId = window.chatState.with;
  addMessageToChat({
    id: tempId,
    from_id: currentUser?.telegram_id,
    to_id: toId,
    content: originalContent,
    created_at: new Date().toISOString(),
    is_sending: true,
    is_deleted: false,
    parent_id: replyParentId,
    replies: []
  });

  if (!window._pendingSends) window._pendingSends = new Map();
  window._pendingSends.set(tempId, { toId, content: originalContent, parentId: replyParentId });
  deliverMessage(tempId);
}

// POST with up to 3 attempts. Every attempt carries the same client_id, so if
// an earlier attempt actually reached the database (response lost / timed out)
// the server returns that message instead of inserting it again.
async function postMessageWithRetry(body) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await apiFetch('/api/messages', { method: 'POST', body, timeout: 12000, retry: false });
    } catch (e) {
      lastError = e;
      // 4xx (validation, no mentorship, rate limit) will never succeed on retry.
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 408) throw e;
      if (attempt < 2) await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function deliverMessage(tempId) {
  const pending = window._pendingSends?.get(tempId);
  if (!pending) return;
  const findTemp = () => document.querySelector(`#chatMessages .message-thread[data-msg-id="${tempId}"]`);

  try {
    const msg = await postMessageWithRetry({
      to_id: pending.toId,
      content: pending.content,
      parent_id: pending.parentId || undefined,
      client_id: tempId,
    });
    window._pendingSends.delete(tempId);
    const container = $('chatMessages');
    if (container) replaceOptimisticBubble(container, tempId, msg);
  } catch (e) {
    haptic('error');
    showToast(e.message && !/^HTTP|timed out|Network|Failed to fetch/i.test(e.message) ? e.message : t('msg_send_failed'), 'error');
    const bubble = findTemp()?.querySelector('.message-bubble');
    if (bubble) {
      bubble.classList.remove('sending');
      bubble.classList.add('failed');
      if (!bubble.querySelector('.retry-btn')) {
        bubble.insertAdjacentHTML('beforeend', `
          <div class="failed-status" style="margin-top: 4px; display: flex; align-items: center; justify-content: flex-end; gap: 4px;">
            <span style="font-size: var(--fs-xs); color: var(--danger);">Failed</span>
            <button class="btn btn-danger btn-xs btn-outline retry-btn" onclick="retrySendMessage('${tempId}')" style="font-size: var(--fs-2xs); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--danger);">Retry</button>
          </div>
        `);
      }
    }
  }
}

// Retry re-uses the SAME client_id (tempId) and the SAME bubble, so a message
// that did reach the server earlier can't be duplicated.
function retrySendMessage(tempId) {
  const tempEl = document.querySelector(`#chatMessages .message-thread[data-msg-id="${tempId}"]`);
  if (!tempEl || !window._pendingSends?.has(tempId)) return;
  const bubble = tempEl.querySelector('.message-bubble');
  if (bubble) {
    bubble.classList.remove('failed');
    bubble.classList.add('sending');
    bubble.querySelector('.failed-status')?.remove();
  }
  deliverMessage(tempId);
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
  loadMessages(window.chatState.with, { force: true });
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

// Premium SVG "join via browser" icon — pairs with ICON_JOIN_SESSION_SVG so
// the outline button matches the primary button's icon weight and style
// instead of sitting as bare text next to an iconed sibling.
const ICON_JOIN_BROWSER_SVG = '<svg class="btn-icon-browser" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3c2.4 2.6 3.7 5.7 3.7 9s-1.3 6.4-3.7 9c-2.4-2.6-3.7-5.7-3.7-9s1.3-6.4 3.7-9z"/></svg>';

// Premium SVG "user / 1-on-1" icon — replaces the 👤 emoji for sessions.
const ICON_USER_SVG = '<svg class="session-type-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

// Premium SVG "group / multi-user" icon — replaces the 👥 emoji for sessions.
const ICON_GROUP_SVG = '<svg class="session-type-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

function joinSessionBtnLabel() {
  return `${ICON_JOIN_SESSION_SVG}<span>${t('btn_join_session')}</span>`;
}

function joinBrowserBtnLabel() {
  return `${ICON_JOIN_BROWSER_SVG}<span>${escapeHtml(t('btn_join_browser') || 'Join via Browser')}</span>`;
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
  // At most one 'typing' event every 2.5 s (was one per keystroke), and only
  // while there is text in the box.
  const inputEl = $('chatInput');
  const now = Date.now();
  if (socket?.connected && window.chatState.with && inputEl?.value && now - (window._lastTypingEmit || 0) > 2500) {
    window._lastTypingEmit = now;
    socket.emit('typing', { to_id: window.chatState.with });
  }
  autoResizeChatInput();
  // Mic <-> send swap, like Telegram
  updateComposerMode();
  // Live character counter. Hidden until it matters, so it doesn't take a
  // whole line of the composer all the time.
  const input = $('chatInput');
  const counter = $('charCounter');
  if (input && counter) {
    const len = input.value.length;
    const MAX = 2000;
    counter.textContent = `${len} / ${MAX}`;
    counter.classList.toggle('visible', len >= 1500);
    counter.classList.toggle('danger', len > MAX);
  }
  syncChatInputHeight();
}

// ── Telegram-style Comprehensive Emoji Picker ─────────────────────────
const EMOJI_CATEGORIES = [
  {
    id: 'smileys',
    icon: '😊',
    titleKey: 'emoji_smileys',
    title: 'Smileys & Emotion',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇',
      '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '😋', '😛', '😜', '🤪', '😝', '🤑',
      '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬',
      '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵',
      '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐', '😕', '😟', '🙁', '☹️',
      '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱',
      '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿',
      '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖', '😺', '😸', '😹',
      '😻', '😼', '😽', '🙀', '😿', '😾', '🙈', '🙉', '🙊'
    ]
  },
  {
    id: 'gestures',
    icon: '👋',
    titleKey: 'emoji_people',
    title: 'Gestures & People',
    emojis: [
      '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘',
      '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜',
      '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵',
      '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅', '👄',
      '👶', '👧', '🧒', '👦', '👩', '🧑', '👨', '👵', '🧓', '👴', '👲', '👳‍♀️', '👳‍♂️',
      '🧕', '👮‍♀️', '👮‍♂️', '👷‍♀️', '👷‍♂️', '💂‍♀️', '💂‍♂️', '🕵️‍♀️', '🕵️‍♂️', '👩‍⚕️', '👨‍⚕️', '👩‍🎓', '👨‍🎓',
      '👩‍🏫', '👨‍🏫', '👩‍⚖️', '👨‍⚖️', '👩‍🌾', '👨‍🌾', '👩‍🍳', '👨‍🍳', '👩‍🔧', '👨‍🔧', '👩‍🏭', '👨‍🏭', '👩‍💼',
      '👨‍💼', '👩‍🔬', '👨‍🔬', '👩‍💻', '👨‍💻', '👩‍🎤', '👨‍🎤', '👩‍🎨', '👨‍🎨', '👩‍✈️', '👨‍✈️', '👩‍🚀', '👨‍🚀',
      '👩‍🚒', '👨‍🚒', '🦸‍♀️', '🦸‍♂️', '🦹‍♀️', '🦹‍♂️', '🧙‍♀️', '🧙‍♂️', '🧚‍♀️', '🧚‍♂️', '🧛‍♀️', '🧛‍♂️', '🧜‍♀️',
      '🧜‍♂️', '🧝‍♀️', '🧝‍♂️', '🧞‍♀️', '🧞‍♂️', '🧟‍♀️', '🧟‍♂️', '🙍‍♀️', '🙍‍♂️', '🙎‍♀️', '🙎‍♂️', '🙅‍♀️', '🙅‍♂️',
      '🙆‍♀️', '🙆‍♂️', '💁‍♀️', '💁‍♂️', '🙋‍♀️', '🙋‍♂️', '🧏‍♀️', '🧏‍♂️', '🙇‍♀️', '🙇‍♂️', '🤦‍♀️', '🤦‍♂️', '🤷‍♀️', '🤷‍♂️'
    ]
  },
  {
    id: 'animals',
    icon: '🐶',
    titleKey: 'emoji_animals',
    title: 'Animals & Nature',
    emojis: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮',
      '🐷', '🐽', '🐸', '🐵', '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅',
      '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🪱', '🐛', '🦋', '🐌', '🐞', '🐜',
      '🪰', '🪲', '🪳', '🦟', '🦗', '🕷️', '🕸️', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕',
      '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🦭',
      '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🦣', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒',
      '🦘', '🦬', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🐕',
      '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛', '🪶', '🐓', '🦃', '🦤', '🦚', '🦜', '🦢', '🦩',
      '🕊️', '🐇', '🦝', '🦨', '🦡', '🦫', '🦦', '🦥', '🐁', '🐀', '🐿️', '🦔', '🌲',
      '🌳', '🌴', '🌵', '🌾', '🌿', '☘️', '🍀', '🍁', '🍂', '🍃', '🍄', '🌰', '🌸',
      '💮', '🏵️', '🌹', '🥀', '🌺', '🌻', '🌼', '🌷', '🌱', '🪴', '☀️', '🌤️', '⛅',
      '🌥️', '☁️', '🌦️', '🌧️', '⛈️', '🌩️', '🌨️', '❄️', '☃️', '⛄', '🌬️', '💨', '🌪️',
      '🌫️', '🌈', '☔', '💧', '🌊'
    ]
  },
  {
    id: 'food',
    icon: '🍔',
    titleKey: 'emoji_food',
    title: 'Food & Drink',
    emojis: [
      '🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑',
      '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽',
      '🥕', '🫒', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚',
      '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕',
      '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗', '🥘', '🫕', '🥫', '🍝', '🍜',
      '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮',
      '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫',
      '🍿', '🍩', '🍪', '🌰', '🥜', '🍯', '🥛', '🍼', '🫖', '☕', '🍵', '🧃', '🥤',
      '🧋', '🍶', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧉', '🍾', '🧊'
    ]
  },
  {
    id: 'activities',
    icon: '⚽',
    titleKey: 'emoji_activities',
    title: 'Activities',
    emojis: [
      '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸',
      '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋',
      '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️‍♀️', '🏋️‍♂️', '🤼‍♀️',
      '🤼‍♂️', '🤸‍♀️', '🤸‍♂️', '⛹️‍♀️', '⛹️‍♂️', '🤺', '🤾‍♀️', '🤾‍♂️', '🏌️‍♀️', '🏌️‍♂️', '🏇', '🧘‍♀️',
      '🧘‍♂️', '🏄‍♀️', '🏄‍♂️', '🏊‍♀️', '🏊‍♂️', '🤽‍♀️', '🤽‍♂️', '🚣‍♀️', '🚣‍♂️', '🧗‍♀️', '🧗‍♂️', '🚵‍♀️',
      '🚵‍♂️', '🚴‍♀️', '🚴‍♂️', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️', '🎫',
      '🎟️', '🎪', '🤹', '🎭', '🩰', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🪘',
      '🎷', '🎺', '🪗', '🎸', '🪕', '🎻', '🎲', '♟️', '🎯', '🎳', '🎮', '🎰', '🧩'
    ]
  },
  {
    id: 'travel',
    icon: '🚗',
    titleKey: 'emoji_travel',
    title: 'Travel & Places',
    emojis: [
      '🚗', '🚙', '🚕', '🛺', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚',
      '🚛', '🚜', '🦯', '🦽', '🦼', '🛴', '🚲', '🛵', '🏍️', '🛞', '🚨', '🚔', '🚍',
      '🚘', '🚖', '🚡', '🚠', '🚟', '🚃', '🚋', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂',
      '🚆', '🚇', '🚊', '🚉', '✈️', '🛫', '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸', '🚁',
      '🛶', '⛵', '🚤', '🛥️', '🛳️', '⛴️', '🚢', '⚓', '🛟', '🚧', '⛽', '🚏', '🚥',
      '🚦', '🗺️', '🗿', '🗽', '🗼', '🏰', '🏯', '🏟️', '🎡', '🎢', '🎠', '⛲', '⛱️',
      '🏖️', '🏝️', '🏜️', '🌋', '⛰️', '🏔️', '🗻', '🏕️', '⛺', '🛖', '🏠', '🏡', '🏘️',
      '🏚️', '🏗️', '🏭', '🏢', '🏬', '🏣', '🏤', '🏥', '🏦', '🏨', '🏪', '🏫', '🏩',
      '💒', '🏛️', '⛪', '🕌', '🛕', '🕍', '⛩️', '🕋', '🛤️', '🛣️', '🗾', '🎑', '🏞️',
      '🌅', '🌄', '🌠', '🎇', '🎆', '🌇', '🌆', '🏙️', '🌃', '🌌', '🌉', '🌁'
    ]
  },
  {
    id: 'objects',
    icon: '💡',
    titleKey: 'emoji_objects',
    title: 'Objects',
    emojis: [
      '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '📷', '📸', '📹', '🎥', '📽️', '📞', '☎️',
      '📟', '📠', '📺', '📻', '🎙️', '🎚️', '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '⌛',
      '⏳', '📡', '🔋', '🔌', '💡', '🔦', '🕯️', '🧯', '🗑️', '🛢️', '💸', '💵', '💴',
      '💶', '💷', '🪙', '💰', '💳', '💎', '⚖️', '🪜', '🧰', '🪛', '🔧', '🔨', '⚒️',
      '🛠️', '⛏️', '🪚', '🔩', '⚙️', '🪤', '🧱', '⛓️', '🧲', '🔫', '💣', '🧨', '🪓',
      '🔪', '🗡️', '⚔️', '🛡️', '🚬', '⚰️', '🪦', '⚱️', '🏺', '🔮', '📿', '🧿', '💈',
      '⚗️', '🔭', '🔬', '🕳️', '🩹', '🩺', '💊', '💉', '🩸', '🧬', '🦠', '🧫', '🧪',
      '🌡️', '🧹', '🪠', '🧺', '🧻', '🚽', '🚰', '🚿', '🛁', '🛀', '🧼', '🪥', '🪒',
      '🧽', '🪣', '🧴', '🗝️', '🔑', '🔐', '🔏', '🔒', '🔓', '📦', '🎁', '🎈', '🎉',
      '🎊', '✉️', '📩', '📨', '📧', '💌', '📮', '📝', '📁', '📂', '📄', '📃', '📊',
      '📈', '📉', '📜', '📋', '📅', '📆', '📇', '📚', '📖', '📗', '📘', '📙', '📕'
    ]
  },
  {
    id: 'symbols',
    icon: '❤️',
    titleKey: 'emoji_symbols',
    title: 'Symbols',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞',
      '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯',
      '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐',
      '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳', '🈶', '🈚', '🈸', '🈺',
      '🈯', '♨️', '🛑', '🕛', '🕧', '🕐', '🕜', '🕑', '🕝', '🕒', '🕞', '🕓', '🕟', '🕔',
      '🕠', '🕕', '🕡', '🕖', '🕢', '🕗', '🕣', '🕘', '🕤', '🕙', '🕥', '🕚', '🕦', '✖️',
      '➕', '➖', '➗', '♾️', '‼️', '⁉️', '❓', '❔', '❕', '❗️', '〰️', '💱', '💲', '⚕️',
      '♻️', '⚜️', '🔱', '📛', '🔰', '⭕', '✅', '☑️', '✔️', '❌', '❎', '➰', '➿', '〽️',
      '✳️', '✴️', '❇️', '©️', '®️', '™️', '💯', '🔥', '✨', '🌟', '💫', '💥', '💢', '💦', '💨'
    ]
  }
];

function getRecentEmojis() {
  try {
    const raw = localStorage.getItem('holy_recent_emojis');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch { }
  return ['😊', '😂', '❤️', '👍', '🙏', '🔥', '😍', '😭', '🎉', '🌟', '👏', '🤝', '💯', '😎', '🤔', '🥰'];
}

function saveRecentEmoji(ch) {
  try {
    const list = getRecentEmojis().filter(e => e !== ch);
    list.unshift(ch);
    if (list.length > 24) list.length = 24;
    localStorage.setItem('holy_recent_emojis', JSON.stringify(list));
    updateRecentEmojiGrid();
  } catch { }
}

function updateRecentEmojiGrid() {
  const grid = document.getElementById('emoji-grid-recent');
  if (!grid) return;
  const recent = getRecentEmojis();
  grid.innerHTML = recent.map(ch =>
    `<button type="button" class="emoji-btn-item" onclick="insertEmoji('${ch}')" aria-label="${ch}">${ch}</button>`
  ).join('');
}

function buildEmojiPickerDOM() {
  const picker = $('emojiPicker');
  if (!picker) return;

  const getLabel = (key, fallback) => {
    try {
      const val = typeof t === 'function' ? t(key) : key;
      return (val && val !== key) ? val : fallback;
    } catch { return fallback; }
  };

  const tabsHtml = [
    `<button type="button" class="emoji-tab-btn active" data-cat-id="recent" title="${getLabel('emoji_recent', 'Recent')}" aria-label="${getLabel('emoji_recent', 'Recent')}">🕒</button>`,
    ...EMOJI_CATEGORIES.map(c =>
      `<button type="button" class="emoji-tab-btn" data-cat-id="${c.id}" title="${getLabel(c.titleKey, c.title)}" aria-label="${getLabel(c.titleKey, c.title)}">${c.icon}</button>`
    )
  ].join('');

  const recent = getRecentEmojis();
  const recentSection = `
    <div class="emoji-section" id="emoji-section-recent" data-cat="recent">
      <div class="emoji-section-title">${getLabel('emoji_recent', 'Recent')}</div>
      <div class="emoji-grid" id="emoji-grid-recent">
        ${recent.map(ch => `<button type="button" class="emoji-btn-item" onclick="insertEmoji('${ch}')" aria-label="${ch}">${ch}</button>`).join('')}
      </div>
    </div>`;

  const categoriesHtml = EMOJI_CATEGORIES.map(c => `
    <div class="emoji-section" id="emoji-section-${c.id}" data-cat="${c.id}">
      <div class="emoji-section-title">${getLabel(c.titleKey, c.title)}</div>
      <div class="emoji-grid">
        ${c.emojis.map(ch => `<button type="button" class="emoji-btn-item" onclick="insertEmoji('${ch}')" aria-label="${ch}">${ch}</button>`).join('')}
      </div>
    </div>`
  ).join('');

  picker.innerHTML = `
    <div class="emoji-picker-tabs">${tabsHtml}</div>
    <div class="emoji-picker-body">${recentSection}${categoriesHtml}</div>
  `;

  // Attach tab switching and scroll tracking
  const tabsContainer = picker.querySelector('.emoji-picker-tabs');
  const body = picker.querySelector('.emoji-picker-body');

  tabsContainer?.addEventListener('click', (e) => {
    const btn = e.target.closest('.emoji-tab-btn');
    if (!btn) return;
    const catId = btn.dataset.catId;
    const targetSection = picker.querySelector(`#emoji-section-${catId}`);
    if (targetSection && body) {
      body.scrollTo({ top: targetSection.offsetTop - body.offsetTop, behavior: 'smooth' });
    }
    tabsContainer.querySelectorAll('.emoji-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    try { if (typeof haptic === 'function') haptic('selection'); } catch { }
  });

  // Spy on scroll to highlight active tab
  let scrollTimeout = null;
  body?.addEventListener('scroll', () => {
    if (scrollTimeout) return;
    scrollTimeout = setTimeout(() => {
      scrollTimeout = null;
      const sections = body.querySelectorAll('.emoji-section');
      const scrollTop = body.scrollTop + 20;
      let activeCat = 'recent';
      sections.forEach(sec => {
        if (sec.offsetTop - body.offsetTop <= scrollTop) {
          activeCat = sec.dataset.cat;
        }
      });
      tabsContainer?.querySelectorAll('.emoji-tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.catId === activeCat);
      });
    }, 50);
  });
}

function toggleEmojiPicker() {
  const picker = $('emojiPicker');
  if (!picker) return;

  if (picker.children.length === 0) {
    buildEmojiPickerDOM();
  }

  const opening = picker.classList.contains('hidden');
  closeComposerPopups();
  if (opening) {
    picker.classList.remove('hidden');
    updateRecentEmojiGrid();
  }
}

function insertEmoji(emoji) {
  saveRecentEmoji(emoji);
  const input = $('chatInput');
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
  const caret = start + emoji.length;
  input.focus();
  try { input.setSelectionRange(caret, caret); } catch { }
  handleChatTyping();
}

// Close the emoji picker / attach menu when clicking outside them
document.addEventListener('click', (e) => {
  const picker = $('emojiPicker');
  const btn = document.querySelector('.emoji-btn');
  if (picker && !picker.classList.contains('hidden')) {
    if (!picker.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
      picker.classList.add('hidden');
    }
  }
  const menu = $('attachMenu');
  const clip = $('attachBtn');
  if (menu && !menu.classList.contains('hidden')) {
    if (!menu.contains(e.target) && !clip?.contains(e.target)) menu.classList.add('hidden');
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
    const [requests, referrals] = await Promise.all([
      apiFetch('/api/mentors/my-requests'),
      apiFetch('/api/mentors/referrals').catch(() => []),
    ]);
    _reqData = { mentee: requests || [], referred: referrals || [] };
    updateRequestCounts();
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
function jumpToSettingsSection(btn, targetId) {
  haptic('selection');
  $(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $$('.settings-nav-item').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
}

async function loadSettings() {
  const nameInput = $('settingDisplayName');
  if (nameInput && !nameInput.dataset.errClearBound) {
    nameInput.dataset.errClearBound = '1';
    nameInput.addEventListener('input', () => clearFieldError('settingDisplayName'));
  }
  try {
    const s = await apiFetch('/api/users/settings');
    $('settingDisplayName').value = s.display_name || '';
    $('toggleMessages').checked = s.notify_messages !== false;
    $('toggleSessions').checked = s.notify_sessions !== false;
    $('toggleVerse').checked = s.notify_daily_verse !== false;
    $('toggleStreak').checked = s.notify_streak_reminder !== false;

    if (currentUser?.role === 'mentor') {
      $('settingsNavMentor')?.classList.remove('hidden');
      if ($('settingBio')) $('settingBio').value = s.bio || '';
      renderBioDisplay(s.bio || '');
      if ($('settingSpecialization')) $('settingSpecialization').value = s.specialization || '';
      if ($('settingMaxMentees')) $('settingMaxMentees').value = s.max_mentees || 5;
      const menteeSex = s.preferred_mentee_sex || 'prefer_not';
      const menteeSexLabels = { prefer_not: 'Both', M: 'Male only', F: 'Female only' };
      selectMenteeSex(menteeSex, menteeSexLabels[menteeSex] || 'Both');

      const acceptToggle = $('toggleAcceptingRequests');
      if (acceptToggle) {
        acceptToggle.checked = s.accepting_requests !== false;
      }
    }

    // Keep the mentor's own rating fresh: mentees can rate at any time, and
    // currentUser was loaded once at app start.
    if (currentUser && s.rating !== undefined) {
      currentUser.rating = s.rating;
      currentUser.rating_count = s.rating_count;
    }

    updateProfileIdentity();
    loadProfilePhoto();
  } catch (e) { showToast(e.message, 'error'); }
}

/** A mentor's own rating for the Profile hero, styled to match what mentees
 * see on mentor cards (renderModernRating): stars rounded to the nearest
 * whole star, the exact average, and the number of ratings. */
function renderProfileRating(rating, count) {
  const n = Number(count) || 0;
  const r = Number(rating) || 0;
  if (n <= 0 || r <= 0) {
    return `<span class="profile-rating-empty">${escapeHtml(t('no_ratings_yet') || 'No ratings yet')}</span>`;
  }
  const filled = Math.max(0, Math.min(5, Math.round(r)));
  let stars = '';
  for (let i = 1; i <= 5; i++) {
    stars += `<svg class="${i <= filled ? 'star-on' : 'star-off'}" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  }
  return `<span class="profile-rating-stars">${stars}</span>` +
    `<span class="profile-rating-val">${r.toFixed(1)}</span>` +
    `<span class="profile-rating-count">(${n})</span>`;
}

/** Syncs the small pieces of "who am I" text/chips that appear in both the
 * Profile hero (view-only) and the Edit Profile modal (editable context). */
function updateProfileIdentity() {
  const name = currentUser?.user_settings?.display_name || currentUser?.anonymous_id || '—';
  const heroName = $('profileHeroName');
  if (heroName) heroName.textContent = name;

  // Mentors see their own rating right under their name.
  const heroRating = $('profileHeroRating');
  if (heroRating) {
    if (currentUser?.role === 'mentor') {
      heroRating.innerHTML = renderProfileRating(currentUser.rating, currentUser.rating_count);
      const n = Number(currentUser.rating_count) || 0;
      heroRating.setAttribute('aria-label', n > 0
        ? `${Number(currentUser.rating).toFixed(1)} out of 5, ${n} rating${n === 1 ? '' : 's'}`
        : 'No ratings yet');
      heroRating.style.display = 'flex';
    } else {
      heroRating.style.display = 'none';
      heroRating.innerHTML = '';
    }
  }

  const anonId = currentUser?.anonymous_id || '';
  const rawRole = currentUser?.role || '';
  const formattedRole = rawRole ? (rawRole.charAt(0).toUpperCase() + rawRole.slice(1)) : '';

  if ($('userAnonId')) $('userAnonId').textContent = anonId;
  if ($('userRole')) {
    $('userRole').textContent = formattedRole;
    $('userRole').style.display = formattedRole ? 'inline-block' : 'none';
  }
  if ($('editProfileAnonId')) $('editProfileAnonId').textContent = anonId;
  if ($('editProfileRole')) $('editProfileRole').textContent = formattedRole;
}

// Live page segmented switch: Private | Group (both lists keep refreshing while hidden)
function switchSessionsTab(tab) {
  const group = tab === 'group';
  $('sessPanePrivate')?.classList.toggle('active', !group);
  $('sessPaneGroup')?.classList.toggle('active', group);
  [['sessTabPrivate', !group], ['sessTabGroup', group]].forEach(([id, on]) => {
    const el = $(id); if (!el) return;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  haptic('selection');
}

// Profile page segmented switch: Preferences | Support
function switchProfileTab(tab) {
  const help = tab === 'help';
  $('profilePanePrefs')?.classList.toggle('active', !help);
  $('profilePaneHelp')?.classList.toggle('active', help);
  [['profileTabPrefs', !help], ['profileTabHelp', help]].forEach(([id, on]) => {
    const el = $(id); if (!el) return;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  haptic('selection');
}
// Unread support replies live inside the Support pane — mirror them as a dot on the tab.
(function watchProfileSupportBadge() {
  const init = () => {
    const badge = $('profileSupportBadge'), tab = $('profileTabHelp');
    if (!badge || !tab || badge._watched) return !!badge;
    badge._watched = true;
    let dot = tab.querySelector('.profile-tab-dot');
    if (!dot) { dot = document.createElement('i'); dot.className = 'profile-tab-dot'; tab.appendChild(dot); }
    const sync = () => dot.classList.toggle('on', badge.style.display !== 'none' && (badge.textContent || '0').trim() !== '0');
    new MutationObserver(sync).observe(badge, { attributes: true, childList: true, characterData: true, subtree: true });
    sync();
    return true;
  };
  if (!init()) document.addEventListener('DOMContentLoaded', init);
})();

function avatarInitials() {
  const name = currentUser?.user_settings?.display_name || currentUser?.anonymous_id || '?';
  const text = String(name || '?').trim();
  return text ? text.charAt(0).toUpperCase() : '?';
}

// The avatar now renders in two places at once — the read-only Profile
// hero and the editable Edit Profile modal — so this keeps both in sync
// from a single fetch instead of loading the photo twice.
async function loadProfilePhoto() {
  const targets = [$('settingsAvatarPreview'), $('editAvatarPreview')].filter(Boolean);
  const removeBtn = $('removeAvatarBtn');
  if (!targets.length) return;

  const initials = avatarInitials();
  targets.forEach(el => { el.textContent = initials; el.classList.remove('has-photo'); });
  removeBtn?.classList.add('hidden');

  if (!currentUser?.photo_file_id) return;

  targets.forEach(el => el.classList.add('avatar-loading'));
  try {
    const url = await loadAvatarUrl(currentUser.telegram_id, currentUser.photo_updated_at || '');
    targets.forEach(el => {
      const img = document.createElement('img');
      img.alt = '';
      img.onerror = () => { el.textContent = initials; el.classList.remove('has-photo'); removeBtn?.classList.add('hidden'); };
      img.src = url;
      el.innerHTML = '';
      el.appendChild(img);
      el.classList.add('has-photo');
    });
    removeBtn?.classList.remove('hidden');
  } catch (e) {
    console.error('Failed to load profile photo:', e);
  } finally {
    targets.forEach(el => el.classList.remove('avatar-loading'));
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
  const box = $('bioDisplayWrap');
  const textarea = $('settingBio');
  // Open the field at the height the read-only box had (within sensible limits)
  // and keep it there while typing: a field that resizes on every keystroke
  // makes the page below it jump.
  const boxHeight = Math.round(box.getBoundingClientRect().height);
  textarea.style.height = Math.min(Math.max(boxHeight, 120), 280) + 'px';
  box.classList.add('hidden');
  $('bioEditWrap').classList.remove('hidden');
  textarea.focus();
  const end = textarea.value.length;
  textarea.setSelectionRange(end, end);
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
    notify_messages: $('toggleMessages').checked,
    notify_sessions: $('toggleSessions').checked,
    notify_daily_verse: $('toggleVerse').checked,
    notify_streak_reminder: $('toggleStreak').checked,
    bio: $('settingBio')?.value,
    specialization: $('settingSpecialization')?.value,
    max_mentees: parseInt($('settingMaxMentees')?.value) || 5,
  };
  if (currentUser?.role === 'mentor') {
    body.accepting_requests = $('toggleAcceptingRequests')?.checked;
    body.preferred_mentee_sex = $('settingMenteeSex')?.value;
  }
  try {
    const updated = await apiFetch('/api/users/settings', { method: 'PATCH', body });
    if (currentUser) {
      currentUser.user_settings = { ...(currentUser.user_settings || {}), ...updated };
    }
    updateProfileIdentity();
    haptic('success');
    showToast(t('settings_saved') || 'Settings saved', 'success');
    return true;
  } catch (e) {
    haptic('error');
    if (e.nickname_taken) {
      showInlineError('settingDisplayName', t('err_nickname_taken'));
    } else {
      showToast(e.message, 'error');
    }
    return false;
  }
}

// ─── Edit Profile modal ────────────────────────────────────────
function openEditProfileModal() {
  haptic('light');
  clearFieldError('settingDisplayName');
  $('editProfileModal')?.classList.add('open');
}

function closeEditProfileModal() {
  haptic('light');
  $('editProfileModal')?.classList.remove('open');
}

async function saveProfileFromModal() {
  const ok = await saveSettings();
  // Leave the modal open if the save failed (e.g. nickname taken) so the
  // person can see and fix the inline error instead of losing it.
  if (ok) closeEditProfileModal();
}

// ─── Notifications modal ───────────────────────────────────────
function openNotificationsModal() {
  haptic('light');
  $('notificationsModal')?.classList.add('open');
}

function closeNotificationsModal() {
  haptic('light');
  $('notificationsModal')?.classList.remove('open');
}

async function saveNotificationsFromModal() {
  const ok = await saveSettings();
  if (ok) closeNotificationsModal();
}

// ─── Mentor Profile modal ──────────────────────────────────────
function openMentorProfileModal() {
  haptic('light');
  $('mentorProfileModal')?.classList.add('open');
}

function closeMentorProfileModal() {
  haptic('light');
  $('mentorProfileModal')?.classList.remove('open');
}

async function saveMentorProfileFromModal() {
  const ok = await saveSettings();
  if (ok) closeMentorProfileModal();
}

// ─── Contact Admin ────────────────────────────────────────────
function contactAdmin() {
  haptic('light');
  const tgUsername = 'YIDIDIYATAMIRUU';
  const url = `https://t.me/${tgUsername}`;
  if (window.Telegram?.WebApp?.openTelegramLink) {
    window.Telegram.WebApp.openTelegramLink(url);
  } else {
    window.open(url, '_blank');
  }
}

// ─── FAQ modal ────────────────────────────────────────────────
function openFaqModal() {
  haptic('light');
  $('faqModal')?.classList.add('open');
}

function closeFaqModal() {
  haptic('light');
  $('faqModal')?.classList.remove('open');
}

function toggleFaqItem(el) {
  haptic('selection');
  if (el) el.classList.toggle('open');
}

async function toggleAcceptingRequests() {
  haptic('light');
  const el = $('toggleAcceptingRequests');
  if (!el) return;
  // The checkbox has already flipped its own .checked state natively by
  // the time this change handler fires.
  const nextValue = el.checked;

  try {
    await apiFetch('/api/users/settings', {
      method: 'PATCH',
      body: { accepting_requests: nextValue }
    });
    haptic('success');
    showToast('Request availability updated.', 'success');
  } catch (e) {
    haptic('error');
    el.checked = !nextValue; // revert on error
    showToast(e.message, 'error');
  }
}

function toggleNotif(id) {
  haptic('light');
  // The neo-toggle checkbox already flips its own .checked state natively;
  // saveSettings() reads it directly when the user hits Save.
}

function selectMenteeSex(value, labelText) {
  haptic('selection');
  const input = $('settingMenteeSex');
  if (input) input.value = value;
  const label = $('settingMenteeSexLabel');
  if (label) label.textContent = labelText;
  const menu = $('settingMenteeSexDropdown')?.querySelector('.premium-dropdown-menu');
  if (menu) {
    menu.querySelectorAll('.dropdown-item').forEach(item => {
      item.classList.toggle('selected', item.dataset.value === value);
    });
  }
}

// ─── Mentor Application ───────────────────────────────────────
async function openApplyModal() {
  haptic('light');
  // A current mentee has to end their mentorship, rate the mentor and give a
  // reason before applying. The server enforces this too (409 ACTIVE_MENTORSHIP).
  try {
    const current = await apiFetch('/api/users/my-mentor');
    if (current && current.mentor_id) {
      const m = current.mentor;
      openEndToApplyWarning(m?.user_settings?.display_name || m?.anonymous_id || '');
      return;
    }
  } catch (e) { /* non-fatal: fall through, the server re-checks on submit */ }
  showApplyForm();
}

function showApplyForm() {
  selectApplySex('', t('Select…') || 'Select…');
  $('applyEdu').value = '';
  $('applyAbout').value = '';
  $('applyModal').classList.add('open');
}

function selectApplySex(val, text, e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  haptic('selection');
  const input = $('applySex');
  if (input) input.value = val;
  const btnText = $('applySexSelectedText');
  if (btnText) {
    const localText = val ? t(val === 'prefer_not' ? 'sex_both' : val === 'M' ? 'sex_male' : 'sex_female') : '';
    btnText.textContent = localText || text;
  }
  const menu = $('applySexDropdownMenu');
  if (menu) {
    menu.querySelectorAll('.dropdown-item').forEach(item => {
      item.classList.toggle('selected', item.dataset.value === val);
    });
  }
  $('applySexDropdown')?.removeAttribute('data-open');
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
  } catch (e) {
    haptic('error');
    if (e.code === 'ACTIVE_MENTORSHIP') {
      // Matched with a mentor after the form was opened: send them through
      // the end-and-rate step instead of showing a raw error.
      closeApplyModal();
      openApplyModal();
      return;
    }
    showToast(e.message, 'error');
  }
}

// ─── End mentorship before applying to become a mentor ────────
const END_TO_APPLY_REASON_MAX = 500;
const END_TO_APPLY_REASON_MIN = 3;
let endToApplyStars = 0;

function paintEndToApplyStars(n) {
  const wrap = $('endToApplyStars');
  if (!wrap) return;
  wrap.innerHTML = [1, 2, 3, 4, 5].map(i => `
    <svg width="30" height="30" viewBox="0 0 24 24" data-star="${i}" role="radio"
      aria-checked="${i === n}" aria-label="${i}"
      fill="${i <= n ? '#C9A84C' : 'none'}" stroke="${i <= n ? 'none' : '#867F76'}" stroke-width="1.5"
      style="cursor:pointer">
      <path d="M12 .587l3.668 7.568 8.332 1.151-6.064 5.828 1.48 8.279-7.416-4.045-7.416 4.045 1.48-8.279-6.064-5.828 8.332-1.151z"/>
    </svg>`).join('');
  wrap.querySelectorAll('svg').forEach(svg => {
    svg.onclick = () => {
      haptic('selection');
      const picked = parseInt(svg.dataset.star, 10);
      endToApplyStars = (picked === endToApplyStars) ? 0 : picked;   // tap the same star again = undo
      paintEndToApplyStars(endToApplyStars);
    };
  });
}

// Step 1: warn that ending the mentorship comes first. Only "Yes, continue"
// moves on to the rate-and-reason sheet.
let endToApplyMentorName = '';

function openEndToApplyWarning(mentorName) {
  endToApplyMentorName = mentorName || '';
  $('endToApplyWarnModal').classList.add('open');
}

function closeEndToApplyWarning() {
  haptic('light');
  $('endToApplyWarnModal').classList.remove('open');
}

function confirmEndToApplyWarning() {
  haptic('medium');
  $('endToApplyWarnModal').classList.remove('open');
  openEndToApplyModal(endToApplyMentorName);
}

function openEndToApplyModal(mentorName) {
  endToApplyStars = 0;
  paintEndToApplyStars(0);
  $('endToApplyReason').value = '';
  const name = mentorName || t('end_to_apply_mentor_fallback');
  $('endToApplyIntro').textContent = t('end_to_apply_intro', { name });
  const btn = $('endToApplySubmitBtn');
  if (btn) btn.disabled = false;
  $('endToApplyModal').classList.add('open');
}

function closeEndToApplyModal() {
  haptic('light');
  $('endToApplyModal').classList.remove('open');
}

async function submitEndToApply() {
  const reason = ($('endToApplyReason').value || '').trim();
  const fail = (msg) => { haptic('error'); showToast(msg, 'error'); };

  if (!endToApplyStars) return fail(t('end_to_apply_rating_required'));
  if (reason.length < END_TO_APPLY_REASON_MIN) return fail(t('end_to_apply_reason_required'));
  if (reason.length > END_TO_APPLY_REASON_MAX) {
    return fail(t('end_to_apply_reason_too_long', { max: END_TO_APPLY_REASON_MAX }));
  }

  const btn = $('endToApplySubmitBtn');
  if (btn) btn.disabled = true;
  haptic('medium');
  try {
    await apiFetch('/api/users/end-mentorship-and-rate', {
      method: 'POST',
      body: { stars: endToApplyStars, reason }
    });
  } catch (e) {
    // NO_ACTIVE_MENTORSHIP: it was already ended (other device, or the mentor
    // ended it first). Nothing left to end, so just carry on to the form.
    if (e.code !== 'NO_ACTIVE_MENTORSHIP') {
      if (btn) btn.disabled = false;
      const byCode = {
        RATING_REQUIRED: 'end_to_apply_rating_required',
        REASON_REQUIRED: 'end_to_apply_reason_required'
      };
      if (e.code === 'REASON_TOO_LONG') return fail(t('end_to_apply_reason_too_long', { max: END_TO_APPLY_REASON_MAX }));
      return fail(byCode[e.code] ? t(byCode[e.code]) : e.message);
    }
  }

  haptic('success');
  showToast(t('end_to_apply_done'), 'success');
  closeEndToApplyModal();
  updateMessageBadge();
  showApplyForm();
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
  const badges = [$('supportBadge'), $('profileSupportBadge')].filter(Boolean);
  if (!badges.length) return;

  if (Array.isArray(ticketsData)) {
    const activeCount = ticketsData.filter(t => t.status === 'open' || t.status === 'in_progress').length;
    badges.forEach(b => {
      if (activeCount > 0) {
        b.textContent = activeCount;
        b.style.display = 'inline-block';
      } else {
        b.style.display = 'none';
      }
    });
  } else {
    apiFetch('/api/support').then(tickets => {
      const activeCount = (tickets || []).filter(t => t.status === 'open' || t.status === 'in_progress').length;
      badges.forEach(b => {
        if (activeCount > 0) {
          b.textContent = activeCount;
          b.style.display = 'inline-block';
        } else {
          b.style.display = 'none';
        }
      });
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

    // Render original ticket message + reply thread as plain speech
    // bubbles, matching the main mentor chat: just the text and a
    // timestamp, aligned right (gold, "sent") for the user's own messages
    // and left (dark, "received") for admin replies. The old card-style
    // layout — icon + role label header, wide 92%-width boxes regardless
    // of sender, the user's own "Original Issue" message oddly pinned to
    // the left — is gone; a reader can now tell the two sides apart by
    // position and colour the same way they already do in the mentor chat.
    const ticketBubble = (content, time, isSent) => `
      <div class="message-bubble ${isSent ? 'sent' : 'received'}">
        <div class="message-text">${escapeHtml(content)}</div>
        <div class="message-footer">
          <span class="message-time">${formatTime(time)}</span>
        </div>
      </div>`;

    let html = ticketBubble(ticket.description, ticket.created_at, true);

    if (replies.length === 0 && ticket.admin_reply) {
      html += ticketBubble(ticket.admin_reply, ticket.updated_at || ticket.created_at, false);
    }

    replies.forEach(r => {
      html += ticketBubble(r.content, r.created_at, r.sender_type !== 'admin');
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

function selectTicketCategory(val, text) {
  haptic('selection');
  const input = $('modalTicketCategory');
  if (input) input.value = val;
  const label = $('modalTicketCategoryLabel');
  if (label) label.textContent = text;
  const menu = $('modalTicketCategoryDropdown')?.querySelector('.premium-dropdown-menu');
  if (menu) {
    menu.querySelectorAll('.dropdown-item').forEach(item => {
      item.classList.toggle('selected', item.dataset.value === val);
    });
  }
}

function toggleNewTicketModal(show) {
  haptic('selection');
  const modal = $('newTicketModal');
  if (!modal) return;
  modal.style.display = '';
  modal.classList.toggle('open', show);
  if (show) {
    $('modalTicketSubject').value = '';
    $('modalTicketDesc').value = '';
    selectTicketCategory('', 'General');
  }
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
    selectTicketCategory('', 'General');
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

// Topics keep English in `name` and Amharic in `name_am`; show only the language
// the app is currently set to (English if no Amharic name exists yet).
function topicLabel(tp) {
  if (!tp) return '';
  return (currentLanguage === 'am' && tp.name_am) ? tp.name_am : (tp.name || '');
}
// Label for the selected topic filter, always in the current language
// (the stored topic_name would go stale after switching EN/AM).
function topicFilterLabel(filters) {
  const id = filters && filters.topic_id;
  if (!id) return t('all_topics') || 'All Topics';
  const tp = (typeof mentorTopicsCache !== 'undefined' ? mentorTopicsCache || [] : []).find(x => String(x.id) === String(id));
  return tp ? topicLabel(tp) : (filters.topic_name || t('all_topics') || 'All Topics');
}
// Search should match either language so people can type in whichever they know.
function topicTextMatches(tp, q) {
  q = (q || '').toLowerCase();
  return (tp.name || '').toLowerCase().includes(q) || (tp.name_am || '').toLowerCase().includes(q);
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
  $$('#languageSegmented .segmented-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === currentLanguage);
  });

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
  refreshLanguageContent();
  loadDashboard();
}

function toggleLanguage() {
  haptic('selection');
  const next = currentLanguage === 'en' ? 'am' : 'en';
  currentLanguage = next;
  localStorage.setItem('language', next);
  applyLanguage();
  refreshLanguageContent();
  loadDashboard();
}

// applyLanguage() only retranslates the static labels in index.html. Anything
// the JS draws itself (mentor cards, chips, lists) was left in the old language
// until you left the page and came back. Draw the page you are on again, from
// what is already loaded where we can, so the switch is instant.
function refreshLanguageContent() {
  try {
    if (_transferAssignmentId != null && $('transferModal')?.classList.contains('open')) { renderTransferSheet(); }
    switch (currentPage) {
      case 'mentors':
        renderMentorTopicChips();
        updateFilterActiveIndicators();
        renderActiveMentorCard();
        renderMentorsList();
        break;
      case 'mentor-profile':
        if (openMentorSheetId != null) renderMentorProfilePage(openMentorSheetId);
        break;
      case 'sessions': loadSessions(); break;
      case 'requests': loadRequests(); break;
      case 'support': loadUserTickets(); break;
      case 'journal': loadJournalEntries(); break;
      case 'my-mentees': flushMentorNotes(); loadMyMentees(); break;
      // chat and settings hold text being typed, so they are left alone.
    }
  } catch (e) {
    console.error('[i18n] could not redraw the page after switching language:', e);
  }
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
let _myMenteesRenderedSig = '';

/**
 * Single source of truth for a mentee's activity state — online / last-active
 * time / needs-follow-up — consumed by the one compact status readout on the
 * mentee card (dot + time, with a follow-up chip when it applies).
 */
function menteeActivityMeta(user) {
  const lastActive = user.last_active;
  const online = isUserOnline(lastActive);
  const staleMs = lastActive ? Date.now() - new Date(lastActive).getTime() : Infinity;
  const needsFollowup = !online && staleMs >= MENTEE_INACTIVITY_THRESHOLD_MS;
  const label = online
    ? t('mentee_status_online')
    : (lastActive ? t('mentee_status_active_ago', { time: timeAgo(lastActive) }) : t('mentee_status_never_active'));
  const dotClass = online ? 'online' : (needsFollowup ? 'stale' : 'offline');
  return { online, needsFollowup, label, dotClass };
}

/** Renders the compact "● Online now / Active 2h ago [Follow-up]" readout for a mentee card. */
function renderMenteeActivity(user) {
  const a = menteeActivityMeta(user);
  const chip = a.needsFollowup
    ? `<span class="mentee-followup-pill">${t('mentee_needs_followup')}</span>`
    : '';
  return `<div class="mentee-status-line mentee-status-line-compact">
    <div class="mentee-status-row">
      <span class="mentee-status-dot ${a.dotClass}"></span>
      <span class="mentee-status-text">${escapeHtml(a.label)}</span>
    </div>
    ${chip}
  </div>`;
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
  updateMenteeSortUI();
  renderMenteesList();
}

/** Syncs the compact sort dropdown (trigger label + selected item + closed state) with menteeSortMode. */
function updateMenteeSortUI() {
  const recentBtn = $('menteeSortRecentBtn');
  const followupBtn = $('menteeSortFollowupBtn');
  recentBtn?.classList.toggle('selected', menteeSortMode === 'recent');
  followupBtn?.classList.toggle('selected', menteeSortMode === 'followup');
  const activeBtn = menteeSortMode === 'followup' ? followupBtn : recentBtn;
  const label = $('menteeSortDropdownLabel');
  if (label && activeBtn) label.textContent = activeBtn.textContent;
  $('menteeSortDropdown')?.removeAttribute('data-open');
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
  // The list is about to be replaced; make sure nothing typed is left unsaved.
  await flushMentorNotes();
  // Only show the skeleton when there is nothing on screen yet. Wiping a list that
  // is already drawn and rebuilding it a moment later was the visible "blink".
  const alreadyDrawn = !!container.querySelector('.mentee-card');
  if (!alreadyDrawn) {
    container.innerHTML = window.skeletonHTML ? skeletonHTML(3) : '<div class="loading-spinner" style="margin:40px auto"></div>';
  }
  try {
    const [mentees, followup, streaks, notes] = await Promise.all([
      apiFetch('/api/mentors/my-mentees'),
      apiFetch('/api/mentors/my-mentees/followup').catch(() => ({})),
      apiFetch('/api/mentors/my-mentees/streaks').catch(() => ({})),
      apiFetch('/api/mentors/notes').catch(() => null),
    ]);

    _myMenteesCache = mentees || [];
    _myMenteesFollowupCache = followup || {};
    _myMenteesStreakCache = streaks || {};
    applyLoadedMentorNotes(notes, _myMenteesCache);

    $('activeMenteeCount').textContent = _myMenteesCache.length;
    const followupCount = _myMenteesCache.filter(m => menteeIsStale(m.user)).length;
    const summaryEl = $('menteeFollowupSummary');
    if (summaryEl) {
      summaryEl.style.display = followupCount > 0 ? 'flex' : 'none';
      $('menteeFollowupCount').textContent = followupCount;
    }
    updateMenteeSortUI();

    if (!_myMenteesCache.length) {
      container.innerHTML = `<div class="empty-state"><span>${t('no_active_mentees_yet')}</span></div>`;
      return;
    }

    // Same data as what is already on screen: leave the DOM (and scroll position,
    // open goal panels, half-typed notes) alone.
    const signature = JSON.stringify([
      currentLanguage,
      _myMenteesCache.map(m => [m.id, m.user.telegram_id, m.user.last_active, m.user.photo_updated_at, m.user.user_settings?.display_name]),
      _myMenteesFollowupCache,
      _myMenteesStreakCache,
    ]);
    if (alreadyDrawn && signature === _myMenteesRenderedSig) return;
    _myMenteesRenderedSig = signature;

    renderMenteesList();
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
    const actionsId = `menteeActions-${assignId}`;

    // Layout: [profile: avatar + name/status + actions menu, streak] then a
    // divider, then [body: goals, private note]. Spacing between and inside
    // these groups is set in styles.css (.mentee-card*), not with utility
    // classes. IDs / data-* hooks used by the goal, note and dropdown code
    // are unchanged; the goals toggle must stay directly before its panel
    // (see updateMenteeGoalsBadge, which uses previousElementSibling).
    html += `
      <div class="card gold-border mentee-card">
        <div class="mentee-card-profile">
          <div class="mentee-card-head">
            ${renderAvatar(user, letter)}
            <div class="mentee-card-identity">
              <div class="mentee-card-name">${escapeHtml(displayName)}</div>
              ${renderMenteeActivity(user)}
            </div>
            <div class="premium-dropdown mentee-actions" data-dropdown id="${actionsId}">
              <button type="button" class="mentee-actions-btn" data-dropdown-toggle aria-haspopup="menu" aria-label="${t('mentee_actions_label')}" title="${t('mentee_actions_label')}">${menteeIcon('more', 18)}</button>
              <div class="premium-dropdown-menu" data-dropdown-menu>
                <button type="button" class="dropdown-item" onclick="openTransferModal('${assignId}')">${menteeIcon('transfer', 14)}${t('btn_transfer')}</button>
                <button type="button" class="dropdown-item" style="color:var(--danger)" onclick="endMentorship('${assignId}')">${menteeIcon('userMinus', 14)}${t('btn_end')}</button>
              </div>
            </div>
          </div>
          ${renderMenteeStreakBadge(user.telegram_id)}
        </div>

        <div class="mentee-card-body">
          <div class="mentee-goals">
            <button class="goal-toggle-btn" onclick="toggleMenteeGoals('${user.telegram_id}', this)">
              <span style="display:flex;align-items:center;gap:6px;">${menteeIcon('target', 14)}${goalsLabel}</span>
              <span class="goal-toggle-caret">${menteeIcon('chevronDown', 14)}</span>
            </button>
            <div id="goalPanel-${user.telegram_id}" class="goal-panel" style="display:none" data-mentee-id="${user.telegram_id}"></div>
          </div>
          <div class="mentee-note">
            <div class="mentee-note-head">
              <label class="mentee-note-label" for="note-${user.telegram_id}">${menteeIcon('lock', 13)}<span data-i18n="mentee_note_label">${t('mentee_note_label')}</span></label>
              <div id="noteStatus-${user.telegram_id}" class="mentor-note-status" role="status" aria-live="polite" onclick="retryMentorNote('${user.telegram_id}')"></div>
            </div>
            <textarea id="note-${user.telegram_id}" class="form-control text-sm" data-i18n="Private note about this mentee..." placeholder="${t('Private note about this mentee...')}" rows="2" maxlength="${MENTOR_NOTE_MAX}" ${_mentorNotesLoadFailed ? 'disabled' : ''} oninput="onMentorNoteInput('${user.telegram_id}')" onblur="saveMentorNote('${user.telegram_id}')">${escapeHtml(mentorNoteValue(user.telegram_id))}</textarea>
          </div>
        </div>
      </div>`;
  }
  container.innerHTML = html;
  hydrateAvatars(container);
  // Restore each note's save-status line (e.g. "Saved" / "tap to retry")
  for (const m of mentees) setMentorNoteStatus(m.user.telegram_id, _mentorNoteStatus[m.user.telegram_id] || '');
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
  const missed = !g.is_done && (g.is_missed || isGoalLocked(g));
  const cb = goalCheckboxAttrs(g);
  const due = g.due_date
    ? `<div class="goal-item-due">${t('mentee_goal_due')} ${new Date(g.due_date).toLocaleDateString()}${missed ? ` <span class="goal-missed-badge">${t('mentee_goal_missed')}</span>` : ''}</div>`
    : '';
  return `
    <div class="goal-item ${g.is_done ? 'done' : ''} ${missed ? 'missed' : ''}" data-goal-id="${g.id}">
      <label class="premium-checkbox${cb.cls}"${cb.title}>
        <input type="checkbox" ${g.is_done ? 'checked' : ''} ${cb.input} onchange="toggleMenteeGoalDone('${g.id}', '${menteeId}', this.checked)">
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
  if (window.HolyGoals) return window.HolyGoals.mountMentor(panel, menteeId); // goals v2 (goals.js)
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
      <div id="goalAddTrigger-${menteeId}" class="goal-add-trigger-wrap">
        <button type="button" class="goal-add-trigger-btn" onclick="showGoalAddForm('${menteeId}')">
          ${menteeIcon('plus', 13)}<span>${t('mentee_goals_add')}</span>
        </button>
      </div>
      <div id="goalAddForm-${menteeId}" class="goal-add-row" style="display:none;">
        <textarea id="goalInput-${menteeId}" class="form-control text-sm goal-add-input" placeholder="${t('mentee_goal_placeholder')}" maxlength="200" rows="2"></textarea>
        <div class="goal-add-row-bottom">
          <div class="goal-date-field">
            <input type="date" id="goalDate-${menteeId}" class="form-control text-sm goal-add-date" oninput="this.classList.toggle('has-value', !!this.value)">
            <span class="goal-date-placeholder">${menteeIcon('calendar', 13)}<span>${t('mentee_goal_due_date_placeholder')}</span></span>
          </div>
          <div class="flex gap-8 items-center">
            <button type="button" class="btn btn-ghost btn-xs" onclick="hideGoalAddForm('${menteeId}')">${t('btn_cancel')}</button>
            <button type="button" class="btn btn-primary btn-sm goal-add-btn" onclick="addMenteeGoal('${menteeId}')">${menteeIcon('plus', 13)}${t('mentee_goal_add_btn')}</button>
          </div>
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

function showGoalAddForm(menteeId) {
  haptic('light');
  const trigger = $(`goalAddTrigger-${menteeId}`);
  const form = $(`goalAddForm-${menteeId}`);
  if (trigger) trigger.style.display = 'none';
  if (form) {
    form.style.display = 'block';
    const input = $(`goalInput-${menteeId}`);
    input?.focus();
  }
}

function hideGoalAddForm(menteeId) {
  haptic('light');
  const trigger = $(`goalAddTrigger-${menteeId}`);
  const form = $(`goalAddForm-${menteeId}`);
  if (trigger) trigger.style.display = 'flex';
  if (form) form.style.display = 'none';
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
    hideGoalAddForm(menteeId);
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



// ─── Mentor private notes ─────────────────────────────────────
// A note is saved automatically ~1s after the mentor stops typing, and again
// on blur, when the app is backgrounded/closed, when leaving the page, and
// before the list reloads. Saving on blur alone (the old behaviour) lost text
// whenever blur didn't fire — common in Telegram's mobile WebView — and gave
// no sign whether anything was stored.
const MENTOR_NOTE_MAX = 2000;          // keep in sync with MAX_NOTE_LENGTH in routes/mentors.js
const MENTOR_NOTE_AUTOSAVE_MS = 1000;
const _mentorNoteSaved = {};   // menteeId -> last content confirmed stored on the server
const _mentorNoteDraft = {};   // menteeId -> text last typed (survives list re-renders)
const _mentorNoteTimers = {};  // menteeId -> pending autosave timer (present = unsaved edits)
const _mentorNoteQueue = {};   // menteeId -> promise chain, so saves reach the server in order
const _mentorNoteStatus = {};  // menteeId -> '' | 'unsaved' | 'saving' | 'saved' | 'error'
const _mentorNoteFailing = {}; // menteeId -> true while saves keep failing (so we toast once, not per retry)
let _mentorNotesLoadFailed = false;

/** What the textarea should show: unsaved draft first, else what's on the server. */
function mentorNoteValue(menteeId) {
  return _mentorNoteDraft[menteeId] ?? _mentorNoteSaved[menteeId] ?? '';
}

function setMentorNoteStatus(menteeId, state) {
  _mentorNoteStatus[menteeId] = state;
  const el = $(`noteStatus-${menteeId}`);
  if (!el) return;
  el.textContent = state ? t(`note_status_${state}`) : '';
  el.className = `mentor-note-status${state ? ` is-${state}` : ''}`;
}

/** Called by loadMyMentees with GET /api/mentors/notes ({ menteeId: content }, or null on failure). */
function applyLoadedMentorNotes(notesMap, mentees) {
  _mentorNotesLoadFailed = !notesMap;
  if (!notesMap) {
    // Don't render empty boxes the mentor could type over an unseen note with.
    showToast(t('note_load_failed'), 'error');
    return;
  }
  mentees.forEach(m => {
    const id = String(m.user.telegram_id);
    const server = notesMap[id] || '';
    _mentorNoteSaved[id] = server;
    // Keep a local draft only if it still differs from the server (e.g. a
    // failed save); otherwise the server copy is the source of truth.
    if (_mentorNoteDraft[id] !== undefined && _mentorNoteDraft[id].trim() === server) delete _mentorNoteDraft[id];
  });
}

function onMentorNoteInput(menteeId) {
  const el = $(`note-${menteeId}`);
  if (!el) return;
  _mentorNoteDraft[menteeId] = el.value;
  setMentorNoteStatus(menteeId, 'unsaved');
  clearTimeout(_mentorNoteTimers[menteeId]);
  _mentorNoteTimers[menteeId] = setTimeout(() => saveMentorNote(menteeId), MENTOR_NOTE_AUTOSAVE_MS);
}

/**
 * Saves a mentee's note if it changed. Always resolves (errors are shown in
 * the note's status line), so callers can safely await it.
 * `keepalive` lets the request finish while the app is being closed/hidden.
 */
function saveMentorNote(menteeId, { keepalive = false } = {}) {
  clearTimeout(_mentorNoteTimers[menteeId]);
  delete _mentorNoteTimers[menteeId];

  const el = $(`note-${menteeId}`);
  const content = (el ? el.value : (_mentorNoteDraft[menteeId] ?? '')).trim();
  if (content === (_mentorNoteSaved[menteeId] ?? '')) {
    if (_mentorNoteStatus[menteeId] === 'unsaved') setMentorNoteStatus(menteeId, '');
    return Promise.resolve();
  }

  setMentorNoteStatus(menteeId, 'saving');
  const run = async () => {
    try {
      await apiFetch('/api/mentors/notes', { method: 'POST', body: { mentee_id: menteeId, content }, keepalive });
      _mentorNoteSaved[menteeId] = content;
      delete _mentorNoteFailing[menteeId];
      const live = $(`note-${menteeId}`);
      const current = (live ? live.value : (_mentorNoteDraft[menteeId] ?? content)).trim();
      // If the mentor kept typing during the request, the pending autosave
      // timer will store the rest — leave the status at "unsaved".
      if (current === content) {
        delete _mentorNoteDraft[menteeId];
        setMentorNoteStatus(menteeId, 'saved');
      }
    } catch (e) {
      const alreadyFailing = _mentorNoteFailing[menteeId];
      _mentorNoteFailing[menteeId] = true;
      setMentorNoteStatus(menteeId, 'error');
      if (!alreadyFailing && !keepalive) showToast(e.message, 'error');
    }
  };
  const queued = (_mentorNoteQueue[menteeId] || Promise.resolve()).then(run);
  _mentorNoteQueue[menteeId] = queued;
  return queued;
}

function retryMentorNote(menteeId) {
  if (_mentorNoteStatus[menteeId] === 'error') saveMentorNote(menteeId);
}

/** Saves every note that has edits still waiting on the autosave timer. */
function flushMentorNotes(opts) {
  return Promise.all(Object.keys(_mentorNoteTimers).map(id => saveMentorNote(id, opts)));
}

// Backgrounding or closing the mini app: push out anything still pending.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushMentorNotes({ keepalive: true });
});
window.addEventListener('pagehide', () => { flushMentorNotes({ keepalive: true }); });

// ─── Transfer Mentee ──────────────────────────────────────────
// A bottom sheet where a mentor hands a mentee to another mentor. Mentors come
// from one /api/mentors call and are filtered, searched and ranked in the
// browser, so switching a topic chip or typing is instant (no reload flicker).
let _transferAssignmentId = null;
let _transferMentee = null;        // { id, name, user }
let _transferMentors = [];         // every other mentor
let _transferMenteeTopics = [];    // [{ id, name, name_am }]
let _transferTopicFilter = '';     // topic id as string; '' = all mentors
let _transferQuery = '';
let _transferSelectedId = null;
let _transferLoadState = 'idle';   // 'loading' | 'ready' | 'error'
let _transferBusy = false;
let _transferStep = 'pick';        // 'pick' (choose a mentor) | 'note' (optional note)
const TRANSFER_NOTE_MAX = 300;

const TRANSFER_ICON_STAR = '<svg class="tf-star" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const TRANSFER_ICON_EMPTY = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M17 4.5a3.5 3.5 0 0 1 0 7"/><path d="M19 14.3c1.9.7 3 2.5 3 5.2"/></svg>';

/**
 * Opens the Transfer Mentee sheet for an active assignment.
 * Only the assignment id is needed: the mentee is looked up in the My Mentees
 * list already on screen, so names with quotes can't break an inline handler.
 * menteeId / menteeName are accepted for older callers.
 */
async function openTransferModal(assignmentId, menteeId, menteeName) {
  haptic('light');
  const row = (_myMenteesCache || []).find(m => String(m.id) === String(assignmentId));
  const user = row?.user || null;
  const id = user?.telegram_id ?? menteeId;
  const name = user ? (user.user_settings?.display_name || user.anonymous_id) : (menteeName || '');

  _transferAssignmentId = assignmentId;
  _transferMentee = { id, name: name || '', user, assignedAt: row?.assigned_at || null };
  _transferMentors = [];
  _transferMenteeTopics = [];
  _transferTopicFilter = '';
  _transferQuery = '';
  _transferSelectedId = null;
  _transferBusy = false;
  _transferLoadState = 'loading';

  const search = $('transferSearch'); if (search) search.value = '';
  $('transferSearchClear') && ($('transferSearchClear').style.display = 'none');
  const note = $('transferNote'); if (note) note.value = '';
  onTransferNoteInput();
  setTransferStep('pick');

  renderTransferSheet();
  $('transferModal').classList.add('open');

  try {
    const [mentors, topics] = await Promise.all([
      apiFetch(`/api/mentors?for_mentee=${encodeURIComponent(id)}`),
      apiFetch(`/api/mentors/mentee-topics/${encodeURIComponent(id)}`).catch(() => []),
    ]);
    if (_transferAssignmentId !== assignmentId) return; // closed or reopened meanwhile
    const me = String(currentUser?.telegram_id || '');
    _transferMentors = (mentors || []).filter(m => String(m.telegram_id) !== me);
    _transferMenteeTopics = (topics || []).map(x => x.topics).filter(Boolean);
    _transferLoadState = 'ready';
  } catch (e) {
    if (_transferAssignmentId !== assignmentId) return;
    _transferLoadState = 'error';
  }
  renderTransferSheet();
}

/** Closes the sheet and clears its state. Ignored while a transfer is being sent. */
function closeTransferModal() {
  if (_transferBusy) return;
  $('transferConfirmModal')?.classList.remove('open');
  haptic('light');
  $('transferModal')?.classList.remove('open');
  _transferAssignmentId = null;
  _transferMentee = null;
  _transferMentors = [];
  _transferSelectedId = null;
}

// Per-mentor facts used for ranking, badges and availability.
function transferMentorInfo(m, topicIds) {
  const max = mentorMax(m);
  const count = m.mentee_count || 0;
  const paused = m.accepting_requests === false;
  const full = count >= max;
  const matched = (m.topics || []).filter(tp => topicIds.has(Number(tp.id))).length;
  return { max, count, paused, full, available: !paused && !full, matched };
}

// Mentors after the topic chip + search box, best candidates first:
// open mentors before unavailable ones, then topic match, rating, free spots.
function transferVisibleMentors() {
  const topicIds = new Set(_transferMenteeTopics.map(tp => Number(tp.id)));
  const q = _transferQuery.trim().toLowerCase();
  const rows = _transferMentors
    .filter(m => !_transferTopicFilter || (m.topics || []).some(tp => String(tp.id) === _transferTopicFilter))
    .filter(m => {
      if (!q) return true;
      const hay = [
        mentorNameOf(m), m.user_settings?.specialization, m.user_settings?.bio,
        ...(m.topics || []).map(tp => `${tp.name || ''} ${tp.name_am || ''}`),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    })
    .map(m => ({ m, info: transferMentorInfo(m, topicIds) }));
  rows.sort((a, b) =>
    (b.info.available - a.info.available) ||
    (b.info.matched - a.info.matched) ||
    ((b.m.rating || 0) - (a.m.rating || 0)) ||
    ((b.info.max - b.info.count) - (a.info.max - a.info.count)) ||
    mentorNameOf(a.m).localeCompare(mentorNameOf(b.m)));
  return rows;
}

function renderTransferSheet() {
  const mentee = _transferMentee;
  if (!mentee) return;
  const safeName = escapeHtml(mentee.name);

  // Subtitle
  const sub = $('transferSubtitle');
  if (sub) {
    if (_transferStep === 'note') {
      sub.hidden = true;
      sub.textContent = '';
    } else {
      sub.hidden = false;
      sub.innerHTML = t('transfer_sub', { name: `<strong>${safeName}</strong>` });
    }
  }

  // Mentee card
  const card = $('transferMenteeCard');
  if (card) {
    const letter = (mentee.name || '?').charAt(0).toUpperCase();
    const dateLocale = currentLanguage === 'am' ? 'am-ET' : undefined;
    const since = mentee.assignedAt
      ? new Date(mentee.assignedAt).toLocaleDateString(dateLocale, { year: 'numeric', month: 'short', day: 'numeric' })
      : '';
    card.hidden = false;
    card.innerHTML = `
      ${renderAvatar(mentee.user || { telegram_id: mentee.id }, letter)}
      <div class="tf-mentee-body">
        <div class="tf-mentee-name">${safeName}</div>
        ${since ? `<div class="tf-mentee-since">${escapeHtml(t('transfer_since', { date: since }))}</div>` : ''}
      </div>`;
    hydrateAvatars(card);
  }

  // Topic filter chips
  const chipsEl = $('transferTopicChips');
  if (chipsEl) {
    const show = _transferLoadState === 'ready' && _transferMenteeTopics.length > 0;
    chipsEl.hidden = !show;
    if (show) {
      const all = `<button type="button" class="tf-chip${_transferTopicFilter === '' ? ' active' : ''}" aria-pressed="${_transferTopicFilter === ''}" onclick="setTransferTopic('')">${t('transfer_filter_all')}</button>`;
      chipsEl.setAttribute('aria-label', t('transfer_filter_label'));
      chipsEl.innerHTML = all + _transferMenteeTopics.map(tp => {
        const on = String(tp.id) === _transferTopicFilter;
        return `<button type="button" class="tf-chip${on ? ' active' : ''}" aria-pressed="${on}" onclick="setTransferTopic('${tp.id}')">${escapeHtml(topicLabel(tp))}</button>`;
      }).join('');
    }
  }

  renderTransferList();
  updateTransferConfirm();
}

function renderTransferList() {
  const list = $('transferMentorList');
  if (!list) return;

  if (_transferLoadState === 'loading') {
    list.innerHTML = Array.from({ length: 3 }, () => `
      <div class="tf-skel"><span class="tf-skel-av"></span><span class="tf-skel-lines"><i></i><i></i></span></div>`).join('');
    return;
  }
  if (_transferLoadState === 'error') {
    list.innerHTML = `
      <div class="tf-empty">
        <span class="tf-empty-icon">${TRANSFER_ICON_EMPTY}</span>
        <p>${t('transfer_load_failed')}</p>
        <button type="button" class="btn btn-outline btn-sm" onclick="retryTransferLoad()">${t('btn_retry')}</button>
      </div>`;
    return;
  }

  const rows = transferVisibleMentors();
  if (!rows.length) {
    const filtered = !!(_transferTopicFilter || _transferQuery.trim());
    const msg = !_transferMentors.length ? t('transfer_none')
      : _transferQuery.trim() ? t('transfer_none_search') : t('transfer_none_topic');
    list.innerHTML = `
      <div class="tf-empty">
        <span class="tf-empty-icon">${TRANSFER_ICON_EMPTY}</span>
        <p>${msg}</p>
        ${filtered && _transferMentors.length ? `<button type="button" class="btn btn-outline btn-sm" onclick="resetTransferFilters()">${t('transfer_show_all')}</button>` : ''}
      </div>`;
    return;
  }

  const totalTopics = _transferMenteeTopics.length;
  const firstAvail = rows.findIndex(r => r.info.available);
  const manyAvail = rows.filter(r => r.info.available).length > 1;

  list.innerHTML = rows.map(({ m, info }, i) => {
    const name = mentorNameOf(m) || `Mentor ${m.telegram_id}`;
    const letter = name.charAt(0).toUpperCase();
    const sel = String(m.telegram_id) === String(_transferSelectedId);
    const pct = Math.min(100, Math.round((info.count / info.max) * 100));
    const status = mentorStatus(m);
    const best = manyAvail && i === firstAvail && info.matched > 0;
    const stateChip = info.paused ? t('not_accepting') : info.full ? t('capacity_full') : '';
    const trailing = stateChip
      ? `<span class="tf-state-chip">${escapeHtml(stateChip)}</span>`
      : `<span class="rt-radio" aria-hidden="true"></span>`;
    return `
      <button type="button" role="radio" aria-checked="${sel}" ${info.available ? '' : 'disabled aria-disabled="true"'}
        class="profile-menu-item rt-topic tf-mentor${sel ? ' pm-gold selected' : ''}${info.available ? '' : ' is-unavailable'}"
        data-mentor-id="${m.telegram_id}" onclick="selectTransferMentor('${m.telegram_id}')">
        ${renderAvatar(m, letter)}
        <span class="profile-menu-label rt-label tf-mentor-body">
          <span class="tf-mentor-top">
            <span class="rt-name">${escapeHtml(name)}</span>
          </span>
          ${renderModernRating(m.rating, m.rating_count)}
          <span class="tf-cap-row">
            <span class="tf-cap" aria-hidden="true"><i class="${info.full ? 'full' : ''}" style="width:${pct}%"></i></span>
            <span class="tf-cap-text">${info.count}/${info.max}${info.available ? ` · ${escapeHtml(status.text)}` : ''}</span>
          </span>
          ${best ? `<span class="tf-best">${TRANSFER_ICON_STAR}${escapeHtml(t('transfer_best_match'))}</span>` : ''}
          ${info.matched > 0 && totalTopics > 0 ? `<span class="tf-match">${escapeHtml(t(info.matched === 1 ? 'transfer_match_one' : 'transfer_match', { n: info.matched, total: totalTopics }))}</span>` : ''}
        </span>
        ${trailing}
      </button>`;
  }).join('');
  hydrateAvatars(list);
}

function updateTransferConfirm() {
  const btn = $('transferConfirmBtn');
  if (!btn) return;
  const m = _transferMentors.find(x => String(x.telegram_id) === String(_transferSelectedId));
  // The picked mentor is already highlighted in the list, so the button stays short.
  btn.disabled = _transferBusy || !m;
  btn.textContent = _transferBusy ? t('transfer_sending') : t('btn_transfer');
  const yes = $('transferConfirmYes');
  if (yes) {
    yes.disabled = _transferBusy;
    yes.textContent = _transferBusy ? t('transfer_sending') : t('transfer_confirm_yes');
  }
  const no = $('transferConfirmNo');
  if (no) no.disabled = _transferBusy;
}

function selectTransferMentor(id) {
  if (_transferBusy) return;
  const m = _transferMentors.find(x => String(x.telegram_id) === String(id));
  if (!m || !transferMentorInfo(m, new Set()).available) return;
  haptic('selection');
  _transferSelectedId = String(id);
  renderTransferList();
  updateTransferConfirm();
}

function setTransferTopic(topicId) {
  haptic('light');
  _transferTopicFilter = String(topicId || '');
  // The pick may no longer be in the list; drop it instead of hiding it.
  const stillThere = transferVisibleMentors().some(r => String(r.m.telegram_id) === String(_transferSelectedId));
  if (!stillThere) _transferSelectedId = null;
  renderTransferSheet();
}

function onTransferSearch(value) {
  _transferQuery = value || '';
  const clear = $('transferSearchClear');
  if (clear) clear.style.display = _transferQuery ? '' : 'none';
  const stillThere = transferVisibleMentors().some(r => String(r.m.telegram_id) === String(_transferSelectedId));
  if (!stillThere) _transferSelectedId = null;
  renderTransferList();
  updateTransferConfirm();
}

function clearTransferSearch() {
  const input = $('transferSearch');
  if (input) { input.value = ''; input.focus(); }
  onTransferSearch('');
}

function resetTransferFilters() {
  haptic('light');
  const input = $('transferSearch'); if (input) input.value = '';
  _transferQuery = '';
  _transferTopicFilter = '';
  $('transferSearchClear') && ($('transferSearchClear').style.display = 'none');
  renderTransferSheet();
}

async function retryTransferLoad() {
  if (_transferAssignmentId == null || !_transferMentee) return;
  const id = _transferAssignmentId;
  const mentee = _transferMentee;
  haptic('light');
  // openTransferModal rebuilds state from the mentees list, which is still loaded.
  await openTransferModal(id, mentee.id, mentee.name);
}

/** Switches the sheet between "pick a mentor" and "add an optional note". */
function setTransferStep(step) {
  _transferStep = step === 'note' ? 'note' : 'pick';
  const note = _transferStep === 'note';
  $('transferNoteStep')?.toggleAttribute('hidden', !note);
  document.querySelector('#transferModal .tf-scroll:not(.tf-note-step)')?.toggleAttribute('hidden', note);
  if (note) {
    const m = _transferMentors.find(x => String(x.telegram_id) === String(_transferSelectedId));
    const name = m ? (mentorNameOf(m) || `Mentor ${m.telegram_id}`) : '';
    const box = $('transferPickedMentor');
    if (box && m) {
      box.innerHTML = `${renderAvatar(m, name.charAt(0).toUpperCase())}
        <span class="tf-picked-body"><span class="tf-picked-label">${escapeHtml(t('transfer_to'))}</span><span class="tf-picked-name">${escapeHtml(name)}</span></span>`;
      hydrateAvatars(box);
    }
  }
  updateTransferSubtitle();
  updateTransferConfirm();
}

/** Subtitle only; switching steps must not rebuild the mentor list underneath. */
function updateTransferSubtitle() {
  const sub = $('transferSubtitle');
  if (!sub || !_transferMentee) return;
  if (_transferStep === 'note') {
    sub.hidden = true;
    sub.textContent = '';
  } else {
    sub.hidden = false;
    const nm = escapeHtml(_transferMentee.name || (_transferMentee.user && (_transferMentee.user.user_settings?.display_name || _transferMentee.user.anonymous_id)) || '');
    sub.innerHTML = t('transfer_sub', { name: `<strong>${nm}</strong>` });
  }
}

function backToTransferPick() {
  if (_transferBusy) return;
  haptic('light');
  setTransferStep('pick');
}

/** The sheet's main button: step 1 moves on to the note, step 2 asks for confirmation. */
function onTransferPrimary() {
  if (_transferBusy) return;
  if (!_transferSelectedId) {
    haptic('error');
    showToast(t('transfer_pick_first'), 'error');
    return;
  }
  haptic('light');
  if (_transferStep === 'pick') {
    // No auto-focus: popping the keyboard open during the step change made the sheet jump.
    setTransferStep('note');
    return;
  }
  openTransferConfirm();
}

function openTransferConfirm() {
  const m = _transferMentors.find(x => String(x.telegram_id) === String(_transferSelectedId));
  if (!m || !_transferMentee) return;
  const body = $('transferConfirmBody');
  if (body) {
    body.innerHTML = t('transfer_confirm_body', {
      mentee: `<strong>${escapeHtml(_transferMentee.name || '')}</strong>`,
      mentor: `<strong>${escapeHtml(mentorNameOf(m) || '')}</strong>`,
    });
  }
  updateTransferConfirm();
  $('transferConfirmModal')?.classList.add('open');
}

function closeTransferConfirm() {
  if (_transferBusy) return;
  $('transferConfirmModal')?.classList.remove('open');
}

function onTransferNoteInput() {
  const ta = $('transferNote');
  const count = $('transferNoteCount');
  if (count) count.textContent = `${(ta?.value || '').length}/${TRANSFER_NOTE_MAX}`;
}

/**
 * Sends POST /api/mentors/transfer (type 'assignment'), then refreshes My Mentees.
 * The note is optional and goes only to the new mentor.
 */
async function confirmTransfer() {
  if (_transferBusy) return;
  const target_mentor_id = _transferSelectedId;

  if (!target_mentor_id) {
    haptic('error');
    showToast(t('transfer_pick_first'), 'error');
    return;
  }
  if (!_transferAssignmentId) {
    haptic('error');
    showToast(t('transfer_failed_missing'), 'error');
    return;
  }

  const note = ($('transferNote')?.value || '').trim().slice(0, TRANSFER_NOTE_MAX);
  haptic('medium');
  _transferBusy = true;
  updateTransferConfirm();
  $('transferMentorList')?.classList.add('is-busy');

  try {
    await apiFetch('/api/mentors/transfer', {
      method: 'POST',
      body: {
        type: 'assignment',
        id: _transferAssignmentId,
        target_mentor_id,
        ...(note ? { note } : {}),
      },
    });

    _transferBusy = false;
    haptic('success');
    showToast(t('transfer_sent'), 'success');
    closeTransferModal();   // also closes the confirmation dialog
    loadMyMentees(); // Refresh the My Mentees list
  } catch (e) {
    _transferBusy = false;
    $('transferMentorList')?.classList.remove('is-busy');
    updateTransferConfirm();
    $('transferConfirmModal')?.classList.remove('open');
    haptic('error');
    showToast(e.message, 'error');
  }
}

async function endMentorship(assignId, skipConfirm = false) {
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
    if (!skipConfirm && !confirm(t('confirm_end_mentorship'))) return;
    haptic('medium');
    try {
      const result = await apiFetch('/api/users/end-mentorship', { method: 'POST' });
      haptic('success');
      showToast(t('mentorship_ended'), 'success');
      // Refresh the badge — messages from this ended pairing no longer count.
      updateMessageBadge();
      navigate('dashboard');
      if (result?.mentor?.telegram_id) {
        openRatingModal(result.mentor.telegram_id, result.mentor.display_name, result.assignment_id);
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
        const filtered = allTopicsCache.filter(t => topicTextMatches(t, searchInput.value));
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
      <span class="chip-name">${escapeHtml(topicLabel(topicItem))}</span>
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
    layout = 'dialog',   // 'dialog' (centered card) | 'sheet' (glowing bottom sheet)
    hint = '',           // small dim line under the buttons (sheet layout)
  } = config;
  const isSheet = layout === 'sheet';

  // Only one engagement popup at a time — a new one replaces whatever
  // is already showing rather than stacking on top of it.
  $('engagementPopupOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'engagementPopupOverlay';
  overlay.className = 'engagement-popup-overlay' + (isSheet ? ' engagement-popup-overlay--sheet' : '');
  overlay.dataset.popupId = id;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);

  overlay.innerHTML = `
    <div class="engagement-popup${isSheet ? ' engagement-popup--sheet' : ''}">
      <button type="button" class="engagement-popup-close" aria-label="${t('btn_close')}">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l14 14M19 5L5 19"/></svg>
      </button>
      <div class="engagement-popup-icon engagement-popup-icon--${variant}">${icon}</div>
      <div class="engagement-popup-title">${title}</div>
      ${isSheet ? `<div class="engagement-popup-card"><p class="engagement-popup-message">${message}</p></div>` : `<p class="engagement-popup-message">${message}</p>`}
      <div class="engagement-popup-actions">
        <button type="button" class="btn btn-primary btn-full engagement-popup-primary">${buttonText}</button>
        ${secondaryText ? `<button type="button" class="btn btn-ghost btn-full engagement-popup-secondary">${secondaryText}</button>` : ''}
      </div>
      ${isSheet && hint ? `<div class="engagement-popup-hint">${hint}</div>` : ''}
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

// ─── Premium Dropdown (click-toggle) ──────────────────────────
// Click-based (not hover-only) so it works identically on touch and
// mouse. Any element with [data-dropdown] toggles a [data-open]
// attribute on itself; styles.css keys the menu's visibility off that
// attribute. Clicking anywhere else closes whatever is open.
document.addEventListener('click', (e) => {
  const toggleBtn = e.target.closest('[data-dropdown-toggle], .premium-dropdown-btn');
  const dropdown = e.target.closest('[data-dropdown]');
  const item = e.target.closest('.dropdown-item');

  if (toggleBtn && dropdown) {
    const isOpen = dropdown.hasAttribute('data-open');
    document.querySelectorAll('[data-dropdown][data-open]').forEach(d => {
      if (d !== dropdown) d.removeAttribute('data-open');
    });
    if (isOpen) {
      dropdown.removeAttribute('data-open');
    } else {
      dropdown.setAttribute('data-open', '');
    }
    return;
  }

  if (item && dropdown) {
    dropdown.removeAttribute('data-open');
    return;
  }

  if (!dropdown) {
    document.querySelectorAll('[data-dropdown][data-open]').forEach(d => d.removeAttribute('data-open'));
  }
});
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
    // Blobs are hidden on touch/small screens (see styles.css); skip the work.
    if (window.matchMedia('(hover: none)').matches || window.innerWidth <= 480) return;
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

  // ── Ripple effect removed to eliminate touch lag/jank ──
  function initRipple() {
    // Disabled
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

  function initEnhancements() {
    ensureBlobs();
    initParallax();
    initRipple();
    initPageObserver();
    wireMoodPicker();
    watchJournalModal();
    wrap('loadJournalEntries', decorateJournalList);
    wrap('loadMentors', decorateMentorList);
  }

  function start() {
    if (typeof window.init === 'function') {
      window.init();
    }
    initEnhancements();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

