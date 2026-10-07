/* ═══════════════════════════════════════════════════════════════════════════
   Chat media — voice messages, photos, videos and files in the Mini App chat,
   behaving like Telegram:

     · the round button is a mic when the box is empty and "send" when there is
       text; HOLD it to record, slide LEFT to cancel, slide UP to lock
     · the paperclip opens "Photo or video" / "File"; a preview sheet with a
       caption comes up before anything is sent
     · every attachment shows a bubble at once with a progress ring (✕ cancels,
       a failed one shows a retry ring); voice bubbles have a waveform player
     · incoming files download on tap, with progress

   Loaded after app.js. app.js calls: renderFileAttachment, attachmentLabel,
   hydratePhotoMessages, updateComposerMode, closeComposerPopups,
   cancelRecording. Uploads go to POST /api/messages/upload (routes/messages.js).
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

/* Where "record in the bot chat instead" points when the WebView has no mic. */
const CM_BOT_USERNAME = 'holynessforchristbot';

const CM_MAX_BYTES = 20 * 1024 * 1024;          // Telegram's bot download ceiling
const CM_MAX_FILES = 10;
const CM_MAX_REC_SECONDS = 15 * 60;
const CM_MIN_REC_SECONDS = 1;
const CM_WAVE_BARS = 40;
const CM_BLOCKED_EXT = /\.(exe|bat|cmd|com|scr|msi|vbs|ps1|pif|cpl|dll|apk|jar)$/i;   // keep in sync with routes/messages.js

