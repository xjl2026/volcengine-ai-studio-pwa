// API 调用层 - 浏览器版（直接调火山方舟 API，无 Electron 依赖）

const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com';

const IMAGE_MODELS = [
  { id: 'doubao-seedream-5-0-pro-260628', name: 'Seedream 5.0 Pro', sizes: ['1K', '2K'], formats: ['png', 'jpeg'],
    caps: { outputFormat: true, sequential: false, stream: false, webSearch: false, optimizeFast: false, maxRefImages: 10 } },
  { id: 'doubao-seedream-5-0-260128', name: 'Seedream 5.0 Lite', sizes: ['2K', '3K', '4K'], formats: ['png', 'jpeg'],
    caps: { outputFormat: true, sequential: true, stream: true, webSearch: true, optimizeFast: false, maxRefImages: 14 } },
  { id: 'doubao-seedream-4-5-251128', name: 'Seedream 4.5', sizes: ['2K', '4K'], formats: ['jpeg'],
    caps: { outputFormat: false, sequential: true, stream: true, webSearch: false, optimizeFast: false, maxRefImages: 14 } },
  { id: 'doubao-seedream-4-0-250828', name: 'Seedream 4.0', sizes: ['1K', '2K', '4K'], formats: ['jpeg'],
    caps: { outputFormat: false, sequential: true, stream: true, webSearch: false, optimizeFast: true, maxRefImages: 14 } }
];

const VIDEO_MODELS = [
  { id: 'doubao-seedance-2-0-260128', name: 'Seedance 2.0', resolutions: ['480p', '720p', '1080p', '4k'], durationRange: [4, 15],
    caps: { generateAudio: true, seed: false, cameraFixed: false, frames: false, draft: false, serviceTier: false, adaptiveRatio: true, maxDuration: 15, referenceImage: true, maxRefImages: 9 } },
  { id: 'doubao-seedance-2-0-fast-260128', name: 'Seedance 2.0 Fast', resolutions: ['480p', '720p'], durationRange: [4, 15],
    caps: { generateAudio: true, seed: false, cameraFixed: false, frames: false, draft: false, serviceTier: false, adaptiveRatio: true, maxDuration: 15, referenceImage: true, maxRefImages: 9 } },
  { id: 'doubao-seedance-1-5-pro-251215', name: 'Seedance 1.5 Pro', resolutions: ['480p', '720p', '1080p'], durationRange: [4, 12],
    caps: { generateAudio: true, seed: true, cameraFixed: true, frames: false, draft: true, serviceTier: false, adaptiveRatio: true, maxDuration: 12, referenceImage: false, maxRefImages: 0 } },
  { id: 'doubao-seedance-1-0-pro-250528', name: 'Seedance 1.0 Pro', resolutions: ['480p', '720p', '1080p'], durationRange: [2, 12],
    caps: { generateAudio: false, seed: true, cameraFixed: true, frames: true, draft: false, serviceTier: true, adaptiveRatio: false, maxDuration: 12, referenceImage: false, maxRefImages: 0 } },
  { id: 'doubao-seedance-1-0-pro-fast-251015', name: 'Seedance 1.0 Pro Fast', resolutions: ['480p', '720p', '1080p'], durationRange: [2, 12],
    caps: { generateAudio: false, seed: true, cameraFixed: true, frames: true, draft: false, serviceTier: true, adaptiveRatio: false, maxDuration: 12, referenceImage: false, maxRefImages: 0 } }
];

