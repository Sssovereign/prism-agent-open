// 交互式创建账号：TTY读取用户名与密码（隐藏回显），scrypt散列入库。
// 密码不写命令行参数、不写日志；重复用户名直接拒绝。
// 统一用raw/cooked两种行读取，不混用readline，避免流控制冲突。
import { stdin, stdout } from 'node:process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const CODE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataDir = process.env.DEBATE_DATA_DIR ?? join(CODE_ROOT, '.data');

// 复用产品编译产物中的存储与散列模块
const { Db, defaultDbPath } = await import('file://' + join(CODE_ROOT, 'dist/src/storage/db.js'));
const { archiveLegacyMock } = await import('file://' + join(CODE_ROOT, 'dist/src/storage/legacy.js'));
const { migrate, defaultMigrationsDir } = await import('file://' + join(CODE_ROOT, 'dist/src/storage/migrate.js'));
const { hashPassword } = await import('file://' + join(CODE_ROOT, 'dist/src/auth/passwords.js'));
const { newPasswordError } = await import('file://' + join(CODE_ROOT, 'dist/contracts/password.js'));

// 持久行读取器：跨请求保留未消费的输入（管道/pty可能一次送达多行）。
let pending = '';
let active = null; // { hidden, resolve }

function feed(ch) {
  if (ch === '\r' || ch === '\n') {
    if (active?.hidden) { stdin.setRawMode?.(false); stdout.write('\n'); }
    const value = pending;
    pending = '';
    const { resolve } = active;
    active = null;
    resolve(value);
    return;
  }
  if (active?.hidden && ch === '\u0003') { // Ctrl+C（cooked模式由驱动发SIGINT）
    stdout.write('\n'); process.exit(130);
  }
  if (ch === '\u007f' || ch === '\b') {
    pending = pending.slice(0, -1);
    return;
  }
  pending += ch;
}

stdin.on('data', (chunk) => {
  for (const ch of String(chunk)) {
    if (active) feed(ch);
    else pending += ch; // 尚无提问在等待：先缓存
  }
});

function ask(question, { hidden = false } = {}) {
  return new Promise((resolveAsk) => {
    stdout.write(question);
    active = { hidden, resolve: resolveAsk };
    if (hidden && stdin.isTTY) stdin.setRawMode(true);
    if (pending) { const buffered = pending; pending = ''; for (const ch of buffered) feed(ch); }
  });
}

const username = (await ask('用户名（2—32位，字母/数字/下划线/连字符）：')).trim().toLowerCase();
if (!/^[a-z0-9_-]{2,32}$/.test(username)) {
  console.error('用户名不符合规则');
  process.exit(1);
}
const password = await ask('密码（不含汉字，输入不回显）：', { hidden: true });
const passwordError = newPasswordError(password);
if (passwordError) {
  console.error(passwordError);
  process.exit(1);
}
const again = await ask('再次输入密码确认：', { hidden: true });
if (again !== password) {
  console.error('两次输入不一致');
  process.exit(1);
}

const db = new Db(defaultDbPath(dataDir));
try {
  archiveLegacyMock(db);
  migrate(db, defaultMigrationsDir());
  const exists = db.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) {
    console.error(`用户名已存在：${username}`);
    process.exit(1);
  }
  const record = await hashPassword(password);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.tx(tx => tx.prepare(
    'INSERT INTO users(id, username, password_hash, password_salt, password_params_json, disabled, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)'
  ).run(id, username, record.hash, record.salt, record.paramsJson, now, now));
  console.log(`已创建账号 ${username}（${id}），数据目录：${dataDir}`);
} finally { db.close(); }
