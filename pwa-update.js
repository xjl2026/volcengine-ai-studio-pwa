// PWA update controller - v1.8.0
// Single owner for manual update. No cache deletion, no SW unregister, no global touch/click interception.
(function () {
  'use strict';
  const VERSION = '1.8.0';
  let updating = false;

  function toast(message, type, duration) {
    try { if (typeof showToast === 'function') return showToast(message, type || 'info', duration || 3500); } catch (_) {}
  }

  function isUnsafeLocalWork() {
    try { if (typeof imageGenState !== 'undefined' && imageGenState.isGenerating) return '图片生成进行中'; } catch (_) {}
    if (window._migratingData) return '数据迁移进行中';
    if (window._syncWriting) return '同步写入进行中';
    return '';
  }

  function waitForControllerChange(timeoutMs) {
    return new Promise(resolve => {
      if (!('serviceWorker' in navigator)) return resolve();
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(); };
      navigator.serviceWorker.addEventListener('controllerchange', finish, { once: true });
      setTimeout(finish, timeoutMs || 1800);
    });
  }

  async function syncLatest() {
    if (updating) return;
    const blocked = isUnsafeLocalWork();
    if (blocked) { toast(blocked + '，请完成后再更新', 'warning', 4000); return; }

    updating = true;
    const btn = document.getElementById('btnForceSyncLatest');
    const status = document.getElementById('forceSyncLatestStatus');
    if (btn) { btn.disabled = true; btn.textContent = '正在检查最新版…'; }
    if (status) status.textContent = '正在检查网络和新版本…';

    try {
      const probe = new URL('./index.html', location.href);
      probe.searchParams.set('__update_probe', Date.now().toString());
      const response = await fetch(probe.href, { cache: 'no-store' });
      if (!response.ok) throw new Error('无法从网络获取最新版');

      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.update().catch(() => {});
          await new Promise(r => setTimeout(r, 250));
          if (reg.waiting) {
            const changed = waitForControllerChange(1800);
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
            await changed;
          }
        }
      }

      if (status) status.textContent = '正在重新加载最新版…';
      const target = new URL('./', location.href);
      target.search = '';
      target.searchParams.set('__manual_sync', Date.now().toString());
      location.replace(target.href);
    } catch (e) {
      updating = false;
      if (btn) { btn.disabled = false; btn.textContent = '检查并同步最新版'; }
      if (status) status.textContent = '更新失败：' + (e?.message || '未知错误');
      toast('更新失败：' + (e?.message || '未知错误'), 'error', 4500);
    }
  }

  function ensureUi() {
    const anchor = document.getElementById('appVersionInfo');
    if (!anchor || document.getElementById('forceSyncLatestBox')) return;
    const box = document.createElement('div');
    box.id = 'forceSyncLatestBox';
    box.style.cssText = 'margin-top:12px;padding:14px 14px 12px;background:var(--bg-tertiary);border-radius:10px;border:1px solid rgba(108,92,231,.28);';
    box.innerHTML = '<button id="btnForceSyncLatest" type="button" style="width:100%;padding:12px 14px;border:none;border-radius:10px;background:#6c5ce7;color:#fff;font-size:14px;font-weight:700;">检查并同步最新版</button>' +
      '<div id="forceSyncLatestStatus" style="margin-top:8px;color:var(--text-muted);font-size:11px;line-height:1.55;text-align:center;">只检查并加载新版，不删除历史记录、任务 ID 或设置。</div>';
    anchor.insertAdjacentElement('afterend', box);
    box.querySelector('#btnForceSyncLatest').onclick = syncLatest;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureUi, { once: true }); else ensureUi();
  window.addEventListener('pageshow', () => { updating = false; ensureUi(); });
  window.pwaUpdateController = { syncLatest, version: VERSION };
  console.log('[pwa-update] loaded v' + VERSION);
})();
