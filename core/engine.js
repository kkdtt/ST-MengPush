/**
 * 编排层。
 *
 * 一轮的流程：
 *   采集上下文 → 拼快照 → 并发/串行请求 → 解析 → 落缓存 → 广播状态
 *
 * 两个刻意的设计：
 *   1. 选项先出、弹幕后补。选项是主菜，先渲染出来，不让用户等弹幕那一路。
 *   2. 结果按 messageId 缓存进 chatMetadata，切回来不重算，也不怕刷新丢。
 */

import { completeWithRetry } from './api.js?v=2.21.0';
import { getChat, getLastMessageId, readChatMeta, writeChatMeta } from './ctx.js?v=2.21.0';
import { buildChatHistory, buildMaterialContext, buildMemoryContext, buildRecentBodies, buildSystemContext, buildUserContext, collectContext, parseJSON } from './parse.js?v=2.21.0';
import { attachResult } from './inspect.js?v=2.21.0';
import { buildTool, readToolArgs } from './tools.js?v=2.21.0';
import { buildBeats, buildChoices, buildDanmaku, buildIntro, buildMoves, buildOutline, buildProfile, buildSteps, getKernel, getPrompt } from './prompts.js?v=2.21.0';
import { channelFor, channelReady, get as getSettings } from './settings.js?v=2.21.0';

const CACHE_KEY = 'meng_push_cache';
const HISTORY_KEY = 'meng_push_history';

/* ---------------- 状态广播 ---------------- */

const listeners = new Set();

const state = {
  status: 'idle', // idle | running | error
  stage: '',
  error: '',
  result: null, // { choices, danmaku, beats, notes, at, messageId }
  history: [],
  story: null, // { keyword, scale, outline, moves, moveCount, busy }
  dream: null, // { messages: [{role, text, at, choices, danmaku}] }
  profile: null, // 最近一次生成的完整角色档案（纯文本）
  /**
   * 每个任务自己的状态：{ status, stage, error, at }。
   *
   * 之前所有任务共用一个 status，跑「走向」的时候「反派行动」的按钮也跟着转，
   * 一个任务失败整页变红。现在各看各的，互不牵连。
   */
  tasks: {},
};

export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

function emit(patch = {}) {
  Object.assign(state, patch);
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (e) {
      console.error('[推进台] 监听器报错', e);
    }
  }
}

export function getState() {
  return state;
}

/* ---------------- 缓存 ---------------- */

function loadCache() {
  return readChatMeta(CACHE_KEY) || {};
}

/** 一层楼的空结果。合并时以它打底，老字段缺了也不会 undefined。 */
function emptyResult(messageId) {
  return {
    choices: [],
    danmaku: [],
    beats: [],
    moves: [],
    intros: [],
    notes: {},
    at: 0,
    messageId,
  };
}

/**
 * 把某个任务的结果并进这一层楼的缓存。
 *
 * 必须「读—改—写」在一步里做完：几个任务并发回来，
 * 谁后写谁说了算，先读一份旧的再写回去会把别人刚写的结果盖掉。
 */
function commitResult(messageId, patch = {}, note) {
  const cache = loadCache();
  const prev = cache[messageId] || {};

  const next = {
    ...emptyResult(messageId),
    ...prev,
    ...patch,
    notes: { ...(prev.notes || {}), ...(note ? { [note.key]: note.value } : {}) },
    at: Date.now(),
    messageId,
  };

  cache[messageId] = next;

  // 只保留最近 40 条，避免 chatMetadata 无限膨胀
  const ids = Object.keys(cache)
    .map(Number)
    .sort((a, b) => a - b);
  while (ids.length > 40) delete cache[ids.shift()];
  writeChatMeta(CACHE_KEY, cache);

  emit({ result: next, history: pushHistory(messageId, next) });
  return next;
}

/** 往轮记录按楼层归并：同一层跑了几项，只留一条。 */
function pushHistory(messageId, result) {
  const history = (readChatMeta(HISTORY_KEY) || []).slice();
  const item = { messageId, at: result.at, choices: result.choices, danmaku: result.danmaku };
  const at = history.findIndex((x) => x && x.messageId === messageId);
  if (at >= 0) history[at] = { ...history[at], ...item };
  else history.push(item);

  const limit = Math.max(4, getSettings().historyLimit || 24);
  while (history.length > limit) history.shift();
  writeChatMeta(HISTORY_KEY, history);
  return history;
}

/** 任务失败时只把提示挂上去，不写缓存——下次还能再跑一遍。 */
function emitNote(messageId, key, value) {
  const base =
    state.result && state.result.messageId === messageId
      ? state.result
      : getCached(messageId) || emptyResult(messageId);
  emit({ result: { ...base, notes: { ...(base.notes || {}), [key]: value }, messageId } });
}

export function getCached(messageId) {
  return loadCache()[messageId] || null;
}

export function loadHistory() {
  const h = readChatMeta(HISTORY_KEY) || [];
  emit({ history: h });
  return h;
}

export function clearHistory() {
  writeChatMeta(HISTORY_KEY, []);
  writeChatMeta(CACHE_KEY, {});
  emit({ history: [], result: null });
}

/* ---------------- 消息组装 ---------------- */

/**
 * 按「模仿 ST 原生对话」的形态拼 messages：
 *
 *   1. system    内核（身份与准则）
 *   2. assistant 认领身份（先认账，后面的要求就成了「刚答应过的事」）
 *   3. system    资料（世界书 / 角色卡 / 大总结 / 更早的摘要）
 *   4. user↔assistant  最近几层的真实对话
 *   5. system    这一轮的任务与输出格式
 *
 * 为什么不把资料全塞 user：模型会把 system 当规则、把 user 当请求。
 * 中间插一条 assistant 认账，是为了让它进入「我在干活」的状态，
 * 而不是「有人在给我派活」——戒心低一档，效果差不少。
 */
