// 待处理视频任务直接操作 - v1.7.12
// 不依赖 app.js 内部作用域：直接读取持久化 pending task，并提供查询/放后台入口。
(function () {
  'use strict';

  const VERSION = '1.7.12';
  const STORAGE_KEY = 'volc_pending_task';

  function parseTask(raw) {
    if (!raw) return null;
    try {
      const task = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!task || !task.taskId) return null;
      const savedAt = Number(task.savedAt || 0);
      if (savedAt && Date.now() - savedAt > 48 * 3600 * 1000) return null;
      return task;
    } catch (_) {
      return null;
    }
  }

  function getPending() {
    const tasks = [];
    try { const t = parseTask(localStorage.getItem(STORAGE_KEY)); if (t) tasks.push(t); } catch (_) {}
    try { const t = parseTask(sessionStorage.getItem(STORAGE_KEY)); if (t) tasks.push(t); } catch (_) {}
    try { const t = parseTask(window._volatilePendingVideoTask); if (t) tasks.push(t); } catch (_) {}
    if (!tasks.length) return null;
    tasks.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    return tasks[0];
  }

  function clearPendingIfSame(taskId) {
    const same = value => {
      const t = parseTask(value);
      return t && String(t.taskId) === String(taskId);
    };
    try { if (same(localStorage.getItem(STORAGE_KEY))) localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    try { if (same(sessionStorage.getItem(STORAGE_KEY))) sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
    try { if (same(window._volatilePendingVideoTask)) window._volatilePendingVideoTask = null; } catch (_) {}
  }

  async function findRecord(taskId) {
    if (typeof Store === 'undefined' || !taskId) return null;
    try {
      const history = await Store.getHistory();
      return Array.isArray(history) ? history.find(r => r && String(r.taskId) === String(taskId)) || null : null;
    } catch (_) {
      return null;
    }
  }

  function releaseUi() {
    // 关键：handleVideoGenerate 的首个门闩就是 videoGenState.isGenerating。
    // 旧任务放后台后必须显式释放，否则新任务会静默 return。
    try { videoGenState.isGenerating = false; } catch (_) {}
    window._restoringTask = false;
    window._currentPollingTaskId = null;

    const ids = [
      'vidModel','vidResolution','vidRatio','vidDuration','vidSeed','vidFrames','vidServiceTier','vidPriority',
      'vidGenerateAudio','vidWatermark','vidReturnLastFrame','vidCameraFixed','vidDraft','vidWebSearch',
      'vidOmniTaskType','vidOutputFormat'
    ];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
    document.querySelectorAll('.mode-tab[data-vid-mode]').forEach(t => {
      t.style.pointerEvents = '';
      t.style.opacity = '';
    });

    const btn = document.getElementById('btnGenVideo');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '生成视频';
    }
  }

  function removeControls() {
    document.getElementById('pendingTaskDirectControls')?.remove();
  }

  function renderRecoveredVideo(url) {
    const panel = document.getElementById('vidResultPanel');
    if (!panel || !url) return;
    panel.innerHTML = '<div class="result-content"><div class="result-item"><video src="' + String(url).replace(/"/g, '&quot;') + '" controls playsinline style="width:100%;border-radius:10px;"></video><div class="result-actions"><a class="btn-secondary" href="' + String(url).replace(/"/g, '&quot;') + '" target="_blank" rel="noopener">打开视频</a></div></div></div>';
  }

  async function saveTerminal(task, status, videoUrl, lastFrameUrl) {
    if (typeof Store === 'undefined') return;
    const record = await findRecord(task.taskId);
    const patch = status === 'succeeded'
      ? { status: 'succeeded', result: videoUrl ? [videoUrl] : [], thumbnail: videoUrl || null, lastFrame: lastFrameUrl || null, backgrounded: false }
      : { status: 'failed', result: [], backgrounded: false };
    if (record?.id) await Store.updateHistory(record.id, patch);
    window._historyRendered = false;
  }

  async function queryPendingOnce() {
    const pending = getPending();
    if (!pending?.taskId) {
      if (typeof showToast === 'function') showToast('当前没有待查询的视频任务', 'info');
      removeControls();
      return;
    }

    const q = document.getElementById('btnPendingQueryNow');
    if (q) { q.disabled = true; q.textContent = '查询中...'; }

    try {
      if (typeof queryVideoTask !== 'function') throw new Error('查询接口未加载');
      const result = await queryVideoTask(pending.taskId);
      if (!result?.success) {
        if (typeof showToast === 'function') showToast('查询失败：' + (result?.error || '未知错误'), 'error');
        return;
      }

      const status = result.data?.status || 'queued';
      if (status === 'succeeded') {
        const url = result.data?.content?.video_url;
        const lf = result.data?.content?.last_frame_url;
        if (!url) {
          if (typeof showToast === 'function') showToast('任务已完成，但没有返回视频URL', 'warning');
          return;
        }
        await saveTerminal(pending, 'succeeded', url, lf);
        clearPendingIfSame(pending.taskId);
        releaseUi();
        renderRecoveredVideo(url);
        removeControls();
        if (typeof showToast === 'function') showToast('任务已完成，视频已取回', 'success', 4000);
        return;
      }

      if (status === 'failed') {
        await saveTerminal(pending, 'failed');
        clearPendingIfSame(pending.taskId);
        releaseUi();
        removeControls();
        if (typeof showToast === 'function') showToast('服务端任务已失败，已释放新任务', 'error', 4000);
        return;
      }

      const label = status === 'running' ? '服务端仍在生成中' : '服务端仍在排队中';
      const statusText = document.getElementById('pendingTaskStatusText');
      if (statusText) statusText.textContent = label + ' · 可继续等待，也可放到后台';
      if (typeof showToast === 'function') showToast(label, 'warning', 4000);
    } catch (e) {
      if (typeof showToast === 'function') showToast('查询异常：' + (e?.message || '网络错误'), 'error');
    } finally {
      if (q && document.body.contains(q)) { q.disabled = false; q.textContent = '查询当前任务'; }
    }
  }

  async function detachPending() {
    const pending = getPending();
    const taskId = pending?.taskId || window._currentPollingTaskId;
    if (!taskId) {
      if (typeof showToast === 'function') showToast('当前没有可释放的视频任务', 'info');
      removeControls();
      return;
    }

    const ok = confirm(
      '把当前任务放到后台？\n\n' +
      '这只停止本机持续查询并释放“生成视频”按钮，不会取消火山服务端任务，也不会重新提交。\n\n' +
      '任务ID和历史记录会保留，之后仍可查询。'
    );
    if (!ok) return;

    // 让 background hotfix 已包装的 pollVideoTask 永久停住旧任务，避免它以后误清理新任务。
    window._videoDetachedTaskIds = window._videoDetachedTaskIds || new Set();
    window._videoDetachedTaskIds.add(String(taskId));

    const record = await findRecord(taskId);
    try {
      // 后台任务仍可能在服务端运行，不再写 timeout/过期；保留 pending 并标记 backgrounded。
      if (record?.id && typeof Store !== 'undefined') {
        await Store.updateHistory(record.id, { status: 'pending', backgrounded: true });
      }
    } catch (_) {}

    clearPendingIfSame(taskId);
    releaseUi();
    removeControls();

    const panel = document.getElementById('vidResultPanel');
    if (panel) {
      panel.innerHTML = '<div class="task-status"><div class="status-text" style="color:#ffb443">任务已放到后台</div><div class="status-detail" style="line-height:1.6">服务端仍可能继续生成，现在可以直接提交下一条。<br>之后可到历史记录查询原任务。</div></div>';
    }
    window._historyRendered = false;
    if (typeof showToast === 'function') showToast('已放到后台，可以继续生成下一条', 'success', 4000);
  }

  function createControls(taskId) {
    const box = document.createElement('div');
    box.id = 'pendingTaskDirectControls';
    box.style.cssText = 'width:100%;box-sizing:border-box;margin:12px 0 14px;padding:12px;border-radius:12px;background:rgba(255,180,67,.10);border:1px solid rgba(255,180,67,.45);';

    const title = document.createElement('div');
    title.textContent = '有一个未完成的视频任务';
    title.style.cssText = 'font-size:14px;font-weight:700;color:#ffb443;margin-bottom:4px;';

    const status = document.createElement('div');
    status.id = 'pendingTaskStatusText';
    status.textContent = '可以先查询结果，也可以放到后台继续新任务';
    status.style.cssText = 'font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:10px;';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;width:100%;';

    const queryBtn = document.createElement('button');
    queryBtn.id = 'btnPendingQueryNow';
    queryBtn.type = 'button';
    queryBtn.textContent = '查询当前任务';
    queryBtn.style.cssText = 'flex:1;padding:11px 8px;border:none;border-radius:10px;background:#ffb443;color:#15151f;font-weight:700;font-size:14px;';
    queryBtn.onclick = queryPendingOnce;

    const detachBtn = document.createElement('button');
    detachBtn.id = 'btnPendingDetachNow';
    detachBtn.type = 'button';
    detachBtn.textContent = '放到后台继续';
    detachBtn.style.cssText = 'flex:1;padding:11px 8px;border:1px solid rgba(255,180,67,.55);border-radius:10px;background:rgba(255,180,67,.08);color:#ffb443;font-weight:700;font-size:14px;';
    detachBtn.onclick = detachPending;

    row.append(queryBtn, detachBtn);
    box.append(title, status, row);
    return box;
  }

  function ensureControls() {
    const pending = getPending();
    if (!pending?.taskId) {
      removeControls();
      return;
    }
    if (document.getElementById('pendingTaskDirectControls')) return;
    const genBtn = document.getElementById('btnGenVideo');
    if (!genBtn) return;
    genBtn.insertAdjacentElement('beforebegin', createControls(pending.taskId));
  }

  const observer = new MutationObserver(() => ensureControls());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => setTimeout(ensureControls, 100));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(ensureControls, 50); });
  setTimeout(ensureControls, 100);
  setTimeout(ensureControls, 500);
  setInterval(ensureControls, 1000);

  window.queryPendingVideoTaskOnce = queryPendingOnce;
  window.detachPendingVideoTask = detachPending;
  console.log('[pending-task-ui-hotfix] loaded v' + VERSION);
})();
