import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildProductApp} from '../src/app.js';
import {clearLoginFailures} from '../src/auth/routes.js';
import {resolveSearchKey, resolveRunSearchBinding, webSearchAvailableForBinding} from '../src/agent/searchSettings.js';
import {isPlanModelEndpoint, searchBindingForBaseUrl} from '../contracts/search.js';
import {validateModelConfigInput} from '../src/contracts/schemas.js';
import {Db} from '../src/storage/db.js';
import {migrate} from '../src/storage/migrate.js';

const password='SyntheticReuse2026!',apiKey='synthetic-reuse-key-4f7b2a';
async function fixture(t:{after(fn:()=>unknown):unknown}){const dir=mkdtempSync(join(tmpdir(),'prism-search-reuse-'));const fx=buildProductApp(dir,{serveWeb:false});t.after(async()=>{clearLoginFailures();await fx.app.close();rmSync(dir,{recursive:true,force:true});});return {fx,dir};}
const register=(fx:ReturnType<typeof buildProductApp>,username:string)=>fx.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{username,password,confirmation:password,remember:true}});
function auth(r:{headers:Record<string,unknown>;json():any}){return {cookie:String(r.headers['set-cookie']).split(';')[0]!, 'x-csrf-token':r.json().data.csrfToken as string};}

test('模型接口 Key 可被联网搜索引用：勾选写入、优先于独立 Key、失效可见、解除引用回到独立 Key',async t=>{
 const {fx}=await fixture(t);
 const a=auth(await register(fx,'reuse-user'));
 // 契约接受千帆预设
 assert.equal(validateModelConfigInput({preset:'qianfan',name:'qf',baseUrl:'https://qianfan.baidubce.com/v2',models:[{modelId:'ernie',displayName:'ernie',enabled:true,parameters:{}}]}).ok,true);
 const qianfanConfig={preset:'qianfan' as const,name:'qianfan',baseUrl:'https://qianfan.baidubce.com/v2',models:[{modelId:'ernie',displayName:'ernie',enabled:true,parameters:{}}]};
 const c=(await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers:a,payload:qianfanConfig})).json().data;
 await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${c.id}/credential`,headers:a,payload:{apiKey}});
 const uid=(fx.db.db.prepare("SELECT id FROM users WHERE username='reuse-user'").get() as {id:string}).id;
 // 未勾选且无独立 Key：明确未配置
 assert.throws(()=>resolveSearchKey(fx.db,uid),/未保存/);
 // 勾选引用：设置显示来源与有效状态
 const linked=await fx.app.inject({method:'PUT',url:'/api/v1/search-settings',headers:a,payload:{provider:'qianfan',sourceConfigId:c.id}});
 assert.equal(linked.statusCode,200,linked.body);
 const settings=linked.json().data;
 assert.equal(settings.provider,'qianfan');assert.equal(settings.sourceConfigId,c.id);assert.equal(settings.sourceConfigName,'qianfan');assert.equal(settings.sourceValid,true);assert.equal(settings.credentialStored,false);
 // 引用优先：同时存独立 Key 也解析到引用
 await fx.app.inject({method:'PUT',url:'/api/v1/search-settings/credential',headers:a,payload:{apiKey:'standalone-key'}});
 assert.deepEqual(resolveSearchKey(fx.db,uid),{key:apiKey,source:'reference'});
 // 引用失效：清除全部模型 Key 后引用仍在但 sourceValid=false，搜索入口拒绝并指路
 await fx.app.inject({method:'DELETE',url:'/api/v1/model-credentials',headers:a});
 const broken=(await fx.app.inject({url:'/api/v1/search-settings',headers:a})).json().data;
 assert.equal(broken.sourceConfigId,c.id);assert.equal(broken.sourceValid,false);
 assert.throws(()=>resolveSearchKey(fx.db,uid),/引用/);
 // 重新保存 Key → 引用即时恢复有效
 await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${c.id}/credential`,headers:a,payload:{apiKey}});
 assert.equal((await fx.app.inject({url:'/api/v1/search-settings',headers:a})).json().data.sourceValid,true);
 // 解除引用 → 回到独立 Key
 await fx.app.inject({method:'PUT',url:'/api/v1/search-settings/credential',headers:a,payload:{apiKey:'standalone-key'}});
 const unlinked=await fx.app.inject({method:'DELETE',url:'/api/v1/search-settings/source',headers:a});
 assert.equal(unlinked.statusCode,200,unlinked.body);assert.equal(unlinked.json().data.sourceConfigId,null);
 assert.deepEqual(resolveSearchKey(fx.db,uid),{key:'standalone-key',source:'standalone'});
});

