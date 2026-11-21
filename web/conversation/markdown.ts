import MarkdownIt from 'markdown-it';
import { normalizeMessageSingleDollarMath } from './mathText.js';
const parser = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
// 块E1：KaTeX 数学定界（$…$ / $$…$$）。归一化先行（isLikelySingleDollarMath 启发式），
// 规则只消费"像数学"的成对定界符；围栏与行内代码内的 $ 由既有规则先行消费，不受影响。
function mathInlineRule(state:any,silent:boolean):boolean{
 const src=state.src,pos=state.pos;
 if(src[pos]!=='$'||src[pos+1]==='$')return false;
 let end=pos+1,found=-1;
 while(end<src.length){if(src[end]==='\\'){end+=2;continue;}if(src[end]==='$'){found=end;break;}end++;}
 if(found===-1)return false;
 const content=src.slice(pos+1,found);
 if(!content.trim())return false;
 if(!silent){const token=state.push('math_inline','math',0);token.content=content;token.markup='$';}
 state.pos=found+1;
 return true;
}
function mathBlockRule(state:any,startLine:number,endLine:number,silent:boolean):boolean{
 const startPos=state.bMarks[startLine]+state.tShift[startLine];
 const lineText=state.src.slice(startPos,state.eMarks[startLine]);
 const trimmed=lineText.trimStart();
 if(!trimmed.startsWith('$$'))return false;
 const openOffset=startPos+(lineText.length-trimmed.length);
 const closing=state.src.indexOf('$$',openOffset+2);
 if(closing===-1)return false;
 if(!silent){
  const content=state.src.slice(openOffset+2,closing);
  const token=state.push('math_block','math',0);
  token.block=true;token.content=content.replace(/^\n/,'').replace(/\n$/,'');token.markup='$$';
  const after=state.src.slice(closing+2);
  const nl=after.indexOf('\n');
  const endPos=closing+2+(nl===-1?after.length:nl+1);
  let line=startLine;
  while(line<endLine&&state.bMarks[line]<endPos)line++;
  token.map=[startLine,line];
  state.line=line;
 }
 return true;
}
parser.inline.ruler.before('escape','math_inline',mathInlineRule);
parser.block.ruler.before('paragraph','math_block',mathBlockRule);
/** No HTML passthrough, no image/network loads, no plugin-controlled attributes. */
export function safeHref(raw: string): string | undefined {
 const value=raw.trim();
 if(/[\u0000-\u0020\u007f]/.test(value)||value.startsWith('//')||value.includes('\\'))return;
 if(/^(https?:|mailto:)/i.test(value)||value.startsWith('#')||(/^\/(?!\/)/.test(value)))return value;
}
export interface MarkdownNode { tag?: string; text?: string; attrs?: Record<string,string>; children?: MarkdownNode[] }
const tags=new Set(['p','h1','h2','h3','h4','h5','h6','blockquote','ul','ol','li','strong','em','s','table','thead','tbody','tr','th','td','a']);
export function parseMarkdown(text:string):MarkdownNode[]{
 const root:MarkdownNode[]=[];const stack:MarkdownNode[][]=[root];
 function walk(tokens:ReturnType<typeof parser.parse>){for(const token of tokens){
  const target=()=>stack.at(-1)!;
  if(token.type==='inline'){walk(token.children??[]);continue;}
  if(token.type==='fence'||token.type==='code_block'){const langAttrs=token.info?{'data-language':token.info.trim().split(/\s/)[0]!.slice(0,40)}:undefined;target().push({tag:'pre',attrs:langAttrs,children:[{tag:'code',text:token.content,attrs:langAttrs}]});continue;}
  if(token.type==='code_inline'){target().push({tag:'code',text:token.content});continue;}
  if(token.type==='math_inline'){target().push({tag:'math',text:token.content});continue;}
  if(token.type==='math_block'){target().push({tag:'math-block',text:token.content});continue;}
  if(token.type==='image'){target().push({text:`[图片：${token.content||'未加载'}]`});continue;}
  if(token.type==='softbreak'){target().push({text:'\n'});continue;}
  if(token.type==='hardbreak'||token.type==='hr'){target().push({tag:token.type==='hr'?'hr':'br'});continue;}
  if(token.nesting===1){const node:MarkdownNode={tag:tags.has(token.tag)?token.tag:'span',children:[]};
   if(token.tag==='a'){const href=safeHref(String(token.attrGet('href')??''));node.attrs=href?{href,rel:'noopener noreferrer',target:'_blank'}:undefined; if(!href)node.tag='span';}
   if(token.tag==='ol'&&/^\d+$/.test(String(token.attrGet('start')??'')))node.attrs={start:String(token.attrGet('start')??'')};
   target().push(node);stack.push(node.children!);
  }else if(token.nesting===-1){if(stack.length>1)stack.pop();}
  else target().push({text:token.content});
 }}
 walk(parser.parse(normalizeMessageSingleDollarMath(text),{}));return root;
}
