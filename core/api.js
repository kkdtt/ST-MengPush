/**
 * 模型调用层。
 *
 * 关键决策：不走浏览器直连，而是走 ST 自己的服务端代理
 *   POST /api/backends/chat-completions/generate
 * 用 chat_completion_source='openai' + reverse_proxy(base url) + proxy_password(key)。
 *
 * 好处：
 *   1. 没有 CORS 问题，任何 OpenAI 兼容渠道都能用；
 *   2. 密钥只经服务端转发，不暴露给第三方页面的 fetch；
 *   3. 复用 ST 已配好的网络环境（反代、超时、证书）。
 *
 * 请求体固定带 tool_choice:'none'。酒馆里装了「结构化传输 / 防截断」这类
 * monkey-patch fetch 的脚本时，它们会拦截 /generate 并把请求改写成工具调用；
 * 声明自己不用工具，是这类拦截器通用的放行信号。
 */

import { getCtx } from './ctx.js?v=2.2.0';
import { markSelf } from './inspect.js?v=2.2.0';

export const GENERATE_URL = '/api/backends/chat-completions/generate';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * 规范化 base url：
 *   - 填了完整 /chat/completions 的，去掉端点后缀（ST 会自己拼）；
 *   - 纯域名补 /v1；
 *   - 带自定义路径的（/v2/coding 之类）原样保留。
 */
export function normalizeUrl(input) {
  const u = String(input || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(u)) return u + '/v1';
  return u;
}

export function buildRequestBody(channel, messages, stream) {
  return {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeUrl(channel.url),
    proxy_password: channel.key || '',
    model: channel.model,
    messages,
    temperature: typeof channel.temperature === 'number' ? channel.temperature : 0.95,
    max_tokens: channel.maxTokens || 900,
    stream: !!stream,
    presence_penalty: 0,
    frequency_penalty: 0,
    tool_choice: 'none',
  };
}

function extractContent(data) {
  return String(
    data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      data?.content ??
      '',
  ).trim();
}

/** 逐行读 SSE，拼 delta.content。 */
async function readSse(resp) {
  const reader = resp.body?.getReader();
  if (!reader) {
    const data = await resp.json().catch(() => null);
    return data ? extractContent(data) : '';
  }

  const decoder = new TextDecoder();
  let buf = '';
  let out = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        if (json?.error) throw new ApiError(json.error.message || '上游返回错误');
        const d =
          json?.choices?.[0]?.delta?.content ??
          json?.choices?.[0]?.message?.content ??
          json?.choices?.[0]?.text;
        if (typeof d === 'string') out += d;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        /* 心跳行、注释行，忽略 */
      }
    }
  }
  return out.trim();
}

/**
 * 单次补全。失败抛 ApiError，调用方决定是否降级。
 * @param {object} channel
 * @param {Array<{role:string,content:string}>} messages
 * @param {{signal?:AbortSignal, stream?:boolean}} [opts]
 */
export async function complete(channel, messages, opts = {}) {
  const ctx = getCtx();
  if (!ctx) throw new ApiError('酒馆上下文还没就绪');
  if (!channel?.url || !channel?.model) throw new ApiError('渠道没配全（缺地址或模型名）');

  const stream = !!opts.stream;
  const body = buildRequestBody(channel, messages, stream);

  // 允许单次请求覆盖输出上限——出选项用 900 就够，
  // 梦中梦要回答长问题，得单独给大一点，否则半句话就断
  if (opts.maxTokens && Number(opts.maxTokens) > 0) {
    body.max_tokens = Math.round(Number(opts.maxTokens));
  }
  const timeoutSec = Math.max(10, channel.timeoutSec || 90);

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutSec * 1000);

  const onOuterAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    // 打个标记，让检视页能把「推进台自己发的」和「主对话发的」分开
    let resp;
    markSelf(1);
    try {
      resp = await fetch(GENERATE_URL, {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      markSelf(-1);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let hint = '';
      if (resp.status === 401 || resp.status === 403) hint = '（密钥被拒，检查渠道里的 Key）';
      if (resp.status === 404) hint = '（地址不对，检查 base url 是否带 /v1）';
      if (resp.status === 429) hint = '（限流，稍等或换渠道）';
      throw new ApiError(`请求失败 ${resp.status}${hint}　${text.slice(0, 200)}`, resp.status);
    }

    if (stream) {
      const content = await readSse(resp);
      if (!content) throw new ApiError('模型返回空内容');
      // 流式拿不到可靠的 finish_reason，按 stop 处理（不做续写）
      return { content, finishReason: 'stop' };
    }

    const data = await resp.json();
    if (data?.error) throw new ApiError(data.error.message || '上游返回错误');
    const content = extractContent(data);
    if (!content) throw new ApiError('模型返回空内容');

    // finish_reason='length' 表示被输出上限截断，调用方可以据此续写
    const finishReason = String(data?.choices?.[0]?.finish_reason || 'stop');
    return { content, finishReason };
  } catch (e) {
    if (timedOut) throw new ApiError(`超时（>${timeoutSec} 秒）`);
    if (e?.name === 'AbortError') throw new ApiError('已取消');
    if (e instanceof ApiError) throw e;
    throw new ApiError('网络异常：' + (e?.message || e));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** 带重试的补全。只对超时/网络/5xx/429 重试，4xx 直接失败。 */
export async function completeWithRetry(channel, messages, opts = {}) {
  const retries = Math.max(0, opts.retries ?? 1);
  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    try {
      return await complete(channel, messages, opts);
    } catch (e) {
      lastErr = e;
      const s = e?.status;
      const retriable = !s || s >= 500 || s === 429;
      if (!retriable || i === retries) break;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

/** 设置页的「测试」按钮用：发一句最短的话，确认渠道通。 */
export async function testChannel(channel) {
  const t0 = Date.now();
  const { content } = await complete(channel, [
    { role: 'system', content: '你是一个测试用的回显器。' },
    { role: 'user', content: '只回复两个字：通了' },
  ]);
  return { ok: true, ms: Date.now() - t0, content: String(content).slice(0, 60) };
}
