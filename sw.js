// Service Worker - 离线缓存
// 每次构建替换 CACHE_NAME 以确保旧缓存被清除
// BUILD_CACHE: volc-ai-1783838801
const CACHE_NAME = 'volc-ai-1783838801';
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
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_FILES)).then(() => {
      // 只删旧版本缓存，不删全部（避免误伤其他存储）
      return caches.keys().then(keys => Promise.all(
        keys.filter(k => k.startsWith('volc-ai-') && k !== CACHE_NAME).map(k => caches.delete(k))
      ));
    }).catch(err => console.warn('SW install failed, will retry:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith('volc-ai-') && k !== CACHE_NAME).map(k => caches.delete(k))
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
