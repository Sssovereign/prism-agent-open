import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SEARCH_PROVIDERS,SEARCH_PROVIDER_OPTIONS,type EnabledSearchProvider} from '../contracts/search.js';
import {createWebSearcher,parseSearchHttpResponse,type SearchHttpRequest} from '../src/agent/searchProviders.js';
import {Db} from '../src/storage/db.js';
import {migrate} from '../src/storage/migrate.js';
import {setSearchProvider,setSearchCredential,getSearchSettings,peekSearchCredential} from '../src/agent/searchSettings.js';
const key='synthetic-search-key',q='中文研究 & evidence?';
const fixtures:Record<EnabledSearchProvider,{url:string;auth:string;raw:unknown;snippet:string}>={
 bocha:{url:'https://api.bochaai.com/v1/web-search',auth:'authorization',raw:{code:200,data:{webPages:{value:[{name:'证据',url:'https://example.com/article',summary:'博查 摘要'}]}}},snippet:'博查 摘要'},
 tavily:{url:'https://api.tavily.com/search',auth:'authorization',raw:{results:[{title:'证据',url:'https://example.com/article',content:'Tavily 摘要'}]},snippet:'Tavily 摘要'},
 zhipu:{url:'https://open.bigmodel.cn/api/paas/v4/web_search',auth:'authorization',raw:{search_result:[{title:'证据',link:'https://example.com/article',content:'智谱 摘要'}]},snippet:'智谱 摘要'},
 zai:{url:'https://api.z.ai/api/paas/v4/web_search',auth:'authorization',raw:{search_result:[{title:'证据',link:'https://example.com/article',content:'Z.ai 摘要'}]},snippet:'Z.ai 摘要'},
 qianfan:{url:'https://qianfan.baidubce.com/v2/ai_search/web_search',auth:'authorization',raw:{references:[{title:'证据',url:'https://example.com/article',snippet:'千帆 摘要'}]},snippet:'千帆 摘要'},
 kimi:{url:'https://api.moonshot.cn/v1/tools/search',auth:'authorization',raw:{search_results:[{title:'证据',url:'https://example.com/article',snippet:'Kimi 摘要'}]},snippet:'Kimi 摘要'},
 deepseek:{url:'https://api.deepseek.com/v1/tools/search',auth:'authorization',raw:{results:[{title:'证据',url:'https://example.com/article',snippet:'DeepSeek 摘要'}]},snippet:'DeepSeek 摘要'},
 brave:{url:'https://api.search.brave.com/res/v1/web/search',auth:'x-subscription-token',raw:{web:{results:[{title:'证据',url:'https://example.com/article',description:'Brave 摘要'}]}},snippet:'Brave 摘要'},
 exa:{url:'https://api.exa.ai/search',auth:'x-api-key',raw:{results:[{title:'证据',url:'https://example.com/article',highlights:['Exa','摘录']}]},snippet:'Exa 摘录'},
 serper:{url:'https://google.serper.dev/search',auth:'x-api-key',raw:{organic:[{title:'证据',link:'https://example.com/article',snippet:'Serper 摘要'}]},snippet:'Serper 摘要'},
 perplexity:{url:'https://api.perplexity.ai/search',auth:'authorization',raw:{results:[{title:'证据',url:'https://example.com/article',snippet:'Perplexity 摘要'}]},snippet:'Perplexity 摘要'},
};
for(const provider of Object.keys(fixtures) as EnabledSearchProvider[])test(`search providers: ${provider} 请求鉴权、查询与返回结构`,async()=>{
 const f=fixtures[provider],calls:SearchHttpRequest[]=[];
 const search=createWebSearcher(async request=>{calls.push(request);return f.raw;});
 const result=await search(provider,key,`  ${q} `,3);assert.equal(calls.length,1);const request=calls[0]!,url=new URL(request.url);
 assert.equal(url.origin+url.pathname,f.url);assert.equal(request.headers[f.auth],f.auth==='authorization'?`Bearer ${key}`:key);assert.ok(!request.url.includes(key));
 if(provider==='brave'){assert.equal(request.method,'GET');assert.equal(request.body,undefined);assert.equal(url.searchParams.get('q'),q);assert.equal(url.searchParams.get('count'),'3');assert.equal(request.headers.authorization,undefined);}
 else{
  assert.equal(request.method,'POST');const body=JSON.parse(request.body!);
  if(provider==='serper')assert.equal(body.q,q);
  else if(provider==='zhipu'||provider==='zai')assert.equal(body.search_query,q);
  else if(provider==='qianfan'){assert.deepEqual(body.messages,[{role:'user',content:q}]);assert.equal(body.edition,'standard');}
  else if(provider==='kimi'){assert.equal(body.text_query,q);assert.equal(body.limit,3);}
  else assert.equal(body.query,q);
  if(provider==='exa'){assert.equal(body.numResults,3);assert.deepEqual(body.contents,{highlights:true});}
  if(provider==='tavily'||provider==='perplexity')assert.equal(body.max_results,3);
  if(provider==='tavily')assert.equal(body.api_key,undefined);
  if(provider==='zhipu')assert.equal(body.search_intent,false);
  if(provider==='zai')assert.equal(body.search_engine,'search-prime');
  if(provider==='serper')assert.equal(body.num,3);
  if(provider==='bocha')assert.equal(body.count,3);
  if(provider==='deepseek'){assert.equal(body.count,3);assert.equal(body.need_content,undefined);assert.equal(body.ori_question,undefined);assert.equal(body.localization,undefined);}
  if(['exa','serper'].includes(provider))assert.equal(request.headers.authorization,undefined);
 }
 assert.equal(result.provider,provider);assert.equal(result.query,q);assert.deepEqual(result.results,[{title:'证据',url:'https://example.com/article',snippet:f.snippet}]);assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
});
test('search providers: 共享目录包含十一家服务，不接受未知服务／none且不发请求',async()=>{
 assert.equal(SEARCH_PROVIDERS.length,12);assert.deepEqual(SEARCH_PROVIDER_OPTIONS.map(p=>p.value),SEARCH_PROVIDERS);
 let calls=0;const search=createWebSearcher(async()=>{calls++;return {};});
 for(const provider of ['none','google','unknown',null])await assert.rejects(search(provider as never,key,q,3),/搜索服务不存在/);
 assert.equal(calls,0);
});
test('search providers: 空查询、异常数量与密钥在出站前拒绝',async()=>{
 let calls=0;const search=createWebSearcher(async()=>{calls++;return fixtures.exa.raw;});
 for(const input of [{query:' ',apiKey:key,count:3},{query:'x'.repeat(401),apiKey:key,count:3},{query:q,apiKey:'bad key',count:3},{query:q,apiKey:'',count:3},{query:q,apiKey:key,count:NaN}])await assert.rejects(search('exa',input.apiKey,input.query,input.count));
 assert.equal(calls,0);
});
test('search providers: 结果数量封顶、去重、过滤非网页链接和坏记录，摘要限长',async()=>{
 const rows=[null,{url:'javascript:alert(1)'},{url:'https://u:p@example.com/'},{title:'x'.repeat(300),url:'https://example.com/one',snippet:'word '.repeat(200)},{url:'https://example.com/one'},...Array.from({length:15},(_,n)=>({url:`https://example.com/${n}`,title:`结果${n}`}))];
 let requested=0;const search=createWebSearcher(async request=>{requested=JSON.parse(request.body!).max_results;return {results:rows};});
 const result=await search('perplexity',key,q,999);assert.equal(requested,10);assert.equal(result.results.length,10);assert.equal(result.results[0]!.title.length,200);assert.equal(result.results[0]!.snippet.length,400);assert.equal(new Set(result.results.map(r=>r.url)).size,10);
});
test('search providers: 正常空列表有效，错误信封／缺失列表／坏JSON不伪装空成功',async()=>{
 const search=createWebSearcher(async()=>({results:[]}));assert.deepEqual((await search('exa',key,q,5)).results,[]);
 for(const raw of [null,[],{},'bad',{error:'invalid key',results:[]},{results:null}])await assert.rejects(createWebSearcher(async()=>raw)('exa',key,q,3),/搜索服务/);
 await assert.rejects(createWebSearcher(async()=>({code:401,data:{webPages:{value:[]}}}))('bocha',key,q,3),/报告失败/);
 assert.throws(()=>parseSearchHttpResponse(200,'not json'),/有效 JSON/);
});
test('search providers: 鉴权、额度、限流、重定向和服务器错误不暴露上游正文',()=>{
 for(const [status,message,code] of [[401,'鉴权失败','PROVIDER_ERROR'],[403,'拒绝访问','PROVIDER_ERROR'],[402,'额度不足','PROVIDER_ERROR'],[429,'请求过于频繁','PROVIDER_RATE_LIMIT'],[302,'未转发搜索密钥','PROVIDER_ERROR'],[500,'HTTP 500','PROVIDER_ERROR']] as const){
  assert.throws(()=>parseSearchHttpResponse(status,JSON.stringify({error:key})),(error:unknown)=>{const e=error as {code:string;message:string;details:unknown};assert.equal(e.code,code);assert.ok(e.message.includes(message));assert.ok(!JSON.stringify(e).includes(key));return true;});
 }
});
test('search providers: 智谱余额不足(1113)映射为额度文案而非限流，不透传上游正文',()=>{
 assert.throws(()=>parseSearchHttpResponse(429,JSON.stringify({error:{code:'1113',message:'余额不足或无可用资源包,请充值。'}})),(error:unknown)=>{const e=error as {code:string;message:string};assert.equal(e.code,'PROVIDER_ERROR');assert.ok(e.message.includes('余额不足'));assert.ok(!e.message.includes('余额不足或无可用资源包,请充值。'));return true;});
 for(const body of [JSON.stringify({error:{code:'1302'}}),'not json']) assert.throws(()=>parseSearchHttpResponse(429,body),/请求过于频繁/);
});
test('search providers: 智谱401/403特化文案点破套餐Key调不了搜索API，其他厂商文案不变',()=>{
 for(const status of [401,403] as const) assert.throws(()=>parseSearchHttpResponse(status,'{}','zhipu'),(error:unknown)=>{const e=error as {message:string};assert.ok(e.message.includes('Coding Plan 套餐 Key 无法调用'));assert.ok(e.message.includes('主站 API Key'));return true;});
 assert.throws(()=>parseSearchHttpResponse(401,'{}'),/请检查所选厂商的 API Key 和搜索权限/);
 assert.throws(()=>parseSearchHttpResponse(401,'{}','kimi'),/请检查所选厂商的 API Key 和搜索权限/);
});
test('search providers: 十一家设置可持久化，同厂商保留Key、切换清除Key且账号隔离',()=>{
 const dir=mkdtempSync(join(tmpdir(),'prism-search-catalog-')),db=new Db(join(dir,'db.sqlite'));
 try{
  migrate(db);const uid=randomUUID(),other=randomUUID(),time=new Date().toISOString();
  for(const id of [uid,other])db.db.prepare("INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES (?,?,'x','s','{}',?,?)").run(id,id,time,time);
  for(const provider of Object.keys(fixtures) as EnabledSearchProvider[]){
   const saved=setSearchProvider(db,uid,provider);assert.equal(saved.provider,provider);assert.equal(saved.credentialStored,false);assert.equal(saved.sourceConfigId,null);assert.equal(saved.sourceValid,false);
   setSearchCredential(db,uid,key);assert.equal(setSearchProvider(db,uid,provider).credentialStored,true);assert.equal(peekSearchCredential(db,uid),key);assert.deepEqual(getSearchSettings(db,other),{provider:'none',credentialStored:false,sourceConfigId:null,sourceConfigName:null,sourceValid:false});
  }
  assert.equal(setSearchProvider(db,uid,'none').credentialStored,false);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});


test('search providers: 博查官网直接结构与官方SDK封装结构均可解析',async()=>{
 const envelope=fixtures.bocha.raw as {data:unknown};
 const direct=await createWebSearcher(async()=>envelope.data)('bocha',key,q,1);
 const wrapped=await createWebSearcher(async()=>envelope)('bocha',key,q,1);
 assert.deepEqual(direct.results,wrapped.results);
});
test('search providers: 智谱遵循官方70字符限制，拒绝前不出站',async()=>{
 let calls=0;const search=createWebSearcher(async()=>{calls++;return fixtures.zhipu.raw;});
 await assert.rejects(search('zhipu',key,'中'.repeat(71),3),/70字符/);assert.equal(calls,0);
 await search('zhipu',key,'中'.repeat(70),3);assert.equal(calls,1);
});
test('search providers: 千帆遵循官方72字符限制，拒绝前不出站',async()=>{
 let calls=0;const search=createWebSearcher(async()=>{calls++;return fixtures.qianfan.raw;});
 await assert.rejects(search('qianfan',key,'中'.repeat(73),3),/72字符/);assert.equal(calls,0);
 await search('qianfan',key,'中'.repeat(72),3);assert.equal(calls,1);
});
test('search providers: Kimi 联网搜索 Basic 请求与解析对齐官方文档',async()=>{
 let calls=0;const search=createWebSearcher(async request=>{calls++;const body=JSON.parse(request.body!) as Record<string,unknown>;assert.equal(body.include_content,undefined);assert.equal(body.timeout_seconds,undefined);return fixtures.kimi.raw;});
 const result=await search('kimi',key,q,10);assert.equal(calls,1);assert.equal(result.results[0]!.snippet,'Kimi 摘要');
 // 官方 limit 范围 1—20，棱镜结果封顶 10 不会越界
 const capped=await createWebSearcher(async()=>fixtures.kimi.raw)('kimi',key,q,999);assert.equal(capped.results.length,1);
});
test('search providers: DeepSeek Search 请求与解析对齐官方文档，snippet 缺失回退 summary',async()=>{
 // 官方字段：results[]{title,url,snippet,summary,...}；need_content 默认 false 不传
 let calls=0;const search=createWebSearcher(async request=>{calls++;const body=JSON.parse(request.body!) as Record<string,unknown>;assert.equal(body.query,q);return fixtures.deepseek.raw;});
 const result=await search('deepseek',key,q,10);assert.equal(calls,1);assert.equal(result.results[0]!.snippet,'DeepSeek 摘要');
 const fallback=await createWebSearcher(async()=>({results:[{title:'证据',url:'https://example.com/fallback',summary:'DeepSeek 长摘要（600—800字）'}]}))('deepseek',key,q,5);
 assert.equal(fallback.results[0]!.snippet,'DeepSeek 长摘要（600—800字）');
});
test('search providers: DeepSeek 遵循官方128字符限制，拒绝前不出站',async()=>{
 let calls=0;const search=createWebSearcher(async()=>{calls++;return fixtures.deepseek.raw;});
 await assert.rejects(search('deepseek',key,'中'.repeat(129),3),/128字符/);assert.equal(calls,0);
 await search('deepseek',key,'中'.repeat(128),3);assert.equal(calls,1);
});
