// test-sync-final.js - fix/sync-final 完整行为测试
// 运行: node test-sync-final.js
const assert = require('assert');
let fetchCalls = [], mockResponseMap = {};
function mockFetch(url, options) {
  options = options || {};
  fetchCalls.push({ url: url, method: options.method || 'GET', body: options.body });
  for (var pattern in mockResponseMap) { if (url.includes(pattern)) { return Promise.resolve(mockResponseMap[pattern](url, options)); } }
  return Promise.resolve(makeResponse({ status: 404, body: {} }));
}
function makeResponse(resp) {
  return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, json: function() { return Promise.resolve(resp.body); }, text: function() { return Promise.resolve(JSON.stringify(resp.body)); } };
}
function resetMock() { fetchCalls = []; mockResponseMap = {}; }
const decryptedRecordMap = {};
global.fetch = mockFetch;
var mockCrypto = {
  subtle: {
    digest: function() { return Promise.resolve(new ArrayBuffer(32)); },
    importKey: function() { return Promise.resolve({}); },
    encrypt: function(a, k, d) { return Promise.resolve(d.buffer ? d : new Uint8Array(d)); },
    decrypt: function(a, k, d) {
      // d 是 base64ToBytes(encrypted_data) 的结果
      // 将 d 转回 base64 字符串（即原始 encrypted_data 值）作为 key
      var binary = '';
      for (var i = 0; i < d.length; i++) binary += String.fromCharCode(d[i]);
      var keyStr = Buffer.from(binary, 'binary').toString('base64');
      if (decryptedRecordMap[keyStr]) {
        var jsonStr = JSON.stringify(decryptedRecordMap[keyStr]);
        var arr = new Uint8Array(jsonStr.length);
        for (var i = 0; i < jsonStr.length; i++) arr[i] = jsonStr.charCodeAt(i);
        return Promise.resolve(arr);
      }
      return Promise.reject(new Error('decrypt: unknown key="' + keyStr + '"'));
    }
  },
  getRandomValues: function(arr) { for (var i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; },
  randomUUID: function() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }); }
};
Object.defineProperty(global, 'crypto', { value: mockCrypto, writable: true, configurable: true });
global.TextEncoder = function() { this.encode = function(s) { var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }; };
global.TextDecoder = function() { this.decode = function(a) { var s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return s; }; };
global.btoa = function(s) { return Buffer.from(s, 'binary').toString('base64'); };
global.atob = function(s) { return Buffer.from(s, 'base64').toString('binary'); };
global.localStorage = { _data: {}, getItem: function(k) { return this._data[k] || null; }, setItem: function(k, v) { this._data[k] = v; } };
global.window = {};
global.document = { getElementById: function() { return null; }, querySelectorAll: function() { return []; }, addEventListener: function() {}, createElement: function() { return { style: {}, classList: { add: function(){}, remove: function(){}, contains: function(){ return false; } }, appendChild: function(){} }; } };
var fs = require('fs'), path = require('path');
var mergeCode = fs.readFileSync(path.join(__dirname, 'merge-cloud-history.js'), 'utf8');
eval(mergeCode); global.mergeCloudHistory = mergeCloudHistory;
var syncCode = fs.readFileSync(path.join(__dirname, 'sync.js'), 'utf8').replace('window.SyncManager = SyncManager;', 'global.SyncManager = SyncManager;');
eval(syncCode); global.window.SyncManager = SyncManager;
var apiCode = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8').replace('const Store =', 'var Store =');
eval(apiCode); global.Store = Store;
var appCode = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
var testResults = [], testPassed = 0, testFailed = 0, testTotal = 0;
function syncTest(name, fn) { testTotal++; try { fn(); testPassed++; testResults.push('PASS: ' + name); } catch (e) { testFailed++; testResults.push('FAIL: ' + name + ' - ' + e.message); } }
function asyncTest(name, fn) { return function() { testTotal++; return fn().then(function() { testPassed++; testResults.push('PASS: ' + name); }).catch(function(e) { testFailed++; testResults.push('FAIL: ' + name + ' - ' + e.message); }); }; }
function initSync() { SyncManager._url = 'https://test.supabase.co'; SyncManager._anonKey = 'test-anon-key'; SyncManager._syncKey = 'test-sync-key'; SyncManager._userId = 'test-user-id'; SyncManager._dbState = null; SyncManager._dbStateCheckedAt = 0; }
// ============ 1. 语法检查 ============
console.log('\n=== 1. 语法检查 ===');
syncTest('node --check api.js', function() { new Function(apiCode); });
syncTest('node --check sync.js', function() { assert.ok(syncCode.length > 0); });
syncTest('node --check merge-cloud-history.js', function() { new Function(mergeCode); });
syncTest('node --check app.js', function() { new Function(appCode); });
syncTest('node --check sw.js', function() { var sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8'); new Function(sw); });
// ============ 2. mergeCloudHistory 行为测试 ============
console.log('\n=== 2. mergeCloudHistory 行为测试 ===');
syncTest('场景1: readOnly 跳过无UID无匹配记录', function() { var r = mergeCloudHistory([{type:'video',prompt:'l',recordUid:'u1',_syncId:100,createdAt:'2025-06-01T10:00:00Z'}],[{type:'video',prompt:'c',_syncId:200,_cloudUpdatedAt:'2025-07-01T10:00:00Z'}],{readOnly:true}); assert.strictEqual(r.history.length,1); assert.strictEqual(r.skippedCount,1); assert.strictEqual(r.addedCount,0); });
syncTest('场景2: 无UID但_syncId可匹配', function() { var r = mergeCloudHistory([{type:'video',prompt:'old',_syncId:200,createdAt:'2025-06-01T10:00:00Z'}],[{type:'video',prompt:'new',_syncId:200,_cloudUpdatedAt:'2025-07-01T10:00:00Z'}],{readOnly:true}); assert.strictEqual(r.history.length,1); assert.strictEqual(r.addedCount,0); assert.strictEqual(r.updatedCount,1); assert.strictEqual(r.history[0].prompt,'new'); });
syncTest('场景3: 有recordUid首次拉取', function() { var r = mergeCloudHistory([],[{type:'video',prompt:'n',recordUid:'cu',_syncId:300,_cloudUpdatedAt:'2025-07-01T10:00:00Z'}],{readOnly:false}); assert.strictEqual(r.addedCount,1); assert.strictEqual(r.history[0].recordUid,'cu'); assert.strictEqual(r.history[0]._syncId,300); });
syncTest('场景4: 连续同步两次不重复', function() { var c=[{type:'video',prompt:'t',recordUid:'u',_syncId:400,_cloudUpdatedAt:'2025-07-01T10:00:00Z'}]; var r1=mergeCloudHistory([],c,{readOnly:false}); assert.strictEqual(r1.addedCount,1); var r2=mergeCloudHistory(r1.history,c,{readOnly:false}); assert.strictEqual(r2.addedCount,0); assert.strictEqual(r2.history.length,1); });
syncTest('场景5: 本地已有相同recordUid', function() { var r=mergeCloudHistory([{type:'video',prompt:'o',recordUid:'u',_syncId:500,createdAt:'2025-06-01T10:00:00Z'}],[{type:'video',prompt:'n',recordUid:'u',_syncId:500,_cloudUpdatedAt:'2025-07-01T10:00:00Z'}],{readOnly:false}); assert.strictEqual(r.addedCount,0); assert.strictEqual(r.updatedCount,1); assert.strictEqual(r.history[0].prompt,'n'); });
syncTest('场景6: 云端墓碑', function() { var r=mergeCloudHistory([{type:'video',prompt:'t',recordUid:'ut',_syncId:600,createdAt:'2025-06-01T10:00:00Z',_isDeleted:false}],[{type:'video',prompt:'t',recordUid:'ut',_syncId:600,_cloudUpdatedAt:'2025-07-01T10:00:00Z',_cloudIsDeleted:true}],{readOnly:false}); assert.ok(r.history[0]._isDeleted); assert.strictEqual(r.history[0]._deletePending,false); });
syncTest('mergeCloudHistory 不修改输入数组', function() { var l=[{type:'video',prompt:'o',recordUid:'uo',_syncId:700}]; var r=mergeCloudHistory(l,[{type:'video',prompt:'u',recordUid:'uo',_syncId:700,_cloudUpdatedAt:'2025-07-01T10:00:00Z'}],{readOnly:false}); assert.strictEqual(l[0].prompt,'o'); assert.strictEqual(r.history[0].prompt,'u'); });
syncTest('readOnly时有UID仍可新增', function() { var r=mergeCloudHistory([],[{type:'video',prompt:'h',recordUid:'uy',_syncId:800,_cloudUpdatedAt:'2025-07-01T10:00:00Z'}],{readOnly:true}); assert.strictEqual(r.addedCount,1); });
syncTest('_syncPending冲突标记', function() { var r=mergeCloudHistory([{type:'video',prompt:'l',recordUid:'uc',_syncId:900,_syncPending:true,_cloudUpdatedAt:'2025-06-01T10:00:00Z'}],[{type:'video',prompt:'c',recordUid:'uc',_syncId:900,_cloudUpdatedAt:'2025-07-01T10:00:00Z'}],{readOnly:false}); assert.ok(r.history[0]._syncConflict); assert.strictEqual(r.conflicts.length,1); });
// ============ 3. pullHistory 映射测试 ============
console.log('\n=== 3. pullHistory 映射测试 ===');
var pullTests=[
  asyncTest('pullHistory: record_uid -> record.recordUid', function() { resetMock(); initSync(); var ek=Buffer.from('p1','binary').toString('base64'); decryptedRecordMap[ek]={type:'video',prompt:'t',result:['u1'],createdAt:'2025-07-01T10:00:00Z'}; mockResponseMap['/rest/v1/history']=function(url,opts){ if(url.includes('order=created_at.desc')) return makeResponse({status:200,body:[{id:1,user_id:'tu',encrypted_data:ek,iv:'m',record_uid:'uid-p1',updated_at:'2025-07-01T10:00:00Z',is_deleted:false}]}); return makeResponse({status:200,body:[]});}; return SyncManager.pullHistory().then(function(r){assert.strictEqual(r[0].recordUid,'uid-p1');assert.strictEqual(r[0]._cloudRecordUid,'uid-p1');assert.strictEqual(r[0]._syncId,1);}); }),
  asyncTest('pullHistory: null record_uid', function() { resetMock(); initSync(); var ek=Buffer.from('p2','binary').toString('base64'); decryptedRecordMap[ek]={type:'video',prompt:'t2',result:['u2'],createdAt:'2025-07-01T10:00:00Z'}; mockResponseMap['/rest/v1/history']=function(url,opts){ if(url.includes('order=created_at.desc')) return makeResponse({status:200,body:[{id:2,user_id:'tu',encrypted_data:ek,iv:'m',record_uid:null,updated_at:'2025-07-01T10:00:00Z',is_deleted:false}]}); return makeResponse({status:200,body:[]});}; return SyncManager.pullHistory().then(function(r){assert.ok(!r[0].recordUid);assert.ok(!r[0]._cloudRecordUid);}); }),
  asyncTest('pullHistory: _syncId from row.id', function() { resetMock(); initSync(); var ek=Buffer.from('p3','binary').toString('base64'); decryptedRecordMap[ek]={type:'video',prompt:'t3',result:['u3'],createdAt:'2025-07-01T10:00:00Z'}; mockResponseMap['/rest/v1/history']=function(url,opts){ if(url.includes('order=created_at.desc')) return makeResponse({status:200,body:[{id:42,user_id:'tu',encrypted_data:ek,iv:'m',record_uid:'uid-42',updated_at:'2025-07-01T10:00:00Z',is_deleted:false}]}); return makeResponse({status:200,body:[]});}; return SyncManager.pullHistory().then(function(r){assert.strictEqual(r[0]._syncId,42);}); })
];
// ============ 4. deleteHistory 0-row 测试 ============
console.log('\n=== 4. deleteHistory 0-row 测试 ===');
var deleteTests=[
  asyncTest('deleteHistory 0行 -> DELETE_TARGET_NOT_FOUND', function() { resetMock(); initSync(); SyncManager._dbState='ready'; SyncManager._dbStateCheckedAt=Date.now(); mockResponseMap['/rest/v1/history']=function(url,opts){ if(opts.method==='PATCH'&&url.includes('record_uid=eq.')) return makeResponse({status:200,body:[]}); return makeResponse({status:200,body:[]});}; return SyncManager.deleteHistory('no-uid').then(function(){assert.fail('should throw');},function(e){assert.ok(e.message.includes('DELETE_TARGET_NOT_FOUND'));}); }),
  asyncTest('deleteHistory 1行 -> 正常', function() { resetMock(); initSync(); SyncManager._dbState='ready'; SyncManager._dbStateCheckedAt=Date.now(); mockResponseMap['/rest/v1/history']=function(url,opts){ if(opts.method==='PATCH'&&url.includes('record_uid=eq.')) return makeResponse({status:200,body:[{id:1,record_uid:'uid-ok',is_deleted:true}]}); return makeResponse({status:200,body:[]});}; return SyncManager.deleteHistory('uid-ok'); }),
  asyncTest('deleteHistory 网络失败', function() { resetMock(); initSync(); SyncManager._dbState='ready'; SyncManager._dbStateCheckedAt=Date.now(); mockResponseMap['/rest/v1/history']=function(url,opts){ if(opts.method==='PATCH'&&url.includes('record_uid=eq.')) return makeResponse({status:500,body:{error:'err'}}); return makeResponse({status:200,body:[]});}; return SyncManager.deleteHistory('uid-fail').then(function(){assert.fail('should throw');},function(e){assert.ok(e.message.includes('500'));}); })
];
// 以下部分在第5节继续（迁移核心测试+checkDbState+caps+回归+运行器）
// ============ 5. 迁移核心测试 ============
console.log('\n=== 5. 迁移核心测试 ===');
function buildMigrationData() {
  for (var k in decryptedRecordMap) delete decryptedRecordMap[k];
  // 辅助：将 key 字符串编码为有效 base64 后作为 encrypted_data
  function encKey(key) { return Buffer.from(key, 'binary').toString('base64'); }
  var localHistory = [];
  // 本地57条: 1条视频(taskId可匹配) + 16条图片(8对候选) + 40条其他视频
  localHistory.push({type:'video',prompt:'local-0',recordUid:'local-uid-0',taskId:'local-task-0',createdAt:'2025-06-01T10:00:00Z',updatedAt:'2025-06-01T10:00:00Z',result:['url-local-0']});
  for (var i = 0; i < 8; i++) {
    var pv = 'img-prompt-' + i, rv = ['img-url-' + i], mv = 'doubao-seedream-5-0-pro-260628';
    var ct = '2025-06-01T10:00:0' + i + 'Z';
    localHistory.push({type:'image',prompt:pv,params:{model:mv},result:rv,recordUid:'cand-a-'+i,createdAt:ct});
    localHistory.push({type:'image',prompt:pv,params:{model:mv},result:rv,recordUid:'cand-b-'+i,createdAt:'2025-06-01T10:00:'+(i+10)+'Z'});
  }
  for (var i = 17; i < 57; i++) {
    localHistory.push({type:'video',prompt:'local-'+i,recordUid:'local-uid-'+i,taskId:'local-task-'+i,createdAt:'2025-06-01T10:00:00Z',updatedAt:'2025-06-01T10:00:00Z',result:['url-local-'+i]});
  }
  var cloudRows = [];
  // 1条视频 taskId匹配本地第0条
  var k1 = 'cloud-match-1'; decryptedRecordMap[encKey(k1)] = {type:'video',prompt:'local-0',taskId:'local-task-0',result:['url-local-0'],createdAt:'2025-06-01T10:00:00Z'};
  cloudRows.push({id:1,user_id:'tu',encrypted_data:encKey(k1),iv:'m',record_uid:null,updated_at:'2025-06-01T10:00:00Z'});
  // 8条图片 每条本地有2个候选
  for (var i = 0; i < 8; i++) {
    var ek = 'cloud-conflict-' + i;
    var pv = 'img-prompt-' + i, rv = ['img-url-' + i], mv = 'doubao-seedream-5-0-pro-260628';
    var ct = '2025-06-01T10:00:0' + i + 'Z';
    decryptedRecordMap[encKey(ek)] = {type:'image',prompt:pv,params:{model:mv},result:rv,createdAt:ct};
    cloudRows.push({id:2+i,user_id:'tu',encrypted_data:encKey(ek),iv:'m',record_uid:null,updated_at:ct});
  }
  // 10条视频 不同taskId无法匹配
  for (var i = 0; i < 10; i++) {
    var ek2 = 'cloud-unmatched-' + i;
    decryptedRecordMap[encKey(ek2)] = {type:'video',prompt:'unmatched-'+i,taskId:'unmatched-task-'+i,result:['url-um-'+i],createdAt:'2025-06-01T11:00:0'+i+'Z'};
    cloudRows.push({id:10+i,user_id:'tu',encrypted_data:encKey(ek2),iv:'m',record_uid:null,updated_at:'2025-06-01T11:00:0'+i+'Z'});
  }
  return { localHistory: localHistory, cloudRows: cloudRows };
}
function setupMigrationMock(db, countNullResult) {
  mockResponseMap['/rest/v1/history'] = function(url, opts) {
    if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) return makeResponse({status:200,body:countNullResult});
    if (url.includes('record_uid=is.null') && url.includes('limit=1')) return makeResponse({status:200,body:[{id:1}]});
    if (url.includes('record_uid=is.null')) return makeResponse({status:200,body:[{id:1}]});
    if (url.includes('select=record_uid') && opts.method !== 'POST') return makeResponse({status:200,body:[]});
    if (opts.method === 'PATCH' && url.includes('id=eq.')) {
      var body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
      if (db && body.record_uid) {
        for (var i = 0; i < db.length; i++) { if (db[i].id === parseInt(url.match(/id=eq\.(\d+)/)[1])) { db[i].record_uid = body.record_uid; } }
      }
      return makeResponse({status:200,body:[{id:1,record_uid:body.record_uid||'patched'}]});
    }
    if (opts.method === 'DELETE') return makeResponse({status:200,body:[]});
    if (url.includes('order=created_at.desc')) return makeResponse({status:200,body:db||[]});
    return makeResponse({status:200,body:[]});
  };
  mockResponseMap['/rpc/'] = function(url, opts) { return makeResponse({status:200,body:{record_uid_not_null:true,unique_constraint_ready:true}}); };
}
var migrationTests = [
  asyncTest('迁移场景1: 57本地+19云端,1匹配+8冲突+10未匹配(预览)', function() {
    resetMock(); initSync();
    var data = buildMigrationData();
    localStorage._data['volc_history'] = JSON.stringify(data.localHistory);
    setupMigrationMock(data.cloudRows, []);
    return SyncManager.migrateHistoryData({ preview: true }).then(function(r) {
      assert.strictEqual(r.localTotal, 57, 'localTotal');
      assert.strictEqual(r.cloudTotal, 19, 'cloudTotal');
      assert.strictEqual(r.cloudMissingRecordUid, 19, 'cloudMissingRecordUid');
      assert.strictEqual(r.predictedNullUidPatch, 1, 'predictedNullUidPatch');
      assert.strictEqual(r.uncertainMatches, 8, 'uncertainMatches');
      assert.strictEqual(r.conflictCloudPreserved, 8, 'conflictCloudPreserved');
      assert.strictEqual(r.unmatchedCloudPreserved, 10, 'unmatchedCloudPreserved');
      assert.strictEqual(r.predictedIndependentUidPatch, 18, 'predictedIndependentUidPatch');
      assert.strictEqual(r.predictedDuplicateDelete, 0, 'predictedDuplicateDelete');
      assert.strictEqual(r.nullRecordUidAfter, 0, 'nullRecordUidAfter');
    });
  }),
  asyncTest('迁移场景2: 全部PATCH成功(执行)', function() {
    resetMock(); initSync();
    var data = buildMigrationData();
    var db = data.cloudRows.map(function(r) { return Object.assign({}, r); });
    localStorage._data['volc_history'] = JSON.stringify(data.localHistory);
    setupMigrationMock(db, []);
    return SyncManager.migrateHistoryData({ preview: false }).then(function(r) {
      assert.strictEqual(r.successfulNullUidPatch, 1, 'successfulNullUidPatch');
      assert.strictEqual(r.successfulIndependentUidPatch, 18, 'successfulIndependentUidPatch');
      assert.strictEqual(r.failedNullUidPatch, 0, 'failedNullUidPatch');
      assert.strictEqual(r.failedIndependentUidPatch, 0, 'failedIndependentUidPatch');
      var patchCount = fetchCalls.filter(function(c) { return c.method === 'PATCH' && c.url.includes('id=eq.'); }).length;
      assert.strictEqual(patchCount, 19, 'PATCH请求数');
      var deleteCount = fetchCalls.filter(function(c) { return c.method === 'DELETE'; }).length;
      assert.strictEqual(deleteCount, 0, 'DELETE请求数');
      var nonNull = db.filter(function(r) { return r.record_uid; });
      assert.strictEqual(nonNull.length, 19, '19条record_uid全部非空');
      var uids = nonNull.map(function(r) { return r.record_uid; });
      var unique = new Set(uids);
      assert.strictEqual(unique.size, 19, '19个record_uid互不相同');
      assert.strictEqual(r.actualNullRecordUid, 0, 'actualNullRecordUid');
    });
  }),
  asyncTest('迁移场景3: 1条PATCH失败(执行)', function() {
    resetMock(); initSync();
    var data = buildMigrationData();
    var db = data.cloudRows.map(function(r) { return Object.assign({}, r); });
    localStorage._data['volc_history'] = JSON.stringify(data.localHistory);
    var failId = db[1].id; // 第2条(第一条冲突图片)失败
    mockResponseMap['/rest/v1/history'] = function(url, opts) {
      if (url.includes('record_uid=is.null') && url.includes('select=id') && url.includes('limit=1000')) return makeResponse({status:200,body:[{id:failId}]});
      if (url.includes('record_uid=is.null') && url.includes('limit=1')) return makeResponse({status:200,body:[{id:1}]});
      if (url.includes('record_uid=is.null')) return makeResponse({status:200,body:[{id:1}]});
      if (url.includes('select=record_uid') && opts.method !== 'POST') return makeResponse({status:200,body:[]});
      if (opts.method === 'PATCH' && url.includes('id=eq.')) {
        var id = parseInt(url.match(/id=eq\.(\d+)/)[1]);
        var body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
        if (id === failId) return makeResponse({status:500,body:{error:'fail'}});
        if (db && body.record_uid) { for (var i = 0; i < db.length; i++) { if (db[i].id === id) db[i].record_uid = body.record_uid; } }
        return makeResponse({status:200,body:[{id:id,record_uid:body.record_uid||'ok'}]});
      }
      if (opts.method === 'DELETE') return makeResponse({status:200,body:[]});
      if (url.includes('order=created_at.desc')) return makeResponse({status:200,body:db});
      return makeResponse({status:200,body:[]});
    };
    mockResponseMap['/rpc/'] = function(url, opts) { return makeResponse({status:200,body:{record_uid_not_null:true,unique_constraint_ready:true}}); };
    return SyncManager.migrateHistoryData({ preview: false }).then(function(r) {
      assert.strictEqual(r.successfulNullUidPatch, 1, 'successfulNullUidPatch');
      assert.strictEqual(r.successfulIndependentUidPatch, 17, 'successfulIndependentUidPatch');
      assert.strictEqual(r.failedIndependentUidPatch, 1, 'failedIndependentUidPatch');
      assert.strictEqual(r.actualNullRecordUid, 1, 'actualNullRecordUid');
      var deleteCount = fetchCalls.filter(function(c) { return c.method === 'DELETE'; }).length;
      assert.strictEqual(deleteCount, 0, 'DELETE请求数');
    });
  }),
  asyncTest('迁移场景4: taskId重复(独立场景)', function() {
    resetMock(); initSync();
    for (var k in decryptedRecordMap) delete decryptedRecordMap[k];
    var ek1 = Buffer.from('dup-1','binary').toString('base64');
    var ek2 = Buffer.from('dup-2','binary').toString('base64');
    decryptedRecordMap[ek1] = {type:'video',prompt:'dup',taskId:'same-task',result:['du'],createdAt:'2025-07-01T10:00:00Z'};
    decryptedRecordMap[ek2] = {type:'video',prompt:'dup',taskId:'same-task',result:['du'],createdAt:'2025-07-01T09:00:00Z'};
    localStorage._data['volc_history'] = JSON.stringify([]);
    var cloudDup = [
      {id:1,user_id:'tu',encrypted_data:ek1,iv:'m',record_uid:null,updated_at:'2025-07-01T10:00:00Z'},
      {id:2,user_id:'tu',encrypted_data:ek2,iv:'m',record_uid:null,updated_at:'2025-07-01T09:00:00Z'}
    ];
    setupMigrationMock(cloudDup, []);
    return SyncManager.migrateHistoryData({ preview: true }).then(function(r) {
      assert.strictEqual(r.cloudOldDuplicates, 1, 'cloudOldDuplicates');
      assert.strictEqual(r.cloudOldDupToDelete, 1, 'cloudOldDupToDelete');
      assert.strictEqual(r.predictedDuplicateDelete, 1, 'predictedDuplicateDelete');
      assert.strictEqual(r.predictedIndependentUidPatch, 1, 'predictedIndependentUidPatch');
      assert.strictEqual(r.uncertainMatches, 0, 'uncertainMatches');
      assert.strictEqual(r.nullRecordUidAfter, 0, 'nullRecordUidAfter');
    });
  })
];
// ============ 6. checkDbState 无副作用测试 ============
console.log('\n=== 6. checkDbState 无副作用测试 ===');
var dbStateTests = [
  asyncTest('checkDbState: schema_not_ready', function() { resetMock(); initSync(); mockResponseMap['/rest/v1/history']=function(u,o){ if(u.includes('select=record_uid')&&o.method!=='POST') return makeResponse({status:400,body:{}}); return makeResponse({status:200,body:[]});}; return SyncManager.checkDbState().then(function(s){assert.strictEqual(s,'schema_not_ready');}); }),
  asyncTest('checkDbState: auth_error', function() { resetMock(); initSync(); mockResponseMap['/rest/v1/history']=function(u,o){ if(u.includes('select=record_uid')&&o.method!=='POST') return makeResponse({status:401,body:{}}); return makeResponse({status:200,body:[]});}; return SyncManager.checkDbState().then(function(s){assert.strictEqual(s,'auth_error');}); }),
  asyncTest('checkDbState: network_error', function() { resetMock(); initSync(); global.fetch=function(){return Promise.reject(new Error('net'));}; return SyncManager.checkDbState().then(function(s){global.fetch=mockFetch;assert.strictEqual(s,'network_error');}); }),
  asyncTest('checkDbState: migration_required', function() { resetMock(); initSync(); mockResponseMap['/rest/v1/history']=function(u,o){ if(u.includes('select=record_uid')&&o.method!=='POST') return makeResponse({status:200,body:[]}); if(u.includes('record_uid=is.null')&&u.includes('limit=1')) return makeResponse({status:200,body:[{id:1}]}); return makeResponse({status:200,body:[]});}; return SyncManager.checkDbState().then(function(s){assert.strictEqual(s,'migration_required');}); }),
  asyncTest('checkDbState: constraint_not_ready', function() { resetMock(); initSync(); mockResponseMap['/rest/v1/history']=function(u,o){ if(u.includes('select=record_uid')&&o.method!=='POST') return makeResponse({status:200,body:[]}); if(u.includes('record_uid=is.null')&&u.includes('limit=1')) return makeResponse({status:200,body:[]}); return makeResponse({status:200,body:[]});}; mockResponseMap['/rpc/']=function(){return makeResponse({status:404,body:{}});}; return SyncManager.checkDbState().then(function(s){assert.strictEqual(s,'constraint_not_ready');}); }),
  asyncTest('checkDbState: ready', function() { resetMock(); initSync(); mockResponseMap['/rest/v1/history']=function(u,o){ if(u.includes('select=record_uid')&&o.method!=='POST') return makeResponse({status:200,body:[]}); if(u.includes('record_uid=is.null')&&u.includes('limit=1')) return makeResponse({status:200,body:[]}); return makeResponse({status:200,body:[]});}; mockResponseMap['/rpc/']=function(){return makeResponse({status:200,body:{record_uid_not_null:true,unique_constraint_ready:true}});}; return SyncManager.checkDbState().then(function(s){assert.strictEqual(s,'ready');}); }),
  asyncTest('checkDbState: 无写请求', function() { resetMock(); initSync(); mockResponseMap['/rest/v1/history']=function(u,o){ if(u.includes('select=record_uid')&&o.method!=='POST') return makeResponse({status:200,body:[]}); if(u.includes('record_uid=is.null')&&u.includes('limit=1')) return makeResponse({status:200,body:[]}); return makeResponse({status:200,body:[]});}; mockResponseMap['/rpc/']=function(){return makeResponse({status:200,body:{record_uid_not_null:true,unique_constraint_ready:true}});}; return SyncManager.checkDbState().then(function(){ var w=fetchCalls.filter(function(c){return(c.method==='POST'||c.method==='PATCH'||c.method==='DELETE')&&c.url.includes('/history');}); assert.strictEqual(w.length,0); var t=fetchCalls.some(function(c){return c.url.includes('__constraint_test__');}); assert.ok(!t); }); })
];
// ============ 7. handleImageGenerate caps 静态回归检查 ============
console.log('\n=== 7. handleImageGenerate caps 声明顺序静态回归检查 ===');
syncTest('handleImageGenerate: model -> mi -> caps 声明顺序正确', function() {
  var m = appCode.match(/async function handleImageGenerate\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m); var f = m[0];
  var mi = f.indexOf("const model"), ii = f.indexOf("const mi"), ci = f.indexOf("const caps"), ri = f.indexOf("caps.maxRefImages");
  assert.ok(mi > -1 && ii > -1 && ci > -1 && ri > -1);
  assert.ok(mi < ii && ii < ci && ci < ri);
});
syncTest('handleImageGenerate: i2i 在 caps 后检查 maxRefImages', function() {
  var m = appCode.match(/async function handleImageGenerate\(\)\s*\{[\s\S]*?\n\}/);
  var f = m[0];
  assert.ok(f.indexOf('const caps = mi.caps') < f.indexOf("caps.maxRefImages && imgRefImages.length"));
});
syncTest('IMAGE_MODELS: 每个模型都有 caps.maxRefImages', function() {
  var mm = apiCode.match(/const IMAGE_MODELS = \[[\s\S]*?\];/);
  assert.ok(mm); eval(mm[0].replace('const IMAGE_MODELS =','var IMAGE_MODELS ='));
  IMAGE_MODELS.forEach(function(m){ assert.ok(m.caps); assert.ok(typeof m.caps.maxRefImages === 'number'); });
});
syncTest('refreshGenerateButtonState: mi null 安全检查', function() {
  var m = appCode.match(/function refreshGenerateButtonState\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m); assert.ok(m[0].includes('mi ? mi.caps.maxRefImages'));
});
// ============ 8. 回归测试 ============
console.log('\n=== 8. 回归测试 ===');
syncTest('sync.js 包含 getRecordModel', function() { assert.ok(syncCode.includes('function getRecordModel')); });
syncTest('sync.js deleteHistory 检查 0-row', function() { assert.ok(syncCode.includes('DELETE_TARGET_NOT_FOUND')); });
syncTest('sync.js checkDbState 无 __constraint_test__', function() { assert.ok(!syncCode.includes('__constraint_test__')); });
syncTest('sync.js pullHistory 设置 record.recordUid', function() { assert.ok(syncCode.includes('record.recordUid = rows[i].record_uid')); });
syncTest('sync.js pullHistory 设置 _cloudRecordUid', function() { assert.ok(syncCode.includes('record._cloudRecordUid = rows[i].record_uid')); });
syncTest('sync.js pullHistory 设置 _syncId', function() { assert.ok(syncCode.includes('record._syncId = rows[i].id')); });
syncTest('app.js mergeCloudHistory 从外部文件加载', function() { assert.ok(appCode.includes('mergeCloudHistory')); assert.ok(!appCode.includes('function mergeCloudHistory')); });
syncTest('merge-cloud-history.js 导出函数', function() { assert.ok(typeof mergeCloudHistory === 'function'); });
syncTest('merge-cloud-history.js 不操作 DOM', function() { var fn = mergeCloudHistory.toString(); assert.ok(!fn.includes('document.')); assert.ok(!fn.includes('localStorage')); assert.ok(!fn.includes('fetch(')); });
// ============ 运行 ============
var allAsyncTests = pullTests.concat(deleteTests).concat(migrationTests).concat(dbStateTests);
allAsyncTests.reduce(function(p, t) { return p.then(function() { return t(); }); }, Promise.resolve()).then(function() {
  console.log('\n========================================');
  console.log('测试结果汇总');
  console.log('========================================');
  testResults.forEach(function(r) { console.log(r); });
  console.log('\n测试总数: ' + testTotal);
  console.log('通过: ' + testPassed + '，失败: ' + testFailed);
  console.log('退出码: ' + (testFailed > 0 ? 1 : 0));
  console.log('========================================');
  if (testFailed > 0) process.exit(1);
}).catch(function(e) { console.error('测试执行错误:', e); process.exit(1); });
