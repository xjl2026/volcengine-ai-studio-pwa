// 视频长任务非阻塞热修复 - v1.7.6
// 目的：服务端视频任务长时间 queued/running 时，允许用户停止本地轮询并继续提交下一条；
// 旧任务保留 taskId/历史记录，可从历史详情单次查询，不取消服务端任务。
(function () {
  'use strict';

  const VERSION = '1.7.6';
  const detachedTaskIds = window._videoDetachedTaskIds || new Set();
  window._videoDetachedTaskIds = detachedTaskIds;

  function isDetached(taskId) {
    return !!taskId && detachedTaskIds.has(String(taskId));
  }

  // 替换轮询函数：保留原逻辑，但支持“放到后台”后立即停止继续请求。
  // 为避免旧 handleVideoGenerate 把“主动放后台”误判为失败，检测到 detach 后保持该旧 Promise 挂起；
  // UI 锁会由 detachCurrentTask() 主动释放。页面刷新后该挂起 Promise 自然消失。
  if (typeof pollVideoTask === 'function' && !pollVideoTask.__backgroundV176) {
    const wrappedPoll = async function (taskId, onProgress, interval, maxAttempts) {
      interval = interval || 5000;
      maxAttempts = maxAttempts || 120;
      let consecutiveErrors = 0;
      const maxConsecutiveErrors = 5;

      for (let i = 0; i < maxAttempts; i++) {
        if (isDetached(taskId)) {
          await new Promise(function () {});
        }

        const result = await queryVideoTask(taskId);

        if (isDetached(taskId)) {
          await new Promise(function () {});
        }

        if (!result.success) {
          consecutiveErrors++;
          if (!navigator.onLine) {
            if (onProgress) onProgress({ status: 'queued', data: null, attempt: i });
            await new Promise(r => setTimeout(r, interval * 4));
            i--;
            continue;
          }
          if (onProgress) onProgress({ status: 'queued', data: null, attempt: i + 1 });
          if (consecutiveErrors >= maxConsecutiveErrors) {
            return { success: false, error: '连续' + maxConsecutiveErrors + '次查询失败: ' + result.error, taskId };
          }
          await new Promise(r => setTimeout(r, interval * 2));
          continue;
        }

        consecutiveErrors = 0;
        const status = result.data?.status || 'queued';
        if (onProgress) onProgress({ status, data: result.data, attempt: i + 1 });
        if (status === 'succeeded') return result;
        if (status === 'failed') {
          return { success: false, error: result.data?.error?.message || '视频生成失败', data: result.data };
        }
        await new Promise(r => setTimeout(r, interval));
      }

      return { success: false, error: '轮询超时，任务可能仍在服务端运行', taskId, timeout: true };
    };
    wrappedPoll.__backgroundV176 = true;
    pollVideoTask = wrappedPoll;
  }

  async function detachCurrentTask() {
    const pending = typeof getValidPendingVideoTask === 'function' ? getValidPendingVideoTask() : null;
    const taskId = window._currentPollingTaskId || pending?.taskId;
    if (!taskId) {
      if (typeof showToast === 'function') showToast('当前没有可释放的视频任务', 'warning');
      return;
    }

    const ok = confirm(
      '把当前任务放到后台？\n\n' +
      '这只会停止本机继续轮询并释放“生成视频”按钮，不会取消火山服务端已经提交的任务，也不会再次扣费。\n\n' +
      '任务 ID 和历史记录会保留，之后可在“历史”里重新查询。'
    );
    if (!ok) return;

    detachedTaskIds.add(String(taskId));

    // 先解除本地 pending 锁，允许立即提交下一条。
    try { clearPendingVideoTask(); } catch (_) {}

    // 保留历史记录，用 timeout 表示“本地不再持续轮询”。
    try {
      if (pending?.recordId && typeof Store !== 'undefined') {
        await Store.updateHistory(pending.recordId, { status: 'timeout' });
      } else if (typeof Store !== 'undefined') {
        const history = await Store.getHistory();
        const record = Array.isArray(history) ? history.find(r => r && r.taskId === taskId) : null;
        if (record?.id) await Store.updateHistory(record.id, { status: 'timeout' });
      }
    } catch (e) {
      console.warn('后台任务历史状态更新失败:', e);
    }

    // 主动释放 UI 与生成锁。
    try { videoGenState.isGenerating = false; } catch (_) {}
    window._restoringTask = false;
    window._currentPollingTaskId = null;

    try { setVideoFormDisabled(false); } catch (_) {}
    const genBtn = document.getElementById('btnGenVideo');
    if (genBtn) {
      genBtn.disabled = false;
      genBtn.textContent = '生成视频';
    }

    const panel = document.getElementById('vidResultPanel');
    if (panel) {
      panel.innerHTML =
        '<div class="task-status">' +
          '<div class="status-text" style="color:#ffb443">任务已放到后台</div>' +
          '<div class="status-detail" style="line-height:1.6">服务端任务仍可能继续生成<br>任务ID: ' + escapeHtml(String(taskId)) + '<br>现在可以直接提交下一条视频</div>' +
          '<button class="btn-secondary" id="btnGoHistoryForTask" style="margin-top:12px;">去历史记录</button>' +
        '</div>';
      const goHistory = document.getElementById('btnGoHistoryForTask');
      if (goHistory) goHistory.onclick = () => switchPage('history');
    }

    window._historyRendered = false;
    if (typeof showToast === 'function') {
      showToast('已放到后台，可以继续生成下一条', 'success', 4000);
    }
  }

  function addBackgroundButton() {
    const panel = document.getElementById('vidResultPanel');
    if (!panel) return;
    const taskId = window._currentPollingTaskId || (typeof getValidPendingVideoTask === 'function' ? getValidPendingVideoTask()?.taskId : null);
    if (!taskId || isDetached(taskId)) return;
    if (document.getElementById('btnDetachVideoTask')) return;

    const taskStatus = panel.querySelector('.task-status');
    if (!taskStatus) return;

    const btn = document.createElement('button');
    btn.id = 'btnDetachVideoTask';
    btn.className = 'btn-secondary';
    btn.style.marginTop = '12px';
    btn.textContent = '放到后台，继续新任务';
    btn.onclick = detachCurrentTask;
    taskStatus.appendChild(btn);
  }

  // 每次状态刷新后都补上“放到后台”按钮。
  if (typeof renderVideoTaskStatus === 'function' && !renderVideoTaskStatus.__backgroundV176) {
    const originalRenderStatus = renderVideoTaskStatus;
    const wrappedRenderStatus = function (status, text, percent, attempt) {
      originalRenderStatus(status, text, percent, attempt);
      if (status === 'queued' || status === 'running') {
        setTimeout(addBackgroundButton, 0);
      }
    };
    wrappedRenderStatus.__backgroundV176 = true;
    renderVideoTaskStatus = wrappedRenderStatus;
  }

  // 超时界面同时提供“释放并继续”按钮。
  if (typeof renderVideoTimeout === 'function' && !renderVideoTimeout.__backgroundV176) {
    const originalRenderTimeout = renderVideoTimeout;
    const wrappedRenderTimeout = function (taskId, recordId, taskInfo) {
      originalRenderTimeout(taskId, recordId, taskInfo);
      const status = document.querySelector('#vidResultPanel .task-status');
      if (status && !document.getElementById('btnDetachVideoTask')) {
        const btn = document.createElement('button');
        btn.id = 'btnDetachVideoTask';
        btn.className = 'btn-secondary';
        btn.style.marginTop = '8px';
        btn.textContent = '放到后台，继续新任务';
        btn.onclick = detachCurrentTask;
        status.appendChild(btn);
      }
    };
    wrappedRenderTimeout.__backgroundV176 = true;
    renderVideoTimeout = wrappedRenderTimeout;
  }

  // 历史详情：pending/timeout 且有 taskId 时，允许做一次“只查询一次”的状态检查。
  if (typeof showHistoryPreview === 'function' && !showHistoryPreview.__backgroundV176) {
    const originalShowHistoryPreview = showHistoryPreview;
    const wrappedShowHistoryPreview = function (record) {
      originalShowHistoryPreview(record);
      if (!record || record.type !== 'video' || !record.taskId || record.result?.[0]) return;

      const modal = document.getElementById('historyPreviewModal');
      if (!modal) return;
      const actions = modal.querySelector('div[style*="flex-wrap:wrap"]');
      if (!actions || document.getElementById('btnQueryHistoryVideoTask')) return;

      const btn = document.createElement('button');
      btn.id = 'btnQueryHistoryVideoTask';
      btn.style.cssText = 'padding:8px 14px;background:#ffb443;border-radius:8px;color:#15151f;border:none;font-size:13px;font-weight:600;cursor:pointer;';
      btn.textContent = '查询任务状态';
      btn.onclick = async function () {
        btn.disabled = true;
        btn.textContent = '查询中...';
        try {
          const result = await queryVideoTask(record.taskId);
          if (!result.success) {
            showToast('查询失败：' + (result.error || ''), 'error');
            return;
          }
          const status = result.data?.status || 'queued';
          if (status === 'succeeded') {
            const url = result.data?.content?.video_url;
            const lf = result.data?.content?.last_frame_url;
            if (!url) {
              showToast('任务已完成，但未返回视频URL', 'warning');
              return;
            }
            await persistVideoTerminalState({
              taskId: record.taskId,
              recordId: record.id,
              vidMode: record.mode === '文生视频' ? 't2v' : 'i2v',
              prompt: record.prompt || '',
              params: record.params || {},
              status: 'succeeded',
              videoUrl: url,
              lastFrameUrl: lf
            });
            window._historyRendered = false;
            showToast('任务已完成，结果已写回历史记录', 'success');
            const history = await Store.getHistory();
            const fresh = history.find(r => r && r.id === record.id) || record;
            originalShowHistoryPreview(fresh);
            return;
          }
          if (status === 'failed') {
            await persistVideoTerminalState({
              taskId: record.taskId,
              recordId: record.id,
              vidMode: record.mode === '文生视频' ? 't2v' : 'i2v',
              prompt: record.prompt || '',
              params: record.params || {},
              status: 'failed',
              videoUrl: null,
              lastFrameUrl: null
            });
            window._historyRendered = false;
            showToast('服务端任务已失败', 'error');
            return;
          }
          showToast(status === 'running' ? '服务端仍在生成中' : '服务端仍在排队中', 'warning', 4000);
        } catch (e) {
          showToast('查询异常：' + (e.message || '网络错误'), 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = '查询任务状态';
        }
      };
      actions.insertBefore(btn, actions.firstChild);
    };
    wrappedShowHistoryPreview.__backgroundV176 = true;
    showHistoryPreview = wrappedShowHistoryPreview;
    window.showHistoryPreview = wrappedShowHistoryPreview;
  }

  // 页面已处于恢复/轮询状态时，热修复加载后补按钮。
  setTimeout(addBackgroundButton, 300);

  console.log('[video-task-background-hotfix] loaded v' + VERSION);
})();