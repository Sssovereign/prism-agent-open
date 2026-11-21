// 主题偏好：跟随系统/浅色/深色。仅记录本机非敏感偏好，不存用户内容。
export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'prism-theme';

export function loadThemePref(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; }
  catch { return 'system'; }
}

export function applyTheme(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  window.prismWindow?.setTheme(dark ? 'dark' : 'light');
}

export function setThemePref(pref: ThemePref): void {
  try { localStorage.setItem(KEY, pref); } catch { /* Theme still works with storage disabled. */ }
  applyTheme(pref);
}
