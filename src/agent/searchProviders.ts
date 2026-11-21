import { ApiError } from '../../contracts/errors.js';
import { isSearchProvider, type EnabledSearchProvider, type SearchProvider, type WebSearchToolResult } from '../../contracts/search.js';

/** Provider-specific wire formats. Production transport stays HTTPS/DNS-pinned in webTools. */
export interface SearchHttpRequest {
  url: string; method: 'GET' | 'POST'; headers: Record<string,string>; body?: string;
}
export type SearchRequester = (request: SearchHttpRequest, provider: EnabledSearchProvider) => Promise<unknown>;
type ObjectValue = Record<string,unknown>;
const object = (value:unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const text = (value:unknown): string => typeof value === 'string' ? value : '';

export function searchRequest(provider: EnabledSearchProvider, key: string, query: string, count: number): SearchHttpRequest {
  const post = (url:string,headers:Record<string,string>,body:unknown):SearchHttpRequest => ({url,method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const bearer={authorization:`Bearer ${key}`};
  switch(provider) {
    case 'bocha': return post('https://api.bochaai.com/v1/web-search',bearer,{query,freshness:'noLimit',summary:true,count});
    case 'tavily': return post('https://api.tavily.com/search',bearer,{query,max_results:count,include_answer:false});
    case 'zhipu': return post('https://open.bigmodel.cn/api/paas/v4/web_search',bearer,{search_engine:'search_std',search_query:query,search_intent:false});
    case 'zai': return post('https://api.z.ai/api/paas/v4/web_search',bearer,{search_engine:'search-prime',search_query:query,count});
    case 'qianfan': return post('https://qianfan.baidubce.com/v2/ai_search/web_search',bearer,{messages:[{role:'user',content:query}],edition:'standard'});
    case 'kimi': return post('https://api.moonshot.cn/v1/tools/search',bearer,{text_query:query,limit:count});
    // DeepSeek Search API（官方文档 2026-11-16 核对）：need_content 默认 false 不传，ori_question/localization 不用
    case 'deepseek': return post('https://api.deepseek.com/v1/tools/search',bearer,{query,count});
    case 'brave': {
      const url=new URL('https://api.search.brave.com/res/v1/web/search');url.searchParams.set('q',query);url.searchParams.set('count',String(count));
      return {url:url.href,method:'GET',headers:{accept:'application/json','x-subscription-token':key}};
    }
    case 'exa': return post('https://api.exa.ai/search',{'x-api-key':key},{query,type:'auto',numResults:count,contents:{highlights:true}});
    case 'serper': return post('https://google.serper.dev/search',{'x-api-key':key},{q:query,num:count});
    case 'perplexity': return post('https://api.perplexity.ai/search',bearer,{query,max_results:count});
    default: throw new ApiError('VALIDATION_FAILED','搜索服务不存在');
  }
}

/** Keep only structured links/snippets; never promote a synthesized answer to source evidence. */
export function normalizeSearch(provider: EnabledSearchProvider, raw: unknown, count: number): WebSearchToolResult['results'] {
  const data=object(raw);
  if(!data)throw new ApiError('PROVIDER_ERROR','搜索服务响应结构异常，请检查服务或稍后重试');
  let rows:unknown;
  switch(provider) {
    case 'bocha':
      if(data.code!==undefined&&data.code!==200&&data.code!=='200')throw new ApiError('PROVIDER_ERROR','博查搜索服务报告失败，请检查密钥与服务额度');
      rows=object((object(data.data)??data).webPages)?.value;break;
    case 'brave': rows=object(data.web)?.results;break;
    case 'serper': rows=data.organic;break;
    case 'zhipu': case 'zai': rows=data.search_result;break;
    case 'qianfan': rows=data.references;break;
    case 'kimi': rows=data.search_results;break;
    case 'deepseek': case 'tavily': case 'exa': case 'perplexity': rows=data.results;break;
    default: throw new ApiError('VALIDATION_FAILED','搜索服务不存在');
  }
  if(data.error || !Array.isArray(rows))throw new ApiError('PROVIDER_ERROR','搜索服务未返回有效结果列表，请检查密钥、服务额度或稍后重试');
  const results:WebSearchToolResult['results']=[],seen=new Set<string>();
  for(const row of rows) {
    const p=object(row);if(!p)continue;
    const url=text(p.url)||text(p.link);let parsed:URL;
    try{parsed=new URL(url);}catch{continue;}
    if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password||seen.has(parsed.href))continue;
    let snippet:string;
    switch(provider) {
      case 'bocha': snippet=text(p.summary)||text(p.snippet);break;
      case 'tavily': case 'zhipu': case 'zai': snippet=text(p.content);break;
      case 'qianfan': snippet=text(p.snippet)||text(p.content);break;
      // DeepSeek 官方：snippet 为展示摘要（100—200字），summary 为模型阅读摘要（600—800字），优先后者兜底
      case 'deepseek': snippet=text(p.snippet)||text(p.summary);break;
      case 'brave': snippet=text(p.description);break;
      case 'exa': snippet=Array.isArray(p.highlights)?p.highlights.filter(h=>typeof h==='string').join(' '):text(p.text);break;
      default: snippet=text(p.snippet);
    }
    seen.add(parsed.href);
    results.push({title:(text(p.title)||text(p.name)||url).slice(0,200),url:parsed.href,snippet:snippet.replace(/\s+/g,' ').trim().slice(0,400)});
    if(results.length>=count)break;
  }
  return results;
}

/** Injection is trusted server/test composition only; callers cannot select URLs or headers. */
export function createWebSearcher(request:SearchRequester) {
  return async (provider:SearchProvider,apiKey:string,query:string,count:number):Promise<WebSearchToolResult> => {
    if(!isSearchProvider(provider)||provider==='none')throw new ApiError('VALIDATION_FAILED','搜索服务不存在');
    if(typeof query!=='string'||!query.trim()||query.trim().length>400)throw new ApiError('VALIDATION_FAILED','搜索词须为1—400字符');
    if(typeof apiKey!=='string'||!apiKey.trim()||apiKey.length>512||/[\s\x00-\x1f\x7f]/.test(apiKey))throw new ApiError('SEARCH_NOT_CONFIGURED','搜索 API Key 无效，请在设置中重新保存');
    if(!Number.isFinite(count))throw new ApiError('VALIDATION_FAILED','搜索结果数量无效');
    const capped=Math.min(10,Math.max(1,Math.floor(count))),trimmed=query.trim();
    if(provider==='zhipu'&&trimmed.length>70)throw new ApiError('VALIDATION_FAILED','智谱搜索词不能超过70字符，请精简搜索词');
    if(provider==='qianfan'&&trimmed.length>72)throw new ApiError('VALIDATION_FAILED','千帆搜索词不能超过72字符，请精简搜索词');
    if(provider==='deepseek'&&trimmed.length>128)throw new ApiError('VALIDATION_FAILED','DeepSeek 搜索词不能超过128字符，请精简搜索词');
    const raw=await request(searchRequest(provider,apiKey,trimmed,capped),provider);
    return {query:trimmed,provider,results:normalizeSearch(provider,raw,capped),fetchedAt:new Date().toISOString()};
  };
}


/** Do not include provider response bodies in errors: they may echo credentials.
 *  智谱把「余额不足/无资源包」伪装成 HTTP 429（error.code=1113），按固定文案单独映射，不透传响应体。
 *  智谱 401/403 特化：搜索 API 属主站按量计费体系，Coding Plan 套餐 Key（/api/anthropic 等端点用）调不了——
 *  2026-11-17 官方文档核对，正是「apikey 的地址不对」的真实含义：主机名相同，但 Key 的产品体系不同。 */
const ZHIPU_AUTH_HINT='智谱 Web Search API 属主站按量计费服务：须用智谱开放平台主站 API Key（bigmodel.cn 控制台生成，账号需有余额或搜索资源包），Coding Plan 套餐 Key 无法调用；请在设置→联网搜索为智谱单独保存主站 Key，或更换其他搜索服务';
export function parseSearchHttpResponse(status:number,body:string,provider?:EnabledSearchProvider):unknown {
  if(status===403)throw new ApiError('PROVIDER_ERROR',provider==='zhipu'?`搜索服务拒绝访问。${ZHIPU_AUTH_HINT}`:'搜索服务拒绝访问，请检查密钥、搜索权限或服务额度');
  if(status===401)throw new ApiError('PROVIDER_ERROR',provider==='zhipu'?`搜索服务鉴权失败。${ZHIPU_AUTH_HINT}`:'搜索服务鉴权失败，请检查所选厂商的 API Key 和搜索权限');
  if([402,432,433].includes(status))throw new ApiError('PROVIDER_ERROR','搜索服务额度不足，请检查该厂商账号余额或套餐');
  if(status===429) {
    let outOfQuota=false;
    try{outOfQuota=(JSON.parse(body) as {error?:{code?:string}})?.error?.code==='1113';}catch{}
    if(outOfQuota)throw new ApiError('PROVIDER_ERROR','智谱联网搜索余额不足或无可用资源包：请为智谱账号充值购买搜索资源包，或在设置→联网搜索更换其他服务');
    throw new ApiError('PROVIDER_RATE_LIMIT','搜索服务请求过于频繁或额度受限，请稍后重试并检查套餐');
  }
  if(status>=300&&status<400)throw new ApiError('PROVIDER_ERROR','搜索接口返回了重定向，未转发搜索密钥，请检查服务状态');
  if(status<200||status>=400)throw new ApiError('PROVIDER_ERROR',`搜索服务返回 HTTP ${status}`);
  try{return JSON.parse(body) as unknown;}
  catch{throw new ApiError('PROVIDER_ERROR','搜索服务响应不是有效 JSON');}
}