test('引用护栏：地址不匹配、非本人接口拒绝；换厂商清引用；停用接口联动解除',async t=>{
 const {fx}=await fixture(t);
 const a=auth(await register(fx,'reuse-guard')),b=auth(await register(fx,'reuse-other'));
 const generic={preset:'custom' as const,name:'generic',baseUrl:'https://models.example.org/v1',models:[{modelId:'fixture',displayName:'fixture',enabled:true,parameters:{}}]};
 const mine=(await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers:a,payload:generic})).json().data;
 const others=(await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers:b,payload:generic})).json().data;
 await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${mine.id}/credential`,headers:a,payload:{apiKey}});
 // 地址主机名不映射到所选搜索服务 → 拒绝
 assert.equal((await fx.app.inject({method:'PUT',url:'/api/v1/search-settings',headers:a,payload:{provider:'zhipu',sourceConfigId:mine.id}})).statusCode,400);
 // 非本人接口 → 404，且 b 的设置仍无引用
 assert.equal((await fx.app.inject({method:'PUT',url:'/api/v1/search-settings',headers:b,payload:{provider:'perplexity',sourceConfigId:mine.id}})).statusCode,404);
 assert.equal((await fx.app.inject({url:'/api/v1/search-settings',headers:b})).json().data.sourceConfigId,null);
 // 引用千帆官方地址成功（需先建一条千帆接口并存 Key）；独立 Key 同存；换厂商 → 引用与独立 Key 一并清除（沿用旧语义）
 const qf={preset:'qianfan' as const,name:'qianfan',baseUrl:'https://qianfan.baidubce.com/v2',models:[{modelId:'ernie',displayName:'ernie',enabled:true,parameters:{}}]};
 const linked=(await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers:a,payload:qf})).json().data;
 await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${linked.id}/credential`,headers:a,payload:{apiKey}});
 const okPut=await fx.app.inject({method:'PUT',url:'/api/v1/search-settings',headers:a,payload:{provider:'qianfan',sourceConfigId:linked.id}});
 assert.equal(okPut.statusCode,200,okPut.body);
 // Kimi 官方地址同样可引用（api.moonshot.cn host 映射）
 const kimiConfig={preset:'kimi' as const,name:'kimi',baseUrl:'https://api.moonshot.cn/v1',models:[{modelId:'kimi-k3',displayName:'kimi-k3',enabled:true,parameters:{}}]};
 const kimiLinked=(await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers:a,payload:kimiConfig})).json().data;
 await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${kimiLinked.id}/credential`,headers:a,payload:{apiKey}});
 const kimiPut=await fx.app.inject({method:'PUT',url:'/api/v1/search-settings',headers:a,payload:{provider:'kimi',sourceConfigId:kimiLinked.id}});
 assert.equal(kimiPut.statusCode,200,kimiPut.body);
 const kimiSettings=kimiPut.json().data;
 assert.equal(kimiSettings.sourceValid,true);assert.equal(kimiSettings.sourceConfigName,'kimi');
 await fx.app.inject({method:'PUT',url:'/api/v1/search-settings/credential',headers:a,payload:{apiKey}});
 await fx.app.inject({method:'PUT',url:'/api/v1/search-settings',headers:a,payload:{provider:'bocha'}});
 const after=(await fx.app.inject({url:'/api/v1/search-settings',headers:a})).json().data;
 assert.equal(after.provider,'bocha');assert.equal(after.sourceConfigId,null);assert.equal(after.credentialStored,false);
 // 重新引用后停用接口 → PATCH 清 Key 联动解除引用
 await fx.app.inject({method:'PUT',url:'/api/v1/search-settings',headers:a,payload:{provider:'qianfan',sourceConfigId:linked.id}});
 const disabled=await fx.app.inject({method:'PATCH',url:`/api/v1/model-configs/${linked.id}`,headers:a,payload:{...qf,revision:linked.revision,enabled:false}});
 assert.equal(disabled.statusCode,200,disabled.body);
 assert.equal((await fx.app.inject({url:'/api/v1/search-settings',headers:a})).json().data.sourceConfigId,null);
});

test('删除模型配置时 search_settings.source_config_id 由外键置空',()=>{
 const dir=mkdtempSync(join(tmpdir(),'prism-search-fk-')),db=new Db(join(dir,'db.sqlite'));
 try{
  migrate(db);const time=new Date().toISOString();
  const uid=randomUUID(),cid=randomUUID();
  db.db.prepare("INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES (?,?,'x','s','{}',?,?)").run(uid,uid,time,time);
  db.db.prepare("INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,api_protocol,revision,enabled,created_at,updated_at) VALUES (?,?,'qianfan','qf','https://qianfan.baidubce.com/v2','openai-completions',1,1,?,?)").run(cid,uid,time,time);
  db.db.prepare("INSERT INTO search_settings(user_id,provider,source_config_id,updated_at) VALUES (?,'qianfan',?,?)").run(uid,cid,time);
  db.db.prepare('DELETE FROM model_configs WHERE id=?').run(cid);
  assert.equal((db.db.prepare('SELECT source_config_id AS v FROM search_settings WHERE user_id=?').get(uid) as {v:string|null}).v,null);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('接口能力勾选（学ZCode）：POST/PATCH searchEnabled 校验、落库与派生下发',async t=>{
 const {fx}=await fixture(t);
 const a=auth(await register(fx,'search-binding-user'));
 const ds={preset:'deepseek' as const,name:'deepseek',baseUrl:'https://api.deepseek.com',models:[{modelId:'deepseek-flash',displayName:'ds',enabled:true,parameters:{}}]};
 // POST 带勾选 → 落库并下发 searchProvider/searchBinding（available+厂商）
 const created=(await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers:a,payload:{...ds,searchEnabled:true}})).json().data;
 assert.equal(created.searchProvider,'deepseek');
 assert.deepEqual(created.searchBinding,{available:true,provider:'deepseek',label:'DeepSeek',planKeyWarning:false});
 // POST 勾选但地址推导不出（中转站）→ 422
 const relay={preset:'custom' as const,name:'relay',baseUrl:'https://models.example.org/v1',models:ds.models,searchEnabled:true};
 const rejected=await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers:a,payload:relay});
 assert.equal(rejected.statusCode,400,rejected.body);
 // PATCH 取消勾选 → 清空
 const off=await fx.app.inject({method:'PATCH',url:`/api/v1/model-configs/${created.id}`,headers:a,payload:{...ds,searchEnabled:false,revision:created.revision}});
 assert.equal(off.statusCode,200,off.body);
 assert.equal(off.json().data.searchProvider,null);
 // PATCH 重新勾选 → 恢复
 const on=await fx.app.inject({method:'PATCH',url:`/api/v1/model-configs/${created.id}`,headers:a,payload:{...ds,searchEnabled:true,revision:off.json().data.revision}});
 assert.equal(on.json().data.searchProvider,'deepseek');
 // PATCH 改地址到推导不出搜索服务的站点 → 能力位联动解除
 const moved=await fx.app.inject({method:'PATCH',url:`/api/v1/model-configs/${created.id}`,headers:a,payload:{...ds,baseUrl:'https://models.example.org/v1',revision:on.json().data.revision}});
 assert.equal(moved.statusCode,200,moved.body);
 assert.equal(moved.json().data.searchProvider,null);
 // 套餐端点允许勾选但下发警告（glm coding plan 地址）
 const plan={preset:'glm-cn-coding' as const,name:'glm',baseUrl:'https://open.bigmodel.cn/api/coding/paas/v4',models:ds.models,searchEnabled:true};
 const planView=(await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers:a,payload:plan})).json().data;
 assert.equal(planView.searchProvider,'zhipu');
 assert.equal(planView.searchBinding.planKeyWarning,true);
 // 停用接口时勾选拒绝
 const disabledReject=await fx.app.inject({method:'PATCH',url:`/api/v1/model-configs/${created.id}`,headers:a,payload:{...ds,baseUrl:'https://api.deepseek.com',searchEnabled:true,revision:moved.json().data.revision,enabled:false}});
 assert.equal(disabledReject.statusCode,400,disabledReject.body);
});

test('运行时解析：勾选接口优先复用其 Key，未勾选回落全局，都无则报错',async t=>{
 const {fx}=await fixture(t);
 const a=auth(await register(fx,'run-binding-user'));
 const uid=(fx.db.db.prepare("SELECT id FROM users WHERE username='run-binding-user'").get() as {id:string}).id;
 const ds={preset:'deepseek' as const,name:'deepseek',baseUrl:'https://api.deepseek.com',models:[{modelId:'deepseek-flash',displayName:'ds',enabled:true,parameters:{}}]};
 const bound=(await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers:a,payload:{...ds,searchEnabled:true}})).json().data;
 const loose=(await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers:a,payload:{...ds,name:'loose'}})).json().data;
 await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${bound.id}/credential`,headers:a,payload:{apiKey}});
 await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${loose.id}/credential`,headers:a,payload:{apiKey:'loose-key'}});
 // 勾选接口 → 解析到接口 Key 与厂商；未勾选接口 → null（即使同厂商同 Key 也在）
 const binding={configId:bound.id,baseUrl:bound.baseUrl};
 assert.deepEqual(resolveRunSearchBinding(fx.db,uid,binding),{provider:'deepseek',key:apiKey,source:'run-binding'});
 assert.equal(resolveRunSearchBinding(fx.db,uid,{configId:loose.id,baseUrl:loose.baseUrl}),null);
 // 勾选接口 Key 不可读 → 明确报错而非静默回落
 await fx.app.inject({method:'DELETE',url:`/api/v1/model-configs/${bound.id}/credential`,headers:a});
 assert.throws(()=>resolveRunSearchBinding(fx.db,uid,binding),/Key 不可用/);
 // 可见性：勾选即 true（Key 缺失留给调用时报错）；未勾选且全局未配置 → false
 assert.equal(webSearchAvailableForBinding(fx.db,uid,binding),true);
 assert.equal(webSearchAvailableForBinding(fx.db,uid,{configId:loose.id,baseUrl:loose.baseUrl}),false);
 // 全局配置后未勾选接口也可用（兜底）
 await fx.app.inject({method:'PUT',url:'/api/v1/search-settings',headers:a,payload:{provider:'bocha'}});
 assert.equal(webSearchAvailableForBinding(fx.db,uid,{configId:loose.id,baseUrl:loose.baseUrl}),true);
 // 勾选优先于全局：bocha 独立 Key 在，勾选接口仍解析到接口 Key
 await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${bound.id}/credential`,headers:a,payload:{apiKey:'rebound-key'}});
 assert.deepEqual(resolveRunSearchBinding(fx.db,uid,binding),{provider:'deepseek',key:'rebound-key',source:'run-binding'});
 // 停用勾选接口 → 绑定失效回落 null
 await fx.app.inject({method:'PATCH',url:`/api/v1/model-configs/${bound.id}`,headers:a,payload:{...ds,revision:bound.revision,enabled:false}});
 assert.equal(resolveRunSearchBinding(fx.db,uid,binding),null);
 assert.equal(webSearchAvailableForBinding(fx.db,uid,binding),true);
});

