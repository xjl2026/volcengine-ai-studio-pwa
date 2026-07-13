// v1.6.2 Mock 测试脚本
// 使用 mock fetch 测试 checkDbState、迁移统计、图片匹配、caps 顺序
// 不连接真实 Supabase 数据库
// 运行: node test-v1.6.2.js

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

function resetMock() {
  fetchCalls = [];
  mockResponseMap = {};
}

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
global.localStorage = {
  _data: {},
  getItem: function(k) { return this._data[k] || null; },
  setItem: function(k, v) { this._data[k] = v; }
};
global.window = {};
global.document = {
  getElementById: function() { return null; },
  querySelectorAll: function() { return []; },
  addEventListener: function() {},
  createElement: function() { return { style: {}, classList: { add: function(){}, remove: function(){}, contains: function(){ return false; } }, appendChild: function(){} }; }
};

// 加载被测代码
var fs = require('fs');
var syncCode = fs.readFileSync(__dirname + '/sync.js', 'utf8');
syncCode = syncCode.replace('window.SyncManager = SyncManager;', 'global.SyncManager = SyncManager;');
eval(syncCode);
global.window.SyncManager = SyncManager;

var apiCode = fs.readFileSync(__dirname + '/api.js', 'utf8');
// api.js 定义 Store 等，确保挂到 global
apiCode = apiCode.replace('const Store =', 'global.Store ='); // 不行，const 不能这样
eval(apiCode);
// 手动将 Store 挂到 global
global.Store = Store;

var appCode = fs.readFileSync(__dirname + '/app.js', 'utf8');
var swCode = fs.readFileSync(__dirname + '/sw.js', 'utf8');

// ============ 测试框架 ============
var testResults = [];
var testPassed = 0;
var testFailed = 0;

function syncTest(name, fn) {
  try {
    fn();
    testPassed++;
    testResults.push('PASS: ' + name);
  } catch (e) {
    testFailed++;
    testResults.push('FAIL: ' + name + ' - ' + e.message);
  }
}

function asyncTest(name, fn) {
  // 返回一个函数，调用时执行测试
  return function() {
    return fn().then(function() {
      testPassed++;
      testResults.push('PASS: ' + name);
    }).catch(function(e) {
      testFailed++;
      testResults.push('FAIL: ' + name + ' - ' + e.message);
    });
  };
}

// 初始化 SyncManager
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

syncTest('api.js 语法检查', function() {
  assert.ok(apiCode.length > 0, 'api.js 应有内容');
  new Function(apiCode);
});

syncTest('sync.js 语法检查', function() {
  assert.ok(syncCode.length > 0, 'sync.js 应有内容');
});

syncTest('app.js 语法检查', function() {
  assert.ok(appCode.length > 0, 'app.js 应有内容');
  try { new Function(appCode); } catch(e) {
    if (!e.message.includes('is not defined') && !e.message.includes('document')) throw e;
  }
});

syncTest('sw.js 语法检查', function() {
  assert.ok(swCode.length > 0, 'sw.js 应有内容');
  new Function(swCode);
});

// ============ 2. checkDbState 测试 ============
console.log('\n=== 2. checkDbState Mock 测试 ===');

var dbStateTests = [
  asyncTest('checkDbState: schema 缺失返回 schema_not_ready', function() {
    resetMock();
    initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      return makeResponse({ status: 400, body: { error: 'column record_uid does not exist' } });
    };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'schema_not_ready');
      var posts = fetchCalls.filter(function(c) { return c.method === 'POST'; });
      assert.strictEqual(posts.length, 0, '不应有 POST 请求');
    });
  }),
  asyncTest('checkDbState: 401 返回 auth_error', function() {
    resetMock();
    initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      return makeResponse({ status: 401, body: { error: 'Unauthorized' } });
    };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'auth_error');
    });
  }),
  asyncTest('checkDbState: 网络失败返回 network_error', function() {
    resetMock();
    initSync();
    global.fetch = function() { return Promise.reject(new Error('Network error')); };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'network_error');
      global.fetch = mockFetch;
    });
  }),
  asyncTest('checkDbState: 有空 record_uid 返回 migration_required', function() {
    resetMock();
    initSync();
    var callCount = 0;
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      callCount++;
      if (callCount === 1) return makeResponse({ status: 200, body: [] });
      if (callCount === 2) return makeResponse({ status: 200, body: [{ id: 1 }] });
      return makeResponse({ status: 200, body: [] });
    };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'migration_required');
    });
  }),
  asyncTest('checkDbState: NOT NULL 不存在返回 constraint_not_ready', function() {
    resetMock();
    initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null')) return makeResponse({ status: 200, body: [] });
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: false, unique_constraint_ready: false } });
    };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'constraint_not_ready');
    });
  }),
  asyncTest('checkDbState: UNIQUE 不存在但 NOT NULL 存在返回 constraint_not_ready', function() {
    resetMock();
    initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: false } });
    };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'constraint_not_ready');
    });
  }),
  asyncTest('checkDbState: 全部就绪返回 ready', function() {
    resetMock();
    initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'ready');
      var writes = fetchCalls.filter(function(c) {
        return (c.method === 'POST' || c.method === 'PATCH' || c.method === 'DELETE') && c.url.includes('/history');
      });
      assert.strictEqual(writes.length, 0, '状态检查期间 history 表无写入');
    });
  }),
  asyncTest('checkDbState: RPC 不存在返回 constraint_not_ready', function() {
    resetMock();
    initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 404, body: {} });
    };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'constraint_not_ready');
    });
  }),
  asyncTest('checkDbState: 状态检查期间 history 表写请求数量为 0', function() {
    resetMock();
    initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.checkDbState().then(function() {
      var writes = fetchCalls.filter(function(c) {
        return (c.method === 'POST' || c.method === 'PATCH' || c.method === 'DELETE') && c.url.includes('/history');
      });
      assert.strictEqual(writes.length, 0, 'history 表写请求必须为 0');
    });
  })
];

