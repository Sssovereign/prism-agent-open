// ZCode ProjectNodeContent/useProjectTaskActions/view: owner-scoped persistent commands.
import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import type {Db} from '../storage/db.js';
import {ApiError} from '../../contracts/errors.js';
import {ok} from '../http.js';
import type {AuthExtractor} from './routes.js';
import {registerArchiveRoutes} from './archive.js';
const props={title:{type:'string',minLength:1,maxLength:200},pinned:{type:'boolean'},archived:{type:'boolean'},unread:{type:'boolean'},readThrough:{type:'string',format:'date-time'},groupId:{anyOf:[{type:'string',format:'uuid'},{type:'null'}]}};
// ZCode TaskSearchDialog 服务语义：近期任务（空查询）+ 按标题或正文搜索（片段窗口）。
// SNIPPET_LIMIT 给 8：上游客户端搜索时前端按 3 折叠并展示「展开另外 N 个片段」，
// 服务端截断到 8 才能让前端的折叠交互生效（前端仍只显示 3 条）。
const SEARCH_CANDIDATE_LIMIT=200,SEARCH_SNIPPET_LIMIT=8,SEARCH_SCAN_BUDGET=20000;
function messageText(contentJson:string):string{return String((JSON.parse(contentJson) as {text?:string}).text??'');}
function searchSnippets(text:string,query:string):string[]{
  const snippets:string[]=[];
  const lower=text.toLocaleLowerCase(),needle=query.toLocaleLowerCase();
  if(!needle)return snippets;
  let from=0;
  for(;;){
    const at=lower.indexOf(needle,from);
    if(at<0)break;
    const start=Math.max(0,at-40),end=Math.min(text.length,at+needle.length+80);
    const body=text.slice(start,end).replace(/\s+/g,' ').trim();
    const marked=(start>0?'…':'')+body+(end<text.length?'…':'');
    if(!snippets.some(s=>s.toLocaleLowerCase()===marked.toLocaleLowerCase()))snippets.push(marked);
    from=at+needle.length;
    if(snippets.length>=SEARCH_SNIPPET_LIMIT)break;
  }
  return snippets;
}
export function registerSidebarRoutes(app:FastifyInstance,db:Db,auth:AuthExtractor):void{
  registerArchiveRoutes(app,db,auth);
  app.get<{Querystring:{q?:string;limit?:string}}>('/api/v1/tasks/search',{schema:{querystring:{type:'object',additionalProperties:false,properties:{q:{type:'string',maxLength:200},limit:{type:'string',pattern:'^[0-9]{1,3}$'}}}}},async(req,reply)=>{
    const uid=auth(req).userId;
    const query=(req.query.q??'').trim();
    const limit=Math.min(Math.max(Number.parseInt(req.query.limit??'9',10)||9,1),50);
    const tasks=db.db.prepare(`SELECT c.id,c.project_id AS projectId,c.title,c.mode,c.updated_at AS updatedAt,r.id AS runId
      FROM conversations c JOIN projects p ON p.id=c.project_id
      JOIN runs r ON r.id=(SELECT rr.id FROM runs rr WHERE rr.conversation_id=c.id ORDER BY rr.created_at DESC,rr.id DESC LIMIT 1)
      WHERE p.owner_user_id=? AND c.archived_at IS NULL ORDER BY c.updated_at DESC,c.id LIMIT ?`).all(uid,SEARCH_CANDIDATE_LIMIT) as unknown as Array<{id:string;projectId:string;title:string;mode:string;updatedAt:string;runId:string}>;
    if(!query)return ok(req,reply,{items:tasks.slice(0,limit)});
    const byId=new Map(tasks.map(t=>[t.id,t]));
    const snippetsByTask=new Map<string,string[]>();
    // Title match: case-insensitive substring (SQLite LIKE covers ASCII; CJK matching is exact either way).
    for(const task of tasks)if(task.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))snippetsByTask.set(task.id,[]);
    // Content match: case-insensitive prefilter on the serialized text field, verified on extracted text.
    const ids=[...byId.keys()];
    let scanned=0;
    for(let i=0;i<ids.length&&scanned<SEARCH_SCAN_BUDGET;i+=50){
      const chunk=ids.slice(i,i+50),marks=chunk.map(()=>'?').join(',');
      const rows=db.db.prepare(`SELECT m.conversation_id AS conversationId,m.content_json AS contentJson
        FROM messages m WHERE m.conversation_id IN (${marks}) AND m.state='published' AND m.visibility='public' AND m.author_type IN ('user','agent')
        AND instr(LOWER(m.content_json),?)>0 ORDER BY m.conversation_id,m.seq`).all(...chunk,query.toLocaleLowerCase()) as unknown as Array<{conversationId:string;contentJson:string}>;
      for(const row of rows){
        const task=byId.get(row.conversationId);
        if(!task)continue;
        scanned+=1;
        const existing=snippetsByTask.get(task.id)??[];
        if(existing.length>=SEARCH_SNIPPET_LIMIT)continue;
        const merged=[...existing,...searchSnippets(messageText(row.contentJson),query)].slice(0,SEARCH_SNIPPET_LIMIT);
        if(merged.length>existing.length||!snippetsByTask.has(task.id))snippetsByTask.set(task.id,merged);
      }
    }
    const items=tasks.filter(t=>snippetsByTask.has(t.id)).slice(0,limit).map(t=>{const snippets=snippetsByTask.get(t.id)!;return snippets.length?{...t,searchSnippets:snippets}:{...t};});
    return ok(req,reply,{items});
  });
  app.get('/api/v1/sidebar',async(req,reply)=>{
    const uid=auth(req).userId;
    const projects=db.db.prepare(`SELECT p.id,p.name,p.archived_at AS archivedAt,p.pinned_at AS pinnedAt,p.sidebar_position AS position,p.approval_mode AS approvalMode,
      (SELECT g.canonical_root FROM workspace_grants g WHERE g.project_id=p.id AND g.revoked_at IS NULL ORDER BY g.created_at DESC LIMIT 1) AS root
      FROM projects p WHERE owner_user_id=? ORDER BY p.pinned_at IS NULL,p.sidebar_position,p.created_at DESC,p.id`).all(uid) as unknown as Array<Record<string,unknown>>;
    const tasks=db.db.prepare(`SELECT c.id,c.project_id AS projectId,c.title,c.mode,c.pinned_at AS pinnedAt,c.archived_at AS archivedAt,c.unread_at AS unreadAt,c.sidebar_group_id AS groupId,
      c.updated_at AS updatedAt,r.id AS runId,r.status,r.created_at AS createdAt,
      EXISTS(SELECT 1 FROM user_questions q WHERE q.run_id=r.id AND q.state='pending') AS awaitingAnswer
      FROM conversations c JOIN projects p ON p.id=c.project_id
      JOIN runs r ON r.id=(SELECT rr.id FROM runs rr WHERE rr.conversation_id=c.id ORDER BY rr.created_at DESC,rr.id DESC LIMIT 1)
      WHERE p.owner_user_id=? ORDER BY c.pinned_at IS NULL,c.updated_at DESC,c.id`).all(uid);
    const groups=db.db.prepare('SELECT id,name FROM sidebar_groups WHERE owner_user_id=? ORDER BY created_at,id').all(uid);
    // Same path privacy policy as grant views: never return the canonical absolute root.
    return ok(req,reply,{projects:projects.map(({root,...p})=>({...p,folderName:typeof root==='string'?root.split('/').filter(Boolean).at(-1)||'本地文件夹':null})),tasks,groups});
  });
  app.patch<{Params:{id:string};Body:{title?:string;pinned?:boolean;archived?:boolean;unread?:boolean;readThrough?:string;groupId?:string|null}}>('/api/v1/conversations/:id',{schema:{body:{type:'object',minProperties:1,additionalProperties:false,properties:props}}},async(req,reply)=>{
    const uid=auth(req).userId;
    const c=db.db.prepare('SELECT c.* FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=? AND p.owner_user_id=?').get(req.params.id,uid) as Record<string,unknown>|undefined;
    if(!c)throw new ApiError('NOT_FOUND','对象不存在或无权访问');
    const b=req.body,now=new Date().toISOString();
    if(b.readThrough!==undefined&&b.unread!==false)throw new ApiError('VALIDATION_FAILED','readThrough仅用于标为已读');
    if(b.archived && db.db.prepare("SELECT id FROM runs WHERE conversation_id=? AND status NOT IN ('succeeded','failed','cancelled') LIMIT 1").get(req.params.id))throw new ApiError('RESOURCE_BUSY','请先停止这个任务，再归档');
    if(b.groupId && !db.db.prepare('SELECT id FROM sidebar_groups WHERE id=? AND owner_user_id=?').get(b.groupId,uid))throw new ApiError('NOT_FOUND','分组不存在或无权访问');
    const title=b.title?.trim()??String(c.title);
    if(!title)throw new ApiError('VALIDATION_FAILED','任务名称不能为空');
    const setTime=(value:boolean|undefined,old:unknown)=>value===undefined?old:value?old??now:null;
    // A delayed read acknowledgement must not clear a newer result notification.
    const unreadAt=b.unread===false&&b.readThrough!==undefined&&c.unread_at!==b.readThrough?c.unread_at:setTime(b.unread,c.unread_at);
    db.db.prepare('UPDATE conversations SET title=?,pinned_at=?,archived_at=?,unread_at=?,sidebar_group_id=? WHERE id=?')
      .run(title,setTime(b.pinned,c.pinned_at) as string|null,setTime(b.archived,c.archived_at) as string|null,unreadAt as string|null,b.groupId===undefined?c.sidebar_group_id as string|null:b.groupId,req.params.id);
    return ok(req,reply,{id:req.params.id});
  });
  app.post<{Body:{name:string}}>('/api/v1/sidebar-groups',{schema:{body:{type:'object',required:['name'],additionalProperties:false,properties:{name:{type:'string',minLength:1,maxLength:120}}}}},async(req,reply)=>{
    const name=req.body.name.trim();if(!name)throw new ApiError('VALIDATION_FAILED','分组名不能为空');
    const id=randomUUID(),now=new Date().toISOString();
    db.db.prepare('INSERT INTO sidebar_groups(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(id,auth(req).userId,name,now,now);
    return ok(req,reply,{id,name},201);
  });
  app.patch<{Params:{id:string};Body:{name:string}}>('/api/v1/sidebar-groups/:id',{schema:{body:{type:'object',required:['name'],additionalProperties:false,properties:{name:{type:'string',minLength:1,maxLength:120}}}}},async(req,reply)=>{
    const name=req.body.name.trim();if(!name)throw new ApiError('VALIDATION_FAILED','分组名不能为空');
    if(!db.db.prepare('UPDATE sidebar_groups SET name=?,updated_at=? WHERE id=? AND owner_user_id=?').run(name,new Date().toISOString(),req.params.id,auth(req).userId).changes)throw new ApiError('NOT_FOUND','分组不存在或无权访问');
    return ok(req,reply,{id:req.params.id,name});
  });
  app.delete<{Params:{id:string}}>('/api/v1/sidebar-groups/:id',async(req,reply)=>{
    if(!db.db.prepare('DELETE FROM sidebar_groups WHERE id=? AND owner_user_id=?').run(req.params.id,auth(req).userId).changes)throw new ApiError('NOT_FOUND','分组不存在或无权访问');
    return ok(req,reply,{removed:true});
  });
  app.patch<{Body:{projectIds:string[]}}>('/api/v1/sidebar/project-order',{schema:{body:{type:'object',required:['projectIds'],additionalProperties:false,properties:{projectIds:{type:'array',uniqueItems:true,maxItems:1000,items:{type:'string',format:'uuid'}}}}}},async(req,reply)=>{
    const uid=auth(req).userId;
    for(const id of req.body.projectIds)if(!db.db.prepare('SELECT id FROM projects WHERE id=? AND owner_user_id=?').get(id,uid))throw new ApiError('NOT_FOUND','项目不存在或无权访问');
    db.tx(tx=>req.body.projectIds.forEach((id,i)=>tx.prepare('UPDATE projects SET sidebar_position=? WHERE id=? AND owner_user_id=?').run(i,id,uid)));
    return ok(req,reply,{saved:true});
  });
}
