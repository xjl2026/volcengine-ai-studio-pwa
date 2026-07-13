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

  isEnabled() {
    return !!(this._url && this._anonKey && this._syncKey);
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

  // 推送单条历史记录（阶段A：带 record_uid，不用 on_conflict）
  async pushHistory(record) {
    if (!this.isEnabled()) return null;
    var enc = await encryptObj(this._syncKey, record);
    var body = {
      user_id: this._userId,
      encrypted_data: enc.encrypted_data,
      iv: enc.iv
    };
    if (record.recordUid) body.record_uid = record.recordUid;
    var rows = await this._request('/history', {
      method: 'POST',
      body: body
    });
    return rows && rows[0] ? rows[0].id : null;
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
      preview: preview,
      steps: [],
      errors: []
    };

    try {
      // Step 1: 拉取本地记录
      var localHistory = await Store.getHistory();
      report.localTotal = localHistory.length;
      report.steps.push('拉取本地记录 ' + localHistory.length + ' 条');

      // Step 2: 补本地 recordUid 和 updatedAt
      var needSave = false;
      for (var i = 0; i < localHistory.length; i++) {
        var rec = localHistory[i];
        if (!rec.recordUid) {
          rec.recordUid = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2, 10));
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

      // Step 4: 检测云端重复（按 record_uid 分组）
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

      // 检测重复
      var duplicatesToDelete = [];
      for (var uid in cloudByRecordUid) {
        var group = cloudByRecordUid[uid];
        if (group.length > 1) {
          report.cloudDuplicates++;
          // 保留 updated_at 最新的，删除其余
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
        report.steps.push('检测到云端重复 recordUid ' + report.cloudDuplicates + ' 组，需删除 ' + report.cloudToDelete + ' 条');
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
          var cloudRow = cloudByRecordUid[rec.recordUid][0]; // 取保留的那条
          // 修正本地 _syncId
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

      // 5b. 无 recordUid 的云端行，按 taskId 匹配
      for (var ci = 0; ci < cloudWithoutRecordUid.length; ci++) {
        var crow = cloudWithoutRecordUid[ci];
        if (cloudMatched.has(crow.id)) continue;
        try {
          var cRec = await decryptObj(this._syncKey, crow.encrypted_data, crow.iv);
        } catch (e) {
          report.errors.push('解密云端记录失败: ' + e.message);
          continue;
        }
        if (cRec.taskId) {
          for (var i = 0; i < localHistory.length; i++) {
            if (localMatched.has(i)) continue;
            if (localHistory[i].taskId === cRec.taskId) {
              // 匹配成功，补写 record_uid 到云端
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
        try {
          var cRec = await decryptObj(this._syncKey, crow.encrypted_data, crow.iv);
        } catch (e) { continue; }
        for (var i = 0; i < localHistory.length; i++) {
          if (localMatched.has(i)) continue;
          var lRec = localHistory[i];
          // prompt + result 匹配
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

      // Step 6: 删除云端重复记录
      if (!preview && duplicatesToDelete.length > 0) {
        var deleted = 0;
        for (var j = 0; j < duplicatesToDelete.length; j++) {
          try {
            await this.deleteCloudRecord(duplicatesToDelete[j].id);
            deleted++;
          } catch (e) {
            report.errors.push('删除重复记录失败 (cloudId=' + duplicatesToDelete[j].id + '): ' + e.message);
          }
        }
        report.steps.push('删除云端重复记录 ' + deleted + ' 条');
      }

      // Step 7: 上传本地未匹配的记录到云端
      var localToPush = 0;
      if (!preview) {
        for (var i = 0; i < localHistory.length; i++) {
          if (!localMatched.has(i) && !localHistory[i]._syncId) {
            try {
              var syncId = await this.pushHistory(localHistory[i]);
              if (syncId) {
                localHistory[i]._syncId = syncId;
                localToPush++;
              }
            } catch (e) {
              report.errors.push('上传本地记录失败: ' + e.message);
            }
          }
        }
        await Store.saveHistory(localHistory);
      } else {
        for (var i = 0; i < localHistory.length; i++) {
          if (!localMatched.has(i) && !localHistory[i]._syncId) {
            localToPush++;
          }
        }
      }
      report.localToPush = localToPush;
      if (localToPush > 0) {
        report.steps.push(preview ? '预览：需上传本地未匹配记录 ' + localToPush + ' 条' : '上传本地未匹配记录 ' + localToPush + ' 条');
      }

      report.success = true;
      report.steps.push(preview ? '预览完成（未修改数据）' : '迁移执行完成');
    } catch (e) {
      report.success = false;
      report.errors.push('迁移异常: ' + e.message);
    }
    return report;
  },

  // 删除单条历史记录
  async deleteHistory(syncId) {
    if (!this.isEnabled() || !syncId) return;
    await this._request('/history?id=eq.' + encodeURIComponent(syncId), { method: 'DELETE' });
  },

  // 清空所有历史记录
  async clearAllHistory() {
    if (!this.isEnabled()) return;
    await this._request('/history?user_id=eq.' + encodeURIComponent(this._userId), { method: 'DELETE' });
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
