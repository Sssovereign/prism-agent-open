<script setup lang="ts">
// WorkspaceShell：侧栏 + 顶栏 + 连续会话 + 固定输入区 + 按需详情面板。
// 产品任务按项目隔离，统一使用真实 Agent 执行链。
import ResearchSetup from './components/ResearchSetup.vue';
import ResearchPanel, { type ResearchHandoffPrefill, type ResearchReviewDraft } from './components/ResearchPanel.vue';
import ResearchHandoffDialog from './components/ResearchHandoffDialog.vue';
import ConversationFind from './components/ConversationFind.vue';
import ContextHistoryPanel from './components/ContextHistoryPanel.vue';
import ConversationQueuePanel from './components/ConversationQueuePanel.vue';
import SelectionActions from './components/SelectionActions.vue';
import {loadShortcuts,shortcutFromEvent,SHORTCUT_COMMANDS,ignoredKeyEvent,globalShortcutBlocked} from './keyboardShortcuts';
import { ref, shallowRef, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import SettingsDialog from './components/SettingsDialog.vue';
import ToastHost from './components/ui/ToastHost.vue';
import type { ModelConfigView } from '../contracts/models';
import { uploadAttachment, MAX_ATTACHMENTS_PER_MESSAGE, type ComposerAttachment } from './conversation/attachments';
import { parseSlashSubmission, matchAppSlashCommand, type AppSlashCommand, type SkillSuggestionSource } from './conversation/promptTriggers';
import { appendPromptHistoryEntry, readPromptHistoryEntries, persistPromptHistoryEntries } from './conversation/promptHistory';
import { toast } from './ui/toast';
import { describeApiError, type ErrorPresentation } from './ui/errorPresentation';
import { loadPreferences, savePreferences, DEFAULT_PREFERENCES, type Preferences } from './preferences';
import { prismUpdates, refreshUpdateStatus, updateCenter } from './updates';
import LoginView from './LoginView.vue';
import TaskSidebar from './components/TaskSidebar.vue';
import TaskHeader from './components/TaskHeader.vue';
import TaskComposer from './components/TaskComposer.vue';
import ErrorBanner from './components/ErrorBanner.vue';
import InspectorDrawer from './components/InspectorDrawer.vue';
import { DEFAULT_DRAWER_WIDTH, DEFAULT_OUTPUT_WIDTH, clampDrawerWidth, drawerWidthBounds } from './layout/drawerWidth';
import { statusLabel, statusKind } from './status';
import { loadThemePref, setThemePref, applyTheme, type ThemePref } from './theme';
import { loadLanguagePref, setLanguagePref, t, type LanguagePref } from './ui/i18n/index';
import { v1, setCsrfToken,ApiError } from './api';
import { modeInfo, type WorkMode } from './modes';
import PrismLogo from './components/PrismLogo.vue';
import { RealRunSession } from './view-model/realRun';
import RealTimeline from './components/RealTimeline.vue';
import UserQuestionPanel from './components/UserQuestionPanel.vue';
import ConversationRail from './components/ConversationRail.vue';
import type { RailItem } from './components/ConversationRail.vue';
import type { ConversationTextRow } from '../contracts/conversation';
import TodoPanel from './components/TodoPanel.vue';
import UsageStatusBar from './components/UsageStatusBar.vue';
import CreateProjectDialog from './components/CreateProjectDialog.vue';
import EditProjectDialog from './components/EditProjectDialog.vue';
import SlashHelpDialog from './components/SlashHelpDialog.vue';
import type {ApprovalMode} from '../contracts/permissions';
import { APPROVAL_MODES, isApprovalMode } from '../contracts/permissions';
import { ComposerSubmissionLedger } from './view-model/composerSubmission';
import UpdateBanner from './components/UpdateBanner.vue';
import { startUpdatePolling } from './updateNotice';

function reloadPage(): void { location.reload(); }

const authState = ref<'checking' | 'anon' | 'authed'>('checking');
const username = ref('');
const projectName = ref('');
interface WorkspaceProject { id: string; name: string; archived: boolean;approvalMode?:ApprovalMode }
const projects = ref<WorkspaceProject[]>([]);
const permissionSaving=ref(false);
const projectApprovalMode=computed<ApprovalMode>(()=>projects.value.find(p=>p.id===projectId.value)?.approvalMode??'auto');
async function changeApprovalMode(mode:ApprovalMode){if(!projectId.value||permissionSaving.value)return;const id=projectId.value;permissionSaving.value=true;try{const saved=await v1<WorkspaceProject>(`/api/v1/projects/${id}`,{method:'PATCH',body:JSON.stringify({approvalMode:mode})});projects.value=projects.value.map(p=>p.id===id?saved:p);}catch(e){setActionError(e,t('app.approvalUpdateFailed'));}finally{permissionSaving.value=false;}}
const projectDialogOpen = ref(false);
const sidebarModalOpen = ref(false);
let projectEpoch = 0;
const settingsOpen = ref(false);
type SettingsSection='shortcuts'|'usage'|'subagents'|'memory'|'agent'|'general'|'appearance'|'models'|'websearch'|'permissions'|'projects'|'archives'|'account'|'advanced';
const settingsSection = ref<SettingsSection>();
const settingsConfigId=ref<string>();
const configs = ref<ModelConfigView[]>([]);
const binding = ref('');
const roleBindings = ref<Record<'pro'|'con'|'host',string>>({pro:'',con:'',host:''});
const preferences = ref<Preferences>(loadPreferences());
const filesGeneration = ref(0);
watch(preferences, value => savePreferences(value), {deep:true,immediate:true});
watch(username, value => { try { binding.value = value ? localStorage.getItem(`prism-model:${value}`) || '' : ''; } catch { binding.value = ''; } });
watch(username,value=>{ try { const data=JSON.parse(value?localStorage.getItem(`prism-role-models:${value}`) || '{}':'{}'); roleBindings.value={pro:typeof data.pro==='string'?data.pro:'',con:typeof data.con==='string'?data.con:'',host:typeof data.host==='string'?data.host:''}; } catch { roleBindings.value={pro:'',con:'',host:''}; } });
watch(roleBindings,value=>{if(username.value)try{localStorage.setItem(`prism-role-models:${username.value}`,JSON.stringify(value));}catch{/* optional non-secret preference */}},{deep:true});
watch(binding,value => { if(username.value) try { localStorage.setItem(`prism-model:${username.value}`,value); } catch { /* optional non-secret preference */ } thinkingOverride.value=''; });
// 任务窗口思考强度覆盖（''=跟随设置档位）。改档位即时写回模型条目（对齐ZCode persistAsWorkspaceLastUsed：
// 记住上次选择，下次任务与设置页同步）；写回失败（如他处已改配置）静默跳过，本次任务仍随建单覆盖值生效
const thinkingOverride = ref('');
async function onThinkingLevelChange(value:string){
  thinkingOverride.value=value;
  const [configId, modelId] = binding.value.split(':');
  if (!configId || !modelId) return;
  const config = configs.value.find(c => c.id === configId);
  if (!config) return;
  const models = config.models.map(m => m.modelId === modelId
    ? { ...m, parameters: Object.fromEntries(Object.entries({ ...m.parameters, ...(value ? { thinkingLevel: value } : { thinkingLevel: undefined }) }).filter(([, v]) => v !== undefined)) as ModelConfigView['models'][number]['parameters'] }
    : m);
  try {
    const updated = await v1<ModelConfigView>(`/api/v1/model-configs/${encodeURIComponent(configId)}`, {
      method: 'PATCH', body: JSON.stringify({ revision: config.revision, models }),
    });
    const idx = configs.value.findIndex(c => c.id === configId);
    if (idx >= 0) configs.value[idx] = updated;
  } catch { /* best-effort：下次任务回落设置档位 */ }
}
function onModelsChanged(value:ModelConfigView[]) { configs.value=value; for(const role of ['pro','con','host'] as const) if(roleBindings.value[role] && !value.some(c=>c.enabled && c.models.some(m=>m.enabled && `${c.id}:${m.modelId}`===roleBindings.value[role]))) roleBindings.value[role]=''; if(binding.value && !value.some(c=>c.enabled && c.models.some(m=>m.enabled && `${c.id}:${m.modelId}`===binding.value))) binding.value=''; }
function openSettings(section?:SettingsSection) { settingsSection.value=section;settingsConfigId.value=section==='models'?(binding.value.split(':')[0]||undefined):undefined; settingsOpen.value=true; }
async function onManagementChanged(){
 filesGeneration.value++;await loadProjects();
 if(projectId.value&&!projects.value.some(p=>p.id===projectId.value&&!p.archived))await selectWorkspaceProject(projects.value.find(p=>!p.archived)?.id||'');
 await refresh();const current=realSession.value;
 if(current)try{await v1(`/api/v1/runs/${current.runId}`);}catch(e){if(e instanceof ApiError&&e.status===404&&realSession.value===current)newTask();}
}
async function openManagedProject(id:string){settingsOpen.value=false;await selectWorkspaceProject(id);openFiles();}
function createManagedProject(){settingsOpen.value=false;openCreateProject();}
function resetPreferences() { preferences.value={...DEFAULT_PREFERENCES}; onTheme('system'); onLanguage('system'); }
const error = ref('');
/** 当前错误的结构化元数据（code/requestId/恢复动作）；error清空时同步清除 */
const errorMeta = ref<ErrorPresentation | null>(null);
watch(error, value => { if (!value) errorMeta.value = null; });
/** 统一动作错误入口（对齐ZCode providerBusinessError模式）：code→恢复动作由errorPresentation解析，
 * 横幅按meta展示动作按钮与复制字段；文案仍以服务端message优先。 */
function setActionError(e: unknown, fallback: string): void {
  const presentation = describeApiError(e, fallback);
  error.value = presentation.message;
  errorMeta.value = presentation;
}
/** 引导类提示（非异常）：无code无动作。 */
function setGuidanceError(message: string): void { error.value = message; errorMeta.value = null; }
function clearError(): void { error.value = ''; errorMeta.value = null; }
function runErrorAction(): void {
  const kind = errorMeta.value?.action?.kind;
  if (kind === 'open-model-settings') openSettings('models');
  else if (kind === 'open-search-settings') openSettings('websearch');
  else if (kind === 'login') void logout();
}
const busy = ref(false);
const stopping = ref(false);
const workMode = ref<WorkMode>('ordinary');
const researchModels=ref<Record<string,string>>({});
const researchRounds=ref(2),researchSourceText=ref(''),researchSourceFiles=ref<string[]>([]);
// v2差异化配置：辩论「需要做决定」（命题+候选）、评审「被评对象+标准」；复核入口从辩论报告预填。
const researchDecision=ref<{proposition:string;candidates:Array<{text:string}>}|null>(null);
const researchSubject=ref<{title:string;content:string}|null>(null);
const researchCriteria=ref<Array<{text:string;mustHave:boolean}>>([{text:'',mustHave:false}]);
const researchReviewSource=ref<string|null>(null);
// 终态异议：随复核创建进入新run（后端校验目标指向来源研究的已发布主张或结论）。
const pendingObjections=ref<Array<{target:unknown;text:string}>>([]);
function resetResearchDraft(){
 researchDecision.value=null;researchSubject.value=null;researchCriteria.value=[{text:'',mustHave:false}];researchReviewSource.value=null;pendingObjections.value=[];
}
function researchChoices(mode:'debate'|'jury'){
 const actors=mode==='debate'?['pro','con','host']:['juror1','juror2','juror3','aggregate'];
 return Object.fromEntries(actors.map(actor=>{const value=researchModels.value[actor]||(actor in roleBindings.value?roleBindings.value[actor as 'pro'|'con'|'host']:'')||binding.value;const index=value.indexOf(':');return [actor,{modelConfigId:value.slice(0,index),modelId:value.slice(index+1)}];}));
}
function reviewResearch(draft:ResearchReviewDraft){
 if(!realSession.value||busy.value)return;
 resetResearchDraft();
 researchSubject.value=draft.subject;
 researchReviewSource.value=draft.sourceRunId;
 pendingObjections.value=draft.objections;
 workMode.value='jury';
 closeRealSession();
 activeConversationId.value=null;
 objective.value=draft.objective;
 error.value='';
 void nextTick(()=>document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus());
}
// —— 阶段④续聊与执行交接：研究面板恢复、继续对话、交接草稿 ——
const researchPanel=ref<InstanceType<typeof ResearchPanel>>();
const restoredResearch=ref<{runId:string;mode:'debate'|'jury';status:string;objective?:string}|null>(null);
const researchRestoreOpen=ref(true);
const handoffDialog=ref<{prefill:ResearchHandoffPrefill;sourceRunId:string}|null>(null);
const researchHandoffDraft=ref<{sourceRunId:string;items:string[]}|null>(null);
function continueConversation(){workMode.value='ordinary';void nextTick(()=>document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus());}
function onHandoffConfirm(payload:{objectiveText:string;sourceRunId:string;items:string[]}){
 researchHandoffDraft.value={sourceRunId:payload.sourceRunId,items:payload.items};
 objective.value=objective.value.trim()?`${objective.value.trim()}\n\n${payload.objectiveText}`:payload.objectiveText;
 handoffDialog.value=null;
 workMode.value='ordinary';
 void nextTick(()=>document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus());
}
const drafts = reactive<Record<string, string>>({});
// 输入草稿持久化：更新切换/意外重载后恢复输入内容（仅文本，不含附件）。
try { const saved=JSON.parse(localStorage.getItem('prism-drafts:v1') ?? 'null'); if (saved && typeof saved === 'object') for (const [k,v] of Object.entries(saved as Record<string,unknown>)) if (typeof v === 'string') drafts[k]=v; } catch { /* 损坏即忽略 */ }
let draftSaveTimer: ReturnType<typeof setTimeout> | undefined;
const persistDrafts = () => { try { const entries=Object.entries(drafts); const trimmed = entries.length > 40 ? entries.slice(-40) : entries; localStorage.setItem('prism-drafts:v1', JSON.stringify(Object.fromEntries(trimmed))); } catch { /* optional persistence */ } };
const draftRevisions = reactive<Record<string, number>>({});
const submissionLedger = new ComposerSubmissionLedger();
const draftKey = computed(() => {
 if(realSession.value)return `task:${realSession.value.runId}`;
 if(workMode.value==='jury'&&researchReviewSource.value)return `new:${projectId.value}:review:${researchReviewSource.value}`;
 return `new:${projectId.value}:${workMode.value}`;
});
const objective = computed({ get: () => drafts[draftKey.value] ?? '', set: (value: string) => { const scope=draftKey.value; drafts[scope]=value; draftRevisions[scope]=(draftRevisions[scope]??0)+1; } });
watch(drafts, () => { if (draftSaveTimer) clearTimeout(draftSaveTimer); draftSaveTimer = setTimeout(persistDrafts, 400); }, { deep: true });
// —— 块E2：composer图片附件（App侧持有：提交成功才清空，失败保留以便重试）——
const attachmentDrafts=reactive<Record<string,ComposerAttachment[]>>({});
const uploadScopes=reactive<Record<string,boolean>>({});
const uploadControllers=new Map<string,AbortController>();
const composerAttachments=computed({get:()=>attachmentDrafts[draftKey.value]??[],set:(items:ComposerAttachment[])=>{attachmentDrafts[draftKey.value]=items;}});
const attachmentUploading=computed(()=>!!uploadScopes[draftKey.value]);
const selectedModelVision = computed<boolean>(() => {
  const [configId, modelId] = binding.value.split(':');
  const config = configs.value.find(c => c.id === configId);
  const model = config?.models.find(m => m.modelId === modelId);
  if (!config || !model) return true; // 未选模型不拦：附件入口由其他条件约束
  // 图片能力由服务端按 pi-ai 模型目录解析并随配置下发；未知模型按不支持处理
  return model.visionSupported === true;
});
async function addComposerFiles(files: File[]): Promise<void> {
  const scope=draftKey.value,generation=sessionGeneration;
  if (!files.length || busy.value || uploadScopes[scope]) return;
  const room = MAX_ATTACHMENTS_PER_MESSAGE - (attachmentDrafts[scope]?.length??0);
  if (room <= 0) return;
  const controller=new AbortController();uploadControllers.set(scope,controller);uploadScopes[scope]=true;
  const failures: string[] = [];
  try {
    for (const file of files.slice(0, room)) {
      if(controller.signal.aborted||generation!==sessionGeneration)break;
      try {const uploaded=await uploadAttachment(file,controller.signal);if(!controller.signal.aborted&&generation===sessionGeneration)attachmentDrafts[scope]=[...(attachmentDrafts[scope]??[]),uploaded].slice(0,MAX_ATTACHMENTS_PER_MESSAGE);}
      catch (e) {if(!controller.signal.aborted)failures.push(e instanceof Error ? e.message : t('app.uploadFailed'));}
    }
  } finally {if(uploadControllers.get(scope)===controller){uploadControllers.delete(scope);delete uploadScopes[scope];}}
  if(failures.length&&generation===sessionGeneration&&scope===draftKey.value)toast(failures[0]!,{variant:'warning'});
}
function removeComposerAttachment(id: string): void {composerAttachments.value=composerAttachments.value.filter(a=>a.id!==id);}
function clearComposerAttachments(scope=draftKey.value): void {delete attachmentDrafts[scope];}
function clearAttachmentDrafts(): void {
 for(const controller of uploadControllers.values())controller.abort();uploadControllers.clear();
 for(const key of Object.keys(uploadScopes))delete uploadScopes[key];
 for(const key of Object.keys(attachmentDrafts))delete attachmentDrafts[key];
}
// —— 真实执行链状态（binding选择真实模型时启用）——
const projectId = ref('');
const grantId = ref('');
// —— 块E3：斜杠命令目录（App 层命令面板选中即执行、提交 /name args 同样分发）＋ 技能/文件 provider ——
// 目录对齐上游 ZCode 内置命令（help/new/goal/plan/init/compact/compress/stop/retry/resume/model/mode），
// 行为映射到棱镜既有能力；会话相关命令按当前状态进入目录，提交分发与面板共用同一目录。
const slashHelpOpen = ref(false);
const slashHelpQuery = ref('');
/** 授权模式展示标签（i18n 字典 approval.<mode>）。 */
function approvalModeLabel(mode: ApprovalMode): string { return t(`approval.${mode}`); }
/** /goal：ZCode goal 命令的棱镜映射——有会话时展示任务目标；无会话时填入新任务目标草稿。 */
function runGoalCommand(args: string): void {
  const text = args.trim();
  const current = realSession.value;
  if (current) {
    const goal = realRunMeta.value[current.runId]?.objective?.trim();
    if (!text) { toast(goal ? t('app.goal.current', { goal: goal.length > 120 ? `${goal.slice(0, 120)}…` : goal }) : t('app.goal.none'), { variant: 'info' }); return; }
    toast(t('app.goal.immutable'), { variant: 'info' });
    return;
  }
  if (text) { objective.value = text; toast(t('app.goal.filled'), { variant: 'info' }); return; }
  toast(objective.value.trim() ? t('app.goal.draft', { goal: objective.value.trim() }) : t('app.goal.usage'), { variant: 'info' });
}
/** /mode：展示当前授权模式或按参数切换（ask/auto/full，同输入区授权菜单）。 */
function runModeCommand(args: string): void {
  const value = args.trim().toLowerCase();
  if (!value) { toast(t('app.mode.current', { mode: approvalModeLabel(projectApprovalMode.value), modes: APPROVAL_MODES.join('|') }), { variant: 'info' }); return; }
  if (!isApprovalMode(value)) { toast(t('app.mode.unknown', { value, modes: APPROVAL_MODES.join(' / ') }), { variant: 'warning' }); return; }
  void changeApprovalMode(value);
}
/** /plan、/init：提示词展开命令（上游 custom command 展开语义）——拼装指令后走正常提交链。 */
function runPromptCommand(instruction: string, args: string, usage: string): void {
  const text = args.trim();
  if (!text) { toast(t('app.usage', { usage }), { variant: 'warning' }); return; }
  objective.value = `${instruction}${text}`;
  void nextTick(() => { void submitCurrent(); });
}
const PLAN_INSTRUCTION = '请先分析任务并给出完整执行计划（步骤、涉及文件、风险与验证方式），在我确认计划前不要开始修改。任务：';
const INIT_INSTRUCTION = '请检查当前项目的工作区结构与既有约定，创建或更新项目根目录的 AGENTS.md 工作说明；文件已存在时在其内容基础上修订，不要整体覆盖。';
const appSlashCommands = computed<AppSlashCommand[]>(() => {
  const session = realSession.value;
  const status = session?.status.value;
  // 可压缩/可停止/可重试集合与状态栏和重试按钮的既有门禁一致
  const compactable = !!status && ['queued', 'running', 'waiting_approval', 'waiting_input'].includes(status);
  const retryable = !!status && ['failed', 'cancelled'].includes(status);
  return [
    { value: 'help', description: t('app.slash.help'), usage: '/help [命令]', keywords: ['help', '帮助', '命令', 'commands'], run: (args) => { slashHelpQuery.value = args ?? ''; slashHelpOpen.value = true; } },
    { value: 'new', aliases: ['clear'], description: t('app.slash.new'), usage: '/new', keywords: ['new', 'clear', '新任务', '清空', '会话'], run: () => newTask() },
    { value: 'goal', aliases: ['target'], description: t('app.slash.goal'), usage: '/goal [目标]', keywords: ['goal', 'target', '目标'], run: (args) => runGoalCommand(args ?? '') },
    { value: 'plan', description: t('app.slash.plan'), usage: '/plan <任务>', keywords: ['plan', '计划', '规划'], run: (args) => runPromptCommand(PLAN_INSTRUCTION, args ?? '', '/plan <任务>') },
    { value: 'init', description: t('app.slash.init'), usage: '/init [补充说明]', keywords: ['init', 'agents', '说明', '规则'], run: (args) => runPromptCommand(INIT_INSTRUCTION, args ?? '', '/init [补充说明]') },
    { value: 'model', description: t('app.slash.model'), usage: '/model', keywords: ['model', '模型', '切换'], run: () => openSettings('models') },
    { value: 'mode', description: t('app.slash.mode'), usage: '/mode [ask|auto|full]', keywords: ['mode', '授权', '权限', 'approval'], run: (args) => runModeCommand(args ?? '') },
    ...(compactable ? [{ value: 'compact', aliases: ['compress'], description: t('app.slash.compact'), usage: '/compact', keywords: ['compact', 'compress', '压缩', '上下文', 'context'], run: () => { void compactCurrent(); } }] : []),
    ...(canStop.value ? [{ value: 'stop', description: t('app.slash.stop'), usage: '/stop', keywords: ['stop', '停止', '取消', 'cancel'], run: () => { void stopRun(); } }] : []),
    ...(retryable && session ? [{ value: 'retry', description: t('app.slash.retry'), usage: '/retry', keywords: ['retry', '重试', '失败'], run: () => { void retryRun(session.runId); } }] : []),
    ...(status === 'waiting_input' ? [{ value: 'resume', aliases: ['continue'], description: t('app.slash.resume'), usage: '/resume', keywords: ['resume', 'continue', '恢复', '继续'], run: () => { void resumeRun(); } }] : []),
    { value: 'files', description: t('app.slash.files'), usage: '/files', keywords: ['files', '文件', '目录', 'folder'], run: () => openFiles() },
    { value: 'settings', description: t('app.slash.settings'), usage: '/settings', keywords: ['settings', '设置', 'preferences'], run: () => openSettings() },
  ];
});
/** 提交路径命令分发（上游提交解析语义）：整条输入命中目录命令 → 本地执行并清空命令草稿；
 *  未收录的斜杠文本不拦截，按普通任务发送（与上游一致，避免误伤以 / 开头的普通提问）。 */
function dispatchSlashSubmission(text: string): boolean {
  const parsed = parseSlashSubmission(text);
  if (!parsed) return false;
  const command = matchAppSlashCommand(appSlashCommands.value, parsed.name);
  if (!command) return false;
  const scope = draftKey.value;
  if (drafts[scope]?.trim() === text) delete drafts[scope];
  command.run(parsed.args);
  return true;
}
const slashSkills = ref<SkillSuggestionSource[]>([]);
let skillsLoadTicket=0;
watch([projectId, authState, settingsOpen], async () => {
  const ticket=++skillsLoadTicket;
  if(settingsOpen.value)return;
  if (authState.value !== 'authed') { slashSkills.value = []; return; }
  const pid = projectId.value;
  try {
    const catalog = await v1<{ skills: Array<import('../contracts/skills').SkillEntry> }>(`/api/v1/skills${pid?`?projectId=${pid}`:''}`);
    if (ticket!==skillsLoadTicket || projectId.value !== pid) return;
    slashSkills.value = catalog.skills.filter(s => s.enabled).map(s => ({ name: s.name, displayName:s.displayName, icon:s.icon, description: s.description, path: s.path, scope: s.scope }));
  } catch { if (ticket===skillsLoadTicket && projectId.value === pid) slashSkills.value = []; }
}, { immediate: true });
const composerFileProvider = (relativePath: string) => v1<{ path: string; entries: Array<{ name: string; type: 'file' | 'directory' }> }>(`/api/v1/projects/${projectId.value}/files?grantId=${grantId.value}&relativePath=${encodeURIComponent(relativePath)}`);
// ＋ 菜单「会话」节：当前项目近期 Runs（引用对话），排除正打开的会话，最近优先；标题缺省取议题摘要。
const composerSessions = computed(() => {
  const currentRunId = realSession.value?.runId;
  return Object.entries(realRunMeta.value)
    .filter(([id]) => id !== currentRunId)
    .sort((a, b) => (b[1].createdAt ?? '').localeCompare(a[1].createdAt ?? ''))
    .slice(0, 8)
    .map(([id, meta]) => ({
      id,
      title: meta.title?.trim() || meta.objective.trim().slice(0, 40) || t('app.untitledSession'),
      description: statusLabel(meta.status),
    }));
});
// —— 块E5：输入历史（按项目持久化，提交成功后追加；composer 上下键回溯）——
const promptHistoryEntries = ref<string[]>([]);
watch([projectId, authState], ([pid, state]) => {
  promptHistoryEntries.value = state === 'authed' && pid ? readPromptHistoryEntries(`${username.value}:${pid}`) : [];
}, { immediate: true });
function pushPromptHistory(text: string): void {
  if (!projectId.value) return;
  const next = appendPromptHistoryEntry(promptHistoryEntries.value, text);
  promptHistoryEntries.value = next;
  persistPromptHistoryEntries(`${username.value}:${projectId.value}`, next);
}
const realSession = shallowRef<RealRunSession | null>(null);
watch([()=>realSession.value?.researchAnchor.value,workMode],([anchor,mode])=>{
 restoredResearch.value=anchor&&(anchor.mode==='debate'||anchor.mode==='jury')&&mode==='ordinary'
  ?{runId:anchor.runId,mode:anchor.mode,status:anchor.status,objective:anchor.objective}:null;
});
const realRunMeta = ref<Record<string, { objective: string; title?: string; conversationTitle?: string; conversationId: string; status: string; createdAt: string;approvalMode?:ApprovalMode }>>({});
const activeConversationId = ref<string | null>(null);
async function loadProjects() {
  const generation = sessionGeneration;
  const list = await v1<WorkspaceProject[]>('/api/v1/projects?limit=100');
  if (generation !== sessionGeneration || authState.value !== 'authed') return;
  projects.value = list.filter(p => !p.archived);
  let remembered = ''; try { remembered = localStorage.getItem(`prism-project:${username.value}`) ?? ''; } catch {}
  if (!projectId.value) await selectWorkspaceProject(projects.value.find(p => p.id === remembered)?.id ?? projects.value[0]?.id ?? '');
}
async function selectWorkspaceProject(id: string) {
  const p = projects.value.find(p => p.id === id);
  onProjectChange({ id, name: p?.name ?? '', grantId: '' });
  const epoch = projectEpoch;
  if (!id) return;
  try {
    const grants = await v1<Array<{ id: string; revoked: boolean }>>(`/api/v1/projects/${encodeURIComponent(id)}/grants`);
    if (epoch !== projectEpoch || id !== projectId.value) return;
    grantId.value = grants.find(g => !g.revoked)?.id ?? '';
    await refresh();
  } catch(e) { if (epoch === projectEpoch) setActionError(e, t('app.projectLoadFailed')); }
}
function onSidebarProjects(list: Array<{id:string;name:string;archivedAt:string|null;approvalMode?:ApprovalMode}>) {
  projects.value=list.map(p=>({id:p.id,name:p.name,archived:!!p.archivedAt,approvalMode:p.approvalMode}));
  if(projectId.value&&!projects.value.some(p=>p.id===projectId.value))void selectWorkspaceProject(projects.value.find(p=>!p.archived)?.id||'');
  else projectName.value=projects.value.find(p=>p.id===projectId.value)?.name||'';
}
async function openSidebarTask(task:{projectId:string;runId:string}) {
  if(task.projectId!==projectId.value)await selectWorkspaceProject(task.projectId);
  if(task.projectId!==projectId.value)return;
  sidebarOpen.value=false;await openRealRun(task.runId);
}
async function projectNewTask(id:string){await selectWorkspaceProject(id);if(projectId.value===id)newTask();}
async function projectFiles(id:string){await selectWorkspaceProject(id);if(projectId.value===id)openFiles();}
function onTaskArchived(task:{runId:string;conversationId:string}){if(realSession.value?.runId===task.runId||activeConversationId.value===task.conversationId)newTask();}
function openCreateProject() { projectDialogOpen.value = true; }
const editProject = ref<{ id: string; name: string }>();
async function onProjectEdited() {
  editProject.value = undefined;
  await onManagementChanged(); // 项目名/归档变化后刷新工作区项目集合与侧栏
  taskSidebar.value?.load(true);
}
async function onProjectCreated(p: WorkspaceProject & {grant:{id:string}}) {
  projectDialogOpen.value = false;
  if (!projects.value.some(project => project.id === p.id)) projects.value = [p, ...projects.value];
  filesGeneration.value++;
  await selectWorkspaceProject(p.id); sidebarOpen.value = false;
}
function loadStatusbarMode(): 'detailed' | 'compact' {
  try { return localStorage.getItem('prism-statusbar-mode') === 'compact' ? 'compact' : 'detailed'; } catch { return 'detailed'; }
}
const statusbarMode = ref<'detailed' | 'compact'>(loadStatusbarMode());
watch(statusbarMode, value => { try { localStorage.setItem('prism-statusbar-mode', value); } catch { /* optional preference */ } });
const realObjective = computed(() => selectedId.value ? realRunMeta.value[selectedId.value]?.objective ?? '' : '');
const realCanSubmit = computed(() => !!(projectId.value && grantId.value && binding.value));

const drawerOpen = ref(false);
const drawerTab = ref<'files' | 'browser' | 'delivery'>('files');
const sidebarOpen = ref(false);
const themePref = ref<ThemePref>(loadThemePref());
const languagePref = ref<LanguagePref>(loadLanguagePref());
const viewportWidth = ref(window.innerWidth);
const sidebarWidth = ref(264);
const preferredDrawerWidth = ref(DEFAULT_DRAWER_WIDTH);
const preferredOutputWidth = ref(DEFAULT_OUTPUT_WIDTH);
const sidebarCollapsed = ref(false);
const shellAnimating = ref(false);
let shellAnimationTimer: ReturnType<typeof setTimeout> | undefined;
function animateShellChange() {
  if(shellAnimationTimer)clearTimeout(shellAnimationTimer);
  shellAnimating.value=!preferences.value.reduceMotion&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 正常由实际网格过渡结束收尾；计时器仅兜底，避免低帧率时提前撤掉动画造成跳变。
  if(shellAnimating.value)shellAnimationTimer=setTimeout(()=>{shellAnimating.value=false;},600);
}
function finishShellTransition(event:TransitionEvent){if(event.target!==event.currentTarget||event.propertyName!=='grid-template-columns')return;if(shellAnimationTimer)clearTimeout(shellAnimationTimer);shellAnimating.value=false;}
const sidebarExpanded=computed(()=>viewportWidth.value>=1024?!sidebarCollapsed.value:sidebarOpen.value);
const occupiedSidebarWidth = computed(() => sidebarExpanded.value && viewportWidth.value >= 1280 ? sidebarWidth.value : 0);
const drawerBounds = computed(() => drawerWidthBounds(viewportWidth.value, occupiedSidebarWidth.value));
const drawerWidth = computed(() => clampDrawerWidth(drawerTab.value === 'delivery' ? preferredOutputWidth.value : preferredDrawerWidth.value, viewportWidth.value, occupiedSidebarWidth.value));
function setDrawerWidth(width: number) { const outputs = drawerTab.value === 'delivery'; if (outputs) preferredOutputWidth.value = width; else preferredDrawerWidth.value = width; try { localStorage.setItem(outputs ? 'prism-output-width-v2' : 'prism-drawer-width', String(width)); } catch { /* optional preference */ } }
function onDrawerResizing(active: boolean) { if (active) { if(shellAnimationTimer)clearTimeout(shellAnimationTimer);shellAnimating.value=false; } }
function openOutputs() { const wasOpen = drawerOpen.value && drawerTab.value === 'delivery'; drawerTab.value = 'delivery'; drawerOpen.value = !wasOpen; sidebarOpen.value = false; }
const overlayKind = computed(() => drawerOpen.value && viewportWidth.value < 1280 ? 'drawer' : sidebarOpen.value && viewportWidth.value < 1024 ? 'sidebar' : '');
let overlayTrigger: HTMLElement | null = null;
let overlayFocusVersion=0;
watch(overlayKind, async (kind, previous) => {
  const focusVersion=++overlayFocusVersion;
  if (kind && !previous) {
    const focused = document.activeElement;
    overlayTrigger = focused instanceof HTMLElement && !focused.closest('.drawer, .sidebar') ? focused : document.querySelector<HTMLElement>(kind === 'drawer' ? '.tb-side button' : '.tb-menu');
  }
  await nextTick();
  if(focusVersion!==overlayFocusVersion)return;
  if (kind) (document.querySelector<HTMLElement>(`.${kind} [role="tab"][aria-selected="true"]`) ?? document.querySelector<HTMLElement>(`.${kind} button:not(:disabled)`))?.focus();
  else if (overlayTrigger?.isConnected) overlayTrigger.focus();
});
const timeline = ref<HTMLElement>();
const realTimeline = ref<InstanceType<typeof RealTimeline>>();
const compactBusy = ref(false);
const compactNotice = ref('');
let sessionGeneration = 0;
let resizeCleanup: (() => void) | undefined;

function clampSidebar(value: number) { return Math.round(Math.max(264, Math.min(value, Math.max(264, viewportWidth.value * .5)))); }
function saveSidebar() { try { localStorage.setItem('prism-sidebar-width', String(sidebarWidth.value)); } catch { /* optional preference */ } }
function onResize() {
  if(shellAnimationTimer)clearTimeout(shellAnimationTimer);shellAnimating.value=false;
  const width=window.innerWidth;
  // 抽屉打开状态只属于窄屏；跨过断点时清理，保留独立的桌面收起偏好。
  if((viewportWidth.value<1024)!==(width<1024))sidebarOpen.value=false;
  viewportWidth.value=width;sidebarWidth.value=clampSidebar(sidebarWidth.value);
}
function beginSidebarResize(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault(); resizeCleanup?.(); shellAnimating.value=false;
  const startX = event.clientX, width = sidebarWidth.value;
  const move = (next: PointerEvent) => { sidebarWidth.value = clampSidebar(width + next.clientX - startX); };
  const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); document.body.classList.remove('resizing-sidebar'); saveSidebar(); resizeCleanup = undefined; };
  resizeCleanup = end; document.body.classList.add('resizing-sidebar');
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
}
function resizeSidebarKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
  event.preventDefault(); sidebarWidth.value = event.key === 'Home' ? 264 : clampSidebar(sidebarWidth.value + (event.key === 'ArrowRight' ? 16 : -16)); saveSidebar();
}
function changeMode(mode: WorkMode) {
  if (workMode.value === mode) return;
  closeRealSession();
  resetResearchDraft();
  workMode.value = mode; activeConversationId.value=null; error.value = ''; sidebarOpen.value = false;
  // 输入优先：进入研究模式直接把光标放进议题输入框，明确「这里输入」。rAF 保证落在模式菜单收回焦点的 nextTick 之后。
  if (mode !== 'ordinary') void nextTick(() => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()));
}
function openFiles() {
  // 复用详情按钮的网格展开动画；仅在网格列真的会变化时启动，避免重复点击时白挂 600ms 兜底计时器。
  if (viewportWidth.value >= 1280 && (!drawerOpen.value || drawerTab.value !== 'files')) animateShellChange();
  drawerTab.value = 'files'; drawerOpen.value = true; sidebarOpen.value = false;
}
function onProjectChange(payload: { id: string; name: string; grantId: string }) {
  if (payload.id !== projectId.value) {
    projectEpoch++; closeRealSession(); activeConversationId.value = null;
    resetResearchDraft();
    realRunMeta.value = {}; error.value = '';
  }
  projectId.value = payload.id; projectName.value = payload.name; grantId.value = payload.grantId;
  if (payload.id && !projects.value.some(p => p.id === payload.id)) projects.value.push({ id: payload.id, name: payload.name, archived: false });
  try { if (username.value) localStorage.setItem(`prism-project:${username.value}`, payload.id); } catch {}
}


