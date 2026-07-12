// 应用主逻辑 - PWA 移动版

// 版本信息
const APP_VERSION = '1.3.7';
const APP_BUILD = '2026-07-12 12:53:00';

let imgMode = 't2i';
let vidMode = 't2v'; // t2v / i2v
let imgRefImages = [];
let vidFirstImage = [];
let vidTailImage = [];
let vidRefImages = [];
let vidRefVideoUrls = [];
let vidRefAudios = [];
let imgUploadCtrl = null;
let vidFirstUploadCtrl = null;
let vidTailUploadCtrl = null;
let vidRefUploadCtrl = null;
let vidRefAudioUploadCtrl = null;
let imgAbortController = null;
// 视频轮询并发控制
window._currentPollingTaskId = null;
window._restoringTask = false;

document.addEventListener('DOMContentLoaded', async () => {
  initNav();
  initImagePage();
  initVideoPage();
  initSettingsPage();
  initSyncSettings();
  await loadConfig();
  await updateApiStatus();
  // 初始化同步
  await initSync();
  // 恢复未完成的视频任务（页面重新加载时）
  restorePendingVideoTask();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      // 检测到新 SW 就等它激活，然后刷新页面
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (newSW) {
          newSW.addEventListener('statechange', () => {
            if (newSW.state === 'activated' && navigator.serviceWorker.controller) {
              location.reload();
            }
          });
        }
      });
      // 每次打开页面时主动检查更新
      reg.update();
    }).catch(() => {});
  }
  // 页面从后台切回前台时也检查 SW 更新
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      restorePendingVideoTask();
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.getRegistration().then(reg => reg && reg.update());
      }
    }
  });

  // 版本信息已在上方 DOMContentLoaded 开头显示，此处无需重复
});

// ============ 导航 ============
function initNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.onclick = () => switchPage(item.dataset.page);
  });
}

function switchPage(name) {
  // 离开历史页时退出选择模式
  if (name !== 'history' && isSelectMode) {
    isSelectMode = false;
    selectedRecords.clear();
    updateSelectModeUI();
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const page = document.getElementById('page-' + name);
  const nav = document.querySelector('.nav-item[data-page="' + name + '"]');
  if (page) page.classList.add('active');
  if (nav) nav.classList.add('active');
  // 历史记录：选择模式下始终重渲染，普通模式只首次渲染
  if (name === 'history') {
    if (isSelectMode || !window._historyRendered) {
      renderHistory();
      if (!isSelectMode) window._historyRendered = true;
    }
  }
}
window.switchPage = switchPage;

// ============ Toast / Loading ============
function showToast(msg, type = 'info', duration = 3000) {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.remove(); }, duration);
}
window.showToast = showToast;

function showLoading(text = '处理中...') {
  document.getElementById('loadingText').textContent = text;
  document.getElementById('loadingOverlay').style.display = 'flex';
}
window.showLoading = showLoading;

function hideLoading() { document.getElementById('loadingOverlay').style.display = 'none'; }
window.hideLoading = hideLoading;

function escapeHtml(text) {
  if (!text) return '';
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

// ============ 设置页 ============
function initSettingsPage() {
  renderApiKeySelect();

  document.getElementById('btnSaveSettings').onclick = async () => {
    const apiKey = document.getElementById('settingsApiKey').value.trim();
    const apiDomain = document.getElementById('settingsApiDomain').value.trim() || ARK_BASE_URL;
    const label = document.getElementById('apiKeyLabel').value.trim() || '默认';
    if (!apiKey) { showToast('请输入 API Key', 'error'); return; }

    // 保存到多 Key 列表
    const keys = Store.getApiKeys();
    const activeId = Store.getActiveKeyId();
    let keyObj = keys.find(k => k.id === activeId);
    if (keyObj) {
      keyObj.key = apiKey; keyObj.label = label; keyObj.domain = apiDomain;
    } else {
      keyObj = { id: Date.now() + '', key: apiKey, label, domain: apiDomain };
      keys.push(keyObj);
      Store.setActiveKeyId(keyObj.id);
    }
    Store.saveApiKeys(keys);
    await Store.saveConfig({ apiKey, apiDomain });

    // 保存通知设置
    Store.setNotifySetting(document.getElementById('notifyOnComplete').checked);

    document.getElementById('configInfo').className = 'config-info success';
    document.getElementById('configInfo').textContent = '配置已保存';
    showToast('保存成功', 'success');
    renderApiKeySelect();
    await updateApiStatus();
  };

  document.getElementById('btnTestConnection').onclick = async () => {
    const apiKey = document.getElementById('settingsApiKey').value.trim();
    if (!apiKey) { showToast('请输入 API Key', 'error'); return; }
    showLoading('测试连接中...');
    const result = await testConnection(apiKey, ARK_BASE_URL);
    hideLoading();
    const info = document.getElementById('configInfo');
    info.className = 'config-info ' + (result.success ? 'success' : 'error');
    info.textContent = result.message;
    showToast(result.message, result.success ? 'success' : 'error');
  };

  document.getElementById('btnDeleteApiKey').onclick = () => {
    const keys = Store.getApiKeys();
    const activeId = Store.getActiveKeyId();
    const filtered = keys.filter(k => k.id !== activeId);
    Store.saveApiKeys(filtered);
    if (filtered.length > 0) {
      Store.setActiveKeyId(filtered[0].id);
      Store.saveConfig({ apiKey: filtered[0].key, apiDomain: filtered[0].domain || ARK_BASE_URL });
    } else {
      Store.setActiveKeyId('');
      Store.saveConfig({ apiKey: '', apiDomain: ARK_BASE_URL });
    }
    showToast('已删除', 'success');
    renderApiKeySelect();
    loadConfig();
  };

  document.getElementById('apiKeySelect').onchange = () => {
    const keys = Store.getApiKeys();
    const selectedId = document.getElementById('apiKeySelect').value;
    const keyObj = keys.find(k => k.id === selectedId);
    if (keyObj) {
      Store.setActiveKeyId(keyObj.id);
      Store.saveConfig({ apiKey: keyObj.key, apiDomain: keyObj.domain || ARK_BASE_URL });
      loadConfig();
    }
  };

  // 通知设置
  document.getElementById('notifyOnComplete').checked = Store.getNotifySetting();
}

function renderApiKeySelect() {
  const keys = Store.getApiKeys();
  const select = document.getElementById('apiKeySelect');
  const activeId = Store.getActiveKeyId();
  select.innerHTML = '';
  if (keys.length === 0) {
    select.innerHTML = '<option value="">新建 Key...</option>';
    document.getElementById('apiKeyLabel').value = '';
    document.getElementById('settingsApiKey').value = '';
  } else {
    keys.forEach(k => {
      const opt = document.createElement('option');
      opt.value = k.id;
      opt.textContent = k.label + ' (' + k.key.slice(0, 6) + '...' + ')';
      if (k.id === activeId) opt.selected = true;
      select.appendChild(opt);
    });
    const active = keys.find(k => k.id === activeId) || keys[0];
    document.getElementById('apiKeyLabel').value = active.label;
    document.getElementById('settingsApiKey').value = active.key;
    document.getElementById('settingsApiDomain').value = active.domain || ARK_BASE_URL;
  }
}

async function loadConfig() {
  const config = await Store.getConfig();
  if (config.apiKey) document.getElementById('settingsApiKey').value = config.apiKey;
  document.getElementById('settingsApiDomain').value = config.apiDomain || ARK_BASE_URL;
}

async function updateApiStatus() {
  const config = await Store.getConfig();
  const dot = document.querySelector('.status-dot') || {};
  // 手机版简化：不做状态指示
}

// ============ 图片生成页 ============
function initImagePage() {
  const modelSelect = document.getElementById('imgModel');
  IMAGE_MODELS.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id; opt.textContent = m.name;
    modelSelect.appendChild(opt);
  });

  document.querySelectorAll('.mode-tab[data-img-mode]').forEach(tab => {
    tab.onclick = () => {
      const mode = tab.dataset.imgMode;
      if (mode === 'sequential') {
        const model = document.getElementById('imgModel').value;
        const mi = IMAGE_MODELS.find(m => m.id === model);
        if (mi && !mi.caps.sequential) { showToast('当前模型不支持组图', 'warning'); return; }
      }
      document.querySelectorAll('.mode-tab[data-img-mode]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      imgMode = mode;
      updateImageModeUI();
    };
  });

  modelSelect.onchange = () => { updateImageModelUI(); updateImageModeUI(); };
  updateImageModelUI();

  imgUploadCtrl = initUploadArea('imgUploadArea', 'imgFileInput', 'imgPreviewList', 14, imgs => imgRefImages = imgs);
  document.getElementById('btnGenImage').onclick = handleImageGenerate;

  // 清空提示词
  document.getElementById('btnClearImgPrompt').onclick = () => { document.getElementById('imgPrompt').value = ''; };
  // 示例提示词
  document.querySelectorAll('#imgPromptSuggestions .tag-suggestion').forEach(btn => {
    btn.onclick = () => { document.getElementById('imgPrompt').value = btn.textContent; };
  });
}

