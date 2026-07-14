// test-video-generate.js
// 视频生成链路行为测试
// 运行: node test-video-generate.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ============ Mock DOM ============
var elements = {};

function createElement(id) {
  return {
    id: id,
    style: { display: '' },
    disabled: false,
    checked: false,
    value: '',
    textContent: '',
    innerHTML: '',
    classList: {
      _classes: [],
      add: function(c) { this._classes.push(c); },
      remove: function(c) { this._classes = this._classes.filter(function(x) { return x !== c; }); },
      contains: function(c) { return this._classes.indexOf(c) >= 0; }
    },
    appendChild: function() {},
    querySelector: function() { return null; },
    querySelectorAll: function() { return []; },
    onclick: null
  };
}

function setupDOM(opts) {
  opts = opts || {};
  elements = {};
  deletedIds = {};
  global.document._dynamicElements = {};
  var ids = [
    'btnGenVideo', 'vidPrompt', 'vidModel', 'vidResolution', 'vidRatio',
    'vidDuration', 'vidSeed', 'vidGenerateAudio', 'vidWatermark',
    'vidReturnLastFrame', 'vidCameraFixed', 'vidFrames', 'vidDraft',
    'vidServiceTier', 'vidWebSearch', 'vidPriority', 'vidResultPanel',
    'vidFirstFrameGroup', 'vidTailFrameGroup', 'vidRefImageGroup',
    'vidRefVideoGroup', 'vidRefAudioGroup', 'vidSeedGroup',
    'vidCameraFixedGroup', 'vidDraftGroup', 'vidServiceTierGroup',
    'vidWebSearchGroup', 'vidPriorityGroup', 'vidFramesGroup',
    'page-video', 'page-image', 'page-history', 'page-settings'
  ];
  ids.forEach(function(id) { elements[id] = createElement(id); });

  elements.vidPrompt.value = opts.prompt !== undefined ? opts.prompt : '一只猫在奔跑';
  elements.vidModel.value = opts.model || 'doubao-seedance-2-0-260128';
  elements.vidResolution.value = opts.resolution || '1080p';
  elements.vidRatio.value = opts.ratio || '16:9';
  elements.vidDuration.value = opts.duration !== undefined ? opts.duration : '12';
  if (elements.vidSeed) elements.vidSeed.value = opts.seedValue !== undefined ? opts.seedValue : '';
  elements.vidGenerateAudio.checked = true;
  elements.vidWatermark.checked = false;
  elements.vidReturnLastFrame.checked = false;

  if (opts.noVidSeed) {
    delete elements.vidSeed;
  }
}

// Track which IDs were explicitly deleted from elements (to simulate missing DOM)
var deletedIds = {};

global.document = {
  _dynamicElements: {},
  getElementById: function(id) {
    // Explicitly deleted elements return null
    if (deletedIds[id]) return null;
    if (elements[id]) return elements[id];
    // For dynamically created elements via innerHTML (like btnRetryQuery),
    // create and register a new dynamic element
    if (this._dynamicElements[id]) return this._dynamicElements[id];
    var el = createElement(id);
    this._dynamicElements[id] = el;
    return el;
  },
  querySelectorAll: function() { return []; },
  querySelector: function() { return null; },
  addEventListener: function() {},
  createElement: function() { return createElement(); }
};

global.window = {
  _currentPollingTaskId: null,
  _historyRendered: false,
  _restoringTask: false
};
global.navigator = { onLine: true };
global.localStorage = {
  _data: {},
  getItem: function(k) { return this._data[k] || null; },
  setItem: function(k, v) { this._data[k] = v; },
  removeItem: function(k) { delete this._data[k]; }
};

// ============ Mock state ============
var toastMessages = [];
var savedHistoryUpdates = [];
var submitVideoCallCount = 0;
var lastSubmitParams = null;
var pollVideoCallCount = 0;
var setVideoFormDisabledCallCount = 0;
var setVideoFormDisabledLastArg = null;
var renderVideoTimeoutCallCount = 0;
var renderVideoResultCallCount = 0;
var renderVideoTaskStatusCallCount = 0;
var lastRenderVideoTaskStatus = null;
var copyToClipboard = async function() { return true; };

var mockConfig = { apiKey: 'test-key', apiDomain: 'https://ark.cn-beijing.volces.com' };

