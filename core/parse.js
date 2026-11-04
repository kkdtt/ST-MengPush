/**
 * 楼层解析。
 *
 * 这套预设的输出是「标签 + 模块」结构：
 *   <content>正文</content>
 *   <Choice>选项</Choice>
 *   <details><summary>摘要</summary>…</details>
 * 开着结构化传输时标签由客户端脚本补，关着时由模型自己写。
 * 两种都要能读，所以提取一律带兜底。
 */

import { getChatVariable, getCharInfo, getVisibleMessages } from './ctx.js';

/** 取某个 <details> 块的内容，按 summary 文字匹配（「摘要」和「此刻」要分开）。 */
export function extractDetails(text, keyword) {
  if (!text) return '';
  const re = /<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1].indexOf(keyword) >= 0) return m[2].trim();
  }
  return '';
}

/** 去掉所有附加模块，只留正文。 */
export function stripModules(text) {
  if (!text) return '';
  return String(text)
    .replace(/<details[^>]*>[\s\S]*?<\/details>/gi, '')
    .replace(/<(Choice|theater|meanwhile|dream_draft|anchor)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(content|scene|affection)>/gi, '')
    .trim();
}

/** 取正文：优先 <content>，没有就整条去模块。 */
export function getBody(message) {
  if (!message) return '';
  const m = /<content>([\s\S]*?)<\/content>/i.exec(message);
  if (m) return m[1].trim();
  return stripModules(message);
}

/** 容错解析 JSON：剥代码围栏、取最外层花括号。 */
export function parseJSON(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** 当前模式：rp（入梦）/ novel（观梦）。预设用 {{setvar::mode::…}} 写进聊天变量。 */
export function getMode() {
  const m = getChatVariable('mode');
  if (m === 'rp' || m === 'novel') return m;
  return 'novel';
}

/**
 * 采集上下文。
 * 只取需要的：最近 N 条摘要 + 最新正文尾部 + 角色卡精简 + 用户上一句。
 * 不把整段聊天记录塞进去——flash 的注意力会被稀释，选项会变得很套路。
 */
export function collectContext(settings) {
  const msgs = getVisibleMessages();
  const summaries = [];
  const depth = Math.max(1, settings?.summaryDepth ?? 3);

  for (let i = msgs.length - 1; i >= 0 && summaries.length < depth; i--) {
    const s = extractDetails(msgs[i].mes, '摘要');
    if (s) summaries.unshift(s);
  }

  let lastBody = '';
  let lastBodyId = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].is_user) continue;
    lastBody = getBody(msgs[i].mes);
    lastBodyId = i;
    if (lastBody) break;
  }

  let lastUser = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].is_user) {
      lastUser = String(msgs[i].mes || '').trim();
      break;
    }
  }

  let card = '';
  const ch = getCharInfo();
  if (ch) {
    const desc = String(ch.description || '').slice(0, settings?.cardChars ?? 600);
    const pers = String(ch.personality || '').slice(0, 200);
    card = `【角色】${ch.name || ''}\n${desc}${pers ? '\n' + pers : ''}`.trim();
  }

  return { summaries, lastBody, lastBodyId, lastUser, card, mode: getMode(), total: msgs.length };
}

/** 把采集到的上下文拼成给 flash 看的快照。 */
export function buildSnapshot(ctx, settings) {
  const parts = [];
  const tail = Math.max(300, settings?.tailChars ?? 1400);

  parts.push(
    `【模式】${
      ctx.mode === 'rp'
        ? '入梦·RP（客人是局内人，选项写第一人称动作）'
        : '观梦·小说（客人是场外导演，选项写镜头调度）'
    }`,
  );

  if (ctx.card) parts.push(ctx.card);

  if (ctx.summaries.length) {
    parts.push('【最近几场摘要】\n' + ctx.summaries.map((s, i) => `(${i + 1}) ${s}`).join('\n'));
  }

  if (ctx.lastUser) parts.push('【客人上一句】\n' + ctx.lastUser.slice(0, 400));

  if (ctx.lastBody) {
    const body = ctx.lastBody;
    parts.push(
      '【当前这一场（尾部）】\n' + (body.length > tail ? '……' + body.slice(-tail) : body),
    );
  } else {
    parts.push('【注意】正文还没开始，按摘要里的局面给开局选项。');
  }

  return parts.join('\n\n');
}
