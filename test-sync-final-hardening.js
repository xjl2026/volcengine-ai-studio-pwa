// test-sync-final-hardening.js
// 针对历史迁移最终收口的生产逻辑回归测试
// 运行: node test-sync-final-hardening.js

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { webcrypto } = require('crypto');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

global.crypto = webcrypto;
global.window = global;
global.atob = value => Buffer.from(value, 'base64').toString('binary');
global.btoa = value => Buffer.from(value, 'binary').toString('base64');

let localFixture = [];
let savedHistory = null;
global.Store = {
  async getHistory() {
    return clone(localFixture);
  },
  async saveHistory(history) {
    savedHistory = clone(history);
  }
};

const syncCode = fs.readFileSync(require.resolve('./sync.js'), 'utf8')
  .replace('window.SyncManager = SyncManager;', 'global.SyncManager = SyncManager;');
vm.runInThisContext(syncCode, { filename: 'sync.js' });

async function deriveEncryptionKey(syncKey) {
  const bytes = new TextEncoder().encode(syncKey + 'enc-v1');
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt']);
}

async function encryptRecord(syncKey, record) {
  const key = await deriveEncryptionKey(syncKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(record));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    encrypted_data: Buffer.from(new Uint8Array(encrypted)).toString('base64'),
    iv: Buffer.from(iv).toString('base64')
  };
}

async function buildRealMigrationFixture() {
  const syncKey = 'sync-final-hardening-key';
  const baseTime = Date.parse('2026-07-01T00:00:00.000Z');
  const localHistory = [];
  const cloudRecords = [];

  // 1 条可靠 taskId 匹配。本地 recordUid/updatedAt 故意均缺失。
  localHistory.push({
    type: 'video',
    taskId: 'reliable-task',
    prompt: 'reliable',
    createdAt: new Date(baseTime).toISOString(),
    params: { model: 'video-model' },
    result: ['reliable.mp4']
  });
  cloudRecords.push({
    type: 'video',
    taskId: 'reliable-task',
    prompt: 'reliable',
    createdAt: new Date(baseTime).toISOString(),
    params: { model: 'video-model' },
    result: ['reliable.mp4']
  });

  // 8 条云端图片，每条都对应 2 条本地候选，必须判定为多候选冲突。
  for (let group = 0; group < 8; group++) {
    for (let candidate = 0; candidate < 2; candidate++) {
      localHistory.push({
        type: 'image',
        prompt: 'conflict-' + group,
        createdAt: new Date(baseTime + group * 100000 + candidate * 1000).toISOString(),
        params: { model: 'image-model' },
        result: ['image-' + group + '.png']
      });
    }
    cloudRecords.push({
      type: 'image',
      prompt: 'conflict-' + group,
      createdAt: new Date(baseTime + group * 100000 + 500).toISOString(),
      params: { model: 'image-model' },
      result: ['image-' + group + '.png']
    });
  }

  // 补足到 57 条本地记录，均缺 recordUid/updatedAt。
  for (let index = 0; index < 40; index++) {
    localHistory.push({
      type: 'video',
      taskId: 'local-only-' + index,
      prompt: 'local-only-' + index,
      createdAt: new Date(baseTime + 1000000 + index * 1000).toISOString(),
      params: { model: 'video-model' },
      result: ['local-' + index + '.mp4']
    });
  }

  // 10 条云端记录无法与本地匹配。
  for (let index = 0; index < 10; index++) {
    cloudRecords.push({
      type: 'video',
      taskId: 'cloud-only-' + index,
      prompt: 'cloud-only-' + index,
      createdAt: new Date(baseTime + 2000000 + index * 1000).toISOString(),
      params: { model: 'video-model' },
      result: ['cloud-' + index + '.mp4']
    });
  }

  const cloudRows = [];
  for (let index = 0; index < cloudRecords.length; index++) {
    const encrypted = await encryptRecord(syncKey, cloudRecords[index]);
    cloudRows.push({
      id: 'cloud-' + (index + 1),
      user_id: 'test-user',
      record_uid: null,
      encrypted_data: encrypted.encrypted_data,
      iv: encrypted.iv,
      created_at: new Date(baseTime + index * 1000).toISOString(),
      updated_at: new Date(baseTime + index * 1000).toISOString(),
      is_deleted: false
    });
  }

  assert.strictEqual(localHistory.length, 57);
  assert.strictEqual(cloudRows.length, 19);
  return { syncKey, localHistory, cloudRows };
}

async function executeScenario(mode) {
  const fixture = await buildRealMigrationFixture();
  localFixture = fixture.localHistory;
  savedHistory = null;
  const db = clone(fixture.cloudRows);
  const calls = [];
  const failedOnce = new Set();

  SyncManager._url = 'https://example.test';
  SyncManager._anonKey = 'anon-key';
  SyncManager._syncKey = fixture.syncKey;
  SyncManager._userId = 'test-user';
  SyncManager.checkDbState = async () => 'migration_required';
  SyncManager.pullAllHistoryRows = async () => db;
  SyncManager.countNullRecordUid = async () => db.filter(row => !row.record_uid).length;
  SyncManager.deleteCloudRecord = async cloudId => {
    calls.push({ method: 'DELETE', cloudId });
    const index = db.findIndex(row => row.id === cloudId);
    if (index >= 0) db.splice(index, 1);
    return true;
  };
  SyncManager._request = async (path, options) => {
    const method = (options && options.method) || 'GET';
    const match = path.match(/(?:^|&)id=eq\.([^&]+)/);
    const cloudId = match ? decodeURIComponent(match[1]) : null;
    const recordUid = options && options.body && options.body.record_uid;
    calls.push({ method, cloudId, recordUid, path });

    if (method !== 'PATCH' || !cloudId) {
      throw new Error('Unexpected request: ' + method + ' ' + path);
    }
    if (mode === 'independent-failure' && cloudId === 'cloud-2') {
      throw new Error('simulated independent PATCH failure');
    }
    if (mode === 'reliable-failure-once' && cloudId === 'cloud-1' && !failedOnce.has(cloudId)) {
      failedOnce.add(cloudId);
      throw new Error('simulated reliable PATCH failure');
    }

    const row = db.find(item => item.id === cloudId);
    if (!row) return [];
    row.record_uid = recordUid;
    return [{ id: row.id, record_uid: row.record_uid }];
  };

  const report = await SyncManager.migrateHistoryData({ preview: mode === 'preview' });
  return { report, db, calls };
}

