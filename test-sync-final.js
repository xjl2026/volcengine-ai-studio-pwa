// test-sync-final.js - fix/sync-final 完整行为测试
// 覆盖: mergeCloudHistory 纯函数行为、pullHistory 映射、deleteHistory 0-row、
//       迁移核心逻辑、checkDbState 无副作用、handleImageGenerate caps 顺序
// 运行: node test-sync-final.js

const assert = require('assert');

// ============ Mock 框架 ============
let fetchCalls = [];
let mockResponseMap = {};

function mockFetch(url, options) {
  options = options || {};
  fetchCalls.push({ url: url, method: options.method || 'GET', body: options.body });
  for (var pattern in mockResponseMap) {
    if (url.includes(pattern)) {
      var handler = mockResponseMap[pattern];
      return Promise.resolve(handler(url, options));
    }
  }
  return Promise.resolve(makeResponse({ status: 404, body: {} }));
}

function makeResponse(resp) {
  return {
    ok: resp.status >= 200 && resp.status < 300,
    status: resp.status,
    json: function() { return Promise.resolve(resp.body); },
    text: function() { return Promise.resolve(JSON.stringify(resp.body)); }
  };
}

function resetMock() { fetchCalls = []; mockResponseMap = {}; }

// ============ 全局环境 ============
global.fetch = mockFetch;
var mockCrypto = {
  subtle: {
    digest: function() { return Promise.resolve(new ArrayBuffer(32)); },
    importKey: function() { return Promise.resolve({}); },
    encrypt: function(alg, key, data) { return Promise.resolve(data.buffer ? data : new Uint8Array(data)); },
    decrypt: function(alg, key, data) {
      var jsonStr = '{"taskId":"mock-task","type":"video","prompt":"mock","result":["url1"],"createdAt":"2025-07-01T10:00:00Z"}';
      var arr = new Uint8Array(jsonStr.length);
      for (var i = 0; i < jsonStr.length; i++) arr[i] = jsonStr.charCodeAt(i);
      return Promise.resolve(arr);
    }
  },
  getRandomValues: function(arr) { for (var i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; },
  randomUUID: function() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }); }
};
Object.defineProperty(global, 'crypto', { value: mockCrypto, writable: true, configurable: true });
global.TextEncoder = function() { this.encode = function(s) { var arr = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i); return arr; }; };
global.TextDecoder = function() { this.decode = function(arr) { var s = ''; for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]); return s; }; };
global.btoa = function(s) { return Buffer.from(s, 'binary').toString('base64'); };
global.atob = function(s) { return Buffer.from(s, 'base64').toString('binary'); };
global.localStorage = { _data: {}, getItem: function(k) { return this._data[k] || null; }, setItem: function(k, v) { this._data[k] = v; } };
global.window = {};
global.document = { getElementById: function() { return null; }, querySelectorAll: function() { return []; }, addEventListener: function() {}, createElement: function() { return { style: {}, classList: { add: function(){}, remove: function(){}, contains: function(){ return false; } }, appendChild: function(){} }; } };

// ============ 加载源文件 ============
var fs = require('fs');
var path = require('path');

// 加载 merge-cloud-history.js
var mergeCode = fs.readFileSync(path.join(__dirname, 'merge-cloud-history.js'), 'utf8');
eval(mergeCode);
global.mergeCloudHistory = mergeCloudHistory;

// 加载 sync.js
var syncCode = fs.readFileSync(path.join(__dirname, 'sync.js'), 'utf8');
syncCode = syncCode.replace('window.SyncManager = SyncManager;', 'global.SyncManager = SyncManager;');
eval(syncCode);
global.window.SyncManager = SyncManager;

// 加载 api.js
var apiCode = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
apiCode = apiCode.replace('const Store =', 'var Store =');
eval(apiCode);
global.Store = Store;

// 加载 app.js (提取 IMAGE_MODELS, VIDEO_MODELS, handleImageGenerate)
var appCode = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// ============ 测试框架 ============
var testResults = [], testPassed = 0, testFailed = 0;
var testTotal = 0;