/* ── tiny helpers ─────────────────────────────────────────────────────────── */
// The app-wide escapeHtml() leaves quotes alone, which is fine between tags but
// NOT inside an attribute: a file name like  x" onmouseover="…  would break out of
// data-name="…". Everything rendered here goes through this stricter version.
function cmEsc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cmT(key, fallback, repl) {
  let s = fallback;
  try {
    const v = typeof t === 'function' ? t(key) : key;
    if (v && v !== key) s = v;
  } catch { /* use fallback */ }
  if (repl) for (const [k, v] of Object.entries(repl)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  return s;
}

function cmFmtDur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function cmFmtSize(bytes) {
  bytes = Number(bytes);
  if (!isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const cmTg = () => window.Telegram?.WebApp;
const cmMsgMap = () => window._chatMessagesMap || (window._chatMessagesMap = new Map());
const cmThread = (id) => document.querySelector(`#chatMessages .message-thread[data-msg-id="${CSS.escape(String(id))}"]`);

/* ── icons ────────────────────────────────────────────────────────────────── */
const CM_ICON = {
  play: '<svg class="cm-ico cm-ico-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6a.6.6 0 0 0 .9.5l11-6.8a.6.6 0 0 0 0-1L8.9 4.7a.6.6 0 0 0-.9.5z"/></svg>',
  pause: '<svg class="cm-ico cm-ico-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 5h3.7v14H6.5zM13.8 5h3.7v14h-3.7z"/></svg>',
  down: '<svg class="cm-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
  file: '<svg class="cm-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  retry: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

const CM_RING_C = 131.95;                        // circumference of r=21

function cmRingSvg(glyph) {
  return `<svg class="cm-ring-svg" viewBox="0 0 48 48" aria-hidden="true"><circle class="cm-ring-track" cx="24" cy="24" r="21"/><circle class="cm-ring-arc" cx="24" cy="24" r="21" style="stroke-dasharray:${CM_RING_C * 0.25} ${CM_RING_C}"/></svg>` +
    `<svg class="cm-ring-glyph" viewBox="0 0 24 24" aria-hidden="true">${glyph}</svg>`;
}

function cmRingBtn(status, overlay) {
  const failed = status === 'failed';
  return `<button type="button" class="cm-ring${overlay ? ' cm-ring--overlay' : ''}${failed ? ' is-failed' : ''}" data-act="${failed ? 'retry' : 'cancel'}" aria-label="${failed ? cmT('cm_retry', 'Retry') : cmT('btn_cancel', 'Cancel')}">${cmRingSvg(failed ? CM_ICON.retry : CM_ICON.x)}</button>`;
}

function cmSetArc(root, p) {
  const arc = root?.querySelector?.('.cm-ring-arc');
  if (!arc) return;
  p = Math.min(1, Math.max(0.04, Number(p) || 0));
  arc.style.strokeDasharray = `${CM_RING_C * p} ${CM_RING_C}`;
}

/* ── labels used outside the chat (reply banner / quote) ──────────────────── */
function attachmentLabel(msg) {
  switch (msg?.file_type) {
    case 'photo': return '📷 ' + cmT('cm_photo', 'Photo');
    case 'voice': return '🎤 ' + cmT('cm_voice_message', 'Voice message');
    case 'video': return '🎬 ' + cmT('cm_video', 'Video');
    case 'audio': return '🎵 ' + (msg.file_name || cmT('cm_audio', 'Audio'));
    default: return '📎 ' + (msg?.file_name || cmT('cm_file', 'File'));
  }
}

/* ═══ Waveform ═════════════════════════════════════════════════════════════ */
function cmEncodeWave(peaks) {
  if (!peaks || peaks.length < 2) return '';
  const out = [];
  let max = 0.05;
  const bars = [];
  for (let i = 0; i < CM_WAVE_BARS; i++) {
    const a = Math.floor((i * peaks.length) / CM_WAVE_BARS);
    const b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / CM_WAVE_BARS));
    let m = 0;
    for (let j = a; j < b && j < peaks.length; j++) m = Math.max(m, peaks[j]);
    bars.push(m);
    max = Math.max(max, m);
  }
  for (const v of bars) out.push(Math.round(Math.pow(v / max, 0.75) * 31).toString(32));
  return out.join('');
}

function cmWaveValues(msg) {
  const w = typeof msg.waveform === 'string' && /^[0-9a-v]{8,128}$/.test(msg.waveform) ? msg.waveform : '';
  if (w) return [...w].map(c => parseInt(c, 32) / 31);
  // Voice messages that came from the bot have no stored waveform: draw a
  // stable, natural-looking one derived from the file id.
  const seed = String(msg.file_id || msg.id || 'x');
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const vals = [];
  let prev = 0.5;
  for (let i = 0; i < CM_WAVE_BARS; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const r = (h % 1000) / 1000;
    prev = Math.min(1, Math.max(0.12, prev * 0.45 + r * 0.7));
    vals.push(prev);
  }
  return vals;
}

/* ═══ Rendering (called by renderThread in app.js) ═════════════════════════ */
function renderFileAttachment(msg) {
  const local = msg._local || null;
  const fid = cmEsc(msg.file_id || '');
  const mid = cmEsc(String(msg.id));
  const mime = cmEsc(msg.mime_type || '');

  switch (msg.file_type) {
    case 'voice':
    case 'audio': {
      const bars = cmWaveValues(msg).map(v => `<i style="height:${Math.round(14 + v * 86)}%"></i>`).join('');
      const btn = local
        ? cmRingBtn(local.status)
        : `<button type="button" class="cm-voice-btn" aria-label="${cmT('cm_play', 'Play')}">${CM_ICON.play}${CM_ICON.pause}</button>`;
      const name = msg.file_type === 'audio'
        ? `<div class="cm-voice-name">${cmEsc(msg.file_name || cmT('cm_audio', 'Audio'))}</div>` : '';
      return `<div class="cm-voice" data-file-id="${fid}" data-mid="${mid}" data-mime="${mime}" data-duration="${Number(msg.duration) || 0}">
        ${btn}<div class="cm-voice-body">${name}<div class="cm-wave" aria-hidden="true">${bars}</div>
        <div class="cm-voice-time">${cmFmtDur(msg.duration)}</div></div></div>`;
    }

    case 'photo':
      if (local) {
        return `<div class="msg-photo cm-photo msg-photo-loaded" data-mid="${mid}">
          <img class="msg-photo-img" src="${cmEsc(local.url)}" alt="${cmT('cm_photo', 'Photo')}"/>
          <div class="cm-media-overlay">${cmRingBtn(local.status, true)}</div></div>`;
      }
      return `<div class="msg-photo cm-photo" data-file-id="${fid}" data-mime="${mime}">
        <div class="msg-photo-placeholder">${cmT('cm_loading_photo', 'Loading photo…')}</div></div>`;

    case 'video': {
      const chip = [msg.duration ? cmFmtDur(msg.duration) : '', cmFmtSize(msg.file_size)].filter(Boolean).join(' · ');
      if (local) {
        return `<div class="cm-video" data-mid="${mid}">
          <video src="${cmEsc(local.url)}" muted playsinline preload="metadata"></video>
          ${chip ? `<span class="cm-chip">${cmEsc(chip)}</span>` : ''}
          <div class="cm-media-overlay">${cmRingBtn(local.status, true)}</div></div>`;
      }
      return `<div class="cm-video" data-file-id="${fid}" data-mime="${mime}">
        <button type="button" class="cm-ring cm-ring--overlay cm-video-btn" data-act="play" aria-label="${cmT('cm_play', 'Play')}">${CM_ICON.play}</button>
        ${chip ? `<span class="cm-chip">${cmEsc(chip)}</span>` : ''}</div>`;
    }

    default: {
      const name = cmEsc(msg.file_name || cmT('cm_file', 'File'));
      const btn = local
        ? cmRingBtn(local.status)
        : `<button type="button" class="cm-file-btn" data-act="file" aria-label="${cmT('cm_download', 'Download')}">${CM_ICON.down}</button>`;
      return `<div class="cm-file" data-file-id="${fid}" data-mid="${mid}" data-mime="${mime}" data-name="${name}">
        ${btn}<div class="cm-file-meta"><div class="cm-file-name">${name}</div>
        <div class="cm-file-size">${cmEsc(cmFmtSize(msg.file_size))}</div></div></div>`;
    }
  }
}

/* ═══ Authed download with progress + blob-URL cache ═══════════════════════ */
async function cmFetchBlob(path, onProgress, signal) {
  const { initData, user } = getTelegramData();
  const res = await fetch(`${API}${path}`, {
    headers: { 'x-telegram-init-data': initData, 'x-telegram-id': user?.id || '' },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!onProgress || !total || !res.body?.getReader) {
    const b = await res.blob();
    onProgress?.(1);
    return b;
  }
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  return new Blob(parts, { type: res.headers.get('content-type') || '' });
}

const cmMediaCache = new Map();                  // file_id → { promise }
const CM_CACHE_MAX = 30;

function cmCacheSet(fileId, promise) {
  cmMediaCache.set(fileId, { promise });
  while (cmMediaCache.size > CM_CACHE_MAX) {
    const k = cmMediaCache.keys().next().value;
    const old = cmMediaCache.get(k);
    cmMediaCache.delete(k);
    old.promise.then(u => URL.revokeObjectURL(u)).catch(() => { });
  }
}

function cmGetMediaUrl(fileId, mime, onProgress, signal) {
  const hit = cmMediaCache.get(fileId);
  if (hit) return hit.promise;
  const promise = (async () => {
    const blob = await cmFetchBlob(`/api/messages/file/${encodeURIComponent(fileId)}`, onProgress, signal);
    // Telegram serves some files as application/octet-stream; the element
    // won't play/preview them unless the blob carries the real type.
    const typed = mime && (!blob.type || blob.type === 'application/octet-stream') ? new Blob([blob], { type: mime }) : blob;
    return URL.createObjectURL(typed);
  })();
  cmCacheSet(fileId, promise);
  promise.catch(() => cmMediaCache.delete(fileId));
  return promise;
}

/* ═══ Photos ═══════════════════════════════════════════════════════════════ */
function hydratePhotoMessages(container) {
  if (!container) return;
  container.querySelectorAll('.msg-photo[data-file-id]:not(.msg-photo-loaded)').forEach(async el => {
    el.classList.add('msg-photo-loaded');      // mark first so it is never fetched twice
    try {
      const url = await cmGetMediaUrl(el.dataset.fileId, el.dataset.mime || 'image/jpeg');
      el.innerHTML = `<img src="${url}" class="msg-photo-img" alt="${cmT('cm_photo', 'Photo')}"/>`;
    } catch {
      el.classList.remove('msg-photo-loaded');
      el.innerHTML = `<div class="msg-photo-error">${cmT('cm_photo_failed', 'Tap to reload photo')}</div>`;
      el.classList.add('is-error');
    }
  });
}

/* ═══ Voice player (one at a time, like Telegram) ══════════════════════════ */
const cmPlayer = { audio: null, el: null, fileId: null };

function cmPlayerPaint() {
  const { audio, el } = cmPlayer;
  if (!audio || !el || !el.isConnected) return;
  const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(el.dataset.duration) || 0;
  const p = dur ? Math.min(1, audio.currentTime / dur) : 0;
  const bars = el.querySelectorAll('.cm-wave i');
  const on = Math.round(p * bars.length);
  bars.forEach((b, i) => b.classList.toggle('on', i < on));
  el.querySelector('.cm-voice-time').textContent = cmFmtDur(audio.currentTime);
}

function cmPlayerReset(el) {
  if (!el) return;
  el.classList.remove('is-playing', 'is-loading');
  el.querySelectorAll('.cm-wave i.on').forEach(b => b.classList.remove('on'));
  const t = el.querySelector('.cm-voice-time');
  if (t) t.textContent = cmFmtDur(el.dataset.duration);
}

function cmStopVoice() {
  const { audio, el } = cmPlayer;
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load?.(); }
  cmPlayerReset(el);
  cmPlayer.audio = null; cmPlayer.el = null; cmPlayer.fileId = null;
}

async function cmToggleVoice(box, startAt) {
  const fileId = box.dataset.fileId;
  if (!fileId) return;

  if (cmPlayer.audio && cmPlayer.fileId === fileId) {       // same message: pause / resume / seek
    if (cmPlayer.el !== box) { cmPlayerReset(cmPlayer.el); cmPlayer.el = box; }
    const a = cmPlayer.audio;
    if (startAt != null) {
      const dur = isFinite(a.duration) && a.duration > 0 ? a.duration : Number(box.dataset.duration) || 0;
      if (dur) a.currentTime = startAt * dur;
      if (a.paused) a.play().catch(() => { });
    } else if (a.paused) a.play().catch(() => { });
    else a.pause();
    return;
  }

  cmStopVoice();
  cmReleaseAudioStream(true);       // an open microphone makes Android play audio quietly
  cmPlayer.el = box;
  cmPlayer.fileId = fileId;
  box.classList.add('is-loading');
  let url;
  try {
    url = await cmGetMediaUrl(fileId, box.dataset.mime || 'audio/ogg');
  } catch {
    if (cmPlayer.el === box) cmStopVoice();
    haptic('error');
    showToast(cmT('cm_voice_failed', 'Could not load the voice message'), 'error');
    return;
  }
  if (cmPlayer.el !== box) return;                          // user tapped something else meanwhile
  box.classList.remove('is-loading');

  const a = new Audio();
  a.preload = 'auto';
  a.src = url;
  cmPlayer.audio = a;
  a.addEventListener('play', () => cmPlayer.el?.classList.add('is-playing'));
  a.addEventListener('pause', () => cmPlayer.el?.classList.remove('is-playing'));
  a.addEventListener('timeupdate', cmPlayerPaint);
  a.addEventListener('error', () => {
    if (cmPlayer.audio !== a) return;
    cmStopVoice();
    showToast(cmT('cm_voice_failed', 'Could not load the voice message'), 'error');
  });
  a.addEventListener('ended', () => {
    const done = cmPlayer.el;
    cmStopVoice();
    // Like Telegram: roll straight into the next message if it is a voice message.
    const next = done?.closest('.message-thread')?.nextElementSibling;
    const nextVoice = next?.classList?.contains('message-thread') ? next.querySelector('.cm-voice') : null;
    if (nextVoice && !nextVoice.querySelector('.cm-ring')) cmToggleVoice(nextVoice);   // skip one still uploading
  });
  if (startAt != null) {
    a.addEventListener('loadedmetadata', () => {
      const dur = isFinite(a.duration) && a.duration > 0 ? a.duration : Number(box.dataset.duration) || 0;
      if (dur) a.currentTime = startAt * dur;
    }, { once: true });
  }
  a.play().catch(() => { cmPlayerReset(box); });
  haptic('light');
}

/* ═══ Video / file downloads ═══════════════════════════════════════════════ */
const cmDownloads = new Map();                   // file_id → AbortController

function cmBtnProgress(btn, p) {
  if (!btn) return;
  if (!btn.querySelector('.cm-ring-svg')) {
    btn.classList.add('is-dl');
    btn.insertAdjacentHTML('beforeend', cmRingSvg(CM_ICON.x));
  }
  cmSetArc(btn, p);
}

function cmBtnProgressEnd(btn) {
  btn?.classList.remove('is-dl');
  btn?.querySelectorAll('.cm-ring-svg, .cm-ring-glyph').forEach(n => n.remove());
}

function cmCancelDownload(fileId) {
  cmDownloads.get(fileId)?.abort();
  cmDownloads.delete(fileId);
}

async function cmPlayVideo(box) {
  const fileId = box.dataset.fileId;
  const btn = box.querySelector('.cm-video-btn');
  if (!fileId || !btn) return;
  if (cmDownloads.has(fileId)) { cmCancelDownload(fileId); cmBtnProgressEnd(btn); return; }
  const ctrl = new AbortController();
  cmDownloads.set(fileId, ctrl);
  cmBtnProgress(btn, 0.04);
  try {
    const url = await cmGetMediaUrl(fileId, box.dataset.mime || 'video/mp4', p => cmBtnProgress(btn, p), ctrl.signal);
    if (!box.isConnected) return;
    box.classList.add('is-playing');
    box.innerHTML = `<video class="cm-video-player" src="${url}" controls autoplay playsinline></video>`;
  } catch (e) {
    cmBtnProgressEnd(btn);
    if (e?.name !== 'AbortError') { haptic('error'); showToast(cmT('cm_download_failed', 'Download failed'), 'error'); }
  } finally {
    cmDownloads.delete(fileId);
  }
}

// window.open() on a blob: URL is blocked in Telegram's mobile WebView, so on
// phones prefer the native share sheet ("Save to Files" etc.), then a download link.
async function cmOpenBlob(url, name, mime) {
  try {
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], name || 'file', { type: mime || blob.type });
    const touch = matchMedia('(pointer: coarse)').matches;
    if (touch && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return;          // user closed the share sheet
  }
  const win = window.open(url, '_blank');
  if (!win) {
    const a = document.createElement('a');
    a.href = url; a.download = name || 'file'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
}

async function cmFileTap(box) {
  const fileId = box.dataset.fileId;
  const btn = box.querySelector('.cm-file-btn');
  if (!fileId || !btn) return;
  const sizeEl = box.querySelector('.cm-file-size');

  if (box.classList.contains('is-ready')) {
    haptic('light');
    cmOpenBlob(await cmGetMediaUrl(fileId, box.dataset.mime), box.dataset.name, box.dataset.mime);
    return;
  }
  if (cmDownloads.has(fileId)) { cmCancelDownload(fileId); cmBtnProgressEnd(btn); box.classList.remove('is-loading'); return; }

  const ctrl = new AbortController();
  cmDownloads.set(fileId, ctrl);
  box.classList.add('is-loading');
  haptic('light');
  const total = Number(cmMsgMap().get(box.dataset.mid)?.file_size) || 0;
  cmBtnProgress(btn, 0.04);
  try {
    await cmGetMediaUrl(fileId, box.dataset.mime, p => {
      cmBtnProgress(btn, p);
      if (sizeEl && total) sizeEl.textContent = `${cmFmtSize(total * p)} / ${cmFmtSize(total)}`;
    }, ctrl.signal);
    box.classList.add('is-ready');
    btn.innerHTML = CM_ICON.file;
    btn.setAttribute('aria-label', cmT('cm_open', 'Open'));
    if (sizeEl) sizeEl.textContent = cmFmtSize(total);
    haptic('success');
  } catch (e) {
    cmBtnProgressEnd(btn);
    if (sizeEl) sizeEl.textContent = cmFmtSize(total);
    if (e?.name !== 'AbortError') { haptic('error'); showToast(cmT('cm_download_failed', 'Download failed'), 'error'); }
  } finally {
    cmDownloads.delete(fileId);
    box.classList.remove('is-loading');
    cmBtnProgressEnd(btn);
  }
}

/* One delegated listener for every attachment control in the chat. */
document.addEventListener('click', (e) => {
  const root = e.target.closest?.('#chatMessages');
  if (!root) return;

  const ring = e.target.closest('.cm-ring[data-act="cancel"], .cm-ring[data-act="retry"]');
  if (ring && ring.closest('[data-mid]')) {
    const tempId = ring.closest('.message-thread')?.dataset.msgId;
    if (ring.dataset.act === 'retry') cmRetryUpload(tempId); else cmCancelUpload(tempId);
    return;
  }

  const wave = e.target.closest('.cm-wave');
  if (wave && !wave.closest('.cm-voice')?.querySelector('.cm-ring')) {
    const r = wave.getBoundingClientRect();
    cmToggleVoice(wave.closest('.cm-voice'), Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
    return;
  }
  const vbtn = e.target.closest('.cm-voice-btn');
  if (vbtn) { cmToggleVoice(vbtn.closest('.cm-voice')); return; }

  const video = e.target.closest('.cm-video-btn');
  if (video) { cmPlayVideo(video.closest('.cm-video')); return; }

  const file = e.target.closest('.cm-file-btn');
  if (file) { cmFileTap(file.closest('.cm-file')); return; }

  const img = e.target.closest('.msg-photo-img');
  if (img && !img.closest('.cm-photo')?.querySelector('.cm-ring')) { openImageLightbox(img.src); return; }

  const err = e.target.closest('.msg-photo.is-error');
  if (err) { err.classList.remove('is-error', 'msg-photo-loaded'); err.innerHTML = `<div class="msg-photo-placeholder">${cmT('cm_loading_photo', 'Loading photo…')}</div>`; hydratePhotoMessages(root); }
});

/* ═══ Uploading ════════════════════════════════════════════════════════════ */
const cmPending = new Map();                     // tempId → { blob, item, toId, xhr, status }
let cmChain = Promise.resolve();                 // one upload at a time keeps messages in order
let cmSeq = 0;
let cmLastTypingEmit = 0;

function cmEmitAction(action) {
  const to = window.chatState?.with;
  const now = Date.now();
  if (!socket?.connected || !to || now - cmLastTypingEmit < 2500) return;
  cmLastTypingEmit = now;
  socket.emit('typing', { to_id: to, action });
}

function cmRerender(tempId, status) {
  const msg = cmMsgMap().get(String(tempId));
  const el = cmThread(tempId);
  if (!msg || !el) return;
  msg._local.status = status;
  el.outerHTML = renderThread([msg], false);
  const bubble = cmThread(tempId)?.querySelector('.message-bubble');
  if (!bubble) return;
  bubble.classList.toggle('sending', status === 'uploading');
  if (status === 'failed') {
    bubble.classList.add('failed');
    bubble.insertAdjacentHTML('beforeend', `<div class="failed-status"><span>${cmT('cm_not_sent', 'Not sent')}</span>
      <button class="btn btn-danger btn-xs btn-outline retry-btn" type="button" onclick="cmCancelUpload('${tempId}')">${cmT('cm_remove', 'Remove')}</button></div>`);
  }
}

function cmSetProgress(tempId, loaded, total) {
  const el = cmThread(tempId);
  if (!el) return;
  const p = total ? loaded / total : 0.1;
  // Once every byte is out the server still has to hand the file to Telegram;
  // keep the arc almost-full rather than reading "done" too early.
  const shown = Math.min(0.96, p);
  el.querySelectorAll('.cm-ring-arc').forEach(a => { a.style.strokeDasharray = `${CM_RING_C * Math.max(0.04, shown)} ${CM_RING_C}`; });
  const sizeEl = el.querySelector('.cm-file-size');
  if (sizeEl && total) sizeEl.textContent = `${cmFmtSize(loaded)} / ${cmFmtSize(total)}`;
}

function cmDropLocal(tempId) {
  const msg = cmMsgMap().get(String(tempId));
  if (msg?._local?.url && msg._local.owns) URL.revokeObjectURL(msg._local.url);
  cmMsgMap().delete(String(tempId));
  cmPending.delete(tempId);
  cmThread(tempId)?.remove();
}

function cmCancelUpload(tempId) {
  const p = cmPending.get(tempId);
  if (p?.xhr && p.status === 'uploading') { p.cancelled = true; try { p.xhr.abort(); } catch { } }
  cmDropLocal(tempId);
  haptic('light');
}

function cmRetryUpload(tempId) {
  const p = cmPending.get(tempId);
  if (!p || p.status === 'uploading') return;
  p.status = 'queued';
  cmRerender(tempId, 'uploading');
  haptic('light');
  cmEnqueue(tempId);
}

function cmEnqueue(tempId) {
  cmChain = cmChain.then(() => cmUpload(tempId)).catch(() => { });
}

function cmUpload(tempId) {
  const p = cmPending.get(tempId);
  if (!p || p.cancelled) return Promise.resolve();
  p.status = 'uploading';

  return new Promise((resolve) => {
    const { item } = p;
    const form = new FormData();
    form.append('kind', item.kind);
    form.append('mime_type', (item.mime || '').split(';')[0]);
    form.append('file_name', item.name || '');
    if (item.duration) form.append('duration', String(item.duration));
    if (item.waveform) form.append('waveform', item.waveform);
    if (p.caption) form.append('caption', p.caption);
    if (p.parentId) form.append('parent_id', String(p.parentId));
    form.append('file', p.blob, item.name || 'file');

    const { initData, user } = getTelegramData();
    const xhr = new XMLHttpRequest();
    p.xhr = xhr;
    xhr.open('POST', `${API}/api/messages/upload?to_id=${encodeURIComponent(p.toId)}&client_id=${encodeURIComponent(tempId)}`);
    xhr.setRequestHeader('x-telegram-init-data', initData || '');
    xhr.setRequestHeader('x-telegram-id', String(user?.id || ''));
    if (socket?.id) xhr.setRequestHeader('x-socket-id', socket.id);
    xhr.timeout = 10 * 60 * 1000;
    xhr.responseType = 'json';

    xhr.upload.onprogress = (e) => {
      cmSetProgress(tempId, e.loaded, e.lengthComputable ? e.total : 0);
      cmEmitAction('upload');
    };

    const fail = (message, final) => {
      if (p.cancelled) return resolve();
      haptic('error');
      showToast(message, 'error');
      if (final) cmDropLocal(tempId);
      else { p.status = 'failed'; cmRerender(tempId, 'failed'); }
      resolve();
    };

    xhr.onload = () => {
      const body = xhr.response && typeof xhr.response === 'object' ? xhr.response : {};
      if (xhr.status === 200 || xhr.status === 201) {
        const msg = body;
        // The bytes are now stored under a permanent file_id. Remember the local
        // copy under it so playing / opening what we just sent needs no download.
        if (msg.file_id && !cmMediaCache.has(msg.file_id)) {
          const local = cmMsgMap().get(String(tempId))?._local;
          const url = local?.url || URL.createObjectURL(p.blob);
          if (local) local.owns = false;            // the cache owns the URL now
          cmCacheSet(msg.file_id, Promise.resolve(url));
        }
        cmPending.delete(tempId);
        const container = $('chatMessages');
        if (container) {
          if (!replaceOptimisticBubble(container, tempId, msg)) cmMsgMap().delete(String(tempId));
        }
        haptic('light');
        return resolve();
      }
      const server = body.error || '';
      if (xhr.status === 413) return fail(cmT('cm_too_large', 'File is too large (max 20 MB)'), true);
      if (xhr.status === 415) return fail(cmT('cm_blocked', 'This type of file cannot be sent'), true);
      if (xhr.status === 403) return fail(server || cmT('msg_send_failed', 'Failed to send'), true);
      return fail(cmT('cm_upload_failed', 'Upload failed. Check your connection and tap retry.'), false);
    };
    xhr.onerror = () => fail(cmT('cm_upload_failed', 'Upload failed. Check your connection and tap retry.'), false);
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => resolve();
    xhr.send(form);
  });
}

/* items: [{ blob, name, mime, kind, size, duration?, waveform? }] */
function cmQueueItems(items, caption, toId) {
  if (!items.length) return;
  if (String(window.chatState?.with) !== String(toId)) {
    showToast(cmT('cm_chat_changed', 'The chat was changed — nothing was sent'), 'error');
    return;
  }
  const replyId = window.replyToId || null;
  cancelReply();
  caption = String(caption || '').trim().slice(0, 1024);

  const tempIds = [];
  items.forEach((item, i) => {
    const tempId = `temp_${Date.now()}_${++cmSeq}`;
    tempIds.push(tempId);
    const useUrl = item.kind === 'photo' || item.kind === 'video';
    const msg = {
      id: tempId,
      from_id: currentUser?.telegram_id,
      to_id: toId,
      content: i === 0 ? caption : '',
      created_at: new Date().toISOString(),
      is_sending: true,
      is_deleted: false,
      parent_id: i === 0 ? replyId : null,
      replies: [],
      file_type: item.kind,
      file_id: '',
      file_name: item.kind === 'voice' || item.kind === 'photo' ? null : item.name,
      file_size: item.size,
      mime_type: (item.mime || '').split(';')[0],
      duration: item.duration || null,
      waveform: item.waveform || null,
      _local: { url: useUrl ? URL.createObjectURL(item.blob) : '', status: 'uploading', owns: useUrl },
    };
    cmPending.set(tempId, {
      blob: item.blob, item, toId, caption: msg.content, parentId: msg.parent_id, status: 'queued', xhr: null,
    });
    addMessageToChat(msg);
  });
  tempIds.forEach(cmEnqueue);                    // creation order = send order
}

/* ═══ Attach menu + file pickers ═══════════════════════════════════════════ */
function closeComposerPopups() {
  $('emojiPicker')?.classList.add('hidden');
  $('attachMenu')?.classList.add('hidden');
  document.querySelectorAll('.cm-notice').forEach(n => n.remove());
}

function toggleAttachMenu() {
  const menu = $('attachMenu');
  if (!menu) return;
  const opening = menu.classList.contains('hidden');
  closeComposerPopups();
  if (opening) menu.classList.remove('hidden');
  haptic('light');
}

function pickAttachment(kind) {
  closeComposerPopups();
  const input = $(kind === 'media' ? 'attachInputMedia' : 'attachInputFile');
  if (!input) return;
  input.value = '';
  input.click();
}

function cmCanSend() {
  return !!(window.chatState?.with && !window.editingMessageId && !$('chatInputRow')?.classList.contains('hidden'));
}

function cmKindOf(item) {
  const type = item.file.type || '';
  if (item.asFile) return 'document';
  if (type.startsWith('image/')) return 'photo';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'document';
}

function cmOpenSheet(fileList, { asFile = false } = {}) {
  if (!cmCanSend()) return;
  cmCloseSheet();
  const items = [];
  let skipped = 0;
  for (const file of Array.from(fileList || []).slice(0, CM_MAX_FILES)) {
    if (!file.size) continue;
    if (file.size > CM_MAX_BYTES) { skipped = 'big'; continue; }
    if (CM_BLOCKED_EXT.test(file.name || '')) { skipped = skipped || 'blocked'; continue; }
    items.push({ file, asFile, url: '', duration: 0 });
  }
  if (skipped === 'big') showToast(cmT('cm_too_large', 'File is too large (max 20 MB)'), 'error');
  else if (skipped === 'blocked') showToast(cmT('cm_blocked', 'This type of file cannot be sent'), 'error');
  if (!items.length) return;

  const toId = window.chatState.with;
  const overlay = document.createElement('div');
  overlay.className = 'cm-sheet-overlay';
  overlay.innerHTML = `<div class="cm-sheet" role="dialog" aria-modal="true">
    <div class="cm-sheet-head"><div class="cm-sheet-title"></div>
      <button type="button" class="cm-sheet-x" data-cm="close" aria-label="${cmT('btn_close', 'Close')}">${CM_ICON.close}</button></div>
    <div class="cm-sheet-body"><div class="cm-sheet-items"></div>
      <label class="cm-toggle-row" hidden><input type="checkbox" data-cm="asfile"/><span>${cmT('cm_send_as_file', 'Send without compression, as a file')}</span></label></div>
    <textarea class="cm-sheet-caption" rows="1" maxlength="1024" placeholder="${cmT('cm_caption', 'Add a caption…')}"></textarea>
    <div class="cm-sheet-foot"><button type="button" class="cm-btn-ghost" data-cm="close">${cmT('btn_cancel', 'Cancel')}</button>
      <button type="button" class="cm-btn-primary" data-cm="send">${cmT('cm_send', 'Send')}</button></div></div>`;
  document.body.appendChild(overlay);
  cmSheet.overlay = overlay;
  cmSheet.items = items;

  const list = overlay.querySelector('.cm-sheet-items');
  const toggle = overlay.querySelector('.cm-toggle-row');
  const caption = overlay.querySelector('.cm-sheet-caption');
  const title = overlay.querySelector('.cm-sheet-title');

  const draw = () => {
    list.textContent = '';
    items.forEach((it, idx) => {
      it.url = it.url || URL.createObjectURL(it.file);
      const kind = cmKindOf(it);
      const row = document.createElement('div');
      if (kind === 'photo' || kind === 'video') {
        row.className = 'cm-prev-media';
        const m = document.createElement(kind === 'photo' ? 'img' : 'video');
        m.src = it.url;
        if (kind === 'video') {
          m.muted = true; m.playsInline = true; m.preload = 'metadata'; m.controls = true;
          m.addEventListener('loadedmetadata', () => { if (isFinite(m.duration)) it.duration = Math.round(m.duration); });
        }
        row.appendChild(m);
      } else {
        row.className = 'cm-prev-file';
        row.innerHTML = `<div class="cm-ico-circle">${CM_ICON.file}</div><div class="cm-prev-meta"><div class="cm-prev-name"></div><div class="cm-prev-size"></div></div>`;
        row.querySelector('.cm-prev-name').textContent = it.file.name || cmT('cm_file', 'File');
        row.querySelector('.cm-prev-size').textContent = cmFmtSize(it.file.size);
        if (kind === 'audio') {
          const a = new Audio(); a.preload = 'metadata'; a.src = it.url;
          a.addEventListener('loadedmetadata', () => { if (isFinite(a.duration)) it.duration = Math.round(a.duration); });
        }
      }
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'cm-prev-remove'; rm.dataset.cm = 'remove'; rm.dataset.idx = String(idx);
      rm.setAttribute('aria-label', cmT('cm_remove', 'Remove'));
      rm.innerHTML = CM_ICON.close;
      row.appendChild(rm);
      list.appendChild(row);
    });
    const hasMedia = items.some(it => /^(image|video)\//.test(it.file.type || ''));
    toggle.hidden = !hasMedia;
    toggle.querySelector('input').checked = items.every(it => it.asFile);
    const n = items.length;
    const photos = items.every(it => cmKindOf(it) === 'photo');
    title.textContent = n > 1 ? cmT('cm_send_n', 'Send {n} files', { n }) : photos ? cmT('cm_send_photo', 'Send photo') : cmT('cm_send_file', 'Send file');
  };
  draw();

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) return cmCloseSheet();
    const act = e.target.closest('[data-cm]');
    if (!act) return;
    if (act.dataset.cm === 'close') cmCloseSheet();
    else if (act.dataset.cm === 'remove') {
      const [gone] = items.splice(Number(act.dataset.idx), 1);
      if (gone?.url) URL.revokeObjectURL(gone.url);
      if (!items.length) cmCloseSheet(); else draw();
    } else if (act.dataset.cm === 'send') doSend();
  });
  overlay.addEventListener('change', (e) => {
    if (e.target.dataset?.cm === 'asfile') { items.forEach(it => { it.asFile = e.target.checked; }); draw(); }
  });
  caption.addEventListener('input', () => { caption.style.height = 'auto'; caption.style.height = Math.min(110, caption.scrollHeight) + 'px'; });
  caption.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
  cmSheet.onKey = (e) => { if (e.key === 'Escape') cmCloseSheet(); };
  document.addEventListener('keydown', cmSheet.onKey);

  function doSend() {
    const text = caption.value;
    const out = items.map(it => ({
      blob: it.file, name: it.file.name || 'file', mime: it.file.type || 'application/octet-stream',
      kind: cmKindOf(it), size: it.file.size, duration: it.duration || 0,
    }));
    cmCloseSheet();
    cmQueueItems(out, text, toId);
  }
}

const cmSheet = { overlay: null, items: [], onKey: null };

function cmCloseSheet() {
  if (!cmSheet.overlay) return;
  cmSheet.items.forEach(it => it.url && URL.revokeObjectURL(it.url));
  cmSheet.overlay.remove();
  document.removeEventListener('keydown', cmSheet.onKey);
  cmSheet.overlay = null; cmSheet.items = []; cmSheet.onKey = null;
}

/* ═══ Voice recorder ═══════════════════════════════════════════════════════ */
const CM_REC_MIMES = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
// Finger gestures while the mic button is held. The first CM_DIR_SLOP px decide
// the direction (left = cancel, up = lock); after that only that direction counts,
// so a thumb that curves a little while sliding can't trigger the other action.
const CM_CANCEL_DX = 90;
const CM_LOCK_DY = 70;
const CM_DIR_SLOP = 12;

function cmNewRec() {
  return {
    state: 'idle',            // idle → starting → recording → preview → stopping → idle
    held: false, locked: false, aborted: false, autoLock: false,
    t0: 0, dir: '', last: null,
    stream: null, mr: null, chunks: [], mime: '', ctx: null, analyser: null,
    startedAt: 0, timer: 0, peaks: [], level: 0, toId: null,
    x0: 0, y0: 0, lastTyping: 0,
    previewBlob: null, previewAudio: null, previewDuration: 0, previewUrl: '',
  };
}
let cmRec = cmNewRec();

function cmPickRecMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  return CM_REC_MIMES.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
}

