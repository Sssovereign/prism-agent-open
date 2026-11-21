<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { v1 } from '../api';
import { AGENT_PROMPT_MAX_CHARS, DEFAULT_AGENT_SETTINGS, DEFAULT_COMPACTION_SYSTEM_PROMPT, DEFAULT_SUBAGENT_SYSTEM_PROMPT, normalizeAgentPrompts, type AgentRuntimeSettings } from '../../contracts/models';
import ModelProviderIcon from './ModelProviderIcon.vue';

const settings = ref<AgentRuntimeSettings>({ ...DEFAULT_AGENT_SETTINGS });
const saved = ref({ autoCompaction: true, keepRecentTurns: 3, memoryEnabled: true, askUserQuestionAutoResolutionEnabled: true });
const prompts = ref({ mainAppend: '', subagent: '', compaction: '' });
const savedPrompts = ref({ mainAppend: '', subagent: '', compaction: '' });
const loading = ref(true), loaded = ref(false), busy = ref(false), message = ref(''), error = ref('');
const controller = new AbortController();
let disposed = false;
const valid = computed(() => Number.isInteger(settings.value.keepRecentTurns) && settings.value.keepRecentTurns >= 1 && settings.value.keepRecentTurns <= 20 && Object.values(prompts.value).every(v => v.trim().length <= AGENT_PROMPT_MAX_CHARS));
const promptsKey = (value: { mainAppend: string; subagent: string; compaction: string }) => JSON.stringify(normalizeAgentPrompts(value) ?? {});
const promptsDirty = computed(() => promptsKey(prompts.value) !== promptsKey(savedPrompts.value));
const dirty = computed(() => loaded.value && (settings.value.autoCompaction !== saved.value.autoCompaction || settings.value.keepRecentTurns !== saved.value.keepRecentTurns || settings.value.memoryEnabled !== saved.value.memoryEnabled || settings.value.askUserQuestionAutoResolutionEnabled !== saved.value.askUserQuestionAutoResolutionEnabled || promptsDirty.value));
const isDefault = computed(() => settings.value.autoCompaction === DEFAULT_AGENT_SETTINGS.autoCompaction && settings.value.keepRecentTurns === DEFAULT_AGENT_SETTINGS.keepRecentTurns && settings.value.memoryEnabled === DEFAULT_AGENT_SETTINGS.memoryEnabled && settings.value.askUserQuestionAutoResolutionEnabled === true && !promptsDirty.value && !normalizeAgentPrompts(prompts.value));
const request = <T,>(init: RequestInit = {}) => v1<T>('/api/v1/agent-settings', { ...init, signal: controller.signal });
function syncPrompts(value: AgentRuntimeSettings) { prompts.value = { mainAppend: value.prompts?.mainAppend ?? '', subagent: value.prompts?.subagent ?? '', compaction: value.prompts?.compaction ?? '' }; }
function remember(value: AgentRuntimeSettings) { saved.value = { autoCompaction: value.autoCompaction, keepRecentTurns: value.keepRecentTurns, memoryEnabled: value.memoryEnabled !== false, askUserQuestionAutoResolutionEnabled: value.askUserQuestionAutoResolutionEnabled !== false }; syncPrompts(value); savedPrompts.value = { ...prompts.value }; }
watch(() => [settings.value.autoCompaction, settings.value.keepRecentTurns, settings.value.memoryEnabled, settings.value.askUserQuestionAutoResolutionEnabled, prompts.value.mainAppend, prompts.value.subagent, prompts.value.compaction], () => {
  if (!busy.value && !loading.value) { message.value = ''; error.value = ''; }
}, { flush: 'sync' });
async function load() {
  if (busy.value) return;
  loading.value = true; error.value = '';
  try {
    const value = await request<AgentRuntimeSettings>();
    if (!disposed) { settings.value = value; syncPrompts(value); remember(value); loaded.value = true; }
  } catch (e) { if (!disposed) error.value = e instanceof Error ? e.message : '读取设置失败，请重试'; }
  finally { if (!disposed) loading.value = false; }
}
function resetDefaults() {
  settings.value.autoCompaction = DEFAULT_AGENT_SETTINGS.autoCompaction;
  settings.value.keepRecentTurns = DEFAULT_AGENT_SETTINGS.keepRecentTurns;
  settings.value.askUserQuestionAutoResolutionEnabled = true;
  settings.value.memoryEnabled = DEFAULT_AGENT_SETTINGS.memoryEnabled;
  prompts.value = { mainAppend: '', subagent: '', compaction: '' };
}
async function save() {
  if (busy.value || loading.value || !loaded.value || !valid.value || !dirty.value) return;
  busy.value = true; error.value = ''; message.value = '';
  // prompts 全空时 normalizeAgentPrompts 返回 undefined，JSON.stringify 丢弃该键=清除自定义、回落内置默认
  const draft = { autoCompaction: settings.value.autoCompaction, keepRecentTurns: settings.value.keepRecentTurns, memoryEnabled: settings.value.memoryEnabled !== false, askUserQuestionAutoResolutionEnabled: settings.value.askUserQuestionAutoResolutionEnabled !== false, prompts: normalizeAgentPrompts(prompts.value) };
  try {
    // Preserve settings maintained on other pages, such as subagent limits.
    const latest = await request<AgentRuntimeSettings>();
    if (disposed) return;
    const value = await request<AgentRuntimeSettings>({ method: 'PUT', body: JSON.stringify({ ...latest, ...draft }) });
    if (!disposed) { settings.value = value; remember(value); message.value = '已保存，新建任务时生效'; }
  } catch (e) { if (!disposed) error.value = e instanceof Error ? e.message : '保存失败，修改已保留，请重试'; }
  finally { if (!disposed) busy.value = false; }
}
onMounted(load);
onBeforeUnmount(() => { disposed = true; controller.abort(); });
</script>

