<script setup lang="ts">
import UiSelect from './UiSelect.vue';
// Vue adaptation of ZCode model-provider-section/{SectionLayout,Navigation,InlineEditableProviderCard,
// ProviderCardSections,ProviderFormControls,ApiKeyInput} and ui/{input,button,switch} (Apache-2.0).
// 状态对齐上游：默认选中首个接口进入其详情卡片；编辑态头部即供应商名（可内联重命名）+ 启停开关；
// 已存 Key 以密文占位显示（凭据网关只存不回传，输入即覆盖、清除按钮显式删除）；新增为独立表单。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import ModelProviderIcon from './ModelProviderIcon.vue';
import ProviderMark from './ProviderMark.vue';
import ProviderDetailFeedback from './ProviderDetailFeedback.vue';
import ComposerSelect, { type ComposerSelectOption } from './ComposerSelect.vue';
import ModelMetadataDialog from './ModelMetadataDialog.vue';
import { v1 } from '../api';
import { modelCapability, THINKING_LEVEL_LABELS, MODEL_PRESETS } from '../../contracts/models';
import type { ModelConfigView } from '../../contracts/models';
import type { ModelConfigInput } from '../../contracts/v1';
import { searchBindingForBaseUrl } from '../../contracts/search';
import { formatTokens } from '../view-model/usage';
type DraftModel = ModelConfigView['models'][number];
type DraftConfig = Omit<ModelConfigInput, 'models'> & { models: DraftModel[] };
const props = defineProps<{ configs: ModelConfigView[]; initialConfigId?: string; binding: string; roleBindings: Record<'pro'|'con'|'host',string> }>();
const emit = defineEmits<{
  (e:'models-changed', value:ModelConfigView[]):void;
  (e:'update:binding', value:string):void;
  (e:'update:roleBindings', value:Record<'pro'|'con'|'host',string>):void;
  (e:'modal-change', value:boolean):void;
}>();
const configs=ref([...props.configs]), draft=ref<DraftConfig>(), editingId=ref(''), revision=ref(0);
const metadataIndex=ref<number|null>(null);
function openMetadata(index:number){metadataIndex.value=index;emit('modal-change',true);}
function closeMetadata(){metadataIndex.value=null;emit('modal-change',false);}
async function commitMetadata(parameters:Record<string,unknown>):Promise<boolean>{
 if(!draft.value||metadataIndex.value===null)return false;
 const model=draft.value.models[metadataIndex.value];if(!model)return false;
 const previous=model.parameters;model.parameters=parameters;busy.value=true;
 try{await saveConfig();return true;}catch(e){model.parameters=previous;throw e;}finally{busy.value=false;}
}
const enabled=ref(true), hasCredential=ref(false), key=ref(''), keyVisible=ref(false), keyTouched=ref(false), keyPrimed=ref(false);
const nameEditing=ref(false), nameDraft=ref('');
// 接口级联网搜索能力位（学 ZCode supportsNativeWebSearch）：勾选随接口保存持久化，运行时优先复用本接口 Key
const searchChecked=ref(false);
const searchNotice=ref<{text:string;error:boolean}|null>(null);
// 凭据网关不回传密钥：未触碰时以固定密文占位表达“已保存”，聚焦后清空等待重输入
const KEY_MASK='•'.repeat(18);
const busy=ref(false), testing=ref(''), discovering=ref(false), error=ref(''), notice=ref('');
const operation=ref(''), testStage=ref<'saving'|'testing'>('saving'), saveComplete=ref(false);
const feedback=ref<{id:number;state:'pending'|'success'|'failure';message:string;detail?:string;emphasis?:boolean}>();
const retryFeedback=ref<()=>Promise<unknown>>();
let feedbackId=0;
function showFeedback(state:'pending'|'success'|'failure',message:string,detail?:string,emphasis=false){feedback.value={id:++feedbackId,state,message,detail,emphasis};}
function edited(){if(!busy.value){feedback.value=undefined;saveComplete.value=false;error.value='';notice.value='';}}
const discovered=ref<string[]>([]), testResults=ref<Record<string,string>>({}), nameInput=ref<HTMLInputElement>();
const roles=[{id:'pro' as const,label:'正方'},{id:'con' as const,label:'反方'},{id:'host' as const,label:'主持'}];
let disposed=false;
const controller=new AbortController();
const request=<T,>(url:string,init:RequestInit={})=>v1<T>(url,{...init,signal:controller.signal});
function payload(config:ModelConfigInput):ModelConfigInput {
  // Legacy preset metadata is retained on edit, never used to prefill a new connection.
  // 只投影输入契约字段：视图模型带 visionSupported 等服务端派生字段，回传会被 additionalProperties:false 拒绝
  return {protocol:config.protocol??'openai-completions',preset:config.preset,name:config.name,baseUrl:config.baseUrl,models:config.models.map(m=>({modelId:m.modelId,displayName:m.displayName,enabled:m.enabled,parameters:{...m.parameters}}))};
}
function toDraft(config:ModelConfigInput, view?:ModelConfigView):DraftConfig {
  // 草稿在契约字段外挂上服务端派生字段（按 modelId 对齐视图）；草稿内新增/发现而来的模型行先给中性默认，保存后 refresh 取回真值
  const base=payload(config), derived=view?.models;
  return {...base, models:base.models.map(m=>{const hit=derived?.find(d=>d.modelId===m.modelId);return {...m,metadata:hit?.metadata,visionSupported:hit?.visionSupported??false,contextWindowDefault:hit?.contextWindowDefault??null,maxOutputTokensDefault:hit?.maxOutputTokensDefault??null,thinkingLevels:hit?.thinkingLevels??[],providerId:hit?.providerId??null};})};
}
function normalizedEndpoint(config:ModelConfigInput):string {
  try { return new URL(config.baseUrl).href.replace(/\/+$/,'').replace(config.protocol==='anthropic-messages'?/\/v1(?:\/messages)?$/:/\/chat\/completions$/,''); }
  catch { return config.baseUrl.trim(); }
}
const connectionChanged=computed(()=>{
  const original=configs.value.find(c=>c.id===editingId.value);
  return !!original&&!!draft.value&&(normalizedEndpoint(original)!==normalizedEndpoint(draft.value)||(original.protocol??'openai-completions')!==draft.value.protocol);
});
const addDirty=computed(()=>{
  const d=draft.value;
  return !!d&&(!!d.name.trim()||!!d.baseUrl.trim()||keyTouched.value||d.models.some(m=>!!m.modelId.trim()||Object.keys(m.parameters).length>0));
});
const hasUnsavedChanges=computed(()=>{
  if(!draft.value)return false;
  if(!editingId.value)return addDirty.value;
  const original=configs.value.find(c=>c.id===editingId.value);
  if(!original)return false;
  // 搜索能力勾选也算待保存变更：勾选意图与接口已存能力位不一致即脏，否则只勾选时保存按钮不启用、勾选静默失效
  const searchIntentChanged=searchChecked.value!==!!original.searchProvider;
  return original.enabled!==enabled.value||keyTouched.value||searchIntentChanged||JSON.stringify(payload(original))!==JSON.stringify(payload(draft.value));
});
// keyPrimed：聚焦后临时清空待输入；未输入内容即失焦则恢复密文且不计脏
const keyDisplay=computed(()=>((keyPrimed.value||keyTouched.value)?key.value:(hasCredential.value&&!connectionChanged.value?KEY_MASK:'')));
const keyHint=computed(()=>{
  if(connectionChanged.value)return keyTouched.value&&key.value.trim()?'接口信息已修改，新 Key 将随保存写入':'接口信息已修改，保存后需重新填写 Key';
  if(hasCredential.value&&!(keyPrimed.value||keyTouched.value))return '已保存在本机账号（不可回显），输入即覆盖';
  if(hasCredential.value&&!key.value.trim())return '留空保存则保留已存 Key';
  return '随本机账号保存';
});
const keyPlaceholder=computed(()=>{
  if(connectionChanged.value)return hasCredential.value?'':'sk-…';
  if(hasCredential.value&&(keyPrimed.value||keyTouched.value)&&!key.value.trim())return '留空保留已保存的 Key';
  return 'sk-…';
});
const eyeDisabled=computed(()=>busy.value||!enabled.value||(keyTouched.value?!key.value.length:true));
const eyeTitle=computed(()=>eyeDisabled.value?((keyPrimed.value||keyTouched.value)?'输入 Key 后可查看':'已保存的 Key 不可回显，修改请重新输入'):(keyVisible.value?'隐藏 API Key':'显示 API Key'));
const usableCredential=computed(()=>(keyTouched.value&&!!key.value.trim())||(hasCredential.value&&!connectionChanged.value));
const headerProviderId=computed(()=>draft.value?.models.find(m=>m.providerId)?.providerId??null);
// 厂商预设：地址主机名映射到支持「同 Key 搜索」的厂商才出现能力勾选（中转站/其他厂商一律不出现）
const vendorOptions=MODEL_PRESETS.map(p=>({value:p.id,label:p.name}));
const searchBindingInfo=computed(()=>draft.value?searchBindingForBaseUrl(draft.value.baseUrl):undefined);
const valid=computed(()=>{
  const d=draft.value;
  return !!d?.name.trim()&&!!d.baseUrl.trim()&&d.models.length>0&&d.models.length<=100&&d.models.every(m=>!!m.modelId.trim())&&new Set(d.models.map(m=>m.modelId.trim())).size===d.models.length;
});
const availableConfigs=computed(()=>configs.value.filter(c=>c.enabled&&c.models.some(m=>m.enabled)));
const modelSelectOptions=computed(()=>availableConfigs.value.flatMap(c=>c.models.filter(m=>m.enabled).map(m=>({value:`${c.id}:${m.modelId}`,label:m.displayName,group:c.name}))));
watch(()=>props.configs,value=>{
  configs.value=[...value];
  const current=value.find(c=>c.id===editingId.value);
  if(current)hasCredential.value=current.hasCredential;
});
watch(()=>props.initialConfigId,id=>{const config=configs.value.find(c=>c.id===id);if(config)selectConfig(config);});
watch(draft,()=>{testResults.value={};if(!applyingDraft)edited();},{deep:true});
watch(key,()=>{testResults.value={};if(!applyingDraft)edited();});
function resetMessages(){feedback.value=undefined;saveComplete.value=false;error.value='';notice.value='';discovered.value=[];testResults.value={};}
function syncKeyState(view:ModelConfigView){hasCredential.value=view.hasCredential;key.value='';keyTouched.value=false;keyPrimed.value=false;keyVisible.value=false;}
// 程序化落草稿守卫：deep watcher 的回调在赋值后的下一个调度帧执行（晚于 busy 复位），
// 不设守卫会把刚写入的保存/重载成功反馈当作用户编辑抹掉；nextTick 晚于 watcher flush，用于解除守卫
let applyingDraft=false;
// preserveReuse：保存后刷新时保留用户刚勾选的联动意图（后端引用由 syncSearchReuse 按勾选写入）；载入其他配置时按后端状态重置
function applyDraftState(view:ModelConfigView){applyingDraft=true;revision.value=view.revision;enabled.value=view.enabled;draft.value=toDraft(view,view);syncKeyState(view);searchChecked.value=view.searchProvider!==null;searchNotice.value=null;nextTick(()=>{applyingDraft=false;});}
function selectConfig(config:ModelConfigView){
  if(busy.value)return;
  editingId.value=config.id;applyDraftState(config);nameEditing.value=false;
  resetMessages();
}
async function addConfig(){
  if(busy.value)return;
  editingId.value='';revision.value=0;enabled.value=true;hasCredential.value=false;key.value='';keyTouched.value=false;keyPrimed.value=false;keyVisible.value=false;nameEditing.value=false;searchChecked.value=false;searchNotice.value=null;resetMessages();
  draft.value=toDraft({protocol:'openai-completions',preset:'custom',name:'',baseUrl:'',models:[{modelId:'',displayName:'',enabled:true,parameters:{}}]});
  await nextTick();nameInput.value?.focus();
}
function closeEditor(){if(busy.value)return;const first=configs.value[0];if(first){selectConfig(first);return;}draft.value=undefined;editingId.value='';key.value='';keyTouched.value=false;keyPrimed.value=false;keyVisible.value=false;resetMessages();}
function changeProtocol(){if(!draft.value)return;draft.value.preset='custom';resetMessages();}
// 厂商预设：选中即覆写地址与 API 类型（显式选择，Anthropic 预设走原生 anthropic-messages）；
// 模型列表仅在全空或仍是上一预设默认时预填；自定义=干净手填底稿（清地址与模型，协议不代答由表单「API 类型」决定）——
// 若保留上一厂商模型，再切其他预设时「上一预设默认」推断断裂会让外来模型残留进保存（实测 grok 混入 Claude 卡）。
// previous 按切换前的地址推断：UiSelect 先发 update:modelValue 再发 change，进入本函数时 preset 已是新值
function changeVendor(id:ModelConfigInput['preset']){
  const d=draft.value;if(!d||busy.value)return;
  const preset=MODEL_PRESETS.find(p=>p.id===id);if(!preset)return;
  const previous=MODEL_PRESETS.find(p=>p.baseUrl&&p.baseUrl===d.baseUrl);
  d.preset=id;discovered.value=[];testResults.value={};
  d.baseUrl=preset.baseUrl;
  if(preset.id==='custom'){d.models=[{modelId:'',displayName:'',enabled:true,parameters:{},visionSupported:false,contextWindowDefault:null,maxOutputTokensDefault:null,thinkingLevels:[],providerId:null}];return;}
  d.protocol=preset.protocol;
  const defaultsOnly=d.models.length===0||d.models.every(m=>{const mid=m.modelId.trim();return !mid||(previous!==undefined&&previous.models.includes(mid));});
  if(defaultsOnly)d.models=preset.models.map(modelId=>({modelId,displayName:modelId,enabled:true,parameters:{},visionSupported:false,contextWindowDefault:null,maxOutputTokensDefault:null,thinkingLevels:[],providerId:null}));
}
// 手改地址偏离预设官方地址 → preset 归 custom（厂商选择只反映真实使用的接入方案）
function onBaseUrlInput(){
  const d=draft.value;if(!d)return;discovered.value=[];testResults.value={};
  const preset=MODEL_PRESETS.find(p=>p.id===d.preset);
  if(preset&&preset.baseUrl!==d.baseUrl)d.preset='custom';
}
// ZCode ProviderCardHeader：供应商名内联编辑，Enter/失焦提交、Esc 取消
function startNameEdit(){if(busy.value||!draft.value)return;nameDraft.value=draft.value.name;nameEditing.value=true;nextTick(()=>{nameInput.value?.focus();nameInput.value?.select();});}
function commitName(){if(!draft.value)return;const trimmed=nameDraft.value.trim();nameEditing.value=false;if(trimmed&&trimmed!==draft.value.name)draft.value.name=trimmed;}
function cancelName(){nameEditing.value=false;}
async function refresh(){
  const list=await request<ModelConfigView[]>('/api/v1/model-configs');
  if(!disposed){configs.value=list;emit('models-changed',list);}
  return list;
}
async function reloadConfig(){
  if(busy.value)return;
  busy.value=true;error.value='';operation.value='reload';retryFeedback.value=reloadConfig;showFeedback('pending','正在重新载入接口配置…');
  try{
    const list=await refresh(),current=list.find(c=>c.id===editingId.value);
    if(!disposed&&current){applyDraftState(current);resetMessages();showFeedback('success','接口配置已重新载入');}
  }catch(e){if(!disposed){error.value=describe(e);showFeedback('failure','重新载入失败',error.value);}}finally{busy.value=false;operation.value='';}
}
async function saveConfig():Promise<ModelConfigView>{
  if(!draft.value||!valid.value)throw new Error('请填写名称、地址和不重复的模型 ID');
  const data=payload(draft.value);
  data.name=data.name.trim();data.models=data.models.map(m=>({...m,modelId:m.modelId.trim(),displayName:m.displayName.trim()||m.modelId.trim()}));
  const original=configs.value.find(c=>c.id===editingId.value);
  const unchanged=!!original&&original.enabled===enabled.value&&!keyTouched.value&&searchChecked.value===!!original.searchProvider&&JSON.stringify(payload(original))===JSON.stringify(data);
  let saved=unchanged?original!:await request<ModelConfigView>(editingId.value?`/api/v1/model-configs/${editingId.value}`:'/api/v1/model-configs',{method:editingId.value?'PATCH':'POST',body:JSON.stringify({...data,searchEnabled:searchChecked.value,...(editingId.value?{revision:revision.value,enabled:enabled.value}:{})})});
  if(disposed)return saved;
  // 重输入的 Key 随保存写入凭据网关；留空=保留（显式清除走“清除”按钮）
  if(keyTouched.value&&key.value.trim()&&saved.enabled){
    await request(`/api/v1/model-configs/${saved.id}/credential`,{method:'PUT',body:JSON.stringify({apiKey:key.value.trim()})});
  }
  editingId.value=saved.id;
  const list=await refresh();
  const fresh=list.find(c=>c.id===saved.id)??saved;
  // 搜索能力位反馈放 applyDraftState 之后（其会重置 notice）：勾选落库即确认文案
  const bindingLabel=searchBindingInfo.value?.label;
  applyDraftState(fresh);
  searchNotice.value=fresh.searchProvider?(bindingLabel?{text:`联网搜索已启用（${bindingLabel}）：任务运行时优先复用本接口 Key`,error:false}:null):(original&&original.searchProvider?{text:'联网搜索能力已解除：任务运行时将使用设置→联网搜索的全局配置',error:false}:null);
  if(!disposed)saveComplete.value=true;
  return fresh;
}
async function save(){
  if(busy.value)return;busy.value=true;operation.value='save';resetMessages();retryFeedback.value=save;showFeedback('pending','正在保存接口配置…');
  try{await saveConfig();if(!disposed){notice.value='配置已保存';showFeedback('success',notice.value,'保存成功；尚未验证连接');}}
  catch(e){if(!disposed){error.value=describe(e);showFeedback('failure','配置保存失败',error.value);}await refresh().catch(()=>undefined);}
  finally{busy.value=false;operation.value='';}
}
async function test(modelId?:string){
  if(busy.value)return;busy.value=true;operation.value='test';testStage.value='saving';error.value='';notice.value='';testing.value=(modelId||draft.value?.models.find(m=>m.enabled)?.modelId||'').trim();delete testResults.value[testing.value];retryFeedback.value=()=>test(modelId);showFeedback('pending','正在保存接口配置…');let stored=false;
  try{
    const saved=await saveConfig(),id=modelId?.trim()||saved.models.find(m=>m.enabled)?.modelId;stored=true;
    if(!id)throw new Error('请启用至少一个模型');
    if(!disposed){testStage.value='testing';showFeedback('pending','正在测试模型连接…',id);}
    const result=await request<{success:boolean;latencyMs:number}>(`/api/v1/model-configs/${saved.id}/test`,{method:'POST',body:JSON.stringify({modelId:id,revision:saved.revision})});
    if(!result.success)throw new Error('连接测试失败');
    if(!disposed){testResults.value[id]=`已连接 · ${result.latencyMs} ms`;notice.value='连接测试通过';showFeedback('success',notice.value,`${id} · ${result.latencyMs} ms`,true);}
  }catch(e){if(!disposed){error.value=describe(e);if(testing.value)testResults.value[testing.value]='连接失败';showFeedback('failure',stored?'配置已保存，连接测试未通过':'配置保存失败',error.value);}await refresh().catch(()=>undefined);}
  finally{busy.value=false;testing.value='';operation.value='';}
}
async function discover(){
  if(busy.value)return;busy.value=true;operation.value='discover';discovering.value=true;resetMessages();retryFeedback.value=discover;showFeedback('pending','正在保存配置并获取模型…');
  try{
    const saved=await saveConfig();
    const result=await request<{models:string[]}>(`/api/v1/model-configs/${saved.id}/discover`,{method:'POST',body:JSON.stringify({revision:saved.revision})});
    if(!disposed){discovered.value=result.models.filter(id=>!draft.value?.models.some(m=>m.modelId===id));notice.value=discovered.value.length?'选择模型后保存':'没有新模型，可手动添加';showFeedback('success',discovered.value.length?`已获取 ${discovered.value.length} 个新模型`:'未发现新模型',notice.value);}
  }catch(e){if(!disposed){error.value=describe(e);showFeedback('failure','获取模型失败',error.value);}}
  finally{busy.value=false;discovering.value=false;operation.value='';}
}
function addModel(id=''){if(busy.value||!draft.value||draft.value.models.length>=100)return;draft.value.models.push({modelId:id,displayName:id,enabled:true,parameters:{},visionSupported:false,contextWindowDefault:null,maxOutputTokensDefault:null,thinkingLevels:[],providerId:null});discovered.value=discovered.value.filter(x=>x!==id);}
async function clearKey(){
  if(!editingId.value||busy.value)return;busy.value=true;operation.value='key';error.value='';retryFeedback.value=clearKey;showFeedback('pending','正在清除已保存的 Key…');
  try{await request(`/api/v1/model-configs/${editingId.value}/credential`,{method:'DELETE'});key.value='';keyTouched.value=false;keyVisible.value=false;hasCredential.value=false;testResults.value={};notice.value='本机账号的 Key 已清除';await refresh();if(!disposed)showFeedback('success',notice.value);}
  catch(e){if(!disposed){error.value=describe(e);showFeedback('failure','清除 Key 失败',error.value);}}finally{busy.value=false;operation.value='';}
}
// （R39 全局引用联动已移除：勾选升级为接口能力位 searchEnabled 随接口保存，运行时按本次任务所用接口解析）
async function toggleEnabled(){
  if(busy.value||!draft.value)return;busy.value=true;operation.value='toggle';error.value='';const previous=enabled.value;enabled.value=!previous;retryFeedback.value=toggleEnabled;showFeedback('pending','正在更新接口状态…');
  try{await saveConfig();if(!disposed){notice.value=enabled.value?'接口已启用':'接口已停用，已保存的 Key 已清除';showFeedback('success',notice.value);}}
  catch(e){enabled.value=previous;if(!disposed){error.value=describe(e);showFeedback('failure','更新接口状态失败',error.value);}await refresh().catch(()=>undefined);}
  finally{busy.value=false;operation.value='';}
}
function onKeyFocus(){if(!keyTouched.value&&hasCredential.value&&!connectionChanged.value)keyPrimed.value=true;}
function onKeyBlur(){if(keyPrimed.value&&!key.value.trim())keyPrimed.value=false;}
function onKeyInput(event:Event){const value=(event.target as HTMLInputElement).value;const wasUntouched=!keyTouched.value;keyTouched.value=true;keyPrimed.value=true;key.value=wasUntouched&&value.startsWith(KEY_MASK)?value.slice(KEY_MASK.length):value;}
function describe(e:unknown){return e instanceof Error?e.message:'操作失败，请重试';}
// 上下文窗口是模型事实：手动覆盖 > 服务端下发的 pi 目录档案(contextWindowDefault) > null（未知不造数）；徽标只在有据可依时显示
function contextWindowEffective(model:DraftModel):number|null{const manual=model.parameters.contextWindow;return typeof manual==='number'&&manual>0?manual:model.contextWindowDefault??null;}
function contextWindowSource(model:DraftModel):string{const manual=model.parameters.contextWindow;if(typeof manual==='number'&&manual>0)return '手动指定';return model.contextWindowDefault?'pi 目录':'未收录，未知';}
function contextBadge(model:DraftModel):string|undefined{const manual=model.parameters.contextWindow;if(typeof manual==='number'&&manual>0)return formatTokens(manual);return model.contextWindowDefault?formatTokens(model.contextWindowDefault):undefined;}
// 最大输出与后端 parameterResolver 同式：请求默认直接接目录(未收录4096)，窗口已知时生效受上下文1/4约束；展示始终取整
function maxOutputRequestDefault(model:DraftModel):number{return model.maxOutputTokensDefault??4096;}
function maxOutputEffective(model:DraftModel):number{const requested=Math.floor(Number(model.parameters.maxOutputTokens??maxOutputRequestDefault(model)))||4096;const win=contextWindowEffective(model);return win===null?Math.min(requested,2000000):Math.min(requested,Math.floor(win/4));}
function normalizeMaxOutput(model:DraftModel){const v=model.parameters.maxOutputTokens;if(v===''||v===undefined||v===null||typeof v!=='number'||!Number.isFinite(v)){delete model.parameters.maxOutputTokens;return;}model.parameters.maxOutputTokens=Math.min(Math.max(Math.floor(v),1),2000000);}
// 思考级别目录结论由服务端下发（view().thinkingLevels，未保存的草稿行为空=不可选）；标签用中文（contracts共用）
function thinkingLevelLabel(level:string):string{return THINKING_LEVEL_LABELS[level as keyof typeof THINKING_LEVEL_LABELS]??level;}
function thinkingAvailable(model:DraftModel):boolean{return (model.thinkingLevels?.length??0)>0;}
// 与 composer 同一份 ZCode 复刻菜单（ComposerSelect），替换原生 select 的系统弹层
function thinkingSelectOptions(model:DraftModel):ComposerSelectOption[]{return [{value:'',label:'默认（不发送思考参数）'},...model.thinkingLevels.map(level=>({value:level,label:thinkingLevelLabel(level)}))];}
function setThinkingLevel(model:DraftModel,value:string){if(value)model.parameters.thinkingLevel=value;else delete model.parameters.thinkingLevel;delete model.parameters.thinkingMode;}
function onEscape(event:KeyboardEvent){if(event.isComposing||!draft.value)return;if(nameEditing.value){cancelName();return;}if(!editingId.value){event.preventDefault();event.stopPropagation();closeEditor();}}
onMounted(async()=>{
  await refresh().catch(e=>{if(!disposed)error.value=describe(e);});
  if(disposed)return;
  // ZCode 导航回落语义：优先外部指定的接口，否则选首个；空列表进入新增表单
  const initial=configs.value.find(c=>c.id===props.initialConfigId)??configs.value[0];
  if(initial)selectConfig(initial);else await addConfig();
});
onUnmounted(()=>{emit('modal-change',false);disposed=true;key.value='';keyTouched.value=false;keyPrimed.value=false;keyVisible.value=false;controller.abort();});
defineExpose({closeEditor});
</script>

