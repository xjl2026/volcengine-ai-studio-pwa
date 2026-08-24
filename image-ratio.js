// Seedream 图片宽高比控制
// 方舟图片生成 API 没有独立 ratio 字段：智能模式直接发送 1K/2K/3K/4K，固定比例转换为具体 WxH 的 size。

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

  // K 档位按近似像素面积处理；固定比例尺寸对齐到 32 像素。
  const TARGET_AREA = {
    '1K': 1024 * 1024,
    '2K': 2048 * 2048,
    '3K': 3072 * 3072,
    '4K': 4096 * 4096
  };
  const MIN_AREA = 1024 * 1024;
  const MAX_AREA = 4096 * 4096;

  function round32(value) {
    return Math.max(32, Math.round(value / 32) * 32);
  }

  function ceil32(value) {
    return Math.max(32, Math.ceil(value / 32) * 32);
  }

  function floor32(value) {
    return Math.max(32, Math.floor(value / 32) * 32);
  }

  function parseRatio(ratio) {
    if (!ratio || ratio === 'adaptive') return null;
    const parts = String(ratio).split(':').map(Number);
    if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1]) || parts[0] <= 0 || parts[1] <= 0) return null;
    return { w: parts[0], h: parts[1] };
  }

  function resolveSeedreamSize(sizeTier, ratio) {
    const parsed = parseRatio(ratio);
    if (!parsed) return sizeTier;

    const targetArea = TARGET_AREA[sizeTier] || TARGET_AREA['2K'];
    let width = round32(Math.sqrt(targetArea * parsed.w / parsed.h));
    let height = round32(Math.sqrt(targetArea * parsed.h / parsed.w));
    let area = width * height;

    // 避免 1K 档位因对齐后低于最小像素面积，或 4K 档位因对齐后超过最大像素面积。
    if (area < MIN_AREA) {
      const scale = Math.sqrt(MIN_AREA / area) * 1.002;
      width = ceil32(width * scale);
      height = ceil32(height * scale);
      area = width * height;
    }
    if (area > MAX_AREA) {
      const scale = Math.sqrt(MAX_AREA / area) * 0.998;
      width = floor32(width * scale);
      height = floor32(height * scale);
    }

    return width + 'x' + height;
  }

  window.resolveSeedreamSize = resolveSeedreamSize;

  function ensureRatioControl() {
    const sizeSelect = document.getElementById('imgSize');
    if (!sizeSelect) return;

    let select = document.getElementById('imgRatio');
    let detail = document.getElementById('imgResolvedSizeHint');

    if (!select) {
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

      select = document.createElement('select');
      select.id = 'imgRatio';
      RATIO_OPTIONS.forEach(([value, text]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.appendChild(option);
      });

      detail = document.createElement('div');
      detail.id = 'imgResolvedSizeHint';
      detail.className = 'hint';
      detail.style.marginTop = '6px';

      group.appendChild(label);
      group.appendChild(select);
      group.appendChild(detail);
      sizeGroup.insertAdjacentElement('afterend', group);
    }

    const savedRatio = localStorage.getItem('volc_img_ratio');
    if (savedRatio && RATIO_OPTIONS.some(([value]) => value === savedRatio)) select.value = savedRatio;
    else select.value = 'adaptive';

    const refreshHint = () => {
      const ratio = select.value;
      const tier = sizeSelect.value;
      localStorage.setItem('volc_img_ratio', ratio);
      if (detail) {
        detail.textContent = ratio === 'adaptive'
          ? tier + ' · 比例由模型根据提示词/参考图自动判断'
          : tier + ' · ' + ratio + ' → ' + resolveSeedreamSize(tier, ratio);
      }
    };

    select.addEventListener('change', refreshHint);
    sizeSelect.addEventListener('change', refreshHint);
    refreshHint();
  }

  function installRequestHook() {
    if (typeof buildImageRequestBody !== 'function' || window.__seedreamRatioRequestHook) return;
    const original = buildImageRequestBody;
    window.buildImageRequestBody = function (params) {
      const ratioEl = document.getElementById('imgRatio');
      const ratio = ratioEl ? ratioEl.value : 'adaptive';
      const nextParams = Object.assign({}, params);
      if (nextParams.size && ratio !== 'adaptive') {
        nextParams.size = resolveSeedreamSize(nextParams.size, ratio);
      }
      return original(nextParams);
    };
    window.__seedreamRatioRequestHook = true;
  }

  function installHistoryHook() {
    if (typeof Store === 'undefined' || !Store || typeof Store.addHistory !== 'function' || window.__seedreamRatioHistoryHook) return;
    const original = Store.addHistory.bind(Store);
    Store.addHistory = async function (record) {
      if (record && record.type === 'image') {
        const ratioEl = document.getElementById('imgRatio');
        const ratio = ratioEl ? ratioEl.value : 'adaptive';
        record.params = Object.assign({}, record.params || {}, { ratio });
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
