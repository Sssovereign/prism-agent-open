<script setup lang="ts">
import { watch, ref, computed } from 'vue';
import { v1 } from '../api';
import { toastSuccess, toastError } from '../ui/toast';

import type { SkillEntry as SkillDto, SkillDiagnostic, SkillCatalog, SkillPackage } from '../../contracts/skills';
import FileIcon from './FileIcon.vue';

const props=defineProps<{projectId?:string}>();
const emit=defineEmits<{(e:'open-plugins'):void}>();
const skills = ref<SkillDto[]>([]);
const packages = ref<SkillPackage[]>([]);
const diagnostics = ref<SkillDiagnostic[]>([]);
const loading = ref(true);
const diagnosticsOpen = ref(false);
const detail = ref<SkillDto | null>(null);
const busyName = ref('');

const diagErrorCount = ref(0);
const diagWarningCount = ref(0);
// ZCode 划分模型（pluginCapabilityProjection/groupScopedSkillsBySource）：direct 技能
// 可启停可管理；插件技能只读成组（标题=插件名），启停/卸载由插件页管理。
function packageLabel(source:string):string{
  let s=source.replace(/^(git|npm):/,'');
  if(s.split('@').length>2)s=s.replace(/@[^@]+$/,'');
  const parts=s.split(/[/:]/).filter(Boolean);
  return parts.length>=2?parts.slice(-2).join('/'):parts[0]??s;
}
const directSkills = computed(()=>skills.value.filter(s=>s.origin!=='package'));
const packageGroups = computed(()=>packages.value.map(pkg=>({
  pkg,
  label:packageLabel(pkg.source),
  skills:skills.value.filter(s=>s.origin==='package'&&s.packageId===pkg.id),
})).filter(g=>g.skills.length));
const scopeLabel = (skill: SkillDto) => skill.scope === 'builtin' ? '内置' : skill.scope === 'workspace' ? '项目级' : skill.origin==='package' ? `插件：${packageLabel(skill.source??'')}` : '个人目录';

async function refresh() {
  loading.value = true;
  try {
    const data = await v1<SkillCatalog>(`/api/v1/skills${props.projectId?`?projectId=${encodeURIComponent(props.projectId)}`:''}`);
    skills.value = data.skills;
    packages.value = data.packages ?? [];
    diagnostics.value = data.diagnostics;
    diagErrorCount.value = data.diagnostics.filter(d => d.severity === 'error').length;
    diagWarningCount.value = data.diagnostics.length - diagErrorCount.value;
  }
  catch (e) { toastError(e instanceof Error ? e.message : '读取技能列表失败'); }
  finally { loading.value = false; }
}
watch(()=>props.projectId,()=>{void refresh();},{immediate:true});

