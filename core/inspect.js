/**
 * 请求检视。
 *
 * 两件事：
 *   1. 旁观 ST 发出去的生成请求，把请求体留下来给人看；
 *   2. 报告「主对话这一版正文写完了」——自动任务只认这个信号。
 *
 * 为什么用 hook fetch 而不是别的手段：
 *   · ST 的 generate_interceptor 拿到的是 chat 数组，不含预设拼装、世界书注入、
 *     正则处理后的最终结果——那是半成品，看了没用；
 *   · 只有拦在 fetch 这一层，才是真正发出去的那份字节。
 *
 * 安全性：只读不改写。原函数照常调用、原参数原样传回，不碰 response。
 * 即使这里出异常也只是记录失败，不影响生成。
 */

const MAX_RECORDS = 8;

let records = [];
const listeners = new Set();
let installed = false;

function emit() {
  for (const fn of listeners) {
    try {
      fn(records);
    } catch (e) {
      console.error('[推进台] 检视监听器报错', e);
    }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(records);
  return () => listeners.delete(fn);
}

export function getRecords() {
  return records;
}

export function clearRecords() {
  records = [];
  emit();
}

/**
 * 把响应结果附到最近一条记录上。
 * 光看请求的 tool_choice 只能证明「带了工具」，证明不了「模型真调了」。
 */
export function attachResult(info) {
  const r = records[0];
  if (!r) return;
  r.result = {
    // tool = 模型调了工具；notool = 工具通道开着但它写了正文；
    // degraded = 工具通道请求失败退回文本；text = 本来就走文本通道
    reason: String(info?.reason || (info?.hasTool ? 'tool' : 'text')),
    hasTool: !!info?.hasTool || info?.reason === 'tool',
    toolName: String(info?.toolName || ''),
    finishReason: String(info?.finishReason || ''),
    chars: Number(info?.chars || 0),
  };
  emit();
}

/** 标记「这条请求是推进台自己发的」，用来跟主对话区分。 */
/**
 * 拿「真正被调用」的那个 fetch 宿主。
 * 浏览器里 window === globalThis，无所谓；但测试环境（happy-dom）里
 * window.fetch 和模块实际用的 globalThis.fetch 是两个东西，
 * 挂错地方就一条都抓不到。所以优先 globalThis。
 */
function hostWindow() {
  if (typeof globalThis.fetch === 'function') return globalThis;
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') return window;
  return globalThis;
}

export function markSelf(delta) {
  const w = hostWindow();
  w.__mengPushSelf = Math.max(0, (w.__mengPushSelf || 0) + delta);
}

/**
 * 粗略估算 token。中文按 0.7，其余（英文/数字/标点）按 0.28。
 * 不同模型的分词器有差异，这个值只用于「大概多少」，别当准数。
 */
export function estimateTokens(text) {
  const str = String(text || '');
  let cjk = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0x4e00 && c <= 0x9fff) cjk++;
  }
  const other = str.length - cjk;
  return Math.round(cjk * 0.7 + other * 0.28);
}

function capture(url, bodyText, self) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return;
  }

  const msgs = Array.isArray(body?.messages) ? body.messages : [];

  const messages = msgs.map((m) => ({
    role: String(m?.role || '?'),
    content: String(m?.content ?? ''),
  }));

  // tools 也要记——预设脚本开了 packContext 时，整段上下文被挪进工具说明，
  // 对话里只剩几条流水线消息，光看 messages 等于什么都没看到。
  const tools = Array.isArray(body?.tools)
    ? body.tools.map((t) => {
        const fn = t?.function || {};
        const raw = JSON.stringify(fn, null, 2);
        return {
          name: String(fn.name || ''),
          desc: String(fn.description || '').slice(0, 300),
          raw,
          chars: raw.length,
        };
      })
    : [];

  // 判断这条请求是不是被别的脚本接管过：出现预设脚本的标记，或工具名不是我们自己的
  const hijacked =
    tools.some((t) => t.name === 'mh_scene') ||
    messages.some((m) => /\[STRUCTURED_TRANSFER\]|\[ROUTER\]|\[DIRECTIVE\]/.test(m.content));

  records.unshift({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    self,
    url: String(url),
    model: String(body?.model || ''),
    temperature: body?.temperature,
    maxTokens: body?.max_tokens,
    stream: !!body?.stream,
    toolChoice: body?.tool_choice ?? null,
    // 原始请求体：字段结构和上面这些不一致时，靠它兜底排查
    rawBody: bodyText.length > 400000 ? bodyText.slice(0, 400000) + '\n…（已截断）' : bodyText,
    bodyKeys: Object.keys(body || {}),
    tools,
    hijacked,
    count: messages.length,
    chars: messages.reduce((n, m) => n + m.content.length, 0),
    tokens:
      messages.reduce((n, m) => n + estimateTokens(m.content), 0) +
      tools.reduce((n, t) => n + estimateTokens(t.raw), 0),
    messages,
  });

  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
  emit();
}