function updateImageModelUI() {
  const model = document.getElementById('imgModel').value;
  const mi = IMAGE_MODELS.find(m => m.id === model);
  if (!mi) return;
  const caps = mi.caps;

  const sizeSelect = document.getElementById('imgSize');
  sizeSelect.innerHTML = '';
  mi.sizes.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; sizeSelect.appendChild(o); });
  sizeSelect.value = mi.sizes.includes('2K') ? '2K' : mi.sizes[0];

  const formatGroup = document.getElementById('imgFormatGroup');
  if (caps.outputFormat) {
    formatGroup.style.display = 'block';
    const fs = document.getElementById('imgFormat');
    fs.innerHTML = '';
    mi.formats.forEach(f => { const o = document.createElement('option'); o.value = f; o.textContent = f.toUpperCase(); fs.appendChild(o); });
  } else { formatGroup.style.display = 'none'; }

  const fastOpt = document.getElementById('imgOptimizeMode').querySelector('option[value="fast"]');
  if (caps.optimizeFast) { fastOpt.disabled = false; fastOpt.style.display = 'block'; }
  else { fastOpt.disabled = true; fastOpt.style.display = 'none'; }

  document.getElementById('imgWebSearchGroup').style.display = caps.webSearch ? 'block' : 'none';

  const seqTab = document.querySelector('.mode-tab[data-img-mode="sequential"]');
  if (caps.sequential) seqTab.classList.remove('disabled');
  else { seqTab.classList.add('disabled'); if (imgMode === 'sequential') { document.querySelectorAll('.mode-tab[data-img-mode]').forEach(t => t.classList.remove('active')); document.querySelector('.mode-tab[data-img-mode="t2i"]').classList.add('active'); imgMode = 't2i'; updateImageModeUI(); } }
}

function updateImageModeUI() {
  const refGroup = document.getElementById('imgRefGroup');
  const maxGroup = document.getElementById('maxImagesGroup');
  const model = document.getElementById('imgModel').value;
  const mi = IMAGE_MODELS.find(m => m.id === model);
  const maxRef = mi ? mi.caps.maxRefImages : 14;

  switch (imgMode) {
    case 't2i': refGroup.style.display = 'none'; maxGroup.style.display = 'none'; break;
    case 'i2i': refGroup.style.display = 'block'; maxGroup.style.display = 'none';
      document.querySelector('#imgUploadArea span').textContent = '点击选择图片'; break;
    case 'fusion': refGroup.style.display = 'block'; maxGroup.style.display = 'none';
      document.querySelector('#imgUploadArea span').textContent = '点击选择多张图片'; break;
    case 'sequential': refGroup.style.display = 'none'; maxGroup.style.display = 'block'; break;
  }
  if (imgUploadCtrl && (imgMode === 't2i' || imgMode === 'sequential')) imgUploadCtrl.clear();
}

async function handleImageGenerate() {
  const config = await Store.getConfig();
  if (!config.apiKey) { showToast('请先配置 API Key', 'warning'); switchPage('settings'); return; }
  const prompt = document.getElementById('imgPrompt').value.trim();
  if (!prompt) { showToast('请输入提示词', 'warning'); return; }
  if ((imgMode === 'i2i' || imgMode === 'fusion') && imgRefImages.length === 0) { showToast('请上传参考图', 'warning'); return; }

  const model = document.getElementById('imgModel').value;
  const mi = IMAGE_MODELS.find(m => m.id === model);
  if (!mi) return;
  const caps = mi.caps;

  const params = {
    mode: imgMode, model, prompt,
    images: (imgMode === 'i2i' || imgMode === 'fusion') ? imgRefImages : [],
    size: document.getElementById('imgSize').value,
    outputFormat: document.getElementById('imgFormat').value,
    watermark: document.getElementById('imgWatermark').checked,
    sequential: imgMode === 'sequential' ? 'auto' : 'disabled',
    maxImages: parseInt(document.getElementById('imgMaxImages').value) || 4,
    optimizeMode: document.getElementById('imgOptimizeMode').value,
    webSearch: document.getElementById('imgWebSearch').checked,
    stream: false, caps
  };

  await doImageGenerate(params, prompt);
}

// 图片生成实际执行（支持重试，最多自动重试1次）
async function doImageGenerate(params, prompt, isRetry) {
  const btn = document.getElementById('btnGenImage');
  btn.disabled = true; btn.textContent = '生成中...';
  imgAbortController = new AbortController();

  // 行内进度展示
  const panel = document.getElementById('imgResultPanel');
  panel.innerHTML = '<div class="task-status"><div class="spinner" style="width:40px;height:40px;border-width:3px;border-top-color:#3a8aff"></div><div class="status-text" style="color:#3a8aff">' + (isRetry ? '正在重新生成...' : '正在生成图片...') + '</div><div style="font-size:12px;color:#6b6b85;margin-top:4px;">切后台不会中断，请耐心等待</div><button class="btn-secondary" id="btnCancelImage" style="margin-top:12px;">取消</button></div>';
  document.getElementById('btnCancelImage').onclick = () => {
    if (imgAbortController) imgAbortController.abort();
  };

  try {
    const result = await generateImage({ ...params, signal: imgAbortController.signal });
    if (result.success && result.data) {
      const images = (result.data.data || []).map(i => i.url).filter(Boolean);
      if (images.length > 0) {
        renderImageResults(images);
        showToast('生成成功！', 'success');
        notifyTaskComplete('image', prompt);
        await Store.addHistory({ type: 'image', mode: getImgModeLabel(imgMode), prompt, params: { model: params.model, size: params.size }, result: images });
        window._historyRendered = false;
      } else { panel.innerHTML = '<div class="result-placeholder"><p>未返回图片数据</p></div>'; showToast('未返回图片数据', 'warning'); }
    } else {
      // 请求失败：首次失败自动重试一次，重试失败显示按钮
      if (!isRetry) {
        showToast('请求失败，自动重试中...', 'warning');
        return await doImageGenerate(params, prompt, true);
      }
      panel.innerHTML = '<div class="task-status"><div class="status-text" style="color:#ff4d6d">生成失败</div><div class="status-detail" style="font-size:13px;color:#a0a0b8;margin-top:4px;">' + escapeHtml(result.error || '') + '</div><button class="btn-primary" id="btnRetryImage" style="margin-top:12px;">重试</button></div>';
      document.getElementById('btnRetryImage').onclick = () => doImageGenerate(params, prompt, true);
      showToast('失败: ' + (result.error || ''), 'error');
    }
  } catch (e) {
    const isUserCancel = e.name === 'AbortError' || e.message === '用户取消';
    if (isUserCancel) {
      panel.innerHTML = '<div class="result-placeholder"><p>已取消</p></div>';
      showToast('已取消', 'info');
    } else {
      // 网络中断等异常：首次异常自动重试一次，重试失败显示按钮
      if (!isRetry) {
        showToast('网络异常，自动重试中...', 'warning');
        return await doImageGenerate(params, prompt, true);
      }
      panel.innerHTML = '<div class="task-status"><div class="status-text" style="color:#ff4d6d">网络异常</div><div class="status-detail" style="font-size:13px;color:#a0a0b8;margin-top:4px;">' + escapeHtml(e.message) + '</div><button class="btn-primary" id="btnRetryImage" style="margin-top:12px;">重试</button></div>';
      document.getElementById('btnRetryImage').onclick = () => doImageGenerate(params, prompt, true);
      showToast('错误: ' + e.message, 'error');
    }
  }
  finally { btn.disabled = false; btn.textContent = '生成图片'; imgAbortController = null; }
}

function getImgModeLabel(m) { return { t2i: '文生图', i2i: '图生图', fusion: '多图融合', sequential: '组图' }[m] || m; }

function renderImageResults(images) {
  const panel = document.getElementById('imgResultPanel');
  panel.innerHTML = '<div class="result-content"></div>';
  const content = panel.querySelector('.result-content');
  images.forEach((url, idx) => {
    const item = document.createElement('div');
    item.className = 'result-item';
    item.innerHTML = '<img src="' + escapeAttr(url) + '"><div class="result-meta">图片 ' + (idx+1) + ' / ' + images.length + '</div><div class="result-actions"><a class="btn-secondary" href="' + escapeAttr(url) + '" download>下载</a><button class="btn-secondary copy-btn" data-url="' + escapeAttr(url) + '">复制链接</button></div>';
    content.appendChild(item);
    item.querySelector('img').onclick = () => window.open(url);
    item.querySelector('.copy-btn').onclick = async () => { const ok = await copyToClipboard(url); showToast(ok ? '已复制' : '复制失败', ok ? 'success' : 'error'); };
  });
}

