// Seedance 2.5 官方能力适配层 - v1.7.3
// 依据 2026-08-16 官方文档 + R2V 实际 API 返回校准。
(function () {
  'use strict';

  const ID = 'doubao-seedance-2-5-260628';
  const VERSION = '1.7.3';

  function getModel() {
    if (typeof VIDEO_MODELS === 'undefined') return null;
    return VIDEO_MODELS.find(m => m.id === ID) || null;
  }

  function isSelected() {
    return document.getElementById('vidModel')?.value === ID;
  }

  function getTaskMode() {
    return document.getElementById('vidOmniTaskType')?.value || 'reference';
  }

  function getOutputFormat() {
    return document.getElementById('vidOutputFormat')?.value || 'mp4';
  }

  function hasFrames(params) {
    return !!((params?.firstFrameImages && params.firstFrameImages.length) ||
      (params?.tailFrameImages && params.tailFrameImages.length));
  }

  function hasReferences(params) {
    return !!((params?.refImages && params.refImages.length) ||
      (params?.refVideos && params.refVideos.length) ||
      (params?.refAudios && params.refAudios.length));
  }

  function patchModelCaps() {
    const m = getModel();
    if (!m) return;
    m.name = 'Seedance 2.5';
    m.resolutions = ['480p', '720p'];
    m.durationRange = [4, 30];
    m.caps = {
      supportsFirstFrame: true,
      supportsLastFrame: true,
      generateAudio: true,
      seed: false,
      cameraFixed: false,
      frames: false,
      draft: false,
      serviceTier: false,
      adaptiveRatio: true,
      maxDuration: 30,
      referenceImage: true,
      maxRefImages: 30,
      referenceVideo: true,
      maxRefVideos: 10,
      refVideoMinDuration: 2,
      refVideoEditMinDuration: 4,
      refVideoMaxDuration: 30,
      refVideoMaxTotalDuration: 30,
      refVideoMaxSize: 209715200,
      refVideoFormats: ['mp4', 'mov'],
      refVideoMinFps: 24,
      refVideoMaxFps: 60,
      referenceAudio: true,
      maxRefAudios: 10,
      refAudioMinDuration: 2,
      refAudioMaxDuration: 30,
      refAudioMaxTotalDuration: 30,
      refAudioMaxSize: 15728640,
      refAudioFormats: ['wav', 'mp3'],
      refAudioRequiresOther: false,
      outputFps: 24,
      outputFpsSelectable: false,
      webSearch: true,
      priority: true,
      outputFormat: true,
      omniTaskType: true
    };
  }

  function patchApiLayer() {
    if (typeof buildVideoRequestBody === 'function' && !buildVideoRequestBody.__seedance25v173) {
      const originalBuild = buildVideoRequestBody;
      const wrapped = function (params) {
        const body = originalBuild(params);
        if (!params || params.model !== ID) return body;

        const frameMode = hasFrames(params);
        const refMode = hasReferences(params);
        const taskMode = getTaskMode();

        // Seedance 2.5 官方能力包含 480p / 720p，默认 720p。
        // 但 2026-08-16 实测 R2V 路由会拒绝显式 resolution 参数，
        // 因此 R2V 请求层省略该字段；界面仍显示 720p（官方默认），
        // 实际返回像素规格由当前服务端路由决定。
        if (refMode && !frameMode) {
          delete body.resolution;
        }

        if (frameMode) {
          body.ratio = 'adaptive';
          delete body.omni_reference_task_type;
        } else if (refMode) {
          if (taskMode === 'reference') {
            delete body.omni_reference_task_type;
          } else if (taskMode === 'auto') {
            body.omni_reference_task_type = 'auto';
            body.ratio = 'adaptive';
            body.duration = -1;
          } else if (taskMode === 'edit') {
            body.omni_reference_task_type = 'edit';
            body.ratio = 'adaptive';
            body.duration = -1;
          } else if (taskMode === 'extend') {
            body.omni_reference_task_type = 'extend';
            body.ratio = 'adaptive';
          }
        } else {
          delete body.omni_reference_task_type;
        }

        body.output_format = getOutputFormat();
        return body;
      };
      wrapped.__seedance25v173 = true;
      buildVideoRequestBody = wrapped;
    }

    if (typeof submitVideoTask === 'function' && !submitVideoTask.__seedance25v173) {
      const originalSubmit = submitVideoTask;
      const wrappedSubmit = async function (params) {
        if (params?.model === ID && !hasFrames(params)) {
          const mode = getTaskMode();
          const hasRef = hasReferences(params);
          const hasVideo = !!(params.refVideos && params.refVideos.length);

          if (params.mode === 'i2v' && !hasRef) {
            return { success: false, error: '参考生成需至少添加一种参考素材' };
          }
          if ((mode === 'edit' || mode === 'extend') && !hasVideo) {
            return { success: false, error: '视频编辑 / 视频延长必须至少添加 1 个参考视频' };
          }
        }
        return originalSubmit(params);
      };
      wrappedSubmit.__seedance25v173 = true;
      submitVideoTask = wrappedSubmit;
    }
  }

  function patchAppValidation() {
    if (typeof validateVideoMedia !== 'function' || validateVideoMedia.__seedance25v173) return;
    const originalValidate = validateVideoMedia;
    const wrappedValidate = function (mode, mediaState, caps) {
      const result = originalValidate(mode, mediaState, caps);
      if (result?.valid) return result;
      const audioOnlyBlocked = result?.msg === '参考音频不能单独使用，请至少添加一张参考图或一个参考视频';
      if (audioOnlyBlocked && caps?.refAudioRequiresOther === false && mediaState?.refAudios?.length) {
        return { valid: true };
      }
      return result;
    };
    wrappedValidate.__seedance25v173 = true;
    validateVideoMedia = wrappedValidate;
  }

  function renderVideoRefs() {
    const preview = document.getElementById('vidRefVideoPreview');
    if (!preview || typeof vidRefVideoUrls === 'undefined') return;
    preview.innerHTML = '';
    vidRefVideoUrls.forEach((url, idx) => {
      const item = document.createElement('div');
      item.className = 'preview-item';
      const inner = document.createElement('div');
      inner.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:rgba(108,92,231,.15);flex-direction:column;gap:2px;';
      const icon = document.createElement('span');
      icon.textContent = '▶';
      icon.style.cssText = 'font-size:18px;color:#6c5ce7;';
      const txt = document.createElement('span');
      txt.textContent = url.length > 40 ? url.slice(0, 37) + '...' : url;
      txt.style.cssText = 'font-size:9px;color:var(--text-muted);max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      const del = document.createElement('button');
      del.className = 'remove-btn';
      del.textContent = '×';
      del.onclick = e => {
        e.stopPropagation();
        vidRefVideoUrls.splice(idx, 1);
        renderVideoRefs();
      };
      inner.append(icon, txt);
      item.append(inner, del);
      preview.appendChild(item);
    });
  }

  function installVideoRefHandler() {
    const btn = document.getElementById('btnAddRefVideoUrl');
    const input = document.getElementById('vidRefVideoUrlInput');
    if (!btn || !input || typeof vidRefVideoUrls === 'undefined') return;
    btn.onclick = function () {
      const url = input.value.trim();
      const max = getModel()?.caps?.maxRefVideos || 10;
      if (!url) return showToast('请粘贴视频 URL', 'warning');
      if (!validateUrl(url)) return showToast('请粘贴有效的 http/https URL', 'error');
      if (vidRefVideoUrls.length >= max) return showToast('当前模型最多 ' + max + ' 个参考视频', 'warning');
      if (vidRefVideoUrls.includes(url)) return showToast('该 URL 已添加', 'warning');
      vidRefVideoUrls.push(url);
      input.value = '';
      renderVideoRefs();
    };
  }

  function readAudioDuration(file) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file);
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const d = Number(audio.duration) || 0;
        URL.revokeObjectURL(url);
        resolve(d);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(0);
      };
      audio.src = url;
    });
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
      const max = getModel()?.caps?.maxRefAudios || 10;
      for (const file of e.target.files) {
        if (files.length >= max) {
          showToast('当前模型最多 ' + max + ' 段参考音频', 'warning');
          break;
        }
        const n = file.name.toLowerCase();
        if (!n.endsWith('.wav') && !n.endsWith('.mp3')) {
          showToast('参考音频支持 WAV / MP3', 'error');
          continue;
        }
        if (file.size > 15 * 1024 * 1024) {
          showToast(file.name + ' 超过 15MB', 'error');
          continue;
        }
        const duration = await readAudioDuration(file);
        if (duration && (duration < 2 || duration > 30)) {
          showToast(file.name + ' 时长需在 2–30 秒', 'error');
          continue;
        }
        const totalDuration = files.reduce((sum, f) => sum + (f.duration || 0), 0) + duration;
        if (duration && totalDuration > 30) {
          showToast('全部参考音频总时长不能超过 30 秒', 'error');
          continue;
        }
        files.push({ name: file.name, base64: await readFileAsBase64(file), duration });
      }
      input.value = '';
      render();
    };

    function render() {
      preview.innerHTML = '';
      files.forEach((f, idx) => {
        const item = document.createElement('div');
        item.className = 'preview-item';
        const inner = document.createElement('div');
        inner.textContent = '♪';
        inner.title = f.name + (f.duration ? ' · ' + f.duration.toFixed(1) + 's' : '');
        inner.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:rgba(108,92,231,.15);color:#6c5ce7;font-size:24px;';
        const del = document.createElement('button');
        del.className = 'remove-btn';
        del.textContent = '×';
        del.onclick = e => {
          e.stopPropagation();
          files.splice(idx, 1);
          render();
        };
        item.append(inner, del);
        preview.appendChild(item);
      });
      vidRefAudios = files.map(f => f.base64);
    }

    vidRefAudioUploadCtrl = {
      clear: () => { files = []; render(); },
      getFiles: () => files.map(f => f.base64)
    };
  }

  function injectControls() {
    if (!document.getElementById('vidOmniTaskTypeGroup')) {
      const anchor = document.getElementById('vidWebSearchGroup');
      if (anchor?.parentNode) {
        const task = document.createElement('div');
        task.className = 'form-group';
        task.id = 'vidOmniTaskTypeGroup';
        task.style.display = 'none';
        task.innerHTML = '<label>Seedance 2.5 任务方式 <span class="hint">官方规则</span></label>' +
          '<select id="vidOmniTaskType">' +
          '<option value="reference">参考生成</option>' +
          '<option value="auto">自动判断</option>' +
          '<option value="edit">视频编辑</option>' +
          '<option value="extend">视频延长</option>' +
          '</select>' +
          '<div class="hint" id="vidOmniTaskHint" style="margin-top:6px;">参考生成：可自定义宽高比和 4–30 秒时长。</div>';

        const format = document.createElement('div');
        format.className = 'form-group';
        format.id = 'vidOutputFormatGroup';
        format.style.display = 'none';
        format.innerHTML = '<label>输出格式 <span class="hint">2.5 专属</span></label>' +
          '<select id="vidOutputFormat"><option value="mp4">MP4</option><option value="mov">MOV（编辑/延长推荐）</option></select>';
        anchor.parentNode.insertBefore(task, anchor);
        anchor.parentNode.insertBefore(format, anchor);
      }
    }

    if (!document.getElementById('vidPromptSyntaxHint')) {
      const prompt = document.getElementById('vidPrompt');
      if (prompt?.parentNode) {
        const hint = document.createElement('div');
        hint.id = 'vidPromptSyntaxHint';
        hint.className = 'hint';
        hint.style.marginTop = '6px';
        hint.textContent = 'Seedance 2.5 声音语法：音乐用 ( ) · 音效用 < > · 台词用 { } · 字幕用 【 】';
        prompt.parentNode.insertBefore(hint, prompt.nextSibling);
      }
    }
  }

  function syncResolutionDisplay(isR2V) {
    const resolution = document.getElementById('vidResolution');
    if (!resolution) return;

    const option720 = Array.from(resolution.options).find(o => o.value === '720p');
    const option480 = Array.from(resolution.options).find(o => o.value === '480p');

    if (option720) option720.textContent = isR2V ? '720p（官方默认）' : '720p';
    if (option480) option480.textContent = '480p';

    if (isR2V && option720) resolution.value = '720p';
    resolution.disabled = !!isR2V;
  }

  function syncTaskConstraints() {
    if (!isSelected()) return;
    const mode = getTaskMode();
    const ratio = document.getElementById('vidRatio');
    const duration = document.getElementById('vidDuration');
    const format = document.getElementById('vidOutputFormat');
    const hint = document.getElementById('vidOmniTaskHint');
    const hasFrameInput = typeof vidFirstImage !== 'undefined' &&
      ((vidFirstImage && vidFirstImage.length) || (vidTailImage && vidTailImage.length));
    const isR2V = typeof vidMode !== 'undefined' && vidMode === 'i2v' && !hasFrameInput;

    syncResolutionDisplay(isR2V);

    if (hasFrameInput) {
      if (ratio) ratio.value = 'adaptive';
      if (hint) hint.textContent = '首帧 / 首尾帧：宽高比自动跟随首帧；时长可设 4–30 秒或 -1。';
      return;
    }

    if (mode === 'reference') {
      if (hint) hint.textContent = isR2V
        ? '参考生成：官方支持 480p / 720p，默认 720p；当前 R2V 兼容模式不显式下发 resolution，实际输出规格由服务端决定。宽高比和 4–30 秒时长可设置。'
        : '参考生成：可自定义宽高比和 4–30 秒时长。';
    } else if (mode === 'auto') {
      if (ratio) ratio.value = 'adaptive';
      if (duration) duration.value = '-1';
      if (hint) hint.textContent = isR2V
        ? '自动判断：按官方推荐使用 adaptive + -1；界面显示 720p（官方默认），R2V 请求不显式下发 resolution，实际输出规格由服务端决定。'
        : '自动判断：按官方推荐使用 adaptive + -1。';
    } else if (mode === 'edit') {
      if (ratio) ratio.value = 'adaptive';
      if (duration) duration.value = '-1';
      if (format) format.value = 'mov';
      if (hint) hint.textContent = '视频编辑：需参考视频；宽高比 adaptive、时长 -1；分辨率由服务端按任务约束处理。';
    } else if (mode === 'extend') {
      if (ratio) ratio.value = 'adaptive';
      if (format) format.value = 'mov';
      if (hint) hint.textContent = '视频延长：需参考视频；宽高比 adaptive；分辨率由服务端按任务约束处理。';
    }
  }

  function refreshUI() {
    const m = getModel();
    if (!m) return;
    const caps = m.caps || {};
    const selected = isSelected();
    const modelOption = document.querySelector('#vidModel option[value="' + ID + '"]');
    if (modelOption) modelOption.textContent = 'Seedance 2.5';

    if (typeof vidRefUploadCtrl !== 'undefined' && vidRefUploadCtrl?.setMax) {
      vidRefUploadCtrl.setMax(caps.maxRefImages || 30);
    }

    const imgHint = document.querySelector('#vidRefImageGroup .hint');
    const imgText = document.querySelector('#vidRefUpload span');
    const vidHint = document.querySelector('#vidRefVideoGroup .hint');
    const audHint = document.querySelector('#vidRefAudioGroup .hint');
    const audText = document.querySelector('#vidRefAudioUpload span');

    if (selected) {
      if (imgHint) imgHint.textContent = '全模态参考最多 30 张；首/尾帧与参考素材为不同任务方式';
      if (imgText) imgText.textContent = '点击选择参考图片（最多30张）';
      if (vidHint) vidHint.textContent = '公网 URL；最多10段，总时长不超过30秒';
      if (audHint) audHint.textContent = '最多10段，总时长不超过30秒；支持纯音频参考';
      if (audText) audText.textContent = '点击选择参考音频（最多10段）';
    }

    const task = document.getElementById('vidOmniTaskTypeGroup');
    const fmt = document.getElementById('vidOutputFormatGroup');
    if (task) task.style.display = selected && typeof vidMode !== 'undefined' && vidMode === 'i2v' ? 'block' : 'none';
    if (fmt) fmt.style.display = selected ? 'block' : 'none';

    if (selected) {
      const res = document.getElementById('vidResolution');
      if (res && Array.from(res.options).some(o => o.value === '720p')) res.value = '720p';
      const dur = document.getElementById('vidDuration');
      if (dur) { dur.min = '-1'; dur.max = '30'; }
      syncTaskConstraints();
    }

    const v = document.getElementById('versionText');
    if (v) v.textContent = 'v' + VERSION;
    const date = document.getElementById('versionDate');
    if (date) date.textContent = '2026-08-16';
  }

  function installUiHooks() {
    patchModelCaps();
    patchApiLayer();
    patchAppValidation();
    injectControls();
    installVideoRefHandler();
    installAudioUploader();

    const taskType = document.getElementById('vidOmniTaskType');
    if (taskType) taskType.onchange = syncTaskConstraints;

    document.getElementById('vidModel')?.addEventListener('change', () => setTimeout(() => {
      patchModelCaps();
      if (typeof updateVideoModelUI === 'function') updateVideoModelUI();
      refreshUI();
    }, 0));

    document.querySelectorAll('.mode-tab[data-vid-mode]').forEach(t => {
      t.addEventListener('click', () => setTimeout(refreshUI, 0));
    });

    ['vidFirstInput', 'vidTailInput', 'vidRefInput', 'vidRefAudioInput'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => setTimeout(refreshUI, 50));
    });

    if (typeof setVideoFormDisabled === 'function' && !setVideoFormDisabled.__seedance25v173) {
      const originalDisable = setVideoFormDisabled;
      const wrappedDisable = function (disabled) {
        originalDisable(disabled);
        ['vidOmniTaskType', 'vidOutputFormat'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.disabled = disabled;
        });
        if (!disabled) syncTaskConstraints();
      };
      wrappedDisable.__seedance25v173 = true;
      setVideoFormDisabled = wrappedDisable;
    }

    if (typeof updateVideoModelUI === 'function') updateVideoModelUI();
    if (typeof updateVideoModeUI === 'function') updateVideoModeUI();
    refreshUI();
  }

  patchModelCaps();
  patchApiLayer();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(installUiHooks, 0), { once: true });
  } else {
    setTimeout(installUiHooks, 0);
  }
})();