function cmSwipes(on) {
  try { on ? cmTg()?.enableVerticalSwipes?.() : cmTg()?.disableVerticalSwipes?.(); } catch { }
}

function cmShowNotice() {
  closeComposerPopups();
  const row = $('chatInputRow');
  if (!row) return;
  const el = document.createElement('div');
  el.className = 'cm-notice';
  el.setAttribute('role', 'status');
  el.innerHTML = `<div>${cmT('rec_unavailable', "Voice recording isn't available here. Allow microphone access for Telegram in your phone's settings, or record the message in the bot chat.")}</div>` +
    `<button type="button">${cmT('cm_open_bot', 'Open the bot')} ↗</button>`;
  el.querySelector('button').addEventListener('click', () => {
    const url = `https://t.me/${CM_BOT_USERNAME.replace(/^@/, '')}`;
    const tg = cmTg();
    if (tg?.openTelegramLink) { tg.openTelegramLink(url); setTimeout(() => { try { tg.close(); } catch { } }, 100); }
    else window.open(url, '_blank', 'noopener');
  });
  row.appendChild(el);
  setTimeout(() => el.remove(), 8000);
}

function updateComposerMode() {
  const btn = $('chatSendBtn');
  if (!btn) return;
  let mode;
  if (window.editingMessageId) mode = 'edit';
  else if ((cmRec.state === 'recording' || cmRec.state === 'preview') && cmRec.locked) mode = 'send';
  else if (($('chatInput')?.value || '').trim()) mode = 'send';
  else mode = 'mic';
  btn.dataset.mode = mode;
  btn.setAttribute('aria-label', mode === 'mic' ? cmT('cm_record_voice', 'Record voice message') : mode === 'edit' ? cmT('cm_save_edit', 'Save edit') : cmT('cm_send', 'Send'));
}

