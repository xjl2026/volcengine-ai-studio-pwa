// API 调用层 - 浏览器版（直接调火山方舟 API，无 Electron 依赖）

const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com';

// 统一获取 API 基础域名，自动去除尾部斜杠
function getApiBaseUrl(config) {
  const base = String((config && config.apiDomain) || ARK_BASE_URL).trim();
  return base.replace(/\/+$/, '');
}

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
    caps: { supportsFirstFrame: true, supportsLastFrame: true, generateAudio: true, seed: false, cameraFixed: false, frames: false, draft: false, serviceTier: false, adaptiveRatio: true, maxDuration: 15, referenceImage: true, maxRefImages: 9, referenceVideo: true, maxRefVideos: 3, refVideoMinDuration: 2, refVideoMaxDuration: 15, refVideoMaxTotalDuration: 15, refVideoMaxSize: 209715200, refVideoFormats: ['mp4', 'mov'], refVideoMinFps: 24, refVideoMaxFps: 60, referenceAudio: true, maxRefAudios: 3, refAudioMinDuration: 2, refAudioMaxDuration: 15, refAudioMaxTotalDuration: 15, refAudioMaxSize: 15728640, refAudioFormats: ['wav', 'mp3'], refAudioRequiresOther: true, outputFps: 24, outputFpsSelectable: false, webSearch: true, priority: true } },
  { id: 'doubao-seedance-2-0-fast-260128', name: 'Seedance 2.0 Fast', resolutions: ['480p', '720p'], durationRange: [4, 15],
    caps: { supportsFirstFrame: true, supportsLastFrame: true, generateAudio: true, seed: false, cameraFixed: false, frames: false, draft: false, serviceTier: false, adaptiveRatio: true, maxDuration: 15, referenceImage: true, maxRefImages: 9, referenceVideo: true, maxRefVideos: 3, refVideoMinDuration: 2, refVideoMaxDuration: 15, refVideoMaxTotalDuration: 15, refVideoMaxSize: 209715200, refVideoFormats: ['mp4', 'mov'], refVideoMinFps: 24, refVideoMaxFps: 60, referenceAudio: true, maxRefAudios: 3, refAudioMinDuration: 2, refAudioMaxDuration: 15, refAudioMaxTotalDuration: 15, refAudioMaxSize: 15728640, refAudioFormats: ['wav', 'mp3'], refAudioRequiresOther: true, outputFps: 24, outputFpsSelectable: false, webSearch: true, priority: true } },
  { id: 'doubao-seedance-1-5-pro-251215', name: 'Seedance 1.5 Pro', resolutions: ['480p', '720p', '1080p'], durationRange: [4, 12],
    caps: { supportsFirstFrame: true, supportsLastFrame: true, generateAudio: true, seed: true, cameraFixed: true, frames: false, draft: true, serviceTier: false, adaptiveRatio: true, maxDuration: 12, referenceImage: false, maxRefImages: 0, referenceVideo: false, maxRefVideos: 0, referenceAudio: false, maxRefAudios: 0, webSearch: false, priority: false } },
  { id: 'doubao-seedance-1-0-pro-250528', name: 'Seedance 1.0 Pro', resolutions: ['480p', '720p', '1080p'], durationRange: [2, 12],
    caps: { supportsFirstFrame: true, supportsLastFrame: true, generateAudio: false, seed: true, cameraFixed: true, frames: true, draft: false, serviceTier: true, adaptiveRatio: false, maxDuration: 12, referenceImage: false, maxRefImages: 0, referenceVideo: false, maxRefVideos: 0, referenceAudio: false, maxRefAudios: 0, webSearch: false, priority: false } },
  { id: 'doubao-seedance-1-0-pro-fast-251015', name: 'Seedance 1.0 Pro Fast', resolutions: ['480p', '720p', '1080p'], durationRange: [2, 12],
    caps: { supportsFirstFrame: true, supportsLastFrame: false, generateAudio: false, seed: true, cameraFixed: true, frames: true, draft: false, serviceTier: true, adaptiveRatio: false, maxDuration: 12, referenceImage: false, maxRefImages: 0, referenceVideo: false, maxRefVideos: 0, referenceAudio: false, maxRefAudios: 0, webSearch: false, priority: false } }
];

