// 设置页手动强制同步最新版 - v1.7.15
(function () {
  'use strict';

  const VERSION = '1.7.15';
  let updating = false;

  function toast(message, type) {
    try {
      if (typeof showToast === 'function') return showToast(message, type || 'info', 4000);
    } catch (_) {}
    alert(message);
  }

  async function forceSyncLatest() {
    if (updating) return;

    const ok = confirm(
      '检查并同步最新版？\n\n' +
      '会注销旧 Service Worker、清理本应用网页缓存并重新加载最新版。\n\n' +
      '不会清除历史记录、提示词、任务 ID、API Key 或其他本地设置；已经提交到火山服务端的视频任务也不会被取消。'
    );
    if (!ok) return;

    updating = true;
    const btn = document.getElementById('btnForceSyncLatest');
    const detail = document.getElementById('forceSyncLatestStatus');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '正在同步最新版…';
    }
    if (detail) detail.textContent = '正在注销旧版本并清理网页缓存…';

    try {
      // 先要求现有 registration 主动检查一次；即便检查失败，后面仍会强制注销并重载。
      if ('serviceWorker' in navigator) {
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) await reg.update();
          if (reg?.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        } catch (_) {}

        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(reg => reg.unregister().catch(() => false)));
      }

      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter(key => key.startsWith('volc-ai-')).map(key => caches.delete(key).catch(() => false))
        );
      }

      if (detail) detail.textContent = '旧缓存已清理，正在从网络加载最新版…';

      // 用唯一查询参数绕开 iOS standalone/BFCache；不清 localStorage / IndexedDB。
      const target = new URL('./', window.location.href);
      target.searchParams.delete('__pwa_build');
      target.searchParams.set('__force_update', Date.now().toString());

      // 先做一次 no-store 网络探测，避免离线时把用户直接送进失败页。
      try {
        const probe = new URL('./index.html', window.location.href);
        probe.searchParams.set('__force_update', Date.now().toString());
        const response = await fetch(probe.href, { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
      } catch (e) {
        throw new Error('当前无法从网络获取最新版，请检查网络后重试');
      }

      setTimeout(() => window.location.replace(target.href), 250);
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
    status.textContent = '遇到版本未刷新时，点这里强制从网络同步；不会删除历史记录。';
    status.style.cssText = 'margin-top:8px;color:var(--text-muted);font-size:11px;line-height:1.55;text-align:center;';

    box.append(btn, status);
    anchor.insertAdjacentElement('afterend', box);
  }

  document.addEventListener('DOMContentLoaded', () => setTimeout(ensureButton, 50));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(ensureButton, 50); });
  setTimeout(ensureButton, 100);
  setTimeout(ensureButton, 500);

  window.forceSyncLatestPwa = forceSyncLatest;
  console.log('[manual-update-control] loaded v' + VERSION);
})();
