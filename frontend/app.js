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
  const icon = $('themeIcon');
  if (icon) icon.textContent = theme === 'light' ? '🌙' : '☀️';
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

  if (startParam && startParam.startsWith('session_')) {
    const sessionId = startParam.replace('session_', '');
    setTimeout(() => joinSession(sessionId), 100);
    return;
  }

  // Fallback for direct browser testing
  const urlParams = new URLSearchParams(window.location.search);
  const browserStart = urlParams.get('start');
  if (browserStart && browserStart.startsWith('session_')) {
    const sessionId = browserStart.replace('session_', '');
    setTimeout(() => joinSession(sessionId), 100);
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
    if (currentPage === 'chat' && window.chatState?.with === msg.from_id) {
      appendMessage(msg, false);
    } else {
      updateMessageBadge();
      showToast('New message received');
      haptic('medium');
    }
  });
  socket.on('session_invite', (session) => {
    haptic('success');
    showToast(`📹 Session invite: ${session.title}`, 'info');
    if (confirm('A new session has been scheduled. Go to Sessions page to join?')) {
      navigate('sessions');
    }
  });
  socket.on('broadcast', ({ message }) => {
    showToast(`📢 ${message}`);
  });
  socket.on('typing', ({ from_id }) => {
    if (window.chatState?.with === from_id) {
      $('typingIndicator').textContent = 'typing...';
      clearTimeout(window.typingTimeout);
      window.typingTimeout = setTimeout(() => { $('typingIndicator').textContent = ''; }, 2000);
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
}

// ─── Navigation ───────────────────────────────────────────────
function navigate(page) {
  haptic('selection');
  currentPage = page;
  $$('.page').forEach(p => p.classList.remove('active'));
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $(`page-${page}`)?.classList.add('active');
  $(`nav-${page}`)?.classList.add('active');

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
      $('journalViewToggle').innerHTML = '📅 Calendar';
      break;
  }
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
  } catch (e) {
    console.error('Failed to load topics for onboarding:', e);
  }

  showStep(0);
}

function toggleOnboardingTopic(id) {
  haptic('light');
  const idx = onboardingSelectedTopics.indexOf(id);
  const el = $(`onb-topic-${id}`);
  if (idx > -1) {
    onboardingSelectedTopics.splice(idx, 1);
    if (el) el.className = 'chip chip-outline';
  } else {
    onboardingSelectedTopics.push(id);
    if (el) el.className = 'chip chip-gold';
  }
}

function showStep(step) {
  haptic('light');
  onboardingStep = step;
  $$('.step-dot').forEach((d, i) => {
    d.classList.toggle('active', i === step);
    d.classList.toggle('done', i < step);
  });
  $$('.onboarding-step').forEach((s, i) => s.classList.toggle('hidden', i !== step));
}

