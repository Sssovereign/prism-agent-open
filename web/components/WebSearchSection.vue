<script setup lang="ts">
import UiSelect from './UiSelect.vue';
/** 设置→联网搜索（块A新增）：provider 持久化 + 本机加密 API Key（或引用模型接口 Key）+ 连接测试。
 *  对齐 ZCode 设置页语义；提示经块0 toast 系统展示。 */
import { computed, onMounted, ref } from 'vue';
import { SEARCH_PROVIDER_OPTIONS, searchReuseForBaseUrl, type SearchProvider, type SearchSettings } from '../../contracts/search';
import type { ModelConfigView } from '../../contracts/models';
import { v1 } from '../api';
import { toastSuccess, toastError } from '../ui/toast';

const providerOptions = SEARCH_PROVIDER_OPTIONS;
const provider = ref<SearchProvider>('none');
const savedProvider = ref<SearchProvider>('none');
const selectedProvider = computed(() => providerOptions.find(p => p.value === provider.value)!);
const providerDocs = computed(() => 'docsUrl' in selectedProvider.value ? selectedProvider.value.docsUrl : undefined);
const modelConfigs = ref<ModelConfigView[]>([]);
/** 可从搜索页正向引用的模型接口：启用、已存 Key、地址主机映射到当前所选搜索服务 */
const reuseCandidates = computed(() => provider.value === 'none' ? [] : modelConfigs.value.filter(c => c.enabled && c.hasCredential && searchReuseForBaseUrl(c.baseUrl)?.provider === provider.value));
const sourceOptions = computed(() => reuseCandidates.value.map(c => ({ value: c.id, label: c.name })));
const selectedSourceId = ref('');
const credentialStored = ref(false);
const sourceConfigId = ref<string | null>(null);
const sourceConfigName = ref<string | null>(null);
const sourceValid = ref(false);
const apiKey = ref('');
const showKey = ref(false);
const busy = ref(false);
const testing = ref(false);

function applySettings(settings: SearchSettings) {
  provider.value = savedProvider.value = settings.provider;
  credentialStored.value = settings.credentialStored;
  sourceConfigId.value = settings.sourceConfigId;
  sourceConfigName.value = settings.sourceConfigName;
  sourceValid.value = settings.sourceValid;
}

onMounted(async () => {
  try {
    applySettings(await v1<SearchSettings>('/api/v1/search-settings'));
  }
  catch (e) { toastError(e instanceof Error ? e.message : '读取联网搜索设置失败'); }
  // 模型接口列表供正向引用；失败静默（仅少一个引用入口，不影响独立 Key 流程）
  try {
    modelConfigs.value = await v1<ModelConfigView[]>('/api/v1/model-configs');
  }
  catch { modelConfigs.value = []; }
});

async function saveProvider() {
  busy.value = true;
  apiKey.value = ''; showKey.value = false; selectedSourceId.value = '';
  try {
    applySettings(await v1<SearchSettings>('/api/v1/search-settings', { method: 'PUT', body: JSON.stringify({ provider: provider.value }) }));
    if (provider.value === 'none') apiKey.value = '';
    toastSuccess('已保存联网搜索设置');
  }
  catch (e) { provider.value = savedProvider.value; toastError(e instanceof Error ? e.message : '保存失败'); }
  finally { busy.value = false; }
}

// 从搜索页正向引用模型接口的 Key（与模型接口侧勾选等效，写同一个引用）
async function linkSource() {
  if (!selectedSourceId.value) return;
  busy.value = true;
  try {
    applySettings(await v1<SearchSettings>('/api/v1/search-settings', { method: 'PUT', body: JSON.stringify({ provider: provider.value, sourceConfigId: selectedSourceId.value }) }));
    toastSuccess(`已引用「${sourceConfigName.value || '模型接口'}」的 Key`);
  }
  catch (e) { toastError(e instanceof Error ? e.message : '引用失败'); }
  finally { busy.value = false; }
}

async function saveKey() {
  busy.value = true;
  try {
    await v1('/api/v1/search-settings/credential', { method: 'PUT', body: JSON.stringify({ apiKey: apiKey.value }) });
    credentialStored.value = true;
    apiKey.value = '';
    toastSuccess('API Key 已加密保存到本机账号');
  }
  catch (e) { toastError(e instanceof Error ? e.message : '保存失败'); }
  finally { busy.value = false; }
}

async function removeKey() {
  busy.value = true;
  try {
    await v1('/api/v1/search-settings/credential', { method: 'DELETE' });
    credentialStored.value = false;
    toastSuccess('已清除 API Key');
  }
  catch (e) { toastError(e instanceof Error ? e.message : '清除失败'); }
  finally { busy.value = false; }
}

// 解除对模型接口 Key 的引用（回到独立 Key 模式）
async function unlinkSource() {
  busy.value = true;
  try {
    applySettings(await v1<SearchSettings>('/api/v1/search-settings/source', { method: 'DELETE' }));
    toastSuccess('已解除引用，回到独立搜索 Key');
  }
  catch (e) { toastError(e instanceof Error ? e.message : '解除引用失败'); }
  finally { busy.value = false; }
}

