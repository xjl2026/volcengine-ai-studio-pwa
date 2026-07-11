// 应用主逻辑 - PWA 移动版

let imgMode = 't2i';
let vidMode = 't2v'; // t2v / i2v
let imgRefImages = [];
let vidFirstImage = [];
let vidTailImage = [];
let vidRefImages = [];
let imgUploadCtrl = null;
let vidFirstUploadCtrl = null;
let vidTailUploadCtrl = null;
let vidRefUploadCtrl = null;

document.addEventListener('DOMContentLoaded', async () => {
  initNav();
  initImagePage();
  initVideoPage();
  initSettingsPage();
  await loadConfig();
  await updateApiStatus();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // 恢复未完成的视频任务
  restorePendingVideoTask();
  // 监听页面可见性变化（手机切后台再切回来）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      restorePendingVideoTask();
    }
  });
});

// ============ 导航 ============
function initNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.onclick = () => switchPage(item.dataset.page);
  });
}

function switchPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const page = document.getElementById('page-' + name);
  const nav = document.querySelector('.nav-item[data-page="' + name + '"]');
  if (page) page.classList.add('active');
  if (nav) nav.classList.add('active');
  // 历史记录只在首次进入时渲染，避免每次切换都重新加载缩略图
  if (name === 'history' && !window._historyRendered) {
    renderHistory();
    window._historyRendered = true;
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

  const btn = document.getElementById('btnGenImage');
  btn.disabled = true; btn.textContent = '生成中...';
  showLoading('正在生成图片...');

  try {
    const result = await generateImage(params);
    hideLoading();
    if (result.success && result.data) {
      const images = (result.data.data || []).map(i => i.url).filter(Boolean);
      if (images.length > 0) {
        renderImageResults(images);
        showToast('生成成功！', 'success');
        notifyTaskComplete('image', prompt);
        await Store.addHistory({ type: 'image', mode: getImgModeLabel(imgMode), prompt, params: { model, size: params.size }, result: images });
        window._historyRendered = false; // 有新记录，标记需要重新渲染
      } else { showToast('未返回图片数据', 'warning'); }
    } else { showToast('失败: ' + (result.error || ''), 'error'); }
  } catch (e) { hideLoading(); showToast('错误: ' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '生成图片'; }
}

function getImgModeLabel(m) { return { t2i: '文生图', i2i: '图生图', fusion: '多图融合', sequential: '组图' }[m] || m; }

function renderImageResults(images) {
  const panel = document.getElementById('imgResultPanel');
  panel.innerHTML = '<div class="result-content"></div>';
  const content = panel.querySelector('.result-content');
  images.forEach((url, idx) => {
    const item = document.createElement('div');
    item.className = 'result-item';
    item.innerHTML = '<img src="' + url + '"><div class="result-meta">图片 ' + (idx+1) + ' / ' + images.length + '</div><div class="result-actions"><a class="btn-secondary" href="' + url + '" download>下载</a><button class="btn-secondary copy-btn" data-url="' + url + '">复制链接</button></div>';
    content.appendChild(item);
    item.querySelector('img').onclick = () => window.open(url);
    item.querySelector('.copy-btn').onclick = () => { navigator.clipboard.writeText(url); showToast('已复制', 'success'); };
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
  updateVideoModelUI(); updateVideoModeUI();
  document.getElementById('btnGenVideo').onclick = handleVideoGenerate;

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
  if (parseInt(dur.value) > mi.durationRange[1] || parseInt(dur.value) < mi.durationRange[0]) dur.value = 5;

  document.getElementById('vidAudioGroup').style.display = caps.generateAudio ? 'block' : 'none';
  document.getElementById('vidSeedGroup').style.display = caps.seed ? 'block' : 'none';
  document.getElementById('vidFramesGroup').style.display = caps.frames ? 'block' : 'none';
  document.getElementById('vidDraftGroup').style.display = caps.draft ? 'block' : 'none';
  document.getElementById('vidServiceTierGroup').style.display = caps.serviceTier ? 'block' : 'none';
  updateCameraFixedVisibility(caps);

  // 图生视频模式下，参考图区域按模型能力显示
  const refGroup = document.getElementById('vidRefImageGroup');
  if (vidMode === 'i2v' && caps.referenceImage) {
    refGroup.style.display = 'block';
  } else {
    refGroup.style.display = 'none';
  }
}

function updateCameraFixedVisibility(caps) {
  document.getElementById('vidCameraFixedGroup').style.display = (caps && caps.cameraFixed && vidMode === 't2v') ? 'block' : 'none';
}

function updateVideoModeUI() {
  const ff = document.getElementById('vidFirstFrameGroup');
  const tf = document.getElementById('vidTailFrameGroup');
  const rf = document.getElementById('vidRefImageGroup');
  ff.style.display = 'none'; tf.style.display = 'none'; rf.style.display = 'none';

  if (vidMode === 'i2v') {
    ff.style.display = 'block';
    tf.style.display = 'block';
    const model = document.getElementById('vidModel').value;
    const mi = VIDEO_MODELS.find(m => m.id === model);
    if (mi && mi.caps.referenceImage) rf.style.display = 'block';
  } else {
    if (vidFirstUploadCtrl) vidFirstUploadCtrl.clear();
    if (vidTailUploadCtrl) vidTailUploadCtrl.clear();
    if (vidRefUploadCtrl) vidRefUploadCtrl.clear();
  }
  const model = document.getElementById('vidModel').value;
  const mi = VIDEO_MODELS.find(m => m.id === model);
  if (mi) updateCameraFixedVisibility(mi.caps);
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

  const params = {
    mode: vidMode, model, prompt,
    firstFrameImages: vidMode === 'i2v' && vidFirstImage.length > 0 ? vidFirstImage : undefined,
    tailFrameImages: vidMode === 'i2v' && vidTailImage.length > 0 ? vidTailImage : undefined,
    refImages: vidMode === 'i2v' && vidRefImages.length > 0 ? vidRefImages : undefined,
    resolution: document.getElementById('vidResolution').value,
    ratio: document.getElementById('vidRatio').value,
    duration: document.getElementById('vidDuration').value,
    seed: parseInt(document.getElementById('vidSeed').value) || -1,
    generateAudio: document.getElementById('vidGenerateAudio').checked,
    watermark: document.getElementById('vidWatermark').checked,
    returnLastFrame: document.getElementById('vidReturnLastFrame').checked,
    cameraFixed: document.getElementById('vidCameraFixed') ? document.getElementById('vidCameraFixed').checked : false,
    frames: document.getElementById('vidFrames') ? document.getElementById('vidFrames').value : '',
    draft: document.getElementById('vidDraft') ? document.getElementById('vidDraft').checked : false,
    serviceTier: document.getElementById('vidServiceTier') ? document.getElementById('vidServiceTier').value : 'default',
    caps
  };

  const btn = document.getElementById('btnGenVideo');
  btn.disabled = true; btn.textContent = '提交中...';
  renderVideoTaskStatus('queued', '任务提交中...', 0);

  try {
    const submitResult = await submitVideoTask(params);
    if (!submitResult.success) { renderVideoTaskStatus('failed', '提交失败: ' + (submitResult.error || ''), 0); showToast('提交失败', 'error'); return; }

    const taskId = submitResult.data?.id;
    if (!taskId) { renderVideoTaskStatus('failed', '未获取到任务ID', 0); return; }

    // 保存任务到 localStorage，防止切后台丢失
    savePendingVideoTask(taskId, vidMode);

    showToast('任务已提交，生成中...', 'success');
    btn.textContent = '生成中...';
    renderVideoTaskStatus('running', '视频生成中... 预计 1-3 分钟', 5, 0);

    const pollResult = await pollVideoTask(taskId, progress => {
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
        await Store.addHistory({ type: 'video', mode: getVidModeLabel(vidMode), prompt, params: {}, result: [videoUrl], thumbnail: videoUrl });
        window._historyRendered = false;
      } else { renderVideoTaskStatus('succeeded', '完成但未找到视频URL', 100); }
      clearPendingVideoTask();
    } else if (pollResult.timeout && pollResult.taskId) {
      renderVideoTimeout(pollResult.taskId);
      showToast('轮询超时，可重试查询', 'warning');
      // 保留 pending task
    } else {
      renderVideoTaskStatus('failed', pollResult.error || '失败', 0);
      showToast('生成失败', 'error');
      clearPendingVideoTask();
    }
  } catch (e) {
    renderVideoTaskStatus('failed', e.message, 0);
    showToast('错误: ' + e.message, 'error');
  } finally { btn.disabled = false; btn.textContent = '生成视频'; }
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
  let html = '<div class="result-content"><div class="result-item"><video src="' + url + '" controls autoplay loop></video><div class="result-actions"><a class="btn-secondary" href="' + url + '" download>下载视频</a><button class="btn-secondary copy-btn" data-url="' + url + '">复制链接</button></div></div>';
  if (lastFrameUrl) html += '<div class="last-frame-preview"><div class="last-frame-label">尾帧图</div><img src="' + lastFrameUrl + '"></div>';
  html += '</div>';
  panel.innerHTML = html;
  panel.querySelector('.copy-btn').onclick = () => { navigator.clipboard.writeText(url); showToast('已复制', 'success'); };
}

function renderVideoTimeout(taskId) {
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
        if (url) { renderVideoResult(url, lf); showToast('生成成功！', 'success'); await Store.addHistory({ type: 'video', mode: '视频', params: {}, result: [url], thumbnail: url }); }
        else renderVideoTaskStatus('succeeded', '完成但未找到URL', 100);
        clearPendingVideoTask();
      } else if (result.timeout && result.taskId) { renderVideoTimeout(result.taskId); showToast('仍未完成', 'warning'); }
      else { renderVideoTaskStatus('failed', result.error || '失败', 0); clearPendingVideoTask(); }
    } catch (e) { renderVideoTaskStatus('failed', e.message, 0); }
  };
}

