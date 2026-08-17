// App build version display - v1.7.13
(function () {
  'use strict';
  const APP_DISPLAY_VERSION = '1.7.13';

  function applyVersion() {
    const el = document.getElementById('versionText');
    if (!el) return;
    const wanted = 'v' + APP_DISPLAY_VERSION;
    if (el.textContent !== wanted) el.textContent = wanted;
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyVersion();
    const el = document.getElementById('versionText');
    if (el) {
      new MutationObserver(applyVersion).observe(el, { childList: true, characterData: true, subtree: true });
    }
  });

  setTimeout(applyVersion, 0);
  setTimeout(applyVersion, 500);
  setTimeout(applyVersion, 1500);

  window.APP_DISPLAY_VERSION = APP_DISPLAY_VERSION;
})();
