from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent


def read(name):
    return (ROOT / name).read_text(encoding='utf-8')


def write(name, text):
    (ROOT / name).write_text(text, encoding='utf-8')


# app.js: source itself follows the v1.8.0 startup architecture.
app = read('app.js')
app = re.sub(r"const APP_VERSION = '[^']*';", "const APP_VERSION = '1.8.0';", app, count=1)
for name in ['isSelectMode','selectedRecords','playlistVideos','playlistIndex','playlistVideoEl','playlistVideoEl2','playlistActiveEl','playlistPreloadedIdx']:
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
  // UI、导航和本地事件先完整初始化；网络配置、云同步和任务恢复异步执行，绝不阻塞页面交互。
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
if old_start in app:
    app = app.replace(old_start, new_start, 1)
elif "document.addEventListener('DOMContentLoaded', () => {" not in app:
    raise RuntimeError('DOMContentLoaded startup block not found')
app = app.replace("  if (window._currentPollingTaskId) swUpdateState.pendingReasons.push('视频任务进行中');\n", '')
write('app.js', app)


# Seedance adapter must not overwrite the whole-app version label.
seed = read('seedance25.js')
seed = re.sub(
    r"\n\s*const v = document\.getElementById\('versionText'\);\n\s*if \(v\) v\.textContent = 'v' \+ VERSION;",
    '', seed, count=1
)
write('seedance25.js', seed)


# index.html explicitly declares the production runtime. No injected hotfix stack.
index = read('index.html')
index = re.sub(r'<link rel="stylesheet" href="style\.css(?:\?[^\"]*)?">', '<link rel="stylesheet" href="style.css?v=__BUILD_ID__">', index, count=1)
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


# Old runtime layers are removed from source, not merely excluded from deployment.
for name in [
    'app-build-version.js',
    'manual-update-control.js',
    'emergency-touch-unlock.js',
    'nav-rescue.js',
    'recovery.html',
    'sw-update-video-safe-hotfix.js',
    'video-task-background-hotfix.js',
    'video-task-pending-ui-hotfix.js',
    'history-video-task-hotfix.js',
]:
    p = ROOT / name
    if p.exists():
        p.unlink()

print('v1.8.0 source stabilization complete')