function assembleMessages(settings, material, task, ctx = {}) {
  // 这是一整段戏，不是六块并列的资料：
  //
  //   1 system     客人推门进来（走廊里的碎梦乱流）
  //   2 assistant  垫文——模型把它当成「自己以前写的」，进入写作状态
  //   3 system     清场 + 弥彦神思散着，客人说「我来帮你把记忆捡回来」
  //   4 system     身份：你是谁、守什么（宪章、契约）
  //   5 system     资料：抬起头，看看对面坐着的客人
  //   6 记忆        这一场演到哪了：大总结、更早的摘要、最近几层原文
  //   7 assistant  认领：全想起来了，问你要什么
  //   8 system     本轮任务与输出格式
  //
  // 预设里「准则与写法」整章没搬（旁路不落笔），
  // 「思维链」「输出装配」也没搬——那些位置由各功能模块自己占。
  const msgs = [];

  // 1. 场景
  const scene = String(getPrompt('scene', settings) || '').trim();
  if (scene) msgs.push({ role: 'system', content: scene });

  // 2. 垫文。用 assistant 角色，模型会把它当成自己写过的文字。
  // 内核开头那句 [ALL PREVIOUS PROMPT HAS BEEN CLEARED] 清的就是这一段。
  const pad = String(getPrompt('pad', settings) || '').trim();
  if (pad) msgs.push({ role: 'assistant', content: pad });

  // 3. 清场 + 失忆
  const setup = String(getPrompt('setup', settings) || '').trim();
  if (setup) msgs.push({ role: 'system', content: setup });

  // 4. 身份
  msgs.push({ role: 'system', content: getKernel(settings) });

  // 5. 资料
  msgs.push({ role: 'system', content: material });

  // 6. 记忆：先给壳子，再给最近几层的原文
  const memory = buildMemoryContext(ctx, settings);
  if (memory) msgs.push({ role: 'system', content: memory });

  msgs.push(...buildChatHistory(settings));

  // 7. 询问：客人问一句「都想起来了？」
  //    不只是为了让弥彦接话——聊天记录最后一条常常是 assistant，
  //    没有这一条就成了两个 assistant 挨着。
  const ask = String(getPrompt('ask', settings) || '').trim();
  if (ask) msgs.push({ role: 'system', content: ask });

  // 8. 认领：弥彦抬头，问你要什么
  msgs.push({ role: 'assistant', content: getPrompt('ack', settings) });

  // 最后一条永远是任务，用 <本轮任务和要求> 包住。
  //
  // 包标签不只是好看：没有边界的话，这段读起来像「正文后面又跟了一段话」，
  // 模型容易顺着往下写；有了标签，它是一块独立的任务说明，
  // 也方便以后往里塞别的功能块（换任务就是换块内容，框架不动）。
  //
  // 末尾那句话有两个作用：
  //   1. 对模型：明确「按格式交结果」，别顺着对话往下写
  //   2. 对预设的「结构化传输」脚本：它见到「接着上一句往下写」会按「扮演续写」放行，
  //      不再接管我们的请求。否则上下文会被它挪进 tools，检视页只剩几条流水线外壳。
  msgs.push({
    role: 'system',
    content:
      '<本轮任务和要求>\n' +
      task +
      '\n\n（这是内部任务：不要接着上一句往下写，直接按上面的格式交出结果。）\n' +
      '</本轮任务和要求>',
  });
  return msgs;
}

/**
 * 拼一份「这次会发出去的东西」给你看，不真的发请求。
 *
 * 只拼装、不校验渠道——没配渠道也能预览，方便调提示词时反复看。
 * 中间那条空 user 是刻意留的，预览里用占位符标出来，
 * 免得看起来像「少了一段」。
 */
export async function previewMessages() {
  const settings = getSettings();
  const ctx = await collectContext(settings);
  const material = buildMaterialContext(ctx, settings);
  // 任务段用占位符：它随功能变（走向 / 反派 / 新人 / 大纲…），
  // 预览时拼真的没意义，能看出「这里是那块会变的内容」就够了。
  return assembleMessages(
    settings,
    material,
    '（本轮任务的占位 —— 实际会换成走向 / 反派 / 新人 / 大纲 / 拆解 / 节拍 / 档案 对应那一段提示词和输出格式。）',
    ctx,
  );
}

/**
 * 统一调用：按设置决定走工具通道还是文本通道。
 *
 * 工具通道下，内容在 tool_calls 的 arguments 里，不进 content。
 * 好处是断流时能按半截 JSON 救回来，且触发上游内容过滤的概率更低。
 * 渠道不支持 tools 时自动降级回文本，不让整轮失败。
 */
async function callTask(ch, task, messages, opts, settings) {
  // 流式下拿不到可靠的 tool_calls，所以流式时不走工具通道
  const stream = !!ch.stream;
  const tool = settings.useToolChannel && !stream ? buildTool(task) : null;

  // 优先级：调用方指定（梦中梦）> 渠道设置 > 全局
  // 上限一律看渠道：渠道里填了就发，没填就不发，让上游用自己的默认。
  // 插件不再自己拍一个数字，省得两边对不上还查不出来。
  const replyCap = Number(ch.maxTokens) > 0 ? Number(ch.maxTokens) : 0;
  const baseOpts = { ...opts };
  if (replyCap > 0) baseOpts.maxTokens = replyCap;
  else delete baseOpts.maxTokens;

  if (!tool) {
    const res = await completeWithRetry(ch, messages, { ...baseOpts, stream });
    attachResult({ reason: 'text', finishReason: res.finishReason, chars: res.content?.length });
    return { ...res, args: null };
  }

  try {
    const res = await completeWithRetry(ch, withToolHint(messages), {
      ...baseOpts,
      stream,
      tools: [tool],
      // 必须是 required，不能是 auto。
      // auto 下模型看到任务段里「直接以 <option> 开头」就照做了，压根不调工具——
      // 这就是之前同一批请求里有的 ✓ 有的 ✗ 的原因，纯粹看模型那一轮的心情。
      toolChoice: 'required',
    });

    const args = readToolArgs({ tool_calls: res.toolCalls });
    if (args) {
      attachResult({
        reason: 'tool',
        toolName: res.toolCalls?.[0]?.function?.name || '',
        finishReason: res.finishReason,
        chars: 0,
      });
      return { ...res, args };
    }

    // required 下还没调工具，说明这个模型不配合，但它给了正文——按文本解析
    if (res.content && res.content.trim()) {
      attachResult({ reason: 'notool', finishReason: res.finishReason, chars: res.content.length });
      return { ...res, args: null };
    }

    throw new Error('工具通道返回空');
  } catch (e) {
    console.warn('[推进台] 工具通道失败，降级文本', e);
    const res = await completeWithRetry(ch, messages, { ...baseOpts, stream });
    attachResult({ reason: 'degraded', finishReason: 'degraded', chars: res.content?.length });
    return { ...res, args: null, degraded: true };
  }
}

/**
 * 工具通道专用：在任务段末尾补一句「用工具交」。
 *
 * 提示词是给文本通道写的，里面写着「直接以 <option> 开头，不要代码块」——
 * 模型看到这句就老老实实写标签，不会去调工具。这句只在走工具通道时加，
 * 不动用户自己写的提示词。
 */
