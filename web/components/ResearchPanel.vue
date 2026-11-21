<script setup lang="ts">
import {onMounted,onBeforeUnmount,ref,watch,computed,nextTick} from 'vue';
import type {CriterionEvaluation,ResearchObjectionTarget,ResearchSubject,ResearchView,ResearchRecord,ResearchSubmission,ResearchReport} from '../../contracts/research';
import {v1} from '../api';
import MarkdownText from './MarkdownText.vue';
import ModeIcon from './ModeIcon.vue';
import UiIcon from './UiIcon.vue';
import ResearchObjectionForm from './ResearchObjectionForm.vue';
import {t} from '../ui/i18n/index';
import {phaseNavLabel,claimTargetIndex,speechSummary,inputViewOf,majorityVerdict,dispositionFields,reviewSubjectFor,storedClaims,type ClaimTarget} from '../view-model/research';
const props=defineProps<{runId:string;status:string;mode:'debate'|'jury';busy:boolean;failure?:string;objective?:string}>();
export interface ResearchReviewDraft {
 sourceRunId:string;
 objective:string;
 subject:ResearchSubject;
 objections:Array<{target:ResearchObjectionTarget;text:string}>;
}
const emit=defineEmits<{(e:'retry'):void;(e:'review',draft:ResearchReviewDraft):void;(e:'settings'):void;(e:'continue'):void;(e:'handoff',prefill:ResearchHandoffPrefill):void}>();
interface Phase {id:string;participantId:string;label:string;role:string;ordinal:number;phaseKey?:string;roundNo?:number;status:string;sealed:boolean;view:ResearchView|null;output:ResearchSubmission|null;model?:{displayName?:string;modelId?:string};activity?:{tools:Record<string,number>;modelRequests:number};rejections?:{count:number;last:{at:string;message:string}|null}}
interface ProtocolInfo {policyVersion:string;verdicts:string[];decision:{required:boolean;proposition:string;candidates:Array<{id:string;text:string}>}|null;subject:{title:string;content:string}|null;criteria:Array<{id:string;text:string;mustHave:boolean}>|null}
const snapshot=ref<{phases:Phase[];records:ResearchRecord[];report:ResearchReport|null;protocol?:ProtocolInfo;failure?:{message?:string}}|null>(null),error=ref(''),actionBusy=ref(false);
const flow=ref<HTMLElement>();
let timer:ReturnType<typeof setTimeout>|undefined,disposed=false,epoch=0;
const roleLabel=(label:string)=>t(`research.role.${label}`);
const states=():Record<string,string>=>({pending:t('research.state.pending'),running:t('research.state.running'),succeeded:t('research.state.succeeded'),failed:t('research.state.failed'),cancelled:t('research.state.cancelled'),skipped:t('research.state.skipped')});
const runStates=computed<Record<string,string>>(()=>({created:t('research.runState.created'),running:t('research.runState.running'),succeeded:t('research.runState.succeeded'),failed:t('research.runState.failed'),cancelled:t('research.runState.cancelled'),waiting_input:t('research.runState.waiting')}));
// 票型标签按冻结协议verdicts解析（v1票型/ v2通过·有条件通过·不通过）；缺协议时回退v1键序。
const votes=computed<Record<string,string>>(()=>Object.fromEntries((snapshot.value?.protocol?.verdicts??['pro','con','mixed','insufficient','abstain']).map(key=>[key,t(`research.verdict.${key}`)])));
const isV2=computed(()=>(snapshot.value?.protocol?.policyVersion??'research-v1')!=='research-v1');
const criterionStates=computed<Record<string,string>>(()=>({satisfied:t('research.criterion.satisfied'),unmet:t('research.criterion.unmet'),insufficient:t('research.criterion.insufficient')}));
const dispositionLabels=computed<Record<string,string>>(()=>({adopt:t('research.disposition.adopt'),trial:t('research.disposition.trial'),defer:t('research.disposition.defer')}));
const dispositionFieldLabels=computed<Record<string,string>>(()=>({candidateId:t('research.disposition.candidateId'),hardConstraints:t('research.disposition.hardConstraints'),scope:t('research.disposition.scope'),successCriteria:t('research.disposition.successCriteria'),reEvalTrigger:t('research.disposition.reEvalTrigger'),missingEvidence:t('research.disposition.missingEvidence'),howToObtain:t('research.disposition.howToObtain'),reDecisionConditions:t('research.disposition.reDecisionConditions')}));
/** 处置字段取值：candidateId解析为冻结候选文本，其余直接取字符串字段。 */
function dispositionValue(disposition:NonNullable<ResearchSubmission['disposition']>,field:string):string{
 if(field==='candidateId')return snapshot.value?.report?.decision?.candidates.find(c=>c.id===disposition.candidateId)?.text??disposition.candidateId??'';
 const value=(disposition as unknown as Record<string,unknown>)[field];
 return typeof value==='string'?value:'';
}
const resolutions=computed<Record<string,string>>(()=>({accepted:t('research.resolution.accepted'),rejected:t('research.resolution.rejected'),partial:t('research.resolution.partial'),unresolved:t('research.resolution.unresolved')}));
const toolNames=computed<Record<string,string>>(()=>({research_read:t('research.tool.read'),research_search:t('research.tool.search'),web_search:t('research.tool.webSearch'),web_fetch:t('research.tool.webFetch')}));
const chipState=computed(()=>['created','running'].includes(props.status)?'running':props.status==='succeeded'?'done':['failed','cancelled'].includes(props.status)?'fail':'warn');
const modeLabel=computed(()=>props.mode==='debate'?t('mode.debate.label'):t('mode.jury.label'));
// 阶段导航：clickable chips 定位到 data-phase-id 锚点；会话查找（续聊恢复）复用同一锚点。
const nav=computed(()=>(snapshot.value?.phases??[]).map(phase=>({id:phase.id,label:phaseNavLabel(phase,{role:roleLabel(phase.label),opening:t('research.phase.opening'),round:(round:number)=>t('research.phase.round',{round})}),status:phase.status,sealed:phase.sealed,active:navActive.value===phase.id})));
const navActive=ref('');
const claimTargets=computed(()=>claimTargetIndex(snapshot.value?.records??[],phaseTaskId=>{
 const phase=snapshot.value?.phases.find(p=>p.id===phaseTaskId);
 return phase?{label:roleLabel(phase.label),roundNo:phase.roundNo??0}:null;
}));
function targetText(target:ClaimTarget){return `${target.roleLabel}${target.roundNo?` · ${t('research.phase.round',{round:target.roundNo})}`:''} · ${t('research.claim.no',{no:target.claimNo})}`;}
// 输入视野：固定视图的分类摘要（资料/发言/补充），联网搜索状态取冻结视图tools。
const inputViews=computed(()=>(snapshot.value?.phases??[]).filter(p=>p.view).map(phase=>({phase,summary:inputViewOf(phase.view!,snapshot.value?.records??[])})));
const reportSummary=computed(()=>snapshot.value?.report?.summary?.trim()??'');
const majority=computed(()=>majorityVerdict(snapshot.value?.report?.tally));
const outcome=computed(()=>{
 const report=snapshot.value?.report;
 if(!report)return '';
 if(report.mode==='jury'&&report.tally){
  const vote=majority.value;
  return vote?t('research.report.majorityHeadline',{verdict:votes.value[vote.key],count:vote.count,total:report.version===2?3:Object.values(report.tally).reduce((sum,count)=>sum+count,0)}):t('research.report.noMajorityHeadline');
 }
 const disposition=report.disposition;
 if(disposition?.kind==='adopt')return t('research.report.adoptHeadline',{candidate:dispositionValue(disposition,'candidateId')});
 if(disposition)return t('research.report.dispositionHeadline',{kind:dispositionLabels.value[disposition.kind]});
 return '';
});
const publishedJurors=computed(()=>(snapshot.value?.phases??[]).filter(phase=>phase.role==='juror'&&!phase.sealed&&phase.status==='succeeded'&&phase.output));
const primaryCondition=computed(()=>{
 if(majority.value?.key!=='conditional_pass')return '';
 const agreed=new Map<string,{text:string;count:number}>();
 for(const phase of publishedJurors.value){
  if(phase.output?.verdict!=='conditional_pass')continue;
  for(const condition of phase.output.pendingConditions??[]){
   const previous=agreed.get(condition.criterionId);
   agreed.set(condition.criterionId,{text:previous?.text??condition.text,count:(previous?.count??0)+1});
  }
 }
 return [...agreed.values()].sort((a,b)=>b.count-a.count)[0]?.text??'';
});
const criterionReviews=computed(()=>{
 const index=new Map<string,Array<{phaseId:string;label:string;evaluation:CriterionEvaluation}>>();
 for(const phase of publishedJurors.value)for(const evaluation of phase.output?.criterionEvaluations??[]){
  const rows=index.get(evaluation.criterionId)??[];
  rows.push({phaseId:phase.id,label:roleLabel(phase.label),evaluation});
  index.set(evaluation.criterionId,rows);
 }
 return index;
});
function criterionText(id:string){
 return (snapshot.value?.report?.criteria??snapshot.value?.protocol?.criteria??snapshot.value?.report?.criterionSummary)?.find(c=>c.id===id)?.text;
}
function sourceTitle(id:string){
 return snapshot.value?.records.find(record=>record.id===id&&record.kind==='source')?.title;
}
const activityLine=(phase:Phase)=>{
 const tools=phase.activity?.tools??{};
 const parts=Object.entries(toolNames.value).filter(([name])=>tools[name]).map(([name,label])=>`${label} ${tools[name]}`);
 return parts.join(' · ');
};
const flash=ref('');
// —— 阶段④执行交接：按报告生成可编辑执行草稿预填（目标/依据/范围/验收项），用户确认后走普通创建 ——
export interface ResearchHandoffPrefill{goal:string;basis:string;scope:string;items:string[]}
const handoffPrefill=computed<ResearchHandoffPrefill|null>(()=>{
 const report=snapshot.value?.report;if(!report||props.status!=='succeeded')return null;
 const items:string[]=[];let goal=t('research.handoff.goalFallback');const basis:string[]=[];let scope='';
 const v2=report as typeof report&{version?:number;majority?:{key:string;count:number}|null;disposition?:{kind?:string;candidateId?:string;hardConstraints?:string;scope?:string;successCriteria?:string;reEvalTrigger?:string;missingEvidence?:string;howToObtain?:string};decision?:{proposition?:string};subject?:{title:string};blockingItems?:Array<{criterionId:string;reason:string}>;nextSteps?:string[];criterionSummary?:Array<{id:string;text:string;mustHave:boolean;unmet:number;insufficient:number}>};
 if(v2.version===2&&report.mode==='debate'&&v2.disposition){
  const kindLabel=v2.disposition.kind==='adopt'?t('research.disposition.adopt'):v2.disposition.kind==='trial'?t('research.disposition.trial'):t('research.disposition.defer');
  const candidate=report.disposition?dispositionValue(report.disposition,'candidateId'):'';
  goal=candidate?`${kindLabel} · ${candidate}`:kindLabel;
  scope=v2.disposition.scope??'';
  if(v2.disposition.hardConstraints)basis.push(v2.disposition.hardConstraints);
  if(v2.disposition.successCriteria)basis.push(v2.disposition.successCriteria);
  if(v2.disposition.kind==='defer'){if(v2.disposition.missingEvidence)items.push(v2.disposition.missingEvidence);if(v2.disposition.howToObtain)items.push(v2.disposition.howToObtain);}
  else{if(v2.disposition.successCriteria)items.push(v2.disposition.successCriteria);if(v2.disposition.reEvalTrigger)items.push(v2.disposition.reEvalTrigger);if(v2.disposition.hardConstraints)items.push(v2.disposition.hardConstraints);}
 }else if(v2.version===2&&report.mode==='jury'){
  goal=v2.subject?.title?`${t('research.handoff.juryGoal')}：${v2.subject.title}`:t('research.handoff.juryGoal');
  if(outcome.value)basis.push(outcome.value);
  if(v2.criterionSummary)for(const criterion of v2.criterionSummary)if(criterion.mustHave&&(criterion.unmet>0||criterion.insufficient>0))items.push(`${t('research.handoff.criterionItem',{text:criterion.text})}`);
  if(v2.blockingItems?.length)for(const blocking of v2.blockingItems)items.push(`${t('research.handoff.blockingItem',{id:blocking.criterionId,reason:blocking.reason})}`);
  if(!items.length&&v2.nextSteps?.length)items.push(...v2.nextSteps.slice(0,5));
 }else{
  goal=t('research.handoff.goalFallback');
 }
 if(!items.length)items.push(report.summary??report.text.slice(0,200));
 return {goal,basis:basis.join('；'),scope,items:items.slice(0,20).map(item=>item.slice(0,2000))};
});
defineExpose({revealPhase:(phaseId:string)=>{navActive.value=phaseId;return scrollToAnchor(phaseId);}});
// —— 运行中异议与终态异议入口：运行中经steer带目标提交；终态随复核创建进入新研究 ——
const objectionOpen=ref<'claim'|'conclusion'|null>(null),objectionClaimId=ref(''),objectionText=ref(''),objectionBusy=ref(false);
const objectionError=ref('');
let objectionSubmission:{text:string;id:string}|null=null;
const runActive=computed(()=>['created','running','waiting_input'].includes(props.status));
async function openObjection(type:'claim'|'conclusion',claimId=''){
 if(objectionBusy.value)return;
 closeObjection();
 objectionOpen.value=type;
 objectionClaimId.value=claimId;
 await nextTick();
 flow.value?.querySelector<HTMLTextAreaElement>('.objection-composer textarea')?.focus({preventScroll:true});
}
function closeObjection(){objectionOpen.value=null;objectionText.value='';objectionError.value='';objectionSubmission=null;}
function startReview(target?:ResearchObjectionTarget,text?:string){
 const report=snapshot.value?.report;
 if(!report)return;
 const objective=props.objective??'';
 const claim=target?.type==='claim'?claimTargets.value.get(target.claimId)?.text:undefined;
 emit('review',{sourceRunId:props.runId,objective,subject:reviewSubjectFor(report,objective,claim),objections:target&&text?[{target,text}]:[]});
}
async function submitObjection(){
 const text=objectionText.value.trim();
 if(!objectionOpen.value||!text||objectionBusy.value)return;
 objectionBusy.value=true;
 objectionError.value='';
 const target:ResearchObjectionTarget=objectionOpen.value==='conclusion'?{type:'conclusion'}:{type:'claim',claimId:objectionClaimId.value};
 try{
  if(runActive.value){
   if(objectionSubmission?.text!==text)objectionSubmission={text,id:crypto.randomUUID()};
   await v1(`/api/v1/runs/${props.runId}/steer`,{method:'POST',body:JSON.stringify({text,clientMessageId:objectionSubmission.id,target})});
   closeObjection();await load();
  }else{
   startReview(target,text);
  }
 }catch(e){objectionError.value=e instanceof Error?e.message:t('research.objection.failed');}
 finally{objectionBusy.value=false;}
}
async function scrollToAnchor(anchor:string,kind:'phase'|'record'|'claim'='phase'){
 await nextTick();
 const el=flow.value?.querySelector<HTMLElement>(`[data-${kind}-id="${CSS.escape(anchor)}"]`);
 if(!el){error.value=t('research.locate.missing');return;}
 error.value='';
 for(let section:HTMLElement|null=el;section&&section!==flow.value;section=section.parentElement){
  if(section instanceof HTMLDetailsElement)section.open=true;
 }
 el.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});
 flash.value=anchor;setTimeout(()=>{if(flash.value===anchor)flash.value='';},1600);
}
async function locateClaim(claimId:string){navActive.value=claimTargets.value.get(claimId)?.phaseId??'';await scrollToAnchor(claimId,'claim');}
const inheritedClaims=computed(()=>new Map((snapshot.value?.records??[]).map(record=>[record.id,storedClaims(record).filter(claim=>claimTargets.value.get(claim.id)?.phaseId===null)])));
async function load(){
 const id=props.runId,generation=++epoch;clearTimeout(timer);
 try{const data=await v1<NonNullable<typeof snapshot.value>>(`/api/v1/runs/${id}/research`);if(!disposed&&generation===epoch){snapshot.value=data;error.value='';}}
 catch(e){if(!disposed&&generation===epoch)error.value=e instanceof Error?e.message:t('research.loadFailed');}
 finally{if(!disposed&&generation===epoch&&!['succeeded','failed','cancelled'].includes(props.status))timer=setTimeout(load,1500);}
}
async function summarize(){actionBusy.value=true;try{await v1(`/api/v1/runs/${props.runId}/research/summarize`,{method:'POST',body:'{}'});await load();}catch(e){error.value=e instanceof Error?e.message:t('research.summarizeFailed');}finally{actionBusy.value=false;}}
watch(()=>[props.runId,props.status],()=>{void load();});onMounted(load);onBeforeUnmount(()=>{disposed=true;epoch++;clearTimeout(timer);});
</script>
<template>
<article ref="flow" class="research-flow" :class="{ 'has-report': snapshot?.report }" :aria-label="t('research.nav.label')">
 <header v-if="!snapshot?.report" class="research-head">
  <ModeIcon :mode="mode" class="research-mode-icon" />
  <h2>{{modeLabel}}<span class="tag-mock">{{t('research.experimentTag')}}</span></h2>
  <span class="chip" :data-state="chipState"><span class="dot"></span>{{runStates[status]||status}}</span>
  <a class="text-btn" :href="`/api/v1/runs/${runId}/research/export`" download>{{t('research.download')}}</a>
 </header>
 <p v-if="error" class="error-text" role="alert">{{error}}</p>
 <p v-if="(failure||snapshot?.failure?.message)&&['failed','waiting_input'].includes(status)" class="notice-line" role="alert">{{t('research.incomplete',{message:snapshot?.failure?.message||failure||''})}}</p>
 <p v-else-if="!snapshot&&!error" class="research-note" role="status">{{t('research.loading')}}</p>
 <section v-if="snapshot?.report" class="research-report-card">
  <header class="report-heading">
   <div><h3 data-testid="research-outcome">{{outcome||t('research.report.title')}}</h3><span v-if="snapshot.report.execution==='early_summary'" class="tag-mock">{{t('research.report.early')}}</span></div>
   <a class="text-btn" :href="`/api/v1/runs/${runId}/research/export`" download>{{t('research.download')}}</a>
  </header>
  <p v-if="primaryCondition" class="report-condition"><strong>{{t('research.report.primaryCondition')}}</strong> {{primaryCondition}}</p>
  <p v-else-if="snapshot.report.blockingItems?.[0]" class="report-condition" data-state="blocked"><strong>{{t('research.report.primaryBlocker')}}</strong> {{snapshot.report.blockingItems[0].reason}}</p>
  <p class="report-meta">{{t('research.report.stats',{sources:snapshot.report.sourceCount,claims:snapshot.report.claimCount,evidence:snapshot.report.evidenceCount})}}</p>
  <p v-if="snapshot.report.evidenceStatus==='insufficient'" class="report-warn">{{t('research.report.insufficient')}}</p>
  <p v-if="snapshot.protocol?.subject" class="report-note">{{t('research.report.subject',{title:snapshot.protocol.subject.title})}}</p>
  <div v-if="reportSummary" class="report-summary"><span class="summary-label">{{t('research.report.summary')}}</span><p>{{reportSummary}}</p></div>
  <div v-else class="report-text"><MarkdownText :text="snapshot.report.text" /></div>
  <!-- v2辩论：冻结命题与候选；处置指向候选并绑定决定性依据主张 -->
  <div v-if="snapshot.report.decision?.required" class="report-decision" data-testid="report-decision">
   <span class="decision-chip-label">{{t('research.report.decision')}}</span>
   <p class="decision-proposition">{{snapshot.report.decision.proposition}}</p>
   <ul class="decision-candidate-list" :aria-label="t('research.report.candidates')">
    <li v-for="candidate in snapshot.report.decision.candidates" :key="candidate.id" :class="{adopted:snapshot.report.disposition?.kind==='adopt'&&snapshot.report.disposition?.candidateId===candidate.id}">{{candidate.text}}</li>
   </ul>
   <div v-if="snapshot.report.disposition" class="report-disposition" :data-kind="snapshot.report.disposition.kind">
    <span class="disposition-kind">{{t('research.report.disposition')}} · {{dispositionLabels[snapshot.report.disposition.kind]}}</span>
    <dl class="disposition-fields">
     <div v-for="field in dispositionFields(snapshot.report.disposition.kind)" :key="field" class="disposition-row">
      <dt>{{dispositionFieldLabels[field]}}</dt><dd>{{dispositionValue(snapshot.report.disposition!,field)}}</dd>
     </div>
    </dl>
    <div v-if="snapshot.report.disposition.basisClaimIds?.length" class="responds-to" data-testid="report-basis">
     <span class="basis-label">{{t('research.disposition.basis')}}</span>
     <button v-for="claimId in snapshot.report.disposition.basisClaimIds" :key="claimId" type="button" class="respond-target" :disabled="!claimTargets.get(claimId)" :title="claimTargets.get(claimId)?t('research.claims.locateTarget'):t('research.claims.targetMissing')" @click="locateClaim(claimId)">
      <UiIcon name="chevron-right" :size="12" />{{claimTargets.get(claimId)?targetText(claimTargets.get(claimId)!):t('research.claims.targetMissing')}}
     </button>
    </div>
   </div>
  </div>
  <dl v-if="snapshot.report.tally" class="research-votes"><div v-for="(count,key) in snapshot.report.tally" :key="key" class="vote" :class="{ 'vote-majority': majority?.key===key }"><dt>{{votes[key]}}</dt><dd>{{count}}</dd></div></dl>
  <p v-if="snapshot.report.tally" class="report-note">{{isV2?t('research.report.votesNoteV2'):t('research.report.votesNote')}}</p>
  <!-- v2评审：逐项标准判定汇总（程序从锁定初判计算） -->
  <div v-if="snapshot.report.criterionSummary?.length" class="report-criteria" data-testid="report-criteria">
   <span class="decision-chip-label">{{t('research.report.criteria')}}</span>
   <div v-for="criterion in snapshot.report.criterionSummary" :key="criterion.id" class="criterion-line">
    <span v-if="criterion.mustHave" class="must-have-tag">{{t('research.criterion.mustHave')}}</span>
    <span class="criterion-text">{{criterion.text}}</span>
    <span class="criterion-counts">{{criterionStates.satisfied}} {{criterion.satisfied}} · {{criterionStates.unmet}} {{criterion.unmet}} · {{criterionStates.insufficient}} {{criterion.insufficient}}</span>
   </div>
  </div>
  <div v-if="snapshot.report.blockingItems?.length" class="report-blocking">
   <span class="decision-chip-label">{{t('research.report.blocking')}}</span>
   <details v-for="(item,index) in snapshot.report.blockingItems" :key="index" class="tool-card" data-testid="report-blocker">
    <summary>{{item.reason}}<UiIcon class="tool-chevron" name="chevron-right" :size="14" /></summary>
    <div class="tool-card-content blocker-reviews">
     <p v-if="criterionText(item.criterionId)"><strong>{{t('research.report.blockerCriterion')}}</strong> {{criterionText(item.criterionId)}}</p>
     <div v-for="review in criterionReviews.get(item.criterionId)||[]" :key="review.phaseId" class="blocker-review">
      <p><strong>{{review.label}}</strong> · {{criterionStates[review.evaluation.status]}}</p>
      <p>{{review.evaluation.reason}}</p>
      <blockquote v-for="(citation,citationIndex) in review.evaluation.evidence||[]" :key="citationIndex">
       {{citation.quote}}
       <button type="button" class="cite-locate" :disabled="!sourceTitle(citation.sourceId)" @click="scrollToAnchor(citation.sourceId,'record')">{{sourceTitle(citation.sourceId)||t('research.claims.sourceMissing')}}</button>
      </blockquote>
     </div>
     <p v-if="!criterionReviews.get(item.criterionId)?.length" class="report-note">{{t('research.report.blockerNoReviews')}}</p>
    </div>
   </details>
  </div>
  <div v-if="snapshot.report.nextSteps?.length" class="report-next-steps">
   <span class="decision-chip-label">{{t('research.report.nextSteps')}}</span>
   <ol><li v-for="(step,index) in snapshot.report.nextSteps" :key="index">{{step}}</li></ol>
  </div>
  <!-- 用户异议与逐条回应：目标主张可定位；回应保留回应人 -->
  <div v-if="snapshot.report.objections?.length" class="report-objections" data-testid="report-objections">
   <span class="decision-chip-label">{{t('research.objection.title')}}</span>
   <div v-for="objection in snapshot.report.objections" :key="objection.id" class="objection-item">
    <p class="objection-quote">
     <button v-if="objection.target.type==='claim'" type="button" class="respond-target" :disabled="!claimTargets.get(objection.target.claimId)" @click="locateClaim(objection.target.claimId)">{{claimTargets.get(objection.target.claimId)?targetText(claimTargets.get(objection.target.claimId)!):t('research.objection.targetClaim')}}</button>
     <span v-else class="resolution-tag">{{t('research.objection.targetConclusion')}}</span>
    </p>
    <p class="objection-text">{{objection.text}}</p>
    <p v-for="(response,index) in objection.responses" :key="index" class="objection-response">
     <span class="resolution-tag" :data-resolution="response.resolution">{{resolutions[response.resolution]}}</span>
     <span class="objection-responder">{{response.responder}}</span><span> · {{response.reason}}</span>
    </p>
   </div>
  </div>
  <ul v-if="snapshot.report.limitations.length" class="report-limits"><li v-for="(item,index) in snapshot.report.limitations" :key="index">{{item}}</li></ul>
  <details v-if="reportSummary" class="tool-card report-full"><summary>{{t('research.report.full')}}<UiIcon class="tool-chevron" name="chevron-right" :size="14" /></summary><div class="tool-card-content report-text"><MarkdownText :text="snapshot.report.text" /></div></details>
  <footer v-if="status==='succeeded'" class="report-footer">
   <div class="research-actions">
    <button class="btn btn-solid" type="button" :disabled="busy" @click="emit('continue')">{{t('research.continue')}}</button>
    <button class="btn" type="button" :disabled="busy" @click="startReview()">{{t('research.juryReview')}}</button>
    <button class="btn" type="button" :disabled="busy" data-testid="objection-conclusion" :aria-expanded="objectionOpen==='conclusion'" @click="openObjection('conclusion')">{{t('research.objection.targetConclusionAction')}}</button>
    <button v-if="handoffPrefill" class="btn" type="button" :disabled="busy" @click="emit('handoff',handoffPrefill)">{{t('research.handoff.action')}}</button>
   </div>
   <ResearchObjectionForm v-if="objectionOpen==='conclusion'" v-model="objectionText" target="conclusion" :running="false" :busy="objectionBusy" :error="objectionError" @submit="submitObjection" @cancel="closeObjection" />
  </footer>
 </section>
 <nav v-if="nav.length" class="phase-nav" :aria-label="t('research.nav.label')">
  <button v-for="item in nav" :key="item.id" type="button" class="phase-nav-chip" :class="{active:navActive===item.id}" :data-state="item.status" @click="navActive=item.id;scrollToAnchor(item.id)">
   <span class="nav-dot"></span>{{item.label}}
  </button>
 </nav>
 <template v-if="!snapshot?.report">
  <p class="research-note">{{t('research.batchNote')}}</p>
  <div v-if="objective" class="research-objective"><span class="obj-label">{{t('research.objective')}}</span><div class="obj-text">{{objective}}</div></div>
  <div v-if="mode==='debate'&&runActive||['failed','cancelled','waiting_input'].includes(status)" class="research-actions">
   <button v-if="mode==='debate'&&['created','running'].includes(status)" class="btn" :disabled="busy||actionBusy" @click="summarize">{{t('research.summarize')}}</button>
   <button v-if="['failed','cancelled','waiting_input'].includes(status)" class="btn" :disabled="busy" @click="emit('retry')">{{t('research.retry')}}</button>
   <button v-if="status==='waiting_input'" class="btn" @click="emit('settings')">{{t('research.checkModel')}}</button>
  </div>
 </template>
 <section v-for="phase in snapshot?.phases||[]" :key="phase.id" class="research-turn" :data-phase-id="phase.id" :class="{flash:flash===phase.id}">
  <header class="turn-speaker">
   <span class="speaker-dot" :data-state="phase.status"></span>
   <span class="speaker-name">{{roleLabel(phase.label)}}</span>
   <small class="speaker-state">
    <template v-if="(phase.roundNo??0)>0">{{t('research.phase.round',{round:phase.roundNo})}} · </template>
    <template v-if="phase.ordinal>0">{{t('research.speech.ordinal',{no:phase.ordinal+1})}} · </template>
    <template v-if="phase.model?.displayName">{{phase.model.displayName}} · </template>
    {{phase.sealed?t('research.sealed'):(states()[phase.status]||phase.status)}}
   </small>
  </header>
  <p v-if="activityLine(phase)" class="activity-line">{{activityLine(phase)}}<template v-if="phase.activity?.modelRequests"> · {{t('research.activity.modelRequests',{count:phase.activity.modelRequests})}}</template></p>
  <p v-if="phase.rejections?.count" class="reject-line">{{t('research.reject.line',{count:phase.rejections.count,message:phase.rejections.last?.message||''})}}</p>
  <template v-if="!phase.sealed&&phase.output">
   <p v-if="speechSummary(phase.output)" class="speech-summary">{{speechSummary(phase.output)}}</p>
   <details class="tool-card"><summary>{{t('research.speech.full')}}<UiIcon class="tool-chevron" name="chevron-right" :size="14" /></summary>
    <div class="tool-card-content turn-body"><MarkdownText :text="phase.output.text" /></div>
   </details>
   <p v-if="phase.output.verdict" class="verdict-line">{{t('research.speech.verdict')}} · {{votes[phase.output.verdict]}}</p>
   <details v-if="phase.output.claims.length" class="tool-card">
    <summary>{{t('research.claims.title',{count:phase.output.claims.length})}}<small>{{t('research.claims.cited',{count:phase.output.claims.filter(claim=>claim.evidence.length).length})}}</small><UiIcon class="tool-chevron" name="chevron-right" :size="14" /></summary>
    <div class="tool-card-content">
     <div v-for="claim in phase.output.claims" :key="claim.key" class="claim" :data-claim-id="`${phase.id}:${claim.key}`" :class="{flash:flash===`${phase.id}:${claim.key}`}">
      <p>{{claim.text}}</p>
      <div v-if="claim.respondsTo?.length" class="responds-to">
       <button v-for="targetId in claim.respondsTo" :key="targetId" type="button" class="respond-target" :disabled="!claimTargets.get(targetId)" :title="claimTargets.get(targetId)?t('research.claims.locateTarget'):t('research.claims.targetMissing')" @click="locateClaim(targetId)">
        <UiIcon name="chevron-right" :size="12" />{{claimTargets.get(targetId)?targetText(claimTargets.get(targetId)!):t('research.claims.targetMissing')}}
       </button>
      </div>
      <blockquote v-for="(citation,index) in claim.evidence" :key="index">
       {{citation.quote}}
       <button type="button" class="cite-locate" :disabled="!sourceTitle(citation.sourceId)" @click="scrollToAnchor(citation.sourceId,'record')">
        {{sourceTitle(citation.sourceId)||t('research.claims.sourceMissing')}}
       </button>
      </blockquote>
      <span v-if="!claim.evidence.length" class="no-evidence">{{t('research.claims.noEvidence')}}</span>
      <button v-if="runActive||status==='succeeded'" type="button" class="cite-locate claim-objection" @click="openObjection('claim',`${phase.id}:${claim.key}`)">{{t('research.objection.action')}}</button>
      <ResearchObjectionForm v-if="objectionOpen==='claim'&&objectionClaimId===`${phase.id}:${claim.key}`" v-model="objectionText" target="claim" :running="runActive" :busy="objectionBusy" :error="objectionError" @submit="submitObjection" @cancel="closeObjection" />
     </div>
    </div>
   </details>
   <details v-if="phase.output.objections?.length" class="tool-card">
    <summary>{{t('research.objections.title',{count:phase.output.objections.length})}}<UiIcon class="tool-chevron" name="chevron-right" :size="14" /></summary>
    <div class="tool-card-content">
     <div v-for="objection in phase.output.objections" :key="objection.claimId" class="claim">
      <p class="objection-head">
       <button type="button" class="respond-target" :disabled="!claimTargets.get(objection.claimId)" @click="locateClaim(objection.claimId)">{{claimTargets.get(objection.claimId)?targetText(claimTargets.get(objection.claimId)!):objection.claimId}}</button>
       <span class="resolution-tag" :data-resolution="objection.resolution">{{resolutions[objection.resolution]}}</span>
      </p>
      <p class="objection-reason">{{objection.reason}}</p>
     </div>
    </div>
   </details>
   <!-- v2辩论决策：主持处置卡——字段按类型分组，依据主张可定位 -->
   <details v-if="phase.output.disposition" class="tool-card" data-testid="speech-disposition">
    <summary>{{t('research.speech.disposition')}} · {{dispositionLabels[phase.output.disposition.kind]}}<UiIcon class="tool-chevron" name="chevron-right" :size="14" /></summary>
    <div class="tool-card-content">
     <dl class="disposition-fields">
      <div v-for="field in dispositionFields(phase.output.disposition.kind)" :key="field" class="disposition-row">
       <dt>{{dispositionFieldLabels[field]}}</dt><dd>{{dispositionValue(phase.output.disposition!,field)}}</dd>
      </div>
     </dl>
     <div v-if="phase.output.disposition.basisClaimIds?.length" class="responds-to">
      <span class="basis-label">{{t('research.disposition.basis')}}</span>
      <button v-for="claimId in phase.output.disposition.basisClaimIds" :key="claimId" type="button" class="respond-target" :disabled="!claimTargets.get(claimId)" :title="claimTargets.get(claimId)?t('research.claims.locateTarget'):t('research.claims.targetMissing')" @click="locateClaim(claimId)">
       <UiIcon name="chevron-right" :size="12" />{{claimTargets.get(claimId)?targetText(claimTargets.get(claimId)!):t('research.claims.targetMissing')}}
      </button>
     </div>
    </div>
   </details>
  </template>
  <details v-if="phase.view" class="tool-card">
   <summary>{{t('research.view.title')}} · {{t('research.view.summary',{sources:inputViews.find(v=>v.phase.id===phase.id)?.summary.sourceCount??0,speeches:inputViews.find(v=>v.phase.id===phase.id)?.summary.speechCount??0})}}<UiIcon class="tool-chevron" name="chevron-right" :size="14" /></summary>
   <div class="tool-card-content insight">
    <p class="view-chips">
     <span class="chip-view">{{t('research.view.sources',{count:inputViews.find(v=>v.phase.id===phase.id)?.summary.sourceCount??0})}}</span>
     <span class="chip-view">{{t('research.view.speeches',{count:inputViews.find(v=>v.phase.id===phase.id)?.summary.speechCount??0})}}</span>
     <span class="chip-view">{{t('research.view.supplement',{version:phase.view.supplementThrough})}}</span>
     <span class="chip-view" :data-on="inputViews.find(v=>v.phase.id===phase.id)?.summary.webSearch">{{inputViews.find(v=>v.phase.id===phase.id)?.summary.webSearch?t('research.view.webSearch.on'):t('research.view.webSearch.off')}}</span>
    </p>
    <p v-for="category in inputViews.find(v=>v.phase.id===phase.id)?.summary.categories||[]" :key="category.key">
     <strong>{{t(`research.view.cat.${category.key}`)}}</strong>：{{category.titles.join('；')}}
    </p>
    <p class="view-export-note">{{t('research.view.fullInExport')}}</p>
   </div>
  </details>
 </section>
 <details v-if="snapshot?.records.length" class="tool-card research-records">
  <summary>{{t('research.records.title',{count:snapshot.records.length})}}<UiIcon class="tool-chevron" name="chevron-right" :size="14" /></summary>
  <div class="tool-card-content">
   <details v-for="record in snapshot.records" :key="record.id" class="record-item" :data-record-id="record.id" :class="{flash:flash===record.id}">
    <summary>{{record.title}} · {{record.kind}}{{record.truncated?` · ${t('research.records.truncated')}`:''}}</summary>
    <div class="record-body">
     <p class="record-meta">{{record.id}} · {{record.hash}}</p>
     <a v-if="record.url" class="text-btn" :href="record.url" target="_blank" rel="noreferrer">{{t('research.records.openSource')}}</a>
     <div v-for="claim in inheritedClaims.get(record.id)" :key="claim.id" class="claim" :data-claim-id="claim.id" :class="{flash:flash===claim.id}">
      <p>{{claim.text}}</p>
      <blockquote v-for="(citation,index) in claim.evidence||[]" :key="index">
       {{citation.quote}}
       <button type="button" class="cite-locate" :disabled="!sourceTitle(citation.sourceId)" @click="scrollToAnchor(citation.sourceId,'record')">{{sourceTitle(citation.sourceId)||t('research.claims.sourceMissing')}}</button>
      </blockquote>
      <button v-if="runActive||status==='succeeded'" type="button" class="cite-locate claim-objection" @click="openObjection('claim',claim.id)">{{t('research.objection.action')}}</button>
      <ResearchObjectionForm v-if="objectionOpen==='claim'&&objectionClaimId===claim.id" v-model="objectionText" target="claim" :running="runActive" :busy="objectionBusy" :error="objectionError" @submit="submitObjection" @cancel="closeObjection" />
     </div>
     <pre>{{record.content}}</pre>
    </div>
   </details>
  </div>
 </details>
