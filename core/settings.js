import { readExtensionSettings, writeExtensionSettings } from './ctx.js?v=2.10.2';
import { VERSION } from './version.js?v=2.10.2';

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
      /** 下面这几个开关只决定「正文写完自动跑」时跑不跑，手动点按钮不受影响 */
      choices: true,
      /** 弹幕按概率触发，不是每轮都出 */
      danmaku: true,
      /** 节拍表只在手动点「节拍」时生成，不参与自动流程 */
      beats: false,
      /** 反派行动与走向互斥，同时开会多跑一次 */
      moves: false,
      /** 新人介绍：每轮自动抽一个，不想要就关掉 */
      intro: false,
    },

    choiceCount: 5,
    danmakuChance: 0.4,

    /** 工具通道：内容走 tool_calls 的 arguments，断流时能按半截 JSON 救回，且触发内容过滤的概率更低 */
    useToolChannel: false,

    /** 角色档案用哪套模板：'1' 详细（约 2000 token）/ '2' 精简（约 1300 token） */
    profileTemplate: '1',

    /** 全局最大回复长度（token）。渠道里留空时用这个 */
    maxReplyTokens: 4000,

    /** 梦中梦单次回答的输出上限。出选项用渠道默认，这里要单独放大 */
    dreamMaxTokens: 12000,

    /** 自定义解析正则：空串表示用内置默认（<content> / <details><summary>摘要</summary>） */
    bodyRegex: '',
    summaryRegex: '',

    /** 自定义提示词：空串表示用内置默认。key 见 prompts.js 的 PROMPT_FIELDS。 */
    prompts: { kernel: '', choices: '', danmaku: '', beats: '', outline: '', steps: '' },

    /** 上下文预算 */
    /** 最近几层以「真实对话」形式发给旁路模型，更早的用摘要 */
    historyDepth: 6,
    /** 摘要总字数预算（不是条数） */
    summaryChars: 8000,
    /** 摘要条数上限，防止极端情况下塞太多 */
    summaryDepth: 20,
    tailChars: 3000,
    cardChars: 3000,

    /** 是否把世界书喂给旁路模型（强烈建议开） */
    includeWorldInfo: true,
    /** 已废弃：扫描预算改为按 worldInfoChars 联动计算，保留字段仅为兼容旧配置 */
    worldInfoBudget: 8192,
    /** 世界书内容截断长度 */
    worldInfoChars: 6000,
    /** 手填的背景设定（预设里的存档条目插件读不到，可以粘这里） */
    background: '',

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
    topP: 0.95,
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

/* ---------------- 配置备份 ---------------- */

/** 导出：渠道（含密钥）、全部参数、提示词。换设备或重装时用它恢复。 */
export function exportConfig() {
  return JSON.stringify(
    {
      _type: 'meng-push-config',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      settings: get(),
    },
    null,
    2,
  );
}

/** 导入：与默认值深合并，缺的字段自动补，多的字段忽略。 */
export function importConfig(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }

  const incoming = data?.settings || data;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new Error('文件里没有可用的设置对象');
  }

  cache = merge(defaults(), incoming);
  if (!Array.isArray(cache.channels)) cache.channels = [];
  save();
  return cache;
}