// ============ 视频生成页 ============
function initVideoPage() {
  const modelSelect = document.getElementById('vidModel');
  VIDEO_MODELS.forEach(m => {
    const o = document.createElement('option'); o.value = m.id; o.textContent = m.name;
    modelSelect.appendChild(o);
  });

  document.querySelectorAll('.mode-tab[data-vid-mode]').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.mode-tab[data-vid-mode]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active'); vidMode = tab.dataset.vidMode; updateVideoModeUI();
    };
  });

  modelSelect.onchange = () => { updateVideoModelUI(); updateVideoModeUI(); };
  vidFirstUploadCtrl = initUploadArea('vidFirstUpload', 'vidFirstInput', 'vidFirstPreview', 1, imgs => vidFirstImage = imgs);
  vidTailUploadCtrl = initUploadArea('vidTailUpload', 'vidTailInput', 'vidTailPreview', 1, imgs => vidTailImage = imgs);
  vidRefUploadCtrl = initUploadArea('vidRefUpload', 'vidRefInput', 'vidRefPreview', 9, imgs => vidRefImages = imgs);
  // 参考视频 —— API 要求网页 URL，改用 URL 输入
  vidRefVideoUrls = [];
  document.getElementById('btnAddRefVideoUrl').onclick = () => {
    const input = document.getElementById('vidRefVideoUrlInput');
    const url = input.value.trim();
    if (!url) { showToast('请粘贴视频 URL', 'warning'); return; }
    if (!url.startsWith('http')) { showToast('请粘贴有效的网页 URL（以 http/https 开头）', 'error'); return; }
    if (vidRefVideoUrls.length >= 3) { showToast('最多添加 3 个参考视频', 'warning'); return; }
    if (vidRefVideoUrls.includes(url)) { showToast('该 URL 已添加', 'warning'); return; }
    vidRefVideoUrls.push(url);
    input.value = '';
    renderRefVideoUrlPreview();
  };
  // 回车也可以添加
  document.getElementById('vidRefVideoUrlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btnAddRefVideoUrl').click(); }
  });

  function renderRefVideoUrlPreview() {
    const preview = document.getElementById('vidRefVideoPreview');
    preview.innerHTML = '';
    vidRefVideoUrls.forEach((url, idx) => {
      const item = document.createElement('div');
      item.className = 'preview-item';
      // 视频 URL 预览：显示一个视频播放图标
      const shortUrl = url.length > 40 ? url.substring(0, 37) + '...' : url;
      item.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:rgba(108,92,231,0.15);flex-direction:column;gap:2px;">'
        + '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6c5ce7" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
        + '<span style="font-size:9px;color:var(--text-muted);max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + shortUrl + '</span></div>'
        + '<button class="remove-btn" data-idx="' + idx + '">&times;</button>';
      preview.appendChild(item);
    });
    // 删除按钮
    preview.querySelectorAll('.remove-btn').forEach(btn => {
      btn.onclick = (e) => { e.stopPropagation(); vidRefVideoUrls.splice(parseInt(btn.dataset.idx), 1); renderRefVideoUrlPreview(); };
    });
  }
  // 音频也改 URL 输入
  vidRefAudioUploadCtrl = initUploadAreaGeneric('vidRefAudioUpload', 'vidRefAudioInput', 'vidRefAudioPreview', 3, 'audio', urls => vidRefAudios = urls);
  updateVideoModelUI(); updateVideoModeUI();
  document.getElementById('btnGenVideo').onclick = handleVideoGenerate;

  // 样片模式开启时隐藏"返回尾帧"（改动 21）
  document.getElementById('vidDraft').onchange = function() {
    const returnFrameGroup = document.getElementById('vidReturnLastFrameGroup');
    if (this.checked) {
      returnFrameGroup.style.display = 'none';
      document.getElementById('vidReturnLastFrame').checked = false;
    } else {
      returnFrameGroup.style.display = 'block';
    }
  };

  // 清空提示词
  document.getElementById('btnClearVidPrompt').onclick = () => { document.getElementById('vidPrompt').value = ''; };
  // 示例提示词
  document.querySelectorAll('#page-video .prompt-suggestions .tag-suggestion').forEach(btn => {
    btn.onclick = () => { document.getElementById('vidPrompt').value = btn.textContent; };
  });
}

function updateVideoModelUI() {
  const model = document.getElementById('vidModel').value;
  const mi = VIDEO_MODELS.find(m => m.id === model);
  if (!mi) return;
  const caps = mi.caps;

  const resSelect = document.getElementById('vidResolution');
  resSelect.innerHTML = '';
  mi.resolutions.forEach(r => { const o = document.createElement('option'); o.value = r; o.textContent = r.toUpperCase(); resSelect.appendChild(o); });

  const adaptiveOpt = document.getElementById('vidRatio').querySelector('option[value="adaptive"]');
  if (caps.adaptiveRatio) { adaptiveOpt.style.display = 'block'; adaptiveOpt.disabled = false; }
  else { adaptiveOpt.style.display = 'none'; adaptiveOpt.disabled = true; if (document.getElementById('vidRatio').value === 'adaptive') document.getElementById('vidRatio').value = '16:9'; }

  const dur = document.getElementById('vidDuration');
  dur.min = mi.durationRange[0]; dur.max = mi.durationRange[1];
  // 改动 11: -1 智能时长不被强制改回 5
  const dv = parseInt(dur.value);
  if (dv !== -1 && (dv > mi.durationRange[1] || dv < mi.durationRange[0])) dur.value = 5;

  document.getElementById('vidAudioGroup').style.display = caps.generateAudio ? 'block' : 'none';
  // 改动 22: 音频 checkbox 在隐藏时重置
  if (!caps.generateAudio) document.getElementById('vidGenerateAudio').checked = false;
  document.getElementById('vidSeedGroup').style.display = caps.seed ? 'block' : 'none';
  document.getElementById('vidFramesGroup').style.display = caps.frames ? 'block' : 'none';
  document.getElementById('vidDraftGroup').style.display = caps.draft ? 'block' : 'none';
  document.getElementById('vidServiceTierGroup').style.display = caps.serviceTier ? 'block' : 'none';
  // 新增 caps 显隐
  document.getElementById('vidWebSearchGroup').style.display = caps.webSearch ? 'block' : 'none';
  document.getElementById('vidPriorityGroup').style.display = caps.priority ? 'block' : 'none';
  updateCameraFixedVisibility(caps);

  // 图生视频模式下，参考图/视频/音频区域按模型能力显示（统一调用 updateVideoModeUI）
  updateVideoModeUI();
}

function updateCameraFixedVisibility(caps) {
  document.getElementById('vidCameraFixedGroup').style.display = (caps && caps.cameraFixed && vidMode === 't2v') ? 'block' : 'none';
}

function updateVideoModeUI() {
  const ff = document.getElementById('vidFirstFrameGroup');
  const tf = document.getElementById('vidTailFrameGroup');
  const rf = document.getElementById('vidRefImageGroup');
  const rv = document.getElementById('vidRefVideoGroup');
  const ra = document.getElementById('vidRefAudioGroup');
  ff.style.display = 'none'; tf.style.display = 'none'; rf.style.display = 'none';
  rv.style.display = 'none'; ra.style.display = 'none';

  if (vidMode === 'i2v') {
    ff.style.display = 'block';
    const model = document.getElementById('vidModel').value;
    const mi = VIDEO_MODELS.find(m => m.id === model);
    if (mi) {
      const caps = mi.caps;
      // 改动 13: 1.0 Pro Fast 不支持尾帧
      const supportsTail = mi.id !== 'doubao-seedance-1-0-pro-fast-251015';
      tf.style.display = supportsTail ? 'block' : 'none';
      if (!supportsTail && vidTailUploadCtrl) vidTailUploadCtrl.clear();
      // 参考图/视频/音频 按 caps 显示
      if (caps.referenceImage) rf.style.display = 'block';
      if (caps.referenceVideo) rv.style.display = 'block';
      if (caps.referenceAudio) ra.style.display = 'block';
    }
  } else {
    if (vidFirstUploadCtrl) vidFirstUploadCtrl.clear();
    if (vidTailUploadCtrl) vidTailUploadCtrl.clear();
    if (vidRefUploadCtrl) vidRefUploadCtrl.clear();
    vidRefVideoUrls = []; renderRefVideoUrlPreview();
    if (vidRefAudioUploadCtrl) vidRefAudioUploadCtrl.clear();
  }
  const model = document.getElementById('vidModel').value;
  const mi = VIDEO_MODELS.find(m => m.id === model);
  if (mi) updateCameraFixedVisibility(mi.caps);
}

