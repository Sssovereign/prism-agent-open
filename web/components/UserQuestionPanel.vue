<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import UiIcon from './UiIcon.vue';
import {ignoredKeyEvent} from '../keyboardShortcuts';
import type { RealRunSession } from '../view-model/realRun';
import type { UserQuestionRequest } from '../../contracts/userQuestions';
const props=defineProps<{request:UserQuestionRequest;session:RealRunSession}>();
const index=ref(0),drafts=ref<Record<string,{selected:string[];custom:string}>>({}),error=ref(''),collapsed=ref(false),active=ref(-1),now=ref(Date.now());
const key=`prism:question-draft:${props.request.runId}:${props.request.id}`;
try{const saved=JSON.parse(sessionStorage.getItem(key)??'null');if(saved&&typeof saved==='object'&&saved.drafts){drafts.value=saved.drafts;index.value=Math.max(0,Math.min(props.request.questions.length-1,Number(saved.index)||0));}}catch{/* storage may be unavailable */}
watch([drafts,index],()=>{try{sessionStorage.setItem(key,JSON.stringify({index:index.value,drafts:drafts.value}));}catch{}},{deep:true});
const question=computed(()=>props.request.questions[index.value]!);
const draft=computed(()=>drafts.value[question.value.question]??{selected:[],custom:''});
const preview=computed(()=>!question.value.multiSelect?question.value.options[active.value]?.preview:undefined);
const remaining=computed(()=>props.request.deadlineAt?Math.max(0,Math.ceil((Date.parse(props.request.deadlineAt)-now.value)/1000)):null);
const last=computed(()=>index.value===props.request.questions.length-1);
const questionExpanded=ref(false);
const longQuestion=computed(()=>question.value.question.length>80||question.value.question.includes('\n'));
const root=ref<HTMLElement>(),customInput=ref<HTMLTextAreaElement>();
function resizeCustomInput(){const el=customInput.value;if(!el)return;el.style.height='auto';el.style.height=`${el.scrollHeight}px`;}
watch([()=>draft.value.custom,index],()=>void nextTick(resizeCustomInput),{immediate:true});
function focusCard(){void nextTick(()=>root.value?.focus({preventScroll:true}));}
watch(index,()=>{questionExpanded.value=false;void nextTick(()=>root.value?.querySelector('.question-body')?.scrollTo({top:0}));});
focusCard();
let pausing=false;
async function interact(){
 if(!props.request.deadlineAt||pausing)return;pausing=true;
 try{await props.session.pauseQuestion(props.request.id);error.value='';}
 catch(e){error.value=e instanceof Error?e.message:'暂停计时失败，请重试';}
 finally{pausing=false;}
}
function save(selected:string[],custom:string){drafts.value={...drafts.value,[question.value.question]:{selected,custom}};}
async function select(label:string){
 if(props.session.busy.value)return;
 void interact();
 const selected=question.value.multiSelect?(draft.value.selected.includes(label)?draft.value.selected.filter(v=>v!==label):[...draft.value.selected,label]):[label];
 save(selected,question.value.multiSelect?draft.value.custom:'');
 if(!question.value.multiSelect)await advance();
}
function custom(event:Event){void interact();save(question.value.multiSelect?draft.value.selected:[],(event.target as HTMLTextAreaElement).value);}
function back(){void interact();index.value=Math.max(0,index.value-1);active.value=-1;focusCard();}
async function advance(){
 if(props.session.busy.value)return;
 void interact();
 if(!question.value.multiSelect&&!draft.value.selected.length&&!draft.value.custom.trim()&&active.value>=0&&active.value<question.value.options.length)save([question.value.options[active.value]!.label],'');
 if(!last.value){index.value++;active.value=-1;focusCard();return;}
 const answers=Object.fromEntries(props.request.questions.flatMap(q=>{const d=drafts.value[q.question];const values=[...(d?.selected??[]),...(d?.custom.trim()?[d.custom.trim()]:[])];return values.length?[[q.question,values]]:[];}));
 await submit({action:'answer',answers});
}
async function submit(response:import('../../contracts/userQuestions').UserQuestionResponse){
 error.value='';try{await props.session.answerQuestion(props.request.id,response);sessionStorage.removeItem(key);}
 catch(e){error.value=e instanceof Error?e.message:'回答提交失败，请重试';}
}
function moveSelection(direction:1|-1){
 void interact();const count=question.value.options.length+1;
 active.value=active.value<0?(direction>0?0:count-1):(active.value+direction+count)%count;
 void nextTick(()=>root.value?.querySelectorAll<HTMLElement>('[data-question-option]')[active.value]?.focus({preventScroll:true}));
}
function dismiss(){void interact();void submit({action:'skip'});}
function keyboard(event:KeyboardEvent){
 if(ignoredKeyEvent(event)||event.ctrlKey||event.metaKey||event.altKey||props.session.busy.value)return;
 const input=event.target instanceof HTMLTextAreaElement;
 const option=event.target instanceof HTMLElement&&event.target.matches('button[data-question-option]');
 const card=event.target===root.value;
 // ZCode reports real navigation, never programmatic focus, as the first interaction.
 if(event.key==='Tab'){void interact();if(option||card){event.preventDefault();moveSelection(event.shiftKey?-1:1);}return;}
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(index.value>0)back();else dismiss();return;}
 if(input){if(event.key==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey){event.preventDefault();void advance();}return;}
 // Space retains the button's native toggle; Enter confirms the current multi-selection.
 if(event.key==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&(card||(question.value.multiSelect&&option))){
  event.preventDefault();event.stopPropagation();void advance();return;
 }
 if((option||card)&&['ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(event.key)){
  event.preventDefault();moveSelection(event.key==='ArrowDown'||event.key==='ArrowRight'?1:-1);
 }
}
const timer=setInterval(()=>now.value=Date.now(),1000);
onBeforeUnmount(()=>clearInterval(timer));
</script>
<template>
 <section ref="root" class="user-question-panel" :class="{'is-collapsed':collapsed}" :tabindex="active<0?0:-1" role="region" aria-label="Agent 提问" data-elicitation-dialog-card @pointerenter="interact" @keydown="keyboard">
  <div class="question-inner">
   <div class="question-body" data-elicitation-dialog-body>
    <header class="question-header">
     <div class="question-title">
      <span class="question-badge" :title="question.header">{{question.header}}</span>
      <span class="question-text" :class="{'question-text-clamped':longQuestion&&!questionExpanded}">{{question.question}}</span>
      <button v-if="longQuestion" class="question-mobile-expand question-ghost" type="button" :aria-expanded="questionExpanded" @click="questionExpanded=!questionExpanded;interact()"><UiIcon :name="questionExpanded?'chevron-up':'chevron-down'" :size="12"/>{{questionExpanded?'收起问题':'展开问题'}}</button>
     </div>
     <nav class="question-pages" aria-label="题目导航">
      <button v-if="remaining!==null&&remaining<60&&remaining>0" class="question-countdown" type="button" aria-label="停止计时" title="停止计时" @click="interact">{{remaining}}秒</button>
      <button class="question-mobile-toggle question-icon" type="button" :aria-expanded="!collapsed" aria-label="收起提问面板" title="收起提问面板" @click="collapsed=true;interact()"><UiIcon name="chevron-down" :size="12"/></button>
      <button class="question-icon" type="button" :disabled="index===0||session.busy.value" aria-label="上一题" title="上一题" @click="back"><UiIcon name="chevron-left" :size="12"/></button>
      <span class="question-page-count">{{index+1}} / {{request.questions.length}}</span>
      <button class="question-icon" type="button" :disabled="last||session.busy.value" aria-label="下一题" title="下一题" @click="advance"><UiIcon name="chevron-right" :size="12"/></button>
     </nav>
    </header>
    <div class="question-content" :class="{'has-preview':preview}">
     <div class="question-options" :role="question.multiSelect?'group':'listbox'" :aria-label="question.question">
      <button v-for="(option,i) in question.options" :key="option.label" type="button" data-question-option class="question-option" :class="{selected:draft.selected.includes(option.label),active:active===i}" :role="question.multiSelect?'checkbox':'option'" :aria-checked="question.multiSelect?draft.selected.includes(option.label):undefined" :aria-selected="!question.multiSelect?draft.selected.includes(option.label):undefined" :tabindex="active===i||(active<0&&i===0)?0:-1" :disabled="session.busy.value" @focus="active=i" @click="select(option.label)">
       <span v-if="question.multiSelect" class="question-checkbox" :class="{checked:draft.selected.includes(option.label)}" aria-hidden="true"><UiIcon name="check" :size="12"/></span>
       <span v-else class="option-number" aria-hidden="true">{{i+1}}.</span>
       <span class="question-option-copy"><strong>{{option.label}}</strong><span class="question-description">{{option.description}}</span></span>
      </button>
      <div class="question-custom" :class="{selected:!!draft.custom.trim(),active:active===question.options.length}" @click="customInput?.focus()">
       <span v-if="question.multiSelect" class="question-checkbox" :class="{checked:!!draft.custom.trim()}" aria-hidden="true"><UiIcon name="check" :size="12"/></span>
       <span v-else class="option-number" aria-hidden="true">{{question.options.length+1}}.</span>
       <textarea ref="customInput" data-question-option :value="draft.custom" :tabindex="active===question.options.length?0:-1" rows="1" maxlength="4000" wrap="soft" aria-label="自定义回答" placeholder="输入你的回答…" :disabled="session.busy.value" @focus="active=question.options.length" @input="custom"/>
      </div>
     </div>
     <pre v-if="preview" class="question-preview">{{preview}}</pre>
    </div>
   </div>
   <div class="question-summary">
    <button class="question-summary-title" type="button" @click="collapsed=false;interact()"><span class="question-badge">{{question.header}}</span><span>{{question.question}}</span></button>
    <span class="question-page-count">{{index+1}} / {{request.questions.length}}</span>
    <button class="question-icon" type="button" aria-label="展开提问面板" aria-expanded="false" @click="collapsed=false;interact()"><UiIcon name="chevron-up" :size="12"/></button>
   </div>
   <p v-if="error" class="question-error" role="alert">{{error}} <button v-if="request.deadlineAt" type="button" class="question-ghost" @click="interact">重试暂停</button></p>
   <footer class="question-footer" data-elicitation-dialog-footer>
    <p class="question-hint"><UiIcon name="info" :size="16"/><span>{{question.multiSelect?'Space 勾选 · ':''}}Enter 继续 · Shift+Enter 换行<span v-if="!request.deadlineAt"> · 等待你的回答</span></span></p>
    <div class="question-actions"><button class="question-action question-action-outline" type="button" :disabled="session.busy.value" @click="dismiss">跳过</button><button class="question-action question-action-primary" type="button" :disabled="session.busy.value" @click="advance">{{session.busy.value?'正在提交…':last?'提交':'下一题'}}</button></div>
   </footer>
  </div>
 </section>
