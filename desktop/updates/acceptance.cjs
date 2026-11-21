// 仅显式隔离验收启用；复用实际preload IPC、应用切换、窗口和持久化路径。
const { writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
module.exports = async function acceptance({ app, window, updater, selection, isApplying }) {
  const output = process.env.PRISM_UPDATES_ACCEPTANCE;
  const dataDir = process.env.PRISM_DATA_DIR ?? '';
  const profile = process.env.PRISM_DESKTOP_PROFILE ?? '';
  if (![output, dataDir, profile].every(value => value.includes('/.cache/verification/'))) throw new Error('验收入口仅允许隔离数据／配置／输出目录');
  const action = process.env.PRISM_UPDATES_QA_ACTION || 'inspect';
  const wait = async predicate => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(`验收等待超时:${action}:${updater.getStatus().lastError?.message ?? ''}`);
  };
  const evaluate = script => window.webContents.executeJavaScript(script);
  const health = () => evaluate("fetch('/api/v1/health').then(r=>r.json()).then(j=>j.data)");
  await wait(async () => { const text = await evaluate('document.body.innerText'); return text.length > 40 && !text.includes('正在检查本机登录状态') && !text.includes('正在读取本机账号'); });
  if (process.env.PRISM_UPDATES_QA_REGISTER === '1') {
    const status = await evaluate("fetch('/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'update_qa',password:'SyntheticUpdate2026!',confirmation:'SyntheticUpdate2026!',remember:true})}).then(r=>r.status)");
    assert.equal(status, 201); await window.webContents.reload();
    await wait(async () => (await evaluate('document.body.innerText')).includes('update_qa'));
  }
  const before = await health();
  let discovered, result;
  if (action !== 'inspect') {
    discovered = await evaluate('window.prismUpdates.check()');
    assert.equal(discovered.phase, 'available', JSON.stringify(discovered.lastError));
    const id = discovered.available.releaseId;
    const downloaded = await evaluate(`window.prismUpdates.download(${JSON.stringify(id)})`);
    assert.equal(downloaded.phase, 'ready');
    const started = await evaluate(`window.prismUpdates.apply(${JSON.stringify(id)})`);
    assert.equal(started.started, true);
    await wait(() => !isApplying());
    result = updater.getStatus();
    if (action === 'rollback') {
      assert.equal(result.phase, 'error');
      assert.equal(selection().identity.businessVersion, before.businessVersion);
      assert.match(result.lastError.code, /APPLY_FAILED/);
    } else {
      assert.equal(selection().identity.businessVersion, discovered.available.productVersion, JSON.stringify(result.lastError));
    }
  }
  const after = await health();
  assert.equal(after.businessVersion, process.env.PRISM_UPDATES_EXPECT_VERSION);
  const login = await evaluate("fetch('/api/v1/auth/me').then(async r=>({status:r.status,username:(await r.json()).data?.user?.username}))");
  assert.equal(login.status, 200); assert.equal(login.username, 'update_qa');
  window.webContents.send('updates:menu');
  await wait(async () => (await evaluate('document.body.innerText')).includes('应用内更新'));
  // 等待设置页的异步运行信息与合成帧，避免只捕获到切换前画面。
  await wait(async () => !(await evaluate('document.body.innerText')).includes('读取中…'));
  await new Promise(resolve => setTimeout(resolve, 500));
  const text = await evaluate('document.body.innerText');
  const url = await evaluate('location.origin');
  const blocked = await fetch(`${url}/api/v1/health`).then(r => r.status);
  assert.equal(blocked, 403);
  const rendererNode = await evaluate("typeof process !== 'undefined'"); assert.equal(rendererNode, false);
  if (process.env.PRISM_DESKTOP_SCREENSHOT) writeFileSync(process.env.PRISM_DESKTOP_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
  writeFileSync(output, JSON.stringify({ pass: true, action, executable: process.execPath, before, after, login, blocked, rendererNode, status: updater.getStatus(), text: text.slice(-1600) }, null, 2) + '\n');
  app.quit();
};
