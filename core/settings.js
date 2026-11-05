import { readExtensionSettings, writeExtensionSettings } from './ctx.js?v=2.17.0';
import { PROMPT_FIELDS } from './prompts.js?v=2.17.0';
import { VERSION } from './version.js?v=2.17.0';

/** extension_settings 里的键名。加前缀避免和其它扩展撞车。 */
const SETTINGS_KEY = 'meng_push_settings';

/** 默认设置。新增字段一律在这里给默认值，老配置缺字段时自动补齐。 */
export function defaults() {
  return {
    /** 每轮正文写完自动跑一次 */
    auto: true,
    /** 自动模式下延迟多少毫秒再跑（等 ST 把楼层渲染完） */
    autoDelay: 700,

    modules: {
      /** 下面这几个开关只决定「正文写完自动跑」时跑不跑，手动点按钮不受影响 */
      choices: true,
      /** 弹幕页已换成「新人」，自动跑弹幕只会白花一次请求，默认关 */
      danmaku: false,
      /** 节拍表只在手动点「节拍」时生成，不参与自动流程 */
      beats: false,
      /** 反派行动与走向互斥，同时开会多跑一次 */
      moves: false,
      /** 新人介绍：每轮自动抽一个，不想要就关掉 */
      intro: false,
    },

    choiceCount: 5,

    /** 工具通道：内容走 tool_calls 的 arguments，断流时能按半截 JSON 救回，且触发内容过滤的概率更低 */
    useToolChannel: false,

    /** 角色档案用哪套模板：'1' 详细（约 2000 token）/ '2' 精简（约 1300 token） */
    profileTemplate: '1',

    /**
     * 导入的全局世界书。entries 里每条只有 on/off 两态，
     * 开着的会拼进资料段，位置在 <世界规则与其他补充材料> 之后。
     */
    worldbook: { name: '', at: 0, entries: [] },

    /** 全局世界书拼进上下文时的字数预算 */
    worldbookChars: 40000,

    /** 任务前那条空 user 是否塞一个空格。某些网关不接受空 content 时打开 */
    emptyUserPad: false,

    /** 一次介绍几个新人（上限 10） */
    introCount: 3,

    /** 一次出几条反派行动 */
    moveCount: 4,

    /** 自定义解析正则：空串表示用内置默认（<content> / <details><summary>摘要</summary>） */
    bodyRegex: '',
    summaryRegex: '',

    /** 自定义提示词：空串表示用内置默认。key 见 prompts.js 的 PROMPT_FIELDS。 */
    prompts: Object.fromEntries(PROMPT_FIELDS.map((f) => [f.key, ''])),

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
    /** 世界书内容截断长度 */
    worldInfoChars: 6000,
    /** 手填的背景设定（预设里的存档条目插件读不到，可以粘这里） */
    background: '',

    /** 渠道：可以为不同任务分配不同模型 */
    channels: [],
    routing: { choices: '', moves: '', intro: '', profile: '', beats: '' },

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
/**
 * 已经删掉的字段。
 *
 * 老备份里可能还带着它们。导入时不清理，它们会一直躺在设置里，
 * 下次导出又原样带出去，越传越脏。
 */
const LEGACY_KEYS = [
  'enabled',
  'worldInfoBudget',
  'jsonMode',
  'maxReplyTokens',
  'dreamMaxTokens',
  'danmakuChance',
];

/** 导出时的字段顺序：常用的在前，扫一眼能看完 */
const EXPORT_ORDER = [
  'channels',
  'routing',
  'modules',
  'choiceCount',
  'introCount',
  'moveCount',
  'historyDepth',
  'summaryDepth',
  'summaryChars',
  'cardChars',
  'worldInfoChars',
  'tailChars',
  'profileTemplate',
  'worldbookChars',
  'emptyUserPad',
  'useToolChannel',
  'includeWorldInfo',
  'bodyRegex',
  'summaryRegex',
  'worldbook',
  'prompts',
  'auto',
  'autoDelay',
  'retries',
  'historyLimit',
  'theme',
  'hotkey',
  'background',
  'panel',
];

/**
 * 把一份设置洗成「当前版本该有的样子」。
 *
 * 导出和导入都过一遍：
 * - 导出：老字段不带进备份文件
 * - 导入：老备份里的死字段不在设置里复活，缺的字段补全
 *
 * 不这么做的话，一份从 v2.5 传下来的配置会带着几十个没人读的字段，
 * 换台机器恢复时看着一堆陌生键，也不知道哪些还有用。
 */
function normalize(obj) {
  const out = { ...obj };
  for (const k of LEGACY_KEYS) delete out[k];

  const mod = out.modules && typeof out.modules === 'object' ? out.modules : {};
  out.modules = {
    choices: mod.choices !== false,
    danmaku: mod.danmaku === true,
    moves: mod.moves === true,
    intro: mod.intro === true,
  };

  const prompts = out.prompts && typeof out.prompts === 'object' ? out.prompts : {};
  out.prompts = Object.fromEntries(PROMPT_FIELDS.map((f) => [f.key, String(prompts[f.key] ?? '')]));

  const routing = out.routing && typeof out.routing === 'object' ? out.routing : {};
  out.routing = Object.fromEntries(
    ['choices', 'moves', 'intro', 'profile', 'beats'].map((k) => [k, String(routing[k] ?? '')]),
  );

  return out;
}

/** 按固定顺序重排，导出的 JSON 更好读 */
function ordered(obj) {
  const out = {};
  for (const k of EXPORT_ORDER) if (obj[k] !== undefined) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
}

/**
 * 导出：渠道（含密钥）、全部参数、提示词、导入的世界书。
 * 换设备或重装时用它一次性恢复。
 */
export function exportConfig() {
  const s = ordered(normalize(get()));
  const wbEntries = Array.isArray(s.worldbook?.entries) ? s.worldbook.entries : [];

  return JSON.stringify(
    {
      _type: 'meng-push-config',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      // 一眼能看出这份备份里有什么，不用展开几百行 JSON
      summary: {
        channels: Array.isArray(s.channels) ? s.channels.length : 0,
        prompts: Object.keys(s.prompts || {}).filter((k) => s.prompts[k]).length,
        worldbook: {
          entries: wbEntries.length,
          on: wbEntries.filter((e) => e && e.on).length,
          chars: wbEntries.reduce((n, e) => n + String(e?.content || '').length, 0),
        },
      },
      settings: s,
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

  cache = normalize(merge(defaults(), incoming));
  if (!Array.isArray(cache.channels)) cache.channels = [];
  save();
  return cache;
}
