// merge-cloud-history.js - 纯函数：云端记录与本地记录合并
// 从 app.js 的 syncHistoryFromCloud 提取，无 DOM / localStorage / 网络依赖
// 可被 app.js 和测试脚本共同加载

function mergeCloudHistory(localHistory, cloudRecords, options) {
  options = options || {};
  var readOnly = options.readOnly;
  var dbState = options.dbState;

  // 深拷贝本地记录，避免修改输入
  var history = localHistory.map(function(r) { return Object.assign({}, r); });

  // 构建索引
  var localByRecordUid = {};
  var localBySyncId = {};
  for (var i = 0; i < history.length; i++) {
    if (history[i].recordUid) {
      localByRecordUid[history[i].recordUid] = history[i];
    }
    if (history[i]._syncId) {
      localBySyncId[history[i]._syncId] = history[i];
    }
  }

  var addedCount = 0;
  var updatedCount = 0;
  var skippedCount = 0;
  var conflicts = [];
  var cloudRecordUids = new Set();
  var cloudSyncIds = new Set();

  for (var ci = 0; ci < cloudRecords.length; ci++) {
    var cr = cloudRecords[ci];
    var crUid = cr.recordUid || cr._cloudRecordUid;
    if (crUid) cloudRecordUids.add(crUid);
    if (cr._syncId) cloudSyncIds.add(cr._syncId);

    // 先按 recordUid 匹配，再按 _syncId fallback 匹配
    var localRecord = crUid ? localByRecordUid[crUid] : null;
    if (!localRecord && cr._syncId) {
      localRecord = localBySyncId[cr._syncId] || null;
    }

    // readOnly 模式下，无 UID 且无本地匹配的记录跳过
    // 交由迁移功能处理
    if (readOnly && !crUid && !localRecord) {
      skippedCount++;
      continue;
    }

    // 云端墓碑
    if (cr._cloudIsDeleted === true) {
      if (localRecord && !localRecord._isDeleted) {
        localRecord._isDeleted = true;
        localRecord._deletedAt = cr._cloudUpdatedAt || new Date().toISOString();
        localRecord._deletePending = false;
        updatedCount++;
      }
      continue;
    }

    // 新记录
    if (!localRecord) {
      var newRec = Object.assign({}, cr);
      delete newRec._cloudIsDeleted;
      if (crUid) {
        newRec.recordUid = crUid;
      }
      newRec._cloudUpdatedAt = cr._cloudUpdatedAt;
      history.push(newRec);
      if (crUid) localByRecordUid[crUid] = newRec;
      if (newRec._syncId) localBySyncId[newRec._syncId] = newRec;
      addedCount++;
      continue;
    }

    // 本地有对应记录
    if (!localRecord._syncPending) {
      Object.assign(localRecord, cr);
      delete localRecord._cloudIsDeleted;
      if (crUid) localRecord.recordUid = crUid;
      localRecord._cloudUpdatedAt = cr._cloudUpdatedAt;
      updatedCount++;
    } else {
      if (localRecord._cloudUpdatedAt && cr._cloudUpdatedAt &&
          localRecord._cloudUpdatedAt !== cr._cloudUpdatedAt) {
        localRecord._syncConflict = true;
        conflicts.push({ recordUid: crUid, syncId: cr._syncId });
        updatedCount++;
      }
    }
  }

  return {
    history: history,
    addedCount: addedCount,
    updatedCount: updatedCount,
    skippedCount: skippedCount,
    conflicts: conflicts,
    cloudRecordUids: cloudRecordUids,
    cloudSyncIds: cloudSyncIds
  };
}

// 兼容浏览器和 Node.js
if (typeof window !== 'undefined') {
  window.mergeCloudHistory = mergeCloudHistory;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = mergeCloudHistory;
}

