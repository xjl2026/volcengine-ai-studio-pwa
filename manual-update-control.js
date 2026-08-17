// 设置页手动同步最新版 - v1.7.16
(function () {
  'use strict';

  const VERSION = '1.7.16';
  let updating = false;

  function toast(message, type) {
    try {
      if (typeof showToast === 'function') return showToast(message, type || 'info', 4000);
    } catch (_) {}
    try { alert(message); } catch (_) {}
  }

  async function forceSyncLatest() {
    if (updating) return;
    updating = true;

    const btn = document.getElementById('btnForceSyncLatest');
    const detail = document.getElementById('forceSyncLatestStatus');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '正在检查最新版…';
    }
    if (detail) detail.textContent = '正在检查网络与新版本…';

    try {
      // 先确认网络可访问最新版，不再先注销 SW，避免 iOS standalone 进入不可交互状态。
      const probe = new URL('./index.html', window.location.href);
      probe.searchParams.set('__force_update_probe', Date.now().toString());
      const response = await fetch(probe.href, { cache: 'no-store' });
      if (!response.ok) throw new Error('当前无法从网络获取最新版');

      // 主动检查 Service Worker 更新；有 waiting 版本则先激活。
      if ('serviceWorker' in navigator) {
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) {
            await reg.update().catch(() => {});
            if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        } catch (_) {}
      }

      // 只清本应用 Cache Storage，不清 localStorage / sessionStorage / IndexedDB。
      if ('caches' in window) {
        try {
          const keys = await caches.keys();
          await Promise.all(keys.filter(k => k.startsWith('volc-ai-')).map(k => caches.delete(k).catch(() => false)));
        } catch (_) {}
      }

      if (detail) detail.textContent = '已找到最新版，正在重新加载…';

      // 带唯一参数从网络重新进入；不注销当前 controller，降低 iOS standalone 锁死概率。
      const target = new URL('./', window.location.href);
      target.searchParams.delete('__pwa_build');
      target.searchParams.delete('__force_update');
      target.searchParams.set('__manual_sync', Date.now().toString());

      setTimeout(() => {
        try { window.location.href = target.href; }
        catch (_) { window.location.reload(); }
      }, 150);
    } catch (e) {
      updating = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = '检查并同步最新版';
      }
      if (detail) detail.textContent = '同步失败：' + (e?.message || '未知错误');
      toast('同步失败：' + (e?.message || '未知错误'), 'error');
    }
  }

  function ensureButton() {
    const anchor = document.getElementById('appVersionInfo');
    if (!anchor || document.getElementById('forceSyncLatestBox')) return;

    const box = document.createElement('div');
    box.id = 'forceSyncLatestBox';
    box.style.cssText = 'margin-top:12px;padding:14px 14px 12px;background:var(--bg-tertiary);border-radius:10px;border:1px solid rgba(108,92,231,.28);';

    const btn = document.createElement('button');
    btn.id = 'btnForceSyncLatest';
    btn.type = 'button';
    btn.textContent = '检查并同步最新版';
    btn.style.cssText = 'width:100%;padding:12px 14px;border:none;border-radius:10px;background:#6c5ce7;color:#fff;font-size:14px;font-weight:700;cursor:pointer;';
    btn.onclick = forceSyncLatest;

    const status = document.createElement('div');
    status.id = 'forceSyncLatestStatus';
    status.textContent = '主动检查并同步新版；不会删除历史记录和任务 ID。';
    status.style.cssText = 'margin-top:8px;color:var(--text-muted);font-size:11px;line-height:1.55;text-align:center;';

    box.append(btn, status);
    anchor.insertAdjacentElement('afterend', box);
  }

  document.addEventListener('DOMContentLoaded', () => setTimeout(ensureButton, 50));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(ensureButton, 50); });
  window.addEventListener('pageshow', () => { updating = false; setTimeout(ensureButton, 50); });
  setTimeout(ensureButton, 100);
  setTimeout(ensureButton, 500);

  window.forceSyncLatestPwa = forceSyncLatest;
  console.log('[manual-update-control] loaded v' + VERSION);
})();