async function completeRegistration() {
  const sex = $('regSex').value;
  const age_range = $('regAge').value;
  const education_level = $('regEdu').value;
  const nickname = $('regNickname').value.trim();

  if (!sex || !age_range || !education_level || !nickname) {
    haptic('error');
    showToast('Please complete all fields', 'error'); return;
  }

  const nickRegex = /^[a-zA-Z0-9_]{3,20}$/;
  if (!nickRegex.test(nickname)) {
    haptic('error');
    showToast('Invalid nickname format (3-20 chars, no spaces)', 'error'); return;
  }

  const regBtn = $('regBtn');
  regBtn.disabled = true; regBtn.textContent = 'Registering...';

  try {
    const data = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: { sex, age_range, education_level, nickname, chat_id: getTelegramData().user?.id, topic_ids: Array.from($('regTopicsSelect').selectedOptions).map(o => Number(o.value)) },
    });
    haptic('success');
    currentUser = data.user;
    $('onboarding').style.display = 'none';
    startApp();
    showToast('Welcome! You are now registered 🙏', 'success');
  } catch (e) {
    haptic('error');
    if (e.message.includes('taken')) {
      showToast('Nickname taken, try another', 'error');
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
async function loadDashboard() {
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

  container.innerHTML = '<div class="loading-spinner" style="margin:40px auto"></div>';

  try {
    // Fetch all mentors (API already filters by same sex)
    let mentors = await apiFetch('/api/mentors');

    // Apply topic filter (mentor.expertise_topics is an array of topic names)
    if (selectedTopic && selectedTopic !== '') {
      mentors = mentors.filter(m => m.expertise_topics && m.expertise_topics.includes(selectedTopic));
    }

    if (!mentors.length) {
      let message = 'No mentors available';
      if (selectedTopic && selectedTopic !== '') {
        message = `No mentors available for "${selectedTopic}"`;
      }
      container.innerHTML = `<div class="empty-state"><span>${message}</span></div>`;
      return;
    }

    // Render mentor cards
    container.innerHTML = mentors.map(m => {
      const name = m.user_settings?.display_name || m.anonymous_id;
      const bio = m.user_settings?.bio || 'No bio provided';
      const spec = m.user_settings?.specialization || '';
      const letter = name.charAt(0).toUpperCase();
      const sexLabel = m.sex === 'M' ? 'Male' : m.sex === 'F' ? 'Female' : '';
      const mentees = m.mentee_count || 0;
      const max = m.user_settings?.max_mentees || 5;

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
          <button class="btn btn-outline btn-sm" onclick="requestMentorship(${m.telegram_id})" ${mentees >= max ? 'disabled' : ''}>
            ${mentees >= max ? t('none') : t('btn_request')}
          </button>
        </div>`;
    }).join('');
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
  container.innerHTML = '<div class="loading-spinner" style="margin:40px auto"></div>';
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
async function loadSessions() {
  try {
    const mySessions = await apiFetch('/api/sessions/my');
    const privateContainer = document.getElementById('privateSessionsList');
    if (!privateContainer) return;
    if (mySessions.length === 0) {
      privateContainer.innerHTML = '<div class="empty-state">No active or upcoming private sessions.</div>';
    } else {
      privateContainer.innerHTML = mySessions.map(s => {
        const session = s.session;
        if (!session) return '';
        const isGroup = session.is_group;
        const title = session.title || (isGroup ? 'Group Session' : 'Private Session');
        const scheduled = formatDateTime(session.scheduled_at);
        return `
          <div class="session-item">
            <div class="session-icon">${isGroup ? '👥' : '👤'}</div>
            <div class="session-body">
              <div class="session-title">${escapeHtml(title)}</div>
              <div class="session-sub">${scheduled} • ${session.status}</div>
            </div>
            ${session.status === 'scheduled' ? `<div style="display:flex; gap:8px;">
  <button class="btn btn-primary btn-sm" onclick="joinSession('${session.id}')">${t('btn_join_session')}</button>
  <button class="btn btn-outline btn-sm" onclick="openSessionInBrowser('${session.id}')">🌐 Browser</button>
</div>` : `<span class="chip chip-green">${t('btn_done')}</span>`}
          </div>`;
      }).filter(Boolean).join('');
    }
  } catch (e) { console.error('Error loading private sessions', e); }

  try {
    const upcoming = await apiFetch('/api/sessions/upcoming');
    const container = document.getElementById('upcomingSessions');
    if (!container) return;
    if (!upcoming.length) {
      container.innerHTML = '<div class="empty-state"><span>No upcoming group sessions</span></div>';
      return;
    }
    container.innerHTML = upcoming.map(s => `
      <div class="session-item">
        <div class="session-icon">👥</div>
        <div class="session-body">
          <div class="session-title">${escapeHtml(s.title)}</div>
          <div class="session-sub">${formatDateTime(s.scheduled_at)}</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="joinSession('${s.id}')">Join</button>
      </div>`).join('');
  } catch (e) {
    if (document.getElementById('upcomingSessions')) {
      document.getElementById('upcomingSessions').innerHTML = `<div class="empty-state"><span>${e.message}</span></div>`;
    }
  }
}

async function clearSessionHistory() {
  if (!confirm('Clear history of ended sessions?')) return;
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

    launchJitsi(data.room_name, data.room_password, data.display_name, data.jitsi_token);
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
    if (!is_group && !mentee_id && currentUser?.role === 'mentor') {
      const res = await apiFetch('/api/users/chat-partner');
      if (res.type === 'single') {
        mentee_id = res.partner.telegram_id;
      } else if (res.type === 'multiple') {
        openMenteeSelectModal();
        return;
      } else {
        haptic('error');
        showToast('No active mentees to start a session with.', 'error');
        return;
      }
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
      launchJitsi(data.room_name, data.room_password, currentUser.anonymous_id, data.jitsi_token);
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

function launchJitsi(roomName, roomPassword, displayName, token) {
  navigate('video');
  const container = $('jitsiContainer');
  if (!container) return;
  container.innerHTML = '';

  const initJitsi = () => {
    const options = {
      roomName,
      width: '100%',
      height: '100%',
      parentNode: container,
      userInfo: { displayName },
      configOverwrite: {
        startWithAudioMuted: true,
        startWithVideoMuted: true,
        enableClosePage: false,
        disableDeepLinking: true,
        ...(roomPassword ? { password: roomPassword } : {}),
      },
      interfaceConfigOverwrite: {
        TOOLBAR_BUTTONS: ['microphone', 'camera', 'desktop', 'chat', 'raisehand', 'fullscreen', 'tileview', 'hangup'],
        SHOW_JITSI_WATERMARK: false,
        MOBILE_APP_PROMO: false,
      },
      ...(token ? { jwt: token } : {}),
    };

    if (window.jitsiApi) {
      try { window.jitsiApi.dispose(); } catch (e) { console.error(e); }
    }

    window.jitsiApi = new JitsiMeetExternalAPI('meet.opensuse.org', options);
    window.jitsiApi.addEventListener('videoConferenceLeft', () => navigate('sessions'));
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
    document.head.appendChild(script);
  }

  $('sessionPasswordDisplay').textContent = roomPassword ? `Password: ${roomPassword}` : '';
}

// ─── Chat ─────────────────────────────────────────────────────
window.chatState = {};

async function loadChat() {
  try {
    const targetId = window.pendingChatPartner;
    window.pendingChatPartner = null;

    const res = await apiFetch('/api/users/chat-partner');
    const selector = $('chatPartnerSelect');

    if (res.type === 'none') {
      $('chatMessages').innerHTML = '<div class="empty-state"><span>No active mentorship.</span></div>';
      toggleChatInput(false);
      $('chatWith').style.display = 'block';
      $('chatWith').textContent = 'Messages';
      selector.style.display = 'none';
      return;
    }

    if (res.type === 'single') {
      selector.style.display = 'none';
      $('chatWith').style.display = 'block';
      $('chatWith').textContent = res.partner.display_name;
      window.chatState = { with: res.partner.telegram_id, name: res.partner.anonymous_id };
      loadMessages(res.partner.telegram_id);
    } else {
      $('chatWith').style.display = 'none';
      selector.style.display = 'block';
      selector.innerHTML = res.mentees.map(m => `<option value="${m.telegram_id}">${escapeHtml(m.display_name)}</option>`).join('');

      const selectedId = targetId || res.mentees[0].telegram_id;
      selector.value = selectedId;

      const partner = res.mentees.find(m => String(m.telegram_id) === String(selectedId)) || res.mentees[0];
      window.chatState = { with: partner.telegram_id, name: partner.anonymous_id };
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
  }
}

function switchChatPartner(tid) {
  haptic('selection');
  window.chatState.with = tid;
  toggleChatInput(true);
  loadMessages(tid);
}

function openChat(partnerId) {
  window.pendingChatPartner = partnerId;
  navigate('chat');
}

async function loadMessages(with_id) {
  try {
    const messages = await apiFetch(`/api/messages/${with_id}`);
    const container = $('chatMessages');
    container.innerHTML = messages.map(m => renderMessage(m)).join('');
    container.scrollTop = container.scrollHeight;
  } catch (e) { console.error(e); }
}

function renderMessage(msg) {
  const isSent = msg.from_id === currentUser?.telegram_id;
  return `<div class="message-bubble ${isSent ? 'sent' : 'received'}">
    ${escapeHtml(msg.content)}
    <div class="message-time">${formatTime(msg.created_at)}</div>
  </div>`;
}

function appendMessage(msg, isSent) {
  const container = $('chatMessages');
  const div = document.createElement('div');
  div.innerHTML = renderMessage(msg);
  container.appendChild(div.firstChild);
  container.scrollTop = container.scrollHeight;
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

  input.value = '';
  try {
    const msg = await apiFetch('/api/messages', {
      method: 'POST',
      body: { to_id: window.chatState.with, content }
    });
    appendMessage(msg, true);
  } catch (e) {
    haptic('error');
    showToast(e.message, 'error');
  }
}

function handleChatTyping() {
  if (socket && window.chatState.with) {
    socket.emit('typing', { to_id: window.chatState.with });
  }
}

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
  $('applyEdu').value = '';
  $('applyAbout').value = '';
  $('applyModal').classList.add('open');
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
  container.innerHTML = '<div class="loading-spinner" style="margin:40px auto"></div>';
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
  if (!confirm('End this mentorship assignment?')) return;
  haptic('medium');
  try {
    await apiFetch(`/api/mentors/end-mentorship/${assignId}`, { method: 'DELETE' });
    haptic('success');
    showToast(t('mentorship_ended'), 'success');
    loadMyMentees();
  } catch (e) { haptic('error'); showToast(e.message, 'error'); }
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
  container.innerHTML = '<div class="loading-spinner" style="margin:40px auto"></div>';
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
    $('journalViewToggle').innerHTML = '📋 List';
  } else {
    journalView = 'list';
    loadJournalEntries();
    $('journalViewToggle').innerHTML = '📅 Calendar';
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
document.addEventListener('DOMContentLoaded', init);