function cmTickTime() {
  const ms = Math.max(0, performance.now() - cmRec.startedAt);
  const s = Math.floor(ms / 1000);
  const el = $('recTime');
  if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')},${Math.floor((ms % 1000) / 100)}`;
  if (s >= CM_MAX_REC_SECONDS && cmRec.state === 'recording') {
    showToast(cmT('cm_rec_limit', 'Maximum length reached'));
    cmFinishRecording(true);
  }
}

function cmSampleLevel() {
  // Tell the other person "recording voice message…" every 2.5 s (also when
  // there is no level meter, e.g. on iOS).
  if (Date.now() - cmRec.lastTyping > 2500) {
    cmRec.lastTyping = Date.now();
    if (socket?.connected && cmRec.toId) socket.emit('typing', { to_id: cmRec.toId, action: 'voice' });
  }
  const a = cmRec.analyser;
  if (!a) return;
  const buf = new Uint8Array(a.fftSize);
  a.getByteTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
  cmRec.peaks.push(peak);
  cmRec.level = cmRec.level * 0.6 + Math.min(1, peak * 2.2) * 0.4;
  $('chatSendBtn')?.style.setProperty('--rec-level', cmRec.level.toFixed(3));
  if (cmRec.locked) cmDrawRecWave();
}

function cmDrawRecWave(progressPct) {
  const c = $('recWave');
  if (!c || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  const gold = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim() || '#C9A84C';
  const bw = 3 * dpr, gap = 2 * dpr;
  const n = Math.floor(w / (bw + gap));
  const recent = cmRec.peaks.slice(-n);
  const playedCount = progressPct != null ? Math.round(progressPct * recent.length) : -1;
  recent.forEach((p, i) => {
    const bh = Math.max(2 * dpr, Math.min(h, p * 2.4 * h));
    const x = w - (recent.length - i) * (bw + gap);
    g.fillStyle = (playedCount >= 0 && i >= playedCount) ? 'rgba(201, 168, 76, 0.35)' : gold;
    g.fillRect(x, (h - bh) / 2, bw, bh);
  });
}

function cmSetStopButtonIcon(mode) {
  const btn = $('recStop');
  if (!btn) return;
  btn.querySelector('.cm-rec-stop-icon')?.classList.toggle('hidden', mode !== 'stop');
  btn.querySelector('.cm-rec-play-icon')?.classList.toggle('hidden', mode !== 'play');
  btn.querySelector('.cm-rec-pause-icon')?.classList.toggle('hidden', mode !== 'pause');
  btn.setAttribute('aria-label', mode === 'stop' ? 'Stop recording' : mode === 'pause' ? 'Pause' : 'Play preview');
}

function cmRecUi(on) {
  const wrap = $('chatComposer');
  const btn = $('chatSendBtn');
  wrap?.classList.toggle('is-recording', on);
  $('recordBar')?.classList.toggle('hidden', !on);
  btn?.classList.toggle('is-recording', on);
  if (on) {
    $('recTrash')?.classList.add('hidden');
    $('recStop')?.classList.add('hidden');
    $('recWave')?.classList.add('hidden');
    cmSetStopButtonIcon('stop');
    const hint = $('recHint');
    if (hint) { hint.classList.remove('hidden'); hint.style.transform = ''; hint.style.opacity = ''; }
    $('recLock')?.classList.remove('hidden', 'is-near');
    $('recLock')?.style.setProperty('--lock-p', '0');
    const tm = $('recTime'); if (tm) tm.textContent = '0:00,0';
  } else {
    $('recLock')?.classList.add('hidden');
    $('recStop')?.classList.add('hidden');
    btn?.style.removeProperty('--rec-level');
  }
  cmSwipes(!on);
  syncChatInputHeight();
}

let cmCachedStream = null;

async function cmAcquireAudioStream() {
  clearTimeout(cmMicIdleTimer);
  const tracks = cmCachedStream?.getAudioTracks?.() || cmCachedStream?.getTracks?.() || [];
  const liveTrack = tracks.find(tr => tr.readyState === 'live' || tr.readyState === undefined);
  if (liveTrack && cmCachedStream) {
    liveTrack.enabled = true;
    return cmCachedStream;
  }
  // Mono voice capture. echoCancellation is OFF on purpose: nothing plays while
  // we record, and on Android it switches the mic to the "voice call" source,
  // which is narrow-band and quiet. AGC + noise suppression stay on so quiet
  // speakers are still audible.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    }
  });
  cmCachedStream = stream;
  return stream;
}