// ============ 配置存储（用 localStorage） ============
const Store = {
  async getConfig() {
    try { return JSON.parse(localStorage.getItem('volc_config')) || { apiKey: '', apiDomain: '' }; }
    catch { return { apiKey: '', apiDomain: '' }; }
  },
  async saveConfig(config) { localStorage.setItem('volc_config', JSON.stringify(config)); return true; },
  async getHistory() { try { return JSON.parse(localStorage.getItem('volc_history')) || []; } catch { return []; } },
  async saveHistory(h) { localStorage.setItem('volc_history', JSON.stringify(h)); return true; },
  async addHistory(record) {
    const history = await this.getHistory();
    const r = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), createdAt: new Date().toISOString(), ...record };
    history.unshift(r);
    if (history.length > 500) history.length = 500;
    await this.saveHistory(history);
    // 同步到云端
    if (window.SyncManager && SyncManager.isEnabled()) {
      try { r._syncId = await SyncManager.pushHistory(r); } catch (e) { console.warn('推送同步失败: ', e); }
    }
    return r;
  },
  async removeHistory(id) {
    const history = await this.getHistory();
    const record = history.find(r => r.id === id);
    const filtered = history.filter(r => r.id !== id);
    await this.saveHistory(filtered);
    // 从云端删除
    if (record && record._syncId && window.SyncManager && SyncManager.isEnabled()) {
      try { await SyncManager.deleteHistory(record._syncId); } catch (e) { console.warn('同步删除失败: ', e); }
    }
    return filtered;
  },
  async clearHistory() {
    localStorage.setItem('volc_history', '[]');
    // 清空云端
    if (window.SyncManager && SyncManager.isEnabled()) {
      try { await SyncManager.clearAllHistory(); } catch (e) { console.warn('同步清空失败: ', e); }
    }
    return [];
  },
  // 多 API Key 管理
  getApiKeys() { try { return JSON.parse(localStorage.getItem('volc_api_keys')) || []; } catch { return []; } },
  saveApiKeys(keys) { localStorage.setItem('volc_api_keys', JSON.stringify(keys)); },
  getActiveKeyId() { return localStorage.getItem('volc_active_key_id') || ''; },
  setActiveKeyId(id) { localStorage.setItem('volc_active_key_id', id); },
  getNotifySetting() { return localStorage.getItem('volc_notify') !== 'false'; },
  setNotifySetting(val) { localStorage.setItem('volc_notify', val ? 'true' : 'false'); },
  // 同步配置
  getSyncConfig() { try { return JSON.parse(localStorage.getItem('volc_sync_config')) || { url: '', anonKey: '', syncKey: '' }; } catch { return { url: '', anonKey: '', syncKey: '' }; } },
  saveSyncConfig(config) { localStorage.setItem('volc_sync_config', JSON.stringify(config)); }
};

// ============ HTTP 请求（带超时） ============
async function arkRequest(path, options = {}) {
  const config = await Store.getConfig();
  if (!config.apiKey) throw new Error('请先在设置中配置 API Key');

  const url = ARK_BASE_URL + path;
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.apiKey, ...options.headers };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || 60000);

  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    let data;
    try { data = await res.json(); } catch { data = await res.text(); }
    return { status: res.status, data };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') throw new Error('请求超时（60秒），请检查网络后重试');
    throw e;
  }
}

// ============ 图片生成 ============
function buildImageRequestBody(params) {
  const { mode, model, prompt, images, size, customWidth, customHeight, outputFormat, watermark, sequential, maxImages, optimizeMode, webSearch, stream, caps } = params;
  const body = { model, prompt };

  if (images && images.length > 0) {
    body.image = images.length === 1 ? images[0] : images;
  }
  if (size === 'custom' && customWidth && customHeight) {
    body.size = parseInt(customWidth) + 'x' + parseInt(customHeight);
  } else if (size) {
    body.size = size;
  }
  if (caps && caps.outputFormat && outputFormat) {
    body.output_format = outputFormat;
    body.response_format = 'url';
  }
  if (watermark !== undefined) body.watermark = watermark;
  if (sequential === 'auto' && caps && caps.sequential) {
    body.sequential_image_generation = 'auto';
    body.sequential_image_generation_options = { max_images: maxImages || 4 };
  }
  if (caps && caps.stream && stream) body.stream = true;
  if (caps && caps.webSearch && webSearch) body.tools = [{ type: 'web_search' }];
  const modeVal = (caps && caps.optimizeFast && optimizeMode === 'fast') ? 'fast' : 'standard';
  body.optimize_prompt_options = { mode: modeVal };
  return body;
}