// ============ 配置存储（用 localStorage） ============
const Store = {
  async getConfig() {
    try { return JSON.parse(localStorage.getItem('volc_config')) || { apiKey: '', apiDomain: '' }; }
    catch { return { apiKey: '', apiDomain: '' }; }
  },
  async saveConfig(config) { localStorage.setItem('volc_config', JSON.stringify(config)); return true; },
  async getHistory() { try { return JSON.parse(localStorage.getItem('volc_history')) || []; } catch { return []; } },
  async saveHistory(h) {
    try {
      localStorage.setItem('volc_history', JSON.stringify(h));
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        // 淘汰最旧的一半记录重试
        h = h.slice(0, Math.floor(h.length / 2));
        try { localStorage.setItem('volc_history', JSON.stringify(h)); } catch {}
      }
    }
    return true;
  },
  async addHistory(record) {
    const history = await this.getHistory();
    // taskId 去重：同一个视频任务只写一次
    if (record.taskId) {
      const exists = history.find(h => h.taskId === record.taskId);
      if (exists) return exists;
    }
    const now = new Date().toISOString();
    // v1.6.1: 统一使用 crypto.randomUUID()，不降级为非 UUID 字符串
    if (!crypto.randomUUID) {
      console.error('浏览器不支持 crypto.randomUUID()');
      throw new Error('浏览器不支持 crypto.randomUUID()，无法生成合法 UUID');
    }
    const r = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), recordUid: crypto.randomUUID(), createdAt: now, updatedAt: now, ...record };
    history.unshift(r);
    if (history.length > 500) history.length = 500;
    await this.saveHistory(history);
    // 同步到云端：检查数据库状态后再决定是否写入
    if (window.SyncManager && SyncManager.isEnabled()) {
      try {
        var dbState = await SyncManager.checkDbState();
        if (dbState === 'ready') {
          // 数据库就绪：正式 Upsert
          const result = await SyncManager.upsertHistory(r);
          if (result) {
            r._syncId = result.syncId;
            r._cloudUpdatedAt = result.cloudUpdatedAt;
            r._syncPending = false;
          }
        } else {
          // 数据库未就绪：标记为待同步，不发送请求
          r._syncPending = true;
          console.warn('数据库未就绪 (' + dbState + ')，记录已保存到本地，待数据库升级后自动同步');
        }
      } catch (e) {
        console.warn('推送同步失败: ', e);
        r._syncPending = true;
      }
      await this.saveHistory(history);
    }
    return r;
  },
  async updateHistory(id, patch) {
    const history = await this.getHistory();
    const idx = history.findIndex(h => h.id === id);
    if (idx >= 0) {
      Object.assign(history[idx], patch);
      history[idx].updatedAt = new Date().toISOString();
      await this.saveHistory(history);
      // 同步到云端：检查数据库状态后再决定是否写入
      if (window.SyncManager && SyncManager.isEnabled()) {
        try {
          var dbState = await SyncManager.checkDbState();
          if (dbState === 'ready') {
            let result;
            if (history[idx]._syncId) {
              result = await SyncManager.updateHistory(history[idx]._syncId, history[idx]);
            } else if (history[idx].recordUid) {
              result = await SyncManager.upsertHistory(history[idx]);
            }
            if (result) {
              if (result.syncId) history[idx]._syncId = result.syncId;
              history[idx]._cloudUpdatedAt = result.cloudUpdatedAt;
              history[idx]._syncPending = false;
              history[idx]._syncConflict = false;
            }
          } else {
            // 数据库未就绪：标记为待同步
            history[idx]._syncPending = true;
          }
        } catch (e) { console.warn('更新同步失败: ', e); history[idx]._syncPending = true; }
        await this.saveHistory(history);
      }
      return history[idx];
    }
    return null;
  },
  async removeHistory(id) {
    const history = await this.getHistory();
    const record = history.find(r => r.id === id);
    if (!record) return history.filter(r => !r._isDeleted);

    // V3.2.1：标记为隐藏墓碑，不从 localStorage 移除
    record._isDeleted = true;
    record._deletedAt = new Date().toISOString();
    record._deletePending = true;
    await this.saveHistory(history);

    // 云端软删除：检查数据库状态
    if (record.recordUid && window.SyncManager && SyncManager.isEnabled()) {
      try {
        var dbState = await SyncManager.checkDbState();
        if (dbState === 'ready' || dbState === 'constraint_not_ready' || dbState === 'migration_required') {
          // schema 字段存在时可以软删除
          await SyncManager.deleteHistory(record.recordUid);
          record._deletePending = false;
        } else {
          // schema 未就绪：保留 _deletePending，等待后续同步
          console.warn('数据库未就绪 (' + dbState + ')，墓碑待后续同步');
        }
      } catch (e) {
        console.warn('墓碑同步失败: ', e);
      }
      await this.saveHistory(history);
    }

    return history.filter(r => !r._isDeleted);
  },
  async clearHistory() {
    const history = await this.getHistory();
    const now = new Date().toISOString();

    // V3.2.1：本地所有记录标记为隐藏墓碑
    for (const record of history) {
      if (record._isDeleted) continue;
      record._isDeleted = true;
      record._deletedAt = now;
      record._deletePending = true;
    }
    await this.saveHistory(history);

    // 云端批量软删除：检查数据库状态
    if (window.SyncManager && SyncManager.isEnabled()) {
      var dbState = null;
      try { dbState = await SyncManager.checkDbState(); } catch (e) { dbState = 'network_error'; }

      if (dbState === 'schema_not_ready' || dbState === 'network_error') {
        // schema 未就绪：只标记本地墓碑，不发送云端请求
        if (typeof showToast === 'function') {
          showToast('本地已清空，云端待数据库升级后同步', 'warning');
        }
      } else {
        let successCount = 0;
        let failCount = 0;
        for (const record of history) {
          if (!record._isDeleted || !record._deletePending) continue;
          if (!record.recordUid) { failCount++; continue; }
          try {
            await SyncManager.deleteHistory(record.recordUid);
            record._deletePending = false;
            successCount++;
          } catch (e) {
            console.warn('墓碑同步失败:', e);
            failCount++;
          }
        }
        await this.saveHistory(history);
        if (typeof showToast === 'function') {
          showToast('清空完成：成功' + successCount + '条，待同步' + failCount + '条', failCount > 0 ? 'warning' : 'success');
        }
      }
    }

    // 不执行 localStorage.setItem('volc_history', '[]')
    return history.filter(r => !r._isDeleted);
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

  const url = getApiBaseUrl(config) + path;
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.apiKey, ...options.headers };

  const controller = new AbortController();
  const actualTimeout = options.timeout || 600000;
  const timeoutId = setTimeout(() => controller.abort(), actualTimeout);
  // 支持外部 AbortController（用于用户手动取消）
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

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
    if (e.name === 'AbortError') {
      // 区分是外部取消还是超时
      if (options.signal && options.signal.aborted) throw new Error('用户取消');
      throw new Error('请求超时（' + Math.round(actualTimeout / 1000) + '秒），请检查网络后重试');
    }
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
  const result = await arkRequest('/api/v3/images/generations', { method: 'POST', body: requestBody, signal: params.signal, timeout: 600000 });
  if (result.status >= 200 && result.status < 300) return { success: true, data: result.data };
  return { success: false, error: result.data?.error?.message || 'HTTP ' + result.status };
}