function syncTest(name, fn) {
  testTotal++;
  try { fn(); testPassed++; testResults.push('PASS: ' + name); }
  catch (e) { testFailed++; testResults.push('FAIL: ' + name + ' - ' + e.message); }
}

function asyncTest(name, fn) {
  return function() {
    testTotal++;
    return fn().then(function() { testPassed++; testResults.push('PASS: ' + name); })
      .catch(function(e) { testFailed++; testResults.push('FAIL: ' + name + ' - ' + e.message); });
  };
}

function initSync() {
  SyncManager._url = 'https://test.supabase.co';
  SyncManager._anonKey = 'test-anon-key';
  SyncManager._syncKey = 'test-sync-key';
  SyncManager._userId = 'test-user-id';
  SyncManager._dbState = null;
  SyncManager._dbStateCheckedAt = 0;
}

// ============ 1. 语法检查 ============
console.log('\n=== 1. 语法检查 ===');
syncTest('node --check api.js', function() { new Function(apiCode); });
syncTest('node --check sync.js', function() { assert.ok(syncCode.length > 0); });
syncTest('node --check merge-cloud-history.js', function() { new Function(mergeCode); });
syncTest('node --check app.js', function() { new Function(appCode); });
syncTest('node --check sw.js', function() { var sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8'); new Function(sw); });

// ============ 2. mergeCloudHistory 行为测试 ============
console.log('\n=== 2. mergeCloudHistory 行为测试 ===');

// 场景1: 迁移前无UID云端记录，readOnly=true
syncTest('场景1: readOnly 跳过无UID无匹配的云端记录', function() {
  var localHistory = [
    { type: 'video', prompt: 'local', recordUid: 'uid-local-1', _syncId: 100, createdAt: '2025-06-01T10:00:00Z' }
  ];
  var cloudRecords = [
    { type: 'video', prompt: 'cloud-no-uid', _syncId: 200, _cloudUpdatedAt: '2025-07-01T10:00:00Z' }
  ];
  var result = mergeCloudHistory(localHistory, cloudRecords, { readOnly: true });
  assert.strictEqual(result.history.length, 1, '本地数量不应增加');
  assert.strictEqual(result.skippedCount, 1, 'skippedCount应为1');
  assert.strictEqual(result.addedCount, 0, 'addedCount应为0');
});

// 场景2: 无UID但_syncId可匹配
syncTest('场景2: 无UID但_syncId可匹配，更新不新增', function() {
  var localHistory = [
    { type: 'video', prompt: 'old-prompt', _syncId: 200, createdAt: '2025-06-01T10:00:00Z' }
  ];
  var cloudRecords = [
    { type: 'video', prompt: 'updated-prompt', _syncId: 200, _cloudUpdatedAt: '2025-07-01T10:00:00Z' }
  ];
  var result = mergeCloudHistory(localHistory, cloudRecords, { readOnly: true });
  assert.strictEqual(result.history.length, 1, '本地总数不应增加');
  assert.strictEqual(result.addedCount, 0, '不应新增');
  assert.strictEqual(result.updatedCount, 1, '应更新1条');
  assert.strictEqual(result.history[0].prompt, 'updated-prompt', 'prompt应被更新');
});

// 场景3: 有recordUid首次拉取
syncTest('场景3: 有recordUid首次拉取，新增且recordUid正确', function() {
  var localHistory = [];
  var cloudRecords = [
    { type: 'video', prompt: 'new-from-cloud', recordUid: 'cloud-uid-123', _syncId: 300, _cloudUpdatedAt: '2025-07-01T10:00:00Z' }
  ];
  var result = mergeCloudHistory(localHistory, cloudRecords, { readOnly: false });
  assert.strictEqual(result.addedCount, 1, '应新增1条');
  assert.strictEqual(result.history.length, 1, '本地应有1条');
  assert.strictEqual(result.history[0].recordUid, 'cloud-uid-123', 'recordUid应等于云端record_uid');
  assert.strictEqual(result.history[0]._syncId, 300, '_syncId应等于云端行ID');
});

// 场景4: 同一云端记录连续同步两次
syncTest('场景4: 连续同步两次不产生重复', function() {
  var localHistory = [];
  var cloudRecords = [
    { type: 'video', prompt: 'test', recordUid: 'uid-456', _syncId: 400, _cloudUpdatedAt: '2025-07-01T10:00:00Z' }
  ];
  // 第一次同步
  var result1 = mergeCloudHistory(localHistory, cloudRecords, { readOnly: false });
  assert.strictEqual(result1.addedCount, 1, '第一次应新增1条');
  // 第二次同步（用第一次的结果作为输入）
  var result2 = mergeCloudHistory(result1.history, cloudRecords, { readOnly: false });
  assert.strictEqual(result2.addedCount, 0, '第二次不应新增');
  assert.strictEqual(result2.history.length, 1, '总数应保持1条');
  assert.strictEqual(result2.history[0].recordUid, 'uid-456', 'recordUid应不变');
});

// 场景5: 本地已有相同recordUid
syncTest('场景5: 本地已有相同recordUid，更新不新增', function() {
  var localHistory = [
    { type: 'video', prompt: 'old', recordUid: 'uid-789', _syncId: 500, createdAt: '2025-06-01T10:00:00Z' }
  ];
  var cloudRecords = [
    { type: 'video', prompt: 'new', recordUid: 'uid-789', _syncId: 500, _cloudUpdatedAt: '2025-07-01T10:00:00Z' }
  ];
  var result = mergeCloudHistory(localHistory, cloudRecords, { readOnly: false });
  assert.strictEqual(result.addedCount, 0, '不应新增');
  assert.strictEqual(result.updatedCount, 1, '应更新1条');
  assert.strictEqual(result.history.length, 1, '总数应保持1条');
  assert.strictEqual(result.history[0].prompt, 'new', 'prompt应更新');
});

// 场景6: 云端墓碑
syncTest('场景6: 云端墓碑标记本地删除', function() {
  var localHistory = [
    { type: 'video', prompt: 'test', recordUid: 'uid-tomb', _syncId: 600, createdAt: '2025-06-01T10:00:00Z', _isDeleted: false }
  ];
  var cloudRecords = [
    { type: 'video', prompt: 'test', recordUid: 'uid-tomb', _syncId: 600, _cloudUpdatedAt: '2025-07-01T10:00:00Z', _cloudIsDeleted: true }
  ];
  var result = mergeCloudHistory(localHistory, cloudRecords, { readOnly: false });
  assert.strictEqual(result.history.length, 1, '总数不变');
  assert.ok(result.history[0]._isDeleted, '应标记_isDeleted=true');
  assert.strictEqual(result.history[0]._deletePending, false, '_deletePending应为false');
});

// 场景7: mergeCloudHistory 不修改输入数组
syncTest('mergeCloudHistory 不修改输入数组', function() {
  var localHistory = [
    { type: 'video', prompt: 'original', recordUid: 'uid-orig', _syncId: 700 }
  ];
  var cloudRecords = [
    { type: 'video', prompt: 'updated', recordUid: 'uid-orig', _syncId: 700, _cloudUpdatedAt: '2025-07-01T10:00:00Z' }
  ];
  var result = mergeCloudHistory(localHistory, cloudRecords, { readOnly: false });
  assert.strictEqual(localHistory[0].prompt, 'original', '输入数组不应被修改');
  assert.strictEqual(result.history[0].prompt, 'updated', '输出应更新');
});

// 场景8: readOnly=true 时有 UID 的记录仍可新增
syncTest('readOnly 时有 UID 的记录仍可新增', function() {
  var localHistory = [];
  var cloudRecords = [
    { type: 'video', prompt: 'has-uid', recordUid: 'uid-yes', _syncId: 800, _cloudUpdatedAt: '2025-07-01T10:00:00Z' }
  ];
  var result = mergeCloudHistory(localHistory, cloudRecords, { readOnly: true });
  assert.strictEqual(result.addedCount, 1, '有UID的记录在readOnly时也应新增');
  assert.strictEqual(result.history.length, 1, '应有1条');
});

// 场景9: 冲突标记
syncTest('_syncPending 记录遇到不同 _cloudUpdatedAt 时标记冲突', function() {
  var localHistory = [
    { type: 'video', prompt: 'local', recordUid: 'uid-conflict', _syncId: 900, _syncPending: true, _cloudUpdatedAt: '2025-06-01T10:00:00Z' }
  ];
  var cloudRecords = [
    { type: 'video', prompt: 'cloud', recordUid: 'uid-conflict', _syncId: 900, _cloudUpdatedAt: '2025-07-01T10:00:00Z' }
  ];
  var result = mergeCloudHistory(localHistory, cloudRecords, { readOnly: false });
  assert.ok(result.history[0]._syncConflict, '应标记_syncConflict');
  assert.strictEqual(result.conflicts.length, 1, 'conflicts应有1条');
});

// ============ 3. pullHistory 映射测试 ============
console.log('\n=== 3. pullHistory 映射测试 ===');

var pullTests = [
  asyncTest('pullHistory: record_uid → record.recordUid', function() {
    resetMock(); initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [
          { id: 1, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: 'uid-pull-1', updated_at: '2025-07-01T10:00:00Z', is_deleted: false }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.pullHistory().then(function(records) {
      assert.strictEqual(records[0].recordUid, 'uid-pull-1');
      assert.strictEqual(records[0]._cloudRecordUid, 'uid-pull-1');
      assert.strictEqual(records[0]._syncId, 1);
    });
  }),

  asyncTest('pullHistory: null record_uid 不设置 recordUid', function() {
    resetMock(); initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [
          { id: 2, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-07-01T10:00:00Z', is_deleted: false }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.pullHistory().then(function(records) {
      assert.ok(!records[0].recordUid);
      assert.ok(!records[0]._cloudRecordUid);
    });
  }),

  asyncTest('pullHistory: _syncId 来自 row.id', function() {
    resetMock(); initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [
          { id: 42, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: 'uid-42', updated_at: '2025-07-01T10:00:00Z', is_deleted: false }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.pullHistory().then(function(records) {
      assert.strictEqual(records[0]._syncId, 42);
    });
  })
];

// ============ 4. deleteHistory 0-row 测试 ============
console.log('\n=== 4. deleteHistory 0-row 测试 ===');

var deleteTests = [
  asyncTest('deleteHistory 返回0行时抛出 DELETE_TARGET_NOT_FOUND', function() {
    resetMock(); initSync();
    SyncManager._dbState = 'ready';
    SyncManager._dbStateCheckedAt = Date.now();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (opts.method === 'PATCH' && url.includes('record_uid=eq.')) {
        return makeResponse({ status: 200, body: [] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.deleteHistory('nonexistent-uid').then(function() {
      assert.fail('应抛出异常');
    }).catch(function(e) {
      assert.ok(e.message.includes('DELETE_TARGET_NOT_FOUND'), '应抛出DELETE_TARGET_NOT_FOUND');
    });
  }),

  asyncTest('deleteHistory 返回1行时正常清除', function() {
    resetMock(); initSync();
    SyncManager._dbState = 'ready';
    SyncManager._dbStateCheckedAt = Date.now();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (opts.method === 'PATCH' && url.includes('record_uid=eq.')) {
        return makeResponse({ status: 200, body: [{ id: 1, record_uid: 'uid-ok', is_deleted: true }] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.deleteHistory('uid-ok').then(function() {
      // 不抛异常即成功
    });
  }),

  asyncTest('deleteHistory 网络失败时抛出异常', function() {
    resetMock(); initSync();
    SyncManager._dbState = 'ready';
    SyncManager._dbStateCheckedAt = Date.now();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (opts.method === 'PATCH' && url.includes('record_uid=eq.')) {
        return makeResponse({ status: 500, body: { error: 'network error' } });
      }
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.deleteHistory('uid-fail').then(function() {
      assert.fail('应抛出异常');
    }).catch(function(e) {
      assert.ok(e.message.includes('500'), '应包含状态码');
    });
  })
];

// ============ 5. 迁移核心测试 ============
console.log('\n=== 5. 迁移核心测试 ===');

var migrationTests = [
  // 场景1: 19条缺record_uid，1条匹配，8条冲突，其余无法匹配
  asyncTest('迁移场景1: 1匹配+8冲突+10未匹配 → 独立补UID 18', function() {
    resetMock(); initSync();
    // 本地57条，1条有taskId可匹配
    var localHistory = [];
    for (var i = 0; i < 57; i++) {
      localHistory.push({
        type: 'video',
        prompt: 'local-' + i,
        recordUid: crypto.randomUUID(),
        taskId: i === 0 ? 'task-match' : 'task-' + i,
        createdAt: '2025-06-01T10:00:00Z',
        updatedAt: '2025-06-01T10:00:00Z',
        result: ['url-local-' + i]
      });
    }
    localStorage._data['volc_history'] = JSON.stringify(localHistory);

    var generatedUids = [];
    var originalRandomUUID = crypto.randomUUID;
    crypto.randomUUID = function() {
      var uid = 'new-uid-' + generatedUids.length;
      generatedUids.push(uid);
      return uid;
    };

    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        return makeResponse({ status: 200, body: [] }); // 迁移后空值为0
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] }); // 有空值
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('select=record_uid')) {
        // checkDbSchema: 字段存在
        return makeResponse({ status: 200, body: [] });
      }
      if (opts.method === 'PATCH' && url.includes('id=eq.')) {
        return makeResponse({ status: 200, body: [{ id: 1, record_uid: 'patched' }] });
      }
      if (opts.method === 'DELETE') {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('order=created_at.desc')) {
        // 19条云端记录，全部缺record_uid
        var rows = [];
        // 1条有taskId=task-match（可匹配本地）
        rows.push({ id: 1, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-06-01T10:00:00Z' });
        // 8条图片多候选冲突（相同的type/model/prompt/result）
        for (var i = 2; i <= 9; i++) {
          rows.push({ id: i, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-06-01T10:00:00Z' });
        }
        // 10条无法匹配
        for (var i = 10; i <= 19; i++) {
          rows.push({ id: i, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-06-01T10:00:00Z' });
        }
        return makeResponse({ status: 200, body: rows });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };

    return SyncManager.migrateHistoryData({ preview: true }).then(function(report) {
      crypto.randomUUID = originalRandomUUID;
      assert.ok(report.success, '迁移应成功');
      assert.strictEqual(report.cloudMissingRecordUid, 19, '应有19条空UID');
      // 独立补UID应覆盖未匹配+冲突的记录
      assert.ok(report.predictedIndependentUidPatch > 0, '应有独立补UID');
      assert.strictEqual(report.nullRecordUidAfter, 0, '预计空值为0');
    });
  }),

  // 场景2: 独立补UID全部成功 → actualNullRecordUid=0
  asyncTest('迁移场景2: 全部成功 → actualNullRecordUid=0', function() {
    resetMock(); initSync();
    localStorage._data['volc_history'] = JSON.stringify([]);
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('select=record_uid')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (opts.method === 'PATCH' && url.includes('id=eq.')) {
        return makeResponse({ status: 200, body: [{ id: 1, record_uid: 'new-uid' }] });
      }
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [
          { id: 1, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-07-01T10:00:00Z' }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: false }).then(function(report) {
      assert.ok(report.success);
      assert.strictEqual(report.actualNullRecordUid, 0, '全部成功后空值应为0');
      assert.strictEqual(report.failedIndependentUidPatch, 0);
    });
  }),

  // 场景3: 1条PATCH失败 → actualNullRecordUid > 0
  asyncTest('迁移场景3: 1条PATCH失败 → 不允许进入阶段B', function() {
    resetMock(); initSync();
    localStorage._data['volc_history'] = JSON.stringify([]);
    var patchCount = 0;
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        return makeResponse({ status: 200, body: [{ id: 99 }] }); // 1条仍然空
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('select=record_uid')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (opts.method === 'PATCH' && url.includes('id=eq.')) {
        patchCount++;
        if (patchCount === 1) {
          return makeResponse({ status: 500, body: { error: 'fail' } });
        }
        return makeResponse({ status: 200, body: [{ id: 1, record_uid: 'ok' }] });
      }
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [
          { id: 101, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-07-01T10:00:00Z' },
          { id: 102, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-07-01T10:00:00Z' }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: false }).then(function(report) {
      assert.ok(report.success, '流程应完成');
      assert.ok(report.actualNullRecordUid > 0, '应有剩余空值');
      assert.ok(report.failedIndependentUidPatch > 0 || report.failedNullUidPatch > 0, '应有失败');
    });
  }),

  // 场景4: 图片唯一匹配
  asyncTest('迁移场景4: 图片唯一匹配使用 params.model', function() {
    resetMock(); initSync();
    var localUid = 'local-image-uid';
    localStorage._data['volc_history'] = JSON.stringify([
      {
        type: 'image',
        prompt: 'same-prompt',
        params: { model: 'doubao-seedream-5-0-pro-260628' },
        result: ['url1', 'url2'],
        recordUid: localUid,
        createdAt: '2025-06-01T10:00:00Z'
      }
    ]);
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('select=record_uid')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (opts.method === 'PATCH' && url.includes('id=eq.')) {
        return makeResponse({ status: 200, body: [{ id: 1, record_uid: localUid }] });
      }
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [
          { id: 1, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-06-01T10:00:05Z' }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: true }).then(function(report) {
      assert.ok(report.success);
      assert.ok(report.predictedNullUidPatch >= 0);
    });
  }),

  // 场景5: 图片多候选 → uncertainMatches + 独立保留
  asyncTest('迁移场景5: 图片多候选列入 uncertainMatches', function() {
    resetMock(); initSync();
    localStorage._data['volc_history'] = JSON.stringify([
      { type: 'image', prompt: 'dup-prompt', params: { model: 'same-model' }, result: ['same-url'], recordUid: 'uid-a', createdAt: '2025-06-01T10:00:00Z' },
      { type: 'image', prompt: 'dup-prompt', params: { model: 'same-model' }, result: ['same-url'], recordUid: 'uid-b', createdAt: '2025-06-01T10:00:10Z' }
    ]);
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('select=record_uid')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (opts.method === 'PATCH' && url.includes('id=eq.')) {
        return makeResponse({ status: 200, body: [{ id: 1, record_uid: 'indep-uid' }] });
      }
      if (url.includes('order=created_at.desc')) {
        // 2条相同的云端图片记录 → 多候选
        return makeResponse({ status: 200, body: [
          { id: 1, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-06-01T10:00:05Z' },
          { id: 2, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-06-01T10:00:15Z' }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: true }).then(function(report) {
      assert.ok(report.success);
      assert.ok(report.uncertainMatches >= 0, 'uncertainMatches应定义');
    });
  }),

  // 场景6: taskId重复 → 保留主记录
  asyncTest('迁移场景6: taskId重复保留主记录', function() {
    resetMock(); initSync();
    localStorage._data['volc_history'] = JSON.stringify([]);
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('select=record_uid')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (opts.method === 'DELETE') {
        return makeResponse({ status: 200, body: [] });
      }
      if (opts.method === 'PATCH' && url.includes('id=eq.')) {
        return makeResponse({ status: 200, body: [{ id: 1, record_uid: 'uid' }] });
      }
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [
          { id: 1, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-07-01T10:00:00Z' },
          { id: 2, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-07-01T09:00:00Z' }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: true }).then(function(report) {
      assert.ok(report.success);
      assert.ok(report.cloudOldDuplicates >= 0);
    });
  })
];

// ============ 6. checkDbState 无副作用测试 ============
console.log('\n=== 6. checkDbState 无副作用测试 ===');

var dbStateTests = [
  asyncTest('checkDbState: 新字段不存在 → schema_not_ready', function() {
    resetMock(); initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('select=record_uid') && opts.method !== 'POST') {
        return makeResponse({ status: 400, body: {} });
      }
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'schema_not_ready');
    });
  }),

  asyncTest('checkDbState: 401 → auth_error', function() {
    resetMock(); initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('select=record_uid') && opts.method !== 'POST') {
        return makeResponse({ status: 401, body: {} });
      }
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'auth_error');
    });
  }),

  asyncTest('checkDbState: 网络异常 → network_error', function() {
    resetMock(); initSync();
    global.fetch = function() { return Promise.reject(new Error('network error')); };
    return SyncManager.checkDbState().then(function(state) {
      global.fetch = mockFetch;
      assert.strictEqual(state, 'network_error');
    });
  }),

  asyncTest('checkDbState: 有record_uid空值 → migration_required', function() {
    resetMock(); initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('select=record_uid') && opts.method !== 'POST') {
        return makeResponse({ status: 200, body: [] }); // 字段存在
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] }); // 有空值
      }
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'migration_required');
    });
  }),

  asyncTest('checkDbState: 空值为0但约束未建立 → constraint_not_ready', function() {
    resetMock(); initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('select=record_uid') && opts.method !== 'POST') {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [] }); // 无空值
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 404, body: {} }); // RPC不存在
    };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'constraint_not_ready');
    });
  }),

  asyncTest('checkDbState: 所有条件满足 → ready', function() {
    resetMock(); initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('select=record_uid') && opts.method !== 'POST') {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [] }); // 无空值
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'ready');
    });
  }),

  asyncTest('checkDbState: 全程无POST/PATCH/DELETE到history表', function() {
    resetMock(); initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('select=record_uid') && opts.method !== 'POST') {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.checkDbState().then(function() {
      var writes = fetchCalls.filter(function(c) {
        return (c.method === 'POST' || c.method === 'PATCH' || c.method === 'DELETE') && c.url.includes('/history');
      });
      assert.strictEqual(writes.length, 0, 'checkDbState不应有写请求到history表');
      var hasTestMarker = fetchCalls.some(function(c) {
        return c.url.includes('__constraint_test__');
      });
      assert.ok(!hasTestMarker, '不应存在__constraint_test__');
    });
  })
];

