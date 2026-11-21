// 资源包容器回归：写入→解包往返一致；路径穿越/盘符/ADS/设备名/链接类型/压缩炸弹全部拒绝。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync, statSync } = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');
const { createTarGz, extractTarGz, readTarGzFile, safePackPath, DEFAULT_CAPS } = require('./tar.cjs');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');

function tempDir() {
  return mkdtempSync(join(os.tmpdir(), 'prism-tar-'));
}

test('tar：写入与解包往返一致，文件摘要与清单吻合', async () => {
  const root = tempDir();
  try {
    const data = Buffer.from('console.log("业务代码");\n'.repeat(100));
    const archive = createTarGz([
      { path: 'dist', type: 'dir' },
      { path: 'dist/src', type: 'dir' },
      { path: 'dist/src/app.js', type: 'file', data },
      { path: 'desktop/backend.mjs', type: 'file', data: Buffer.from('export {};\n') },
      { path: 'package.json', type: 'file', data: Buffer.from('{"version":"0.0.6-beta"}\n') },
    ]);
    const extracted = extractTarGz(gunzipSync(archive), root, DEFAULT_CAPS);
    assert.equal(extracted.files.length, 3);
    const app = extracted.files.find(file => file.path === 'dist/src/app.js');
    assert.equal(app.sha256, createHash('sha256').update(data).digest('hex'));
    assert.equal(statSync(join(root, 'dist/src/app.js')).size, data.length);
    // 目录也已建立
    assert.ok(statSync(join(root, 'dist/src')).isDirectory());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tar：路径安全规则逐项拒绝', () => {
  for (const bad of ['/etc/passwd', '../escape', 'a/../../escape', 'C:/win', 'C:\\win', 'stream:ads', '//unc/share/x',
    'CON', 'aux.txt', 'NUL.png', 'com1.log', 'lpt9.ini', 'a//b']) {
    assert.throws(() => safePackPath(bad), undefined, `应拒绝：${bad}`);
  }
  for (const good of ['dist/src/app.js', 'web-dist/index.html', 'resources/icons/app.png', 'desktop/backend.mjs']) {
    assert.equal(safePackPath(good), good);
  }
});

test('tar：链接、设备与pax扩展头一律拒绝（不产不收）', () => {
  const header = typeflag => {
    const block = Buffer.alloc(512);
    block.write('evil/target', 0, 100, 'utf8');
    block.write('0', 124, 12, 'utf8'); // size=0 的占位（校验和计算前重写）
    block.write('0000000', 124, 7, 'utf8');
    block.write(typeflag, 156, 1, 'utf8');
    block.write('ustar\0', 257, 6, 'utf8');
    block.write('00', 263, 2, 'utf8');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    return block;
  };
  const archive = Buffer.concat([header('2'), Buffer.alloc(1024)]); // 符号链接 + 结束零块
  const root = tempDir();
  try {
    assert.throws(() => extractTarGz(archive, root, DEFAULT_CAPS), /TAR_TYPEFLAG_REJECTED/); // 此处为原始tar缓冲
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tar：截断归档与超限拒绝', async () => {
  const archive = gunzipSync(createTarGz([{ path: 'a.txt', type: 'file', data: Buffer.alloc(4096, 7) }])); // 原始tar
  const root = tempDir();
  try {
    assert.throws(() => extractTarGz(archive.subarray(0, 600), root, DEFAULT_CAPS), /TAR_(TRUNCATED|CHECKSUM_INVALID|MAGIC_INVALID)/);
    const caps = { ...DEFAULT_CAPS, maxTotalBytes: 10 };
    assert.throws(() => extractTarGz(archive, root, caps), /TAR_TOTAL_TOO_LARGE/);
    assert.throws(() => createTarGz([{ path: `f${'x'.repeat(200)}.txt`, type: 'file', data: Buffer.alloc(1) }]), /TAR_NAME_TOO_LONG/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tar：readTarGzFile 流式解压可还原', async () => {
  const root = tempDir();
  const packFile = join(root, 'pack.tar.gz');
  try {
    const archive = createTarGz([{ path: 'x.txt', type: 'file', data: Buffer.from('hello pack') }]);
    writeFileSync(packFile, archive);
    const buffer = await readTarGzFile(packFile, DEFAULT_CAPS);
    const out = tempDir();
    try {
      const extracted = extractTarGz(buffer, out, DEFAULT_CAPS);
      assert.equal(extracted.files[0].path, 'x.txt');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
