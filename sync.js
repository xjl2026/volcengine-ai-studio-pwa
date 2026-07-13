// sync.js - Supabase 跨设备同步模块
// 使用 AES-GCM 客户端加密，数据在 Supabase 中以密文存储

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

  // 检查数据库 schema 是否有新字段
  // 通过查询一条记录看返回字段来判断（不依赖 information_schema）
  async checkDbSchema() {
    if (!this.isEnabled()) return 'schema_not_ready';
    try {
      // 尝试查询一条记录，select 只取新字段
      // 如果字段不存在，PostgREST 会返回 400 错误
      var res = await fetch(this._url + '/rest/v1/history?user_id=eq.' + encodeURIComponent(this._userId) + '&select=record_uid,updated_at,is_deleted,deleted_at&limit=1', {
        headers: { 'apikey': this._anonKey, 'Authorization': 'Bearer ' + this._anonKey }
      });
      if (res.ok) return 'schema_ok';
      if (res.status === 400) {
        // 字段不存在
        var body = await res.text();
        if (body.includes('record_uid') || body.includes('column') || body.includes('Could not find')) {
          return 'schema_not_ready';
        }
        return 'schema_not_ready';
      }
      if (res.status === 401) return 'auth_error';
      return 'schema_not_ready';
    } catch (e) {
      return 'network_error';
    }
  },

  // 检查唯一约束是否存在
  // 通过尝试一个不产生副作用的 upsert（insert only，如果约束不存在会创建重复行而不是报错）
  // 更安全的方式：检查 information_schema（需要更高权限）
  // 实际方案：在 checkDbState 中综合判断
  async checkUniqueConstraint() {
    if (!this.isEnabled()) return false;
    try {
      // 查询 information_schema.table_constraints
      var res = await fetch(this._url + '/rest/v1/information_schema?select=table_constraints!inner&limit=0', {
        headers: { 'apikey': this._anonKey, 'Authorization': 'Bearer ' + this._anonKey }
      });
      // information_schema 可能无法通过 REST API 访问
      // 更好的方案：尝试一个带 on_conflict 的 HEAD 请求
      // 实际上 PostgREST 在约束不存在时使用 on_conflict 会返回 400
      // 用一个测试请求：HEAD 请求带 on_conflict 参数
      var testRes = await fetch(this._url + '/rest/v1/history?on_conflict=user_id,record_uid&limit=0', {
        headers: { 'apikey': this._anonKey, 'Authorization': 'Bearer ' + this._anonKey, 'Prefer': 'count=exact' },
        method: 'HEAD'
      });
      // PostgREST 对 HEAD+on_conflict 的处理：
      // 如果约束不存在，HEAD 请求不会报错（因为不实际 upsert）
      // 所以我们换一个方案：实际 upsert 一条测试记录
      // 但这有副作用...
      // 最终方案：用 _dbStateConfigured 标记，由用户在迁移完成后手动确认
      return null; // 返回 null 表示无法自动检测
    } catch (e) {
      return null;
    }
  },

  // 综合检查数据库状态
  // 返回: 'schema_not_ready' | 'migration_required' | 'constraint_not_ready' | 'ready' | 'network_error'
  async checkDbState() {
    if (!this.isEnabled()) return 'schema_not_ready';

    // 缓存 30 秒内不重复检查
    var now = Date.now();
    if (this._dbState && (now - this._dbStateCheckedAt) < 30000) {
      return this._dbState;
    }

    // Step 1: 检查字段是否存在
    var schemaStatus = await this.checkDbSchema();
    if (schemaStatus === 'schema_not_ready' || schemaStatus === 'network_error') {
      this._dbState = schemaStatus;
      this._dbStateCheckedAt = now;
      return this._dbState;
    }

    // Step 2: 检查是否有 record_uid 为空的记录（迁移未完成）
    try {
      var res = await fetch(this._url + '/rest/v1/history?user_id=eq.' + encodeURIComponent(this._userId) + '&record_uid=is.null&select=id&limit=1', {
        headers: { 'apikey': this._anonKey, 'Authorization': 'Bearer ' + this._anonKey }
      });
      if (res.ok) {
        var rows = await res.json();
        if (rows && rows.length > 0) {
          // 有空 record_uid 的记录 → 迁移未完成
          this._dbState = 'migration_required';
          this._dbStateCheckedAt = now;
          return this._dbState;
        }
      }
    } catch (e) {
      // 查询失败，保守处理
    }

    // Step 3: 检查唯一约束是否存在
    // 用一个安全的测试：发一个带 on_conflict 的 POST 请求到一个不存在的 record_uid
    // 如果约束不存在，PostgREST 会忽略 on_conflict 并创建一条新记录
    // 如果约束存在，PostgREST 会执行 upsert（更新而非插入）
    // 但这有副作用，所以用一个只读的替代方案：
    // 尝试带 on_conflict 的 HEAD 请求，看 PostgREST 是否返回错误
    try {
      // 实际上 PostgREST 在 on_conflict 引用不存在的约束时，对 GET/HEAD 请求不会报错
      // 只有在实际 POST 时才会报错
      // 所以我们只能标记为 constraint_not_ready，让用户手动确认
      // 但如果用户已经执行了阶段B SQL，我们可以通过检查 NOT NULL 约束间接判断
      // 检查 record_uid 是否 NOT NULL：尝试插入一条 record_uid=null 的记录
      // 如果 NOT NULL 约束存在，会报错
      var testRes = await fetch(this._url + '/rest/v1/history', {
        method: 'POST',
        headers: {
          'apikey': this._anonKey,
          'Authorization': 'Bearer ' + this._anonKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          user_id: '__constraint_test__',
          encrypted_data: 'test',
          iv: 'test',
          record_uid: null
        })
      });
      if (testRes.status === 201 || testRes.ok) {
        // 插入成功 → record_uid 可以为 null → NOT NULL 约束不存在 → 阶段B未完成
        // 清理测试数据
        try {
          await fetch(this._url + '/rest/v1/history?user_id=eq.__constraint_test__', {
            method: 'DELETE',
            headers: { 'apikey': this._anonKey, 'Authorization': 'Bearer ' + this._anonKey }
          });
        } catch (e) {}
        this._dbState = 'constraint_not_ready';
        this._dbStateCheckedAt = now;
        return this._dbState;
      } else {
        // 插入失败（可能是 NOT NULL 约束导致 400/23502）
        var errBody = await testRes.text();
        if (errBody.includes('not-null') || errBody.includes('23502') || errBody.includes('record_uid')) {
          // NOT NULL 约束存在 → 唯一约束可能也已建立
          this._dbState = 'ready';
          this._dbStateCheckedAt = now;
          return this._dbState;
        }
        // 其他错误，保守标记
        this._dbState = 'constraint_not_ready';
        this._dbStateCheckedAt = now;
        return this._dbState;
      }
    } catch (e) {
      this._dbState = 'constraint_not_ready';
      this._dbStateCheckedAt = now;
      return this._dbState;
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
  async deleteHistory(recordUid) {
    if (!this.isEnabled() || !recordUid) return;
    // schema 未准备好时不执行软删除（is_deleted 字段不存在）
    var dbState = await this.checkDbState();
    if (dbState === 'schema_not_ready' || dbState === 'network_error') {
      throw new Error('DB_NOT_READY:' + dbState);
    }
    await this._request('/history?user_id=eq.' + encodeURIComponent(this._userId) + '&record_uid=eq.' + encodeURIComponent(recordUid), {
      method: 'PATCH',
      body: { is_deleted: true }
    });
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
        if (rows[i].record_uid) record._cloudRecordUid = rows[i].record_uid;
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
  async patchRecordUid(cloudId, recordUid) {
    if (!this.isEnabled() || !cloudId || !recordUid) return false;
    await this._request('/history?id=eq.' + encodeURIComponent(cloudId), {
      method: 'PATCH',
      body: { record_uid: recordUid }
    });
    return true;
  },

  // DELETE 云端重复记录
  async deleteCloudRecord(cloudId) {
    if (!this.isEnabled() || !cloudId) return false;
    await this._request('/history?id=eq.' + encodeURIComponent(cloudId), { method: 'DELETE' });
    return true;
  },

  // 数据迁移（预览 / 执行）
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
      matched: 0,
      cloudDuplicates: 0,
      cloudToDelete: 0,
      localToPush: 0,
      cloudOldDuplicates: 0,       // 旧版重复（record_uid 为空，按 taskId 分组）
      cloudOldDupToDelete: 0,     // 旧版重复待删除
      uncertainMatches: 0,        // 不确定匹配数量
      pendingUpload: 0,           // 阶段B约束完成后待上传
      nullRecordUidAfter: 0,      // 迁移后预计仍为空的 record_uid 数量
      dbState: null,              // 当前数据库状态
      preview: preview,
      steps: [],
      errors: []
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

      // Step 2: 补本地 recordUid 和 updatedAt（统一使用 crypto.randomUUID，不降级）
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
          }
        }
      }
      if (report.cloudDuplicates > 0) {
        report.steps.push('检测到已有 record_uid 的重复 ' + report.cloudDuplicates + ' 组，需删除 ' + report.cloudToDelete + ' 条');
      }

      // Step 4b: 检测旧版重复（record_uid 为空，按 taskId 分组去重）
      var oldDupToDelete = [];
      var cloudByTaskId = {}; // taskId → [rows]
      var cloudNoTaskId = []; // 无 taskId 的空 record_uid 行

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

      // 同一 taskId 有多条 → 保留最新，其余列入删除
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
          }
        }
      }
      if (report.cloudOldDuplicates > 0) {
        report.steps.push('检测到旧版 taskId 重复 ' + report.cloudOldDuplicates + ' 组，需删除 ' + report.cloudOldDupToDelete + ' 条');
      }

      // Step 4c: 无 taskId 的图片记录按 model+prompt+result 匹配（不确定匹配）
      // 只统计不自动删除
      var contentGroups = {};
      for (var ni = 0; ni < cloudNoTaskId.length; ni++) {
        var nrow = cloudNoTaskId[ni];
        var nRec = nrow._decrypted;
        if (!nRec) continue;
        var key = (nRec.model || '') + '|' + (nRec.prompt || '') + '|' + JSON.stringify(nRec.result || []);
        if (!contentGroups[key]) contentGroups[key] = [];
        contentGroups[key].push(nrow);
      }
      for (var ck in contentGroups) {
        if (contentGroups[ck].length > 1) {
          report.uncertainMatches += contentGroups[ck].length - 1;
        }
      }
      if (report.uncertainMatches > 0) {
        report.steps.push('检测到 ' + report.uncertainMatches + ' 条不确定的内容重复（不会自动删除）');
      }

      // Step 5: 匹配本地与云端
      var matchedCount = 0;
      var localMatched = new Set();
      var cloudMatched = new Set();

      // 5a. 按 recordUid 匹配
      for (var i = 0; i < localHistory.length; i++) {
        var rec = localHistory[i];
        if (!rec.recordUid) continue;
        if (cloudByRecordUid[rec.recordUid]) {
          var cloudRow = cloudByRecordUid[rec.recordUid][0];
          if (rec._syncId !== cloudRow.id) {
            if (!preview) {
              rec._syncId = cloudRow.id;
            }
          }
          localMatched.add(i);
          cloudMatched.add(cloudRow.id);
          matchedCount++;
        }
      }

      // 5b. 无 recordUid 的云端行，按 taskId 匹配（跳过旧版重复中已标记删除的行）
      var oldDupIds = new Set(oldDupToDelete.map(function(r) { return r.id; }));
      for (var ci = 0; ci < cloudWithoutRecordUid.length; ci++) {
        var crow = cloudWithoutRecordUid[ci];
        if (cloudMatched.has(crow.id)) continue;
        if (oldDupIds.has(crow.id)) continue; // 跳过已标记删除的重复
        var cRec = crow._decrypted;
        if (!cRec) {
          try { cRec = await decryptObj(this._syncKey, crow.encrypted_data, crow.iv); } catch (e) { continue; }
        }
        if (cRec.taskId) {
          for (var i = 0; i < localHistory.length; i++) {
            if (localMatched.has(i)) continue;
            if (localHistory[i].taskId === cRec.taskId) {
              if (!preview) {
                try {
                  await this.patchRecordUid(crow.id, localHistory[i].recordUid);
                  localHistory[i]._syncId = crow.id;
                } catch (e) {
                  report.errors.push('PATCH record_uid 失败 (cloudId=' + crow.id + '): ' + e.message);
                }
              }
              localMatched.add(i);
              cloudMatched.add(crow.id);
              matchedCount++;
              break;
            }
          }
        }
      }

      // 5c. 仍无 recordUid 且无 taskId 的云端行，按内容匹配
      for (var ci = 0; ci < cloudWithoutRecordUid.length; ci++) {
        var crow = cloudWithoutRecordUid[ci];
        if (cloudMatched.has(crow.id)) continue;
        if (oldDupIds.has(crow.id)) continue;
        var cRec = crow._decrypted;
        if (!cRec) {
          try { cRec = await decryptObj(this._syncKey, crow.encrypted_data, crow.iv); } catch (e) { continue; }
        }
        for (var i = 0; i < localHistory.length; i++) {
          if (localMatched.has(i)) continue;
          var lRec = localHistory[i];
          if (cRec.prompt && lRec.prompt && cRec.prompt === lRec.prompt
              && cRec.result && lRec.result
              && JSON.stringify(cRec.result) === JSON.stringify(lRec.result)) {
            if (!preview) {
              try {
                await this.patchRecordUid(crow.id, lRec.recordUid);
                lRec._syncId = crow.id;
              } catch (e) {
                report.errors.push('PATCH record_uid 失败 (content match): ' + e.message);
              }
            }
            localMatched.add(i);
            cloudMatched.add(crow.id);
            matchedCount++;
            break;
          }
        }
      }

      report.matched = matchedCount;
      report.steps.push('匹配本地与云端 ' + matchedCount + ' 条');

      // Step 6: 删除云端重复记录（已有 record_uid 的重复 + 旧版 taskId 重复）
      if (!preview) {
        var allToDelete = duplicatesToDelete.concat(oldDupToDelete);
        var deleted = 0;
        for (var j = 0; j < allToDelete.length; j++) {
          try {
            await this.deleteCloudRecord(allToDelete[j].id);
            deleted++;
          } catch (e) {
            report.errors.push('删除重复记录失败 (cloudId=' + allToDelete[j].id + '): ' + e.message);
          }
        }
        if (deleted > 0) {
          report.steps.push('删除云端重复记录 ' + deleted + ' 条');
        }
      }

      // Step 7: 统计待上传的本地未匹配记录
      // v1.6.1 热修复：不在唯一约束建立前调用 upsertHistory
      // 只统计为 pendingUpload，等阶段B约束完成后由正式同步上传
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

      // 估算迁移后仍为空的 record_uid 数量
      // = 当前空 record_uid 数量 - 被匹配并补写的数量 - 被删除的重复数量
      var nullAfter = report.cloudMissingRecordUid - matchedCount - report.cloudToDelete - report.cloudOldDupToDelete;
      if (nullAfter < 0) nullAfter = 0;
      report.nullRecordUidAfter = nullAfter;
      report.steps.push('迁移后预计 record_uid 为空: ' + nullAfter + ' 条');

      report.success = true;
      report.steps.push(preview ? '预览完成（未修改数据）' : '迁移执行完成');
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
            record._deletePending = false;
            needSave = true;
          } catch (e) {
            console.warn('墓碑删除重试失败:', e);
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