// ============ Mock functions ============
function showToast(msg, type) { toastMessages.push({ msg: msg, type: type }); }
function notifyTaskComplete() {}
function switchPage() {}
function setVideoFormDisabled(disabled) { setVideoFormDisabledCallCount++; setVideoFormDisabledLastArg = disabled; }
function getVidModeLabel(m) { return m; }
function escapeHtml(s) { return s; }
function escapeAttr(s) { return s; }

// renderVideoTaskStatus: record calls but also do minimal DOM update
function renderVideoTaskStatus(status, text, percent, attempt) {
  renderVideoTaskStatusCallCount++;
  lastRenderVideoTaskStatus = { status: status, text: text, percent: percent, attempt: attempt };
  var panel = elements.vidResultPanel;
  if (panel) panel.innerHTML = '<div class="task-status"><div class="status-text">' + escapeHtml(text) + '</div></div>';
}

// renderVideoResult: record calls
function renderVideoResult(url, lastFrameUrl) {
  renderVideoResultCallCount++;
  var panel = elements.vidResultPanel;
  if (panel) panel.innerHTML = '<div class="result-content"><video src="' + escapeAttr(url) + '"></video></div>';
}

var videoGenState = { isGenerating: false };
var vidMode = 'i2v';
var vidFirstImage = [];
var vidTailImage = [];
var vidRefImages = [];
var vidRefVideoUrls = [];
var vidRefAudios = [];

var validateVideoMediaResult = { valid: true, msg: '' };
function validateVideoMedia(mode, state, caps) { return validateVideoMediaResult; }

var submitVideoResult = { success: true, data: { id: 'test-task-001' } };
async function submitVideoTask(params) {
  submitVideoCallCount++;
  lastSubmitParams = params;
  return submitVideoResult;
}

var pollVideoResult = { success: true, data: { content: { video_url: 'https://example.com/video.mp4' } } };
async function pollVideoTask(taskId, onProgress, interval, maxAttempts) {
  pollVideoCallCount++;
  if (onProgress) onProgress({ status: 'running', attempt: 1 });
  return pollVideoResult;
}

// ============ 加载 api.js ============
var apiCode = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
apiCode = apiCode.replace('const Store =', 'var Store =');
apiCode = apiCode.replace('const IMAGE_MODELS =', 'var IMAGE_MODELS =');
apiCode = apiCode.replace('const VIDEO_MODELS =', 'var VIDEO_MODELS =');
eval(apiCode);

// 替换 Store 为 mock 版本
Store = {
  getConfig: async function() { return mockConfig; },
  addHistory: async function(record) { return Object.assign({ id: 'rec-001' }, record); },
  updateHistory: async function(id, updates) { savedHistoryUpdates.push({ id: id, updates: updates }); return true; }
};

// 替换 submitVideoTask 和 pollVideoTask
submitVideoTask = async function(params) {
  submitVideoCallCount++;
  lastSubmitParams = params;
  return submitVideoResult;
};
pollVideoTask = async function(taskId, onProgress, interval, maxAttempts) {
  pollVideoCallCount++;
  if (onProgress) onProgress({ status: 'running', attempt: 1 });
  return pollVideoResult;
};

// ============ 加载 app.js 并提取生产函数 ============
var appCode = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// 提取 handleVideoGenerate
var handlerMatch = appCode.match(/async function handleVideoGenerate\(\)\s*\{[\s\S]*?\n\}/);
assert.ok(handlerMatch, '必须找到 handleVideoGenerate 定义');
eval(handlerMatch[0]);

// 提取 renderVideoTimeout（真实函数，会创建 btnRetryQuery 并绑定 onclick）
var timeoutMatch = appCode.match(/function renderVideoTimeout\(taskId, recordId\)\s*\{[\s\S]*?\n\}/);
assert.ok(timeoutMatch, '必须找到 renderVideoTimeout 定义');
eval(timeoutMatch[0]);

// 提取 savePendingVideoTask（真实函数，写入 localStorage）
var saveMatch = appCode.match(/function savePendingVideoTask\(taskId, vidModeSnapshot, prompt, recordId, params\)\s*\{[\s\S]*?\n\}/);
assert.ok(saveMatch, '必须找到 savePendingVideoTask 定义');
eval(saveMatch[0]);

// 提取 clearPendingVideoTask（真实函数，清除 localStorage）
var clearMatch = appCode.match(/function clearPendingVideoTask\(\)\s*\{[\s\S]*?\n\}/);
assert.ok(clearMatch, '必须找到 clearPendingVideoTask 定义');
eval(clearMatch[0]);

