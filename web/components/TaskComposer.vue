<script setup lang="ts">
// 固定输入区：目标输入、模式选择、发送与停止。Enter发送、Shift+Enter换行，中文输入法组合期不触发。
// 真实执行链（binding非空）与示例执行共用输入区；运行中真实Run的Enter提交=补充注入（steer）。
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import PermissionModeMenu from './PermissionModeMenu.vue';
import ComposerSelect, { type ComposerSelectOption } from './ComposerSelect.vue';
import ComposerModelMenu from './ComposerModelMenu.vue';
import UiIcon from './UiIcon.vue';
import ControlHintTooltip from './ControlHintTooltip.vue';
import MentionPanel, { type MentionPanelSection } from './MentionPanel.vue';
import ComposerAddMenu from './ComposerAddMenu.vue';
import type {ApprovalMode} from '../../contracts/permissions';
import type { ModelConfigView } from '../../contracts/models';
import type { Preferences } from '../preferences';
import { modeInfo, type WorkMode } from '../modes';
import { MAX_ATTACHMENTS_PER_MESSAGE, formatAttachmentSize, attachmentRawUrl, isImageFile, type ComposerAttachment } from '../conversation/attachments';
import { toast } from '../ui/toast';
import {defaultBindings,formatShortcut,matchesShortcut,ignoredKeyEvent,plainKey,shouldSend,type ShortcutBindings} from '../keyboardShortcuts';
import {
  extractActivePromptInputTrigger, getPromptInputTriggerSignature, filterPromptInputSuggestions,
  buildAppSlashCommandSuggestions, buildSkillSuggestions, isAppSlashCommandSuggestion,
  removeActivePromptInputToken, replaceActivePromptInputTokenWithMarkdown,
  buildFileMentionMarkdown, buildSkillMentionMarkdown, scoreFuzzyMatch,
  type ActivePromptInputTrigger, type AppSlashCommand, type PromptInputSuggestionItem, type SkillSuggestionSource,
} from '../conversation/promptTriggers';
import { navigatePromptHistory } from '../conversation/promptHistory';
import { t } from '../ui/i18n/index';

const props = defineProps<{
  shortcuts?: ShortcutBindings;
  objective: string;
  approvalMode:ApprovalMode;
  permissionSaving?:boolean;
  projectId:string;
  projects:Array<{id:string;name:string}>;
  newTask?:boolean;
  configs: ModelConfigView[];
  binding: string;
  preferences: Preferences;
  busy: boolean;
  canStop: boolean;
  stopping: boolean;
  mode: WorkMode;
  /** 真实执行链前置条件不满足时禁用发送（无项目/授权/模型绑定） */
  submitDisabled?: boolean;
  /** 存在运行中的真实Run：Enter提交=补充注入 */
  liveSession?: boolean;
  /** 块E2：已上传附件（App侧持有，提交成功才清空，失败保留可重试） */
  attachments?: ComposerAttachment[];
  attachmentUploading?: boolean;
  /** 块E2：所选模型是否支持图片输入（服务端按pi目录解析下发）；false时禁用附件入口并明示 */
  visionSupported?: boolean;
  /** 块E3：App 层斜杠命令（选中即执行 UI 行为，不发送） */
  appCommands?: AppSlashCommand[];
  /** 块E3：技能目录（$ 引用与 / 面板技能分节） */
  skills?: SkillSuggestionSource[];
  /** 块E3：项目文件目录读取（@ 引用）；返回当前目录条目，调用方负责鉴权 */
  fileProvider?: (relativePath: string) => Promise<{ path: string; entries: Array<{ name: string; type: 'file' | 'directory' }> }>;
  /** ＋ 菜单「会话」节：近期会话引用（调用方按项目取 Runs，已排序并排除当前会话） */
  sessions?: Array<{ id: string; title: string; description?: string }>;
  /** 块E5：输入历史条目（App侧按项目读取/持久化，提交成功后追加） */
  historyEntries?: string[];
  /** 任务窗口思考强度覆盖（''=跟随设置档位）；选项由服务端目录结论（configs[].models[].thinkingLevels）派生 */
  thinkingLevel?: string;
}>();
const emit = defineEmits<{
  (e: 'update:objective', v: string): void;
  (e: 'update:binding', v: string): void;
  (e: 'update:thinkingLevel', v: string): void;
  (e: 'open-settings'): void;
  (e:'select-project',id:string):void;
  (e:'create-project'):void;
  (e:'change-approval-mode',mode:ApprovalMode):void;
  (e:'modal-change',active:boolean):void;
  (e: 'submit'): void;
  (e: 'queue'): void;
  (e: 'stop'): void;
  (e: 'open-files'): void;
  (e: 'add-files', files: File[]): void;
  (e: 'remove-attachment', id: string): void;
}>();

