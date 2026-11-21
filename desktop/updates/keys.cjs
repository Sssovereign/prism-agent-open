// 更新签名：Ed25519（node:crypto 内置），覆盖 manifest.json 原始 UTF-8 字节。
// 私钥只在 Git 之外的受限目录；客户端安装包只带公钥与 keyId。
'use strict';
const { generateKeyPairSync, sign: cryptoSign, verify: cryptoVerify, createHash } = require('node:crypto');
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');

/** 生成 Ed25519 密钥对，返回 PEM。调用方负责以 0600 落盘与备份。 */
function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** 公钥指纹（短 keyId 建议）：SHA256 前 16 hex。 */
function publicKeyId(publicKeyPem) {
  return 'sha256-' + createHash('sha256').update(String(publicKeyPem), 'utf8').digest('hex').slice(0, 16);
}

/** 对原始字节签名，返回 base64。 */
function signBytes(privateKeyPem, data) {
  return cryptoSign(null, data, privateKeyPem).toString('base64');
}

/** 常量时间验签；任何异常按失败处理。 */
function verifyBytes(publicKeyPem, data, signatureBase64) {
  try {
    const signature = Buffer.from(String(signatureBase64), 'base64');
    if (signature.length === 0) return false;
    return cryptoVerify(null, data, publicKeyPem, signature);
  } catch {
    return false;
  }
}

function saveKeyPair(outDir, keyId) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (['updates-private.pem','updates-public.pem','updates-key.json'].some(name=>existsSync(outDir+'/'+name))) throw new Error('UPDATE_SIGNING_KEY_ALREADY_EXISTS');
  const { publicKeyPem, privateKeyPem } = generateKeyPair();
  writeFileSync(outDir + '/updates-private.pem', privateKeyPem, { mode: 0o600, flag: 'wx' });
  writeFileSync(outDir + '/updates-public.pem', publicKeyPem, { mode: 0o644, flag: 'wx' });
  writeFileSync(outDir + '/updates-key.json', JSON.stringify({ keyId, publicKeyId: publicKeyId(publicKeyPem), createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  return { publicKeyPem, privateKeyPem, keyId, publicKeyId: publicKeyId(publicKeyPem) };
}

function loadPrivateKey(file) {
  return readFileSync(file, 'utf8');
}

module.exports = { generateKeyPair, publicKeyId, signBytes, verifyBytes, saveKeyPair, loadPrivateKey };
