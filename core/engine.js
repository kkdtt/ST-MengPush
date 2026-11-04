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

import { completeWithRetry } from './api.js?v=2.7.2';
import { readChatMeta, writeChatMeta } from './ctx.js?v=2.7.2';
import { buildChatHistory, buildMaterialContext, buildSystemContext, buildUserContext, collectContext, parseJSON } from './parse.js?v=2.7.2';
import { attachResult } from './inspect.js?v=2.7.2';
import { buildTool, readToolArgs } from './tools.js?v=2.7.2';
import { buildBeats, buildChoices, buildDanmaku, buildOutline, buildSteps, getKernel, getPrompt } from './prompts.js?v=2.7.2';
import { channelFor, channelReady, get as getSettings } from './settings.js?v=2.7.2';

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
  story: null, // { keyword, scale, outline, steps, stepCount, busy }
  dream: null, // { messages: [{role, text, at, choices, danmaku}] }
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

function saveResult(messageId, result) {
  const cache = loadCache();
  cache[messageId] = result;

  // 只保留最近 40 条，避免 chatMetadata 无限膨胀
  const ids = Object.keys(cache)
    .map(Number)
    .sort((a, b) => a - b);
  while (ids.length > 40) delete cache[ids.shift()];
  writeChatMeta(CACHE_KEY, cache);

  const history = (readChatMeta(HISTORY_KEY) || []).slice();
  history.push({ messageId, at: result.at, choices: result.choices, danmaku: result.danmaku });
  const limit = Math.max(4, getSettings().historyLimit || 24);
  while (history.length > limit) history.shift();
  writeChatMeta(HISTORY_KEY, history);

  emit({ history });
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
function assembleMessages(settings, material, task) {
  const msgs = [
    { role: 'system', content: getKernel(settings) },
    { role: 'assistant', content: getPrompt('ack', settings) },
    { role: 'system', content: material },
  ];

  msgs.push(...buildChatHistory(settings));

  // 最后一条永远是任务。末尾这句话有两个作用：
  //   1. 对模型：明确「按格式交结果」，别顺着对话往下写
  //   2. 对预设的「结构化传输」脚本：它见到「接着上一句往下写」会按「扮演续写」放行，
  //      不再接管我们的请求。否则上下文会被它挪进 tools，检视页只剩几条流水线外壳。
  msgs.push({
    role: 'system',
    content: task + '\n\n（这是内部任务：不要接着上一句往下写，直接按上面的格式交出结果。）',
  });
  return msgs;
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
  const replyCap = opts.maxTokens || ch.maxTokens || settings.maxReplyTokens || 4000;
  const baseOpts = { ...opts, maxTokens: replyCap };

  if (!tool) {
    const res = await completeWithRetry(ch, messages, { ...baseOpts, stream });
    attachResult({ hasTool: false, finishReason: res.finishReason, chars: res.content?.length });
    return { ...res, args: null };
  }

  try {
    const res = await completeWithRetry(ch, messages, {
      ...baseOpts,
      stream,
      tools: [tool],
      toolChoice: 'auto',
    });
    const args = readToolArgs({ tool_calls: res.toolCalls });
    attachResult({
      hasTool: !!args,
      toolName: res.toolCalls?.[0]?.function?.name || '',
      finishReason: res.finishReason,
      chars: res.content?.length,
    });
    if (args) return { ...res, args };
    // 模型没调工具，但给了正文——按文本通道解析
    if (res.content && res.content.trim()) return { ...res, args: null };
    throw new Error('工具通道返回空');
  } catch (e) {
    console.warn('[推进台] 工具通道失败，降级文本', e);
    const res = await completeWithRetry(ch, messages, { ...baseOpts, stream });
    attachResult({ hasTool: false, finishReason: 'degraded', chars: res.content?.length });
    return { ...res, args: null, degraded: true };
  }
}

/* ---------------- 主流程 ---------------- */

let currentAbort = null;
let running = false;

/**
 * 跑一轮。
 * @param {{tasks?: string[], manual?: boolean}} opts
 *   tasks 不传时按设置里的开关走；传了就只跑这几项，其余保留上次的结果。
 */
export async function run(opts = {}) {
  const settings = getSettings();
  if (!settings.enabled) {
    emit({ status: 'idle', stage: '', error: '推进台已关闭' });
    return;
  }

  const ctx = await collectContext(settings);

  // 只重刷某一项时，其余项保留上一次的结果，不要清空
  const prev = getCached(ctx.lastBodyId) || {};
  const result = {
    choices: Array.isArray(prev.choices) ? prev.choices : [],
    danmaku: Array.isArray(prev.danmaku) ? prev.danmaku : [],
    beats: Array.isArray(prev.beats) ? prev.beats : [],
    notes: { ...(prev.notes || {}) },
    at: Date.now(),
    messageId: ctx.lastBodyId,
  };

  const tasks = opts.tasks ? opts.tasks.slice() : ['choices', 'danmaku', 'beats'].filter((t) => settings.modules[t]);

  const ch = channelFor('choices');
  if (!channelReady(ch)) {
    emit({ status: 'error', stage: '', error: '先去设置里配一个渠道（地址 + 模型名）' });
    return;
  }

  currentAbort?.abort();
  const abort = new AbortController();
  currentAbort = abort;
  running = true;

  emit({ status: 'running', stage: '整理上下文', error: '', result: { ...result } });

  // 资料段：世界书 + 角色卡 + 背景 + 大总结 + 更早的摘要
  const material = buildMaterialContext(ctx, settings);

  try {
    // 走向和弹幕并发：谁先回来谁先渲染，不用互相等。
    // 两个任务通常走同一个渠道，所以不再额外拆渠道并发，避免撞限流。
    const jobs = [];
    let choiceError = null;

    if (tasks.includes('choices')) {
      jobs.push(
        (async () => {
          emit({ stage: '生成中' });
          try {
            const res = await callTask(
              ch,
              'choices',
              assembleMessages(settings, material, buildChoices(settings)),
              { signal: abort.signal, retries: settings.retries, stream: false },
              settings,
            );
            result.choices = parseChoices(res.args || res.content, settings.choiceCount);
            result.notes.choices = result.choices.length ? '' : 'empty';
          } catch (e) {
            result.notes.choices = 'error:' + (e?.message || e);
            choiceError = e;
          } finally {
            emit({ result: { ...result }, stage: '' });
          }
        })(),
      );
    }

    if (tasks.includes('danmaku') && !abort.signal.aborted) {
      const shouldRun = opts.manual || Math.random() < (settings.danmakuChance ?? 0.4);
      if (shouldRun) {
        jobs.push(
          (async () => {
            emit({ stage: '生成中' });
            try {
              const dmCh = channelFor('danmaku') || ch;
              const res = await callTask(
                dmCh,
                'danmaku',
                assembleMessages(settings, material, buildDanmaku(settings)),
                { signal: abort.signal, retries: 0, stream: false },
                settings,
              );
              result.danmaku = parseDanmaku(res.args || res.content);
              result.notes.danmaku = result.danmaku.length ? '' : 'empty';
            } catch (e) {
              result.danmaku = [];
              result.notes.danmaku = 'error:' + (e?.message || e);
              console.warn('[推进台] 弹幕生成失败', e);
            } finally {
              emit({ result: { ...result }, stage: '' });
            }
          })(),
        );
      } else {
        result.notes.danmaku = 'skipped';
      }
    }

    if (tasks.includes('beats') && !abort.signal.aborted) {
      jobs.push(
        (async () => {
          emit({ stage: '排节拍' });
          try {
            const btCh = channelFor('beats') || ch;
            const res = await callTask(
              btCh,
              'beats',
              assembleMessages(settings, material, buildBeats(settings)),
              { signal: abort.signal, retries: 0, stream: false },
              settings,
            );
            result.beats = parseBeats(res.args || res.content);
            result.notes.beats = result.beats.length ? '' : 'empty';
          } catch (e) {
            result.notes.beats = 'error:' + (e?.message || e);
            console.warn('[推进台] 节拍表生成失败', e);
          } finally {
            emit({ result: { ...result }, stage: '' });
          }
        })(),
      );
    }

    await Promise.all(jobs);

    // 走向是主菜，它挂了才算这一轮失败；弹幕/节拍挂了只在自己那页显示
    if (choiceError) throw choiceError;

    if (result.messageId >= 0) saveResult(result.messageId, result);
    emit({ status: 'idle', stage: '', result });
  } catch (e) {
    if (abort.signal.aborted) {
      emit({ status: 'idle', stage: '', error: '已取消' });
    } else {
      console.error('[推进台]', e);
      emit({ status: 'error', stage: '', error: e?.message || String(e), result });
    }
  } finally {
    running = false;
    if (currentAbort === abort) currentAbort = null;
  }
}

export function cancel() {
  currentAbort?.abort();
}

export function isRunning() {
  return running;
}

/**
 * 直接跑一项，不改动其他项。面板上的「重刷弹幕」「排节拍」都走这里。
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

let lastAutoId = -1;

/**
 * 生成结束时被调用。同一个 messageId 只处理一次，
 * 否则 swipes / 重绘会重复触发。
 */
export function onGenerationEnded(messageId) {
  const settings = getSettings();
  if (!settings.enabled || !settings.auto) return;

  const id = typeof messageId === 'number' ? messageId : -1;
  if (id < 0 || id === lastAutoId) return;
  lastAutoId = id;

  const cached = getCached(id);
  if (cached) {
    emit({ result: cached, status: 'idle', stage: '', error: '' });
    return;
  }

  setTimeout(() => {
    if (lastAutoId !== id) return; // 期间又生成了新的，放弃这轮
    void run({ manual: false });
  }, Math.max(200, settings.autoDelay || 700));
}

export function resetAutoGuard() {
  lastAutoId = -1;
}

/* ---------------- 剧情创作 ---------------- */

const STORY_KEY = 'meng_push_story';

/** 推进幅度 → 默认段数。 */
const SCALE_COUNT = { light: 3, medium: 4, heavy: 6 };

export function getStory() {
  return (
    readChatMeta(STORY_KEY) || {
      keyword: '',
      scale: 'medium',
      outline: [],
      steps: [],
      stepCount: 5,
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
      .slice(0, 10)
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
      .map((x, i) => ({ n: Number(x.n) || i + 1, text: String(x.text).trim(), done: false }));
  }

  const out = [];
  const re = /<step\b([^>]*)>([\s\S]*?)<\/step>/gi;
  let m;
  while ((m = re.exec(String(input || ''))) !== null) {
    const attrs = parseAttrs(m[1]);
    const body = m[2].replace(/\s+/g, ' ').trim();
    if (!body) continue;
    out.push({ n: Number(attrs.n) || out.length + 1, text: body, done: false });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 创作页的两个动作。
 *   runStory('outline', { keyword, scale })  → 出大纲
 *   runStory('steps', { count })             → 把大纲拆成步骤
 */
export async function runStory(action, params = {}) {
  const settings = getSettings();
  if (!settings.enabled) {
    emit({ status: 'error', error: '推进台已关闭' });
    return;
  }

  const ch = channelFor('choices');
  if (!channelReady(ch)) {
    emit({ status: 'error', error: '先去设置里配一个渠道' });
    return;
  }

  currentAbort?.abort();
  const abort = new AbortController();
  currentAbort = abort;

  emit({ status: 'running', stage: action === 'outline' ? '排大纲' : '拆步骤', error: '' });

  try {
    const ctx = await collectContext(settings);
    const material = buildMaterialContext(ctx, settings);

    if (action === 'outline') {
      const scale = params.scale || 'medium';
      const count = SCALE_COUNT[scale] || 4;
      const res = await callTask(
        ch,
        'outline',
        assembleMessages(
          settings,
          material,
          buildOutline(settings, { keyword: params.keyword, scale, count }),
        ),
        { signal: abort.signal, retries: settings.retries, stream: false },
        settings,
      );
      const outline = parseOutline(res.args || res.content);
      if (!outline.length) throw new Error('模型没给出可用的大纲');
      saveStory({ keyword: params.keyword || '', scale, outline, steps: [], at: Date.now() });
    } else {
      const story = getStory();
      if (!story.outline?.length) throw new Error('还没有大纲，先出大纲');
      const count = Math.min(12, Math.max(2, params.count || 5));
      const outlineText = story.outline.map((o) => `${o.n}. ${o.title ? o.title + '：' : ''}${o.text}`).join('\n');
      const res = await callTask(
        ch,
        'steps',
        assembleMessages(
          settings,
          material,
          '【已定的大纲】\n' + outlineText + '\n\n---\n\n' + buildSteps(settings, { count }),
        ),
        { signal: abort.signal, retries: settings.retries, stream: false },
        settings,
      );
      const steps = parseSteps(res.args || res.content);
      if (!steps.length) throw new Error('模型没给出可用的步骤');
      saveStory({ steps, stepCount: count, at: Date.now() });
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
  }
}

/** 把某一步标记为已执行。 */
export function markStepDone(n) {
  const story = getStory();
  const steps = (story.steps || []).map((s) => (s.n === n ? { ...s, done: true } : s));
  saveStory({ steps });
}

/* ---------------- 梦中梦 ---------------- */

const DREAM_KEY = 'meng_push_dream';
const DREAM_KEEP = 12; // 只带最近 12 轮进上下文

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
  const text = String(input || '').trim();
  if (!text) return;

  const settings = getSettings();
  if (!settings.enabled) {
    emit({ status: 'error', error: '推进台已关闭' });
    return;
  }

  const ch = channelFor('choices');
  if (!channelReady(ch)) {
    emit({ status: 'error', error: '先去设置里配一个渠道' });
    return;
  }

  const dream = getDream();
  const history = dream.messages.slice(-DREAM_KEEP);

  // 先把客人这句挂上去，界面上立刻能看到
  const pending = { ...dream, messages: [...dream.messages, { role: 'user', text, at: Date.now() }] };
  emit({ dream: pending, status: 'running', stage: '弥彦在想', error: '' });

  currentAbort?.abort();
  const abort = new AbortController();
  currentAbort = abort;

  try {
    const ctx = await collectContext(settings);

    // 前四段跟其它任务完全一致（内核 / 认领 / 资料 / 梦境对话），
    // 梦中梦特有的东西全部塞进第五段插槽：人格 + 铺子里的对话 + 客人刚说。
    // 这样框架是死的，只有插槽在变，加新功能只要写插槽就行。
    let material = buildMaterialContext(ctx, settings);
    if (ctx.lastBody) {
      const tail = Math.max(300, settings?.tailChars ?? 3000);
      const body = ctx.lastBody;
      material +=
        '\n\n【梦里此刻（正文尾部）】\n' + (body.length > tail ? '……' + body.slice(-tail) : body);
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

    const baseMessages = assembleMessages(settings, material, taskText);
    const reqOpts = {
      signal: abort.signal,
      retries: settings.retries,
      stream: false,
      // 梦中梦要回答长问题，单独给输出上限，否则半句话就断
      maxTokens: settings.dreamMaxTokens || 12000,
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
        emit({ stage: `续写 ${guard}` });
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
  }
}