// 提取 getValidPendingVideoTask（真实函数，校验 pending task 有效性）
var getValidMatch = appCode.match(/function getValidPendingVideoTask\(\)\s*\{[\s\S]*?\n\}/);
assert.ok(getValidMatch, '必须找到 getValidPendingVideoTask 定义');
eval(getValidMatch[0]);

// 提取 restorePendingVideoTask（真实函数，执行恢复轮询）
var restoreMatch = appCode.match(/async function restorePendingVideoTask\(\)\s*\{[\s\S]*?\n\}/);
assert.ok(restoreMatch, '必须找到 restorePendingVideoTask 定义');
eval(restoreMatch[0]);

// buildVideoRequestBody 已在 api.js eval 中定义
assert.ok(typeof buildVideoRequestBody === 'function', 'buildVideoRequestBody must be loaded');

// ============ 测试辅助 ============
function setupTestEnvironment(opts) {
  opts = opts || {};
  setupDOM(opts);
  // setupDOM already clears deletedIds and dynamicElements
  vidMode = opts.vidMode || 'i2v';
  vidFirstImage = opts.vidFirstImage || [];
  vidTailImage = opts.vidTailImage || [];
  vidRefImages = opts.vidRefImages || [];
  vidRefVideoUrls = [];
  vidRefAudios = [];
  videoGenState.isGenerating = false;
  global.window._currentPollingTaskId = null;
  global.window._historyRendered = false;
  global.window._restoringTask = false;
  submitVideoCallCount = 0;
  pollVideoCallCount = 0;
  lastSubmitParams = null;
  toastMessages = [];
  savedHistoryUpdates = [];
  submitVideoResult = { success: true, data: { id: 'test-task-001' } };
  pollVideoResult = { success: true, data: { content: { video_url: 'https://example.com/video.mp4' } } };
  validateVideoMediaResult = { valid: true, msg: '' };
  setVideoFormDisabledCallCount = 0;
  setVideoFormDisabledLastArg = null;
  renderVideoTimeoutCallCount = 0;
  renderVideoResultCallCount = 0;
  renderVideoTaskStatusCallCount = 0;
  lastRenderVideoTaskStatus = null;
  // 清空 localStorage
  global.localStorage._data = {};
  // 每次都重新赋值 mock 函数
  submitVideoTask = async function(params) {
    submitVideoCallCount++;
    lastSubmitParams = params;
    return submitVideoResult;
  };
  pollVideoTask = async function(taskId, onProgress, interval, maxAttempts) {
    pollVideoCallCount++;
    if (onProgress) onProgress({ status: 'running', attempt: 1 });
    return pollVideoResult;
  };
}

// ============ 测试 ============
var testPassed = 0, testFailed = 0, testTotal = 0, testResults = [];
var asyncTests = [];

function test(name, fn) {
  testTotal++;
  asyncTests.push({ name: name, fn: fn });
}

// --- 1. 图生视频基本流程（不抛 seedRaw ReferenceError） ---
test('图生视频: seedRaw 未定义不抛异常', async function() {
  setupTestEnvironment({
    vidMode: 'i2v',
    vidFirstImage: ['data:image/png;base64,abc'],
    seedValue: ''
  });
  await handleVideoGenerate();
  assert.ok(submitVideoCallCount === 1, 'submitVideoTask 应被调用1次，实际: ' + submitVideoCallCount);
  assert.strictEqual(lastSubmitParams.seed, -1, '空 seed 应为 -1');
});

// --- 2. Seedance 2.0 最终请求体不发送 seed ---
test('Seedance 2.0: 请求体不包含 seed', function() {
  var seedance20 = VIDEO_MODELS.find(function(m) { return m.id === 'doubao-seedance-2-0-260128'; });
  assert.ok(seedance20, 'Seedance 2.0 must exist');
  var params = {
    mode: 'i2v', model: 'doubao-seedance-2-0-260128', prompt: 'test',
    firstFrameImages: ['data:image/png;base64,abc'],
    resolution: '1080p', ratio: '16:9', duration: '12',
    seed: 123, generateAudio: true, watermark: false,
    returnLastFrame: false, cameraFixed: false, frames: '',
    draft: false, serviceTier: 'default', webSearch: false, priority: 0,
    caps: seedance20.caps
  };
  var body = buildVideoRequestBody(params);
  assert.strictEqual(body.seed, undefined, 'Seedance 2.0 不支持 seed，请求体不应包含 seed');
});

