from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent


def read(name):
    return (ROOT / name).read_text(encoding='utf-8')


def write(name, text):
    (ROOT / name).write_text(text, encoding='utf-8')


# ---------- app.js: make UI startup deterministic ----------
app = read('app.js')
app = re.sub(r"const APP_VERSION = '[^']*';", "const APP_VERSION = '1.8.0';", app, count=1)

state_names = [
    'isSelectMode', 'selectedRecords', 'playlistVideos', 'playlistIndex',
    'playlistVideoEl', 'playlistVideoEl2', 'playlistActiveEl', 'playlistPreloadedIdx'
]
for name in state_names:
    app = re.sub(rf'^let {name} = .*?;\s*$', '', app, flags=re.M)

state_block = """const videoGenState = { isGenerating: false };
let isSelectMode = false;
let selectedRecords = [];
let playlistVideos = [];
let playlistIndex = 0;
let playlistVideoEl = null;
let playlistVideoEl2 = null;
let playlistActiveEl = null;
let playlistPreloadedIdx = -1;"""
app, n = re.subn(r"const videoGenState = \{ isGenerating: false \};", state_block, app, count=1)
if n != 1:
    raise RuntimeError('videoGenState anchor not found')

old_start = """document.addEventListener('DOMContentLoaded', async () => {
  initNav();
  initImagePage();
  initVideoPage();
  initSettingsPage();
  initSyncSettings();
  await loadConfig();
  await updateApiStatus();
  // 初始化同步
  await initSync();
  // 恢复未完成的视频任务（页面重新加载时）
  restorePendingVideoTask();
"""
new_start = """document.addEventListener('DOMContentLoaded', () => {
  // UI、导航和本地事件必须先完整初始化；网络配置、云同步和任务恢复异步执行，绝不阻塞页面交互。
  initNav();
  initImagePage();
  initVideoPage();
  initSettingsPage();
  initSyncSettings();

  Promise.resolve().then(async () => {
    await loadConfig();
    await updateApiStatus();
    await initSync();
    restorePendingVideoTask();
  }).catch(err => {
    console.error('异步启动初始化失败:', err);
    try { showToast('部分在线功能初始化失败，可继续使用本地页面', 'warning', 4000); } catch (_) {}
  });
"""
if old_start not in app:
    raise RuntimeError('DOMContentLoaded startup block not found')
app = app.replace(old_start, new_start, 1)

# A submitted video is a recoverable server task and must not block PWA update.
app = app.replace("  if (window._currentPollingTaskId) swUpdateState.pendingReasons.push('视频任务进行中');\n", '')
write('app.js', app)


# ---------- Seedance adapter: adapter version must not overwrite app version ----------
seed = read('seedance25.js')
seed = re.sub(
    r"\n\s*const v = document\.getElementById\('versionText'\);\n\s*if \(v\) v\.textContent = 'v' \+ VERSION;",
    '', seed, count=1
)
write('seedance25.js', seed)


# ---------- index.html: explicit runtime, one build-id mechanism ----------
index = read('index.html')
index = re.sub(r'<link rel="stylesheet" href="style\.css(?:\?[^\"]*)?">',
               '<link rel="stylesheet" href="style.css?v=__BUILD_ID__">', index, count=1)
index = re.sub(r'<span id="versionText">[^<]*</span>', '<span id="versionText">v1.8.0</span>', index, count=1)
index = re.sub(r'<span id="versionDate">[^<]*</span>', '<span id="versionDate">--</span>', index, count=1)

script_block = """  <script src="api.js?v=__BUILD_ID__"></script>
  <script src="sync.js?v=__BUILD_ID__"></script>
  <script src="merge-cloud-history.js?v=__BUILD_ID__"></script>
  <script src="app.js?v=__BUILD_ID__"></script>
  <script src="seedance25.js?v=__BUILD_ID__"></script>
  <script src="seedance25-refvideo-hotfix.js?v=__BUILD_ID__"></script>
  <script src="video-task-manager.js?v=__BUILD_ID__"></script>
  <script src="pwa-update.js?v=__BUILD_ID__"></script>
"""
start = index.find('  <script src="api.js')
end = index.find('</body>', start)
if start < 0 or end < 0:
    raise RuntimeError('index runtime script block not found')
index = index[:start] + script_block + index[end:]
write('index.html', index)


# ---------- Service Worker: one lifecycle, no forced client navigation ----------
sw = r"""// Service Worker - v1.8.0 stabilization
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
"""
write('sw.js', sw)


# ---------- Pages build: no runtime injection; stage only production files ----------
deploy = r"""name: Deploy to GitHub Pages

on:
  push:
    branches: [master]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Validate runtime JavaScript
        run: |
          for f in api.js sync.js merge-cloud-history.js app.js seedance25.js seedance25-refvideo-hotfix.js video-task-manager.js pwa-update.js sw.js; do
            node --check "$f"
          done

      - name: Build production site
        run: |
          BUILD_TIME=$(TZ='Asia/Shanghai' date '+%Y-%m-%d %H:%M:%S')
          BUILD_ID="$(date +%s)"
          echo "Build: $BUILD_TIME | ID: $BUILD_ID"
          rm -rf _site
          mkdir -p _site
          cp index.html style.css api.js sync.js merge-cloud-history.js app.js seedance25.js seedance25-refvideo-hotfix.js video-task-manager.js pwa-update.js sw.js manifest.json _site/
          sed -i "s|APP_BUILD = '[^']*'|APP_BUILD = '$BUILD_TIME'|g" _site/app.js
          sed -i "s|<span id=\"versionDate\">[^<]*</span>|<span id=\"versionDate\">$BUILD_TIME</span>|g" _site/index.html
          sed -i "s|__BUILD_ID__|$BUILD_ID|g" _site/index.html _site/sw.js

      - name: Setup Pages
        uses: actions/configure-pages@v5

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: '_site'

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
"""
write('.github/workflows/deploy.yml', deploy)


# ---------- Remove superseded runtime layers ----------
obsolete = [
    'app-build-version.js',
    'manual-update-control.js',
    'emergency-touch-unlock.js',
    'nav-rescue.js',
    'recovery.html',
    'sw-update-video-safe-hotfix.js',
    'video-task-background-hotfix.js',
    'video-task-pending-ui-hotfix.js',
    'history-video-task-hotfix.js',
]
for name in obsolete:
    p = ROOT / name
    if p.exists():
        p.unlink()

print('v1.8.0 stabilization source rewrite complete')