// 表单整体 disable（改动 23）
function setVideoFormDisabled(disabled) {
  ['vidModel', 'vidResolution', 'vidRatio', 'vidDuration', 'vidSeed', 'vidFrames',
   'vidServiceTier', 'vidPriority'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
  ['vidGenerateAudio', 'vidWatermark', 'vidReturnLastFrame', 'vidCameraFixed',
   'vidDraft', 'vidWebSearch'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
  document.querySelectorAll('.mode-tab[data-vid-mode]').forEach(t => {
    t.style.pointerEvents = disabled ? 'none' : '';
    t.style.opacity = disabled ? '0.5' : '';
  });
}

async function handleVideoGenerate() {
  const config = await Store.getConfig();
  if (!config.apiKey) { showToast('请先配置 API Key', 'warning'); switchPage('settings'); return; }
  const prompt = document.getElementById('vidPrompt').value.trim();
  if (!prompt) { showToast('请输入提示词', 'warning'); return; }
  if (vidMode === 'i2v' && vidFirstImage.length === 0 && vidTailImage.length === 0 && vidRefImages.length === 0) { showToast('请至少上传一张图片', 'warning'); return; }

  const model = document.getElementById('vidModel').value;
  const mi = VIDEO_MODELS.find(m => m.id === model);
  if (!mi) return;
  const caps = mi.caps;

  // 改动 12: seed=0 不被当作未设置
  const seedRaw = document.getElementById('vidSeed').value.trim();

  // 首帧/尾帧与参考媒体互斥 —— API 不允许混用
  const hasFirstOrLastFrame = (vidFirstImage.length > 0 || vidTailImage.length > 0);
  const hasRefMedia = (vidRefImages.length > 0 || vidRefVideoUrls.length > 0 || vidRefAudios.length > 0);
  if (hasFirstOrLastFrame && hasRefMedia) {
    showToast('首帧/尾帧与参考媒体不能同时使用，已自动忽略参考媒体', 'warning');
  }

  const params = {
    mode: vidMode, model, prompt,
    firstFrameImages: vidMode === 'i2v' && vidFirstImage.length > 0 ? vidFirstImage : undefined,
    tailFrameImages: vidMode === 'i2v' && vidTailImage.length > 0 ? vidTailImage : undefined,
    refImages: vidMode === 'i2v' && vidRefImages.length > 0 ? vidRefImages : undefined,
    refVideos: vidMode === 'i2v' && vidRefVideoUrls.length > 0 ? vidRefVideoUrls : undefined,
    refAudios: vidMode === 'i2v' && vidRefAudios.length > 0 ? vidRefAudios : undefined,
    resolution: document.getElementById('vidResolution').value,
    ratio: document.getElementById('vidRatio').value,
    duration: document.getElementById('vidDuration').value,
    seed: seedRaw === '' ? -1 : parseInt(seedRaw),
    generateAudio: document.getElementById('vidGenerateAudio').checked,
    watermark: document.getElementById('vidWatermark').checked,
    returnLastFrame: document.getElementById('vidReturnLastFrame').checked,
    cameraFixed: document.getElementById('vidCameraFixed') ? document.getElementById('vidCameraFixed').checked : false,
    frames: document.getElementById('vidFrames') ? document.getElementById('vidFrames').value : '',
    draft: document.getElementById('vidDraft') ? document.getElementById('vidDraft').checked : false,
    serviceTier: document.getElementById('vidServiceTier') ? document.getElementById('vidServiceTier').value : 'default',
    webSearch: document.getElementById('vidWebSearch') ? document.getElementById('vidWebSearch').checked : false,
    priority: document.getElementById('vidPriority') ? parseInt(document.getElementById('vidPriority').value) || 0 : 0,
    caps
  };

  const btn = document.getElementById('btnGenVideo');
  btn.disabled = true; btn.textContent = '提交中...';
  setVideoFormDisabled(true);
  renderVideoTaskStatus('queued', '任务提交中...', 0);

  // 历史记录参数（复用于 pending 记录和成功后更新）
  const historyParams = { model, resolution: params.resolution, ratio: params.ratio, duration: params.duration, seed: params.seed, audio: params.generateAudio, watermark: params.watermark };

  try {
    const submitResult = await submitVideoTask(params);
    if (!submitResult.success) { renderVideoTaskStatus('failed', '提交失败: ' + (submitResult.error || ''), 0); showToast('提交失败', 'error'); return; }

    const taskId = submitResult.data?.id;
    if (!taskId) { renderVideoTaskStatus('failed', '未获取到任务ID', 0); return; }

    // 改动 6: 提交成功后立即写 pending 历史记录
    const pendingRecord = await Store.addHistory({
      type: 'video', mode: getVidModeLabel(vidMode), prompt, params: historyParams,
      result: [], taskId, status: 'pending'
    });
    window._historyRendered = false;

    // 改动 7: 保存更多参数到 localStorage
    savePendingVideoTask(taskId, vidMode, prompt, pendingRecord.id, historyParams);

    showToast('任务已提交，生成中...', 'success');
    btn.textContent = '生成中...';
    renderVideoTaskStatus('running', '视频生成中... 预计 1-3 分钟', 5, 0);

    // 改动 3: 并发控制
    window._currentPollingTaskId = taskId;
    const pollResult = await pollVideoTask(taskId, progress => {
      if (window._currentPollingTaskId !== taskId) return; // 被恢复逻辑接管，退出
      const labels = { queued: '排队中...', running: '生成中...', succeeded: '完成', failed: '失败' };
      const percent = Math.min((progress.attempt / 60) * 100, 90);
      renderVideoTaskStatus(progress.status, labels[progress.status] || progress.status, percent, progress.attempt);
    }, 5000, 240);
    window._currentPollingTaskId = null;

    if (pollResult.success) {
      const videoUrl = pollResult.data?.content?.video_url;
      const lastFrameUrl = pollResult.data?.content?.last_frame_url;
      if (videoUrl) {
        renderVideoResult(videoUrl, lastFrameUrl);
        showToast('生成成功！', 'success');
        notifyTaskComplete('video', prompt);
        // 改动 6/14: 更新历史记录（含尾帧图）
        await Store.updateHistory(pendingRecord.id, {
          result: [videoUrl], lastFrame: lastFrameUrl || null,
          thumbnail: videoUrl, status: 'succeeded'
        });
        window._historyRendered = false;
      } else { renderVideoTaskStatus('succeeded', '完成但未找到视频URL', 100); }
      clearPendingVideoTask();
    } else if (pollResult.timeout && pollResult.taskId) {
      renderVideoTimeout(pollResult.taskId, pendingRecord.id);
      showToast('轮询超时，可重试查询', 'warning');
      await Store.updateHistory(pendingRecord.id, { status: 'timeout' });
    } else {
      renderVideoTaskStatus('failed', pollResult.error || '失败', 0);
      showToast('生成失败', 'error');
      await Store.updateHistory(pendingRecord.id, { status: 'failed' });
      clearPendingVideoTask();
    }
  } catch (e) {
    renderVideoTaskStatus('failed', e.message, 0);
    showToast('错误: ' + e.message, 'error');
  } finally { btn.disabled = false; btn.textContent = '生成视频'; setVideoFormDisabled(false); }
}

function getVidModeLabel(m) { return { 't2v': '文生视频', 'i2v': '图生视频' }[m] || m; }

function renderVideoTaskStatus(status, text, percent, attempt) {
  const panel = document.getElementById('vidResultPanel');
  const colors = { queued: '#ffb443', running: '#3a8aff', succeeded: '#00d4aa', failed: '#ff4d6d' };
  const color = colors[status] || '#a0a0b8';
  let icon = status === 'queued' || status === 'running' ? '<div class="spinner" style="width:40px;height:40px;border-width:3px;border-top-color:' + color + '"></div>' :
    status === 'succeeded' ? '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' :
    '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
  let progress = (status === 'queued' || status === 'running') ? '<div class="task-progress"><div class="task-progress-bar" style="width:' + percent + '%"></div></div>' : '';
  let att = attempt ? '<div class="status-detail">已等待 ' + (attempt * 5) + ' 秒</div>' : '';
  panel.innerHTML = '<div class="task-status"><div class="status-icon">' + icon + '</div><div class="status-text" style="color:' + color + '">' + escapeHtml(text) + '</div>' + progress + att + '</div>';
}

function renderVideoResult(url, lastFrameUrl) {
  const panel = document.getElementById('vidResultPanel');
  let html = '<div class="result-content"><div class="result-item"><video src="' + escapeAttr(url) + '" controls loop playsinline></video><div class="result-actions"><a class="btn-secondary" href="' + escapeAttr(url) + '" download>下载视频</a><button class="btn-secondary copy-btn" data-url="' + escapeAttr(url) + '">复制链接</button></div></div>';
  if (lastFrameUrl) html += '<div class="last-frame-preview"><div class="last-frame-label">尾帧图</div><img src="' + escapeAttr(lastFrameUrl) + '"></div>';
  html += '</div>';
  panel.innerHTML = html;
  panel.querySelector('.copy-btn').onclick = async () => { const ok = await copyToClipboard(url); showToast(ok ? '已复制' : '复制失败', ok ? 'success' : 'error'); };
}

function renderVideoTimeout(taskId, recordId) {
  const panel = document.getElementById('vidResultPanel');
  panel.innerHTML = '<div class="task-status"><div class="status-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ffb443" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="6" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><div class="status-text" style="color:#ffb443">轮询超时</div><div class="status-detail">任务ID: ' + taskId + '<br>任务可能仍在生成中</div><button class="btn-primary" id="btnRetryQuery" style="margin-top:12px;">重新查询</button></div>';
  document.getElementById('btnRetryQuery').onclick = async () => {
    const btn = document.getElementById('btnRetryQuery');
    btn.disabled = true; btn.textContent = '查询中...';
    renderVideoTaskStatus('queued', '重新查询中...', 0);
    try {
      const result = await pollVideoTask(taskId, p => {
        const labels = { queued: '排队中...', running: '生成中...', succeeded: '完成', failed: '失败' };
        const percent = Math.min((p.attempt / 60) * 100, 90);
        renderVideoTaskStatus(p.status, labels[p.status] || p.status, percent, p.attempt);
      }, 5000, 240);
      if (result.success) {
        const url = result.data?.content?.video_url;
        const lf = result.data?.content?.last_frame_url;
        if (url) {
          renderVideoResult(url, lf);
          showToast('生成成功！', 'success');
          // 用 updateHistory 更新已有记录，避免重复
          if (recordId) {
            await Store.updateHistory(recordId, { result: [url], lastFrame: lf || null, thumbnail: url, status: 'succeeded' });
          } else {
            await Store.addHistory({ type: 'video', mode: '视频', params: {}, result: [url], thumbnail: url, taskId, status: 'succeeded' });
          }
          window._historyRendered = false;
        } else renderVideoTaskStatus('succeeded', '完成但未找到URL', 100);
        clearPendingVideoTask();
      } else if (result.timeout && result.taskId) { renderVideoTimeout(result.taskId, recordId); showToast('仍未完成', 'warning'); }
      else { renderVideoTaskStatus('failed', result.error || '失败', 0); clearPendingVideoTask(); }
    } catch (e) { renderVideoTaskStatus('failed', e.message, 0); }
  };
}

// ============ 待处理任务恢复 ============
function savePendingVideoTask(taskId, vidModeSnapshot, prompt, recordId, params) {
  localStorage.setItem('volc_pending_task', JSON.stringify({
    taskId, vidMode: vidModeSnapshot, prompt, recordId, params, savedAt: Date.now()
  }));
}

function clearPendingVideoTask() {
  localStorage.removeItem('volc_pending_task');
}

async function restorePendingVideoTask() {
  // 改动 3: 重入锁
  if (window._restoringTask) return;
  const raw = localStorage.getItem('volc_pending_task');
  if (!raw) return;

  let taskInfo;
  try { taskInfo = JSON.parse(raw); } catch { clearPendingVideoTask(); return; }

  // 超过 48 小时的任务清掉
  if (Date.now() - taskInfo.savedAt > 48 * 3600 * 1000) {
    clearPendingVideoTask();
    return;
  }

  // 如果当前已有该任务的轮询在跑，不重复恢复
  if (window._currentPollingTaskId === taskInfo.taskId) return;

  window._restoringTask = true;
  window._currentPollingTaskId = taskInfo.taskId;

  // 切到视频页，显示恢复中的状态
  switchPage('video');
  const btn = document.getElementById('btnGenVideo');
  btn.disabled = true; btn.textContent = '恢复任务中...';
  setVideoFormDisabled(true);
  // 改动 10: 进度不从 0 开始，根据 savedAt 计算已过时间
  const elapsed = Math.floor((Date.now() - taskInfo.savedAt) / 5000);
  renderVideoTaskStatus('running', '正在恢复查询任务...', Math.min(elapsed, 10), elapsed);

  try {
    const result = await pollVideoTask(taskInfo.taskId, p => {
      if (window._currentPollingTaskId !== taskInfo.taskId) return; // 被其他轮询接管
      const labels = { queued: '排队中...', running: '生成中...', succeeded: '完成', failed: '失败' };
      const totalAttempt = p.attempt + elapsed;
      const percent = Math.min((totalAttempt / 60) * 100, 90);
      renderVideoTaskStatus(p.status, labels[p.status] || p.status, percent, totalAttempt);
    }, 5000, 240);

    if (result.success) {
      const url = result.data?.content?.video_url;
      const lf = result.data?.content?.last_frame_url;
      if (url) {
        renderVideoResult(url, lf);
        showToast('视频生成成功！', 'success');
        notifyTaskComplete('video', taskInfo.prompt || '');
        // 改动 8: 用存下来的 recordId 更新，而不是新增
        if (taskInfo.recordId) {
          await Store.updateHistory(taskInfo.recordId, {
            result: [url], lastFrame: lf || null, thumbnail: url, status: 'succeeded'
          });
        } else {
          // 兜底：没有 recordId 时才新增
          await Store.addHistory({
            type: 'video', mode: getVidModeLabel(taskInfo.vidMode || 'i2v'),
            prompt: taskInfo.prompt || '', params: taskInfo.params || {},
            result: [url], lastFrame: lf || null, thumbnail: url,
            taskId: taskInfo.taskId, status: 'succeeded'
          });
        }
        window._historyRendered = false;
      } else renderVideoTaskStatus('succeeded', '完成但未找到URL', 100);
      clearPendingVideoTask();
    } else if (result.timeout && result.taskId) {
      renderVideoTimeout(result.taskId, taskInfo.recordId);
      showToast('任务仍在生成中，可稍后重试', 'warning');
      // 保留 pending task，下次切回来还能恢复
    } else {
      renderVideoTaskStatus('failed', result.error || '失败', 0);
      // 更新历史记录状态为失败
      if (taskInfo.recordId) await Store.updateHistory(taskInfo.recordId, { status: 'failed' });
      clearPendingVideoTask();
    }
  } catch (e) {
    renderVideoTaskStatus('failed', e.message, 0);
    clearPendingVideoTask();
  } finally {
    window._restoringTask = false;
    window._currentPollingTaskId = null;
    btn.disabled = false; btn.textContent = '生成视频';
    setVideoFormDisabled(false);
  }
}
function initUploadArea(areaId, inputId, previewId, maxFiles, onChange) {
  const area = document.getElementById(areaId);
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  let files = [];

  area.onclick = () => input.click();
  input.onchange = async (e) => {
    for (let file of e.target.files) {
      if (files.length >= maxFiles) {
        // 改动 36: 更准确的提示
        const remaining = maxFiles - files.length;
        showToast(remaining > 0 ? '还能添加' + remaining + '张' : '已达到上限' + maxFiles + '张', 'warning');
        break;
      }
      if (!file.type.startsWith('image/')) { showToast('请上传图片', 'error'); continue; }
      if (file.size > 15 * 1024 * 1024) { showToast(file.name + '超过15MB', 'error'); continue; }
      const base64 = await readFileAsBase64(file);
      files.push({ name: file.name, base64 });
    }
    renderPreview();
    if (onChange) onChange(files.map(f => f.base64));
    input.value = '';
  };

  function renderPreview() {
    preview.innerHTML = '';
    files.forEach((f, idx) => {
      const item = document.createElement('div');
      item.className = 'preview-item';
      item.innerHTML = '<span class="preview-index">' + (idx + 1) + '</span><img src="' + f.base64 + '"><button class="remove-btn" data-idx="' + idx + '">×</button>';
      preview.appendChild(item);
    });
    preview.querySelectorAll('.remove-btn').forEach(btn => {
      btn.onclick = (e) => { e.stopPropagation(); files.splice(parseInt(btn.dataset.idx), 1); renderPreview(); if (onChange) onChange(files.map(f => f.base64)); };
    });
  }

  return { clear: () => { files = []; renderPreview(); if (onChange) onChange([]); }, getFiles: () => files.map(f => f.base64) };
}
window.initUploadArea = initUploadArea;

// 改动 19: 通用上传区域，支持 image/video/audio
function initUploadAreaGeneric(areaId, inputId, previewId, maxFiles, acceptType, onChange) {
  const area = document.getElementById(areaId);
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  let files = [];

  if (!area || !input) return { clear: () => {} };

  area.onclick = () => input.click();
  input.onchange = async (e) => {
    for (let file of e.target.files) {
      if (files.length >= maxFiles) {
        const remaining = maxFiles - files.length;
        showToast(remaining > 0 ? '还能添加' + remaining + '个' : '已达到上限' + maxFiles + '个', 'warning');
        break;
      }
      const prefix = acceptType === 'video' ? 'video/' : acceptType === 'audio' ? 'audio/' : 'image/';
      if (!file.type.startsWith(prefix)) { showToast('请上传' + acceptType + '文件', 'error'); continue; }
      const sizeLimit = acceptType === 'video' ? 100 : acceptType === 'audio' ? 50 : 15;
      if (file.size > sizeLimit * 1024 * 1024) { showToast(file.name + '超过' + sizeLimit + 'MB', 'error'); continue; }
      const base64 = await readFileAsBase64(file);
      files.push({ name: file.name, base64 });
    }
    renderPreview();
    if (onChange) onChange(files.map(f => f.base64));
    input.value = '';
  };

  function renderPreview() {
    preview.innerHTML = '';
    files.forEach((f, idx) => {
      const item = document.createElement('div');
      item.className = 'preview-item';
      let mediaHtml = '';
      if (acceptType === 'video') {
        mediaHtml = '<video src="' + escapeAttr(f.base64) + '" muted style="width:100%;height:100%;object-fit:cover;"></video>';
      } else if (acceptType === 'audio') {
        mediaHtml = '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:rgba(108,92,231,0.15);"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6c5ce7" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>';
      } else {
        mediaHtml = '<img src="' + escapeAttr(f.base64) + '">';
      }
      item.innerHTML = '<span class="preview-index">' + (idx + 1) + '</span>' + mediaHtml + '<button class="remove-btn" data-idx="' + idx + '">×</button>';
      preview.appendChild(item);
    });
    preview.querySelectorAll('.remove-btn').forEach(btn => {
      btn.onclick = (e) => { e.stopPropagation(); files.splice(parseInt(btn.dataset.idx), 1); renderPreview(); if (onChange) onChange(files.map(f => f.base64)); };
    });
  }

  return { clear: () => { files = []; renderPreview(); if (onChange) onChange([]); }, getFiles: () => files.map(f => f.base64) };
}
window.initUploadAreaGeneric = initUploadAreaGeneric;

// ============ 链接有效期计算（24 小时） ============
function getExpiryInfo(createdAt) {
  if (!createdAt) return { expired: true, label: '已过期', color: '#888', remaining: 0 };
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const remaining = Math.max(0, created + 24 * 3600 * 1000 - now);
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);

  if (remaining <= 0) return { expired: true, label: '已过期', color: '#888', remaining: 0 };
  if (hours < 1) return { expired: false, label: '还剩' + minutes + '分钟', color: '#ff4d6d', remaining };
  if (hours < 6) return { expired: false, label: '还剩' + hours + '小时' + (minutes > 0 ? minutes + '分钟' : ''), color: '#ffb443', remaining };
  return { expired: false, label: '还剩' + hours + '小时', color: '#00d68f', remaining };
}

// ============ 历史记录 ============
async function renderHistory() {
  const history = await Store.getHistory();
  const list = document.getElementById('historyList');
  if (!history || history.length === 0) { list.innerHTML = '<div class="empty-state"><p>暂无历史记录</p></div>'; return; }
  list.innerHTML = '';
  history.forEach(r => {
    const card = document.createElement('div');
    card.className = 'history-card';
    const date = new Date(r.createdAt);
    const timeStr = date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    // 链接有效期倒计时
    const expiry = getExpiryInfo(r.createdAt);
    const expiryHtml = '<span class="history-expiry" style="color:' + expiry.color + ';font-size:11px;">' + expiry.label + '</span>';
    // 改动 28: 视频缩略图用播放图标占位，不加载视频
    let thumb = r.type === 'image' && r.result?.[0] ? '<img src="' + escapeAttr(r.result[0]) + '" loading="lazy">' :
      r.type === 'video' ? '<div class="history-thumb-video"><svg width="32" height="32" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></div>' : '<div class="history-thumb-placeholder">无预览</div>';
    const url = r.result?.[0] || '';
    const downloadLabel = r.type === 'image' ? '下载图片' : '下载视频';
    // 改动 15: 状态标记
    const statusLabel = r.status === 'pending' ? ' · 生成中' : r.status === 'failed' ? ' · 失败' : r.status === 'timeout' ? ' · 超时' : '';
    const statusColor = r.status === 'pending' || r.status === 'timeout' ? '#ffb443' : r.status === 'failed' ? '#ff4d6d' : '';
    const statusHtml = statusLabel ? '<span style="color:' + statusColor + ';">' + statusLabel + '</span>' : '';
    card.innerHTML = '<div class="history-thumb" data-url="' + escapeAttr(url) + '" data-type="' + r.type + '" data-id="' + r.id + '">' + thumb + '</div><div class="history-info"><span class="history-type">' + (r.type === 'image' ? '图片' : '视频') + ' · ' + escapeHtml(r.mode || '') + statusHtml + '</span><div class="history-prompt">' + escapeHtml(r.prompt || '') + '</div><div class="history-time">' + timeStr + ' · ' + expiryHtml + '</div></div><div class="history-actions"><a class="btn-secondary download-btn" href="' + escapeAttr(url) + '" download data-id="' + r.id + '">' + downloadLabel + '</a><button class="btn-secondary delete-btn" data-id="' + r.id + '">删除</button></div>';
    // 整个卡片可点击打开详情
    card.style.cursor = 'pointer';
    card.onclick = (e) => {
      if (e.target.closest('.history-actions')) return; // 点下载/删除按钮不触发
      showHistoryPreview(r);
    };
    list.appendChild(card);
  });

  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.onclick = async (e) => { e.stopPropagation(); await Store.removeHistory(btn.dataset.id); renderHistory(); window._historyRendered = true; showToast('已删除', 'success'); };
  });
}

