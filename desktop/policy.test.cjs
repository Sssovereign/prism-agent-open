const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isInternal, isExternal, dataDirectory, clipboardPermissionAllowed } = require('./policy.cjs');
test('仅允许宿主来源留在桌面窗口，拒绝相似域名及不同端口', () => {
  const origin = 'http://127.0.0.1:49152';
  assert.equal(isInternal(origin + '/api/v1/health', origin), true);
  for (const url of ['http://127.0.0.1:49153/', 'http://127.0.0.1.evil.test:49152/', 'file:///etc/passwd', 'javascript:alert(1)', 'invalid']) assert.equal(isInternal(url, origin), false);
});
test('系统打开仅限网页和邮件协议', () => {
  for (const url of ['https://example.com', 'http://example.com', 'mailto:test@example.com']) assert.equal(isExternal(url), true);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'powershell:run']) assert.equal(isExternal(url), false);
});
test('桌面数据路径显式配置优先，否则使用应用数据目录', () => {
  assert.equal(dataDirectory({}, '/tmp/Prism'), '/tmp/Prism');
  assert.equal(dataDirectory({ PRISM_DATA: '/tmp/legacy', PRISM_DATA_DIR: '/tmp/new' }, '/tmp/Prism'), '/tmp/new');
});
test('剪贴板权限仅对本地业务页放行，其余权限一律拒绝', () => {
  const origin = 'http://127.0.0.1:49152';
  assert.equal(clipboardPermissionAllowed('clipboard-sanitized-write', origin + '/', origin), true);
  assert.equal(clipboardPermissionAllowed('clipboard-read', origin, origin), true);
  for (const permission of ['geolocation', 'media', 'notifications', 'fullscreen', 'unknown-permission']) {
    assert.equal(clipboardPermissionAllowed(permission, origin, origin), false, permission);
  }
  for (const bad of ['http://127.0.0.1:49153/', 'http://127.0.0.1.evil.test:49152/', 'file:///etc/passwd', 'javascript:alert(1)', '', undefined]) {
    assert.equal(clipboardPermissionAllowed('clipboard-sanitized-write', bad, origin), false, bad);
  }
});
