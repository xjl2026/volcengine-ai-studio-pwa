// Emergency iOS/PWA touch unlock - v1.7.16
(function () {
  'use strict';

  function isInvisibleBlockingOverlay(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    if (cs.pointerEvents === 'none') return false;

    const r = el.getBoundingClientRect();
    const covers = r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9;
    if (!covers) return false;

    const opacity = parseFloat(cs.opacity || '1');
    const bg = cs.backgroundColor || '';
    const invisible = opacity <= 0.02 || cs.visibility === 'hidden' || bg === 'rgba(0, 0, 0, 0)';

    // Never remove known visible/intentional UI containers.
    if (el.id === 'app' || el.id === 'historyPreviewModal' || el.id === 'playlistPlayer') return false;
    if (el.classList?.contains('modal') || el.classList?.contains('dialog')) return false;

    return invisible;
  }

  function unlock() {
    try {
      document.documentElement.style.pointerEvents = '';
      document.body.style.pointerEvents = '';
      document.documentElement.removeAttribute('inert');
      document.body.removeAttribute('inert');
      document.querySelectorAll('[inert]').forEach(el => el.removeAttribute('inert'));

      // Re-enable app shell/navigation if a previous update flow left them disabled.
      const app = document.getElementById('app');
      if (app) {
        app.style.pointerEvents = '';
        app.removeAttribute('inert');
      }
      document.querySelectorAll('.bottom-nav, .nav-item, .page, button, select, input, textarea, a').forEach(el => {
        if (el.dataset?.keepDisabled === '1') return;
        el.style.pointerEvents = '';
      });

      // Remove only invisible full-screen blockers.
      [...document.body.children].forEach(el => {
        try {
          if (isInvisibleBlockingOverlay(el)) el.remove();
        } catch (_) {}
      });

      // Clean update-flow classes/attributes if present.
      document.body.classList.remove('updating', 'is-updating', 'loading-lock', 'modal-open');
      document.documentElement.classList.remove('updating', 'is-updating', 'loading-lock');
      document.body.style.touchAction = '';
      document.documentElement.style.touchAction = '';
    } catch (_) {}
  }

  document.addEventListener('DOMContentLoaded', unlock, { once: true });
  window.addEventListener('pageshow', unlock);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) unlock(); });
  setTimeout(unlock, 0);
  setTimeout(unlock, 100);
  setTimeout(unlock, 500);
  setTimeout(unlock, 1500);

  window.emergencyUnlockPwaTouch = unlock;
  console.log('[emergency-touch-unlock] loaded v1.7.16');
})();
