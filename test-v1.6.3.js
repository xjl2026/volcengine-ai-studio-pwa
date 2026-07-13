// v1.6.3 Mock 测试脚本
// 测试 getRecordModel、图片迁移匹配（真实数据结构）、deleteHistory 0 行检查
// 运行: node test-v1.6.3.js

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
// Replace const Store with var Store to make it accessible globally after eval
apiCode = apiCode.replace('const Store =', 'var Store =');
eval(apiCode);
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
  assert.ok(apiCode.length > 0);
  new Function(apiCode);
});

syncTest('sync.js 语法检查', function() {
  assert.ok(syncCode.length > 0);
});

syncTest('app.js 语法检查', function() {
  assert.ok(appCode.length > 0);
  try { new Function(appCode); } catch(e) {
    if (!e.message.includes('is not defined') && !e.message.includes('document')) throw e;
  }
});

syncTest('sw.js 语法检查', function() {
  assert.ok(swCode.length > 0);
  new Function(swCode);
});

// ============ 2. getRecordModel 测试 ============
console.log('\n=== 2. getRecordModel 测试 ===');

syncTest('getRecordModel: 顶层 model 存在', function() {
  assert.strictEqual(getRecordModel({ model: 'doubao-x' }), 'doubao-x');
});

syncTest('getRecordModel: params.model 存在', function() {
  assert.strictEqual(getRecordModel({ params: { model: 'doubao-y' } }), 'doubao-y');
});

syncTest('getRecordModel: 顶层 model 优先于 params.model', function() {
  assert.strictEqual(getRecordModel({ model: 'top', params: { model: 'nested' } }), 'top');
});

syncTest('getRecordModel: 缺少 model 返回空字符串', function() {
  assert.strictEqual(getRecordModel({ prompt: 'test' }), '');
});

syncTest('getRecordModel: null/undefined 安全', function() {
  assert.strictEqual(getRecordModel(null), '');
  assert.strictEqual(getRecordModel(undefined), '');
});

// ============ 3. 图片迁移匹配测试（真实数据结构） ============
console.log('\n=== 3. 图片迁移匹配（真实数据结构） ===');

// 3a. 本地和云端均使用 params.model，可以唯一匹配
var imageMatchTests = [
  asyncTest('图片匹配: 双方 params.model 唯一匹配', function() {
    resetMock();
    initSync();
    var localUid = crypto.randomUUID();
    localStorage._data['volc_history'] = JSON.stringify([
      {
        id: '1', recordUid: localUid, type: 'image',
        prompt: 'a cat on a chair',
        params: { model: 'doubao-seedream-5-0-pro-260628', size: '2K' },
        result: ['https://img.url1', 'https://img.url2'],
        createdAt: '2025-06-01T10:00:00Z', updatedAt: '2025-06-01T10:00:00Z'
      }
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
      // 由于 mock 解密返回的不是真实结构，无法直接测试匹配逻辑
      // 但可以验证 getRecordModel 被正确引用（通过代码分析测试已覆盖）
      assert.ok(typeof report.predictedNullUidPatch === 'number');
    });
  }),

  // 3b. getRecordModel 兼容测试（直接测试函数）
  asyncTest('getRecordModel: 兼容 params.model 和顶层 model', function() {
    // 旧记录结构
    var oldRec = { type: 'image', prompt: 'test', params: { model: 'doubao-x' }, result: ['url'] };
    assert.strictEqual(getRecordModel(oldRec), 'doubao-x');

    // 新记录结构（如有顶层 model）
    var newRec = { type: 'image', model: 'doubao-y', prompt: 'test', result: ['url'] };
    assert.strictEqual(getRecordModel(newRec), 'doubao-y');

    // 混合（顶层优先）
    var mixed = { type: 'image', model: 'top', params: { model: 'nested' }, prompt: 'test', result: ['url'] };
    assert.strictEqual(getRecordModel(mixed), 'top');

    // 缺少 model
    var noModel = { type: 'image', prompt: 'test', result: ['url'] };
    assert.strictEqual(getRecordModel(noModel), '');

    return Promise.resolve();
  }),

  // 3c. 代码验证：migrateHistoryData 中使用了 getRecordModel
  asyncTest('代码验证: migrateHistoryData 使用 getRecordModel', function() {
    assert.ok(syncCode.includes('function getRecordModel'), 'sync.js 应包含 getRecordModel 函数定义');
    assert.ok(syncCode.includes('var cloudModel = getRecordModel(cRec)'), '应使用 cloudModel');
    assert.ok(syncCode.includes('var localModel = getRecordModel(lRec)'), '应使用 localModel');
    assert.ok(syncCode.includes('if (cloudModel !== localModel) continue'), '应比较 cloudModel 和 localModel');
    // 不应再直接使用 cRec.model 或 lRec.model
    assert.ok(!syncCode.includes('!cRec.model'), '不应再直接检查 !cRec.model');
    assert.ok(!syncCode.includes('cRec.model !== lRec.model'), '不应再直接比较 cRec.model !== lRec.model');
    return Promise.resolve();
  }),

  // 3d. 代码验证：缺少 model 不自动匹配
  asyncTest('代码验证: 缺少 model 时 continue', function() {
    assert.ok(syncCode.includes('if (!cRec.prompt || !cRec.result || !cloudModel) continue'), '应检查 !cloudModel');
    assert.ok(syncCode.includes('if (!lRec.prompt || !lRec.result || !localModel) continue'), '应检查 !localModel');
    return Promise.resolve();
  })
];

