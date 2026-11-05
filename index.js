/**
 * 造梦师 · 推进台
 * SillyTavern 第三方扩展入口。
 *
 * 启动顺序：
 *   等 ST 上下文就绪 → 挂 shadow host → 建面板 → 订阅事件
 */

import { getCtx, on, eventTypes } from './core/ctx.js?v=2.17.0';
import { loadHistory, onGenerationEnded, resetAutoGuard } from './core/engine.js?v=2.17.0';
import { get as getSettings, invalidate as invalidateSettings, load as loadSettings } from './core/settings.js?v=2.17.0';
import { install as installInspector } from './core/inspect.js?v=2.17.0';
import { mountHost, syncTheme } from './ui/host.js?v=2.17.0';
import { createPanel } from './ui/panel.js?v=2.17.0';

const TAG = '[推进台]';

// 尽早挂上请求检视——越早越好，免得被别的扩展先 hook 掉
installInspector();

let panel = null;
let unbinds = [];
let booted = false;

/* ---------------- 启动 ---------------- */

function boot() {
  if (booted) return;
  const ctx = getCtx();
  if (!ctx) return;

  booted = true;
  loadSettings();

  const shadow = mountHost();
  panel = createPanel(shadow);

  bindStEvents();
  bindHotkeys();

  loadHistory();
  console.log(TAG, '已启动');
}

/** ST 的上下文不一定在脚本执行时就绪，轮询等它。 */
function waitForTavern(attempt = 0) {
  if (getCtx()) {
    boot();
    return;
  }
  if (attempt > 60) {
    console.warn(TAG, '等不到 SillyTavern 上下文，扩展未启动');
    return;
  }
  setTimeout(() => waitForTavern(attempt + 1), 300);
}

/* ---------------- ST 事件 ---------------- */

function bindStEvents() {
  const et = eventTypes();

  const onEnded = (messageId) => {
    if (typeof messageId !== 'number') return;
    onGenerationEnded(messageId);
  };

  const onChatChanged = () => {
    resetAutoGuard();
    invalidateSettings();
    loadSettings();
    loadHistory();
    syncTheme();
  };

  const onSwiped = () => {
    // 换 swipe 等于换了一版正文，之前的选项作废
    resetAutoGuard();
  };

  if (et.GENERATION_ENDED) unbinds.push(on(et.GENERATION_ENDED, onEnded));
  if (et.CHAT_CHANGED) unbinds.push(on(et.CHAT_CHANGED, onChatChanged));
  if (et.MESSAGE_SWIPED) unbinds.push(on(et.MESSAGE_SWIPED, onSwiped));

  // 主题切换时重新探测
  unbinds.push(
    on(et.SETTINGS_UPDATED || 'settings_updated', () => {
      invalidateSettings();
      loadSettings();
      syncTheme();
    }),
  );
}

/* ---------------- 快捷键 ---------------- */

function bindHotkeys() {
  const handler = (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;

    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;

    const key = String(e.key || '').toLowerCase();
    const hot = (getSettings().hotkey || 'p').toLowerCase();

    if (key === hot) {
      e.preventDefault();
      panel?.toggle();
      return;
    }
    if (key === 'r' && !typing) {
      e.preventDefault();
      document.querySelector('#meng-push-host')?.shadowRoot?.querySelector('.mini-btn.primary')?.click();
    }
  };

  document.addEventListener('keydown', handler);
  unbinds.push(() => document.removeEventListener('keydown', handler));
}

/* ---------------- 生命周期 ---------------- */

function destroy() {
  for (const fn of unbinds) {
    try {
      fn();
    } catch {
      /* 忽略 */
    }
  }
  unbinds = [];
  panel?.destroy();
  panel = null;
  booted = false;
}

// 页面卸载时清理，避免 ST 热重载后出现两份面板
window.addEventListener('pagehide', destroy);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => waitForTavern());
} else {
  waitForTavern();
}

// 暴露给控制台调试
window.__mengPush = {
  boot,
  destroy,
  get panel() {
    return panel;
  },
};
