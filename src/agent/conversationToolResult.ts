import { Readable } from 'node:stream';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
const allowed=new Set(['read_file','read_image','list_dir','grep_files','bash','write_file','delete_file','write_artifact','read_artifact','AskUserQuestion']);
export const RESULT_PAGE_SIZE=16384;
/** Read only persisted tool JSON. Never interpret a model-supplied path or open original files. */
export function storedToolResult(db:Db,runId:string,invocationId:string,userId:string){
 const row=db.db.prepare(`SELECT ti.id,ti.tool_name AS tool,ti.result_json IS NOT NULL AS available,
 length(ti.result_json) AS total,json_valid(ti.result_json) AS valid,
 CASE WHEN json_valid(ti.result_json) THEN json_extract(ti.result_json,'$.truncated') END AS truncated
 FROM tool_invocations ti JOIN runs r ON r.id=ti.run_id JOIN projects p ON p.id=r.project_id
 JOIN runs selected ON selected.conversation_id=r.conversation_id
 WHERE selected.id=? AND ti.id=? AND p.owner_user_id=?`).get(runId,invocationId,userId) as {id:string;tool:string;available:number;total:number|null;valid:number;truncated:unknown}|undefined;
 if(!row||!allowed.has(row.tool))throw new ApiError('NOT_FOUND','工具结果不存在或无权访问');
 return {invocationId:row.id,tool:row.tool,available:!!row.available,total:row.total??0,sourceTruncated:row.truncated===1,format:'json' as const};
}
export function toolResultPage(db:Db,runId:string,invocationId:string,userId:string,offset:number,limit=RESULT_PAGE_SIZE){
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>RESULT_PAGE_SIZE)throw new ApiError('VALIDATION_FAILED','工具结果分页参数无效');
 const meta=storedToolResult(db,runId,invocationId,userId);
 if(offset>meta.total)throw new ApiError('VALIDATION_FAILED','工具结果游标超出范围');
 const row=db.db.prepare('SELECT substr(result_json,?,?) AS text FROM tool_invocations WHERE id=?').get(offset+1,limit,invocationId) as {text:string|null};
 const next=Math.min(meta.total,offset+limit);
 return {...meta,offset,text:row.text??'',nextOffset:next<meta.total?next:null,hasMore:next<meta.total};
}
export function toolResultDownload(db:Db,runId:string,invocationId:string,userId:string){
 const meta=storedToolResult(db,runId,invocationId,userId);
 // SQLite substr counts Unicode code points, so astral characters are never split across chunks.
 function* chunks(){for(let offset=0;offset<meta.total;offset+=RESULT_PAGE_SIZE){yield toolResultPage(db,runId,invocationId,userId,offset).text;}}
 return {meta,stream:Readable.from(chunks())};
}
