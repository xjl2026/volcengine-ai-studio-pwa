// merge-cloud-history.js - 纯函数：云端记录与本地记录合并
// 从 app.js 的 syncHistoryFromCloud 提取，无 DOM / localStorage / 网络依赖
// 可被 app.js 和测试脚本共同加载

function mergeCloudHistory(localHistory, cloudRecords, options) {
  options = options || {};
  var readOnly = options.readOnly;
  var dbState = options.dbState;

  // 深拷贝本地记录，避免修改输入
  var history = localHistory.map(function(r) { return Object.assign({}, r); });

  // 构建索引
  var localByRecordUid = {};
  var localBySyncId = {};
  for (var i = 0; i < history.length; i++) {
    if (history[i].recordUid) {
      localByRecordUid[history[i].recordUid] = history[i];
    }
    if (history[i]._syncId) {
      localBySyncId[history[i]._syncId] = history[i];
    }
  }

  var addedCount = 0;
  var updatedCount = 0;
  var skippedCount = 0;
  var conflicts = [];
  var cloudRecordUids = new Set();
  var cloudSyncIds = new Set();

  for (var ci = 0; ci < cloudRecords.length; ci++) {
    var cr = cloudRecords[ci];
    var crUid = cr.recordUid || cr._cloudRecordUid;
    if (crUid) cloudRecordUids.add(crUid);
    if (cr._syncId) cloudSyncIds.add(cr._syncId);

    // 先按 recordUid 匹配，再按 _syncId fallback 匹配
    var localRecord = crUid ? localByRecordUid[crUid] : null;
    if (!localRecord && cr._syncId) {
      localRecord = localBySyncId[cr._syncId] || null;
    }

    // readOnly 模式下，无 UID 且无本地匹配的记录跳过
    // 交由迁移功能处理
    if (readOnly && !crUid && !localRecord) {
      skippedCount++;
      continue;
    }

    // 云端墓碑
    if (cr._cloudIsDeleted === true) {
      if (localRecord && !localRecord._isDeleted) {
        localRecord._isDeleted = true;
        localRecord._deletedAt = cr._cloudUpdatedAt || new Date().toISOString();
        localRecord._deletePending = false;
        updatedCount++;
      }
      continue;
    }

    // 新记录
    if (!localRecord) {
      var newRec = Object.assign({}, cr);
      delete newRec._cloudIsDeleted;
      if (crUid) {
        newRec.recordUid = crUid;
      }
      newRec._cloudUpdatedAt = cr._cloudUpdatedAt;
      history.push(newRec);
      if (crUid) localByRecordUid[crUid] = newRec;
      if (newRec._syncId) localBySyncId[newRec._syncId] = newRec;
      addedCount++;
      continue;
    }

    // 本地有对应记录
    if (!localRecord._syncPending) {
      Object.assign(localRecord, cr);
      delete localRecord._cloudIsDeleted;
      if (crUid) localRecord.recordUid = crUid;
      localRecord._cloudUpdatedAt = cr._cloudUpdatedAt;
      updatedCount++;
    } else {
      if (localRecord._cloudUpdatedAt && cr._cloudUpdatedAt &&
          localRecord._cloudUpdatedAt !== cr._cloudUpdatedAt) {
        localRecord._syncConflict = true;
        conflicts.push({ recordUid: crUid, syncId: cr._syncId });
        updatedCount++;
      }
    }
  }

  return {
    history: history,
    addedCount: addedCount,
    updatedCount: updatedCount,
    skippedCount: skippedCount,
    conflicts: conflicts,
    cloudRecordUids: cloudRecordUids,
    cloudSyncIds: cloudSyncIds
  };
}

// 兼容浏览器和 Node.js
if (typeof window !== 'undefined') {
  window.mergeCloudHistory = mergeCloudHistory;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = mergeCloudHistory;
}

// 浏览器端加载独立的 Seedance 2.5 官方适配层。
// 适配逻辑与云端历史合并逻辑分离，便于后续按官方文档独立维护。
if (typeof document !== 'undefined') {
  (function loadSeedance25Adapter() {
    if (document.querySelector('script[data-seedance25-adapter]')) return;
    var script = document.createElement('script');
    script.src = 'seedance25.js?v=1.7.1';
    script.async = false;
    script.setAttribute('data-seedance25-adapter', 'v1.7.1');
    (document.head || document.documentElement).appendChild(script);
  })();
}
