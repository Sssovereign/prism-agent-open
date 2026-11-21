<script setup lang="ts">
/** 设置→MCP（块B新增）：server 列表＋表单＋信任/测试。
 *  按 ZCode McpSettingsSection/McpServerList/McpServerForm 语义复刻（React→Vue）：
 *  行布局 auto_minmax(0,1fr)_auto、Cable 图标角标状态点、dashed 空态、env 折叠区。
 *  R62：本地 stdio 之外支持远程 streamable HTTP（url+headers，如智谱 webSearchPrime）；错误经块0 toast 展示。 */
import { onMounted, ref } from 'vue';
import { v1 } from '../api';
import { toastSuccess, toastError } from '../ui/toast';
import ConfirmationDialog from './ConfirmationDialog.vue';

interface McpServerDto {
  id: string; name: string; command: string; args: string[]; envKeys: string[];
  transport: 'stdio' | 'http'; url: string | null; headerKeys: string[];
  trusted: boolean; enabled: boolean; lastError: string | null; toolCount: number; updatedAt: string;
}
interface FormState { name: string; command: string; args: string; env: string; transport: 'stdio' | 'http'; url: string; headers: string }

const servers = ref<McpServerDto[]>([]);
const loading = ref(true);
const editing = ref<McpServerDto | null>(null);
const showForm = ref(false);
const form = ref<FormState>({ name: '', command: '', args: '', env: '', transport: 'stdio', url: '', headers: '' });
const showEnv = ref(false);
const showHeaders = ref(false);
const busy = ref(false);
const testingId = ref('');
const deleteTarget = ref<McpServerDto | null>(null);
const trustTarget = ref<McpServerDto | null>(null);

/** 行状态点：对齐 McpStatusDot 色语义——connected绿/connecting黄(转圈)/error红/untrusted警告灰点。 */
function statusKind(server: McpServerDto): 'connected' | 'error' | 'connecting' | 'untrusted' | 'unknown' {
  if (!server.trusted) return 'untrusted';
  if (server.lastError) return 'error';
  if (server.enabled && server.toolCount > 0) return 'connected';
  return 'unknown';
}
const statusText: Record<string, string> = {
  connected: '已连接', error: '连接出错', connecting: '连接中', untrusted: '待信任', unknown: '未测试',
};
function rowDescription(server: McpServerDto): string {
  if ((server.transport ?? 'stdio') === 'http') return `远程 HTTP · ${server.url ?? ''}`;
  const tail = server.args.length ? ` ${server.args.join(' ')}` : '';
  return `stdio · ${server.command}${tail}`;
}

async function refresh() {
  loading.value = true;
  try {
    const data = await v1<{ servers: McpServerDto[] }>('/api/v1/mcp-servers');
    servers.value = data.servers;
  }
  catch (e) { toastError(e instanceof Error ? e.message : '读取 MCP 服务列表失败'); }
  finally { loading.value = false; }
}
onMounted(() => { void refresh(); });

function openCreate() {
  editing.value = null;
  form.value = { name: '', command: '', args: '', env: '', transport: 'stdio', url: '', headers: '' };
  showEnv.value = false;
  showHeaders.value = false;
  showForm.value = true;
}
function openEdit(server: McpServerDto) {
  editing.value = server;
  form.value = { name: server.name, command: server.command, args: server.args.join(' '), env: '',
    transport: server.transport ?? 'stdio', url: server.url ?? '', headers: '' };
  showEnv.value = server.envKeys.length > 0;
  showHeaders.value = server.headerKeys.length > 0;
  showForm.value = true;
}
function closeForm() { showForm.value = false; editing.value = null; }

