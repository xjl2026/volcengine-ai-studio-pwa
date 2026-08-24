// Seedream 图片宽高比控制
// 将“分辨率档位 + 画面比例”转换为方舟图片生成 API 的 size 参数。
// 选择“智能”时保留 1K/2K/3K/4K 档位，由模型自行判断宽高比；固定比例时发送具体 WxH。

(function () {
  'use strict';

  const RATIO_OPTIONS = [
    ['adaptive', '智能（模型判断）'],
    ['1:1', '1:1'],
    ['4:3', '4:3'],
    ['3:4', '3:4'],
    ['3:2', '3:2'],
    ['2:3', '2:3'],
    ['16:9', '16:9'],
    ['9:16', '9:16'],
    ['21:9', '21:9']
  ];

  // 以各 K 档位的近似像素面积为目标，尺寸对齐到 16 像素，便于模型稳定处理。
  const TARGET_AREA = {
    '1K': 1024 * 1024,
    '2K': 2048 * 2048,
    '3K': 3072 * 3072,
    '4K': 4096 * 4096
  };

  function align16(value) {
    return Math.max(16, Math.round(value / 16) * 16);
  }

  function parseRatio(ratio) {
    if (!ratio || ratio === 'adaptive') return null;
    const parts = String(ratio).split(':').map(Number);
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { w: parts[0], h: parts[1] };
  }

  function resolveSeedreamSize(sizeTier, ratio) {
    const parsed = parseRatio(ratio);
    if (!parsed) return sizeTier;

    const targetArea = TARGET_AREA[sizeTier] || TARGET_AREA['2K'];
    const width = align16(Math.sqrt(targetArea * parsed.w / parsed.h));
    const height = align16(Math.sqrt(targetArea * parsed.h / parsed.w));
    return width + 'x' + height;
  }

  window.resolveSeedreamSize = resolveSeedreamSize;

  function ensureRatioControl() {
    const sizeSelect = document.getElementById('imgSize');
    if (!sizeSelect || document.getElementById('imgRatio')) return;

    const sizeGroup = sizeSelect.closest('.form-group');
    if (!sizeGroup) return;

    const group = document.createElement('div');
    group.className = 'form-group';
    group.id = 'imgRatioGroup';

    const label = document.createElement('label');
    label.textContent = '画面比例 ';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = '固定比例会转换为具体输出尺寸';
    label.appendChild(hint);

    const select = document.createElement('select');
    select.id = 'imgRatio';
    RATIO_OPTIONS.forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    });
    select.value = localStorage.getItem('volc_img_ratio') || 'adaptive';

    const detail = document.createElement('div');
    detail.id = 'imgResolvedSizeHint';
    detail.className = 'hint';
    detail.style.marginTop = '6px';

    group.appendChild(label);
    group.appendChild(select);
    group.appendChild(detail);
    sizeGroup.insertAdjacentElement('afterend', group);

    const refreshHint = () => {
      const ratio = select.value;
      const tier = sizeSelect.value;
      localStorage.setItem('volc_img_ratio', ratio);
      detail.textContent = ratio === 'adaptive'
        ? tier + ' · 比例由模型根据提示词/参考图自动判断'
        : tier + ' · ' + ratio + ' → ' + resolveSeedreamSize(tier, ratio);
    };

    select.addEventListener('change', refreshHint);
    sizeSelect.addEventListener('change', refreshHint);
    refreshHint();
  }

  function installRequestHook() {
    if (typeof window.buildImageRequestBody !== 'function' || window.__seedreamRatioRequestHook) return;
    const original = window.buildImageRequestBody;
    window.buildImageRequestBody = function (params) {
      const ratioEl = document.getElementById('imgRatio');
      const ratio = ratioEl ? ratioEl.value : 'adaptive';
      const nextParams = Object.assign({}, params);
      if (nextParams.size && ratio && ratio !== 'adaptive') {
        nextParams.size = resolveSeedreamSize(nextParams.size, ratio);
      }
      return original(nextParams);
    };
    window.__seedreamRatioRequestHook = true;
  }

  function installHistoryHook() {
    if (!window.Store || typeof Store.addHistory !== 'function' || window.__seedreamRatioHistoryHook) return;
    const original = Store.addHistory.bind(Store);
    Store.addHistory = async function (record) {
      if (record && record.type === 'image') {
        const ratioEl = document.getElementById('imgRatio');
        const ratio = ratioEl ? ratioEl.value : 'adaptive';
        record.params = Object.assign({}, record.params || {}, {
          ratio,
          requestedSize: resolveSeedreamSize((record.params && record.params.size) || '2K', ratio)
        });
      }
      return original(record);
    };
    window.__seedreamRatioHistoryHook = true;
  }

  function init() {
    ensureRatioControl();
    installRequestHook();
    installHistoryHook();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
