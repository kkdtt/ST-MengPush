/**
 * 主面板。
 *
 * 渲染策略：内容区每次状态变化重建（没有输入框，不怕失焦），
 * 设置页只建一次（有输入框，重建会丢焦点）。
 */

import { fillInput, readChatMeta, writeChatMeta } from '../core/ctx.js?v=2.21.0';
import {
  cancel,
  clearHistory,
  clearDream,
  deleteDreamMessage,
  updateDreamMessage,
  clearStory,
  getDream,
  getState,
  getStory,
  isRunning,
  loadHistory,
  previewMessages,
  runOne,
  runProfile,
  runDream,
  runStory,
  subscribe,
} from '../core/engine.js?v=2.21.0';
import { exportConfig, get as getSettings, importConfig, newChannel, patch as patchSettings } from '../core/settings.js?v=2.21.0';
import { PROMPT_FIELDS, getDefault, getPrompt, isCustomized } from '../core/prompts.js?v=2.21.0';
import { parseWorldbook, worldbookStats } from '../core/worldbook.js?v=2.21.0';
import { clearRecords, getRecords } from '../core/inspect.js?v=2.21.0';
import { testChannel } from '../core/api.js?v=2.21.0';
import { clear, h, icon, keepInViewport, makeDraggable } from './host.js?v=2.21.0';

/**
 * 顶层三组：自动 / 手动 / 设置。
 *
 * 六个平铺的 tab 太多了——「走向」和「新人」都是正文写完自动跑的，
 * 「梦中梦」「创作」「节拍」都是想起来才点的，混在一起每次都要找。
 * 分成两堆之后，顶层只有三个入口，组内再选。
 */
const GROUPS = [
  {
    id: 'auto',
    label: '自动',
    icon: 'play',
    items: [
      { id: 'choices', label: '走向', icon: 'branch' },
      { id: 'intro', label: '新人', icon: 'user' },
      { id: 'history', label: '往轮', icon: 'clock' },
    ],
  },
  {
    id: 'manual',
    label: '手动',
    icon: 'pen',
    items: [
      { id: 'dream', label: '梦中梦', icon: 'moon' },
      { id: 'story', label: '创作', icon: 'pen' },
      { id: 'beats', label: '节拍', icon: 'wave' },
    ],
  },
  { id: 'settings', label: '设置', icon: 'gear' },
];

/**
 * 提示词页的分层。
 *
 * 照预设的章法：破甲 → 设置 → 身份 → 资料 → 功能模块。
 * 预设里「准则与写法」整章没搬（旁路不落笔），
 * 「思维链」「输出装配」也没搬——那些位置由各功能模块自己占。
 */
const PROMPT_LAYERS = [
  {
    name: '破甲',
    title: '第 0 层 · 破甲',
    desc: '客人推门进来，然后垫一段写作样本。',
  },
  {
    name: '设置',
    title: '第 1 层 · 设置',
    desc: '清场 + 失忆。客人说「我来帮你把记忆一片一片捡回来」，然后才递身份。',
  },
  {
    name: '身份',
    title: '第 2 层 · 身份',
    desc: '他是谁、守什么。宪章和契约都在这一层。',
  },
  {
    name: '资料',
    title: '第 3 层 · 资料 · 自动拼装',
    desc: '身份讲完，客人说「抬起头，看看对面坐着的客人」。这一层不用编辑：',
    preview: `<梦境资料>
  <世界观与人物设定>        世界书 before + 角色卡
  <世界规则与其他补充材料>   世界书 after + @深度条目
  <其他补充材料>            你导入的那本世界书（开着的条目）
</梦境资料>`,
  },
  {
    name: '记忆',
    title: '第 4 层 · 记忆 · 自动拼装',
    desc: '这一场演到哪了。资料是「世界什么样」，记忆是「演到哪了」：',
    preview: `<过往事件>
大总结 + 更早的剧情摘要
</过往事件>

后面接最近 6 层的真实聊天记录（user / assistant 交替）`,
  },
  {
    name: '认领',
    title: '第 5 层 · 询问与认领',
    desc: '客人先问一句「都想起来了？」，弥彦才好接话。这一层也隔开了聊天记录和认领——否则两个 assistant 会挨着。',
  },
  {
    name: '功能模块',
    title: '第 6 层 · 功能模块',
    desc: '认领问完「你要什么」，这一层就是回答。换哪块内容，就跑哪个功能。',
  },
];