// --- 3. 支持 seed 的模型输入 123 时发送 seed=123 ---
test('Seedance 1.5 Pro: seed=123 出现在请求体', function() {
  var seedance15 = VIDEO_MODELS.find(function(m) { return m.id === 'doubao-seedance-1-5-pro-251215'; });
  assert.ok(seedance15, 'Seedance 1.5 Pro must exist');
  var params = {
    mode: 't2v', model: seedance15.id, prompt: 'test',
    resolution: '720p', ratio: '16:9', duration: '5',
    seed: 123, generateAudio: true, watermark: false,
    returnLastFrame: false, cameraFixed: false, frames: '',
    draft: false, serviceTier: 'default', webSearch: false, priority: 0,
    caps: seedance15.caps
  };
  var body = buildVideoRequestBody(params);
  assert.strictEqual(body.seed, 123, 'Seedance 1.5 Pro 应发送 seed=123');
});

// --- 4. vidSeed 元素不存在时不抛异常 ---
test('vidSeed 元素不存在: 不抛异常，seed 为 -1', async function() {
  setupTestEnvironment({
    vidMode: 'i2v',
    vidFirstImage: ['data:image/png;base64,abc'],
    noVidSeed: true
  });
  await handleVideoGenerate();
  assert.ok(submitVideoCallCount === 1, 'submitVideoTask 应被调用1次');
  assert.strictEqual(lastSubmitParams.seed, -1, 'vidSeed 不存在时 seed 应为 -1');
});

// --- 5. seed 输入非法时按 -1 处理 ---
test('vidSeed 输入非法: seed 为 -1', async function() {
  setupTestEnvironment({
    vidMode: 'i2v',
    vidFirstImage: ['data:image/png;base64,abc'],
    seedValue: 'abc'
  });
  await handleVideoGenerate();
  assert.strictEqual(lastSubmitParams.seed, -1, '非法 seed 输入应为 -1');
});

// --- 6. 参数构造阶段异常显示 Toast 并恢复按钮 ---
test('参数构造异常: Toast 显示并恢复按钮', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });
  deletedIds.vidResolution = true;
  await handleVideoGenerate();
  assert.ok(toastMessages.some(function(t) { return t.type === 'error'; }), '应显示 error Toast');
  assert.strictEqual(videoGenState.isGenerating, false, 'isGenerating 应恢复为 false');
  assert.strictEqual(elements.btnGenVideo.disabled, false, '按钮应恢复可点击');
  assert.strictEqual(elements.btnGenVideo.textContent, '生成视频', '按钮文字应恢复');
});

// --- 7. API 提交失败时恢复按钮和 isGenerating ---
test('API 提交失败: 恢复按钮和 isGenerating', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });
  submitVideoResult = { success: false, error: 'API Error 500' };
  await handleVideoGenerate();
  assert.strictEqual(videoGenState.isGenerating, false, 'isGenerating 应恢复为 false');
  assert.strictEqual(elements.btnGenVideo.disabled, false, '按钮应恢复可点击');
  assert.strictEqual(elements.btnGenVideo.textContent, '生成视频', '按钮文字应恢复');
});

// --- 8. 主生成流程：取得 taskId 后轮询异常 → 可恢复 ---
test('主流程轮询异常: pending 保留 + timeout + 不显示提交异常', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });
  // pollVideoTask 抛出网络异常
  pollVideoTask = async function() { throw new Error('网络断开'); };

  await handleVideoGenerate();

  // pending task 应保留（未被清除）
  var pendingRaw = global.localStorage.getItem('volc_pending_task');
  assert.ok(pendingRaw, 'pending task 应保留在 localStorage 中');
  var pendingObj = JSON.parse(pendingRaw);
  assert.strictEqual(pendingObj.taskId, 'test-task-001', 'pending task 的 taskId 应未被覆盖');

  // 历史状态应更新为 timeout
  var timeoutUpdate = savedHistoryUpdates.find(function(u) { return u.updates.status === 'timeout'; });
  assert.ok(timeoutUpdate, '历史记录状态应更新为 timeout');

  // 不应显示"视频提交异常"
  assert.ok(!toastMessages.some(function(t) { return t.msg.indexOf('视频提交异常') >= 0; }), '不应显示"视频提交异常"');

  // 应显示查询中断提示
  assert.ok(toastMessages.some(function(t) { return t.msg.indexOf('查询暂时中断') >= 0; }), '应显示查询中断提示');

  // _currentPollingTaskId 应清理
  assert.strictEqual(global.window._currentPollingTaskId, null, '_currentPollingTaskId 应为 null');

  // isGenerating 应恢复
  assert.strictEqual(videoGenState.isGenerating, false, 'isGenerating 应恢复为 false');
});

