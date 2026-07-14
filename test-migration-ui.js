// test-migration-ui.js
// 迁移完成态界面行为测试
// 运行: node test-migration-ui.js
// 测试 updateMigrationUI 在不同 dbState 下的界面状态

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ============ Mock DOM ============
// 用 JS 对象模拟 DOM 元素，记录 style.display / disabled / textContent / innerHTML
function createElement() {
  var children = {};
  var el = {
    style: { display: '' },
    disabled: false,
    textContent: '',
    innerHTML: '',
    classList: {
      _classes: [],
      add: function(c) { this._classes.push(c); },
      remove: function(c) { this._classes = this._classes.filter(function(x) { return x !== c; }); },
      contains: function(c) { return this._classes.indexOf(c) >= 0; }
    },
    appendChild: function(child) {},
    querySelector: function(sel) { return null; },
    querySelectorAll: function(sel) { return []; },
    _children: children,
    getElementById: function(id) { return children[id] || null; }
  };
  return el;
}

var elements = {};
function setupDOM() {
  elements = {};
  // 创建所有需要的元素
  var ids = [
    'migrationSection', 'migrationActions', 'migrationStatus', 'migrationHint',
    'btnMigratePreview', 'btnMigrateExecute', 'syncStatus'
  ];
  ids.forEach(function(id) {
    elements[id] = createElement();
  });
}

// Mock document
global.document = {
  getElementById: function(id) {
    return elements[id] || null;
  },
  querySelectorAll: function(sel) { return []; },
  addEventListener: function() {},
  createElement: function() { return createElement(); }
};

// Mock window
global.window = {};

// Mock SyncManager
var syncEnabled = false;
global.SyncManager = {
  isEnabled: function() { return syncEnabled; },
  _dbState: null
};

// ============ 加载 app.js 并提取 updateMigrationUI ============
// app.js 在 DOMContentLoaded 闭包内定义函数，需要 eval 后手动提取
var appCode = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// 由于 app.js 使用 DOMContentLoaded，我们需要提取函数定义
// updateMigrationUI 和 updateSyncStatus 定义在闭包内
// 我们用正则提取函数体，或者在 eval 之前注入 window 暴露

// 方案：eval app.js，但先 mock document.addEventListener 来阻止 DOMContentLoaded
var domReadyCallbacks = [];
global.document.addEventListener = function(event, cb) {
  if (event === 'DOMContentLoaded') {
    domReadyCallbacks.push(cb);
  }
};

// 先提取 updateMigrationUI 函数体（不执行整个 app.js）
// 由于函数在闭包内，我们直接 eval 整个文件但阻止 DOMContentLoaded
try {
  eval(appCode);
} catch (e) {
  // app.js 中可能有 Store / ARK_BASE_URL 等未定义引用，忽略
}

// 如果 eval 成功且 window.updateMigrationUI 被设置
var updateMigrationUI = global.window.updateMigrationUI;
var updateSyncStatus = global.window.updateSyncStatus;

// 如果函数没有被暴露（eval 可能因错误中断），手动从源码提取
if (!updateMigrationUI) {
  // 从源码中提取 updateMigrationUI 函数体并 eval
  var match = appCode.match(/function updateMigrationUI\(dbState\)\s*\{[\s\S]*?\n\}/);
  if (match) {
    // 提供 document 和 SyncManager 上下文
    eval(match[0]);
    updateMigrationUI = updateMigrationUI;
  }
}

if (!updateSyncStatus) {
  var match2 = appCode.match(/function updateSyncStatus\(dbState\)\s*\{[\s\S]*?\n\}/);
  if (match2) {
    eval(match2[0]);
    updateSyncStatus = updateSyncStatus;
  }
}

assert.ok(typeof updateMigrationUI === 'function', 'updateMigrationUI must be a function');
assert.ok(typeof updateSyncStatus === 'function', 'updateSyncStatus must be a function');

// ============ 辅助函数 ============
function resetSync(enabled) {
  syncEnabled = enabled;
  global.SyncManager._dbState = null;
}

