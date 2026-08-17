// 视频后台任务历史页修复 - v1.7.13
// 目标：所有有 taskId 且暂无结果的视频记录都可在历史详情直接查询；
// timeout 仅表示本地轮询曾超时，不再误导为任务终态。
(function () {
  'use strict';

  const VERSION = '1.7.13';
  const PENDING_KEY = 'volc_pending_task';
  let lastOpenedRecordId = null;
  let decorating = false;

  function safeEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function getHistoryRecord(id) {
    if (!id || typeof Store === 'undefined') return null;
    try {
      const history = await Store.getHistory();
      return Array.isArray(history) ? history.find(r => r && String(r.id) === String(id)) || null : null;
    } catch (_) {
      return null;
    }
  }

  function clearPendingIfSame(taskId) {
    if (!taskId) return;
    const matches = raw => {
      if (!raw) return false;
      try {
        const t = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return t && String(t.taskId) === String(taskId);
      } catch (_) { return false; }
    };
    try { if (matches(localStorage.getItem(PENDING_KEY))) localStorage.removeItem(PENDING_KEY); } catch (_) {}
    try { if (matches(sessionStorage.getItem(PENDING_KEY))) sessionStorage.removeItem(PENDING_KEY); } catch (_) {}
    try { if (matches(window._volatilePendingVideoTask)) window._volatilePendingVideoTask = null; } catch (_) {}
  }

  function taskStateLabel(record) {
    if (!record || record.type !== 'video') return null;
    if (record.status === 'failed') return { text: ' · 失败', color: '#ff4d6d' };
    if (record.result && record.result[0]) return null;
    if (!record.taskId) return record.status === 'timeout' ? { text: ' · 超时', color: '#ffb443' } : null;
    if (record.backgrounded) return { text: ' · 后台处理中', color: '#ffb443' };
    if (record.status === 'pending') return { text: ' · 生成中', color: '#ffb443' };
    if (record.status === 'timeout') return { text: ' · 待查询', color: '#ffb443' };
    return { text: ' · 待查询', color: '#ffb443' };
  }

  async function decorateHistoryCards() {
    if (decorating || typeof Store === 'undefined') return;
    const list = document.getElementById('historyList');
    if (!list) return;
    decorating = true;
    try {
      const history = await Store.getHistory();
      const map = new Map((Array.isArray(history) ? history : []).map(r => [String(r.id), r]));
      list.querySelectorAll('.history-card').forEach(card => {
        const thumb = card.querySelector('.history-thumb[data-id]');
        const typeEl = card.querySelector('.history-type');
        if (!thumb || !typeEl) return;
        const record = map.get(String(thumb.dataset.id));
        if (!record) return;
        typeEl.textContent = (record.type === 'image' ? '图片' : '视频') + ' · ' + (record.mode || '');
        const state = taskStateLabel(record);
        if (state) {
          const s = document.createElement('span');
          s.dataset.taskStateV1713 = '1';
          s.style.color = state.color;
          s.textContent = state.text;
          typeEl.appendChild(s);
        }
      });
    } catch (_) {
    } finally {
      decorating = false;
    }
  }

  function findStatusPlaceholder(modal) {
    if (!modal) return null;
    const candidates = Array.from(modal.querySelectorAll('div'));
    return candidates.find(el => {
      const text = (el.textContent || '').trim();
      return text === '结果已过期或不可用' ||
             text === '任务正在生成中，请稍后查看' ||
             text.indexOf('服务端仍在生成') >= 0 ||
             text.indexOf('任务已放到后台') >= 0 ||
             text.indexOf('任务状态待查询') >= 0;
    }) || null;
  }

  function setModalStatus(modal, text, color) {
    const panel = findStatusPlaceholder(modal);
    if (!panel) return;
    panel.textContent = text;
    panel.style.color = color || '#ffb443';
    panel.style.padding = '40px 16px';
    panel.style.fontSize = '14px';
    panel.style.textAlign = 'center';
  }

  function showRecoveredVideoInModal(modal, url) {
    const panel = findStatusPlaceholder(modal);
    if (!panel || !url) return;
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.loop = true;
    video.playsInline = true;
    video.style.cssText = 'max-width:100%;max-height:45vh;border-radius:8px;object-fit:contain;';
    panel.replaceWith(video);
  }

  async function refreshBaseHistoryIfPossible() {
    window._historyRendered = false;
    try {
      if (typeof renderHistory === 'function') await renderHistory();
    } catch (_) {}
    setTimeout(decorateHistoryCards, 30);
  }

  async function queryRecord(record, modal, button) {
    if (!record || !record.taskId) return;
    if (button) {
      button.disabled = true;
      button.textContent = '查询中...';
    }
    try {
      if (typeof queryVideoTask !== 'function') throw new Error('查询接口未加载');
      const result = await queryVideoTask(record.taskId);
      if (!result || !result.success) {
        if (typeof showToast === 'function') showToast('查询失败：' + (result && result.error ? result.error : '未知错误'), 'error');
        return;
      }

      const status = result.data && result.data.status ? result.data.status : 'queued';
      if (status === 'succeeded') {
        const url = result.data?.content?.video_url;
        const lastFrame = result.data?.content?.last_frame_url || null;
        if (!url) {
          if (typeof showToast === 'function') showToast('任务已完成，但没有返回视频URL', 'warning');
          return;
        }
        if (typeof Store !== 'undefined') {
          await Store.updateHistory(record.id, {
            status: 'succeeded',
            result: [url],
            thumbnail: url,
            lastFrame: lastFrame,
            backgrounded: false
          });
        }
        clearPendingIfSame(record.taskId);
        showRecoveredVideoInModal(modal, url);
        if (button) button.remove();
        await refreshBaseHistoryIfPossible();
        if (typeof showToast === 'function') showToast('任务已完成，视频已取回', 'success', 4000);
        return;
      }

      if (status === 'failed') {
        if (typeof Store !== 'undefined') {
          await Store.updateHistory(record.id, { status: 'failed', result: [], backgrounded: false });
        }
        clearPendingIfSame(record.taskId);
        setModalStatus(modal, '服务端任务已失败', '#ff4d6d');
        if (button) button.remove();
        await refreshBaseHistoryIfPossible();
        if (typeof showToast === 'function') showToast('服务端任务已失败', 'error', 4000);
        return;
      }

      // queued/running：这不是“超时终态”，统一转为后台处理中。
      if (typeof Store !== 'undefined') {
        await Store.updateHistory(record.id, { status: 'pending', backgrounded: true });
      }
      setModalStatus(modal, status === 'running' ? '服务端仍在生成中，可稍后再次查询' : '服务端仍在排队中，可稍后再次查询', '#ffb443');
      await refreshBaseHistoryIfPossible();
      if (typeof showToast === 'function') {
        showToast(status === 'running' ? '服务端仍在生成中' : '服务端仍在排队中', 'warning', 4000);
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('查询异常：' + (e && e.message ? e.message : '网络错误'), 'error');
    } finally {
      if (button && document.body.contains(button)) {
        button.disabled = false;
        button.textContent = '查询任务状态';
      }
    }
  }

  async function enhanceModal(recordId) {
    const modal = document.getElementById('historyPreviewModal');
    if (!modal || !recordId) return;
    if (modal.dataset.videoTaskEnhancedV1713 === String(recordId)) return;

    const record = await getHistoryRecord(recordId);
    if (!record || record.type !== 'video' || !record.taskId || (record.result && record.result[0])) return;

    modal.dataset.videoTaskEnhancedV1713 = String(recordId);

    if (record.backgrounded) {
      setModalStatus(modal, '任务已放到后台，服务端可能仍在生成', '#ffb443');
    } else if (record.status === 'timeout') {
      setModalStatus(modal, '本地查询曾超时，服务端任务可能仍在运行', '#ffb443');
    } else if (record.status === 'pending') {
      setModalStatus(modal, '任务仍在处理中，可随时查询服务端状态', '#ffb443');
    }

    const copyPrompt = modal.querySelector('#btnCopyPrompt');
    const actions = copyPrompt ? copyPrompt.parentElement : null;
    if (!actions || modal.querySelector('#btnQueryHistoryVideoTaskV1713')) return;

    const btn = document.createElement('button');
    btn.id = 'btnQueryHistoryVideoTaskV1713';
    btn.type = 'button';
    btn.textContent = '查询任务状态';
    btn.style.cssText = 'padding:8px 14px;background:#ffb443;border-radius:8px;color:#15151f;border:none;font-size:13px;font-weight:700;cursor:pointer;';
    btn.onclick = async function (e) {
      e.preventDefault();
      e.stopPropagation();
      const fresh = await getHistoryRecord(recordId);
      await queryRecord(fresh || record, modal, btn);
    };
    actions.insertBefore(btn, actions.firstChild);
  }

  // 在历史卡片点击的捕获阶段记住 recordId；原 app.js 随后打开详情弹窗。
  document.addEventListener('click', function (e) {
    const card = e.target && e.target.closest ? e.target.closest('.history-card') : null;
    if (!card || e.target.closest('.history-actions')) return;
    const thumb = card.querySelector('.history-thumb[data-id]');
    if (!thumb || !thumb.dataset.id) return;
    lastOpenedRecordId = thumb.dataset.id;
    setTimeout(() => enhanceModal(lastOpenedRecordId), 30);
    setTimeout(() => enhanceModal(lastOpenedRecordId), 150);
  }, true);

  const observer = new MutationObserver(function () {
    decorateHistoryCards();
    if (lastOpenedRecordId && document.getElementById('historyPreviewModal')) {
      setTimeout(() => enhanceModal(lastOpenedRecordId), 0);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(decorateHistoryCards, 200);
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) setTimeout(decorateHistoryCards, 100);
  });
  setInterval(decorateHistoryCards, 1500);

  console.log('[history-video-task-hotfix] loaded v' + VERSION);
})();
