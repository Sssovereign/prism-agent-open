const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTextContextMenuTemplate } = require('./context-menu.cjs');

const editableFlags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true };

test('可编辑区给出完整编辑菜单，各项随editFlags置灰', () => {
  const items = buildTextContextMenuTemplate({ isEditable: true, editFlags: editableFlags, selectionText: '', x: 10, y: 20 });
  assert.deepEqual(items.map(item => item.label), ['撤销', '重做', undefined, '剪切', '复制', '粘贴', '删除', undefined, '全选']);
  assert.deepEqual(items.filter(item => item.type === 'separator').length, 2);
  for (const item of items) if (item.role) assert.equal(item.enabled, true);
  const disabled = buildTextContextMenuTemplate({ isEditable: true, editFlags: { ...editableFlags, canUndo: false, canPaste: false } });
  assert.equal(disabled.find(item => item.role === 'undo').enabled, false);
  assert.equal(disabled.find(item => item.role === 'paste').enabled, false);
  assert.equal(disabled.find(item => item.role === 'copy').enabled, true);
});

test('非编辑区选中文本仅给复制，空白或链接不弹菜单', () => {
  const selected = buildTextContextMenuTemplate({ isEditable: false, editFlags: { canCopy: true }, selectionText: '  答复内容  ', x: 0, y: 0 });
  assert.deepEqual(selected, [{ label: '复制', role: 'copy', enabled: true }]);
  assert.equal(buildTextContextMenuTemplate({ isEditable: false, editFlags: {}, selectionText: '' }).length, 0);
  assert.equal(buildTextContextMenuTemplate({ isEditable: false, editFlags: {}, selectionText: '   ' }).length, 0);
  assert.equal(buildTextContextMenuTemplate({ isEditable: false, editFlags: {}, selectionText: '', srcURL: 'https://example.com', hrefURL: 'https://example.com' }).length, 0);
});

test('打包环境无检查元素；开发态追加且空模板也只给检查元素', () => {
  const packed = buildTextContextMenuTemplate({ isEditable: false, editFlags: {}, selectionText: '' }, { devTools: null });
  assert.equal(packed.length, 0);
  const packedEditable = buildTextContextMenuTemplate({ isEditable: true, editFlags: editableFlags }, {});
  assert.equal(packedEditable.some(item => item.label === '检查元素'), false);
  const calls = [];
  const dev = buildTextContextMenuTemplate({ isEditable: false, editFlags: {}, selectionText: '', x: 33, y: 44 }, { devTools: (x, y) => calls.push([x, y]) });
  assert.deepEqual(dev.map(item => item.label), ['检查元素']);
  dev.at(-1).click();
  assert.deepEqual(calls, [[33, 44]]);
  const devEditable = buildTextContextMenuTemplate({ isEditable: true, editFlags: editableFlags, x: 1, y: 2 }, { devTools: (x, y) => calls.push([x, y]) });
  assert.equal(devEditable.at(-1).label, '检查元素');
  assert.equal(devEditable.at(-2).type, 'separator');
});