const selectedId = computed(() => realSession.value?.runId);
// needs_reconciliation（有未确认写入的中断）必须可停止：该状态的系统出口就是cancel后再重试
const canStop = computed(() => !!realSession.value && (realSession.value.isActive.value || ['waiting_input', 'needs_reconciliation'].includes(realSession.value.status.value)));
const headerStatus = computed(() => {
  if (!realSession.value) return null;
  const status = realSession.value.status.value;
  if(realSession.value.pendingQuestion.value)return {kind:'idle' as const,label:t('app.awaitingAnswer')};
  return { kind: statusKind(status), label: statusLabel(status) };
});

async function refresh() {
  const generation = sessionGeneration;
  const requestedProject = projectId.value, epoch = projectEpoch;
  // 刷新产品 Run 元数据，不覆盖进行中会话的本地状态。
  if (requestedProject) {
    try {
      const data = await v1<{ runs: Array<{ id: string; conversationId: string; status: string; createdAt: string; objective: string; title?: string;approvalMode?:ApprovalMode }> }>(`/api/v1/projects/${requestedProject}/runs`);
      if (generation !== sessionGeneration || authState.value !== 'authed' || epoch !== projectEpoch || requestedProject !== projectId.value) return;
      const next: typeof realRunMeta.value = {};
      for (const row of data.runs) {
        next[row.id] = { title:row.title, objective: row.objective, conversationId: row.conversationId, status: row.status, createdAt: row.createdAt,approvalMode:row.approvalMode??realRunMeta.value[row.id]?.approvalMode };
      }
      realRunMeta.value = next;
    } catch { /* 项目清单暂不可得时下次轮询再试 */ }
  }
}