const box = ref<HTMLTextAreaElement>();
const fileInput = ref<HTMLInputElement>();
const dragOver = ref(false);
const realMode = computed(() => !!props.binding);
const projectOptions = computed<ComposerSelectOption[]>(() => props.projects.map(project => ({
  value: project.id, label: project.name, icon: 'folder',
})));

// 任务窗口思考强度：档位展示与调整统一在模型菜单内（上游合并菜单语义），''=跟随设置档位
const selectedComposerModel = computed(() => {
  const [configId, modelId] = props.binding.split(':');
  if (!configId || !modelId) return null;
  const config = props.configs.find(c => c.id === configId);
  return config?.models.find(m => m.modelId === modelId && m.enabled) ?? null;
});
// cycleThoughtLevel：使用已配置的思考快捷键，按目录档位顺序循环（无合成"默认"格）；
// 未指定（''）视为 -1，下一档即首档（上游 getNextThoughtLevelValue 同语义）
const composerRoot = ref<HTMLElement>();
function cycleThinkingLevel(): void {
  if (props.canStop || props.busy) return;
  const levels = selectedComposerModel.value?.thinkingLevels ?? [];
  if (levels.length < 2) return;
  const current = props.thinkingLevel || selectedComposerModel.value?.parameters?.thinkingLevel;
  const index = levels.findIndex(level => level === current);
  emit('update:thinkingLevel', levels[(Math.max(index, -1) + 1) % levels.length] ?? '');
}
function onDocKeydown(event: KeyboardEvent): void {
  if (!matchesShortcut(event, (props.shortcuts ?? defaultBindings()).thinking)) return;
  if (document.querySelector('[role=dialog][aria-modal=true], [role=alertdialog], [data-shortcut-recording]')) return;
  const target = event.target instanceof Element ? event.target : null;
  const inComposer = Boolean(composerRoot.value?.contains(target)) || Boolean(target?.closest('.composer-model-menu-panel, .composer-model-submenu'));
  if (!inComposer || props.canStop || props.busy || (selectedComposerModel.value?.thinkingLevels.length ?? 0) < 2) return;
  event.preventDefault();
  cycleThinkingLevel();
}

// 块E2：附件入口。无视觉能力的模型直接禁用并给出原因（计划E2“无vision供应商明示不可用”）
// 研究模式同样允许图片附件（服务端创建时冻结元数据+启动前按角色核验vision）
// 研究运行中的补充（steer）当前服务端只收文字：入口明示禁用，避免"能上传但发送必失败"的假可用
const attachDisabledReason = computed(() => {
  if (props.busy) return t('composer.busySubmitting');
  if (props.attachmentUploading) return t('composer.uploadingImages');
  if (props.liveSession && props.mode !== 'ordinary') return t('composer.steerTextOnly');
  if (props.visionSupported === false) return t('composer.noVision');
  if ((props.attachments?.length ?? 0) >= MAX_ATTACHMENTS_PER_MESSAGE) return t('composer.imageLimit', { max: MAX_ATTACHMENTS_PER_MESSAGE });
  return '';
});
const attachDisabled = computed(() => !!attachDisabledReason.value);