function getSectionDisplay() {
  return elements.migrationSection.style.display;
}
function getActionsDisplay() {
  return elements.migrationActions.style.display;
}
function getExecuteDisabled() {
  return elements.btnMigrateExecute.disabled;
}
function getPreviewDisabled() {
  return elements.btnMigratePreview.disabled;
}
function getHintText() {
  return elements.migrationHint.textContent;
}
function getStatusHTML() {
  return elements.migrationStatus.innerHTML;
}

// ============ 测试 ============
var testPassed = 0;
var testFailed = 0;
var testTotal = 0;
var testResults = [];
var asyncTests = [];

function test(name, fn) {
  testTotal++;
  setupDOM();
  var result;
  try {
    result = fn();
  } catch (e) {
    testFailed++;
    testResults.push('FAIL: ' + name + ' - ' + e.message);
    return;
  }
  if (result && typeof result.then === 'function') {
    asyncTests.push({ name: name, promise: result });
  } else {
    testPassed++;
    testResults.push('PASS: ' + name);
  }
}

// --- 1. sync 未开启 ---
test('sync disabled: migrationSection 隐藏', function() {
  resetSync(false);
  updateMigrationUI(null);
  assert.strictEqual(getSectionDisplay(), 'none', 'migrationSection should be hidden');
  assert.strictEqual(getActionsDisplay(), 'none', 'migrationActions should be hidden by default');
});

test('sync disabled: dbState=migration_required 仍隐藏', function() {
  resetSync(false);
  updateMigrationUI('migration_required');
  assert.strictEqual(getSectionDisplay(), 'none', 'migrationSection should be hidden even if dbState=migration_required');
});

// --- 2. dbState = migration_required ---
test('migration_required: 显示 section 和按钮', function() {
  resetSync(true);
  updateMigrationUI('migration_required');
  assert.strictEqual(getSectionDisplay(), 'block', 'migrationSection should be visible');
  assert.strictEqual(getActionsDisplay(), 'flex', 'migrationActions should be visible');
  assert.strictEqual(getPreviewDisabled(), false, '预览按钮应可用');
  assert.strictEqual(getExecuteDisabled(), true, '执行按钮应禁用');
});

test('migration_required: 提示文字正确', function() {
  resetSync(true);
  updateMigrationUI('migration_required');
  assert.ok(getHintText().indexOf('检测到旧版历史数据') >= 0, '提示应包含"检测到旧版历史数据"');
  assert.ok(getHintText().indexOf('预览确认') >= 0, '提示应包含"预览确认"');
});

// --- 3. dbState = constraint_not_ready ---
test('constraint_not_ready: 显示 section, 隐藏按钮', function() {
  resetSync(true);
  updateMigrationUI('constraint_not_ready');
  assert.strictEqual(getSectionDisplay(), 'block', 'migrationSection should be visible');
  assert.strictEqual(getActionsDisplay(), 'none', 'migrationActions should be hidden');
});

test('constraint_not_ready: 提示文字正确', function() {
  resetSync(true);
  updateMigrationUI('constraint_not_ready');
  assert.ok(getHintText().indexOf('迁移已完成') >= 0, '提示应包含"迁移已完成"');
  assert.ok(getHintText().indexOf('阶段 B 约束') >= 0, '提示应包含"阶段 B 约束"');
  assert.ok(getHintText().indexOf('请勿重复执行迁移') >= 0, '提示应包含"请勿重复执行迁移"');
});

test('constraint_not_ready: 执行按钮重置为禁用', function() {
  resetSync(true);
  // 先模拟 migration_required 下的预览后启用
  setupDOM();
  elements.btnMigrateExecute.disabled = false;
  // 切换到 constraint_not_ready
  updateMigrationUI('constraint_not_ready');
  assert.strictEqual(getExecuteDisabled(), true, '执行按钮应被重置为禁用');
});

// --- 4. dbState = ready ---
test('ready: 显示 section, 隐藏按钮', function() {
  resetSync(true);
  updateMigrationUI('ready');
  assert.strictEqual(getSectionDisplay(), 'block', 'migrationSection should be visible');
  assert.strictEqual(getActionsDisplay(), 'none', 'migrationActions should be hidden');
});

test('ready: 提示文字包含完成提示', function() {
  resetSync(true);
  updateMigrationUI('ready');
  assert.ok(getHintText().indexOf('迁移已完成') >= 0, '提示应包含"迁移已完成"');
  assert.ok(getHintText().indexOf('无需重复操作') >= 0, '提示应包含"无需重复操作"');
});