// The microphone stays open for CM_MIC_IDLE_MS after a recording so that
// recording again right away does not make Telegram / Android ask for the
// permission again (and does not delay the start). After that the tracks are
// really stopped, which clears Android's green "mic in use" dot and returns the
// phone to normal playback volume. forceStop = stop right now (leaving the app,
// or about to play a voice message).
const CM_MIC_IDLE_MS = 30 * 1000;
let cmMicIdleTimer = 0;
function cmReleaseAudioStream(forceStop = false) {
  clearTimeout(cmMicIdleTimer);
  if (!cmCachedStream) return;
  if (forceStop) {
    try { cmCachedStream.getTracks?.().forEach(tr => tr.stop()); } catch { }
    cmCachedStream = null;
    return;
  }
  try { (cmCachedStream.getAudioTracks?.() || cmCachedStream.getTracks?.() || []).forEach(tr => { tr.enabled = false; }); } catch { }
  cmMicIdleTimer = setTimeout(() => cmReleaseAudioStream(true), CM_MIC_IDLE_MS);
}

function cmTeardownRec(forceStop = false) {
  clearInterval(cmRec.timer);
  cmReleaseAudioStream(forceStop);
  try { cmRec.ctx?.close(); } catch { }
  if (cmRec.previewAudio) {
    try { cmRec.previewAudio.pause(); } catch { }
  }
  if (cmRec.previewUrl) {
    try { URL.revokeObjectURL(cmRec.previewUrl); } catch { }
  }
  cmRec = cmNewRec();
  cmRecUi(false);
  updateComposerMode();
}

