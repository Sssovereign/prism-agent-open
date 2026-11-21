<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import type { ConversationToolRow } from '../../contracts/conversation';
import type { RealRunSession } from '../view-model/realRun';
import FullToolResult from '../conversation/FullToolResult.vue';
import MotionDisclosure from '../conversation/MotionDisclosure.vue';
import { readDisclosureChoice, saveDisclosureChoice, claimToolEntrance } from '../conversation/motion';
import { summarizeTool, stateLabel } from '../conversation/tools';
import HighlightedDiffLines from './HighlightedDiffLines.vue';
import { v1 } from '../api';
import UserQuestionHistory from './UserQuestionHistory.vue';
const props=defineProps<{item:ConversationToolRow;session?:RealRunSession}>();
const userQuestion=computed(()=>props.session?.userQuestions.value.find(q=>q.invocationId===props.item.invocationId));
const summary=computed(()=>summarizeTool(props.item));
const proseSubject=computed(()=>['web','mcp','todo','agent'].includes(summary.value.category)||(props.item.tool==='bash'&&typeof props.item.args?.description==='string'&&!!props.item.args.description.trim()));
const detail=computed(()=>props.item?props.session?.details.value[props.item.invocationId]:undefined);
// 块D：todo清单与子代理活动（subagent.message事件按parentInvocationId归属本工具卡）
const todoPlan=computed(()=>{const todos=props.item?.args?.['todos'];return Array.isArray(todos)?todos as Array<{content?:unknown;status?:unknown}>:[];});
const subMessages=computed(()=>{if(!props.session||!props.item)return[];void props.session.subagentRevision.value;
 return props.session.runs.value.flatMap(r=>r.events).filter(e=>e.type==='subagent.message'&&String((e.payload as Record<string,unknown>).parentInvocationId??'')===props.item!.invocationId)
  .map(e=>String((e.payload as Record<string,unknown>).text??''));});
const choiceKey=computed(()=>`tool:${props.item?.invocationId??''}`);
const open=ref(props.session?readDisclosureChoice(props.session,choiceKey.value)??false:false);
// 块F1：写入类工具卡内联 diff（EditInlineDiffContent 语义：展开时按需拉补丁，轻量行先渲染+异步高亮）
const diffMeta=computed(()=>props.session&&props.item?props.session.details.value[props.item.invocationId]?.diff:undefined);
const diffPatch=ref('');const diffLoading=ref(false);const diffError=ref('');
const diffFetched=new Set<string>();
async function fetchDiff(meta: NonNullable<typeof diffMeta.value>):Promise<void>{
 if(!props.session||diffFetched.has(meta.changeRecordId))return;
 diffFetched.add(meta.changeRecordId);diffLoading.value=true;diffError.value='';
 try{const result=await v1<{patch:string}>(`/api/v1/runs/${props.session.runId}/changes/${encodeURIComponent(meta.changeRecordId)}/diff`);
  if(meta===diffMeta.value)diffPatch.value=result.patch;
 }catch(e){diffFetched.delete(meta.changeRecordId);if(meta===diffMeta.value)diffError.value=e instanceof Error?e.message:'diff 读取失败';}
 finally{if(meta===diffMeta.value)diffLoading.value=false;}
}
function retryDiff():void{const meta=diffMeta.value;if(meta){diffFetched.delete(meta.changeRecordId);void fetchDiff(meta);}}
watch(diffMeta,meta=>{if(meta&&open.value)void fetchDiff(meta);});
watch(open,expanded=>{const meta=diffMeta.value;if(expanded&&meta)void fetchDiff(meta);});
const loading=ref(false),error=ref(''),visible=ref(true);
const running=computed(()=>visible.value&&props.item?.state==='running');
// Snapshot restoration is static; only subsequently arriving live tool identities fade in.
const entrance=ref(props.session&&props.item ? claimToolEntrance(props.session,props.item.invocationId,
 props.session.turns.value.flatMap(turn=>turn.segments.flatMap(segment=>segment.history.filter(row=>row.kind==='tool').map(row=>row.id))),
 props.session.isActive.value&&props.item.state==='running') : false);