async function openRealRun(id: string) {
  const epoch = projectEpoch, generation = sessionGeneration;
  closeRealSession();
  resetResearchDraft();
  error.value = '';
  workMode.value = 'ordinary';
  restoredResearch.value = null; researchRestoreOpen.value = true; researchHandoffDraft.value = null;
  const session = new RealRunSession(id);
  realSession.value = session;
  try {
    const detail = await v1<{ run: { mode:WorkMode; objective: string; title?: string; conversationTitle?: string; conversationId: string; status: string; createdAt: string;approvalMode?:ApprovalMode; model?: {configId?: string; configModelId: string} } }>(`/api/v1/runs/${id}`);
    if (epoch !== projectEpoch || generation !== sessionGeneration || realSession.value !== session) return;
    workMode.value=detail.run.mode;
    if (detail.run.model?.configId) binding.value = `${detail.run.model.configId}:${detail.run.model.configModelId}`;
    realRunMeta.value = { ...realRunMeta.value, [id]: { title:detail.run.conversationTitle, objective: detail.run.objective, conversationId: detail.run.conversationId, status: detail.run.status, createdAt: detail.run.createdAt,approvalMode:detail.run.approvalMode } };
    activeConversationId.value = detail.run.conversationId;
  } catch { /* 元数据缺失时时间线仍可用 */ }
  if (epoch !== projectEpoch || generation !== sessionGeneration || realSession.value !== session) { session.dispose(); return; }
  await session.start();
  void nextTick(() => { if (preferences.value.followOutput) realTimeline.value?.scrollToBottom(); });
}