function collectImages(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter(f => f instanceof File && isImageFile(f));
}
function addFiles(files: FileList | File[] | null | undefined): void {
  if(attachDisabled.value)return;
  const images = collectImages(files);
  if (!images.length) return;
  const room = MAX_ATTACHMENTS_PER_MESSAGE - (props.attachments?.length ?? 0);
  if (room <= 0) return;
  emit('add-files', images.slice(0, room));
}
function onPaste(event: ClipboardEvent): void {
  // 粘贴截图：图片进附件而非文本框（无图片时保持默认文本粘贴行为）
  const images = collectImages(event.clipboardData?.files);
  if (!images.length) return;
  if (attachDisabled.value) {
    // 拦截必须明示：静默丢弃会让图片功能看起来"坏了"
    toast(attachDisabledReason.value || t('composer.imagesUnavailable'), { variant: 'warning' });
    return;
  }
  event.preventDefault();
  addFiles(images);
}
function onDragOver(event: DragEvent): void {
  // 始终preventDefault：避免把图片拖到输入区外时浏览器直接打开文件
  event.preventDefault();
  dragOver.value = !attachDisabled.value;
}
function onDrop(event: DragEvent): void {
  event.preventDefault();
  dragOver.value = false;
  const images = collectImages(event.dataTransfer?.files);
  if (!images.length) return;
  if (attachDisabled.value) {
    toast(attachDisabledReason.value || t('composer.imagesUnavailable'), { variant: 'warning' });
    return;
  }
  emit('add-files', images.slice(0, MAX_ATTACHMENTS_PER_MESSAGE - (props.attachments?.length ?? 0)));
}

// —— 块E3：斜杠命令＋@/$ 触发建议（上游 SlashCommandPlugin 语义的 textarea 移植）——
const MAX_FILE_SUGGESTIONS = 50;
const activeTrigger = ref<ActivePromptInputTrigger | null>(null);
const dismissedSignature = ref<string | null>(null); // Esc 关闭后同一 token 不再自动弹出，token 变化即重新武装
const selectedIndex = ref(0);
const fileEntries = ref<Array<{ name: string; type: 'file' | 'directory' }>>([]);
const filesLoading = ref(false);
const filesError = ref<string | null>(null);
let fileFetchToken = 0;

function textareaAroundCursor(): { before: string; after: string } | null {
  const el = box.value;
  if (!el || el.selectionStart !== el.selectionEnd) return null;
  const start = el.selectionStart ?? 0;
  return { before: el.value.slice(0, start), after: el.value.slice(start) };
}

/** 光标/文本变化后重算激活触发器；Esc 关闭过的 token 签名不重复弹出。 */
function syncTrigger(): void {
  const around = textareaAroundCursor();
  let trigger = around ? extractActivePromptInputTrigger(around.before) : null;
  const signature = getPromptInputTriggerSignature(trigger);
  if (!trigger || !signature || signature === dismissedSignature.value) {
    if (activeTrigger.value) activeTrigger.value = null;
    return;
  }
  const prev = activeTrigger.value;
  const changed = !prev || prev.trigger !== trigger.trigger || prev.query !== trigger.query;
  if (changed) selectedIndex.value = 0;
  activeTrigger.value = trigger;
  dismissedSignature.value = null;
}

const skillSuggestions = computed(() => buildSkillSuggestions(props.skills ?? []));
const slashSuggestions = computed(() => ([
  ...buildAppSlashCommandSuggestions(props.appCommands ?? []),
  ...skillSuggestions.value,
]));

/** @ 引用 query 支持路径前缀（`src/`），末段做模糊过滤；目录级进入替代上游全局索引。 */
function splitFileQuery(query: string): { dir: string; name: string } {
  const slash = query.lastIndexOf('/');
  return slash >= 0 ? { dir: query.slice(0, slash), name: query.slice(slash + 1) } : { dir: '', name: query };
}
const fileQuery = computed(() => splitFileQuery(activeTrigger.value?.trigger === '@' ? activeTrigger.value.query : ''));
const filteredFileSuggestions = computed<PromptInputSuggestionItem[]>(() => {
  if (activeTrigger.value?.trigger !== '@') return [];
  const { dir, name } = fileQuery.value;
  return fileEntries.value
    .map((entry, index) => ({ entry, index, score: scoreFuzzyMatch(entry.name, name) }))
    .filter((item): item is { entry: { name: string; type: 'file' | 'directory' }; index: number; score: number } => item.score !== null)
    .sort((left, right) => left.score !== right.score ? left.score - right.score : left.index - right.index)
    .slice(0, MAX_FILE_SUGGESTIONS)
    .map(({ entry }) => ({
      id: `file:${dir ? `${dir}/` : ''}${entry.name}`,
      trigger: '@' as const,
      value: entry.name,
      label: entry.name,
      description: entry.type === 'directory' ? t('composer.entryDirectory') : t('composer.entryFile'),
      data: { relativePath: dir ? `${dir}/${entry.name}` : entry.name, kind: entry.type },
    }));
});