// ============ 历史记录详情弹窗 ============
function showHistoryPreview(record) {
  const existing = document.getElementById('historyPreviewModal');
  if (existing) existing.remove();

  const url = record.result?.[0] || '';
  const type = record.type;
  const isImage = type === 'image';

  const modal = document.createElement('div');
  modal.id = 'historyPreviewModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:16px;padding-top:env(safe-area-inset-top,16px);overflow-y:auto;';

  // 媒体预览
  let mediaHtml = '';
  if (isImage && url) {
    mediaHtml = '<img src="' + escapeAttr(url) + '" style="max-width:100%;max-height:45vh;border-radius:8px;object-fit:contain;">';
  } else if (url) {
    mediaHtml = '<video src="' + escapeAttr(url) + '" controls loop playsinline style="max-width:100%;max-height:45vh;border-radius:8px;"></video>';
  } else if (record.status === 'pending') {
    mediaHtml = '<div style="color:#ffb443;padding:40px;font-size:14px;text-align:center;">任务正在生成中，请稍后查看</div>';
  } else {
    mediaHtml = '<div style="color:#888;padding:40px;font-size:14px;">结果已过期或不可用</div>';
  }

  // 改动 14: 尾帧图展示
  let lastFrameHtml = '';
  if (record.lastFrame) {
    lastFrameHtml = '<div style="margin-top:10px;"><div style="color:#a0a0b8;font-size:12px;margin-bottom:4px;">尾帧图</div><img src="' + escapeAttr(record.lastFrame) + '" style="max-width:100%;max-height:30vh;border-radius:8px;object-fit:contain;"></div>';
  }

  // 链接有效期倒计时
  const expiryInfo = getExpiryInfo(record.createdAt);
  const expiryWarning = url
    ? '<div style="color:' + expiryInfo.color + ';font-size:13px;margin-top:8px;display:flex;align-items:center;gap:6px;">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
        (expiryInfo.expired ? '链接已过期，无法下载' : '下载链接有效期: ' + expiryInfo.label) +
      '</div>'
    : '';

  // 参数标签
  const p = record.params || {};
  let modelName = '';
  if (p.model) {
    const models = isImage ? IMAGE_MODELS : VIDEO_MODELS;
    const m = models.find(m => m.id === p.model);
    modelName = m ? m.name : p.model;
  }
  const paramItems = [];
  if (modelName) paramItems.push(['模型', modelName]);
  if (p.size) paramItems.push(['尺寸', p.size]);
  if (p.resolution) paramItems.push(['分辨率', p.resolution]);
  if (p.ratio) paramItems.push(['比例', p.ratio]);
  if (p.duration) paramItems.push(['时长', p.duration + 's']);
  if (p.seed !== undefined && p.seed !== -1 && p.seed !== 0) paramItems.push(['种子', p.seed]);
  if (p.audio !== undefined) paramItems.push(['音频', p.audio ? '开启' : '关闭']);
  if (p.watermark !== undefined) paramItems.push(['水印', p.watermark ? '有' : '无']);
  const paramsHtml = paramItems.length > 0
    ? '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">' +
      paramItems.map(([k, v]) => '<span style="background:rgba(108,92,231,0.2);border:1px solid rgba(108,92,231,0.3);padding:3px 10px;border-radius:4px;font-size:12px;color:#c8b8ff;">' + k + ': ' + escapeHtml(String(v)) + '</span>').join('') + '</div>'
    : '';

  // 详情面板
  const date = record.createdAt ? new Date(record.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const typeLabel = isImage ? '图片' : '视频';
  const modeLabel = record.mode || '';
  const detailHtml =
    '<div style="width:100%;margin-top:12px;background:rgba(255,255,255,0.06);border-radius:12px;padding:14px 16px;">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
        '<span style="background:#6c5ce7;color:#fff;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;">' + typeLabel + '</span>' +
        '<span style="color:#a0a0b8;font-size:13px;">' + escapeHtml(modeLabel) + '</span>' +
        '<span style="color:#666;font-size:12px;margin-left:auto;">' + date + '</span>' +
      '</div>' +
      '<div style="color:#e0e0e8;font-size:14px;line-height:1.6;word-break:break-all;background:rgba(0,0,0,0.25);padding:10px 12px;border-radius:8px;">' + escapeHtml(record.prompt || '(无提示词)') + '</div>' +
      paramsHtml +
    '</div>';

  // 操作按钮
  const actionsHtml =
    '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;justify-content:center;">' +
      (url ? '<a href="' + url + '" download style="padding:8px 14px;background:rgba(255,255,255,0.1);border-radius:8px;color:#fff;text-decoration:none;font-size:13px;">下载</a>' : '') +
      (url ? '<button id="btnCopyLink" style="padding:8px 14px;background:rgba(255,255,255,0.1);border-radius:8px;color:#fff;border:none;font-size:13px;cursor:pointer;">复制链接</button>' : '') +
      '<button id="btnCopyPrompt" style="padding:8px 14px;background:rgba(255,255,255,0.1);border-radius:8px;color:#fff;border:none;font-size:13px;cursor:pointer;">复制提示词</button>' +
      '<button id="btnReuseParams" style="padding:8px 14px;background:#6c5ce7;border-radius:8px;color:#fff;border:none;font-size:13px;cursor:pointer;">用此参数生成</button>' +
      '<button id="btnDeleteRecord" style="padding:8px 14px;background:#e74c3c;border-radius:8px;color:#fff;border:none;font-size:13px;cursor:pointer;">删除</button>' +
      '<button id="btnClosePreview" style="padding:8px 14px;background:rgba(255,255,255,0.15);border-radius:8px;color:#fff;border:none;font-size:13px;cursor:pointer;">关闭</button>' +
    '</div>';

  modal.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;width:100%;max-width:520px;">' +
    mediaHtml + lastFrameHtml + detailHtml + expiryWarning + actionsHtml + '</div>';

  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);

  document.getElementById('btnClosePreview').onclick = () => modal.remove();
  if (url) {
    document.getElementById('btnCopyLink').onclick = async () => { const ok = await copyToClipboard(url); showToast(ok ? '链接已复制' : '复制失败', ok ? 'success' : 'error'); };
  }
  document.getElementById('btnCopyPrompt').onclick = async () => { const ok = await copyToClipboard(record.prompt || ''); showToast(ok ? '提示词已复制' : '复制失败', ok ? 'success' : 'error'); };
  document.getElementById('btnDeleteRecord').onclick = async () => {
    await Store.removeHistory(record.id);
    modal.remove();
    window._historyRendered = false;
    renderHistory();
    showToast('已删除', 'success');
  };
  document.getElementById('btnReuseParams').onclick = () => {
    modal.remove();
    reuseHistoryParams(record);
  };
}