async function cmStartRecording(e) {
  if (cmRec.state !== 'idle') return;
  if (!cmCanSend()) return;
  closeComposerPopups();
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { cmShowNotice(); return; }

  cmRec = cmNewRec();
  cmRec.state = 'starting';
  cmRec.held = true;
  cmRec.t0 = performance.now();
  cmRec.toId = window.chatState.with;
  cmRec.x0 = e.clientX; cmRec.y0 = e.clientY;
  cmSwipes(false);
  const btn = $('chatSendBtn');
  try { btn.setPointerCapture(e.pointerId); } catch { }

  let stream;
  try {
    stream = await cmAcquireAudioStream();
  } catch {
    cmRec = cmNewRec();
    cmSwipes(true);
    cmShowNotice();
    return;
  }

  if (cmRec.aborted || cmRec.state !== 'starting') {          // cancelled while the microphone was starting
    cmReleaseAudioStream(false);
    cmRec = cmNewRec();
    cmSwipes(true);
    updateComposerMode();
    return;
  }
  // Finger already lifted while the microphone was opening. Like Telegram, a tap
  // never starts a recording: show the hint and drop it. (Only a touch that the
  // system took over, e.g. the permission sheet, sets autoLock via pointercancel.)
  if (!cmRec.held && !cmRec.autoLock) {
    const permissionSheet = !!cmRec.touchTaken;
    cmReleaseAudioStream(false);
    cmRec = cmNewRec();
    cmSwipes(true);
    updateComposerMode();
    showToast(permissionSheet
      ? cmT('rec_mic_ready', 'Microphone allowed. Now hold the mic button to record.')
      : cmT('rec_hold_hint', 'Hold the mic button to record, release to send.'));
    return;
  }

  try {
    const mime = cmPickRecMime();
    const mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 64000 });
    cmRec.stream = stream;
    cmRec.mr = mr;
    cmRec.mime = mr.mimeType || mime || 'audio/webm';
    mr.ondataavailable = (ev) => { if (ev.data?.size) cmRec.chunks.push(ev.data); };
    mr.onerror = () => { cmCancelRecording(); showToast(cmT('rec_unavailable', 'Recording failed'), 'error'); };
    try {
      // iOS WebKit can mute or garble a MediaRecorder when an AudioContext taps
      // the same microphone stream, so the live level meter is skipped there
      // (the waveform then falls back to the generated one).
      const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const AC = window.AudioContext || window.webkitAudioContext;
      if (isIOS || !AC) throw new Error('no level meter');
      cmRec.ctx = new AC();
      if (cmRec.ctx.state === 'suspended') cmRec.ctx.resume?.().catch?.(() => { });
      const src = cmRec.ctx.createMediaStreamSource(stream);
      cmRec.analyser = cmRec.ctx.createAnalyser();
      cmRec.analyser.fftSize = 256;
      src.connect(cmRec.analyser);
    } catch { cmRec.analyser = null; }                       // level meter is cosmetic

    mr.start(500);
    cmRec.state = 'recording';
    cmRec.startedAt = performance.now();
    cmRec.timer = setInterval(() => { cmTickTime(); cmSampleLevel(); }, 80);
    cmRecUi(true);
    updateComposerMode();
    haptic('medium');
    document.addEventListener('visibilitychange', cmOnHidden);
    if (cmRec.autoLock) cmLockRecording();
    else if (cmRec.last) cmMoveHold(cmRec.last);              // the finger may have slid while the mic was starting
  } catch {
    cmReleaseAudioStream();
    cmRec = cmNewRec();
    cmSwipes(true);
    cmShowNotice();
  }
}