function withToolHint(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'system') return messages;

  const hint = '（用 submit 工具提交结果，不要把内容写在正文里。）';
  const body = String(last.content || '');
  if (body.includes(hint)) return messages;

  const next = /<\/本轮任务和要求>\s*$/.test(body)
    ? body.replace(/<\/本轮任务和要求>\s*$/, `${hint}\n</本轮任务和要求>`)
    : `${body}\n${hint}`;

  return [...messages.slice(0, -1), { ...last, content: next }];
}

/* ---------------- 主流程 ---------------- */

let currentAbort = null;
/** 每个任务自己的取消控制器：重跑「走向」不该顺手杀掉「反派行动」 */
const taskAborts = new Map();
/** 正在跑的东西：任务名或 story / dream / profile → { stage } */
const runners = new Map();

function signalFor(task, parentSignal) {
  taskAborts.get(task)?.abort();
  const c = new AbortController();
  taskAborts.set(task, c);
  if (parentSignal) parentSignal.addEventListener('abort', () => c.abort(), { once: true });
  return c.signal;
}

/**
 * 任务表：每个任务怎么拼提示词、怎么解析、结果落到哪个字段。
 *
 * 以前这些都散在 run() 的 if 分支里，加一个任务要改四处；
 * 现在一张表说清楚，调度只负责「谁在跑、跑完怎么落」。
 */
const TASK_SPECS = {
  choices: {
    label: '走向',
    stage: '生成中',
    field: 'choices',
    note: 'choices',
    retries: (s) => s.retries,
    build: (s) => buildChoices(s),
    parse: (raw, s) => parseChoices(raw, s.choiceCount),
  },
  danmaku: {
    label: '弹幕',
    stage: '生成中',
    field: 'danmaku',
    note: 'danmaku',
    retries: () => 0,
    // 自动跑的时候按概率跳过，手动点必跑
    gate: (s, opts) => !!opts.manual || Math.random() < (s.danmakuChance ?? 0.4),
    build: (s) => buildDanmaku(s),
    parse: (raw) => parseDanmaku(raw),
  },
  moves: {
    label: '反派行动',
    stage: '有人要动手了',
    field: 'moves',
    note: 'moves',
    retries: () => 0,
    build: (s) => buildMoves(s, { count: s.moveCount || 4 }),
    parse: (raw) => parseMoves(raw),
  },
  intro: {
    label: '新人',
    // 上限 10：再多模型就开始灌水，每个人只剩两句话
    stage: (s) => `在想 ${Math.min(10, Math.max(1, Number(s.introCount) || 3))} 个新人`,
    field: 'intros',
    note: 'intro',
    retries: () => 0,
    build: (s) => buildIntro(s, { count: Math.min(10, Math.max(1, Number(s.introCount) || 3)) }),
    parse: (raw) => parseIntros(raw),
  },
  beats: {
    label: '节拍',
    stage: '排节拍',
    field: 'beats',
    note: 'beats',
    retries: () => 0,
    build: (s) => buildBeats(s),
    parse: (raw) => parseBeats(raw),
  },
};

/** 自动跑哪几项：只看设置里勾了哪些，跟当前打开哪一页无关。 */
export function autoTasks(settings = getSettings()) {
  const mod = settings.modules || {};
  const out = [];
  if (mod.choices !== false) out.push('choices');
  if (mod.moves === true) out.push('moves');
  if (mod.intro === true) out.push('intro');
  if (mod.danmaku === true) out.push('danmaku');
  return out;
}

/* ---------------- 状态 ---------------- */

function syncStatus() {
  const list = [...runners.values()];
  if (list.length) {
    emit({ status: 'running', stage: list.map((r) => r.stage).filter(Boolean).join(' · ') });
  } else if (state.status === 'running') {
    emit({ status: 'idle', stage: '' });
  }
}

function startRunner(key, stage = '') {
  runners.set(key, { stage });
  emit({ status: 'running', stage, error: '' });
}

function setRunnerStage(key, stage) {
  const r = runners.get(key);
  if (!r) return;
  r.stage = stage;
  syncStatus();
}

function endRunner(key) {
  runners.delete(key);
  syncStatus();
}

function emitTask(task, patch) {
  const prev = state.tasks[task] || { status: 'idle', stage: '', error: '', at: 0 };
  emit({ tasks: { ...state.tasks, [task]: { ...prev, ...patch } } });
}

/**
 * 跑一个任务。
 *
 * 各跑各的：自己的取消控制器、自己的状态、自己的错误。
 * 一个任务挂了只在自己那页显示，不牵连别的，也不改全局 error。
 */
async function runTask(task, opts = {}) {
  const spec = TASK_SPECS[task];
  if (!spec) throw new Error('未知任务：' + task);

  const settings = getSettings();
  const ch = channelFor(task);
  if (!channelReady(ch)) {
    emitTask(task, { status: 'error', stage: '', error: '先去设置里配一个渠道（地址 + 模型名）' });
    return;
  }

  if (spec.gate && !spec.gate(settings, opts)) {
    emitNote(getLastMessageId(), spec.note, 'skipped');
    return;
  }

  // 同一任务重跑：先掐掉上一次，免得两个结果互相覆盖
  taskAborts.get(task)?.abort();
  const ctrl = new AbortController();
  taskAborts.set(task, ctrl);

  const stage = typeof spec.stage === 'function' ? spec.stage(settings) : spec.stage;
  startRunner(task, stage);
  emitTask(task, { status: 'running', stage, error: '' });

  /**
   * 这一跑还是不是当前这一跑。
   *
   * 同一个任务被重跑时，旧的请求要等一拍才会 reject；
   * 那一拍里新的一跑已经登记好了，旧的不许再改状态、不许再写结果，
   * 否则界面刚显示「生成中」，又被旧的置回「待命」。
   */
  const owns = () => taskAborts.get(task) === ctrl;

  let id = getLastMessageId();

  try {
    // 上下文几个任务共用一份（run() 里采过一次就传进来），单独跑才自己采
    const ctx = opts.ctx || (await collectContext(settings));
    const material = opts.material !== undefined ? opts.material : buildMaterialContext(ctx, settings);
    id = ctx.lastBodyId;

    const res = await callTask(
      ch,
      task,
      assembleMessages(settings, material, spec.build(settings), ctx),
      { signal: ctrl.signal, retries: spec.retries(settings), stream: false },
      settings,
    );

    if (!owns()) return;

    const list = spec.parse(res.args || res.content, settings);
    commitResult(id, { [spec.field]: list }, { key: spec.note, value: list.length ? '' : 'empty' });
    emitTask(task, { status: 'idle', stage: '', error: '', at: Date.now() });
  } catch (e) {
    if (!owns()) return;
    if (ctrl.signal.aborted) {
      emitTask(task, { status: 'idle', stage: '', error: '' });
      emitNote(id, spec.note, 'cancelled');
    } else {
      const msg = e?.message || String(e);
      console.warn(`[推进台] ${spec.label}失败`, e);
      emitTask(task, { status: 'error', stage: '', error: msg });
      emitNote(id, spec.note, 'error:' + msg);
    }
  } finally {
    if (owns()) {
      taskAborts.delete(task);
      endRunner(task);
    }
  }
}