async function testExactPreview() {
  const { report } = await executeScenario('preview');
  assert.strictEqual(report.success, true);
  assert.strictEqual(report.localTotal, 57);
  assert.strictEqual(report.localMissingRecordUid, 57);
  assert.strictEqual(report.localMissingUpdatedAt, 57);
  assert.strictEqual(report.cloudTotal, 19);
  assert.strictEqual(report.cloudMissingRecordUid, 19);
  assert.strictEqual(report.predictedNullUidPatch, 1);
  assert.strictEqual(report.uncertainMatches, 8);
  assert.strictEqual(report.conflictCloudPreserved, 8);
  assert.strictEqual(report.unmatchedCloudPreserved, 10);
  assert.strictEqual(report.predictedIndependentUidPatch, 18);
  assert.strictEqual(report.predictedDuplicateDelete, 0);
  assert.strictEqual(report.nullRecordUidAfter, 0);
}

async function testExactExecution() {
  const { report, db, calls } = await executeScenario('success');
  assert.strictEqual(report.success, true);
  assert.strictEqual(report.successfulNullUidPatch, 1);
  assert.strictEqual(report.successfulIndependentUidPatch, 18);
  assert.strictEqual(report.failedNullUidPatch, 0);
  assert.strictEqual(report.failedIndependentUidPatch, 0);
  assert.strictEqual(report.successfulDuplicateDelete, 0);
  assert.strictEqual(report.actualNullRecordUid, 0);
  assert.strictEqual(calls.filter(call => call.method === 'PATCH').length, 19);
  assert.strictEqual(calls.filter(call => call.method === 'DELETE').length, 0);
  assert.strictEqual(db.filter(row => !row.record_uid).length, 0);
  assert.strictEqual(new Set(db.map(row => row.record_uid)).size, 19);
  assert.ok(savedHistory);
  assert.strictEqual(savedHistory.filter(row => !row.recordUid).length, 0);
  assert.strictEqual(savedHistory.filter(row => !row.updatedAt).length, 0);
}

async function testIndependentPatchFailure() {
  const { report, db, calls } = await executeScenario('independent-failure');
  assert.strictEqual(report.success, false);
  assert.strictEqual(report.successfulNullUidPatch, 1);
  assert.strictEqual(report.successfulIndependentUidPatch, 17);
  assert.strictEqual(report.failedIndependentUidPatch, 1);
  assert.strictEqual(report.actualNullRecordUid, 1);
  assert.strictEqual(db.filter(row => !row.record_uid).length, 1);
  assert.strictEqual(calls.filter(call => call.method === 'DELETE').length, 0);
}

async function testReliableMatchFailureDoesNotFallBack() {
  const { report, db, calls } = await executeScenario('reliable-failure-once');
  const reliableCalls = calls.filter(call => call.method === 'PATCH' && call.cloudId === 'cloud-1');
  assert.strictEqual(reliableCalls.length, 1, '可靠匹配失败后不得再次独立补 UID');
  assert.strictEqual(report.success, false);
  assert.strictEqual(report.predictedNullUidPatch, 1);
  assert.strictEqual(report.successfulNullUidPatch, 0);
  assert.strictEqual(report.failedNullUidPatch, 1);
  assert.strictEqual(report.predictedIndependentUidPatch, 18);
  assert.strictEqual(report.successfulIndependentUidPatch, 18);
  assert.strictEqual(report.failedIndependentUidPatch, 0);
  assert.strictEqual(report.actualNullRecordUid, 1);
  assert.strictEqual(db.find(row => row.id === 'cloud-1').record_uid, null);
}

async function testPatch200EmptyArrayIsFailure() {
  SyncManager._url = 'https://example.test';
  SyncManager._anonKey = 'anon-key';
  SyncManager._syncKey = 'sync-key';
  SyncManager._userId = 'test-user';
  SyncManager._request = async () => [];
  await assert.rejects(
    () => SyncManager.patchRecordUid('missing-row', crypto.randomUUID()),
    /PATCH_RECORD_UID_TARGET_NOT_FOUND/
  );
}

const tests = [
  ['真实预览计数', testExactPreview],
  ['全部成功后实际空 UID 为 0', testExactExecution],
  ['独立补 UID 失败后实际空 UID 为 1 且整体失败', testIndependentPatchFailure],
  ['可靠匹配 PATCH 失败不得降级独立补 UID', testReliableMatchFailureDoesNotFallBack],
  ['PATCH 200 + 空数组不得算成功', testPatch200EmptyArrayIsFailure]
];

(async () => {
  let passed = 0;
  for (const [name, test] of tests) {
    try {
      await test();
      passed++;
      console.log('PASS:', name);
    } catch (error) {
      console.error('FAIL:', name, '-', error.stack || error.message);
      process.exitCode = 1;
    }
  }
  console.log('\nHardening tests:', passed + '/' + tests.length, 'passed');
  if (passed !== tests.length) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
