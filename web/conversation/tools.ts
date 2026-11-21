import type { ConversationToolRow } from '../../contracts/conversation.js';
export function summarizeTool(tool:Pick<ConversationToolRow,'tool'|'args'>):{category:string;verb:string;subject:string}{
 const a=tool.args??{},s=(key:string)=>typeof a[key]==='string'?String(a[key]):'';
 switch(tool.tool){
 case 'AskUserQuestion':return {category:'question',verb:'询问用户',subject:Array.isArray(a.questions)?`${a.questions.length} 个问题`:''};
 case 'read_file':return {category:'read',verb:'读取文件',subject:s('path')};
 case 'list_dir':return {category:'read',verb:'浏览目录',subject:s('path')};
 case 'grep_files':return {category:'search',verb:'搜索内容',subject:s('pattern')||s('query')||s('path')};
 case 'bash':return {category:'command',verb:'执行命令',subject:s('description')||s('command').split('\n')[0]||'命令详情按需展开'};
 case 'write_file':return {category:'write',verb:'写入文件',subject:s('path')};
 case 'delete_file':return {category:'write',verb:'删除文件',subject:s('path')};
 case 'write_artifact':return {category:'artifact',verb:'保存产物',subject:s('name')||s('path')};
 case 'read_artifact':return {category:'artifact',verb:'读取产物',subject:s('artifactId')};
 case 'web_fetch':return {category:'web',verb:'抓取网页',subject:s('url')};
 case 'web_search':return {category:'web',verb:'搜索网页',subject:s('query')};
 case 'todo_write':{
  const todos=Array.isArray(a.todos)?a.todos as Array<{content?:unknown;status?:unknown}>:[];
  const active=todos.find(t=>t?.status==='in_progress');
  return {category:'todo',verb:'更新任务清单',subject:typeof active?.content==='string'?active.content:`${todos.length} 项`};
 }
 case 'agent':return {category:'agent',verb:'派出子代理',subject:s('description')||s('prompt').slice(0,80)};
 default:return mcpSummary(tool);
 }
}
/** MCP桥接工具（mcp__<server>__<tool>）：对齐上游 mcp.tsx 的机械拆分与标识格式化；
 * 工具名常重复server前缀，大小写无关去重后首字母大写展示。 */
function mcpSummary(tool:Pick<ConversationToolRow,'tool'|'args'>):{category:string;verb:string;subject:string}{
 const name=tool.tool;
 if(!name.startsWith('mcp__'))return {category:'generic',verb:name,subject:safeString(tool,'description')||safeString(tool,'path')};
 const segments=name.split('__');
 if(segments.length!==3||!segments[1]||!segments[2])return {category:'mcp',verb:'调用 MCP 工具',subject:name};
 const server=formatMcpIdentifier(segments[1]);
 const toolLabel=formatMcpToolLabel(segments[2],server);
 return {category:'mcp',verb:'调用 MCP 工具',subject:`${server} · ${toolLabel}`};
}
function formatMcpIdentifier(value:string):string{
 const words=value.trim().replace(/[-_]+/gu,' ').replace(/\s+/gu,' ');
 if(!words)return value;
 return words[0]!.toLocaleUpperCase()+words.slice(1);
}
function formatMcpToolLabel(toolName:string,serverLabel:string):string{
 const formatted=formatMcpIdentifier(toolName);
 const prefix=`${serverLabel} `;
 return formatted.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
  ?formatMcpIdentifier(formatted.slice(prefix.length))
  :formatted;
}
function safeString(tool:Pick<ConversationToolRow,'args'>,key:string):string{
 const value=(tool.args??{})[key];
 return typeof value==='string'?value:'';
}
export const stateLabel:Record<string,string>={running:'进行中',awaiting_approval:'等待审批',done:'已完成',failed:'失败',cancelled:'已取消',deferred:'已延后，等待处理新补充',unknown:'结果待核对'};
