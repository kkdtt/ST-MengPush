/**
 * 主面板。
 *
 * 渲染策略：内容区每次状态变化重建（没有输入框，不怕失焦），
 * 设置页只建一次（有输入框，重建会丢焦点）。
 */

import { fillInput, readChatMeta, writeChatMeta } from '../core/ctx.js?v=2.1.0';
import {
  cancel,
  clearHistory,
  clearDream,
  clearStory,
  getDream,
  getState,
  getStory,
  isRunning,
  loadHistory,
  loadStory,
  markStepDone,
  run,
  runOne,
  runDream,
  runStory,
  subscribe,
} from '../core/engine.js?v=2.1.0';
import { get as getSettings, newChannel, patch as patchSettings } from '../core/settings.js?v=2.1.0';
import { PROMPT_FIELDS, getDefault, getPrompt, isCustomized } from '../core/prompts.js?v=2.1.0';
import { parsePreset } from '../core/import.js?v=2.1.0';
import { clearRecords, getRecords } from '../core/inspect.js?v=2.1.0';
import { testChannel } from '../core/api.js?v=2.1.0';
import { clear, h, icon, makeDraggable } from './host.js?v=2.1.0';

const TABS = [
  { id: 'dream', label: '梦中梦' },
  { id: 'choices', label: '走向' },
  { id: 'danmaku', label: '场外' },
  { id: 'beats', label: '节拍' },
  { id: 'story', label: '创作' },
  { id: 'history', label: '往轮' },
];

