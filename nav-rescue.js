// Independent bottom navigation rescue - v1.7.18
// 目的：底栏切页不再依赖 app.js 的异步初始化、选择模式或其他热修复。
(function () {
  'use strict';

  const VERSION = '1.7.18';
  let lastHandledAt = 0;

  function ensureNavOnTop() {
    const nav = document.querySelector('.bottom-nav');
    if (nav) {
      nav.style.setProperty('z-index', '2147483000', 'important');
      nav.style.setProperty('pointer-events', 'auto', 'important');
      nav.style.setProperty('touch-action', 'manipulation', 'important');
    }
    document.querySelectorAll('.nav-item').forEach(item => {
      item.style.setProperty('pointer-events', 'auto', 'important');
      item.style.setProperty('touch-action', 'manipulation', 'important');
      item.removeAttribute('inert');
    });
  }

  function hardSwitch(name) {
    if (!name) return;

    const page = document.getElementById('page-' + name);
    const navItem = document.querySelector('.nav-item[data-page="' + name + '"]');
    if (!page || !navItem) return;

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    page.classList.add('active');
    navItem.classList.add('active');

    // 只做必要的附加动作。失败也不能阻止切页。
    if (name === 'history') {
      try {
        if (typeof window.renderHistory === 'function') {
          window._historyRendered = false;
          Promise.resolve(window.renderHistory()).then(() => {
            window._historyRendered = true;
          }).catch(() => {});
        }
      } catch (_) {}
    }

    try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch (_) { try { window.scrollTo(0, 0); } catch (_) {} }
    try { sessionStorage.setItem('volc_last_page', name); } catch (_) {}
  }

  function getNavItemFromEvent(e) {
    const target = e && e.target;
    return target && target.closest ? target.closest('.nav-item[data-page]') : null;
  }

  function handleNavEvent(e) {
    const item = getNavItemFromEvent(e);
    if (!item) return;

    const now = Date.now();
    // touchend 后通常还会补一个 click，避免重复处理。
    if (now - lastHandledAt < 250) {
      if (e.type === 'click') {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    lastHandledAt = now;

    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    hardSwitch(item.dataset.page);
  }

  function boot() {
    ensureNavOnTop();

    // 捕获阶段优先于旧 onclick / 其他热修复。
    document.addEventListener('touchend', handleNavEvent, { capture: true, passive: false });
    document.addEventListener('click', handleNavEvent, true);

    // 每个 item 再绑一层直接 touch，防 iOS standalone 某些情况下 document click 不触发。
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      item.addEventListener('touchstart', () => ensureNavOnTop(), { passive: true });
    });

    // 如果页面当前已有 active 页则保持；否则恢复最后一页/图片页。
    if (!document.querySelector('.page.active')) {
      let name = 'image';
      try { name = sessionStorage.getItem('volc_last_page') || 'image'; } catch (_) {}
      hardSwitch(name);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.hardSwitchPwaPage = hardSwitch;
  window.addEventListener('pageshow', ensureNavOnTop);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureNavOnTop(); });
  setInterval(ensureNavOnTop, 2000);

  console.log('[nav-rescue] loaded v' + VERSION);
})();
