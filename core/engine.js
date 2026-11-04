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

import { completeWithRetry } from './api.js?v=1.2.1';
import { readChatMeta, writeChatMeta } from './ctx.js?v=1.2.1';
import { buildSnapshot, collectContext, parseJSON } from './parse.js?v=1.2.1';
import { buildBeats, buildChoices, buildDanmaku, buildOutline, buildSteps, getKernel } from './prompts.js?v=1.2.1';
import { channelFor, channelReady, get as getSettings } from './settings.js?v=1.2.1';

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

  const ctx = collectContext(settings);

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

  const snapshot = buildSnapshot(ctx, settings);
  const base = snapshot + '\n\n---\n\n';
  const kernel = getKernel(settings);

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
            const text = await completeWithRetry(
              ch,
              [
                { role: 'system', content: kernel },
                { role: 'user', content: base + buildChoices(settings) },
              ],
              { signal: abort.signal, retries: settings.retries, stream: false },
            );
            result.choices = parseChoices(text, settings.choiceCount);
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
              const text = await completeWithRetry(
                dmCh,
                [
                  { role: 'system', content: kernel },
                  { role: 'user', content: base + buildDanmaku(settings) },
                ],
                { signal: abort.signal, retries: 0, stream: false },
              );
              result.danmaku = parseDanmaku(text);
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
            const text = await completeWithRetry(
              btCh,
              [
                { role: 'system', content: kernel },
                { role: 'user', content: base + buildBeats(settings) },
              ],
              { signal: abort.signal, retries: 0, stream: false },
            );
            result.beats = parseBeats(text);
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
export function parseDanmaku(text) {
  const raw = String(text || '').trim();
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
export function parseBeats(text) {
  const raw = String(text || '');
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
  const arr = Array.isArray(j?.beats) ? j.beats : [];
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
export function parseChoices(text, limit) {
  const raw = String(text || '');
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

  // 模型没给够时，把「退让」补上——这一类最容易被漏，但它是唯一的出口
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

export function parseOutline(text) {
  const out = [];
  const re = /<outline\b([^>]*)>([\s\S]*?)<\/outline>/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
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

export function parseSteps(text) {
  const out = [];
  const re = /<step\b([^>]*)>([\s\S]*?)<\/step>/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
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
    const ctx = collectContext(settings);
    const base = buildSnapshot(ctx, settings) + '\n\n---\n\n';
    const kernel = getKernel(settings);

    if (action === 'outline') {
      const scale = params.scale || 'medium';
      const count = SCALE_COUNT[scale] || 4;
      const text = await completeWithRetry(
        ch,
        [
          { role: 'system', content: kernel },
          { role: 'user', content: base + buildOutline(settings, { keyword: params.keyword, scale, count }) },
        ],
        { signal: abort.signal, retries: settings.retries, stream: false },
      );
      const outline = parseOutline(text);
      if (!outline.length) throw new Error('模型没给出可用的大纲');
      saveStory({ keyword: params.keyword || '', scale, outline, steps: [], at: Date.now() });
    } else {
      const story = getStory();
      if (!story.outline?.length) throw new Error('还没有大纲，先出大纲');
      const count = Math.min(12, Math.max(2, params.count || 5));
      const outlineText = story.outline.map((o) => `${o.n}. ${o.title ? o.title + '：' : ''}${o.text}`).join('\n');
      const text = await completeWithRetry(
        ch,
        [
          { role: 'system', content: kernel },
          { role: 'user', content: base + '【已定的大纲】\n' + outlineText + '\n\n---\n\n' + buildSteps(settings, { count }) },
        ],
        { signal: abort.signal, retries: settings.retries, stream: false },
      );
      const steps = parseSteps(text);
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
