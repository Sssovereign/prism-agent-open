import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveModelParameters} from '../src/models/parameterResolver.js';
import {resolveModelContextWindow,resolveThinkingCapability} from '../src/agent/modelCatalog.js';
import {selectCompactionSources, type CompactEntry} from '../src/agent/compactionSources.js';
import {parseChatRequest,encodeSseFromEvents} from '../src/agent/protocolAdapter.js';
import {validate} from '../src/contracts/schemas.js';
import {DEFAULT_COMPACTION_SYSTEM_PROMPT,DEFAULT_SUBAGENT_SYSTEM_PROMPT,normalizeAgentPrompts,normalizeAgentSettings,AGENT_PROMPT_MAX_CHARS} from '../contracts/models.js';
import type {AssistantMessage,AssistantMessageEvent} from '@earendil-works/pi-ai';

test('runtime parameters: temperature zero survives, requested/effective policy clipping is explicit',()=>{
 const p=resolveModelParameters('openai-completions','https://api.openai.com/v1','gpt-4o',{temperature:0,contextWindow:65536,maxOutputTokens:32768,thinkingMode:'off'});
 assert.equal(p.effective.temperature,0);assert.equal(p.effective.maxOutputTokens,16384);assert.equal(p.requested.maxOutputTokens,32768);assert.match(p.adjustments[0]!.reason,/1\/4/);
 assert.equal(resolveModelParameters('openai-completions','https://api.openai.com/v1','gpt-4o',{contextWindow:4096}).effective.maxOutputTokens,1024);
});
test('runtime parameters: unsupported/unknown controls fail closed and legacy modes do not fake efficacy',()=>{
 for(const raw of [{temperature:0},{thinkingMode:'on'},{thinkingMode:'off'},{thinkingLevel:'high'},{foo:1},{contextWindow:0},{temperature:NaN}])assert.throws(()=>resolveModelParameters('openai-completions','https://relay.example/v1','custom-alias',raw));
 const p=resolveModelParameters('openai-completions','https://relay.example/v1','custom-alias',{thinkingMode:'auto'});assert.equal(p.effective.reasoning,undefined);assert.equal(p.capability.verified,false);assert.match(p.adjustments.at(-1)!.reason,/不代表/);
 assert.equal(resolveModelParameters('openai-completions','https://api.openai.com/v1','o3',{thinkingMode:'on'}).effective.reasoning,'medium');
 assert.throws(()=>resolveModelParameters('openai-completions','https://api.openai.com/v1','o3',{thinkingLevel:'off'}));
 assert.throws(()=>resolveModelParameters('anthropic-messages','https://api.anthropic.com','claude-sonnet-4-20250514',{temperature:0,thinkingLevel:'high'}));
 assert.equal(validate('ModelParameters',{contextWindow:32768,thinkingLevel:'low',temperature:0}).ok,true);
 assert.equal(validate('ModelParameters',{contextWindow:100,thinkingLevel:'fake'}).ok,false);
});
test('context window: pi catalog is the source of truth, explicit override wins, unknown falls back',()=>{
	// 目录收录模型：未显式配置时取目录声明值（deepseek-flash=1M，随 pi-ai 升级自动更新）
	assert.equal(resolveModelContextWindow('https://api.deepseek.com','deepseek-flash'),1000000);
	assert.equal(resolveModelParameters('openai-completions','https://api.deepseek.com','deepseek-flash',{}).effective.contextWindow,1000000);
	// 显式覆盖永远优先
	assert.equal(resolveModelParameters('openai-completions','https://api.deepseek.com','deepseek-flash',{contextWindow:32768}).effective.contextWindow,32768);
	// 未收录且未手填：窗口未知不造数（null，D55 不猜）；空 ID、未知模型返回 undefined
	assert.equal(resolveModelParameters('openai-completions','https://relay.example/v1','custom-alias',{}).effective.contextWindow,null);
	assert.equal(resolveModelContextWindow('https://relay.example/v1','custom-alias'),undefined);
	assert.equal(resolveModelContextWindow('https://api.deepseek.com',''),undefined);
	assert.equal(resolveModelContextWindow('https://api.deepseek.com','  '),undefined);
	// 全目录假冲突（glm-5.3：厂商 1000000 vs radius 1048576）→ 厂商优先取 1M，标准端点未收录也命中
	assert.equal(resolveModelContextWindow('https://open.bigmodel.cn/api/paas/v4','glm-5.3'),1000000);
	assert.equal(resolveModelContextWindow('https://api.z.ai/api/paas/v4','glm-5.3'),1000000);
});
test('thinking capability: catalog levels unlock explicit thinkingLevel; dialect compat only on indexed baseUrl',()=>{
	// glm-5.3 全目录级别结论一致：[low,high,max]（无 off，目录声明 off:null）；deepseek-flash [off,low,high,max]
	for(const base of ['https://open.bigmodel.cn/api/paas/v4','https://open.bigmodel.cn/api/coding/paas/v4','https://api.z.ai/api/paas/v4','https://relay.example/v1'])
		assert.deepEqual(resolveThinkingCapability('openai-completions',base,'glm-5.3').thinkingLevels,['low','high','max'],base);
	assert.deepEqual(resolveThinkingCapability('openai-completions','https://api.deepseek.com','deepseek-flash').thinkingLevels,['off','low','high','max']);
	// compat（线上方言）只在 baseUrl 目录命中时采信：coding 端点 zai/deepseek 格式，标准端点/中转不猜（交给 pi-ai detectCompat）
	const coding=resolveThinkingCapability('openai-completions','https://open.bigmodel.cn/api/coding/paas/v4','glm-5.3');
	assert.equal(((coding.vendorCompat??coding.catalogCompat) as Record<string,unknown>).thinkingFormat,'zai');
	assert.deepEqual(coding.thinkingLevelMap,{off:null,minimal:null,low:'low',medium:null,high:'high',xhigh:null,max:'max'});
	assert.equal(((resolveThinkingCapability('openai-completions','https://api.deepseek.com','deepseek-flash').vendorCompat??resolveThinkingCapability('openai-completions','https://api.deepseek.com','deepseek-flash').catalogCompat) as Record<string,unknown>).thinkingFormat,'deepseek');
	assert.equal(resolveThinkingCapability('openai-completions','https://open.bigmodel.cn/api/paas/v4','glm-5.3').catalogCompat,undefined);
	assert.equal(resolveThinkingCapability('openai-completions','https://relay.example/v1','glm-5.3').catalogCompat,undefined);
	// resolver：目录模型显式级别放行（原先抛错），verified 升级、id 语义不变
	const glm=resolveModelParameters('openai-completions','https://open.bigmodel.cn/api/paas/v4','glm-5.3',{thinkingLevel:'high'});
	assert.equal(glm.effective.reasoning,'high');assert.equal(glm.capability.verified,true);
	assert.equal(resolveModelParameters('openai-completions','https://api.deepseek.com','deepseek-flash',{thinkingLevel:'max'}).effective.reasoning,'max');
	// 目录无 off（glm）→ 显式 off 拒绝；未显式级别仍不发思考参数（默认行为不变）；未知别名仍拒绝
	assert.throws(()=>resolveModelParameters('openai-completions','https://open.bigmodel.cn/api/paas/v4','glm-5.3',{thinkingLevel:'off'}));
	const silent=resolveModelParameters('openai-completions','https://open.bigmodel.cn/api/paas/v4','glm-5.3',{});
	assert.equal(silent.effective.thinkingLevel,'off');assert.equal(silent.effective.reasoning,undefined);
	assert.throws(()=>resolveModelParameters('openai-completions','https://relay.example/v1','custom-alias',{thinkingLevel:'high'}));
	// schema 接受 max；既有 o3/gpt-4o 正则回落无回归
	assert.equal(validate('ModelParameters',{contextWindow:32768,thinkingLevel:'max'}).ok,true);
	assert.equal(resolveModelParameters('openai-completions','https://api.openai.com/v1','o3',{thinkingMode:'on'}).effective.reasoning,'medium');
	assert.equal(resolveThinkingCapability('openai-completions','https://api.openai.com/v1','gpt-4o').temperature,true);
});
test('thinking catalog: non-thinking models keep the picker hidden and callers cannot mutate cached levels',()=>{
	const text=resolveThinkingCapability('openai-completions','https://api.openai.com/v1','gpt-4o');
	assert.deepEqual(text.thinkingLevels,[]);
	const base='https://relay.example/v1';
	const first=resolveThinkingCapability('openai-completions',base,'glm-5.3');
	assert.deepEqual(first.thinkingLevels,['low','high','max']);
	first.thinkingLevels.splice(0,first.thinkingLevels.length,'off');
	assert.deepEqual(resolveThinkingCapability('openai-completions',base,'glm-5.3').thinkingLevels,['low','high','max']);
	assert.equal(resolveModelParameters('openai-completions',base,'glm-5.3',{thinkingLevel:'max'}).effective.reasoning,'max');
	assert.throws(()=>resolveModelParameters('openai-completions',base,'glm-5.3',{thinkingLevel:'off'}));
});
test('agent prompt settings: normalize trims, enforces length, drops blanks and invalid input; default shape has no prompts key',()=>{
 assert.equal(normalizeAgentPrompts(null),undefined);
 assert.equal(normalizeAgentPrompts('text'),undefined);
 assert.equal(normalizeAgentPrompts({subagent:42,compaction:'  '}),undefined);
 assert.deepEqual(normalizeAgentPrompts({subagent:'  自定义  ',compaction:''}),{subagent:'自定义'});
 const long='x'.repeat(AGENT_PROMPT_MAX_CHARS+1);
 assert.deepEqual(normalizeAgentPrompts({mainAppend:long}),{mainAppend:'x'.repeat(AGENT_PROMPT_MAX_CHARS)});
 // 默认响应形状不含 prompts 键（既有 deepEqual 断言依赖；deepStrictEqual 校验键集）；研究能力位缺省全开
 const researchDefaults={researchMcpTools:true,researchSkillMethods:true,researchMemory:true,researchHostVerify:true,researchModelRequestLimit:240,researchToolRequestLimit:480};
 assert.deepEqual(normalizeAgentSettings({}),{autoCompaction:true,keepRecentTurns:3,memoryEnabled:true,subagent:{enabled:true,maxSteps:20,timeoutSeconds:120},askUserQuestionAutoResolutionEnabled:true,...researchDefaults});
 const merged=normalizeAgentSettings({autoCompaction:false,keepRecentTurns:5,prompts:{subagent:'只查数据目录'}});
 assert.deepEqual(merged,{autoCompaction:false,keepRecentTurns:5,memoryEnabled:true,subagent:{enabled:true,maxSteps:20,timeoutSeconds:120},askUserQuestionAutoResolutionEnabled:true,prompts:{subagent:'只查数据目录'},...researchDefaults});
 // 研究键显式写入与越界回退
 assert.deepEqual(normalizeAgentSettings({researchMcpTools:false,researchModelRequestLimit:999,researchToolRequestLimit:10}),{...normalizeAgentSettings({}),researchMcpTools:false,researchModelRequestLimit:400,researchToolRequestLimit:60});
 assert.ok(DEFAULT_SUBAGENT_SYSTEM_PROMPT.includes('只读'));assert.ok(DEFAULT_COMPACTION_SYSTEM_PROMPT.includes('1200'));
});
const entry=(id:string,role:string,content:unknown):CompactEntry=>({id,type:'message',message:{role,content}});
test('compaction sources: retains complete user turns and tool call/result pairs; subsequent compaction uses prior cut',()=>{
 const b=[entry('u1','user','one'),entry('a1','assistant',[{type:'toolCall',id:'call',name:'read_file',arguments:{path:'a'}}]),{...entry('t1','toolResult','result'),message:{role:'toolResult',toolCallId:'call',content:'result'}},entry('u2','user','two'),entry('a2','assistant','two'),entry('u3','user','three'),entry('a3','assistant','three')];
 const p=selectCompactionSources(b,2)!;assert.deepEqual(p.manifest.summarizedIds,['u1','a1','t1']);assert.deepEqual(p.manifest.keptIds,['u2','a2','u3','a3']);
 assert.equal(selectCompactionSources(b,3),null);
 const next=selectCompactionSources([...b,{id:'cp',type:'compaction',summary:'old summary',firstKeptEntryId:'u2'},entry('u4','user','four')],1)!;
 assert.equal(next.previousSummary,'old summary');assert.ok(!next.manifest.summarizedIds.includes('u1'));assert.ok(next.manifest.summarizedIds.includes('u2'));
});
test('private thinking adapter: never conflates thinking with text; metadata requires trusted decoder',async()=>{
 const base={model:'gpt-4o',messages:[{role:'assistant',content:[{type:'thinking',text:'DO_NOT_SHOW'},{type:'text',text:'answer'}],reasoning_content:'PRIVATE'}]};
 const p=parseChatRequest(base);const m=p.messages[0] as AssistantMessage;
 assert.equal(m.content.filter(c=>c.type==='text').map(c=>c.type==='text'?c.text:'').join(''),'answer');assert.equal(m.content[0]!.type,'thinking');
 assert.throws(()=>parseChatRequest({model:'x',messages:[{role:'assistant',content:'answer',reasoning_details:[]}]}));
 let decoded=false;parseChatRequest({model:'x',messages:[{role:'assistant',content:'answer',reasoning_details:['token']}]},{decodePrivateThinking:details=>{assert.deepEqual(details,['token']);decoded=true;return [{type:'thinking',thinking:'PRIVATE',thinkingSignature:'signed'}];}});assert.ok(decoded);
 const final={...m,stopReason:'stop'} as AssistantMessage;
 async function* events(){yield {type:'done',reason:'stop',message:final} as AssistantMessageEvent;}
 const wire=await new Response(encodeSseFromEvents(events(),'id','x',0,{encodePrivateThinking:()=>[{type:'reasoning.encrypted',data:'opaque-token'}]})).text();
 assert.match(wire,/opaque-token/);assert.ok(!wire.includes('PRIVATE'));assert.ok(!wire.includes('DO_NOT_SHOW'));
});