test('ready: 状态使用成功色', function() {
  resetSync(true);
  updateMigrationUI('ready');
  var html = getStatusHTML();
  assert.ok(html.indexOf('#00d4aa') >= 0, '状态应使用成功色 #00d4aa');
});

// --- 5. dbState = schema_not_ready ---
test('schema_not_ready: 显示 section, 隐藏按钮', function() {
  resetSync(true);
  updateMigrationUI('schema_not_ready');
  assert.strictEqual(getSectionDisplay(), 'block', 'migrationSection should be visible');
  assert.strictEqual(getActionsDisplay(), 'none', 'migrationActions should be hidden');
});

test('schema_not_ready: 提示文字正确', function() {
  resetSync(true);
  updateMigrationUI('schema_not_ready');
  assert.ok(getHintText().indexOf('阶段 A 升级') >= 0, '提示应包含"阶段 A 升级"');
  assert.ok(getHintText().indexOf('迁移功能暂不可用') >= 0, '提示应包含"迁移功能暂不可用"');
});

// --- 6. dbState = network_error ---
test('network_error: 隐藏 section', function() {
  resetSync(true);
  updateMigrationUI('network_error');
  assert.strictEqual(getSectionDisplay(), 'none', 'migrationSection should be hidden for network_error');
});

test('network_error: 按钮也隐藏', function() {
  resetSync(true);
  updateMigrationUI('network_error');
  assert.strictEqual(getActionsDisplay(), 'none', 'migrationActions should be hidden');
});

// --- 7. dbState = auth_error ---
test('auth_error: 隐藏 section', function() {
  resetSync(true);
  updateMigrationUI('auth_error');
  assert.strictEqual(getSectionDisplay(), 'none', 'migrationSection should be hidden for auth_error');
});

// --- 8. dbState = 空值 ---
test('空值 dbState: 隐藏 section', function() {
  resetSync(true);
  updateMigrationUI(null);
  assert.strictEqual(getSectionDisplay(), 'none', 'migrationSection should be hidden for null dbState');
});

test('空值 dbState: 隐藏 section (undefined)', function() {
  resetSync(true);
  updateMigrationUI(undefined);
  assert.strictEqual(getSectionDisplay(), 'none', 'migrationSection should be hidden for undefined dbState');
});

// --- 9. dbState = 未知状态 ---
test('未知 dbState: 隐藏 section', function() {
  resetSync(true);
  updateMigrationUI('unknown_state');
  assert.strictEqual(getSectionDisplay(), 'none', 'migrationSection should be hidden for unknown dbState');
});

// --- 10. 状态切换时按钮重置 ---
test('状态切换: migration_required -> ready 按钮重置', function() {
  resetSync(true);
  // 先处于 migration_required，预览后执行按钮被启用
  setupDOM();
  updateMigrationUI('migration_required');
  elements.btnMigrateExecute.disabled = false;
  elements.btnMigratePreview.textContent = '预览中...';
  // 切换到 ready
  updateMigrationUI('ready');
  assert.strictEqual(getExecuteDisabled(), true, '执行按钮应重置为禁用');
  assert.strictEqual(elements.btnMigratePreview.textContent, '预览迁移', '预览按钮文字应重置');
});

test('状态切换: ready -> migration_required 按钮恢复可用', function() {
  resetSync(true);
  setupDOM();
  // 先处于 ready（按钮隐藏且禁用）
  updateMigrationUI('ready');
  assert.strictEqual(getActionsDisplay(), 'none');
  // 切换回 migration_required
  updateMigrationUI('migration_required');
  assert.strictEqual(getActionsDisplay(), 'flex', '按钮区域应重新显示');
  assert.strictEqual(getPreviewDisabled(), false, '预览按钮应可用');
  assert.strictEqual(getExecuteDisabled(), true, '执行按钮应默认禁用');
});

// --- 11. updateSyncStatus 调用 updateMigrationUI ---
test('updateSyncStatus(sync未开启): 迁移区域隐藏', function() {
  resetSync(false);
  setupDOM();
  updateSyncStatus(null);
  assert.strictEqual(getSectionDisplay(), 'none', 'sync未开启时迁移区域应隐藏');
});

