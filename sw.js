// Service Worker - 离线缓存
// 每次构建替换 CACHE_NAME 以确保旧缓存被清除
// BUILD_CACHE: volc-ai-1783936800
const CACHE_NAME = 'volc-ai-1783936800';
const CACHE_FILES = [
  './',
  './index.html',
  './style.css',
  './api.js',
  './sync.js',
  './app.js',
  './manifest.json'
];

// install: 只缓存，不自动 skipWaiting（等待用户确认后再激活）
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_FILES)).catch(err => console.warn('SW install failed:', err))
  );
  // 不调用 self.skipWaiting()，等待消息触发
});

// activate: 清理旧缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith('volc-ai-') && k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// 消息监听：用户确认后才 skipWaiting
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
