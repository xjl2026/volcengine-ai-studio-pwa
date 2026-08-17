// PWA 更新修复 - v1.7.9
// 视频任务已提交到服务端且 taskId 已持久化时，允许刷新更新；刷新后由现有恢复逻辑继续查询。
(function () {
  'use strict';

  const VERSION = '1.7.9';
  let applying = false;

  function hasRecoverableVideoTask() {
    try {
      if (window._currentPollingTaskId) return true;
      if (typeof getValidPendingVideoTask === 'function') return !!getValidPendingVideoTask()?.taskId;
    } catch (_) {}
    return false;
  }

  async function forceSafeUpdate() {
    if (applying) return;
    applying = true;
    try {
      // 数据迁移/同步写入仍然不强制刷新。
      if (window._migratingData || window._syncWriting) {
        if (typeof showToast === 'function') showToast('数据写入进行中，请稍后更新', 'warning');
        applying = false;
        return;
      }

      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.waiting) {
        let reloaded = false;
        const reloadOnce = () => {
          if (reloaded) return;
          reloaded = true;
          location.reload();
        };
        navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        setTimeout(reloadOnce, 1200);
      } else {
        location.reload();
      }
    } catch (e) {
      applying = false;
      if (typeof showToast === 'function') showToast('更新失败，请重新打开应用', 'error');
    }
  }

  // 旧 app.js 会因为“视频任务进行中”拦截更新。
  // 在捕获阶段只接管这一种可恢复场景，不影响图片生成等保护。
  document.addEventListener('click', function (e) {
    const bar = e.target?.closest?.('#swUpdateBar');
    if (!bar) return;
    const text = String(bar.textContent || '');
    const videoBlocked = text.includes('视频任务进行中') || (text.includes('发现新版本') && hasRecoverableVideoTask());
    if (!videoBlocked) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    forceSafeUpdate();
  }, true);

  console.log('[sw-update-video-safe-hotfix] loaded v' + VERSION);
})();
