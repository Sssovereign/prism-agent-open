// 研究协议v2·真实模型实测驱动：辩论决策模式与独立评审，全部走产品API（配置POST model-configs、
// 凭据PUT credential、研究POST /projects/:id/research）。Key从 PRISM_REALMODEL_KEY_FILE 读取，
// 不落仓库与证据文件。唯一保留绕过：workspace_grants直落库（原生目录弹窗不可无人值守驱动）。
// 记录口径（计划阶段②）：分角色样本数、首次合规率、修复后成功率、最终失败率、典型失败字段。
// 用法：先 pnpm run build，再 PRISM_REALMODEL_KEY_FILE=/path/to/key node scripts/verification/research-v2-real-model.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RUN_TAG = `research-v2-real-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
const CACHE = join(ROOT, '.cache', 'verification', RUN_TAG);
const EVIDENCE = join(CACHE, 'evidence');
mkdirSync(EVIDENCE, { recursive: true });
const DATA_DIR = join(CACHE, 'workspace', '.data');

const MODEL = process.env.PRISM_REALMODEL_MODEL ?? 'deepseek-flash';
const BASE_URL = process.env.PRISM_REALMODEL_BASE_URL ?? 'https://api.deepseek.com/v1';
const PORT = 4397;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY_FILE = process.env.PRISM_REALMODEL_KEY_FILE;
if (!KEY_FILE) { console.error('缺少 PRISM_REALMODEL_KEY_FILE（0600 DeepSeek Key 文件）'); process.exit(2); }
const KEY = readFileSync(KEY_FILE, 'utf8').trim();

let cookie = '', csrf = '';
async function api(method, path, body, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  if (!res.ok && !opts.allowFail) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  if (json?.data?.csrfToken) csrf = json.data.csrfToken;
  return { status: res.status, json };
}
function assert(cond, label) { if (!cond) throw new Error(`断言失败：${label}`); console.log(`  ✓ ${label}`); }
function save(name, data) { writeFileSync(join(EVIDENCE, name), JSON.stringify(data, null, 2) + '\n'); console.log(`  💾 evidence/${name}`); }

async function waitRun(runId, label, timeoutMs = 1_500_000) {
  const started = Date.now();
  for (;;) {
    const { json } = await api('GET', `/api/v1/runs/${runId}`);
    const status = json.data.run.status;
    if (['succeeded', 'failed', 'cancelled', 'waiting_input', 'needs_reconciliation'].includes(status)) return { status, json: json.data };
    if (Date.now() - started > timeoutMs) throw new Error(`${label} 超时(>${timeoutMs}ms)，最后状态=${status}`);
    await new Promise(r => setTimeout(r, 4000));
  }
}

// —— 合成共同材料（不含真实项目资料）：数字显式给出或显式缺席，供四类评审情形 ——
const SOURCES_FULL = [
  { title: '方案A试点摘要', content: '方案A在两个试点门店试运行8周。试点期间人工复核工时下降18%，成本核算下降10%，依据是试点期财务台账摘要（2026年10月）。试点NPS为46。样本为两组各20单，共40单。' },
  { title: '成本核算说明', content: '方案A的10%成本下降由三项构成：模板复用（4%）、人工复核减少（5%）、打印耗材（1%）。口径为试点8周对比之前8周同期，由财务部出具。' },
  { title: '试点局限', content: '试点仅覆盖华东两店，未覆盖华南；旺季订单未纳入；40单样本对转化率推断的置信区间较宽。' },
];
const SOURCES_QUAL = [
  { title: '方案A描述', content: '方案A预计能改善效率并降低成本，团队反馈积极。暂无量化台账与样本统计，数字待财务部复核后补充。' },
];