test('套餐端点判定：Coding Plan/Anthropic 兼容路径告警，标准 API 地址不告警',()=>{
 assert.equal(isPlanModelEndpoint('https://open.bigmodel.cn/api/coding/paas/v4'),true);
 assert.equal(isPlanModelEndpoint('https://open.bigmodel.cn/api/anthropic'),true);
 assert.equal(isPlanModelEndpoint('https://api.z.ai/api/anthropic/'),true);
 assert.equal(isPlanModelEndpoint('https://open.bigmodel.cn/api/paas/v4'),false);
 assert.equal(isPlanModelEndpoint('https://api.deepseek.com'),false);
 assert.equal(isPlanModelEndpoint('not a url'),false);
 // 绑定派生：标准 glm 地址 available 但不告警；套餐地址两者兼有
 assert.deepEqual(searchBindingForBaseUrl('https://open.bigmodel.cn/api/paas/v4'),{available:true,provider:'zhipu',label:'智谱 BigModel',planKeyWarning:false});
 assert.deepEqual(searchBindingForBaseUrl('https://open.bigmodel.cn/api/coding/paas/v4'),{available:true,provider:'zhipu',label:'智谱 BigModel',planKeyWarning:true});
 assert.deepEqual(searchBindingForBaseUrl('https://models.example.org/v1'),{available:false,provider:null,label:null,planKeyWarning:false});
});
