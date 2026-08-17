// Service Worker - 离线缓存
// 每次构建替换 CACHE_NAME 以确保旧缓存被清除
// v1.7.10 - force active PWA clients onto latest build
const CACHE_NAME = 'volc-ai-1.7.10-20260817';
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

// 当前版本自动激活，用于解开旧版本“视频任务进行中，无法刷新”的更新死锁。
// 视频任务已经提交到服务端，taskId 持久化在本地，页面重载后可继续恢复查询。
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CACHE_FILES))
      .catch(err => console.warn('SW install failed:', err))
      .then(() => self.skipWaiting())
  );
});

// 激活后：清旧缓存、接管页面，并把仍停留在旧 UI 的窗口强制导航一次。
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
        // 增加一次性版本参数，绕开 iOS standalone/BFCache 对旧页面的恢复。
        url.searchParams.set('__pwa_build', '1.7.10');
        await client.navigate(url.href);
      } catch (err) {
        console.warn('Force client refresh failed:', err);
      }
    }));
  })());
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