// Seedance 2.5 官方能力补丁：本文件在 api.js 之后、app.js 之前加载，
// 因此可在 app 初始化前修正模型能力和请求参数，同时不影响旧模型。
(function () {
  'use strict';
  const ID = 'doubao-seedance-2-5-260628';
  if (typeof VIDEO_MODELS === 'undefined') return;

  const m25 = VIDEO_MODELS.find(m => m.id === ID);
  if (m25) {
    m25.name = 'Seedance 2.5';
    m25.resolutions = ['480p', '720p'];
    m25.durationRange = [4, 30];
    m25.caps = {
      supportsFirstFrame: true, supportsLastFrame: true, generateAudio: true,
      seed: false, cameraFixed: false, frames: false, draft: false, serviceTier: false,
      adaptiveRatio: true, maxDuration: 30,
      referenceImage: true, maxRefImages: 30,
      referenceVideo: true, maxRefVideos: 10,
      refVideoMinDuration: 2, refVideoMaxDuration: 30, refVideoMaxTotalDuration: 30,
      refVideoMaxSize: 209715200, refVideoFormats: ['mp4', 'mov'], refVideoMinFps: 24, refVideoMaxFps: 60,
      referenceAudio: true, maxRefAudios: 10,
      refAudioMinDuration: 2, refAudioMaxDuration: 30, refAudioMaxTotalDuration: 30,
      refAudioMaxSize: 15728640, refAudioFormats: ['wav', 'mp3'], refAudioRequiresOther: false,
      outputFps: 24, outputFpsSelectable: false,
      webSearch: true, priority: true, outputFormat: true, omniTaskType: true
    };
  }

  const hasFrames = p => !!((p.firstFrameImages && p.firstFrameImages.length) || (p.tailFrameImages && p.tailFrameImages.length));
  const hasRefs = p => !!((p.refImages && p.refImages.length) || (p.refVideos && p.refVideos.length) || (p.refAudios && p.refAudios.length));
  const taskType = () => document.getElementById('vidOmniTaskType')?.value || 'auto';
  const outputFormat = () => document.getElementById('vidOutputFormat')?.value || 'mp4';

  if (typeof buildVideoRequestBody === 'function') {
    const originalBuild = buildVideoRequestBody;
    buildVideoRequestBody = function (params) {
      const body = originalBuild(params);
      if (!params || params.model !== ID) return body;
      const frameMode = hasFrames(params);
      const refMode = hasRefs(params);
      const type = taskType();

      if (frameMode) {
        body.ratio = 'adaptive';
        delete body.omni_reference_task_type;
      } else if (refMode) {
        body.omni_reference_task_type = type;
        if (type === 'edit') { body.ratio = 'adaptive'; body.duration = -1; }
        if (type === 'extend') body.ratio = 'adaptive';
      }
      body.output_format = outputFormat();
      return body;
    };
  }

  if (typeof submitVideoTask === 'function') {
    const originalSubmit = submitVideoTask;
    submitVideoTask = async function (params) {
      if (params?.model === ID && !hasFrames(params)) {
        const type = taskType();
        const refVideo = !!(params.refVideos && params.refVideos.length);
        if (type === 'reference' && !hasRefs(params)) return { success: false, error: '参考生视频需至少添加一种参考素材' };
        if ((type === 'edit' || type === 'extend') && !refVideo) return { success: false, error: '视频编辑/延长任务必须至少添加 1 个参考视频' };
      }
      return originalSubmit(params);
    };
  }

  function currentModel() {
    const id = document.getElementById('vidModel')?.value;
    return VIDEO_MODELS.find(m => m.id === id);
  }

  function renderVideoRefs() {
    const p = document.getElementById('vidRefVideoPreview');
    if (!p || typeof vidRefVideoUrls === 'undefined') return;
    p.innerHTML = '';
    vidRefVideoUrls.forEach((url, idx) => {
      const item = document.createElement('div'); item.className = 'preview-item';
      const inner = document.createElement('div');
      inner.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:rgba(108,92,231,.15);flex-direction:column;gap:2px;';
      const icon = document.createElement('span'); icon.textContent = '▶'; icon.style.cssText = 'font-size:18px;color:#6c5ce7;';
      const txt = document.createElement('span'); txt.textContent = url.length > 40 ? url.slice(0, 37) + '...' : url;
      txt.style.cssText = 'font-size:9px;color:var(--text-muted);max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      const del = document.createElement('button'); del.className = 'remove-btn'; del.textContent = '×';
      del.onclick = e => { e.stopPropagation(); vidRefVideoUrls.splice(idx, 1); renderVideoRefs(); };
      inner.append(icon, txt); item.append(inner, del); p.appendChild(item);
    });
  }

  function installVideoRefHandler() {
    const btn = document.getElementById('btnAddRefVideoUrl');
    const input = document.getElementById('vidRefVideoUrlInput');
    if (!btn || !input || typeof vidRefVideoUrls === 'undefined') return;
    btn.onclick = function () {
      const url = input.value.trim();
      const max = currentModel()?.caps?.maxRefVideos || 0;
      if (!url) return showToast('请粘贴视频 URL', 'warning');
      if (!validateUrl(url)) return showToast('请粘贴有效的 http/https URL', 'error');
      if (vidRefVideoUrls.length >= max) return showToast('当前模型最多 ' + max + ' 个参考视频', 'warning');
      if (vidRefVideoUrls.includes(url)) return showToast('该 URL 已添加', 'warning');
      vidRefVideoUrls.push(url); input.value = ''; renderVideoRefs();
    };
  }

  function installAudioUploader() {
    const area = document.getElementById('vidRefAudioUpload');
    const input = document.getElementById('vidRefAudioInput');
    const preview = document.getElementById('vidRefAudioPreview');
    if (!area || !input || !preview || typeof vidRefAudios === 'undefined') return;
    let files = [];
    input.accept = '.wav,.mp3,audio/wav,audio/mpeg';
    area.onclick = () => input.click();
    input.onchange = async e => {
      const max = currentModel()?.caps?.maxRefAudios || 0;
      for (const file of e.target.files) {
        if (files.length >= max) { showToast('当前模型最多 ' + max + ' 段参考音频', 'warning'); break; }
        const n = file.name.toLowerCase();
        if (!n.endsWith('.wav') && !n.endsWith('.mp3')) { showToast('仅支持 WAV / MP3', 'error'); continue; }
        if (file.size > 15 * 1024 * 1024) { showToast(file.name + ' 超过 15MB', 'error'); continue; }
        files.push({ name: file.name, base64: await readFileAsBase64(file) });
      }
      input.value = ''; render();
    };
    function render() {
      preview.innerHTML = '';
      files.forEach((f, idx) => {
        const item = document.createElement('div'); item.className = 'preview-item';
        const inner = document.createElement('div'); inner.textContent = '♪';
        inner.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:rgba(108,92,231,.15);color:#6c5ce7;font-size:24px;';
        const del = document.createElement('button'); del.className = 'remove-btn'; del.textContent = '×';
        del.onclick = e => { e.stopPropagation(); files.splice(idx, 1); render(); };
        item.append(inner, del); preview.appendChild(item);
      });
      vidRefAudios = files.map(f => f.base64);
    }
    vidRefAudioUploadCtrl = { clear: () => { files = []; render(); }, getFiles: () => files.map(f => f.base64) };
  }

  function injectControls() {
    if (document.getElementById('vidOmniTaskTypeGroup')) return;
    const anchor = document.getElementById('vidWebSearchGroup');
    if (!anchor?.parentNode) return;
    const task = document.createElement('div'); task.className = 'form-group'; task.id = 'vidOmniTaskTypeGroup'; task.style.display = 'none';
    task.innerHTML = '<label>全模态任务类型 <span class="hint">2.5 专属</span></label><select id="vidOmniTaskType"><option value="auto">自动判断</option><option value="reference">参考生视频</option><option value="edit">视频编辑</option><option value="extend">视频延长</option></select>';
    const format = document.createElement('div'); format.className = 'form-group'; format.id = 'vidOutputFormatGroup'; format.style.display = 'none';
    format.innerHTML = '<label>输出格式 <span class="hint">2.5 专属</span></label><select id="vidOutputFormat"><option value="mp4">MP4</option><option value="mov">MOV（专业后期）</option></select>';
    anchor.parentNode.insertBefore(task, anchor); anchor.parentNode.insertBefore(format, anchor);
    document.getElementById('vidOmniTaskType').onchange = function () {
      if (this.value === 'edit') { document.getElementById('vidRatio').value = 'adaptive'; document.getElementById('vidDuration').value = '-1'; }
      if (this.value === 'extend') document.getElementById('vidRatio').value = 'adaptive';
    };
  }

  function refreshUI(resetRatio) {
    const m = currentModel(); if (!m) return;
    const c = m.caps || {}, is25 = m.id === ID;
    if (typeof vidRefUploadCtrl !== 'undefined' && vidRefUploadCtrl?.setMax) vidRefUploadCtrl.setMax(c.maxRefImages || 0);
    const imgHint = document.querySelector('#vidRefImageGroup .hint');
    const imgText = document.querySelector('#vidRefUpload span');
    const vidHint = document.querySelector('#vidRefVideoGroup .hint');
    const audHint = document.querySelector('#vidRefAudioGroup .hint');
    const audText = document.querySelector('#vidRefAudioUpload span');
    if (imgHint) imgHint.textContent = '不可与首/尾帧混用，最多 ' + (c.maxRefImages || 0) + ' 张';
    if (imgText) imgText.textContent = '点击选择参考图片（最多' + (c.maxRefImages || 0) + '张）';
    if (vidHint) vidHint.textContent = '公网 URL，最多 ' + (c.maxRefVideos || 0) + ' 个';
    if (audHint) audHint.textContent = is25 ? '最多 10 段；2.5 支持仅输入音频' : '最多 ' + (c.maxRefAudios || 0) + ' 段；需搭配图片或视频';
    if (audText) audText.textContent = '点击选择参考音频（最多' + (c.maxRefAudios || 0) + '段）';
    const task = document.getElementById('vidOmniTaskTypeGroup');
    const fmt = document.getElementById('vidOutputFormatGroup');
    if (task) task.style.display = is25 && typeof vidMode !== 'undefined' && vidMode === 'i2v' ? 'block' : 'none';
    if (fmt) fmt.style.display = is25 ? 'block' : 'none';
    if (is25 && resetRatio) document.getElementById('vidRatio').value = 'adaptive';
    if (is25 && typeof vidFirstImage !== 'undefined' && (vidFirstImage.length || vidTailImage.length)) document.getElementById('vidRatio').value = 'adaptive';
  }

  window.addEventListener('load', function () {
    injectControls(); installVideoRefHandler(); installAudioUploader();
    document.getElementById('vidModel')?.addEventListener('change', () => setTimeout(() => refreshUI(true), 0));
    document.querySelectorAll('.mode-tab[data-vid-mode]').forEach(t => t.addEventListener('click', () => setTimeout(() => refreshUI(false), 0)));
    ['vidFirstInput', 'vidTailInput', 'vidRefInput', 'vidRefAudioInput'].forEach(id => document.getElementById(id)?.addEventListener('change', () => setTimeout(() => refreshUI(false), 50)));
    if (typeof setVideoFormDisabled === 'function') {
      const originalDisable = setVideoFormDisabled;
      setVideoFormDisabled = function (disabled) {
        originalDisable(disabled);
        ['vidOmniTaskType', 'vidOutputFormat'].forEach(id => { const el = document.getElementById(id); if (el) el.disabled = disabled; });
      };
    }
    const v = document.getElementById('versionText'); if (v) v.textContent = 'v1.7.0';
    refreshUI(true);
  });
})();
