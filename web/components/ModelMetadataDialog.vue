<script setup lang="ts">
// Vue adaptation of ZCode ProviderModelMetadataDialog, ModelEditorAdvanced,
// ProviderModelModalityOptions, ProviderModelReasoningLevelEditor (Apache-2.0).
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { ModelAdvancedOptions, ModelConfigView, ModelMetadataView, ThinkingLevel } from '../../contracts/models';
import { THINKING_LEVELS } from '../../contracts/models';
import { v1 } from '../api';
import UiIcon from './UiIcon.vue';

const props=defineProps<{model:ModelConfigView['models'][number];protocol:string;baseUrl:string;commit:(parameters:Record<string,unknown>)=>Promise<boolean>}>();
const emit=defineEmits<{(e:'close'):void}>();
const original=JSON.parse(JSON.stringify(props.model.parameters)) as Record<string,unknown>;
const saved=(original.advanced??{}) as ModelAdvancedOptions;
const metadata=ref<ModelMetadataView|undefined>(props.model.metadata);
const smart=ref(saved.smartConfig!==false),image=ref(saved.image??props.model.visionSupported),levels=ref<string[]>([...(saved.thinkingLevels??props.model.thinkingLevels)]);
const context=ref(String(original.contextWindow??'')),maxOutput=ref(String(original.maxOutputTokens??''));
const mapping=ref(saved.thinkingParameterMap?JSON.stringify(saved.thinkingParameterMap,null,2):'');
const expanded=ref(false),busy=ref(false),error=ref(''),errorField=ref(''),reset=ref(false),imageEdited=ref(false),levelsEdited=ref(false),mapEdited=ref(false);
const dialog=ref<HTMLElement>(),contextInput=ref<HTMLInputElement>(),mappingInput=ref<HTMLTextAreaElement>();
const previousFocus=document.activeElement as HTMLElement|null;
const controller=new AbortController();let disposed=false;
const defaults=computed(()=>metadata.value?.defaults??{image:false,thinkingLevels:[],contextWindow:null,maxOutputTokens:4096});
const sourceLabel=computed(()=>({manual:'手动配置', 'vendor-docs':'官方文档',catalog:'Pi 模型目录',unverified:'当前接口未验证'})[metadata.value?.source??'unverified']);
const example=computed(()=>JSON.stringify(props.protocol==='anthropic-messages'?{thinking:{type:'enabled'},output_config:{effort:'$level'}}:{reasoning_effort:'$level'},null,2));
function resetForm(){smart.value=true;image.value=defaults.value.image;levels.value=[...defaults.value.thinkingLevels];context.value='';maxOutput.value='';mapping.value='';reset.value=true;imageEdited.value=false;levelsEdited.value=false;mapEdited.value=false;error.value='';}
function toggleSmart(){if(!smart.value){resetForm();return;}smart.value=false;if(!context.value&&defaults.value.contextWindow!==null)context.value=String(defaults.value.contextWindow);if(!maxOutput.value)maxOutput.value=String(defaults.value.maxOutputTokens);imageEdited.value=true;levelsEdited.value=true;}
function addLevel(){const next=THINKING_LEVELS.find(level=>!levels.value.includes(level));if(next){levels.value.push(next);levelsEdited.value=true;}}
function close(){if(!busy.value)emit('close');}
function keydown(event:KeyboardEvent){
 if(event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopPropagation();close();}
 if(event.key==='Tab'){
  const nodes=[...dialog.value!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')].filter(node=>node.getClientRects().length&&!node.closest('[inert]'));
  const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
 }
}
async function save(){
 if(busy.value)return;error.value='';errorField.value='';
 const parameters={...original};if(reset.value){delete parameters.advanced;delete parameters.contextWindow;delete parameters.maxOutputTokens;}
 const fail=(message:string,field:string):never=>{errorField.value=field;throw new Error(message);};
 try{
  for(const [key,value] of [['contextWindow',context.value],['maxOutputTokens',maxOutput.value]]){
   const text=String(value).trim();if(!text){delete parameters[key!];continue;}
   const n=Number(text);if(!/^\d+$/.test(text)||!Number.isSafeInteger(n)||n<(key==='contextWindow'?4096:1)||n>2000000)fail(key==='contextWindow'?'上下文窗口须为4096—2000000整数':'最大输出Token须为1—2000000整数',String(key));parameters[key!]=n;
  }
  if(!smart.value&&(!context.value.trim()||!maxOutput.value.trim()))fail('关闭智能配置后，请填写上下文窗口和最大输出Token','contextWindow');
  if(levels.value.some((level,index,all)=>!(THINKING_LEVELS as readonly string[]).includes(level)||(index>0&&(THINKING_LEVELS as readonly string[]).indexOf(level)<=(THINKING_LEVELS as readonly string[]).indexOf(all[index-1]!)))||new Set(levels.value).size!==levels.value.length)fail('推理等级须从低到高填写且不能重复','levels');
  const advanced:ModelAdvancedOptions=reset.value?{}:{...saved};
  if(!smart.value)advanced.smartConfig=false;else delete advanced.smartConfig;
  if(imageEdited.value||!smart.value)advanced.image=image.value;
  if(levelsEdited.value||!smart.value)advanced.thinkingLevels=[...levels.value] as ThinkingLevel[];
  if(mapEdited.value||reset.value){
   if(mapping.value.trim()){
    let parsed:unknown;try{parsed=JSON.parse(mapping.value);}catch{fail('推理参数映射须为有效JSON；请检查引号和逗号','mapping');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail('推理参数映射须为JSON对象','mapping');advanced.thinkingParameterMap=parsed as Record<string,unknown>;
   }else delete advanced.thinkingParameterMap;
  }
  if(Object.keys(advanced).length)parameters.advanced=advanced;else delete parameters.advanced;
  if(typeof parameters.thinkingLevel==='string'&&!levels.value.includes(parameters.thinkingLevel))delete parameters.thinkingLevel;
  delete parameters.thinkingMode;
  busy.value=true;const success=await props.commit(parameters);if(success&&!disposed)emit('close');else if(!success)error.value='保存未完成，请核对配置后重试';
 }catch(e){error.value=e instanceof Error?e.message:'保存失败';if(/推理|映射/.test(error.value)&&!errorField.value){errorField.value='mapping';}if(errorField.value==='mapping'||errorField.value==='levels')expanded.value=true;await nextTick();if(errorField.value==='mapping')mappingInput.value?.focus();else if(errorField.value==='contextWindow')contextInput.value?.focus();}
 finally{busy.value=false;}
}
onMounted(async()=>{
 await nextTick();contextInput.value?.focus();contextInput.value?.select();
 // 模型ID/协议/端点可能在外层草稿中已改变，不能沿用旧条目的派生能力。
 try{const resolved=await v1<ModelMetadataView>('/api/v1/model-configs/resolve-model',{method:'POST',body:JSON.stringify({protocol:props.protocol,baseUrl:props.baseUrl,modelId:props.model.modelId,parameters:original}),signal:controller.signal});if(disposed)return;metadata.value=resolved;if(!imageEdited.value)image.value=reset.value?resolved.defaults.image:resolved.image;if(!levelsEdited.value)levels.value=[...(reset.value?resolved.defaults.thinkingLevels:resolved.thinkingLevels)];}catch{ /* 表单仍可手动配置；保存由服务端校验 */ }
});
onUnmounted(()=>{disposed=true;controller.abort();nextTick(()=>{if(previousFocus?.isConnected)previousFocus.focus();});});
</script>

<template>
 <Teleport to="body"><div class="model-meta-overlay" @click.self="close">
  <section ref="dialog" class="model-meta-dialog" role="dialog" aria-modal="true" aria-labelledby="model-meta-title" @keydown="keydown">
   <header class="model-meta-header"><div class="model-meta-title"><h2 id="model-meta-title">编辑模型配置</h2><button type="button" aria-label="关闭模型配置" :disabled="busy" @click="close"><UiIcon name="x" :size="20"/></button></div>
    <div class="model-meta-smart"><span>智能配置</span><span class="model-meta-help" tabindex="0" title="自动使用官方事实与Pi目录，仍可单独覆盖图片能力和推理参数。关闭后由手动配置决定。">?</span><button class="model-meta-switch" role="switch" aria-label="智能配置" :aria-checked="smart" :disabled="busy" type="button" @click="toggleSmart"></button><span class="model-meta-source">{{sourceLabel}}</span></div>
   </header>
   <form class="model-meta-form" @submit.prevent="save"><div class="model-meta-scroll" :inert="busy">
    <p class="model-meta-id">{{model.modelId}}</p>
    <label class="model-meta-field">上下文窗口 <input ref="contextInput" v-model="context" inputmode="numeric" aria-label="上下文窗口" :placeholder="defaults.contextWindow===null?'未收录':String(defaults.contextWindow)" autocomplete="off"></label>
    <label class="model-meta-field">最大输出 Token <input v-model="maxOutput" inputmode="numeric" aria-label="最大输出 Token" :placeholder="String(defaults.maxOutputTokens)" autocomplete="off"></label>
    <button class="model-meta-advanced" type="button" :aria-expanded="expanded" aria-controls="model-meta-advanced" @click="expanded=!expanded"><UiIcon :name="expanded?'chevron-down':'chevron-right'" :size="18"/>高级配置</button>
    <div id="model-meta-advanced" class="model-meta-advanced-body" :class="{expanded}" :inert="!expanded" :aria-hidden="!expanded"><div class="model-meta-advanced-inner">
     <div class="model-meta-field"><span>输入类型 <span class="model-meta-help" tabindex="0" title="勾选当前模型实际支持的输入。文本为必选；图片开关同时控制附件入口和实际请求。">?</span></span><div class="model-meta-options">
      <button class="model-meta-option" type="button" role="checkbox" aria-label="文本" aria-checked="true" disabled><span class="model-meta-checkbox checked">✓</span>文本 <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/></svg></button>
      <button class="model-meta-option" :class="{selected:image}" type="button" role="checkbox" aria-label="图片" :aria-checked="image" @click="image=!image;imageEdited=true"><span class="model-meta-checkbox" :class="{checked:image}">{{image?'✓':''}}</span>图片</button>
      <button v-for="name in ['视频','PDF']" :key="name" class="model-meta-option" type="button" role="checkbox" :aria-label="name" aria-checked="false" disabled title="棱镜暂不支持直接发送此类内容"><span class="model-meta-checkbox"></span>{{name}}</button>
     </div></div>
     <div class="model-meta-field"><span>模型能力 <span class="model-meta-help" tabindex="0" title="这些原生能力暂不可用；联网检索仍可使用搜索工具。">?</span></span><div class="model-meta-options"><button v-for="name in ['结构化输出','原生联网搜索','对话中系统消息']" :key="name" class="model-meta-option" type="button" role="checkbox" :aria-label="name" aria-checked="false" disabled title="棱镜暂未启用此项模型原生能力"><span class="model-meta-checkbox"></span>{{name}}</button></div></div>
     <div class="model-meta-field"><span>推理等级（从低到高） <span class="model-meta-help" tabindex="0" title="只填写模型支持的档位。未验证接口需要同时填写请求参数映射。">?</span></span><div class="model-meta-levels"><div v-for="(_,index) in levels" :key="index" class="model-meta-level"><input v-model="levels[index]" :aria-label="`推理等级 ${index+1}`" autocomplete="off" @input="levelsEdited=true"><button type="button" :aria-label="`删除推理等级 ${index+1}`" @click="levels.splice(index,1);levelsEdited=true"><UiIcon name="x" :size="12"/></button></div><button class="model-meta-add" type="button" aria-label="添加推理等级" :disabled="levels.length>=7" @click="addLevel"><UiIcon name="plus" :size="20"/></button></div><p v-if="!levels.length" class="model-meta-note">此接口尚无可选档位，可手动添加并设置参数映射。</p></div>
     <label class="model-meta-field">推理参数映射 <span class="model-meta-help" tabindex="0" title="填写JSON请求字段；$level替换为所选档位。也可用low/high/max等档位作为键，为每一档指定JSON请求字段。">?</span><textarea ref="mappingInput" v-model="mapping" aria-label="推理参数映射" spellcheck="false" :placeholder="example" @input="mapEdited=true"></textarea></label>
    </div></div>
    <p v-if="error" class="model-meta-error" role="alert">{{error}}</p>
   </div><footer class="model-meta-footer"><button class="model-meta-reset" type="button" :disabled="busy" @click="resetForm">重置表单</button><div><button class="model-meta-cancel" type="button" :disabled="busy" @click="close">取消</button><button class="model-meta-save" type="submit" :disabled="busy">{{busy?'保存中…':'保存'}}</button></div></footer></form>
  </section>
 </div></Teleport>
</template>

<style scoped>
.model-meta-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgb(0 0 0/.5)}
.model-meta-dialog{width:min(672px,100%);max-height:min(768px,calc(100dvh - 48px));display:flex;flex-direction:column;overflow:clip;border:1px solid var(--border);border-radius:14px;background:var(--bg-panel);color:var(--fg);box-shadow:0 20px 70px rgb(0 0 0/.25);font-size:14px}
.model-meta-header{padding:22px 24px 10px}.model-meta-title{display:flex;align-items:center;justify-content:space-between;gap:16px}.model-meta-title h2{margin:0;font-size:16px;font-weight:600}.model-meta-title button{display:grid;place-items:center;border:0;background:transparent;color:var(--fg-subtle);padding:4px;cursor:pointer}.model-meta-smart{display:flex;align-items:center;gap:10px;margin-top:20px}.model-meta-help{display:inline-grid;place-items:center;width:14px;height:14px;border:1px solid var(--fg-subtle);border-radius:50%;font-size:10px;line-height:1;color:var(--fg-subtle);cursor:help;vertical-align:middle}.model-meta-source{margin-left:auto;font-size:11px;color:var(--fg-subtle)}
.model-meta-switch{position:relative;width:32px;height:18px;padding:0;border:1px solid var(--border);border-radius:999px;background:var(--secondary);cursor:pointer}.model-meta-switch[aria-checked=true]{background:var(--fg);border-color:var(--fg)}.model-meta-switch:after{content:'';position:absolute;top:1px;left:1px;width:14px;height:14px;border-radius:50%;background:var(--fg-subtle)}.model-meta-switch[aria-checked=true]:after{left:15px;background:var(--bg)}
.model-meta-form{display:flex;flex-direction:column;min-height:0;overflow:hidden}.model-meta-scroll{overflow:auto;min-height:0;padding:4px 24px 18px;overscroll-behavior:contain}.model-meta-id{margin:4px 0 18px;color:var(--fg-subtle);font-size:12px}.model-meta-field{display:flex;flex-direction:column;gap:9px;margin-bottom:21px;color:var(--fg-subtle)}.model-meta-field>input,.model-meta-field textarea{width:100%;min-width:0;border:1px solid var(--border);border-radius:9px;background:transparent;color:var(--fg);padding:11px 12px;font:inherit;outline-offset:2px}.model-meta-field input::placeholder,.model-meta-field textarea::placeholder{color:var(--fg-subtle);opacity:.55}.model-meta-advanced{display:flex;align-items:center;gap:8px;padding:4px 8px;margin:4px 0 20px;border:0;background:transparent;color:var(--fg);font:inherit;cursor:pointer}
.model-meta-advanced-body{display:grid;grid-template-rows:0fr;visibility:hidden;opacity:0;transition:grid-template-rows .18s,opacity .18s,visibility .18s}.model-meta-advanced-body.expanded{grid-template-rows:1fr;visibility:visible;opacity:1}.model-meta-advanced-inner{min-height:0;overflow:hidden;padding:0 1px}.model-meta-options{display:flex;flex-wrap:wrap;gap:8px}.model-meta-option{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:9px;background:transparent;color:var(--fg);padding:10px 12px;font:inherit;cursor:pointer}.model-meta-option.selected,.model-meta-option[aria-checked=true]{background:var(--secondary)}.model-meta-option:disabled{cursor:default;color:var(--fg-subtle)}.model-meta-checkbox{width:16px;height:16px;display:inline-grid;place-items:center;flex:none;border:1px solid var(--border);border-radius:4px;font-size:12px}.model-meta-checkbox.checked{background:var(--fg);border-color:var(--fg);color:var(--bg)}
.model-meta-levels{display:flex;flex-wrap:wrap;gap:7px}.model-meta-level{position:relative;display:flex;align-items:center}.model-meta-level input{width:86px;border:1px solid var(--border);border-radius:9px;background:transparent;color:var(--fg);padding:10px 23px 10px 10px;font:inherit}.model-meta-level button{position:absolute;right:5px;display:grid;place-items:center;border:0;padding:2px;background:transparent;color:var(--fg-subtle);cursor:pointer}.model-meta-add{width:36px;display:grid;place-items:center;border:1px solid var(--border);border-radius:9px;background:transparent;color:var(--fg);cursor:pointer}.model-meta-field textarea{height:132px;min-height:132px;max-height:132px;resize:none;font-family:ui-monospace,monospace;font-size:12px;line-height:1.6}.model-meta-note{margin:0;font-size:12px;line-height:1.6}.model-meta-error{color:var(--danger);font-size:12px;white-space:pre-wrap}.model-meta-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 24px 20px;background:var(--bg-panel)}.model-meta-footer>div{display:flex;gap:14px;align-items:center}.model-meta-footer button{font:inherit;cursor:pointer}.model-meta-reset{border:0;background:transparent;color:var(--fg-subtle);text-decoration:underline;text-underline-offset:4px;padding:0}.model-meta-cancel{border:0;background:transparent;color:var(--fg);padding:9px 4px}.model-meta-save{border:1px solid var(--fg);border-radius:8px;background:var(--fg);color:var(--bg);padding:9px 16px}.model-meta-dialog button:disabled{cursor:default;opacity:.55}.model-meta-dialog .model-meta-option[aria-checked=true]:disabled{opacity:1;color:var(--fg)}
@media(max-width:600px){.model-meta-overlay{padding:12px}.model-meta-dialog{max-height:calc(100dvh - 24px)}.model-meta-header{padding:18px 16px 10px}.model-meta-scroll{padding:4px 16px 16px}.model-meta-footer{padding:12px 16px 16px}.model-meta-source{font-size:10px}.model-meta-option{padding:9px 10px}}
@media(prefers-reduced-motion:reduce){.model-meta-advanced-body{transition:none}}
</style>
