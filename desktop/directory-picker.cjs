'use strict';
const { isAbsolute } = require('node:path');
const { realpathSync, statSync } = require('node:fs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Only attached to the private backend child channel, never ipcMain/renderer.
function attachDirectoryPicker(child, { dialog, getWindow, allowed = () => true }) {
  const pending = new Map();
  const seen = new Set();
  let closed = false;
  let dialogOpen = false;
  const send = message => { if (!closed && child.connected) { try { child.send(message, () => {}); } catch {} } };
  const finish = (requestId, state, path) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId); clearTimeout(entry.timer);
    if (Date.now() >= entry.expiresAt) { state = 'expired'; path = undefined; }
    send({ type: 'directory-picker:result', requestId, state, ...(state === 'selected' ? { path } : {}) });
  };
  const onMessage = message => {
    if (closed || !message || !UUID.test(message.requestId ?? '')) return;
    const { requestId } = message;
    if (message.type === 'directory-picker:hello') { send({ type: 'directory-picker:capability', requestId, version: 1 }); return; }
    if (message.type === 'directory-picker:cancel') { finish(requestId, 'cancelled'); return; }
    if (message.type !== 'directory-picker:open' || seen.has(requestId)) return;
    if (seen.size >= 10000) { send({ type: 'directory-picker:result', requestId, state: 'failed' }); return; }
    seen.add(requestId);
    const { expiresAt, purpose } = message;
    const parent = getWindow();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 600000 || !['project', 'grant'].includes(purpose) || !allowed() || !parent || parent.isDestroyed() || dialogOpen || seen.size > 10000) {
      send({ type: 'directory-picker:result', requestId, state: 'failed' }); return;
    }
    const timer = setTimeout(() => finish(requestId, 'expired'), expiresAt - Date.now()); timer.unref();
    pending.set(requestId, { expiresAt, timer });
    // Electron has no portable close-open-dialog API: cancellation invalidates the request;
    // any result from the still-visible OS dialog is discarded.
    dialogOpen = true;
    Promise.resolve().then(() => dialog.showOpenDialog(parent, {
      title: purpose === 'project' ? '选择此项目的本地文件夹' : '选择授权给本项目的工作目录',
      properties: ['openDirectory'],
    })).then(result => {
      dialogOpen = false;
      if (!pending.has(requestId)) return;
      if (result.canceled) { finish(requestId, 'cancelled'); return; }
      try {
        if (!Array.isArray(result.filePaths) || result.filePaths.length !== 1) throw new Error();
        const input = result.filePaths[0];
        if (typeof input !== 'string' || input.includes('\0') || input.length > 16384 || !isAbsolute(input)) throw new Error();
        const path = realpathSync(input);
        if (!statSync(path).isDirectory()) throw new Error();
        finish(requestId, 'selected', path);
      } catch { finish(requestId, 'failed'); }
    }, () => { dialogOpen = false; finish(requestId, 'failed'); });
  };
  const close = () => {
    if (closed) return;
    for (const requestId of [...pending.keys()]) finish(requestId, 'cancelled');
    closed = true;
    child.removeListener('message', onMessage); child.removeListener('exit', close); child.removeListener('disconnect', close);
    seen.clear();
  };
  child.on('message', onMessage); child.once('exit', close); child.once('disconnect', close);
  // 主动能力公告：后端晚监听时消息驻留IPC管道，先于hello消除启动竞态（旧后端会忽略无requestId公告）。
  send({ type: 'directory-picker:capability', version: 1 });
  return { close };
}
module.exports = { attachDirectoryPicker };