async function loadFileEntries(dir: string): Promise<void> {
  const provider = props.fileProvider;
  if (!provider) { fileEntries.value = []; return; }
  const token = ++fileFetchToken;
  filesLoading.value = true; filesError.value = null;
  try {
    const result = await provider(dir || '.');
    if (token !== fileFetchToken) return; // 过期响应丢弃
    fileEntries.value = result.entries;
  } catch {
    if (token !== fileFetchToken) return;
    fileEntries.value = [];
    filesError.value = t('composer.filesLoadFailed');
  } finally {
    if (token === fileFetchToken) filesLoading.value = false;
  }
}
// 仅在 @ 面板激活时按目录读取；关闭即作废在途请求
watch(() => activeTrigger.value?.trigger === '@' ? fileQuery.value.dir : null, (dir) => {
  if (dir === null) { fileFetchToken += 1; filesLoading.value = false; return; }
  void loadFileEntries(dir);
}, { immediate: true });

// 面板分节：上游 slashCommandPanelSections（命令/技能）＋ @ 文件分节；标题与空态文案取上游 zh-CN 串。
const panelSections = computed<MentionPanelSection[]>(() => {
  const trigger = activeTrigger.value;
  if (!trigger) return [];
  const query = trigger.query.trim();
  if (trigger.trigger === '@') {
    return [{
      id: 'files', title: t('composer.panel.filesTitle'), options: filteredFileSuggestions.value.map(toPanelOption),
      loading: filesLoading.value, loadingText: t('composer.panel.searching'), emptyText: t('composer.panel.noFilesMatch'),
      errorText: filesError.value,
    }];
  }
  const source = trigger.trigger === '$' ? skillSuggestions.value : slashSuggestions.value;
  const filtered = filterPromptInputSuggestions(source, query);
  if (trigger.trigger === '$') {
    return [{ id: 'skills', title: t('composer.panel.skillsTitle'), options: filtered.map(toPanelOption), loading: false, emptyText: t('composer.panel.noSkillsMatch') }];
  }
  const commands = filtered.filter(isAppSlashCommandSuggestion);
  const skills = filtered.filter(s => s.trigger === '$');
  const appCount = buildAppSlashCommandSuggestions(props.appCommands ?? []).length;
  return [
    { id: 'commands', title: t('composer.panel.commandsTitle'), options: commands.map(toPanelOption), loading: false, emptyText: appCount === 0 ? t('composer.panel.noCommandsMatch') : t('composer.panel.noSlashMatch') },
    { id: 'skills', title: t('composer.panel.skillsTitle'), options: skills.map(toPanelOption), loading: false, emptyText: t('composer.panel.noSkillsMatch') },
  ];
});
function toPanelOption(s: PromptInputSuggestionItem) {
  // label 已在建议构造时带前缀（/命令、$技能、文件为文件名）
  return { id: s.id, label: s.label, description: s.description };
}
const flatSuggestions = computed(() => panelSections.value.flatMap(section => section.options.map(option => ({ section, option }))));
const panelOpen = computed(() => !!activeTrigger.value && ['/', '@', '$'].includes(activeTrigger.value.trigger));
const panelTitle = computed(() => activeTrigger.value?.trigger === '@' ? t('composer.panel.filesTitle') : activeTrigger.value?.trigger === '$' ? t('composer.panel.skillsTitle') : t('composer.panel.commandsAbilitiesTitle'));
const panelDescription = computed(() => activeTrigger.value?.query.trim() ? '' : activeTrigger.value?.trigger === '@' ? t('composer.panel.searchFiles') : activeTrigger.value?.trigger === '$' ? t('composer.panel.searchSkills') : t('composer.panel.searchCommands'));

function closePanel(signature: string | null): void {
  dismissedSignature.value = signature;
  activeTrigger.value = null;
}

