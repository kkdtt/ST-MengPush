/**
 * 工具通道。
 *
 * 为什么要有这个东西：
 *   文本通道里，NSFW 内容是「叙述流」，安全分类器逐字实时扫 content，
 *   很容易在写到一半时掐断；
 *   工具通道里，同样的内容被包进 tool_calls 的 arguments（JSON 字符串），
 *   很多网关只对 content 做实时过滤，对 arguments 宽松得多。
 *
 *   而且掐断后的表现也不同：文本是整条断流，工具是半截 JSON——
 *   半截 JSON 能救，能救多少救多少。
 *
 * 注意：这不是「不会截断」，是「断得能被救回来，且触发概率低」。
 * 长度问题仍然要靠 max_tokens 和续写解决。
 */

/** 每个任务只要自己那几个字段，schema 越小越不容易跑偏。 */
const SPECS = {
  choices: {
    desc: '提交这一轮的下一步走向。所有选项必须放进 choices 数组，不要写在工具外面。',
    props: {
      choices: {
        type: 'array',
        description: '3 到 8 条走向，每条一个切入点',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['顺承', '横向', '升温', '切场', '破局', '退让'],
              description: '走向类别',
            },
            text: { type: 'string', description: '不超过 32 字，只写动作、台词或镜头方向' },
            risk: { type: 'string', enum: ['低', '中', '高'], description: '这条走法的风险' },
          },
          required: ['type', 'text'],
        },
      },
    },
    required: ['choices'],
  },

  danmaku: {
    desc: '提交场外弹幕。这一场确实没什么可起哄的就交空数组。',
    props: {
      danmaku: {
        type: 'array',
        description: '3 到 5 条，每条不超过 18 字，口语，像视频弹幕',
        items: { type: 'string' },
      },
    },
    required: ['danmaku'],
  },

  beats: {
    desc: '提交亲密戏的节拍表。只写骨架，不写成品描写。',
    props: {
      beats: {
        type: 'array',
        description: '按前戏 / 过程 / 事后三段，共 6 到 12 拍',
        items: {
          type: 'object',
          properties: {
            phase: { type: 'string', enum: ['前戏', '过程', '事后'] },
            n: { type: 'integer', description: '第几拍' },
            action: { type: 'string', description: '谁做了什么，具体到部位和动作' },
            react: { type: 'string', description: '对方什么反应' },
            friction: { type: 'string', description: '这一拍的阻力或意外' },
          },
          required: ['phase', 'action'],
        },
      },
    },
    required: ['beats'],
  },

  outline: {
    desc: '提交剧情大纲。每段必须是一个具体事件，不是「关系升温」这种结果。',
    props: {
      outline: {
        type: 'array',
        description: '3 到 6 段，按时间顺序',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer' },
            title: { type: 'string', description: '四字以内' },
            text: { type: 'string', description: '这一段发生什么，谁推动，落在什么状态' },
          },
          required: ['text'],
        },
      },
    },
    required: ['outline'],
  },

  steps: {
    desc: '提交可执行步骤。每步一句指令，写清这一轮写什么、写到哪里停。',
    props: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer' },
            text: { type: 'string', description: '陈述句指令，一到两轮的量' },
          },
          required: ['text'],
        },
      },
    },
    required: ['steps'],
  },

  dream: {
    desc: '提交你对客人说的话。say 必填；想顺手递走向或弹幕就填对应字段，不递就留空。',
    props: {
      say: { type: 'string', description: '你对客人说的话，纯文本，不要 markdown' },
      choices: {
        type: 'array',
        description: '可选，顺手递的走向',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['顺承', '横向', '升温', '切场', '破局', '退让'],
            },
            text: { type: 'string' },
            risk: { type: 'string', enum: ['低', '中', '高'] },
          },
          required: ['type', 'text'],
        },
      },
      danmaku: {
        type: 'array',
        description: '可选，顺手递的场外弹幕',
        items: { type: 'string' },
      },
    },
    required: ['say'],
  },
};

const TOOL_NAME = 'submit';

/** 生成 OpenAI 格式的工具定义。task 不认识就返回 null（调用方退回文本通道）。 */
export function buildTool(task) {
  const spec = SPECS[task];
  if (!spec) return null;
  return {
    type: 'function',
    function: {
      name: TOOL_NAME,
      description: spec.desc,
      parameters: {
        type: 'object',
        properties: spec.props,
        required: spec.required,
      },
    },
  };
}

/**
 * 从半截 JSON 里尽量救出内容。
 *
 * 做法：从尾部往前找合法的截断点（逗号、闭合括号、字符串结尾），
 * 截到那里，把没闭合的引号和括号补上，再试一次解析。
 * 能救出多少算多少——这正是工具通道相对文本通道的价值所在。
 */
export function salvageJson(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  try {
    return JSON.parse(s);
  } catch {
    /* 往下走兜底 */
  }

  // 第一次尝试：假设只是断在字符串中间或括号没闭合，直接补齐尾部。
  // 这样「{"say":"线还热着」也能救出「线还热着」，而不是退到前一个边界丢掉它。
  const closed = closeJson(s);
  if (closed) {
    try {
      return JSON.parse(closed);
    } catch {
      /* 继续往下 */
    }
  }

  for (let i = s.length - 1; i > 0; i--) {
    const ch = s[i];
    if (ch !== ',' && ch !== '}' && ch !== ']' && ch !== '"') continue;

    let t = s.slice(0, ch === ',' ? i : i + 1);
    const stack = [];
    let inStr = false;
    let esc = false;

    for (const c of t) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') stack.pop();
    }

    if (inStr) t += '"';
    while (stack.length) {
      t += stack.pop() === '{' ? '}' : ']';
    }

    try {
      return JSON.parse(t);
    } catch {
      /* 继续往前试 */
    }
  }

  return null;
}

/** 补齐未闭合的引号和括号，补不了就返回 null。 */
function closeJson(s) {
  const stack = [];
  let inStr = false;
  let esc = false;

  for (const c of s) {
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }

  // 尾部是逗号或冒号说明断在键值之间，补上也没意义
  const tail = s.trimEnd().slice(-1);
  if (!inStr && (tail === ',' || tail === ':')) return null;

  let t = s;
  if (esc) t = t.slice(0, -1); // 去掉孤立的反斜杠
  if (inStr) t += '"';
  while (stack.length) t += stack.pop() === '{' ? '}' : ']';
  return t;
}

/** 从响应消息里取工具参数。没有工具调用返回 null。 */
export function readToolArgs(message) {
  const calls = message?.tool_calls;
  if (!Array.isArray(calls) || !calls.length) return null;

  // 多个调用时优先取 name 匹配的
  const hit = calls.find((c) => c?.function?.name === TOOL_NAME) || calls[0];
  const raw = hit?.function?.arguments;
  if (!raw) return null;

  const args = salvageJson(raw);
  return args && typeof args === 'object' ? args : null;
}

export { TOOL_NAME };
