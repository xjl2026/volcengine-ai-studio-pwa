// Seedance reference audio URL adapter
// Official Ark video generation API expects:
// { type: 'audio_url', audio_url: { url: 'https://...' }, role: 'reference_audio' }
(function () {
  'use strict';

  function currentCaps() {
    try {
      const id = document.getElementById('vidModel')?.value;
      return (typeof VIDEO_MODELS !== 'undefined' && VIDEO_MODELS.find(m => m.id === id)?.caps) || {};
    } catch (_) {
      return {};
    }
  }

  function isHttpUrl(value) {
    try {
      const u = new URL(String(value || '').trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function getMaxAudios() {
    return Number(currentCaps().maxRefAudios) || 10;
  }

  function renderAudioUrls() {
    const preview = document.getElementById('vidRefAudioPreview');
    if (!preview || typeof vidRefAudios === 'undefined') return;

    preview.innerHTML = '';
    const urls = Array.isArray(vidRefAudios) ? vidRefAudios : [];
    if (!urls.length) return;

    const summary = document.createElement('div');
    summary.style.cssText = 'width:100%;padding:8px 10px;border-radius:8px;background:rgba(108,92,231,.10);border:1px solid rgba(108,92,231,.28);color:#8f83ff;font-size:12px;font-weight:600;';
    summary.textContent = '✓ 已加入 ' + urls.length + '/' + getMaxAudios() + ' 个参考音频 URL';
    preview.appendChild(summary);

    urls.forEach((url, idx) => {
      const item = document.createElement('div');
      item.className = 'preview-item';
      item.style.cssText = 'position:relative;width:100%;height:auto;min-height:58px;padding:9px 36px 9px 10px;border-radius:8px;overflow:hidden;border:1px solid var(--border-color);background:var(--bg-tertiary);';

      const inner = document.createElement('div');
      inner.style.cssText = 'display:flex;align-items:center;width:100%;gap:9px;';

      const icon = document.createElement('span');
      icon.textContent = '♪';
      icon.style.cssText = 'display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:rgba(108,92,231,.14);color:#8f83ff;font-size:16px;font-weight:700;flex-shrink:0;';

      const textWrap = document.createElement('div');
      textWrap.style.cssText = 'min-width:0;flex:1;';

      const title = document.createElement('div');
      title.textContent = '参考音频 ' + (idx + 1) + ' · reference_audio';
      title.style.cssText = 'font-size:12px;color:var(--text-primary);font-weight:600;margin-bottom:2px;';

      const txt = document.createElement('div');
      txt.textContent = url;
      txt.title = url;
      txt.style.cssText = 'font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

      const del = document.createElement('button');
      del.className = 'remove-btn';
      del.textContent = '×';
      del.title = '移除参考音频';
      del.onclick = e => {
        e.stopPropagation();
        vidRefAudios.splice(idx, 1);
        renderAudioUrls();
        if (typeof showToast === 'function') showToast('已移除参考音频', 'info');
      };

      textWrap.append(title, txt);
      inner.append(icon, textWrap);
      item.append(inner, del);
      preview.appendChild(item);
    });
  }

  function install() {
    const group = document.getElementById('vidRefAudioGroup');
    if (!group || typeof vidRefAudios === 'undefined') return;

    // Replace the former local-file/base64 uploader. Ark audio_url only accepts http/https URLs.
    group.innerHTML = '';

    const label = document.createElement('label');
    label.innerHTML = '参考音频 <span class="hint">官方 API：WAV/MP3 的公网或 TOS 预签名 URL</span>';

    const row = document.createElement('div');
    row.className = 'url-input-row';

    const input = document.createElement('input');
    input.type = 'url';
    input.id = 'vidRefAudioUrlInput';
    input.className = 'url-input';
    input.placeholder = '粘贴音频 URL（https://...mp3 / ...wav）';
    input.autocomplete = 'off';
    input.inputMode = 'url';

    const add = document.createElement('button');
    add.id = 'btnAddRefAudioUrl';
    add.className = 'btn-secondary btn-sm';
    add.type = 'button';
    add.textContent = '添加';

    const note = document.createElement('div');
    note.className = 'hint';
    note.style.marginTop = '6px';
    note.textContent = '请求按 audio_url + role: reference_audio 提交；本地文件需先上传到可访问的 URL。';

    const preview = document.createElement('div');
    preview.className = 'preview-list';
    preview.id = 'vidRefAudioPreview';

    row.append(input, add);
    group.append(label, row, note, preview);

    const addUrl = () => {
      const url = input.value.trim();
      const max = getMaxAudios();

      if (!url) {
        if (typeof showToast === 'function') showToast('请粘贴音频 URL', 'warning');
        return;
      }
      if (!isHttpUrl(url)) {
        if (typeof showToast === 'function') showToast('音频必须是有效的 http/https URL', 'error');
        return;
      }
      if (vidRefAudios.length >= max) {
        if (typeof showToast === 'function') showToast('当前模型最多 ' + max + ' 段参考音频', 'warning');
        return;
      }
      if (vidRefAudios.includes(url)) {
        if (typeof showToast === 'function') showToast('该音频 URL 已添加', 'warning');
        return;
      }

      vidRefAudios.push(url);
      input.value = '';
      input.blur();
      renderAudioUrls();

      if (typeof showToast === 'function') {
        showToast('参考音频已按官方 URL 格式加入（' + vidRefAudios.length + '/' + max + '）', 'success');
      }
    };

    add.onclick = addUrl;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addUrl();
      }
    });

    // Keep compatibility with app.js / Seedance adapters that clear reference inputs.
    vidRefAudioUploadCtrl = {
      clear: () => {
        vidRefAudios = [];
        input.value = '';
        renderAudioUrls();
      },
      getFiles: () => Array.from(vidRefAudios)
    };

    renderAudioUrls();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(install, 0), { once: true });
  } else {
    setTimeout(install, 0);
  }
})();