export function createPanel(shadow) {
  const settings = getSettings();

  let activeTab = settings.panel?.tab || 'choices';
  let settingsOpen = false;
  let settingsTab = 'basic'; // basic | prompts
  let collapsed = false;

  /* ---------------- 骨架 ---------------- */

  const statusEl = h('span', { class: 'status', text: '' });
  const footEl = h('div', { class: 'foot' }, [statusEl]);
  const bodyEl = h('div', { class: 'body' });
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });

  const refreshBtn = h(
    'button',
    { class: 'icon-btn', title: '重跑这一轮（Alt+R）', onclick: () => trigger('refresh') },
    [icon('refresh')],
  );

  const gearBtn = h(
    'button',
    { class: 'icon-btn', title: '设置', onclick: () => toggleSettings() },
    [icon('gear')],
  );

  const collapseBtn = h(
    'button',
    { class: 'icon-btn', title: '收起', onclick: () => setCollapsed(true) },
    [icon('close')],
  );

  const headEl = h('div', { class: 'head' }, [
    h('div', { class: 'brand' }, [
      icon('brand', 15),
      h('span', { class: 'brand-name', text: '推 进 台' }),
    ]),
    h('div', { class: 'tools' }, [refreshBtn, gearBtn, collapseBtn]),
  ]);

  const panelEl = h('div', { class: 'panel', role: 'dialog', 'aria-label': '剧情推进台' }, [
    headEl,
    tabsEl,
    bodyEl,
    footEl,
  ]);

  shadow.appendChild(panelEl);

  /* ---------------- 悬浮球 ---------------- */

  const orbEl = h('div', { class: 'orb', title: '推进台（Alt+P）', onclick: () => setCollapsed(false) }, [
    icon('brand', 22),
    h('span', { class: 'dot' }),
  ]);
  shadow.appendChild(orbEl);

  /* ---------------- 位置 ---------------- */

  function applyPosition() {
    const p = getSettings().panel || {};
    if (typeof p.x === 'number' && typeof p.y === 'number') {
      panelEl.style.left = p.x + 'px';
      panelEl.style.top = p.y + 'px';
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
    } else {
      panelEl.style.right = '18px';
      panelEl.style.bottom = '132px';
    }
    if (typeof p.orbX === 'number' && typeof p.orbY === 'number') {
      orbEl.style.left = p.orbX + 'px';
      orbEl.style.top = p.orbY + 'px';
      orbEl.style.right = 'auto';
      orbEl.style.bottom = 'auto';
    } else {
      orbEl.style.right = '20px';
      orbEl.style.bottom = '150px';
    }
  }
  applyPosition();

  makeDraggable(headEl, panelEl, {
    onEnd: ({ x, y }) => patchSettings({ panel: { ...getSettings().panel, x, y } }),
  });

  let orbStart = null;
  orbEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const r = orbEl.getBoundingClientRect();
    orbStart = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
  });
  document.addEventListener('mousemove', (e) => {
    if (!orbStart) return;
    const dx = e.clientX - orbStart.x;
    const dy = e.clientY - orbStart.y;
    if (!orbStart.moved && Math.hypot(dx, dy) < 4) return;
    orbStart.moved = true;
    orbEl.style.left = Math.max(0, orbStart.left + dx) + 'px';
    orbEl.style.top = Math.max(0, orbStart.top + dy) + 'px';
    orbEl.style.right = 'auto';
    orbEl.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => {
    if (!orbStart) return;
    if (orbStart.moved) {
      const r = orbEl.getBoundingClientRect();
      patchSettings({ panel: { ...getSettings().panel, orbX: Math.round(r.left), orbY: Math.round(r.top) } });
    }
    const wasDrag = orbStart.moved;
    orbStart = null;
    if (wasDrag) {
      orbEl.dataset.suppressClick = '1';
      setTimeout(() => delete orbEl.dataset.suppressClick, 60);
    }
  });
  orbEl.addEventListener(
    'click',
    (e) => {
      if (orbEl.dataset.suppressClick) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    true,
  );

  /* ---------------- 展开 / 收起 ---------------- */

  function setCollapsed(next) {
    collapsed = next;
    panelEl.hidden = collapsed;
    orbEl.style.display = collapsed ? 'grid' : 'none';
    patchSettings({ panel: { ...getSettings().panel, collapsed } });
  }

  function toggle() {
    setCollapsed(!collapsed);
  }

  function toggleSettings(force) {
    settingsOpen = force === undefined ? !settingsOpen : force;
    if (settingsOpen) {
      tabsEl.hidden = true;
      renderSettings();
    } else {
      tabsEl.hidden = false;
      render(getState());
    }
  }

  /* ---------------- 触发 ---------------- */

  function trigger(kind) {
    if (kind === 'refresh') {
      void run({ manual: true, tasks: ['choices', ...(getSettings().modules.danmaku ? ['danmaku'] : [])] });
    } else if (kind === 'beats') {
      void run({ manual: true, tasks: ['beats'] });
    }
  }

  /* ---------------- 渲染：标签 ---------------- */

  function renderTabs(state) {
    clear(tabsEl);
    for (const t of TABS) {
      const count =
        t.id === 'choices'
          ? state.result?.choices?.length || 0
          : t.id === 'danmaku'
            ? state.result?.danmaku?.length || 0
            : t.id === 'beats'
              ? state.result?.beats?.length || 0
              : 0;

      const btn = h(
        'button',
        {
          class: 'tab',
          role: 'tab',
          'aria-selected': String(activeTab === t.id),
          onclick: () => {
            activeTab = t.id;
            patchSettings({ panel: { ...getSettings().panel, tab: t.id } });
            if (t.id === 'history') loadHistory();
            render(getState());
          },
        },
        [t.label, count ? h('span', { class: 'badge', text: String(count) }) : null],
      );
      tabsEl.appendChild(btn);
    }
  }

  /* ---------------- 渲染：内容 ---------------- */

  function render(state) {
    if (settingsOpen) return;
    renderTabs(state);

    // 梦中梦和创作页都有常驻输入区，不能走「清空重建」那条路，否则一打字就失焦
    if (activeTab === 'dream') {
      renderDream(state);
      renderFoot(state);
      return;
    }

    if (activeTab === 'story') {
      renderStory(state);
      renderFoot(state);
      return;
    }

    clear(bodyEl);

    if (state.status === 'error' && state.error) {
      bodyEl.appendChild(h('div', { class: 'error-box', text: state.error }));
      bodyEl.appendChild(h('div', { style: { height: '10px' } }));
    }

    if (activeTab === 'choices') renderChoices(state);
    else if (activeTab === 'danmaku') renderDanmaku(state);
    else if (activeTab === 'beats') renderBeats(state);
    else if (activeTab === 'history') renderHistory(state);

    renderFoot(state);
  }

  function renderChoices(state) {
    const list = state.result?.choices || [];

    if (!list.length) {
      bodyEl.appendChild(
        emptyWithNote(state, state.result?.notes?.choices || '', 'choices', {
          running: '正在想下一步……',
          empty: '模型没给出可用的走向',
          idle: '这一轮还没有走向',
        }),
      );
      return;
    }

    bodyEl.appendChild(h('div', { class: 'section-label', text: '下一步' }));
    list.forEach((c, i) => {
      bodyEl.appendChild(
        h(
          'button',
          {
            class: `choice type-${c.type}`,
            title: '单击填入输入框，Ctrl+单击直接发送',
            onclick: (e) => {
              const sendNow = e.ctrlKey || e.metaKey;
              const ok = fillInput(c.text, sendNow);
              if (!ok) setStatus('没找到输入框', 'err');
              else if (!sendNow) setStatus('已填入，改完再发 · Ctrl+点击直接发送');
            },
          },
          [
            h('span', { class: 'choice-idx', text: String(i + 1) }),
            h('div', { class: 'choice-main' }, [
              h('span', { class: 'choice-text', text: c.text }),
              h('div', { class: 'choice-meta' }, [
                h('span', { class: 'chip type', text: c.type }),
                c.risk ? h('span', { class: `chip risk-${c.risk}`, text: '风险 ' + c.risk }) : null,
              ]),
            ]),
          ],
        ),
      );
    });
  }

  /**
   * 空态。关键是要说清楚「为什么空」——
   * 上一版把失败静默吞掉，面板上什么都不显示，用户根本分不清是没触发还是请求挂了。
   */
  function emptyWithNote(state, note, task, texts) {
    const wrap = h('div', { class: 'empty' });

    if (state.status === 'running') {
      wrap.appendChild(document.createTextNode(texts.running || '生成中……'));
      return wrap;
    }

    if (note.startsWith('error:')) {
      wrap.appendChild(h('div', { class: 'error-box', text: note.slice(6) }));
      wrap.appendChild(
        h('div', { class: 'note-row' }, [
          h('button', { class: 'mini-btn', text: '重试', onclick: () => runOne(task) }),
        ]),
      );
      return wrap;
    }

    wrap.appendChild(document.createTextNode(texts[note] || texts.idle || '还没有内容'));
    if (note === 'skipped') {
      const pct = Math.round((getSettings().danmakuChance ?? 0.4) * 100);
      wrap.appendChild(h('span', { class: 'hint', text: `自动模式下按 ${pct}% 概率触发，也可以直接点下面生成` }));
    }
    wrap.appendChild(
      h('div', { class: 'note-row' }, [
        h('button', { class: 'mini-btn', text: '生成', onclick: () => runOne(task) }),
      ]),
    );
    return wrap;
  }

  function renderDanmaku(state) {
    const list = state.result?.danmaku || [];
    const note = state.result?.notes?.danmaku || '';

    if (!list.length) {
      bodyEl.appendChild(emptyWithNote(state, note, 'danmaku', {
        running: '在看要不要刷……',
        skipped: '这一轮没掷中',
        empty: '模型判定这一场没什么可起哄的',
        idle: '这一场还没有弹幕',
      }));
      return;
    }

    bodyEl.appendChild(h('div', { class: 'section-label', text: '场外' }));
    bodyEl.appendChild(
      h('div', { class: 'danmaku-wrap' }, list.map((d) => h('span', { class: 'danmaku', text: d }))),
    );
    bodyEl.appendChild(
      h('div', { class: 'note-row' }, [
        h('button', { class: 'mini-btn', text: '重刷', onclick: () => runOne('danmaku') }),
      ]),
    );
  }

  function renderBeats(state) {
    const list = state.result?.beats || [];

    if (!list.length) {
      bodyEl.appendChild(
        emptyWithNote(state, state.result?.notes?.beats || '', 'beats', {
          running: '在排节拍……',
          empty: '模型没给出可用的节拍',
          idle: '还没有节拍表',
        }),
      );
      return;
    }

    let lastPhase = '';
    for (const b of list) {
      if (b.phase && b.phase !== lastPhase) {
        lastPhase = b.phase;
        bodyEl.appendChild(h('div', { class: 'beat-phase', text: b.phase }));
      }
      bodyEl.appendChild(
        h('div', { class: 'beat' }, [
          h('b', { text: (b.n ? b.n + ' · ' : '') + (b.action || '') }),
          b.react ? h('span', { class: 'react', text: '→ ' + b.react }) : null,
          b.friction ? h('span', { class: 'friction', text: '阻力：' + b.friction }) : null,
        ]),
      );
    }
  }

  /* ---------------- 梦中梦 ---------------- */

  const dreamLog = h('div', { class: 'dream-log' });
  const dreamInput = h('textarea', {
    class: 'dream-input',
    rows: '2',
    placeholder: '跟弥彦说点什么……（Enter 发送，Shift+Enter 换行）',
  });
  const dreamSend = h('button', {
    class: 'mini-btn primary',
    text: '说',
    onclick: () => sendDream(),
  });
  const dreamClear = h('button', {
    class: 'mini-btn',
    text: '清空',
    title: '清掉铺子里的对话记录（不影响聊天本身）',
    onclick: () => {
      clearDream();
      render(getState());
    },
  });

  const dreamWrap = h('div', { class: 'dream-wrap' }, [
    dreamLog,
    h('div', { class: 'dream-bar' }, [dreamInput, dreamClear, dreamSend]),
  ]);

  dreamInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendDream();
    }
  });

  function sendDream() {
    const t = dreamInput.value.trim();
    if (!t) return;
    dreamInput.value = '';
    void runDream(t);
  }

  function renderDream(state) {
    if (!bodyEl.contains(dreamWrap)) {
      clear(bodyEl);
      bodyEl.appendChild(dreamWrap);
    }

    const d = state.dream || getDream();
    const running = state.status === 'running';
    dreamSend.disabled = running;
    dreamSend.textContent = running ? '…' : '说';

    clear(dreamLog);

    // 清空按钮常驻在输入栏里（dreamClear），没有对话时禁用
    dreamClear.disabled = !d.messages.length;
    dreamClear.textContent = d.messages.length ? `清空 ${d.messages.length}` : '清空';

    if (state.status === 'error' && state.error) {
      dreamLog.appendChild(h('div', { class: 'error-box', text: state.error }));
    }

    if (!d.messages.length) {
      dreamLog.appendChild(
        h('div', { class: 'empty' }, [
          '铺子里只有一盏灯',
          h('span', {
            class: 'hint',
            text: '可以问他「林晚现在在想什么」，也可以说「这一段织得急了，拆了重来」',
          }),
        ]),
      );
      return;
    }

    for (const m of d.messages) {
      const isUser = m.role === 'user';
      const bubble = h('div', { class: 'dream-msg ' + (isUser ? 'user' : 'assistant') }, [
        h('span', { class: 'dream-who', text: isUser ? '你' : '弥彦' }),
        h('div', { class: 'dream-text', text: m.text }),
      ]);

      // 弥彦顺手递的走向，直接做成可点的卡片
      if (!isUser && m.choices?.length) {
        const wrap = h('div', { class: 'dream-choices' });
        for (const c of m.choices) {
          wrap.appendChild(
            h('button', {
              class: `choice type-${c.type}`,
              title: '单击填入输入框，Ctrl+单击直接发送',
              onclick: (e) => {
                const send = e.ctrlKey || e.metaKey;
                fillInput(c.text, send);
                setStatus(send ? '已发送' : '已填入，改完发出去');
              },
            }, [
              h('div', { class: 'choice-main' }, [
                h('span', { class: 'choice-text', text: c.text }),
                h('div', { class: 'choice-meta' }, [
                  h('span', { class: 'chip type', text: c.type }),
                  c.risk ? h('span', { class: `chip risk-${c.risk}`, text: '风险 ' + c.risk }) : null,
                ]),
              ]),
            ]),
          );
        }
        bubble.appendChild(wrap);
      }

      dreamLog.appendChild(bubble);
    }

    if (running) {
      dreamLog.appendChild(
        h('div', { class: 'dream-msg assistant pending' }, [
          h('span', { class: 'dream-who', text: '弥彦' }),
          h('div', { class: 'dream-text', text: '……' }),
        ]),
      );
    }

    requestAnimationFrame(() => {
      bodyEl.scrollTop = bodyEl.scrollHeight;
    });
  }

  /* ---------------- 创作页 ---------------- */

  let draftKeyword = '';

  const storyKw = h('textarea', {
    class: 'story-kw',
    rows: '2',
    placeholder: '想写什么？比如：他送她回家，在楼道里被她拦住',
    oninput: (e) => {
      draftKeyword = e.target.value;
    },
  });

  const storyScale = h('select', { class: 'story-scale' }, [
    h('option', { value: 'light', text: '轻推 · 一件事' }),
    h('option', { value: 'medium', text: '中推 · 一个小事件' }),
    h('option', { value: 'heavy', text: '大推 · 跨一个阶段' }),
  ]);

  const storyGo = h('button', {
    class: 'mini-btn primary',
    text: '出大纲',
    onclick: () => runStory('outline', { keyword: draftKeyword, scale: storyScale.value }),
  });

  const storyInput = h('div', { class: 'story-input' }, [
    storyKw,
    h('div', { class: 'story-ctrl' }, [storyScale, storyGo]),
  ]);

  const storyBody = h('div', { class: 'story-body' });

  function renderStory(state) {
    const story = getStory() || {};
    const running = state.status === 'running';

    // 输入区常驻：只在它不在 DOM 里时挂回去，避免每次状态变化都把正在打的字冲掉
    if (!bodyEl.contains(storyInput)) {
      clear(bodyEl);
      bodyEl.appendChild(storyInput);
      bodyEl.appendChild(storyBody);
      if (!draftKeyword && story.keyword) draftKeyword = story.keyword;
      storyKw.value = draftKeyword;
      storyScale.value = story.scale || 'medium';
    }

    storyGo.disabled = running;
    storyGo.textContent = running ? '生成中…' : '出大纲';

    clear(storyBody);

    if (state.status === 'error' && state.error) {
      storyBody.appendChild(h('div', { class: 'error-box', text: state.error }));
      storyBody.appendChild(h('div', { style: { height: '8px' } }));
    }

    const outline = story.outline || [];
    const steps = story.steps || [];

    if (!outline.length) {
      storyBody.appendChild(
        h('div', { class: 'empty' }, [
          '还没有大纲',
          h('span', { class: 'hint', text: '写一句想往哪走，选个推进幅度，点「出大纲」' }),
        ]),
      );
      return;
    }

    storyBody.appendChild(h('div', { class: 'section-label', text: '大纲' }));
    for (const o of outline) {
      storyBody.appendChild(
        h('div', { class: 'outline-item' }, [
          h('span', { class: 'outline-n', text: String(o.n) }),
          h('div', { class: 'outline-main' }, [
            o.title ? h('b', { text: o.title }) : null,
            h('span', { class: 'outline-text', text: o.text }),
          ]),
        ]),
      );
    }

    const stepCount = h(
      'select',
      { class: 'story-scale' },
      [3, 4, 5, 6, 8].map((n) =>
        h('option', {
          value: String(n),
          text: n + ' 步',
          selected: (story.stepCount || 5) === n,
        }),
      ),
    );

    storyBody.appendChild(
      h('div', { class: 'story-ctrl' }, [
        stepCount,
        h('button', {
          class: 'mini-btn',
          text: steps.length ? '重新分步' : '分步执行',
          disabled: running,
          onclick: () => runStory('steps', { count: Number(stepCount.value) }),
        }),
        h('button', {
          class: 'mini-btn',
          text: '清空',
          onclick: () => {
            clearStory();
            draftKeyword = '';
            storyKw.value = '';
            render(getState());
          },
        }),
      ]),
    );

    if (steps.length) {
      storyBody.appendChild(
        h('div', { class: 'section-label', text: '步骤 · 点一下填入输入框' }),
      );
      for (const st of steps) {
        storyBody.appendChild(
          h(
            'button',
            {
              class: 'step' + (st.done ? ' done' : ''),
              title: '单击填入输入框，Ctrl+单击直接发送',
              onclick: (e) => {
                const send = e.ctrlKey || e.metaKey;
                fillInput(st.text, send);
                if (!send) markStepDone(st.n);
                setStatus(send ? '已发送' : '已填入，改完发出去');
              },
            },
            [
              h('span', { class: 'step-n', text: String(st.n) }),
              h('span', { class: 'step-text', text: st.text }),
            ],
          ),
        );
      }
    }
  }

  function renderHistory(state) {
    const hist = state.history || [];

    if (!hist.length) {
      bodyEl.appendChild(h('div', { class: 'empty', text: '还没有往轮记录' }));
      return;
    }

    const head = h('div', { class: 'section-label', text: '往轮' });
    const clearBtn = h('button', {
      class: 'mini-btn',
      text: '清空',
      style: { marginLeft: 'auto', padding: '1px 7px', fontSize: '10px' },
      onclick: () => {
        clearHistory();
        render(getState());
      },
    });
    head.appendChild(clearBtn);
    bodyEl.appendChild(head);

    for (let i = hist.length - 1; i >= 0; i--) {
      const item = hist[i];
      const time = new Date(item.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const wrap = h('div', { class: 'hist-item' }, [
        h('div', { class: 'hist-head' }, [
          icon('clock', 11),
          h('span', { text: time }),
          h('span', { text: `第 ${item.messageId + 1} 楼` }),
        ]),
      ]);

      for (const c of item.choices || []) {
        wrap.appendChild(
          h('button', {
            class: 'hist-choice',
            text: `· ${c.text}`,
            onclick: () => {
              fillInput(c.text, false);
              setStatus('已填入');
            },
          }),
        );
      }
      bodyEl.appendChild(wrap);
    }
  }

  /* ---------------- 渲染：底栏 ---------------- */

  let statusOverride = null;

  function setStatus(text, kind) {
    statusOverride = { text, kind };
    applyStatus(getState());
  }

  function applyStatus(state) {
    statusEl.className = 'status';
    if (statusOverride && !isRunning()) {
      statusEl.textContent = statusOverride.text;
      if (statusOverride.kind === 'err') statusEl.classList.add('err');
      return;
    }
    if (state.status === 'running') {
      statusEl.textContent = state.stage || '生成中';
      statusEl.classList.add('busy');
    } else if (state.status === 'error') {
      statusEl.textContent = state.error || '出错了';
      statusEl.classList.add('err');
    } else if (state.result?.at) {
      const t = new Date(state.result.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      statusEl.textContent = `更新于 ${t}`;
    } else {
      statusEl.textContent = '待命';
    }
  }

  function renderFoot(state) {
    statusOverride = null;
    applyStatus(state);

    const running = state.status === 'running';
    refreshBtn.disabled = running;
    refreshBtn.classList.toggle('spin', running);

    clear(footEl);
    footEl.appendChild(statusEl);

    const beatsBtn = h('button', {
      class: 'mini-btn',
      text: '节拍',
      title: '生成亲密戏节拍表',
      disabled: running,
      onclick: () => trigger('beats'),
    });

    const mainBtn = h('button', {
      class: 'mini-btn primary',
      text: running ? '取消' : '重跑',
      onclick: () => (running ? cancel() : trigger('refresh')),
    });

    footEl.appendChild(beatsBtn);
    footEl.appendChild(mainBtn);
  }

  /* ---------------- 设置页 ---------------- */

  function renderSettings() {
    clear(bodyEl);
    clear(footEl);
    statusEl.textContent = '';
    footEl.appendChild(statusEl);

    const back = h('button', {
      class: 'mini-btn',
      text: '← 返回',
      onclick: () => toggleSettings(false),
    });
    footEl.appendChild(back);

    const s = getSettings();
    const box = h('div', { class: 'settings' });
    bodyEl.appendChild(box);

    /* --- 分段：基础 / 提示词 --- */
    box.appendChild(
      h('div', { class: 'seg' }, [
        h('button', {
          class: settingsTab === 'basic' ? 'on' : '',
          text: '基础',
          onclick: () => {
            settingsTab = 'basic';
            renderSettings();
          },
        }),
        h('button', {
          class: settingsTab === 'prompts' ? 'on' : '',
          text: '提示词',
          onclick: () => {
            settingsTab = 'prompts';
            renderSettings();
          },
        }),
        h('button', {
          class: settingsTab === 'inspect' ? 'on' : '',
          text: '检视',
          onclick: () => {
            settingsTab = 'inspect';
            renderSettings();
          },
        }),
      ]),
    );

    // 检视页：看真实发出去的请求
    if (settingsTab === 'inspect') {
      renderInspect(box);
      return;
    }

    // 提示词页单独一屏，不再塞在设置页最底下
    if (settingsTab === 'prompts') {
      const gp = h('div', { class: 'set-group' });
      for (const field of PROMPT_FIELDS) gp.appendChild(promptEditor(field));
      box.appendChild(gp);
      box.appendChild(
        h('div', {
          class: 'empty',
          style: { padding: '2px 0 0', textAlign: 'left', fontSize: '11px', lineHeight: '1.8' },
          text: '留空 = 用内置默认。改坏了点「恢复默认」即可。',
        }),
      );
      return;
    }

    /* --- 总开关 --- */
    const g1 = h('div', { class: 'set-group' }, [h('h4', { text: '运行' })]);
    g1.appendChild(
      switchRow('启用推进台', s.enabled, (v) => {
        patchSettings({ enabled: v });
        renderSettings();
      }),
    );
    g1.appendChild(
      switchRow('正文写完自动跑', s.auto, (v) => patchSettings({ auto: v })),
    );
    g1.appendChild(switchRow('选项', s.modules.choices, (v) => patchSettings({ modules: { choices: v } })));
    g1.appendChild(switchRow('弹幕', s.modules.danmaku, (v) => patchSettings({ modules: { danmaku: v } })));
    g1.appendChild(
      switchRow('节拍表（手动）', s.modules.beats, (v) => patchSettings({ modules: { beats: v } })),
    );
    box.appendChild(g1);

    /* --- 渠道 --- */
    const g2 = h('div', { class: 'set-group' }, [h('h4', { text: '渠道' })]);
    for (const ch of s.channels) {
      g2.appendChild(channelCard(ch));
    }
    g2.appendChild(
      h('button', {
        class: 'mini-btn',
        text: '+ 添加渠道',
        style: { width: '100%', padding: '6px' },
        onclick: () => {
          const list = [...getSettings().channels, newChannel({ name: '渠道 ' + (getSettings().channels.length + 1) })];
          patchSettings({ channels: list });
          renderSettings();
        },
      }),
    );
    box.appendChild(g2);

    /* --- 路由 --- */
    const g3 = h('div', { class: 'set-group' }, [h('h4', { text: '任务分配' })]);
    const opts = [{ id: '', name: '（用第一个可用渠道）' }, ...s.channels.map((c) => ({ id: c.id, name: c.name || c.model }))];
    for (const [task, label] of [
      ['choices', '走向选项'],
      ['danmaku', '弹幕'],
      ['beats', '节拍表'],
    ]) {
      const sel = h(
        'select',
        {
          onchange: (e) => patchSettings({ routing: { [task]: e.target.value } }),
        },
        opts.map((o) =>
          h('option', { value: o.id, text: o.name, selected: (s.routing?.[task] || '') === o.id }),
        ),
      );
      g3.appendChild(h('div', { class: 'row' }, [h('label', { text: label }), sel]));
    }
    box.appendChild(g3);

    /* --- 参数 --- */
    const g4 = h('div', { class: 'set-group' }, [h('h4', { text: '参数' })]);
    g4.appendChild(numRow('选项条数', s.choiceCount, 3, 20, 1, (v) => patchSettings({ choiceCount: v }), '条'));
    g4.appendChild(
      numRow('弹幕概率', s.danmakuChance, 0, 1, 0.05, (v) => patchSettings({ danmakuChance: v })),
    );
    g4.appendChild(
      numRow('对话层数', s.historyDepth, 0, 50, 1, (v) => patchSettings({ historyDepth: v }), '层'),
    );
    g4.appendChild(
      numRow('梦中梦上限', s.dreamMaxTokens, 500, 32000, 500, (v) => patchSettings({ dreamMaxTokens: v }), 'token'),
    );
    g4.appendChild(
      numRow('摘要条数', s.summaryDepth, 1, 200, 1, (v) => patchSettings({ summaryDepth: v }), '条'),
    );
    g4.appendChild(
      numRow('摘要字数', s.summaryChars, 400, 200000, 500, (v) => patchSettings({ summaryChars: v }), '字'),
    );
    g4.appendChild(
      numRow('正文尾部', s.tailChars, 400, 200000, 500, (v) => patchSettings({ tailChars: v }), '字'),
    );
    g4.appendChild(
      switchRow('喂世界书给旁路模型', s.includeWorldInfo, (v) => {
        patchSettings({ includeWorldInfo: v });
        renderSettings();
      }),
    );
    g4.appendChild(
      numRow('世界书截断', s.worldInfoChars, 400, 200000, 1000, (v) => patchSettings({ worldInfoChars: v }), '字'),
    );
    g4.appendChild(
      numRow('角色卡长度', s.cardChars, 300, 50000, 500, (v) => patchSettings({ cardChars: v }), '字'),
    );
    g4.appendChild(
      h('div', {
        class: 'prompt-hint',
        style: { marginTop: '2px' },
        text: '「对话层数」指最近几层以真实对话发给旁路，更早的走摘要。单位是字，中文约 1 字 ≈ 0.7 token，100k token 对应 14 万字。数字改完立刻存，失焦时会修正超出范围的值。',
      }),
    );
    box.appendChild(g4);

    /* --- 背景设定 --- */
    const g5 = h('div', { class: 'set-group' }, [h('h4', { text: '背景设定' })]);
    g5.appendChild(
      h('div', {
        class: 'prompt-hint',
        text: '预设里的「存档 / 过往事件」条目插件读不到，把大总结或世界观粘这里，会一起喂给旁路模型。',
      }),
    );
    const bg = h('textarea', {
      class: 'prompt-input',
      rows: '6',
      placeholder: '例：世界观、势力关系、此前发生过的关键事件……',
      oninput: (e) => patchSettings({ background: e.target.value }),
    });
    bg.value = s.background || '';
    g5.appendChild(bg);
    box.appendChild(g5);

    /* --- 解析正则 --- */
    const gre = h('div', { class: 'set-group' }, [h('h4', { text: '解析' })]);
    gre.appendChild(
      h('div', {
        class: 'prompt-hint',
        text: '换别的预设时用。留空走默认：正文取 <content> 标签，摘要取 <details><summary>摘要</summary>。第一个捕获组就是结果。',
      }),
    );

    const saveBody = debounced((v) => patchSettings({ bodyRegex: v }));
    const bodyRe = h('input', {
      type: 'text',
      class: 're-input',
      placeholder: '<content>([\\s\\S]*?)<\\/content>',
      oninput: (e) => saveBody(e.target.value),
    });
    bodyRe.value = s.bodyRegex || '';
    gre.appendChild(h('div', { class: 'row' }, [h('label', { text: '正文正则' }), bodyRe]));

    const saveSum = debounced((v) => patchSettings({ summaryRegex: v }));
    const sumRe = h('input', {
      type: 'text',
      class: 're-input',
      placeholder: '<details><summary>摘要<\\/summary>([\\s\\S]*?)<\\/details>',
      oninput: (e) => saveSum(e.target.value),
    });
    sumRe.value = s.summaryRegex || '';
    gre.appendChild(h('div', { class: 'row' }, [h('label', { text: '摘要正则' }), sumRe]));
    box.appendChild(gre);

    /* --- 预设导入 --- */
    const g6 = h('div', { class: 'set-group' }, [h('h4', { text: '预设导入' })]);
    g6.appendChild(
      h('div', {
        class: 'prompt-hint',
        text: '从预设 JSON 里抽出人格、宪章、总纲、铁律、私密场景等条目，拼成内核。世界书 / 聊天记录 / 角色卡不在这里，那些由插件实时读取。',
      }),
    );

    const preview = h('div', { class: 'import-preview' });

    const fileInput = h('input', {
      type: 'file',
      accept: '.json,application/json',
      style: { display: 'none' },
      onchange: async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;

        clear(preview);
        preview.className = 'import-preview';
        preview.textContent = '读取中…';

        try {
          const text = await file.text();
          const r = parsePreset(text);

          if (!r.ok) {
            preview.className = 'import-preview fail';
            preview.textContent = r.error;
            return;
          }

          preview.className = 'import-preview';
          preview.appendChild(
            h('div', {
              class: 'import-head',
              text: `${file.name} · 提取 ${r.entries.length} 条 · ${r.totalChars} 字`,
            }),
          );

          const list = h('div', { class: 'import-list' });
          for (const en of r.entries) {
            list.appendChild(h('span', { class: 'chip', text: `${en.label} ${en.chars}` }));
          }
          preview.appendChild(list);

          preview.appendChild(
            h('div', { class: 'story-ctrl' }, [
              h('button', {
                class: 'mini-btn primary',
                text: '应用为内核',
                onclick: () => {
                  patchSettings({ prompts: { ...getSettings().prompts, kernel: r.kernel } });
                  preview.className = 'import-preview ok';
                  preview.textContent = `已应用，内核 ${r.totalChars} 字。去「提示词」分段能看和改。`;
                },
              }),
              h('button', {
                class: 'mini-btn',
                text: '取消',
                onclick: () => {
                  clear(preview);
                  preview.className = 'import-preview';
                },
              }),
            ]),
          );
        } catch (err) {
          preview.className = 'import-preview fail';
          preview.textContent = '读取失败：' + (err?.message || err);
        }
      },
    });

    g6.appendChild(
      h('div', { class: 'story-ctrl' }, [
        h('button', {
          class: 'mini-btn',
          text: '选择预设 JSON',
          onclick: () => fileInput.click(),
        }),
        fileInput,
      ]),
    );
    g6.appendChild(preview);
    box.appendChild(g6);

    /* --- 关于 --- */
    const g7 = h('div', { class: 'set-group' }, [h('h4', { text: '关于' })]);
    g7.appendChild(
      h('div', {
        class: 'empty',
        style: { padding: '4px 0', textAlign: 'left', lineHeight: '1.9' },
        html:
          '选项与弹幕由旁路模型生成，只进这个面板，不写回聊天楼层，<br>' +
          '所以不占用主对话的上下文。<br>' +
          '单击卡片填入输入框，Ctrl+单击直接发送。',
      }),
    );
    box.appendChild(g7);
  }

  /** token 数按 k 显示，太长了挤不下 */
  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v < 1000) return String(v);
    return (v / 1000).toFixed(v < 10000 ? 1 : 0) + 'k';
  }

  /** 输入防抖，避免每敲一个字都写一次 extension_settings */
  function debounced(fn, ms = 500) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  /* ---------------- 检视页 ---------------- */

  function renderInspect(box) {
    const recs = getRecords();

    const g = h('div', { class: 'set-group' }, [h('h4', { text: '最近发出去的请求' })]);

    // 当前用的外部上下文
    const ext = String(readChatMeta('meng_push_external_context') || '');
    if (ext) {
      g.appendChild(
        h('div', { class: 'import-preview ok' }, [
          h('div', { text: `当前上下文来自导入：${ext.length} 字` }),
          h('div', { class: 'story-ctrl' }, [
            h('button', {
              class: 'mini-btn',
              text: '清除，改回自动拼装',
              onclick: () => {
                writeChatMeta('meng_push_external_context', '');
                renderSettings();
              },
            }),
          ]),
        ]),
      );
    }

    g.appendChild(
      h('div', {
        class: 'prompt-hint',
        text: '只读不改写。主对话那一条含预设拼装、世界书注入、正则处理后的最终内容——就是模型真正收到的东西。',
      }),
    );

    if (!recs.length) {
      g.appendChild(
        h('div', { class: 'empty' }, [
          '还没有抓到请求',
          h('span', { class: 'hint', text: '去聊天里发一条，或者点一次「重跑」，再回来看' }),
        ]),
      );
      box.appendChild(g);
      return;
    }

    g.appendChild(
      h('div', { class: 'story-ctrl' }, [
        h('button', {
          class: 'mini-btn',
          text: '清空记录',
          onclick: () => {
            clearRecords();
            renderSettings();
          },
        }),
        h('button', {
          class: 'mini-btn',
          text: '清除旁路上下文',
          title: '把之前设为「旁路上下文」的那份 payload 撤掉',
          onclick: () => {
            writeChatMeta('meng_push_external_context', '');
            setStatus('已清除，旁路恢复自己拼装');
          },
        }),
      ]),
    );

    for (const r of recs) g.appendChild(recordCard(r));
    box.appendChild(g);
  }

  function recordCard(r) {
    const time = new Date(r.at).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const wrap = h('details', { class: 'rec' }, [
      h('summary', { class: 'rec-sum' }, [
        h('span', { class: 'rec-tag ' + (r.self ? 'self' : 'main'), text: r.self ? '推进台' : '主对话' }),
        h('span', { class: 'rec-time', text: time }),
        h('span', {
          class: 'rec-meta',
          text: `${r.count} 条 · ${r.chars} 字 ≈ ${fmtTokens(r.tokens)} token`,
        }),
      ]),
    ]);

    const body = h('div', { class: 'rec-body' });
    body.appendChild(
      h('div', {
        class: 'rec-param',
        text: `model ${r.model || '-'}　temp ${r.temperature ?? '-'}　max_tokens ${r.maxTokens ?? '-'}　stream ${r.stream}`,
      }),
    );

    for (const m of r.messages) {
      body.appendChild(
        h('details', { class: 'rec-msg' }, [
          h('summary', { class: 'rec-msg-sum' }, [
            h('span', { class: 'rec-role ' + m.role, text: m.role }),
            h('span', { class: 'rec-len', text: m.content.length + ' 字' }),
            h('span', { class: 'rec-peek', text: m.content.slice(0, 44).replace(/\s+/g, ' ') }),
          ]),
          h('div', { class: 'rec-text', text: m.content }),
        ]),
      );
    }

    body.appendChild(
      h('div', { class: 'story-ctrl' }, [
        h('button', {
          class: 'mini-btn primary',
          text: '设为上下文',
          title: '把这条请求的完整内容设为推进台的上下文，选项/弹幕/梦中梦都会用它',
          onclick: () => {
            const text = r.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
            writeChatMeta('meng_push_external_context', text);
            renderSettings();
            setStatus(`已设为上下文 · ${text.length} 字`);
          },
        }),
        h('button', {
          class: 'mini-btn',
          text: '复制全文',
          onclick: async () => {
            const full = r.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
            try {
              await navigator.clipboard.writeText(full);
              setStatus('已复制到剪贴板');
            } catch {
              setStatus('复制失败，试试手动选中', 'err');
            }
          },
        }),
      ]),
    );

    wrap.appendChild(body);
    return wrap;
  }

  /** 单个提示词编辑器。空串 = 用默认，所以「恢复默认」就是把它清空。 */
  function promptEditor(field) {
    const customized = isCustomized(field.key, getSettings());

    const mark = h('span', {
      class: 'prompt-flag' + (customized ? ' on' : ''),
      text: customized ? '已修改' : '默认',
    });

    const ta = h('textarea', {
      class: 'prompt-input',
      rows: String(field.rows || 10),
      spellcheck: 'false',
      oninput: (e) => {
        const prompts = { ...getSettings().prompts, [field.key]: e.target.value };
        patchSettings({ prompts });
        mark.textContent = e.target.value.trim() ? '已修改' : '默认';
        mark.className = 'prompt-flag' + (e.target.value.trim() ? ' on' : '');
      },
    });
    ta.value = getPrompt(field.key, getSettings());

    const reset = h('button', {
      class: 'mini-btn',
      text: '恢复默认',
      onclick: () => {
        const prompts = { ...getSettings().prompts, [field.key]: '' };
        patchSettings({ prompts });
        ta.value = getDefault(field.key);
        mark.textContent = '默认';
        mark.className = 'prompt-flag';
      },
    });

    return h('div', { class: 'prompt-block' }, [
      h('div', { class: 'prompt-head' }, [
        h('span', { class: 'prompt-title', text: field.label }),
        mark,
        reset,
      ]),
      h('div', { class: 'prompt-hint', text: field.hint }),
      ta,
    ]);
  }

  function switchRow(label, checked, onChange) {
    const input = h('input', {
      type: 'checkbox',
      onchange: (e) => onChange(e.target.checked),
    });
    input.checked = !!checked;
    return h('label', { class: 'switch' }, [input, h('span', { text: label })]);
  }

  /**
   * 数字输入。
   *
   * 之前用 onchange，只在失焦时提交——输入完直接切页签或关面板就丢了，
   * 加上外层还有 clamp，用户看到的和存下的不是一回事。
   * 现在：输入时就防抖保存，失焦时再兜一次并回显真实值。
   */
  function numRow(label, value, min, max, step, onChange, suffix = '') {
    let timer = null;

    const commit = (raw) => {
      const v = Number(raw);
      if (!Number.isFinite(v)) return;
      const clamped = Math.min(max, Math.max(min, v));
      // 回显真正存下的值——被上限截断时用户立刻能看见
      if (String(clamped) !== String(raw)) input.value = String(clamped);
      onChange(clamped);
    };

    const input = h('input', {
      type: 'number',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
      oninput: (e) => {
        const raw = e.target.value;
        clearTimeout(timer);
        // 输入过程中不打断、不 clamp，避免打到一半被改写
        timer = setTimeout(() => {
          const v = Number(raw);
          if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
        }, 400);
      },
      onblur: (e) => {
        clearTimeout(timer);
        commit(e.target.value);
      },
    });

    return h('div', { class: 'row' }, [
      h('label', { text: label }),
      input,
      suffix ? h('span', { class: 'suffix', text: suffix }) : null,
    ]);
  }

  function channelCard(ch) {
    const body = h('div', { class: 'channel-body' });

    const field = (label, key, type = 'text', placeholder = '') => {
      const input = h('input', {
        type,
        placeholder,
        value: ch[key] ?? '',
        onchange: (e) => {
          ch[key] = e.target.value;
          const list = getSettings().channels.map((c) => (c.id === ch.id ? ch : c));
          patchSettings({ channels: list });
          if (key === 'name' || key === 'model') {
            const nm = card.querySelector('.name');
            const md = card.querySelector('.model');
            if (nm) nm.textContent = ch.name || '未命名';
            if (md) md.textContent = ch.model || '';
          }
        },
      });
      return h('div', { class: 'row' }, [h('label', { text: label }), input]);
    };

    const testOut = h('div', { class: 'test-result', text: '' });

    body.appendChild(field('名称', 'name', 'text', '主力 flash'));
    body.appendChild(field('地址', 'url', 'text', 'https://xxx.com/v1'));
    body.appendChild(field('密钥', 'key', 'password', 'sk-...'));
    body.appendChild(field('模型', 'model', 'text', 'gemini-2.5-flash'));

    const tempInput = h('input', {
      type: 'number',
      min: '0',
      max: '2',
      step: '0.05',
      value: String(ch.temperature ?? 0.95),
      onchange: (e) => {
        ch.temperature = Number(e.target.value);
        const list = getSettings().channels.map((c) => (c.id === ch.id ? ch : c));
        patchSettings({ channels: list });
      },
    });
    const maxInput = h('input', {
      type: 'number',
      min: '100',
      max: '8000',
      step: '100',
      value: String(ch.maxTokens ?? 900),
      onchange: (e) => {
        ch.maxTokens = Number(e.target.value);
        const list = getSettings().channels.map((c) => (c.id === ch.id ? ch : c));
        patchSettings({ channels: list });
      },
    });

    body.appendChild(
      h('div', { class: 'row' }, [h('label', { text: '温度' }), tempInput, h('label', { text: '上限' }), maxInput]),
    );

    const testBtn = h('button', {
      class: 'mini-btn',
      text: '测试',
      onclick: async () => {
        testBtn.disabled = true;
        testOut.className = 'test-result';
        testOut.textContent = '请求中…';
        try {
          const r = await testChannel(ch);
          testOut.className = 'test-result ok';
          testOut.textContent = `通了 · ${r.ms}ms · ${r.content}`;
        } catch (e) {
          testOut.className = 'test-result fail';
          testOut.textContent = e?.message || String(e);
        } finally {
          testBtn.disabled = false;
        }
      },
    });

    const delBtn = h('button', {
      class: 'icon-btn',
      title: '删除这个渠道',
      onclick: (e) => {
        e.stopPropagation();
        const list = getSettings().channels.filter((c) => c.id !== ch.id);
        patchSettings({ channels: list });
        renderSettings();
      },
    });
    delBtn.appendChild(icon('trash', 13));

    body.appendChild(h('div', { class: 'row' }, [testBtn, delBtn]));
    body.appendChild(testOut);

    const card = h('div', { class: 'channel' }, [
      h('div', {
        class: 'channel-head',
        onclick: () => card.classList.toggle('open'),
      }, [
        h('span', { class: 'name', text: ch.name || '未命名' }),
        h('span', { class: 'model', text: ch.model || '' }),
        icon('chevron', 13),
      ]),
      body,
    ]);

    return card;
  }

  /* ---------------- 订阅 ---------------- */

  const unsubscribe = subscribe((state) => {
    if (settingsOpen) {
      applyStatus(state);
      return;
    }
    render(state);
    if (state.result?.at && collapsed) orbEl.classList.add('has-new');
    if (!collapsed) orbEl.classList.remove('has-new');
  });

  /* ---------------- 初始化 ---------------- */

  setCollapsed(settings.panel?.collapsed ?? false);
  if (!settings.channels.length) {
    settingsOpen = true;
    tabsEl.hidden = true;
    renderSettings();
  } else {
    render(getState());
  }

  return {
    el: panelEl,
    orb: orbEl,
    toggle,
    open: () => setCollapsed(false),
    close: () => setCollapsed(true),
    destroy: () => {
      unsubscribe();
      panelEl.remove();
      orbEl.remove();
    },
  };
}
