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

global.document = {
  getElementById: function(id) { return elements[id] || null; },
  querySelectorAll: function() { return []; },
  querySelector: function() { return null; },
  addEventListener: function() {},
  createElement: function() { return createElement(); }
};

global.window = {
  _currentPollingTaskId: null,
  _historyRendered: false
};
global.navigator = { onLine: true };
global.localStorage = { _data: {}, getItem: function(k) { return this._data[k] || null; }, setItem: function(k, v) { this._data[k] = v; }, removeItem: function(k) { delete this._data[k]; } };

// ============ Mock state ============
var toastMessages = [];
var savedHistoryUpdate = null;
var submitVideoCallCount = 0;
var lastSubmitParams = null;
var pollVideoCallCount = 0;
var setVideoFormDisabledCallCount = 0;
var setVideoFormDisabledLastArg = null;

var mockConfig = { apiKey: 'test-key', apiDomain: 'https://ark.cn-beijing.volces.com' };

// ============ Mock functions ============
function showToast(msg, type) { toastMessages.push({ msg: msg, type: type }); }
function renderVideoTaskStatus() {}
function renderVideoResult() {}
function renderVideoTimeout() {}
function notifyTaskComplete() {}
function switchPage() {}
function setVideoFormDisabled(disabled) { setVideoFormDisabledCallCount++; setVideoFormDisabledLastArg = disabled; }
function savePendingVideoTask() {}
function clearPendingVideoTask() { global.localStorage.removeItem('volc_pending_task'); }
function getVidModeLabel(m) { return m; }
function escapeHtml(s) { return s; }
function escapeAttr(s) { return s; }

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

// 替换 Store 为 mock 版本（api.js 的 Store 依赖 localStorage，我们用 mock）
Store = {
  getConfig: async function() { return mockConfig; },
  addHistory: async function(record) { return Object.assign({ id: 'rec-001' }, record); },
  updateHistory: async function(id, updates) { savedHistoryUpdate = { id: id, updates: updates }; return true; }
};

// 替换 submitVideoTask 和 pollVideoTask（api.js 的版本会发送真实 HTTP 请求）
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

// ============ 加载 app.js 并提取 handleVideoGenerate 函数体 ============
var appCode = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// 提取 handleVideoGenerate 完整函数
var handlerMatch = appCode.match(/async function handleVideoGenerate\(\)\s*\{[\s\S]*?\n\}/);
assert.ok(handlerMatch, '必须找到 handleVideoGenerate 定义');
var handlerSource = handlerMatch[0];

// 使用 eval 在当前作用域定义函数 — 当前作用域有所有需要的 mock 变量
eval(handlerSource);

// 也提取 buildVideoRequestBody（已在 api.js eval 中定义）
assert.ok(typeof buildVideoRequestBody === 'function', 'buildVideoRequestBody must be loaded');

// ============ 测试辅助 ============
function setupTestEnvironment(opts) {
  opts = opts || {};
  setupDOM(opts);
  vidMode = opts.vidMode || 'i2v';
  vidFirstImage = opts.vidFirstImage || [];
  vidTailImage = opts.vidTailImage || [];
  vidRefImages = opts.vidRefImages || [];
  vidRefVideoUrls = [];
  vidRefAudios = [];
  videoGenState.isGenerating = false;
  global.window._currentPollingTaskId = null;
  global.window._historyRendered = false;
  submitVideoCallCount = 0;
  pollVideoCallCount = 0;
  lastSubmitParams = null;
  toastMessages = [];
  savedHistoryUpdate = null;
  submitVideoResult = { success: true, data: { id: 'test-task-001' } };
  pollVideoResult = { success: true, data: { content: { video_url: 'https://example.com/video.mp4' } } };
  validateVideoMediaResult = { valid: true, msg: '' };
  setVideoFormDisabledCallCount = 0;
  setVideoFormDisabledLastArg = null;
  // 每次都重新赋值 mock 函数，防止被其他测试覆盖后残留
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
  delete elements.vidResolution;
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

// --- 8. 轮询抛异常后清理 _currentPollingTaskId ---
test('轮询异常: 清理 _currentPollingTaskId', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });
  // 替换 pollVideoTask 为抛出异常的版本
  pollVideoTask = async function() { throw new Error('网络断开'); };

  await handleVideoGenerate();
  assert.strictEqual(global.window._currentPollingTaskId, null, '轮询异常后 _currentPollingTaskId 应为 null');
  assert.strictEqual(videoGenState.isGenerating, false, 'isGenerating 应恢复为 false');
});

