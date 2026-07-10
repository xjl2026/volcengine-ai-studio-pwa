// Service Worker - 离线缓存
const CACHE_NAME = 'volc-ai-v1';
const CACHE_FILES = [
  './',
  './index.html',
  './style.css',
  './api.js',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_FILES)).catch(() => {})
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
      caches.match(e.request).then(cached => {
        return cached || fetch(e.request).then(res => {
          return res;
        }).catch(() => cached);
      })
    );
  }
});
