const path = require('node:path');
function isInternal(url, origin) {
  try { return new URL(url).origin === origin; } catch { return false; }
}
function isExternal(url) {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol); } catch { return false; }
}
function dataDirectory(env, userData) {
  return path.resolve(env.PRISM_DATA_DIR || env.PRISM_DATA || userData);
}
// 剪贴板读写仅对本地业务页放行：宿主权限默认全拒时，navigator.clipboard.writeText 的
// 权限检查（clipboard-sanitized-write）一并被拒，对话/代码块复制按钮会全部失效。
const CLIPBOARD_PERMISSIONS = ['clipboard-read', 'clipboard-sanitized-write'];
function clipboardPermissionAllowed(permission, requestingUrl, origin) {
  return CLIPBOARD_PERMISSIONS.includes(permission) && isInternal(requestingUrl ?? '', origin);
}
function titleBarOverlay(theme) {
  return { color: '#00000000', symbolColor: theme === 'dark' ? '#eeeeee' : '#242424', height: 48 };
}
function windowChromeOptions(platform, dark = false) {
  if (platform === 'darwin') return { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 16 } };
  if (platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(dark ? 'dark' : 'light') };
  return {};
}
module.exports = { isInternal, isExternal, dataDirectory, windowChromeOptions, titleBarOverlay, clipboardPermissionAllowed };
