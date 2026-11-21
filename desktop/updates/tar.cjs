// 业务资源包容器：确定性 ustar（tar.gz）写入与严格安全解包。
// 写入与解包是同一格式的两端，均不依赖系统 tar：写入只产 ustar 常规文件／目录，
// 解包拒绝绝对路径、盘符、UNC／ADS、设备名、软／硬链接、pax 头与路径逃逸，
// 并以文件数与解压总量上限抵御压缩炸弹。上限以实际资源包核对后固定，不静默放宽。
'use strict';
const { createGunzip, gzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync, readFileSync, statSync } = require('node:fs');
const { join, resolve, sep } = require('node:path');

const BLOCK = 512;
const DEFAULT_CAPS = { maxFiles: 20000, maxTotalBytes: 256 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024 };

// —— 路径安全 —— //

const WINDOWS_DEVICE_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

/** 校验包内相对路径：只接受受限的 POSIX 风格相对路径，返回标准化 posix 字符串。 */
function safePackPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 512) throw new Error(`TAR_PATH_INVALID:${rawPath}`);
  if (rawPath.includes('\0')) throw new Error('TAR_PATH_NUL');
  const posix = rawPath.replaceAll('\\', '/');
  if (/^[A-Za-z]:/.test(posix)) throw new Error(`TAR_PATH_DRIVE:${rawPath}`);
  if (posix.startsWith('/') || posix.startsWith('//')) throw new Error(`TAR_PATH_ABSOLUTE:${rawPath}`);
  if (posix.includes(':')) throw new Error(`TAR_PATH_COLON:${rawPath}`); // ADS / 备用流一并拒绝
  const segments = posix.split('/');
  if (segments.some(s => s.length === 0)) throw new Error(`TAR_PATH_EMPTY_SEGMENT:${rawPath}`);
  if (segments.some(s => s === '.' || s === '..')) throw new Error(`TAR_PATH_DOT:${rawPath}`);
  for (const segment of segments) {
    if (/[. ]$/.test(segment)) throw new Error(`TAR_PATH_ALIAS:${rawPath}`);
    const stem = segment.split('.')[0];
    if (WINDOWS_DEVICE_NAMES.has(segment.toUpperCase()) || WINDOWS_DEVICE_NAMES.has(stem.toUpperCase())) {
      throw new Error(`TAR_PATH_DEVICE:${rawPath}`);
    }
  }
  return posix;
}

/** 解包目标校验：join 后必须仍落在目标目录内。 */
function resolveUnder(destDir, posixPath) {
  const target = resolve(destDir, ...posixPath.split('/'));
  const root = resolve(destDir);
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`TAR_PATH_ESCAPE:${posixPath}`);
  return target;
}

// —— ustar 头部 —— //

function writeOctal(value, length) {
  // 标准 ustar：NUL 结尾八进制；size 用 11 位数字 + NUL，其余用 7 位 + NUL
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function tarHeader({ name, typeflag, size }) {
  if (Buffer.byteLength(name, 'utf8') > 100) throw new Error(`TAR_NAME_TOO_LONG:${name}`);
  const buffer = Buffer.alloc(BLOCK);
  buffer.write(name, 0, 100, 'utf8');
  buffer.write(writeOctal(typeflag === '5' ? 0o755 : 0o644, 8), 100, 8, 'utf8');
  buffer.write(writeOctal(0, 8), 108, 8, 'utf8'); // uid
  buffer.write(writeOctal(0, 8), 116, 8, 'utf8'); // gid
  buffer.write(writeOctal(typeflag === '5' ? 0 : size, 12), 124, 12, 'utf8');
  buffer.write(writeOctal(0, 12), 136, 12, 'utf8'); // mtime：确定性打包固定 0
  buffer.write('        ', 148, 8, 'utf8'); // chksum 占位空格
  buffer.write(typeflag, 156, 1, 'utf8');
  buffer.write('ustar\0', 257, 6, 'utf8');
  buffer.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const byte of buffer) sum += byte;
  buffer.write(writeOctal(sum, 8), 148, 8, 'utf8'); // chksum：八进制 + NUL + 填充（旧式，兼容自读）
  return buffer;
}

