/**
 * 请求检视。
 *
 * 只做一件事：旁观 ST 发出去的生成请求，把请求体留下来给人看。
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

function capture(url, bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return;
  }

  const w = hostWindow();
  const self = (w.__mengPushSelf || 0) > 0;
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

export function install() {
  if (installed) return;
  // 浏览器里 window === globalThis；测试环境里 window 可能是 mock 对象，
  // 这时要退回到 globalThis 才拿得到真的 fetch。
  const w = hostWindow();
  if (typeof w.fetch !== 'function') return;

  installed = true;
  const original = w.fetch;

  w.fetch = function patchedFetch(input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url || '';
      // 注意是 chat-completions（连字符），不是 chat/completions。
      // 用 indexOf 而不是正则，省得再踩一次转义和字符的坑。
      if (url.indexOf('chat-completions/generate') >= 0 && init && typeof init.body === 'string') {
        capture(url, init.body);
      }
    } catch (e) {
      console.warn('[推进台] 抓请求失败', e);
    }
    return original.apply(this, arguments);
  };

  console.log('[推进台] 请求检视已挂载');
}