function closeRealSession() {
  compactNotice.value='';
  if (realSession.value) { realSession.value.dispose(); realSession.value = null; }
}

function newTask() {
  overlayTrigger = null;
  sidebarOpen.value = false;
  closeRealSession();
  resetResearchDraft();
  activeConversationId.value = null;
  restoredResearch.value = null; researchRestoreOpen.value = true; researchHandoffDraft.value = null;

  error.value = '';
  void nextTick(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus());
}

async function create() {
  if (attachmentUploading.value || busy.value || permissionSaving.value || !objective.value.trim()) return;
  if(!binding.value){openSettings('models');return;}
  const generation = sessionGeneration, epoch = projectEpoch;
  const key = draftKey.value, text = objective.value, revision=draftRevisions[key]??0;
  const scopeSession=realSession.value, scopeConversation=activeConversationId.value;
  if (!projectId.value || !grantId.value) { setGuidanceError(t('app.createProjectGuidance')); return; }
  const [modelConfigId, modelId] = binding.value.split(':');
  if (!modelConfigId || !modelId) { setGuidanceError(t('app.invalidModelBinding')); return; }
  busy.value = true; error.value = '';
  try {
    if(workMode.value!=='ordinary'&&composerAttachments.value.length)throw new Error(t('app.researchTextOnly'));
    const researchMode=workMode.value==='ordinary'?null:workMode.value;
    const created = await v1<{ runId: string; conversationId: string; status: string }>(`/api/v1/projects/${encodeURIComponent(projectId.value)}/${researchMode?'research':'runs'}`, {
      method: 'POST', body: JSON.stringify(researchMode?{mode:researchMode,objective:text,rounds:researchRounds.value,models:researchChoices(researchMode),
        sources:researchSourceText.value.trim()?[{title:t('app.sharedSourceTitle'),content:researchSourceText.value}]:[],sourceFiles:researchSourceFiles.value.map(path=>({grantId:grantId.value,relativePath:path})),
        ...(researchMode==='debate'&&researchDecision.value?{decision:researchDecision.value}:{}),
        ...(researchMode==='jury'&&researchSubject.value?{subject:researchSubject.value,criteria:researchCriteria.value.filter(criterion=>criterion.text.trim())}:{}),
        ...(researchMode==='jury'&&researchReviewSource.value?{sourceRunId:researchReviewSource.value}:{}),
        ...(researchMode==='jury'&&researchReviewSource.value&&pendingObjections.value.length?{objections:pendingObjections.value}:{})}:{ objective: text, modelConfigId, modelId, conversationId: activeConversationId.value ?? undefined, attachmentIds: composerAttachments.value.map(a => a.id), ...(thinkingOverride.value ? { thinkingLevel: thinkingOverride.value } : {}), ...(researchHandoffDraft.value?{researchHandoff:{sourceRunId:researchHandoffDraft.value.sourceRunId,items:researchHandoffDraft.value.items}}:{}) }),
    });
    if (generation !== sessionGeneration || epoch !== projectEpoch) return;
    clearComposerAttachments(key);
    pushPromptHistory(text);
    const stillInScope=realSession.value===scopeSession && activeConversationId.value===scopeConversation && draftKey.value===key;
    if(stillInScope){researchReviewSource.value=null;pendingObjections.value=[];researchHandoffDraft.value=null;}
    if (drafts[key] === text && (draftRevisions[key]??0)===revision) delete drafts[key];
    realRunMeta.value = { ...realRunMeta.value, [created.runId]: { objective: text, conversationId: created.conversationId, status: created.status, createdAt: new Date().toISOString() } };
    if (stillInScope) await openRealRun(created.runId);
  } catch (e) {
    if(generation===sessionGeneration&&epoch===projectEpoch)setActionError(e,t('app.createFailed'));
  } finally { if(generation===sessionGeneration)busy.value=false; }
}