// Snapshot the textarea selection just like ChatPromptActionMenu's editor-state snapshot.
let addMenuSelection:{text:string;start:number;end:number}|undefined;
function addMenuAnchor(){return composerRoot.value?.querySelector<HTMLElement>('.composer')??undefined;}
function onAddMenuOpen(open:boolean){
 if(!open)return;
 const text=props.objective;addMenuSelection={text,start:box.value?.selectionStart??text.length,end:box.value?.selectionEnd??text.length};
 closePanel(getPromptInputTriggerSignature(activeTrigger.value));
}
function insertFromAddMenu(payload:{text:string;kind:'file'|'command'|'skill'|'session';path?:string}){
 const saved=addMenuSelection;if(!saved||saved.text!==props.objective)return;
 const before=saved.text.slice(0,saved.start),after=saved.text.slice(saved.end);
 let result:{text:string;cursorOffset:number};
 const trigger=saved.start===saved.end?extractActivePromptInputTrigger(before):null;
 if((payload.kind==='file'&&trigger?.trigger==='@')||(payload.kind==='skill'&&trigger?.trigger==='$')){
  result=replaceActivePromptInputTokenWithMarkdown(before,after,payload.text)??{text:saved.text,cursorOffset:saved.start};
 }else{
  const leading=payload.kind!=='command'&&before&&!/\s$/.test(before)?' ':'';
  const trailing=payload.kind!=='command'&&!/^\s/.test(after)?' ':'';
  const inserted=leading+payload.text+trailing;
  result={text:before+inserted+after,cursorOffset:before.length+inserted.length};
 }
 if(result.text.length>20000){toast(t('composer.insertTooLong'),{variant:'warning'});return;}
 emit('update:objective',result.text);historyIndex.value=null;
 void nextTick(()=>{box.value?.focus({preventScroll:true});box.value?.setSelectionRange(result.cursorOffset,result.cursorOffset);void resize();});
}

function selectSuggestion(index: number): void {
  const flat = flatSuggestions.value[index];
  const around = textareaAroundCursor();
  const trigger = activeTrigger.value;
  if (!flat || !around || !trigger) return;
  const option = flat.option;
  // 由 id 反查建议：面板 option 只承载展示字段
  const source = trigger.trigger === '@' ? filteredFileSuggestions.value
    : trigger.trigger === '$' ? skillSuggestions.value
    : slashSuggestions.value;
  const suggestion = source.find(s => s.id === option.id) ??
    slashSuggestions.value.find(s => s.id === option.id);
  if (!suggestion) return;
  let replacement: { text: string; cursorOffset: number } | null;
  if (suggestion.trigger === '/' && isAppSlashCommandSuggestion(suggestion)) {
    replacement = removeActivePromptInputToken(around.before, around.after, suggestion.value);
  } else if (suggestion.trigger === '$') {
    replacement = replaceActivePromptInputTokenWithMarkdown(around.before, around.after, buildSkillMentionMarkdown(suggestion.value, suggestion.data?.path));
  } else if (suggestion.trigger === '@') {
    const markdown = buildFileMentionMarkdown(suggestion.data?.relativePath ?? suggestion.value, suggestion.value, suggestion.data?.kind === 'directory' ? 'directory' : 'file');
    replacement = replaceActivePromptInputTokenWithMarkdown(around.before, around.after, markdown);
  } else {
    replacement = replaceActivePromptInputTokenWithMarkdown(around.before, around.after, `/${suggestion.value}`);
  }
  if (!replacement) return;
  closePanel(null);
  emit('update:objective', replacement.text);
  void nextTick(() => {
    const el = box.value;
    if (el) { el.selectionStart = el.selectionEnd = replacement.cursorOffset; resize(); }
  });
  if (suggestion.trigger === '/' && isAppSlashCommandSuggestion(suggestion)) {
    (props.appCommands ?? []).find(c => c.value === suggestion.value)?.run();
  }
}

