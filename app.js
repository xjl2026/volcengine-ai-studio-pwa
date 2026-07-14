// 应用主逻辑 - PWA 移动版

// 版本信息
const APP_VERSION = '1.6.7';
const APP_BUILD = '2026-07-13 15:20:00';

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

// 统一按钮状态管理
const imageGenState = { isGenerating: false };
const videoGenState = { isGenerating: false };

function refreshGenerateButtonState() {
  // 图片按钮
  const imgBtn = document.getElementById('btnGenImage');
  if (imgBtn) {
    const model = document.getElementById('imgModel');
    const mi = model ? IMAGE_MODELS.find(m => m.id === model.value) : null;
    const maxRef = mi ? mi.caps.maxRefImages : 14;
    const overLimit = (imgMode === 'i2i' || imgMode === 'fusion') && imgRefImages.length > maxRef;
    imgBtn.disabled = imageGenState.isGenerating || overLimit;
    if (imageGenState.isGenerating) imgBtn.textContent = '生成中...';
    else imgBtn.textContent = '生成图片';
  }
  // 视频按钮
  const vidBtn = document.getElementById('btnGenVideo');
  if (vidBtn) {
    vidBtn.disabled = videoGenState.isGenerating;
  }
}

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
// SW 更新保护
let swUpdateState = {
  hasUpdate: false,
  waitingSW: null,
  isSafeToUpdate: true,
  pendingReasons: [],
  refreshTriggered: false
};

function checkSafeToUpdate() {
  swUpdateState.pendingReasons = [];
  if (imageGenState.isGenerating) swUpdateState.pendingReasons.push('图片生成进行中');
  if (window._currentPollingTaskId) swUpdateState.pendingReasons.push('视频任务进行中');
  if (window._migratingData) swUpdateState.pendingReasons.push('数据迁移进行中');
  if (window._syncWriting) swUpdateState.pendingReasons.push('同步写入进行中');
  swUpdateState.isSafeToUpdate = swUpdateState.pendingReasons.length === 0;
  return swUpdateState.isSafeToUpdate;
}

function showUpdateNotification(msg) {
  let bar = document.getElementById('swUpdateBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'swUpdateBar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#3a8aff;color:#fff;text-align:center;padding:8px;font-size:13px;z-index:9999;cursor:pointer;';
    document.body.appendChild(bar);
  }
  bar.textContent = msg;
  bar.onclick = applyUpdate;
}

function applyUpdate() {
  if (swUpdateState.refreshTriggered) return;
  checkSafeToUpdate();
  if (!swUpdateState.isSafeToUpdate) {
    showToast(swUpdateState.pendingReasons[0] + '，无法刷新', 'warning');
    return;
  }
  if (imageGenState.isGenerating) {
    if (!confirm('刷新将中断当前图片生成请求，已提交的请求可能仍在服务端处理。确定要刷新吗？')) return;
  }
  swUpdateState.refreshTriggered = true;
  if (swUpdateState.waitingSW) {
    swUpdateState.waitingSW.postMessage({ type: 'SKIP_WAITING' });
  } else {
    location.reload();
  }
}

// SW 注册
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const newSW = reg.installing;
      if (newSW) {
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            swUpdateState.hasUpdate = true;
            swUpdateState.waitingSW = newSW;
            checkSafeToUpdate();
            if (swUpdateState.isSafeToUpdate) {
              showUpdateNotification('发现新版本，点击刷新更新');
            } else {
              showUpdateNotification('发现新版本，' + swUpdateState.pendingReasons[0] + '，完成后可刷新');
            }
          }
        });
      }
    });
    reg.update();
  }).catch(() => {});

  // controllerchange 只触发一次刷新
  let controllerChangeHandled = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controllerChangeHandled && swUpdateState.refreshTriggered) {
      controllerChangeHandled = true;
      location.reload();
    }
  });
}

// 页面从后台切回前台时检查 SW 更新
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    restorePendingVideoTask();
    if (swUpdateState.hasUpdate && !swUpdateState.refreshTriggered) {
      checkSafeToUpdate();
      if (swUpdateState.isSafeToUpdate) {
        showUpdateNotification('发现新版本，点击刷新更新');
      }
    }
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.getRegistration().then(reg => reg && reg.update());
    }
  }
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
    selectedRecords = [];
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

function validateUrl(url) {
  if (!url || typeof url !== 'string') return false;
  var trimmed = url.trim().toLowerCase();
  // 拒绝危险协议
  if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('vbscript:')) {
    return false;
  }
  // 只允许 http/https
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return false;
  }
  return true;
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
    const apiDomain = document.getElementById('settingsApiDomain').value.trim() || ARK_BASE_URL;
    if (!apiKey) { showToast('请输入 API Key', 'error'); return; }
    // 二次确认：说明会发起一次最小图片生成请求
    if (!confirm('纯前端 PWA 无法在不发起业务请求的情况下可靠验证 API Key。\n\n点击"确定"将发起一次最小图片生成请求来验证连接。\n（使用 test 作为提示词，不会生成实际有用的图片）\n\n是否继续？')) return;
    showLoading('测试连接中...');
    try {
      const result = await testConnection(apiKey, apiDomain);
      const info = document.getElementById('configInfo');
      info.className = 'config-info ' + (result.success ? 'success' : 'error');
      info.textContent = result.message;
      showToast(result.message, result.success ? 'success' : 'error');
    } catch (e) {
      const info = document.getElementById('configInfo');
      info.className = 'config-info error';
      info.textContent = '连接失败: ' + e.message;
      showToast('连接失败: ' + e.message, 'error');
    }
    hideLoading();
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

  // 动态更新上传限制
  if (imgUploadCtrl) {
    imgUploadCtrl.setMax(maxRef);
    const currentCount = imgUploadCtrl.getCount();
    const uploadArea = document.getElementById('imgUploadArea');
    const span = uploadArea ? uploadArea.querySelector('span') : null;
    if (currentCount > maxRef) {
      if (uploadArea) uploadArea.style.borderColor = 'var(--danger)';
      if (span) span.textContent = '已选' + currentCount + '张，当前模型最多' + maxRef + '张，请删除' + (currentCount - maxRef) + '张';
    } else {
      if (uploadArea) uploadArea.style.borderColor = '';
      if (span) span.textContent = '点击选择图片（最多' + maxRef + '张）';
    }
    refreshGenerateButtonState();
  }

  switch (imgMode) {
    case 't2i': refGroup.style.display = 'none'; maxGroup.style.display = 'none'; break;
    case 'i2i': refGroup.style.display = 'block'; maxGroup.style.display = 'none';
      break;
    case 'fusion': refGroup.style.display = 'block'; maxGroup.style.display = 'none';
      break;
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

  // v1.6.2: 先获取 model → mi → caps，再做依赖 caps 的校验
  const model = document.getElementById('imgModel').value;
  const mi = IMAGE_MODELS.find(m => m.id === model);
  if (!mi) return;
  const caps = mi.caps;

  // 最终兜底校验：参考图数量不超限（caps 已定义）
  if ((imgMode === 'i2i' || imgMode === 'fusion') && caps.maxRefImages && imgRefImages.length > caps.maxRefImages) {
    showToast('参考图最多' + caps.maxRefImages + '张，当前' + imgRefImages.length + '张，请删除多余图片', 'warning');
    return;
  }

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

// 图片生成实际执行（失败后不自动重试，防止重复扣费）
async function doImageGenerate(params, prompt, isRetry) {
  const btn = document.getElementById('btnGenImage');
  // 防双击
  if (btn.disabled && !isRetry) return;
  imageGenState.isGenerating = true;
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
      // 请求失败：不自动重试，显示重试按钮
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
      // 网络异常：不自动重试，提示谨慎重试
      panel.innerHTML = '<div class="task-status"><div class="status-text" style="color:#ff4d6d">网络异常</div><div class="status-detail" style="font-size:13px;color:#a0a0b8;margin-top:4px;">网络异常，无法确认服务端是否已完成生成。再次提交可能产生第二次调用费用，请谨慎重试。</div><button class="btn-primary" id="btnRetryImage" style="margin-top:12px;">重试</button></div>';
      document.getElementById('btnRetryImage').onclick = () => doImageGenerate(params, prompt, true);
      showToast('网络异常，请谨慎重试', 'error');
    }
  }
  finally { imageGenState.isGenerating = false; btn.disabled = false; btn.textContent = '生成图片'; imgAbortController = null; }
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
    if (!validateUrl(url)) { showToast('请粘贴有效的网页 URL（以 http/https 开头）', 'error'); return; }
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

      // 使用 DOM API 构建，避免 XSS
      const inner = document.createElement('div');
      inner.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:rgba(108,92,231,0.15);flex-direction:column;gap:2px;';

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '20');
      svg.setAttribute('height', '20');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', '#6c5ce7');
      svg.setAttribute('stroke-width', '2');
      const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      polygon.setAttribute('points', '5 3 19 12 5 21 5 3');
      svg.appendChild(polygon);

      const span = document.createElement('span');
      span.style.cssText = 'font-size:9px;color:var(--text-muted);max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      // 使用 textContent 而非 innerHTML，防止 XSS
      span.textContent = url.length > 40 ? url.substring(0, 37) + '...' : url;

      inner.appendChild(svg);
      inner.appendChild(span);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.dataset.idx = idx;
      removeBtn.textContent = '\u00d7';

      item.appendChild(inner);
      item.appendChild(removeBtn);
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
      // 使用 caps.supportsLastFrame 判断尾帧支持
      const supportsTail = caps.supportsLastFrame !== false;
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
    vidRefVideoUrls = [];
    const rvPreview = document.getElementById('vidRefVideoPreview');
    if (rvPreview) rvPreview.innerHTML = '';
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