async function toggle(skill: SkillDto, enabled: boolean) {
  busyName.value = skill.name;
  try {
    await v1(`/api/v1/skills/${encodeURIComponent(skill.name)}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) });
    skill.enabled = enabled;
    toastSuccess(enabled ? `技能 ${skill.name} 已启用，新任务生效` : `技能 ${skill.name} 已停用`,{dedupeKey:`skill-enabled:${skill.name}`});
  }
  catch (e) { toastError(e instanceof Error ? e.message : '切换失败'); }
  finally { busyName.value = ''; }
}
</script>
<template>
<section class="skills-section" aria-label="技能">
  <div class="skills-intro">
    <div><h3>技能能力视图</h3><p>技能是随任务装配进 Agent 上下文的能力单元。「已安装与内置」组（内置、个人与项目目录）可在此按名称启停；插件提供的技能按来源插件分组展示、随插件装配，不单独启停，由「插件」页统一管理。</p></div>
    <p>需要安装第三方技能集合？<button type="button" class="text-btn" @click="emit('open-plugins')">前往「插件」页</button>，从推荐目录或 Git/npm 来源安装。</p>
    <div class="skills-library-links"><a href="https://skills.sh/" target="_blank" rel="noopener noreferrer">浏览第三方技能</a><a href="https://agentskills.io/specification" target="_blank" rel="noopener noreferrer">技能格式说明</a></div>
  </div>
  <p class="settings-description">内置技能随棱镜提供，可直接启停。第三方插件按账号独立安装；下方个人／项目目录用于手动放置技能。同名优先级为项目、已安装包、个人目录、内置。技能是带 SKILL.md 说明的目录，按约定路径放置即可被发现：个人级 ~/.prism/skills，项目级 &lt;项目根&gt;/.prism/skills。已启用技能随新任务装配进 Agent 上下文。已有旧目录保持兼容；同名技能优先采用项目目录和新目录版本。</p>
  <div v-if="diagnostics.length" class="skills-diagnostics">
    <button type="button" class="skills-diagnostics-toggle" :aria-expanded="diagnosticsOpen" @click="diagnosticsOpen = !diagnosticsOpen">
      <svg class="skills-chevron" :class="{ 'skills-chevron-open': diagnosticsOpen }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="skills-warn-icon" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
      <span class="skills-diagnostics-summary">{{ diagErrorCount }} 个错误、{{ diagWarningCount }} 个警告（技能目录扫描）</span>
    </button>
    <ul v-if="diagnosticsOpen" class="skills-diagnostics-list">
      <li v-for="(d, index) in diagnostics" :key="`${d.code}-${d.path ?? 'none'}-${index}`">
        <div class="skills-diagnostics-head">
          <span class="skills-severity" :data-severity="d.severity">{{ d.severity === 'error' ? '错误' : '警告' }}</span>
          <span class="skills-code">{{ d.code }}</span>
          <span v-if="d.skillName" class="skills-diag-skill">· {{ d.skillName }}</span>
        </div>
        <p class="skills-diag-message">{{ d.message }}</p>
        <p v-if="d.path" class="skills-diag-path">{{ d.path }}</p>
      </li>
    </ul>
  </div>
  <div v-if="!loading && directSkills.length" class="skills-group">
    <h3 class="skills-group-title">已安装与内置 <span class="skills-group-count">{{ directSkills.length }}</span></h3>
    <div class="skills-list" role="list">
      <div v-for="skill in directSkills" :key="`${skill.scope}-${skill.name}`" class="skills-row" role="listitem">
        <div class="skills-row-icon" aria-hidden="true">
          <FileIcon :name="skill.icon??'SKILL.md'" :size="22"/>
        </div>
        <button type="button" class="skills-row-main" @click="detail = skill">
          <span class="skills-name">
            {{ skill.displayName ?? skill.name }}
            <span v-if="skill.disableModelInvocation" class="skills-badge">仅手动</span>
          </span>
          <span class="skills-desc">{{ skill.description || '（无描述，模型触发不可靠）' }}</span>
        </button>
        <div class="skills-row-actions">
          <span class="skills-scope">{{ scopeLabel(skill) }}</span>
          <label class="mcp-switch" :aria-label="`启用 ${skill.name}`">
            <input type="checkbox" :checked="skill.enabled" :disabled="busyName === skill.name" @change="toggle(skill, ($event.target as HTMLInputElement).checked)">
            <span class="mcp-switch-track" aria-hidden="true"></span>
          </label>
        </div>
      </div>
    </div>
  </div>
  <div v-for="group in packageGroups" :key="group.pkg.id" class="skills-group">
    <h3 class="skills-group-title">
      {{ group.label }}
      <span class="skills-group-count">{{ group.skills.length }}</span>
      <span class="skills-group-tag">来自插件</span>
    </h3>
    <div class="skills-list" role="list">
      <div v-for="skill in group.skills" :key="`pkg-${skill.packageId}-${skill.name}`" class="skills-row" role="listitem">
        <div class="skills-row-icon skills-row-icon-package" aria-hidden="true">
          <FileIcon :name="skill.icon??'SKILL.md'" :size="22"/>
        </div>
        <button type="button" class="skills-row-main" @click="detail = skill">
          <span class="skills-name">{{ skill.displayName ?? skill.name }}</span>
          <span class="skills-desc">{{ skill.description || '（无描述，模型触发不可靠）' }}</span>
        </button>
        <div class="skills-row-actions">
          <span class="skills-scope">随插件装配</span>
        </div>
      </div>
    </div>
    <p class="skills-group-footnote">此组技能来自插件（版本 {{ group.pkg.version.length===40?group.pkg.version.slice(0,12):group.pkg.version }}），随插件安装生效、卸载移除；如需管理请<button type="button" class="text-btn" @click="emit('open-plugins')">前往「插件」页</button>。</p>
  </div>
  <div v-if="!loading && !skills.length" class="skills-empty">
    <p class="mcp-empty-title">还没有发现技能</p>
    <p class="mcp-empty-desc">在 ~/.prism/skills 下建立目录并写入 SKILL.md（含 name 与 description frontmatter），或到「插件」页安装技能集合。启用后随新任务装配。</p>
  </div>
  <p v-if="loading" class="settings-footnote" role="status">正在扫描技能目录…</p>
  <p class="settings-footnote">文档技能在使用时检查生成库与预览工具，缺少依赖会提示；不会自动修改系统环境。技能内容由模型经读取工具按需加载；禁用的技能不参与装配。变更在下一个任务生效，进行中的任务不受影响。</p>
  <Teleport to="body">
    <div v-if="detail" class="skills-detail-backdrop" @click.self="detail = null">
      <section class="skills-detail" role="dialog" aria-modal="true" :aria-label="detail.name">
        <header><h3>{{ detail.displayName ?? detail.name }}</h3><button type="button" class="btn" @click="detail = null">关闭</button></header>
        <div class="skills-detail-body">
          <div class="skills-detail-desc">
            <h4>描述</h4>
            <p>{{ detail.description || '（无描述）' }}</p>
          </div>
          <div class="skills-detail-grid">
            <div><strong>调用名称</strong><p><code>/skill:{{detail.name}}</code></p></div><div v-if="detail.source"><strong>来源</strong><p>{{detail.source}}</p></div><div><strong>作用域</strong><p>{{ scopeLabel(detail) }}</p></div>
            <div><strong>状态</strong><p>{{ detail.enabled ? '已启用' : '已停用' }}</p></div>
            <div class="skills-detail-path"><strong>路径</strong><p class="skills-mono">{{ detail.path }}</p></div>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</section>
</template>
<style scoped>
.skills-intro{padding:20px;border:1px solid var(--border);border-radius:12px;display:grid;gap:10px;background:var(--bg-panel)}
.skills-intro h3{font-size:var(--text-ui-base);margin:0 0 6px;color:var(--fg)}
.skills-intro p{font-size:var(--text-ui-caption);color:var(--fg-subtle);overflow-wrap:anywhere;margin:0;line-height:1.7}
.skills-library-links{display:flex;gap:16px;font-size:var(--text-ui-caption)}
.skills-library-links a{color:var(--fg);text-underline-offset:3px}
.skills-section{display:grid;gap:12px}
.skills-group{display:grid;gap:8px}
.skills-group-title{margin:0;font-size:var(--text-ui-base);color:var(--fg);display:flex;align-items:center;gap:8px}
.skills-group-count{display:inline-flex;min-width:20px;justify-content:center;border-radius:999px;padding:1px 6px;font-size:var(--text-ui-sm);color:var(--fg-subtle);background:var(--bg-surface,var(--bg-card));box-shadow:0 0 0 1px var(--border)}
.skills-group-tag{display:inline-flex;border-radius:6px;padding:2px 6px;font-size:var(--text-ui-xs);color:var(--fg-subtle);background:var(--bg-surface,var(--bg-card));box-shadow:0 0 0 1px var(--border)}
.skills-group-footnote{margin:0;font-size:var(--text-ui-caption);color:var(--fg-subtle);line-height:1.7}
.skills-row-icon-package{color:var(--accent,#2563eb)}
.skills-list,.skills-empty{border:1px solid var(--border);border-radius:12px;background:var(--bg-card)}
.skills-list{overflow:hidden}
.skills-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--border);transition:background-color 150ms ease}
.skills-row:hover{background:var(--bg-surface-hover,var(--bg-card))}
.skills-row:first-child{border-top:0}
.skills-row-icon{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:12px;flex:none;color:var(--fg-subtle);background:var(--bg-card)}
.skills-row-main{display:grid;gap:2px;min-width:0;text-align:left;background:none;border:0;padding:0;cursor:default;border-radius:6px}
.skills-name{display:flex;align-items:center;gap:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-base);font-weight:500;color:var(--fg)}
.skills-badge{display:inline-flex;border-radius:6px;padding:2px 6px;font-size:var(--text-ui-sm);color:var(--fg-subtle);background:var(--bg-surface,var(--bg-card));box-shadow:0 0 0 1px var(--border)}
.skills-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-ui-sm);color:var(--fg-subtle)}
.skills-row-actions{display:flex;flex:none;align-items:center;gap:8px}
.skills-scope{font-size:var(--text-ui-sm);color:var(--fg-subtlest)}
.skills-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:40px 16px;text-align:center;border-style:dashed}
.skills-diagnostics{overflow:hidden;border-radius:8px;border:1px solid rgba(245,158,11,.4);background:rgba(245,158,11,.1)}
.skills-diagnostics-toggle{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;text-align:left;background:none;border:0;color:var(--fg);cursor:pointer;font-size:var(--text-ui-base)}
.skills-warn-icon{flex:none;color:var(--warning)}
.skills-diagnostics-summary{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.skills-chevron{flex:none;transition:transform 150ms ease}
.skills-chevron-open{transform:rotate(90deg)}
@media (prefers-reduced-motion:reduce){.skills-chevron{transition:none}}
.skills-diagnostics-list{list-style:none;margin:0;padding:8px 12px;border-top:1px solid rgba(245,158,11,.3);display:grid;gap:8px}
.skills-diagnostics-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.skills-severity{flex:none;font-size:var(--text-ui-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.skills-severity[data-severity=error]{color:var(--danger)}
.skills-severity[data-severity=warning]{color:var(--warning)}
.skills-code{font-weight:500;color:var(--fg)}
.skills-diag-skill{color:var(--fg-subtle)}
.skills-diag-message{margin:2px 0 0;color:var(--fg-subtle);font-size:var(--text-ui-base);overflow-wrap:anywhere}
.skills-diag-path{margin:2px 0 0;font:var(--text-ui-xs) var(--font-mono);color:var(--fg-subtle);word-break:break-all}
.skills-detail-backdrop{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px}
.skills-detail{width:min(576px,100%);max-height:min(80vh,640px);overflow:hidden;display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--border);background:var(--bg-card)}
.skills-detail header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:16px 16px 12px;border-bottom:1px solid var(--border)}
.skills-detail h3{margin:0;font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skills-detail-body{overflow:auto;padding:20px 16px;display:grid;gap:16px}
.skills-detail-desc h4,.skills-detail-grid strong{font-size:var(--text-ui-base);font-weight:500;color:var(--fg)}
.skills-detail-desc p{margin:4px 0 0;max-height:160px;overflow:auto;white-space:pre-wrap;font-size:var(--text-ui-base);line-height:1.75;color:var(--fg-subtle)}
.skills-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px}
.skills-detail-grid p{margin:4px 0 0;font-size:var(--text-ui-base);color:var(--fg-subtle);overflow-wrap:anywhere}
.skills-detail-path{grid-column:span 2}
.skills-mono{font-family:var(--font-mono);word-break:break-all}
/* Switch 复刻样式（与 McpSection.vue 同款，scoped 隔离故重复声明） */
.mcp-switch{position:relative;display:inline-flex;cursor:pointer}
.mcp-switch input{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.mcp-switch-track{display:inline-block;width:32px;height:18px;border-radius:9999px;background:var(--fg-subtlest);opacity:.4;transition:background-color 150ms ease,opacity 150ms ease;position:relative}
.mcp-switch-track::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:9999px;background:#fff;transition:transform 150ms ease}
.mcp-switch input:checked+.mcp-switch-track{background:var(--accent,#2563eb);opacity:1}
.mcp-switch input:checked+.mcp-switch-track::after{transform:translateX(14px)}
.mcp-switch input:disabled+.mcp-switch-track{opacity:.2;cursor:not-allowed}
.mcp-switch input:focus-visible+.mcp-switch-track{outline:2px solid var(--accent,#2563eb);outline-offset:2px}
</style>