/**
 * 跑一组任务。
 * @param {{tasks?: string[], manual?: boolean}} opts
 *   tasks 不传时按设置里的开关走；传了就只跑这几项，其余保留上次的结果。
 */
export async function run(opts = {}) {
  const settings = getSettings();

  const ch = channelFor('choices');
  if (!channelReady(ch)) {
    emit({ status: 'error', stage: '', error: '先去设置里配一个渠道（地址 + 模型名）' });
    return;
  }

  const tasks = (opts.tasks && opts.tasks.length ? opts.tasks : autoTasks(settings)).filter(
    (t) => TASK_SPECS[t],
  );
  if (!tasks.length) return;

  // 上下文只采一次（世界书扫描不便宜），几个任务共用；之后各自并发，互不等待
  let ctx;
  try {
    ctx = await collectContext(settings);
  } catch (e) {
    emit({ status: 'error', stage: '', error: '采集上下文失败：' + (e?.message || e) });
    return;
  }
  const material = buildMaterialContext(ctx, settings);

  await Promise.all(tasks.map((t) => runTask(t, { ...opts, ctx, material })));
}

export function cancel() {
  const ctrls = [...taskAborts.values()];
  taskAborts.clear();
  for (const c of ctrls) {
    try {
      c.abort();
    } catch {
      /* 已经结束了 */
    }
  }
  currentAbort?.abort();

  // 控制器已经摘掉，被取消的那几跑回来也认不出自己了，这里一次性收干净
  runners.clear();
  const tasks = {};
  for (const [k, v] of Object.entries(state.tasks)) {
    tasks[k] = { ...v, status: 'idle', stage: '' };
  }
  emit({ tasks, status: 'idle', stage: '', error: '' });
}

export function isRunning() {
  return runners.size > 0;
}

/**
 * 直接跑一项，不改动其他项。面板上每个页面自己的按钮都走这里。
 */
export function runOne(task) {
  return run({ manual: true, tasks: [task] });
}

/* ---------------- 结果规整 ---------------- */

/**
 * 解析弹幕。模型不一定老实给 JSON，所以三级兜底：
 *   1. 标准 {"danmaku":[...]}
 *   2. 裸数组 [...]
 *   3. 按行抠——去掉编号、引号、项目符号，留下像弹幕的短句
 */
export function parseDanmaku(input) {
  if (input && typeof input === 'object') {
    const arr = Array.isArray(input.danmaku) ? input.danmaku : [];
    return cleanList(arr);
  }

  const raw = String(input || '').trim();
  if (!raw) return [];

  // ① <dm>…</dm>，逐条闭合，截断不影响已闭合的部分
  const out = [];
  const re = /<dm\b[^>]*>([\s\S]*?)<\/dm>/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const s = m[1].replace(/\s+/g, ' ').trim();
    if (s) out.push(s);
  }
  if (out.length) return cleanList(out);

  // ② 标准 {"danmaku":[...]}
  const j = parseJSON(raw);
  if (j && Array.isArray(j.danmaku)) return cleanList(j.danmaku);

  // ③ 裸数组 [...]
  const arr = /^\s*\[[\s\S]*\]\s*$/.exec(raw);
  if (arr) {
    try {
      const parsed = JSON.parse(arr[0]);
      if (Array.isArray(parsed)) return cleanList(parsed);
    } catch {
      /* 落到按行抠 */
    }
  }

  // ④ 按行抠——去掉编号、引号、项目符号，留下像弹幕的短句
  const lines = raw
    .split(/\r?\n/)
    .map((s) =>
      s
        .replace(/^\s*(?:[-*•·]|\d+[.、)）])\s*/, '')
        .replace(/^["'「『]|["'」』,，。]$/g, '')
        .trim(),
    )
    .filter((s) => s.length >= 2 && s.length <= 30 && !/[{}[\]<>]/.test(s) && !/^(danmaku|json)$/i.test(s));

  return cleanList(lines);
}

function cleanList(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const s = String(item ?? '')
      .replace(/^["'「『]|["'」』]$/g, '')
      .trim();
    if (!s || s.length > 40 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 8) break;
  }
  return out;
}

/** 解析节拍表。字段缺失时给空串，前端按空处理。 */
export function parseBeats(input) {
  if (input && typeof input === 'object') {
    const arr = Array.isArray(input.beats) ? input.beats : [];
    return normalizeBeats(arr);
  }

  const raw = String(input || '');
  const out = [];

  // ① <beat phase="前戏" n="1"> action: … react: … friction: … </beat>
  const re = /<beat\b([^>]*)>([\s\S]*?)<\/beat>/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const attrs = parseAttrs(m[1]);
    const body = m[2];
    const field = (name) => {
      const hit = new RegExp(name + '\\s*[:：]\\s*([^\\n]+)', 'i').exec(body);
      return hit ? hit[1].trim() : '';
    };
    const action = field('action') || body.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!action) continue;
    out.push({
      phase: attrs.phase || '',
      n: Number(attrs.n) || out.length + 1,
      action,
      react: field('react'),
      friction: field('friction'),
    });
    if (out.length >= 16) break;
  }
  if (out.length) return out;

  // ② JSON 兜底
  const j = parseJSON(raw);
  return normalizeBeats(Array.isArray(j?.beats) ? j.beats : []);
}

function normalizeBeats(arr) {
  const out = [];
  for (const b of arr) {
    if (!b) continue;
    const action = String(b.action ?? '').trim();
    if (!action) continue;
    out.push({
      phase: String(b.phase ?? '').trim(),
      n: Number.isFinite(Number(b.n)) ? Number(b.n) : out.length + 1,
      action,
      react: String(b.react ?? '').trim(),
      friction: String(b.friction ?? '').trim(),
    });
    if (out.length >= 16) break;
  }
  return out;
}

