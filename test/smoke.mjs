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
    historyDepth: 0,
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
    worldInfoAfter: '【规则】门禁十一点，走廊不许喧哗。',
    worldInfoDepth: [],
  }),
};

globalThis.window = {
  SillyTavern: { getContext: () => CTX },
};

/* ---------------- mock 接口 ---------------- */

let lastRequestBody = null;

globalThis.__dreamCall = 0;

globalThis.fetch = async (url, opt) => {
  lastRequestBody = JSON.parse(opt.body);
  // 梦中梦的提示词里有「线筐」，内核里没有——用这个区分两条链路
  const allText = (lastRequestBody.messages || []).map((m) => String(m.content || '')).join('\n');
  if (allText.includes('线筐')) {
    globalThis.__dreamCall += 1;
    const first = globalThis.__dreamCall === 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: { content: first ? '<say>前半句，撞到上限' : '后半句，接着写完</say>' },
            finish_reason: first ? 'length' : 'stop',
          },
        ],
      }),
      text: async () => '',
    };
  }

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
    json: async () => ({
      choices: [{ message: { content: '```json\n' + JSON.stringify(payload) + '\n```' }, finish_reason: 'stop' }],
    }),
    text: async () => '',
  };
};

/* ---------------- 跑 ---------------- */

const {
  extractDetails,
  stripModules,
  getBody,
  parseJSON,
  collectContext,
  buildSnapshot,
  buildMaterialContext,
  buildMemoryContext,
  buildChatHistory,
  buildRecentBodies,
  extractSummary,
} = await import('../core/parse.js');
const { normalizeUrl, buildRequestBody } = await import('../core/api.js');
// 必须用带版本号的 URL 导入，否则跟 engine 内部引用的是两个模块实例，
// 改 settings 里的值不会影响 engine 读到的 cache
const { VERSION: V0 } = await import('../core/version.js');
const settingsMod = await import(`../core/settings.js?v=${V0}`);
const engine = await import('../core/engine.js');
const importer = await import('../core/import.js');
const toolsMod = await import('../core/tools.js');
const prompts = await import('../core/prompts.js');
const wbMod = await import('../core/worldbook.js');

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

const mat = buildMaterialContext(ctx, s);
ok('不再输出【当前模式】', !mat.includes('当前模式'));
ok('有世界观与人物设定块', mat.includes('<世界观与人物设定>'));
ok('有世界规则与其他补充材料块', mat.includes('<世界规则与其他补充材料>'));
const mem = buildMemoryContext(ctx, s);
ok('记忆层有过往事件块', mem.includes('<过往事件>'));
ok('记忆层只有过往事件', mem.includes('<过往事件>') && !mem.includes('<梦境资料>'));
ok('资料层有梦境资料壳', mat.includes('<梦境资料>'));
ok('世界书 before 落在世界观块', mat.indexOf('旧城区常年下雨') < mat.indexOf('</世界观与人物设定>'));
ok('世界书 after 落在规则块', mat.indexOf('门禁十一点') > mat.indexOf('<世界规则与其他补充材料>'));
ok('角色卡落在世界观块', mat.indexOf('性格：') < mat.indexOf('</世界观与人物设定>'));
ok('大总结落在过往事件块', mem.indexOf('每周三来买同一款咖啡') > mem.indexOf('<过往事件>'));
ok('摘要在过往事件块里', mem.indexOf('21:40') > mem.indexOf('<过往事件>'));
ok('过往事件不带 user 标记', !/<\/?user>/.test(mat));
ok('资料段不含破甲垫文', !mat.includes('破甲') && !mat.includes('织梦宪章'));

// 外部导入的完整上下文
CTX.chatMetadata['meng_push_external_context'] = '[system]\n完整预设\n\n[user]\n这是主模型的 payload';
const ctxExt = await collectContext(s);
const snapExt = buildSnapshot(ctxExt, s);
ok('外部上下文被采用', snapExt.includes('这是主模型的 payload'));
ok('外部上下文时不再拼世界书', !snapExt.includes('世界设定（世界书）'));
ok('外部上下文有说明前缀', snapExt.includes('主模型本轮收到的完整请求'));
CTX.chatMetadata['meng_push_external_context'] = '';

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
eq('step 解析出序号', sp[0].n, 1);
eq('step 截断保住前面', engine.parseSteps('<step n="1">一</step>\n<step n="2">二</step>\n<step n="3">三').length, 2);