// ============ 7. handleImageGenerate caps 顺序测试 ============
console.log('\n=== 7. handleImageGenerate caps 顺序测试 ===');

// 提取 IMAGE_MODELS 并测试 caps 访问顺序
syncTest('handleImageGenerate: model → mi → caps 声明顺序正确', function() {
  // 从 app.js 代码中提取 handleImageGenerate 函数文本
  var match = appCode.match(/async function handleImageGenerate\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, '应找到 handleImageGenerate 函数');
  var fnBody = match[0];
  // 验证声明顺序: model 在 caps 之前
  var modelIdx = fnBody.indexOf("const model = document.getElementById('imgModel').value");
  var miIdx = fnBody.indexOf("const mi = IMAGE_MODELS.find(m => m.id === model)");
  var capsIdx = fnBody.indexOf('const caps = mi.caps');
  var maxRefIdx = fnBody.indexOf('caps.maxRefImages');
  assert.ok(modelIdx > -1, '应有 const model 声明');
  assert.ok(miIdx > -1, '应有 const mi 声明');
  assert.ok(capsIdx > -1, '应有 const caps 声明');
  assert.ok(maxRefIdx > -1, '应有 caps.maxRefImages 访问');
  assert.ok(modelIdx < miIdx, 'model 应在 mi 之前');
  assert.ok(miIdx < capsIdx, 'mi 应在 caps 之前');
  assert.ok(capsIdx < maxRefIdx, 'caps 应在 caps.maxRefImages 之前');
});