function onTextareaKeydown(e: KeyboardEvent): void {
  if (ignoredKeyEvent(e)) return;
  if (panelOpen.value && plainKey(e)) {
    const total = flatSuggestions.value.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); selectedIndex.value = Math.min(selectedIndex.value + 1, total - 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); selectedIndex.value = Math.max(selectedIndex.value - 1, 0); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanel(getPromptInputTriggerSignature(activeTrigger.value)); return; }
    if ((e.key === 'Enter' || e.key === 'Tab') && total > 0) {
      e.preventDefault(); e.stopPropagation();
      selectSuggestion(selectedIndex.value);
      return;
    }
  }
  // 块E5：输入历史回溯（上游 promptHistory 插件语义）——只在"空输入"或"已进入历史浏览态"时接管上下键，
  // 不抢多行输入的光标移动；建议面板打开时上下键归面板。
  if (!panelOpen.value && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.isComposing && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (historyIndex.value === null && props.objective.length > 0) return;
    const result = navigatePromptHistory(props.historyEntries ?? [], historyIndex.value, e.key === 'ArrowUp' ? 'up' : 'down');
    if (!result.shouldHandle) return;
    e.preventDefault(); e.stopPropagation();
    historyIndex.value = result.nextIndex;
    emit('update:objective', result.nextValue);
    void nextTick(resize);
    return;
  }
  composerKeydown(e);
}
function onTriggerBlur(): void {
  // 面板候选用 mousedown.prevent 保持输入框焦点；真实失焦（点击别处/Tab）即收起
  activeTrigger.value = null;
}
// 程序回填不触发 input；任何真实输入都退出历史浏览态。
const historyIndex = ref<number | null>(null);
function onTextareaInput(event: Event): void {
  emit('update:objective', (event.target as HTMLTextAreaElement).value);
  syncTrigger();
  historyIndex.value = null;
}

const sendDisabledReason = computed(() => {
  if (props.attachmentUploading) return t('composer.uploadingImages');
  if ((props.attachments?.length ?? 0) > 0 && props.visionSupported === false) return t('composer.send.noVisionRemove');
  if (props.busy) return t('composer.busySubmitting');
  if (!props.objective.trim()) return t('composer.send.empty');
  if (realMode.value && props.submitDisabled === true) return t('composer.send.notReady');
  return '';
});
const sendDisabled = computed(() => !!sendDisabledReason.value);

async function resize() {
  await nextTick();
  const el = box.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
}
watch(() => props.objective, resize);
onMounted(() => {
  resize();
  // 切档快捷键由输入区统一接管；capture让传送到body的模型菜单/滑杆也能使用，
  // 避免菜单自己的冒泡拦截及多处监听导致一次按键重复提交。
  document.addEventListener('keydown', onDocKeydown, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocKeydown, true);
});

function composerKeydown(e: KeyboardEvent): void {
  if (!shouldSend(e, props.preferences.sendShortcut)) return;
  e.preventDefault();
  if (sendDisabled.value) return;
  submit();
}
function submit() {
  if (!sendDisabled.value) emit('submit');
}
const caption = computed(() => {
  const sendKey = props.preferences.sendShortcut === 'enter' ? 'Enter' : formatShortcut('Mod+Enter');
  if (props.mode !== 'ordinary') return props.liveSession?t('composer.caption.researchLive'):t('composer.caption.researchDraft');
  if (!realMode.value) return t('composer.caption.pickModel');
  if (props.liveSession) return t('composer.caption.live', { shortcut: sendKey });
  if (props.submitDisabled) return t('composer.caption.needProject');
  return t('composer.caption.hint', { shortcut: sendKey });
});
</script>

