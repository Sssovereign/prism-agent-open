import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAdvancedOptions,mappedThinkingPayload,thinkingPayloadHook} from '../src/models/advancedOptions.js';
import {resolveModelParameters} from '../src/models/parameterResolver.js';
import {modelMetadata} from '../src/models/modelMetadata.js';
import {resolveVisionSupport} from '../src/agent/modelCatalog.js';
import {ModelGateway} from '../src/models/gateway.js';
import type {ModelConfigView,ModelAdvancedOptions} from '../contracts/models.js';

const advanced:ModelAdvancedOptions={thinkingLevels:['low','high','max'],thinkingParameterMap:{thinking:{type:'enabled'},output_config:{effort:'$level'}}};
const base='https://open.bigmodel.cn/api/anthropic';
test('manual thinking restores hidden GLM levels without claiming official endpoint verification',()=>{
 const automatic=modelMetadata('anthropic-messages',base,'glm-5.3-flash',{thinkingLevel:'max'});
 assert.equal(automatic.source,'unverified');assert.deepEqual(automatic.thinkingLevels,[]);
 const metadata=modelMetadata('anthropic-messages',base,'glm-5.3-flash',{advanced});
 assert.equal(metadata.source,'manual');assert.deepEqual(metadata.thinkingLevels,['low','high','max']);assert.deepEqual(metadata.defaults.thinkingLevels,[]);
 for(const thinkingLevel of ['low','high','max']){
  const frozen=resolveModelParameters('anthropic-messages',base,'glm-5.3-flash',{advanced,thinkingLevel,contextWindow:300000});
  assert.equal(frozen.effective.thinkingLevel,thinkingLevel);assert.equal(frozen.effective.contextWindow,300000);assert.deepEqual(frozen.advanced,advanced);
  assert.deepEqual(mappedThinkingPayload(frozen.advanced,frozen.effective.thinkingLevel),{thinking:{type:'enabled'},output_config:{effort:thinkingLevel}});
 }
 assert.equal(resolveModelParameters('anthropic-messages',base,'glm-5.3',{advanced}).effective.thinkingLevel,'max');
 assert.throws(()=>resolveModelParameters('anthropic-messages',base,'glm-5.3',{advanced,thinkingLevel:'off'}));
 assert.throws(()=>resolveModelParameters('anthropic-messages',base,'glm-5.3',{advanced:{thinkingLevels:['low','high','max']}}),/参数映射/);
 assert.throws(()=>resolveModelParameters('anthropic-messages',base,'glm-5.3',{advanced:{thinkingParameterMap:advanced.thinkingParameterMap}}),/至少需要/);
});
test('image overrides are explicit while protocol alone does not grant vision',()=>{
 assert.equal(resolveVisionSupport('anthropic-messages',base,'glm-5.3'),false);
 assert.equal(resolveVisionSupport('anthropic-messages',base,'glm-5.3-flash'),true);
 assert.equal(resolveVisionSupport('anthropic-messages',base,'alias'),false);
 assert.equal(resolveVisionSupport('anthropic-messages',base,'alias',{image:true}),true);
 assert.equal(resolveVisionSupport('anthropic-messages',base,'glm-5.3-flash',{image:false}),false);
 assert.equal(resolveVisionSupport('anthropic-messages',base,'glm-5.3-flash',{smartConfig:false}),false);
});
test('mapping replaces provider dialect without changing model, messages, tools or frozen budget',()=>{
 const original={model:'glm-5.3',messages:[{role:'user',content:'hello'}],tools:[{name:'read'}],max_tokens:128,stream:true,thinking:{type:'enabled',budget_tokens:8192},reasoning_effort:'high'};
 const payload=thinkingPayloadHook(advanced,'low')!(original) as Record<string,unknown>;
 assert.equal(payload.model,original.model);assert.deepEqual(payload.messages,original.messages);assert.deepEqual(payload.tools,original.tools);assert.equal(payload.max_tokens,128);assert.equal(payload.stream,true);
 assert.deepEqual(payload.thinking,{type:'enabled'});assert.deepEqual(payload.output_config,{effort:'low'});assert.equal(payload.reasoning_effort,undefined);assert.equal(original.reasoning_effort,'high');
});
test('advanced JSON rejects protected fields, prototype keys, malformed levels and incomplete maps',()=>{
 for(const value of [null,{image:'true'},{smartConfig:1},{thinkingLevels:['low','low']},{thinkingLevels:['max','low']},{thinkingLevels:['custom']},{thinkingParameterMap:{messages:[]}},{thinkingParameterMap:{model:'other'}},{thinkingParameterMap:{headers:{Authorization:'bad'}}},{thinkingParameterMap:JSON.parse('{"thinking":{"__proto__":{}}}')},{thinkingLevels:['low','max'],thinkingParameterMap:{low:{thinking:{type:'enabled'}}}}])assert.throws(()=>parseAdvancedOptions(value));
 const perLevel=parseAdvancedOptions({thinkingLevels:['off','high'],thinkingParameterMap:{off:{thinking:{type:'disabled'}},high:{thinking:{type:'enabled',budget_tokens:4096}}}});
 assert.deepEqual(mappedThinkingPayload(perLevel,'off'),{thinking:{type:'disabled'}});
 assert.deepEqual(mappedThinkingPayload(perLevel,'high'),{thinking:{type:'enabled',budget_tokens:4096}});
 assert.throws(()=>mappedThinkingPayload(perLevel,'low'));
});
test('connection test sends configured Anthropic mapping through the real Pi adapter',async()=>{
 let body:Record<string,unknown>|undefined;
 const gateway=new ModelGateway(()=>async(_input,init)=>{
  body=JSON.parse(String(init?.body));
  const chunks=[['message_start',{type:'message_start',message:{id:'fixture',role:'assistant',type:'message',model:'glm-5.3-flash',content:[],usage:{input_tokens:1,output_tokens:0}}}],['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OK'}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}}],['message_stop',{type:'message_stop'}]];
  return new Response(chunks.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
 });
 const config={id:'fixture',revision:1,enabled:true,hasCredential:true,updatedAt:'now',name:'glm',preset:'custom',protocol:'anthropic-messages',baseUrl:base,searchProvider:null,searchBinding:{available:false,provider:null,label:null,planKeyWarning:false},models:[{modelId:'glm-5.3-flash',displayName:'GLM',enabled:true,parameters:{thinkingLevel:'max',advanced},visionSupported:true,contextWindowDefault:300000,thinkingLevels:['low','high','max'],maxOutputTokensDefault:128,providerId:null}]} satisfies ModelConfigView;
 assert.equal((await gateway.test(config,'glm-5.3-flash','synthetic-key',new AbortController().signal)).success,true);
 assert.deepEqual(body?.thinking,{type:'enabled'});assert.deepEqual(body?.output_config,{effort:'max'});assert.equal(body?.max_tokens,128);assert.equal(body?.model,'glm-5.3-flash');
});