// --- 9. 成功状态但没有 video_url：标记为 failed ---
test('成功但无 video_url: 标记为 failed 不留 pending', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });
  pollVideoResult = { success: true, data: { content: {} } };
  await handleVideoGenerate();
  assert.ok(toastMessages.some(function(t) { return t.msg.indexOf('未返回视频URL') >= 0; }), '应显示未返回视频URL提示');
  var failedUpdate = savedHistoryUpdates.find(function(u) { return u.updates.status === 'failed'; });
  assert.ok(failedUpdate, 'Store.updateHistory 应更新为 failed');
  assert.strictEqual(global.localStorage.getItem('volc_pending_task'), null, 'pending task 应被清除');
});

// --- 9b. Store.addHistory 抛异常 → pending 保留 + recordId 可为空 ---
test('addHistory 异常: pending 保留 + 不重复提交 + 触发恢复', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });
  // Store.addHistory 抛异常
  var origAddHistory = Store.addHistory;
  Store.addHistory = async function() { throw new Error('IndexedDB 写入失败'); };

  await handleVideoGenerate();

  // submitVideoTask 只调用1次
  assert.strictEqual(submitVideoCallCount, 1, 'submitVideoTask 应被调用1次');

  // pending task 应保留
  var pendingRaw = global.localStorage.getItem('volc_pending_task');
  assert.ok(pendingRaw, 'pending task 应保留');
  var pendingObj = JSON.parse(pendingRaw);
  assert.strictEqual(pendingObj.taskId, 'test-task-001', 'taskId 应与服务端返回值一致');
  // recordId 可以为空
  assert.ok(!pendingObj.recordId, 'recordId 应为空（本地记录保存失败）');

  // 应显示"本地记录保存失败"提示
  assert.ok(toastMessages.some(function(t) { return t.msg.indexOf('本地记录保存失败') >= 0; }), '应显示本地记录保存失败提示');

  // 应显示重新查询入口
  assert.ok(elements.vidResultPanel.innerHTML.indexOf('btnRetryQuery') >= 0, '应显示重新查询按钮');

  // 不应显示"视频提交异常"
  assert.ok(!toastMessages.some(function(t) { return t.msg.indexOf('视频提交异常') >= 0; }), '不应显示"视频提交异常"');

  // 恢复 Store.addHistory
  Store.addHistory = origAddHistory;

  // 再次点击生成：不应再次调用 submitVideoTask
  submitVideoCallCount = 0;
  pollVideoTask = async function(taskId, onProgress) {
    pollVideoCallCount++;
    return pollVideoResult;
  };
  toastMessages = [];

  await handleVideoGenerate();

  // submitVideoTask 不应再次调用
  assert.strictEqual(submitVideoCallCount, 0, '存在 pending task 时不应再次提交');

  // 应触发旧任务恢复（pollVideoTask 应被调用）
  assert.ok(pollVideoCallCount >= 1, '应触发旧任务恢复轮询');
});

// --- 9c. Store.addHistory 返回 null → 同样进入可恢复状态 ---
test('addHistory 返回 null: pending 保留 + 不显示提交异常', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });
  var origAddHistory = Store.addHistory;
  Store.addHistory = async function() { return null; };

  await handleVideoGenerate();

  // submitVideoTask 只调用1次
  assert.strictEqual(submitVideoCallCount, 1, 'submitVideoTask 应被调用1次');

  // pending task 应保留
  var pendingRaw = global.localStorage.getItem('volc_pending_task');
  assert.ok(pendingRaw, 'pending task 应保留');
  var pendingObj = JSON.parse(pendingRaw);
  assert.strictEqual(pendingObj.taskId, 'test-task-001', 'taskId 应一致');
  assert.ok(!pendingObj.recordId, 'recordId 应为空');

  // 应显示本地记录保存失败提示
  assert.ok(toastMessages.some(function(t) { return t.msg.indexOf('本地记录保存失败') >= 0; }), '应显示本地记录保存失败提示');

  // 不应显示视频提交异常
  assert.ok(!toastMessages.some(function(t) { return t.msg.indexOf('视频提交异常') >= 0; }), '不应显示视频提交异常');

  // 应显示重新查询入口
  assert.ok(elements.vidResultPanel.innerHTML.indexOf('btnRetryQuery') >= 0, '应显示重新查询按钮');

  Store.addHistory = origAddHistory;
});

