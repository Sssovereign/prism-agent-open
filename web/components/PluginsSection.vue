<script setup lang="ts">
import { ref } from 'vue';
import { v1 } from '../api';
import { toastSuccess, toastError } from '../ui/toast';

import type { SkillPackage, SkillCatalogEntry, SkillPackageCatalog } from '../../contracts/skills';
import UiIcon from './UiIcon.vue';

const packages=ref<SkillPackage[]>([]),source=ref(''),skillPath=ref(''),managing=ref(''),manageError=ref('');
const catalogEntries = ref<Array<SkillCatalogEntry & { installed: boolean }>>([]);
const loading = ref(true);

async function refresh() {
  loading.value = true;
  try {
    const [listRes, catalogRes] = await Promise.all([
      v1<SkillPackage[]>('/api/v1/skills/packages'),
      v1<SkillPackageCatalog>('/api/v1/skills/packages/catalog').catch(() => null),
    ]);
    packages.value = Array.isArray(listRes) ? listRes : [];
    catalogEntries.value = catalogRes?.entries ?? [];
  }
  catch (e) { toastError(e instanceof Error ? e.message : '读取插件列表失败'); }
  finally { loading.value = false; }
}
refresh();

async function manage(action:'install'|'update'|'remove',pkg?:SkillPackage){
  if(managing.value)return;
  managing.value=pkg?.id??'install';manageError.value='';
  try{
    const path='/api/v1/skills/packages'+(pkg?`/${encodeURIComponent(pkg.id)}${action==='update'?'/update':''}`:'');
    await v1(path,{method:action==='remove'?'DELETE':'POST',...(action==='install'?{body:JSON.stringify({source:source.value,skillPath:skillPath.value})}:{})});
    if(action==='install'){source.value='';skillPath.value='';}
    await refresh();toastSuccess(action==='remove'?'插件已卸载，下个任务生效':action==='update'?'插件已更新，下个任务生效':'插件已安装，其技能可在「技能」页启停',{dedupeKey:'plugins-manage'});
  }catch(e){manageError.value=e instanceof Error?e.message:'插件操作失败';}
  finally{managing.value='';}
}
async function installFromCatalog(entry: SkillCatalogEntry & { installed: boolean }) {
  if (managing.value || entry.installed) return;
  source.value = entry.source; skillPath.value = '';
  await manage('install');
}
</script>
<template>
<section class="plugins-section" aria-label="插件">
  <div class="plugins-install">
    <div><h3>添加插件</h3><p>插件是打包的技能集合：从本地目录、Git仓库或npm安装，使用Pi的包管理和技能解析。安装记录跟随当前本地账号保存；技能内容按需读取。</p></div>
    <form @submit.prevent="manage('install')" class="plugins-install-form"><input v-model="source" aria-label="插件来源" placeholder="https://github.com/作者/仓库、npm:包名 或 /本地/插件目录" :disabled="!!managing" required maxlength="2048"><button class="btn btn-solid" type="submit" :disabled="!!managing||!source.trim()"><UiIcon :name="managing==='install'?'refresh':'plus'" :class="{spin:managing==='install'}"/>{{managing==='install'?'正在安装…':'安装插件'}}</button></form>
    <label class="plugins-subpath">包内技能路径（可选）<input v-model="skillPath" aria-label="包内技能路径" placeholder="例如 skills/.curated/技能名；留空按Pi包声明发现" :disabled="!!managing" maxlength="1024"></label>
    <p>可安装单个SKILL.md目录、包含skills/的仓库，或声明pi.skills的包。固定版本示例：<code>npm:包名@1.0.0</code>、<code>git:github.com/作者/仓库@版本</code>。Git/npm包可能下载依赖并运行安装脚本，请选择了解的来源。</p>
    <div class="plugins-library-links"><a href="https://skills.sh/" target="_blank" rel="noopener noreferrer">浏览第三方技能</a><a href="https://agentskills.io/specification" target="_blank" rel="noopener noreferrer">技能格式说明</a></div>
    <p v-if="manageError" role="alert" class="plugins-manage-error">{{manageError}}</p>
  </div>
  <div v-if="catalogEntries.length" class="plugins-packages" aria-label="推荐插件">
    <h3>推荐插件</h3>
    <p class="plugins-catalog-hint">经核验的精选来源，走与手动安装相同的包管理通道；安装后同样可更新与卸载。安装来自第三方仓库的插件前请先查看其来源。</p>
    <div v-for="entry in catalogEntries" :key="entry.source" class="plugins-package">
      <div>
        <strong>{{ entry.name }}</strong>
        <span class="plugins-catalog-tag" :data-publisher="entry.publisherType">{{ entry.publisherType === 'official' ? '官方' : '社区' }}</span>
        <p>{{ entry.description }}</p>
        <small>{{ entry.publisher?.name ?? '' }}<template v-if="entry.keywords?.length"> · {{ entry.keywords.join(' / ') }}</template></small>
      </div>
      <div class="plugins-package-actions">
        <a v-if="entry.homepage" class="btn" :href="entry.homepage" target="_blank" rel="noopener noreferrer">查看来源</a>
        <button class="btn btn-solid" :disabled="!!managing || entry.installed" @click="installFromCatalog(entry)">{{ entry.installed ? '已安装' : (managing === 'install' ? '正在安装…' : '安装') }}</button>
      </div>
    </div>
  </div>
  <div v-if="packages.length" class="plugins-packages" aria-label="已安装插件"><h3>已安装插件</h3><div v-for="pkg in packages" :key="pkg.id" class="plugins-package"><div><strong>{{pkg.source}}</strong><code v-if="pkg.skillPath"> / {{pkg.skillPath}}</code><p><span class="plugins-component-count">技能 {{pkg.skills.length}}</span>{{pkg.skills.join(' · ')}}</p><small>版本 {{pkg.version.length===40?pkg.version.slice(0,12):pkg.version}} · {{new Date(pkg.installedAt).toLocaleString()}}</small></div><div class="plugins-package-actions"><button class="btn" :disabled="!!managing" @click="manage('update',pkg)"><UiIcon name="refresh" :class="{spin:managing===pkg.id}"/>更新</button><button class="btn" :disabled="!!managing" @click="manage('remove',pkg)">卸载</button></div></div></div>
  <p v-if="loading" class="settings-footnote" role="status">正在读取插件列表…</p>
  <p class="settings-footnote">插件是打包的技能集合（Pi 包：SKILL.md 目录、skills/ 仓库或声明 pi.skills 的包）；安装后其技能在「技能」页按来源插件分组展示、随插件装配，不单独启停；卸载插件即移除对应技能。同名优先级为项目、已安装包、个人目录、内置。变更在下一个任务生效，进行中的任务不受影响。</p>
