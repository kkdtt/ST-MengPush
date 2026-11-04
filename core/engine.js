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

import { completeWithRetry } from './api.js';
import { readChatMeta, writeChatMeta } from './ctx.js';
import { buildSnapshot, collectContext, parseJSON } from './parse.js';
import { KERNEL, promptBeats, promptChoices, promptDanmaku } from './prompts.js';
import { channelFor, channelReady, get as getSettings } from './settings.js';

const CACHE_KEY = 'meng_push_cache';
const HISTORY_KEY = 'meng_push_history';

/* ---------------- 状态广播 ---------------- */

const listeners = new Set();

const state = {
  status: 'idle', // idle | running | error
  stage: '',
  error: '',
  result: null, // { choices, danmaku, beats, at, messageId }
  history: [],
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
 *   tasks 默认按设置里的开关来；manual=true 时至少会跑选项。
 */
export async function run(opts = {}) {
  const settings = getSettings();
  if (!settings.enabled) {
    emit({ status: 'idle', stage: '', error: '推进台已关闭' });
    return;
  }

  const ctx = collectContext(settings);
  const tasks = (opts.tasks || ['choices', 'danmaku', 'beats']).filter((t) => {
    if (t === 'choices') return true; // 选项永远跑
    return opts.manual ? settings.modules[t] || t === 'beats' : settings.modules[t];
  });

  const ch = channelFor('choices');
  if (!channelReady(ch)) {
    emit({ status: 'error', stage: '', error: '先去设置里配一个渠道（地址 + 模型名）' });
    return;
  }

  // 打断上一轮
  currentAbort?.abort();
  const abort = new AbortController();
  currentAbort = abort;
  running = true;

  emit({ status: 'running', stage: '整理上下文', error: '', result: null });

  const snapshot = buildSnapshot(ctx, settings);
  const base = snapshot + '\n\n---\n\n';
  const result = { choices: [], danmaku: [], beats: [], at: Date.now(), messageId: ctx.lastBodyId };

  try {
    /* ---- 选项：先跑，先出 ---- */
    if (tasks.includes('choices')) {
      emit({ stage: '出选项' });
      const text = await completeWithRetry(
        ch,
        [
          { role: 'system', content: KERNEL },
          { role: 'user', content: base + promptChoices(settings.choiceCount) },
        ],
        { signal: abort.signal, retries: settings.retries, stream: false },
      );
      result.choices = normalizeChoices(parseJSON(text), settings.choiceCount);
      emit({ result: { ...result }, stage: result.choices.length ? '选项好了' : '这轮没出选项' });
    }

    /* ---- 弹幕：按概率，不阻塞选项 ---- */
    if (tasks.includes('danmaku') && !abort.signal.aborted) {
      // 手动触发时无条件跑一次；自动模式下按概率掷骰
      const shouldRun = opts.manual || Math.random() < (settings.danmakuChance ?? 0.4);
      if (shouldRun) {
        emit({ stage: '看要不要刷弹幕' });
        try {
          const dmCh = channelFor('danmaku') || ch;
          const text = await completeWithRetry(
            dmCh,
            [
              { role: 'system', content: KERNEL },
              { role: 'user', content: base + promptDanmaku() },
            ],
            { signal: abort.signal, retries: 0, stream: false },
          );
          const j = parseJSON(text);
          result.danmaku = Array.isArray(j?.danmaku)
            ? j.danmaku.filter(Boolean).slice(0, 6).map((s) => String(s).trim())
            : [];
          emit({ result: { ...result }, stage: '' });
        } catch (e) {
          // 弹幕失败不影响主流程，静默降级
          console.warn('[推进台] 弹幕生成失败', e);
        }
      }
    }

    /* ---- 节拍表：只在手动时跑 ---- */
    if (tasks.includes('beats') && opts.manual && !abort.signal.aborted) {
      emit({ stage: '排节拍' });
      try {
        const btCh = channelFor('beats') || ch;
        const text = await completeWithRetry(
          btCh,
          [
            { role: 'system', content: KERNEL },
            { role: 'user', content: base + promptBeats() },
          ],
          { signal: abort.signal, retries: 0, stream: false },
        );
        const j = parseJSON(text);
        result.beats = Array.isArray(j?.beats) ? j.beats.slice(0, 16) : [];
        emit({ result: { ...result }, stage: '' });
      } catch (e) {
        console.warn('[推进台] 节拍表生成失败', e);
      }
    }

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

/* ---------------- 结果规整 ---------------- */

const TYPES = ['顺承', '横向', '升温', '切场', '破局', '退让'];
const RISKS = ['低', '中', '高'];

function normalizeChoices(parsed, limit) {
  const arr = Array.isArray(parsed?.choices) ? parsed.choices : [];
  const out = [];

  for (const c of arr) {
    if (!c) continue;
    const text = String(c.text ?? c.content ?? '').trim();
    if (!text) continue;
    out.push({
      type: TYPES.includes(String(c.type)) ? String(c.type) : '顺承',
      text: text.slice(0, 60),
      risk: RISKS.includes(String(c.risk)) ? String(c.risk) : '中',
    });
    if (out.length >= limit) break;
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