async function submitCurrent() {
  if (dispatchSlashSubmission(objective.value.trim())) return;
  const current = realSession.value;
  if (!current?.isActive.value) {
    // waiting_input/needs_reconciliation不是终态，直接create会被CONVERSATION_BUSY拒绝——引导用户走正确出口
    const status = current?.status.value;
    if (status === 'waiting_input') { setGuidanceError(t('app.waitingInputGuidance')); return; }
    if (status === 'needs_reconciliation') { setGuidanceError(t('app.needsReconciliationGuidance')); return; }
    await create(); return;
  }
  if (attachmentUploading.value || busy.value || current.busy.value) return;
  const scope=draftKey.value, text=objective.value, revision=draftRevisions[scope]??0;
  if (!text.trim()) return;
  const generation=sessionGeneration, claim=submissionLedger.claim({scope,text,revision});
  busy.value=true; error.value='';
  try {
    await current.steer(text.trim(), claim.clientMessageId, composerAttachments.value.map(a => a.id));
    if(generation!==sessionGeneration)return;
    clearComposerAttachments(scope);
    pushPromptHistory(text.trim());
    const unchanged=submissionLedger.settle(claim,{scope,text:drafts[scope]??'',revision:draftRevisions[scope]??0});
    if(unchanged)delete drafts[scope];
    if(realSession.value===current)await nextTick(()=>realTimeline.value?.scrollToBottom());
  } catch(e) {
    // A transport failure may follow a successful enqueue; retry keeps the same identity.
    if(generation===sessionGeneration&&realSession.value===current)setActionError(e,t('app.steerUnconfirmed'));
  } finally { if(generation===sessionGeneration)busy.value=false; }
}

async function compactCurrent() {
 const current=realSession.value;
 if(!current?.isActive.value||compactBusy.value)return;
 compactBusy.value=true;compactNotice.value='';
 try {
  await v1(`/api/v1/runs/${current.runId}/compact`,{method:'POST',body:JSON.stringify({})});
  if(realSession.value===current)compactNotice.value=t('app.compactAccepted');
 }catch(e){if(realSession.value===current)compactNotice.value=e instanceof Error?e.message:t('app.compactFailed');}
 finally{compactBusy.value=false;}
}