// 统一素材校验
function validateVideoMedia(mode, mediaState, caps) {
  if (mode === 't2v') return { valid: true };

  if (mode === 'i2v') {
    const hasFirst = mediaState.firstFrameImages.length > 0;
    const hasTail = mediaState.tailFrameImages.length > 0;
    const hasRefImg = mediaState.refImages.length > 0;
    const hasRefVid = mediaState.refVideoUrls.length > 0;
    const hasRefAud = mediaState.refAudios.length > 0;
    const hasFrame = hasFirst || hasTail;
    const hasRef = hasRefImg || hasRefVid || hasRefAud;

    // 1. 无任何素材
    if (!hasFrame && !hasRef)
      return { valid: false, msg: '请至少添加一种素材' };

    // 2. 首尾帧模式和多模态参考模式不能混用
    if (hasFrame && hasRef)
      return { valid: false, msg: '首帧/尾帧与参考媒体不能同时使用。请保留其中一组，移除另一组后再提交。' };

    // 3. 尾帧不能单独使用
    if (hasTail && !hasFirst)
      return { valid: false, msg: '尾帧不能单独使用，请先添加首帧' };

    // 4. 首帧最多1张
    if (hasFirst && mediaState.firstFrameImages.length > 1)
      return { valid: false, msg: '首帧最多1张图片' };

    // 5. 尾帧最多1张
    if (hasTail && mediaState.tailFrameImages.length > 1)
      return { valid: false, msg: '尾帧最多1张图片' };

    // 6. 当前模型是否支持首帧
    if (hasFirst && (!caps || caps.supportsFirstFrame === false))
      return { valid: false, msg: '当前模型不支持首帧输入' };

    // 7. 当前模型是否支持尾帧
    if (hasTail && (!caps || caps.supportsLastFrame === false))
      return { valid: false, msg: '当前模型不支持尾帧输入' };

    // 8. 模型是否支持参考视频
    if (hasRefVid && (!caps || !caps.referenceVideo))
      return { valid: false, msg: '当前模型不支持参考视频' };

    // 9. 模型是否支持参考音频
    if (hasRefAud && (!caps || !caps.referenceAudio))
      return { valid: false, msg: '当前模型不支持参考音频' };

    // 10. 参考图数量上限
    if (hasRefImg && caps && caps.maxRefImages &&
        mediaState.refImages.length > caps.maxRefImages)
      return { valid: false, msg: '参考图最多' + caps.maxRefImages + '张，当前' + mediaState.refImages.length + '张' };

    // 11. 参考视频数量上限
    if (hasRefVid && caps && caps.maxRefVideos &&
        mediaState.refVideoUrls.length > caps.maxRefVideos)
      return { valid: false, msg: '参考视频最多' + caps.maxRefVideos + '个，当前' + mediaState.refVideoUrls.length + '个' };

    // 12. 参考音频数量上限
    if (hasRefAud && caps && caps.maxRefAudios &&
        mediaState.refAudios.length > caps.maxRefAudios)
      return { valid: false, msg: '参考音频最多' + caps.maxRefAudios + '段，当前' + mediaState.refAudios.length + '段' };

    // 13. 参考音频不能单独使用
    if (hasRefAud && !hasRefImg && !hasRefVid)
      return { valid: false, msg: '参考音频不能单独使用，请至少添加一张参考图或一个参考视频' };

    return { valid: true };
  }

  return { valid: true };
}

