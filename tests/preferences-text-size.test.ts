import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEXT_SIZE_PX, normalizeTextSize, DEFAULT_PREFERENCES, type TextSize } from '../web/preferences.js';

// 界面字号三档（对齐 ZCode uiFontSize：12–20px 区间，默认 14px，只覆盖 --ui-font-size 基准 token）。

test('三档字号映射为 px：小12/标准14/大16，默认标准档', () => {
    assert.equal(TEXT_SIZE_PX.small, 12);
    assert.equal(TEXT_SIZE_PX.standard, 14);
    assert.equal(TEXT_SIZE_PX.large, 16);
    assert.equal(TEXT_SIZE_PX[DEFAULT_PREFERENCES.textSize], 14);
});

test('normalizeTextSize：合法档位保留，未知与缺失一律回退标准档（旧两档偏好迁移无损）', () => {
    for (const size of ['small', 'standard', 'large'] as const) {
        assert.equal(normalizeTextSize(size), size);
    }
    for (const bad of [undefined, null, '', 'huge', 12, true, {}]) {
        assert.equal(normalizeTextSize(bad), 'standard', String(JSON.stringify(bad)));
    }
    // 旧版两档偏好只可能存过 'standard'|'large'，不得被改写成 'small'
    assert.equal(normalizeTextSize('large'), 'large');
});

test('档位类型与 px 映射一一对应，无越界档位', () => {
    const sizes: TextSize[] = ['small', 'standard', 'large'];
    assert.equal(Object.keys(TEXT_SIZE_PX).length, sizes.length);
    for (const size of sizes) {
        assert.ok(Number.isInteger(TEXT_SIZE_PX[size]) && TEXT_SIZE_PX[size] >= 12 && TEXT_SIZE_PX[size] <= 20, size);
    }
});