// --- 9. 成功状态但没有 video_url：标记为 failed ---
test('成功但无 video_url: 标记为 failed 不留 pending', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });
  pollVideoResult = { success: true, data: { content: {} } };
  await handleVideoGenerate();
  assert.ok(toastMessages.some(function(t) { return t.msg.indexOf('未返回视频URL') >= 0; }), '应显示未返回视频URL提示');
  assert.ok(savedHistoryUpdate, 'Store.updateHistory 应被调用');
  assert.strictEqual(savedHistoryUpdate.updates.status, 'failed', '记录状态应为 failed');
  assert.strictEqual(global.localStorage.getItem('volc_pending_task'), null, 'pending task 应被清除');
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

  // 用可控的 pending Promise 控制 submitVideoTask 的完成时机
  var resolveSubmit;
  submitVideoTask = async function(params) {
    submitVideoCallCount++;
    lastSubmitParams = params;
    // 返回一个不会自动完成的 Promise，等待外部 resolve
    return new Promise(function(resolve) { resolveSubmit = resolve; });
  };
  // pollVideoTask 不会被调用到（submitVideoTask 未完成），但以防万一设个默认值
  pollVideoTask = async function(taskId, onProgress) {
    pollVideoCallCount++;
    return pollVideoResult;
  };

  // 启动第一次调用（不 await，让它在 submitVideoTask 处挂起）
  var firstCall = handleVideoGenerate();

  // 让微任务队列跑一轮，让第一次调用执行到 await submitVideoTask
  await new Promise(function(r) { setTimeout(r, 0); });

  // 第一次调用应该已抢占锁
  assert.strictEqual(videoGenState.isGenerating, true, '第一次调用后 isGenerating 应为 true');
  assert.strictEqual(elements.btnGenVideo.disabled, true, '第一次调用后按钮应 disabled');
  assert.strictEqual(elements.btnGenVideo.textContent, '提交中...', '第一次调用后按钮文字应为"提交中..."');

  // 第一次 submitVideoTask 应已调用一次
  assert.strictEqual(submitVideoCallCount, 1, '第一次调用后 submitVideoTask 应被调用1次');

  // 第二次调用（第一次尚未结束）
  var secondCall = handleVideoGenerate();

  // 让微任务队列跑一轮
  await new Promise(function(r) { setTimeout(r, 0); });

  // 第二次调用应直接返回（锁被占用），不释放第一次的锁
  assert.strictEqual(videoGenState.isGenerating, true, '第二次调用后 isGenerating 仍应为 true');
  assert.strictEqual(elements.btnGenVideo.disabled, true, '第二次调用后按钮仍应 disabled');
  // submitVideoTask 仍只被调用一次（第二次未进入提交逻辑）
  assert.strictEqual(submitVideoCallCount, 1, '第二次调用不应额外调用 submitVideoTask');

  // 等第二次调用完成（它是同步返回的，但 await 一下确保安全）
  await secondCall;

  // 释放第一次的 Promise
  resolveSubmit(submitVideoResult);

  // 等第一次调用完成
  await firstCall;

  // 第一次完成后锁应释放
  assert.strictEqual(videoGenState.isGenerating, false, '第一次完成后 isGenerating 应为 false');
  assert.strictEqual(elements.btnGenVideo.disabled, false, '第一次完成后按钮应恢复可点击');
  assert.strictEqual(elements.btnGenVideo.textContent, '生成视频', '第一次完成后按钮文字应恢复');
});

// --- 12. 语法检查 ---
test('app.js 语法检查', function() {
  new Function(appCode);
});

test('api.js 语法检查', function() {
  new Function(apiCode);
});

// --- 13. 版本号检查 ---
test('APP_VERSION = 1.6.7', function() {
  assert.ok(appCode.indexOf("const APP_VERSION = '1.6.7'") >= 0, 'APP_VERSION should be 1.6.7');
});

test('index.html 版本号 v1.6.7', function() {
  var html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(html.indexOf('v1.6.7') >= 0, 'index.html should contain v1.6.7');
});

// --- 14. seedRaw 安全定义检查 ---
test('app.js handleVideoGenerate 不直接引用未定义的 seedRaw', function() {
  var fnMatch = appCode.match(/async function handleVideoGenerate\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'handleVideoGenerate must exist');
  var fnBody = fnMatch[0];
  var defIdx = fnBody.indexOf('const seedRaw');
  var oldPattern = "seedRaw === '' ? -1 : parseInt(seedRaw)";
  assert.ok(defIdx >= 0, 'seedRaw 应有定义');
  assert.ok(fnBody.indexOf(oldPattern) === -1, '不应残留旧的无定义 seedRaw 用法');
});

// --- 15. 锁在 try 之前抢占检查 ---
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
  // 锁检查和设置必须在 try 之前
  assert.ok(lockCheckIdx < tryIdx, '锁检查必须在 try 之前');
  assert.ok(lockSetIdx < tryIdx, '锁设置必须在 try 之前');
  // 不应在 try 内部重复设置 isGenerating = true
  var afterTry = fnBody.substring(tryIdx);
  assert.ok(afterTry.indexOf('videoGenState.isGenerating = true;') === -1, 'try 内不应重复设置 isGenerating = true');
});

// --- 16. 非法 API Key 时锁恢复 ---
test('非法 API Key: 锁恢复且不调用 API', async function() {
  setupTestEnvironment({ vidMode: 'i2v', vidFirstImage: ['data:image/png;base64,abc'] });
  Store.getConfig = async function() { return { apiKey: '', apiDomain: '' }; };
  await handleVideoGenerate();
  assert.strictEqual(videoGenState.isGenerating, false, 'isGenerating 应恢复为 false');
  assert.strictEqual(submitVideoCallCount, 0, '无 API Key 时不应调用 submitVideoTask');
  assert.strictEqual(elements.btnGenVideo.disabled, false, '按钮应恢复可点击');
  // 恢复 Store.getConfig
  Store.getConfig = async function() { return mockConfig; };
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