let entranceTimer: ReturnType<typeof setTimeout> | undefined;
let request=0;
async function load(){if(!props.item||!props.session||loading.value)return;const ticket=++request;loading.value=true;error.value='';try{await props.session.loadToolResult(props.item.invocationId);}catch(e){if(ticket===request)error.value=e instanceof Error?e.message:'详情读取失败';}finally{if(ticket===request)loading.value=false;}}
function toggle(value:boolean){open.value=value;if(props.session)saveDisclosureChoice(props.session,choiceKey.value,value);if(value&&!detail.value?.resultLoaded)void load();}
watch(choiceKey,()=>{request++;loading.value=false;error.value='';open.value=props.session?readDisclosureChoice(props.session,choiceKey.value)??false:false;});
// A result arriving while its details are open updates in place, not a remount/entrance animation.
watch(()=>props.item?.state,()=>{if(open.value&&!detail.value?.resultLoaded)void load();});
function visibility(){visible.value=!document.hidden;if(!visible.value)entrance.value=false;}
onMounted(()=>{visibility();document.addEventListener('visibilitychange',visibility);if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)entrance.value=false;if(entrance.value)entranceTimer=setTimeout(()=>entrance.value=false,1000);if(open.value&&!detail.value?.resultLoaded)void load();});
onBeforeUnmount(()=>{request++;clearTimeout(entranceTimer);document.removeEventListener('visibilitychange',visibility);});
</script>
<template>
 <UserQuestionHistory v-if="item.tool==='AskUserQuestion'" :request="userQuestion" :running="item.state==='running'" :failed="item.state==='failed'"/>
 <MotionDisclosure v-else class="tool-call" :class="{'tool-entrance':entrance}" :data-category="summary.category" :data-tool-state="item?.state" :open="open" label="展开或收起工具详情" @update:open="toggle">
  <!-- web 类（web_fetch/web_search）按 ZCode renderers/web-fetch|search 复刻：图标+动词+纯文本主题 -->
  <!-- MCP 桥接工具按 renderers/mcp.tsx 复刻：PlugIcon(size-4)+kindLabel"MCP"语义进入动词列，纯文本主题 -->
  <template #summary><svg v-if="summary.category==='web'" class="web-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><template v-if="summary.verb==='抓取网页'"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></template><template v-else><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></template></svg><svg v-else-if="summary.category==='mcp'" class="web-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg><svg v-else-if="summary.category==='todo'" class="web-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13"/></svg><svg v-else-if="summary.category==='agent'" class="web-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg><span class="tool-verb" :class="{'is-running':running}">{{summary.verb}}</span><code v-if="!proseSubject" class="tool-subject" :title="summary.subject">{{summary.subject}}</code><span v-else class="tool-subject-plain" :title="summary.subject">{{summary.subject}}</span><span class="tool-outcome" :title="stateLabel[item.state]"><template v-if="item.state==='done'"><svg class="tool-done" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg><span class="sr-only">已完成</span></template><template v-else>{{stateLabel[item.state]}}</template></span><svg class="tool-disclosure" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 5 7 7-7 7"/></svg></template>
  <div class="tool-output" v-if="item"><p v-if="item.approval" class="approval-link">审批 {{item.approval.state}} · {{item.approval.approvalId}}</p><p v-if="item.error" role="alert">{{item.error}}</p><!-- 块D：todo_write 主体按 renderers/todo.tsx 复刻（rounded-xl bg-surface px-3 py-2 space-y-1） --><div v-if="summary.category==='todo'&&todoPlan.length" class="todo-body"><div v-for="(step,i) in todoPlan" :key="i" class="todo-row"><svg v-if="step.status==='completed'" class="todo-glyph todo-glyph-muted" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg><svg v-else-if="step.status==='in_progress'" class="todo-glyph todo-glyph-active" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg><svg v-else class="todo-glyph todo-glyph-muted" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/></svg><span class="todo-text" :data-status="step.status">{{typeof step.content==='string'?step.content:''}}</span></div></div><!-- 块D：agent 子代理活动按 AgentActivitySection 语义复刻（大写小节标+边框滚动盒 max-h-64） --><div v-if="summary.category==='agent'&&subMessages.length" class="subagent-body"><p class="subagent-label">子代理活动</p><ul class="subagent-stream"><li v-for="(text,i) in subMessages" :key="i" class="subagent-line"><pre>{{text}}</pre></li></ul></div><dl v-if="item.args&&summary.category!=='todo'&&summary.category!=='agent'"><template v-for="(value,key) in item.args" :key="key"><dt>{{key}}</dt><dd><pre>{{typeof value==='string'?value:JSON.stringify(value,null,2)}}</pre></dd></template></dl><!-- 块F1：写入类工具卡内联 diff（max-h-60 rounded-xl border bg-card，EditInlineDiffContent 语义） --><div v-if="diffMeta" class="inline-diff"><p class="inline-diff-meta">{{diffMeta.path}} · {{diffMeta.operation==='create'?'新建':diffMeta.operation==='delete'?'删除':'修改'}} <span class="inline-diff-nums"><span class="num-added">+{{diffMeta.addedLines}}</span> <span class="num-removed">−{{diffMeta.removedLines}}</span></span></p><p v-if="diffLoading" role="status">正在读取 diff…</p><p v-else-if="diffError" role="alert">{{diffError}} <button type="button" @click="retryDiff">重试</button></p><div v-else-if="diffPatch" class="inline-diff-frame"><HighlightedDiffLines :patch="diffPatch" :path="diffMeta.path" :show-line-numbers="true" /></div></div><p v-if="loading" role="status">正在读取工具结果…</p><p v-else-if="error" role="alert">{{error}} <button type="button" @click="load">重试</button></p><pre v-else-if="detail?.resultPreview">{{detail.resultPreview}}</pre><p v-else>尚无工具输出。</p><p v-if="detail?.resultTruncated">结果预览已截断，不代表完整输出。</p><button v-if="detail && !detail.resultLoaded && !loading" type="button" @click="load">刷新输出</button><FullToolResult v-if="session" :run-id="session.runId" :invocation-id="item.invocationId"/></div>
 </MotionDisclosure>
