import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import { createSession } from '../src/auth/sessions.js';
import { brokerWrite, toolWriteArtifact } from '../src/agent/toolExec.js';
import { prepareFileRewind, applyFileRewind, wasFileChangeReverted } from '../src/agent/fileRewind.js';
import { buildContextManifest } from '../src/agent/contextManifest.js';
import type { GrantRow } from '../src/files/picker.js';

async function fixture(t: {after(fn:()=>unknown):unknown}) {
  const dir=mkdtempSync(join(tmpdir(),'prism-deliverables-')), root=join(dir,'project');mkdirSync(root);
  const fx=buildProductApp(dir,{serveWeb:false});await fx.gatewayServer.ready;
  t.after(async()=>{await fx.app.close();rmSync(dir,{recursive:true,force:true});});
  const db=fx.db.db,uid=randomUUID(),pid=randomUUID(),config=randomUUID(),now=new Date().toISOString(),grantId=randomUUID();
  db.prepare("INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,'h','s','{}',0,?,?)").run(uid,uid,now,now);
  db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(pid,uid,'产物验证',now,now);
  db.prepare("INSERT INTO workspace_grants(id,project_id,canonical_root,access,selected_by,excludes_json,created_at,updated_at) VALUES (?,?,?,'write',?,'[]',?,?)").run(grantId,pid,root,uid,now,now);
  db.prepare("INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,api_protocol,revision,enabled,created_at,updated_at) VALUES (?,?,'custom','fixture','https://example.invalid/v1','openai-completions',1,1,?,?)").run(config,uid,now,now);
  db.prepare("INSERT INTO model_entries(id,config_id,model_id,display_name,parameters_json,enabled,created_at,updated_at) VALUES (?,?,'fixture','fixture','{}',1,?,?)").run(randomUUID(),config,now,now);
  const s=createSession(fx.db,uid),headers={cookie:`deb_session=${s.token}`,'x-csrf-token':s.csrf};
  const sessionId=(db.prepare('SELECT id FROM sessions WHERE user_id=?').get(uid) as {id:string}).id;
  fx.supervisor.opts.vault.set(sessionId,config,'synthetic-only',new Date(Date.now()+3600000).toISOString());
  fx.supervisor.startAttempt=(id)=>{db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(id);};
  const create=()=>fx.supervisor.createOrdinaryRun({userId:uid,sessionId,projectId:pid,conversationId:null,objective:'验证',modelConfigId:config,modelId:'fixture'}).runId;
  const runId=create(),grant=db.prepare('SELECT * FROM workspace_grants WHERE id=?').get(grantId) as unknown as GrantRow;
  const write=async(path:string,content:string|null,run=runId)=>{
    const chain=db.prepare('SELECT pt.id AS phase,a.id AS attempt FROM phase_tasks pt JOIN attempts a ON a.phase_task_id=pt.id WHERE pt.run_id=?').get(run) as {phase:string;attempt:string};
    const invocationId=randomUUID();
    db.prepare("INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,canonical_exec_args_json,redacted_args_json,state,effect_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,'v1','h','{}','{}','succeeded','fs_write',?,?)")
      .run(invocationId,run,chain.phase,chain.attempt,invocationId,content===null?'delete_file':'write_file',now,now);
    const full=join(root,path),before=existsSync(full)?readFileSync(full):null;
    return brokerWrite(fx.db,{runId:run,invocationId,dataDir:dir},grant,{operation:content===null?'delete':before===null?'create':'modify',relativePath:path,...(content!==null?{content}:{}),expectedHash:before===null?null:createHash('sha256').update(before).digest('hex')});
  };
  const preview=()=>prepareFileRewind(fx.db,dir,runId).preview;
  const apply=()=>applyFileRewind(fx.db,dir,runId,preview().previewToken);
  return {fx,db,dir,root,uid,runId,grant,headers,write,preview,apply,create};
}