</template>
<style scoped>
/* ElicitationDialog.tsx + Button/Badge/Textarea at ZCode a9fe401, translated to Vue/CSS.
   Match the existing conversation column; z-index keeps the sibling turn navigator behind the card. */
.user-question-panel{position:relative;z-index:11;display:flex;flex-direction:column;width:var(--conversation-content-width,min(896px,calc(100% - 32px)));max-height:min(72dvh,42rem,calc(100dvh - 208px));margin:0 auto 8px;min-width:0;overflow:hidden;border:1px solid var(--border);border-radius:16px;background:var(--color-popover,var(--bg-card));color:var(--fg);box-shadow:0 1px 2px rgb(0 0 0 / 5%);font-size:var(--text-ui-base);outline:none}
.question-inner{display:flex;flex:1;min-height:0;flex-direction:column;gap:12px;padding:12px}.question-body{display:flex;flex:1;min-height:0;flex-direction:column;gap:12px;overflow-y:auto;overscroll-behavior:contain;padding-right:4px}.question-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.question-title{flex:1;min-width:0;font-weight:500;line-height:24px;overflow-wrap:anywhere}.question-text{white-space:pre-wrap}.question-badge{display:inline-flex;max-width:160px;height:20px;align-items:center;overflow:hidden;vertical-align:baseline;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--border);border-radius:999px;background:color-mix(in oklab,var(--bg-input) 20%,transparent);padding:0 8px;margin-right:8px;font-size:var(--text-ui-base);font-weight:500;line-height:18px}.question-pages{display:flex;flex:none;align-items:center;gap:4px;font-weight:500;line-height:1.2;color:var(--fg-subtlest)}.question-page-count{min-width:40px;text-align:center;white-space:nowrap;font-variant-numeric:tabular-nums}
.question-icon,.question-ghost,.question-countdown{display:inline-flex;flex:none;align-items:center;justify-content:center;gap:4px;height:20px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--fg);padding:0;font:inherit;cursor:pointer}.question-icon{width:20px}.question-ghost{padding:0 6px}.question-icon:hover,.question-ghost:hover{background:var(--hover)}.question-countdown{min-width:40px;padding:0 6px;background:var(--secondary);color:var(--fg-subtle);font-variant-numeric:tabular-nums}.question-mobile-toggle,.question-mobile-expand{display:none}
.question-content{min-width:0}.question-content.has-preview{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}.question-options{display:grid;gap:4px;min-width:0}.question-option,.question-custom{display:flex;width:100%;min-width:0;align-items:center;gap:12px;border:0;border-radius:12px;padding:8px 12px;background:transparent;color:var(--fg);text-align:left;transition:background-color .15s;font:inherit;line-height:1.5}.question-option{cursor:pointer}.question-option:hover,.question-option.active,.question-custom:hover,.question-custom.active{background:var(--hover)}.question-option.selected,.question-custom.selected{background:var(--selected)}.question-option:focus-visible{outline:none;background:var(--hover)}.question-option-copy{min-width:0;flex:1;overflow-wrap:anywhere}.question-option-copy strong{font-weight:500}.question-description{margin-left:8px;color:var(--fg-subtle)}.option-number{width:20px;flex:none;align-self:center;color:var(--fg-subtlest);font-weight:500}.question-checkbox{display:flex;width:16px;height:16px;flex:none;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:2px;color:transparent}.question-checkbox.checked{border-color:var(--color-brand);background:var(--color-brand);color:var(--color-foreground-inverse)}.question-custom{cursor:text}.question-custom .option-number{align-self:flex-start;margin-top:1px}.question-custom textarea{display:block;field-sizing:content;flex:1;min-width:0;width:100%;min-height:1.5em;max-height:7.5em;overflow-y:auto;resize:none;border:0;border-radius:0;background:transparent;color:var(--fg);padding:0;font:inherit;font-weight:500;line-height:1.5;outline:none;box-shadow:none}.question-custom textarea::placeholder{color:var(--fg-subtlest);font-weight:400}.question-custom textarea:focus-visible{outline:none}.question-preview{min-width:0;margin:0;padding:8px 12px;border-left:1px solid var(--border);white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--text-ui-base);line-height:1.5}
.question-footer{display:flex;flex:none;align-items:center;justify-content:space-between;gap:8px;padding:0 4px}.question-hint{display:flex;flex:1;min-width:0;align-items:center;gap:8px;margin:0;color:var(--fg-subtle);line-height:1.5}.question-hint>.ui-icon{color:var(--fg)}.question-actions{display:flex;flex:none;align-items:center;gap:8px}.question-action{display:inline-flex;flex:none;align-items:center;justify-content:center;height:32px;gap:4px;border:1px solid transparent;border-radius:8px;padding:0 10px;font:inherit;line-height:1.5;white-space:nowrap;cursor:pointer;transition:background-color .15s}.question-action-outline{border-color:var(--border);background:transparent;color:var(--fg)}.question-action-outline:hover{border-color:var(--border-hover);background:color-mix(in oklab,var(--bg-input) 50%,transparent)}.question-action-primary{border-color:transparent;background:var(--color-brand);color:var(--color-foreground-inverse)}.question-action-primary:hover{background:color-mix(in oklab,var(--color-brand) 80%,transparent)}.question-action:focus-visible,.question-icon:focus-visible,.question-ghost:focus-visible{outline:2px solid var(--fg-subtle);outline-offset:2px}.user-question-panel button:disabled{pointer-events:none;opacity:.5}.question-error{flex:none;margin:0;color:var(--danger);font-size:var(--text-ui-sm);overflow-wrap:anywhere}.question-summary{display:none}
@media(max-width:767px){.question-mobile-toggle,.question-mobile-expand{display:inline-flex}.question-mobile-expand{margin-top:8px}.question-text-clamped{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}.is-collapsed .question-body,.is-collapsed .question-footer{display:none}.is-collapsed .question-summary{display:flex;min-width:0;align-items:center;gap:8px}.question-summary-title{display:flex;flex:1;min-width:0;align-items:center;gap:0;border:0;border-radius:8px;background:transparent;padding:2px 4px;color:var(--fg);font:inherit;text-align:left}.question-summary-title>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.question-summary-title .question-badge{max-width:128px;flex:none}.question-content.has-preview{grid-template-columns:1fr}.question-preview{border-left:0;border-top:1px solid var(--border);padding:8px 12px 0}}
@media(max-width:639px){.question-footer{flex-wrap:wrap}.question-hint{flex-basis:100%}.question-actions{margin-left:auto}.question-custom textarea{font-size:max(16px,var(--text-ui-base))}}
@media(prefers-reduced-motion:reduce){.question-option,.question-action{transition:none}}
</style>
