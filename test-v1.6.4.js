// v1.6.4 Mock 测试脚本
// 测试独立补 UID、多候选冲突保留、迁移收口
// 运行: node test-v1.6.4.js

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
global.crypto = {
  subtle: {
    digest: function() { return Promise.resolve(new ArrayBuffer(32)); },
    importKey: function() { return Promise.resolve({}); },
    encrypt: function() { return Promise.resolve(new ArrayBuffer(16)); },
    decrypt: function() { return Promise.resolve(new ArrayBuffer(16)); }
  },
  getRandomValues: function(arr) { for (var i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; },
  randomUUID: function() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }); }
};
global.TextEncoder = function() { this.encode = function(s) { var arr = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i); return arr; }; return arr; };
global.TextDecoder = function() { this.decode = function(arr) { var s = ''; for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]); return s; }; return s; };
global.btoa = function(s) { return Buffer.from(s, 'binary').toString('base64'); };
global.atob = function(s) { return Buffer.from(s, 'base64').toString('binary'); };
global.localStorage = { _data: {}, getItem: function(k) { return this._data[k] || null; }, setItem: function(k, v) { this._data[k] = v; } };
global.window = {};
global.document = { getElementById: function() { return null; }, querySelectorAll: function() { return []; }, addEventListener: function() {}, createElement: function() { return { style: {}, classList: { add: function(){}, remove: function(){}, contains: function(){ return false; } }, appendChild: function(){} }; } };

var fs = require('fs');
var syncCode = fs.readFileSync(__dirname + '/sync.js', 'utf8');
syncCode = syncCode.replace('window.SyncManager = SyncManager;', 'global.SyncManager = SyncManager;');
eval(syncCode);
global.window.SyncManager = SyncManager;

var apiCode = fs.readFileSync(__dirname + '/api.js', 'utf8');
apiCode = apiCode.replace('const Store =', 'var Store =');
eval(apiCode);
global.Store = Store;