async function save() {
  busy.value = true;
  try {
    const isHttp = form.value.transport === 'http';
    const args = form.value.args.trim() ? form.value.args.trim().split(/\s+/) : [];
    let env: Record<string, string> = {};
    if (!isHttp && form.value.env.trim()) {
      try { env = JSON.parse(form.value.env) as Record<string, string>; }
      catch { toastError('环境变量须为合法 JSON 对象'); return; }
    }
    let headers: Record<string, string> = {};
    if (isHttp) {
      if (form.value.headers.trim()) {
        try { headers = JSON.parse(form.value.headers) as Record<string, string>; }
        catch { toastError('Headers 须为合法 JSON 对象'); return; }
      }
      if (!/^https:\/\//.test(form.value.url.trim())) { toastError('远程 MCP 地址须以 https:// 开头'); return; }
    }
    const body = JSON.stringify({
      name: form.value.name.trim(),
      transport: form.value.transport,
      command: isHttp ? '' : form.value.command.trim(),
      args: isHttp ? [] : args,
      env: isHttp ? {} : env,
      url: isHttp ? form.value.url.trim() : null,
      headers: isHttp ? headers : {},
    });
    if (editing.value) {
      await v1(`/api/v1/mcp-servers/${editing.value.id}`, { method: 'PUT', body });
      toastSuccess('MCP 服务已更新，工具清单需重新测试获取');
    } else {
      await v1('/api/v1/mcp-servers', { method: 'POST', body });
      toastSuccess('MCP 服务已添加（默认未信任，测试后请开启信任）');
    }
    closeForm();
    await refresh();
  }
  catch (e) { toastError(e instanceof Error ? e.message : '保存失败'); }
  finally { busy.value = false; }
}

async function toggleEnabled(server: McpServerDto, enabled: boolean) {
  try {
    await v1(`/api/v1/mcp-servers/${server.id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) });
    server.enabled = enabled;
  }
  catch (e) { toastError(e instanceof Error ? e.message : '切换失败'); }
}

async function confirmTrust() {
  const server = trustTarget.value;
  if (!server) return;
  busy.value = true;
  try {
    await v1(`/api/v1/mcp-servers/${server.id}/trust`, { method: 'PUT', body: JSON.stringify({ trusted: true }) });
    toastSuccess('已信任并启用该服务');
    trustTarget.value = null;
    await refresh();
  }
  catch (e) { toastError(e instanceof Error ? e.message : '信任操作失败'); }
  finally { busy.value = false; }
}

async function confirmDelete() {
  const server = deleteTarget.value;
  if (!server) return;
  busy.value = true;
  try {
    await v1(`/api/v1/mcp-servers/${server.id}`, { method: 'DELETE' });
    toastSuccess('MCP 服务已删除');
    deleteTarget.value = null;
    if (editing.value?.id === server.id) closeForm();
    await refresh();
  }
  catch (e) { toastError(e instanceof Error ? e.message : '删除失败'); }
  finally { busy.value = false; }
}

async function test(server: McpServerDto) {
  testingId.value = server.id;
  try {
    const result = await v1<{ ok: boolean; toolCount: number; latencyMs: number }>(`/api/v1/mcp-servers/${server.id}/test`, { method: 'POST' });
    toastSuccess(`连接成功：发现 ${result.toolCount} 个工具（${result.latencyMs}ms）`);
    await refresh();
  }
  catch (e) { toastError(e instanceof Error ? e.message : '连接测试失败'); await refresh(); }
  finally { testingId.value = ''; }
}
</script>
<template>
<section class="mcp-section" aria-label="MCP 服务">
  <p class="settings-description">连接 MCP 服务（本地进程或远程 HTTP），其工具以 mcp__服务__工具 名义加入 Agent。本地进程由平台宿主侧启动管理（不进入沙箱）；请只添加你信任的服务。</p>
  <template v-if="!showForm">
    <div v-if="!loading && servers.length" class="mcp-list" role="list">
      <div v-for="server in servers" :key="server.id" class="mcp-row" role="listitem" :data-mcp-status="statusKind(server)" @click="openEdit(server)">
        <div class="mcp-row-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 9V6a2 2 0 0 1 2-2h3"/><path d="M22 9V6a2 2 0 0 0-2-2h-3"/><path d="M2 15v3a2 2 0 0 0 2 2h3"/><path d="M22 15v3a2 2 0 0 1-2 2h-3"/><path d="M8 12h8"/></svg>
          <span class="mcp-status-dot" :data-status="statusKind(server)" :title="statusText[statusKind(server)]"><template v-if="statusKind(server)==='connecting'"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mcp-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></template></span>
        </div>
        <div class="mcp-row-main">
          <div class="mcp-row-title">
            <span class="mcp-name">{{ server.name }}</span>
            <span class="mcp-badge" :data-badge="server.trusted ? 'trusted' : 'untrusted'">{{ server.trusted ? '已信任' : '待信任' }}</span>
            <span v-if="server.toolCount" class="mcp-tool-count">{{ server.toolCount }} 个工具</span>
          </div>
          <p class="mcp-row-desc">{{ rowDescription(server) }}</p>
          <p v-if="server.lastError" class="mcp-row-error">{{ server.lastError }}</p>
        </div>
        <div class="mcp-row-actions" @click.stop>
          <button v-if="!server.trusted" type="button" class="btn" @click="trustTarget = server">信任</button>
          <button type="button" class="btn" :disabled="testingId === server.id" @click="test(server)">{{ testingId === server.id ? '测试中…' : '测试连接' }}</button>
          <label class="mcp-switch" :aria-label="`启用 ${server.name}`">
            <input type="checkbox" :checked="server.enabled" :disabled="!server.trusted" @change="toggleEnabled(server, ($event.target as HTMLInputElement).checked)">
            <span class="mcp-switch-track" aria-hidden="true"></span>
          </label>
        </div>
      </div>
    </div>
    <div v-else-if="!loading" class="mcp-empty">
      <p class="mcp-empty-title">还没有 MCP 服务</p>
      <p class="mcp-empty-desc">添加本地或远程 MCP 服务，其工具会在任务尝试启动时随快照装配。</p>
      <button type="button" class="btn" @click="openCreate">＋ 新建服务</button>
    </div>
    <p v-if="loading" class="settings-footnote" role="status">正在读取 MCP 服务列表…</p>
    <div class="mcp-footer"><button type="button" class="btn" @click="openCreate">＋ 新建服务</button></div>
    <p class="settings-footnote">信任=允许该服务随任务启动并被调用；未信任的服务不参与任务。本地服务的环境变量与远程服务的 Headers 随配置保存在本机数据库（Headers 常需存放 Bearer Key，请知悉）；服务清单变更后需重新“测试连接”并重建任务生效。</p>
  </template>
  <template v-else>
    <div class="mcp-form-head">
      <div>
        <h3>{{ editing ? '编辑服务' : '新建服务' }}</h3>
        <p class="settings-description">{{ editing ? '修改后原工具清单失效，请重新测试连接。' : '连接本地 stdio 进程或远程 streamable HTTP 服务。' }}</p>
      </div>
    </div>
    <div class="mcp-form">
      <label class="mcp-field"><span>名称</span>
        <input v-model="form.name" maxlength="64" placeholder="my-mcp-server" :disabled="busy">
      </label>
      <label class="mcp-field"><span>连接方式</span>
        <select v-model="form.transport" class="mcp-transport-select" :disabled="busy">
          <option value="stdio">本地进程（stdio）</option>
          <option value="http">远程 HTTP（streamable）</option>
        </select>
      </label>
      <template v-if="form.transport === 'http'">
        <label class="mcp-field"><span>服务地址</span>
          <input v-model="form.url" maxlength="2048" placeholder="https://open.bigmodel.cn/api/mcp/web_search_prime/mcp" :disabled="busy" spellcheck="false">
        </label>
        <div class="mcp-env">
          <button type="button" class="mcp-env-toggle" @click="showHeaders = !showHeaders">
            <svg :class="{'mcp-chevron-open': showHeaders}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
            Headers（鉴权用）
          </button>
          <p class="settings-footnote">JSON 对象，随配置保存在本机数据库。远程服务通常需要在这里放授权头，如 {"Authorization": "Bearer &lt;Key&gt;"}。</p>
          <textarea v-if="showHeaders" v-model="form.headers" rows="4" class="mcp-env-json" placeholder='{
  "Authorization": "Bearer your-key"
}' :disabled="busy" spellcheck="false"></textarea>
        </div>
      </template>
      <template v-else>
        <label class="mcp-field"><span>启动命令</span>
          <input v-model="form.command" placeholder="npx" :disabled="busy">
        </label>
        <label class="mcp-field"><span>参数（空格分隔）</span>
          <input v-model="form.args" placeholder="-y @modelcontextprotocol/server-memory" :disabled="busy">
        </label>
        <div class="mcp-env">
          <button type="button" class="mcp-env-toggle" @click="showEnv = !showEnv">
            <svg :class="{'mcp-chevron-open': showEnv}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
            环境变量（可选）
          </button>
          <p class="settings-footnote">随配置保存在本机数据库；请勿填入 API Key 等敏感凭据。</p>
          <textarea v-if="showEnv" v-model="form.env" rows="4" class="mcp-env-json" placeholder='{
  "MY_API_KEY": "your-key"
}' :disabled="busy" spellcheck="false"></textarea>
        </div>
      </template>
      <div class="mcp-form-actions">
        <button v-if="editing" type="button" class="btn btn-danger-link" :disabled="busy" @click="deleteTarget = editing">删除服务</button>
        <span class="mcp-form-actions-main">
          <button type="button" class="btn btn-solid" :disabled="busy || !form.name.trim() || (form.transport === 'http' ? !form.url.trim() : !form.command.trim())" @click="save">保存</button>
          <button type="button" class="btn" :disabled="busy" @click="closeForm">取消</button>
        </span>
      </div>
    </div>
  </template>
  <ConfirmationDialog v-if="deleteTarget" title="删除该 MCP 服务？" description="删除后其工具不再装配进新任务；已运行的任务不受影响。" confirm-label="删除" danger :busy="busy" @close="deleteTarget = null" @confirm="confirmDelete" />
  <ConfirmationDialog v-if="trustTarget" :title="`信任 MCP 服务“${trustTarget.name}”？`" description="信任后平台会在任务启动时以你的账户权限启动该命令进程，其工具可被 Agent 调用；未声明只读的工具每次调用都需你审批。请确认命令与参数来源可信。" confirm-label="信任并启用" :busy="busy" @close="trustTarget = null" @confirm="confirmTrust" />
</section>
</template>
<style scoped>
.mcp-section{display:grid;gap:12px}
.mcp-list,.mcp-empty,.mcp-form{border:1px solid var(--border);border-radius:12px;background:var(--bg-card)}
.mcp-list{overflow:hidden}
.mcp-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--border);cursor:default;transition:background-color 150ms ease}
.mcp-row:hover{background:var(--bg-surface-hover,var(--bg-card))}
.mcp-row:first-child{border-top:0}
.mcp-row-icon{position:relative;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:12px;flex:none;color:var(--fg-subtle);background:var(--bg-card)}
.mcp-status-dot{position:absolute;right:-4px;bottom:-4px;display:flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:9999px;background:var(--bg-card)}
.mcp-status-dot::after{content:'';width:10px;height:10px;border-radius:9999px;background:var(--fg-subtlest)}
.mcp-status-dot[data-status=connected]::after{background:#22c55e}
.mcp-status-dot[data-status=error]::after{background:#ef4444}
.mcp-status-dot[data-status=connecting]::after{background:transparent}
.mcp-status-dot[data-status=untrusted]::after{background:var(--warning,#eab308)}
.mcp-spin{color:#eab308;animation:mcp-rotate 1s linear infinite}
@keyframes mcp-rotate{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.mcp-spin{animation:none}}
.mcp-row-main{min-width:0}
.mcp-row-title{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.mcp-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-base);font-weight:500;color:var(--fg)}
.mcp-badge{display:inline-flex;border-radius:6px;padding:2px 6px;font-size:var(--text-ui-sm);color:var(--fg-subtle);background:var(--bg-surface,var(--bg-card));box-shadow:0 0 0 1px var(--border)}
.mcp-badge[data-badge=trusted]{color:var(--success)}
.mcp-badge[data-badge=untrusted]{color:var(--warning,#a16207)}
.mcp-tool-count{display:inline-flex;border-radius:6px;padding:2px 6px;font-size:var(--text-ui-sm);color:var(--fg-subtle);background:var(--bg-surface,var(--bg-card));box-shadow:0 0 0 1px var(--border)}
.mcp-row-desc{margin:4px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-sm);color:var(--fg-subtle)}
.mcp-row-error{margin:4px 0 0;font-size:var(--text-ui-sm);color:var(--danger)}
.mcp-row-actions{display:flex;flex:none;align-items:center;gap:8px}
.mcp-footer{display:flex;justify-content:flex-end}
/* Switch：对齐上游 Switch 组件 24×14 视觉比例 */
.mcp-switch{position:relative;display:inline-flex;cursor:pointer}
.mcp-switch input{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.mcp-switch-track{display:inline-block;width:32px;height:18px;border-radius:9999px;background:var(--fg-subtlest);opacity:.4;transition:background-color 150ms ease,opacity 150ms ease;position:relative}
.mcp-switch-track::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:9999px;background:#fff;transition:transform 150ms ease}
.mcp-switch input:checked+.mcp-switch-track{background:var(--accent,#2563eb);opacity:1}
.mcp-switch input:checked+.mcp-switch-track::after{transform:translateX(14px)}
.mcp-switch input:disabled+.mcp-switch-track{opacity:.2;cursor:not-allowed}
.mcp-switch input:focus-visible+.mcp-switch-track{outline:2px solid var(--accent,#2563eb);outline-offset:2px}
.mcp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:40px 16px;text-align:center;border-style:dashed}
.mcp-empty-title{font-size:var(--text-ui-base);font-weight:500;color:var(--fg)}
.mcp-empty-desc{font-size:var(--text-ui-base);color:var(--fg-subtle)}
.mcp-form{display:grid;gap:12px;padding:16px}
.mcp-form-head h3{font-size:18px;font-weight:600;margin:0 0 4px}
.mcp-field{display:grid;gap:4px;font-size:var(--text-ui-base);font-weight:500;color:var(--fg-subtle)}
.mcp-field input{height:36px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);padding:0 10px;font-size:var(--text-ui-base);color:var(--fg)}
.mcp-transport-select{height:36px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);padding:0 10px;font-size:var(--text-ui-base);color:var(--fg)}
.mcp-env-toggle{display:inline-flex;align-items:center;gap:4px;font-size:var(--text-ui-base);color:var(--fg-subtle);background:none;border:0;padding:0;cursor:pointer}
.mcp-env-toggle:hover{color:var(--fg)}
.mcp-chevron-open{transform:rotate(90deg)}
.mcp-env-json{width:100%;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);padding:8px 10px;font:var(--text-ui-base) var(--font-mono);color:var(--fg);resize:vertical}
.mcp-form-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}
.mcp-form-actions-main{display:flex;gap:8px}
.btn-danger-link{color:var(--danger)}
.btn-solid{background:var(--primary);color:var(--primary-fg);border-color:transparent}
</style>