// —— 块E5：消息编辑（同会话回退重发）与轮尾分叉（新分支会话）——
function currentConversationId(): string {
  const current = realSession.value;
  return current ? realRunMeta.value[current.runId]?.conversationId ?? activeConversationId.value ?? '' : activeConversationId.value ?? '';
}
async function onForkEdit(payload: { messageId: string; text: string; onSuccess?:()=>void }) {
  const current = realSession.value;
  if (!current || busy.value) return;
  if (!binding.value) { openSettings('models'); return; }
  const [modelConfigId, modelId] = binding.value.split(':');
  if (!modelConfigId || !modelId) { setGuidanceError(t('app.invalidModelBinding')); return; }
  const conversationId = currentConversationId(),epoch=projectEpoch,generation=sessionGeneration;
  busy.value = true; error.value = '';
  try {
    const created = await v1<{ runId: string; conversationId: string; status: string }>(`/api/v1/conversations/${conversationId}/fork`, {
      method: 'POST', body: JSON.stringify({ cutMessageId: payload.messageId, cutMode: 'before', objective: payload.text, modelConfigId, modelId, ...(thinkingOverride.value ? { thinkingLevel: thinkingOverride.value } : {}) }),
    });
    if(generation!==sessionGeneration||epoch!==projectEpoch||realSession.value!==current)return;
    realRunMeta.value = { ...realRunMeta.value, [created.runId]: { objective: payload.text, conversationId: created.conversationId, status: created.status, createdAt: new Date().toISOString() } };
    payload.onSuccess?.();
    if(generation!==sessionGeneration||epoch!==projectEpoch||realSession.value!==current)return;
    pushPromptHistory(payload.text);
    closeRealSession();
    await openRealRun(created.runId);
  } catch (e) { if(generation===sessionGeneration&&epoch===projectEpoch&&realSession.value===current)setActionError(e,t('app.forkEditFailed')); } finally { if(generation===sessionGeneration)busy.value=false; }
}
async function onFork(messageId: string) {
  const current = realSession.value;
  if (!current || busy.value) return;
  const conversationId = currentConversationId(),epoch=projectEpoch,generation=sessionGeneration;
  busy.value = true; error.value = '';
  try {
    const res = await v1<{ conversationId: string; runId?: string }>(`/api/v1/conversations/${conversationId}/fork`, {
      method: 'POST', body: JSON.stringify({ cutMessageId: messageId, cutMode: 'through' }),
    });
    if(generation!==sessionGeneration||epoch!==projectEpoch||realSession.value!==current)return;
    closeRealSession();
      activeConversationId.value = res.conversationId;
    if(res.runId)await openRealRun(res.runId);

    toast(t('app.forked'), { variant: 'info' });
  } catch (e) { if(generation===sessionGeneration&&epoch===projectEpoch&&realSession.value===current)setActionError(e,t('app.forkFailed')); } finally { if(generation===sessionGeneration)busy.value=false; }
}

const retryingRunId=ref('');
async function retryRun(runId:string){
 const current=realSession.value;if(!current||busy.value||runId!==current.runId)return;
 const epoch=projectEpoch,generation=sessionGeneration;busy.value=true;retryingRunId.value=runId;error.value='';
 try{
  const detail=await v1<{attempts:Array<{id:string}>}>(`/api/v1/runs/${runId}`);
  const attemptId=detail.attempts[0]?.id;if(!attemptId)throw new Error(t('app.missingAttempt'));
  await v1(`/api/v1/runs/${runId}/retry`,{method:'POST',body:JSON.stringify({attemptId,...(current.status.value==='succeeded'?{regenerate:true}:{})})});
  if(generation===sessionGeneration&&epoch===projectEpoch&&realSession.value===current){await openRealRun(runId);await loadProjects();}
 }catch(e){if(generation===sessionGeneration&&epoch===projectEpoch&&realSession.value===current){setActionError(e,t('app.retryFailed'));if(e instanceof ApiError&&e.code==='CREDENTIAL_REQUIRED')openSettings('models');}}finally{retryingRunId.value='';if(generation===sessionGeneration)busy.value=false;}
}

async function resumeRun(){
 const current=realSession.value;if(!current||busy.value)return;
 const id=current.runId,epoch=projectEpoch;busy.value=true;error.value='';
 try{
  const detail=await v1<{run:{waiting:{reasonVersion:string}|null}}>(`/api/v1/runs/${id}`);
  if(!detail.run.waiting)throw new Error(t('app.runStateChanged'));
  await v1(`/api/v1/runs/${id}/resume`,{method:'POST',body:JSON.stringify({reasonVersion:detail.run.waiting.reasonVersion})});
  if(epoch===projectEpoch&&realSession.value===current)await openRealRun(id);
 }catch(e){setActionError(e,t('app.resumeFailed'));}finally{busy.value=false;}
}

async function stopRun() {
  const current = realSession.value;
  if (!current || stopping.value) return;
  stopping.value = true;
  try { await current.cancel(); }
  catch (e) { setActionError(e, t('app.stopFailed')); }
  finally { stopping.value = false; }
}

async function checkSession(): Promise<boolean> {
  try {
    const me = await v1<{ user: { username: string } }>('/api/v1/auth/me');
    username.value = me.user.username;
    authState.value = 'authed';
    return true;
  } catch { authState.value = 'anon'; return false; }
}

function clearWorkspace() {
  clearAttachmentDrafts();
  closeRealSession();
  projectEpoch++; projects.value = [];
  projectId.value = '';
  projectName.value = '';
  grantId.value = '';
  realRunMeta.value = {};
  activeConversationId.value = null;
  configs.value = [];
  binding.value = '';
  settingsOpen.value = false; projectDialogOpen.value = false; sidebarModalOpen.value = false; slashHelpOpen.value = false;
  for (const key of Object.keys(drafts)) delete drafts[key];
  for (const key of Object.keys(draftRevisions)) delete draftRevisions[key];
  submissionLedger.clear(); busy.value=false;
  workMode.value = 'ordinary';
  error.value = '';
  drawerOpen.value = false;
  sidebarOpen.value = false;
}

async function logout() {
  sessionGeneration++;
  if (timer) { clearInterval(timer); timer = undefined; }
  try { await v1('/api/v1/auth/logout', { method: 'POST' }); } catch { /* 会话已失效也按登出处理 */ }
  setCsrfToken(null);
  username.value = '';
  authState.value = 'anon';
  clearWorkspace();
}

function onPasswordChanged() {
  sessionGeneration++;
  if (timer) { clearInterval(timer); timer = undefined; }
  setCsrfToken(null);
  username.value = '';
  authState.value = 'anon';
  clearWorkspace();
  toast(t('app.passwordChanged'));
}

function onAuthenticated(user: { username: string }) {
  username.value = user.username;
  authState.value = 'authed';
  void start();
}

function onTheme(pref: ThemePref) {
  themePref.value = pref;
  setThemePref(pref);
}

function onLanguage(pref: LanguagePref) {
  languagePref.value = pref;
  setLanguagePref(pref);
}

function toggleDetail() {
  if (drawerOpen.value && drawerTab.value === 'delivery') { openFiles(); return; }
  drawerTab.value = 'files';
  if(viewportWidth.value>=1280)animateShellChange();
  drawerOpen.value = !drawerOpen.value;
  if (drawerOpen.value) sidebarOpen.value = false; // 窄屏抽屉互斥
}
function toggleSidebar() {
  if (viewportWidth.value >= 1024) { animateShellChange(); sidebarCollapsed.value = !sidebarCollapsed.value; return; }
  sidebarOpen.value = !sidebarOpen.value;
  if (sidebarOpen.value) drawerOpen.value = false;
}