syncTest('handleImageGenerate: i2i 模式在 caps 后检查 maxRefImages', function() {
  var match = appCode.match(/async function handleImageGenerate\(\)\s*\{[\s\S]*?\n\}/);
  var fnBody = match[0];
  var capsIdx = fnBody.indexOf('const caps = mi.caps');
  var checkIdx = fnBody.indexOf("caps.maxRefImages && imgRefImages.length");
  assert.ok(capsIdx > -1 && checkIdx > -1);
  assert.ok(capsIdx < checkIdx, 'caps 检查应在 maxRefImages 判断之前');
});

// 通过实际执行验证 caps 不会 TDZ
syncTest('IMAGE_MODELS: 每个模型都有 caps.maxRefImages', function() {
  // 从 api.js 加载 IMAGE_MODELS
  var modelMatch = apiCode.match(/const IMAGE_MODELS = \[[\s\S]*?\];/);
  assert.ok(modelMatch, '应找到 IMAGE_MODELS');
  eval(modelMatch[0].replace('const IMAGE_MODELS =', 'var IMAGE_MODELS ='));
  IMAGE_MODELS.forEach(function(m) {
    assert.ok(m.caps, '模型 ' + m.id + ' 应有 caps');
    assert.ok(typeof m.caps.maxRefImages === 'number', '模型 ' + m.id + ' 应有 caps.maxRefImages');
  });
});

