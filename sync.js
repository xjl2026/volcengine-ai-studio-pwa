// sync.js - Supabase 跨设备同步模块
// 使用 AES-GCM 客户端加密，数据在 Supabase 中以密文存储

// ============ 工具函数 ============
// v1.6.3: 统一获取记录的 model ID
// 兼容旧记录的 params.model 和可能的顶层 model
function getRecordModel(record) {
  if (!record) return '';
  return record.model || (record.params && record.params.model) || '';
}

// ============ 加密工具 ============
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveUserId(syncKey) {
  return await sha256Hex(syncKey);
}

async function deriveEncKey(syncKey) {
  const hex = await sha256Hex(syncKey + 'enc-v1');
  const raw = hexToBytes(hex);
  return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptObj(syncKey, obj) {
  const key = await deriveEncKey(syncKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return {
    encrypted_data: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv)
  };
}

async function decryptObj(syncKey, encryptedData, iv) {
  const key = await deriveEncKey(syncKey);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    key,
    base64ToBytes(encryptedData)
  );
  const text = new TextDecoder().decode(decrypted);
  return JSON.parse(text);
}

// ============ Supabase REST 客户端 ============
const SyncManager = {
  _url: null,
  _anonKey: null,
  _syncKey: null,
  _userId: null,
  _dbState: null,       // 缓存的数据库状态：schema_not_ready / migration_required / constraint_not_ready / ready
  _dbStateCheckedAt: 0, // 上次检查时间戳

  isEnabled() {
    return !!(this._url && this._anonKey && this._syncKey);
  },

  // 检查数据库 schema 是否有新字段（只读，无副作用）
  async checkDbSchema() {
    if (!this.isEnabled()) return 'schema_not_ready';
    try {
      // 只读查询：select 只取新字段，limit=0 不返回任何行
      // 如果字段不存在，PostgREST 返回 400
      var res = await fetch(this._url + '/rest/v1/history?user_id=eq.' + encodeURIComponent(this._userId) + '&select=record_uid,updated_at,is_deleted,deleted_at&limit=0', {
        headers: { 'apikey': this._anonKey, 'Authorization': 'Bearer ' + this._anonKey }
      });
      if (res.ok) return 'schema_ok';
      if (res.status === 400) {
        return 'schema_not_ready';
      }
      if (res.status === 401 || res.status === 403) return 'auth_error';
      return 'schema_not_ready';
    } catch (e) {
      return 'network_error';
    }
  },

  // v1.6.2: 无副作用的约束检查
  // 通过只读 RPC get_history_sync_constraints() 获取 NOT NULL 和 UNIQUE 约束状态
  // RPC 不存在时 fallback 到 checkDbSchema 返回的字段状态
  async checkConstraintsViaRpc() {
    if (!this.isEnabled()) return { recordUidNotNull: false, uniqueConstraintReady: false, rpcAvailable: false };
    try {
      var res = await fetch(this._url + '/rest/v1/rpc/get_history_sync_constraints', {
        method: 'POST',
        headers: { 'apikey': this._anonKey, 'Authorization': 'Bearer ' + this._anonKey, 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (res.status === 404) {
        // RPC 函数不存在 → 用户尚未执行阶段A SQL 中的 RPC 部分
        return { recordUidNotNull: false, uniqueConstraintReady: false, rpcAvailable: false };
      }
      if (res.status === 401 || res.status === 403) {
        return { recordUidNotNull: false, uniqueConstraintReady: false, rpcAvailable: false, authError: true };
      }
      if (!res.ok) {
        return { recordUidNotNull: false, uniqueConstraintReady: false, rpcAvailable: false };
      }
      var data = await res.json();
      return {
        recordUidNotNull: !!(data && data.record_uid_not_null),
        uniqueConstraintReady: !!(data && data.unique_constraint_ready),
        rpcAvailable: true
      };
    } catch (e) {
      return { recordUidNotNull: false, uniqueConstraintReady: false, rpcAvailable: false, networkError: true };
    }
  },

  // v1.6.2: 综合检查数据库状态（完全无副作用）
  // 返回: 'schema_not_ready' | 'auth_error' | 'network_error' | 'migration_required' | 'constraint_not_ready' | 'ready'
  async checkDbState() {
    if (!this.isEnabled()) return 'schema_not_ready';

    // 缓存 30 秒内不重复检查
    var now = Date.now();
    if (this._dbState && (now - this._dbStateCheckedAt) < 30000) {
      return this._dbState;
    }

    var result = 'schema_not_ready';

    try {
      // Step 1: 检查字段是否存在（只读查询，limit=0）
      var schemaStatus = await this.checkDbSchema();
      if (schemaStatus === 'schema_not_ready') {
        result = 'schema_not_ready';
        this._dbState = result;
        this._dbStateCheckedAt = now;
        return result;
      }
      if (schemaStatus === 'auth_error') {
        result = 'auth_error';
        this._dbState = result;
        this._dbStateCheckedAt = now;
        return result;
      }
      if (schemaStatus === 'network_error') {
        result = 'network_error';
        this._dbState = result;
        this._dbStateCheckedAt = now;
        return result;
      }
      // schemaStatus === 'schema_ok' → 继续

      // Step 2: 检查是否有 record_uid 为空的记录（只读查询）
      var nullRes = await fetch(this._url + '/rest/v1/history?user_id=eq.' + encodeURIComponent(this._userId) + '&record_uid=is.null&select=id&limit=1', {
        headers: { 'apikey': this._anonKey, 'Authorization': 'Bearer ' + this._anonKey }
      });
      if (nullRes.status === 401 || nullRes.status === 403) {
        result = 'auth_error';
        this._dbState = result;
        this._dbStateCheckedAt = now;
        return result;
      }
      if (nullRes.ok) {
        var nullRows = await nullRes.json();
        if (nullRows && nullRows.length > 0) {
          // 有空 record_uid 的记录 → 迁移未完成
          result = 'migration_required';
          this._dbState = result;
          this._dbStateCheckedAt = now;
          return result;
        }
      }

      // Step 3: 通过只读 RPC 检查 NOT NULL 和 UNIQUE 约束
      var constraints = await this.checkConstraintsViaRpc();
      if (constraints.authError) {
        result = 'auth_error';
        this._dbState = result;
        this._dbStateCheckedAt = now;
        return result;
      }
      if (constraints.networkError) {
        result = 'network_error';
        this._dbState = result;
        this._dbStateCheckedAt = now;
        return result;
      }

      if (!constraints.rpcAvailable) {
        // RPC 不存在 → 用户未执行含 RPC 的阶段A SQL
        // 字段存在但无法确认约束 → 保守标记
        result = 'constraint_not_ready';
        this._dbState = result;
        this._dbStateCheckedAt = now;
        return result;
      }

      // RPC 可用，检查约束状态
      if (!constraints.recordUidNotNull || !constraints.uniqueConstraintReady) {
        // NOT NULL 或 UNIQUE 约束未全部建立
        result = 'constraint_not_ready';
        this._dbState = result;
        this._dbStateCheckedAt = now;
        return result;
      }

      // 所有条件满足
      result = 'ready';
      this._dbState = result;
      this._dbStateCheckedAt = now;
      return result;

    } catch (e) {
      // 网络异常
      result = 'network_error';
      this._dbState = result;
      this._dbStateCheckedAt = now;
      return result;
    }
  },

  // 清除数据库状态缓存（迁移后需要重新检查）
  clearDbStateCache() {
    this._dbState = null;
    this._dbStateCheckedAt = 0;
  },

  async configure(url, anonKey, syncKey) {
    this._url = url ? url.replace(/\/$/, '') : null;
    this._anonKey = anonKey || null;
    this._syncKey = syncKey || null;
    this._userId = syncKey ? await deriveUserId(syncKey) : null;
  },

  async _request(path, options) {
    options = options || {};
    if (!this.isEnabled()) throw new Error('同步未启用');
    const headers = {
      'apikey': this._anonKey,
      'Authorization': 'Bearer ' + this._anonKey,
      'Content-Type': 'application/json'
    };
    if (options.method === 'POST' || options.method === 'PATCH') {
      headers['Prefer'] = options.upsert ? 'resolution=merge-duplicates,return=representation' : 'return=representation';
    }
    const res = await fetch(this._url + '/rest/v1' + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error('Supabase ' + res.status + ': ' + text);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },

  // 阶段B：基于 on_conflict 的 Upsert（需要 UNIQUE 约束）
  // 在约束未建立前调用此方法会被阻止
  async upsertHistory(record) {
    if (!this.isEnabled()) return null;

    // 检查数据库状态
    var dbState = await this.checkDbState();
    if (dbState !== 'ready') {
      // 数据库未准备好，不执行 on_conflict Upsert
      throw new Error('DB_NOT_READY:' + dbState);
    }

    var enc = await encryptObj(this._syncKey, record);
    var body = {
      user_id: this._userId,
      encrypted_data: enc.encrypted_data,
      iv: enc.iv
    };
    if (record.recordUid) body.record_uid = record.recordUid;
    // 不传 is_deleted，依赖数据库默认值 false
    var rows = await this._request('/history?on_conflict=user_id,record_uid', {
      method: 'POST',
      upsert: true,
      body: body
    });
    if (rows && rows[0]) {
      return { syncId: rows[0].id, cloudUpdatedAt: rows[0].updated_at };
    }
    return null;
  },

  // 基于 syncId 的 PATCH 更新
  async updateHistory(syncId, record) {
    if (!this.isEnabled() || !syncId) return null;
    var enc = await encryptObj(this._syncKey, record);
    var rows = await this._request('/history?id=eq.' + encodeURIComponent(syncId), {
      method: 'PATCH',
      body: {
        encrypted_data: enc.encrypted_data,
        iv: enc.iv
      }
    });
    if (rows && rows[0]) {
      return { syncId: rows[0].id, cloudUpdatedAt: rows[0].updated_at };
    }
    return { syncId: syncId, cloudUpdatedAt: null };
  },

  // 阶段B：基于 recordUid 的软删除（PATCH is_deleted=true）
  // v1.6.3: 检查返回行数，更新 0 行时抛出 DELETE_TARGET_NOT_FOUND
  async deleteHistory(recordUid) {
    if (!this.isEnabled() || !recordUid) return;
    // schema 未准备好时不执行软删除（is_deleted 字段不存在）
    var dbState = await this.checkDbState();
    if (dbState === 'schema_not_ready' || dbState === 'network_error' || dbState === 'auth_error') {
      throw new Error('DB_NOT_READY:' + dbState);
    }
    var rows = await this._request('/history?user_id=eq.' + encodeURIComponent(this._userId) + '&record_uid=eq.' + encodeURIComponent(recordUid), {
      method: 'PATCH',
      body: { is_deleted: true }
    });
    // v1.6.3: 检查返回结果，更新 0 行时抛出错误
    if (!rows || rows.length === 0) {
      throw new Error('DELETE_TARGET_NOT_FOUND:record_uid=' + recordUid);
    }
  },

  // 恢复记录（PATCH is_deleted=false）
  async restoreHistory(recordUid) {
    if (!this.isEnabled() || !recordUid) return;
    await this._request('/history?user_id=eq.' + encodeURIComponent(this._userId) + '&record_uid=eq.' + encodeURIComponent(recordUid), {
      method: 'PATCH',
      body: { is_deleted: false }
    });
  },

  // 分页拉取全部云端行（含 record_uid, updated_at, is_deleted 等元数据）
  async pullAllHistoryRows() {
    if (!this.isEnabled()) return [];
    var allRows = [];
    var pageSize = 200;
    var offset = 0;
    var hasMore = true;
    while (hasMore) {
      var path = '/history?user_id=eq.' + encodeURIComponent(this._userId)
        + '&order=created_at.desc'
        + '&limit=' + pageSize
        + '&offset=' + offset;
      var rows = await this._request(path);
      if (!rows || rows.length === 0) {
        hasMore = false;
      } else {
        allRows = allRows.concat(rows);
        if (rows.length < pageSize) {
          hasMore = false;
        } else {
          offset += pageSize;
        }
      }
    }
    return allRows;
  },

  // 拉取所有历史记录（解密后，附带云端元数据）
  async pullHistory() {
    if (!this.isEnabled()) return [];
    var rows = await this.pullAllHistoryRows();
    var records = [];
    for (var i = 0; i < rows.length; i++) {
      try {
        var record = await decryptObj(this._syncKey, rows[i].encrypted_data, rows[i].iv);
        record._syncId = rows[i].id;
        // v1.6.5: 云端 record_uid 同时写入标准 recordUid 字段，避免重复拉取
        if (rows[i].record_uid) {
          record.recordUid = rows[i].record_uid;
          record._cloudRecordUid = rows[i].record_uid;
        }
        if (rows[i].updated_at) record._cloudUpdatedAt = rows[i].updated_at;
        if (rows[i].is_deleted !== undefined) record._cloudIsDeleted = rows[i].is_deleted;
        records.push(record);
      } catch (e) {
        console.warn('解密失败，跳过: ', e);
      }
    }
    return records;
  },

  // PATCH 云端记录补写 record_uid
  // 必须确认 PostgREST 实际返回被更新的行，避免 200 + [] 被误判为成功
  async patchRecordUid(cloudId, recordUid) {
    if (!this.isEnabled()) throw new Error('同步未启用');
    if (!cloudId || !recordUid) throw new Error('PATCH_RECORD_UID_INVALID_ARGUMENT');
    var rows = await this._request(
      '/history?user_id=eq.' + encodeURIComponent(this._userId) +
      '&id=eq.' + encodeURIComponent(cloudId),
      {
        method: 'PATCH',
        body: { record_uid: recordUid }
      }
    );
    if (!rows || rows.length !== 1 || rows[0].record_uid !== recordUid) {
      throw new Error('PATCH_RECORD_UID_TARGET_NOT_FOUND:' + cloudId);
    }
    return true;
  },

  // DELETE 云端重复记录
  async deleteCloudRecord(cloudId) {
    if (!this.isEnabled() || !cloudId) return false;
    await this._request('/history?id=eq.' + encodeURIComponent(cloudId), { method: 'DELETE' });
    return true;
  },

  // v1.6.2: 查询当前用户云端实际 record_uid 为空的数量（只读）
  async countNullRecordUid() {
    if (!this.isEnabled()) return -1;
    try {
      var res = await fetch(this._url + '/rest/v1/history?user_id=eq.' + encodeURIComponent(this._userId) + '&record_uid=is.null&select=id&limit=1000', {
        headers: { 'apikey': this._anonKey, 'Authorization': 'Bearer ' + this._anonKey }
      });
      if (!res.ok) return -1;
      var rows = await res.json();
      return rows ? rows.length : 0;
    } catch (e) {
      return -1;
    }
  },

  // 数据迁移（预览 / 执行）
  // v1.6.2: 拆分预测/成功/失败计数；执行后重新查询实际空值
  // options.preview = true 时只返回报告不修改数据
  async migrateHistoryData(options) {
    if (!this.isEnabled()) return { error: '同步未启用' };
    var preview = options && options.preview;

    var report = {
      localTotal: 0,
      localMissingRecordUid: 0,
      localMissingUpdatedAt: 0,
      cloudTotal: 0,
      cloudMissingRecordUid: 0,
      cloudDuplicates: 0,
      cloudToDelete: 0,
      cloudOldDuplicates: 0,
      cloudOldDupToDelete: 0,
      uncertainMatches: 0,
      pendingUpload: 0,
      nullRecordUidAfter: 0,       // 迁移后预计仍为空的 record_uid 数量
      actualNullRecordUid: -1,    // v1.6.2: 执行后实际查询的空值数量（-1=未查询/预览模式）
      dbState: null,
      preview: preview,
      steps: [],
      errors: [],
      // v1.6.2: 拆分统计
      existingUidMatched: 0,       // 原本已有 record_uid 的匹配
      predictedNullUidPatch: 0,   // 预计需要 PATCH record_uid 的数量
      successfulNullUidPatch: 0,   // PATCH record_uid 成功
      failedNullUidPatch: 0,       // PATCH record_uid 失败
      predictedDuplicateDelete: 0, // 预计需要删除的重复数量
      successfulDuplicateDelete: 0,// 删除重复成功
      failedDuplicateDelete: 0,    // 删除重复失败
      uncertainDetails: [],        // v1.6.2: 冲突记录详情（模型、提示词摘要、时间、候选数）
      // v1.6.4: 独立补 UID 统计
      predictedIndependentUidPatch: 0,  // 预计需要独立补 UID 的数量
      successfulIndependentUidPatch: 0, // 独立补 UID 成功
      failedIndependentUidPatch: 0,     // 独立补 UID 失败
      unmatchedCloudPreserved: 0,        // 无法匹配但保留的云端记录数
      conflictCloudPreserved: 0          // 多候选冲突保留的云端记录数
    };

    try {
      // Step 0: 检查数据库状态
      var dbState = await this.checkDbState();
      report.dbState = dbState;
      if (dbState === 'schema_not_ready') {
        report.steps.push('数据库缺少阶段A字段，请先执行阶段A SQL');
        report.success = false;
        report.errors.push('Supabase 数据库尚未完成阶段A升级，请先执行阶段A SQL');
        return report;
      }
      report.steps.push('数据库状态: ' + dbState);

      // Step 1: 拉取本地记录
      var localHistory = await Store.getHistory();
      report.localTotal = localHistory.length;
      report.steps.push('拉取本地记录 ' + localHistory.length + ' 条');

      // Step 2: 补本地 recordUid 和 updatedAt
      var needSave = false;
      for (var i = 0; i < localHistory.length; i++) {
        var rec = localHistory[i];
        if (!rec.recordUid) {
          if (!crypto.randomUUID) {
            report.errors.push('浏览器不支持 crypto.randomUUID()，无法生成合法 UUID');
            report.success = false;
            return report;
          }
          rec.recordUid = crypto.randomUUID();
          report.localMissingRecordUid++;
          needSave = true;
        }
        if (!rec.updatedAt) {
          rec.updatedAt = rec.createdAt || new Date().toISOString();
          report.localMissingUpdatedAt++;
          needSave = true;
        }
      }
      if (needSave && !preview) {
        await Store.saveHistory(localHistory);
        report.steps.push('本地补全 recordUid ' + report.localMissingRecordUid + ' 条，updatedAt ' + report.localMissingUpdatedAt + ' 条');
      } else if (needSave) {
        report.steps.push('预览：需补全本地 recordUid ' + report.localMissingRecordUid + ' 条，updatedAt ' + report.localMissingUpdatedAt + ' 条');
      }

      // Step 3: 拉取全部云端行
      var cloudRows = await this.pullAllHistoryRows();
      report.cloudTotal = cloudRows.length;
      report.steps.push('拉取云端记录 ' + cloudRows.length + ' 条');

      // Step 4: 分组云端记录
      var cloudByRecordUid = {};
      var cloudWithoutRecordUid = [];
      for (var i = 0; i < cloudRows.length; i++) {
        var row = cloudRows[i];
        if (row.record_uid) {
          if (!cloudByRecordUid[row.record_uid]) {
            cloudByRecordUid[row.record_uid] = [];
          }
          cloudByRecordUid[row.record_uid].push(row);
        } else {
          cloudWithoutRecordUid.push(row);
          report.cloudMissingRecordUid++;
        }
      }

      // Step 4a: 检测已有 record_uid 的云端重复
      var duplicatesToDelete = [];
      for (var uid in cloudByRecordUid) {
        var group = cloudByRecordUid[uid];
        if (group.length > 1) {
          report.cloudDuplicates++;
          group.sort(function(a, b) {
            return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
          });
          for (var j = 1; j < group.length; j++) {
            duplicatesToDelete.push(group[j]);
            report.cloudToDelete++;
            report.predictedDuplicateDelete++;
          }
        }
      }
      if (report.cloudDuplicates > 0) {
        report.steps.push('检测到已有 record_uid 的重复 ' + report.cloudDuplicates + ' 组，需删除 ' + report.cloudToDelete + ' 条');
      }

      // Step 4b: 检测旧版重复（record_uid 为空，按 taskId 分组去重）
      var oldDupToDelete = [];
      var cloudByTaskId = {};
      var cloudNoTaskId = [];

      for (var ci = 0; ci < cloudWithoutRecordUid.length; ci++) {
        var crow = cloudWithoutRecordUid[ci];
        try {
          var cRec = await decryptObj(this._syncKey, crow.encrypted_data, crow.iv);
          crow._decrypted = cRec;
        } catch (e) {
          report.errors.push('解密云端记录失败: ' + e.message);
          continue;
        }
        if (cRec.taskId) {
          if (!cloudByTaskId[cRec.taskId]) cloudByTaskId[cRec.taskId] = [];
          cloudByTaskId[cRec.taskId].push(crow);
        } else {
          cloudNoTaskId.push(crow);
        }
      }

      for (var tid in cloudByTaskId) {
        var tidGroup = cloudByTaskId[tid];
        if (tidGroup.length > 1) {
          report.cloudOldDuplicates++;
          tidGroup.sort(function(a, b) {
            return new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0);
          });
          for (var j = 1; j < tidGroup.length; j++) {
            oldDupToDelete.push(tidGroup[j]);
            report.cloudOldDupToDelete++;
            report.predictedDuplicateDelete++;
          }
        }
      }
      if (report.cloudOldDuplicates > 0) {
        report.steps.push('检测到旧版 taskId 重复 ' + report.cloudOldDuplicates + ' 组，需删除 ' + report.cloudOldDupToDelete + ' 条');
      }

      // Step 4c: v1.6.2 收紧无 taskId 图片记录匹配
      // v1.6.4: 冲突检测也使用 getRecordModel
      var contentGroups = {};
      for (var ni = 0; ni < cloudNoTaskId.length; ni++) {
        var nrow = cloudNoTaskId[ni];
        var nRec = nrow._decrypted;
        if (!nRec) continue;
        var nModel = getRecordModel(nRec);
        var key = (nRec.type || '') + '|' + nModel + '|' + (nRec.prompt || '') + '|' + JSON.stringify(nRec.result || []);
        if (!contentGroups[key]) contentGroups[key] = [];
        contentGroups[key].push(nrow);
      }
      // v1.6.4: 追踪多候选冲突的云端记录 ID
      var conflictCloudIds = new Set();
      for (var ck in contentGroups) {
        if (contentGroups[ck].length > 1) {
          report.uncertainMatches += contentGroups[ck].length;
          for (var di = 0; di < contentGroups[ck].length; di++) {
            conflictCloudIds.add(contentGroups[ck][di].id);
            var dRec = contentGroups[ck][di]._decrypted;
            report.uncertainDetails.push({
              model: getRecordModel(dRec),
              prompt: (dRec && dRec.prompt) ? dRec.prompt.substring(0, 80) : '',
              createdAt: (dRec && dRec.createdAt) || '',
              candidates: contentGroups[ck].length
            });
          }
        }
      }
      if (report.uncertainMatches > 0) {
        report.steps.push('检测到 ' + report.uncertainMatches + ' 条多候选内容冲突（不自动匹配、不自动删除）');
      }

      // Step 5: 匹配本地与云端
      var localMatched = new Set();
      var cloudMatched = new Set();
      // 可靠匹配 PATCH 失败的云端行，本轮不得降级为“独立补 UID”。
      // 否则会切断其与本地记录的确定关联，并在后续同步时制造重复。
      var failedMatchedCloudIds = new Set();

      // 5a. 按 recordUid 匹配（原本已有 record_uid）
      for (var i = 0; i < localHistory.length; i++) {
        var rec = localHistory[i];
        if (!rec.recordUid) continue;
        if (cloudByRecordUid[rec.recordUid]) {
          var cloudRow = cloudByRecordUid[rec.recordUid][0];
          if (!preview) {
            if (rec._syncId !== cloudRow.id) {
              rec._syncId = cloudRow.id;
            }
          }
          localMatched.add(i);
          cloudMatched.add(cloudRow.id);
          report.existingUidMatched++;
        }
      }

      // 5b. 无 recordUid 的云端行，按 taskId 匹配
      var oldDupIds = new Set(oldDupToDelete.map(function(r) { return r.id; }));
      for (var ci = 0; ci < cloudWithoutRecordUid.length; ci++) {
        var crow = cloudWithoutRecordUid[ci];
        if (cloudMatched.has(crow.id)) continue;
        if (oldDupIds.has(crow.id)) continue;
        var cRec = crow._decrypted;
        if (!cRec) {
          try { cRec = await decryptObj(this._syncKey, crow.encrypted_data, crow.iv); } catch (e) { continue; }
        }
        if (cRec.taskId) {
          for (var i = 0; i < localHistory.length; i++) {
            if (localMatched.has(i)) continue;
            if (localHistory[i].taskId === cRec.taskId) {
              report.predictedNullUidPatch++;
              if (!preview) {
                try {
                  await this.patchRecordUid(crow.id, localHistory[i].recordUid);
                  localHistory[i]._syncId = crow.id;
                  report.successfulNullUidPatch++;
                } catch (e) {
                  report.failedNullUidPatch++;
                  failedMatchedCloudIds.add(crow.id);
                  report.errors.push('PATCH record_uid 失败 (cloudId=' + crow.id + '): ' + e.message);
                  // PATCH 失败：不标记匹配、不写 _syncId，也不在本轮降级为独立补 UID
                  continue;
                }
              } else {
                report.successfulNullUidPatch++;
              }
              localMatched.add(i);
              cloudMatched.add(crow.id);
              break;
            }
          }
        }
      }

      // 5c. v1.6.2 收紧无 taskId 图片记录匹配
      // 保守策略：type均为image + model完全一致 + prompt完全一致 + result URL数组完全一致
      // + createdAt时间差60秒内 + 候选恰好1条
      for (var ci = 0; ci < cloudWithoutRecordUid.length; ci++) {
        var crow = cloudWithoutRecordUid[ci];
        if (cloudMatched.has(crow.id)) continue;
        if (oldDupIds.has(crow.id)) continue;
        var cRec = crow._decrypted;
        if (!cRec) {
          try { cRec = await decryptObj(this._syncKey, crow.encrypted_data, crow.iv); } catch (e) { continue; }
        }
        // 只处理图片记录
        if (!cRec || cRec.type !== 'image') continue;
        var cloudModel = getRecordModel(cRec);
        if (!cRec.prompt || !cRec.result || !cloudModel) continue;

        // 查找候选匹配
        var candidates = [];
        for (var i = 0; i < localHistory.length; i++) {
          if (localMatched.has(i)) continue;
          var lRec = localHistory[i];
          if (lRec.type !== 'image') continue;
          var localModel = getRecordModel(lRec);
          if (!lRec.prompt || !lRec.result || !localModel) continue;
          // model 完全一致
          if (cloudModel !== localModel) continue;
          // prompt 完全一致
          if (cRec.prompt !== lRec.prompt) continue;
          // result URL 数组完全一致
          if (JSON.stringify(cRec.result) !== JSON.stringify(lRec.result)) continue;
          // createdAt 时间差 60 秒内
          var cTime = cRec.createdAt ? new Date(cRec.createdAt).getTime() : 0;
          var lTime = lRec.createdAt ? new Date(lRec.createdAt).getTime() : 0;
          if (!cTime || !lTime) continue; // 缺少时间字段不匹配
          if (Math.abs(cTime - lTime) > 60000) continue;
          candidates.push(i);
        }

        if (candidates.length === 1) {
          // 恰好 1 条候选：允许匹配
          var matchIdx = candidates[0];
          report.predictedNullUidPatch++;
          if (!preview) {
            try {
              await this.patchRecordUid(crow.id, localHistory[matchIdx].recordUid);
              localHistory[matchIdx]._syncId = crow.id;
              report.successfulNullUidPatch++;
            } catch (e) {
              report.failedNullUidPatch++;
              failedMatchedCloudIds.add(crow.id);
              report.errors.push('PATCH record_uid 失败 (image match): ' + e.message);
              continue;
            }
          } else {
            report.successfulNullUidPatch++;
          }
          localMatched.add(matchIdx);
          cloudMatched.add(crow.id);
        } else if (candidates.length > 1) {
          // 多于 1 条候选：列入 uncertainMatches，不自动 PATCH
          report.uncertainMatches++;
          conflictCloudIds.add(crow.id);
          report.uncertainDetails.push({
            model: cloudModel,
            prompt: cRec.prompt.substring(0, 80),
            createdAt: cRec.createdAt || '',
            candidates: candidates.length
          });
        }
        // candidates.length === 0：保持未匹配
      }

      report.steps.push('已有 record_uid 匹配: ' + report.existingUidMatched + ' 条');
      report.steps.push('预计 PATCH record_uid: ' + report.predictedNullUidPatch + ' 条（成功 ' + report.successfulNullUidPatch + '，失败 ' + report.failedNullUidPatch + '）');

      // v1.6.4 Step 5d: 独立补 UID
      // 处理所有仍 record_uid IS NULL 且未匹配本地且不属于待删除重复的云端记录
      // 包括多候选冲突记录 — 每条生成独立 UUID 保留
      for (var ci = 0; ci < cloudWithoutRecordUid.length; ci++) {
        var crow = cloudWithoutRecordUid[ci];
        if (cloudMatched.has(crow.id)) continue;      // 已匹配本地
        if (failedMatchedCloudIds.has(crow.id)) continue; // 可靠匹配写入失败，留待重试，禁止改发独立 UID
        if (oldDupIds.has(crow.id)) continue;           // 属于待删除旧重复
        if (duplicatesToDelete.some(function(r) { return r.id === crow.id; })) continue; // 属于待删除重复

        // v1.6.4: crypto.randomUUID 不可用时停止迁移
        if (!crypto.randomUUID) {
          report.errors.push('浏览器不支持 crypto.randomUUID()，无法生成独立 UUID，迁移中止');
          report.success = false;
          return report;
        }

        report.predictedIndependentUidPatch++;

        // 多候选冲突记录也独立补 UID，但单独统计
        if (conflictCloudIds.has(crow.id)) {
          report.conflictCloudPreserved++;
        } else {
          report.unmatchedCloudPreserved++;
        }

        if (!preview) {
          var newUid = crypto.randomUUID();
          try {
            await this.patchRecordUid(crow.id, newUid);
            report.successfulIndependentUidPatch++;
            cloudMatched.add(crow.id);
          } catch (e) {
            report.failedIndependentUidPatch++;
            report.errors.push('独立补 UID 失败 (cloudId=' + crow.id + '): ' + e.message);
          }
        } else {
          report.successfulIndependentUidPatch++;
        }
      }
      report.steps.push('独立补 UID: 预计 ' + report.predictedIndependentUidPatch + ' 条（成功 ' + report.successfulIndependentUidPatch + '，失败 ' + report.failedIndependentUidPatch + '）');
      if (report.conflictCloudPreserved > 0) {
        report.steps.push('多候选冲突独立保留: ' + report.conflictCloudPreserved + ' 条');
      }

      // Step 6: 删除云端重复记录
      if (!preview) {
        var allToDelete = duplicatesToDelete.concat(oldDupToDelete);
        for (var j = 0; j < allToDelete.length; j++) {
          try {
            await this.deleteCloudRecord(allToDelete[j].id);
            report.successfulDuplicateDelete++;
          } catch (e) {
            report.failedDuplicateDelete++;
            report.errors.push('删除重复记录失败 (cloudId=' + allToDelete[j].id + '): ' + e.message);
          }
        }
        if (report.successfulDuplicateDelete > 0) {
          report.steps.push('删除云端重复记录: 成功 ' + report.successfulDuplicateDelete + ' 条，失败 ' + report.failedDuplicateDelete + ' 条');
        }
      } else {
        report.steps.push('预计删除重复: ' + report.predictedDuplicateDelete + ' 条');
      }

      // Step 7: 统计待上传的本地未匹配记录
      var pendingUpload = 0;
      for (var i = 0; i < localHistory.length; i++) {
        if (!localMatched.has(i) && !localHistory[i]._syncId && !localHistory[i]._isDeleted) {
          pendingUpload++;
          if (!preview) {
            localHistory[i]._syncPending = true;
          }
        }
      }
      report.pendingUpload = pendingUpload;
      if (pendingUpload > 0) {
        report.steps.push(preview ? '预览：待阶段B约束完成后上传 ' + pendingUpload + ' 条' : '标记 ' + pendingUpload + ' 条为待同步（阶段B约束完成后自动上传）');
      }

      // 保存本地修改
      if (!preview) {
        await Store.saveHistory(localHistory);
      }

      // v1.6.4: 迁移后预计空值数量
      // = 空值总数 - 成功匹配补写 - 成功独立补UID - 成功删除重复
      // 预览模式: 使用 predictedDuplicateDelete（未实际删除但预计会删除）
      var effectiveDuplicateDelete = preview ? report.predictedDuplicateDelete : report.successfulDuplicateDelete;
      var predictedNullAfter = report.cloudMissingRecordUid
        - report.successfulNullUidPatch
        - report.successfulIndependentUidPatch
        - effectiveDuplicateDelete;
      if (predictedNullAfter < 0) predictedNullAfter = 0;
      report.nullRecordUidAfter = predictedNullAfter;
      report.steps.push('迁移后预计 record_uid 为空: ' + predictedNullAfter + ' 条');

      // v1.6.2: 执行模式下，重新查询云端实际空值数量
      if (!preview) {
        var actualNull = await this.countNullRecordUid();
        report.actualNullRecordUid = actualNull;
        if (actualNull >= 0) {
          report.steps.push('执行后实际查询 record_uid 为空: ' + actualNull + ' 条');
        } else {
          report.steps.push('执行后查询实际空值失败（网络错误），请手动检查');
        }
      }

      var hasOperationFailures = report.failedNullUidPatch > 0
        || report.failedIndependentUidPatch > 0
        || report.failedDuplicateDelete > 0;
      var actualCheckFailed = !preview && report.actualNullRecordUid < 0;
      var actualHasNull = !preview && report.actualNullRecordUid > 0;

      report.success = !hasOperationFailures && !actualCheckFailed && !actualHasNull;
      if (report.success) {
        report.steps.push(preview ? '预览完成（未修改数据）' : '迁移执行完成');
      } else {
        report.steps.push('迁移未完成：存在失败操作、实际空值或无法确认实际空值');
      }
    } catch (e) {
      report.success = false;
      report.errors.push('迁移异常: ' + e.message);
    }
    return report;
  },

  // 阶段B：批量软删除（PATCH is_deleted=true）
  async clearAllHistory() {
    if (!this.isEnabled()) return;
    var dbState = await this.checkDbState();
    if (dbState === 'schema_not_ready' || dbState === 'network_error') {
      throw new Error('DB_NOT_READY:' + dbState);
    }
    await this._request('/history?user_id=eq.' + encodeURIComponent(this._userId), {
      method: 'PATCH',
      body: { is_deleted: true }
    });
  },

  // 重试待同步记录（含墓碑删除重试）
  async retryPendingSync() {
    if (!this.isEnabled()) return;

    // 检查数据库状态，未准备好时不重试
    var dbState = await this.checkDbState();
    if (dbState !== 'ready') {
      console.warn('数据库未准备好 (' + dbState + ')，跳过同步重试');
      return;
    }

    var history = await Store.getHistory();
    var needSave = false;

    for (var i = 0; i < history.length; i++) {
      var record = history[i];

      // 已删除记录：重试墓碑同步
      if (record._isDeleted) {
        if (record._deletePending && record.recordUid) {
          try {
            await this.deleteHistory(record.recordUid);
            // v1.6.3: 只有 deleteHistory 不抛异常（返回至少1行）才清除 _deletePending
            record._deletePending = false;
            needSave = true;
          } catch (e) {
            // v1.6.3: DELETE_TARGET_NOT_FOUND 或网络错误都保留 _deletePending
            console.warn('墓碑删除重试失败:', e.message);
          }
        }
        continue;
      }

      // 普通待同步记录
      if (!record._syncPending) continue;

      try {
        var result;
        if (record._syncId) {
          result = await this.updateHistory(record._syncId, record);
        } else {
          result = await this.upsertHistory(record);
        }
        if (result && result.syncId) {
          record._syncId = result.syncId;
          record._cloudUpdatedAt = result.cloudUpdatedAt;
          record._syncPending = false;
          record._syncConflict = false;
          needSave = true;
        }
      } catch (e) {
        console.warn('同步重试失败:', e);
      }
    }

    if (needSave) await Store.saveHistory(history);
  },

  // 推送设置
  async pushSettings(settings) {
    if (!this.isEnabled()) return;
    var enc = await encryptObj(this._syncKey, settings);
    await this._request('/settings', {
      method: 'POST',
      upsert: true,
      body: { user_id: this._userId, encrypted_data: enc.encrypted_data, iv: enc.iv, updated_at: new Date().toISOString() }
    });
  },

  // 拉取设置
  async pullSettings() {
    if (!this.isEnabled()) return null;
    var rows = await this._request('/settings?user_id=eq.' + encodeURIComponent(this._userId));
    if (!rows || rows.length === 0) return null;
    try {
      return await decryptObj(this._syncKey, rows[0].encrypted_data, rows[0].iv);
    } catch (e) {
      console.warn('设置解密失败: ', e);
      return null;
    }
  },

  // 测试连接
  async testConnection() {
    if (!this._url || !this._anonKey) return { success: false, message: '请填写 Supabase URL 和 Anon Key' };
    try {
      var res = await fetch(this._url + '/rest/v1/', {
        headers: { 'apikey': this._anonKey, 'Authorization': 'Bearer ' + this._anonKey }
      });
      if (res.ok) return { success: true, message: '连接成功' };
      return { success: false, message: 'HTTP ' + res.status };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }
};

window.SyncManager = SyncManager;