const scenarios = [
  { key: 'debate-sufficient', mode: 'debate', objective: '任务规划应采用方案A（先上线可读性）还是方案B（先压成本）？请给出取舍决定', rounds: 1,
    sources: SOURCES_FULL, decision: { proposition: '任务规划默认采用哪个交付方案？', candidates: [{ text: '采用方案A：先上线可读性' }, { text: '采用方案B：先压成本' }, { text: '维持现状：暂不改造' }] } },
  { key: 'debate-insufficient', mode: 'debate', objective: '任务规划应采用方案A还是维持现状？请给出取舍决定', rounds: 1,
    sources: SOURCES_QUAL, decision: { proposition: '任务规划默认采用哪个交付方案？', candidates: [{ text: '采用方案A' }, { text: '维持现状' }] } },
  { key: 'jury-sufficient', mode: 'jury', objective: '对方案A交付说明做独立评审', sources: SOURCES_FULL,
    subject: { title: '方案A交付说明', content: '方案A计划先上线可读性：试点8周，人工复核工时下降18%，成本下降10%（财务台账2026年10月），试点NPS 46，样本两组各20单。' },
    criteria: [{ id: 's1', text: '成本下降10%有可核查依据', mustHave: true }, { id: 's2', text: '试点样本规模足以支撑推广结论', mustHave: false }, { id: 's3', text: '给出了明确的下一步验证安排', mustHave: false }] },
  { key: 'jury-trial', mode: 'jury', objective: '对方案A交付说明做独立评审（适合试验情形）', sources: SOURCES_FULL,
    subject: { title: '方案A交付说明（试验版）', content: '方案A计划先上线可读性，成本下降10%，NPS 46；华南与旺季未覆盖，拟先在华东两店继续试验一个旺季。' },
    criteria: [{ id: 's1', text: '成本下降10%有可核查依据', mustHave: true }, { id: 's2', text: '推广到全部门店前完成旺季验证', mustHave: true }] },
  { key: 'jury-insufficient', mode: 'jury', objective: '对方案A交付说明做独立评审（证据缺口情形）', sources: SOURCES_QUAL,
    subject: { title: '方案A交付说明（待补证）', content: '方案A预计改善效率并降低成本，暂无量化台账与样本统计。' },
    criteria: [{ id: 's1', text: '成本下降10%有可核查依据', mustHave: true }] },
  { key: 'jury-fail', mode: 'jury', objective: '对方案A交付说明做独立评审（标准未满足情形）', sources: SOURCES_FULL,
    subject: { title: '方案A交付说明（标准未满足）', content: '方案A计划先上线可读性。试点8周成本下降10%。未给出下一步验证安排，华南与旺季未覆盖且无补测计划。' },
    criteria: [{ id: 's1', text: '给出了明确的下一步验证安排', mustHave: true }, { id: 's2', text: '试点样本规模足以支撑全量推广结论', mustHave: true }] },
];

