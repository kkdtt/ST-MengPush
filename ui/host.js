/**
 * Shadow DOM 宿主 + 一组 DOM 小工具。
 *
 * 为什么用 shadow root：酒馆的全局样式会渗透进扩展（尤其是 font-size、
 * line-height、button 的默认样式），而且我们的样式也不该外泄。shadow 边界
 * 是唯一能同时解决这两件事的办法。
 */

import { detectTheme } from '../core/ctx.js?v=2.13.1';
import { VERSION } from '../core/version.js?v=2.13.1';

const HOST_ID = 'meng-push-host';

let host = null;
let shadow = null;
let themeObserver = null;

/** 这些属性会透过 shadow 边界从宿主继承进来，在 host 上钉死。 */
const INHERIT_RESET = {
  'font-size': '13px',
  'font-weight': '400',
  'font-style': 'normal',
  'line-height': '1.62',
  'letter-spacing': 'normal',
  'text-align': 'left',
  'text-transform': 'none',
  'text-indent': '0',
  'text-shadow': 'none',
  'white-space': 'normal',
  'word-spacing': 'normal',
  direction: 'ltr',
};

export function mountHost() {
  if (host && host.isConnected) return shadow;

  host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    document.body.appendChild(host);
  }

  host.style.setProperty('display', 'contents', 'important');
  for (const [prop, value] of Object.entries(INHERIT_RESET)) {
    host.style.setProperty(prop, value, 'important');
  }

  shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  shadow.textContent = '';

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  // 带版本号，否则改了 CSS 浏览器还用旧的
  link.href = new URL(`./style.css?v=${VERSION}`, import.meta.url).href;
  shadow.appendChild(link);

  syncTheme();
  watchTheme();
  return shadow;
}

/** 主题跟随酒馆：用户换主题时面板自动切深浅。 */
export function syncTheme(forced) {
  if (!host) return;
  const theme = forced || detectTheme();
  host.setAttribute('data-theme', theme);
}

function watchTheme() {
  if (themeObserver) return;
  try {
    themeObserver = new MutationObserver(() => syncTheme());
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  } catch {
    /* 观察失败不影响功能 */
  }
}

export function getHost() {
  return host;
}

/* ---------------- DOM 工具 ---------------- */

/**
 * 建元素。
 * h('div', {class:'x', onclick: fn}, [子节点或文本])
 */
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);

  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }

  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/* ---------------- 图标 ---------------- */

const ICONS = {
  brand: 'M4 20c0-6 3-10 8-14M9 20c0-4 2-7 6-9M4 14h6M14 6h5M16 4v4',
  refresh: 'M20 11a8 8 0 1 0-2.3 6M20 4v6h-6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-4l-.4 2.6a7 7 0 0 0-1.7 1l-2.3-1-2 3.4L6 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1L10.5 21h4l.4-2.6a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5c.1-.3.1-.7.1-1z',
  chevron: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  play: 'M8 5l11 7-11 7V5z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  stop: 'M7 7h10v10H7z',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ICONS.brand);
  svg.appendChild(p);
  return svg;
}

/* ---------------- 拖动 ---------------- */

/**
 * 把坐标限制在视口内。
 *
 * 移动端上元素可能比视口还宽（窄屏 342px 面板 + 边距），
 * 这时 upper 会算成负数，Math.min 一夹就跑到屏幕外了，所以先兜个 0。
 */
function clampToViewport(x, y, w, h) {
  const maxX = Math.max(0, window.innerWidth - w - 4);
  const maxY = Math.max(0, window.innerHeight - h - 4);
  return {
    x: Math.min(Math.max(0, x), maxX),
    y: Math.min(Math.max(0, y), maxY),
  };
}

/**
 * 让元素可拖动。坐标会写回 onEnd 回调，由调用方决定存哪。
 * 拖动结束后才回调，避免拖的时候疯狂写 settings。
 *
 * 用 Pointer Events 而不是 mouse 事件：手机、平板、触控笔都是 pointer，
 * 鼠标那一套在触屏上一个都不会触发，这也是移动端拖不动的根本原因。
 * 配合 CSS 的 touch-action: none，浏览器才不会把手势当成页面滚动。
 */
export function makeDraggable(handle, el, { onEnd } = {}) {
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;
  let dragging = false;
  let pointerId = null;

  const finish = (commit) => {
    if (!dragging) return;
    dragging = false;
    pointerId = null;
    el.classList.remove('dragging');

    if (commit !== false) {
      // 优先用写进 style 的值：拖动过程中它就是最终位置，
      // 不受 transform / 动画影响；拿不到再退回布局测量
      const x = parseFloat(el.style.left);
      const y = parseFloat(el.style.top);
      const r = el.getBoundingClientRect();
      onEnd?.({
        x: Math.round(Number.isFinite(x) ? x : r.left),
        y: Math.round(Number.isFinite(y) ? y : r.top),
      });
    }
  };

  handle.addEventListener('pointerdown', (e) => {
    // 鼠标只认左键；触屏的 button 恒为 0
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea, a')) return;

    const r = el.getBoundingClientRect();
    dragging = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    originX = r.left;
    originY = r.top;

    el.style.left = r.left + 'px';
    el.style.top = r.top + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.classList.add('dragging');

    // 捕获指针：手指移出面板范围也照样收得到 move，
    // 否则一拖快就断在边界上，手感很怪
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* 某些环境不支持，退化成普通事件流 */
    }

    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const { x, y } = clampToViewport(
      originX + e.clientX - startX,
      originY + e.clientY - startY,
      el.offsetWidth,
      el.offsetHeight,
    );
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  });

  handle.addEventListener('pointerup', (e) => {
    if (e.pointerId !== pointerId) return;
    finish(true);
  });

  // 被系统手势打断（来电、通知下拉、切后台）时不留脏状态
  handle.addEventListener('pointercancel', () => finish(false));
  handle.addEventListener('lostpointercapture', () => finish(true));
}

/**
 * 窗口尺寸变化时把面板拉回视口内。
 * 手机横竖屏切换、地址栏收起，都会让原本存下的坐标跑到屏幕外。
 */
export function keepInViewport(el) {
  const fix = () => {
    if (!el || el.hidden) return;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const { x, y } = clampToViewport(r.left, r.top, r.width, r.height);
    if (Math.abs(x - r.left) > 1 || Math.abs(y - r.top) > 1) {
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    }
  };
  window.addEventListener('resize', fix);
  window.addEventListener('orientationchange', () => setTimeout(fix, 260));
  return fix;
}