async function handleVideoGenerate() {
  const btn = document.getElementById('btnGenVideo');

  // 必须在任何 await 和 try/finally 之前抢占生成锁
  if (videoGenState.isGenerating) return;

  // 检查是否存在有效的待恢复任务（同步操作，不含 await）
  const pendingTask = getValidPendingVideoTask();
  if (pendingTask) {
    showToast('已有未完成的视频任务，请先查询该任务结果', 'warning');
    restorePendingVideoTask();
    return;
  }

  videoGenState.isGenerating = true;

  // 锁抢占后立即设置 UI 禁用状态，避免状态管理散落两处
  if (btn) {
    btn.disabled = true;
    btn.textContent = '提交中...';
  }
  setVideoFormDisabled(true);

  // 跟踪是否已取得 taskId（决定 catch 中走"可恢复"还是"提交异常"分支）
  let submittedTaskId = null;
  let submittedRecordId = null;

  try {
    const config = await Store.getConfig();
    if (!config.apiKey) { showToast('请先配置 API Key', 'warning'); switchPage('settings'); return; }
    const prompt = document.getElementById('vidPrompt').value.trim();
    if (!prompt) { showToast('请输入提示词', 'warning'); return; }

    const model = document.getElementById('vidModel').value;
    const mi = VIDEO_MODELS.find(m => m.id === model);
    if (!mi) return;
    const caps = mi.caps;

    // 统一素材校验
    if (vidMode === 'i2v') {
      const mediaState = {
        firstFrameImages: vidFirstImage,
        tailFrameImages: vidTailImage,
        refImages: vidRefImages,
        refVideoUrls: vidRefVideoUrls,
        refAudios: vidRefAudios
      };
      const validation = validateVideoMedia(vidMode, mediaState, caps);
      if (!validation.valid) {
        showToast(validation.msg, 'warning');
        return;
      }
    }

    // 安全读取种子输入，避免 seedRaw 未定义导致 ReferenceError
    const seedInput = document.getElementById('vidSeed');
    const seedRaw = seedInput ? seedInput.value.trim() : '';
    const parsedSeed = seedRaw === '' ? -1 : Number.parseInt(seedRaw, 10);

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
      seed: Number.isFinite(parsedSeed) ? parsedSeed : -1,
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

    renderVideoTaskStatus('queued', '任务提交中...', 0);

    // 历史记录参数（复用于 pending 记录和成功后更新）
    const historyParams = { model, resolution: params.resolution, ratio: params.ratio, duration: params.duration, seed: params.seed, audio: params.generateAudio, watermark: params.watermark };

    const submitResult = await submitVideoTask(params);
    if (!submitResult.success) { renderVideoTaskStatus('failed', '提交失败: ' + (submitResult.error || ''), 0); showToast('提交失败', 'error'); return; }

    const taskId = submitResult.data?.id;
    if (!taskId) { renderVideoTaskStatus('failed', '未获取到任务ID', 0); return; }

    // 服务端已经接受任务，必须立即进入可恢复状态
    submittedTaskId = taskId;

    // 先保存不依赖本地历史记录的最小恢复信息
    const durablePendingSaved = savePendingVideoTask(taskId, vidMode, prompt, null, historyParams);

    if (!durablePendingSaved) {
      showToast('任务已提交，但浏览器持久化存储不可用，请勿刷新页面，并保留任务ID：' + taskId, 'warning');
    }

    // 再写入本地历史
    const pendingRecord = await Store.addHistory({
      type: 'video', mode: getVidModeLabel(vidMode), prompt, params: historyParams,
      result: [], taskId, status: 'pending'
    });

    if (!pendingRecord || !pendingRecord.id) {
      throw new Error('本地历史记录保存失败');
    }

    submittedRecordId = pendingRecord.id;

    // 历史记录写入成功后，用 recordId 更新恢复信息
    savePendingVideoTask(taskId, vidMode, prompt, submittedRecordId, historyParams);

    window._historyRendered = false;

    showToast('任务已提交，生成中...', 'success');
    if (btn) btn.textContent = '生成中...';
    renderVideoTaskStatus('running', '视频生成中... 预计 1-3 分钟', 5, 0);

    // 改动 3: 并发控制
    window._currentPollingTaskId = taskId;
    const pollResult = await pollVideoTask(taskId, progress => {
      if (window._currentPollingTaskId !== taskId) return; // 被恢复逻辑接管，退出
      const labels = { queued: '排队中...', running: '生成中...', succeeded: '完成', failed: '失败' };
      const percent = Math.min((progress.attempt / 60) * 100, 90);
      renderVideoTaskStatus(progress.status, labels[progress.status] || progress.status, percent, progress.attempt);
    }, 5000, 240);

    if (pollResult.success) {
      const videoUrl = pollResult.data?.content?.video_url;
      const lastFrameUrl = pollResult.data?.content?.last_frame_url;
      if (videoUrl) {
        renderVideoResult(videoUrl, lastFrameUrl);
        showToast('生成成功！', 'success');
        notifyTaskComplete('video', prompt);
        await persistVideoTerminalState({
          taskId, recordId: submittedRecordId, vidMode, prompt, params: historyParams,
          status: 'succeeded', videoUrl, lastFrameUrl
        });
        window._historyRendered = false;
      } else {
        renderVideoTaskStatus('failed', '任务完成但未返回视频URL', 0);
        showToast('任务完成但未返回视频URL', 'error');
        await persistVideoTerminalState({
          taskId, recordId: submittedRecordId, vidMode, prompt, params: historyParams,
          status: 'failed', videoUrl: null, lastFrameUrl: null
        });
      }
      clearPendingVideoTask();
    } else if (pollResult.timeout && pollResult.taskId) {
      renderVideoTimeout(pollResult.taskId, submittedRecordId, { vidMode, prompt, params: historyParams });
      showToast('轮询超时，可重试查询', 'warning');
      if (submittedRecordId) {
        try { await Store.updateHistory(submittedRecordId, { status: 'timeout' }); } catch (_) {}
      }
    } else {
      renderVideoTaskStatus('failed', pollResult.error || '失败', 0);
      showToast('生成失败', 'error');
      await persistVideoTerminalState({
        taskId, recordId: submittedRecordId, vidMode, prompt, params: historyParams,
        status: 'failed', videoUrl: null, lastFrameUrl: null
      });
      clearPendingVideoTask();
    }
  } catch (e) {
    console.error('视频提交异常:', e);
    if (submittedTaskId) {
      // 已取得 taskId 后的异常（通常是轮询网络异常）：进入可恢复状态
      if (submittedRecordId) {
        try { await Store.updateHistory(submittedRecordId, { status: 'timeout' }); } catch (_) {}
      }
      renderVideoTimeout(submittedTaskId, submittedRecordId, { vidMode, prompt: document.getElementById('vidPrompt') ? document.getElementById('vidPrompt').value.trim() : '', params: {} });
      if (!submittedRecordId) {
        showToast('任务已提交，但本地记录保存失败，请保留任务并稍后重新查询', 'warning');
      } else {
        showToast('任务已提交，但查询暂时中断，请稍后重新查询', 'warning');
      }
    } else {
      // 尚未取得 taskId：真正的提交异常
      renderVideoTaskStatus('failed', e.message, 0);
      showToast('视频提交异常：' + e.message, 'error');
    }
  } finally {
    videoGenState.isGenerating = false;
    window._currentPollingTaskId = null;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '生成视频';
    }
    setVideoFormDisabled(false);
  }
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

