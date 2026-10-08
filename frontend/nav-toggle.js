/* nav-toggle.js — collapsible bottom navigation.
 *
 * The nav is hidden until the user taps the handle at the bottom edge. It
 * closes again when a tab is chosen, when the dim layer is tapped, on Escape,
 * on a downward swipe, when a text field gets focus (so it never fights the
 * keyboard), and after a few seconds of no interaction.
 *
 * Nothing in app.js needs to change: navigate() still runs through the tabs'
 * existing inline onclick handlers.
 */
(function () {
  'use strict';

  var AUTO_CLOSE_MS = 8000;
  var nav = document.querySelector('.bottom-nav');
  if (!nav || document.getElementById('navToggle')) return;

  var body = document.body;
  var autoCloseTimer = 0;

  /* ── Build the handle and the dim layer ─────────────────────────────── */
  var toggle = document.createElement('button');
  toggle.id = 'navToggle';
  toggle.type = 'button';
  toggle.className = 'nav-toggle';
  toggle.setAttribute('aria-label', 'Open navigation menu');
  toggle.setAttribute('aria-controls', 'bottomNav');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 15 12 9 18 15"></polyline></svg>' +
    '<span class="nav-toggle-dot" aria-hidden="true"></span>';

  var scrim = document.createElement('div');
  scrim.className = 'nav-scrim';
  scrim.setAttribute('aria-hidden', 'true');

  nav.id = nav.id || 'bottomNav';
  nav.setAttribute('role', 'navigation');
  nav.parentNode.insertBefore(scrim, nav);
  nav.parentNode.insertBefore(toggle, nav);

  /* ── Open / close ───────────────────────────────────────────────────── */
  function isOpen() { return body.classList.contains('nav-open'); }

  function setOpen(open) {
    if (open === isOpen()) return;
    body.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    nav.setAttribute('aria-hidden', open ? 'false' : 'true');
    clearTimeout(autoCloseTimer);
    if (open) {
      // dismiss the keyboard so the panel is not hidden behind it
      var ae = document.activeElement;
      if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) ae.blur();
      autoCloseTimer = setTimeout(function () { setOpen(false); }, AUTO_CLOSE_MS);
      try { window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback && Telegram.WebApp.HapticFeedback.impactOccurred('light'); } catch (e) { }
    }
  }

  function bumpAutoClose() {
    if (!isOpen()) return;
    clearTimeout(autoCloseTimer);
    autoCloseTimer = setTimeout(function () { setOpen(false); }, AUTO_CLOSE_MS);
  }

  nav.setAttribute('aria-hidden', 'true');

  toggle.addEventListener('click', function () { setOpen(!isOpen()); });
  scrim.addEventListener('click', function () { setOpen(false); });

  // choosing a tab closes the panel (the tab's own onclick still navigates)
  nav.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.nav-item')) {
      setTimeout(function () { setOpen(false); }, 120);
    } else {
      bumpAutoClose();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) setOpen(false);
  });

  // typing in any field closes the nav so it never competes with the keyboard
  document.addEventListener('focusin', function (e) {
    var t = e.target;
    if (isOpen() && t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) setOpen(false);
  });

  // swipe down on the open panel to dismiss it
  var startY = null;
  nav.addEventListener('touchstart', function (e) {
    startY = e.touches[0].clientY;
    bumpAutoClose();
  }, { passive: true });
  nav.addEventListener('touchmove', function (e) {
    if (startY === null) return;
    if (e.touches[0].clientY - startY > 28) { startY = null; setOpen(false); }
  }, { passive: true });
  nav.addEventListener('touchend', function () { startY = null; }, { passive: true });

  // swipe up on the handle to open it
  var hStartY = null;
  toggle.addEventListener('touchstart', function (e) { hStartY = e.touches[0].clientY; }, { passive: true });
  toggle.addEventListener('touchmove', function (e) {
    if (hStartY === null) return;
    if (hStartY - e.touches[0].clientY > 14) { hStartY = null; setOpen(true); }
  }, { passive: true });
  toggle.addEventListener('touchend', function () { hStartY = null; }, { passive: true });

  /* ── Unread dot: the tab badges are invisible while the nav is hidden, so
        mirror "any badge is showing" onto the handle. ───────────────────── */
  function syncBadgeDot() {
    var any = false;
    nav.querySelectorAll('.nav-badge').forEach(function (b) {
      var item = b.closest('.nav-item');
      if (item && getComputedStyle(item).display === 'none') return;
      if (getComputedStyle(b).display === 'none') return;
      var n = parseInt((b.textContent || '').trim(), 10);
      if (n > 0 || (isNaN(n) && (b.textContent || '').trim() !== '' && (b.textContent || '').trim() !== '0')) any = true;
    });
    toggle.classList.toggle('has-badge', any);
  }

  syncBadgeDot();
  if (window.MutationObserver) {
    new MutationObserver(syncBadgeDot).observe(nav, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    });
  }

  // expose for other scripts (e.g. a future "open nav" shortcut)
  window.holyNav = { open: function () { setOpen(true); }, close: function () { setOpen(false); }, toggle: function () { setOpen(!isOpen()); } };
})();