// ============ 待处理任务恢复 ============
function savePendingVideoTask(taskId, vidModeSnapshot) {
  localStorage.setItem('volc_pending_task', JSON.stringify({
    taskId, vidMode: vidModeSnapshot, savedAt: Date.now()
  }));
}

function clearPendingVideoTask() {
  localStorage.removeItem('volc_pending_task');
}

async function restorePendingVideoTask() {
  const raw = localStorage.getItem('volc_pending_task');
  if (!raw) return;
  let taskInfo;
  try { taskInfo = JSON.parse(raw); } catch { clearPendingVideoTask(); return; }

  // 超过 48 小时的任务清掉
  if (Date.now() - taskInfo.savedAt > 48 * 3600 * 1000) {
    clearPendingVideoTask();
    return;
  }

  // 切到视频页，显示恢复中的状态
  switchPage('video');
  const btn = document.getElementById('btnGenVideo');
  btn.disabled = true; btn.textContent = '恢复任务中...';
  renderVideoTaskStatus('running', '正在恢复查询任务...', 10, 0);

  try {
    const result = await pollVideoTask(taskInfo.taskId, p => {
      const labels = { queued: '排队中...', running: '生成中...', succeeded: '完成', failed: '失败' };
      const percent = Math.min((p.attempt / 60) * 100, 90);
      renderVideoTaskStatus(p.status, labels[p.status] || p.status, percent, p.attempt);
    }, 5000, 240);

    if (result.success) {
      const url = result.data?.content?.video_url;
      const lf = result.data?.content?.last_frame_url;
      if (url) {
        renderVideoResult(url, lf);
        showToast('视频生成成功！', 'success');
        await Store.addHistory({ type: 'video', mode: getVidModeLabel(taskInfo.vidMode || 'i2v'), params: {}, result: [url], thumbnail: url });
      } else renderVideoTaskStatus('succeeded', '完成但未找到URL', 100);
      clearPendingVideoTask();
    } else if (result.timeout && result.taskId) {
      renderVideoTimeout(result.taskId);
      showToast('任务仍在生成中，可稍后重试', 'warning');
      // 保留 pending task，下次切回来还能恢复
    } else {
      renderVideoTaskStatus('failed', result.error || '失败', 0);
      clearPendingVideoTask();
    }
  } catch (e) {
    renderVideoTaskStatus('failed', e.message, 0);
    clearPendingVideoTask();
  } finally {
    btn.disabled = false; btn.textContent = '生成视频';
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
      if (files.length >= maxFiles) { showToast('最多' + maxFiles + '张', 'warning'); break; }
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
    let thumb = r.type === 'image' && r.result?.[0] ? '<img src="' + r.result[0] + '" loading="lazy">' :
      r.type === 'video' && r.thumbnail ? '<video src="' + r.thumbnail + '" muted></video>' : '<div class="history-thumb-placeholder">无预览</div>';
    const url = r.result?.[0] || '';
    const downloadLabel = r.type === 'image' ? '下载图片' : '下载视频';
    card.innerHTML = '<div class="history-thumb" data-url="' + url + '" data-type="' + r.type + '" data-id="' + r.id + '">' + thumb + '</div><div class="history-info"><span class="history-type">' + (r.type === 'image' ? '图片' : '视频') + ' · ' + (r.mode || '') + '</span><div class="history-prompt">' + escapeHtml(r.prompt || '') + '</div><div class="history-time">' + timeStr + '</div></div><div class="history-actions"><a class="btn-secondary download-btn" href="' + url + '" download data-id="' + r.id + '">' + downloadLabel + '</a><button class="btn-secondary delete-btn" data-id="' + r.id + '">删除</button></div>';
    list.appendChild(card);
  });

  // 缩略图/卡片点击：图片打开查看，视频在历史页内弹出播放
  list.querySelectorAll('.history-thumb').forEach(thumb => {
    thumb.style.cursor = 'pointer';
    thumb.onclick = () => {
      const url = thumb.dataset.url;
      const type = thumb.dataset.type;
      if (!url) return;
      showHistoryPreview(url, type);
    };
  });

  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.onclick = async (e) => { e.stopPropagation(); await Store.removeHistory(btn.dataset.id); renderHistory(); window._historyRendered = true; showToast('已删除', 'success'); };
  });
}

