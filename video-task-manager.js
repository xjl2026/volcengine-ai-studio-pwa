// Video background task manager - v1.8.0
// Single owner for: pending-task controls, background detach, one-shot query, and history recovery.
(function () {
  'use strict';

  const VERSION = '1.8.0';
  const STORAGE_KEY = 'volc_pending_task';
  const detachedTaskIds = window._videoDetachedTaskIds || new Set();
  window._videoDetachedTaskIds = detachedTaskIds;

  function parseTask(raw) {
    if (!raw) return null;
    try {
      const task = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!task || !task.taskId) return null;
      const savedAt = Number(task.savedAt || 0);
      if (savedAt && Date.now() - savedAt > 48 * 3600 * 1000) return null;
      return task;
    } catch (_) { return null; }
  }

  function getPending() {
    const tasks = [];
    try { const t = parseTask(localStorage.getItem(STORAGE_KEY)); if (t) tasks.push(t); } catch (_) {}
    try { const t = parseTask(sessionStorage.getItem(STORAGE_KEY)); if (t) tasks.push(t); } catch (_) {}
    try { const t = parseTask(window._volatilePendingVideoTask); if (t) tasks.push(t); } catch (_) {}
    tasks.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    return tasks[0] || null;
  }

  function sameTask(raw, taskId) {
    const t = parseTask(raw);
    return !!(t && String(t.taskId) === String(taskId));
  }

  function clearPendingIfSame(taskId) {
    if (!taskId) return;
    try { if (sameTask(localStorage.getItem(STORAGE_KEY), taskId)) localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    try { if (sameTask(sessionStorage.getItem(STORAGE_KEY), taskId)) sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
    try { if (sameTask(window._volatilePendingVideoTask, taskId)) window._volatilePendingVideoTask = null; } catch (_) {}
  }

  async function getHistory() {
    if (typeof Store === 'undefined') return [];
    try {
      const list = await Store.getHistory();
      return Array.isArray(list) ? list : [];
    } catch (_) { return []; }
  }

  async function findRecordByTaskId(taskId) {
    const list = await getHistory();
    return list.find(r => r && String(r.taskId) === String(taskId)) || null;
  }

  async function findRecordById(id) {
    const list = await getHistory();
    return list.find(r => r && String(r.id) === String(id)) || null;
  }

  function toast(msg, type, duration) {
    try { if (typeof showToast === 'function') showToast(msg, type || 'info', duration || 3000); } catch (_) {}
  }

  function releaseVideoUi() {
    try { videoGenState.isGenerating = false; } catch (_) {}
    window._restoringTask = false;
    window._currentPollingTaskId = null;
    try { if (typeof setVideoFormDisabled === 'function') setVideoFormDisabled(false); } catch (_) {}
    const btn = document.getElementById('btnGenVideo');
    if (btn) { btn.disabled = false; btn.textContent = '生成视频'; }
  }

  // The legacy generator owns its own try/finally. To prevent a detached old task from later
  // running that finally block during a newer generation, the old poll promise intentionally
  // remains suspended until the page is reloaded. One manager owns this behavior; no competing wrappers.
  if (typeof pollVideoTask === 'function' && !pollVideoTask.__managedV180) {
    const managedPoll = async function (taskId, onProgress, interval, maxAttempts) {
      interval = interval || 5000;
      maxAttempts = maxAttempts || 120;
      let consecutiveErrors = 0;
      const maxConsecutiveErrors = 5;

      for (let i = 0; i < maxAttempts; i++) {
        if (detachedTaskIds.has(String(taskId))) await new Promise(function () {});
        const result = await queryVideoTask(taskId);
        if (detachedTaskIds.has(String(taskId))) await new Promise(function () {});

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
            return { success: false, error: '连续' + maxConsecutiveErrors + '次查询失败: ' + (result.error || ''), taskId };
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
    managedPoll.__managedV180 = true;
    pollVideoTask = managedPoll;
  }

  async function writeTerminal(record, status, videoUrl, lastFrameUrl) {
    if (!record?.id || typeof Store === 'undefined') return;
    if (status === 'succeeded') {
      await Store.updateHistory(record.id, {
        status: 'succeeded', result: videoUrl ? [videoUrl] : [], thumbnail: videoUrl || null,
        lastFrame: lastFrameUrl || null, backgrounded: false
      });
    } else {
      await Store.updateHistory(record.id, { status: 'failed', result: [], backgrounded: false });
    }
    window._historyRendered = false;
  }

  async function queryTask(taskId, recordHint) {
    if (!taskId) return { state: 'none' };
    if (typeof queryVideoTask !== 'function') throw new Error('查询接口未加载');
    const result = await queryVideoTask(taskId);
    if (!result?.success) throw new Error(result?.error || '查询失败');

    const record = recordHint || await findRecordByTaskId(taskId);
    const status = result.data?.status || 'queued';
    if (status === 'succeeded') {
      const url = result.data?.content?.video_url;
      const lf = result.data?.content?.last_frame_url || null;
      if (!url) throw new Error('任务已完成，但没有返回视频URL');
      await writeTerminal(record, 'succeeded', url, lf);
      clearPendingIfSame(taskId);
      return { state: 'succeeded', url, lastFrame: lf, record };
    }
    if (status === 'failed') {
      await writeTerminal(record, 'failed');
      clearPendingIfSame(taskId);
      return { state: 'failed', record };
    }

    if (record?.id && typeof Store !== 'undefined') {
      await Store.updateHistory(record.id, { status: 'pending', backgrounded: true });
      window._historyRendered = false;
    }
    return { state: status === 'running' ? 'running' : 'queued', record };
  }

  function removePendingCard() {
    document.getElementById('pendingTaskManagerCard')?.remove();
  }

  function renderRecoveredVideo(url) {
    const panel = document.getElementById('vidResultPanel');
    if (!panel || !url) return;
    const safe = String(url).replace(/"/g, '&quot;');
    panel.innerHTML = '<div class="result-content"><div class="result-item"><video src="' + safe + '" controls playsinline style="width:100%;border-radius:10px;"></video><div class="result-actions"><a class="btn-secondary" href="' + safe + '" target="_blank" rel="noopener">打开视频</a></div></div></div>';
  }

  async function queryCurrent() {
    const pending = getPending();
    if (!pending?.taskId) { removePendingCard(); toast('当前没有待查询的视频任务', 'info'); return; }
    const btn = document.getElementById('btnManagedTaskQuery');
    if (btn) { btn.disabled = true; btn.textContent = '查询中...'; }
    try {
      const res = await queryTask(pending.taskId);
      if (res.state === 'succeeded') {
        releaseVideoUi(); removePendingCard(); renderRecoveredVideo(res.url); toast('任务已完成，视频已取回', 'success', 4000);
      } else if (res.state === 'failed') {
        releaseVideoUi(); removePendingCard(); toast('服务端任务已失败', 'error', 4000);
      } else {
        const label = res.state === 'running' ? '服务端仍在生成中' : '服务端仍在排队中';
        const text = document.getElementById('managedTaskStatus');
        if (text) text.textContent = label + ' · 可继续等待，也可放到后台';
        toast(label, 'warning', 4000);
      }
    } catch (e) { toast('查询失败：' + (e?.message || '网络错误'), 'error'); }
    finally { if (btn && document.body.contains(btn)) { btn.disabled = false; btn.textContent = '查询当前任务'; } }
  }

  async function detachCurrent() {
    const pending = getPending();
    const taskId = pending?.taskId || window._currentPollingTaskId;
    if (!taskId) { removePendingCard(); toast('当前没有可放到后台的视频任务', 'info'); return; }
    const ok = confirm('把当前任务放到后台？\n\n只停止本机持续查询并释放生成按钮，不会取消服务端任务，也不会重新提交。\n\n任务 ID 和历史记录会保留，之后可在历史中查询。');
    if (!ok) return;

    detachedTaskIds.add(String(taskId));
    const record = await findRecordByTaskId(taskId);
    if (record?.id && typeof Store !== 'undefined') {
      try { await Store.updateHistory(record.id, { status: 'pending', backgrounded: true }); } catch (_) {}
    }
    clearPendingIfSame(taskId);
    releaseVideoUi();
    removePendingCard();
    window._historyRendered = false;

    const panel = document.getElementById('vidResultPanel');
    if (panel) panel.innerHTML = '<div class="task-status"><div class="status-text" style="color:#ffb443">任务已放到后台</div><div class="status-detail" style="line-height:1.6">服务端任务仍可能继续生成，现在可以直接提交下一条。<br>之后可到历史记录查询原任务。</div></div>';
    toast('已放到后台，可以继续生成下一条', 'success', 4000);
  }

  function makePendingCard() {
    const box = document.createElement('div');
    box.id = 'pendingTaskManagerCard';
    box.style.cssText = 'width:100%;box-sizing:border-box;margin:12px 0 14px;padding:12px;border-radius:12px;background:rgba(255,180,67,.10);border:1px solid rgba(255,180,67,.45);';
    box.innerHTML = '<div style="font-size:14px;font-weight:700;color:#ffb443;margin-bottom:4px;">有一个未完成的视频任务</div>' +
      '<div id="managedTaskStatus" style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:10px;">可以先查询结果，也可以放到后台继续新任务</div>' +
      '<div style="display:flex;gap:8px;width:100%;">' +
      '<button id="btnManagedTaskQuery" type="button" style="flex:1;padding:11px 8px;border:none;border-radius:10px;background:#ffb443;color:#15151f;font-weight:700;font-size:14px;">查询当前任务</button>' +
      '<button id="btnManagedTaskDetach" type="button" style="flex:1;padding:11px 8px;border:1px solid rgba(255,180,67,.55);border-radius:10px;background:rgba(255,180,67,.08);color:#ffb443;font-weight:700;font-size:14px;">放到后台继续</button></div>';
    box.querySelector('#btnManagedTaskQuery').onclick = queryCurrent;
    box.querySelector('#btnManagedTaskDetach').onclick = detachCurrent;
    return box;
  }

  function ensurePendingCard() {
    const pending = getPending();
    if (!pending?.taskId) { removePendingCard(); return; }
    if (document.getElementById('pendingTaskManagerCard')) return;
    const gen = document.getElementById('btnGenVideo');
    if (gen) gen.insertAdjacentElement('beforebegin', makePendingCard());
  }

  function stateLabel(record) {
    if (!record || record.type !== 'video' || (record.result && record.result[0])) return null;
    if (record.status === 'failed') return { text: ' · 失败', color: '#ff4d6d' };
    if (!record.taskId) return record.status === 'timeout' ? { text: ' · 超时', color: '#ffb443' } : null;
    if (record.backgrounded) return { text: ' · 后台处理中', color: '#ffb443' };
    if (record.status === 'timeout') return { text: ' · 待查询', color: '#ffb443' };
    if (record.status === 'pending') return { text: ' · 生成中', color: '#ffb443' };
    return { text: ' · 待查询', color: '#ffb443' };
  }

  let decorating = false;
  async function decorateHistory() {
    if (decorating) return;
    const listEl = document.getElementById('historyList');
    if (!listEl) return;
    decorating = true;
    try {
      const history = await getHistory();
      const map = new Map(history.map(r => [String(r.id), r]));
      listEl.querySelectorAll('.history-card').forEach(card => {
        const thumb = card.querySelector('.history-thumb[data-id]');
        const typeEl = card.querySelector('.history-type');
        if (!thumb || !typeEl) return;
        const r = map.get(String(thumb.dataset.id));
        if (!r) return;
        typeEl.textContent = (r.type === 'image' ? '图片' : '视频') + ' · ' + (r.mode || '');
        const state = stateLabel(r);
        if (state) {
          const s = document.createElement('span'); s.style.color = state.color; s.textContent = state.text; typeEl.appendChild(s);
        }
      });
    } finally { decorating = false; }
  }

  function findStatusPanel(modal) {
    if (!modal) return null;
    return Array.from(modal.querySelectorAll('div')).find(el => {
      const t = (el.textContent || '').trim();
      return t === '结果已过期或不可用' || t === '任务正在生成中，请稍后查看' || t.includes('服务端仍在') || t.includes('任务已放到后台') || t.includes('任务状态待查询');
    }) || null;
  }

  function setModalStatus(modal, text, color) {
    const panel = findStatusPanel(modal); if (!panel) return;
    panel.textContent = text; panel.style.color = color || '#ffb443'; panel.style.padding = '40px 16px'; panel.style.fontSize = '14px'; panel.style.textAlign = 'center';
  }

  async function enhanceHistoryModal(recordId) {
    const modal = document.getElementById('historyPreviewModal');
    if (!modal || !recordId || modal.dataset.managedTaskId === String(recordId)) return;
    const record = await findRecordById(recordId);
    if (!record || record.type !== 'video' || !record.taskId || record.result?.[0]) return;
    modal.dataset.managedTaskId = String(recordId);

    if (record.backgrounded) setModalStatus(modal, '任务已放到后台，服务端可能仍在生成');
    else if (record.status === 'timeout') setModalStatus(modal, '本地查询曾超时，服务端任务可能仍在运行');
    else setModalStatus(modal, '任务仍在处理中，可随时查询服务端状态');

    const copyPrompt = modal.querySelector('#btnCopyPrompt');
    const actions = copyPrompt?.parentElement;
    if (!actions || modal.querySelector('#btnManagedHistoryQuery')) return;
    const btn = document.createElement('button');
    btn.id = 'btnManagedHistoryQuery'; btn.type = 'button'; btn.textContent = '查询任务状态';
    btn.style.cssText = 'padding:8px 14px;background:#ffb443;border-radius:8px;color:#15151f;border:none;font-size:13px;font-weight:700;cursor:pointer;';
    btn.onclick = async function (e) {
      e.preventDefault(); e.stopPropagation(); btn.disabled = true; btn.textContent = '查询中...';
      try {
        const fresh = await findRecordById(recordId) || record;
        const res = await queryTask(fresh.taskId, fresh);
        if (res.state === 'succeeded') {
          const panel = findStatusPanel(modal);
          if (panel) {
            const video = document.createElement('video'); video.src = res.url; video.controls = true; video.loop = true; video.playsInline = true; video.style.cssText = 'max-width:100%;max-height:45vh;border-radius:8px;object-fit:contain;'; panel.replaceWith(video);
          }
          btn.remove(); toast('任务已完成，视频已取回', 'success', 4000);
        } else if (res.state === 'failed') {
          setModalStatus(modal, '服务端任务已失败', '#ff4d6d'); btn.remove(); toast('服务端任务已失败', 'error', 4000);
        } else {
          setModalStatus(modal, res.state === 'running' ? '服务端仍在生成中，可稍后再次查询' : '服务端仍在排队中，可稍后再次查询');
          toast(res.state === 'running' ? '服务端仍在生成中' : '服务端仍在排队中', 'warning', 4000);
        }
        try { if (typeof renderHistory === 'function') await renderHistory(); } catch (_) {}
        setTimeout(decorateHistory, 0);
      } catch (err) { toast('查询失败：' + (err?.message || '网络错误'), 'error'); }
      finally { if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = '查询任务状态'; } }
    };
    actions.insertBefore(btn, actions.firstChild);
  }

  function boot() {
    ensurePendingCard();
    const videoPage = document.getElementById('page-video');
    if (videoPage) new MutationObserver(ensurePendingCard).observe(videoPage, { childList: true, subtree: true });
    const historyList = document.getElementById('historyList');
    if (historyList) new MutationObserver(() => setTimeout(decorateHistory, 0)).observe(historyList, { childList: true, subtree: true });
    setTimeout(decorateHistory, 0);
  }

  document.addEventListener('click', function (e) {
    const card = e.target?.closest?.('.history-card');
    if (!card || e.target.closest('.history-actions')) return;
    const id = card.querySelector('.history-thumb[data-id]')?.dataset?.id;
    if (!id) return;
    setTimeout(() => enhanceHistoryModal(id), 40);
    setTimeout(() => enhanceHistoryModal(id), 180);
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { ensurePendingCard(); decorateHistory(); } });

  window.videoTaskManager = { queryCurrent, detachCurrent, decorateHistory, version: VERSION };
  console.log('[video-task-manager] loaded v' + VERSION);
})();
