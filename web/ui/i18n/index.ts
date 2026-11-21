// 界面语言（ZCode IntlProvider / DSH resolveDesktopStartupLocale 双参照裁剪，零第三方库）：
// - 偏好三态 system/zh/en，独立 localStorage（theme.ts 先例）；system 探测 navigator.language zh 前缀，
//   其余回退英文（ZCode/DSH 同款兜底方向）。
// - 模块级 ref + t()：模板/computed 里调用 t() 即自动跟踪重渲染，无需 provide/inject。
// - 扁平点分 key，{name} 占位符 replaceAll 插值（DSH formatDesktopMessage 同式）；
//   缺 key 依序回退另一语言 → key 本身。
// - 字典为纯数据文件，本模块在 node 下可直接 import（vue 响应式不依赖 DOM），node:test 可测。
import { ref } from 'vue';
import { zhCN } from './zh-CN.js';
import { enUS } from './en-US.js';

export type LanguagePref = 'system' | 'zh' | 'en';
export type Locale = 'zh' | 'en';

const KEY = 'prism-language';
const DICTS: Record<Locale, Record<string, string>> = { zh: zhCN, en: enUS };

export function loadLanguagePref(): LanguagePref {
    try { const v = localStorage.getItem(KEY); return v === 'zh' || v === 'en' ? v : 'system'; }
    catch { return 'system'; }
}

/** system → navigator.language 主子标签（zh 开头取中文，其余英文）；显式偏好原样通过。 */
export function resolveLocale(pref: LanguagePref): Locale {
    if (pref !== 'system') return pref;
    try {
        const language = typeof navigator === 'undefined' ? '' : navigator.language || '';
        return language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }
    catch { return 'en'; }
}

const locale = ref<Locale>(resolveLocale(loadLanguagePref()));
if (typeof document !== 'undefined') document.documentElement.lang = locale.value === 'zh' ? 'zh-CN' : 'en-US';

/** 当前生效语言（响应式；组件按需分支读取）。 */
export function currentLocale(): Locale { return locale.value; }

export function applyLanguage(pref: LanguagePref): void {
    locale.value = resolveLocale(pref);
    if (typeof document !== 'undefined') document.documentElement.lang = locale.value === 'zh' ? 'zh-CN' : 'en-US';
}

export function setLanguagePref(pref: LanguagePref): void {
    try { localStorage.setItem(KEY, pref); } catch { /* Language still applies in memory. */ }
    applyLanguage(pref);
}

export interface TranslateValues { [key: string]: string | number | undefined }

/** key 是否在任一字典登记（供「登记了才翻译」的调用方使用，如错误码映射）。 */
export function hasTranslation(key: string): boolean {
    return key in DICTS[locale.value] || key in DICTS[locale.value === 'zh' ? 'en' : 'zh'];
}

/** 翻译：字典查找（当前语言 → 另一语言 → key 本身）+ {name} 占位符插值。 */
export function t(key: string, values?: TranslateValues): string {
    const text = DICTS[locale.value][key] ?? DICTS[locale.value === 'zh' ? 'en' : 'zh'][key] ?? key;
    if (!values) return text;
    return text.replaceAll(/\{([^{}]+)\}/g, (placeholder, name) => {
        const value = values[name];
        return value === undefined ? placeholder : String(value);
    });
}
