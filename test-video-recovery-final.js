'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const appCode = fs.readFileSync('app.js', 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, '未找到函数: ' + signature);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('函数括号不完整: ' + signature);
}

const storage = () => ({
  data: Object.create(null),
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; },
  setItem(k, v) { this.data[k] = String(v); },
  removeItem(k) { delete this.data[k]; }
});

global.window = { _volatilePendingVideoTask: null };
global.localStorage = storage();
global.sessionStorage = storage();
global.getVidModeLabel = mode => mode === 'i2v' ? '图生视频' : '文生视频';

let history = [];
let addCalls = 0;
global.Store = {
  async getHistory() { return JSON.parse(JSON.stringify(history)); },
  async updateHistory(id, patch) {
    const item = history.find(row => row.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    return JSON.parse(JSON.stringify(item));
  },
  async addHistory(record) {
    addCalls++;
    const existing = history.find(row => row.taskId === record.taskId);
    if (existing) return JSON.parse(JSON.stringify(existing));
    const row = Object.assign({ id: 'new-' + addCalls }, record);
    history.unshift(row);
    return JSON.parse(JSON.stringify(row));
  }
};

for (const signature of [
  'function clearPendingVideoTask()',
  'function getValidPendingVideoTask()',
  'async function persistVideoTerminalState(options)'
]) {
  vm.runInThisContext(extractFunction(appCode, signature), { filename: 'app.js' });
}

async function run(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
  } catch (error) {
    console.error('FAIL:', name);
    throw error;
  }
}

(async () => {
  await run('损坏 localStorage 不得删除有效 sessionStorage', async () => {
    clearPendingVideoTask();
    localStorage.setItem('volc_pending_task', '{broken json');
    sessionStorage.setItem('volc_pending_task', JSON.stringify({
      taskId: 'session-task', savedAt: Date.now(), recordId: 'session-record'
    }));
    const task = getValidPendingVideoTask();
    assert.strictEqual(task.taskId, 'session-task');
    assert.strictEqual(task.recordId, 'session-record');
  });

  await run('旧 localStorage 不得覆盖更新的 session/volatile recordId', async () => {
    clearPendingVideoTask();
    const now = Date.now();
    localStorage.setItem('volc_pending_task', JSON.stringify({
      taskId: 'same-task', savedAt: now, recordId: null
    }));
    sessionStorage.setItem('volc_pending_task', JSON.stringify({
      taskId: 'same-task', savedAt: now, recordId: 'new-record'
    }));
    window._volatilePendingVideoTask = {
      taskId: 'same-task', savedAt: now, recordId: 'new-record'
    };
    const task = getValidPendingVideoTask();
    assert.strictEqual(task.recordId, 'new-record');
    assert.strictEqual(JSON.parse(localStorage.getItem('volc_pending_task')).recordId, 'new-record');
  });

  await run('recordId 失效时必须按 taskId 更新现有记录而不是调用 addHistory', async () => {
    history = [{
      id: 'real-record', taskId: 'task-1', status: 'pending', result: [],
      prompt: '原提示词', params: { model: 'm', resolution: '1080p', duration: '12' }
    }];
    addCalls = 0;
    const row = await persistVideoTerminalState({
      taskId: 'task-1', recordId: 'stale-record', vidMode: 'i2v',
      prompt: '原提示词', params: { model: 'm' }, status: 'succeeded',
      videoUrl: 'https://example.com/video.mp4', lastFrameUrl: null
    });
    assert.strictEqual(row.id, 'real-record');
    assert.strictEqual(row.status, 'succeeded');
    assert.strictEqual(row.result[0], 'https://example.com/video.mp4');
    assert.strictEqual(addCalls, 0);
  });

  await run('新增终态记录必须保留完整元数据', async () => {
    history = [];
    addCalls = 0;
    const params = { model: 'doubao-seedance-2-0-260128', resolution: '1080p', duration: '12' };
    const row = await persistVideoTerminalState({
      taskId: 'task-new', recordId: null, vidMode: 'i2v',
      prompt: '测试提示词', params, status: 'succeeded',
      videoUrl: 'https://example.com/new.mp4', lastFrameUrl: null
    });
    assert.strictEqual(row.prompt, '测试提示词');
    assert.deepStrictEqual(row.params, params);
    assert.strictEqual(row.mode, '图生视频');
  });

  await run('Store 返回成功但未真实落盘时必须抛错', async () => {
    history = [{ id: 'silent', taskId: 'task-silent', status: 'pending', result: [] }];
    const originalUpdate = Store.updateHistory;
    Store.updateHistory = async function(id, patch) {
      return Object.assign({ id, taskId: 'task-silent' }, patch);
    };
    await assert.rejects(() => persistVideoTerminalState({
      taskId: 'task-silent', recordId: 'silent', vidMode: 'i2v',
      prompt: '', params: {}, status: 'succeeded',
      videoUrl: 'https://example.com/silent.mp4', lastFrameUrl: null
    }), /未实际落盘/);
    Store.updateHistory = originalUpdate;
  });

  assert.ok(appCode.includes('let submittedTaskInfo = null;'), '必须保存提交时任务元数据');
  assert.ok(appCode.includes('submittedTaskInfo = { vidMode, prompt, params: historyParams };'), '必须保存原参数快照');
  assert.ok(appCode.includes('renderVideoTimeout(submittedTaskId, submittedRecordId, submittedTaskInfo || undefined);'), '异常恢复必须传原参数快照');

  console.log('\nVideo recovery final tests: 5/5 passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