<template>
  <section class="model-providers" aria-label="模型接口" @keydown.esc="onEscape">
    <div class="mp-toolbar">
      <span class="mp-muted">OpenAI / Anthropic</span>
      <div class="mp-actions"><button class="mp-button mp-icon-button" type="button" :disabled="busy" aria-label="刷新接口" title="刷新接口" @click="reloadConfig"><ModelProviderIcon name="refresh"/></button><button class="mp-button mp-outline" type="button" :disabled="busy" @click="addConfig"><ModelProviderIcon name="plus"/>添加接口</button></div>
    </div>
    <div class="mp-panel">
      <nav class="mp-navigation" aria-label="已配置接口">
        <button v-for="c in configs" :key="c.id" class="mp-nav-item" :class="{selected:editingId===c.id}" :aria-current="editingId===c.id?'true':undefined" :title="c.name" :aria-label="c.name" :disabled="busy" type="button" @click="selectConfig(c)">
          <ModelProviderIcon name="server"/><span>{{ c.name }}</span><i class="mp-status-dot" :class="{ready:c.enabled&&c.hasCredential}" :aria-label="c.enabled?(c.hasCredential?'Key 已设置':'需要 Key'):'已停用'"></i>
        </button>
        <p v-if="!configs.length" class="mp-nav-empty">暂无接口</p>
      </nav>
      <div class="mp-detail">
        <form v-if="draft" class="mp-form" @submit.prevent="save">
          <header class="mp-card-header">
            <template v-if="editingId">
              <div class="mp-card-title">
                <ProviderMark class="mp-card-logo" :provider-id="headerProviderId" :base-url="draft.baseUrl"><ModelProviderIcon name="server"/></ProviderMark>
                <input v-if="nameEditing" ref="nameInput" v-model="nameDraft" class="mp-name-input" maxlength="100" autocomplete="off" aria-label="重命名接口" @keydown.enter.prevent="commitName" @keydown.esc.prevent.stop="cancelName" @blur="commitName">
                <button v-else class="mp-name" type="button" :title="draft.name" @click="startNameEdit">{{ draft.name.trim()||'未命名接口' }}</button>
                <button v-if="!nameEditing" class="mp-button mp-icon-button" type="button" aria-label="重命名接口" title="重命名" :disabled="busy" @click="startNameEdit"><ModelProviderIcon name="pencil"/></button>
              </div>
              <Transition name="mp-save-state"><span v-if="!busy&&(hasUnsavedChanges||saveComplete)" class="mp-save-state" :class="{'is-saved':!hasUnsavedChanges}" role="status"><ModelProviderIcon v-if="!hasUnsavedChanges" name="check"/>{{hasUnsavedChanges?'未保存':'已保存'}}</span></Transition>
              <input class="mp-switch" type="checkbox" role="switch" :checked="enabled" :disabled="busy" :aria-label="enabled?'停用接口':'启用接口'" :title="enabled?'停用接口（将清除已保存的 Key）':'启用接口'" @change="toggleEnabled">
            </template>
            <template v-else>
              <div class="mp-card-title"><h2>添加接口</h2></div>
              <Transition name="mp-save-state"><span v-if="!busy&&(hasUnsavedChanges||saveComplete)" class="mp-save-state" :class="{'is-saved':!hasUnsavedChanges}" role="status"><ModelProviderIcon v-if="!hasUnsavedChanges" name="check"/>{{hasUnsavedChanges?'未保存':'已保存'}}</span></Transition>
              <button class="mp-button mp-outline" type="button" :disabled="busy" @click="closeEditor">取消</button>
            </template>
          </header>
          <label v-if="!editingId" class="mp-field">名称<input ref="nameInput" v-model="draft.name" :disabled="busy" aria-label="接口名称" maxlength="100" autocomplete="off" required></label>
          <label class="mp-field">厂商<UiSelect v-model="draft.preset" :disabled="busy" label="厂商预设" :options="vendorOptions" @change="changeVendor"/></label>
          <label class="mp-field">API 地址<input v-model="draft.baseUrl" :disabled="busy" type="url" aria-label="API 地址" autocomplete="off" spellcheck="false" required @input="onBaseUrlInput"></label>
          <label class="mp-field">API 类型<UiSelect v-model="draft.protocol" :disabled="busy" label="接口类型" @change="changeProtocol" :options="[{value:'openai-completions',label:'OpenAI'},{value:'anthropic-messages',label:'Anthropic'}]"/></label>
          <div class="mp-field"><div class="mp-label-line"><label for="mp-api-key">API Key</label><span class="mp-hint">{{keyHint}}</span></div><div class="mp-key-row"><div class="mp-key-control"><input id="mp-api-key" :value="keyDisplay" :type="keyVisible&&keyTouched?'text':'password'" :disabled="busy||!enabled" :placeholder="keyPlaceholder" aria-label="API Key" autocomplete="off" spellcheck="false" @focusin="onKeyFocus" @focusout="onKeyBlur" @input="onKeyInput"><button class="mp-button mp-icon-button mp-eye" type="button" :aria-label="eyeTitle" :title="eyeTitle" :disabled="eyeDisabled" @click="keyVisible=!keyVisible"><ModelProviderIcon :name="keyVisible&&keyTouched?'eye-off':'eye'"/></button></div><button v-if="hasCredential" class="mp-button" type="button" :disabled="busy" @click="clearKey">清除</button></div></div>
          <div v-if="searchBindingInfo?.available" class="mp-field mp-reuse">
            <label class="mp-reuse-row"><input type="checkbox" v-model="searchChecked" :disabled="busy"><span>为该接口启用联网搜索（{{searchBindingInfo.label}}）</span></label>
            <p v-if="searchBindingInfo.planKeyWarning" class="mp-hint mp-error">该接口是套餐端点：其 Key 无法调用联网搜索 API，请改用标准 API 地址，或在设置→联网搜索单独保存主站 Key。</p>
            <p v-else class="mp-hint">勾选并保存后，任务运行时优先复用本接口的 Key 调用 {{searchBindingInfo.label}} 搜索；未勾选的接口使用设置→联网搜索的全局配置。</p>
            <p v-if="searchNotice" class="mp-hint" :class="{'mp-error':searchNotice.error}">{{ searchNotice.text }}</p>
          </div>
          <div class="mp-model-heading"><h3>模型</h3><button class="mp-button" type="button" :disabled="busy||!valid||!usableCredential||!enabled" title="保存当前配置并获取模型列表" @click="discover"><ModelProviderIcon name="refresh" :class="{'mp-spinning':discovering}"/>{{discovering?'获取中…':'获取模型'}}</button></div>
          <div v-if="draft.models.length" class="mp-model-list">
            <div v-for="(model,index) in draft.models" :key="index" class="mp-model-row">
              <div class="mp-model-basic"><div class="mp-model-identity"><input v-model="model.modelId" class="mp-model-id" :disabled="busy" :aria-label="`模型 ID ${index+1}`" placeholder="模型 ID" maxlength="200" required spellcheck="false"><span v-if="contextBadge(model)" class="mp-context-badge" :title="`上下文窗口 ${formatTokens(contextWindowEffective(model))}`">{{contextBadge(model)}}</span><input v-model="model.displayName" :disabled="busy" :aria-label="`模型显示名称 ${index+1}`" placeholder="显示名称（可选）" maxlength="200"></div><div class="mp-model-actions"><button class="mp-button mp-icon-button" type="button" :disabled="busy||!model.modelId.trim()" :aria-label="`编辑模型配置 ${model.modelId}`" title="编辑模型配置" @click="openMetadata(index)"><ModelProviderIcon name="pencil"/></button><button class="mp-button mp-icon-button" type="button" :disabled="busy||!valid||!model.enabled||!usableCredential||!enabled" :aria-label="`测试模型 ${index+1}`" title="保存并测试模型" @click="test(model.modelId)"><ModelProviderIcon :name="testing===model.modelId.trim()?'loader':testResults[model.modelId]?.startsWith('已连接')?'check':'test'" :class="{'mp-spinning':testing===model.modelId.trim()}"/></button><button class="mp-button mp-icon-button" type="button" :disabled="busy||draft.models.length===1" :aria-label="`移除模型 ${index+1}`" title="移除模型" @click="draft.models.splice(index,1)"><ModelProviderIcon name="trash"/></button><input v-model="model.enabled" class="mp-switch" type="checkbox" role="switch" :disabled="busy" :aria-label="`启用模型 ${index+1}`"></div></div>
              <span v-if="testResults[model.modelId]" class="mp-test-result" :class="{'mp-error':testResults[model.modelId]==='连接失败'}" role="status">{{testResults[model.modelId]}}</span>
              <details class="mp-parameters"><summary><ModelProviderIcon name="chevron"/>模型参数</summary>
                <p>{{thinkingAvailable(model)?(model.metadata?.source==='manual'?'思考级别来自手动配置。':model.metadata?.source==='vendor-docs'?'思考级别来自官方文档。':'思考级别来自Pi目录。'):'当前接口未配置思考控制，不代表上游关闭思考。'}}{{modelCapability(draft.protocol??'openai-completions',model.modelId).temperature?'温度控制已验证。':'温度控制未验证：不发送temperature。'}}</p>
                <div class="mp-parameter-fields">
                  <label class="mp-field">上下文窗口<input v-model.number="model.parameters.contextWindow" :disabled="busy" type="number" min="4096" max="2000000" :aria-label="`上下文窗口 ${index+1}`" :placeholder="contextWindowEffective(model)===null?'未收录':String(contextWindowEffective(model))" @change="model.parameters.contextWindow===''&&delete model.parameters.contextWindow"></label>
                  <label class="mp-field">请求最大输出 Token<input v-model.number="model.parameters.maxOutputTokens" :disabled="busy" type="number" min="1" max="2000000" step="1" :aria-label="`最大输出 Token ${index+1}`" :placeholder="String(maxOutputRequestDefault(model))" @change="normalizeMaxOutput(model)"></label>
                  <label class="mp-field">Temperature<input v-model.number="model.parameters.temperature" :disabled="busy||!modelCapability(draft.protocol??'openai-completions',model.modelId).temperature||(draft.protocol==='anthropic-messages'&&model.parameters.thinkingLevel!=='off')" type="number" min="0" :max="draft.protocol==='anthropic-messages'?1:2" step="0.1" :aria-label="`Temperature ${index+1}`" placeholder="上游默认" @change="model.parameters.temperature===''&&delete model.parameters.temperature"></label>
                  <div class="mp-field"><span>思考级别</span><ComposerSelect :value="typeof model.parameters.thinkingLevel==='string'?model.parameters.thinkingLevel:''" :options="thinkingSelectOptions(model)" :label="`思考级别 ${index+1}`" :width="224" :disabled="busy||!thinkingAvailable(model)" @change="value=>setThinkingLevel(model,value)" /></div>
                </div>
                <p>生效上下文 {{formatTokens(contextWindowEffective(model))}}（{{contextWindowSource(model)}}）；生效最大输出 {{maxOutputEffective(model)}} Token（请求默认 {{maxOutputRequestDefault(model)}}，受上下文窗口 1/4 约束）。</p>
                <p v-if="model.parameters.thinkingMode">旧模式 {{model.parameters.thinkingMode}} 将经能力验证映射；不支持的显式模式会拒绝保存。<button class="mp-button" type="button" @click="delete model.parameters.thinkingMode">恢复默认</button></p>
                <button v-if="model.parameters.temperature!==undefined" class="mp-button" type="button" @click="delete model.parameters.temperature">清除温度覆盖</button>
              </details>
            </div>
          </div>
          <div v-else class="mp-models-empty"><ModelProviderIcon name="info"/>尚无模型：手动添加，或填写地址与 Key 后获取模型</div>
          <button class="mp-button mp-add-model" type="button" :disabled="busy||draft.models.length>=100" @click="addModel()"><ModelProviderIcon name="plus"/>手动添加模型</button>
          <div v-if="discovered.length" class="mp-discovered"><button v-for="id in discovered" :key="id" class="mp-button mp-outline" type="button" :disabled="busy||draft.models.length>=100" @click="addModel(id)"><ModelProviderIcon name="plus"/>{{id}}</button></div>
          <p v-if="error" class="mp-feedback mp-error">{{error}} <button v-if="editingId" class="mp-button" type="button" :disabled="busy" @click="reloadConfig">重新载入</button></p>
          <footer class="mp-footer"><div class="mp-actions"><button class="mp-button mp-outline" type="button" :disabled="busy||!valid||!usableCredential||!enabled||!draft.models.some(m=>m.enabled)" @click="test()"><ModelProviderIcon :name="testing?'loader':'test'" :class="{'mp-spinning':!!testing}"/>{{testing?(testStage==='saving'?'保存中…':'测试中…'):'保存并测试'}}</button><button class="mp-button mp-primary" :class="{'mp-save-done':saveComplete}" type="submit" :disabled="busy||!valid" :aria-busy="operation==='save'"><ModelProviderIcon :name="operation==='save'?'loader':saveComplete?'check':'save'" :class="{'mp-spinning':operation==='save'}"/>{{operation==='save'?'保存中…':saveComplete?'已保存':'保存'}}</button></div></footer>
        </form>
        <div v-else class="mp-empty"><ModelProviderIcon name="server"/><p>{{configs.length?'选择一个接口':'尚未添加接口'}}</p><p v-if="error" class="mp-feedback mp-error">{{error}}</p></div>
        <ProviderDetailFeedback :feedback="feedback" :can-retry="!!retryFeedback" @dismiss="feedback=undefined" @retry="retryFeedback?.()" />
      </div>
    </div>
    <div v-if="availableConfigs.length" class="mp-defaults"><h2>任务默认模型</h2><label class="mp-field">普通 Agent<UiSelect :model-value="binding" label="默认模型" @change="emit('update:binding',$event)" :options="[{value:'',label:'请选择模型'},...modelSelectOptions]"/></label><details class="mp-parameters"><summary><ModelProviderIcon name="chevron"/>辩论角色</summary><div class="mp-parameter-fields"><label v-for="role in roles" :key="role.id" class="mp-field">{{role.label}}<UiSelect :model-value="roleBindings[role.id]" :label="`${role.label}默认模型`" @change="emit('update:roleBindings',{...roleBindings,[role.id]:$event})" :options="[{value:'',label:'跟随普通 Agent'},...modelSelectOptions]"/></label></div></details></div>
    <ModelMetadataDialog v-if="metadataIndex!==null&&draft?.models[metadataIndex]" :model="draft.models[metadataIndex]!" :protocol="draft.protocol??'openai-completions'" :base-url="draft.baseUrl" :commit="commitMetadata" @close="closeMetadata" />
  </section>
