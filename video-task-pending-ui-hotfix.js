// 待处理视频任务提示条直接操作 - v1.7.7
(function () {
  'use strict';

  const VERSION = '1.7.7';
  const NOTICE_TEXT = '已有未完成的视频任务，请先查询该任务结果';

  function getPending() {
    try {
      return typeof getValidPendingVideoTask === 'function' ? getValidPendingVideoTask() : null;
    } catch (_) {
      return null;
    }
  }

  async function findRecord(taskId) {
    if (typeof Store === 'undefined' || !taskId) return null;
    try {
      const history = await Store.getHistory();
      return Array.isArray(history) ? history.find(r => r && r.taskId === taskId) || null : null;
    } catch (_) {
      return null;
    }
  }

  function releaseUi() {
    try { videoGenState.isGenerating = false; } catch (_) {}
    window._restoringTask = false;
    window._currentPollingTaskId = null;
    try { setVideoFormDisabled(false); } catch (_) {}
    const btn = document.getElementById('btnGenVideo');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '生成视频';
    }
  }

  async function queryPendingOnce() {
    const pending = getPending();
    if (!pending?.taskId) {
      showToast('当前没有待查询的视频任务', 'info');
      enhanceNotice();
      return;
    }

    const q = document.getElementById('btnPendingQueryNow');
    if (q) { q.disabled = true; q.textContent = '查询中...'; }

    try {
      const result = await queryVideoTask(pending.taskId);
      if (!result?.success) {
        showToast('查询失败：' + (result?.error || '未知错误'), 'error');
        return;
      }

      const status = result.data?.status || 'queued';
      const record = await findRecord(pending.taskId);

      if (status === 'succeeded') {
        const url = result.data?.content?.video_url;
        const lf = result.data?.content?.last_frame_url;
        if (!url) {
          showToast('任务已完成，但没有返回视频URL', 'warning');
          return;
        }
        if (typeof persistVideoTerminalState === 'function') {
          await persistVideoTerminalState({
            taskId: pending.taskId,
            recordId: pending.recordId || record?.id || null,
            vidMode: pending.vidMode || 'i2v',
            prompt: pending.prompt || record?.prompt || '',
            params: pending.params || record?.params || {},
            status: 'succeeded',
            videoUrl: url,
            lastFrameUrl: lf
          });
        }
        try { clearPendingVideoTask(); } catch (_) {}
        releaseUi();
        if (typeof renderVideoResult === 'function') renderVideoResult(url, lf);
        window._historyRendered = false;
        showToast('任务已完成，视频已取回', 'success', 4000);
        removeControls();
        return;
      }

      if (status === 'failed') {
        if (typeof persistVideoTerminalState === 'function') {
          await persistVideoTerminalState({
            taskId: pending.taskId,
            recordId: pending.recordId || record?.id || null,
            vidMode: pending.vidMode || 'i2v',
            prompt: pending.prompt || record?.prompt || '',
            params: pending.params || record?.params || {},
            status: 'failed',
            videoUrl: null,
            lastFrameUrl: null
          });
        }
        try { clearPendingVideoTask(); } catch (_) {}
        releaseUi();
        window._historyRendered = false;
        showToast('服务端任务已失败，已释放新任务', 'error', 4000);
        removeControls();
        return;
      }

      showToast(status === 'running' ? '服务端仍在生成中' : '服务端仍在排队中', 'warning', 4000);
    } catch (e) {
      showToast('查询异常：' + (e?.message || '网络错误'), 'error');
    } finally {
      if (q && document.body.contains(q)) { q.disabled = false; q.textContent = '查询当前任务'; }
    }
  }

  async function detachPending() {
    const pending = getPending();
    const taskId = pending?.taskId || window._currentPollingTaskId;
    if (!taskId) {
      showToast('当前没有可释放的视频任务', 'info');
      removeControls();
      return;
    }

    const ok = confirm(
      '把当前任务放到后台？\n\n' +
      '这只停止本机继续等待并释放“生成视频”按钮，不会取消火山服务端任务，也不会重新提交。\n\n' +
      '任务ID和历史记录会保留，之后仍可查询。'
    );
    if (!ok) return;

    try {
      if (window._videoDetachedTaskIds) window._videoDetachedTaskIds.add(String(taskId));
    } catch (_) {}

    const record = await findRecord(taskId);
    try {
      if (record?.id && typeof Store !== 'undefined') await Store.updateHistory(record.id, { status: 'timeout' });
    } catch (_) {}

    try { clearPendingVideoTask(); } catch (_) {}
    releaseUi();
    window._historyRendered = false;
    removeControls();

    const panel = document.getElementById('vidResultPanel');
    if (panel) {
      panel.innerHTML = '<div class="task-status"><div class="status-text" style="color:#ffb443">任务已放到后台</div><div class="status-detail">服务端仍可能继续生成，现在可以直接提交下一条。<br>之后可到历史记录查询原任务。</div></div>';
    }
    showToast('已放到后台，可以继续生成下一条', 'success', 4000);
  }

  function removeControls() {
    const c = document.getElementById('pendingTaskDirectControls');
    if (c) c.remove();
  }

  function findNoticeLeaf() {
    const root = document.getElementById('page-video') || document.body;
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (el.children.length === 0 && String(el.textContent || '').trim().includes(NOTICE_TEXT)) return el;
    }
    return null;
  }

  function enhanceNotice() {
    const pending = getPending();
    if (!pending?.taskId) {
      removeControls();
      return;
    }
    if (document.getElementById('pendingTaskDirectControls')) return;

    const leaf = findNoticeLeaf();
    if (!leaf) return;

    const controls = document.createElement('div');
    controls.id = 'pendingTaskDirectControls';
    controls.style.cssText = 'display:flex;gap:8px;margin-top:8px;width:100%;';

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
    detachBtn.style.cssText = 'flex:1;padding:11px 8px;border:1px solid rgba(255,180,67,.55);border-radius:10px;background:rgba(255,180,67,.10);color:#ffb443;font-weight:700;font-size:14px;';
    detachBtn.onclick = detachPending;

    controls.append(queryBtn, detachBtn);

    const anchor = leaf.closest('.form-group') || leaf.parentElement || leaf;
    anchor.insertAdjacentElement('afterend', controls);
  }

  const observer = new MutationObserver(() => enhanceNotice());
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener('DOMContentLoaded', () => setTimeout(enhanceNotice, 200));
  setTimeout(enhanceNotice, 300);
  setInterval(enhanceNotice, 1500);

  window.queryPendingVideoTaskOnce = queryPendingOnce;
  window.detachPendingVideoTask = detachPending;
  console.log('[pending-task-ui-hotfix] loaded v' + VERSION);
})();
