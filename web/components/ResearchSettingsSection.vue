<script setup lang="ts">
import UiSelect from './UiSelect.vue';
/** 设置→研究：能力位开关（MCP 只读/技能正文/记忆索引/引证核验）与 run 级预算上限。
 *  全部写入 /api/v1/agent-settings；只影响新发起的研究（发起时冻结），在途 run 不受影响。 */
import { onMounted, ref } from 'vue';
import { v1 } from '../api';
import { toastSuccess, toastError } from '../ui/toast';
import type { AgentRuntimeSettings } from '../../contracts/models';

const settings = ref<AgentRuntimeSettings | null>(null);
const busy = ref(false);

const toggles = [
  { key: 'researchMcpTools', label: '允许参与者使用 MCP 工具', desc: '发起研究时从已发现的只读声明工具中逐项勾选并冻结；有副作用的工具不可选。MCP 工具在宿主进程执行（stdio）或复用账户级会话（HTTP）。' },
  { key: 'researchSkillMethods', label: '允许研究中勾选技能（正文下发）', desc: '发起研究时在资料区「＋ 添加」菜单勾选技能，正文冻结后随提示词下发；仅为方法论参考，不是证据。' },
  { key: 'researchMemory', label: '允许注入项目记忆索引', desc: '把项目记忆库的索引摘要作为只读背景上下文注入各参与者；记忆正文不进入研究。' },
  { key: 'researchHostVerify', label: '允许主持/汇总核验引证来源', desc: '主持与汇总可对视图内带网址的资料执行来源核验（matched/changed/unavailable）；不新增证据，不开放网页搜索。' },
] as const;

const modelLimitOptions = [40, 80, 120, 200, 240, 300, 400].map(n => ({ value: String(n), label: `${n} 次` }));
const toolLimitOptions = [60, 120, 180, 300, 480, 600].map(n => ({ value: String(n), label: `${n} 次` }));

onMounted(async () => {
  try { settings.value = await v1<AgentRuntimeSettings>('/api/v1/agent-settings'); }
  catch (e) { toastError(e instanceof Error ? e.message : '读取研究设置失败'); }
});

async function put(patch: Partial<AgentRuntimeSettings>) {
  if (!settings.value) return;
  busy.value = true;
  try {
    settings.value = await v1<AgentRuntimeSettings>('/api/v1/agent-settings', { method: 'PUT', body: JSON.stringify({ ...settings.value, ...patch }) });
    toastSuccess('研究设置已保存');
  }
  catch (e) { toastError(e instanceof Error ? e.message : '保存研究设置失败'); }
  finally { busy.value = false; }
}
function toggle(key: typeof toggles[number]['key'], checked: boolean) { void put({ [key]: checked }); }
function saveLimit(key: 'researchModelRequestLimit' | 'researchToolRequestLimit', value: string | number) {
  const n = Number(value);
  if (!Number.isInteger(n)) return;
  void put({ [key]: n });
}
</script>
<template>
<section class="research-settings-section" aria-label="研究">
  <p class="settings-description">控制辩论/评审研究运行的能力边界。所有开关与上限只影响新发起的研究：发起时会冻结当时的能力与清单，进行中或重试的 run 不受设置改动影响。</p>
  <div class="settings-group">
    <div v-for="tg in toggles" :key="tg.key" class="setting-row">
      <div><strong>{{ tg.label }}</strong><p>{{ tg.desc }}</p></div>
      <input type="checkbox" :checked="settings?.[tg.key] !== false" :aria-label="tg.label" :disabled="busy || !settings" @change="toggle(tg.key, ($event.target as HTMLInputElement).checked)">
    </div>
    <div class="setting-row">
      <div><strong>模型请求上限（整场）</strong><p>整场研究允许的模型请求总数（40—400），发起时冻结；重试不清零。</p></div>
      <UiSelect :model-value="String(settings?.researchModelRequestLimit ?? 240)" label="模型请求上限" :disabled="busy || !settings" @change="saveLimit('researchModelRequestLimit', $event)" :options="modelLimitOptions"/>
    </div>
    <div class="setting-row">
      <div><strong>工具请求上限（整场）</strong><p>整场研究允许的工具调用总数（60—600），发起时冻结；重试不清零。</p></div>
      <UiSelect :model-value="String(settings?.researchToolRequestLimit ?? 480)" label="工具请求上限" :disabled="busy || !settings" @change="saveLimit('researchToolRequestLimit', $event)" :options="toolLimitOptions"/>
    </div>
  </div>
  <p class="settings-footnote">MCP 工具结果与网页抓取一样属待核验数据：只有落库为资料后才能作为证据引用。90 分钟累计执行窗与「重试不清零」是协议安全语义，不可配置。</p>
</section>
</template>
<style scoped>
.research-settings-section{display:grid;gap:12px}
.research-settings-section .setting-row input[type="checkbox"]{accent-color:var(--color-icon-blue,#508de0)}
</style>