<template>
  <div ref="composerRoot" class="composer-wrap" @dragover="onDragOver" @dragleave="dragOver = false" @drop="onDrop">
    <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden aria-hidden="true" @change="addFiles(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value=''" />
    <div class="composer" :class="{ 'drag-over': dragOver }">
      <div v-if="attachments?.length || attachmentUploading" class="composer-attachments" role="list" :aria-label="t('composer.attachmentsAria')">
        <span v-for="a in attachments" :key="a.id" class="composer-chip" role="listitem" :title="t('composer.chipTitle',{name:a.name,size:formatAttachmentSize(a.sizeBytes)})">
          <img :src="attachmentRawUrl(a.id)" :alt="a.name" />
          <button type="button" class="composer-chip-remove" :aria-label="t('composer.removeImageAria',{name:a.name})" @click="emit('remove-attachment', a.id)"><UiIcon name="x" :size="10" /></button>
        </span>
        <span v-if="attachmentUploading" class="composer-chip-uploading" role="status">{{t('composer.uploading')}}</span>
      </div>
      <p v-if="attachments?.length && visionSupported===false" class="composer-image-warning" role="alert">{{t('composer.noVisionWarning')}}</p>
      <textarea
        ref="box"
        :value="props.objective"
        rows="2"
        :placeholder="modeInfo(props.mode).placeholder"
        :aria-label="props.liveSession ? t('composer.inputAriaSteer') : t('composer.inputAriaGoal')"
        maxlength="20000"
        @input="onTextareaInput"
        @keydown="onTextareaKeydown"
        @paste="onPaste"
        @click="syncTrigger"
        @keyup="syncTrigger"
        @blur="onTriggerBlur"
      ></textarea>
      <div v-if="panelOpen" class="mention-anchor">
        <MentionPanel
          :title="panelTitle" :description="panelDescription" :trigger="activeTrigger!.trigger"
          :sections="panelSections" empty-text="" :selected-index="selectedIndex"
          :has-active-query="!!activeTrigger!.query.trim()"
          @select="selectSuggestion"
        />
      </div>
      <div class="composer-bar">
        <ComposerAddMenu
          :draft="objective" :new-task="newTask" :project-id="projectId" :disabled="busy"
          :image-disabled-reason="attachDisabledReason" :offer-goal="!!appCommands?.some(command=>command.value==='goal')"
          :anchor="addMenuAnchor" :file-provider="fileProvider" :skills="skills" :sessions="sessions"
          @open-change="onAddMenuOpen" @attach="fileInput?.click()" @insert="insertFromAddMenu"
        />
        <ComposerModelMenu :thinking-shortcut="formatShortcut((shortcuts ?? defaultBindings()).thinking)"
          class="composer-model-picker" :configs="configs" :binding="binding" :thinking-level="thinkingLevel ?? ''"
          :disabled="canStop" :busy="busy"
          @select-model="emit('update:binding', $event)" @update:thinking-level="emit('update:thinkingLevel', $event)"
          @open-settings="emit('open-settings')"
        />
        <PermissionModeMenu
          :key="projectId" :value="approvalMode" :disabled="canStop || !projectId"
          :disabled-reason="canStop ? t('composer.approvalFrozen') : !projectId ? t('composer.pickProjectFirst') : undefined"
          :busy="permissionSaving" compact
          @change="emit('change-approval-mode', $event)" @modal-change="emit('modal-change', $event)"
        />
        <ComposerSelect
          v-if="newTask" class="composer-project-picker" :value="projectId" :options="projectOptions" :label="t('composer.projectLabel')" :placeholder="t('composer.projectPlaceholder')" icon="folder"
          :disabled="canStop" searchable :search-placeholder="t('composer.searchProjects')" :empty-text="t('composer.noProjectsMatch')" :width="288" compact
          :action-label="t('composer.createProject')" action-icon="folder-plus"
          @change="emit('select-project', $event)" @action="emit('create-project')"
        />
        <span class="grow"></span>
        <div class="composer-actions">
          <button v-if="props.canStop" class="composer-stop" type="button" :disabled="props.stopping" :aria-label="props.stopping ? t('composer.stoppingAria') : t('composer.stopTask')" :title="props.stopping ? t('composer.stoppingTitle') : t('composer.stopTask')" @click="emit('stop')">
            <UiIcon name="stop" :size="16" />
            <span>{{ props.stopping ? t('composer.stopping') : t('composer.stopTask') }}</span>
          </button>
          <ControlHintTooltip v-if="liveSession && mode==='ordinary'" :text="sendDisabledReason || t('composer.queueHint')" :focusable="sendDisabled" v-slot="{describedby}"><button class="composer-attach composer-queue" type="button" :disabled="sendDisabled" :aria-label="t('composer.queueAria')" :aria-describedby="describedby" @click="emit('queue')"><UiIcon name="list-end" :size="18" /></button></ControlHintTooltip>
          <button class="composer-send" type="button" :disabled="sendDisabled" :aria-label="props.liveSession ? t('composer.sendSteer') : t('composer.startTask')" :title="props.liveSession ? t('composer.sendSteer') : (realMode ? t('composer.sendTask') : t('composer.sendAfterModel'))" @click="submit">
            <UiIcon name="arrow-up" :size="16" />
          </button>
        </div>
      </div>
    </div>
    <div v-if="$slots.dock" class="composer-dock"><slot name="dock" /></div>
    <p v-else class="composer-caption">{{ caption }}</p>
  </div>