async function test() {
  testing.value = true;
  try {
    const result = await v1<{ ok: boolean; provider: string; latencyMs: number; sample: string | null; resultCount: number }>('/api/v1/search-settings/test', { method: 'POST' });
    toastSuccess(`连接正常（${selectedProvider.value.label}，${result.latencyMs}ms）${result.resultCount ? '' : '，本次查询未返回匹配结果'}`);
  }
  catch (e) { toastError(e instanceof Error ? e.message : '连接测试失败'); }
  finally { testing.value = false; }
}
</script>
<template>
<section class="web-search-section" aria-label="联网搜索">
  <p class="settings-description">为 Agent 的“搜索网页”工具选择搜索服务。网页抓取（web_fetch）无需此配置即可使用。此处的配置是全局兜底：在模型接口勾选了「启用联网搜索」的任务会优先复用该接口的 Key，仅当所用接口未勾选时才使用这里的选择。</p>
  <p class="provider-description">{{ selectedProvider.description }} <a v-if="providerDocs" :href="providerDocs" target="_blank" rel="noopener noreferrer">查看服务说明</a></p>
  <div class="settings-group">
    <div class="setting-row">
      <div><strong>搜索服务</strong><p>Agent 搜索网页时使用的服务；不启用时该工具会明确提示未配置。</p></div>
      <UiSelect v-model="provider" label="搜索服务" :disabled="busy || testing" @change="saveProvider" :options="providerOptions"/>
    </div>
    <div v-if="provider!=='none' && !sourceConfigId && sourceOptions.length" class="setting-row">
      <div><strong>从模型接口引用</strong><p>以下接口与当前搜索服务同一厂商账号；引用后直接使用其已保存的密钥，随该接口的保存与清除联动。</p></div>
      <div class="key-controls">
        <UiSelect v-model="selectedSourceId" label="模型接口" :disabled="busy || testing" :options="sourceOptions"/>
        <button type="button" class="btn" :disabled="busy || testing || !selectedSourceId" @click="linkSource">引用</button>
      </div>
    </div>
    <div v-if="provider!=='none'" class="setting-row">
      <div>
        <strong>API Key</strong>
        <p v-if="sourceConfigId">{{ sourceValid ? '来自模型接口「'+(sourceConfigName||'未知')+'」的密钥，随该接口的保存与清除联动。' : '引用的模型接口已停用、地址已变更或其 Key 已清除；请在模型接口重新保存 Key 或解除引用。' }}</p>
        <p v-else>{{ credentialStored ? '已加密保存到本机账号，退出或重启后保留。' : '未填写。保存后随本机账号加密保留。' }}</p>
      </div>
      <div class="key-controls" :class="{'key-source-invalid': sourceConfigId && !sourceValid}">
        <template v-if="sourceConfigId">
          <button type="button" class="btn" :disabled="busy || testing" @click="test">{{ testing ? '测试中…' : '测试连接' }}</button>
          <button type="button" class="btn" :disabled="busy || testing" @click="unlinkSource">解除引用</button>
        </template>
        <template v-else-if="credentialStored">
          <button type="button" class="btn" :disabled="busy || testing" @click="test">{{ testing ? '测试中…' : '测试连接' }}</button>
          <button type="button" class="btn" :disabled="busy || testing" @click="removeKey">清除 Key</button>
        </template>
        <template v-else>
          <input v-model="apiKey" :type="showKey ? 'text' : 'password'" autocomplete="off" placeholder="粘贴 API Key" aria-label="搜索服务 API Key" :disabled="busy">
          <button type="button" class="btn" :aria-pressed="showKey" :disabled="busy || !apiKey" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
          <button type="button" class="btn" :disabled="busy || !apiKey.trim()" @click="saveKey">保存 Key</button>
        </template>
      </div>
    </div>
  </div>
  <p v-if="provider!=='none'" class="settings-footnote">需使用所选厂商搜索服务的 API Key；切换厂商会清除原搜索密钥。也可在「模型接口」勾选「用此接口的 Key 连通联网搜索」，复用同一厂商账号的密钥。</p>
  <p class="settings-footnote">搜索请求经本机网关出站：仅公开 HTTPS、DNS 固定解析、重定向逐跳校验；Key 不进入沙箱与任务记录。</p>
</section>
</template>
<style scoped>
.web-search-section{display:grid;gap:12px}.provider-description{font-size:13px;color:var(--fg-subtle);margin:0}.provider-description a{color:inherit;text-decoration:underline}
@media(max-width:640px){.web-search-section .setting-row{flex-wrap:wrap;gap:10px}.key-controls{flex-wrap:wrap;max-width:100%}.key-controls input{max-width:100%}}
.key-controls{display:flex;gap:8px;align-items:center;flex:none}
.key-controls input{width:220px;height:28px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);padding:0 8px;font-size:var(--text-ui-base)}
.key-source-invalid{color:var(--danger)}
</style>