// 用历史记录的参数重新生成
function reuseHistoryParams(record) {
  if (record.type === 'image') {
    switchPage('image');
    const promptEl = document.getElementById('imgPrompt');
    if (promptEl && record.prompt) promptEl.value = record.prompt;
    if (record.params?.model) {
      const modelSelect = document.getElementById('imgModel');
      if (modelSelect) { modelSelect.value = record.params.model; modelSelect.dispatchEvent(new Event('change')); }
    }
    if (record.params?.size) {
      const sizeSelect = document.getElementById('imgSize');
      if (sizeSelect) sizeSelect.value = record.params.size;
    }
    showToast('已填入参数，可调整后生成', 'success');
  } else if (record.type === 'video') {
    switchPage('video');
    const promptEl = document.getElementById('vidPrompt');
    if (promptEl && record.prompt) promptEl.value = record.prompt;
    if (record.params?.model) {
      const modelSelect = document.getElementById('vidModel');
      if (modelSelect) { modelSelect.value = record.params.model; modelSelect.dispatchEvent(new Event('change')); }
    }
    if (record.params?.resolution) {
      const el = document.getElementById('vidResolution');
      if (el) el.value = record.params.resolution;
    }
    if (record.params?.ratio) {
      const el = document.getElementById('vidRatio');
      if (el) el.value = record.params.ratio;
    }
    if (record.params?.duration !== undefined) {
      const el = document.getElementById('vidDuration');
      if (el) el.value = record.params.duration;
    }
    if (record.params?.seed !== undefined) {
      const el = document.getElementById('vidSeed');
      if (el) el.value = record.params.seed;
    }
    if (record.params?.audio !== undefined) {
      const el = document.getElementById('vidGenerateAudio');
      if (el) el.checked = record.params.audio;
    }
    if (record.params?.watermark !== undefined) {
      const el = document.getElementById('vidWatermark');
      if (el) el.checked = record.params.watermark;
    }
    showToast('已填入参数，图片需手动上传', 'success');
  }
}
window.renderHistory = renderHistory;
window.showHistoryPreview = showHistoryPreview;

