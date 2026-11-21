// 更新IPC桥：渲染层唯一更新通道，仅暴露最小方法（检查/下载/申请/取消/状态/事件）。
// 主进程侧再按「本窗口主frame」校验来源；渲染层不能指定路径、更新源或命令。
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// contextBridge copies/freezes this data; no renderer access to process or IPC.
contextBridge.exposeInMainWorld('prismPlatform', Object.freeze({ platform: process.platform, integratedTitlebar: ['darwin', 'win32'].includes(process.platform) }));
contextBridge.exposeInMainWorld('prismWindow', {
  setTheme: theme => { if (theme === 'dark' || theme === 'light') ipcRenderer.send('window:theme', theme); },
});

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('prismUpdates', {
  getStatus: () => ipcRenderer.invoke('updates:get-status'),
  check: () => ipcRenderer.invoke('updates:check'),
  download: releaseId => ipcRenderer.invoke('updates:download', String(releaseId ?? '')),
  downloadInstaller: () => ipcRenderer.invoke('updates:download-installer'),
  openInstaller: () => ipcRenderer.invoke('updates:open-installer', false),
  showInstaller: () => ipcRenderer.invoke('updates:open-installer', true),
  apply: releaseId => ipcRenderer.invoke('updates:apply', String(releaseId ?? '')),
  cancelApply: () => ipcRenderer.invoke('updates:cancel-apply'),
  downloadShell: () => ipcRenderer.invoke('updates:download-shell'),
  applyShell: () => ipcRenderer.invoke('updates:apply-shell'),
  onState: callback => subscribe('updates:state', callback),
  onMenu: callback => subscribe('updates:menu', callback),
});
