'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { realpathSync } = require('node:fs');
const { attachDirectoryPicker } = require('./directory-picker.cjs');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
class Child extends EventEmitter { connected = true; sent = []; send(m, cb) { this.sent.push(m); cb?.(); } }
function setup() {
  const child = new Child(); let resolveDialog; let calls = 0;
  const host = attachDirectoryPicker(child, { dialog: { showOpenDialog: (_parent, options) => { calls++; assert.deepEqual(options.properties, ['openDirectory']); return new Promise(resolve => { resolveDialog = resolve; }); } }, getWindow: () => ({ isDestroyed: () => false }) });
  const announce = child.sent.find(m => m.type === 'directory-picker:capability' && m.requestId === undefined);
  child.sent.length = 0; // 公告属启动期外发，各用例只断言请求驱动的消息
  return { child, host, announce, resolve: value => resolveDialog(value), calls: () => calls };
}
const open = (child, requestId, duration = 1000) => child.emit('message', { type: 'directory-picker:open', requestId, expiresAt: Date.now() + duration, purpose: 'project' });
test('native directory host capability, request correlation, one selection and replay protection', async () => {
  const e = setup();
  try {
    assert.deepEqual(e.announce, { type: 'directory-picker:capability', version: 1 });
    const requestId = randomUUID();
    e.child.emit('message', { type: 'directory-picker:hello', requestId });
    assert.deepEqual(e.child.sent.pop(), { type: 'directory-picker:capability', requestId, version: 1 });
    open(e.child, requestId); await tick();
    e.resolve({ canceled: false, filePaths: [process.cwd()] }); await tick();
    assert.deepEqual(e.child.sent.pop(), { type: 'directory-picker:result', requestId, state: 'selected', path: realpathSync(process.cwd()) });
    open(e.child, requestId); await tick(); assert.equal(e.calls(), 1);
  } finally { e.host.close(); }
});
test('native directory host discards cancelled/expired late selection and rejects malformed output', async () => {
  const e = setup();
  try {
    const id = randomUUID(); open(e.child, id); await tick();
    e.child.emit('message', { type: 'directory-picker:cancel', requestId: randomUUID() });
    assert.equal(e.child.sent.length, 0);
    e.child.emit('message', { type: 'directory-picker:cancel', requestId: id });
    assert.equal(e.child.sent.at(-1).state, 'cancelled');
    open(e.child, randomUUID()); await tick(); assert.equal(e.calls(), 1, 'cancelled OS dialog still occupies slot');
    e.resolve({ canceled: false, filePaths: [process.cwd()] }); await tick();
    assert.ok(e.child.sent.every(m => m.state !== 'selected'));
    const timed = randomUUID(); open(e.child, timed, 5); await tick();
    assert.equal(e.child.sent.at(-1).state, 'expired');
    e.resolve({ canceled: false, filePaths: [process.cwd()] }); await tick();
    const bad = randomUUID(); open(e.child, bad); await tick();
    e.resolve({ canceled: false, filePaths: ['relative'] }); await tick();
    assert.equal(e.child.sent.at(-1).state, 'failed');
  } finally { e.host.close(); }
});
test('native directory host disconnect clears callbacks and ignores outstanding native result', async () => {
  const e = setup(); open(e.child, randomUUID()); await tick();
  e.child.connected = false; e.child.emit('disconnect');
  e.resolve({ canceled: false, filePaths: [process.cwd()] }); await tick();
  assert.equal(e.child.sent.length, 0); assert.equal(e.child.listenerCount('message'), 0);
});

test('preload platform bridge is data-only and frozen without exposing Node process', () => {
  const { runInNewContext } = require('node:vm');
  const { readFileSync } = require('node:fs');
  const exposed = {};
  runInNewContext(readFileSync(require('node:path').join(__dirname, 'preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } }, ipcRenderer: {} }; },
    process: { platform: 'win32' },
  });
  assert.deepEqual(Object.keys(exposed.prismPlatform), ['platform', 'integratedTitlebar']);
  assert.equal(exposed.prismPlatform.platform, 'win32');
  assert.equal(exposed.prismPlatform.integratedTitlebar, true);
  assert.equal(Object.isFrozen(exposed.prismPlatform), true);
});
