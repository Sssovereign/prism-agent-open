// 完整安装包验证后，显式登记下一轮业务更新可复用的宿主基线。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHostBaseline } = require('./host-gate.cjs');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const input = arg('--host-build-info');
const output = arg('--out');
if (!input || !output) throw new Error('用法：record-host-baseline.mjs --host-build-info <已验证宿主desktop/build-info.json> --out <基线.json>');
const baseline = createHostBaseline(resolve(input));
writeFileSync(resolve(output), JSON.stringify(baseline, null, 2) + '\n');
console.log(`已登记兼容基线 ${JSON.parse(readFileSync(resolve(output), 'utf8')).hostVersion}：${resolve(output)}`);
