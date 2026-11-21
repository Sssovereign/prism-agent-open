/**
 * Mermaid 语言识别与自动渲染预算（块E1）：按 ZCode mermaidLanguage.ts /
 * mermaidRenderBudget.ts 语义移植。预算门禁必须在进入 Mermaid render 之前——
 * 大源码的 SVG 构造无法事后取消。
 */

export function isMermaidLanguage(language:string):boolean{
 const normalized=language.trim().toLowerCase();
 return normalized==='mermaid'||normalized==='mmd';
}

const MERMAID_AUTODETECT_LANGUAGES=new Set(['','text','txt','plain']);
const MERMAID_LEADING_DIRECTIVE_PATTERN=/^---[\s\S]*?---\s*/;
const MERMAID_DIAGRAM_START_PATTERN=
 /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|sankey-beta|xychart-beta|block-beta|packet-beta|architecture-beta|c4(?:Context|Container|Component|Dynamic|Deployment))/i;

export function isLikelyMermaidCode(code:string):boolean{
 const firstMeaningfulLine=code
  .trim()
  .replace(MERMAID_LEADING_DIRECTIVE_PATTERN,'')
  .split(/\r?\n/)
  .find(line=>line.trim().length>0);
 return firstMeaningfulLine?MERMAID_DIAGRAM_START_PATTERN.test(firstMeaningfulLine.trim()):false;
}

export function shouldRenderMermaidCodeBlock(language:string,code:string):boolean{
 const normalizedLanguage=language.trim().toLowerCase();
 if(isMermaidLanguage(normalizedLanguage))return true;
 // 模型经常输出未标注语言的 Mermaid 围栏块；只在纯文本/空语言做窄首行识别，
 // 显式 ts/js/sh 等普通代码不误染成图表。
 return MERMAID_AUTODETECT_LANGUAGES.has(normalizedLanguage)&&isLikelyMermaidCode(code);
}

export const MERMAID_AUTO_RENDER_MAX_SOURCE_CHARS=20_000;
export const MERMAID_AUTO_RENDER_MAX_LINES=600;
export const MERMAID_AUTO_RENDER_MAX_COMPLEXITY_SCORE=1_500;

export type MermaidDocumentVisibilityState='visible'|'hidden'|'prerender'|'unloaded'|'unknown';
export type MermaidAutoRenderSkipReason='document-hidden'|'source-too-large'|'line-count-too-large'|'complexity-too-large';
export interface MermaidAutoRenderMetrics{sourceChars:number;lineCount:number;edgeLikeTokenCount:number;nodeLikeTokenCount:number;complexityScore:number}
export type MermaidAutoRenderDecision={shouldRender:true;metrics:MermaidAutoRenderMetrics}|{shouldRender:false;reason:MermaidAutoRenderSkipReason;metrics:MermaidAutoRenderMetrics};

const MERMAID_EDGE_TOKEN_PATTERN=/(?:<-->|<--|-->|---|-\.->|==>|--x|--o|x--|o--)/gu;
const MERMAID_NODE_TOKEN_PATTERN=/(?:^|\n)\s*[A-Za-z][\w-]*(?:\[[^\]\n]{0,200}\]|\([^)\n]{0,200}\)|\{[^}\n]{0,200}\})/gu;

function countPatternMatches(value:string,pattern:RegExp):number{
 pattern.lastIndex=0;let count=0;
 while(pattern.exec(value))count+=1;
 return count;
}
function countLines(value:string):number{
 if(!value)return 0;
 let lineCount=1;
 for(let index=0;index<value.length;index+=1){if(value.charCodeAt(index)===10)lineCount+=1;}
 return lineCount;
}
function measureMermaidSource(source:string):MermaidAutoRenderMetrics{
 const sourceChars=source.length,lineCount=countLines(source);
 const edgeLikeTokenCount=countPatternMatches(source,MERMAID_EDGE_TOKEN_PATTERN);
 const nodeLikeTokenCount=countPatternMatches(source,MERMAID_NODE_TOKEN_PATTERN);
 return {sourceChars,lineCount,edgeLikeTokenCount,nodeLikeTokenCount,complexityScore:lineCount+edgeLikeTokenCount+nodeLikeTokenCount};
}
export function getCurrentMermaidDocumentVisibility():MermaidDocumentVisibilityState{
 if(typeof document==='undefined')return 'visible';
 const visibilityState=document.visibilityState as MermaidDocumentVisibilityState|undefined;
 if(visibilityState==='visible'||visibilityState==='hidden'||visibilityState==='prerender'||visibilityState==='unloaded')return visibilityState;
 return document.hidden?'hidden':'visible';
}
export function resolveMermaidAutoRenderDecision(
 source:string,
 options:{documentVisibilityState?:MermaidDocumentVisibilityState;maxSourceChars?:number;maxLines?:number;maxComplexityScore?:number}={},
):MermaidAutoRenderDecision{
 const metrics=measureMermaidSource(source);
 const documentVisibilityState=options.documentVisibilityState??'visible';
 const maxSourceChars=options.maxSourceChars??MERMAID_AUTO_RENDER_MAX_SOURCE_CHARS;
 const maxLines=options.maxLines??MERMAID_AUTO_RENDER_MAX_LINES;
 const maxComplexityScore=options.maxComplexityScore??MERMAID_AUTO_RENDER_MAX_COMPLEXITY_SCORE;
 if(documentVisibilityState!=='visible'&&documentVisibilityState!=='unknown')return {shouldRender:false,reason:'document-hidden',metrics};
 if(metrics.sourceChars>maxSourceChars)return {shouldRender:false,reason:'source-too-large',metrics};
 if(metrics.lineCount>maxLines)return {shouldRender:false,reason:'line-count-too-large',metrics};
 if(metrics.complexityScore>maxComplexityScore)return {shouldRender:false,reason:'complexity-too-large',metrics};
 return {shouldRender:true,metrics};
}