test('updateSyncStatus(migration_required): 迁移区域显示且按钮可见', function() {
  resetSync(true);
  setupDOM();
  updateSyncStatus('migration_required');
  assert.strictEqual(getSectionDisplay(), 'block');
  assert.strictEqual(getActionsDisplay(), 'flex');
});

test('updateSyncStatus(ready): 迁移区域显示但按钮隐藏', function() {
  resetSync(true);
  setupDOM();
  updateSyncStatus('ready');
  assert.strictEqual(getSectionDisplay(), 'block');
  assert.strictEqual(getActionsDisplay(), 'none');
});

// --- 12. 语法检查 ---
test('app.js 语法检查', function() {
  new Function(appCode);
});

test('APP_VERSION = 1.6.7', function() {
  assert.ok(appCode.indexOf("const APP_VERSION = '1.6.7'") >= 0, 'APP_VERSION should be 1.6.7');
});

test('index.html 包含 migrationActions id', function() {
  var html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(html.indexOf('id="migrationActions"') >= 0, 'index.html should contain migrationActions id');
});

test('index.html 版本号 v1.6.7', function() {
  var html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(html.indexOf('v1.6.7') >= 0, 'index.html should contain v1.6.7');
});

test('index.html query 参数 v=1.6.7', function() {
  var html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(html.indexOf('app.js?v=1.6.7') >= 0, 'index.html should use ?v=1.6.7');
});

// ============ 提取执行迁移 onclick 收尾逻辑 ============
// 从 app.js 源码中提取 btnMigrateExecute.onclick handler 的完整定义
// 用于在测试中实际执行收尾逻辑
var execHandlerMatch = appCode.match(/document\.getElementById\('btnMigrateExecute'\)\.onclick = async \(\) => \{([\s\S]*?)\n  \};/);
assert.ok(execHandlerMatch, '必须找到 btnMigrateExecute.onclick handler 定义');
var execHandlerBody = execHandlerMatch[1];

// Mock showToast / confirm / SyncManager.migrateHistoryData / renderHistory
global.showToast = function() {};
global.renderHistory = function() {};
global.confirm = function() { return true; };

// 构建一个可执行的 async 函数来模拟 onclick handler
// 使用 eval 在当前作用域定义，确保能访问 updateMigrationUI / updateSyncStatus
function buildExecHandler(mockMigrateResult, mockNewDbState) {
  var origMigrate = global.SyncManager.migrateHistoryData;
  var origClearDbState = global.SyncManager.clearDbStateCache;
  var origCheckDbState = global.SyncManager.checkDbState;
  global.SyncManager.migrateHistoryData = function() { return Promise.resolve(mockMigrateResult); };
  global.SyncManager.clearDbStateCache = function() {};
  global.SyncManager.checkDbState = function() { return Promise.resolve(mockNewDbState); };

  // 用 eval 在当前作用域创建 handler，确保 updateSyncStatus 可访问
  var handler = eval('(async () => { ' + execHandlerBody + ' })');
  return handler;
}

// --- 13. 执行迁移收尾：成功后执行按钮禁用 ---
test('执行迁移成功后: btnMigrateExecute.disabled === true', function() {
  resetSync(true);
  // 先设置 migration_required 状态
  updateMigrationUI('migration_required');
  // 模拟预览成功后启用执行按钮
  elements.btnMigrateExecute.disabled = false;
  assert.strictEqual(getExecuteDisabled(), false, '预览后执行按钮应可用');

  // 构建模拟的迁移成功报告
  var successReport = {
    success: true,
    localTotal: 57,
    cloudTotal: 19,
    existingUidMatched: 0,
    predictedNullUidPatch: 1,
    successfulNullUidPatch: 1,
    failedNullUidPatch: 0,
    predictedIndependentUidPatch: 18,
    successfulIndependentUidPatch: 18,
    failedIndependentUidPatch: 0,
    cloudToDelete: 0,
    cloudOldDupToDelete: 0,
    predictedDuplicateDelete: 0,
    successfulDuplicateDelete: 0,
    failedDuplicateDelete: 0,
    conflictCloudPreserved: 8,
    uncertainMatches: 8,
    pendingUpload: 0,
    nullRecordUidAfter: 0,
    actualNullRecordUid: 0,
    errors: [],
    dbState: 'migration_required',
    steps: [],
    preview: false
  };

  var handler = buildExecHandler(successReport, 'constraint_not_ready');
  return handler().then(function() {
    // 收尾后执行按钮必须禁用
    assert.strictEqual(getExecuteDisabled(), true, '执行成功后执行按钮必须禁用');
    // 预览按钮应恢复可用
    assert.strictEqual(getPreviewDisabled(), false, '预览按钮应恢复可用');
    assert.strictEqual(elements.btnMigratePreview.textContent, '预览迁移', '预览按钮文字应恢复');
    assert.strictEqual(elements.btnMigrateExecute.textContent, '执行迁移', '执行按钮文字应恢复');
  });
});