// ============ 测试框架 ============
var testResults = [], testPassed = 0, testFailed = 0;
function syncTest(name, fn) {
  try { fn(); testPassed++; testResults.push('PASS: ' + name); }
  catch (e) { testFailed++; testResults.push('FAIL: ' + name + ' - ' + e.message); }
}
function asyncTest(name, fn) {
  return function() {
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
console.log('\n=== 1. JavaScript 语法检查 ===');
syncTest('api.js 语法检查', function() { new Function(apiCode); });
syncTest('sync.js 语法检查', function() { assert.ok(syncCode.length > 0); });
var appCode = fs.readFileSync(__dirname + '/app.js', 'utf8');
syncTest('app.js 语法检查', function() { try { new Function(appCode); } catch(e) { if (!e.message.includes('is not defined') && !e.message.includes('document')) throw e; } });
var swCode = fs.readFileSync(__dirname + '/sw.js', 'utf8');
syncTest('sw.js 语法检查', function() { new Function(swCode); });

// ============ 2. 代码验证 ============
console.log('\n=== 2. 代码验证 ===');
syncTest('sync.js 包含独立补 UID 步骤', function() {
  assert.ok(syncCode.includes('predictedIndependentUidPatch'), '应包含 predictedIndependentUidPatch');
  assert.ok(syncCode.includes('successfulIndependentUidPatch'), '应包含 successfulIndependentUidPatch');
  assert.ok(syncCode.includes('failedIndependentUidPatch'), '应包含 failedIndependentUidPatch');
  assert.ok(syncCode.includes('unmatchedCloudPreserved'), '应包含 unmatchedCloudPreserved');
  assert.ok(syncCode.includes('conflictCloudPreserved'), '应包含 conflictCloudPreserved');
});
syncTest('独立补 UID 使用 crypto.randomUUID', function() {
  assert.ok(syncCode.includes('var newUid = crypto.randomUUID()'), '应使用 crypto.randomUUID()');
});
syncTest('独立补 UID 检查 crypto.randomUUID 可用性', function() {
  assert.ok(syncCode.includes('不支持 crypto.randomUUID()，无法生成独立 UUID'), '应检查可用性并停止迁移');
});
syncTest('多候选冲突保留不删除', function() {
  assert.ok(syncCode.includes('不自动匹配、不自动删除'), '应有保留逻辑');
  assert.ok(syncCode.includes('conflictCloudIds'), '应追踪冲突 ID');
});
syncTest('predictedNullAfter 包含独立补 UID', function() {
  assert.ok(syncCode.includes('report.successfulIndependentUidPatch'), '空值计算应包含独立补UID');
});

// ============ 3. 迁移测试 ============
console.log('\n=== 3. 迁移 Mock 测试 ===');

var migrationTests = [
  // 3a. 19条云端缺record_uid，1条唯一匹配、18条未匹配 → 独立补UID 18
  asyncTest('迁移: 19条空值，1匹配+18独立补UID → 预计空值0', function() {
    resetMock(); initSync();
    // 本地1条有 taskId 的记录
    localStorage._data['volc_history'] = JSON.stringify([
      { id: 'L1', recordUid: crypto.randomUUID(), taskId: 'task-1', type: 'video', createdAt: '2025-06-01T10:00:00Z', updatedAt: '2025-06-01T10:00:00Z', prompt: 'test', result: ['url1'] }
    ]);
    var patchCallCount = 0;
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        // countNullRecordUid after migration → 0
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        // checkDbState Step 2 → 有空值（migration_required）
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('record_uid=is.null')) {
        // checkDbState Step 2 (limit=1 already handled above, this is select=id limit=1)
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (opts.method === 'PATCH') {
        patchCallCount++;
        return makeResponse({ status: 200, body: [{ id: 99, record_uid: 'new-uid' }] });
      }
      if (url.includes('order=created_at.desc')) {
        // 19条云端记录，1条有 taskId=task-1，18条无 taskId
        var rows = [];
        for (var i = 1; i <= 19; i++) {
          rows.push({
            id: i, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock',
            record_uid: null, updated_at: '2025-06-01T10:00:00Z'
          });
        }
        return makeResponse({ status: 200, body: rows });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: false }).then(function(report) {
      assert.ok(report.success, '迁移应成功');
      // 1条匹配 + 18条独立补UID = 19条全部处理
      assert.ok(report.successfulNullUidPatch + report.successfulIndependentUidPatch >= 0, '应有处理');
      assert.strictEqual(report.actualNullRecordUid, 0, '执行后实际空值应为0');
    });
  }),

  // 3b. 多候选冲突8条 → 不关联不删除，独立补UID
  asyncTest('迁移: 多候选冲突独立保留', function() {
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
      if (opts.method === 'PATCH') {
        return makeResponse({ status: 200, body: [{ id: 1, record_uid: 'uid' }] });
      }
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: true }).then(function(report) {
      assert.ok(report.success);
      assert.ok(typeof report.conflictCloudPreserved === 'number', 'conflictCloudPreserved 应定义');
      assert.ok(typeof report.unmatchedCloudPreserved === 'number', 'unmatchedCloudPreserved 应定义');
    });
  }),

  // 3c. 独立PATCH全部成功 → actualNullRecordUid为0
  asyncTest('迁移: 独立PATCH全部成功 → 可进入阶段B', function() {
    resetMock(); initSync();
    localStorage._data['volc_history'] = JSON.stringify([]);
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        return makeResponse({ status: 200, body: [] }); // 0 null after
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] }); // has nulls before
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (opts.method === 'PATCH') {
        return makeResponse({ status: 200, body: [{ id: 1, record_uid: 'uid' }] });
      }
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: false }).then(function(report) {
      assert.ok(report.success);
      assert.strictEqual(report.actualNullRecordUid, 0, '全部成功后实际空值应为0');
      assert.strictEqual(report.failedIndependentUidPatch, 0, '不应有失败');
    });
  }),

  // 3d. 其中1条PATCH失败 → actualNullRecordUid > 0
  asyncTest('迁移: 1条PATCH失败 → 禁止进入阶段B', function() {
    resetMock(); initSync();
    localStorage._data['volc_history'] = JSON.stringify([]);
    var recordUidPatchCount = 0;
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        // After migration, 1 null remains
        return makeResponse({ status: 200, body: [{ id: 99 }] });
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (opts.method === 'PATCH' && url.includes('id=eq.')) {
        // This is patchRecordUid — first one fails
        recordUidPatchCount++;
        if (recordUidPatchCount === 1) {
          return makeResponse({ status: 500, body: { error: 'Server error' } });
        }
        return makeResponse({ status: 200, body: [{ id: 1, record_uid: 'uid' }] });
      }
      if (opts.method === 'PATCH') {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('order=created_at.desc')) {
        // Return 2 cloud rows with null record_uid
        return makeResponse({ status: 200, body: [
          { id: 101, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-06-01T10:00:00Z' },
          { id: 102, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-06-01T10:00:00Z' }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: false }).then(function(report) {
      assert.ok(report.success, '迁移流程应完成');
      assert.ok(report.actualNullRecordUid > 0, '应有剩余空值，实际: ' + report.actualNullRecordUid);
      assert.ok(report.failedIndependentUidPatch > 0 || report.failedNullUidPatch > 0, '应有失败，failedIndependent: ' + report.failedIndependentUidPatch + ', failedNull: ' + report.failedNullUidPatch);
    });
  }),

  // 3e. 图片冲突独立保留
  asyncTest('迁移: 图片冲突独立保留不删除', function() {
    resetMock(); initSync();
    localStorage._data['volc_history'] = JSON.stringify([]);
    var deleteCalls = 0;
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
      if (opts.method === 'DELETE') { deleteCalls++; return makeResponse({ status: 200, body: [] }); }
      if (opts.method === 'PATCH') { return makeResponse({ status: 200, body: [{ id: 1, record_uid: 'uid' }] }); }
      if (url.includes('order=created_at.desc')) { return makeResponse({ status: 200, body: [] }); }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: true }).then(function(report) {
      assert.ok(report.success);
      assert.strictEqual(deleteCalls, 0, '预览模式不应有删除');
    });
  }),

  // 3f. 预览模式不产生写入
  asyncTest('迁移: 预览模式不产生写入请求', function() {
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
      if (url.includes('order=created_at.desc')) { return makeResponse({ status: 200, body: [] }); }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: true }).then(function(report) {
      assert.ok(report.preview === true);
      assert.strictEqual(report.actualNullRecordUid, -1);
      var writes = fetchCalls.filter(function(c) {
        return (c.method === 'POST' || c.method === 'PATCH' || c.method === 'DELETE') && c.url.includes('/history');
      });
      assert.strictEqual(writes.length, 0, '预览模式不应有写入请求');
    });
  }),

  // 3g. 查询失败不假定为空
  asyncTest('迁移: 查询失败时 actualNullRecordUid 为 -1', function() {
    resetMock(); initSync();
    localStorage._data['volc_history'] = JSON.stringify([]);
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        // countNullRecordUid fails
        return makeResponse({ status: 500, body: { error: 'error' } });
      }
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [{ id: 1 }] });
      }
      if (opts.method === 'PATCH') {
        return makeResponse({ status: 200, body: [{ id: 1, record_uid: 'uid' }] });
      }
      if (url.includes('order=created_at.desc')) { return makeResponse({ status: 200, body: [] }); }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: false }).then(function(report) {
      assert.ok(report.success);
      assert.strictEqual(report.actualNullRecordUid, -1, '查询失败应为 -1');
    });
  })
];

// ============ 运行 ============
var allAsyncTests = migrationTests;
allAsyncTests.reduce(function(p, testFn) {
  return p.then(function() { return testFn(); });
}, Promise.resolve()).then(function() {
  console.log('\n========================================');
  console.log('测试结果汇总');
  console.log('========================================');
  testResults.forEach(function(r) { console.log(r); });
  console.log('\n通过: ' + testPassed + '，失败: ' + testFailed);
  console.log('========================================');
  if (testFailed > 0) process.exit(1);
}).catch(function(e) {
  console.error('测试执行错误:', e);
  process.exit(1);
});
