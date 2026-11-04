import { readExtensionSettings, writeExtensionSettings } from './ctx.js?v=1.2.1';

/** extension_settings 里的键名。加前缀避免和其它扩展撞车。 */
const SETTINGS_KEY = 'meng_push_settings';

/** 默认设置。新增字段一律在这里给默认值，老配置缺字段时自动补齐。 */
export function defaults() {
  return {
    enabled: true,

    /** 每轮正文写完自动跑一次 */
    auto: true,
    /** 自动模式下延迟多少毫秒再跑（等 ST 把楼层渲染完） */
    autoDelay: 700,

    modules: {
      choices: true,
      /** 弹幕按概率触发，不是每轮都出 */
      danmaku: true,
      /** 节拍表只在手动点「节拍」时生成，不参与自动流程 */
      beats: false,
    },

    choiceCount: 5,
    danmakuChance: 0.4,

    /** 自定义提示词：空串表示用内置默认。key 见 prompts.js 的 PROMPT_FIELDS。 */
    prompts: { kernel: '', choices: '', danmaku: '', beats: '', outline: '', steps: '' },

    /** 上下文预算 */
    summaryDepth: 3,
    tailChars: 1400,
    cardChars: 600,

    /** 渠道：可以为不同任务分配不同模型 */
    channels: [],
    routing: { choices: '', danmaku: '', beats: '' },

    /** 采样 */
    jsonMode: true,
    retries: 1,

    /** 面板位置与状态 */
    panel: { x: null, y: null, open: true, collapsed: false, tab: 'choices' },

    /** 历史回溯保留多少轮 */
    historyLimit: 24,

    /** 主题：auto 跟随酒馆，dark/light 强制 */
    theme: 'auto',

    /** 快捷键（Alt + 键） */
    hotkey: 'p',
  };
}

/** 深合并：对象递归，数组整体替换。 */
function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch === undefined ? base : patch;
  }
  const out = Array.isArray(base) ? [] : { ...base };
  for (const k of Object.keys(patch)) {
    const bv = base?.[k];
    const pv = patch[k];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = merge(bv, pv);
    } else {
      out[k] = pv;
    }
  }
  return out;
}

let cache = null;

export function load() {
  if (cache) return cache;
  const stored = readExtensionSettings(SETTINGS_KEY);
  cache = merge(defaults(), stored || {});
  if (!Array.isArray(cache.channels)) cache.channels = [];
  return cache;
}

export function save() {
  if (!cache) return;
  writeExtensionSettings(SETTINGS_KEY, cache);
}

export function patch(partial) {
  cache = merge(load(), partial || {});
  save();
  return cache;
}

export function get() {
  return load();
}

/** 外部改动了设置（比如另一个标签页），丢弃缓存重新读。 */
export function invalidate() {
  cache = null;
}

/* ---------------- 渠道 ---------------- */

export function newChannel(overrides = {}) {
  return {
    id: 'ch_' + Math.random().toString(36).slice(2, 9),
    name: '新渠道',
    url: '',
    key: '',
    model: '',
    temperature: 0.95,
    maxTokens: 900,
    timeoutSec: 90,
    stream: false,
    ...overrides,
  };
}

export function getChannel(id) {
  const list = get().channels;
  return list.find((c) => c.id === id) || list[0] || null;
}

/** 取某个任务该用哪个渠道：优先任务专属，其次第一个配好的。 */
export function channelFor(task) {
  const s = get();
  const id = s.routing?.[task];
  if (id) {
    const hit = s.channels.find((c) => c.id === id);
    if (hit) return hit;
  }
  return s.channels.find((c) => c.url && c.model) || null;
}

/** 渠道是否配全了。 */
export function channelReady(ch) {
  return !!(ch && ch.url && ch.model);
}

/** 掩码显示 key，避免设置界面里明文滚动。 */
export function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 8) return '•'.repeat(s.length);
  return s.slice(0, 4) + '•'.repeat(Math.min(12, s.length - 8)) + s.slice(-4);
}