</template>

<style scoped>
/* Source sizes: SectionLayout 224px / 56px navigation, detail p-6 pb-24 (mobile p-4 pb-20);
   Input lg h-8, Button default h-7 / icon-sm size-6, card header = ProviderCardHeader (text-ui-lg semibold). */
.model-providers { min-width:0;font-size:var(--ui-font-size,14px);line-height:1.5; }
.model-providers .mp-toolbar,.model-providers .mp-actions,.model-providers .mp-label-line,.model-providers .mp-model-heading,.model-providers .mp-footer { display:flex;align-items:center;justify-content:space-between;gap:8px; }
.model-providers .mp-toolbar { margin-bottom:16px; }
.model-providers .mp-muted,.model-providers .mp-hint { color:var(--fg-subtle); }
.model-providers .mp-hint { font-size:12px; }
.model-providers .mp-panel { display:grid;grid-template-columns:224px minmax(0,1fr);min-height:36rem;border:1px solid var(--border);border-radius:12px;overflow:clip;background:var(--bg-card); }
.model-providers .mp-navigation { min-width:0;padding:8px;border-right:1px solid var(--border); }
.model-providers .mp-nav-item { display:flex;align-items:center;gap:8px;width:100%;height:32px;border:1px solid transparent;border-radius:8px;padding:4px 8px;margin-bottom:4px;background:transparent;text-align:left;font:inherit;font-weight:500; }
.model-providers .mp-nav-item:hover { border-color:var(--border-hover); }
.model-providers .mp-nav-item.selected { border-color:var(--border-hover);background:var(--color-card-selected,var(--selected)); }
.model-providers .mp-nav-item>span { min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.model-providers .mp-nav-item>svg { width:16px;height:16px; }
.model-providers .mp-status-dot { width:5px;height:5px;border-radius:50%;background:var(--fg-subtlest);flex:none; }
.model-providers .mp-status-dot.ready { background:var(--success); }
.model-providers .mp-nav-empty { padding:4px 8px;color:var(--fg-subtlest);font-size:12px; }
.model-providers .mp-detail { position:relative;min-width:0;padding:24px 24px 96px;container-type:inline-size; }
.model-providers .mp-form { display:flex;flex-direction:column;gap:12px;min-width:0; }
/* ZCode ProviderCardHeader：品牌位 + 名称（text-ui-lg semibold）+ 右侧启停开关 */
.model-providers .mp-card-header { display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0; }
.model-providers .mp-card-title { display:flex;align-items:center;gap:8px;min-width:0;flex:1; }
.model-providers .mp-card-title h2 { margin:0;font-size:16px;font-weight:600;line-height:1.5; }
.model-providers .mp-model-heading h3,.model-providers .mp-defaults h2 { margin:0;font-size:var(--ui-font-size,14px);font-weight:500;line-height:1.5; }
.model-providers .mp-card-logo { flex:none; }
.model-providers .mp-card-logo svg { width:16px;height:16px; }
.model-providers .mp-name { min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;padding:0;background:none;color:var(--fg);font:inherit;font-size:16px;font-weight:600;line-height:1.5;text-align:left;cursor:text; }
.model-providers .mp-name-input { flex:1;max-width:320px;height:32px;min-height:32px;padding:6px 12px;border:1px solid var(--color-input-border-focused,var(--border-hover));border-radius:8px;background:var(--bg-input);color:var(--fg);font:inherit;font-size:16px;font-weight:600;line-height:18px;outline:none; }
.model-providers .mp-field { display:flex;flex-direction:column;gap:4px;min-width:0;color:var(--fg-subtle);font-size:var(--ui-font-size,14px); }
.model-providers input:not([type=checkbox]),.model-providers select { width:100%;min-width:0;height:32px;min-height:32px;padding:6px 12px;border:1px solid var(--color-input-border,var(--border));border-radius:8px;background:var(--bg-input);color:var(--fg);font:inherit;line-height:18px;outline:none;transition:border-color .12s,background-color .12s; }
.model-providers input::placeholder { color:var(--fg-subtlest); }
.model-providers input:not([type=checkbox]):hover,.model-providers select:hover { border-color:var(--color-input-border-hover,var(--border-hover)); }
.model-providers input:not([type=checkbox]):focus-visible,.model-providers select:focus-visible { border-color:var(--color-input-border-focused,var(--border-hover));background:var(--color-input-focused,var(--bg-input)); }
.model-providers .mp-button { display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;min-height:28px;height:28px;padding:0 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--fg);font:inherit;line-height:1.5;white-space:nowrap;transition:background-color .12s,border-color .12s; }
.model-providers .mp-button:hover { background:var(--hover); }
.model-providers .mp-outline { border-color:var(--border); }
.model-providers .mp-outline:hover { border-color:var(--border-hover); }
.model-providers .mp-primary { background:var(--primary);color:var(--primary-fg); }
.model-providers .mp-primary:hover { background:color-mix(in srgb,var(--primary) 80%,transparent); }
.model-providers .mp-icon-button { width:24px;height:24px;min-height:24px;padding:0; }
.model-providers button:focus-visible,.model-providers summary:focus-visible,.model-providers .mp-switch:focus-visible { outline:2px solid var(--color-input-border-focused,var(--border-hover));outline-offset:2px; }
.model-providers button:disabled,.model-providers input:disabled,.model-providers select:disabled { opacity:.5;cursor:not-allowed; }
.model-providers .mp-key-row { display:flex;align-items:center;gap:8px; }
.model-providers .mp-reuse-row { display:flex;align-items:center;gap:8px;color:var(--fg);cursor:pointer; }
.model-providers .mp-reuse-row input { width:auto;min-width:0;height:auto;min-height:0;margin:0;accent-color:var(--primary);cursor:pointer; }
.model-providers .mp-key-control { position:relative;min-width:0;flex:1; }
.model-providers .mp-key-control input { padding-right:40px; }
.model-providers .mp-eye { position:absolute;right:6px;top:50%;transform:translateY(-50%); }
.model-providers .mp-model-heading { margin-top:4px; }
.model-providers .mp-model-list { border:1px solid var(--border);border-radius:8px;overflow:hidden; }
.model-providers .mp-model-row { padding:8px 12px;border-top:1px solid var(--border); }
.model-providers .mp-model-row:first-child { border-top:0; }
.model-providers .mp-models-empty { display:flex;align-items:center;gap:8px;height:48px;padding:0 16px;margin-top:4px;border:1px dashed var(--border);border-radius:8px;color:var(--fg-subtle); }
.model-providers .mp-models-empty svg { width:16px;height:16px;flex:none; }
.model-providers .mp-model-basic,.model-providers .mp-model-actions { display:flex;align-items:center;gap:8px;min-width:0; }
.model-providers .mp-model-identity { display:grid;grid-template-columns:minmax(0,1fr);gap:4px;min-width:0;flex:1; }
.model-providers .mp-model-identity input { height:28px;min-height:28px;padding:4px 8px;border-radius:6px; }
.model-providers .mp-context-badge { justify-self:start;width:fit-content;padding:1px 7px;border:1px solid var(--border);border-radius:6px;background:var(--selected);color:var(--fg-subtle);font-size:11px;line-height:1.5;white-space:nowrap; }
.model-providers .mp-model-id { font-family:var(--font-mono)!important; }
.model-providers .mp-switch { appearance:none;position:relative;width:24px;height:14px;min-width:24px;margin:0;border:1px solid var(--border);border-radius:999px;background:var(--secondary);cursor:pointer;flex:none; }
.model-providers .mp-switch::before { content:'';position:absolute;top:1px;left:1px;width:10px;height:10px;border-radius:50%;background:var(--fg-subtle); }
.model-providers .mp-switch:checked { background:var(--primary);border-color:var(--primary); }
.model-providers .mp-switch:checked::before { transform:translateX(10px);background:var(--primary-fg); }
.model-providers .mp-parameters { margin-top:8px;color:var(--fg-subtle);font-size:12px; }
.model-providers .mp-parameters summary { display:flex;align-items:center;gap:4px;cursor:pointer;list-style:none;width:fit-content; }
.model-providers .mp-parameters summary::-webkit-details-marker { display:none; }
.model-providers .mp-parameters[open]>summary>svg { transform:rotate(90deg); }
.model-providers .mp-parameter-fields { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px; }
.model-providers .mp-add-model { align-self:flex-start; }
.model-providers .mp-discovered { display:flex;flex-wrap:wrap;gap:8px; }
.model-providers .mp-discovered button { max-width:100%;height:auto;min-height:28px;white-space:normal;overflow-wrap:anywhere;text-align:left; }
.model-providers .mp-footer { padding-top:12px;flex-wrap:wrap;border-top:1px solid var(--border); }
.model-providers .mp-footer>.mp-actions { margin-left:auto; }
.model-providers .mp-feedback { font-size:12px;overflow-wrap:anywhere; }
.model-providers .mp-test-result { display:block;margin-top:8px;color:var(--success);font-size:12px; }
.model-providers .mp-error { color:var(--danger); }
.model-providers .mp-empty { display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-height:280px;color:var(--fg-subtle); }
.model-providers .mp-empty>svg { width:24px;height:24px; }
.model-providers .mp-defaults { display:flex;flex-direction:column;gap:12px;margin-top:24px; }
@media(max-width:767px){.model-providers .mp-panel{grid-template-columns:56px minmax(0,1fr)}.model-providers .mp-navigation{padding:12px 6px}.model-providers .mp-nav-item{width:32px;padding:4px;justify-content:center;position:relative}.model-providers .mp-nav-item>span,.model-providers .mp-nav-empty{display:none}.model-providers .mp-status-dot{position:absolute;right:2px;bottom:2px}.model-providers .mp-detail{padding:16px 16px 80px}}
@container(max-width:300px){.model-providers .mp-model-basic{flex-wrap:wrap}.model-providers .mp-model-identity{flex-basis:100%}.model-providers .mp-model-actions{margin-left:auto}.model-providers .mp-parameter-fields{grid-template-columns:minmax(0,1fr)}.model-providers .mp-label-line{flex-wrap:wrap}.model-providers .mp-model-heading{flex-wrap:wrap}.model-providers .mp-footer>.mp-actions{flex-wrap:wrap}}
.mp-save-state{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:12px;color:var(--fg-subtle)}.mp-save-state.is-saved{color:var(--success)}.mp-save-state-enter-active,.mp-save-state-leave-active{transition:opacity .18s ease,transform .18s ease}.mp-save-state-enter-from,.mp-save-state-leave-to{opacity:0;transform:translateY(2px)}
.mp-spinning{animation:mp-feedback-spin .85s linear infinite}.mp-save-done>svg{color:var(--success)}@keyframes mp-feedback-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.mp-save-state-enter-active,.mp-save-state-leave-active{transition:none}.mp-save-state-enter-from,.mp-save-state-leave-to{transform:none}.mp-spinning{animation:none}.model-providers input,.model-providers select,.model-providers button{transition:none}}
</style>