test('产物：文件发布保留二进制、MIME和中文名，下载不可变副本；文本兼容、输入校验与损坏拒绝',async t=>{
  const f=await fixture(t),source=join(f.root,'报告.pdf'),bytes=Buffer.from([0x25,0x50,0x44,0x46,0,0xff,0xfe]);writeFileSync(source,bytes);
  const ctx={runId:f.runId,dataDir:f.dir,producerRole:'ordinary',workspaceRoot:f.root};
  const artifact=await toolWriteArtifact(f.fx.db,ctx,{name:'中文 报告.pdf',path:'报告.pdf'});
  writeFileSync(source,'source changed');
  const download=await f.fx.app.inject({url:`/api/v1/artifacts/${artifact.artifactId}/download`,headers:f.headers});
  assert.equal(download.statusCode,200);assert.deepEqual(download.rawPayload,bytes);assert.match(String(download.headers['content-type']),/application\/pdf/);
  assert.match(String(download.headers['content-disposition']),new RegExp(encodeURIComponent('中文 报告.pdf')));
  const text=await toolWriteArtifact(f.fx.db,ctx,{name:'notes.txt',content:'原始文本'});assert.ok(text.sizeBytes>0);
  await assert.rejects(toolWriteArtifact(f.fx.db,ctx,{name:'bad',content:'x',path:source}),/只能选一个/);
  await assert.rejects(toolWriteArtifact(f.fx.db,ctx,{name:'bad'}),/只能选一个/);
  await assert.rejects(toolWriteArtifact(f.fx.db,ctx,{name:'missing',path:'missing'}),/不存在/);
  await assert.rejects(toolWriteArtifact(f.fx.db,ctx,{name:'directory',path:'.'}),/普通文件/);
  const row=f.db.prepare('SELECT internal_path FROM artifacts WHERE id=?').get(artifact.artifactId) as {internal_path:string};writeFileSync(row.internal_path,'tampered');
  assert.equal((await f.fx.app.inject({url:`/api/v1/artifacts/${artifact.artifactId}/download`,headers:f.headers})).json().error.code,'ARTIFACT_HASH_MISMATCH');
  rmSync(row.internal_path);assert.equal((await f.fx.app.inject({url:`/api/v1/artifacts/${artifact.artifactId}/download`,headers:f.headers})).json().error.code,'ARTIFACT_MISSING');
});

test('回退：同文件连续修改合并为原始内容；新建删除、删除恢复、权限与持久化幂等',async t=>{
  const f=await fixture(t);writeFileSync(join(f.root,'old.txt'),'original');chmodSync(join(f.root,'old.txt'),0o600);writeFileSync(join(f.root,'deleted.txt'),'restore me');
  await f.write('old.txt','middle');await f.write('old.txt','final');await f.write('new.txt','new');await f.write('deleted.txt',null);
  const p=f.preview();assert.equal(p.canApply,true);assert.equal(p.safeFiles.length,3);assert.equal(p.safeFiles.find(x=>x.path==='old.txt')?.operationCount,2);
  const response=await f.fx.app.inject({method:'POST',url:`/api/v1/runs/${f.runId}/file-rewind`,headers:f.headers,payload:{previewToken:p.previewToken}});
  assert.equal(response.statusCode,200,response.body);assert.equal(readFileSync(join(f.root,'old.txt'),'utf8'),'original');assert.equal(statSync(join(f.root,'old.txt')).mode&0o777,0o600);
  assert.equal(existsSync(join(f.root,'new.txt')),false);assert.equal(readFileSync(join(f.root,'deleted.txt'),'utf8'),'restore me');assert.equal(f.preview().reverted,true);
  assert.equal(f.apply().reverted,true);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM change_records WHERE reverted_at IS NOT NULL').get()!.n,4);
  const changes=(await f.fx.app.inject({url:`/api/v1/runs/${f.runId}/changes`,headers:f.headers})).json().data.changes;assert.ok(changes.every((c:{reverted_at:string})=>c.reverted_at));
});

test('回退：外部修改整批拒绝；确认前变化使旧预检失效，未触及其他文件',async t=>{
  const f=await fixture(t);await f.write('a.txt','a');await f.write('b.txt','b');const token=f.preview().previewToken;
  writeFileSync(join(f.root,'a.txt'),'external');assert.equal(f.preview().canApply,false);assert.equal(f.preview().unsafeFiles[0]?.reason,'external_modified');
  assert.throws(()=>applyFileRewind(f.fx.db,f.dir,f.runId,token),/未写入任何文件/);assert.equal(readFileSync(join(f.root,'b.txt'),'utf8'),'b');assert.equal(readFileSync(join(f.root,'a.txt'),'utf8'),'external');
});

test('回退：备份丢失或内容损坏拒绝；新建再删除的空净效果可安全记录',async t=>{
  const f=await fixture(t);writeFileSync(join(f.root,'a.txt'),'before');const record=await f.write('a.txt','after');
  writeFileSync(record.backupPath!,'corrupt');assert.equal(f.preview().unsafeFiles[0]?.reason,'checkpoint_unreadable');assert.throws(()=>f.apply());
  rmSync(record.backupPath!);assert.equal(f.preview().canApply,false);assert.equal(readFileSync(join(f.root,'a.txt'),'utf8'),'after');
  const second=await fixture(t);await second.write('temp.txt','temporary');await second.write('temp.txt',null);assert.equal(second.preview().canApply,true);second.apply();assert.equal(existsSync(join(second.root,'temp.txt')),false);
});

test('回退：后续轮次即使写入相同内容也不能越过，后轮先撤销后可继续',async t=>{
  const f=await fixture(t);await f.write('shared.txt','same');const later=f.create();await f.write('shared.txt','same',later);
  assert.equal(f.preview().unsafeFiles[0]?.reason,'external_modified');
  applyFileRewind(f.fx.db,f.dir,later,prepareFileRewind(f.fx.db,f.dir,later).preview.previewToken);assert.equal(f.preview().canApply,true);f.apply();assert.equal(existsSync(join(f.root,'shared.txt')),false);
});

