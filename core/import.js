/**
 * 预设导入。
 *
 * 只做一件事：从 SillyTavern 预设 JSON 里抽出「决定这个世界怎么运转」的条目，
 * 拼成内核文本。
 *
 * 注意边界——预设 JSON 里**没有**这些，别指望它：
 *   · 世界书    → 独立文件，运行时用 getWorldInfoPrompt 实时读
 *   · 聊天记录  → .jsonl，运行时读 ctx.chat
 *   · 角色卡    → png，运行时读 ctx.characters
 *   · 变量      → chat_metadata，运行时读 ctx.chatMetadata
 * 它只有提示词。而这恰好是运行时读不到的那部分，所以互补。
 */

/** 想要的条目，按这个顺序排。keys 命中任意一个就收。 */
const WANTED = [
  { label: '人格', keys: ['弥彦·造梦师'] },
  { label: '宪章', keys: ['织梦宪章'] },
  { label: '契约', keys: ['梦境契约'] },
  { label: '总纲', keys: ['叙事与活人总纲', '叙事总纲'] },
  { label: '群像', keys: ['空间、群像与交锋'] },
  { label: '铁律', keys: ['描写铁律'] },
  { label: '转译', keys: ['输入转译'] },
  { label: '私密', keys: ['私密场景'] },
  { label: '推进', keys: ['推进·'] },
  { label: '裁决', keys: ['冲突裁决'] },
];

/** 去掉宏和注释——这些对旁路模型没意义，只会占字数。 */
export function cleanMacros(text) {
  return String(text || '')
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, '') // {{// 注释 }}
    .replace(/\{\{\s*(?:set|get)var::[^}]*\}\}/g, '')
    .replace(/\{\{\s*random::[^}]*\}\}/g, '')
    .replace(/\{\{\s*(?:user|char)\s*\}\}/g, '对方')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 解析预设 JSON。
 * @returns {{ok:boolean, error?:string, entries?:Array, kernel?:string, totalChars?:number}}
 */
export function parsePreset(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return { ok: false, error: '不是合法的 JSON：' + (e?.message || e) };
  }

  if (!data || !Array.isArray(data.prompts)) {
    return { ok: false, error: '这不像 SillyTavern 预设（找不到 prompts 数组）' };
  }

  // identifier → prompt
  const byId = new Map();
  for (const p of data.prompts) {
    if (p && p.identifier) byId.set(p.identifier, p);
  }

  // 按预设里的启用顺序走，拿不到就按原数组顺序
  let ordered = data.prompts;
  try {
    const order = data.prompt_order?.[0]?.order;
    if (Array.isArray(order)) {
      const seq = [];
      for (const item of order) {
        const p = byId.get(item.identifier);
        if (p) seq.push(p);
      }
      if (seq.length) ordered = seq;
    }
  } catch {
    /* 用原顺序 */
  }

  const buckets = new Map(); // label → [content]
  for (const p of ordered) {
    const name = String(p?.name || '');
    const content = String(p?.content || '');
    if (!name || !content.trim()) continue;

    for (const w of WANTED) {
      if (w.keys.some((k) => name.includes(k))) {
        const list = buckets.get(w.label) || [];
        list.push(content);
        buckets.set(w.label, list);
        break;
      }
    }
  }

  if (!buckets.size) {
    return {
      ok: false,
      error: '一条都没匹配上。这个预设的条目名可能跟《造梦师》不一样，试试手动填内核。',
    };
  }

  const entries = [];
  const parts = [];
  for (const w of WANTED) {
    const list = buckets.get(w.label);
    if (!list?.length) continue;
    for (const content of list) {
      const cleaned = cleanMacros(content);
      if (!cleaned) continue;
      entries.push({ label: w.label, name: w.label, chars: cleaned.length });
      parts.push(cleaned);
    }
  }

  const kernel = parts.join('\n\n');
  return {
    ok: true,
    entries,
    kernel,
    totalChars: kernel.length,
  };
}
