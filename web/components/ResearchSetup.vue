<script setup lang="ts">
import UiSelect from './UiSelect.vue';
import ModeIcon from './ModeIcon.vue';
import UiIcon from './UiIcon.vue';
import {computed,onMounted,ref,watch} from 'vue';
import type {ModelConfigView} from '../../contracts/models';
import { toast } from '../ui/toast';
import { v1 } from '../api';
import {DECISION_CANDIDATES_MAX,DECISION_CANDIDATES_MIN,normalizeDecision,type ResearchDecisionDraft} from '../view-model/research';
export interface ResearchSubjectDraft { title:string;content:string }
export interface ResearchCriterionDraft { text:string;mustHave:boolean }
const props=defineProps<{mode:'debate'|'jury';configs:ModelConfigView[];models:Record<string,string>;binding:string;rounds:number;sourceText:string;decision:ResearchDecisionDraft|null;subject:ResearchSubjectDraft|null;criteria:ResearchCriterionDraft[];mcpToolIds:string[];projectId?:string;objective?:string}>();
const emit=defineEmits<{(e:'update:models',value:Record<string,string>):void;(e:'update:rounds',value:number):void;(e:'update:sourceText',value:string):void;(e:'update:decision',value:ResearchDecisionDraft|null):void;(e:'update:subject',value:ResearchSubjectDraft|null):void;(e:'update:criteria',value:ResearchCriterionDraft[]):void;(e:'update:mcpToolIds',value:string[]):void}>();
const labels:Record<string,string>={pro:'正方',con:'反方',host:'主持',juror1:'陪审员一',juror2:'陪审员二',juror3:'陪审员三',aggregate:'汇总复核'};
const actors=computed(()=>props.mode==='debate'?['pro','con','host']:['juror1','juror2','juror3','aggregate']);
const options=computed(()=>props.configs.filter(c=>c.enabled).flatMap(c=>c.models.filter(m=>m.enabled).map(m=>({value:`${c.id}:${m.modelId}`,label:`${c.name} · ${m.displayName}`}))));
function change(actor:string,value:string){emit('update:models',{...props.models,[actor]:value});}
// —— v2差异化表单：辩论「需要做决定」（候选2—6，含维持现状快捷项）；评审「被评对象+标准」（标准1—12，必达标记）——
// 与后端 freezeProtocolConfig 的边界一致；ID由服务端创建时冻结分配，前端只收集文本与必达标记。
const CRITERIA_MAX=12;
const decisionOn=computed(()=>props.mode==='debate'&&props.decision!==null);
function toggleDecision(on:boolean){
  emit('update:decision',on?{proposition:'',candidates:[{text:''},{text:'维持现状'}]}:null);
}
function patchDecision(patch:Partial<ResearchDecisionDraft>){
  if(!props.decision)return;
  emit('update:decision',{...props.decision,...patch});
}
function patchCandidate(index:number,text:string){
  if(!props.decision)return;
  const candidates=props.decision.candidates.map((c,i)=>i===index?{text}:c);
  emit('update:decision',{...props.decision,candidates});
}
function addCandidate(text=''){
  if(!props.decision)return;
  if(props.decision.candidates.length>=DECISION_CANDIDATES_MAX){toast(`候选方案最多${DECISION_CANDIDATES_MAX}项`,{variant:'warning'});return;}
  emit('update:decision',{...props.decision,candidates:[...props.decision.candidates,{text}]});
}
function removeCandidate(index:number){
  if(!props.decision)return;
  if(props.decision.candidates.length<=DECISION_CANDIDATES_MIN){toast(`决策模式至少保留${DECISION_CANDIDATES_MIN}项候选`,{variant:'warning'});return;}
  emit('update:decision',{...props.decision,candidates:props.decision.candidates.filter((_,i)=>i!==index)});
}
function quickAddStatusQuo(){
  if(!props.decision)return;
  if(props.decision.candidates.some(c=>c.text.trim()==='维持现状'))return;
  addCandidate('维持现状');
}
// —— 能力扩展（设置归还自由度）：MCP=只读声明工具显式勾选。技能不再单独挑选——研究参与者
// 与普通任务共用同一份已启用技能装配（服务端 collectEnabledSkillPaths）。
// 候选清单在挂载时拉取；设置关闭或清单为空则整块不渲染（服务端仍会校验，UI只是不引导）。
const mcpCandidates=ref<Array<{qualifiedName:string;serverName:string;toolName:string;description:string}>>([]);
onMounted(async()=>{
  if(!props.projectId)return;
  try{
    const settings=await v1<{researchMcpTools?:boolean}>('/api/v1/agent-settings');
    if(settings.researchMcpTools!==false){
      const candidates=await v1<{tools:Array<{qualifiedName:string;serverName:string;toolName:string;description:string}>}>('/api/v1/research/mcp-candidates');
      mcpCandidates.value=candidates.tools;
    }
  }catch{ /* 候选拉取失败不阻塞研究设置；提交时服务端仍会校验 */ }
});
function toggleMcpTool(qualifiedName:string){
  emit('update:mcpToolIds',props.mcpToolIds.includes(qualifiedName)?props.mcpToolIds.filter(id=>id!==qualifiedName):[...props.mcpToolIds,qualifiedName]);
}
// 折叠摘要与提交共用 normalizeDecision 单一事实源：命题回退议题、候选剔空、与后端校验同口径
const decisionNormalized=computed(()=>normalizeDecision(props.decision,props.objective??''));
const candidateReady=computed(()=>decisionNormalized.value.ready);
function patchSubject(patch:Partial<ResearchSubjectDraft>){
  emit('update:subject',{title:props.subject?.title??'',content:props.subject?.content??'',...patch});
}
function patchCriterion(index:number,patch:Partial<ResearchCriterionDraft>){
  emit('update:criteria',props.criteria.map((c,i)=>i===index?{...c,...patch}:c));
}
function addCriterion(){
  if(props.criteria.length>=CRITERIA_MAX){toast(`评审标准最多${CRITERIA_MAX}项`,{variant:'warning'});return;}
  emit('update:criteria',[...props.criteria,{text:'',mustHave:false}]);
}
function removeCriterion(index:number){
  if(props.criteria.length<=1){toast('至少保留一项评审标准',{variant:'warning'});return;}
  emit('update:criteria',props.criteria.filter((_,i)=>i!==index));
}
const criteriaReady=computed(()=>props.criteria.some(c=>c.text.trim()));
const subjectReady=computed(()=>!!props.subject&&props.subject.title.trim().length>0&&props.subject.content.trim().length>0);
// 默认展开，让模型/资料区一目了然；用户折叠/展开后记住选择（prism- 前缀 localStorage 惯例）。
const OPEN_KEY='prism-research-setup-open';
const open=ref((()=>{try{return localStorage.getItem(OPEN_KEY)!=='0';}catch{return true;}})());
watch(open,v=>{try{localStorage.setItem(OPEN_KEY,v?'1':'0');}catch{}});
const summary=computed(()=>{
  const overridden=actors.value.filter(a=>props.models[a]).length;
  const bits=[overridden?`角色模型自定义 ${overridden} 项`:'角色跟随任务模型'];
  if(props.mode==='debate'){bits.push(`${props.rounds}轮交锋`);if(decisionOn.value)bits.push(candidateReady.value?'需做决定 · 候选已填':'需做决定 · 候选未填');}
  if(props.mode==='jury'){if(subjectReady.value)bits.push('已填被评对象');if(criteriaReady.value)bits.push(`评审标准 ${props.criteria.filter(c=>c.text.trim()).length} 项`);}
  if(props.sourceText.trim())bits.push('已附共同资料');
  if(props.mcpToolIds.length)bits.push(`MCP 工具 ${props.mcpToolIds.length} 个`);
  return bits.join(' · ');
});
</script>
<template>
<section class="research-setup" data-testid="research-setup">
  <button type="button" class="setup-head" :aria-expanded="open" @click="open=!open">
    <ModeIcon :mode="mode" class="setup-mode-icon" />
    <span class="setup-title">研究设置</span>
    <span class="tag-mock">试验版</span>
    <span v-if="!open" class="setup-summary">{{summary}}</span>
    <UiIcon name="chevron-down" :size="14" class="setup-chevron" :class="{open}" />
  </button>
  <Transition name="setup-expand" @before-enter="el=>el.removeAttribute('inert')" @before-leave="el=>el.setAttribute('inert','')">
  <div v-if="open" class="setup-body-wrap">
  <div class="setup-body-clip">
  <div class="setup-body">
    <p class="setup-note">各参与者使用独立上下文。未单独指定时跟随下方所选模型；同模型的独立运行仍可能存在共同偏差。</p>
    <div class="research-models">
      <label v-for="actor in actors" :key="actor">
        <span>{{labels[actor]}}</span>
        <UiSelect :label="`${labels[actor]}模型`" :model-value="models[actor]||''" @change="change(actor,$event)" :options="[{value:'',label:'跟随任务模型'},...options]" />
      </label>
      <label v-if="mode==='debate'">
        <span>交锋轮次</span>
        <UiSelect label="交锋轮次" :model-value="rounds" @change="emit('update:rounds',Number($event))" :options="[{value:1,label:'1轮'},{value:2,label:'2轮'},{value:3,label:'3轮'}]" />
      </label>
    </div>
    <!-- v2辩论：需要做决定——命题+候选（2—6项）在创建时冻结；更换命题或候选须另建研究 -->
    <div v-if="mode==='debate'" class="research-decision" data-testid="research-decision">
      <label class="decision-toggle">
        <input type="checkbox" :checked="decisionOn" @change="toggleDecision(($event.target as HTMLInputElement).checked)" />
        <span>本议题需要做出决定</span>
      </label>
      <template v-if="decisionOn&&decision">
        <label class="decision-field">
          <span>决定命题</span>
          <input type="text" :value="decision.proposition" maxlength="2000" placeholder="留空则使用上方议题作为决定命题" @input="patchDecision({proposition:($event.target as HTMLInputElement).value})" />
        </label>
        <p v-if="decisionNormalized.propositionFromObjective&&decisionNormalized.proposition" class="setup-note">未填命题时将使用上方议题「{{decisionNormalized.proposition.slice(0,60)}}{{decisionNormalized.proposition.length>60?'…':''}}」。</p>
        <div class="decision-candidates">
          <span class="decision-label">候选方案（至少{{DECISION_CANDIDATES_MIN}}项，最多{{DECISION_CANDIDATES_MAX}}项）</span>
          <div v-for="(candidate,index) in decision.candidates" :key="index" class="candidate-row">
            <input type="text" :value="candidate.text" maxlength="500" :aria-label="`候选方案${index+1}`" placeholder="候选方案文本" @input="patchCandidate(index,($event.target as HTMLInputElement).value)" />
            <button v-if="decision.candidates.length>DECISION_CANDIDATES_MIN" type="button" class="row-remove" :aria-label="`移除候选方案${index+1}`" @click="removeCandidate(index)">×</button>
          </div>
          <div class="candidate-actions">
            <button type="button" class="text-btn" @click="addCandidate()">+ 添加候选</button>
            <button v-if="!decision.candidates.some(c=>c.text.trim()==='维持现状')" type="button" class="text-btn" @click="quickAddStatusQuo()">+ 维持现状</button>
          </div>
          <p class="setup-note">发起后冻结；主持将交付「采用/试验/暂缓」之一。</p>
        </div>
      </template>
    </div>
    <!-- v2评审：被评对象快照+评审标准（1—12项，必达标记）；独立初判不受辩论结论锚定 -->
    <div v-if="mode==='jury'" class="research-jury" data-testid="research-jury">
      <div class="jury-subject">
        <label class="decision-field">
          <span>被评对象标题</span>
          <input type="text" :value="subject?.title||''" maxlength="200" placeholder="如：方案A交付说明" @input="patchSubject({title:($event.target as HTMLInputElement).value})" />
        </label>
        <label class="decision-field">
          <span>被评对象材料（1—20000字符，发起时冻结）</span>
          <textarea aria-label="被评对象材料" :value="subject?.content||''" maxlength="20000" placeholder="粘贴待评审的方案/交付材料原文；评审将以此为准独立核查。" @input="patchSubject({content:($event.target as HTMLTextAreaElement).value})" />
        </label>
      </div>
      <div class="jury-criteria">
        <span class="decision-label">评审标准（1—{{CRITERIA_MAX}}项；勾选「必达」后，全部必达标准判「满足」才可投通过）</span>
        <div v-for="(criterion,index) in criteria" :key="index" class="criterion-row">
          <label class="criterion-must">
            <input type="checkbox" :checked="criterion.mustHave" @change="patchCriterion(index,{mustHave:($event.target as HTMLInputElement).checked})" />
            <span>必达</span>
          </label>
          <input type="text" :value="criterion.text" maxlength="2000" :aria-label="`评审标准${index+1}`" placeholder="如：成本下降10%有可核查依据" @input="patchCriterion(index,{text:($event.target as HTMLInputElement).value})" />
          <button v-if="criteria.length>1" type="button" class="row-remove" :aria-label="`移除评审标准${index+1}`" @click="removeCriterion(index)">×</button>
        </div>
        <div class="candidate-actions">
          <button type="button" class="text-btn" @click="addCriterion()">+ 添加标准</button>
        </div>
        <p class="setup-note">陪审员对每项标准独立给出「满足/未满足/证据不足」及理由；汇总只组织理由，票数由程序计算。</p>
      </div>
    </div>
    <!-- 能力扩展：MCP 只读工具（发起时勾选冻结）。设置关闭或无候选时不渲染 -->
    <div v-if="mcpCandidates.length" class="research-capabilities">
      <div class="cap-block" data-testid="research-mcp">
        <span class="decision-label">MCP 工具（可选；仅只读声明工具，发起时勾选冻结，结果须保存为资料才能引用）</span>
        <div class="cap-tools" role="group" aria-label="勾选 MCP 工具">
          <label v-for="tool in mcpCandidates" :key="tool.qualifiedName" class="cap-tool" :title="tool.description">
            <input type="checkbox" :checked="mcpToolIds.includes(tool.qualifiedName)" @change="toggleMcpTool(tool.qualifiedName)" />
            <span class="cap-tool-name">{{tool.serverName}} / {{tool.toolName}}</span>
          </label>
        </div>
      </div>
    </div>
    <div class="research-source">
      <div class="source-head">
        <span>共同资料（可选，最多20000字符/份）</span>
      </div>
      <!-- 研究复用普通Agent能力：项目文件由参与者以只读工具直接查看（list_dir/grep_files/read_file），
           显式图片附件经输入框附件入口上传（服务端创建时冻结并按角色核验视觉）；这里只收纯文本资料 -->
      <textarea aria-label="共同资料" :value="sourceText" maxlength="20000" placeholder="直接粘贴研究资料原文；来源与结论请分开描述。项目文件可由参与者直接读取，重点图片材料请用输入框附件上传。" @input="emit('update:sourceText',($event.target as HTMLTextAreaElement).value)" />
    </div>
    <p class="setup-note">网页读取可直接使用；关键词搜索需在设置中配置搜索服务。没有引证的结果会标明证据不足。</p>
  </div>
  </div>
  </div>
  </Transition>