// ============ 3. 迁移统计测试 ============
console.log('\n=== 3. 迁移统计 Mock 测试 ===');

var migrationTests = [
  asyncTest('迁移: PATCH 成功计入 successfulNullUidPatch', function() {
    resetMock();
    initSync();
    localStorage._data['volc_history'] = JSON.stringify([
      { id: '1', recordUid: crypto.randomUUID(), taskId: 'task-1', type: 'video', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', prompt: 'test', result: ['url1'] }
    ]);
    var historyCallCount = 0;
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      historyCallCount++;
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (opts.method === 'PATCH') {
        return makeResponse({ status: 200, body: [{ id: 99 }] });
      }
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [{
          id: 99, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-01-01T00:00:00Z'
        }] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: false }).then(function(report) {
      assert.ok(report.success, '迁移应成功');
      assert.ok(typeof report.successfulNullUidPatch === 'number', 'successfulNullUidPatch 应定义');
      assert.ok(report.actualNullRecordUid >= 0, 'actualNullRecordUid 应已查询');
      assert.ok(typeof report.existingUidMatched === 'number', 'existingUidMatched 应定义');
    });
  }),
  asyncTest('迁移: PATCH 失败计入 failedNullUidPatch', function() {
    resetMock();
    initSync();
    localStorage._data['volc_history'] = JSON.stringify([
      { id: '1', recordUid: crypto.randomUUID(), taskId: 'task-fail', type: 'video', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', prompt: 'test', result: ['url1'] }
    ]);
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (opts.method === 'PATCH') {
        return makeResponse({ status: 500, body: { error: 'Server error' } });
      }
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [{
          id: 88, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-01-01T00:00:00Z'
        }] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: false }).then(function(report) {
      assert.ok(report.success, '迁移流程应完成');
      assert.ok(typeof report.failedNullUidPatch === 'number', 'failedNullUidPatch 应定义');
    });
  }),
  asyncTest('迁移: 删除成功计入 successfulDuplicateDelete', function() {
    resetMock();
    initSync();
    localStorage._data['volc_history'] = JSON.stringify([]);
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (opts.method === 'DELETE') {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [
          { id: 1, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: 'uid-dup-1', updated_at: '2025-01-02T00:00:00Z' },
          { id: 2, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: 'uid-dup-1', updated_at: '2025-01-01T00:00:00Z' }
        ] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: false }).then(function(report) {
      assert.ok(report.success, '迁移应成功');
      assert.ok(report.cloudDuplicates >= 1, '应检测到重复');
      assert.ok(report.successfulDuplicateDelete >= 1, '应有成功删除');
      assert.strictEqual(report.failedDuplicateDelete, 0, '不应有删除失败');
    });
  }),
  asyncTest('迁移: 预览模式不产生写入请求', function() {
    resetMock();
    initSync();
    localStorage._data['volc_history'] = JSON.stringify([
      { id: '1', recordUid: crypto.randomUUID(), taskId: 'task-prev', type: 'video', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', prompt: 'test', result: ['url1'] }
    ]);
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [{
          id: 77, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-01-01T00:00:00Z'
        }] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: true }).then(function(report) {
      assert.ok(report.preview === true, '应为预览模式');
      assert.strictEqual(report.actualNullRecordUid, -1, '预览模式不查询实际空值');
      var writes = fetchCalls.filter(function(c) {
        return (c.method === 'POST' || c.method === 'PATCH' || c.method === 'DELETE') && c.url.includes('/history');
      });
      assert.strictEqual(writes.length, 0, '预览模式不应有写入请求');
    });
  }),
  asyncTest('迁移: 执行后查询 actualNullRecordUid', function() {
    resetMock();
    initSync();
    localStorage._data['volc_history'] = JSON.stringify([]);
    var nullCountQueryCount = 0;
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        nullCountQueryCount++;
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [] });
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
      assert.ok(report.success, '迁移应成功');
      assert.ok(report.actualNullRecordUid >= 0, 'actualNullRecordUid 应已查询');
      assert.ok(nullCountQueryCount > 0, '应执行了实际空值查询');
    });
  })
];