async function generateImage(params) {
  const requestBody = buildImageRequestBody(params);
  const result = await arkRequest('/api/v3/images/generations', { method: 'POST', body: requestBody });
  if (result.status >= 200 && result.status < 300) return { success: true, data: result.data };
  return { success: false, error: result.data?.error?.message || 'HTTP ' + result.status };
}

// ============ 视频生成 ============
function buildVideoRequestBody(params) {
  const { mode, model, prompt, firstFrameImages, tailFrameImages, refImages, resolution, ratio, duration, seed, generateAudio, watermark, returnLastFrame, cameraFixed, frames, draft, serviceTier, caps } = params;
  const body = { model, content: [] };

  if (prompt) body.content.push({ type: 'text', text: prompt });

  // 首帧图（不填 role，默认 first_frame）
  if (firstFrameImages && firstFrameImages.length > 0) {
    firstFrameImages.forEach(url => body.content.push({ type: 'image_url', image_url: { url } }));
  }
  // 尾帧图（role: last_frame）
  if (tailFrameImages && tailFrameImages.length > 0) {
    tailFrameImages.forEach(url => body.content.push({ type: 'image_url', image_url: { url }, role: 'last_frame' }));
  }
  // 参考图（role: reference_image，仅 2.0 系列支持）
  if (refImages && refImages.length > 0) {
    refImages.forEach(url => body.content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' }));
  }
  if (resolution) body.resolution = resolution;
  if (ratio) body.ratio = ratio;
  if (caps && caps.frames && frames && frames !== '') {
    body.frames = parseInt(frames);
  } else if (duration !== undefined && duration !== '') {
    body.duration = parseInt(duration);
  }
  if (caps && caps.generateAudio && generateAudio !== undefined) body.generate_audio = generateAudio;
  if (watermark !== undefined) body.watermark = watermark;
  if (returnLastFrame !== undefined) body.return_last_frame = returnLastFrame;
  if (caps && caps.cameraFixed && cameraFixed !== undefined && mode === 't2v') body.camera_fixed = cameraFixed;
  if (caps && caps.seed && seed !== undefined && seed !== '' && seed !== -1) body.seed = parseInt(seed);
  if (caps && caps.draft && draft) body.draft = true;
  if (caps && caps.serviceTier && serviceTier && serviceTier !== 'default') body.service_tier = serviceTier;
  return body;
}

async function submitVideoTask(params) {
  const requestBody = buildVideoRequestBody(params);
  const result = await arkRequest('/api/v3/contents/generations/tasks', { method: 'POST', body: requestBody });
  if (result.status >= 200 && result.status < 300) return { success: true, data: result.data };
  return { success: false, error: result.data?.error?.message || 'HTTP ' + result.status };
}

async function queryVideoTask(taskId) {
  const result = await arkRequest('/api/v3/contents/generations/tasks/' + taskId);
  if (result.status >= 200 && result.status < 300) return { success: true, data: result.data };
  return { success: false, error: result.data?.error?.message || 'HTTP ' + result.status };
}

async function pollVideoTask(taskId, onProgress, interval, maxAttempts) {
  interval = interval || 5000;
  maxAttempts = maxAttempts || 120;
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 5;

  for (let i = 0; i < maxAttempts; i++) {
    const result = await queryVideoTask(taskId);
    if (!result.success) {
      consecutiveErrors++;
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
    if (status === 'failed') return { success: false, error: result.data?.error?.message || '视频生成失败', data: result.data };
    await new Promise(r => setTimeout(r, interval));
  }
  return { success: false, error: '轮询超时，任务可能仍在服务端运行', taskId, timeout: true };
}

// ============ 测试连接 ============
async function testConnection(apiKey, apiDomain) {
  const res = await fetch((apiDomain || ARK_BASE_URL).replace(/\/$/, '') + '/api/v3/models', {
    headers: { 'Authorization': 'Bearer ' + apiKey }
  });
  return { success: res.status === 200, message: res.status === 200 ? '连接成功' : 'HTTP ' + res.status };
}

// ============ 文件读取为 base64 ============
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
