export interface Preferences {
    sendShortcut: 'enter' | 'modifier-enter';
    textSize: 'standard' | 'large';
    followOutput: boolean;
    reduceMotion: boolean;
    eyeCare: boolean;
}
export const DEFAULT_PREFERENCES: Preferences = { sendShortcut: 'enter', textSize: 'standard', followOutput: true, reduceMotion: false, eyeCare: false };
export function loadPreferences(): Preferences { try {
    const p = JSON.parse(localStorage.getItem('prism-preferences') || '{}');
    return { sendShortcut: p.sendShortcut === 'modifier-enter' ? 'modifier-enter' : 'enter', textSize: p.textSize === 'large' ? 'large' : 'standard', followOutput: p.followOutput !== false, reduceMotion: p.reduceMotion === true, eyeCare: p.eyeCare === true };
}
catch {
    return { ...DEFAULT_PREFERENCES };
} }
export function savePreferences(value: Preferences) { try {
    localStorage.setItem('prism-preferences', JSON.stringify(value));
}
catch { /* preferences still apply in memory */ } document.documentElement.style.setProperty('--conversation-font-size', value.textSize === 'large' ? '16px' : '14px'); document.documentElement.dataset.reduceMotion = String(value.reduceMotion); document.documentElement.dataset.eyeCare = String(value.eyeCare); }