function renderVideoTimeout(taskId, recordId, taskInfo) {
  // 通过 getValidPendingVideoTask 获取完整信息（如果调用方未传 taskInfo）
  if (!taskInfo) {
    var pending = getValidPendingVideoTask();
    if (pending && pending.taskId === taskId) {
      taskInfo = pending;
    } else {
      taskInfo = { vidMode: 'i2v', prompt: '', params: {} };
    }
  }
  const panel = document.getElementById('vidResultPanel');
  panel.innerHTML = '<div class="task-status"><div class="status-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ffb443" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="6" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><div class="status-text" style="color:#ffb443">轮询超时</div><div class="status-detail">任务ID: ' + taskId + '<br>任务可能仍在生成中</div><button class="btn-primary" id="btnRetryQuery" style="margin-top:12px;">重新查询</button></div>';
  document.getElementById('btnRetryQuery').onclick = async () => {
    const btn = document.getElementById('btnRetryQuery');
    btn.disabled = true; btn.textContent = '查询中...';
    renderVideoTaskStatus('queued', '重新查询中...', 0);
    window._currentPollingTaskId = taskId;
    try {
      const result = await pollVideoTask(taskId, p => {
        if (window._currentPollingTaskId !== taskId) return;
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
          await persistVideoTerminalState({
            taskId, recordId, vidMode: taskInfo.vidMode || 'i2v',
            prompt: taskInfo.prompt || '', params: taskInfo.params || {},
            status: 'succeeded', videoUrl: url, lastFrameUrl: lf
          });
          window._historyRendered = false;
        } else {
          renderVideoTaskStatus('failed', '任务完成但未返回视频URL', 0);
          showToast('任务完成但未返回视频URL', 'error');
          await persistVideoTerminalState({
            taskId, recordId, vidMode: taskInfo.vidMode || 'i2v',
            prompt: taskInfo.prompt || '', params: taskInfo.params || {},
            status: 'failed', videoUrl: null, lastFrameUrl: null
          });
        }
        clearPendingVideoTask();
      } else if (result.timeout && result.taskId) { renderVideoTimeout(result.taskId, recordId, taskInfo); showToast('仍未完成', 'warning'); }
      else {
        renderVideoTaskStatus('failed', result.error || '失败', 0);
        showToast('生成失败', 'error');
        await persistVideoTerminalState({
          taskId, recordId, vidMode: taskInfo.vidMode || 'i2v',
          prompt: taskInfo.prompt || '', params: taskInfo.params || {},
          status: 'failed', videoUrl: null, lastFrameUrl: null
        });
        clearPendingVideoTask();
      }
    } catch (e) {
      console.error('重新查询异常:', e);
      // 网络异常或落盘失败时不清除 pending task，保持可恢复
      if (recordId) {
        try { await Store.updateHistory(recordId, { status: 'timeout' }); } catch (_) {}
      }
      renderVideoTimeout(taskId, recordId, taskInfo);
      showToast('任务已提交，但查询暂时中断，请稍后重新查询', 'warning');
    } finally {
      window._currentPollingTaskId = null;
    }
  };
}

// ============ 待处理任务恢复 ============
function buildPendingVideoTask(taskId, vidModeSnapshot, prompt, recordId, params) {
  return {
    taskId,
    vidMode: vidModeSnapshot,
    prompt: prompt || '',
    recordId: recordId || null,
    params: params || {},
    savedAt: Date.now()
  };
}

function savePendingVideoTask(taskId, vidModeSnapshot, prompt, recordId, params) {
  const task = buildPendingVideoTask(taskId, vidModeSnapshot, prompt, recordId, params);

  window._volatilePendingVideoTask = task;

  let durableSaved = false;
  const raw = JSON.stringify(task);

  try {
    localStorage.setItem('volc_pending_task', raw);
    durableSaved = true;
  } catch (e) {
    console.warn('localStorage 保存待恢复任务失败:', e);
  }

  try {
    sessionStorage.setItem('volc_pending_task', raw);
    durableSaved = true;
  } catch (e) {
    console.warn('sessionStorage 保存待恢复任务失败:', e);
  }

  return durableSaved;
}

function clearPendingVideoTask() {
  try { localStorage.removeItem('volc_pending_task'); } catch (_) {}
  try { sessionStorage.removeItem('volc_pending_task'); } catch (_) {}
  window._volatilePendingVideoTask = null;
}

function getValidPendingVideoTask() {
  const sources = [];
  try { sources.push(localStorage.getItem('volc_pending_task')); } catch (_) {}
  try { sources.push(sessionStorage.getItem('volc_pending_task')); } catch (_) {}
  if (window._volatilePendingVideoTask) {
    sources.push(JSON.stringify(window._volatilePendingVideoTask));
  }

  for (var i = 0; i < sources.length; i++) {
    var raw = sources[i];
    if (!raw) continue;

    try {
      var task = JSON.parse(raw);
      if (!task.taskId || !task.savedAt) {
        clearPendingVideoTask();
        return null;
      }

      if (Date.now() - task.savedAt > 48 * 3600 * 1000) {
        clearPendingVideoTask();
        return null;
      }

      return task;
    } catch (e) {
      clearPendingVideoTask();
      return null;
    }
  }

  return null;
}

async function persistVideoTerminalState(options) {
  var updates = {};
  if (options.videoUrl) {
    updates.result = [options.videoUrl];
    updates.thumbnail = options.videoUrl;
  }
  if (options.lastFrameUrl) {
    updates.lastFrame = options.lastFrameUrl;
  } else {
    updates.lastFrame = null;
  }
  updates.status = options.status;

  var recordId = options.recordId;

  if (recordId) {
    var updateResult = await Store.updateHistory(recordId, updates);
    if (!updateResult) {
      recordId = null;
    }
  }

  if (!recordId) {
    var newRecord = await Store.addHistory({
      type: 'video',
      mode: getVidModeLabel(options.vidMode || 'i2v'),
      prompt: options.prompt || '',
      params: options.params || {},
      taskId: options.taskId,
      status: options.status,
      result: options.videoUrl ? [options.videoUrl] : [],
      lastFrame: options.lastFrameUrl || null,
      thumbnail: options.videoUrl || null
    });

    if (!newRecord || !newRecord.id) {
      throw new Error('视频历史记录保存失败');
    }
    recordId = newRecord.id;
  }

  // 读后验证
  var history = await Store.getHistory();
  var persisted = null;
  if (history && Array.isArray(history)) {
    persisted = history.find(function(item) { return item.taskId === options.taskId; });
  }

  if (!persisted || persisted.status !== options.status) {
    throw new Error('视频历史记录未实际落盘');
  }

  if (options.status === 'succeeded' &&
    (!persisted.result || persisted.result[0] !== options.videoUrl)) {
    throw new Error('视频结果未实际落盘');
  }

  return persisted;
}