test('回退：拒绝目录换向、文件软链和已撤销授权；保留其他目录内容',async t=>{
  const f=await fixture(t);await f.write('sub/a.txt','ours');renameSync(join(f.root,'sub'),join(f.root,'saved'));mkdirSync(join(f.root,'other'));writeFileSync(join(f.root,'other/a.txt'),'outsider');symlinkSync(join(f.root,'other'),join(f.root,'sub'));
  assert.equal(f.preview().canApply,false);assert.throws(()=>f.apply());assert.equal(readFileSync(join(f.root,'other/a.txt'),'utf8'),'outsider');
  const g=await fixture(t);await g.write('a.txt','ours');g.db.prepare('UPDATE workspace_grants SET revoked_at=? WHERE id=?').run(new Date().toISOString(),g.grant.id);assert.equal(g.preview().canApply,false);
});

test('回退：写入后数据库失败恢复全部文件并保留可核对记录',async t=>{
  const f=await fixture(t);writeFileSync(join(f.root,'a.txt'),'before');await f.write('a.txt','after');await f.write('new.txt','new');
  f.db.exec("CREATE TRIGGER reject_rewind BEFORE UPDATE OF reverted_at ON change_records BEGIN SELECT RAISE(ABORT,'synthetic db failure'); END;");
  assert.throws(()=>f.apply(),/已恢复本次写入/);assert.equal(readFileSync(join(f.root,'a.txt'),'utf8'),'after');assert.equal(readFileSync(join(f.root,'new.txt'),'utf8'),'new');assert.equal(f.preview().canApply,true);
  f.db.exec('DROP TRIGGER reject_rewind');f.apply();assert.equal(readFileSync(join(f.root,'a.txt'),'utf8'),'before');
});

test('产物与回退API：登录、属主、CSRF和活动任务门禁；命令修改只报告忽略',async t=>{
  const f=await fixture(t);await f.write('a.txt','a');const url=`/api/v1/runs/${f.runId}/file-rewind`,p=f.preview();
  assert.equal((await f.fx.app.inject({url})).statusCode,401);
  assert.equal((await f.fx.app.inject({method:'POST',url,headers:{cookie:f.headers.cookie},payload:{previewToken:p.previewToken}})).statusCode,403);
  const other=randomUUID(),now=new Date().toISOString();f.db.prepare("INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,'h','s','{}',0,?,?)").run(other,other,now,now);
  const s=createSession(f.fx.db,other),headers={cookie:`deb_session=${s.token}`,'x-csrf-token':s.csrf};assert.equal((await f.fx.app.inject({url,headers})).statusCode,404);assert.equal((await f.fx.app.inject({method:'POST',url,headers,payload:{previewToken:p.previewToken}})).statusCode,404);
  const artifact=await toolWriteArtifact(f.fx.db,{runId:f.runId,dataDir:f.dir,producerRole:'ordinary'},{name:'a.txt',content:'private'});
  assert.equal((await f.fx.app.inject({url:`/api/v1/artifacts/${artifact.artifactId}/download`,headers})).statusCode,404);
  f.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(f.runId);assert.equal((await f.fx.app.inject({method:'POST',url,headers:f.headers,payload:{previewToken:p.previewToken}})).statusCode,409);
  f.db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(f.runId);f.db.prepare("UPDATE tool_invocations SET tool_name='bash' WHERE run_id=?").run(f.runId);
  assert.equal(f.preview().ignoredFiles[0]?.reason,'bash_ignored');
});

test('回退后恢复：副作用回放失效、上下文含撤销记录，原消息与产物保留',async t=>{
  const f=await fixture(t),record=await f.write('a.txt','a');
  f.db.prepare('UPDATE tool_invocations SET result_json=? WHERE id=(SELECT invocation_id FROM change_records WHERE id=?)').run(JSON.stringify(record),record.changeRecordId);
  assert.equal(wasFileChangeReverted(f.fx.db,JSON.stringify(record)),false);
  const artifact=await toolWriteArtifact(f.fx.db,{runId:f.runId,dataDir:f.dir,producerRole:'ordinary'},{name:'a.txt',content:'a'});
  const messageCount=f.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(f.runId)!.n;
  f.apply();assert.equal(wasFileChangeReverted(f.fx.db,JSON.stringify(record)),true);
  const conversationId=(f.db.prepare('SELECT conversation_id FROM runs WHERE id=?').get(f.runId) as {conversation_id:string}).conversation_id;
  const manifest=buildContextManifest(f.fx.db,{runId:f.runId,conversationId,grant:f.grant,checkpointFrom:'run'});
  assert.equal(manifest.toolLedger[0]?.ok,false);assert.match(manifest.toolLedger[0]!.summary,/已被用户撤销/);assert.equal(manifest.revertedFiles[0]?.path,'a.txt');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(f.runId)!.n,messageCount);
  assert.equal((await f.fx.app.inject({url:`/api/v1/artifacts/${artifact.artifactId}/download`,headers:f.headers})).statusCode,200);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type='workspace.files_reverted'").get(f.runId)!.n,1);
});