// ============ 清空历史 ============
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const btn = document.getElementById('btnClearHistory');
    if (btn) btn.onclick = async () => {
      if (confirm('确定清空所有历史记录？')) {
        await Store.clearHistory();
        // 退出选择模式
        if (isSelectMode) { isSelectMode = false; selectedRecords.clear(); updateSelectModeUI(); }
        renderHistory();
        showToast('已清空', 'success');
      }
    };
  }, 100);

  // 离线检测
  window.addEventListener('online', () => { document.getElementById('offlineIndicator').style.display = 'none'; });
  window.addEventListener('offline', () => { document.getElementById('offlineIndicator').style.display = 'block'; });

  // 选择模式 + 连续播放
  initSelectMode();
});

// ============ 通知提醒 ============
function notifyTaskComplete(type, prompt) {
  if (!Store.getNotifySetting()) return;
  const title = type === 'video' ? '视频生成完成' : '图片生成完成';
  const body = (prompt || '').slice(0, 50) + '...';
  // 请求通知权限
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: undefined }); } catch {}
  }
  // 震动
  if ('vibrate' in navigator) {
    navigator.vibrate([200, 100, 200]);
  }
  // 如果页面不可见，也弹 toast（回来后能看到）
  if (document.hidden) {
    showToast(title + '：' + body, 'success', 5000);
  }
}
window.notifyTaskComplete = notifyTaskComplete;

// ============ 历史记录选择模式 + 连续播放 ============
let isSelectMode = false;
let selectedRecords = new Set();
let playlistVideos = [];
let playlistIndex = 0;
let playlistVideoEl = null;

function initSelectMode() {
  const toggleBtn = document.getElementById('btnToggleSelect');
  const batchBar = document.getElementById('batchActionsBar');

  toggleBtn.onclick = () => {
    isSelectMode = !isSelectMode;
    selectedRecords.clear();
    updateSelectModeUI();
  };

  // 全选
  document.getElementById('btnSelectAll').onclick = async () => {
    const history = await Store.getHistory();
    const videos = history.filter(r => r.type === 'video' && r.result?.[0]);
    if (selectedRecords.size === videos.length) {
      selectedRecords.clear();
    } else {
      videos.forEach(r => selectedRecords.add(r.id));
    }
    updateSelectModeUI();
  };

  // 连续播放
  document.getElementById('btnPlaylistPlay').onclick = () => {
    startPlaylist();
  };

  // 服务端合并 - 勾选时提示（功能待实现）
  document.getElementById('batchServerMerge').onchange = function() {
    if (this.checked) {
      showToast('服务端合并功能将在方案一中实现（Supabase Edge Function + FFmpeg）', 'info', 4000);
    }
  };

  // 播放器事件
  initPlaylistPlayer();
}

function updateSelectModeUI() {
  const toggleBtn = document.getElementById('btnToggleSelect');
  const batchBar = document.getElementById('batchActionsBar');

  if (isSelectMode) {
    toggleBtn.textContent = '☑ 退出选择';
    toggleBtn.classList.add('active');
    batchBar.classList.add('visible');
  } else {
    toggleBtn.textContent = '☐ 选择视频';
    toggleBtn.classList.remove('active');
    batchBar.classList.remove('visible');
  }

  // 更新选中计数
  document.getElementById('batchSelectedCount').textContent = '已选 ' + selectedRecords.size + ' 个';

  // 重新渲染历史记录以更新选中状态
  renderHistorySelectMode();
}

async function renderHistorySelectMode() {
  const history = await Store.getHistory();
  const list = document.getElementById('historyList');
  list.innerHTML = '';

  if (!history || history.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>暂无历史记录</p></div>';
    return;
  }

  history.forEach(r => {
    const card = document.createElement('div');
    card.className = 'history-card';
    if (isSelectMode) card.classList.add('select-mode');
    if (selectedRecords.has(r.id)) card.classList.add('selected');

    const date = new Date(r.createdAt);
    const timeStr = date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const expiry = getExpiryInfo(r.createdAt);
    const expiryHtml = '<span class="history-expiry" style="color:' + expiry.color + ';font-size:11px;">' + expiry.label + '</span>';

    let thumb = r.type === 'image' && r.result?.[0] ? '<img src="' + escapeAttr(r.result[0]) + '" loading="lazy">' :
      r.type === 'video' ? '<div class="history-thumb-video"><svg width="32" height="32" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></div>' : '<div class="history-thumb-placeholder">无预览</div>';

    const url = r.result?.[0] || '';
    const statusLabel = r.status === 'pending' ? ' · 生成中' : r.status === 'failed' ? ' · 失败' : r.status === 'timeout' ? ' · 超时' : '';
    const statusColor = r.status === 'pending' || r.status === 'timeout' ? '#ffb443' : r.status === 'failed' ? '#ff4d6d' : '';
    const statusHtml = statusLabel ? '<span style="color:' + statusColor + ';">' + statusLabel + '</span>' : '';

    card.innerHTML = '<input type="checkbox" class="select-checkbox" ' + (selectedRecords.has(r.id) ? 'checked' : '') + '>' +
      '<div class="history-thumb" data-url="' + escapeAttr(url) + '" data-type="' + r.type + '" data-id="' + r.id + '">' + thumb + '</div>' +
      '<div class="history-info"><span class="history-type">' + (r.type === 'image' ? '图片' : '视频') + ' · ' + escapeHtml(r.mode || '') + statusHtml + '</span>' +
      '<div class="history-prompt">' + escapeHtml(r.prompt || '') + '</div>' +
      '<div class="history-time">' + timeStr + ' · ' + expiryHtml + '</div></div>' +
      '<div class="history-actions"><a class="btn-secondary download-btn" href="' + escapeAttr(url) + '" download data-id="' + r.id + '">' + (r.type === 'image' ? '下载图片' : '下载视频') + '</a><button class="btn-secondary delete-btn" data-id="' + r.id + '">删除</button></div>';

    // 选择模式下点卡片 = 勾选/取消（仅视频可勾选）
    card.onclick = (e) => {
      if (isSelectMode && r.type === 'video' && r.result?.[0]) {
        e.stopPropagation();
        e.preventDefault();
        if (selectedRecords.has(r.id)) {
          selectedRecords.delete(r.id);
        } else {
          selectedRecords.add(r.id);
        }
        updateSelectModeUI();
        return;
      }
      if (!isSelectMode) {
        if (e.target.closest('.history-actions')) return;
        showHistoryPreview(r);
      }
    };

    // checkbox 点击（选择模式）
    const checkbox = card.querySelector('.select-checkbox');
    checkbox.onclick = (e) => {
      e.stopPropagation();
      if (r.type !== 'video' || !r.result?.[0]) {
        e.preventDefault();
        showToast('仅可选择有视频结果的历史记录', 'warning');
        return;
      }
      if (checkbox.checked) {
        selectedRecords.add(r.id);
      } else {
        selectedRecords.delete(r.id);
      }
      updateSelectModeUI();
    };

    // 下载按钮
    const downloadBtn = card.querySelector('.download-btn');
    if (downloadBtn) downloadBtn.onclick = (e) => { e.stopPropagation(); };

    // 删除按钮
    const delBtn = card.querySelector('.delete-btn');
    if (delBtn) delBtn.onclick = async (e) => {
      e.stopPropagation();
      selectedRecords.delete(r.id);
      await Store.removeHistory(r.id);
      window._historyRendered = false;
      renderHistorySelectMode();
      showToast('已删除', 'success');
    };

    list.appendChild(card);
  });
}

