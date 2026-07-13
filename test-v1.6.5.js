// v1.6.5 Mock 测试脚本
// 测试 pullHistory recordUid 映射、syncHistoryFromCloud 去重、localBySyncId fallback、readOnly 跳过
// 运行: node test-v1.6.5.js

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
// Node 22 有内置 crypto 全局变量，需要用 Object.defineProperty 覆盖
var mockCrypto = {
  subtle: {
    digest: function() { return Promise.resolve(new ArrayBuffer(32)); },
    importKey: function() { return Promise.resolve({}); },
    encrypt: function(alg, key, data) { return Promise.resolve(data.buffer ? data : new Uint8Array(data)); },
    decrypt: function(alg, key, data) {
      // Mock decrypt: data is Uint8Array from base64ToBytes('mock')
      // Return the raw bytes, pullHistory will try JSON.parse on the decoded string
      // Since we can't do real AES-GCM, we intercept at decryptObj level
      // Instead, return a Uint8Array that when decoded gives valid JSON
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
syncTest('sync.js 语法检查', function() { new Function(syncCode); });
syncTest('api.js 语法检查', function() { new Function(apiCode); });
var appCode = fs.readFileSync(__dirname + '/app.js', 'utf8');
syncTest('app.js 语法检查', function() { try { new Function(appCode); } catch(e) { if (!e.message.includes('is not defined') && !e.message.includes('document')) throw e; } });
var swCode = fs.readFileSync(__dirname + '/sw.js', 'utf8');
syncTest('sw.js 语法检查', function() { new Function(swCode); });

// ============ 2. 代码验证 ============
console.log('\n=== 2. 代码验证 ===');
syncTest('sync.js pullHistory 设置 record.recordUid', function() {
  assert.ok(syncCode.includes('record.recordUid = rows[i].record_uid'), 'pullHistory 应设置 record.recordUid');
});
syncTest('sync.js pullHistory 同时设置 _cloudRecordUid', function() {
  assert.ok(syncCode.includes('record._cloudRecordUid = rows[i].record_uid'), 'pullHistory 应同时设置 _cloudRecordUid');
});
syncTest('app.js 包含 localBySyncId 索引', function() {
  assert.ok(appCode.includes('localBySyncId'), 'syncHistoryFromCloud 应构建 localBySyncId 索引');
});
syncTest('app.js 新记录赋值 recordUid', function() {
  assert.ok(appCode.includes('newRec.recordUid = crUid'), '新记录应赋值 recordUid');
});
syncTest('app.js readOnly 跳过无 UID 无 _syncId 记录', function() {
  assert.ok(appCode.includes('readOnly && !crUid && !localRecord && !cr._syncId'), 'readOnly 模式应跳过无 UID 无 _syncId 的记录');
});
syncTest('app.js 匹配记录同步 recordUid', function() {
  assert.ok(appCode.includes('if (crUid) localRecord.recordUid = crUid'), '匹配记录应同步 recordUid');
});

// ============ 3. pullHistory 测试 ============
console.log('\n=== 3. pullHistory Mock 测试 ===');

var pullTests = [
  // 3a. pullHistory 正确设置 recordUid
  asyncTest('pullHistory: 云端 record_uid 写入 record.recordUid', function() {
    resetMock(); initSync();
    var cloudRecordUid = 'uid-from-cloud-12345';
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [
          { id: 1, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: cloudRecordUid, updated_at: '2025-07-01T10:00:00Z', is_deleted: false }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.pullHistory().then(function(records) {
      assert.strictEqual(records.length, 1, '应返回1条记录');
      assert.strictEqual(records[0].recordUid, cloudRecordUid, 'recordUid 应来自云端 record_uid');
      assert.strictEqual(records[0]._cloudRecordUid, cloudRecordUid, '_cloudRecordUid 也应设置');
      assert.strictEqual(records[0]._syncId, 1, '_syncId 应设置');
    });
  }),

  // 3b. pullHistory 云端 record_uid 为 null 时不设置 recordUid
  asyncTest('pullHistory: 云端 record_uid 为 null 时不设置 recordUid', function() {
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
      assert.strictEqual(records.length, 1, '应返回1条记录');
      assert.ok(!records[0].recordUid, 'recordUid 不应设置');
      assert.ok(!records[0]._cloudRecordUid, '_cloudRecordUid 也不应设置');
    });
  }),

  // 3c. pullHistory 多条记录部分有 record_uid
  asyncTest('pullHistory: 混合 record_uid 状态', function() {
    resetMock(); initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [
          { id: 1, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: 'uid-1', updated_at: '2025-07-01T10:00:00Z', is_deleted: false },
          { id: 2, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-07-01T11:00:00Z', is_deleted: false },
          { id: 3, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: 'uid-3', updated_at: '2025-07-01T12:00:00Z', is_deleted: false }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.pullHistory().then(function(records) {
      assert.strictEqual(records.length, 3, '应返回3条记录');
      assert.strictEqual(records[0].recordUid, 'uid-1', '第1条 recordUid 应为 uid-1');
      assert.ok(!records[1].recordUid, '第2条 recordUid 不应设置');
      assert.strictEqual(records[2].recordUid, 'uid-3', '第3条 recordUid 应为 uid-3');
    });
  })
];

// ============ 4. syncHistoryFromCloud 测试 ============
console.log('\n=== 4. syncHistoryFromCloud 代码验证 ===');

// 为 app.js 中的 syncHistoryFromCloud 构建一个可测试的版本
// app.js 代码中使用了很多全局引用，直接 eval 不现实
// 我们通过验证代码内容和测试 pullHistory 的正确性来间接验证

// 4a-4e: 同步代码验证（syncTest 直接执行）
syncTest('syncHistoryFromCloud: localBySyncId 索引正确构建', function() {
  resetMock(); initSync();
  assert.ok(appCode.includes('var localBySyncId = {}'), '应声明 localBySyncId');
  assert.ok(appCode.includes('localBySyncId[localHistory[i]._syncId] = localHistory[i]'), '应按 _syncId 建索引');
});

syncTest('syncHistoryFromCloud: _syncId fallback 匹配逻辑存在', function() {
  assert.ok(appCode.includes('localBySyncId[cr._syncId]'), '应有 _syncId fallback 匹配');
});

syncTest('syncHistoryFromCloud: readOnly 跳过无 UID 无 _syncId 记录', function() {
  assert.ok(appCode.includes('readOnly && !crUid && !localRecord && !cr._syncId'), '应跳过 readOnly 无 UID 无 _syncId');
  assert.ok(appCode.includes('continue;'), '应执行 continue 跳过');
});

syncTest('syncHistoryFromCloud: 新记录赋值 recordUid', function() {
  assert.ok(appCode.includes('newRec.recordUid = crUid'), '新记录应赋值 recordUid');
  assert.ok(appCode.includes('if (crUid) localByRecordUid[crUid] = newRec'), '新记录应加入索引');
  assert.ok(appCode.includes('if (newRec._syncId) localBySyncId[newRec._syncId] = newRec'), '新记录应加入 syncId 索引');
});

syncTest('syncHistoryFromCloud: 匹配记录同步 recordUid', function() {
  assert.ok(appCode.includes('if (crUid) localRecord.recordUid = crUid'), '匹配记录应同步 recordUid');
});

// 4f-4h: 异步测试
var asyncSyncTests = [
  // 4f. pullHistory 连续调用一致性（不产生重复）
  asyncTest('pullHistory: 连续调用返回一致结果', function() {
    resetMock(); initSync();
    var callCount = 0;
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('order=created_at.desc')) {
        callCount++;
        return makeResponse({ status: 200, body: [
          { id: 10, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: 'stable-uid', updated_at: '2025-07-01T10:00:00Z', is_deleted: false }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.pullHistory().then(function(records1) {
      return SyncManager.pullHistory().then(function(records2) {
        assert.strictEqual(records1.length, 1, '第一次应返回1条');
        assert.strictEqual(records2.length, 1, '第二次应返回1条');
        assert.strictEqual(records1[0].recordUid, 'stable-uid', '第一次 recordUid 应一致');
        assert.strictEqual(records2[0].recordUid, 'stable-uid', '第二次 recordUid 应一致');
        assert.strictEqual(records1[0]._syncId, 10, '第一次 _syncId 应一致');
        assert.strictEqual(records2[0]._syncId, 10, '第二次 _syncId 应一致');
        assert.strictEqual(callCount, 2, '应调用2次');
      });
    });
  }),

  // 4g. pullHistory 返回的记录 recordUid 与 _cloudRecordUid 一致
  asyncTest('pullHistory: recordUid 与 _cloudRecordUid 一致', function() {
    resetMock(); initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [
          { id: 1, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: 'test-uid-abc', updated_at: '2025-07-01T10:00:00Z', is_deleted: false }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.pullHistory().then(function(records) {
      assert.strictEqual(records[0].recordUid, records[0]._cloudRecordUid, 'recordUid 和 _cloudRecordUid 应相同');
    });
  }),

  // 4h. pullHistory 空列表
  asyncTest('pullHistory: 空云端列表返回空数组', function() {
    resetMock(); initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.pullHistory().then(function(records) {
      assert.strictEqual(records.length, 0, '应返回空数组');
    });
  })
];

// ============ 5. 版本号验证 ============
console.log('\n=== 5. 版本号验证 ===');
syncTest('app.js APP_VERSION 为 1.6.5', function() {
  assert.ok(appCode.includes("APP_VERSION = '1.6.5'"), 'APP_VERSION 应为 1.6.5');
});
syncTest('index.html 版本显示为 v1.6.5', function() {
  var htmlCode = fs.readFileSync(__dirname + '/index.html', 'utf8');
  assert.ok(htmlCode.includes('v1.6.5'), 'index.html 应包含 v1.6.5');
});
syncTest('index.html 脚本缓存参数为 v1.6.5', function() {
  var htmlCode = fs.readFileSync(__dirname + '/index.html', 'utf8');
  assert.ok(htmlCode.includes('api.js?v=1.6.5'), 'api.js 缓存参数应为 v1.6.5');
  assert.ok(htmlCode.includes('sync.js?v=1.6.5'), 'sync.js 缓存参数应为 v1.6.5');
  assert.ok(htmlCode.includes('app.js?v=1.6.5'), 'app.js 缓存参数应为 v1.6.5');
});
syncTest('sw.js CACHE_NAME 已更新', function() {
  assert.ok(!swCode.includes('1783936800'), 'sw.js 不应包含旧缓存版本号');
});

// ============ 6. 回归测试 ============
console.log('\n=== 6. 回归测试 ===');
syncTest('sync.js 仍包含 getRecordModel', function() {
  assert.ok(syncCode.includes('function getRecordModel'), '应保留 getRecordModel');
});
syncTest('sync.js deleteHistory 仍检查 0-row', function() {
  assert.ok(syncCode.includes('DELETE_TARGET_NOT_FOUND'), '应保留 DELETE_TARGET_NOT_FOUND 检查');
});
syncTest('sync.js checkDbState 仍无副作用', function() {
  assert.ok(!syncCode.includes('__constraint_test__'), '不应包含 __constraint_test__');
  assert.ok(syncCode.includes('get_history_sync_constraints'), '应使用 RPC 检查约束');
});
syncTest('sync.js 保留独立补 UID 逻辑', function() {
  assert.ok(syncCode.includes('predictedIndependentUidPatch'), '应保留独立补 UID 统计');
  assert.ok(syncCode.includes('conflictCloudIds'), '应保留冲突追踪');
});

// ============ 运行 ============
var allAsyncTests = pullTests.concat(asyncSyncTests);
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