const TYPES = ['顺承', '横向', '升温', '切场', '破局', '退让'];
const RISKS = ['低', '中', '高'];

/** 解析标签属性：type="顺承" risk="低" */
function parseAttrs(s) {
  const out = {};
  const re = /([\w-]+)\s*=\s*"([^"]*)"|([\w-]+)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) out[m[1]] = m[2];
    else if (m[3]) out[m[3]] = m[4];
  }
  return out;
}

/**
 * 解析走向。优先读 <option> 标签，读不到再退回 JSON。
 *
 * 为什么用标签而不是 JSON：标签逐条闭合，流式生成时每收一个 </option>
 * 就能解析出一条，后面被截断也不影响前面已经拿到的。JSON 是整体结构，
 * 截断一个字符就全废——这就是「抗截断」的全部意义。
 */
export function parseChoices(input, limit) {
  // 工具通道直接把参数对象递进来，省掉解析
  if (input && typeof input === 'object') {
    return finishChoices(normalizeChoiceList(Array.isArray(input.choices) ? input.choices : [], limit), limit);
  }

  const raw = String(input || '');
  const out = [];

  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const attrs = parseAttrs(m[1]);
    const body = m[2].replace(/\s+/g, ' ').trim();
    if (!body) continue;
    out.push({
      type: TYPES.includes(attrs.type) ? attrs.type : '顺承',
      text: body.slice(0, 60),
      risk: RISKS.includes(attrs.risk) ? attrs.risk : '中',
    });
    if (out.length >= limit) break;
  }

  if (!out.length) {
    const j = parseJSON(raw);
    const arr = Array.isArray(j?.choices) ? j.choices : [];
    for (const c of arr) {
      if (!c) continue;
      const body = String(c.text ?? c.content ?? '').trim();
      if (!body) continue;
      out.push({
        type: TYPES.includes(String(c.type)) ? String(c.type) : '顺承',
        text: body.slice(0, 60),
        risk: RISKS.includes(String(c.risk)) ? String(c.risk) : '中',
      });
      if (out.length >= limit) break;
    }
  }

  return finishChoices(out, limit);
}