// --- 10. 素材校验失败时不得调用 API ---
test('素材校验失败: 不调用 API', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: [] });
  validateVideoMediaResult = { valid: false, msg: '请上传首帧图片' };
  await handleVideoGenerate();
  assert.strictEqual(submitVideoCallCount, 0, '素材校验失败不应调用 submitVideoTask');
  assert.ok(toastMessages.some(function(t) { return t.msg === '请上传首帧图片'; }), '应显示校验失败提示');
});

// --- 11. 真实并发测试：第二次调用不得释放第一次的锁 ---
test('并发: 第二次调用不释放第一次的锁', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });

  var resolveSubmit;
  submitVideoTask = async function(params) {
    submitVideoCallCount++;
    lastSubmitParams = params;
    return new Promise(function(resolve) { resolveSubmit = resolve; });
  };
  pollVideoTask = async function(taskId, onProgress) {
    pollVideoCallCount++;
    return pollVideoResult;
  };

  var firstCall = handleVideoGenerate();
  await new Promise(function(r) { setTimeout(r, 0); });

  assert.strictEqual(videoGenState.isGenerating, true, '第一次调用后 isGenerating 应为 true');
  assert.strictEqual(elements.btnGenVideo.disabled, true, '第一次调用后按钮应 disabled');
  assert.strictEqual(elements.btnGenVideo.textContent, '提交中...', '按钮文字应为"提交中..."');
  assert.strictEqual(submitVideoCallCount, 1, 'submitVideoTask 应被调用1次');

  var secondCall = handleVideoGenerate();
  await new Promise(function(r) { setTimeout(r, 0); });

  assert.strictEqual(videoGenState.isGenerating, true, '第二次调用后 isGenerating 仍应为 true');
  assert.strictEqual(elements.btnGenVideo.disabled, true, '第二次调用后按钮仍应 disabled');
  assert.strictEqual(submitVideoCallCount, 1, '第二次调用不应额外调用 submitVideoTask');

  await secondCall;
  resolveSubmit(submitVideoResult);
  await firstCall;

  assert.strictEqual(videoGenState.isGenerating, false, '第一次完成后 isGenerating 应为 false');
  assert.strictEqual(elements.btnGenVideo.disabled, false, '第一次完成后按钮应恢复可点击');
  assert.strictEqual(elements.btnGenVideo.textContent, '生成视频', '按钮文字应恢复');
});

// --- 12. 存在有效 pending task 时点击生成 → 不提交新任务 ---
test('存在 pending task: 阻止新任务并触发恢复', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });

  // 预设一个有效的 pending task
  savePendingVideoTask('old-task-999', 'i2v', '旧任务提示词', 'rec-old-001', { model: 'test' });

  // pollVideoTask 设为可控（restorePendingVideoTask 会被调用）
  pollVideoTask = async function(taskId, onProgress) {
    pollVideoCallCount++;
    return pollVideoResult;
  };

  await handleVideoGenerate();

  // submitVideoTask 不应被调用（新任务被阻止）
  assert.strictEqual(submitVideoCallCount, 0, '存在 pending task 时不应提交新任务');

  // 原 taskId 不应被覆盖
  var pendingRaw = global.localStorage.getItem('volc_pending_task');
  assert.ok(pendingRaw, 'pending task 应仍存在');
  var pendingObj = JSON.parse(pendingRaw);
  assert.strictEqual(pendingObj.taskId, 'old-task-999', '原 taskId 不应被覆盖');

  // 应显示 warning 提示
  assert.ok(toastMessages.some(function(t) { return t.msg.indexOf('已有未完成的视频任务') >= 0; }), '应显示已有未完成任务提示');

  // 应触发恢复（pollVideoTask 应被调用）
  assert.ok(pollVideoCallCount >= 1, '应触发旧任务恢复轮询');
});

// --- 13. 过期的 pending task 被安全清除，不阻止新任务 ---
test('过期 pending task: 安全清除后正常提交', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });

  // 预设一个过期的 pending task（超过 48 小时）
  var expiredTime = Date.now() - 49 * 3600 * 1000;
  global.localStorage.setItem('volc_pending_task', JSON.stringify({
    taskId: 'expired-task', vidMode: 'i2v', prompt: '过期任务', recordId: 'rec-expired',
    params: {}, savedAt: expiredTime
  }));

  await handleVideoGenerate();

  // 新任务应正常提交
  assert.strictEqual(submitVideoCallCount, 1, '过期 task 清除后应正常提交新任务');

  // 过期 task 应已被 getValidPendingVideoTask 清除（新任务提交成功完成后会再次 clear）
  // 成功完成后 pending task 会被 clearPendingVideoTask 清除
  assert.strictEqual(global.localStorage.getItem('volc_pending_task'), null, '成功完成后 pending task 应被清除');
});