</template>
<style scoped>
.tool-call{border:0;border-radius:0;background:transparent;box-shadow:none;margin:2px 0;min-width:0;padding:0}
.tool-call :deep(>.disclosure-trigger){font-size:var(--text-ui-caption);line-height:20px}
/* ToolSummaryRow.tsx: trailing chevron, 200ms ease-out, only exposed on hover/focus/open. */
.tool-disclosure{flex:none;color:var(--fg-subtlest);opacity:0;transition:transform 200ms cubic-bezier(0,0,.2,1),opacity 200ms cubic-bezier(0,0,.2,1)}
.tool-call:hover .tool-disclosure,.tool-call:focus-within .tool-disclosure,.tool-call[data-state=open] .tool-disclosure{opacity:1}
.tool-call[data-state=open] .tool-disclosure{transform:rotate(90deg)}
.tool-call .tool-subject{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-family:var(--font-mono);font-size:var(--text-ui-sm);flex:0 1 auto;background:transparent;padding:0;border-radius:0}
/* web 类主文本：非等宽、subtlest 色，对齐 ToolSummaryRow primaryText 语义。 */
.web-icon{flex:none;color:var(--fg-subtlest)}
.tool-subject-plain{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--text-ui-sm);flex:0 1 auto;color:var(--fg-subtlest)}
.tool-verb{font-size:var(--text-ui-caption);font-weight:500;flex-shrink:0;color:var(--fg-subtle)}
.tool-done{display:block;opacity:.65}
.tool-outcome{font-size:var(--text-ui-sm);color:var(--fg-subtlest);white-space:nowrap;flex-shrink:0}
.tool-call[data-tool-state=failed] .tool-outcome{color:var(--danger)}
/* ToolLayout.tsx -> styles.css animated-gradient-text. Exact stops, size and 4s timing;
   host semantic foreground replaces upstream light/dark literal RGB values. No spinning icons. */