<template>
  <section class="agent-runtime-settings" aria-label="Agent 运行设置">
    <p class="settings-description">管理长对话如何整理，以及最近多少轮内容完整交给模型。设置保存到当前本机账号。</p>
    <div class="agent-scope-note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></svg><p><strong>仅对新建任务生效</strong><span>已有任务继续使用启动时的设置，保存后不会中途改变正在执行的任务。</span></p></div>

    <form :aria-busy="loading || busy" @submit.prevent="save">
      <div class="agent-section-heading"><h2>上下文整理</h2><span v-if="loading" class="agent-badge" role="status">正在读取…</span><span v-else-if="loaded" class="agent-badge">{{ dirty ? '有未保存的修改' : '已与账号同步' }}</span></div>
      <fieldset class="agent-fields settings-group" :disabled="busy || loading || !loaded">
        <div class="setting-row agent-setting-row"><div class="agent-setting-copy"><label for="agent-question-auto" class="agent-setting-label">提问自动继续</label><p id="agent-question-help">Agent 提问后，5 分钟未作答会自行继续。开始作答或点击停止计时后，本次问题会一直等待。关闭会立即暂停当前问题的计时，重新开启只影响之后的新问题。</p></div><input id="agent-question-auto" v-model="settings.askUserQuestionAutoResolutionEnabled" class="agent-switch" type="checkbox" role="switch" aria-describedby="agent-question-help"></div>
        <div class="setting-row agent-setting-row"><div class="agent-setting-copy"><label for="agent-auto-compaction" class="agent-setting-label">自动整理上下文</label><p id="agent-auto-help">对话接近模型可用上下文上限时，将较早的内容归纳成摘要，为继续执行留出空间。</p><span class="agent-inline-state">{{ settings.autoCompaction ? '已开启 · 需要时自动整理' : '已关闭 · 仍可使用 /compact 手动整理' }}</span></div><input id="agent-auto-compaction" v-model="settings.autoCompaction" class="agent-switch" type="checkbox" role="switch" aria-describedby="agent-auto-help"></div>
        <div class="setting-row agent-setting-row"><div class="agent-setting-copy"><label for="agent-keep-turns" class="agent-setting-label">完整保留最近轮次</label><p id="agent-turns-help">最近这些轮次保留原文，较早的对话才进入摘要。保留越多，细节越完整，也会占用更多上下文。</p><span class="agent-input-hint">1–20 轮 · 默认保留 3 轮 · 手动整理时也使用此范围</span></div><div class="agent-turn-control"><div class="agent-stepper"><button type="button" aria-label="减少保留轮次" :disabled="!valid || settings.keepRecentTurns <= 1" @click="settings.keepRecentTurns--">−</button><input id="agent-keep-turns" v-model.number="settings.keepRecentTurns" type="number" min="1" max="20" step="1" required aria-label="保留最近轮次" :aria-invalid="!valid" aria-describedby="agent-turns-help agent-turn-validation"><button type="button" aria-label="增加保留轮次" :disabled="!valid || settings.keepRecentTurns >= 20" @click="settings.keepRecentTurns++">+</button></div><span>轮</span></div></div>
        <div class="setting-row agent-setting-row"><div class="agent-setting-copy"><label for="agent-memory" class="agent-setting-label">持久记忆库</label><p id="agent-memory-help">Agent 可在项目内保存跨任务要点（用户偏好、工作方式反馈、进度交接），后续任务自动选择相关记忆，回合后提炼可复用要点；辅助模型用量单独记账。记忆按项目隔离保存，对话中随时可以让 Agent「记住」或「忘掉」内容。</p><span class="agent-inline-state">{{ settings.memoryEnabled !== false ? '已开启 · 新任务可读写项目记忆' : '已关闭 · 新任务不注入记忆，已有记忆保留' }}</span></div><input id="agent-memory" v-model="settings.memoryEnabled" class="agent-switch" type="checkbox" role="switch" aria-describedby="agent-memory-help"></div>
        <div class="agent-context-preview" aria-label="整理后的上下文示意"><div><span class="agent-preview-label">较早的对话</span><strong>归纳为摘要</strong><small>保留关键结论与待办</small></div><span class="agent-preview-plus" aria-hidden="true">+</span><div><span class="agent-preview-label">最近 {{ valid ? settings.keepRecentTurns : 'N' }} 轮</span><strong>完整保留原文</strong><small>工具调用与结果成对保留</small></div></div>
      </fieldset>

      <div class="agent-section-heading"><h2>系统提示词</h2><span class="agent-badge">留空使用内置默认</span></div>
      <fieldset class="agent-fields settings-group" :disabled="busy || loading || !loaded">
        <p class="agent-prompt-intro">以下自定义文本只会追加在内置提示词之后；内置的安全约束与格式要求始终保留，无法被移除。保存后对新建任务生效。</p>
        <div class="setting-row agent-setting-row agent-prompt-row"><div class="agent-setting-copy"><label for="agent-prompt-main" class="agent-setting-label">主链路附加提示</label><p id="agent-prompt-main-help">随每次任务注入 system 提示词，位于项目规则之前；适合放个人偏好与通用约定。留空则不附加。</p><textarea id="agent-prompt-main" v-model="prompts.mainAppend" class="agent-prompt-input" rows="4" maxlength="8000" placeholder="留空则不附加任何自定义提示" aria-describedby="agent-prompt-main-help"></textarea></div></div>
        <div class="setting-row agent-setting-row agent-prompt-row"><div class="agent-setting-copy"><label for="agent-prompt-subagent" class="agent-setting-label">子代理附加提示</label><p id="agent-prompt-subagent-help">追加在子代理内置提示词之后；内置的只读约束不可移除。</p><textarea id="agent-prompt-subagent" v-model="prompts.subagent" class="agent-prompt-input" rows="4" maxlength="8000" placeholder="留空使用内置默认" aria-describedby="agent-prompt-subagent-help"></textarea><details class="agent-prompt-default"><summary>查看内置默认</summary><pre>{{ DEFAULT_SUBAGENT_SYSTEM_PROMPT }}</pre></details></div></div>
        <div class="setting-row agent-setting-row agent-prompt-row"><div class="agent-setting-copy"><label for="agent-prompt-compaction" class="agent-setting-label">上下文摘要附加提示</label><p id="agent-prompt-compaction-help">自动整理上下文生成摘要时追加的要求；内置的摘要结构与字数约束不可移除。</p><textarea id="agent-prompt-compaction" v-model="prompts.compaction" class="agent-prompt-input" rows="4" maxlength="8000" placeholder="留空使用内置默认" aria-describedby="agent-prompt-compaction-help"></textarea><details class="agent-prompt-default"><summary>查看内置默认</summary><pre>{{ DEFAULT_COMPACTION_SYSTEM_PROMPT }}</pre></details></div></div>
      </fieldset>
      <p v-if="!valid && loaded" id="agent-turn-validation" class="agent-error" role="alert">请检查输入：保留轮次须为 1–20 的整数，自定义提示词不超过 8000 字。</p><span v-else id="agent-turn-validation" class="agent-sr-only">保留轮次范围为 1 到 20 的整数，自定义提示词不超过 8000 字。</span>
      <div class="agent-save-bar"><div class="agent-save-status" aria-live="polite"><span v-if="message" class="agent-saved"><ModelProviderIcon name="check"/>{{ message }}</span><span v-else-if="dirty">修改尚未保存</span><span v-else>提问开关立即生效，其余设置用于新建任务</span></div><div class="agent-save-actions"><button class="agent-reset" type="button" :disabled="busy || loading || !loaded || isDefault" @click="resetDefaults">恢复默认值</button><button class="btn primary agent-save" type="submit" :disabled="busy || loading || !loaded || !valid || !dirty"><ModelProviderIcon :name="busy ? 'loader' : message ? 'check' : 'save'" :class="{ 'agent-spinning': busy }"/>{{ busy ? '正在保存…' : message ? '已保存' : '保存设置' }}</button></div></div>
      <div v-if="error" class="agent-error-panel" role="alert"><ModelProviderIcon name="alert"/><p>{{ error }}</p><button v-if="!loaded" class="btn" type="button" :disabled="loading" @click="load">重新读取</button><button v-else class="btn" type="button" :disabled="busy" @click="save">重试保存</button></div>
    </form>

    <section class="agent-explanation" aria-labelledby="agent-context-guide"><h2 id="agent-context-guide">整理时会发生什么</h2><dl class="agent-guide-list"><div><dt>一轮指什么？</dt><dd>你的一次输入，以及随后 Agent 的回复和工具过程。例如保留 3 轮，就是完整保留最近 3 次输入及对应过程。</dd></div><div><dt>历史会被删除吗？</dt><dd>不会。整理只改变后续请求交给模型的上下文，页面里的原始历史消息仍然保留；尚未处理的用户补充也不会被提前压缩。</dd></div><div><dt>会产生额外用量吗？</dt><dd>生成摘要需要调用模型，用量计入当前任务。没有足够的较早完整轮次时会跳过，不发起摘要请求。若上下文过大且无法安全整理，任务会报告问题并停止。</dd></div></dl></section>

    <section aria-labelledby="agent-runtime-policy"><div class="agent-section-heading"><h2 id="agent-runtime-policy">当前执行策略</h2><span class="agent-badge">只读说明</span></div><dl class="agent-policy-list settings-group"><div><dt>工具与任务</dt><dd>同一 Agent 的工具按顺序执行，不同任务仍可并行。子代理的启用与限制在“子代理”中单独设置。</dd></div><div><dt>重试与缓存</dt><dd>自动重试与缓存预热关闭。失败会如实报告，也不会为预热缓存额外发送模型请求。</dd></div><div><dt>技能与外部服务</dt><dd>不会自动加载宿主的其他上下文文件和扩展。技能须在“技能”中启用；MCP 服务须配置并确认信任；搜索服务须在“联网搜索”中配置。</dd></div><div><dt>单次输出上限</dt><dd>默认接所选模型的目录声明值，生效不超过其上下文窗口的 1/4；模型参数可手动指定。实际值在任务创建时固定。</dd></div><div><dt>文件与操作审批</dt><dd>Agent 在真实本机目录工作，文件范围取决于本机系统账号权限。修改或执行前是否询问，由任务的操作审批模式决定，可在“权限与文件”中查看。</dd></div></dl></section>
  </section>