// --- 14. 损坏的 pending task 被安全清除，不阻止新任务 ---
test('损坏 pending task: 安全清除后正常提交', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });

  // 预设损坏的 pending task（无效 JSON）
  global.localStorage.setItem('volc_pending_task', 'this is not valid json {{{');

  await handleVideoGenerate();

  // 新任务应正常提交
  assert.strictEqual(submitVideoCallCount, 1, '损坏 task 清除后应正常提交新任务');
});

// --- 15. restorePendingVideoTask 网络异常 → 保持可恢复 ---
test('恢复任务网络异常: pending 保留 + timeout + 重新查询入口', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });

  // 预设有效的 pending task
  savePendingVideoTask('restore-task-001', 'i2v', '恢复任务提示词', 'rec-restore-001', { model: 'test' });

  // pollVideoTask 抛出网络异常
  pollVideoTask = async function() { throw new Error('恢复时网络断开'); };

  await restorePendingVideoTask();

  // pending task 应保留
  var pendingRaw = global.localStorage.getItem('volc_pending_task');
  assert.ok(pendingRaw, '恢复异常后 pending task 应保留');
  var pendingObj = JSON.parse(pendingRaw);
  assert.strictEqual(pendingObj.taskId, 'restore-task-001', 'taskId 不应变');

  // 历史状态应更新为 timeout
  var timeoutUpdate = savedHistoryUpdates.find(function(u) { return u.updates.status === 'timeout'; });
  assert.ok(timeoutUpdate, '历史记录应更新为 timeout');

  // 应显示查询中断提示
  assert.ok(toastMessages.some(function(t) { return t.msg.indexOf('查询暂时中断') >= 0; }), '应显示查询中断提示');

  // _currentPollingTaskId 应清理
  assert.strictEqual(global.window._currentPollingTaskId, null, '_currentPollingTaskId 应为 null');

  // vidResultPanel innerHTML 应包含 btnRetryQuery（renderVideoTimeout 被调用）
  assert.ok(elements.vidResultPanel.innerHTML.indexOf('btnRetryQuery') >= 0, '应显示重新查询按钮');
});

// --- 16. btnRetryQuery 网络异常 → 保持可恢复 ---
test('重新查询网络异常: pending 保留 + timeout + 重试按钮重新出现', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });

  // 先调用 renderVideoTimeout 创建 btnRetryQuery
  renderVideoTimeout('retry-task-001', 'rec-retry-001');

  // 确认 btnRetryQuery 存在
  var retryBtn = document.getElementById('btnRetryQuery');
  assert.ok(retryBtn, 'btnRetryQuery 应存在');

  // 预设 pending task
  savePendingVideoTask('retry-task-001', 'i2v', '重试任务', 'rec-retry-001', { model: 'test' });

  // pollVideoTask 抛出网络异常
  pollVideoTask = async function() { throw new Error('重试时网络断开'); };

  // 触发 onclick（这是 async 函数）
  await retryBtn.onclick();

  // pending task 应保留
  var pendingRaw = global.localStorage.getItem('volc_pending_task');
  assert.ok(pendingRaw, '重新查询异常后 pending task 应保留');

  // 历史状态应更新为 timeout
  var timeoutUpdate = savedHistoryUpdates.find(function(u) { return u.updates.status === 'timeout'; });
  assert.ok(timeoutUpdate, '历史记录应更新为 timeout');

  // 应显示查询中断提示
  assert.ok(toastMessages.some(function(t) { return t.msg.indexOf('查询暂时中断') >= 0; }), '应显示查询中断提示');

  // _currentPollingTaskId 应清理
  assert.strictEqual(global.window._currentPollingTaskId, null, '_currentPollingTaskId 应为 null');

  // btnRetryQuery 应重新出现（renderVideoTimeout 被再次调用）
  var newRetryBtn = document.getElementById('btnRetryQuery');
  assert.ok(newRetryBtn, 'btnRetryQuery 应重新出现');
});

// --- 17. 语法检查 ---
test('app.js 语法检查', function() {
  new Function(appCode);
});

test('api.js 语法检查', function() {
  new Function(apiCode);
});