// 梦中梦
const dr = engine.parseDream('<say>坐。线还热着。</say>\n<option type="顺承" risk="低">把咖啡递过去</option>');
eq('dream 提取 say', dr.say, '坐。线还热着。');
ok('dream 顺带选项', dr.choices.length >= 1);  // 会自动补一条「退让」
eq('dream 选项类型', dr.choices[0].type, '顺承');
ok('无 say 时兜底不空', engine.parseDream('<option type="破局" risk="高">问她</option>').say.length > 0);
eq('dream 纯文本也能读', engine.parseDream('线还够用。').say, '线还够用。');

// 预设导入（用真实的预设文件验证，文件不在就跳过）
const fsmod = await import('node:fs');
const presetPath = 'D:/浏览器下载/造梦师_弥彦_v6.9_通用_带面板.json';
if (fsmod.existsSync(presetPath)) {
  const r = importer.parsePreset(fsmod.readFileSync(presetPath, 'utf8'));
  ok('预设解析成功', r.ok, r.error || '');
  ok('提取到六条以上', r.entries.length >= 6, '实际 ' + r.entries.length);
  ok('含宪章', r.entries.some((e) => e.label === '宪章'));
  ok('含人格', r.entries.some((e) => e.label === '人格'));
  ok('含私密场景（两条）', r.entries.filter((e) => e.label === '私密').length === 2);
  ok('内核字数够用', r.totalChars > 4000, '实际 ' + r.totalChars);
  ok('宏已清干净', !/\{\{/.test(r.kernel));
  ok('不含破甲条目', !r.kernel.includes('破甲'));
  ok('不含存档条目', !r.kernel.includes('读档'));
  eq('坏 JSON 有报错', importer.parsePreset('{oops').ok, false);
  eq('非预设 JSON 有报错', importer.parsePreset('{"a":1}').ok, false);
} else {
  console.log('  skip  预设文件不存在，跳过导入测试');
}

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
/** 按内容找内核：破甲是小说样本、设置是工作性质声明，都靠特征排除掉 */
function kernelIndex(msgs) {
  const list = msgs || [];
  // 用标签定位，别用「弥彦」二字——设置层那句「弥彦，看来刚才…」也含这两个字
  let i = list.findIndex(
    (m) => m.role === 'system' && String(m.content || '').includes('<弥彦·造梦师>'),
  );
  if (i < 0) {
    i = list.findIndex((m) => m.role === 'system' && String(m.content || '').includes('织梦宪章'));
  }
  return i < 0 ? 0 : i;
}
const ki = kernelIndex(lastRequestBody?.messages);
ok('提示词用了内核', String(lastRequestBody?.messages?.[ki]?.content).includes('弥彦'));
// 五段式结构
const M = lastRequestBody?.messages || [];
const KI = kernelIndex(M);
ok('内核是 system', M[KI]?.role === 'system' && M[KI].content.includes('弥彦'));
eq('内核之后是资料', M[KI + 1]?.role, 'system');
ok('资料带抬头引导语', String(M[KI + 1]?.content).includes('抬起头'));
ok('资料段含世界书', M[KI + 1]?.content.includes('旧城区常年下雨'));
// 认领挪到聊天记录之后了
ok('倒数第二条是认领', M[M.length - 2]?.role === 'assistant', '实际 ' + M[M.length - 2]?.role);
ok('认领说「我全都想起来了」', String(M[M.length - 2]?.content).includes('全都想起来了'));
ok('最后一条是任务', M[M.length - 1]?.role === 'system');
ok('认领在记忆层之后', M.length - 2 > M.findIndex((m) => String(m.content).includes('<过往事件>')));
ok('认领前有询问层', M[M.length - 3]?.role === 'system' && String(M[M.length - 3]?.content).includes('想起来了'));
ok('资料段含角色卡', M[KI + 1].content.includes('林晚'));
const MEM = M.find((m) => String(m.content).includes('<过往事件>'));
ok('记忆层单独一条', !!MEM);
ok('记忆层含大总结', String(MEM?.content).includes('每周三来买同一款咖啡'));
ok('记忆层不再带「当事实用」那句', !String(MEM?.content).includes('当事实用'));
ok('记忆层在资料之后', M.indexOf(MEM) > KI + 1);
ok('最后一段是任务', M[M.length - 1].role === 'system' && M[M.length - 1].content.includes('下一步'));
ok('资料段不混正文', !M[KI + 1].content.includes('冻的'));

// 真实对话段：最近 N 层以 user/assistant 交替出现
s.historyDepth = 6;
const hist = buildChatHistory(s);
ok('对话段有内容', hist.length > 0);
ok('对话段角色合法', hist.every((m) => m.role === 'user' || m.role === 'assistant'));
ok('对话段含正文', hist.some((m) => m.content.includes('冻的')));
s.historyDepth = 0;

console.log('\n— 缓存 —');
const cached = engine.getCached(2);
ok('按 messageId 落缓存', !!cached && cached.choices.length === st.result.choices.length);
ok('历史已记录', engine.loadHistory().length >= 1);

// 请求检视
// 注意必须用带 ?v= 的同一个 URL 导入：api.js 里 import 的是 './inspect.js?v=x.y.z'，
// 裸路径在 node 里会被当成另一个模块实例，records 是两份，读不到。
const { VERSION } = await import('../core/version.js');
const insp = await import(`../core/inspect.js?v=${VERSION}`);
insp.install();
await globalThis.fetch('/api/backends/chat-completions/generate', {
  method: 'POST',
  body: JSON.stringify({
    model: 'demo-model',
    temperature: 0.9,
    max_tokens: 500,
    stream: false,
    messages: [
      { role: 'system', content: '这是系统提示' },
      { role: 'user', content: '这是用户输入' },
    ],
  }),
});
await globalThis.fetch('/api/other/endpoint', { method: 'POST', body: '{}' });

const recs = insp.getRecords();
eq('抓到生成请求', recs.length, 1);
eq('非生成端点不记', recs.filter((r) => r.url.includes('/api/other')).length, 0);
eq('模型名记录正确', recs[0].model, 'demo-model');
eq('消息条数', recs[0].count, 2);
eq('字数统计', recs[0].chars, '这是系统提示'.length + '这是用户输入'.length);
eq('参数被记下', recs[0].temperature, 0.9);
ok('默认判为主对话', recs[0].self === false);

insp.markSelf(1);
await globalThis.fetch('/api/backends/chat-completions/generate', {
  method: 'POST',
  body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
});
insp.markSelf(-1);
ok('自身请求被标出来', insp.getRecords()[0].self === true);
eq('最多保留八条', (() => { for (let i = 0; i < 12; i++) insp.getRecords(); return insp.getRecords().length; })(), 2);

// 工具定义与接管识别
await globalThis.fetch('/api/backends/chat-completions/generate', {
  method: 'POST',
  body: JSON.stringify({
    model: 'x',
    messages: [{ role: 'system', content: '[STRUCTURED_TRANSFER] 预设脚本改写过的请求' }],
    tools: [{ type: 'function', function: { name: 'mh_scene', description: '场景', parameters: {} } }],
    tool_choice: 'required',
  }),
});
const toolRec = insp.getRecords()[0];
ok('记录了 tools', toolRec.tools.length === 1, '实际 ' + toolRec.tools.length);
eq('工具名记对', toolRec.tools[0].name, 'mh_scene');
eq('tool_choice 记对', toolRec.toolChoice, 'required');
ok('识别出被脚本接管', toolRec.hijacked === true);
ok('token 估算含 tools', toolRec.tokens > 0);

insp.clearRecords();
eq('清空后为零', insp.getRecords().length, 0);

// 自定义解析正则
const custom = { bodyRegex: '<正文>([\\s\\S]*?)<\\/正文>', summaryRegex: '<摘要>([\\s\\S]*?)<\\/摘要>' };
eq('自定义正文正则生效', getBody('<正文>你好</正文>', custom), '你好');
eq('自定义摘要正则生效', extractSummary('<摘要>时间：晚上</摘要>', custom), '时间：晚上');
eq('正则写坏时退回默认', getBody('<content>默认</content>', { bodyRegex: '([' }), '默认');
eq('没配正则时走默认', getBody('<content>默认</content>', {}), '默认');

// 背景设定归到过往事件
const matBg = buildMemoryContext({ ...ctx, background: '这是手填的存档' }, s);
const bgAt = matBg.indexOf('这是手填的存档');
ok('背景在过往事件块内', bgAt > matBg.indexOf('<过往事件>') && bgAt < matBg.indexOf('</过往事件>'));
ok('背景不在规则块', !(bgAt > matBg.indexOf('<世界规则与其他补充材料>') && bgAt < matBg.indexOf('</世界规则与其他补充材料>')));

// token 估算
ok('中文四字约三 token', Math.abs(insp.estimateTokens('你好世界') - 3) <= 1, String(insp.estimateTokens('你好世界')));
eq('空串零 token', insp.estimateTokens(''), 0);
ok('英文也有 token', insp.estimateTokens('hello world') >= 2);

// markdown 清理
eq('清掉加粗', engine.stripMarkdown('**重点**'), '重点');
eq('清掉标题', engine.stripMarkdown('#### 标题'), '标题');
eq('清掉行内代码', engine.stripMarkdown('`code`'), 'code');
eq('列表换成圆点', engine.stripMarkdown('- 一\n- 二'), '· 一\n· 二');
ok('分隔线被清掉', !engine.stripMarkdown('上\n---\n下').includes('---'));
ok('parseDream 里已清理', !engine.parseDream('<say>**坐。**线还热着。</say>').say.includes('**'));

// 梦中梦用更大的输出上限，并在被截断时自动续写
globalThis.__dreamCall = 0;
await engine.runDream('林晚现在在想什么');
eq('上限来自渠道', lastRequestBody.max_tokens, s.channels[0].maxTokens);
eq('触发了一次续写（共两次请求）', globalThis.__dreamCall, 2);
// 注意：这里拿到的是「续写请求」，最后一条是续写指令，不是任务段
const dmMsgs = lastRequestBody.messages || [];
const DKI = kernelIndex(dmMsgs);
ok('梦中梦有内核', String(dmMsgs[DKI]?.content || '').includes('弥彦'));
eq('梦中梦内核之后是资料', dmMsgs[DKI + 1]?.role, 'system');
ok('梦中梦最后有认领', dmMsgs[dmMsgs.length - 2]?.role === 'assistant');
ok('梦中梦有认领', dmMsgs.some((m) => m.role === 'assistant' && m.content.length > 20));

// 新提示词用了 {{user_last_input}}，不会再追加【客人刚说】，改按人格标记找
const taskMsg = dmMsgs.find(
  (m) => m.role === 'system' && String(m.content || '').includes('线筐'),
);
ok('任务段存在且是 system', !!taskMsg);
ok('任务段含弥彦人格', String(taskMsg?.content || '').includes('线筐'));
ok('梦中梦也用同一套开场', String(dmMsgs[0].content).includes('走廊'));

// 占位符：写了就替换到指定位置，不再末尾追加
const origDream = s.prompts.dream;
s.prompts.dream = '第五层插槽。你是造梦师弥彦，线筐在案头。客人说：{{user_last_input}}　请据此回答。';
globalThis.__dreamCall = 0;
await engine.runDream('这是测试输入');
const allDream = (lastRequestBody.messages || []).map((m) => String(m.content || '')).join('\n');
ok('占位符被替换成实际输入', allDream.includes('这是测试输入'));
ok('替换后不再追加【客人刚说】', !allDream.includes('【客人刚说】'));
ok('占位符本身不残留', !allDream.includes('{{user_last_input}}'));
s.prompts.dream = origDream;

const dreamMsgs = engine.getDream().messages;
const lastSay = dreamMsgs[dreamMsgs.length - 1]?.text || '';
ok('续写内容已拼接', lastSay.includes('前半句') && lastSay.includes('后半句'), lastSay.slice(0, 60));
ok('续写后没有残留标签', !/<\/?say>/.test(lastSay));

// 工具通道
const toolDef = toolsMod.buildTool('choices');
ok('工具定义有名字', toolDef.function.name === 'submit');
ok('工具只含 choices 字段', !!toolDef.function.parameters.properties.choices);
ok('工具不含别的任务字段', !toolDef.function.parameters.properties.say);
eq('未知任务返回 null', toolsMod.buildTool('不存在'), null);

// 每个任务都必须有工具定义——少一个，那个任务就会悄悄退回文本通道
for (const t of ['choices', 'moves', 'intro', 'profile', 'beats', 'outline', 'steps', 'dream', 'danmaku']) {
  ok(`工具覆盖 ${t}`, !!toolsMod.buildTool(t));
}

eq('完整 JSON 正常解析', toolsMod.salvageJson('{"a":1}').a, 1);
eq('半截数组能救', toolsMod.salvageJson('{"choices":[{"type":"顺承","text":"递咖啡"}').choices.length, 1);
eq('半截字符串能救', toolsMod.salvageJson('{"say":"线还热着').say, '线还热着');
eq('空输入返回 null', toolsMod.salvageJson(''), null);

const toolArgs = toolsMod.readToolArgs({
  tool_calls: [
    { function: { name: 'submit', arguments: '{"choices":[{"type":"破局","text":"问她","risk":"高"}]}' } },
  ],
});
eq('从 tool_calls 取参数', toolArgs.choices[0].type, '破局');
eq('没有工具调用返回 null', toolsMod.readToolArgs({ content: 'hi' }), null);

// 解析器接受工具参数对象
eq('选项对象输入', engine.parseChoices({ choices: [{ type: '退让', text: '不动' }] }, 5)[0].type, '退让');
eq('弹幕对象输入', engine.parseDanmaku({ danmaku: ['笑死'] })[0], '笑死');
eq('节拍对象输入', engine.parseBeats({ beats: [{ phase: '前戏', action: '抵住' }] })[0].action, '抵住');
eq('大纲对象输入', engine.parseOutline({ outline: [{ n: 1, title: '拉链', text: '卡住' }] })[0].title, '拉链');
eq('步骤对象输入', engine.parseSteps({ steps: [{ n: 1, text: '写她插钥匙' }] })[0].text, '写她插钥匙');
eq('梦中梦对象输入', engine.parseDream({ say: '**坐。**' }).say, '坐。');

// 渠道参数
const chTopP = { ...ch, topP: 0.7 };
eq('top_p 进请求体', buildRequestBody(chTopP, [], false).top_p, 0.7);
ok('topP 为 1 时不发', !('top_p' in buildRequestBody({ ...ch, topP: 1 }, [], false)));

// 配置导入导出
const exported = JSON.parse(settingsMod.exportConfig());
ok('导出含渠道', Array.isArray(exported.settings.channels));
ok('导出含提示词', typeof exported.settings.prompts === 'object');
ok('导出带版本号', typeof exported.version === 'string');
ok('导出带时间', typeof exported.exportedAt === 'string');

settingsMod.importConfig(JSON.stringify({ settings: { choiceCount: 9 } }));
eq('导入后自定义值生效', settingsMod.get().choiceCount, 9);
ok('导入后默认值补齐', typeof settingsMod.get().maxReplyTokens === 'undefined' && typeof settingsMod.get().choiceCount === 'number');
eq('导入非法内容会报错', (() => { try { settingsMod.importConfig('不是json'); return 'no'; } catch { return 'ok'; } })(), 'ok');

// 响应结果记录
insp.clearRecords();
await globalThis.fetch('/api/backends/chat-completions/generate', {
  method: 'POST',
  body: JSON.stringify({ model: 'x', messages: [] }),
});
insp.attachResult({ hasTool: true, toolName: 'submit', finishReason: 'tool_calls', chars: 0 });
const withResult = insp.getRecords()[0];
ok('结果被记录', withResult.result?.hasTool === true);
eq('工具名被记录', withResult.result?.toolName, 'submit');
eq('finish_reason 被记录', withResult.result?.finishReason, 'tool_calls');

// 上限只看渠道：渠道没填就不发 max_tokens
const noCap = buildRequestBody({ ...ch, maxTokens: 0 }, [], false);
ok('渠道没填上限时不发 max_tokens', !('max_tokens' in noCap), JSON.stringify(Object.keys(noCap)));

// 创作页也要走统一框架
// 前面的导入导出测试把渠道清空了，先补回来
settingsMod.patch({ channels: [ch] });
try {
  await engine.runStory('outline', { keyword: '测试关键词', scale: 'medium' });
} catch {
  /* mock 返回的不是大纲格式，解析会失败，但请求已经发出，够检查结构了 */
}
const om = lastRequestBody?.messages || [];
const OKI = kernelIndex(om);
eq('大纲有内核', om[OKI]?.role, 'system');
eq('大纲内核之后是资料', om[OKI + 1]?.role, 'system');
ok('大纲最后有认领', om[om.length - 2]?.role === 'assistant');
ok('大纲有认领', om.some((m) => m.role === 'assistant' && m.content.length > 20));
ok('messages 不是嵌套数组', !Array.isArray(om[0]));
ok('大纲最后一段是任务', om[om.length - 1]?.role === 'system');
ok('大纲任务段含关键词', String(om[om.length - 1]?.content || '').includes('测试关键词'));

// 新人介绍：一次多个，private 可跨行
const multi = `<intro n="1" name="周敏" tag="欠债的室友">
relation: 林晚大学室友，两年前借了她三万，一直没还
entry: 今晚是来还钱的，站在楼道里等了一个小时
hook: 进门先低头看鞋，看见两双鞋就停住了
private: 两年没碰过人。忙起来能忘，闲下来就睡不着，靠跑步把自己耗到倒头就睡。
</intro>
<intro n="2" name="陈柏川" tag="车行的少东家">
relation: 跟林晚的弟弟一起玩车，见过两次
entry: 来送修好的车，钥匙要亲手交
hook: 说话时总把钥匙在指间转
private: 表面玩世不恭，其实很怕被人当成废物。
</intro>`;
const intros = engine.parseIntros(multi);
eq('一次解析出两个人', intros.length, 2);
eq('第一个名字对', intros[0].name, '周敏');
eq('第二个名字对', intros[1].name, '陈柏川');
ok('private 跨行完整', intros[0].priv.includes('两年没碰过人') && intros[0].priv.includes('跑步'), intros[0].priv);
eq('旧接口取第一个', engine.parseIntro(multi).name, '周敏');

const introPrompt = prompts.buildIntro(s, { count: 5 });
ok('新人提示词填了数量', introPrompt.includes('编 5 个'), introPrompt.slice(0, 40));
ok('新人提示词含私事字段', introPrompt.includes('private:'));
ok('新人提示词禁街坊职业', introPrompt.includes('五金店老板'));

// 大纲：没选幅度就不该出现幅度那一行
const noScale = prompts.buildOutline(s, { keyword: '测试', count: 6 });
ok('不选幅度时没有推进幅度行', !noScale.includes('推进幅度'), noScale.slice(0, 200));
ok('不选幅度时没有幅度规则', !noScale.includes('幅度大就允许跨时间段'));
ok('段数照填', noScale.includes('严格输出 6 段'));
ok('幅度占位符没残留', !/\{scale(Line|Rule)?\}/.test(noScale), noScale.match(/\{[a-zA-Z]+\}/g)?.join(','));

const withScale = prompts.buildOutline(s, { keyword: '测试', scale: 'heavy', count: 3 });
ok('选了幅度就出现那一行', withScale.includes('推进幅度') && withScale.includes('大推'));
ok('选了幅度就有对应规则', withScale.includes('幅度大就允许跨时间段'));

// 反派行动：一半往身体走
const mv4 = prompts.buildMoves(s, { count: 4 });
ok('4 条里 2 条带情欲', mv4.includes('至少 2 条'), mv4.slice(0, 60));
const mv5 = prompts.buildMoves(s, { count: 5 });
ok('5 条向上取整到 3', mv5.includes('至少 3 条'));

const parsedMoves = engine.parseMoves(
  '<move n="1" who="陈柏川" risk="中" nsfw="1">\nact: 把钥匙塞进她手心时按住不放\ngain: 换来一次单独说话\ncost: 被她甩开，丢了面子\n</move>\n<move n="2" who="周敏" risk="低" nsfw="0">\nact: 把还款日期往后拖\ngain: 多一个月\ncost: 欠人情\n</move>',
);
eq('第一条标了情欲', parsedMoves[0].nsfw, true);
eq('第二条是纯利益', parsedMoves[1].nsfw, false);

// 全局世界书：按灯色定开关
const wbJson = JSON.stringify({
  entries: {
    0: { comment: '蓝灯常驻', content: '这条是常驻的', constant: true, disable: false },
    1: { comment: '绿灯关键词', content: '这条要关键词才触发', constant: false, disable: false },
    2: { comment: '关掉的蓝灯', content: '这条被关掉了', constant: true, disable: true },
    3: { comment: '', content: '没名字的条目', constant: true, disable: false },
  },
});
const parsedWb = wbMod.parseWorldbook(wbJson, 'test.json');
eq('解析出四条', parsedWb.entries.length, 4);
eq('蓝灯默认开', parsedWb.entries[0].on, true);
eq('绿灯默认关', parsedWb.entries[1].on, false);
eq('关掉的蓝灯默认关', parsedWb.entries[2].on, false);
eq('没名字的给个占位名', parsedWb.entries[3].name, '条目 4');
eq('文件名记下来', parsedWb.name, 'test.json');

// 只拼开着的
const wbText = wbMod.buildWorldbookText({ worldbook: parsedWb });
ok('拼了蓝灯那条', wbText.includes('这条是常驻的'));
ok('没拼绿灯那条', !wbText.includes('这条要关键词才触发'));
ok('没拼关掉的那条', !wbText.includes('这条被关掉了'));

// 全关时返回空
const allOff = { worldbook: { entries: parsedWb.entries.map((e) => ({ ...e, on: false })) } };
eq('全关时为空串', wbMod.buildWorldbookText(allOff), '');

// 字数上限
const big = {
  worldbook: {
    entries: [{ name: 'x', content: '啊'.repeat(5000), on: true }],
  },
  worldbookChars: 1000,
};
const wbCut = wbMod.buildWorldbookText(big);
ok('超预算被截断', wbCut.length < 1200, '实际 ' + wbCut.length);
ok('截断带提示', wbCut.includes('余下部分略'));

// 拼进资料段的位置：紧跟在 <世界规则与其他补充材料> 之后
const matWithWb = buildMaterialContext({ ...ctx, worldbook: '这是导入的全局世界书' }, s);
const ruleEnd = matWithWb.indexOf('</世界规则与其他补充材料>');
const wbAt = matWithWb.indexOf('这是导入的全局世界书');
ok('世界书在规则块之后', wbAt > ruleEnd && ruleEnd >= 0, `规则块结束 ${ruleEnd} / 世界书 ${wbAt}`);

// 世界书统计
const wbStat = wbMod.worldbookStats(parsedWb);
eq('统计总数', wbStat.total, 4);
eq('统计开着数', wbStat.on, 2);

// 破限层：有内容就排第一，空就不发
const savedPad = s.prompts.pad;
s.prompts.pad = '这是垫文，用来测试';
settingsMod.patch({ prompts: { ...s.prompts, pad: '这是垫文，用来测试' } });
const withPad = await engine.previewMessages();
eq('场景层是第 1 条', withPad[0].role, 'system');
ok('场景层写推门进来', withPad[0].content.includes('走廊'), withPad[0].content.slice(0, 20));
eq('垫文是第 2 条且为 assistant', withPad[1].role, 'assistant');
ok('垫文内容对', withPad[1].content.includes('这是垫文'));
eq('设置层是第 3 条', withPad[2].role, 'system');
ok('设置层含失忆引导', withPad[2].content.includes('记忆一片一片捡回来'), withPad[2].content.slice(0, 30));
ok('设置之后才是内核', withPad[3].content.includes('弥彦'));

settingsMod.patch({ prompts: { ...getSettingsSafe(), pad: '' } });
const noPad = await engine.previewMessages();
ok('留空时不发破限层', !noPad.some((m) => String(m.content).includes('这是垫文')));
eq('没有垫文时第 2 条是设置层', noPad[1].role, 'system');

function getSettingsSafe() {
  return settingsMod.get().prompts;
}

// 世界书用 <其他补充材料> 包起来
const matTag = buildMaterialContext({ ...ctx, worldbook: '世界书内容' }, s);
ok('世界书有 <其他补充材料> 标签', matTag.includes('<其他补充材料>') && matTag.includes('</其他补充材料>'));
ok('世界书在标签内', (() => {
  const open = matTag.indexOf('<其他补充材料>');
  const close = matTag.indexOf('</其他补充材料>');
  const body = matTag.indexOf('世界书内容');
  return body > open && body < close;
})());

// 预览：结构完整，空 user 用空串
const pv = await engine.previewMessages();
ok('预览有内核', pv[0].role === 'system');
ok('预览有资料', pv.some((m) => m.role === 'system' && String(m.content).includes('<世界观与人物设定>')));
ok('预览有认领', pv.some((m) => m.role === 'assistant' && String(m.content).length > 20));
ok('预览最后一条是任务', pv[pv.length - 1].role === 'system');

// 任务段用 <本轮任务和要求> 包住
const boxedTask = M[M.length - 1];
ok('任务段有 <本轮任务和要求>', String(boxedTask.content).includes('<本轮任务和要求>'));
ok('任务段标签闭合', String(boxedTask.content).includes('</本轮任务和要求>'));
ok('内部任务提示在标签内', (() => {
  const c = String(boxedTask.content);
  const open = c.indexOf('<本轮任务和要求>');
  const close = c.indexOf('</本轮任务和要求>');
  const hint = c.indexOf('不要接着上一句往下写');
  return hint > open && hint < close;
})());
ok('任务正文在标签内', String(boxedTask.content).indexOf('下一步') < String(boxedTask.content).indexOf('</本轮任务和要求>'));

// 各功能都要包（走走向以外的一条验证框架通用）
const pvTask = pv[pv.length - 1];
ok('预览的任务段也包了', String(pvTask.content).includes('<本轮任务和要求>'));

// 梦中梦：单条编辑与删除
engine.saveDream({
  messages: [
    { role: 'user', text: '第一条' },
    { role: 'assistant', text: '第二条' },
    { role: 'user', text: '第三条' },
  ],
});
engine.updateDreamMessage(1, '改过的第二条');
eq('编辑生效', engine.getDream().messages[1].text, '改过的第二条');
eq('编辑不动前一条', engine.getDream().messages[0].text, '第一条');
eq('编辑不动后一条', engine.getDream().messages[2].text, '第三条');
ok('编辑打了时间戳', typeof engine.getDream().messages[1].editedAt === 'number');

engine.deleteDreamMessage(0);
eq('删完剩两条', engine.getDream().messages.length, 2);
eq('删的是第一条', engine.getDream().messages[0].text, '改过的第二条');

eq('空文本不覆盖', (() => {
  engine.updateDreamMessage(0, '   ');
  return engine.getDream().messages[0].text;
})(), '改过的第二条');
eq('越界 index 不报错', (() => {
  try { engine.updateDreamMessage(99, 'x'); return 'ok'; } catch { return 'boom'; }
})(), 'ok');

// 重发：输入框空 + 最后一条是客人说的
engine.saveDream({
  messages: [
    { role: 'user', text: '第一句' },
    { role: 'assistant', text: '第一次答的' },
    { role: 'user', text: '这句要重来' },
  ],
});
globalThis.__dreamCall = 0;
await engine.runDream('');
// 重发后应该只有「原 3 条 + 1 条新回复」，而不是再加一条空的 user
eq('重发只多一条回复', engine.getDream().messages.length, 4, JSON.stringify(engine.getDream().messages.map(m=>m.role+':'+m.text.slice(0,6))));

const resendBody = (lastRequestBody.messages || []).map((m) => String(m.content || '')).join('\n');
ok('重发用了上一条的内容', resendBody.includes('这句要重来'));
const dupCount = resendBody.split('这句要重来').length - 1;
ok('重发不会把同句话给两遍', dupCount === 1, '出现 ' + dupCount + ' 次：' + (lastRequestBody.messages || []).filter((m) => String(m.content).includes('这句要重来')).map((m) => m.role + '/' + String(m.content).length).join(', '));
ok('重发仍带历史', resendBody.includes('第一句') || resendBody.includes('第一次答的'));

// 空输入 + 最后一条是 assistant → 不该发
engine.saveDream({ messages: [{ role: 'user', text: '问' }, { role: 'assistant', text: '答' }] });
const before = engine.getDream().messages.length;
globalThis.__dreamCall = 0;
await engine.runDream('');
eq('最后一条是弥彦时空输入不重发', globalThis.__dreamCall, 0);
eq('消息数没变', engine.getDream().messages.length, before);

// 梦中梦的「梦里此刻」：最近三段正文，全文不截
const recent = buildRecentBodies(3, s);
ok('取到最近正文', recent.length >= 1, '实际 ' + recent.length);
ok('正文已去标签', !recent[0].includes('<content>'), recent[0].slice(0, 40));
ok('只取 assistant', recent.every((b) => !b.includes('我去便利店')), recent.join('|').slice(0, 60));
eq('要一条就只给一条', buildRecentBodies(1, s).length, 1);

// 配置备份：旧字段清理
const legacy = JSON.stringify({
  settings: {
    enabled: false,
    maxReplyTokens: 4000,
    dreamMaxTokens: 12000,
    danmakuChance: 0.4,
    worldInfoBudget: 8192,
    jsonMode: true,
    modules: { choices: true, danmaku: true, beats: true },
    prompts: { kernel: '旧内核还在' },
    routing: { choices: 'ch_a' },
    channels: [],
  },
});
settingsMod.importConfig(legacy);
const got = settingsMod.get();
ok('旧字段被清掉', got.enabled === undefined && got.maxReplyTokens === undefined);
ok('废弃字段被清掉', got.worldInfoBudget === undefined && got.jsonMode === undefined);
eq('自定义提示词保留', got.prompts.kernel, '旧内核还在');
eq('提示词 key 补全', Object.keys(got.prompts).length, 14);
ok('routing 补全了新任务', 'moves' in got.routing && 'intro' in got.routing && 'profile' in got.routing);
ok('modules 只剩四个开关', !('beats' in got.modules) && 'moves' in got.modules);
eq('modules.choices 默认开', got.modules.choices, true);

// 导出带 summary，且不含旧字段
const dump = JSON.parse(settingsMod.exportConfig());
ok('导出有 summary', !!dump.summary && typeof dump.summary.channels === 'number');
ok('导出不含旧字段', !('enabled' in dump.settings));
ok('导出字段有顺序', Object.keys(dump.settings)[0] === 'channels', Object.keys(dump.settings).slice(0, 3).join(','));

console.log(`\n${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
