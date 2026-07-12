// Service Worker - 离线缓存
const CACHE_NAME = 'volc-ai-v13';
const CACHE_FILES = [
  './',
  './index.html',
  './style.css',
  './api.js',
  './sync.js',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    // 先清掉所有旧缓存，再预缓存新文件
    caches.keys().then(keys => Promise.all(
      keys.map(k => caches.delete(k))
    )).then(() => caches.open(CACHE_NAME)).then(cache => cache.addAll(CACHE_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // 只缓存同源请求，不拦截 API 调用
  if (e.request.url.startsWith(self.location.origin) && e.request.method === 'GET') {
    e.respondWith(
      // 网络优先：先尝试从网络获取最新版本，失败再用缓存
      fetch(e.request).then(res => {
        // 成功获取到新内容，更新缓存
        if (res && res.status === 200) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone)).catch(() => {});
        }
        return res;
      }).catch(() => {
        // 网络失败时用缓存（离线场景）
        return caches.match(e.request);
      })
    );
  }
});
