/**
 * 全局世界书。
 *
 * 跟 ST 自己那本世界书是两回事：ST 那本由 ST 按关键词/位置实时注入，
 * 插件只能读到「已经注入进 prompt 的部分」。这里导入的是一份独立副本，
 * 由插件自己决定拼不拼、拼多少。
 *
 * 条目只有两个状态：开 / 关。导入时按 ST 的灯色决定初始值——
 * 蓝灯（constant 且没被关掉）默认开，绿灯和手动关掉的默认关。
 */

/** 从各种形状的 JSON 里挖出条目数组。 */
function pickEntries(data) {
  const raw = data?.entries ?? data?.data?.entries ?? data;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.values(raw);
  return [];
}

/**
 * 解析世界书 JSON。
 *
 * 兼容 ST 导出的 `{ entries: { "0": {...} } }`、数组形式、以及裸数组。
 * 字段名也做了兜底：标题可能是 comment / name / title。
 */
export function parseWorldbook(text, fileName = '') {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }

  const list = pickEntries(data);
  if (!list.length) throw new Error('文件里没有世界书条目');

  const entries = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const content = String(e.content ?? e.text ?? '').trim();
    if (!content) continue;

    const name = String(e.comment ?? e.name ?? e.title ?? '').trim() || `条目 ${entries.length + 1}`;
    const keys = Array.isArray(e.key) ? e.key.map(String) : [];
    // 蓝灯 = constant 且没被关掉；绿灯（关键词触发）和关掉的一律默认关
    const isBlue = e.constant === true && e.disable !== true;

    entries.push({
      name,
      keys,
      content,
      chars: content.length,
      on: isBlue,
    });
  }

  if (!entries.length) throw new Error('条目里没有可用内容');

  return {
    name: fileName || String(data?.name || '世界书'),
    at: Date.now(),
    entries,
  };
}

/**
 * 把开着的条目拼成一段文本，供资料段使用。
 *
 * 位置由调用方决定（现在挂在 <世界规则与其他补充材料> 后面）。
 * 有字数预算：世界书动辄几万字，全塞进去会把上下文挤爆，
 * 超了按顺序截，并在末尾说明还有多少条没进来。
 */
export function buildWorldbookText(settings) {
  const wb = settings?.worldbook;
  const list = Array.isArray(wb?.entries) ? wb.entries : [];
  const on = list.filter((e) => e && e.on && String(e.content || '').trim());
  if (!on.length) return '';

  const budget = Math.max(500, Number(settings?.worldbookChars) || 40000);
  const parts = [];
  let used = 0;
  let skipped = 0;

  for (const e of on) {
    const body = String(e.content).trim();
    const room = budget - used;

    if (body.length <= room) {
      parts.push(body);
      used += body.length;
      continue;
    }

    // 还剩一点空间就截一段，太小就不塞了，免得半句话更误导
    if (room > 300) {
      parts.push(body.slice(0, room) + '\n……（此条余下部分略）');
      used = budget;
    }
    skipped++;
  }

  let text = parts.join('\n\n');
  if (skipped) {
    text += `\n\n（还有 ${skipped} 条世界书因字数上限没放进来）`;
  }
  return text;
}

/** 统计：给设置页显示「几条开着 / 共多少字」。 */
export function worldbookStats(wb) {
  const list = Array.isArray(wb?.entries) ? wb.entries : [];
  const on = list.filter((e) => e?.on);
  return {
    total: list.length,
    on: on.length,
    chars: on.reduce((n, e) => n + (e.chars || String(e.content || '').length), 0),
    totalChars: list.reduce((n, e) => n + (e.chars || String(e.content || '').length), 0),
  };
}