// --- 18. 版本号检查 ---
test('APP_VERSION = 1.6.7', function() {
  assert.ok(appCode.indexOf("const APP_VERSION = '1.6.7'") >= 0, 'APP_VERSION should be 1.6.7');
});

test('index.html 版本号 v1.6.7', function() {
  var html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(html.indexOf('v1.6.7') >= 0, 'index.html should contain v1.6.7');
});

// --- 19. seedRaw 安全定义检查 ---
test('app.js handleVideoGenerate 不直接引用未定义的 seedRaw', function() {
  var fnMatch = appCode.match(/async function handleVideoGenerate\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'handleVideoGenerate must exist');
  var fnBody = fnMatch[0];
  var defIdx = fnBody.indexOf('const seedRaw');
  var oldPattern = "seedRaw === '' ? -1 : parseInt(seedRaw)";
  assert.ok(defIdx >= 0, 'seedRaw 应有定义');
  assert.ok(fnBody.indexOf(oldPattern) === -1, '不应残留旧的无定义 seedRaw 用法');
});

// --- 20. 锁在 try 之前抢占检查 ---
test('锁抢占在 try/finally 之前', function() {
  var fnMatch = appCode.match(/async function handleVideoGenerate\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'handleVideoGenerate must exist');
  var fnBody = fnMatch[0];
  var lockCheckIdx = fnBody.indexOf('if (videoGenState.isGenerating) return;');
  var lockSetIdx = fnBody.indexOf('videoGenState.isGenerating = true;');
  var tryIdx = fnBody.indexOf('try {');
  assert.ok(lockCheckIdx >= 0, '应有 isGenerating 检查');
  assert.ok(lockSetIdx >= 0, '应有 isGenerating = true');
  assert.ok(tryIdx >= 0, '应有 try {');
  assert.ok(lockCheckIdx < tryIdx, '锁检查必须在 try 之前');
  assert.ok(lockSetIdx < tryIdx, '锁设置必须在 try 之前');
  var afterTry = fnBody.substring(tryIdx);
  assert.ok(afterTry.indexOf('videoGenState.isGenerating = true;') === -1, 'try 内不应重复设置 isGenerating = true');
});

// --- 21. 非法 API Key 时锁恢复 ---
test('非法 API Key: 锁恢复且不调用 API', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });
  Store.getConfig = async function() { return { apiKey: '', apiDomain: '' }; };
  await handleVideoGenerate();
  assert.strictEqual(videoGenState.isGenerating, false, 'isGenerating 应恢复为 false');
  assert.strictEqual(submitVideoCallCount, 0, '无 API Key 时不应调用 submitVideoTask');
  assert.strictEqual(elements.btnGenVideo.disabled, false, '按钮应恢复可点击');
  Store.getConfig = async function() { return mockConfig; };
});

// --- 22. getValidPendingVideoTask 函数存在性检查 ---
test('getValidPendingVideoTask 函数存在', function() {
  assert.ok(typeof getValidPendingVideoTask === 'function', 'getValidPendingVideoTask 应为函数');
  assert.ok(typeof savePendingVideoTask === 'function', 'savePendingVideoTask 应为函数');
  assert.ok(typeof clearPendingVideoTask === 'function', 'clearPendingVideoTask 应为函数');
  assert.ok(typeof restorePendingVideoTask === 'function', 'restorePendingVideoTask 应为函数');
});

// ============ 运行 ============
asyncTests.reduce(function(p, t) {
  return p.then(function() {
    var result;
    try {
      result = t.fn();
    } catch (e) {
      testFailed++;
      testResults.push('FAIL: ' + t.name + ' - ' + e.message);
      return;
    }
    if (result && typeof result.then === 'function') {
      return result.then(function() {
        testPassed++;
        testResults.push('PASS: ' + t.name);
      }).catch(function(e) {
        testFailed++;
        testResults.push('FAIL: ' + t.name + ' - ' + (e.message || e));
      });
    } else {
      testPassed++;
      testResults.push('PASS: ' + t.name);
      return;
    }
  });
}, Promise.resolve()).then(function() {
  console.log('\n========================================');
  console.log('视频生成链路行为测试');
  console.log('========================================');
  testResults.forEach(function(r) { console.log(r); });
  console.log('\n测试总数: ' + testTotal);
  console.log('通过: ' + testPassed + '，失败: ' + testFailed);
  console.log('退出码: ' + (testFailed > 0 ? 1 : 0));
  console.log('========================================');
  if (testFailed > 0) process.exit(1);
}).catch(function(e) {
  console.error('测试执行错误:', e);
  process.exit(1);
});