/** 打包条目为 ustar + gzip 单缓冲。entries 顺序即写入顺序；调用方先排序与去重。 */
function createTarGz(entries, caps = DEFAULT_CAPS) {
  if (entries.length > caps.maxFiles) throw new Error(`TAR_TOO_MANY_ENTRIES:${entries.length}`);
  const chunks = [];
  let total = 0;
  for (const entry of entries) {
    const name = safePackPath(entry.path);
    const typeflag = entry.type === 'dir' ? '5' : '0';
    let data = null;
    if (typeflag === '0') {
      data = entry.data;
      if (!Buffer.isBuffer(data)) throw new Error(`TAR_DATA_MISSING:${entry.path}`);
      if (data.length > caps.maxFileBytes) throw new Error(`TAR_FILE_TOO_LARGE:${entry.path}`);
      total += data.length;
    }
    chunks.push(tarHeader({ name, typeflag, size: data?.length ?? 0 }));
    if (data) {
      chunks.push(data);
      const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // 结束零块
  if (total > caps.maxTotalBytes) throw new Error(`TAR_TOTAL_TOO_LARGE:${total}`);
  return gzipSync(Buffer.concat(chunks));
}

// —— 解包 —— //

function parseOctal(text) {
  if (typeof text !== 'string' || text.length === 0) throw new Error('TAR_OCTAL_INVALID');
  const trimmed = text.replace(/\0/g, '').trim();
  if (!/^[0-7]*$/.test(trimmed)) throw new Error(`TAR_OCTAL_INVALID:${JSON.stringify(text)}`);
  return trimmed.length ? parseInt(trimmed, 8) : 0;
}

function verifyHeaderChecksum(header) {
  const stored = parseOctal(header.toString('utf8', 148, 156));
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum === stored;
}

function readHeaderName(header) {
  const name = header.toString('utf8', 0, 100).replace(/\0+$/, '');
  const prefix = header.toString('utf8', 345, 155).replace(/\0+$/, '');
  return prefix ? `${prefix}/${name}` : name;
}

/**
 * 从 tar.gz 缓冲解包到 destDir。逐条目执行路径与上限校验；
 * 任一违规即整体抛错，调用方丢弃整个目标目录（半包不可用）。
 * 返回 {files:[{path,size,sha256}], totalBytes}。
 */
function extractTarGz(archive, destDir, caps = DEFAULT_CAPS) {
  const extracted = [];
  let offset = 0;
  let fileCount = 0;
  let totalBytes = 0;
  const at = length => {
    if (offset + length > archive.length) throw new Error('TAR_TRUNCATED');
    return archive.subarray(offset, offset + length);
  };
  while (true) {
    const header = at(BLOCK);
    offset += BLOCK;
    if (header.every(b => b === 0)) break; // 结束零块
    if (header.toString('utf8', 257, 263) !== 'ustar\0') throw new Error('TAR_MAGIC_INVALID');
    if (!verifyHeaderChecksum(header)) throw new Error('TAR_CHECKSUM_INVALID');
    const typeflag = header.toString('utf8', 156, 157);
    const size = parseOctal(header.toString('utf8', 124, 136));
    const rawName = readHeaderName(header);
    if (typeflag === '0') {
      const posix = safePackPath(rawName);
      const data = at(size);
      offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);
      if (size > caps.maxFileBytes) throw new Error(`TAR_FILE_TOO_LARGE:${rawName}`);
      totalBytes += size;
      if (totalBytes > caps.maxTotalBytes) throw new Error('TAR_TOTAL_TOO_LARGE');
      fileCount += 1;
      if (fileCount > caps.maxFiles) throw new Error('TAR_TOO_MANY_ENTRIES');
      const target = resolveUnder(destDir, posix);
      mkdirSync(resolve(destDir), { recursive: true });
      mkdirSync(target.slice(0, target.lastIndexOf(sep)) || destDir, { recursive: true });
      writeFileSync(target, data, { mode: 0o644 });
      extracted.push({ path: posix, size, sha256: createHash('sha256').update(data).digest('hex') });
    } else if (typeflag === '5') {
      safePackPath(rawName);
      fileCount += 1;
      if (fileCount > caps.maxFiles) throw new Error('TAR_TOO_MANY_ENTRIES');
      const target = resolveUnder(destDir, rawName.replaceAll('\\', '/'));
      mkdirSync(target, { recursive: true, mode: 0o755 });
    } else {
      // 软／硬链接、设备、pax 扩展头等一律不产不收
      throw new Error(`TAR_TYPEFLAG_REJECTED:${JSON.stringify(typeflag)}:${rawName}`);
    }
  }
  return { files: extracted, totalBytes };
}

/** 流式解压 .tar.gz 文件到缓冲，解压总量超限即中止（压缩炸弹防线）。 */
async function readTarGzFile(archivePath, caps = DEFAULT_CAPS) {
  const { createReadStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const chunks = [];
  let total = 0;
  const gunzip = createGunzip();
  gunzip.on('data', chunk => {
    total += chunk.length;
    if (total > caps.maxTotalBytes) gunzip.destroy(new Error('TAR_TOTAL_TOO_LARGE'));
    else chunks.push(chunk);
  });
  const source = createReadStream(archivePath);
  const sourceStat = statSync(archivePath);
  if (sourceStat.size > caps.maxTotalBytes) throw new Error('TAR_ARCHIVE_TOO_LARGE');
  await pipeline(source, gunzip);
  return Buffer.concat(chunks);
}

module.exports = { safePackPath, resolveUnder, createTarGz, extractTarGz, readTarGzFile, DEFAULT_CAPS };
