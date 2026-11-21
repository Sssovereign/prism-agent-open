import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampDrawerWidth, drawerWidthBounds } from '../web/layout/drawerWidth.js';

test('详情面板调宽：保留主区空间、侧栏收起后可扩展、覆盖面板受视口限制', () => {
    assert.deepEqual(drawerWidthBounds(1440, 264), { min: 320, max: 736 });
    assert.equal(clampDrawerWidth(900, 1440, 264), 736);
    assert.equal(clampDrawerWidth(900, 1440), 900);
    assert.equal(clampDrawerWidth(480, 390), 358);
    assert.equal(clampDrawerWidth(480, 200), 184);
    assert.equal(clampDrawerWidth(-10, 1440), 320);
    assert.equal(clampDrawerWidth(Number.NaN, 1440), 480);
    assert.equal(clampDrawerWidth(Number.POSITIVE_INFINITY, 1440), 480);
    assert.equal(clampDrawerWidth(700, 1280, 640), 320);
});
