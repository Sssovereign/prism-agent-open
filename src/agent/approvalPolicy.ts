import type {ApprovalMode} from '../../contracts/permissions.js';
import type {ToolSpec} from './toolExec.js';
/** Trusted supervisor decision; no mode supplied by the worker is accepted. */
export function requiresApproval(mode:ApprovalMode,spec:ToolSpec,args:Record<string,unknown>):boolean{
 if(spec.effect==='read'||spec.name==='read_artifact')return false;
 // 内嵌浏览器：无凭据专用会话+双层出网守卫+宿主隐藏面板承载；ask模式仅对点击/填写确认，auto/full不打断
 if(spec.effect==='browser')return mode==='ask'&&spec.highImpact(args);
 // 持久记忆库：产品自有数据区内钉死路径的读写——写入不询问（对齐ZCode），删除须确认；full信任用户明示授权不询问
 if(spec.effect==='memory')return mode!=='full'&&(spec.name==='memory_delete'||mode==='ask');
 // MCP外部副作用工具：未知副作用按D49先核对——auto/ask逐次询问，full信任用户明示授权不询问
 if(spec.effect==='external')return mode!=='full';
 if(mode==='ask')return true;
 if(mode==='full')return false;
 return spec.name==='delete_file'||spec.highImpact(args);
}
