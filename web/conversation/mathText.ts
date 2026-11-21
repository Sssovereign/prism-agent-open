/**
 * 单美元行内公式归一化（块E1）：按 ZCode message.tsx 的 normalizeMessageSingleDollarMath
 * 语义移植（React→纯函数）。开启 `$…$` 行内公式后，`$5 … $10`、`$HOME … $PATH`
 * 这类普通文本会被误当成公式——仅当内容"像数学"时保留定界符，否则转义当前 `$`
 * 让扫描继续。代码围栏与行内代码内的 `$` 一律不动。
 */

const markdownFencePattern = /^(?: {0,3})(`{3,}|~{3,})/;
const likelyMathSyntaxPattern = /[\\{}^_=+\-*/<>|()[\]∇∂∫∑√∞≈≠≤≥±×÷πΠα-ωΑ-Ω]/u;
const texCommandPattern = /\\[A-Za-z]+/;
const simpleMathIdentifierPattern = /^(?:[A-Za-z]|[a-z][A-Za-z0-9]{1,2}|\d+(?:\.\d+)?)$/;
const compactCurrencyRangePrefixPattern = /^(?:\d[\d,]*(?:\.\d+)?|\.\d+)[+\-*/]$/;
const compactCurrencyAmountStartPattern = /^(?:\d|\.\d)/;

function getMarkdownFence(line:string):{marker:string;length:number}|null{
 const match=markdownFencePattern.exec(line);
 if(!match)return null;
 const sequence=match[1]??'';
 return {marker:sequence[0]??'',length:sequence.length};
}
function isEscapedMarkdownCharacter(text:string,index:number):boolean{
 let slashCount=0;
 for(let cursor=index-1;cursor>=0&&text[cursor]==='\\';cursor--)slashCount++;
 return slashCount%2===1;
}
function isSingleDollarDelimiter(text:string,index:number):boolean{
 return text[index]==='$'&&text[index-1]!=='$'&&text[index+1]!=='$'&&!isEscapedMarkdownCharacter(text,index);
}
function findClosingSingleDollarDelimiter(text:string,startIndex:number):number{
 for(let index=startIndex;index<text.length;index++){if(isSingleDollarDelimiter(text,index))return index;}
 return -1;
}
export function isLikelySingleDollarMath(content:string):boolean{
 if(!content||content!==content.trim()||/[\r\n]/.test(content))return false;
 if(texCommandPattern.test(content)||likelyMathSyntaxPattern.test(content))return true;
 if(!/\s/.test(content)&&simpleMathIdentifierPattern.test(content))return true;
 return false;
}
function isLikelyCompactCurrencyRangeText(text:string,closingIndex:number,content:string):boolean{
 if(!compactCurrencyRangePrefixPattern.test(content))return false;
 return compactCurrencyAmountStartPattern.test(text.slice(closingIndex+1));
}
function normalizeSingleDollarMathInText(text:string):string{
 if(!text.includes('$'))return text;
 let output='';
 for(let index=0;index<text.length;index++){
  if(!isSingleDollarDelimiter(text,index)){output+=text[index];continue;}
  const closingIndex=findClosingSingleDollarDelimiter(text,index+1);
  if(closingIndex===-1){output+=text[index];continue;}
  const content=text.slice(index+1,closingIndex);
  if(isLikelyCompactCurrencyRangeText(text,closingIndex,content)){output+='\\$';continue;}
  if(isLikelySingleDollarMath(content)){output+=text.slice(index,closingIndex+1);index=closingIndex;continue;}
  output+='\\$';
 }
 return output;
}
function normalizeSingleDollarMathOutsideInlineCode(line:string):string{
 let output='';let cursor=0;
 while(cursor<line.length){
  const codeStart=line.indexOf('`',cursor);
  if(codeStart===-1){output+=normalizeSingleDollarMathInText(line.slice(cursor));break;}
  output+=normalizeSingleDollarMathInText(line.slice(cursor,codeStart));
  let codeFenceEnd=codeStart+1;
  while(line[codeFenceEnd]==='`')codeFenceEnd++;
  const codeMarker=line.slice(codeStart,codeFenceEnd);
  const codeEnd=line.indexOf(codeMarker,codeFenceEnd);
  if(codeEnd===-1){output+=normalizeSingleDollarMathInText(line.slice(codeStart));break;}
  output+=line.slice(codeStart,codeEnd+codeMarker.length);
  cursor=codeEnd+codeMarker.length;
 }
 return output;
}
/** 进入 markdown 解析前调用：围栏外的裸 `$…$` 按"像数学"启发式保留或转义。 */
export function normalizeMessageSingleDollarMath(markdown:string):string{
 if(!markdown.includes('$'))return markdown;
 let output='';let cursor=0;let activeFence:{marker:string;length:number}|null=null;
 while(cursor<markdown.length){
  const newlineIndex=markdown.indexOf('\n',cursor);
  const lineEnd=newlineIndex===-1?markdown.length:newlineIndex;
  const line=markdown.slice(cursor,lineEnd);
  const newline=newlineIndex===-1?'':'\n';
  const fence=getMarkdownFence(line);
  if(activeFence){
   output+=line+newline;
   if(fence&&fence.marker===activeFence.marker&&fence.length>=activeFence.length)activeFence=null;
  }else{
   output+=normalizeSingleDollarMathOutsideInlineCode(line)+newline;
   if(fence)activeFence=fence;
  }
  cursor=lineEnd+1;
 }
 return output;
}
