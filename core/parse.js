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

import { getChatVariable, getCharInfo, getVisibleMessages, getWorldInfo } from './ctx.js?v=1.6.1';

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
 *
 * 给旁路模型的上下文必须和主模型看到的世界一致，否则选项会跟设定打架。
 * 四层来源：
 *   1. 世界书（ST 激活条目，自动扫描）
 *   2. 角色卡（描述 / 性格 / 场景，全字段）
 *   3. 过往事件（聊天里的大总结楼层 + 用户手填的背景）
 *   4. 近况（最近几条摘要 + 最新正文尾部 + 客人上一句）
 *
 * 世界书读取是异步的，所以这个函数也是异步的。
 */
export async function collectContext(settings) {
  const msgs = getVisibleMessages();
  const summaries = [];

  // 摘要按「字数预算」取，不按条数。
  // 预设里摘要固定六字段、一条约 200 字，3 条根本不够 flash 建立前情。
  // 旧楼层被 /hide 之后不影响这里——hide 只是不显示，数据还在 chat 数组里，
  // 所以可以放心往回翻，翻到字数上限为止。
  const maxChars = Math.max(400, settings?.summaryChars ?? 3200);
  const maxCount = Math.max(1, settings?.summaryDepth ?? 20);
  let used = 0;

  for (let i = msgs.length - 1; i >= 0; i--) {
    const s = extractDetails(msgs[i].mes, '摘要');
    if (!s) continue;
    if (summaries.length >= maxCount) break;
    if (summaries.length && used + s.length > maxChars) break;
    summaries.unshift(s);
    used += s.length;
  }

  // 大总结：预设里「大总结」跑完会作为一条楼层留在聊天里
  let bigSummary = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const s = extractDetails(msgs[i].mes, '大总结');
    if (s) {
      bigSummary = s;
      break;
    }
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

  // 角色卡：描述给足，性格和场景也要带上
  let card = '';
  const ch = getCharInfo();
  if (ch) {
    const cardChars = settings?.cardChars ?? 1200;
    const desc = String(ch.description || '').slice(0, cardChars);
    const pers = String(ch.personality || '').slice(0, 400);
    const scen = String(ch.scenario || '').slice(0, 400);
    const lines = [`【角色】${ch.name || ''}`, desc];
    if (pers) lines.push('性格：' + pers);
    if (scen) lines.push('场景：' + scen);
    card = lines.filter(Boolean).join('\n').trim();
  }

  // 世界书：读不到就是空串，不影响流程。
  // 扫描预算跟着「世界书截断」走——预算给小了，条目根本没被激活，
  // 后面截断多长都没意义。中文 1 字约 0.7 token，这里留足余量。
  let worldInfo = '';
  if (settings?.includeWorldInfo !== false) {
    const wiChars = settings?.worldInfoChars ?? 6000;
    const budget = Math.max(8192, Math.round(wiChars * 1.2));
    worldInfo = await getWorldInfo(budget);
  }

  return {
    summaries,
    bigSummary,
    lastBody,
    lastBodyId,
    lastUser,
    card,
    worldInfo,
    background: String(settings?.background || '').trim(),
    mode: getMode(),
    total: msgs.length,
  };
}

/** 把采集到的上下文拼成给 flash 看的快照。顺序按「由远到近」排。 */
export function buildSnapshot(ctx, settings) {
  const parts = [];
  const tail = Math.max(300, settings?.tailChars ?? 1400);
  const wiChars = Math.max(400, settings?.worldInfoChars ?? 2400);

  parts.push(
    `【模式】${
      ctx.mode === 'rp'
        ? '入梦·RP（客人是局内人，选项写第一人称动作）'
        : '观梦·小说（客人是场外导演，选项写镜头调度）'
    }`,
  );

  if (ctx.worldInfo) {
    const wi = ctx.worldInfo.length > wiChars ? ctx.worldInfo.slice(0, wiChars) + '\n……（世界书余下部分略）' : ctx.worldInfo;
    parts.push('【世界设定（世界书）】\n' + wi);
  }

  if (ctx.card) parts.push(ctx.card);

  if (ctx.background) parts.push('【背景设定】\n' + ctx.background);

  if (ctx.bigSummary) parts.push('【此前发生的事（大总结）】\n' + ctx.bigSummary);

  if (ctx.summaries.length) {
    parts.push('【最近几场摘要】\n' + ctx.summaries.map((s, i) => `(${i + 1}) ${s}`).join('\n'));
  }

  if (ctx.lastUser) parts.push('【客人上一句】\n' + ctx.lastUser.slice(0, 400));

  if (ctx.lastBody) {
    const body = ctx.lastBody;
    parts.push('【当前这一场（尾部）】\n' + (body.length > tail ? '……' + body.slice(-tail) : body));
  } else {
    parts.push('【注意】正文还没开始，按摘要里的局面给开局选项。');
  }

  return parts.join('\n\n');
}