</template>

<style scoped>
.agent-runtime-settings{display:flex;flex-direction:column;gap:24px;min-width:0;line-height:1.6}
.agent-runtime-settings h2{margin:0;font-size:var(--text-ui-lg);font-weight:500}
.agent-runtime-settings form{min-width:0}
.agent-scope-note{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-radius:8px;background:var(--selected);font-size:12px;color:var(--fg-subtle)}
.agent-scope-note>svg{width:16px;height:16px;margin-top:2px;flex:none}.agent-scope-note p{display:flex;flex-direction:column;gap:3px}.agent-scope-note strong{font-weight:500;color:var(--fg)}
.agent-section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}.agent-badge{font-size:11px;line-height:1.5;color:var(--fg-subtle);padding:3px 8px;border:1px solid var(--border);border-radius:6px;flex:none}
.agent-fields{margin:0;padding:0;min-width:0}.agent-setting-row{align-items:flex-start;padding:18px 16px;gap:24px}.agent-setting-copy{flex:1;min-width:0}.agent-setting-label{font-size:14px;font-weight:500;color:var(--fg);cursor:pointer}.agent-setting-copy p{font-size:13px;line-height:1.7;margin-top:5px;color:var(--fg-subtle)}.agent-inline-state,.agent-input-hint{display:block;font-size:12px;line-height:1.6;color:var(--fg-subtle);margin-top:8px}
.agent-runtime-settings .agent-switch{appearance:none;width:36px;height:22px;margin:2px 0 0;border-radius:16px;flex:none;position:relative;background:var(--selected);border:1px solid var(--border-hover);cursor:pointer;transition:background .15s}.agent-runtime-settings .agent-switch::after{content:'';position:absolute;width:14px;height:14px;top:3px;left:3px;border-radius:50%;background:var(--fg-subtle);transition:transform .15s}.agent-runtime-settings .agent-switch:checked{background:var(--fg);border-color:var(--fg)}.agent-runtime-settings .agent-switch:checked::after{left:3px;transform:translateX(14px);background:var(--bg)}.agent-switch:disabled{opacity:.5;cursor:default}
.agent-turn-control{display:flex;align-items:center;gap:8px;color:var(--fg-subtle);font-size:12px;flex:none;margin-top:2px}.agent-stepper{display:flex;align-items:center;height:34px;border:1px solid var(--border-hover);border-radius:7px;background:var(--bg-input);overflow:hidden}.agent-stepper:focus-within{outline:2px solid var(--fg-subtle);outline-offset:2px}.agent-stepper button{display:flex;align-items:center;justify-content:center;width:30px;height:32px;padding:0;border:0;background:transparent;color:var(--fg-subtle);font-size:17px}.agent-stepper button:hover:not(:disabled){background:var(--hover);color:var(--fg)}.agent-stepper input{appearance:textfield;-moz-appearance:textfield;width:36px;min-width:0;height:32px;border:0;background:transparent;color:var(--fg);padding:0;text-align:center;font-size:14px;outline:none}.agent-stepper input::-webkit-inner-spin-button,.agent-stepper input::-webkit-outer-spin-button{appearance:none;margin:0}
.agent-context-preview{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:12px;align-items:center;padding:16px;border-top:1px solid var(--border);background:var(--bg)}.agent-context-preview>div{display:flex;flex-direction:column;gap:3px;min-width:0}.agent-preview-label,.agent-context-preview small{color:var(--fg-subtle);font-size:12px}.agent-context-preview strong{font-size:13px;font-weight:500;color:var(--fg-subtle)}.agent-preview-plus{font-size:16px;color:var(--fg-subtlest);margin:0 12px}
.agent-save-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0 0;flex-wrap:wrap}.agent-save-status{font-size:12px;color:var(--fg-subtle);min-width:0}.agent-save-actions{display:flex;align-items:center;gap:12px;margin-left:auto}.agent-reset{padding:6px 0;border:0;background:transparent;color:var(--fg-subtle);font-size:12px}.agent-reset:hover:not(:disabled){color:var(--fg)}.agent-save{display:flex;align-items:center;gap:6px;min-height:34px}.agent-save>svg,.agent-saved>svg{width:14px;height:14px}.agent-saved{display:flex;align-items:center;gap:6px;color:var(--success)}
.agent-guide-list{display:grid;gap:14px;margin:14px 0 0}.agent-guide-list>div{display:grid;grid-template-columns:128px minmax(0,1fr);gap:16px;font-size:14px}.agent-guide-list dt{color:var(--fg-subtle);font-weight:500}.agent-guide-list dd{margin:0;color:var(--fg-subtle);line-height:1.8}
.agent-prompt-intro{margin:0;padding:10px 16px;font-size:12px;line-height:1.7;color:var(--fg-subtle);background:var(--bg);border-bottom:1px solid var(--border)}
.agent-prompt-row{padding:16px}.agent-prompt-input{width:100%;margin-top:10px;padding:10px 12px;border:1px solid var(--border-hover);border-radius:7px;background:var(--bg-input);color:var(--fg);font:inherit;font-size:13px;line-height:1.7;resize:vertical;min-height:74px}.agent-prompt-input:focus-visible{outline:2px solid var(--fg-subtle);outline-offset:1px}.agent-prompt-input::placeholder{color:var(--fg-subtlest)}
.agent-prompt-default{margin-top:8px;font-size:12px;color:var(--fg-subtle)}.agent-prompt-default summary{cursor:pointer;user-select:none;width:fit-content}.agent-prompt-default summary:hover{color:var(--fg)}.agent-prompt-default pre{margin:8px 0 0;padding:10px 12px;border:1px solid var(--border);border-radius:7px;background:var(--selected);color:var(--fg-subtle);font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto}
.agent-policy-list{margin:0}.agent-policy-list>div{display:grid;grid-template-columns:128px minmax(0,1fr);gap:16px;padding:14px 16px;font-size:14px;border-top:1px solid var(--border)}.agent-policy-list>div:first-child{border-top:0}.agent-policy-list dt{font-weight:500;color:var(--fg-subtle)}.agent-policy-list dd{margin:0;color:var(--fg-subtle);line-height:1.8;overflow-wrap:anywhere}
.agent-error,.agent-error-panel{color:var(--danger);font-size:12px}.agent-error{margin-top:8px}.agent-error-panel{display:flex;align-items:center;gap:10px;margin-top:12px;padding:12px;border:1px solid color-mix(in srgb,var(--danger) 30%,transparent);border-radius:8px}.agent-error-panel>svg{width:16px;height:16px;flex:none}.agent-error-panel p{flex:1;overflow-wrap:anywhere}.agent-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.agent-spinning{animation:agent-settings-spin .85s linear infinite}@keyframes agent-settings-spin{to{transform:rotate(360deg)}}
@media(max-width:767px){.agent-runtime-settings{gap:22px}.agent-setting-row{flex-wrap:nowrap!important;gap:12px}.agent-turn-control{align-self:flex-start}.agent-runtime-settings .agent-setting-row:has(.agent-turn-control){flex-wrap:wrap!important}.agent-runtime-settings .agent-setting-row:has(.agent-turn-control) .agent-setting-copy{flex-basis:100%}.agent-stepper input{font-size:16px}.agent-guide-list>div,.agent-policy-list>div{grid-template-columns:minmax(0,1fr);gap:5px}.agent-preview-plus{margin:0}.agent-context-preview{gap:8px;padding:14px}.agent-save-bar{gap:10px}.agent-error-panel{flex-wrap:wrap}.agent-error-panel p{min-width:0}}
@media(prefers-reduced-motion:reduce){.agent-spinning{animation:none}.agent-runtime-settings .agent-switch,.agent-runtime-settings .agent-switch::after{transition:none}}
</style>