// --- 14. 执行迁移收尾：失败后也必须重新预览 ---
test('执行迁移失败后: btnMigrateExecute.disabled === true', function() {
  resetSync(true);
  updateMigrationUI('migration_required');
  // 模拟预览成功后启用执行按钮
  elements.btnMigrateExecute.disabled = false;
  assert.strictEqual(getExecuteDisabled(), false, '预览后执行按钮应可用');

  // 构建模拟的迁移失败报告
  var failReport = {
    success: false,
    localTotal: 57,
    cloudTotal: 19,
    existingUidMatched: 0,
    predictedNullUidPatch: 1,
    successfulNullUidPatch: 1,
    failedNullUidPatch: 0,
    predictedIndependentUidPatch: 18,
    successfulIndependentUidPatch: 17,
    failedIndependentUidPatch: 1,
    cloudToDelete: 0,
    cloudOldDupToDelete: 0,
    predictedDuplicateDelete: 0,
    successfulDuplicateDelete: 0,
    failedDuplicateDelete: 0,
    conflictCloudPreserved: 8,
    uncertainMatches: 8,
    pendingUpload: 0,
    nullRecordUidAfter: 1,
    actualNullRecordUid: 1,
    errors: ['独立补 UID 失败 (cloudId=cloud-2): simulated failure'],
    dbState: 'migration_required',
    steps: [],
    preview: false
  };

  var handler = buildExecHandler(failReport, 'migration_required');
  return handler().then(function() {
    // 收尾后执行按钮必须禁用（失败后不得直接再次执行）
    assert.strictEqual(getExecuteDisabled(), true, '执行失败后执行按钮必须禁用');
    // 预览按钮应恢复可用
    assert.strictEqual(getPreviewDisabled(), false, '预览按钮应恢复可用');
    assert.strictEqual(elements.btnMigratePreview.textContent, '预览迁移', '预览按钮文字应恢复');
    assert.strictEqual(elements.btnMigrateExecute.textContent, '执行迁移', '执行按钮文字应恢复');
  });
});

// --- 15. ready 状态下按钮区域隐藏且执行按钮禁用 ---
test('ready 状态: 按钮区域隐藏且执行按钮禁用', function() {
  resetSync(true);
  // 先模拟 migration_required 并启用执行按钮
  updateMigrationUI('migration_required');
  elements.btnMigrateExecute.disabled = false;
  assert.strictEqual(getActionsDisplay(), 'flex');
  assert.strictEqual(getExecuteDisabled(), false);

  // 切换到 ready
  updateMigrationUI('ready');
  assert.strictEqual(getActionsDisplay(), 'none', 'ready 状态下按钮区域必须隐藏');
  assert.strictEqual(getExecuteDisabled(), true, 'ready 状态下执行按钮必须禁用');
  assert.strictEqual(getPreviewDisabled(), false, 'ready 状态下预览按钮应可用(但隐藏)');
});

// ============ 运行 ============
// 先等所有异步测试完成
asyncTests.reduce(function(p, t) {
  return p.then(function() {
    return t.promise.then(function() {
      testPassed++;
      testResults.push('PASS: ' + t.name);
    }).catch(function(e) {
      testFailed++;
      testResults.push('FAIL: ' + t.name + ' - ' + (e.message || e));
    });
  });
}, Promise.resolve()).then(function() {
  console.log('\n========================================');
  console.log('迁移完成态界面行为测试');
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
