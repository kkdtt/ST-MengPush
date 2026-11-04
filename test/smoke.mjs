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
  {
    name: 'System',
    is_user: true,
    mes: '<details><summary>大总结</summary>前三章：她在便利店打工，他每周三来买同一款咖啡，从没说过多余的话。</details>',
  },
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
  getWorldInfoPrompt: async () => ({
    worldInfoBefore: '【世界观】旧城区常年下雨，便利店是唯一 24 小时亮着的地方。',
    worldInfoAfter: '',
    worldInfoDepth: [],
  }),
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
const msg = CHAT[2].mes;

eq('摘要只取摘要块', extractDetails(msg, '摘要').startsWith('时间：'), true);
eq('此刻不会串到摘要', extractDetails(msg, '此刻'), '林晚｜大二学生');
eq('正文剥掉全部模块', getBody(msg), '她把袖子往下扯了扯：「冻的。」\n\n「你怎么才来。」');
eq('裸文本兜底', getBody('就一句话。'), '就一句话。');
ok('坏 JSON 返回 null', parseJSON('不是 json') === null);
eq('围栏 JSON 能解', parseJSON('```json\n{"a":1}\n```'), { a: 1 });
eq('前后废话能抠', parseJSON('结果如下：{"a":1} 完毕'), { a: 1 });

console.log('\n— 上下文采集 —');
const s = settingsMod.load();
const ctx = await collectContext(s);
eq('摘要抓到一条', ctx.summaries.length, 1);
ok('正文取到最后一条 AI 楼', ctx.lastBody.includes('冻的'));
eq('模式识别为小说', ctx.mode, 'novel');
ok('角色卡被精简带入', ctx.card.includes('林晚'));
ok('上一句用户输入', ctx.lastUser === '我去便利店买点东西。');

const snap = buildSnapshot(ctx, s);
ok('快照含模式说明', snap.includes('观梦'));
ok('快照含摘要', snap.includes('21:40'));
ok('快照不含破甲垫文', !snap.includes('破甲') && !snap.includes('织梦宪章'));
ok('世界书进了快照', snap.includes('旧城区常年下雨'));
ok('大总结进了快照', snap.includes('每周三来买同一款咖啡'));
ok('角色卡带性格字段', snap.includes('性格：'));
ok('快照按由远到近排序', snap.indexOf('世界设定') < snap.indexOf('最近几场摘要'));

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

console.log('\n— 标签解析（抗截断）—');

const xmlChoices = `<option type="顺承" risk="低">把咖啡递过去一罐</option>
<option type="破局" risk="高">「你等我，还是等这罐咖啡。」</option>
<option type="升温" risk="中">把外套脱下来搭在她肩上</option>`;

const c3 = engine.parseChoices(xmlChoices, 3);
eq('<option> 解析出三条', c3.length, 3);
eq('属性 type 生效', c3[1].type, '破局');
eq('属性 risk 生效', c3[1].risk, '高');
eq('标签正文进 text', c3[0].text, '把咖啡递过去一罐');

// 模拟截断：最后一条只有开标签，没有闭合
const cut = xmlChoices + '\n<option type="切场" risk="低">切到二十分钟后，两个人坐在';
eq('截断时保住已闭合的三条', engine.parseChoices(cut, 3).length, 3);
ok('截断的残条不会混进来', !engine.parseChoices(cut, 3).some((c) => c.text.includes('二十分钟后')));

eq('JSON 仍能兜底', engine.parseChoices('{"choices":[{"type":"破局","text":"问她","risk":"高"}]}', 5)[0].type, '破局');

eq('<dm> 解析', engine.parseDanmaku('<dm>嘴上说冻的</dm>\n<dm>这拉链是故意的吧</dm>').length, 2);
eq('dm 截断保住前面', engine.parseDanmaku('<dm>一</dm>\n<dm>二</dm>\n<dm>三').length, 2);
eq('dm 空输入返回空', engine.parseDanmaku('').length, 0);
eq('dm 不把 JSON 残片当弹幕', engine.parseDanmaku('{"danmaku":["笑死"]}').length, 1);

const bs = engine.parseBeats(`<beat phase="前戏" n="1">
action: 她背对着门，钥匙插了两次没进去
react: 手停住，没回头
friction: 楼道里有人上下楼
</beat>`);
eq('<beat> 解析', bs.length, 1);
eq('beat action 字段', bs[0].action, '她背对着门，钥匙插了两次没进去');
eq('beat friction 字段', bs[0].friction, '楼道里有人上下楼');

// 创作页的两个解析器
const ol = engine.parseOutline('<outline n="1" title="拉链">她把拉链卡住，他伸手帮忙</outline>\n<outline n="2" title="外套">他把外套搭在她肩上</outline>');
eq('<outline> 解析', ol.length, 2);
eq('outline title 属性', ol[0].title, '拉链');
eq('outline 正文', ol[0].text, '她把拉链卡住，他伸手帮忙');

const sp = engine.parseSteps('<step n="1">写她插钥匙，插了两次没进去</step>\n<step n="2">写他伸手把钥匙转正</step>');
eq('<step> 解析', sp.length, 2);
eq('step 默认未完成', sp[0].done, false);
eq('step 截断保住前面', engine.parseSteps('<step n="1">一</step>\n<step n="2">二</step>\n<step n="3">三').length, 2);

// 梦中梦
const dr = engine.parseDream('<say>坐。线还热着。</say>\n<option type="顺承" risk="低">把咖啡递过去</option>');
eq('dream 提取 say', dr.say, '坐。线还热着。');
ok('dream 顺带选项', dr.choices.length >= 1);  // 会自动补一条「退让」
eq('dream 选项类型', dr.choices[0].type, '顺承');
ok('无 say 时兜底不空', engine.parseDream('<option type="破局" risk="高">问她</option>').say.length > 0);
eq('dream 纯文本也能读', engine.parseDream('线还够用。').say, '线还够用。');

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
ok('结果带 messageId', typeof st.result?.messageId === 'number' && st.result.messageId === 2);
ok('请求体确实发出', lastRequestBody?.model === 'gemini-2.5-flash');
ok('提示词用了内核', String(lastRequestBody?.messages?.[0]?.content).includes('推进台'));
ok('用户消息含快照', String(lastRequestBody?.messages?.[1]?.content).includes('最近几场摘要'));

console.log('\n— 缓存 —');
const cached = engine.getCached(2);
ok('按 messageId 落缓存', !!cached && cached.choices.length === st.result.choices.length);
ok('历史已记录', engine.loadHistory().length >= 1);

console.log(`\n${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