/* ---------------- 主对话响应结束 ---------------- */

/**
 * 订阅「主对话这一版正文写完了」。
 *
 * 只认主对话发的请求：推进台自己发的请求带 self 标记（api.js 里 markSelf），
 * 一律不通知——否则自己跑一次走向，就会被当成「正文写完了」再触发一轮。
 *
 * 「写完」= 响应体读到底。流式就是流结束，非流式就是整包收完。
 * 注意这不是「楼层已落盘」：那时候 ST 还在解析，chat 数组里还没有新消息。
 */
const mainDoneListeners = new Set();

export function onMainResponseEnd(fn) {
  mainDoneListeners.add(fn);
  return () => mainDoneListeners.delete(fn);
}

function notifyMainEnd(info) {
  for (const fn of mainDoneListeners) {
    try {
      fn(info);
    } catch (e) {
      console.error('[推进台] 主对话完成回调报错', e);
    }
  }
}

/**
 * 盯着主对话的响应，读完一份副本再通知。
 *
 * 必须 clone：原始响应 ST 自己还要读，这里抢着读会把正文吞掉。
 * 副本读的是同一份字节流，不干扰对方。
 */
function watchMainResponse(promise, url) {
  const startedAt = Date.now();

  promise.then(
    (resp) => {
      const base = {
        url: String(url),
        ok: resp?.ok !== false,
        status: Number(resp?.status) || 0,
      };
      const finish = () => notifyMainEnd({ ...base, ms: Date.now() - startedAt });

      let copy = null;
      try {
        copy = typeof resp?.clone === 'function' ? resp.clone() : null;
      } catch {
        copy = null;
      }

      // 测试环境里的假响应没有 body，直接算读完
      if (!copy || typeof copy.text !== 'function') {
        finish();
        return;
      }
      copy.text().then(finish, finish);
    },
    (err) => {
      // 请求挂了也算这一轮结束——自动任务没必要干等
      notifyMainEnd({
        url: String(url),
        ok: false,
        status: 0,
        error: err?.message || '网络失败',
        ms: Date.now() - startedAt,
      });
    },
  );
}

export function install() {
  if (installed) return;
  // 浏览器里 window === globalThis；测试环境里 window 可能是 mock 对象，
  // 这时要退回到 globalThis 才拿得到真的 fetch。
  const w = hostWindow();
  if (typeof w.fetch !== 'function') return;

  installed = true;
  const original = w.fetch;

  w.fetch = function patchedFetch(input, init) {
    let url = '';
    // 注意是 chat-completions（连字符），不是 chat/completions。
    // 用 indexOf 而不是正则，省得再踩一次转义和字符的坑。
    try {
      url = typeof input === 'string' ? input : input?.url || '';
    } catch {
      url = '';
    }

    const isGenerate = url.indexOf('chat-completions/generate') >= 0;
    // self 在发请求这一刻读：api.js 用 markSelf 把「自己的请求」包起来
    const self = (w.__mengPushSelf || 0) > 0;

    try {
      if (isGenerate && init && typeof init.body === 'string') capture(url, init.body, self);
    } catch (e) {
      console.warn('[推进台] 抓请求失败', e);
    }

    const out = original.apply(this, arguments);

    // 主对话的响应读完才算这一版正文到齐了
    if (isGenerate && !self && out && typeof out.then === 'function') {
      watchMainResponse(out, url);
    }

    return out;
  };

  console.log('[推进台] 请求检视已挂载');
}