export function createPanel(shadow) {
  const settings = getSettings();

  let activeTab = settings.panel?.tab || 'choices';
  // 顶层分组：auto / manual / settings
  let activeGroup = settings.panel?.group || 'auto';
  /** 兼容老配置：没有 group 时按当前 tab 反推 */
  if (!settings.panel?.group) {
    const g = GROUPS.find((x) => x.items?.some((it) => it.id === (settings.panel?.tab || 'choices')));
    if (g) activeGroup = g.id;
  }
  let settingsTab = 'basic'; // basic | prompts
  let collapsed = false;

  /* ---------------- 骨架 ---------------- */

  const statusEl = h('span', { class: 'status', text: '' });
  const footEl = h('div', { class: 'foot' }, [statusEl]);
  const bodyEl = h('div', { class: 'body' });
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const subTabsEl = h('div', { class: 'subtabs' });

  const collapseBtn = h(
    'button',
    { class: 'icon-btn', title: '收起', onclick: () => setCollapsed(true) },
    [icon('close')],
  );

  // 顶栏只留开合。以前那个「重跑这一轮」是一次性把所有任务一起重发，
  // 现在每个功能在自己的页面里各自有一个按钮，顶栏这个就撤掉了。
  const headEl = h('div', { class: 'head' }, [
    h('div', { class: 'brand' }, [
      icon('brand', 15),
      h('span', { class: 'brand-name', text: '推 进 台' }),
    ]),
    h('div', { class: 'tools' }, [collapseBtn]),
  ]);

  const panelEl = h('div', { class: 'panel', role: 'dialog', 'aria-label': '剧情推进台' }, [
    headEl,
    tabsEl,
    subTabsEl,
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
    if (typeof p.w === 'number' && p.w > 0) {
      panelEl.style.width = p.w + 'px';
    }
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

  /* ---------------- 调宽度 ---------------- */

  /**
   * 右下角拖宽。
   *
   * 342px 固定宽在「走向」页够用，但检视页要看九万字的请求、
   * 设置页要摊渠道配置，那个宽度一行放不下几个字，滚起来很难受。
   */
  const resizeEl = h('div', {
    class: 'resize-handle',
    title: '拖动调宽度，双击恢复默认',
  });

  let rsStart = null;
  let rsPointer = null;

  resizeEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const r = panelEl.getBoundingClientRect();
    rsStart = { x: e.clientX, w: r.width };
    rsPointer = e.pointerId;
    try {
      resizeEl.setPointerCapture(e.pointerId);
    } catch {
      /* 不支持就算了 */
    }
    e.preventDefault();
    e.stopPropagation();
  });

  resizeEl.addEventListener('pointermove', (e) => {
    if (!rsStart || e.pointerId !== rsPointer) return;
    const w = Math.min(560, Math.max(300, rsStart.w + (e.clientX - rsStart.x)));
    panelEl.style.width = Math.round(w) + 'px';
  });

  const endResize = () => {
    if (!rsStart) return;
    rsStart = null;
    rsPointer = null;
    const w = Math.round(parseFloat(panelEl.style.width) || 0);
    if (w) {
      patchSettings({ panel: { ...getSettings().panel, w } });
      // 变宽后右边缘可能出界，拉回来
      fixPanelPos();
    }
  };
  resizeEl.addEventListener('pointerup', endResize);
  resizeEl.addEventListener('pointercancel', endResize);

  resizeEl.addEventListener('dblclick', () => {
    panelEl.style.width = '';
    patchSettings({ panel: { ...getSettings().panel, w: 0 } });
  });

  panelEl.appendChild(resizeEl);

  // 手机横竖屏切换、地址栏收起后，存下的坐标可能已经在屏幕外了
  const fixPanelPos = keepInViewport(panelEl);
  const fixOrbPos = keepInViewport(orbEl);
  // 首帧布局还没出来时测量全是 0，等一拍再校正
  setTimeout(() => {
    fixPanelPos();
    fixOrbPos();
  }, 120);

  /**
   * 悬浮球的拖动。
   *
   * 用 Pointer Events：手机上只有 pointer 事件，mousedown 那套根本不触发。
   * 球同时是「点击展开」和「拖动换位」，所以用 4px 位移阈值区分，
   * 超过阈值才算拖，否则让 click 照常走。
   */
  let orbStart = null;
  let orbPointerId = null;

  orbEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const r = orbEl.getBoundingClientRect();
    orbStart = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
    orbPointerId = e.pointerId;
    try {
      orbEl.setPointerCapture(e.pointerId);
    } catch {
      /* 不支持就退化成普通事件流 */
    }
  });

  orbEl.addEventListener('pointermove', (e) => {
    if (!orbStart || e.pointerId !== orbPointerId) return;
    const dx = e.clientX - orbStart.x;
    const dy = e.clientY - orbStart.y;
    if (!orbStart.moved && Math.hypot(dx, dy) < 4) return;
    orbStart.moved = true;
    const maxX = Math.max(0, window.innerWidth - orbEl.offsetWidth - 4);
    const maxY = Math.max(0, window.innerHeight - orbEl.offsetHeight - 4);
    orbEl.style.left = Math.min(Math.max(0, orbStart.left + dx), maxX) + 'px';
    orbEl.style.top = Math.min(Math.max(0, orbStart.top + dy), maxY) + 'px';
    orbEl.style.right = 'auto';
    orbEl.style.bottom = 'auto';
  });

  const endOrbDrag = () => {
    if (!orbStart) return;
    const wasDrag = orbStart.moved;
    if (wasDrag) {
      // 用 style 里的值，拖动时它就是最终位置；rect 在动画/transform 下会偏
      const x = parseFloat(orbEl.style.left);
      const y = parseFloat(orbEl.style.top);
      const r = orbEl.getBoundingClientRect();
      patchSettings({
        panel: {
          ...getSettings().panel,
          orbX: Math.round(Number.isFinite(x) ? x : r.left),
          orbY: Math.round(Number.isFinite(y) ? y : r.top),
        },
      });
      // 拖完别顺手把面板打开：拦掉紧随其后的 click
      orbEl.dataset.suppressClick = '1';
      setTimeout(() => delete orbEl.dataset.suppressClick, 120);
    }
    orbStart = null;
    orbPointerId = null;
  };

  orbEl.addEventListener('pointerup', (e) => {
    if (e.pointerId !== orbPointerId) return;
    endOrbDrag();
  });
  orbEl.addEventListener('pointercancel', endOrbDrag);

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
    // 展开时校正一次：桌面存的坐标在手机上可能已经出界了
    if (!collapsed) setTimeout(fixPanelPos, 0);
  }

  function toggle() {
    setCollapsed(!collapsed);
  }



  /* ---------------- 每个任务自己的状态 ---------------- */

  /**
   * 各功能各跑各的：一项在转，别的页面的按钮照常能点。
   * 之前共用一个 running 标志，跑「走向」的时候「节拍」的按钮也是灰的，
   * 一个任务失败整页变红。
   */
  function taskState(task) {
    return getState().tasks?.[task] || { status: 'idle', stage: '', error: '', at: 0 };
  }

  function busy(task) {
    return taskState(task).status === 'running';
  }

  function anyBusy() {
    return Object.values(getState().tasks || {}).some((t) => t?.status === 'running');
  }

  function taskErrorBox(task) {
    const t = taskState(task);
    return t.status === 'error' && t.error ? h('div', { class: 'error-box', text: t.error }) : null;
  }

  /* ---------------- 渲染：标签 ---------------- */

  function renderTabs(state) {
    clear(tabsEl);
    for (const g of GROUPS) {
      tabsEl.appendChild(
        h(
          'button',
          {
            class: 'tab',
            role: 'tab',
            'aria-selected': String(activeGroup === g.id),
            onclick: () => switchGroup(g.id),
          },
          [icon(g.icon, 13), h('span', { class: 'tab-label', text: g.label })],
        ),
      );
    }

    // 组内子项。设置组没有子项，这一行直接收起来。
    clear(subTabsEl);
    const group = GROUPS.find((x) => x.id === activeGroup);
    if (!group?.items) {
      subTabsEl.hidden = true;
      return;
    }
    subTabsEl.hidden = false;

    for (const it of group.items) {
      const count =
        it.id === 'choices'
          ? state.result?.choices?.length || 0
          : it.id === 'intro'
            ? state.result?.intros?.length || 0
            : it.id === 'beats'
              ? state.result?.beats?.length || 0
              : 0;

      subTabsEl.appendChild(
        h(
          'button',
          {
            class: 'subtab' + (activeTab === it.id ? ' on' : ''),
            onclick: () => {
              activeTab = it.id;
              patchSettings({ panel: { ...getSettings().panel, tab: it.id } });
              if (it.id === 'history') loadHistory();
              render(getState());
            },
          },
          [
            icon(it.icon, 12),
            h('span', { text: it.label }),
            count ? h('span', { class: 'badge', text: String(count) }) : null,
          ],
        ),
      );
    }
  }

  /** 切顶层组。切过去时当前子项不在这一组里，就落到第一个。 */
  function switchGroup(id) {
    activeGroup = id;

    if (id === 'settings') {
      patchSettings({ panel: { ...getSettings().panel, group: id } });
      // 先重画标签，把组内那一行收起来，再渲染设置页
      renderTabs(getState());
      renderSettings();
      return;
    }

    const g = GROUPS.find((x) => x.id === id);
    if (g && !g.items.some((it) => it.id === activeTab)) {
      activeTab = g.items[0].id;
      if (activeTab === 'history') loadHistory();
    }

    patchSettings({ panel: { ...getSettings().panel, group: id, tab: activeTab } });
    render(getState());
  }

  /* ---------------- 渲染：内容 ---------------- */

  function render(state) {
    renderTabs(state);

    if (activeGroup === 'settings') {
      renderSettings();
      return;
    }

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

    // 每个任务的错误只在自己那页显示，不影响别的页面
    if (activeTab === 'intro' || activeTab === 'beats') {
      const err = taskErrorBox(activeTab);
      if (err) bodyEl.appendChild(err);
    }

    if (activeTab === 'choices') renderChoices(state);
    else if (activeTab === 'intro') renderIntro(state);
    else if (activeTab === 'beats') renderBeats(state);
    else if (activeTab === 'history') renderHistory(state);

    renderFoot(state);
  }

  function renderChoices(state) {
    const mode = getSettings().panel?.choiceMode || 'choices';
    const isMoves = mode === 'moves';

    bodyEl.appendChild(
      h('div', { class: 'seg small' }, [
        h('button', {
          class: isMoves ? '' : 'on',
          text: '走向',
          onclick: () => {
            patchSettings({ panel: { ...getSettings().panel, choiceMode: 'choices' } });
            render(getState());
          },
        }),
        h('button', {
          class: isMoves ? 'on' : '',
          text: '反派行动',
          onclick: () => {
            // 只切视图，不发请求——要看就自己点「再想一批」
            patchSettings({ panel: { ...getSettings().panel, choiceMode: 'moves' } });
            render(getState());
          },
        }),
      ]),
    );

    const err = taskErrorBox(isMoves ? 'moves' : 'choices');
    if (err) bodyEl.appendChild(err);

    if (isMoves) {
      renderMoves(state);
      return;
    }

    const list = state.result?.choices || [];

    if (!list.length) {
      bodyEl.appendChild(
        emptyWithNote(state.result?.notes?.choices || '', 'choices', {
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

    bodyEl.appendChild(
      h('div', { class: 'note-row' }, [
        h('button', {
          class: 'mini-btn',
          text: busy('choices') ? '生成中…' : '重跑走向',
          title: '只重跑走向，不动其他功能',
          disabled: busy('choices'),
          onclick: () => runOne('choices'),
        }),
      ]),
    );
  }

  /**
   * 空态。关键是要说清楚「为什么空」——
   * 上一版把失败静默吞掉，面板上什么都不显示，用户根本分不清是没触发还是请求挂了。
   */
  function emptyWithNote(note, task, texts) {
    const wrap = h('div', { class: 'empty' });

    if (busy(task)) {
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
    wrap.appendChild(
      h('div', { class: 'note-row' }, [
        h('button', { class: 'mini-btn', text: '生成', onclick: () => runOne(task) }),
      ]),
    );
    return wrap;
  }

  /** 走向页的第二个模式：有人要动手了 */
  function renderMoves(state) {
    const list = state.result?.moves || [];
    const note = state.result?.notes?.moves || '';

    if (!list.length) {
      bodyEl.appendChild(
        emptyWithNote(note, 'moves', {
          running: '在想要谁动手……',
          empty: '模型没给出可用的行动',
          idle: '还没有反派行动',
        }),
      );
      return;
    }

    for (const m of list) {
      bodyEl.appendChild(
        h(
          'button',
          {
            class: 'move',
            title: '单击填入输入框，Ctrl+单击直接发送',
            onclick: (e) => {
              const send = e.ctrlKey || e.metaKey;
              fillInput(`${m.who}：${m.act}`, send);
              setStatus(send ? '已发送' : '已填入，改完发出去');
            },
          },
          [
            h('div', { class: 'move-head' }, [
              h('span', { class: 'move-n', text: String(m.n) }),
              h('span', { class: 'move-who', text: m.who || '某人' }),
              m.nsfw ? h('span', { class: 'chip heat', text: '情欲' }) : null,
              m.risk ? h('span', { class: `chip risk-${m.risk}`, text: '暴露 ' + m.risk }) : null,
            ]),
            h('div', { class: 'move-act', text: m.act }),
            m.gain ? h('div', { class: 'move-line', text: '得利：' + m.gain }) : null,
            m.cost ? h('div', { class: 'move-line', text: '代价：' + m.cost }) : null,
          ],
        ),
      );
    }

    bodyEl.appendChild(
      h('div', { class: 'note-row' }, [
        h('button', {
          class: 'mini-btn',
          text: busy('moves') ? '在想…' : '再想一批',
          title: '只重跑反派行动，不动其他功能',
          disabled: busy('moves'),
          onclick: () => runOne('moves'),
        }),
      ]),
    );
  }

  function renderIntro(state) {
    const list = state.result?.intros || [];
    const note = state.result?.notes?.intro || '';
    const running = busy('intro');
    const profiling = busy('profile');
    const s = getSettings();

    // 顶部控制条常驻：数量 + 换一批，空态也能操作
    const cntSel = h(
      'select',
      { class: 'story-scale', title: '一次介绍几个人（上限 10）' },
      [1, 2, 3, 4, 5, 6, 8, 10].map((n) =>
        h('option', {
          value: String(n),
          text: n + ' 人',
          selected: (s.introCount || 3) === n,
        }),
      ),
    );
    cntSel.onchange = (e) => patchSettings({ introCount: Number(e.target.value) });

    bodyEl.appendChild(
      h('div', { class: 'story-ctrl' }, [
        cntSel,
        h('button', {
          class: 'mini-btn',
          text: running ? '在想…' : list.length ? '换一批' : '抽新人',
          title: '只重跑新人，不动其他功能',
          disabled: running,
          onclick: () => runOne('intro'),
        }),
      ]),
    );

    if (!list.length) {
      bodyEl.appendChild(
        emptyWithNote(note, 'intro', {
          running: '在想新人……',
          empty: '模型没给出可用的人',
          idle: '还没有新人，点上面抽一批',
        }),
      );
      return;
    }

    const tpl = s.profileTemplate || '1';

    /** 每张卡各建一个下拉，同一个节点塞进多个父元素只会剩最后一个 */
    const makeTplSelect = () => {
      const sel = h(
        'select',
        { class: 'story-scale' },
        [
          { v: '1', t: '模板1 · 详细' },
          { v: '2', t: '模板2 · 精简' },
        ].map((o) => h('option', { value: o.v, text: o.t, selected: tpl === o.v })),
      );
      sel.onchange = (e) => patchSettings({ profileTemplate: e.target.value });
      return sel;
    };

    for (const it of list) {
      const card = h('div', { class: 'intro-card' }, [
        h('div', { class: 'intro-head' }, [
          h('span', { class: 'intro-name', text: it.name }),
          it.tag ? h('span', { class: 'intro-tag', text: it.tag }) : null,
        ]),
        it.relation ? h('div', { class: 'intro-line', text: '关系：' + it.relation }) : null,
        it.entry ? h('div', { class: 'intro-line', text: '由头：' + it.entry }) : null,
        it.hook ? h('div', { class: 'intro-line', text: '细节：' + it.hook }) : null,
        it.priv
          ? h('div', { class: 'intro-line intro-priv' }, [
              h('span', { class: 'intro-priv-tag', text: '私事' }),
              h('span', { text: it.priv }),
            ])
          : null,
      ]);

      const oneTpl = makeTplSelect();
      card.appendChild(
        h('div', { class: 'intro-actions' }, [
          oneTpl,
          h('button', {
            class: 'mini-btn primary',
            text: profiling ? '写着…' : '写档案',
            disabled: profiling,
            onclick: () => runProfile({ ...it, template: oneTpl.value }),
          }),
        ]),
      );

      bodyEl.appendChild(card);
    }

    if (state.profile) {
      bodyEl.appendChild(h('div', { class: 'section-label', text: '档案 · 复制后粘进世界书' }));
      bodyEl.appendChild(h('pre', { class: 'profile-text', text: state.profile }));
      bodyEl.appendChild(
        h('div', { class: 'note-row' }, [
          h('button', {
            class: 'mini-btn',
            text: '复制档案',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(state.profile);
                setStatus('已复制，去世界书新建条目粘进去');
              } catch {
                setStatus('复制失败，手动选中吧', 'err');
              }
            },
          }),
        ]),
      );
    }
  }

  function renderBeats(state) {
    const list = state.result?.beats || [];

    if (!list.length) {
      bodyEl.appendChild(
        emptyWithNote(state.result?.notes?.beats || '', 'beats', {
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

    bodyEl.appendChild(
      h('div', { class: 'note-row' }, [
        h('button', {
          class: 'mini-btn',
          text: busy('beats') ? '排着…' : '重排',
          title: '只重排节拍，不动其他功能',
          disabled: busy('beats'),
          onclick: () => runOne('beats'),
        }),
      ]),
    );
  }

  /* ---------------- 梦中梦 ---------------- */

  const dreamLog = h('div', { class: 'dream-log' });
  const dreamInput = h('textarea', {
    class: 'dream-input',
    rows: '2',
    placeholder: '跟弥彦说点什么……（Enter 发送，Shift+Enter 换行）',
    oninput: () => syncSendBtn(),
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

  /** 上一条是不是客人说的。是的话，输入框空着也能发（等于重发）。 */
  function lastIsUser() {
    const list = (getState().dream || getDream()).messages || [];
    return list[list.length - 1]?.role === 'user';
  }

  /** 按钮状态跟着输入框和最后一条走 */
  function syncSendBtn() {
    const running = busy('dream');
    const hasText = !!dreamInput.value.trim();
    const resend = !hasText && lastIsUser();

    dreamSend.disabled = running || (!hasText && !resend);
    dreamSend.textContent = running ? '…' : resend ? '重说' : '说';
    dreamSend.title = resend ? '输入框空着，点了按上一条重发' : '';
  }

  function sendDream() {
    const t = dreamInput.value.trim();
    if (!t && !lastIsUser()) return;
    dreamInput.value = '';
    syncSendBtn();
    // 空字符串会让 runDream 走「重发」分支
    void runDream(t);
  }

  function renderDream(state) {
    if (!bodyEl.contains(dreamWrap)) {
      clear(bodyEl);
      bodyEl.appendChild(dreamWrap);
    }

    const d = state.dream || getDream();
    const running = busy('dream');
    syncSendBtn();

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

    d.messages.forEach((m, idx) => {
      const isUser = m.role === 'user';
      const textEl = h('div', { class: 'dream-text', text: m.text });

      const bubble = h('div', { class: 'dream-msg ' + (isUser ? 'user' : 'assistant') }, [
        h('div', { class: 'dream-head' }, [
          h('span', { class: 'dream-who', text: isUser ? '你' : '弥彦' }),
          h('div', { class: 'dream-actions' }, [
            h('button', {
              class: 'dream-act',
              text: '复制',
              title: '复制这一条',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(m.text);
                  setStatus('已复制');
                } catch {
                  setStatus('复制失败，手动选中吧', 'err');
                }
              },
            }),
            h('button', {
              class: 'dream-act',
              text: '改',
              title: '改这一条，改完接着往下聊',
              onclick: () => {
                // 就地换成输入框，保存后整页重绘，不用手动还原
                const ta = h('textarea', { class: 'dream-edit' });
                ta.value = m.text;
                bubble.replaceChild(ta, textEl);
                bubble.querySelector('.dream-actions').hidden = true;

                const bar = h('div', { class: 'dream-edit-bar' }, [
                  h('button', {
                    class: 'mini-btn primary',
                    text: '保存',
                    onclick: () => updateDreamMessage(idx, ta.value),
                  }),
                  h('button', {
                    class: 'mini-btn',
                    text: '取消',
                    onclick: () => {
                      bubble.replaceChild(textEl, ta);
                      bubble.querySelector('.dream-actions').hidden = false;
                      bar.remove();
                    },
                  }),
                ]);
                bubble.appendChild(bar);
                ta.focus();
              },
            }),
            h('button', {
              class: 'dream-act',
              text: '删',
              title: '删掉这一条',
              onclick: () => deleteDreamMessage(idx),
            }),
          ]),
        ]),
        textEl,
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
    });

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

  // 幅度默认「不指定」：选了才在提示词里出现，否则模型会自己按幅度定节奏
  const storyScale = h('select', { class: 'story-scale', title: '推进幅度（可选）' }, [
    h('option', { value: '', text: '幅度 · 不指定' }),
    h('option', { value: 'light', text: '轻推 · 一件事' }),
    h('option', { value: 'medium', text: '中推 · 一个小事件' }),
    h('option', { value: 'heavy', text: '大推 · 跨一个阶段' }),
  ]);

  const storyCount = h('select', { class: 'story-scale', title: '大纲段数' }, [
    3, 4, 5, 6, 8, 10, 12,
  ].map((n) => h('option', { value: String(n), text: n + ' 段' })));

  const storyGo = h('button', {
    class: 'mini-btn primary',
    text: '出大纲',
    onclick: () =>
      runStory('outline', {
        keyword: draftKeyword,
        scale: storyScale.value,
        count: Number(storyCount.value) || 4,
      }),
  });

  const storyInput = h('div', { class: 'story-input' }, [
    storyKw,
    h('div', { class: 'story-ctrl' }, [storyCount, storyScale, storyGo]),
  ]);

  const storyBody = h('div', { class: 'story-body' });

  function renderStory(state) {
    const story = getStory() || {};
    const running = busy('story');

    // 输入区常驻：只在它不在 DOM 里时挂回去，避免每次状态变化都把正在打的字冲掉
    if (!bodyEl.contains(storyInput)) {
      clear(bodyEl);
      bodyEl.appendChild(storyInput);
      bodyEl.appendChild(storyBody);
      if (!draftKeyword && story.keyword) draftKeyword = story.keyword;
      storyKw.value = draftKeyword;
      storyScale.value = story.scale || '';
      if (story.outlineCount) storyCount.value = String(story.outlineCount);
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

    storyBody.appendChild(h('div', { class: 'section-label', text: '大纲 · 点一下填入输入框' }));
    for (const o of outline) {
      storyBody.appendChild(
        h(
          'button',
          {
            class: 'outline-item',
            title: '单击填入输入框，Ctrl+单击直接发送',
            onclick: (e) => {
              const send = e.ctrlKey || e.metaKey;
              fillInput(o.text, send);
              setStatus(send ? '已发送' : '已填入，改完发出去');
            },
          },
          [
            h('span', { class: 'outline-n', text: String(o.n) }),
            h('div', { class: 'outline-main' }, [
              o.title ? h('b', { text: o.title }) : null,
              h('span', { class: 'outline-text', text: o.text }),
            ]),
          ],
        ),
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
          text: steps.length ? '重新拆解' : '拆解',
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
      storyBody.appendChild(h('div', { class: 'section-label', text: '步骤 · 一步一步推' }));
      for (const st of steps) {
        storyBody.appendChild(
          h(
            'button',
            {
              class: 'step',
              title: '单击填入输入框，Ctrl+单击直接发送',
              onclick: (e) => {
                const send = e.ctrlKey || e.metaKey;
                fillInput(st.text, send);
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

    // 底栏只显示状态，重跑按钮下放到各页面，各跑各的
    clear(footEl);
    footEl.appendChild(statusEl);

    if (anyBusy()) {
      footEl.appendChild(
        h('button', {
          class: 'mini-btn',
          text: '取消',
          onclick: () => cancel(),
        }),
      );
    }
  }

  /* ---------------- 设置页 ---------------- */

  function renderSettings() {
    clear(bodyEl);
    clear(footEl);
    statusEl.textContent = '';
    footEl.appendChild(statusEl);

    const back = h('button', {
      class: 'mini-btn',
      text: '← 自动',
      onclick: () => switchGroup('auto'),
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

    // 提示词页单独一屏，按分层顺序排
    if (settingsTab === 'prompts') {
      for (const layer of PROMPT_LAYERS) {
        const fields = PROMPT_FIELDS.filter((f) => f.group === layer.name);
        const gp = h('div', { class: 'set-group' }, [
          h('h4', { text: `${layer.title}${fields.length ? '' : ' · 自动拼装'}` }),
        ]);

        if (fields.length) {
          for (const field of fields) gp.appendChild(promptEditor(field));
        } else {
          gp.appendChild(h('div', { class: 'prompt-hint', text: layer.desc }));
          gp.appendChild(h('pre', { class: 'layer-preview', text: layer.preview || '' }));
        }
        box.appendChild(gp);
      }

      box.appendChild(
        h('div', {
          class: 'empty',
          style: { padding: '2px 0 0', textAlign: 'left', fontSize: '11px', lineHeight: '1.8' },
          text: '留空 = 用内置默认。改坏了点「恢复默认」即可。点分组标题可以折叠。',
        }),
      );

      box.appendChild(buildWorldbookGroup());
      return;
    }

    // 点分组标题折叠/展开。设置页七个分组一屏到底，找东西要滚半天。
    // 只加在 box 上，box 每次重建设置页都是新的，不会重复绑。
    box.addEventListener('click', (e) => {
      const h4 = e.target.closest('.set-group > h4');
      if (h4) h4.parentElement.classList.toggle('collapsed');
    });

    /* --- 自动跑哪些 --- */
    const g1 = h('div', { class: 'set-group' }, [h('h4', { text: '运行' })]);
    g1.appendChild(
      switchRow('正文写完自动跑', s.auto, (v) => patchSettings({ auto: v })),
    );
    g1.appendChild(
      switchRow('自动跑走向', s.modules.choices, (v) => patchSettings({ modules: { choices: v } })),
    );
    g1.appendChild(
      switchRow('自动跑反派行动', s.modules.moves, (v) => patchSettings({ modules: { moves: v } })),
    );
    g1.appendChild(
      switchRow('自动跑新人', s.modules.intro, (v) => patchSettings({ modules: { intro: v } })),
    );
    g1.appendChild(
      h('div', {
        class: 'prompt-hint',
        text:
          '只在「酒馆正文这一版真的写完」之后跑：捕获到主对话请求的响应读完、新楼层进了聊天，才算数。' +
          '推进台自己发的请求不算，换 swipe、切页面也不会重复跑，同一层楼只自动跑一次。' +
          '勾上的几项各自并发，互不等待；每个功能在自己页面里还有按钮，随时可以单独点。',
      }),
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
      ['moves', '反派行动'],
      ['intro', '新人介绍'],
      ['profile', '角色档案'],
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
      numRow('对话层数', s.historyDepth, 0, 50, 1, (v) => patchSettings({ historyDepth: v }), '层'),
    );
    g4.appendChild(
      switchRow('空 user 补空格', s.emptyUserPad, (v) => {
        patchSettings({ emptyUserPad: v });
        renderSettings();
      }),
    );
    if (s.emptyUserPad) {
      g4.appendChild(
        h('div', {
          class: 'prompt-hint',
          text: '任务前那条 user 默认是空的。个别网关会拒收空 content，报 400 时把这里打开。',
        }),
      );
    }
    /* --- 上下文预览 --- */
    const previewBox = h('div', { class: 'pv-box' });

    g4.appendChild(
      h('div', { class: 'story-ctrl' }, [
        h('button', {
          class: 'mini-btn',
          text: '预览本次上下文',
          title: '把这次会发出去的内容拼出来给你看，不消耗请求',
          onclick: async () => {
            clear(previewBox);
            previewBox.textContent = '拼装中…';
            try {
              const msgs = await previewMessages();
              clear(previewBox);
              msgs.forEach((m, i) => {
                const empty = m.role === 'user' && !String(m.content || '').trim();
                previewBox.appendChild(
                  h('div', { class: 'pv-msg' + (empty ? ' pv-empty' : '') }, [
                    h('div', { class: 'pv-head' }, [
                      h('span', { class: `pv-role ${m.role}`, text: m.role }),
                      h('span', { class: 'pv-idx', text: '#' + (i + 1) }),
                      h('span', {
                        class: 'pv-len',
                        text: empty ? '空' : String(m.content || '').length + ' 字',
                      }),
                    ]),
                    h('pre', {
                      class: 'pv-body',
                      text: empty ? '（客人没说话 —— 这一条是故意留空的 user）' : m.content,
                    }),
                  ]),
                );
              });
            } catch (err) {
              previewBox.textContent = '拼装失败：' + (err?.message || err);
            }
          },
        }),
      ]),
    );
    g4.appendChild(previewBox);

    g4.appendChild(
      switchRow('工具通道（抗截断）', s.useToolChannel, (v) => {
        patchSettings({ useToolChannel: v });
        renderSettings();
      }),
    );
    if (s.useToolChannel) {
      g4.appendChild(
        h('div', {
          class: 'prompt-hint',
          text: '内容走 tool_calls 的 arguments 而不是正文：断流时能按半截 JSON 救回，触发上游内容过滤的概率也更低。渠道不支持 tools 会自动降级回文本通道。',
        }),
      );
    }
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

    /* --- 大总结 --- */
    const g5 = h('div', { class: 'set-group' }, [h('h4', { text: '大总结' })]);
    g5.appendChild(
      h('div', {
        class: 'prompt-hint',
        text: '粘这里的内容会整段放进 <过往事件>，排在摘要前面。通常放预设里的存档条目或阶段性大总结。',
      }),
    );
    const bg = h('textarea', {
      class: 'prompt-input',
      rows: '6',
      placeholder: '把大总结存档粘在这里……',
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

    /* --- 配置备份 --- */
    const gbak = h('div', { class: 'set-group' }, [h('h4', { text: '配置备份' })]);
    gbak.appendChild(
      h('div', {
        class: 'prompt-hint',
        text: '导出包含渠道（含密钥）、全部参数、提示词、导入的世界书。文件头有 summary，一眼能看出里面有什么。旧版本遗留的废弃字段会自动清掉。',
      }),
    );

    const impInput = h('input', {
      type: 'file',
      accept: '.json,application/json',
      style: { display: 'none' },
      onchange: async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
          importConfig(await file.text());
          setStatus('配置已导入');
          renderSettings();
        } catch (err) {
          setStatus('导入失败：' + (err?.message || err), 'err');
        }
      },
    });

    gbak.appendChild(
      h('div', { class: 'story-ctrl' }, [
        h('button', {
          class: 'mini-btn',
          text: '导出配置',
          onclick: () => {
            try {
              const text = exportConfig();
              const blob = new Blob([text], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = `meng-push-config-${new Date().toISOString().slice(0, 10)}.json`;
              document.body.appendChild(a);
              a.click();
              setTimeout(() => {
                URL.revokeObjectURL(a.href);
                a.remove();
              }, 1000);
              setStatus('已导出');
            } catch (err) {
              setStatus('导出失败：' + (err?.message || err), 'err');
            }
          },
        }),
        h('button', {
          class: 'mini-btn',
          text: '导入配置',
          onclick: () => impInput.click(),
        }),
        impInput,
      ]),
    );
    box.appendChild(gbak);

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

  /** 这一轮到底走没走工具通道，四种情况分开显示 */
  function resultTag(r) {
    const map = {
      tool: { cls: 'toolok', text: `✓ ${r.toolName || '工具'}` },
      notool: { cls: 'toolhalf', text: '△ 没调工具' },
      degraded: { cls: 'toolno', text: '✗ 降级文本' },
      text: { cls: 'toolno', text: '— 文本' },
    };
    const it = map[r.reason] || map.text;
    return h('span', { class: 'rec-tag ' + it.cls, text: it.text });
  }

  /** tool_choice 可能是字符串也可能是 {type,function:{name}} 对象 */
  function fmtChoice(v) {
    if (v === null || v === undefined || v === '') return '-';
    if (typeof v === 'string') return v;
    return v?.function?.name || v?.type || JSON.stringify(v);
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

  /**
   * 全局世界书。
   *
   * 独立于 ST 那本：ST 那本按关键词实时注入，插件读不到没触发的条目，
   * 这里导入一份副本自己管。导入时按灯色定初始开关——
   * 蓝灯（常驻）开，绿灯（关键词触发）和手动关掉的关。
   */
  function buildWorldbookGroup() {
    const s = getSettings();
    const wb = s.worldbook || { name: '', entries: [] };
    const list = Array.isArray(wb.entries) ? wb.entries : [];
    const st = worldbookStats(wb);

    const g = h('div', { class: 'set-group' }, [h('h4', { text: '全局世界书' })]);
    g.appendChild(
      h('div', {
        class: 'prompt-hint',
        text:
          '导入 ST 导出的世界书 JSON。蓝灯（常驻）默认开，绿灯和关掉的默认关。' +
          '开着的条目会拼进资料段，位置在 <世界规则与其他补充材料> 后面。',
      }),
    );

    const save = (entries) =>
      patchSettings({ worldbook: { ...getSettings().worldbook, entries } });

    const fileInput = h('input', {
      type: 'file',
      accept: '.json,application/json',
      style: { display: 'none' },
      onchange: async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
          const parsed = parseWorldbook(await file.text(), file.name);
          patchSettings({ worldbook: parsed });
          setStatus(`已导入 ${parsed.entries.length} 条，开着 ${parsed.entries.filter((x) => x.on).length} 条`);
          renderSettings();
        } catch (err) {
          setStatus('导入失败：' + (err?.message || err), 'err');
        }
      },
    });

    g.appendChild(
      h('div', { class: 'story-ctrl' }, [
        h('button', {
          class: 'mini-btn',
          text: list.length ? '换个文件' : '导入世界书 JSON',
          onclick: () => fileInput.click(),
        }),
        list.length
          ? h('button', {
              class: 'mini-btn',
              text: '清除',
              onclick: () => {
                patchSettings({ worldbook: { name: '', at: 0, entries: [] } });
                setStatus('已清除全局世界书');
                renderSettings();
              },
            })
          : null,
        fileInput,
      ]),
    );

    if (!list.length) return g;

    g.appendChild(
      h('div', {
        class: 'wb-summary',
        text: `${wb.name || '世界书'} · ${st.total} 条 · 开着 ${st.on} 条 · ${st.chars} 字`,
      }),
    );

    const rows = h('div', { class: 'wb-list' });
    list.forEach((e, i) => {
      const box = h('input', { type: 'checkbox' });
      box.checked = !!e.on;
      box.onchange = (ev) => {
        const next = list.map((x, j) => (j === i ? { ...x, on: ev.target.checked } : x));
        save(next);
        renderSettings();
      };
      rows.appendChild(
        h('label', { class: 'wb-row' }, [
          box,
          h('span', { class: 'wb-name', text: e.name }),
          h('span', { class: 'wb-chars', text: (e.chars || String(e.content || '').length) + ' 字' }),
        ]),
      );
    });
    g.appendChild(rows);

    g.appendChild(
      h('div', { class: 'story-ctrl' }, [
        h('button', {
          class: 'mini-btn',
          text: '全开',
          onclick: () => {
            save(list.map((x) => ({ ...x, on: true })));
            renderSettings();
          },
        }),
        h('button', {
          class: 'mini-btn',
          text: '全关',
          onclick: () => {
            save(list.map((x) => ({ ...x, on: false })));
            renderSettings();
          },
        }),
      ]),
    );

    g.appendChild(
      numRow(
        '字数上限',
        s.worldbookChars,
        1000,
        200000,
        1000,
        (v) => patchSettings({ worldbookChars: v }),
        '字',
      ),
    );

    return g;
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
        r.hijacked ? h('span', { class: 'rec-tag hijack', text: '被脚本接管' }) : null,
        r.result ? resultTag(r.result) : null,
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
        text: `model ${r.model || '-'}　temp ${r.temperature ?? '-'}　max_tokens ${r.maxTokens ?? '-'}　tool_choice ${fmtChoice(r.toolChoice)}　stream ${r.stream}`,
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
            const full = [
              ...r.messages.map((m) => `[${m.role}]\n${m.content}`),
              ...(r.tools || []).map((t) => `[tool ${t.name}]\n${t.raw}`),
            ].join('\n\n');
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
      min: '0',
      max: '64000',
      step: '500',
      placeholder: '留空=上游默认',
      value: ch.maxTokens ? String(ch.maxTokens) : '',
      onchange: (e) => {
        ch.maxTokens = Number(e.target.value) || 0;
        const list = getSettings().channels.map((c) => (c.id === ch.id ? ch : c));
        patchSettings({ channels: list });
      },
    });

    const topPInput = h('input', {
      type: 'number',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(ch.topP ?? 0.95),
      onchange: (e) => {
        ch.topP = Number(e.target.value);
        const list = getSettings().channels.map((c) => (c.id === ch.id ? ch : c));
        patchSettings({ channels: list });
      },
    });

    const streamChk = h('input', {
      type: 'checkbox',
      onchange: (e) => {
        ch.stream = e.target.checked;
        const list = getSettings().channels.map((c) => (c.id === ch.id ? ch : c));
        patchSettings({ channels: list });
      },
    });
    streamChk.checked = !!ch.stream;

    body.appendChild(
      h('div', { class: 'row' }, [
        h('label', { text: '温度' }),
        tempInput,
        h('label', { text: 'TopP' }),
        topPInput,
      ]),
    );

    body.appendChild(
      h('div', { class: 'row' }, [
        h('label', { text: '上限' }),
        maxInput,
        h('label', { class: 'switch inline' }, [streamChk, h('span', { text: '流式' })]),
      ]),
    );

    if (ch.stream) {
      body.appendChild(
        h('div', {
          class: 'prompt-hint',
          text: '流式下拿不到可靠的 tool_calls，工具通道会自动退回文本通道。',
        }),
      );
    }

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
    // 设置页重绘会丢输入焦点，跑任务时只更新状态文字
    if (activeGroup === 'settings') {
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
    // 没配渠道先扔进设置，省得点半天才发现没东西可跑
    activeGroup = 'settings';
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
