// 仅创建可丢弃的下载验收资料；不启动模型请求或读取正式数据。
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const [workspaceArg,dataArg,outArg]=process.argv.slice(2),workspace=resolve(workspaceArg),data=resolve(dataArg);
if(!data.replaceAll('\\','/').includes('/.cache/verification/'))throw new Error('验收数据必须隔离');
const moduleAt=file=>import(pathToFileURL(join(workspace,file)).href);
const {buildProductApp}=await moduleAt('dist/src/app.js');
const {toolWriteArtifact}=await moduleAt('dist/src/agent/toolExec.js');
const {saveUpload}=await moduleAt('dist/src/files/broker.js');
const {saveAttachment}=await moduleAt('dist/src/agent/attachments.js');
const fx=buildProductApp(data,{serveWeb:false});
try{
 await fx.gatewayServer.ready;
 const user=await fx.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{username:'flow-user',password:'1',confirmation:'1',remember:true}});
 assert.equal(user.statusCode,201,user.body);const uid=user.json().data.user.id;
 const session=fx.db.db.prepare('SELECT id,expires_at FROM sessions WHERE user_id=?').get(uid),now=new Date().toISOString();
 const pid=randomUUID(),config=randomUUID(),project=join(data,'fixture-project');mkdirSync(project,{recursive:true});
 const db=fx.db.db;
 db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(pid,uid,'下载验收',now,now);
 db.prepare("INSERT INTO workspace_grants(id,project_id,canonical_root,access,selected_by,excludes_json,created_at,updated_at) VALUES (?,?,?,'write',?,'[]',?,?)").run(randomUUID(),pid,project,uid,now,now);
 db.prepare("INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,api_protocol,revision,enabled,created_at,updated_at) VALUES (?,?,'custom','合成验收','https://example.invalid/v1','openai-completions',1,1,?,?)").run(config,uid,now,now);
 db.prepare("INSERT INTO model_entries(id,config_id,model_id,display_name,parameters_json,enabled,created_at,updated_at) VALUES (?,?,'fixture','fixture','{}',1,?,?)").run(randomUUID(),config,now,now);
 fx.supervisor.opts.vault.set(session.id,config,'synthetic-only',session.expires_at);
 fx.supervisor.startAttempt=(run,id)=>{db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run);db.prepare("UPDATE attempts SET status='running' WHERE id=?").run(id);db.prepare("UPDATE phase_tasks SET status='running' WHERE active_attempt_id=?").run(id);};
 const ordinary=fx.supervisor.createOrdinaryRun({userId:uid,sessionId:session.id,projectId:pid,conversationId:null,objective:'下载功能验收',modelConfigId:config,modelId:'fixture'});
 const bytes=Buffer.from([0x25,0x50,0x44,0x46,0,0xff,0xfe,0x0a]);
 writeFileSync(join(project,'报告.pdf'),bytes);
 const ctx={runId:ordinary.runId,dataDir:data,producerRole:'ordinary',workspaceRoot:project};
 const binary=await toolWriteArtifact(fx.db,ctx,{name:'中文 报告.pdf',path:'报告.pdf'});
 const text=await toolWriteArtifact(fx.db,ctx,{name:'文本 报告.txt',content:'原始文本\nHello 🙂\n'});
 const phase=db.prepare('SELECT pt.id AS phase,a.id AS attempt FROM phase_tasks pt JOIN attempts a ON a.phase_task_id=pt.id WHERE pt.run_id=?').get(ordinary.runId);
 const invocation=randomUUID(),toolJson=JSON.stringify({text:'完整工具结果\n🙂',truncated:false});
 db.prepare("INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,canonical_exec_args_json,redacted_args_json,state,effect_kind,result_json,created_at,updated_at) VALUES (?,?,?,?,?,'read_file','v1','h','{}','{}','succeeded','fs_read',?,?,?)").run(invocation,ordinary.runId,phase.phase,phase.attempt,invocation,toolJson,now,now);
 db.prepare("INSERT INTO messages(id,conversation_id,run_id,author_type,role_id,seq,visibility,state,content_json,created_at,updated_at) VALUES (?,?,?,'agent','ordinary',2,'public','published',?,?,?)").run(randomUUID(),ordinary.conversationId,ordinary.runId,JSON.stringify({text:'合成下载资料已准备。',artifactIds:[binary.artifactId,text.artifactId]}),now,now);
 db.prepare('UPDATE conversations SET last_message_seq=2 WHERE id=?').run(ordinary.conversationId);
 const resourceBytes=Buffer.from('列A,列B\n1,2\n'),resource=await saveUpload(fx.db,data,pid,'表 格.csv',resourceBytes);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=','base64');
 const attachment=saveAttachment(fx.db,data,uid,'验收截图.png',png);
 const choice={modelConfigId:config,modelId:'fixture'};
 const research=fx.supervisor.research.create({userId:uid,sessionId:session.id,projectId:pid,mode:'jury',objective:'下载研究记录验收',models:{juror1:choice,juror2:choice,juror3:choice,aggregate:choice},sources:[{title:'合成资料',content:'固定原文'}]});
 for(let i=0;i<4;i++){
  const attempt=db.prepare("SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id=? AND a.status='running'").get(research.runId);
  const context=fx.supervisor.research.context(attempt.id);
  fx.supervisor.research.complete(attempt.id,JSON.stringify({text:'合成分析',claims:[],limitations:['仅下载验收'],...(context.phase.role==='juror'?{verdict:'insufficient'}:{})}));
  fx.supervisor.research.launchNext(research.runId,session.id);
 }
 for(const table of ['runs','attempts','phase_tasks']) db.prepare(`UPDATE ${table} SET status='succeeded' WHERE status NOT IN ('succeeded','failed','cancelled')`).run();
 const digest=b=>createHash('sha256').update(b).digest('hex');
 const entries=[
  {kind:'项目附件',url:`/api/v1/projects/${pid}/resources/${resource.resourceId}/versions/${resource.version}?view=download`,name:'表 格.csv',sha256:digest(resourceBytes)},
  {kind:'原图附件',url:`/api/v1/attachments/${attachment.id}/raw`,name:'验收截图.png',sha256:digest(png)},
  {kind:'生成PDF',url:`/api/v1/artifacts/${binary.artifactId}/download`,name:'中文 报告.pdf',sha256:digest(bytes)},
  {kind:'生成文本',url:`/api/v1/artifacts/${text.artifactId}/download`,name:'文本 报告.txt',sha256:digest(Buffer.from('原始文本\nHello 🙂\n'))},
  {kind:'完整工具结果',url:`/api/v1/runs/${ordinary.runId}/conversation/tools/${invocation}/result/download`,name:'tool-result.json',sha256:digest(Buffer.from(toolJson))},
  {kind:'研究导出',url:`/api/v1/runs/${research.runId}/research/export`,name:`research-${research.runId}.json`}
 ];
 writeFileSync(outArg,JSON.stringify({ordinary, research, entries},null,2)+'\n');
}finally{await fx.app.close();}
