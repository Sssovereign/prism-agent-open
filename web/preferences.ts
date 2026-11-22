export type TextSize = 'small' | 'standard' | 'large';
export interface Preferences {
    sendShortcut: 'enter' | 'modifier-enter';
    textSize: TextSize;
    followOutput: boolean;
    reduceMotion: boolean;
    eyeCare: boolean;
}
// 三档字号（对齐 ZCode uiFontSize.ts 的 12–20px 区间：下限 12、默认 14）。
export const TEXT_SIZE_PX: Record<TextSize, number> = { small: 12, standard: 14, large: 16 };
export function normalizeTextSize(value: unknown): TextSize { return value === 'small' || value === 'large' ? value : 'standard'; }
export const DEFAULT_PREFERENCES: Preferences = { sendShortcut: 'enter', textSize: 'standard', followOutput: true, reduceMotion: false, eyeCare: false };
export function loadPreferences(): Preferences { try {
    const p = JSON.parse(localStorage.getItem('prism-preferences') || '{}');
    return { sendShortcut: p.sendShortcut === 'modifier-enter' ? 'modifier-enter' : 'enter', textSize: normalizeTextSize(p.textSize), followOutput: p.followOutput !== false, reduceMotion: p.reduceMotion === true, eyeCare: p.eyeCare === true };
}
catch {
    return { ...DEFAULT_PREFERENCES };
} }
export function savePreferences(value: Preferences) { try {
    localStorage.setItem('prism-preferences', JSON.stringify(value));
}
catch { /* preferences still apply in memory */ }
// 对齐 ZCode：只覆盖 UI 字号基准 token（--ui-font-size），不动根 font-size，
// 避免连带缩放图标、间距与圆角；对话正文经 style.css 的
// --conversation-font-size: var(--ui-font-size) 派生级联。
document.documentElement.style.setProperty('--ui-font-size', `${TEXT_SIZE_PX[value.textSize]}px`);
document.documentElement.dataset.reduceMotion = String(value.reduceMotion);
document.documentElement.dataset.eyeCare = String(value.eyeCare); }