</template>

<style scoped>
.composer-image-warning{margin:6px 12px;color:var(--danger);font-size:var(--text-ui-sm)}
/* Container sizing stays with the shell; toolbar metrics belong to this component.
   Fixed-source references: V4ComposerModeControls, ModelConfigSelect, ui/button. */
.composer { container: composer / inline-size; }
.composer-dock { width:var(--conversation-content-width,calc(100% - 32px)); margin:4px auto 0; min-height:24px; }
.composer-bar { display: flex; flex-wrap: nowrap; align-items: center; gap: 4px; row-gap: 4px; min-width: 0; padding: 0; font: 400 14px/20px var(--font-ui, sans-serif); }
.composer-bar .grow { flex: 1 1 0; min-width: 0; }
.composer-model-picker { flex: 0 1 auto; min-width: 28px; max-width: 240px; }
.composer-project-picker { flex: 0 1 auto; min-width: 28px; max-width: 180px; }
.composer-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.composer-attach, .composer-send, .composer-stop { box-sizing: border-box; display: inline-flex; flex: none; align-items: center; justify-content: center; gap: 4px; height: 28px; min-height: 28px; margin: 0; padding: 0; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--fg); font: 400 14px/20px var(--font-ui, sans-serif); white-space: nowrap; cursor: pointer; transition: background-color .1s, color .1s; }
.composer-attach { width: 28px; color: var(--fg-subtle); }
.composer-queue:disabled { cursor:not-allowed; }
.composer-attach:hover { color: var(--fg); background: var(--hover); }
.composer-attachments { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px 0; }
.composer-chip { position: relative; width: 56px; height: 42px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; line-height: 0; }
.composer-chip img { width: 100%; height: 100%; object-fit: cover; display: block; }
.composer-chip-remove { position: absolute; top: 2px; right: 2px; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border: none; border-radius: 999px; background: rgb(0 0 0 / 62%); color: #fff; cursor: pointer; line-height: 0; }
.composer-chip-remove:hover { background: rgb(0 0 0 / 82%); }
.composer-chip-remove:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.composer-chip-uploading { align-self: center; color: var(--fg-subtle); font-size: var(--text-ui-sm, 12px); }
.composer.drag-over { outline: 2px dashed var(--primary); outline-offset: -6px; border-radius: var(--radius-m, 12px); }
.composer-send { width: 28px; border-radius: 50%; background: var(--primary); color: var(--primary-fg); }
.composer-send:hover:not(:disabled) { opacity: .85; }
.composer-stop { padding: 0 8px; border: 1px solid var(--border); border-radius: 999px; }
.composer-stop:hover:not(:disabled) { background: var(--hover); border-color: var(--border-hover); }
.composer-send:disabled, .composer-stop:disabled { cursor: not-allowed; opacity: .5; }
.composer-attach:focus-visible, .composer-send:focus-visible, .composer-stop:focus-visible { outline: 2px solid var(--fg-subtle); outline-offset: 2px; }
/* 块E3：建议浮层锚点——贴 composer 顶缘上方（上游面板在输入框上方弹出） */
.composer { position: relative; }
.mention-anchor { position: absolute; left: 0; right: 0; bottom: calc(100% + 4px); z-index: 60; }
@container composer (max-width: 600px) {
  .composer-model-picker { max-width: 200px; }
  .composer-stop { width: 28px; padding: 0; }
  .composer-stop > span { display: none; }
}
@container composer (max-width: 360px) {
  .composer-model-picker { flex: 1 1 0; max-width: none; min-width: 28px; }
  .composer-bar .grow { display: none; }
  .composer-model-picker :deep(.composer-select-label) { max-width: 100%; }
}
</style>
