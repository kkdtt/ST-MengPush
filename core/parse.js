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

import { getChatVariable, getCharInfo, getVisibleMessages, getWorldInfo, readChatMeta } from './ctx.js?v=2.9.3';

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

/**
 * 取正文。
 * 有自定义正则就用它（第一个捕获组，没有捕获组就整段匹配），
 * 没配或写错就退回默认：优先 <content>，再退回「整条去模块」。
 */
export function getBody(message, settings) {
  if (!message) return '';
  const custom = settings?.bodyRegex;
  if (custom) {
    try {
      const re = new RegExp(custom, 'i');
      const m = re.exec(message);
      if (m) {
        const hit = m[1] !== undefined ? m[1] : m[0];
        if (hit && hit.trim()) return hit.trim();
      }
    } catch {
      /* 正则写错，静默退回默认 */
    }
  }
  const m = /<content>([\s\S]*?)<\/content>/i.exec(message);
  if (m) return m[1].trim();
  return stripModules(message);
}

/** 取摘要。同上，支持自定义正则。 */
export function extractSummary(text, settings) {
  if (!text) return '';
  const custom = settings?.summaryRegex;
  if (custom) {
    try {
      const re = new RegExp(custom, 'i');
      const m = re.exec(text);
      if (m) {
        const hit = m[1] !== undefined ? m[1] : m[0];
        if (hit && hit.trim()) return hit.trim();
      }
    } catch {
      /* 退回默认 */
    }
  }
  return extractDetails(text, '摘要');
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
  const maxCount = Math.max(1, settings?.summaryDepth ?? 200);
  // 最近 N 层会以「真实对话」的形式进 messages，它们的摘要就不必重复取了
  const recentN = Math.max(0, settings?.historyDepth ?? 6);
  const cutoff = msgs.length - recentN;
  let used = 0;

  for (let i = cutoff - 1; i >= 0; i--) {
    const s = extractSummary(msgs[i].mes, settings);
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
    lastBody = getBody(msgs[i].mes, settings);
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

  // 外部上下文：从检视页「设为上下文」存进来的完整 payload。
  // 有它就不再自己拼世界书/摘要——那份已经是主模型收到的原文，重复拼只会打架。
  const external = String(readChatMeta('meng_push_external_context') || '').trim();

  return {
    external,
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

/**
 * 拼 system 段：世界的「物理法则」。
 *
 * 这些是设定，不是请求。放进 system 才能拿到 system 的权威性——
 * 之前全塞在 user 里，模型会当成「用户提供的一些背景材料」，
 * 服从度差一大截，破甲效果也跟着掉。
 */
export function buildSystemContext(ctx, settings) {
  const wiChars = Math.max(400, settings?.worldInfoChars ?? 6000);
  const wi = ctx.worldInfo || { before: '', after: '' };

  // 有外部上下文就整段用它，不再重复拼世界书和角色卡
  if (ctx.external) {
    return '【主模型本轮收到的完整请求（以此为准）】\n' + ctx.external;
  }

  const parts = [];

  // 世界书 before 是「世界观与人物」，角色卡也归到这里
  const charParts = [];
  if (wi.before) charParts.push(clip(wi.before, wiChars));
  if (ctx.card) charParts.push(ctx.card);
  if (charParts.length) {
    parts.push('<世界观与人物设定>\n' + charParts.join('\n\n') + '\n</世界观与人物设定>');
  }

  // 世界书 after 是「规则与补充」
  const ruleParts = [];
  if (wi.after) ruleParts.push(clip(wi.after, wiChars));
  if (ruleParts.length) {
    parts.push('<世界规则与其他补充材料>\n' + ruleParts.join('\n\n') + '\n</世界规则与其他补充材料>');
  }

  return parts.join('\n\n');
}

/** 超长截断，带上提示，免得模型以为资料就这么多。 */
function clip(text, max) {
  const str = String(text || '');
  return str.length > max ? str.slice(0, max) + '\n……（余下部分略）' : str;
}

/** 去掉 <user> 这类宏标记，换成预设里的称呼「主控」。 */
function cleanUserMarks(text) {
  return String(text || '')
    .replace(/\{\{\s*user\s*\}\}/gi, '主控')
    .replace(/<\/?user>/gi, '')
    .trim();
}

/**
 * 拼 user 段：此刻的事实与这一轮要做的事。
 *
 * 摘要、上一句、正文尾部都是「最近发生了什么」，属于对话事实，
 * 放 user 里符合模型对对话结构的预期。
 */
export function buildUserContext(ctx, settings) {
  const parts = [];
  const tail = Math.max(300, settings?.tailChars ?? 3000);

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

/** 兼容旧调用：两段拼在一起。engine 已经分开用了，这里留给测试和外部引用。 */
export function buildSnapshot(ctx, settings) {
  return buildSystemContext(ctx, settings) + '\n\n---\n\n' + buildUserContext(ctx, settings);
}

/**
 * 资料段（第 3 条 system）：世界书 + 角色卡 + 背景 + 大总结 + 更早的摘要。
 *
 * 用户方案里这一条单独成 system，夹在「认领身份」和「真实对话」之间，
 * 读起来像「设定补充」，而不是「用户提供的材料」。
 */
export function buildMaterialContext(ctx, settings) {
  const base = buildSystemContext(ctx, settings);
  const parts = base ? [base] : [];

  // 过往事件：手填的背景（通常是存档/大总结）→ 自动抓到的大总结 → 更早的摘要
  const hist = [];
  if (ctx.background) hist.push(ctx.background);
  if (ctx.bigSummary) hist.push(ctx.bigSummary);
  if (ctx.summaries.length) {
    hist.push(ctx.summaries.map((s, i) => `(${i + 1}) ${s}`).join('\n'));
  }

  if (hist.length) {
    parts.push('<过往事件>\n' + cleanUserMarks(hist.join('\n\n')) + '\n</过往事件>');
  }

  return parts.join('\n\n');
}

/**
 * 真实对话段（第 4 条起）：最近 N 层，用户与助手交替。
 *
 * 用真实 role 而不是把正文塞进 user 的文本里——模型看到的是「我以前编的梦」，
 * 而不是「用户给我的一段材料」。这是降低戒心的关键。
 */
export function buildChatHistory(settings) {
  const n = Math.max(0, settings?.historyDepth ?? 6);
  if (!n) return [];

  return getVisibleMessages()
    .slice(-n)
    .map((m) => ({
      role: m.is_user ? 'user' : 'assistant',
      content: m.is_user ? String(m.mes || '').trim() : getBody(m.mes, settings),
    }))
    .filter((m) => m.content);
}
