/**
 * 与 SillyTavern 宿主接触的唯一入口。
 * ST 升级导致 API 变动时，只需要改这一个文件。
 */

/** 取 ST 上下文；未就绪返回 null（启动阶段常见）。 */
export function getCtx() {
  try {
    return window.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

export function isReady() {
  return !!getCtx();
}

/* ---------------- 聊天数据 ---------------- */

/** 原始楼层数组。每项是 STMessage：{ name, is_user, mes, swipes, extra, ... } */
export function getChat() {
  const c = getCtx();
  return Array.isArray(c?.chat) ? c.chat : [];
}

export function getLastMessageId() {
  const chat = getChat();
  return chat.length ? chat.length - 1 : -1;
}

/**
 * 参与分析的楼层：有正文、不是系统提示、不是本扩展自己插的。
 * ST 没有统一的 is_hidden 字段，隐藏楼层只能靠 DOM，这里不做过滤——
 * 摘要提取本身带正则兜底，多扫几条不会出错。
 */
export function getVisibleMessages() {
  return getChat().filter(
    (m) => m && typeof m.mes === 'string' && m.mes.trim() && !m.is_system && !m.extra?.meng_internal,
  );
}

/* ---------------- 角色卡 ---------------- */

export function getCharInfo() {
  const c = getCtx();
  if (!c) return null;
  try {
    const idx = c.characterId;
    const list = c.characters;
    if (idx !== undefined && idx !== null && Array.isArray(list) && list[idx]) {
      return list[idx];
    }
    if (c.groupId && Array.isArray(c.groups)) {
      const g = c.groups.find((x) => x.id === c.groupId);
      if (g) return { name: g.name, description: '', personality: '', group: true };
    }
  } catch {
    /* 群聊/特殊模式下取不到，走兜底 */
  }
  return null;
}

/** 当前角色名（群聊时是群名）。 */
export function getCharName() {
  return getCharInfo()?.name || getCtx()?.name2 || '';
}

/* ---------------- 变量 ---------------- */

/**
 * 读聊天变量。预设里大量使用 {{getvar::mode}} 这类宏，
 * 它们落在 chatMetadata.variables 里，正好可以判断当前是 RP 还是小说模式。
 */
export function getChatVariable(name) {
  try {
    const vars = getCtx()?.chatMetadata?.variables;
    return vars ? vars[name] : undefined;
  } catch {
    return undefined;
  }
}

/** 读全局变量（扩展设置之外、用户自己定义的那种）。 */
export function getGlobalVariable(name) {
  try {
    const vars = getCtx()?.extensionSettings?.variables;
    return vars ? vars[name] : undefined;
  } catch {
    return undefined;
  }
}

/* ---------------- 输入框 ---------------- */

/**
 * 把文本填进 ST 输入框。
 * 派发 input 事件，让 ST 自己同步高度、发送按钮状态和草稿。
 */
export function fillInput(text, sendNow = false) {
  const ta = document.querySelector('#send_textarea');
  if (!ta) return false;

  ta.value = String(text ?? '');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  try {
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
  } catch {
    /* 部分浏览器对 textarea 的 setSelectionRange 有限制 */
  }

  if (sendNow) {
    setTimeout(() => {
      const btn = document.querySelector('#send_but');
      if (btn) btn.click();
    }, 70);
  }
  return true;
}

/* ---------------- 事件 ---------------- */

/**
 * 订阅 ST 事件，返回取消订阅函数。
 * eventTypes 从上下文取，不同版本名字可能不同，取不到就退回字面量。
 */
export function on(eventName, handler) {
  const c = getCtx();
  const es = c?.eventSource;
  if (!es || typeof es.on !== 'function') return () => {};
  es.on(eventName, handler);
  return () => {
    try {
      es.off?.(eventName, handler);
    } catch {
      /* 老版本没有 off */
    }
  };
}

export function eventTypes() {
  const c = getCtx();
  return c?.eventTypes || c?.event_types || {};
}

/* ---------------- 设置持久化 ---------------- */

/**
 * 扩展设置落在 extension_settings 里（→ 服务器 settings.json），
 * 而不是 localStorage：换设备、换浏览器都能同步到同一份配置。
 */
export function readExtensionSettings(key) {
  try {
    const es = getCtx()?.extensionSettings;
    return es ? es[key] : undefined;
  } catch {
    return undefined;
  }
}

export function writeExtensionSettings(key, value) {
  const c = getCtx();
  if (!c) return false;
  try {
    if (!c.extensionSettings) c.extensionSettings = {};
    c.extensionSettings[key] = value;
    c.saveSettingsDebounced?.();
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 聊天元数据（按聊天隔离的缓存） ---------------- */

export function readChatMeta(key) {
  try {
    return getCtx()?.chatMetadata?.[key];
  } catch {
    return undefined;
  }
}

export function writeChatMeta(key, value) {
  const c = getCtx();
  if (!c) return false;
  try {
    if (!c.chatMetadata) c.chatMetadata = {};
    c.chatMetadata[key] = value;
    c.saveMetadataDebounced?.();
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 主题探测 ---------------- */

/**
 * 判断当前是深色还是浅色主题。
 * ST 没有统一的主题标记，最可靠的办法是量一下聊天区背景的实际亮度。
 */
export function detectTheme() {
  try {
    const probe =
      document.querySelector('#chat') ||
      document.querySelector('#sheld') ||
      document.body;
    const bg = getComputedStyle(probe).backgroundColor;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg || '');
    if (!m) return 'dark';
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
