/* ============================================================
   Recovery App – Main App Logic
   ============================================================ */

const API = window.location.origin;
let socket = null;
let currentUser = null;
let currentPage = 'dashboard';
let jitsiApi = null;
let chart = null;

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
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/csv')) return res.blob();
  return res.json();
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatTime(dateStr) {
  const tz = currentUser?.user_settings?.timezone || 'UTC';
  try {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: tz });
  } catch (e) {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

function formatDateTime(dateStr) {
  let tz = currentUser?.user_settings?.timezone || 'Africa/Addis_Ababa';
  if (!tz || tz === 'UTC') tz = 'Africa/Addis_Ababa';
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
function buildMessageTree(messages) {
  const map = new Map();
  const roots = [];
  messages.forEach(msg => {
    map.set(msg.id, { ...msg, replies: [] });
  });
  messages.forEach(msg => {
    if (msg.parent_id && map.has(msg.parent_id)) {
      map.get(msg.parent_id).replies.push(map.get(msg.id));
    } else {
      roots.push(map.get(msg.id));
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
    const replyFormId = `reply-form-${msg.id}`;
    const editedMark = msg.edited_at
      ? '<span class="msg-edited">edited</span>'
      : '';
    const hasReplies = msg.replies && msg.replies.filter(r => !r.is_deleted).length > 0;
    
    const statusIndicator = isSent 
      ? `<span class="msg-status ${msg.read_at ? 'read' : 'unread'}">${msg.read_at ? '✓✓' : '✓'}</span>` 
      : '';

    html += `
      <div class="message-thread ${isSent ? 'thread-sent' : 'thread-received'}" data-msg-id="${msg.id}">
        <div class="message-bubble ${isSent ? 'sent' : 'received'}">
          <div class="message-text">${escapeHtml(msg.content)}${editedMark}</div>
          <div class="message-footer">
            <span class="message-time">${formatTime(msg.created_at)}</span>
            ${statusIndicator}
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
              <button class="msg-action-btn" onclick="showReplyForm('${msg.id}')" aria-label="Reply">${ICON_REPLY}</button>
            </span>
          </div>
        </div>
        <div id="${replyFormId}" class="reply-form">
          <input type="text" id="reply-input-${msg.id}" class="reply-input" placeholder="Write a reply…" autocomplete="off" />
          <button class="reply-send" onclick="sendReply('${msg.id}')">Send</button>
          <button class="cancel-reply" onclick="hideReplyForm('${msg.id}')">✕</button>
        </div>
        ${hasReplies ? `<div class="replies-container">${renderThread(msg.replies, false)}</div>` : ''}
      </div>
    `;
  }
  
  return html;
}

function appendMessageToChat(msg) {
  const container = $('chatMessages');
  if (!container) return;

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
  container.scrollTop = container.scrollHeight;
}

/* ── In-place read-tick updater ─────────────────────────────── */
// Called when the partner has read our messages. Upgrades ✓ → ✓✓
// by touching only the .msg-status spans, with no full DOM re-render.
function updateReadTicks() {
  const container = $('chatMessages');
  if (!container) return;
  container.querySelectorAll('.msg-status.unread').forEach(el => {
    el.classList.remove('unread');
    el.classList.add('read');
    el.textContent = '✓✓';
  });
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


async function editMessageInline(msgId) {
  currentMessageId = msgId;
  await editMessage();
}

async function deleteMessageInline(msgId) {
  currentMessageId = msgId;
  await deleteMessage();
}

function showReplyForm(messageId) {
  const form = document.getElementById(`reply-form-${messageId}`);
  if (form) form.classList.add('visible');
  document.getElementById(`reply-input-${messageId}`)?.focus();
}
window.setReplyTo = showReplyForm;

function hideReplyForm(messageId) {
  const form = document.getElementById(`reply-form-${messageId}`);
  if (form) form.classList.remove('visible');
}

async function sendReply(parentId) {
  const input = document.getElementById(`reply-input-${parentId}`);
  const content = input.value.trim();
  if (!content || !window.chatState.with) return;

  input.value = '';
  hideReplyForm(parentId);

  try {
    const msg = await apiFetch('/api/messages', {
      method: 'POST',
      body: {
        to_id: window.chatState.with,
        content,
        parent_id: parentId
      }
    });
    appendMessageToChat(msg);
    haptic('light');
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}
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

async function editMessage() {
  if (!currentMessageId) return;
  const newContent = prompt('Edit your message:');
  if (!newContent || newContent.trim() === '') return;
  try {
    await apiFetch(`/api/messages/${currentMessageId}`, {
      method: 'PATCH',
      body: { content: newContent.trim() }
    });
    closeMessageOptions();
    loadMessages(window.chatState.with);
    haptic('light');
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
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
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const icon = theme === 'light' ? '🌙' : '☀️';
  $$('.theme-btn span').forEach(s => s.textContent = icon);
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
    }
  }
}

// ─── Socket Setup ─────────────────────────────────────────────
function connectSocket() {
  socket = io(API);
  socket.on('connect', () => {
    socket.emit('auth', getTelegramData().user?.id);
    $('reconnectBanner')?.classList.remove('show');
  });
  socket.on('disconnect', () => {
    $('reconnectBanner')?.classList.add('show');
  });
  socket.on('new_message', (msg) => {
    if (currentPage === 'chat' && window.chatState?.with && String(window.chatState.with) === String(msg.from_id)) {
      appendMessageToChat(msg);
      // Tell the server to mark messages as read — server handles the DB update and
      // notifies the sender; we do NOT emit a socket 'messages_read' here to avoid
      // triggering a loadMessages() loop on the other side.
      apiFetch(`/api/messages/${msg.from_id}`).catch(() => {});
    } else {
      updateMessageBadge();
      showToast('New message received');
      haptic('medium');
    }
  });

  // Debounce guard — prevents rapid-fire events triggering multiple DOM rebuilds
  let _readReceiptTimeout = null;
  socket.on('messages_read', ({ by_id }) => {
    if (currentPage !== 'chat') return;
    if (!window.chatState?.with || String(window.chatState.with) !== String(by_id)) return;
    // Update tick marks in-place instead of wiping the whole DOM
    clearTimeout(_readReceiptTimeout);
    _readReceiptTimeout = setTimeout(() => {
      updateReadTicks();
    }, 300);
  });
  socket.on('chat_cleared', ({ by_id }) => {
    if (currentPage === 'chat' && window.chatState?.with && String(window.chatState.with) === String(by_id)) {
      loadMessages(window.chatState.with);
    }
  });
  socket.on('session_invite', (session) => {
    haptic('success');
    showToast(`📹 Session invite: ${session.title}`, 'info');
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
      const partnerName = window.chatState.name || 'Partner';
      const indicatorText = t('typing_indicator', { name: partnerName });
      $('typingIndicator').innerHTML = `${escapeHtml(indicatorText)} <span class="typing-dots"><span></span><span></span><span></span></span>`;
      clearTimeout(window.typingTimeout);
      window.typingTimeout = setTimeout(() => { $('typingIndicator').innerHTML = ''; }, 3000);
    }
  });
  socket.on('new_mentorship_request', () => {
    haptic('success');
    showToast('New mentorship request received! 🙏', 'success');
    updateRequestsBadge();  // update the badge count
    if (currentPage === 'requests') loadRequests();
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
    if (currentPage !== 'chat' || !window.chatState?.with) return;
    // Update the message text in-place instead of rebuilding the whole chat
    const thread = document.querySelector(`.message-thread[data-msg-id="${editedMsg.id}"]`);
    if (thread) {
      const textEl = thread.querySelector('.message-text');
      if (textEl) {
        const editedMark = '<span class="msg-edited">edited</span>';
        textEl.innerHTML = escapeHtml(editedMsg.content) + editedMark;
      }
    } else {
      // Fallback: message not in DOM yet, do a full reload
      loadMessages(window.chatState.with);
    }
  });

  socket.on('message_deleted', ({ id }) => {
    if (currentPage !== 'chat' || !window.chatState?.with) return;
    // Remove the message thread element directly from the DOM
    const thread = document.querySelector(`.message-thread[data-msg-id="${id}"]`);
    if (thread) {
      thread.remove();
    } else {
      loadMessages(window.chatState.with);
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
    case 'chat': loadChat(); break;
    case 'requests': loadRequests(); break;
    case 'settings': loadSettings(); break;
    case 'my-mentees': loadMyMentees(); break;
    case 'journal':
      journalView = 'list';
      loadJournalEntries();
      $('journalViewToggle').innerHTML = '📅 ' + t('Calendar');
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
}

// ─── Onboarding ───────────────────────────────────────────────
let onboardingStep = 0;

async function showOnboarding() {
  $('loadingScreen')?.classList.add('hidden');
  $('onboarding').style.display = 'flex';

  // Load topics for onboarding
  try {
    const topics = await apiFetch('/api/topics');
    const select = $('regTopicsSelect');
    if (select) {
      select.innerHTML = topics.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    }

    // Populate dynamic chips
    const chipsContainer = $('regTopicsChips');
    if (chipsContainer) {
      chipsContainer.innerHTML = topics.map(t => `
        <div class="topic-chip" id="onb-topic-${t.id}" onclick="toggleOnboardingTopicChip(${t.id})">
          <span class="chip-icon">+</span>
          <span class="chip-name">${escapeHtml(t.name)}</span>
        </div>
      `).join('');
    }
  } catch (e) {
    console.error('Failed to load topics for onboarding:', e);
  }

  showStep(0);
}

function toggleOnboardingTopicChip(id) {
  haptic('light');
  const select = $('regTopicsSelect');
  if (!select) return;

  const option = Array.from(select.options).find(o => Number(o.value) === id);
  if (!option) return;

  option.selected = !option.selected;

  const chip = $(`onb-topic-${id}`);
  if (chip) {
    chip.classList.toggle('active', option.selected);
    const icon = chip.querySelector('.chip-icon');
    if (icon) {
      icon.textContent = option.selected ? '✓' : '+';
    }
  }
}

function showStep(step) {
  haptic('light');
  onboardingStep = step;

  // Update step dots if any
  $$('.step-dot').forEach((d, i) => {
    d.classList.toggle('active', i === step);
    d.classList.toggle('done', i < step);
  });

  // Update stepper connectors
  const fill = $('ob-step-line-fill');
  if (fill) {
    fill.style.width = (step / 2 * 100) + '%';
  }

  // Update stepper active states
  $$('.stepper-step').forEach((d, i) => {
    d.classList.toggle('active', i === step);
    d.classList.toggle('done', i < step);
  });

  $$('.onboarding-step').forEach((s, i) => s.classList.toggle('hidden', i !== step));
  clearAllFieldErrors();
}

function goToStepIfValid(step) {
  if (step === 0) {
    showStep(0);
  } else if (step === 1) {
    showStep(1);
  } else if (step === 2) {
    validateStep1AndGo(2);
  }
}

function showInlineError(fieldId, message) {
  const field = $(fieldId);
  if (!field) return;

  field.classList.add('is-invalid');
  const parent = field.closest('.form-group-ob') || field.parentNode;
  let errorDiv = parent.querySelector('.inline-error');
  if (!errorDiv) {
    errorDiv = document.createElement('div');
    errorDiv.className = 'inline-error';
    parent.appendChild(errorDiv);
  }
  errorDiv.innerHTML = `⚠️ ${escapeHtml(message)}`;
}

function clearFieldError(fieldId) {
  const field = $(fieldId);
  if (!field) return;
  field.classList.remove('is-invalid');
  const parent = field.closest('.form-group-ob') || field.parentNode;
  const errorDiv = parent.querySelector('.inline-error');
  if (errorDiv) {
    errorDiv.remove();
  }
}

function clearAllFieldErrors() {
  $$('.inline-error').forEach(el => el.remove());
  $$('.form-control-ob').forEach(el => el.classList.remove('is-invalid'));
}

function validateStep1AndGo(nextStep) {
  const sex = $('regSex').value;
  const age_range = $('regAge').value;
  const education_level = $('regEdu').value;

  clearAllFieldErrors();

  let hasError = false;
  if (!sex) {
    showInlineError('regSex', 'Please select your sex');
    hasError = true;
  }
  if (!age_range) {
    showInlineError('regAge', 'Please select your age range');
    hasError = true;
  }
  if (!education_level) {
    showInlineError('regEdu', 'Please select your education level');
    hasError = true;
  }

  if (hasError) {
    haptic('error');
    return;
  }

  showStep(nextStep);
}

async function completeRegistration() {
  const sex = $('regSex').value;
  const age_range = $('regAge').value;
  const education_level = $('regEdu').value;
  const nickname = $('regNickname').value.trim();

  clearAllFieldErrors();

  let hasError = false;
  if (!sex) {
    showInlineError('regSex', 'Sex selection is required');
    hasError = true;
  }
  if (!age_range) {
    showInlineError('regAge', 'Age range is required');
    hasError = true;
  }
  if (!education_level) {
    showInlineError('regEdu', 'Education level is required');
    hasError = true;
  }

  if (!nickname) {
    showInlineError('regNickname', 'Anonymous nickname is required');
    hasError = true;
  } else {
    const nickRegex = /^[a-zA-Z0-9_]{3,20}$/;
    if (!nickRegex.test(nickname)) {
      showInlineError('regNickname', '3-20 characters: letters, numbers, and underscores only');
      hasError = true;
    }
  }

  if (hasError) {
    haptic('error');
    if (!sex || !age_range || !education_level) {
      showStep(1);
      if (!sex) showInlineError('regSex', 'Sex selection is required');
      if (!age_range) showInlineError('regAge', 'Age range is required');
      if (!education_level) showInlineError('regEdu', 'Education level is required');
    }
    showToast('Please correct the errors below', 'error');
    return;
  }

  const regBtn = $('regBtn');
  regBtn.disabled = true; regBtn.textContent = 'Registering...';

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
    showToast('Welcome! You are now registered 🙏', 'success');
  } catch (e) {
    haptic('error');
    if (e.message.toLowerCase().includes('taken')) {
      showInlineError('regNickname', 'This nickname is already taken. Please try another.');
    } else {
      showToast(e.message, 'error');
    }
    regBtn.disabled = false; regBtn.textContent = 'Join the Community 🙏';
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


  if (String(currentUser?.telegram_id) === String(window.ADMIN_ID)) {
    $('adminBtn')?.classList.remove('hidden');
  }

  if (currentUser?.role === 'mentor') {
    $('nav-requests')?.classList.remove('hidden');
    $('nav-my-mentees')?.style.setProperty('display', 'flex');
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
  } catch { }

  try {
    const stats = await apiFetch('/api/users/stats');
    $('statUsers').textContent = stats.total_users;
    $('statMentors').textContent = stats.active_mentors;
    $('statSessions').textContent = stats.sessions_today;
  } catch { }

  loadActivityChart();
  loadStreak();

  if (String(currentUser?.telegram_id) === String(window.ADMIN_ID)) {
    $('adminBtn')?.classList.remove('hidden');
  }
  updateSessionsBadge();
}

// ─── Streaks ──────────────────────────────────────────────────
async function loadStreak() {
  try {
    const s = await apiFetch('/api/streaks');
    $('streakCount').textContent = t('streak_display', { count: s.current_streak });

    // Check if already read today (Ethiopia time)
    const etNow = new Date(new Date().getTime() + (3 * 60 * 60 * 1000));
    const today = etNow.toISOString().split('T')[0];

    const btn = $('markReadBtn');
    if (s.last_read_date === today) {
      btn.textContent = t('streak_already_read');
      btn.disabled = true;
      $('streakCard').style.opacity = '0.7';
    } else {
      btn.textContent = t('btn_mark_read');
      btn.disabled = false;
      $('streakCard').style.opacity = '1';
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
    showToast(t('streak_marked'), 'success');
    loadStreak();
  } catch (e) { showToast(e.message, 'error'); }
}

async function loadActivityChart() {
  try {
    const data = await apiFetch('/api/users/weekly-activity');
    const ctx = $('activityChart')?.getContext('2d');
    if (!ctx) return;
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(d => d.date),
        datasets: [
          {
            label: 'Messages',
            data: data.map(d => d.messages),
            backgroundColor: 'rgba(201,168,76,0.4)',
            borderColor: 'rgba(201,168,76,0.8)',
            borderWidth: 1, borderRadius: 4,
          },
          {
            label: 'Sessions',
            data: data.map(d => d.sessions),
            backgroundColor: 'rgba(91,142,255,0.4)',
            borderColor: 'rgba(91,142,255,0.8)',
            borderWidth: 1, borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: getComputedStyle(document.documentElement).getPropertyValue('--text2').trim() } } },
        scales: {
          x: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true },
        },
      },
    });
  } catch (e) { console.error('Chart error:', e); }
}

// ─── Mentors ──────────────────────────────────────────────────
async function loadMentors() {
  const container = $('mentorsList');
  const filterSelect = $('mentorTopicSelect');
  const selectedTopic = filterSelect ? filterSelect.value : '';

  container.innerHTML = window.skeletonHTML ? skeletonHTML(3) : '<div class="loading-spinner" style="margin:40px auto"></div>';

  try {
    // 1. Fetch active mentor if the user is a mentee ('user')
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
          const sexLabel = m.sex === 'M' ? t('sex_male') : m.sex === 'F' ? t('sex_female') : m.sex === 'prefer_not' ? t('sex_both') : '';

          activeMentorHtml = `
            <div class="card gold-border mb-16" style="border: 2px solid var(--gold);">
              <div class="text-xs font-bold uppercase tracking-wider mb-8" style="color:var(--gold)" data-i18n="your_active_mentor">
                ${t('your_active_mentor') || 'Your Active Mentor'}
              </div>
              <div class="flex items-center gap-8 mb-12">
                <div class="mentor-avatar">${letter}</div>
                <div class="mentor-info">
                  <div class="mentor-id">${escapeHtml(name)}</div>
                  ${sexLabel ? `<div class="mentor-sex">${sexLabel}</div>` : ''}
                  <div class="mentor-bio">${escapeHtml(bio)}</div>
                </div>
              </div>
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

    // 2. Fetch all mentors (API already filters by same sex)
    let mentors = await apiFetch('/api/mentors');

    // Apply topic filter (mentor.expertise_topics is an array of topic names)
    if (selectedTopic && selectedTopic !== '') {
      mentors = mentors.filter(m => m.expertise_topics && m.expertise_topics.includes(selectedTopic));
    }

    let mentorsListHtml = '';
    if (!mentors.length) {
      let message = 'No mentors available';
      if (selectedTopic && selectedTopic !== '') {
        message = `No mentors available for "${selectedTopic}"`;
      }
      mentorsListHtml = `<div class="empty-state"><span>${message}</span></div>`;
    } else {
      // Render mentor cards
      mentorsListHtml = mentors.map(m => {
        const name = m.user_settings?.display_name || m.anonymous_id;
        const bio = m.user_settings?.bio || 'No bio provided';
        const spec = m.user_settings?.specialization || '';
        const letter = name.charAt(0).toUpperCase();
        const sexLabel = m.sex === 'M' ? t('sex_male') : m.sex === 'F' ? t('sex_female') : m.sex === 'prefer_not' ? t('sex_both') : '';
        const mentees = m.mentee_count || 0;
        const max = m.user_settings?.max_mentees || 5;

        // If user already has an active mentor, disable requesting other mentors
        const canRequest = !hasActiveMentor && mentees < max;

        return `
          <div class="mentor-card">
            <div class="flex items-center gap-8">
              <div class="mentor-avatar">${letter}</div>
              <div class="mentor-info">
                <div class="mentor-id">${escapeHtml(name)}</div>
                ${sexLabel ? `<div class="mentor-sex">${sexLabel}</div>` : ''}
                <div class="mentor-bio">${escapeHtml(bio)}</div>
              </div>
            </div>
            <div class="mentor-meta">
              ${spec ? `<span class="mentor-badge badge-spec">${escapeHtml(spec)}</span>` : ''}
              <span class="mentor-badge badge-mentees">${mentees}/${max} ${t('role_mentee')}s</span>
            </div>
            ${mentees >= max ? `
              <button class="btn btn-outline btn-sm" disabled style="opacity:0.5;cursor:not-allowed;background:var(--bg3);color:var(--text3);" title="${t('capacity_full_tooltip')}">
                ${t('capacity_full')}
              </button>
            ` : `
              <button class="btn btn-outline btn-sm" onclick="requestMentorship(${m.telegram_id})" ${!canRequest ? 'disabled' : ''}>
                ${t('btn_request')}
              </button>
            `}
          </div>`;
      }).join('');
    }

    container.innerHTML = activeMentorHtml + mentorsListHtml;
    // Apply localizations to any newly rendered elements
    applyLanguage();
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
        topics.map(t => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`).join('');
    }
  } catch (e) {
    console.error('Failed to load topics for filter:', e);
  }
}
async function requestMentorship(mentor_id) {
  haptic('medium');
  try {
    await apiFetch('/api/mentors/request', { method: 'POST', body: { mentor_id, message: 'I would like your mentorship.' } });
    haptic('success');
    showToast('Mentorship request sent! 🙏', 'success');
    loadMentors();
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}

// ─── Mentorship Requests ──────────────────────────────────────
async function loadRequests() {
  const container = $('requestsList');
  if (!container) return;
  container.innerHTML = window.skeletonHTML ? skeletonHTML(3) : '<div class="loading-spinner" style="margin:40px auto"></div>';
  try {
    const requests = await apiFetch('/api/mentors/my-requests');
    if (!requests.length) {
      container.innerHTML = '<div class="empty-state"><span>No pending requests</span></div>';
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

  // Future session
  if (elapsed < 0) {
    const diffMs = -elapsed;
    const diffMin = Math.ceil(diffMs / 60000);
    if (diffMin <= 60) {
      return {
        isJoinable: true,
        label: `⏰ Starts in ${diffMin} min`,
        labelClass: 'session-time-label upcoming'
      };
    }
    const diffH = Math.floor(diffMin / 60);
    const remMin = diffMin % 60;
    const hLabel = remMin > 0 ? `${diffH}h ${remMin}m` : `${diffH}h`;
    return {
      isJoinable: true,
      label: `⏰ Starts in ${hLabel}`,
      labelClass: 'session-time-label upcoming'
    };
  }

  // Scheduled time has passed and we're within the grace period —
  // just show the Join button, no extra label text needed.
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
        if (isJoinable) {
          const sid = item.dataset.sessionId;
          actionEl.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:6px;">
              <button class="btn btn-primary btn-sm" onclick="joinSession('${sid}')">${t('btn_join_session')}</button>
              <button class="btn btn-outline btn-sm"  onclick="openSessionInBrowser('${sid}')">Browser</button>
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
        actionEl.innerHTML = isJoinable
          ? `<button class="btn btn-primary btn-sm" onclick="joinSession('${sid}')">${t('btn_join_session')}</button>`
          : `<span class="${labelClass}">${label}</span>`;
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
        privateContainer.innerHTML = '<div class="empty-state">No active or upcoming private sessions.</div>';
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

          const actionHtml = isJoinable
            ? `<div style="display:flex; flex-direction:column; gap:6px;">
                <button class="btn btn-primary btn-sm" onclick="joinSession('${session.id}')">${t('btn_join_session')}</button>
                <button class="btn btn-outline btn-sm" onclick="openSessionInBrowser('${session.id}')">Browser</button>
              </div>`
            : `<span class="${labelClass}">${label}</span>`;

          // Embed scheduling metadata as data-* attrs so refreshSessionLabels can update in place
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
        container.innerHTML = '<div class="empty-state"><span>No upcoming group sessions</span></div>';
      } else {
        container.innerHTML = upcoming.map(s => {
          const { isJoinable, label, labelClass } = getSessionState(s.scheduled_at, s.status);
          if (isJoinable) {
            activeSessionCount++;
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
              <div class="session-action">
                ${isJoinable
              ? `<button class="btn btn-primary btn-sm" onclick="joinSession('${s.id}')">${t('btn_join_session')}</button>`
              : `<span class="${labelClass}">${label}</span>`}
              </div>
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

async function joinSession(session_id) {
  haptic('medium');
  try {
    const data = await apiFetch(`/api/sessions/${session_id}/join`);

    // Detect Plus Messenger (also covers Telegram Plus, Nicegram, etc.)
    const ua = navigator.userAgent;
    const isPlus = ua.includes('Plus') || ua.includes('TelegramPlus') || ua.includes('Nicegram');

    if (isPlus) {
      if (confirm("⚠️ Your current app may not support video calls.\nOpen in your phone's browser instead?")) {
        // Build the external URL (same room, same name, disable deep linking)
        const externalUrl = `https://${data.jitsi_domain}/${data.room_name}#config.disableDeepLinking=true&userInfo.displayName=${encodeURIComponent(data.display_name)}${data.jitsi_token ? `&jwt=${data.jitsi_token}` : ''}`;
        window.open(externalUrl, '_blank');
        return;
      }
    }

    launchJitsi(data.room_name, data.room_password, data.display_name, data.jitsi_token, data.is_moderator);
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
      launchJitsi(data.room_name, data.room_password, currentUser.anonymous_id, data.jitsi_token, true, data.session.id);
    } else {
      loadSessions();
    }
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
  titleField.classList.toggle('hidden', !is_group);
  participantField.classList.toggle('hidden', !is_group);

  if (is_group && menteeList) {
    menteeList.innerHTML = '<div class="text-xs text-dim">Loading mentees...</div>';
    apiFetch('/api/mentors/my-mentees').then(mentees => {
      if (!mentees.length) {
        menteeList.innerHTML = '<div class="text-xs text-dim">No mentees to invite.</div>';
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

function launchJitsi(roomName, roomPassword, displayName, token, isModerator = false, sessionId = null) {
  navigate('video');
  const container = $('jitsiContainer');
  if (!container) return;
  container.innerHTML = '';

  window.activeSession = {
    sessionId,
    isModerator
  };

  const initJitsi = () => {
    const options = {
      roomName,
      width: '100%',
      height: '100%',
      parentNode: container,
      userInfo: { displayName },
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
    window.jitsiApi.addEventListener('videoConferenceLeft', async () => {
      if (isModerator && sessionId) {
        try {
          await apiFetch(`/api/sessions/${sessionId}/end`, { method: 'PATCH' });
        } catch (e) {
          console.error('Failed to end session:', e);
        }
      }
      window.activeSession = null;
      if (window.jitsiApi) {
        try { window.jitsiApi.dispose(); window.jitsiApi = null; } catch (e) { }
      }
      navigate('sessions');
    });
    window.jitsiApi.addEventListener('passwordRequired', () => {
      if (roomPassword) window.jitsiApi.executeCommand('password', roomPassword);
    });

    // If this user is the moderator, set the password so the room is locked
    // for anyone who doesn't already have it (extra guard on public servers).
    if (isModerator && roomPassword) {
      window.jitsiApi.addEventListener('videoConferenceJoined', () => {
        window.jitsiApi.executeCommand('password', roomPassword);
      });
    }
  };

  if (window.JitsiMeetExternalAPI) {
    initJitsi();
  } else {
    const script = document.createElement('script');
    script.src = 'https://meet.jit.si/external_api.js';
    script.onload = initJitsi;
    document.head.appendChild(script);
  }

  $('sessionPasswordDisplay').textContent = roomPassword ? `Password: ${roomPassword}` : '';
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

async function loadChat() {
  try {
    const targetId = window.pendingChatPartner;
    window.pendingChatPartner = null;

    const res = await apiFetch('/api/users/chat-partner');
    const partnerWrapper = $('chatPartnerWrapper');

    if (res.type === 'none') {
      $('chatMessages').innerHTML = '<div class="empty-state"><span>No active mentorship.</span></div>';
      toggleChatInput(false);
      $('chatWith').style.display = 'block';
      $('chatWith').textContent = 'Messages';
      if (partnerWrapper) partnerWrapper.style.display = 'none';
      return;
    }

    if (res.type === 'single') {
      if (partnerWrapper) partnerWrapper.style.display = 'none';
      $('chatWith').style.display = 'block';
      $('chatWith').textContent = res.partner.display_name;
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
    const messageTree = buildMessageTree(messages);
    const container = $('chatMessages');
    container.innerHTML = renderThread(messageTree);
    container.scrollTop = container.scrollHeight;
  } catch (e) { console.error(e); }
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

  // Save the input to restore on failure
  const originalContent = content;
  input.value = '';
  $('emojiPicker')?.classList.add('hidden');

  // Disable send button to prevent double-click
  const sendBtn = document.querySelector('.chat-send-btn');
  if (sendBtn) sendBtn.disabled = true;
  if (sendBtn) sendBtn.classList.add('sending');

  let attempts = 0;
  const maxAttempts = 3;
  let lastError = null;

  while (attempts < maxAttempts) {
    try {
      const msg = await apiFetch('/api/messages', {
        method: 'POST',
        body: { to_id: window.chatState.with, content: originalContent }
      });
      // Success! Append message directly to chat
      appendMessageToChat(msg);
      // Exit the loop – we're done
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      attempts++;
      if (attempts < maxAttempts) {
        // Wait before retry: 500ms, 1000ms, 1500ms
        const delay = attempts * 500;
        await new Promise(r => setTimeout(r, delay));
        // Optional: show a subtle "Retrying..." indicator (we can skip for simplicity)
        continue;
      }
    }
  }

  // Re-enable send button
  if (sendBtn) sendBtn.disabled = false;
  if (sendBtn) sendBtn.classList.remove('sending');

  // If all attempts failed, show error and restore the message
  if (lastError && attempts === maxAttempts) {
    haptic('error');
    showToast(t('msg_send_failed'), 'error');
    // Put the message back in the input so user can try again manually
    input.value = originalContent;
    input.focus();
  }
}

function handleChatTyping() {
  if (socket && window.chatState.with) {
    socket.emit('typing', { to_id: window.chatState.with });
  }
}

function toggleEmojiPicker() {
  const picker = $('emojiPicker');
  if (!picker) return;

  if (picker.children.length === 0) {
    const emojis = ['😊', '😂', '🤣', '❤️', '👍', '🙏', '🔥', '😍', '😭', '😘', '😎', '😢', '😡', '😱', '🤔', '🙌', '👏', '🎉', '🌟', '💡', '💯', '🤝', '🙄', '💔'];
    picker.innerHTML = emojis.map(emoji => `<button onclick="insertEmoji('${emoji}')">${emoji}</button>`).join('');
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
  try {
    const s = await apiFetch('/api/users/settings');
    $('settingDisplayName').value = s.display_name || '';
    $('settingTimezone').value = s.timezone || 'UTC';
    $('toggleMessages').classList.toggle('on', s.notify_messages !== false);
    $('toggleSessions').classList.toggle('on', s.notify_sessions !== false);
    $('toggleVerse').classList.toggle('on', s.notify_daily_verse !== false);

    if (currentUser?.role === 'mentor') {
      $('mentorSettings').classList.remove('hidden');
      $('settingBio').value = s.bio || '';
      $('settingSpecialization').value = s.specialization || '';
      $('settingMaxMentees').value = s.max_mentees || 5;
    }

    $('userAnonId').textContent = currentUser?.anonymous_id || '';
    $('userRole').textContent = currentUser?.role || '';
  } catch (e) { showToast(e.message, 'error'); }
}

async function saveSettings() {
  haptic('medium');
  const body = {
    display_name: $('settingDisplayName').value,
    timezone: $('settingTimezone').value,
    notify_messages: $('toggleMessages').classList.contains('on'),
    notify_sessions: $('toggleSessions').classList.contains('on'),
    notify_daily_verse: $('toggleVerse').classList.contains('on'),
    bio: $('settingBio')?.value,
    specialization: $('settingSpecialization')?.value,
    max_mentees: parseInt($('settingMaxMentees')?.value) || 5,
  };
  try {
    await apiFetch('/api/users/settings', { method: 'PATCH', body });
    haptic('success');
    showToast('Settings saved', 'success');
  } catch (e) {
    haptic('error');
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

// ─── Support Ticket ───────────────────────────────────────────
async function submitTicket() {
  haptic('medium');
  const subject = $('ticketSubject').value.trim();
  const description = $('ticketDesc').value.trim();
  if (!subject || !description) { haptic('error'); showToast('Fill in all fields', 'error'); return; }

  try {
    await apiFetch('/api/support', { method: 'POST', body: { subject, description } });
    haptic('success');
    showToast('Ticket submitted', 'success');
    $('ticketSubject').value = ''; $('ticketDesc').value = '';
  } catch (e) { haptic('error'); showToast(e.message, 'error'); }
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

// ─── Mentor Management ────────────────────────────────────────
async function loadMyMentees() {
  const container = $('menteesList');
  container.innerHTML = window.skeletonHTML ? skeletonHTML(3) : '<div class="loading-spinner" style="margin:40px auto"></div>';
  try {
    const mentees = await apiFetch('/api/mentors/my-mentees');
    const stats = await apiFetch('/api/mentors/my-mentees/stats');

    $('activeMenteeCount').textContent = mentees.length;
    if (!mentees.length) {
      container.innerHTML = '<div class="empty-state"><span>No active mentees yet</span></div>';
      return;
    }

    let html = '';
    for (const m of mentees) {
      const { user, assigned_at, id: assignId } = m;
      const sessionCount = stats[user.telegram_id] || 0;

      html += `
        <div class="card mb-12">
          <div class="flex justify-between items-start mb-8">
            <div>
              <div class="font-bold" style="color:var(--gold)">${escapeHtml(user.anonymous_id)}</div>
              <div class="text-xs text-dim">${t('Joined')} ${new Date(assigned_at).toLocaleDateString()}</div>
              <div class="text-xs text-dim">${t('Sessions:')} ${sessionCount}</div>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="endMentorship('${assignId}')">${t('btn_end')}</button>
          </div>
          <div class="flex gap-8 mb-8">
            <button class="btn btn-outline btn-sm flex-1" onclick="openChat('${user.telegram_id}')">${t('btn_message')}</button>
            <button class="btn btn-outline btn-sm flex-1" onclick="createSession(false, '${user.telegram_id}')">${t('btn_session')}</button>
          </div>
          <div class="form-group mb-0">
            <textarea id="note-${user.telegram_id}" class="form-control text-sm" data-i18n="Private note about this mentee..." placeholder="${t('Private note about this mentee...')}" rows="2" onblur="saveMentorNote('${user.telegram_id}')"></textarea>
          </div>
        </div>`;
    }
    container.innerHTML = html;

    for (const m of mentees) {
      const note = await apiFetch(`/api/mentors/notes/${m.user.telegram_id}`);
      if (note.content) $(`note-${m.user.telegram_id}`).value = note.content;
    }
  } catch (e) { showToast(e.message, 'error'); }
}

async function saveMentorNote(menteeId) {
  const content = $(`note-${menteeId}`).value.trim();
  try {
    await apiFetch('/api/mentors/notes', { method: 'POST', body: { mentee_id: menteeId, content } });
    haptic('light');
  } catch (e) { showToast(e.message, 'error'); }
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
      loadMyMentees();
    } catch (e) { haptic('error'); showToast(e.message, 'error'); }
  } else {
    // Mentee Flow (from Mentors Page)
    if (!confirm(t('confirm_end_mentorship') || 'Are you sure you want to end your mentorship?')) return;
    haptic('medium');
    try {
      await apiFetch('/api/users/end-mentorship', { method: 'POST' });
      haptic('success');
      showToast(t('mentorship_ended'), 'success');
      navigate('dashboard');
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
  container.innerHTML = topics.map(t => `
    <div id="topic-${t.id}" class="chip ${selectedIds.includes(t.id) ? 'chip-gold' : 'chip-outline'}" onclick="toggleTopic(${t.id})">
      ${escapeHtml(t.name)}
    </div>
  `).join('');
}

function toggleTopic(id) {
  haptic('light');
  const idx = window.selectedTopics.indexOf(id);
  if (idx > -1) {
    window.selectedTopics.splice(idx, 1);
    $(`topic-${id}`).className = 'chip chip-outline';
  } else {
    window.selectedTopics.push(id);
    $(`topic-${id}`).className = 'chip chip-gold';
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
        <div class="journal-date">${formatDateTime(e.created_at)}</div>
        <div class="journal-mood">${getMoodIcon(e.mood)}</div>
        <div class="journal-preview">${escapeHtml(e.content.substring(0, 80))}${e.content.length > 80 ? '…' : ''}</div>
      </div>
    `).join('');
  } catch (e) { container.innerHTML = `<div class="empty-state"><span>${e.message}</span></div>`; }
}

function getMoodIcon(mood) {
  switch (mood) {
    case 'happy': return '😊';
    case 'sad': return '😢';
    default: return '😐';
  }
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

function toggleJournalView() {
  if (journalView === 'list') {
    journalView = 'calendar';
    showJournalCalendar();
    $('journalViewToggle').innerHTML = '📋 ' + t('List');
  } else {
    journalView = 'list';
    loadJournalEntries();
    $('journalViewToggle').innerHTML = '📅 ' + t('Calendar');
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
// ─── Boot ─────────────────────────────────────────────────────
window.loadDashboard = loadDashboard;
document.addEventListener('DOMContentLoaded', init);