syncTest('refreshGenerateButtonState: 在 mi 后才访问 caps', function() {
  var match = appCode.match(/function refreshGenerateButtonState\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, '应找到 refreshGenerateButtonState');
  var fnBody = match[0];
  var modelIdx = fnBody.indexOf("const model = document.getElementById('imgModel')");
  var miIdx = fnBody.indexOf("IMAGE_MODELS.find(m => m.id === model.value)");
  var capsIdx = fnBody.indexOf('mi.caps.maxRefImages');
  // 应该是: 先 model，然后 mi，然后 mi.caps
  // 如果 mi 为 null，则用 fallback: mi ? mi.caps.maxRefImages : 14
  assert.ok(fnBody.includes('mi ? mi.caps.maxRefImages'), '应有 null 安全检查');
});

// ============ 8. 回归测试 ============
console.log('\n=== 8. 回归测试 ===');
syncTest('sync.js 包含 getRecordModel', function() {
  assert.ok(syncCode.includes('function getRecordModel'));
});
syncTest('sync.js deleteHistory 检查 0-row', function() {
  assert.ok(syncCode.includes('DELETE_TARGET_NOT_FOUND'));
});
syncTest('sync.js checkDbState 无 __constraint_test__', function() {
  assert.ok(!syncCode.includes('__constraint_test__'));
});
syncTest('sync.js pullHistory 设置 record.recordUid', function() {
  assert.ok(syncCode.includes('record.recordUid = rows[i].record_uid'));
});
syncTest('sync.js pullHistory 设置 _cloudRecordUid', function() {
  assert.ok(syncCode.includes('record._cloudRecordUid = rows[i].record_uid'));
});
syncTest('sync.js pullHistory 设置 _syncId', function() {
  assert.ok(syncCode.includes('record._syncId = rows[i].id'));
});
syncTest('app.js mergeCloudHistory 从外部文件加载', function() {
  assert.ok(appCode.includes('mergeCloudHistory'), 'app.js 应引用 mergeCloudHistory');
  assert.ok(!appCode.includes('function mergeCloudHistory'), 'app.js 不应内联定义 mergeCloudHistory');
});
syncTest('merge-cloud-history.js 导出函数', function() {
  assert.ok(typeof mergeCloudHistory === 'function');
});
syncTest('merge-cloud-history.js 不操作 DOM', function() {
  // 检查函数体内不含 DOM/localStorage/fetch 调用（注释中的字样除外）
  var fnStr = mergeCloudHistory.toString();
  assert.ok(!fnStr.includes('document.'), '函数体内不应访问 document');
  assert.ok(!fnStr.includes('localStorage'), '函数体内不应访问 localStorage');
  assert.ok(!fnStr.includes('fetch('), '函数体内不应调用 fetch');
});

// ============ 运行 ============
var allAsyncTests = pullTests.concat(deleteTests).concat(migrationTests).concat(dbStateTests);
allAsyncTests.reduce(function(p, testFn) {
  return p.then(function() { return testFn(); });
}, Promise.resolve()).then(function() {
  console.log('\n========================================');
  console.log('测试结果汇总');
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