// 重写 renderHistory 以支持选择模式
const _originalRenderHistory = renderHistory;
renderHistory = async function() {
  if (isSelectMode) {
    await renderHistorySelectMode();
  } else {
    await _originalRenderHistory();
  }
};

// ============ 连续播放播放器 ============
function initPlaylistPlayer() {
  playlistVideoEl = document.getElementById('playlistVideo');

  document.getElementById('btnPlaylistClose').onclick = closePlaylist;
  document.getElementById('btnPlaylistPrev').onclick = playPrev;
  document.getElementById('btnPlaylistNext').onclick = playNext;
  document.getElementById('btnPlaylistPlayPause').onclick = togglePlayPause;

  playlistVideoEl.addEventListener('ended', () => {
    playNext();
  });

  playlistVideoEl.addEventListener('play', () => {
    document.getElementById('btnPlaylistPlayPause').textContent = '⏸';
  });
  playlistVideoEl.addEventListener('pause', () => {
    document.getElementById('btnPlaylistPlayPause').textContent = '▶';
  });

  // 物理返回键关闭播放器
  window.addEventListener('popstate', (e) => {
    const player = document.getElementById('playlistPlayer');
    if (player && player.style.display !== 'none') {
      e.preventDefault();
      closePlaylist();
    }
  });
}

async function startPlaylist() {
  const history = await Store.getHistory();
  // 按选中的顺序获取视频 URL
  const selected = history.filter(r => selectedRecords.has(r.id) && r.result?.[0]);
  playlistVideos = selected.map(r => ({
    url: r.result[0],
    prompt: r.prompt || '',
    id: r.id
  }));

  if (playlistVideos.length === 0) {
    showToast('请先选择至少一个视频', 'warning');
    return;
  }

  playlistIndex = 0;
  document.getElementById('playlistPlayer').style.display = 'flex';
  // 禁用页面滚动
  document.body.style.overflow = 'hidden';
  loadPlaylistVideo(playlistIndex);
}

function loadPlaylistVideo(idx) {
  if (idx < 0 || idx >= playlistVideos.length) return;
  const v = playlistVideos[idx];
  playlistVideoEl.src = v.url;
  playlistVideoEl.load();
  playlistVideoEl.play().catch(() => {});
  updatePlaylistUI();
}

function updatePlaylistUI() {
  const total = playlistVideos.length;
  document.getElementById('playlistVideoLabel').textContent = (playlistIndex + 1) + ' / ' + total;
  document.getElementById('playlistProgress').textContent = (playlistIndex + 1) + ' / ' + total;
  document.getElementById('btnPlaylistPrev').style.opacity = playlistIndex === 0 ? '0.3' : '1';
  document.getElementById('btnPlaylistNext').style.opacity = playlistIndex === total - 1 ? '0.3' : '1';
}

function playNext() {
  if (playlistIndex < playlistVideos.length - 1) {
    playlistIndex++;
    loadPlaylistVideo(playlistIndex);
  } else {
    closePlaylist();
    showToast('播放列表已全部播完', 'success');
  }
}

function playPrev() {
  if (playlistIndex > 0) {
    playlistIndex--;
    loadPlaylistVideo(playlistIndex);
  }
}

function togglePlayPause() {
  if (playlistVideoEl.paused) {
    playlistVideoEl.play().catch(() => {});
  } else {
    playlistVideoEl.pause();
  }
}

function closePlaylist() {
  playlistVideoEl.pause();
  playlistVideoEl.removeAttribute('src');
  playlistVideoEl.load();
  document.getElementById('playlistPlayer').style.display = 'none';
  document.body.style.overflow = '';
}

// ============ 跨设备同步 ============
async function initSync() {
  const config = Store.getSyncConfig();
  if (config.url && config.anonKey && config.syncKey) {
    await SyncManager.configure(config.url, config.anonKey, config.syncKey);
    await syncHistoryFromCloud();
  }
}

async function syncHistoryFromCloud() {
  if (!SyncManager.isEnabled()) return;
  try {
    const cloudRecords = await SyncManager.pullHistory();
    if (cloudRecords.length === 0) {
      // 云端为空，把本地记录全部推送上去
      const localHistory = await Store.getHistory();
      for (const record of localHistory) {
        const syncId = await SyncManager.pushHistory(record);
        if (syncId) record._syncId = syncId;
      }
      await Store.saveHistory(localHistory);
      return;
    }
    // 合并云端和本地记录
    const localHistory = await Store.getHistory();
    const localIds = new Set(localHistory.map(r => r.id));
    const cloudIds = new Set(cloudRecords.map(r => r.id));
    // 添加云端有但本地没有的
    const merged = [...localHistory];
    for (const cr of cloudRecords) {
      if (!localIds.has(cr.id)) merged.push(cr);
    }
    // 给本地有但云端没有的记录推送上去
    for (const lr of localHistory) {
      if (!lr._syncId && !cloudIds.has(lr.id)) {
        const syncId = await SyncManager.pushHistory(lr);
        if (syncId) lr._syncId = syncId;
      }
    }
    // 按 createdAt 降序排列
    merged.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    if (merged.length > 500) merged.length = 500;
    await Store.saveHistory(merged);
    window._historyRendered = false;
    // 改动 34: 如果当前在历史页，立即刷新
    if (document.getElementById('page-history')?.classList.contains('active')) {
      renderHistory();
      window._historyRendered = true;
    }
  } catch (e) {
    console.warn('同步历史记录失败: ', e);
  }
}

function initSyncSettings() {
  const config = Store.getSyncConfig();
  document.getElementById('syncUrl').value = config.url || '';
  document.getElementById('syncAnonKey').value = config.anonKey || '';
  document.getElementById('syncKey').value = config.syncKey || '';
  updateSyncStatus();

  document.getElementById('btnSaveSync').onclick = async () => {
    const url = document.getElementById('syncUrl').value.trim();
    const anonKey = document.getElementById('syncAnonKey').value.trim();
    const syncKey = document.getElementById('syncKey').value.trim();
    if (url && anonKey && syncKey) {
      Store.saveSyncConfig({ url, anonKey, syncKey });
      await SyncManager.configure(url, anonKey, syncKey);
      updateSyncStatus();
      showToast('同步设置已保存，正在同步...', 'success');
      await syncHistoryFromCloud();
      showToast('同步完成', 'success');
    } else if (!url && !anonKey && !syncKey) {
      Store.saveSyncConfig({ url: '', anonKey: '', syncKey: '' });
      await SyncManager.configure('', '', '');
      updateSyncStatus();
      showToast('已关闭同步', 'success');
    } else {
      showToast('请填写完整或全部留空', 'warning');
    }
  };

  document.getElementById('btnTestSync').onclick = async () => {
    const url = document.getElementById('syncUrl').value.trim();
    const anonKey = document.getElementById('syncAnonKey').value.trim();
    if (!url || !anonKey) { showToast('请填写 URL 和 Anon Key', 'warning'); return; }
    await SyncManager.configure(url, anonKey, '');
    showLoading('测试连接中...');
    const result = await SyncManager.testConnection();
    hideLoading();
    showToast(result.message, result.success ? 'success' : 'error');
  };
}

function updateSyncStatus() {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  if (SyncManager.isEnabled()) {
    el.textContent = '同步已开启';
    el.style.color = '#00d4aa';
  } else {
    el.textContent = '同步未开启';
    el.style.color = '#a0a0b8';
  }
}