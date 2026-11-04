/**
 * 冒烟测试：不需要浏览器，用最小 mock 跑通核心链路。
 *   node test/smoke.mjs
 */

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log(' FAIL  ' + name + (extra ? '  → ' + extra : ''));
  }
}

function eq(name, actual, expect) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(name, a === e, a + ' !== ' + e);
}

/* ---------------- mock 宿主 ---------------- */

const CHAT = [
  { name: 'You', is_user: true, mes: '我去便利店买点东西。' },
  {
    name: '林晚',
    is_user: false,
    mes: `<content>她把袖子往下扯了扯：「冻的。」

「你怎么才来。」</content>
<details><summary>此刻</summary>林晚｜大二学生</details>
<details><summary>摘要</summary>时间：2026年11月3日 21:40
地点：旧城区／便利店门口
对白：「你怎么才来。」
情报：她在楼下站了四十分钟
行为：买了两罐热咖啡
情感：从无所谓到有点在意</details>`,
  },
];

const extSettings = {
  meng_push_settings: {
    channels: [
      {
        id: 'ch_a',
        name: 'flash',
        url: 'https://api.demo.com',
        key: 'sk-test',
        model: 'gemini-2.5-flash',
        temperature: 0.95,
        maxTokens: 900,
        timeoutSec: 30,
        stream: false,
      },
    ],
    routing: { choices: 'ch_a', danmaku: 'ch_a', beats: 'ch_a' },
    modules: { choices: true, danmaku: false, beats: false },
    choiceCount: 5,
    jsonMode: true,
  },
};

// ST 的 getContext() 返回的是同一个 context 单例，mock 必须保持同一引用，
// 否则 writeChatMeta 写进临时对象、readChatMeta 读不到。
const CTX = {
  chat: CHAT,
  chatMetadata: { variables: { mode: 'novel' } },
  extensionSettings: extSettings,
  characters: [{ name: '林晚', description: '大二，建筑系。嘴硬，怕冷。', personality: '冷淡' }],
  characterId: 0,
  name2: '林晚',
  getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
  saveSettingsDebounced: () => {},
  saveMetadataDebounced: () => {},
  eventSource: { on: () => {}, off: () => {} },
  eventTypes: { GENERATION_ENDED: 'generation_ended' },
};

globalThis.window = {
  SillyTavern: { getContext: () => CTX },
};

/* ---------------- mock 接口 ---------------- */

let lastRequestBody = null;

globalThis.fetch = async (url, opt) => {
  lastRequestBody = JSON.parse(opt.body);
  const payload = {
    choices: [
      { type: '顺承', text: '把咖啡递过去一罐', risk: '低' },
      { type: '破局', text: '「你等我，还是等这罐咖啡。」', risk: '高' },
      { type: '升天', text: '这条 type 不合法，应被归到顺承', risk: '中' },
    ],
  };
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '```json\n' + JSON.stringify(payload) + '\n```' } }] }),
    text: async () => '',
  };
};

/* ---------------- 跑 ---------------- */

const { extractDetails, stripModules, getBody, parseJSON, collectContext, buildSnapshot } = await import(
  '../core/parse.js'
);
const { normalizeUrl, buildRequestBody } = await import('../core/api.js');
const settingsMod = await import('../core/settings.js');
const engine = await import('../core/engine.js');

console.log('\n— 解析层 —');
const msg = CHAT[1].mes;

eq('摘要只取摘要块', extractDetails(msg, '摘要').startsWith('时间：'), true);
eq('此刻不会串到摘要', extractDetails(msg, '此刻'), '林晚｜大二学生');
eq('正文剥掉全部模块', getBody(msg), '她把袖子往下扯了扯：「冻的。」\n\n「你怎么才来。」');
eq('裸文本兜底', getBody('就一句话。'), '就一句话。');
ok('坏 JSON 返回 null', parseJSON('不是 json') === null);
eq('围栏 JSON 能解', parseJSON('```json\n{"a":1}\n```'), { a: 1 });
eq('前后废话能抠', parseJSON('结果如下：{"a":1} 完毕'), { a: 1 });

console.log('\n— 上下文采集 —');
const s = settingsMod.load();
const ctx = collectContext(s);
eq('摘要抓到一条', ctx.summaries.length, 1);
ok('正文取到最后一条 AI 楼', ctx.lastBody.includes('冻的'));
eq('模式识别为小说', ctx.mode, 'novel');
ok('角色卡被精简带入', ctx.card.includes('林晚'));
ok('上一句用户输入', ctx.lastUser === '我去便利店买点东西。');

const snap = buildSnapshot(ctx, s);
ok('快照含模式说明', snap.includes('观梦'));
ok('快照含摘要', snap.includes('21:40'));
ok('快照不含破甲垫文', !snap.includes('破甲') && !snap.includes('织梦宪章'));

console.log('\n— 请求构造 —');
eq('裸域名补 /v1', normalizeUrl('https://api.demo.com'), 'https://api.demo.com/v1');
eq('已带 /v1 不动', normalizeUrl('https://api.demo.com/v1/'), 'https://api.demo.com/v1');
eq('完整端点去掉后缀', normalizeUrl('https://api.demo.com/v1/chat/completions'), 'https://api.demo.com/v1');
eq('自定义路径保留', normalizeUrl('https://api.demo.com/v2/coding'), 'https://api.demo.com/v2/coding');

const ch = settingsMod.channelFor('choices');
ok('渠道解析到 ch_a', ch?.id === 'ch_a');
ok('渠道配全判定', settingsMod.channelReady(ch) === true);

const rb = buildRequestBody(ch, [{ role: 'user', content: 'hi' }], false);
eq('走 ST 代理源', rb.chat_completion_source, 'openai');
eq('反向代理地址已规范化', rb.reverse_proxy, 'https://api.demo.com/v1');
eq('密钥走 proxy_password', rb.proxy_password, 'sk-test');
eq('声明不用工具', rb.tool_choice, 'none');
eq('非流式', rb.stream, false);

console.log('\n— 端到端 —');
let seen = null;
engine.subscribe((st) => {
  if (st.result?.choices?.length) seen = st.result;
});

await engine.run({ manual: true, tasks: ['choices'] });

const st = engine.getState();
eq('状态回到 idle', st.status, 'idle');
ok('拿到选项', st.result?.choices?.length >= 2);
eq('选项数不超过上限', st.result.choices.length <= s.choiceCount + 1, true);
eq('非法 type 归到顺承', st.result.choices[2]?.type, '顺承');
eq('风险字段保留', st.result.choices[1]?.risk, '高');
ok('结果带 messageId', typeof st.result?.messageId === 'number' && st.result.messageId === 1);
ok('请求体确实发出', lastRequestBody?.model === 'gemini-2.5-flash');
ok('提示词用了内核', String(lastRequestBody?.messages?.[0]?.content).includes('推进台'));
ok('用户消息含快照', String(lastRequestBody?.messages?.[1]?.content).includes('最近几场摘要'));

console.log('\n— 缓存 —');
const cached = engine.getCached(1);
ok('按 messageId 落缓存', !!cached && cached.choices.length === st.result.choices.length);
ok('历史已记录', engine.loadHistory().length >= 1);

console.log(`\n${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