// ============ 历史记录预览弹窗 ============
function showHistoryPreview(url, type) {
  // 移除已有的弹窗
  const existing = document.getElementById('historyPreviewModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'historyPreviewModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;';

  let contentHtml = '';
  if (type === 'image') {
    contentHtml = '<img src="' + url + '" style="max-width:100%;max-height:75vh;border-radius:8px;">';
  } else {
    contentHtml = '<video src="' + url + '" controls autoplay loop style="max-width:100%;max-height:75vh;border-radius:8px;"></video>';
  }

  modal.innerHTML = '<div style="display:flex;gap:8px;margin-top:12px;">' +
    '<a class="btn-secondary" href="' + url + '" download style="padding:8px 16px;background:var(--bg-tertiary);border-radius:8px;color:var(--text-primary);text-decoration:none;">下载</a>' +
    '<button class="btn-secondary" id="btnCopyHistory" style="padding:8px 16px;background:var(--bg-tertiary);border-radius:8px;color:var(--text-primary);border:none;">复制链接</button>' +
    '<button class="btn-secondary" id="btnClosePreview" style="padding:8px 16px;background:var(--danger);border-radius:8px;color:#fff;border:none;">关闭</button>' +
    '</div>' + contentHtml;

  // 关闭按钮
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  document.body.appendChild(modal);

  document.getElementById('btnClosePreview').onclick = () => modal.remove();
  document.getElementById('btnCopyHistory').onclick = () => { navigator.clipboard.writeText(url); showToast('已复制', 'success'); };
}
window.renderHistory = renderHistory;

// ============ 清空历史 ============
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const btn = document.getElementById('btnClearHistory');
    if (btn) btn.onclick = async () => {
      if (confirm('确定清空所有历史记录？')) { await Store.clearHistory(); renderHistory(); showToast('已清空', 'success'); }
    };
  }, 100);

  // 离线检测
  window.addEventListener('online', () => { document.getElementById('offlineIndicator').style.display = 'none'; });
  window.addEventListener('offline', () => { document.getElementById('offlineIndicator').style.display = 'block'; });
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