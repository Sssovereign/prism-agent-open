// 右键菜单模板：ZCode 同款壳层策略——可编辑框给完整编辑操作，非编辑区选中文本只给复制，
// 其余（链接/图片/空白）返回空数组，调用方不 popup 即不弹菜单；开发态额外追加「检查元素」。
function buildTextContextMenuTemplate(params, { devTools } = {}) {
  const items = [];
  if (params.isEditable) {
    items.push(
      { label: '撤销', role: 'undo', enabled: !!params.editFlags?.canUndo },
      { label: '重做', role: 'redo', enabled: !!params.editFlags?.canRedo },
      { type: 'separator' },
      { label: '剪切', role: 'cut', enabled: !!params.editFlags?.canCut },
      { label: '复制', role: 'copy', enabled: !!params.editFlags?.canCopy },
      { label: '粘贴', role: 'paste', enabled: !!params.editFlags?.canPaste },
      { label: '删除', role: 'delete', enabled: !!params.editFlags?.canDelete },
      { type: 'separator' },
      { label: '全选', role: 'selectAll', enabled: !!params.editFlags?.canSelectAll },
    );
  } else if (String(params.selectionText ?? '').trim().length > 0) {
    items.push({ label: '复制', role: 'copy', enabled: !!params.editFlags?.canCopy });
  }
  if (devTools) {
    if (items.length > 0) items.push({ type: 'separator' });
    items.push({ label: '检查元素', click: () => devTools(params.x, params.y) });
  }
  return items;
}
module.exports = { buildTextContextMenuTemplate };