</article>
</template>
<style scoped>
/* 对话流式研究过程：复用全站 token 与 .chip/.tool-card/.btn/.text-btn/.notice-line/.error-text 惯用法。 */
.research-flow{width:var(--conversation-content-width);margin:0 auto;padding:32px 0 24px;display:flex;flex-direction:column;gap:16px;font-size:var(--text-ui-base);overflow-wrap:anywhere}
.research-flow.has-report{padding-top:16px}
.research-head{display:flex;align-items:center;gap:10px;min-width:0}
.research-head h2{font-size:var(--text-ui-base);font-weight:500;display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.research-mode-icon{color:var(--fg-subtle);flex:none}
.research-head .chip{flex:none}
.research-head .chip[data-state="running"] .dot{background:var(--success);animation:chip-breathe 1.8s ease-in-out infinite}
.research-head .chip[data-state="done"] .dot{background:var(--color-icon-blue,#508de0)}
.research-head .chip[data-state="fail"] .dot{background:var(--danger)}
.research-head .chip[data-state="warn"] .dot{background:var(--warning)}
.research-head .text-btn{margin-left:auto}
.research-note{color:var(--fg-subtle);font-size:var(--text-ui-sm);line-height:1.7}
/* 议题按用户气泡观感呈现（对齐 UserInput.user-bubble 配色）。 */
.research-objective{display:flex;flex-direction:column;gap:6px;align-self:flex-end;width:fit-content;max-width:min(100%,576px);min-width:0}
.research-objective .obj-label{font-size:var(--text-ui-xs);color:var(--fg-subtlest);text-align:right}
.research-objective .obj-text{padding:10px 16px;border-radius:18px;background:light-dark(#e8f3ff,#213247);color:light-dark(#163354,#e0edff);white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--text-ui-base);line-height:1.6}
/* 阶段导航：横向可点chip，点击滚动到对应发言卡并高亮。 */
.phase-nav{display:flex;gap:6px;flex-wrap:wrap}
.phase-nav-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:1px solid var(--border);border-radius:999px;background:var(--bg-card);font-size:var(--text-ui-sm);color:var(--fg-subtle);cursor:pointer;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.phase-nav-chip:hover{color:var(--fg);border-color:var(--border-hover)}
.phase-nav-chip.active{color:var(--fg);border-color:var(--border-hover);background:var(--hover)}
.phase-nav-chip .nav-dot{width:6px;height:6px;border-radius:50%;background:var(--fg-subtlest);flex:none}
.phase-nav-chip[data-state="running"] .nav-dot{background:var(--success)}
.phase-nav-chip[data-state="succeeded"] .nav-dot{background:var(--color-icon-blue,#508de0)}
.phase-nav-chip[data-state="failed"],.phase-nav-chip[data-state="cancelled"] .nav-dot{background:var(--danger)}
.research-actions{display:flex;gap:8px;flex-wrap:wrap}
/* 研究结果卡 */
.research-report-card{border:1px solid var(--border);border-radius:12px;background:var(--bg-card);padding:16px;display:flex;flex-direction:column;gap:10px}
.report-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.report-heading>div{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.report-heading h3{margin:0;color:var(--fg);font-size:clamp(18px,2vw,24px);line-height:1.3;font-weight:650}
.report-heading .text-btn{flex:none}
.report-condition{margin:0;color:var(--fg);font-size:var(--text-ui-sm);line-height:1.6}
.report-condition strong{color:var(--fg-subtle);margin-right:6px}
.report-condition[data-state="blocked"] strong{color:var(--warning)}
.report-meta{color:var(--fg-subtle);font-size:var(--text-ui-sm)}
.report-warn{font-size:var(--text-ui-sm);line-height:1.6;color:var(--warning);border-left:2px solid var(--warning);padding-left:10px}
.report-summary{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-left:2px solid var(--color-icon-blue,#508de0);background:var(--color-surface);border-radius:var(--radius-s)}
.report-summary .summary-label{font-size:var(--text-ui-xs);color:var(--fg-subtlest)}
.report-summary p{margin:0;font-size:var(--text-ui-base);line-height:1.7}
.report-full summary{min-height:28px}
.report-text{font-size:var(--text-ui-base);line-height:1.8;color:var(--fg)}
.research-votes{display:flex;flex-wrap:wrap;gap:8px;margin:0}
.research-votes .vote{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border:1px solid var(--border);border-radius:999px;font-size:var(--text-ui-sm);color:var(--fg-subtle)}
.research-votes dt,.research-votes dd{margin:0}
.research-votes dd{font-weight:600;color:var(--fg)}
.research-votes .vote-majority{color:var(--fg);border-color:var(--color-icon-blue,#508de0);background:var(--color-surface);font-weight:600}
.report-note{color:var(--fg-subtlest);font-size:var(--text-ui-xs)}
.report-limits{margin:0;padding-left:18px;color:var(--fg-subtle);font-size:var(--text-ui-sm);line-height:1.7;display:flex;flex-direction:column;gap:4px}
/* v2决策与评审块：命题/候选/处置与逐项标准，沿用 chip 标签 + 卡内分组排版。 */
.decision-chip-label{display:inline-flex;align-items:center;height:22px;padding:0 9px;border:1px solid var(--border);border-radius:999px;font-size:var(--text-ui-xs);color:var(--fg-subtle);align-self:flex-start}
.report-decision{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-s);background:var(--color-surface)}
.decision-proposition{margin:0;font-size:var(--text-ui-base);line-height:1.6;font-weight:500}
.decision-candidate-list{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:6px}
.decision-candidate-list li{display:inline-flex;align-items:center;height:26px;padding:0 10px;border:1px solid var(--border);border-radius:999px;font-size:var(--text-ui-sm);color:var(--fg-subtle);background:var(--bg-card)}
.decision-candidate-list li.adopted{color:var(--success);border-color:var(--success);font-weight:500}
.report-disposition{display:flex;flex-direction:column;gap:8px;padding:8px 0 0;border-top:1px dashed var(--border)}
.disposition-kind{font-size:var(--text-ui-sm);font-weight:500;color:var(--fg)}
.report-disposition[data-kind="adopt"] .disposition-kind{color:var(--success)}
.report-disposition[data-kind="trial"] .disposition-kind{color:var(--color-icon-blue,#508de0)}
.report-disposition[data-kind="defer"] .disposition-kind{color:var(--warning)}
.disposition-fields{margin:0;display:flex;flex-direction:column;gap:6px}
.disposition-row{display:flex;gap:8px;min-width:0}
.disposition-row dt{flex:none;font-size:var(--text-ui-sm);color:var(--fg-subtlest)}
.disposition-row dd{margin:0;font-size:var(--text-ui-sm);line-height:1.6;color:var(--fg);overflow-wrap:anywhere}
.basis-label{font-size:var(--text-ui-xs);color:var(--fg-subtlest);align-self:center}
.report-criteria{display:flex;flex-direction:column;gap:6px}
.criterion-line{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.must-have-tag{display:inline-flex;align-items:center;height:18px;padding:0 7px;border:1px solid var(--warning);border-radius:999px;font-size:var(--text-ui-xs);color:var(--warning);flex:none}
.criterion-text{font-size:var(--text-ui-sm);color:var(--fg);line-height:1.6;min-width:0}
.criterion-counts{font-size:var(--text-ui-xs);color:var(--fg-subtlest);white-space:nowrap}
.report-next-steps ol{margin:0;padding-left:18px;color:var(--fg-subtle);font-size:var(--text-ui-sm);line-height:1.7;display:flex;flex-direction:column;gap:4px}
.report-blocking,.report-next-steps{display:flex;flex-direction:column;gap:6px}
.blocker-reviews,.blocker-review{display:grid;gap:6px;font-size:var(--text-ui-sm);line-height:1.6}
.blocker-reviews p,.blocker-review blockquote{margin:0}
.blocker-review{border-top:1px solid var(--border);padding-top:8px}
.blocker-review blockquote{border-left:2px solid var(--border);padding-left:10px;color:var(--fg-subtle)}
.report-footer{display:grid;gap:8px;border-top:1px solid var(--border);padding-top:12px}
.report-footer .btn{white-space:normal}
.claim-objection{margin-top:2px}
.report-objections{display:flex;flex-direction:column;gap:8px}
.objection-item{display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:1px solid var(--border)}
.objection-item:first-of-type{border-top:0;padding-top:0}
.objection-quote{margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.objection-text{margin:0;font-size:var(--text-ui-sm);line-height:1.7;color:var(--fg)}
.objection-response{margin:0;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:var(--text-ui-sm);color:var(--fg-subtle);line-height:1.6}
.objection-responder{font-weight:500;color:var(--fg-subtle)}
/* 阶段=对话轮：发言者标签沿用 .assistant-label 观感，状态点对齐全站惯例（执行中绿呼吸/已提交蓝/失败红/未开始灰）。 */
.research-turn{display:flex;flex-direction:column;gap:8px;border-radius:var(--radius-s)}
.research-turn.flash,.record-item.flash,.claim.flash{animation:locate-flash 1.6s ease-out}
@media(prefers-reduced-motion:reduce){.research-turn.flash,.record-item.flash,.claim.flash{animation:none;background:var(--selected)}}
@keyframes locate-flash{0%,40%{background:var(--hover)}100%{background:transparent}}
.turn-speaker{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;min-width:0}
.speaker-dot{width:6px;height:6px;border-radius:50%;background:var(--fg-subtlest);flex:none}
.speaker-dot[data-state="running"]{background:var(--success);animation:chip-breathe 1.8s ease-in-out infinite}
.speaker-dot[data-state="succeeded"]{background:var(--color-icon-blue,#508de0)}
.speaker-dot[data-state="failed"],.speaker-dot[data-state="cancelled"]{background:var(--danger)}
.speaker-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.speaker-state{font-weight:400;font-size:var(--text-ui-sm);color:var(--fg-subtlest);white-space:nowrap}
.activity-line,.reject-line{margin:0;font-size:var(--text-ui-xs);color:var(--fg-subtlest)}
.reject-line{color:var(--warning)}
.speech-summary{margin:0;padding:8px 12px;border-left:2px solid var(--border);color:var(--fg-subtle);font-size:var(--text-ui-sm);line-height:1.7}
.turn-body{font-size:var(--text-ui-base);line-height:1.8;color:var(--fg)}
.verdict-line{align-self:flex-start;display:inline-flex;align-items:center;height:24px;padding:0 10px;border:1px solid var(--border);border-radius:999px;font-size:var(--text-ui-sm);color:var(--fg-subtle)}
/* 主张引证与输入视野复用全局 .tool-card，仅补充卡内排版。 */
.claim{display:flex;flex-direction:column;gap:6px;padding:8px 0;border-top:1px solid var(--border)}
.claim:first-child{border-top:0;padding-top:0}
.claim p{margin:0;line-height:1.7}
.claim .objection-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.claim .objection-reason{color:var(--fg-subtle);font-size:var(--text-ui-sm)}
.resolution-tag{display:inline-flex;align-items:center;height:20px;padding:0 8px;border:1px solid var(--border);border-radius:999px;font-size:var(--text-ui-xs);color:var(--fg-subtle)}
.responds-to{display:flex;flex-wrap:wrap;gap:6px}
.respond-target{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border:1px solid var(--border);border-radius:999px;background:var(--bg-card);font-size:var(--text-ui-xs);color:var(--fg-subtle);cursor:pointer;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.respond-target:disabled{cursor:default;color:var(--fg-subtlest);font-style:italic}
.respond-target:not(:disabled):hover{color:var(--fg);border-color:var(--border-hover)}
.claim blockquote{margin:0;border-left:2px solid var(--border);padding:2px 0 2px 12px;color:var(--fg-subtle);font-size:var(--text-ui-sm);line-height:1.7;display:flex;flex-direction:column;gap:2px}
.cite-locate{align-self:flex-start;display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:none;font-size:var(--text-ui-xs);color:var(--color-icon-blue,#508de0);cursor:pointer;overflow-wrap:anywhere;text-align:left}
.cite-locate:disabled{cursor:default;color:var(--fg-subtlest);font-style:italic}
.cite-locate:not(:disabled):hover{text-decoration:underline}
.claim .no-evidence{color:var(--fg-subtlest);font-size:var(--text-ui-xs)}
.insight{display:flex;flex-direction:column;gap:6px}
.insight p{margin:0;color:var(--fg-subtle);font-size:var(--text-ui-sm)}
.insight strong{color:var(--fg-subtle)}
.view-chips{display:flex;flex-wrap:wrap;gap:6px}
.chip-view{display:inline-flex;align-items:center;height:22px;padding:0 9px;border:1px solid var(--border);border-radius:999px;font-size:var(--text-ui-xs);color:var(--fg-subtle)}
.chip-view[data-on="true"]{color:var(--success)}
.view-export-note{color:var(--fg-subtlest);font-size:var(--text-ui-xs)}
.insight code{font:var(--text-ui-xs) var(--font-mono);background:var(--color-surface);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
/* 资料记录：嵌套折叠列表，原文 pre 沿用 mono 滚动观感。 */
.research-records summary small{margin-left:auto;font-size:11px;color:var(--fg-subtlest)}
.record-item{border-top:1px solid var(--border);padding:4px 0}
.record-item:first-child{border-top:0}
.record-item summary{display:flex;align-items:center;gap:8px;min-height:28px;cursor:pointer;list-style:none;color:var(--fg-subtle);font-size:var(--text-ui-sm);overflow-wrap:anywhere}
.record-item summary::-webkit-details-marker{display:none}
.record-item summary:hover{color:var(--fg)}
.record-body{display:flex;flex-direction:column;gap:8px;padding:4px 0 8px}
.record-meta{margin:0;color:var(--fg-subtlest);font:var(--text-ui-xs) var(--font-mono);overflow-wrap:anywhere}
.record-body pre{margin:0;font:12px/1.6 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;background:var(--color-surface);border-radius:var(--radius-s);padding:10px 12px;color:var(--fg)}
@media(max-width:1023.98px){.research-flow{padding:20px 0 16px}.research-head .text-btn{margin-left:0}.research-head{flex-wrap:wrap}}
</style>