</section>
</template>
<style scoped>
.plugins-section{display:grid;gap:12px}
.plugins-install{padding:20px;border:1px solid var(--border);border-radius:12px;display:grid;gap:12px;background:var(--bg-panel)}
.plugins-install h3,.plugins-packages h3{font-size:var(--text-ui-base);margin:0 0 6px;color:var(--fg)}.plugins-install p,.plugins-package p,.plugins-package small{font-size:var(--text-ui-caption);color:var(--fg-subtle);overflow-wrap:anywhere;margin:0;line-height:1.7}.plugins-install-form{display:flex;gap:8px}.plugins-subpath{display:grid;gap:6px;font-size:var(--text-ui-caption);color:var(--fg-subtle)}.plugins-subpath input{width:100%;border:1px solid var(--border);background:var(--bg-input);color:var(--fg);border-radius:8px;padding:10px 12px}.plugins-install-form input{flex:1;min-width:0;border:1px solid var(--border);background:var(--bg-input);color:var(--fg);border-radius:8px;padding:10px 12px}.plugins-install .btn,.plugins-package .btn{display:inline-flex;gap:6px;align-items:center;justify-content:center}.plugins-library-links{display:flex;gap:16px;font-size:var(--text-ui-caption)}.plugins-library-links a{color:var(--fg);text-underline-offset:3px}.plugins-install .plugins-manage-error{color:var(--danger)}.plugins-packages{display:grid;gap:8px}.plugins-package{display:flex;gap:12px;justify-content:space-between;align-items:center;padding:12px 16px;border:1px solid var(--border);border-radius:10px;background:var(--bg-panel)}.plugins-package>div:first-child{min-width:0;overflow-wrap:anywhere}.plugins-package strong{font-size:var(--text-ui-base)}.plugins-package-actions{display:flex;gap:8px;flex:none}
.plugins-catalog-hint{font-size:var(--text-ui-caption);color:var(--fg-subtle);margin:0;line-height:1.7}
.plugins-catalog-tag{display:inline-flex;margin-left:8px;border-radius:6px;padding:2px 6px;font-size:var(--text-ui-xs);color:var(--fg-subtle);background:var(--bg-surface,var(--bg-card));box-shadow:0 0 0 1px var(--border)}
.plugins-catalog-tag[data-publisher=official]{color:var(--color-progress-surface-foreground,var(--fg));background:var(--color-progress-surface,var(--bg-surface,var(--bg-card)))}
.plugins-component-count{display:inline-flex;margin-right:8px;border-radius:6px;padding:2px 6px;font-size:var(--text-ui-xs);color:var(--color-progress-surface-foreground,var(--fg));background:var(--color-progress-surface,var(--bg-surface,var(--bg-card)));box-shadow:0 0 0 1px var(--border)}
.spin{animation:plugins-spin 1s linear infinite}@keyframes plugins-spin{to{transform:rotate(360deg)}}
@media(max-width:640px){.plugins-install-form,.plugins-package{flex-direction:column;align-items:stretch}.plugins-package-actions{justify-content:flex-end}}
@media(prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