function cmOnHidden() {
  if (document.hidden && cmRec.state === 'recording' && !cmRec.locked) cmCancelRecording();
}
window.addEventListener('pagehide', () => cmReleaseAudioStream());

function cmLockRecording() {
  if (cmRec.state !== 'recording' || cmRec.locked) return;
  cmRec.locked = true;
  $('recHint')?.classList.add('hidden');
  $('recLock')?.classList.add('hidden');
  $('recTrash')?.classList.remove('hidden');
  $('recStop')?.classList.remove('hidden');
  cmSetStopButtonIcon('stop');
  $('recWave')?.classList.remove('hidden');
  $('chatSendBtn')?.style.removeProperty('--rec-level');
  updateComposerMode();
  haptic('heavy');
}

function cmStopToPreview() {
  if (cmRec.state !== 'recording' || !cmRec.locked) return;
  const seconds = (performance.now() - cmRec.startedAt) / 1000;
  if (seconds < CM_MIN_REC_SECONDS) {
    showToast(cmT('rec_hold_hint', 'Recording too short'));
    return;
  }
  clearInterval(cmRec.timer);
  cmRec.state = 'preview';
  const mr = cmRec.mr;
  const finishPreview = () => {
    cmReleaseAudioStream(false);       // only after the recorder has flushed its tail
    const blob = new Blob(cmRec.chunks, { type: cmRec.mime });
    cmRec.previewBlob = blob;
    cmRec.previewDuration = Math.max(1, Math.round(seconds));
    cmRec.previewUrl = URL.createObjectURL(blob);
    const audio = new Audio(cmRec.previewUrl);
    cmRec.previewAudio = audio;
    audio.addEventListener('timeupdate', () => {
      const cur = audio.currentTime;
      const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : cmRec.previewDuration;
      const pct = dur ? Math.min(1, cur / dur) : 0;
      $('recTime').textContent = cmFmtDur(cur);
      cmDrawRecWave(pct);
    });
    audio.addEventListener('ended', () => {
      cmSetStopButtonIcon('play');
      $('recTime').textContent = cmFmtDur(cmRec.previewDuration);
      cmDrawRecWave(0);
    });
    cmSetStopButtonIcon('play');
    $('recTime').textContent = cmFmtDur(cmRec.previewDuration);
    cmDrawRecWave(0);
  };
  mr.onstop = finishPreview;
  try { if (mr.state !== 'inactive') mr.stop(); else finishPreview(); } catch { finishPreview(); }
  haptic('medium');
}

function cmTogglePreviewPlay() {
  if (!cmRec.previewAudio) return;
  const a = cmRec.previewAudio;
  if (a.paused) {
    a.play().then(() => {
      cmSetStopButtonIcon('pause');
      haptic('light');
    }).catch(() => { });
  } else {
    a.pause();
    cmSetStopButtonIcon('play');
    haptic('light');
  }
}

