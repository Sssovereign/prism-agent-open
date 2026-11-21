// 更新签名密钥生成：Ed25519，私钥落在 Git 之外的受限目录（默认 ~/.local/share/prism-agent/updates-keys）。
// 用法：node scripts/release/update-keys.mjs generate --out <目录> --key-id <标识>
// 备份约定：updates-private.pem 以 0600 保存，用户应复制到离线安全存储；恢复时放回原路径即可。
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const command = args[0];
if (command !== 'generate') {
  console.error('用法：update-keys.mjs generate --out <目录> --key-id <标识>');
  process.exit(2);
}
const outIndex = args.indexOf('--out');
const keyIndex = args.indexOf('--key-id');
const out = outIndex >= 0 ? resolve(args[outIndex + 1]) : join(homedir(), '.local/share/prism-agent/updates-keys');
const keyId = keyIndex >= 0 ? String(args[keyIndex + 1]) : 'prism-updates-beta';
if (!/^[\w.-]{1,64}$/.test(keyId)) throw new Error(`keyId 不合法：${keyId}`);

const { saveKeyPair, publicKeyId } = require('../../desktop/updates/keys.cjs');
mkdirSync(out, { recursive: true, mode: 0o700 });
const { publicKeyPem, publicKeyId: fingerprint } = saveKeyPair(out, keyId);
console.log(`已生成更新签名密钥对（Ed25519）：${out}`);
console.log(`keyId：${keyId}`);
console.log(`公钥指纹：${fingerprint}`);
console.log('公钥文件：updates-public.pem（植入引导版 build-info）');
console.log('私钥文件：updates-private.pem（0600，绝不入库/入日志/入安装包）');
console.log('备份：把 updates-private.pem 复制到离线安全存储；恢复时放回原路径。');
console.log('---公钥内容---');
console.log(publicKeyPem.trim());
