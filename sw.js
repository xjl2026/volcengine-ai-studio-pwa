// Service Worker - 离线缓存
// 每次构建替换 CACHE_NAME 以确保旧缓存被清除
// v1.7.9 - emergency auto-activate to break old-version update deadlock
const CACHE_NAME = 'volc-ai-1.7.9-20260817';
const CACHE_FILES = [
  './',
  './index.html',
  './style.css',
  './api.js',
  './sync.js',
  './merge-cloud-history.js',
  './seedance25.js',
  './app.js',
  './manifest.json'
];

// install: 本次自动激活新 SW，用于解开“旧版本因视频任务禁止更新”的死锁。
// 视频生成任务已在服务端运行，taskId 保存在 localStorage，重新打开后可恢复查询。
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CACHE_FILES))
      .catch(err => console.warn('SW install failed:', err))
      .then(() => self.skipWaiting())
  );
});

// activate: 清理旧缓存并立即接管页面。
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('volc-ai-') && k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// 仍保留手动激活消息兼容旧前端。
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// fetch: network-first
self.addEventListener('fetch', (e) => {
  if (e.request.url.startsWith(self.location.origin) && e.request.method === 'GET') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
  }
});
