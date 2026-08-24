// Service Worker - v1.8.0 stabilization
// Predictable lifecycle: no automatic client navigation and no page-side cache deletion.
const CACHE_NAME = 'volc-ai-__BUILD_ID__';
const CACHE_FILES = [
  './',
  './index.html',
  './style.css?v=__BUILD_ID__',
  './api.js?v=__BUILD_ID__',
  './sync.js?v=__BUILD_ID__',
  './merge-cloud-history.js?v=__BUILD_ID__',
  './app.js?v=__BUILD_ID__',
  './image-ratio.js?v=__BUILD_ID__',
  './seedance25.js?v=__BUILD_ID__',
  './seedance25-refvideo-hotfix.js?v=__BUILD_ID__',
  './video-task-manager.js?v=__BUILD_ID__',
  './pwa-update.js?v=__BUILD_ID__',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_FILES)).catch(err => {
      console.warn('SW precache failed:', err);
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('volc-ai-') && k !== CACHE_NAME).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then(res => {
          if (res && res.ok) {
            caches.open(CACHE_NAME).then(cache => cache.put('./index.html', res.clone())).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    fetch(req, { cache: 'no-store' })
      .then(res => {
        if (res && res.ok) {
          caches.open(CACHE_NAME).then(cache => cache.put(req, res.clone())).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