// ============ 视频生成 ============
function buildVideoRequestBody(params) {
  const { mode, model, prompt, firstFrameImages, tailFrameImages, refImages, refVideos, refAudios, resolution, ratio, duration, seed, generateAudio, watermark, returnLastFrame, cameraFixed, frames, draft, serviceTier, webSearch, priority, caps } = params;
  const body = { model, content: [] };

  if (prompt) body.content.push({ type: 'text', text: prompt });

  const hasFirstOrLastFrame = (firstFrameImages && firstFrameImages.length > 0) || (tailFrameImages && tailFrameImages.length > 0);

  // 首帧图
  if (firstFrameImages && firstFrameImages.length > 0) {
    firstFrameImages.forEach(url => body.content.push({ type: 'image_url', image_url: { url }, role: 'first_frame' }));
  }
  // 尾帧图
  if (tailFrameImages && tailFrameImages.length > 0) {
    tailFrameImages.forEach(url => body.content.push({ type: 'image_url', image_url: { url }, role: 'last_frame' }));
  }
  // 参考图/视频/音频 —— 不能与首帧/尾帧共存（API 限制）
  if (!hasFirstOrLastFrame) {
    if (refImages && refImages.length > 0) {
      refImages.forEach(url => body.content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' }));
    }
    if (refVideos && refVideos.length > 0) {
      refVideos.forEach(url => body.content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' }));
    }
    if (refAudios && refAudios.length > 0) {
      refAudios.forEach(url => body.content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' }));
    }
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
  // 联网搜索（仅 2.0 系列）
  if (caps && caps.webSearch && webSearch) body.tools = [{ type: 'web_search' }];
  // 排队优先级（仅 2.0 系列）
  if (caps && caps.priority && priority !== undefined && priority !== 0) body.priority = parseInt(priority);
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
      // 断网时降低查询频率，不消耗 attempt
      if (!navigator.onLine) {
        if (onProgress) onProgress({ status: 'queued', data: null, attempt: i });
        await new Promise(r => setTimeout(r, interval * 4));
        i--; // 断网不消耗 attempt
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
    if (status === 'failed') return { success: false, error: result.data?.error?.message || '视频生成失败', data: result.data };
    await new Promise(r => setTimeout(r, interval));
  }
  return { success: false, error: '轮询超时，任务可能仍在服务端运行', taskId, timeout: true };
}

// ============ 测试连接 ============
// 不能用 GET /api/v3/models（CORS 拦截），不能用 arkRequest（会真的生成图片+signal问题）
// 直接发一个 POST 请求到图片生成接口，不带 signal，只看返回的状态码
async function testConnection(apiKey, apiDomain) {
  const url = getApiBaseUrl({ apiDomain }) + '/api/v3/images/generations';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({ model: 'doubao-seedream-5-0-pro-260628', prompt: 'test' })
    });
    if (res.status === 200) return { success: true, message: '连接成功，API Key 有效' };
    if (res.status === 400) return { success: false, message: 'API Key 有效，但请求参数有误（400）。连接可用但无法确认完全正常' };
    if (res.status === 401) return { success: false, message: 'API Key 无效或已过期（401）' };
    if (res.status === 403) return { success: false, message: '无权限访问该模型（403），请检查 API Key 权限' };
    if (res.status === 429) return { success: false, message: '请求过于频繁（429），请稍后再试' };
    let msg = 'HTTP ' + res.status;
    try { const body = await res.json(); if (body.error?.message) msg = body.error.message; } catch {}
    return { success: false, message: msg };
  } catch (e) {
    return { success: false, message: '无法连接：' + (e.message || '网络错误') + '。请检查域名和网络' };
  }
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