async function restorePendingVideoTask() {
  // 改动 3: 重入锁
  if (window._restoringTask) return;
  const taskInfo = getValidPendingVideoTask();
  if (!taskInfo) return;

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
        await persistVideoTerminalState({
          taskId: taskInfo.taskId, recordId: taskInfo.recordId,
          vidMode: taskInfo.vidMode || 'i2v', prompt: taskInfo.prompt || '',
          params: taskInfo.params || {},
          status: 'succeeded', videoUrl: url, lastFrameUrl: lf
        });
        window._historyRendered = false;
      } else {
        renderVideoTaskStatus('failed', '任务完成但未返回视频URL', 0);
        showToast('任务完成但未返回视频URL', 'error');
        await persistVideoTerminalState({
          taskId: taskInfo.taskId, recordId: taskInfo.recordId,
          vidMode: taskInfo.vidMode || 'i2v', prompt: taskInfo.prompt || '',
          params: taskInfo.params || {},
          status: 'failed', videoUrl: null, lastFrameUrl: null
        });
      }
      // 只有本地成功落盘或终态处理成功后，才清除恢复任务
      clearPendingVideoTask();
    } else if (result.timeout && result.taskId) {
      renderVideoTimeout(result.taskId, taskInfo.recordId, taskInfo);
      showToast('任务仍在生成中，可稍后重试', 'warning');
      // 保留 pending task，下次切回来还能恢复
    } else {
      renderVideoTaskStatus('failed', result.error || '失败', 0);
      showToast('生成失败', 'error');
      await persistVideoTerminalState({
        taskId: taskInfo.taskId, recordId: taskInfo.recordId,
        vidMode: taskInfo.vidMode || 'i2v', prompt: taskInfo.prompt || '',
        params: taskInfo.params || {},
        status: 'failed', videoUrl: null, lastFrameUrl: null
      });
      clearPendingVideoTask();
    }
  } catch (e) {
    // 网络异常时不删除待恢复任务，保留 taskId/recordId 和 localStorage 信息
    console.error('恢复任务查询异常:', e);
    if (taskInfo.recordId) {
      try { await Store.updateHistory(taskInfo.recordId, { status: 'timeout' }); } catch (_) {}
    }
    renderVideoTimeout(taskInfo.taskId, taskInfo.recordId, taskInfo);
    showToast('任务已提交，但查询暂时中断，请稍后重新查询', 'warning');
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

  return {
    clear: () => { files = []; renderPreview(); if (onChange) onChange([]); },
    getFiles: () => files.map(f => f.base64),
    setMax: (newMax) => { maxFiles = newMax; },
    getMax: () => maxFiles,
    getCount: () => files.length
  };
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
  const history = (await Store.getHistory()).filter(r => !r._isDeleted);
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

// ============ 选择模式 + 连续播放 变量声明 ============
let isSelectMode = false;
let selectedRecords = []; // 数组，按勾选顺序记录 id
let playlistVideos = [];
let playlistIndex = 0;
let playlistVideoEl = null;
let playlistVideoEl2 = null; // 第二个 video 元素，用于无缝切换
let playlistActiveEl = null; // 当前正在播放的 video 元素
let playlistPreloadedIdx = -1; // 正在预加载的索引

// ============ 清空历史 ============
setTimeout(() => {
  const btn = document.getElementById('btnClearHistory');
  if (btn) btn.onclick = async () => {
    if (confirm('确定清空所有历史记录？')) {
      await Store.clearHistory();
      // 退出选择模式
      if (isSelectMode) { isSelectMode = false; selectedRecords = []; updateSelectModeUI(); }
      renderHistory();
      // Store.clearHistory 在同步开启时已显示详细 toast，此处仅在未开启同步时提示
      if (!(window.SyncManager && SyncManager.isEnabled())) {
        showToast('已清空', 'success');
      }
    }
  };
}, 100);

// 离线检测
window.addEventListener('online', () => { document.getElementById('offlineIndicator').style.display = 'none'; });
window.addEventListener('offline', () => { document.getElementById('offlineIndicator').style.display = 'block'; });

// 选择模式 + 连续播放
initSelectMode();

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
function initSelectMode() {
  const toggleBtn = document.getElementById('btnToggleSelect');
  const batchBar = document.getElementById('batchActionsBar');

  toggleBtn.onclick = () => {
    isSelectMode = !isSelectMode;
    selectedRecords = [];
    updateSelectModeUI();
  };

  // 全选
  document.getElementById('btnSelectAll').onclick = async () => {
    const history = (await Store.getHistory()).filter(r => !r._isDeleted);
    const videos = history.filter(r => r.type === 'video' && r.result?.[0]);
    if (selectedRecords.length === videos.length) {
      selectedRecords = [];
    } else {
      selectedRecords = videos.map(r => r.id);
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
  document.getElementById('batchSelectedCount').textContent = '已选 ' + selectedRecords.length + ' 个';

  // 重新渲染历史记录以更新选中状态
  renderHistorySelectMode();
}

async function renderHistorySelectMode() {
  const history = (await Store.getHistory()).filter(r => !r._isDeleted);
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
    if (selectedRecords.includes(r.id)) card.classList.add('selected');

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

    const selectOrder = selectedRecords.indexOf(r.id);
    const orderBadge = selectOrder >= 0 ? '<span class="select-order-badge">' + (selectOrder + 1) + '</span>' : '';

    card.innerHTML = '<input type="checkbox" class="select-checkbox" ' + (selectedRecords.includes(r.id) ? 'checked' : '') + '>' + orderBadge +
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
        const idx = selectedRecords.indexOf(r.id);
        if (idx >= 0) {
          selectedRecords.splice(idx, 1);
        } else {
          selectedRecords.push(r.id);
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
        selectedRecords.push(r.id);
      } else {
        const idx = selectedRecords.indexOf(r.id);
        if (idx >= 0) selectedRecords.splice(idx, 1);
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
      const idx = selectedRecords.indexOf(r.id);
      if (idx >= 0) selectedRecords.splice(idx, 1);
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
  playlistVideoEl2 = document.getElementById('playlistVideo2');
  playlistActiveEl = playlistVideoEl;

  document.getElementById('btnPlaylistClose').onclick = closePlaylist;
  document.getElementById('btnPlaylistPrev').onclick = playPrev;
  document.getElementById('btnPlaylistNext').onclick = playNext;
  document.getElementById('btnPlaylistPlayPause').onclick = togglePlayPause;

  // 当前视频播完 → 切到预加载好的下一段
  const onEnded = () => {
    if (playlistIndex < playlistVideos.length - 1) {
      swapToNextVideo();
    } else {
      closePlaylist();
      showToast('播放列表已全部播完', 'success');
    }
  };
  playlistVideoEl.addEventListener('ended', onEnded);
  playlistVideoEl2.addEventListener('ended', onEnded);

  // 播放/暂停按钮图标
  const onPlay = () => { document.getElementById('btnPlaylistPlayPause').textContent = '⏸'; };
  const onPause = () => { document.getElementById('btnPlaylistPlayPause').textContent = '▶'; };
  playlistVideoEl.addEventListener('play', onPlay);
  playlistVideoEl2.addEventListener('play', onPlay);
  playlistVideoEl.addEventListener('pause', onPause);
  playlistVideoEl2.addEventListener('pause', onPause);

  // 进度条联动
  const seek = document.getElementById('playlistSeek');
  const currentTimeEl = document.getElementById('playlistCurrentTime');
  const durationEl = document.getElementById('playlistDuration');

  function fmtTime(t) {
    if (!t || isNaN(t)) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  const onTimeUpdate = () => {
    const el = playlistActiveEl;
    if (!el || !el.duration) return;
    seek.value = (el.currentTime / el.duration) * 100;
    currentTimeEl.textContent = fmtTime(el.currentTime);
  };
  const onMetaLoaded = () => {
    const el = playlistActiveEl;
    if (!el) return;
    durationEl.textContent = fmtTime(el.duration);
  };
  playlistVideoEl.addEventListener('timeupdate', onTimeUpdate);
  playlistVideoEl2.addEventListener('timeupdate', onTimeUpdate);
  playlistVideoEl.addEventListener('loadedmetadata', onMetaLoaded);
  playlistVideoEl2.addEventListener('loadedmetadata', onMetaLoaded);

  // 用户拖进度条
  seek.addEventListener('input', () => {
    const el = playlistActiveEl;
    if (!el || !el.duration) return;
    el.currentTime = (seek.value / 100) * el.duration;
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
  const history = (await Store.getHistory()).filter(r => !r._isDeleted);
  // 按 selectedRecords 数组顺序（即用户勾选顺序）获取视频
  const selected = selectedRecords
    .map(id => history.find(r => r.id === id))
    .filter(r => r && r.result?.[0]);
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
  // 设置当前活跃 video 元素的源并播放
  playlistActiveEl.src = v.url;
  playlistActiveEl.load();
  playlistActiveEl.play().catch(() => {});
  updatePlaylistUI();
  // 预加载下一段
  preloadNextVideo(idx + 1);
}

// 预加载下一段视频到非活跃的 video 元素
function preloadNextVideo(idx) {
  if (idx < 0 || idx >= playlistVideos.length) {
    playlistPreloadedIdx = -1;
    return;
  }
  const v = playlistVideos[idx];
  const inactiveEl = (playlistActiveEl === playlistVideoEl) ? playlistVideoEl2 : playlistVideoEl;
  // 只设置 src，不播放，让浏览器自动缓冲
  inactiveEl.src = v.url;
  inactiveEl.load();
  // load() 后浏览器会自动开始缓冲，不需要 play()
  playlistPreloadedIdx = idx;
}

// 无缝切换：当前视频 ended 时，切换到已经预加载好的另一个 video 元素
function swapToNextVideo() {
  const nextIdx = playlistIndex + 1;
  if (nextIdx >= playlistVideos.length) return;

  const currentEl = playlistActiveEl;
  const nextEl = (currentEl === playlistVideoEl) ? playlistVideoEl2 : playlistVideoEl;

  // 如果预加载的就是下一段，直接切换
  if (playlistPreloadedIdx === nextIdx && nextEl.src) {
    // 暂停当前
    currentEl.pause();
    currentEl.removeAttribute('src');
    currentEl.load();
    currentEl.style.display = 'none';

    // 显示并播放下一段
    nextEl.style.display = '';
    playlistActiveEl = nextEl;
    playlistIndex = nextIdx;
    nextEl.play().catch(() => {});
    updatePlaylistUI();
    // 预加载下下一段
    preloadNextVideo(nextIdx + 1);
  } else {
    // 没有预加载好，退回到普通加载
    playlistIndex = nextIdx;
    loadPlaylistVideo(nextIdx);
  }
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
    // 如果下一段已经预加载好了，用无缝切换
    if (playlistPreloadedIdx === playlistIndex + 1) {
      swapToNextVideo();
    } else {
      playlistIndex++;
      loadPlaylistVideo(playlistIndex);
    }
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
  if (playlistActiveEl.paused) {
    playlistActiveEl.play().catch(() => {});
  } else {
    playlistActiveEl.pause();
  }
}

function closePlaylist() {
  playlistVideoEl.pause();
  playlistVideoEl2.pause();
  playlistVideoEl.removeAttribute('src');
  playlistVideoEl2.removeAttribute('src');
  playlistVideoEl.load();
  playlistVideoEl2.load();
  playlistVideoEl.style.display = '';
  playlistVideoEl2.style.display = 'none';
  playlistActiveEl = playlistVideoEl;
  playlistPreloadedIdx = -1;
  document.getElementById('playlistPlayer').style.display = 'none';
  document.body.style.overflow = '';
}

// ============ 跨设备同步 ============
async function initSync() {
  const config = Store.getSyncConfig();
  if (config.url && config.anonKey && config.syncKey) {
    await SyncManager.configure(config.url, config.anonKey, config.syncKey);
    // v1.6.1: 检查数据库状态后再决定是否同步
    var dbState = null;
    try { dbState = await SyncManager.checkDbState(); } catch (e) { dbState = 'network_error'; }
    updateSyncStatus(dbState);

    if (dbState === 'ready') {
      // 数据库完全就绪：执行完整同步
      await syncHistoryFromCloud();
      try { await SyncManager.retryPendingSync(); } catch (e) { console.warn('重试同步失败: ', e); }
    } else if (dbState === 'constraint_not_ready' || dbState === 'migration_required') {
      // schema 存在但约束/迁移未完成：只拉取云端记录，不写入
      console.warn('数据库状态: ' + dbState + '，仅拉取云端记录，不执行写入同步');
      try { await syncHistoryFromCloud(true); } catch (e) { console.warn('拉取历史记录失败: ', e); }
    } else if (dbState === 'auth_error') {
      console.warn('数据库认证失败，跳过云同步');
    } else {
      // schema 未就绪或网络错误：不执行云端同步
      console.warn('数据库状态: ' + dbState + '，跳过云同步，本地历史正常使用');
    }
  }
}

// mergeCloudHistory 从 merge-cloud-history.js 加载（纯函数，可独立测试）
// syncHistoryFromCloud 调用该函数后再保存数据

// readOnly = true 时只拉取云端记录合并到本地，不向上行写入
async function syncHistoryFromCloud(readOnly) {
  if (!SyncManager.isEnabled()) return;
  try {
    const cloudRecords = await SyncManager.pullHistory();
    const localHistory = await Store.getHistory();

    var dbState = null;
    try { dbState = SyncManager._dbState; } catch (e) {}

    var result = mergeCloudHistory(localHistory, cloudRecords, {
      readOnly: readOnly,
      dbState: dbState
    });

    var needSave = result.addedCount > 0 || result.updatedCount > 0;

    // 上传本地有但云端没有的记录（仅在非 readOnly 模式下）
    if (!readOnly) {
      for (var i = 0; i < result.history.length; i++) {
        var rec = result.history[i];
        if (rec._isDeleted) continue;
        if (!rec.recordUid || result.cloudRecordUids.has(rec.recordUid)) continue;
        if (!rec._syncId) {
          try {
            var upResult = await SyncManager.upsertHistory(rec);
            if (upResult) {
              rec._syncId = upResult.syncId;
              rec._cloudUpdatedAt = upResult.cloudUpdatedAt;
              rec._syncPending = false;
              needSave = true;
            }
          } catch (e) {
            console.warn('上传本地记录失败: ', e);
            rec._syncPending = true;
            needSave = true;
          }
        }
      }
    } else {
      // readOnly 模式：标记未同步的记录
      for (var i = 0; i < result.history.length; i++) {
        var rec = result.history[i];
        if (rec._isDeleted) continue;
        if (!rec.recordUid || result.cloudRecordUids.has(rec.recordUid)) continue;
        if (!rec._syncId) {
          rec._syncPending = true;
          needSave = true;
        }
      }
    }

    result.history.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    if (result.history.length > 500) result.history.length = 500;
    if (needSave) {
      await Store.saveHistory(result.history);
      window._historyRendered = false;
      if (document.getElementById('page-history')?.classList.contains('active')) {
        renderHistory();
        window._historyRendered = true;
      }
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
      // v1.6.1: 保存后检查数据库状态
      var dbState = null;
      try { dbState = await SyncManager.checkDbState(); } catch (e) { dbState = 'network_error'; }
      updateSyncStatus(dbState);
      if (dbState === 'ready') {
        showToast('同步设置已保存，正在同步...', 'success');
        await syncHistoryFromCloud();
        try { await SyncManager.retryPendingSync(); } catch (e) { console.warn('重试同步失败: ', e); }
        showToast('同步完成', 'success');
      } else if (dbState === 'schema_not_ready') {
        showToast('同步已保存，但 Supabase 数据库尚未完成阶段A升级。本地历史正常使用，待数据库升级后自动同步', 'warning');
      } else if (dbState === 'auth_error') {
        showToast('同步已保存，但认证失败。请检查 Supabase URL 和 Anon Key 是否正确', 'error');
      } else if (dbState === 'network_error') {
        showToast('同步已保存，但无法连接到 Supabase。请检查网络和 URL', 'error');
      } else if (dbState === 'migration_required') {
        showToast('同步已保存，但数据库存在未迁移的记录。请在设置页执行数据迁移', 'warning');
      } else if (dbState === 'constraint_not_ready') {
        showToast('同步已保存，但唯一约束尚未建立。请先完成数据迁移和阶段B SQL', 'warning');
      } else {
        showToast('同步已保存，但数据库连接异常 (' + dbState + ')。本地历史正常使用', 'warning');
      }
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

  // 迁移预览
  document.getElementById('btnMigratePreview').onclick = async () => {
    if (!SyncManager.isEnabled()) { showToast('请先保存同步设置', 'warning'); return; }
    const btn = document.getElementById('btnMigratePreview');
    btn.disabled = true; btn.textContent = '预览中...';
    const statusEl = document.getElementById('migrationStatus');
    statusEl.textContent = '正在扫描本地和云端记录...';
    window._migratingData = true;
    try {
      const report = await SyncManager.migrateHistoryData({ preview: true });
      if (report.success) {
        var lines = [];
        if (report.dbState) lines.push('数据库状态: <strong>' + report.dbState + '</strong>');
        lines.push('本地记录: ' + report.localTotal + ' 条');
        if (report.localMissingRecordUid > 0) lines.push('需补全 recordUid: ' + report.localMissingRecordUid + ' 条');
        if (report.localMissingUpdatedAt > 0) lines.push('需补全 updatedAt: ' + report.localMissingUpdatedAt + ' 条');
        lines.push('云端记录: ' + report.cloudTotal + ' 条');
        if (report.cloudMissingRecordUid > 0) lines.push('云端缺 record_uid: ' + report.cloudMissingRecordUid + ' 条');
        lines.push('唯一匹配并沿用本地 recordUid: ' + report.existingUidMatched + ' 条');
        lines.push('预计 PATCH record_uid (匹配本地): ' + report.predictedNullUidPatch + ' 条');
        if (report.predictedIndependentUidPatch > 0) {
          lines.push('无法匹配、将分配独立 recordUid: ' + report.predictedIndependentUidPatch + ' 条');
        }
        if (report.conflictCloudPreserved > 0) {
          lines.push('<span style="color:#ffb443;">多候选冲突、将独立保留: ' + report.conflictCloudPreserved + ' 条</span>');
        }
        if (report.cloudDuplicates > 0) lines.push('已有 record_uid 重复组: ' + report.cloudDuplicates + ' 组（需删除 ' + report.cloudToDelete + ' 条）');
        if (report.cloudOldDuplicates > 0) lines.push('旧版 taskId 重复组: ' + report.cloudOldDuplicates + ' 组（需删除 ' + report.cloudOldDupToDelete + ' 条）');
        if (report.uncertainMatches > 0) lines.push('<span style="color:#ffb443;">多候选内容冲突: ' + report.uncertainMatches + ' 条（不自动匹配、不自动删除，独立补UID保留）</span>');
        if (report.predictedDuplicateDelete > 0) lines.push('明确待删除旧重复: ' + report.predictedDuplicateDelete + ' 条');
        if (report.pendingUpload > 0) lines.push('<span style="color:#3a8aff;">待阶段B约束完成后上传: ' + report.pendingUpload + ' 条</span>');
        lines.push('<strong>迁移后预计 record_uid 为空: ' + report.nullRecordUidAfter + ' 条</strong>');
        if (report.errors.length > 0) lines.push('错误: ' + report.errors.length + ' 条');
        // v1.6.4: 只有预计空值为 0 时才允许执行迁移
        if (report.nullRecordUidAfter === 0) {
          statusEl.innerHTML = lines.join('<br>') + '<br><span style="color:#00d4aa;font-size:12px;">预计空值为 0，可以执行迁移</span>';
          document.getElementById('btnMigrateExecute').disabled = false;
        } else {
          statusEl.innerHTML = lines.join('<br>') + '<br><span style="color:#ffb443;font-size:12px;">预计空值不为 0，请检查错误后重新预览</span>';
          document.getElementById('btnMigrateExecute').disabled = true;
        }
      } else {
        statusEl.innerHTML = '<span style="color:#ff4d6d;">预览失败</span><br>' + report.errors.join('<br>');
      }
    } catch (e) {
      statusEl.innerHTML = '<span style="color:#ff4d6d;">预览异常: ' + e.message + '</span>';
    }
    window._migratingData = false;
    btn.disabled = false; btn.textContent = '预览迁移';
  };

  // 迁移执行
  document.getElementById('btnMigrateExecute').onclick = async () => {
    if (!SyncManager.isEnabled()) { showToast('请先保存同步设置', 'warning'); return; }
    if (!confirm('确认执行迁移？这将修改本地和云端数据。建议先完成预览确认。')) return;
    const btn = document.getElementById('btnMigrateExecute');
    btn.disabled = true; btn.textContent = '迁移中...';
    const previewBtn = document.getElementById('btnMigratePreview');
    previewBtn.disabled = true;
    const statusEl = document.getElementById('migrationStatus');
    statusEl.textContent = '正在执行迁移...';
    window._migratingData = true;
    try {
      const report = await SyncManager.migrateHistoryData({ preview: false });
      if (report.success) {
        var lines = [];
        lines.push('<span style="color:#00d4aa;font-weight:600;">迁移执行完成</span>');
        lines.push('本地: ' + report.localTotal + ' 条');
        lines.push('云端: ' + report.cloudTotal + ' 条');
        lines.push('唯一匹配沿用本地 recordUid: ' + report.existingUidMatched + ' 条');
        lines.push('PATCH record_uid (匹配): 预计 ' + report.predictedNullUidPatch + '，成功 ' + report.successfulNullUidPatch + '，失败 ' + report.failedNullUidPatch);
        if (report.predictedIndependentUidPatch > 0) {
          lines.push('独立补 UID: 预计 ' + report.predictedIndependentUidPatch + '，成功 ' + report.successfulIndependentUidPatch + '，失败 ' + report.failedIndependentUidPatch);
        }
        if (report.cloudToDelete > 0 || report.cloudOldDupToDelete > 0) {
          lines.push('删除重复: 预计 ' + report.predictedDuplicateDelete + '，成功 ' + report.successfulDuplicateDelete + '，失败 ' + report.failedDuplicateDelete);
        }
        if (report.conflictCloudPreserved > 0) lines.push('<span style="color:#ffb443;">多候选冲突独立保留: ' + report.conflictCloudPreserved + ' 条</span>');
        if (report.uncertainMatches > 0) lines.push('<span style="color:#ffb443;">多候选内容冲突: ' + report.uncertainMatches + ' 条（已独立补UID保留）</span>');
        if (report.pendingUpload > 0) lines.push('<span style="color:#3a8aff;">待阶段B约束完成后上传: ' + report.pendingUpload + ' 条</span>');
        lines.push('迁移后预计空值: ' + report.nullRecordUidAfter + ' 条');
        if (report.actualNullRecordUid >= 0) {
          lines.push('<strong>执行后实际查询 record_uid 为空: ' + report.actualNullRecordUid + ' 条</strong>');
          var hasFailures = report.failedNullUidPatch > 0 || report.failedDuplicateDelete > 0 || report.failedIndependentUidPatch > 0;
          if (report.actualNullRecordUid === 0 && !hasFailures) {
            lines.push('<span style="color:#00d4aa;">阶段A迁移完成，可以准备阶段B约束</span>');
          } else if (report.actualNullRecordUid === 0 && hasFailures) {
            lines.push('<span style="color:#ffb443;">实际空值为 0，但存在失败操作，请检查错误后再确认</span>');
          } else {
            lines.push('<span style="color:#ff4d6d;">仍有 ' + report.actualNullRecordUid + ' 条实际空值，不可执行阶段B SQL</span>');
          }
        } else {
          lines.push('<span style="color:#ff4d6d;">执行后查询实际空值失败，不得执行 NOT NULL 或 UNIQUE</span>');
        }
        if (report.errors.length > 0) {
          lines.push('<span style="color:#ffb443;">错误: ' + report.errors.length + ' 条</span>');
          for (var i = 0; i < Math.min(report.errors.length, 5); i++) {
            lines.push('<span style="font-size:11px;color:var(--text-muted);">' + report.errors[i] + '</span>');
          }
        }
        statusEl.innerHTML = lines.join('<br>');
        showToast('迁移完成', 'success');
        // v1.6.1: 清除数据库状态缓存并刷新显示
        SyncManager.clearDbStateCache();
        var newDbState = null;
        try { newDbState = await SyncManager.checkDbState(); } catch (e) { newDbState = 'network_error'; }
        updateSyncStatus(newDbState);
        // 刷新历史列表
        window._historyRendered = false;
        if (document.getElementById('page-history')?.classList.contains('active')) {
          renderHistory();
          window._historyRendered = true;
        }
      } else {
        statusEl.innerHTML = '<span style="color:#ff4d6d;">迁移失败</span><br>' + report.errors.join('<br>');
        showToast('迁移失败', 'error');
      }
    } catch (e) {
      statusEl.innerHTML = '<span style="color:#ff4d6d;">迁移异常: ' + e.message + '</span>';
      showToast('迁移异常: ' + e.message, 'error');
    }
    window._migratingData = false;
    btn.textContent = '执行迁移';
    // 每次执行结束后都必须重新预览，禁止残留可执行状态
    btn.disabled = true;
    previewBtn.disabled = false;
    previewBtn.textContent = '预览迁移';
  };
}

function updateMigrationUI(dbState) {
  var migSection = document.getElementById('migrationSection');
  var migActions = document.getElementById('migrationActions');
  var migStatus = document.getElementById('migrationStatus');
  var migHint = document.getElementById('migrationHint');
  var previewBtn = document.getElementById('btnMigratePreview');
  var executeBtn = document.getElementById('btnMigrateExecute');
  if (!migSection) return;

  // 默认隐藏
  migSection.style.display = 'none';
  if (migActions) migActions.style.display = 'none';
  if (previewBtn) { previewBtn.disabled = false; previewBtn.textContent = '预览迁移'; }
  if (executeBtn) { executeBtn.disabled = true; executeBtn.textContent = '执行迁移'; }

  if (!SyncManager.isEnabled()) {
    // sync 未开启：整个迁移区域隐藏
    return;
  }

  switch (dbState) {
    case 'migration_required':
      migSection.style.display = 'block';
      if (migActions) migActions.style.display = 'flex';
      if (migHint) migHint.textContent = '检测到旧版历史数据，请先预览确认，再执行一次迁移。';
      if (migStatus) {
        migStatus.innerHTML = '<span style="color:#ffb443;">数据库存在未迁移的记录，请执行迁移</span>';
      }
      if (executeBtn) executeBtn.disabled = true;
      break;

    case 'constraint_not_ready':
      migSection.style.display = 'block';
      if (migActions) migActions.style.display = 'none';
      if (migHint) migHint.textContent = '历史数据迁移已完成，尚待完成数据库阶段 B 约束，请勿重复执行迁移。';
      if (migStatus) {
        migStatus.innerHTML = '<span style="color:#ffb443;">迁移已完成，等待阶段 B 约束</span>';
      }
      break;

    case 'ready':
      migSection.style.display = 'block';
      if (migActions) migActions.style.display = 'none';
      if (migHint) migHint.textContent = '历史数据迁移已完成，后续无需重复操作。';
      if (migStatus) {
        migStatus.innerHTML = '<span style="color:#00d4aa;font-weight:600;">迁移已完成，数据库已就绪</span>';
      }
      break;

    case 'schema_not_ready':
      migSection.style.display = 'block';
      if (migActions) migActions.style.display = 'none';
      if (migHint) migHint.textContent = '数据库尚未完成阶段 A 升级，迁移功能暂不可用。';
      if (migStatus) {
        migStatus.innerHTML = '<span style="color:#ff4d6d;">数据库未升级，迁移不可用</span>';
      }
      break;

    default:
      // auth_error, network_error, 空值或未知状态：隐藏迁移区域
      migSection.style.display = 'none';
      break;
  }
}

function updateSyncStatus(dbState) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  if (SyncManager.isEnabled()) {
    var stateText = '';
    var stateColor = '#00d4aa';
    if (!dbState) {
      dbState = SyncManager._dbState;
    }
    if (dbState === 'schema_not_ready') {
      stateText = '（数据库未升级）';
      stateColor = '#ff4d6d';
    } else if (dbState === 'auth_error') {
      stateText = '（认证失败，请检查 URL 和 Key）';
      stateColor = '#ff4d6d';
    } else if (dbState === 'migration_required') {
      stateText = '（待数据迁移）';
      stateColor = '#ffb443';
    } else if (dbState === 'constraint_not_ready') {
      stateText = '（待建立唯一约束）';
      stateColor = '#ffb443';
    } else if (dbState === 'ready') {
      stateText = '';
      stateColor = '#00d4aa';
    } else if (dbState === 'network_error') {
      stateText = '（数据库连接异常）';
      stateColor = '#ff4d6d';
    }
    el.textContent = '同步已开启' + stateText;
    el.style.color = stateColor;
  } else {
    el.textContent = '同步未开启';
    el.style.color = '#a0a0b8';
  }
  updateMigrationUI(dbState);
}

window.updateMigrationUI = updateMigrationUI;
window.updateSyncStatus = updateSyncStatus;
});