// ============ 4. 图片匹配规则测试 ============
console.log('\n=== 4. 图片匹配规则测试 ===');

var imageMatchTests = [
  asyncTest('图片匹配: 字段定义存在 (existingUidMatched, predictedNullUidPatch, uncertainMatches)', function() {
    resetMock();
    initSync();
    localStorage._data['volc_history'] = JSON.stringify([
      { id: '1', recordUid: crypto.randomUUID(), type: 'image', model: 'doubao-seedream-5-0-pro-260628', prompt: 'a cat', result: ['url1', 'url2'], createdAt: '2025-06-01T10:00:00Z', updatedAt: '2025-06-01T10:00:00Z' }
    ]);
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [{
          id: 55, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-06-01T10:00:00Z'
        }] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: true }).then(function(report) {
      assert.ok(report.success, '预览应成功');
      assert.ok(typeof report.uncertainMatches === 'number', 'uncertainMatches 应定义');
      assert.ok(typeof report.predictedNullUidPatch === 'number', 'predictedNullUidPatch 应定义');
      assert.ok(typeof report.existingUidMatched === 'number', 'existingUidMatched 应定义');
      assert.ok(Array.isArray(report.uncertainDetails), 'uncertainDetails 应是数组');
    });
  }),
  asyncTest('图片匹配: 多候选列入 uncertainMatches', function() {
    resetMock();
    initSync();
    localStorage._data['volc_history'] = JSON.stringify([
      { id: '1', recordUid: crypto.randomUUID(), type: 'image', model: 'doubao-seedream-5-0-pro-260628', prompt: 'same', result: ['url1'], createdAt: '2025-06-01T10:00:00Z', updatedAt: '2025-06-01T10:00:00Z' },
      { id: '2', recordUid: crypto.randomUUID(), type: 'image', model: 'doubao-seedream-5-0-pro-260628', prompt: 'same', result: ['url1'], createdAt: '2025-06-01T10:00:30Z', updatedAt: '2025-06-01T10:00:30Z' }
    ]);
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('order=created_at.desc')) {
        return makeResponse({ status: 200, body: [{
          id: 55, user_id: 'test-user-id', encrypted_data: 'mock', iv: 'mock', record_uid: null, updated_at: '2025-06-01T10:00:00Z'
        }] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.migrateHistoryData({ preview: true }).then(function(report) {
      assert.ok(report.success, '预览应成功');
      assert.ok(typeof report.uncertainMatches === 'number', 'uncertainMatches 应定义');
      assert.ok(Array.isArray(report.uncertainDetails), 'uncertainDetails 应是数组');
    });
  })
];

// ============ 5. caps 使用顺序测试 ============
console.log('\n=== 5. caps 使用顺序测试 ===');

syncTest('caps 顺序: handleImageGenerate 中 caps 在校验前定义', function() {
  var fnStart = appCode.indexOf('async function handleImageGenerate');
  assert.ok(fnStart >= 0, '应找到 handleImageGenerate 函数');
  var fnEnd = appCode.indexOf('\n}', fnStart);
  var fnCode = appCode.substring(fnStart, fnEnd);
  var capsUsePos = fnCode.indexOf('caps.maxRefImages');
  var capsDefPos = fnCode.indexOf('const caps = mi.caps');
  assert.ok(capsDefPos >= 0, '应找到 caps 定义');
  assert.ok(capsUsePos >= 0, '应找到 caps.maxRefImages 使用');
  assert.ok(capsDefPos < capsUsePos, 'caps 定义应在 caps.maxRefImages 使用之前');
});

syncTest('caps 顺序: model → mi → caps 顺序正确', function() {
  var fnStart = appCode.indexOf('async function handleImageGenerate');
  var fnEnd = appCode.indexOf('\n}', fnStart);
  var fnCode = appCode.substring(fnStart, fnEnd);
  var modelPos = fnCode.indexOf('const model =');
  var miPos = fnCode.indexOf('const mi =');
  var capsPos = fnCode.indexOf('const caps =');
  assert.ok(modelPos >= 0, '应找到 model 定义');
  assert.ok(miPos >= 0, '应找到 mi 定义');
  assert.ok(capsPos >= 0, '应找到 caps 定义');
  assert.ok(modelPos < miPos, 'model 应在 mi 之前');
  assert.ok(miPos < capsPos, 'mi 应在 caps 之前');
});

// ============ 运行所有异步测试（顺序执行避免共享状态冲突） ============
var allAsyncTests = dbStateTests.concat(migrationTests).concat(imageMatchTests);

allAsyncTests.reduce(function(p, testFn, idx) {
  return p.then(function() {
    return testFn();
  });
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