function cmMoveHold(e) {
  if (cmRec.state === 'starting' || cmRec.state === 'recording') cmRec.last = { clientX: e.clientX, clientY: e.clientY };
  if (cmRec.state !== 'recording' || cmRec.locked || !cmRec.held) return;
  const dx = e.clientX - cmRec.x0;
  const dy = e.clientY - cmRec.y0;
  const left = Math.max(0, -dx);
  const up = Math.max(0, -dy);
  const hint = $('recHint');
  const lock = $('recLock');
  const showLock = (p) => { if (lock) { lock.style.setProperty('--lock-p', p.toFixed(2)); lock.classList.toggle('is-near', p > 0.6); } };
  const showHint = (px, opacity) => { if (hint) { hint.style.transform = px ? `translateX(${-px}px)` : ''; hint.style.opacity = opacity; } };

  if (!cmRec.dir) {
    if (Math.max(left, up) < CM_DIR_SLOP) { showHint(0, ''); showLock(0); return; }
    cmRec.dir = up >= left * 0.75 ? 'y' : 'x';
  } else if (Math.max(left, up) < CM_DIR_SLOP / 2) {
    cmRec.dir = '';
    showHint(0, ''); showLock(0);
    return;
  }

  if (cmRec.dir === 'x') {
    showLock(0);
    showHint(Math.min(left, CM_CANCEL_DX) * 0.6, String(Math.max(0, 1 - left / CM_CANCEL_DX)));
    if (left >= CM_CANCEL_DX) { cmCancelRecording(); }
  } else {
    showHint(0, '');
    const p = Math.min(1, up / CM_LOCK_DY);
    showLock(p);
    if (p >= 1) cmLockRecording();
  }
}

function cmEndHold() {
  cmRec.held = false;
  if (cmRec.state !== 'recording' || cmRec.locked) return;
  const ms = performance.now() - cmRec.startedAt;
  if (ms < 700) {
    cmCancelRecording(true);
    showToast(cmT('rec_hold_hint', 'Hold the mic button to record, release to send.'));
  } else {
    cmFinishRecording(true);
  }
}

function cmFinishRecording(send) {
  if (cmRec.state !== 'recording' && cmRec.state !== 'preview') return;
  document.removeEventListener('visibilitychange', cmOnHidden);
  const { toId } = cmRec;
  const peaks = cmRec.peaks.slice();
  const mime = cmRec.mime;

  if (cmRec.state === 'preview') {
    const blob = cmRec.previewBlob;
    const dur = cmRec.previewDuration;
    cmTeardownRec();
    if (send && blob && dur >= CM_MIN_REC_SECONDS) {
      const base = mime.split(';')[0];
      const ext = base.includes('ogg') ? 'ogg' : base.includes('mp4') ? 'm4a' : 'webm';
      cmQueueItems([{
        blob, name: `voice.${ext}`, mime: base, kind: 'voice', size: blob.size,
        duration: dur, waveform: cmEncodeWave(peaks),
      }], '', toId);
    }
    return;
  }

  cmRec.state = 'stopping';
  const seconds = (performance.now() - cmRec.startedAt) / 1000;
  const { mr } = cmRec;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const blob = new Blob(cmRec.chunks, { type: mime });
    cmTeardownRec();
    if (send && seconds >= CM_MIN_REC_SECONDS && blob.size > 0) {
      const base = mime.split(';')[0];
      const ext = base.includes('ogg') ? 'ogg' : base.includes('mp4') ? 'm4a' : 'webm';
      cmQueueItems([{
        blob, name: `voice.${ext}`, mime: base, kind: 'voice', size: blob.size,
        duration: Math.max(1, Math.round(seconds)), waveform: cmEncodeWave(peaks),
      }], '', toId);
    }
  };
  mr.onstop = finish;
  clearInterval(cmRec.timer);
  cmRecUi(false);
  try { mr.state !== 'inactive' ? mr.stop() : finish(); } catch { finish(); }
  setTimeout(finish, 1500);
}

function cmCancelRecording(quiet) {
  if (cmRec.state === 'idle') return;
  document.removeEventListener('visibilitychange', cmOnHidden);
  if (cmRec.state === 'starting') { cmRec.aborted = true; return; }
  cmRec.state = 'stopping';
  const { mr } = cmRec;
  if (mr) {
    mr.ondataavailable = null;
    mr.onstop = cmTeardownRec;
    try { if (mr.state !== 'inactive') mr.stop(); } catch { }
  }
  clearInterval(cmRec.timer);
  cmTeardownRec();
  if (!quiet) haptic('warning');
}

// Exposed names used by app.js and the markup.
function cancelRecording() { cmCancelRecording(); }
window.cancelRecording = cancelRecording;

/* ═══ Wiring ═══════════════════════════════════════════════════════════════ */
function cmInitComposer() {
  const btn = $('chatSendBtn');
  if (!btn || btn.dataset.cmBound) return;
  btn.dataset.cmBound = '1';

  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  let down = null;
  const onMove = (e) => { if (down?.id === e.pointerId && down.mode === 'mic') cmMoveHold(e); };
  const onUp = (e) => {
    if (!down || down.id !== e.pointerId) return;
    const d = down; down = null;
    if (d.mode === 'mic') return cmEndHold();
    const r = btn.getBoundingClientRect();
    const inside = e.clientX >= r.left - 8 && e.clientX <= r.right + 8 && e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8;
    if (!inside) return;
    if ((cmRec.state === 'recording' || cmRec.state === 'preview') && cmRec.locked) cmFinishRecording(true);
    else sendMessage();
  };
  const onCancel = (e) => {
    if (!down || down.id !== e.pointerId) return;
    const d = down; down = null;
    if (d.mode !== 'mic') return;
    cmRec.held = false;
    // The touch was taken while the microphone was still opening (Telegram's / Android's
    // permission sheet). Like Telegram: grant the permission, record nothing, and let the
    // person press again. Only a touch lost mid-recording locks it so nothing is lost.
    if (cmRec.state === 'starting') cmRec.touchTaken = true;
    else if (cmRec.state === 'recording') cmLockRecording();
  };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    updateComposerMode();
    down = { mode: btn.dataset.mode, id: e.pointerId };
    if (down.mode === 'mic') cmStartRecording(e);
    else { try { btn.setPointerCapture(e.pointerId); } catch { } }
  });
  btn.addEventListener('pointermove', onMove);
  btn.addEventListener('pointerup', onUp);
  btn.addEventListener('pointercancel', onCancel);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);

  btn.addEventListener('click', (e) => {
    if (e.detail !== 0) return;
    updateComposerMode();
    if (btn.dataset.mode === 'mic') showToast(cmT('rec_hold_hint', 'Hold the mic button to record, release to send.'));
    else if ((cmRec.state === 'recording' || cmRec.state === 'preview') && cmRec.locked) cmFinishRecording(true);
    else sendMessage();
  });

  $('recTrash')?.addEventListener('click', () => cmCancelRecording());
  $('recStop')?.addEventListener('click', () => {
    if (cmRec.state === 'recording' && cmRec.locked) cmStopToPreview();
    else if (cmRec.state === 'preview') cmTogglePreviewPlay();
  });

  $('attachInputMedia')?.addEventListener('change', (e) => cmOpenSheet(e.target.files));
  $('attachInputFile')?.addEventListener('change', (e) => cmOpenSheet(e.target.files, { asFile: true }));

  // Paste an image (desktop) or drop files onto the chat.
  $('chatInput')?.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length) { e.preventDefault(); cmOpenSheet(files); }
  });
  const page = $('page-chat');
  if (page) {
    page.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
    page.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      cmOpenSheet(e.dataTransfer.files);
    });
  }

  $('chatInput')?.addEventListener('focus', closeComposerPopups);
  updateComposerMode();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', cmInitComposer);
else cmInitComposer();