.tool-verb.is-running{--sweep-strong:var(--fg);--sweep-soft:color-mix(in srgb,var(--fg) 22%,transparent);background:linear-gradient(90deg,var(--sweep-strong) 0%,var(--sweep-strong) 34%,var(--sweep-soft) 50%,var(--sweep-strong) 66%,var(--sweep-strong) 100%);background-size:300% 100%;background-clip:text;-webkit-background-clip:text;color:transparent;-webkit-text-fill-color:transparent;animation:tool-gradient-flow 4s linear infinite}
@keyframes tool-gradient-flow{0%{background-position:100% 0}50%,100%{background-position:0% 0}}
.tool-output{border:0;border-left:1px solid var(--border);background:transparent;margin:5px 0 10px 5px;padding:4px 0 4px 14px;min-width:0;color:var(--fg)}.tool-output pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:440px;overflow:auto;font-size:var(--text-ui-sm);font-family:var(--font-mono)}.tool-output dl{margin:0}.tool-output dt{font-size:var(--text-ui-sm);color:var(--fg-subtlest)}.tool-output dd{margin:0 0 8px}.approval-link{font-size:var(--text-ui-sm);color:var(--fg-subtle);overflow-wrap:anywhere}.tool-output [role=alert]{color:var(--danger)}button{cursor:pointer}
/* renderers/todo.tsx：rounded-xl bg-surface px-3 py-2 space-y-1（12px/8px 内距、4px 间距）。 */
.todo-body{border-radius:12px;background:var(--bg-surface,rgba(127,127,127,.08));padding:8px 12px;display:grid;gap:4px;margin-bottom:8px;min-width:0}
.todo-row{display:flex;min-width:0;align-items:center;gap:8px}
.todo-glyph{flex:none;color:var(--fg-subtlest)}
.todo-glyph-active{color:var(--fg)}
.todo-text{min-width:0;font-size:var(--text-ui-sm);overflow-wrap:anywhere}
.todo-text[data-status=pending]{color:var(--fg-subtle)}
.todo-text[data-status=in_progress]{color:var(--fg)}
.todo-text[data-status=completed]{color:var(--fg-subtlest);text-decoration:line-through}
/* AgentActivitySection：大写小节标 + rounded-lg border 盒 max-h-64（256px）滚动。 */
.subagent-body{margin-bottom:8px;min-width:0}
.subagent-label{margin:0 0 4px;font-size:var(--text-ui-caption);font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--fg-subtle)}
.subagent-stream{list-style:none;margin:0;padding:0;border:1px solid var(--border);border-radius:8px;max-height:256px;overflow:auto;display:grid;gap:4px}
.subagent-line{padding:6px 8px}
.subagent-line pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:var(--text-ui-sm);color:var(--fg-subtle)}
/* 块F1：写入类内联 diff（EditInlineDiffContent：mb-2 max-h-60 overflow-auto rounded-xl border bg-card） */
.inline-diff{margin:4px 0 12px;min-width:0}
.inline-diff-meta{margin:0 0 6px;font-size:var(--text-ui-sm);color:var(--fg-subtle);overflow-wrap:anywhere}
.inline-diff-nums{font-family:var(--font-mono);font-size:var(--text-ui-sm)}
.num-added{color:var(--color-diff-added)}
.num-removed{color:var(--color-diff-removed)}
.inline-diff-frame{max-height:240px;overflow:auto;border-radius:12px;border:1px solid var(--border);background:var(--bg-card)}
/* styles.css:1110 + ToolCallBlocks.tsx:28-30: 900ms fade, 1000ms cleanup. */
.tool-entrance{animation:tool-stream-in 900ms cubic-bezier(.16,1,.3,1) both}
@keyframes tool-stream-in{from{opacity:0}to{opacity:1}}
@media(hover:none){.tool-disclosure{opacity:1}}
@media(prefers-reduced-motion:reduce){.tool-entrance{animation:none}.tool-disclosure{transition:none}.tool-verb.is-running{animation:none;background:none;color:var(--fg);-webkit-text-fill-color:currentColor}}
@media(forced-colors:active){.tool-verb.is-running{animation:none;background:none;color:CanvasText;-webkit-text-fill-color:currentColor}}
</style>
