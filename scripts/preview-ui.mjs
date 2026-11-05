/**
 * 把面板渲染成一份独立 HTML，方便直接看效果，不用开酒馆。
 *
 * 做法：用 happy-dom 跑一遍真实扩展，抓出 shadow root 里的面板 DOM，
 * 把 CSS 的 :host 换成普通类名，内联进一个页面。
 */

import fs from 'node:fs';
import { Window } from 'happy-dom';

const OUT = 'D:/workpage/workbuddy/2026-11-04-14-15-38/造梦师-推进台/preview.html';
const ROOT = 'file:///D:/workpage/workbuddy/2026-11-04-14-15-38/%E9%80%A0%E6%A2%A6%E5%B8%88-%E6%8E%A8%E8%BF%9B%E5%8F%B0';

const w = new Window({ url: 'http://127.0.0.1:8123/' });
globalThis.window = w;
globalThis.document = w.document;
globalThis.HTMLElement = w.HTMLElement;
globalThis.Node = w.Node;
globalThis.MutationObserver = w.MutationObserver;
globalThis.getComputedStyle = w.getComputedStyle.bind(w);
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const CHAT = [
  { name: 'You', is_user: true, mes: '我推开出租屋的门。' },
  {
    name: '林晚',
    is_user: false,
    mes: `<content>客厅没开灯。陈梦瑶坐在沙发上，手机屏幕的光照着她半张脸。

「你回来了。」她抬起头，「昨晚你去哪了？」</content>
<details><summary>摘要</summary>时间：2026年11月3日 21:40
地点：旧城区／出租屋
对白：「你回来了。」
情报：她在沙发上坐了两个小时没开灯
情感：从质问到有点慌</details>`,
  },
];

const CTX = {
  chat: CHAT,
  chatMetadata: { variables: { mode: 'novel' } },
  extensionSettings: {
    meng_push_settings: {
      channels: [
        {
          id: 'ch_a',
          name: '渠道 1',
          url: 'https://api.demo.com/v1',
          key: 'sk-test',
          model: 'gemini-3.8-flash',
          temperature: 1,
          maxTokens: 12000,
          timeoutSec: 30,
          stream: true,
        },
      ],
      routing: { choices: 'ch_a' },
      modules: { choices: true, beats: false, moves: false, intro: false },
      choiceCount: 5,
      panel: { tab: 'choices', collapsed: false, w: 342 },
    },
  },
  characters: [{ name: '林晚', description: '大二，建筑系。嘴硬，怕冷。', personality: '冷淡' }],
  characterId: 0,
  name2: '林晚',
  getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
  saveSettingsDebounced: () => {},
  saveMetadataDebounced: () => {},
  eventSource: { on: () => {}, off: () => {} },
  eventTypes: {
    GENERATION_ENDED: 'generation_ended',
    CHAT_CHANGED: 'chat_changed',
    MESSAGE_SWIPED: 'message_swiped',
    SETTINGS_UPDATED: 'settings_updated',
  },
};

w.SillyTavern = { getContext: () => CTX };
globalThis.SillyTavern = w.SillyTavern;

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [
      {
        message: {
          content: `<option type="顺承" risk="低">关上门，换下鞋子低声说：「在系馆画图，忘了看时间。」</option>
<option type="横向" risk="低">顺手把门边的顶灯开关按亮，走向饮水机接水。</option>
<option type="退让" risk="中">站在玄关没动，把冻得发僵的手缩进外套口袋里，没出声。</option>
<option type="破局" risk="高">走到沙发前看着她的眼睛问：「你怎么没开灯，在等我？」</option>
<option type="升温" risk="中">走过去坐在她身边，把冻得冰凉的指尖碰了碰她的手腕。</option>`,
        },
      },
    ],
  }),
  text: async () => '',
});

await import(`${ROOT}/index.js`);
await new Promise((r) => setTimeout(r, 800));

const host = w.document.getElementById('meng-push-host');
const root = host?.shadowRoot;
if (!root) throw new Error('面板没挂载');

// 先跑一轮，让走向页有内容
root.querySelectorAll('.icon-btn')[0]?.click();
await new Promise((r) => setTimeout(r, 600));

const clean = (html) =>
  html
    .replace(/ style="[^"]*"/g, '')
    .replace(/ hidden(="")?/g, '')
    .replace(/<div class="resize-handle"[^>]*><\/div>/g, '<div class="resize-handle"></div>');

const shots = [];
shots.push({ title: '走向', html: clean(root.querySelector('.panel').outerHTML) });

// 切到「新人」页
[...root.querySelectorAll('.tab')].find((t) => t.textContent.includes('新人'))?.click();
await new Promise((r) => setTimeout(r, 200));
shots.push({ title: '新人', html: clean(root.querySelector('.panel').outerHTML) });

// 设置页
[...root.querySelectorAll('.icon-btn')][1]?.click();
await new Promise((r) => setTimeout(r, 200));
shots.push({ title: '设置', html: clean(root.querySelector('.panel').outerHTML) });

// 提示词页
[...root.querySelectorAll('.seg button')][1]?.click();
await new Promise((r) => setTimeout(r, 200));
shots.push({ title: '提示词', html: clean(root.querySelector('.panel').outerHTML) });

// 检视页
[...root.querySelectorAll('.seg button')][2]?.click();
await new Promise((r) => setTimeout(r, 300));
shots.push({ title: '检视', html: clean(root.querySelector('.panel').outerHTML) });

let css = fs.readFileSync('D:/workpage/workbuddy/2026-11-04-14-15-38/造梦师-推进台/ui/style.css', 'utf8');
css = css
  .replace(/:host\(\[data-theme='light'\]\)/g, ".stage[data-theme='light']")
  .replace(/:host/g, '.stage');

const frames = shots
  .map(
    (s) => `    <figure class="shot">
      <figcaption>${s.title}</figcaption>
      <div class="stage" data-theme="dark">${s.html}</div>
    </figure>`,
  )
  .join('\n');

const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>推进台 · 界面预览</title>
<style>
  body {
    margin: 0;
    padding: 32px;
    background: #0f0e0c;
    font-family: 'MiSans', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
    color: #e9e3d7;
  }
  h1 { font-size: 15px; font-weight: 500; letter-spacing: 0.08em; margin: 0 0 4px; }
  .sub { font-size: 12px; color: #7a7264; margin: 0 0 28px; }
  .row { display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start; }
  .shot { margin: 0; }
  figcaption {
    font-size: 11px;
    color: #7a7264;
    margin-bottom: 8px;
    letter-spacing: 0.06em;
  }
  .stage {
    position: relative;
    width: 342px;
    height: 640px;
    overflow: auto;
    border-radius: 12px;
    background: #14120f;
  }
  /* 预览里把 fixed 改成相对定位，塞进框里 */
  .stage .panel {
    position: relative !important;
    inset: auto !important;
    width: 100% !important;
    max-height: 100% !important;
    height: 100%;
  }
  .stage .orb { display: none; }
${css}
</style>
</head>
<body>
  <h1>推 进 台 · 界面预览</h1>
  <p class="sub">真实 DOM + 真实样式，五个页面并排。宽度可拖右下角，双击复位。</p>
  <div class="row">
${frames}
  </div>
</body>
</html>
`;

fs.writeFileSync(OUT, page, 'utf8');
console.log('已生成', OUT, `（${Math.round(page.length / 1024)} KB，${shots.length} 屏）`);
