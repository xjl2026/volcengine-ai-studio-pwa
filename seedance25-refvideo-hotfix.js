// Seedance 2.5 reference-video add hotfix for iOS/PWA.
(function () {
  'use strict';

  const MODEL_ID = 'doubao-seedance-2-5-260628';

  function isSeedance25() {
    return document.getElementById('vidModel')?.value === MODEL_ID;
  }

  function getList() {
    try {
      if (typeof vidRefVideoUrls !== 'undefined' && Array.isArray(vidRefVideoUrls)) return vidRefVideoUrls;
    } catch (_) {}
    return null;
  }

  function ensureStatus() {
    let el = document.getElementById('vidRefVideoStatus');
    if (el) return el;
    const row = document.querySelector('#vidRefVideoGroup .url-input-row');
    if (!row) return null;
    el = document.createElement('div');
    el.id = 'vidRefVideoStatus';
    el.style.cssText = 'margin-top:8px;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.45;display:none;';
    row.insertAdjacentElement('afterend', el);
    return el;
  }

  function setStatus(text, ok) {
    const el = ensureStatus();
    if (!el) return;
    el.textContent = text;
    el.style.display = 'block';
    el.style.background = ok ? 'rgba(0,212,170,.10)' : 'rgba(255,77,109,.10)';
    el.style.border = ok ? '1px solid rgba(0,212,170,.35)' : '1px solid rgba(255,77,109,.35)';
    el.style.color = ok ? 'var(--accent)' : 'var(--danger)';
  }

  function render(list) {
    const preview = document.getElementById('vidRefVideoPreview');
    if (!preview) return;
    preview.innerHTML = '';
    preview.style.display = 'block';
    preview.style.marginTop = '8px';

    list.forEach((url, idx) => {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;margin-top:8px;border:1px solid rgba(0,212,170,.28);border-radius:9px;background:rgba(0,212,170,.07);';

      const badge = document.createElement('div');
      badge.textContent = String(idx + 1);
      badge.style.cssText = 'width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:0 0 auto;background:var(--accent);color:#fff;font-size:12px;font-weight:700;';

      const body = document.createElement('div');
      body.style.cssText = 'min-width:0;flex:1;';
      const title = document.createElement('div');
      title.textContent = '参考视频 ' + (idx + 1) + ' · 已加入提交列表';
      title.style.cssText = 'font-size:12px;color:var(--text-primary);font-weight:600;';
      const sub = document.createElement('div');
      sub.textContent = url;
      sub.style.cssText = 'font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;';
      body.append(title, sub);

      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '删除';
      del.className = 'btn-secondary btn-sm';
      del.style.flex = '0 0 auto';
      del.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        list.splice(idx, 1);
        render(list);
        if (list.length) setStatus('已加入 ' + list.length + '/10 个参考视频', true);
        else setStatus('当前未加入参考视频', false);
      });

      item.append(badge, body, del);
      preview.appendChild(item);
    });
  }

  function addReferenceVideo(e) {
    if (!isSeedance25()) return;

    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

    const input = document.getElementById('vidRefVideoUrlInput');
    const list = getList();
    if (!input || !list) {
      setStatus('参考视频组件未初始化，请刷新页面后重试', false);
      if (typeof showToast === 'function') showToast('参考视频组件未初始化', 'error');
      return;
    }

    const url = input.value.trim();
    if (!url) {
      setStatus('请先粘贴视频 URL', false);
      if (typeof showToast === 'function') showToast('请先粘贴视频 URL', 'warning');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setStatus('URL 无效：必须以 http:// 或 https:// 开头', false);
      if (typeof showToast === 'function') showToast('请粘贴有效的 http/https URL', 'error');
      return;
    }
    if (list.length >= 10) {
      setStatus('已达到 10 个参考视频上限', false);
      if (typeof showToast === 'function') showToast('当前模型最多 10 个参考视频', 'warning');
      return;
    }
    if (list.includes(url)) {
      input.value = '';
      render(list);
      setStatus('该视频已经在提交列表中（' + list.length + '/10）', true);
      if (typeof showToast === 'function') showToast('该参考视频已经添加', 'success');
      return;
    }

    list.push(url);
    input.value = '';
    render(list);
    setStatus('已加入 ' + list.length + '/10 个参考视频；生成时会随请求提交', true);
    if (typeof showToast === 'function') showToast('参考视频已加入提交列表', 'success');
  }

  // Capture phase: run before legacy onclick handlers so iOS taps cannot be swallowed/overwritten.
  document.addEventListener('click', function (e) {
    const target = e.target && e.target.closest ? e.target.closest('#btnAddRefVideoUrl') : null;
    if (target) addReferenceVideo(e);
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.target && e.target.id === 'vidRefVideoUrlInput' && isSeedance25()) addReferenceVideo(e);
  }, true);

  function boot() {
    ensureStatus();
    const list = getList();
    if (list && list.length) {
      render(list);
      setStatus('已加入 ' + list.length + '/10 个参考视频；生成时会随请求提交', true);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
