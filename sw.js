// Service Worker - 离线缓存
// 每次构建替换 CACHE_NAME 以确保旧缓存被清除
// v1.7.14 - recovery page + dynamic build marker
const CACHE_NAME = 'volc-ai-1.7.14-20260817';
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

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CACHE_FILES))
      .catch(err => console.warn('SW install failed:', err))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('volc-ai-') && k !== CACHE_NAME).map(k => caches.delete(k))
    );

    await self.clients.claim();

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(clients.map(async client => {
      try {
        const url = new URL(client.url);
        if (url.origin !== self.location.origin) return;
        // 使用当前构建的 CACHE_NAME，而不是固定版本号，避免以后再次卡在旧版本参数。
        url.searchParams.set('__pwa_build', CACHE_NAME);
        await client.navigate(url.href);
      } catch (err) {
        console.warn('Force client refresh failed:', err);
      }
    }));
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 同源 GET 请求 network-first；在线时优先拿最新文件，离线才回退缓存。
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
