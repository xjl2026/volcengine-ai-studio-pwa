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

  // 推送单条历史记录
  async pushHistory(record) {
    if (!this.isEnabled()) return null;
    var enc = await encryptObj(this._syncKey, record);
    var rows = await this._request('/history', {
      method: 'POST',
      body: { user_id: this._userId, encrypted_data: enc.encrypted_data, iv: enc.iv }
    });
    return rows && rows[0] ? rows[0].id : null;
  },

  // 拉取所有历史记录
  async pullHistory() {
    if (!this.isEnabled()) return [];
    var rows = await this._request('/history?user_id=eq.' + encodeURIComponent(this._userId) + '&order=created_at.desc&limit=500');
    var records = [];
    for (var i = 0; i < rows.length; i++) {
      try {
        var record = await decryptObj(this._syncKey, rows[i].encrypted_data, rows[i].iv);
        record._syncId = rows[i].id;
        records.push(record);
      } catch (e) {
        console.warn('解密失败，跳过: ', e);
      }
    }
    return records;
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
