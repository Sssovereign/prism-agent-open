import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_ERROR_CODES } from '../contracts/errors.js';
import { ERROR_CODE_PRESETS, describeApiError } from '../web/ui/errorPresentation.js';
import { ApiError } from '../web/api.js';
import { t, applyLanguage, resolveLocale, currentLocale, type LanguagePref } from '../web/ui/i18n/index.js';
import { zhCN } from '../web/ui/i18n/zh-CN.js';
import { enUS } from '../web/ui/i18n/en-US.js';

function placeholdersOf(text: string): string[] {
    return [...text.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]!);
}

test('zh/en 字典逐 key 对等', () => {
    const zh = Object.keys(zhCN).sort(), en = Object.keys(enUS).sort();
    assert.deepEqual(zh, en, '两份字典的 key 集合必须完全一致');
});

test('占位符逐 key 对等', () => {
    for (const [key, text] of Object.entries(zhCN)) {
        assert.deepEqual(placeholdersOf(text).sort(), placeholdersOf(enUS[key]!).sort(), `key ${key} 的占位符不一致`);
    }
});

test('ERROR_CODE_PRESETS 每个码都登记了 errors.* 字典文案', () => {
    const missing = Object.keys(ERROR_CODE_PRESETS).filter(code => !(`errors.${code}` in zhCN) || !(`errors.${code}` in enUS));
    assert.deepEqual(missing, [], '新增错误码须同时在 zh/en 字典登记 errors.<CODE> 呈现文案');
});

test('ALL_ERROR_CODES 与 ERROR_CODE_PRESETS 对齐（沿用 error-presentation 契约）', () => {
    const missing = ALL_ERROR_CODES.filter(code => !(code in ERROR_CODE_PRESETS));
    assert.deepEqual(missing, []);
});

test('resolveLocale：显式偏好直通，system 按 zh 前缀探测、其余英文兜底', () => {
    assert.equal(resolveLocale('zh'), 'zh');
    assert.equal(resolveLocale('en'), 'en');
    // node 的 globalThis.navigator 只读（getter-only 但 configurable），用 defineProperty 打桩。
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const stub = (language: string) => Object.defineProperty(globalThis, 'navigator', { value: { language }, configurable: true, enumerable: true });
    try {
        stub('zh-CN');
        assert.equal(resolveLocale('system'), 'zh');
        stub('en-US');
        assert.equal(resolveLocale('system'), 'en');
        stub('ja-JP');
        assert.equal(resolveLocale('system'), 'en');
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    }
});

test('t()：当前语言查找 + {name} 插值 + 缺值保留占位符 + 缺 key 回退', () => {
    applyLanguage('zh');
    assert.equal(t('common.loading'), '正在读取…');
    assert.equal(t('settings.general.sendOptionModifier', { shortcut: 'Ctrl+Enter' }), 'Ctrl+Enter 发送');
    assert.equal(t('settings.general.sendOptionModifier', {}), '{shortcut} 发送');
    assert.equal(t('no.such.key'), 'no.such.key');
    applyLanguage('en');
    assert.equal(t('common.loading'), 'Loading…');
    assert.equal(t('settings.general.sendOptionModifier', { shortcut: 'Ctrl+Enter' }), 'Ctrl+Enter sends');
});

test('describeApiError：中文模式服务端 message 优先；英文模式 errors.<CODE> 字典翻译', () => {
    const apiError = new ApiError('CREDENTIAL_REQUIRED', '当前模型连接缺少 API Key', 422);
    applyLanguage('zh');
    const zhView = describeApiError(apiError, '操作失败');
    assert.equal(zhView.message, '当前模型连接缺少 API Key');
    applyLanguage('en');
    const enView = describeApiError(apiError, 'Operation failed');
    assert.equal(enView.message, 'A model connection is required first.');
    assert.equal(enView.action?.label, 'Open model settings');
    const fallbackView = describeApiError(new Error('plain'), 'Operation failed');
    assert.equal(fallbackView.message, 'plain');
});

test('语言切换是模块级响应式：currentLocale 与 t() 同步翻转', () => {
    const sequence: LanguagePref[] = ['en', 'zh'];
    for (const pref of sequence) {
        applyLanguage(pref);
        assert.equal(currentLocale(), pref);
    }
});
