/**
 * Shiki 高亮协调器（块E1）：按 ZCode shikiHighlighter.ts 语义移植。
 * 与上游的差异：shiki 的 createHighlighter 经工厂注入（Vue 侧用动态 import 装配，
 * 保持代码分包与 node 测试无重依赖）；缓存键、纯文本旁路、lang 回退、
 * 订阅回调微任务语义与上游一致。
 */

export interface Token { color:string;content:string }
export interface TokenizedCode { tokens:Token[][];fg:string;bg:string }

const FALLBACK_CODE_LANGUAGE='log';
const PLAIN_TEXT_CODE_LANGUAGES=new Set(['','text','txt','plain','plaintext','log','output']);

export function isPlainTextCodeLanguage(language:string):boolean{
 return PLAIN_TEXT_CODE_LANGUAGES.has(language.trim().toLowerCase());
}
/** 语言是否可高亮：非纯文本且在已装配语言集（含别名）内。 */
export function shouldUseSyntaxHighlighting(language:string,bundledLanguageIds:Set<string>,bundledLanguageAliases:Map<string,string>):boolean{
 const candidate=language.trim().toLowerCase();
 if(PLAIN_TEXT_CODE_LANGUAGES.has(candidate))return false;
 return bundledLanguageIds.has(candidate)||bundledLanguageAliases.has(candidate);
}
export function normalizeCodeLanguage(language:string,bundledLanguageIds:Set<string>,bundledLanguageAliases:Map<string,string>):string{
 const candidate=language.trim().toLowerCase();
 if(!candidate)return FALLBACK_CODE_LANGUAGE;
 const alias=bundledLanguageAliases.get(candidate);
 if(alias&&bundledLanguageIds.has(alias))return alias;
 if(bundledLanguageIds.has(candidate))return candidate;
 return FALLBACK_CODE_LANGUAGE;
}
export function resolveCodeTheme():'github-dark-default'|'github-light-default'{
 if(typeof document!=='undefined'){
  const root=document.documentElement;
  if(root.dataset.theme==='dark'||(!root.dataset.theme&&root.classList.contains('dark')))return 'github-dark-default';
 }
 return 'github-light-default';
}
export function createRawCodeTokens(code:string):TokenizedCode{
 return {bg:'transparent',fg:'inherit',tokens:code.split('\n').map(line=>line===''?[]:[{color:'inherit',content:line}])};
}
function getCodeTokensCacheKey(code:string,language:string,theme:string):string{
 const start=code.slice(0,100);
 const end=code.length>100?code.slice(-100):'';
 return `${theme}:${language}:${code.length}:${start}:${end}`;
}
export interface LoadedHighlighter{
 getLoadedLanguages:()=>string[];
 codeToTokens:(code:string,opts:{lang:string;theme:string})=>{tokens:Token[][];fg?:string};
}
export interface HighlightCoordinatorOptions{
 createHighlighter:(language:string,theme:string)=>Promise<LoadedHighlighter>;
}
/** 纯逻辑协调器：tokensCache 无淘汰（对齐上游，量大时靠内容哈希命中）。 */
export function createHighlightCoordinator(options:HighlightCoordinatorOptions){
 const highlighterCache=new Map<string,Promise<LoadedHighlighter>>();
 const tokensCache=new Map<string,TokenizedCode>();
 const subscribers=new Map<string,Set<(result:TokenizedCode)=>void>>();
 function getHighlighter(language:string,theme:string){
  const cacheKey=`${theme}:${language}`;
  const cached=highlighterCache.get(cacheKey);
  if(cached)return cached;
  const promise=options.createHighlighter(language,theme);
  highlighterCache.set(cacheKey,promise);
  return promise;
 }
 return {
  tokensCacheSize:()=>tokensCache.size,
  /** 带缓存的异步高亮入口；Vue 侧只在 watchEffect/computed 后调用。缓存命中同步返回并微任务通知；未命中返回 null，完成后回调订阅者。 */
  highlightCode(
   code:string,
   language:string,
   resolvedTheme:string,
   bundledLanguageIds:Set<string>,
   bundledLanguageAliases:Map<string,string>,
   callback?:(result:TokenizedCode)=>void,
  ):TokenizedCode|null{
   if(!shouldUseSyntaxHighlighting(language,bundledLanguageIds,bundledLanguageAliases))return createRawCodeTokens(code);
   const resolvedLanguage=normalizeCodeLanguage(language,bundledLanguageIds,bundledLanguageAliases);
   const tokensCacheKey=getCodeTokensCacheKey(code,resolvedLanguage,resolvedTheme);
   const cached=tokensCache.get(tokensCacheKey);
   if(cached){
    if(callback)queueMicrotask(()=>callback(cached));
    return cached;
   }
   if(callback){
    if(!subscribers.has(tokensCacheKey))subscribers.set(tokensCacheKey,new Set());
    subscribers.get(tokensCacheKey)?.add(callback);
   }
   getHighlighter(resolvedLanguage,resolvedTheme)
    .then(highlighter=>{
     const availableLangs=highlighter.getLoadedLanguages();
     const langToUse=availableLangs.includes(resolvedLanguage)?resolvedLanguage:FALLBACK_CODE_LANGUAGE;
     const result=highlighter.codeToTokens(code,{lang:langToUse,theme:resolvedTheme});
     const tokenized:TokenizedCode={bg:'transparent',fg:result.fg??'inherit',tokens:result.tokens};
     tokensCache.set(tokensCacheKey,tokenized);
     const subs=subscribers.get(tokensCacheKey);
     if(subs){for(const sub of subs)sub(tokenized);}
     subscribers.delete(tokensCacheKey);
    })
    .catch(()=>{/* 高亮失败停留在无高亮 rawTokens 状态，不打断聊天渲染 */});
   return null;
  },
 };
}