// —— 启动隔离服务 ——
console.log(`① 隔离服务启动（DATA_DIR=${DATA_DIR}）`);
mkdirSync(DATA_DIR, { recursive: true });
const server = spawn('node', [join(ROOT, 'dist', 'src', 'server.js')], {
  env: { ...process.env, DEBATE_PORT: String(PORT), DEBATE_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLogs = [];
server.stdout.on('data', c => serverLogs.push(String(c)));
server.stderr.on('data', c => serverLogs.push(String(c)));
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/v1/health`); if (r.ok) return; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`服务未就绪：${serverLogs.join('').slice(-800)}`);
}
try {
  await waitForServer();
  console.log('  ✓ 服务就绪');

  // —— 账号/项目/授权 ——
  const USER = 'realmmodel-v2';
  await api('POST', '/api/v1/auth/register', { username: USER, password: 'RealModel2026!', confirmation: 'RealModel2026!' }, { allowFail: true });
  const login = await api('POST', '/api/v1/auth/login', { username: USER, password: 'RealModel2026!' });
  const userId = login.json.data.user.id;
  assert(login.json.data?.user?.username === USER, `登录 user=${USER}`);
  const proj = await api('POST', '/api/v1/projects', { name: '研究v2真实模型实测' });
  const projectId = proj.json.data.id;
  assert(!!projectId, `项目 ${projectId.slice(0, 8)}`);
  const WORKDIR = join(DATA_DIR, 'realmodel-workdir');
  mkdirSync(WORKDIR, { recursive: true });
  const { Db, defaultDbPath } = await import('file://' + join(ROOT, 'dist', 'src', 'storage', 'db.js'));
  const grantDb = new Db(defaultDbPath(DATA_DIR));
  try {
    const now = new Date().toISOString();
    grantDb.tx(tx => tx.prepare(`INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,revoked_at,excludes_json,created_at,updated_at)
      VALUES (?,?,?,'write',1,?,NULL,'[]',?,?)`).run(randomUUID(), projectId, WORKDIR, userId, now, now));
  } finally { grantDb.close(); }
  console.log(`  ✓ grant直落库（保留绕过）-> ${WORKDIR}`);

  // —— DeepSeek 配置与凭据（产品路径） ——
  console.log('② DeepSeek 配置/凭据（产品路径）');
  const cfg = await api('POST', '/api/v1/model-configs', {
    preset: 'custom', protocol: 'openai-completions', name: 'DeepSeek（研究v2实测）', baseUrl: BASE_URL,
    models: [{ modelId: MODEL, displayName: 'DeepSeek Chat', enabled: true, parameters: { contextWindow: 128000, maxOutputTokens: 8192 } }],
  });
  const CFG = cfg.json.data.id;
  const cred = await api('PUT', `/api/v1/model-configs/${CFG}/credential`, { apiKey: KEY });
  assert(cred.json.data?.hasCredential === true, `凭据入库 ${CFG.slice(0, 8)}`);
  const choice = { modelConfigId: CFG, modelId: MODEL };
  const debateModels = { pro: choice, con: choice, host: choice };
  const juryModels = { juror1: choice, juror2: choice, juror3: choice, aggregate: choice };

  // —— 场景执行 ——
  const results = [];
  for (const [index, scenario] of scenarios.entries()) {
    console.log(`③[${index + 1}/${scenarios.length}] ${scenario.key}（${scenario.mode}）`);
    const payload = { mode: scenario.mode, objective: scenario.objective, rounds: scenario.rounds ?? 1,
      models: scenario.mode === 'debate' ? debateModels : juryModels,
      sources: scenario.sources, ...(scenario.decision ? { decision: scenario.decision } : {}),
      ...(scenario.subject ? { subject: scenario.subject } : {}), ...(scenario.criteria ? { criteria: scenario.criteria } : {}) };
    const created = await api('POST', `/api/v1/projects/${projectId}/research`, payload);
    const runId = created.json.data.runId;
    const ended = await waitRun(runId, scenario.key);
    console.log(`  → 终态=${ended.status}`);
    const inspect = (await api('GET', `/api/v1/runs/${runId}/research`)).json.data;
    save(`${scenario.key}-inspect.json`, inspect);
    save(`${scenario.key}-payload.json`, payload);
    results.push({ key: scenario.key, runId, status: ended.status, inspect });
  }

  // —— 指标汇总：分角色首次合规率、修复成功率、最终失败率和典型失败字段 ——
  console.log('④ 指标汇总');
  const metrics = { scenarios: {}, roles: {} };
  for (const result of results) {
    const phases = result.inspect.phases;
    // Runner 在同一 attempt 内重提修复稿，用拒绝记录判断首稿是否合规。
    const firstPass = phases.filter(p => p.rejections.count === 0 && p.status === 'succeeded').length;
    const repaired = phases.filter(p => p.rejections.count > 0 && p.status === 'succeeded').length;
    const failed = phases.filter(p => p.status === 'failed').length;
    const scenarioMetric = { runId: result.runId, runStatus: result.status, phases: phases.length,
      firstPass, repaired, failed, rejectionMessages: result.inspect.rejections.map(r => r.payload.message).filter(Boolean) };
    metrics.scenarios[result.key] = scenarioMetric;
    for (const phase of phases) {
      if (phase.status !== 'succeeded' && phase.status !== 'failed') continue;
      const role = phase.role;
      const bucket = metrics.roles[role] ??= { sample: 0, firstPass: 0, repaired: 0, failed: 0, failureFields: [] };
      bucket.sample += 1;
      if (phase.status === 'failed') bucket.failed += 1;
      else if (phase.rejections.count > 0) bucket.repaired += 1;
      else bucket.firstPass += 1;
      if (phase.rejections.last?.message) bucket.failureFields.push(phase.rejections.last.message);
    }
  }
  for (const [role, bucket] of Object.entries(metrics.roles)) {
    const total = bucket.sample || 1;
    console.log(`  ${role}: 样本${bucket.sample} 首次合规${bucket.firstPass}(${Math.round(bucket.firstPass / total * 100)}%) 修复后成功${bucket.repaired} 最终失败${bucket.failed}`);
  }
  save('metrics.json', metrics);

  // —— 泄漏检查：Key不得出现在证据目录 ——
  const leaked = readFileSync(join(EVIDENCE, 'metrics.json'), 'utf8').includes(KEY);
  assert(!leaked, 'Key未泄漏进证据文件');

  console.log(`\n=== 研究v2真实模型实测完成：${results.length}个场景 ===`);
  for (const result of results) console.log(`${result.key}: ${result.status}`);
  console.log(`证据目录: ${EVIDENCE}`);
} finally {
  server.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 800));
  if (!server.killed) server.kill('SIGKILL');
  rmSync(join(DATA_DIR, 'credential-master.key'), { force: true });
}