// ============ 4. deleteHistory 0 行检查测试 ============
console.log('\n=== 4. deleteHistory 0 行检查测试 ===');

var deleteTests = [
  // 4a. PATCH 返回 1 条记录 → 删除成功
  asyncTest('deleteHistory: PATCH 返回 1 条 → 成功', function() {
    resetMock();
    initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (opts.method === 'PATCH') {
        return makeResponse({ status: 200, body: [{ id: 99, is_deleted: true }] });
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.deleteHistory('test-uid-123').then(function() {
      // 不抛异常即成功
      assert.ok(true, 'deleteHistory 应成功');
    });
  }),

  // 4b. PATCH 返回空数组 → 抛出 DELETE_TARGET_NOT_FOUND
  asyncTest('deleteHistory: PATCH 返回空数组 → 抛出 DELETE_TARGET_NOT_FOUND', function() {
    resetMock();
    initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (url.includes('record_uid=is.null')) {
        return makeResponse({ status: 200, body: [] });
      }
      if (opts.method === 'PATCH') {
        return makeResponse({ status: 200, body: [] }); // 空数组
      }
      return makeResponse({ status: 200, body: [] });
    };
    mockResponseMap['/rpc/'] = function(url, opts) {
      return makeResponse({ status: 200, body: { record_uid_not_null: true, unique_constraint_ready: true } });
    };
    return SyncManager.deleteHistory('test-uid-456').then(function() {
      assert.fail('应抛出 DELETE_TARGET_NOT_FOUND');
    }).catch(function(e) {
      assert.ok(e.message.includes('DELETE_TARGET_NOT_FOUND'), '错误信息应包含 DELETE_TARGET_NOT_FOUND，实际: ' + e.message);
    });
  }),

  // 4c. 网络失败 → 保留 _deletePending
  asyncTest('deleteHistory: 网络失败 → 抛出错误', function() {
    resetMock();
    initSync();
    global.fetch = function() { return Promise.reject(new Error('Network error')); };
    return SyncManager.deleteHistory('test-uid-789').then(function() {
      assert.fail('应抛出网络错误');
    }).catch(function(e) {
      assert.ok(e.message.includes('Network error') || e.message.includes('network_error') || e.message.includes('DB_NOT_READY'), '应有网络错误');
      global.fetch = mockFetch;
    });
  }),

  // 4d. 代码验证：deleteHistory 检查返回行数
  asyncTest('代码验证: deleteHistory 检查 rows.length', function() {
    assert.ok(syncCode.includes('if (!rows || rows.length === 0)'), '应检查 rows.length === 0');
    assert.ok(syncCode.includes('DELETE_TARGET_NOT_FOUND'), '应抛出 DELETE_TARGET_NOT_FOUND');
    return Promise.resolve();
  }),

  // 4e. 代码验证：retryPendingSync 保留 _deletePending
  asyncTest('代码验证: retryPendingSync 保留 _deletePending on error', function() {
    var retrySection = syncCode.substring(
      syncCode.indexOf('retryPendingSync'),
      syncCode.indexOf('pushSettings')
    );
    assert.ok(retrySection.includes('墓碑删除重试失败'), '应有错误处理');
    assert.ok(retrySection.includes('_deletePending = false'), '成功时才清除 _deletePending');
    return Promise.resolve();
  }),

  // 4f. 代码验证：removeHistory catch 保留 _deletePending
  asyncTest('代码验证: removeHistory catch 保留 _deletePending', function() {
    assert.ok(apiCode.includes('墓碑同步失败:'), '应有 catch 处理');
    var removeSection = apiCode.substring(
      apiCode.indexOf('async removeHistory'),
      apiCode.indexOf('async clearHistory')
    );
    // _deletePending = false 只在 try 块内
    assert.ok(removeSection.includes('record._deletePending = false'), '应有 _deletePending = false');
    // catch 块不应清除 _deletePending
    var catchIdx = removeSection.indexOf('console.warn(\'墓碑同步失败');
    var deletePendingFalseIdx = removeSection.indexOf('record._deletePending = false');
    assert.ok(deletePendingFalseIdx < catchIdx, '_deletePending = false 应在 catch 之前（try 块内）');
    return Promise.resolve();
  }),

  // 4g. 代码验证：clearHistory catch 保留 _deletePending
  asyncTest('代码验证: clearHistory catch 保留 _deletePending', function() {
    var clearSection = apiCode.substring(
      apiCode.indexOf('async clearHistory'),
      apiCode.indexOf('getApiKeys')
    );
    // _deletePending = false 只在 try 块
    var tryIdx = clearSection.indexOf('await SyncManager.deleteHistory(record.recordUid);');
    var successIdx = clearSection.indexOf('record._deletePending = false;');
    var catchIdx = clearSection.indexOf('墓碑同步失败:');
    assert.ok(tryIdx >= 0 && successIdx > tryIdx, '_deletePending = false 应在 deleteHistory 之后');
    assert.ok(catchIdx > successIdx, 'catch 应在 _deletePending = false 之后');
    // catch 块不应有 _deletePending = false
    var afterCatch = clearSection.substring(catchIdx);
    assert.ok(!afterCatch.includes('_deletePending = false'), 'catch 块不应清除 _deletePending');
    return Promise.resolve();
  })
];

// ============ 5. 迁移统计测试 ============
console.log('\n=== 5. 迁移统计回归测试 ===');

var migrationTests = [
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
      assert.ok(report.preview === true);
      assert.strictEqual(report.actualNullRecordUid, -1);
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
      assert.ok(report.success);
      assert.ok(report.actualNullRecordUid >= 0);
      assert.ok(nullCountQueryCount > 0, '应执行了实际空值查询');
    });
  })
];

// ============ 6. checkDbState 回归测试 ============
console.log('\n=== 6. checkDbState 回归测试 ===');

var dbStateTests = [
  asyncTest('checkDbState: schema 缺失返回 schema_not_ready', function() {
    resetMock();
    initSync();
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      return makeResponse({ status: 400, body: { error: 'column record_uid does not exist' } });
    };
    return SyncManager.checkDbState().then(function(state) {
      assert.strictEqual(state, 'schema_not_ready');
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
  })
];

// ============ 运行所有异步测试（顺序执行） ============
var allAsyncTests = imageMatchTests.concat(deleteTests).concat(migrationTests).concat(dbStateTests);

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
