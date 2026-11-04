/**
 * 主面板。
 *
 * 渲染策略：内容区每次状态变化重建（没有输入框，不怕失焦），
 * 设置页只建一次（有输入框，重建会丢焦点）。
 */

import { fillInput } from '../core/ctx.js';
import {
  cancel,
  clearHistory,
  getState,
  isRunning,
  loadHistory,
  run,
  runOne,
  subscribe,
} from '../core/engine.js';
import { get as getSettings, newChannel, patch as patchSettings } from '../core/settings.js';
import { PROMPT_FIELDS, getDefault, getPrompt, isCustomized } from '../core/prompts.js';
import { testChannel } from '../core/api.js';
import { clear, h, icon, makeDraggable } from './host.js';

const TABS = [
  { id: 'choices', label: '走向' },
  { id: 'danmaku', label: '场外' },
  { id: 'beats', label: '节拍' },
  { id: 'history', label: '往轮' },
];

export function createPanel(shadow) {
  const settings = getSettings();

  let activeTab = settings.panel?.tab || 'choices';
  let settingsOpen = false;
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
    g4.appendChild(numRow('选项条数', s.choiceCount, 3, 8, 1, (v) => patchSettings({ choiceCount: v })));
    g4.appendChild(
      numRow('弹幕概率', s.danmakuChance, 0, 1, 0.1, (v) => patchSettings({ danmakuChance: v })),
    );
    g4.appendChild(numRow('摘要回溯', s.summaryDepth, 1, 8, 1, (v) => patchSettings({ summaryDepth: v }), '轮'));
    g4.appendChild(numRow('正文尾部', s.tailChars, 400, 4000, 100, (v) => patchSettings({ tailChars: v }), '字'));
    g4.appendChild(
      switchRow('JSON 模式（渠道不支持就关）', s.jsonMode, (v) => patchSettings({ jsonMode: v })),
    );
    box.appendChild(g4);

    /* --- 提示词 --- */
    const g5 = h('div', { class: 'set-group' }, [h('h4', { text: '提示词' })]);
    for (const field of PROMPT_FIELDS) {
      g5.appendChild(promptEditor(field));
    }
    box.appendChild(g5);

    /* --- 关于 --- */
    const g6 = h('div', { class: 'set-group' }, [h('h4', { text: '关于' })]);
    g6.appendChild(
      h('div', {
        class: 'empty',
        style: { padding: '4px 0', textAlign: 'left', lineHeight: '1.9' },
        html:
          '选项与弹幕由旁路模型生成，只进这个面板，不写回聊天楼层，<br>' +
          '所以不占用主对话的上下文。<br>' +
          '单击卡片填入输入框，Ctrl+单击直接发送。',
      }),
    );
    box.appendChild(g6);
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

  function numRow(label, value, min, max, step, onChange, suffix = '') {
    const input = h('input', {
      type: 'number',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
      onchange: (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
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
