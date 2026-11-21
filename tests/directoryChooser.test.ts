import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, win32 } from 'node:path';
import { IpcDirectoryChooser, connectDesktopDirectoryChooser } from '../src/files/directoryChooser.js';
import { canonicalDirectory, normalizeRelative } from '../src/files/paths.js';
import { Db } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { LocalProjectPicker } from '../src/projects/localPicker.js';
import { startPicker, getTicket, claimGrant, cancelPicker, closeFilePickers } from '../src/files/picker.js';

class Channel extends EventEmitter {
  connected = true;
  sent: any[] = [];
  send(message: unknown, cb?: (error: Error | null) => void): void { this.sent.push(message); cb?.(null); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
test('directory IPC correlates requests, canonicalizes Chinese paths, ignores duplicates and late results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'picker-'));
  const chosen = join(dir, '中文 工作目录 '); mkdirSync(chosen);
  const channel = new Channel(), chooser = new IpcDirectoryChooser(channel, true);
  try {
    const id = randomUUID(), abort = new AbortController();
    let settled = false;
    const result = chooser.choose(id, Date.now() + 1000, 'project', abort.signal).then(r => { settled = true; return r; });
    channel.emit('message', { type: 'directory-picker:result', requestId: randomUUID(), state: 'selected', path: chosen });
    await tick(); assert.equal(settled, false);
    channel.emit('message', { type: 'directory-picker:result', requestId: id, state: 'selected', path: chosen });
    assert.deepEqual(await result, { state: 'selected', path: realpathSync(chosen) });
    channel.emit('message', { type: 'directory-picker:result', requestId: id, state: 'failed' });
    const next = randomUUID(), controller = new AbortController();
    const cancelled = chooser.choose(next, Date.now() + 1000, 'grant', controller.signal);
    controller.abort();
    channel.emit('message', { type: 'directory-picker:result', requestId: next, state: 'selected', path: chosen });
    assert.deepEqual(await cancelled, { state: 'cancelled' });
    assert.ok(channel.sent.some(m => m.type === 'directory-picker:cancel' && m.requestId === next));
  } finally { chooser.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('directory IPC expires, fails closed on disconnect/invalid paths and requires capability', async () => {
  const channel = new Channel(), chooser = new IpcDirectoryChooser(channel, true);
  try {
    const expired = chooser.choose(randomUUID(), Date.now() + 5, 'grant', new AbortController().signal);
    await tick(); assert.deepEqual(await expired, { state: 'expired' });
    const id = randomUUID(), invalid = chooser.choose(id, Date.now() + 1000, 'grant', new AbortController().signal);
    channel.emit('message', { type: 'directory-picker:result', requestId: id, state: 'selected', path: 'relative' });
    assert.deepEqual(await invalid, { state: 'failed' });
    const disconnected = chooser.choose(randomUUID(), Date.now() + 1000, 'project', new AbortController().signal);
    channel.emit('disconnect'); channel.connected = false; assert.deepEqual(await disconnected, { state: 'failed' });
    assert.throws(() => chooser.assertAvailable(), /重启棱镜/);
  } finally { chooser.close(); }
  // 握手失败不再硬禁用：通道仍连时 tolerate，等点击期补偿握手；通道关闭后才明确报错
  const old = await connectDesktopDirectoryChooser(new Channel(), 5);
  old.assertAvailable(); old.close();
  assert.throws(() => old.assertAvailable(), /重启棱镜/);
  const modern = new Channel();
  const connecting = connectDesktopDirectoryChooser(modern, 100);
  modern.emit('message', { type: 'directory-picker:capability', requestId: modern.sent[0].requestId, version: 1 });
  const supported = await connecting; supported.assertAvailable(); supported.close();
});
test('desktop handshake recovers from busy host: hello retry, unsolicited announce and click-time re-handshake', async () => {
  // (a) 主进程繁忙漏答首个hello：重发后应答
  class LazyChannel extends Channel {
    hellos = 0;
    send(message: any, cb?: (error: Error | null) => void): void {
      this.sent.push(message); cb?.(null);
      if (message.type === 'directory-picker:hello' && ++this.hellos >= 2) setImmediate(() => this.emit('message', { type: 'directory-picker:capability', requestId: message.requestId, version: 1 }));
    }
  }
  const retried = await connectDesktopDirectoryChooser(new LazyChannel(), 2000);
  retried.assertAvailable(); retried.close();
  // (b) 宿主不经hello主动公告（无requestId）：直接接受
  class AnnouncingChannel extends Channel {
    send(message: any, cb?: (error: Error | null) => void): void {
      this.sent.push(message); cb?.(null);
      if (message.type === 'directory-picker:hello') setImmediate(() => this.emit('message', { type: 'directory-picker:capability', version: 1 }));
    }
  }
  const announced = await connectDesktopDirectoryChooser(new AnnouncingChannel(), 2000);
  announced.assertAvailable(); announced.close();
  // (c) 启动期握手版本不符失败，点击期补偿握手恢复后正常完成选择
  const dir = mkdtempSync(join(tmpdir(), 'picker-recover-'));
  try {
    class WrongVersionChannel extends Channel {
      hellos = 0;
      send(message: any, cb?: (error: Error | null) => void): void {
        this.sent.push(message); cb?.(null);
        if (message.type === 'directory-picker:hello') { const first = ++this.hellos === 1; setImmediate(() => this.emit('message', { type: 'directory-picker:capability', requestId: message.requestId, version: first ? 2 : 1 })); }
      }
    }
    const channel = new WrongVersionChannel();
    const chooser = await connectDesktopDirectoryChooser(channel, 30);
    const id = randomUUID();
    const result = chooser.choose(id, Date.now() + 3000, 'project', new AbortController().signal);
    // 补偿握手完成后open才发出；等open再应答，模拟真实宿主时序
    await new Promise(resolve => { const i = setInterval(() => { if (channel.sent.some(m => m.type === 'directory-picker:open' && m.requestId === id)) { clearInterval(i); resolve(null); } }, 10); });
    channel.emit('message', { type: 'directory-picker:result', requestId: id, state: 'selected', path: dir });
    assert.deepEqual(await result, { state: 'selected', path: realpathSync(dir) });
    chooser.close();
    // (d) 通道已死：点击即明确报错，不再提示重装
    const dead = new IpcDirectoryChooser(new Channel(), false);
    dead.close();
    await assert.rejects(dead.choose(randomUUID(), Date.now() + 1000, 'grant', new AbortController().signal), /重启棱镜/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('path validation preserves platform root; rejects files, relative, drive-relative and UNC client paths', () => {
  assert.equal(canonicalDirectory(parse(process.cwd()).root), realpathSync(parse(process.cwd()).root));
  const dir = mkdtempSync(join(tmpdir(), 'picker-file-'));
  try { const file = join(dir, '文件'); writeFileSync(file, 'x'); assert.throws(() => canonicalDirectory(file)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  for (const value of ['relative', '', '\0']) assert.throws(() => canonicalDirectory(value));
  for (const value of ['C:\\', 'C:relative', '\\\\server\\中文共享', '\\rooted', 'a/../b', 'file:stream']) assert.throws(() => normalizeRelative(value));
  assert.equal(win32.isAbsolute('C:\\'), true);
  assert.equal(win32.isAbsolute('\\\\server\\中文共享\\目录'), true);
  assert.equal(win32.normalize('C:\\'), 'C:\\');
});

test('both ticket flows reject late completion, cancel safely and expire selected grants before claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'picker-tickets-'));
  const db = new Db(join(dir, 'test.sqlite')); migrate(db);
  const user = randomUUID(), project = randomUUID(), now = new Date().toISOString();
  db.db.prepare("INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)").run(user, 'picker', 'x', 'x', '{}', now, now);
  db.db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(project, user, 'picker', now, now);
  const channel = new Channel(), chooser = new IpcDirectoryChooser(channel, true), local = new LocalProjectPicker(db, chooser);
  const selected = (id: string) => channel.emit('message', { type: 'directory-picker:result', requestId: id, state: 'selected', path: dir });
  try {
    const a = local.start(user); assert.equal(local.cancel(a.id, user, 'wrong'), false);
    assert.equal(local.cancel(a.id, user, a.nonce), true); selected(a.id); await tick();
    assert.equal(local.get(a.id, user)?.state, 'cancelled');
    const b = local.start(user);
    db.db.prepare("UPDATE project_directory_pickers SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(b.id);
    selected(b.id); await tick(); assert.equal(local.get(b.id, user)?.state, 'expired');
    const c = startPicker(db, user, project, chooser); selected(c.ticketId); await tick();
    assert.equal(getTicket(db, c.ticketId, user)?.state, 'selected');
    db.db.prepare("UPDATE picker_tickets SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(c.ticketId);
    assert.equal(claimGrant(db, { ticketId: c.ticketId, nonce: c.nonce, userId: user, projectId: project, access: 'read' }), undefined);
    assert.equal(getTicket(db, c.ticketId, user)?.selected_path, null);
    const d = startPicker(db, user, project, chooser); assert.equal(cancelPicker(db, d.ticketId, user, d.nonce), true);
    selected(d.ticketId); await tick(); assert.equal(getTicket(db, d.ticketId, user)?.state, 'cancelled');
    const good = startPicker(db, user, project, chooser); selected(good.ticketId); await tick();
    const claim = { ticketId: good.ticketId, nonce: good.nonce, userId: user, projectId: project, access: 'read' as const };
    assert.equal(claimGrant(db, claim)?.canonical_root, realpathSync(dir));
    assert.equal(claimGrant(db, claim), undefined);
    const pending = startPicker(db, user, project, chooser); closeFilePickers(db); selected(pending.ticketId); await tick();
    assert.equal(getTicket(db, pending.ticketId, user)?.state, 'cancelled');
  } finally { local.close(); closeFilePickers(db); chooser.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