// —— 会话左缘问题导航轨（ZCode TurnNavigator 复刻）：每条真实用户提问一线 ——
// assistantTexts 按轮内出现顺序收集执行过程正文与最终答复（对齐 d_t 的 assistantTextRows）；
// 运行中只把最后一线标记 running（对齐 d_t 的 isRunning 仅最后一行）。
const railItems = computed<RailItem[]>(() => {
  const session = realSession.value;
  if (!session) return [];
  const items: RailItem[] = [];
  for (const turn of session.turns.value) {
    for (const segment of turn.segments) {
      const texts = segment.history.filter((r): r is ConversationTextRow => r.kind === 'assistant' && !!r.text.trim()).map(r => r.text);
      if (segment.final?.text.trim()) texts.push(segment.final.text);
      for (const row of segment.rows) {
        if (row.kind !== 'user') continue;
        items.push({ id: row.id, runId: turn.id, queryText: row.text, createdAt: row.createdAt, assistantTexts: texts, running: false });
      }
    }
  }
  if (items.length && session.isActive.value) items[items.length - 1]!.running = true;
  return items;
});
// 活动线随滚动派生：取当前视口内（顶部 96px 阈值之上）最后一条已渲染的用户输入
const railActiveId = ref('');
function updateRailActive() {
  const region = timeline.value;
  if (!region || !railItems.value.length) { railActiveId.value = ''; return; }
  const top = region.getBoundingClientRect().top;
  let current = '';
  for (const item of railItems.value) {
    const el = region.querySelector(`[data-message-id="${CSS.escape(item.id)}"]`);
    if (el && el.getBoundingClientRect().top - top <= 96) current = item.id;
  }
  railActiveId.value = current;
}
watch(railItems, () => void nextTick(updateRailActive));
function locateRailItem(item: RailItem) { void realTimeline.value?.revealMessage(item.id, item.runId); }
const findOpen=ref(false),contextHistoryOpen=ref(false);
const shortcuts=ref(loadShortcuts(username.value));
const taskSidebar=ref<InstanceType<typeof TaskSidebar>>();
watch(username,value=>{shortcuts.value=loadShortcuts(value);});
const queuePanel=ref<InstanceType<typeof ConversationQueuePanel>>();
async function locateMessage(item:{id:string;runId:string;authorType?:string;phaseTaskId?:string}){
 const current=realSession.value;if(!current)return;
 // 阶段④：查找命中按run.mode分派——研究发言定位研究面板data-phase-id锚点，消息定位普通时间线
 if(item.authorType==='research'){
  if(restoredResearch.value?.runId===item.runId)researchRestoreOpen.value=true;
  else if(current.runId!==item.runId)await openRealRun(item.runId);
  await nextTick();
  if(item.phaseTaskId)await researchPanel.value?.revealPhase(item.phaseTaskId);
  return;
 }
 if(!current.runs.value.some(r=>r.id===item.runId))await openRealRun(item.runId);
 await nextTick();await realTimeline.value?.revealMessage(item.id,item.runId);
}
function quoteSelection(text:string){const quote=text.split('\n').map(line=>`> ${line}`).join('\n');if(!realSession.value&&workMode.value!=='ordinary'){if(researchSourceText.value.length+quote.length>20000){toast(t('app.quoteSourceLimit'),{variant:'warning'});return;}researchSourceText.value=`${researchSourceText.value}${researchSourceText.value?'\n\n':''}${quote}\n\n`;return;}if(objective.value.length+quote.length>20000){toast(t('app.quoteMessageLimit'),{variant:'warning'});return;}objective.value=`${objective.value}${objective.value?'\n\n':''}${quote}\n\n`;void nextTick(()=>document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus());}
// 研究草稿态：+ / @ 引用的文件与文件夹内容落入共同资料（提交时作为 sources 下发）。
// 研究共同资料：文本直接追加；文件引用只收相对路径chips，正文由服务端在发起时按授权导入
function appendResearchSource(payload:{text:string;kind:'file'|'session';path?:string}){
  if(payload.kind==='file'&&payload.path){
    if(researchSourceFiles.value.includes(payload.path)){toast(t('app.sourceFileDuplicate'),{variant:'info'});return;}
    if(researchSourceFiles.value.length>=20){toast(t('app.sourceFileLimit'),{variant:'warning'});return;}
    researchSourceFiles.value=[...researchSourceFiles.value,payload.path];return;
  }
  const next=`${researchSourceText.value}${researchSourceText.value?'\n\n':''}${payload.text}`;if(next.length>20000){toast(t('app.quoteSourceLimitExact'),{variant:'warning'});return;}researchSourceText.value=next;
}
function askSelection(text:string){newTask();quoteSelection(text);}
async function enqueueCurrent(){
 if(dispatchSlashSubmission(objective.value.trim()))return;
 const current=realSession.value;if(!current||!objective.value.trim()||attachmentUploading.value||busy.value)return;
 const scope=draftKey.value,text=objective.value,revision=draftRevisions[scope]??0,attachments=composerAttachments.value.map(a=>a.id),claim=submissionLedger.claim({scope:`${scope}:queue`,text,revision});
 busy.value=true;try{await v1(`/api/v1/runs/${current.runId}/queue`,{method:'POST',body:JSON.stringify({text,attachmentIds:attachments,clientKey:claim.clientMessageId})});
 if(realSession.value===current&&draftKey.value===scope&&objective.value===text&&(draftRevisions[scope]??0)===revision){objective.value='';clearComposerAttachments(scope);}await queuePanel.value?.refresh();
 }catch(e){setActionError(e,t('app.queueFailed'));}finally{busy.value=false;}
}
function onKeydown(e: KeyboardEvent) {
  if(ignoredKeyEvent(e))return;
  const combo=shortcutFromEvent(e),action=SHORTCUT_COMMANDS.find(c=>shortcuts.value[c.id]&&shortcuts.value[c.id]===combo)?.id;
  if (settingsOpen.value || projectDialogOpen.value || !!editProject.value || sidebarModalOpen.value || slashHelpOpen.value || globalShortcutBlocked()) return;
  if (e.key === 'Tab' && overlayKind.value) {
    const items = [...document.querySelectorAll<HTMLElement>(`.${overlayKind.value} button:not(:disabled), .${overlayKind.value} input:not(:disabled), .${overlayKind.value} select:not(:disabled), .${overlayKind.value} a[href]`)].filter(el => el.getClientRects().length && el.tabIndex >= 0);
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
  if(action&&action!=='thinking'&&authState.value==='authed'){if(action==='find'&&!realSession.value)return;e.preventDefault();if(action==='settings')openSettings();else if(action==='search'||action==='searchAlternate')taskSidebar.value?.openSearch();else if(action==='newTask')newTask();else if(action==='sidebar')toggleSidebar();else if(action==='find'&&realSession.value)findOpen.value=!findOpen.value;else if(action==='focusInput')document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();return;}
  if (e.key === 'Escape' && authState.value === 'authed') {
    if (drawerOpen.value) drawerOpen.value = false;
    else if (sidebarOpen.value) sidebarOpen.value = false;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let unsubscribeUpdateState: (() => void) | undefined;
let unsubscribeUpdateMenu: (() => void) | undefined;
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
function onSystemTheme() { if (themePref.value === 'system') applyTheme('system'); }
async function start() {
  if (timer) clearInterval(timer);
  if (!await checkSession()) return;
  applyTheme(themePref.value);
  const generation=sessionGeneration;
  try { await loadProjects(); } catch(e) { setActionError(e, t('app.projectListLoadFailed')); }
  try { const value=await v1<ModelConfigView[]>('/api/v1/model-configs'); if(generation===sessionGeneration && authState.value==='authed') onModelsChanged(value); } catch { /* settings can retry loading and show its error */ }
  await refresh();
  timer = setInterval(refresh, 1200);
}

onMounted(() => {
  try { const stored = localStorage.getItem('prism-output-width-v2'); if (stored !== null && Number.isFinite(Number(stored))) preferredOutputWidth.value = Number(stored); } catch { /* optional preference */ }
  try { const stored = localStorage.getItem('prism-drawer-width'); if (stored !== null && Number.isFinite(Number(stored))) preferredDrawerWidth.value = Number(stored); } catch { /* optional preference */ }
  try { const value = Number(localStorage.getItem('prism-sidebar-width')); if (value) sidebarWidth.value = clampSidebar(value); } catch { /* optional preference */ }
  window.addEventListener('resize', onResize);
  systemTheme.addEventListener('change', onSystemTheme);
  void start();
  window.addEventListener('keydown', onKeydown);
  startUpdatePolling(); // 服务端更新后提示刷新（对齐业界：启动一次+周期检查）
  unsubscribeUpdateState = prismUpdates?.onState(value => { updateCenter.status = value; });
  unsubscribeUpdateMenu = prismUpdates?.onMenu(() => openSettings('advanced'));
  void refreshUpdateStatus(); // 桌面更新状态预取（后台检查就绪时设置里即时可见）
});
onUnmounted(() => {
  unsubscribeUpdateState?.();
  unsubscribeUpdateMenu?.();
  clearAttachmentDrafts();
  if (timer) clearInterval(timer);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onResize);
  systemTheme.removeEventListener('change', onSystemTheme);
  resizeCleanup?.(); if(shellAnimationTimer)clearTimeout(shellAnimationTimer);
});
</script>

<template>
  <div v-if="authState !== 'authed'" class="desktop-blank-drag" aria-hidden="true"></div>
  <UpdateBanner @refresh="reloadPage" />
  <LoginView v-if="authState === 'anon'" @authenticated="onAuthenticated" />
  <p v-else-if="authState === 'checking'" class="boot-note">{{t('app.bootChecking')}}</p>
  <div v-else :inert="settingsOpen || projectDialogOpen || !!editProject || sidebarModalOpen || slashHelpOpen" class="shell" :class="{ 'with-drawer': drawerOpen, 'with-outputs': drawerOpen && drawerTab === 'delivery', 'sb-open': sidebarOpen, 'sb-collapsed': sidebarCollapsed, 'shell-animating':shellAnimating }" :style="{ '--sidebar-width': `${sidebarWidth}px`, '--drawer-width': `${drawerWidth}px` }" @transitionend="finishShellTransition">
    <TaskSidebar ref="taskSidebar" :shortcuts="shortcuts"
      :inert="overlayKind === 'drawer' || viewportWidth < 1024 && !sidebarOpen || viewportWidth >= 1024 && sidebarCollapsed" :projects="projects" :project-id="projectId" :conversation-id="activeConversationId" :selected-id="selectedId" :refresh-key="realSession ? `${realSession.runId}:${realSession.status.value}` : ''" :username="username" :project-name="projectName"
      @select-project="selectWorkspaceProject" @create-project="openCreateProject" @open-task="openSidebarTask" @project-task="projectNewTask" @project-files="projectFiles" @projects-updated="onSidebarProjects" @task-archived="onTaskArchived" @modal-change="sidebarModalOpen=$event" @new-task="newTask" @logout="logout" @open-files="openFiles" @open-settings="openSettings($event)" @close-sidebar="sidebarOpen=false" @edit-project="editProject=$event"
    />
    <div class="main-col" :inert="!!overlayKind">
      <TaskHeader
        @open-updates="openSettings('advanced')"
        :project-name="projectName" :mode="workMode" :title="realSession ? realRunMeta[realSession.runId]?.title || realObjective : ''" :status="headerStatus" :detail-open="drawerOpen" :detail-tab="drawerTab" :sidebar-expanded="sidebarExpanded" :eye-care="preferences.eyeCare"
        @open-outputs="openOutputs" @toggle-detail="toggleDetail" @toggle-sidebar="toggleSidebar" @change-mode="changeMode" @toggle-eye-care="preferences = { ...preferences, eyeCare: !preferences.eyeCare }"
      />
      <section class="conversation-region" :class="{ 'is-draft': !realSession }">
      <ConversationRail v-if="realSession" :items="railItems" :active-id="railActiveId" @locate="locateRailItem" />
      <div v-if="realSession" class="conversation-feature-actions"><button class="text-btn" type="button" :aria-expanded="findOpen" @click="findOpen=!findOpen">{{t('app.findConversation')}}</button><button class="text-btn" type="button" :aria-expanded="contextHistoryOpen" @click="contextHistoryOpen=!contextHistoryOpen">{{t('app.organizeHistory')}}</button></div>
      <ConversationFind v-if="realSession&&findOpen" :run-id="realSession.runId" @close="findOpen=false" @locate="locateMessage"/>
      <div v-if="realSession&&contextHistoryOpen" class="context-history-seat"><ContextHistoryPanel :run-id="realSession.runId"/></div>
      <div ref="timeline" class="timeline-scroll" @scroll="updateRailActive">
        <template v-if="realSession&&workMode!=='ordinary'">
          <ResearchPanel :key="realSession.runId" ref="researchPanel" :run-id="realSession.runId" :mode="workMode" :objective="realObjective" :status="realSession.status.value" :failure="realSession.failure.value?.message||realSession.stopReason.value||undefined" :busy="busy" @retry="retryRun(realSession.runId)" @review="reviewResearch" @settings="openSettings('models')" @continue="continueConversation" @handoff="handoffDialog={prefill:$event,sourceRunId:realSession.runId}" />
        </template>
        <template v-else-if="realSession&&restoredResearch">
          <section class="research-restore">
            <header class="research-restore-bar"><span>{{t('research.restoreTitle')}}</span><button class="text-btn" type="button" :aria-expanded="researchRestoreOpen" @click="researchRestoreOpen=!researchRestoreOpen">{{researchRestoreOpen?t('research.restoreCollapse'):t('research.restoreExpand')}}</button></header>
            <ResearchPanel v-if="researchRestoreOpen" :key="restoredResearch.runId" ref="researchPanel" :run-id="restoredResearch.runId" :mode="restoredResearch.mode" :objective="restoredResearch.objective||realObjective" :status="restoredResearch.status" :busy="busy" @review="reviewResearch" @settings="openSettings('models')" @continue="continueConversation" @handoff="handoffDialog={prefill:$event,sourceRunId:restoredResearch.runId}" />
          </section>
          <RealTimeline ref="realTimeline" :session="realSession" :objective="realObjective" :follow-output="preferences.followOutput" :busy="busy" :retrying="retryingRunId===realSession.runId" @open-settings="openSettings('models')" @resume="resumeRun" @retry="retryRun" @fork-edit="onForkEdit" @fork="onFork" />
        </template>
        <RealTimeline ref="realTimeline" v-else-if="realSession" :session="realSession" :objective="realObjective" :follow-output="preferences.followOutput" :busy="busy" :retrying="retryingRunId===realSession.runId" @open-settings="openSettings('models')" @resume="resumeRun" @retry="retryRun" @fork-edit="onForkEdit" @fork="onFork" />
        <div v-else class="empty-state">
          <PrismLogo class="empty-logo" />
          <h2>{{ workMode === 'ordinary' ? t('app.empty.ordinary.title') : workMode === 'debate' ? t('app.empty.debate.title') : t('app.empty.jury.title') }}</h2>
          <div class="empty-suggestions" v-if="workMode==='ordinary'"><button v-for="suggestion in [t('app.empty.suggestion1'),t('app.empty.suggestion2'),t('app.empty.suggestion3')]" :key="suggestion" @click="objective=suggestion">{{suggestion}}</button></div>
          <span>{{ workMode === 'ordinary' ? t('app.empty.ordinary.sub') : modeInfo(workMode).description }}</span>
        </div>
      </div>
      <TodoPanel v-if="realSession" :plan="realSession.todos.value" :is-streaming="realSession.isActive.value" />
      <div v-if="!realSession||workMode==='ordinary'||realSession.status.value!=='succeeded'" class="composer-seat" :class="{'has-session': !!realSession, 'has-research': !realSession&&workMode!=='ordinary'}">
      <ResearchSetup v-if="!realSession&&workMode!=='ordinary'" :mode="workMode" :configs="configs" :binding="binding" v-model:models="researchModels" v-model:rounds="researchRounds" v-model:source-text="researchSourceText" v-model:source-files="researchSourceFiles" v-model:decision="researchDecision" v-model:subject="researchSubject" v-model:criteria="researchCriteria" :project-id="projectId" :file-provider="composerFileProvider" />
      <ConversationQueuePanel v-if="realSession&&workMode==='ordinary'" ref="queuePanel" :run-id="realSession.runId" :active="realSession.isActive.value" @sent="$event!==realSession?.runId&&openRealRun($event)"/>
      <ErrorBanner v-if="error" :message="error" :detail="errorMeta?.detail" :code="errorMeta?.code" :request-id="errorMeta?.requestId" :action-label="errorMeta?.action?.label" dismissible @action="runErrorAction" @dismiss="clearError"/>
      <UserQuestionPanel v-if="realSession?.pendingQuestion.value" :key="realSession.pendingQuestion.value.id" :session="realSession" :request="realSession.pendingQuestion.value"/>
      <TaskComposer :shortcuts="shortcuts"
        v-model:objective="objective" v-model:binding="binding" :configs="configs" :preferences="preferences"
        :thinking-level="thinkingOverride" @update:thinking-level="onThinkingLevelChange"
        :mode="workMode" :approval-mode="realSession && canStop?(realRunMeta[realSession.runId]?.approvalMode||projectApprovalMode):projectApprovalMode" :permission-saving="permissionSaving" :busy="busy || permissionSaving || realSession?.busy.value === true" :can-stop="canStop" :stopping="stopping"
        :submit-disabled="!realCanSubmit && !!binding" :project-id="projectId" :projects="projects.filter(p=>!p.archived)" :new-task="!realSession" :live-session="!!realSession?.isActive.value"
        :attachments="composerAttachments" :attachment-uploading="attachmentUploading" :vision-supported="selectedModelVision" :source-mode="!realSession&&workMode!=='ordinary'"
        :app-commands="appSlashCommands" :skills="slashSkills" :file-provider="composerFileProvider" :history-entries="promptHistoryEntries" :sessions="composerSessions"
        @change-approval-mode="changeApprovalMode" @modal-change="sidebarModalOpen=$event" @select-project="selectWorkspaceProject" @create-project="openCreateProject" @submit="submitCurrent" @queue="enqueueCurrent" @stop="stopRun" @open-files="openFiles" @open-settings="openSettings('models')"
        @add-files="addComposerFiles" @remove-attachment="removeComposerAttachment" @insert-source="appendResearchSource"
      >
        <template v-if="realSession" #dock><UsageStatusBar :session="realSession" :mode="statusbarMode" :compact-busy="compactBusy" :compact-notice="compactNotice" @compact="compactCurrent" @toggle-mode="statusbarMode = statusbarMode === 'detailed' ? 'compact' : 'detailed'" /></template>
      </TaskComposer>
      </div>
      </section>
    </div>
    <div class="sidebar-resize" :inert="!!overlayKind" role="separator" :aria-label="t('app.resizeSidebar')" aria-orientation="vertical" :aria-valuemin="264" :aria-valuemax="Math.max(264, Math.floor(viewportWidth * .5))" :aria-valuenow="sidebarWidth" tabindex="0" @pointerdown="beginSidebarResize" @keydown="resizeSidebarKey" @dblclick="sidebarWidth = 264; saveSidebar()"></div>
    <button v-if="overlayKind" class="scrim" type="button" :aria-label="t('app.closeOverlay')" @click="drawerOpen = sidebarOpen = false"></button>
    <InspectorDrawer :key="filesGeneration"
      :open="drawerOpen" :tab="drawerTab" :width="drawerWidth" :min-width="drawerBounds.min" :max-width="drawerBounds.max" @update:width="setDrawerWidth" @resizing="onDrawerResizing" :active-project-id="projectId" :real-run-id="realSession?.runId ?? ''" :refresh-key="realSession?.status.value" :suppressed="settingsOpen || projectDialogOpen || !!editProject || sidebarModalOpen || slashHelpOpen"
      @close="drawerOpen = false" @update:tab="drawerTab = $event" @project-change="onProjectChange" @create-project="openCreateProject"
    />
    <SelectionActions :scope="timeline" :enabled="!settingsOpen&&!projectDialogOpen&&!overlayKind" @quote="quoteSelection" @new-task="askSelection"/>
    <CreateProjectDialog v-if="projectDialogOpen" @close="projectDialogOpen=false" @created="onProjectCreated" />
    <EditProjectDialog v-if="editProject" :project="editProject" @close="editProject=undefined" @saved="onProjectEdited" @deleted="onProjectEdited" />
    <SlashHelpDialog v-if="slashHelpOpen" :commands="appSlashCommands" :initial-query="slashHelpQuery" @close="slashHelpOpen=false" />
    <SettingsDialog :shortcuts="shortcuts" v-if="settingsOpen" :username="username" :project-id="projectId" :initial-section="settingsSection" :initial-config-id="settingsConfigId" :theme-pref="themePref" :language-pref="languagePref" :preferences="preferences" :configs="configs" :binding="binding" :role-bindings="roleBindings"
      @password-changed="onPasswordChanged" @shortcuts-changed="shortcuts=loadShortcuts(username)" @close="settingsOpen=false" @management-changed="onManagementChanged" @open-project="openManagedProject" @create-project="createManagedProject" @update:theme-pref="onTheme" @update:language-pref="onLanguage" @update:preferences="preferences=$event" @models-changed="onModelsChanged" @update:binding="binding=$event" @update:role-bindings="roleBindings=$event" @reset-preferences="resetPreferences" @permissions-changed="filesGeneration++" @open-files="settingsOpen=false;openFiles()" @logout="logout" />
  </div>
  <ResearchHandoffDialog v-if="handoffDialog" :prefill="handoffDialog.prefill" :source-run-id="handoffDialog.sourceRunId" @close="handoffDialog=null" @confirm="onHandoffConfirm" />
  <ToastHost />
</template>
