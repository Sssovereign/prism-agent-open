export interface KeyboardShortcutPlatformInfo { platform?: string; userAgent?: string }
declare global { interface Window { readonly prismPlatform?: Readonly<{ platform: string; integratedTitlebar?: boolean }>; readonly prismWindow?: Readonly<{setTheme(theme:'light'|'dark'):void}> } }
export function isAppleKeyboardPlatform(info?: KeyboardShortcutPlatformInfo): boolean {
  if (!info) {
    const host = typeof window !== 'undefined' ? window.prismPlatform?.platform : undefined;
    if (host) return host === 'darwin';
    info = typeof navigator === 'undefined' ? {} : { platform: navigator.platform, userAgent: navigator.userAgent };
  }
  if (info.platform) return /darwin|mac|iphone|ipad|ipod/i.test(info.platform);
  return /Mac|iPhone|iPad|iPod/i.test(info.userAgent ?? '');
}
export const SHORTCUT_COMMANDS = [
  { id: 'newTask', label: '新任务', default: 'Mod+N' },
  { id: 'settings', label: '打开设置', default: 'Mod+,' },
  { id: 'sidebar', label: '切换侧栏', default: 'Mod+B' },
  { id: 'find', label: '查找会话', default: 'Mod+F' },
  { id: 'focusInput', label: '聚焦输入框', default: 'Mod+I' },
  { id: 'search', label: '搜索任务', default: 'Mod+G' },
  { id: 'searchAlternate', label: '搜索任务（备用）', default: 'Mod+K' },
  { id: 'thinking', label: '切换思考强度（输入区）', default: 'Mod+Shift+Y' },
] as const;
export type ShortcutId = typeof SHORTCUT_COMMANDS[number]['id'];
export type ShortcutBindings = Record<ShortcutId, string>;
export const defaultBindings = (): ShortcutBindings => Object.fromEntries(SHORTCUT_COMMANDS.map(c => [c.id, c.default])) as ShortcutBindings;
type KeyEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & Partial<Pick<KeyboardEvent, 'code' | 'isComposing' | 'keyCode' | 'repeat' | 'defaultPrevented' | 'getModifierState'>>;
export function ignoredKeyEvent(e: KeyEvent): boolean {
  return !!(e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat || e.getModifierState?.('AltGraph'));
}
export function primaryModifier(e: KeyEvent, info?: KeyboardShortcutPlatformInfo): boolean {
  return isAppleKeyboardPlatform(info) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
export function plainKey(e: KeyEvent): boolean { return !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey; }
export function shortcutFromEvent(e: KeyEvent, info?: KeyboardShortcutPlatformInfo): string | null {
  if (ignoredKeyEvent(e) || ['Control','Meta','Alt','AltGraph','Shift','Dead','Process','Unidentified'].includes(e.key)) return null;
  const primary = primaryModifier(e, info);
  // Never alias macOS Control (native Emacs editing) or Windows Meta to Mod.
  if ((e.ctrlKey || e.metaKey) && !primary || (!primary && !e.altKey)) return null;
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (e.code && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (e.code && /^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (e.code) {
    // Shift/Option can change event.key (Slash -> ?, BracketLeft -> {).
    // Record and match the same physical punctuation key, as for Key/Digit codes.
    const punctuation: Record<string, string> = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`', Minus: '-', Equal: '=' };
    key = punctuation[e.code] ?? key;
  }
  return [...(primary ? ['Mod'] : []), ...(e.altKey ? ['Alt'] : []), ...(e.shiftKey ? ['Shift'] : []), key].join('+');
}
export function matchesShortcut(e: KeyEvent, binding: string, info?: KeyboardShortcutPlatformInfo): boolean {
  return !!binding && shortcutFromEvent(e, info) === binding;
}
export function formatShortcut(binding: string, info?: KeyboardShortcutPlatformInfo): string {
  if (!binding) return '';
  const apple = isAppleKeyboardPlatform(info);
  return binding.split('+').map(p => p === 'Mod' ? apple ? '⌘' : 'Ctrl' : p === 'Alt' && apple ? '⌥' : p === 'Shift' && apple ? '⇧' : p).join(apple ? ' ' : '+');
}
export function shouldSend(e: KeyEvent, mode: 'enter' | 'modifier-enter', info?: KeyboardShortcutPlatformInfo): boolean {
  return !ignoredKeyEvent(e) && e.key === 'Enter' && (mode === 'enter' ? plainKey(e) : primaryModifier(e, info) && !e.altKey && !e.shiftKey);
}
export function shortcutProblem(bindings: ShortcutBindings, id: ShortcutId, binding: string): string | null {
  if (binding === '') return null;
  if (!/^(?:Mod\+(?:Alt\+)?|Alt\+)(?:Shift\+)?(?:[A-Z0-9,./;\[\]\\`=-]|F(?:[1-9]|1[0-2]))$/.test(binding)) return '请使用 Mod / Alt 加字母、数字、标点或 F1–F12 的组合键';
  if (/^Alt\+(?:Shift\+)?(?!F\d)[^+]+$/.test(binding)) return 'Alt / Option 字符键保留给原生文本输入';
  // Electron menu roles: minimize, zoomOut/zoomIn/resetZoom and togglefullscreen.
  // Reserve across platforms so a portable binding cannot shadow a host accelerator.
  if (/^Mod\+(?:Shift\+)?[M=\-0]$/.test(binding) || /^Mod\+(?:Alt\+)?(?:Shift\+)?F11$/.test(binding) || ['Alt+F11','Alt+Shift+F11'].includes(binding)) return '此组合键由桌面窗口最小化、缩放或全屏使用';
  // macOS fullscreen is Control+Command+F: the grammar intentionally cannot
  // represent it, and shortcutFromEvent rejects dual primary modifiers. Plain
  // F11 (Windows/Linux fullscreen) is likewise not a configurable combination.
  // Editing, window/browser control and result navigation remain native/reserved.
  if (/^Mod\+(?:Shift\+)?[ACVXZ]$/.test(binding) || /^Mod\+(?:Shift\+)?[QWTLR]$/.test(binding) || /^Mod\+[0-9]$/.test(binding) || ['Mod+Y','Mod+Shift+I','Mod+Shift+J','Mod+Shift+C','Alt+F4','Alt+F','Alt+E','Alt+Space'].includes(binding)) return '此组合键由系统、原生编辑、浏览器或搜索结果导航使用';
  const conflict = SHORTCUT_COMMANDS.find(c => c.id !== id && bindings[c.id] === binding);
  return conflict ? `与“${conflict.label}”冲突` : null;
}
export function normalizeShortcuts(raw: unknown): { bindings: ShortcutBindings; notices: string[] } {
  const bindings = defaultBindings(), notices: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { bindings, notices: ['快捷键配置无效，已恢复默认。'] };
  const stored = raw as Record<string, unknown>;
  const source = stored.version === 2 ? stored.bindings : stored;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { bindings, notices: ['快捷键配置无效，已恢复默认。'] };
  const values = source as Record<string, unknown>;
  // Start empty so swaps are legal. Missing/new commands receive defaults in the second pass.
  for (const c of SHORTCUT_COMMANDS) bindings[c.id] = '';
  for (const c of SHORTCUT_COMMANDS) {
    if (!(c.id in values)) continue;
    const value = values[c.id];
    const issue = typeof value === 'string' ? shortcutProblem(bindings, c.id, value) : '格式无效';
    if (issue) notices.push(`${c.label}：${issue}，已清除，请重新分配。`);
    else bindings[c.id] = value as string;
  }
  for (const c of SHORTCUT_COMMANDS) if (!(c.id in values)) {
    if (!shortcutProblem(bindings, c.id, c.default)) bindings[c.id] = c.default;
    else notices.push(`${c.label}：默认组合与已有绑定冲突，保持未分配。`);
  }
  if (stored.version !== 2) notices.unshift('旧快捷键已按当前平台迁移：macOS 使用 ⌘，Windows/Linux 使用 Ctrl；思考切档默认改为 Mod+Shift+Y。');
  return { bindings, notices };
}
export function loadShortcutState(user: string): { bindings: ShortcutBindings; notices: string[] } {
  try { const text = localStorage.getItem(`prism-shortcuts:${user}`); return text ? normalizeShortcuts(JSON.parse(text)) : { bindings: defaultBindings(), notices: [] }; }
  catch { return { bindings: defaultBindings(), notices: ['无法读取快捷键配置，暂用默认设置。'] }; }
}
export function loadShortcuts(user: string): ShortcutBindings { return loadShortcutState(user).bindings; }
export function saveShortcuts(user: string, bindings: ShortcutBindings): void {
  for (const c of SHORTCUT_COMMANDS) { const issue = shortcutProblem(bindings, c.id, bindings[c.id]); if (issue) throw new Error(`${c.label}：${issue}`); }
  try { localStorage.setItem(`prism-shortcuts:${user}`, JSON.stringify({ version: 2, bindings })); }
  catch { throw new Error('浏览器未允许保存快捷键'); }
}
/** Modal ownership is explicit; menus are also local keyboard scopes. */
export function globalShortcutBlocked(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"], [role="menu"], .composer-select-panel, .mention-panel, [data-shortcut-recording]');
}