/** 把工具参数里的数组规整成统一的选项结构。 */
function normalizeChoiceList(arr, limit) {
  const out = [];
  for (const c of arr) {
    if (!c) continue;
    const body = String(c.text ?? c.content ?? '').trim();
    if (!body) continue;
    out.push({
      type: TYPES.includes(String(c.type)) ? String(c.type) : '顺承',
      text: body.slice(0, 60),
      risk: RISKS.includes(String(c.risk)) ? String(c.risk) : '中',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 模型没给够时，把「退让」补上——这一类最容易被漏，但它是唯一的出口。 */
function finishChoices(out, limit) {
  if (out.length && !out.some((c) => c.type === '退让') && out.length < limit) {
    out.push({ type: '退让', text: '什么都不做，先看着', risk: '低' });
  }
  return out;
}

/* ---------------- 自动触发 ---------------- */

/**
 * 自动任务只在「酒馆正文这一版真的写完了」之后跑。
 *
 * 判据是捕获到主对话请求的响应体读完（inspect.js 那层 fetch hook 报上来的）。
 * 插件自己发的请求带 self 标记，不算——不然自己跑一次走向，
 * 就会被当成「正文写完了」再触发一轮，越跑越多。
 *
 * 光有请求结束还不够：那一刻 ST 还在解析，chat 数组里还没有新楼层，
 * 采到的上下文仍是上一轮的。所以要等楼层真的变了再跑。
 *
 * 等不到也不无限等——超时就按已经落盘的内容跑一次。
 */
let lastAutoId = -1;
let autoToken = 0;
let autoTimer = null;
let lastCaptureAt = 0;

/** 楼层快照：楼层数、最后一层是谁、最后一层多长。任一变化都算「落盘了」。 */
function snapshotChat() {
  const chat = getChat();
  const last = chat[chat.length - 1];
  return {
    len: chat.length,
    lastLen: last ? String(last.mes || '').length : -1,
  };
}

function armAuto({ waitCommit }) {
  if (!getSettings().auto) return;

  const token = ++autoToken;
  const base = snapshotChat();
  const delay = Math.max(120, Number(getSettings().autoDelay) || 700);
  const deadline = Date.now() + 8000;

  clearTimeout(autoTimer);

  const tick = () => {
    if (token !== autoToken) return; // 期间又来了新一轮，这一轮作废
    if (!getSettings().auto) return;

    if (!waitCommit) {
      fireAuto();
      return;
    }

    const cur = snapshotChat();
    const committed = cur.len !== base.len || cur.lastLen !== base.lastLen;
    if (committed || Date.now() > deadline) {
      fireAuto();
      return;
    }
    autoTimer = setTimeout(tick, 100);
  };

  autoTimer = setTimeout(tick, delay);
}

function fireAuto() {
  const settings = getSettings();
  if (!settings.auto) return;

  const id = getLastMessageId();
  if (id < 0) return;

  // 同一层楼只自动跑一次：swipe、重绘、切回来都不再重复
  if (id === lastAutoId) return;
  lastAutoId = id;

  // 这一层已经算过了就不再花钱，直接把结果摆出来
  const cached = getCached(id);
  if (cached) {
    emit({ result: cached });
    return;
  }

  const tasks = autoTasks(settings);
  if (!tasks.length) return;

  void run({ manual: false, tasks }).catch((e) => console.warn('[推进台] 自动任务失败', e));
}

/**
 * 捕获层报到：主对话这一版正文写完了（不含插件自己的请求）。
 */
export function onMainBodyCaptured() {
  lastCaptureAt = Date.now();
  armAuto({ waitCommit: true });
}

/**
 * ST 的生成结束事件。只在捕获层没工作时兜底——
 * 有些后端（非 chat-completions）不走那个端点，抓不到。
 */
export function onGenerationEnded() {
  if (Date.now() - lastCaptureAt < 8000) return;
  armAuto({ waitCommit: false });
}

/** 换聊天、换 swipe：把排着的那一轮取消掉，别让它跑在错的地方。 */
export function resetAutoGuard() {
  autoToken++;
  clearTimeout(autoTimer);
  lastAutoId = -1;
  lastCaptureAt = 0;
}

/* ---------------- 剧情创作 ---------------- */

const STORY_KEY = 'meng_push_story';

/** 推进幅度 → 默认段数。 */
export function getStory() {
  return (
    readChatMeta(STORY_KEY) || {
      keyword: '',
      scale: 'medium',
      outline: [],
      steps: [],
      stepCount: 5,
      moves: [],
      moveCount: 4,
      at: 0,
    }
  );
}

export function saveStory(patch) {
  const next = { ...getStory(), ...patch };
  writeChatMeta(STORY_KEY, next);
  emit({ story: next });
  return next;
}

export function loadStory() {
  emit({ story: getStory() });
  return getStory();
}

export function clearStory() {
  writeChatMeta(STORY_KEY, null);
  emit({ story: null });
}

export function parseOutline(input) {
  if (input && typeof input === 'object') {
    const arr = Array.isArray(input.outline) ? input.outline : [];
    return arr
      .filter((o) => o && String(o.text || '').trim())
      .slice(0, 12)
      .map((o, i) => ({
        n: Number(o.n) || i + 1,
        title: String(o.title || '').trim(),
        text: String(o.text).trim(),
      }));
  }

  const out = [];
  const re = /<outline\b([^>]*)>([\s\S]*?)<\/outline>/gi;
  let m;
  while ((m = re.exec(String(input || ''))) !== null) {
    const attrs = parseAttrs(m[1]);
    const body = m[2].replace(/\s+/g, ' ').trim();
    if (!body) continue;
    out.push({
      n: Number(attrs.n) || out.length + 1,
      title: String(attrs.title || '').trim(),
      text: body,
    });
    if (out.length >= 10) break;
  }
  return out;
}

export function parseSteps(input) {
  if (input && typeof input === 'object') {
    const arr = Array.isArray(input.steps) ? input.steps : [];
    return arr
      .filter((x) => x && String(x.text || '').trim())
      .slice(0, 20)
      .map((x, i) => ({ n: Number(x.n) || i + 1, text: String(x.text).trim() }));
  }

  const raw = String(input || '');
  const out = [];
  const re = /<step\b([^>]*)>([\s\S]*?)<\/step>/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const attrs = parseAttrs(m[1]);
    const body = m[2].replace(/\s+/g, ' ').trim();
    if (!body) continue;
    out.push({ n: Number(attrs.n) || out.length + 1, text: body });
    if (out.length >= 20) break;
  }
  return out;
}

export function parseMoves(input) {
  if (input && typeof input === 'object') {
    return normalizeMoves(Array.isArray(input.moves) ? input.moves : []);
  }

  const raw = String(input || '');
  const out = [];
  const re = /<move\b([^>]*)>([\s\S]*?)<\/move>/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const attrs = parseAttrs(m[1]);
    const body = m[2];
    const field = (name) => {
      const hit = new RegExp(name + '\\s*[:：]\\s*([^\\n]+)', 'i').exec(body);
      return hit ? hit[1].trim() : '';
    };
    const act = field('act');
    if (!act) continue;
    out.push({
      n: Number(attrs.n) || out.length + 1,
      who: String(attrs.who || '').trim(),
      risk: String(attrs.risk || '').trim(),
      nsfw: attrs.nsfw === '1' || attrs.nsfw === 'true',
      act,
      gain: field('gain'),
      cost: field('cost'),
    });
    if (out.length >= 12) break;
  }
  return out;
}

function normalizeMoves(arr) {
  const out = [];
  for (const x of arr) {
    if (!x) continue;
    const act = String(x.act ?? '').trim();
    if (!act) continue;
    out.push({
      n: Number(x.n) || out.length + 1,
      who: String(x.who || '').trim(),
      risk: String(x.risk || '').trim(),
      nsfw: x.nsfw === 1 || x.nsfw === true || x.nsfw === '1',
      act,
      gain: String(x.gain || '').trim(),
      cost: String(x.cost || '').trim(),
    });
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * 创作页的两个动作。
 *   runStory('outline', { keyword, scale })  → 出大纲
 *   runStory('moves', { count })             → 让某个人动手
 */
export async function runStory(action, params = {}) {
  const settings = getSettings();

  const ch = channelFor('choices');
  if (!channelReady(ch)) {
    emit({ status: 'error', error: '先去设置里配一个渠道' });
    return;
  }

  currentAbort?.abort();
  const abort = new AbortController();
  currentAbort = abort;

  startRunner('story', action === 'outline' ? '排大纲' : '拆步骤');

  try {
    const ctx = await collectContext(settings);
    const material = buildMaterialContext(ctx, settings);

    if (action === 'outline') {
      // 幅度默认不传——用户没选就不该在提示词里出现，否则模型会照着幅度自己定节奏
      const scale = params.scale || '';
      // 段数由用户直接指定，不再跟幅度绑定（之前 heavy 卡在 6 段）
      const count = Math.min(12, Math.max(1, Number(params.count) || 4));
      const res = await callTask(
        ch,
        'outline',
        assembleMessages(
          settings,
          material,
          buildOutline(settings, { keyword: params.keyword, scale, count }),
          ctx,
        ),
        { signal: abort.signal, retries: settings.retries, stream: false },
        settings,
      );
      const outline = parseOutline(res.args || res.content);
      if (!outline.length) throw new Error('模型没给出可用的大纲');
      saveStory({ keyword: params.keyword || '', scale, outlineCount: count, outline, steps: [], moves: [], at: Date.now() });
    } else {
      const story = getStory();
      if (!story.outline?.length) throw new Error('还没有大纲，先出大纲');
      const outlineText = story.outline.map((o) => `${o.n}. ${o.title ? o.title + '：' : ''}${o.text}`).join('\n');

      if (action === 'steps') {
        const count = Math.min(12, Math.max(2, params.count || 5));
        const res = await callTask(
          ch,
          'steps',
          assembleMessages(
            settings,
            material,
            '【已定的大纲】\n' + outlineText + '\n\n---\n\n' + buildSteps(settings, { count }),
            ctx,
          ),
          { signal: abort.signal, retries: settings.retries, stream: false },
          settings,
        );
        const steps = parseSteps(res.args || res.content);
        if (!steps.length) throw new Error('模型没给出可用的步骤');
        saveStory({ steps, stepCount: count, at: Date.now() });
      } else {
        const count = Math.min(12, Math.max(1, params.count || 4));
        const res = await callTask(
          ch,
          'moves',
          assembleMessages(
            settings,
            material,
            '【已定的大纲】\n' + outlineText + '\n\n---\n\n' + buildMoves(settings, { count }),
            ctx,
          ),
          { signal: abort.signal, retries: settings.retries, stream: false },
          settings,
        );
        const moves = parseMoves(res.args || res.content);
        if (!moves.length) throw new Error('模型没给出可用的行动');
        saveStory({ moves, moveCount: count, at: Date.now() });
      }
    }

    emit({ status: 'idle', stage: '' });
  } catch (e) {
    if (abort.signal.aborted) {
      emit({ status: 'idle', stage: '', error: '已取消' });
    } else {
      console.error('[推进台] 创作失败', e);
      emit({ status: 'error', stage: '', error: e?.message || String(e) });
    }
  } finally {
    if (currentAbort === abort) currentAbort = null;
    endRunner('story');
  }
}

/**
 * 把选中的新人展开成完整档案。
 * 跟 runStory 不同，它是一次性的：生成完直接给文本，不存状态树。
 */
export async function runProfile(target) {
  const settings = getSettings();

  const base = channelFor('choices');
  const ch = channelFor('profile') || base;
  if (!channelReady(ch)) {
    emit({ status: 'error', error: '先去设置里配一个渠道' });
    return;
  }

  const abort = new AbortController();
  currentAbort = abort;
  startRunner('profile', '写档案');
  emit({ profile: null });

  try {
    const ctx = await collectContext(settings);
    const material = buildMaterialContext(ctx, settings);

    const introText = [
      `姓名：${target?.name || ''}`,
      target?.tag ? `定位：${target.tag}` : '',
      target?.relation ? `关系：${target.relation}` : '',
      target?.entry ? `由头：${target.entry}` : '',
      target?.hook ? `细节：${target.hook}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const res = await callTask(
      ch,
      'profile',
      assembleMessages(
        settings,
        material,
        buildProfile(settings, { name: target?.name || '', intro: introText, template: target?.template || '' }),
        ctx,
      ),
      { signal: signalFor('profile', abort.signal), retries: settings.retries, stream: false },
      settings,
    );

    const text = parseProfile(res.args?.profile || res.content);
    if (!text) throw new Error('模型没给出档案');
    emit({ status: 'idle', stage: '', profile: text });
  } catch (e) {
    if (abort.signal.aborted) {
      emit({ status: 'idle', stage: '', error: '已取消' });
    } else {
      console.error('[推进台] 档案构建失败', e);
      emit({ status: 'error', stage: '', error: e?.message || String(e) });
    }
  } finally {
    if (currentAbort === abort) currentAbort = null;
    endRunner('profile');
  }
}

/* ---------------- 梦中梦 ---------------- */

const DREAM_KEY = 'meng_push_dream';
const DREAM_KEEP = 12; // 只带最近 12 轮进上下文
/** 梦中梦带最近几段正文。3 条完整输出，比截 3000 字尾部有用 */
const DREAM_RECENT = 3;

export function getDream() {
  const d = readChatMeta(DREAM_KEY);
  return d && Array.isArray(d.messages) ? d : { messages: [], at: 0 };
}

export function saveDream(patch) {
  const next = { ...getDream(), ...patch };
  writeChatMeta(DREAM_KEY, next);
  emit({ dream: next });
  return next;
}

export function loadDream() {
  const d = getDream();
  emit({ dream: d });
  return d;
}

/**
 * 改某一条。
 *
 * 只动这一条，前后都保留——改完接着往下聊，模型看到的就是改过的版本。
 * 记一个 editedAt，方便以后想标「这条改过」。
 */
export function updateDreamMessage(index, text) {
  const d = getDream();
  if (!d.messages[index]) return d;
  const body = String(text ?? '').trim();
  if (!body) return d;

  const messages = d.messages.map((m, i) =>
    i === index ? { ...m, text: body, editedAt: Date.now() } : m,
  );
  return saveDream({ messages });
}

/** 删某一条。删完后面的顺次前移，index 不用重算。 */
export function deleteDreamMessage(index) {
  const d = getDream();
  const messages = d.messages.filter((_, i) => i !== index);
  return saveDream({ messages });
}

export function clearDream() {
  writeChatMeta(DREAM_KEY, null);
  emit({ dream: { messages: [], at: 0 } });
}

/** 去掉所有标签，模型没给 <say> 时的兜底。 */
function stripTags(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 清掉 markdown 标记。
 * 弥彦是个坐在铺子里说话的人，不该满口 **加粗** 和 #### 标题。
 * 模型很爱用它，靠提示词约束不完全管用，这里再兜一层。
 */
export function stripMarkdown(text) {
  return String(text || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 解析新人介绍。
 *
 * 一次可以出好几个，所以返回数组。字段值可能跨行（private 尤其），
 * 用「到下一个字段名之前」来截，不能只取一行。
 */
export function parseIntros(input) {
  const pick = (o) => {
    if (!o || !o.name) return null;
    return {
      name: String(o.name || '').trim(),
      tag: String(o.tag || '').trim(),
      relation: String(o.relation || '').trim(),
      entry: String(o.entry || '').trim(),
      hook: String(o.hook || '').trim(),
      priv: String(o.private ?? o.priv ?? '').trim(),
    };
  };

  // 工具通道：参数已经是结构化的
  if (input && typeof input === 'object') {
    const arr = Array.isArray(input.intros)
      ? input.intros
      : Array.isArray(input.intro)
        ? input.intro
        : Array.isArray(input)
          ? input
          : [input.intro || input];
    return arr.map(pick).filter(Boolean).slice(0, 10);
  }

  const raw = String(input || '');
  const out = [];
  const re = /<intro\b([^>]*)>([\s\S]*?)<\/intro>/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const attrs = parseAttrs(m[1]);
    const body = m[2];
    const name = String(attrs.name || '').trim();
    if (!name) continue;

    const field = (key) => {
      const hit = new RegExp(
        '^' + key + '\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*(?:relation|entry|hook|private)\\s*[:：]|$)',
        'im',
      ).exec(body);
      return hit ? hit[1].trim() : '';
    };

    out.push({
      name,
      tag: String(attrs.tag || '').trim(),
      relation: field('relation'),
      entry: field('entry'),
      hook: field('hook'),
      priv: field('private'),
    });
    if (out.length >= 10) break;
  }
  return out;
}

/** 只要第一个。旧调用点用这个。 */
export function parseIntro(input) {
  return parseIntros(input)[0] || null;
}

export function parseProfile(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input || '');
  const m = /<profile>([\s\S]*?)<\/profile>/i.exec(raw);
  return (m ? m[1] : stripTags(raw)).trim();
}

export function parseDream(input) {
  if (input && typeof input === 'object') {
    const say = stripMarkdown(String(input.say || '').trim());
    return {
      say: say || '（他没说话，只是把灯挪近了一点。）',
      choices: parseChoices({ choices: input.choices || [] }, 6),
      danmaku: parseDanmaku({ danmaku: input.danmaku || [] }),
    };
  }

  const raw = String(input || '');

  // 续写可能产生多个 <say> 块，全部按顺序拼起来
  const blocks = [...raw.matchAll(/<say>([\s\S]*?)<\/say>/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);

  let say = blocks.join('\n\n');

  if (blocks.length) {
    // 续写的内容通常没有包 <say>，会落在最后一个 </say> 之后，也算正文
    const lastClose = raw.lastIndexOf('</say>');
    if (lastClose >= 0) {
      const tail = raw
        .slice(lastClose + 6)
        .replace(/<(option|dm)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]+>/g, '')
        .trim();
      if (tail) say = say ? say + '\n\n' + tail : tail;
    }
  } else {
    say = stripTags(raw);
  }

  say = stripMarkdown(say);

  return {
    say: say || '（他没说话，只是把灯挪近了一点。）',
    choices: parseChoices(raw, 6),
    danmaku: parseDanmaku(raw),
  };
}

/**
 * 在铺子里跟弥彦说一句话。
 * 人格提示词 + 世界规则 + 当前局面 + 最近几轮对话，一次性发过去。
 */
export async function runDream(input) {
  const raw = String(input || '').trim();
  const settings = getSettings();

  const ch = channelFor('choices');
  if (!channelReady(ch)) {
    emit({ status: 'error', error: '先去设置里配一个渠道' });
    return;
  }

  const dream = getDream();
  const lastMsg = dream.messages[dream.messages.length - 1];

  // 输入框空着 + 最后一条是客人说的 = 重发上一条。
  //
  // 这种情况通常是：弥彦答得不对味，把那条删了，想让它重新说一遍。
  // 此时不该再往历史里塞一条空消息——直接用现有的对话重跑，
  // 请求体跟删掉那条之前完全一样，模型看到的上下文也没变。
  const resend = !raw && lastMsg?.role === 'user';
  const text = resend ? String(lastMsg.text || '').trim() : raw;
  if (!text) return;

  // 重发时历史要掐掉最后那条——它已经作为「客人刚说」单独给了一遍，
  // 留在 history 里会变成同一句话说两次。
  const source = resend ? dream.messages.slice(0, -1) : dream.messages;
  const history = source.slice(-DREAM_KEEP);

  // 先把客人这句挂上去，界面上立刻能看到（重发时不用再挂）
  const pending = resend
    ? { ...dream }
    : { ...dream, messages: [...dream.messages, { role: 'user', text, at: Date.now() }] };
  emit({ dream: pending });

  currentAbort?.abort();
  const abort = new AbortController();
  currentAbort = abort;
  startRunner('dream', '弥彦在想');

  try {
    const ctx = await collectContext(settings);

    // 前四段跟其它任务完全一致（内核 / 认领 / 资料 / 梦境对话），
    // 梦中梦特有的东西全部塞进第五段插槽：人格 + 铺子里的对话 + 客人刚说。
    // 这样框架是死的，只有插槽在变，加新功能只要写插槽就行。
    let material = buildMaterialContext(ctx, settings);

    // 梦里此刻 = 最近三段正文，全文给，不截尾
    const recent = buildRecentBodies(DREAM_RECENT, settings);
    if (recent.length) {
      material += '\n\n【梦里此刻（最近几段正文）】\n' + recent.join('\n\n');
    }

    const historyText = history
      .map((m) => (m.role === 'user' ? '客人：' : '弥彦：') + m.text)
      .join('\n');

    // 第五层插槽。如果提示词里写了 {{user_last_input}}，就把客人这句话替换进去；
    // 没写就自动追加在末尾。这样提示词可以自己决定输入放在哪一段。
    const PH_TEST = /\{\{\s*(?:user_last_input|lastMessage|input)\s*\}\}/i;
    const PH_REPLACE = /\{\{\s*(?:user_last_input|lastMessage|input)\s*\}\}/gi;

    let taskText = getPrompt('dream', settings);
    if (PH_TEST.test(taskText)) {
      taskText = taskText.replace(PH_REPLACE, () => text);
    } else {
      taskText += '\n\n【客人刚说】\n' + text;
    }

    if (historyText) taskText = '【你们刚才的对话】\n' + historyText + '\n\n' + taskText;

    const baseMessages = assembleMessages(settings, material, taskText, ctx);
    const reqOpts = {
      signal: abort.signal,
      retries: settings.retries,
      stream: false,
      // 梦中梦要回答长问题，单独给输出上限，否则半句话就断
    };

    const first = await callTask(ch, 'dream', baseMessages, reqOpts, settings);

    let parsed;

    if (first.args) {
      // 工具通道：参数已经是结构化的，截断的部分 salvageJson 已尽力救
      parsed = parseDream(first.args);
    } else {
      let raw = first.content || '';
      let fin = first.finishReason;

      // finish_reason='length' 说明撞上输出上限。自动续写，最多两轮。
      // 续写走文本通道——「接着写」这种指令用纯文本更自然。
      let guard = 0;
      while (fin === 'length' && guard < 2 && !abort.signal.aborted) {
        guard++;
        setRunnerStage('dream', `续写 ${guard}`);
        try {
          const cont = await completeWithRetry(
            ch,
            [
              ...baseMessages,
              { role: 'assistant', content: raw },
              {
                role: 'user',
                content: '接着上一句往下写。不要重复已经写过的字，不要重新开头，不要写 <say> 标签。',
              },
            ],
            reqOpts,
          );
          if (!cont.content || !cont.content.trim()) break;
          raw += cont.content;
          fin = cont.finishReason;
        } catch (e) {
          console.warn('[推进台] 续写失败，用已生成的部分', e);
          break;
        }
      }

      parsed = parseDream(raw);
    }
    const messages = [
      ...pending.messages,
      {
        role: 'assistant',
        text: parsed.say,
        at: Date.now(),
        choices: parsed.choices,
        danmaku: parsed.danmaku,
      },
    ].slice(-40);

    saveDream({ messages, at: Date.now() });
    emit({ status: 'idle', stage: '' });
  } catch (e) {
    if (abort.signal.aborted) {
      emit({ status: 'idle', stage: '', error: '已取消' });
    } else {
      console.error('[推进台] 梦中梦失败', e);
      emit({ status: 'error', stage: '', error: e?.message || String(e), dream: pending });
    }
  } finally {
    if (currentAbort === abort) currentAbort = null;
    endRunner('dream');
  }
}