</section>
</template>
<style scoped>
/* 发起前研究设置卡：与输入框并成一个气泡——上圆下平，底边框兼作与输入区的分隔线；顶边圆角随输入框 squircle 约定。 */
.research-setup{width:var(--conversation-content-width);margin:0 auto;border:.5px solid var(--border);border-radius:16px 16px 0 0;background:var(--bg-input);overflow:hidden;transition:border-color .12s}
@supports (corner-shape: squircle){.research-setup{corner-shape:squircle;border-radius:32px 32px 0 0}}
.setup-head{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:10px 14px;border:0;background:none;color:var(--fg);text-align:left}
.setup-mode-icon{color:var(--fg-subtle);flex:none}
.setup-title{font-size:var(--text-ui-base);font-weight:500}
.setup-summary{margin-left:auto;color:var(--fg-subtlest);font-size:var(--text-ui-sm);max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.setup-chevron{margin-left:8px;flex:none;color:var(--fg-subtlest);transition:transform .24s cubic-bezier(.2,.8,.2,1)}
.setup-chevron.open{transform:rotate(180deg)}
/* 用内容实际高度伸缩，支持窄屏换行与资料输入框拖高；离场期间禁用内部焦点。 */
.setup-body-wrap{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows .24s cubic-bezier(.2,.8,.2,1),opacity .18s ease}
.setup-body-clip{min-height:0;overflow:hidden}
.setup-expand-enter-from,.setup-expand-leave-to{grid-template-rows:0fr;opacity:0}
.setup-body{display:flex;flex-direction:column;gap:12px;padding:0 14px 14px}
.setup-note{color:var(--fg-subtlest);font-size:var(--text-ui-sm);line-height:1.7}
.research-models{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.research-models label{display:flex;flex-direction:column;gap:5px;min-width:0}
.research-models label>span{font-size:var(--text-ui-sm);color:var(--fg-subtle)}
/* v2差异化表单：决策与评审块沿用资料区观感，子字段缩进一层。 */
.research-decision,.research-jury{display:flex;flex-direction:column;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-s);background:var(--bg-card)}
.decision-toggle{display:flex;align-items:center;gap:8px;font-size:var(--text-ui-sm);color:var(--fg);cursor:pointer}
.decision-toggle input{accent-color:var(--color-icon-blue,#508de0)}
.decision-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.decision-field>span{font-size:var(--text-ui-sm);color:var(--fg-subtle)}
.decision-field input[type="text"],.decision-field textarea{width:100%;min-width:0;border:1px solid var(--border);border-radius:var(--radius-s);background:var(--bg-input);color:var(--fg);padding:8px 10px;font-size:var(--text-ui-base);line-height:1.5}
.decision-field textarea{min-height:96px;resize:vertical}
.decision-field input:focus,.decision-field textarea:focus{outline:none;border-color:var(--border-hover)}
.decision-field input::placeholder,.decision-field textarea::placeholder{color:var(--fg-subtlest)}
.decision-candidates,.jury-criteria{display:flex;flex-direction:column;gap:6px}
.decision-label{font-size:var(--text-ui-sm);color:var(--fg-subtle)}
.candidate-row,.criterion-row{display:flex;align-items:center;gap:6px;min-width:0}
.candidate-row input[type="text"],.criterion-row input[type="text"]{flex:1;min-width:0;border:1px solid var(--border);border-radius:var(--radius-s);background:var(--bg-input);color:var(--fg);padding:7px 10px;font-size:var(--text-ui-sm);line-height:1.5}
.candidate-row input:focus,.criterion-row input:focus{outline:none;border-color:var(--border-hover)}
.candidate-row input::placeholder,.criterion-row input::placeholder{color:var(--fg-subtlest)}
.criterion-must{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:var(--text-ui-xs);color:var(--fg-subtle);cursor:pointer}
.criterion-must input{accent-color:var(--color-icon-blue,#508de0)}
.row-remove{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--fg-subtlest);cursor:pointer;font-size:13px;line-height:1}
.row-remove:hover{background:var(--hover);color:var(--fg)}
.candidate-actions{display:flex;gap:12px;flex-wrap:wrap}
.jury-subject{display:flex;flex-direction:column;gap:10px}
.research-source{display:flex;flex-direction:column;gap:6px}
/* 能力扩展：MCP只读工具勾选清单，沿用资料区观感 */
.research-capabilities{display:flex;flex-direction:column;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-s);background:var(--bg-card)}
.cap-block{display:flex;flex-direction:column;gap:6px}
.cap-tools{display:flex;flex-direction:column;gap:4px}
.cap-tool{display:flex;align-items:center;gap:8px;font-size:var(--text-ui-sm);color:var(--fg);min-width:0;cursor:pointer}
.cap-tool input{accent-color:var(--color-icon-blue,#508de0);flex:none}
.cap-tool-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.source-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.source-head>span{font-size:var(--text-ui-sm);color:var(--fg-subtle)}
.research-source textarea{width:100%;min-width:0;min-height:64px;resize:vertical;border:1px solid var(--border);border-radius:var(--radius-s);background:var(--bg-input);color:var(--fg);padding:8px 10px;font-size:var(--text-ui-base);line-height:1.5}
.research-source textarea::placeholder{color:var(--fg-subtlest)}
.research-source textarea:focus{outline:none;border-color:var(--border-hover)}
:global([data-reduce-motion=true]) .setup-body-wrap,:global([data-reduce-motion=true]) .setup-chevron{transition:none}
@media(prefers-reduced-motion:reduce){.setup-body-wrap,.setup-chevron{transition:none}}
</style>
