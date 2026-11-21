import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {buildProductApp} from '../src/app.js';
import {createSession} from '../src/auth/sessions.js';
import {cloneConversation} from '../src/agent/conversationFork.js';
import {buildContextManifest} from '../src/agent/contextManifest.js';
import {readConversationWindow} from '../src/agent/conversationProjection.js';
import {deleteArchivedConversation} from '../src/projects/archive.js';
import {appendPromptHistoryEntry,navigatePromptHistory,readPromptHistoryEntries,persistPromptHistoryEntries} from '../web/conversation/promptHistory.js';

async function fixture(t:{after(fn:()=>unknown):unknown}){
 const dir=mkdtempSync(join(tmpdir(),'prism-fork-')),fx=buildProductApp(dir,{serveWeb:false});
 t.after(async()=>{await fx.app.close();rmSync(dir,{recursive:true,force:true});});
 await fx.gatewayServer.ready;
 const db=fx.db.db,uid=randomUUID(),pid=randomUUID(),config=randomUUID(),now=new Date().toISOString(),root=join(dir,'project');mkdirSync(root);
 db.prepare("INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,'h','s','{}',0,?,?)").run(uid,uid,now,now);
 db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(pid,uid,'分叉测试',now,now);
 const grantId=randomUUID();db.prepare("INSERT INTO workspace_grants(id,project_id,canonical_root,access,selected_by,excludes_json,created_at,updated_at) VALUES (?,?,?,'write',?,'[]',?,?)").run(grantId,pid,root,uid,now,now);
 db.prepare("INSERT INTO model_configs(id,owner_user_id,preset,name,base_url,api_protocol,revision,enabled,created_at,updated_at) VALUES (?,?,'custom','fixture','https://example.invalid/v1','openai-completions',1,1,?,?)").run(config,uid,now,now);
 db.prepare("INSERT INTO model_entries(id,config_id,model_id,display_name,parameters_json,enabled,created_at,updated_at) VALUES (?,?,'fixture','fixture','{}',1,?,?)").run(randomUUID(),config,now,now);
 createSession(fx.db,uid);
 const session=(db.prepare('SELECT id FROM sessions WHERE user_id=?').get(uid) as {id:string}).id;
 fx.supervisor.opts.vault.set(session,config,'synthetic-only',new Date(Date.now()+3600000).toISOString());
 const observed:Array<ReturnType<typeof buildContextManifest>>=[];
 fx.supervisor.startAttempt=(runId)=>{
  const r=db.prepare('SELECT conversation_id FROM runs WHERE id=?').get(runId) as {conversation_id:string};
  const grant=db.prepare('SELECT * FROM workspace_grants WHERE id=?').get(grantId) as never;
  observed.push(buildContextManifest(fx.db,{runId,conversationId:r.conversation_id,grant,checkpointFrom:'conversation'}));
  db.prepare("UPDATE runs SET status='succeeded',ended_at=? WHERE id=?").run(now,runId);
 };
 const create=(objective:string,conversationId:string|null=null)=>fx.supervisor.createOrdinaryRun({userId:uid,sessionId:session,projectId:pid,conversationId,objective,modelConfigId:config,modelId:'fixture'});
 const original=create('原始目标');
 const target=db.prepare('SELECT id FROM messages WHERE run_id=?').get(original.runId) as {id:string};
 const replyId=randomUUID();db.prepare("INSERT INTO messages(id,conversation_id,run_id,author_type,role_id,seq,visibility,state,content_json,created_at,updated_at) VALUES (?,?,?,'agent','ordinary',2,'public','published',?,?,?)").run(replyId,original.conversationId,original.runId,JSON.stringify({text:'原始答复'}),now,now);
 db.prepare('UPDATE conversations SET last_message_seq=2 WHERE id=?').run(original.conversationId);
 return{fx,db,uid,pid,config,session,root,create,original,target,replyId,observed};
}

test('分叉保留可见历史、独立归属、已消费标记；删除原归档后分支仍可读取',async t=>{
 const f=await fixture(t),branch=cloneConversation(f.fx.db,f.uid,f.original.conversationId,f.replyId,'through');
 assert.ok(branch.runId);assert.notEqual(branch.conversationId,f.original.conversationId);
 const window=readConversationWindow(f.fx.db,branch.runId!,f.uid);assert.deepEqual(window.runs.flatMap(r=>r.messages.map(m=>m.content.text)),['原始目标','原始答复']);
 assert.ok(window.runs.flatMap(r=>r.messages).every(m=>m.applied));
 f.create('继续',branch.conversationId);assert.deepEqual(f.observed.at(-1)!.historyMessages.map(m=>m.text),['原始目标','原始答复']);
 assert.equal(f.observed.at(-1)!.inheritedCheckpoint,null);
 f.db.prepare('UPDATE conversations SET archived_at=? WHERE id=?').run(new Date().toISOString(),f.original.conversationId);
 deleteArchivedConversation(f.fx.db,f.uid,f.original.conversationId);
 assert.equal(readConversationWindow(f.fx.db,branch.runId!,f.uid).runs[0]!.messages.length,2);
 assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('显式编辑重发产生独立新分支，不废弃原消息，不回退真实文件，不继承截断点后历史',async t=>{
 const f=await fixture(t);writeFileSync(join(f.root,'keep.txt'),'existing-effect');
 const result=f.fx.supervisor.forkRun({userId:f.uid,sessionId:f.session,conversationId:f.original.conversationId,cutMessageId:f.target.id,cutMode:'before',objective:'改后的目标',modelConfigId:f.config,modelId:'fixture'});
 assert.notEqual(result.conversationId,f.original.conversationId);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND state='published'").get(f.original.conversationId)!.n,2);
 assert.equal(f.observed.at(-1)!.objective,'改后的目标');assert.deepEqual(f.observed.at(-1)!.historyMessages,[]);
 assert.equal(readFileSync(join(f.root,'keep.txt'),'utf8'),'existing-effect');
 const before=f.db.prepare('SELECT COUNT(*) n FROM conversations').get()!.n;
 assert.throws(()=>f.fx.supervisor.forkRun({userId:f.uid,sessionId:f.session,conversationId:f.original.conversationId,cutMessageId:f.target.id,cutMode:'before',objective:'invalid',modelConfigId:'invalid',modelId:'fixture'}));
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversations').get()!.n,before);
});

test('分叉拒绝他人、私有消息、活动任务和归档会话',async t=>{
 const f=await fixture(t);assert.throws(()=>cloneConversation(f.fx.db,'stranger',f.original.conversationId,f.target.id,'through'));
 f.db.prepare("UPDATE messages SET visibility='private' WHERE id=?").run(f.replyId);
 assert.throws(()=>cloneConversation(f.fx.db,f.uid,f.original.conversationId,f.replyId,'through'));
 f.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(f.original.runId);
 assert.throws(()=>cloneConversation(f.fx.db,f.uid,f.original.conversationId,f.target.id,'through'),/先停止/);
 f.db.prepare("UPDATE runs SET status='succeeded' WHERE id=?").run(f.original.runId);
 f.db.prepare("UPDATE conversations SET archived_at='2026-11-13' WHERE id=?").run(f.original.conversationId);
 assert.throws(()=>cloneConversation(f.fx.db,f.uid,f.original.conversationId,f.target.id,'through'),/归档/);
});

test('输入历史保留非连续重复、正确回到空草稿；受限存储不会阻断发送',()=>{
 assert.deepEqual(appendPromptHistoryEntry(['A','B'],'A'),['A','B','A']);
 assert.deepEqual(appendPromptHistoryEntry(['A'],' A '),['A']);
 assert.equal(navigatePromptHistory(['A','B'],null,'up').nextValue,'B');
 assert.equal(navigatePromptHistory(['A','B'],1,'down').nextIndex,null);
 const storage={getItem(){throw Error('denied')},setItem(){throw Error('quota')}};
 assert.deepEqual(readPromptHistoryEntries('user:project',storage),[]);
 assert.doesNotThrow(()=>persistPromptHistoryEntries('user:project',['A'],storage));
});

test('队列持久化：提交幂等、顺序调整、编辑拒绝不改变原值、移除和归属校验',async t=>{
 const {enqueueMessage,changeQueueItem,queueView}=await import('../src/agent/conversationQueue.js');
 const f=await fixture(t);f.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(f.original.runId);
 const a=enqueueMessage(f.fx.db,f.original.runId,f.uid,{text:'first',clientKey:'a'});
 assert.equal(enqueueMessage(f.fx.db,f.original.runId,f.uid,{text:'duplicate',clientKey:'a'}).id,a.id);
 const b=enqueueMessage(f.fx.db,f.original.runId,f.uid,{text:'second',clientKey:'b'});
 changeQueueItem(f.fx.db,f.original.conversationId,b.id,'up');assert.deepEqual(queueView(f.fx.db,f.original.conversationId).items.map(i=>i.text),['second','first']);
 assert.throws(()=>changeQueueItem(f.fx.db,f.original.conversationId,a.id,'edit',''));
 assert.equal(queueView(f.fx.db,f.original.conversationId).items.find(i=>i.id===a.id)!.text,'first');
 changeQueueItem(f.fx.db,f.original.conversationId,b.id,'delete');assert.equal(queueView(f.fx.db,f.original.conversationId).items.length,1);
 assert.throws(()=>enqueueMessage(f.fx.db,f.original.runId,'stranger',{text:'bad',clientKey:'bad'}));
});

test('用量统计快照按账号隔离，未知用量与真实零分别统计',async t=>{
 const {appUsageSnapshot}=await import('../src/agent/appUsage.js');const f=await fixture(t),now=new Date().toISOString();
 f.db.prepare('DELETE FROM usage_entries').run();
 for(const usage of [null,JSON.stringify({output:7,totalInput:null}),JSON.stringify({input:0,output:0,totalInput:0}),JSON.stringify({input:100,output:20,totalInput:100})]){
  f.db.prepare("INSERT INTO usage_entries(id,run_id,request_id,provider,model,status,normalized_usage_json,created_at,updated_at) VALUES (?,?,?,'fixture','test','completed',?,?,?)").run(randomUUID(),f.original.runId,randomUUID(),usage,now,now);
 }
 const stats=appUsageSnapshot(f.fx.db,f.uid,'7d','Asia/Shanghai');
 assert.equal(stats.source,'agent-db');assert.equal(stats.range,'7d');
 assert.equal(stats.summary.totalTokens,120);assert.equal(stats.summary.inputTokens,100);assert.equal(stats.summary.outputTokens,20);
 assert.equal(stats.unknownRequests,2);assert.equal(stats.summary.totalTurns,1);assert.equal(stats.summary.totalSessions,1);
 assert.equal(stats.summary.peakDayTokens,120);assert.equal(stats.summary.favoriteModel?.modelId,'fixture / test');assert.equal(stats.summary.favoriteModel?.share,1);
 assert.equal(stats.models.length,1);assert.equal(stats.models[0]!.requestCount,4);assert.equal(stats.models[0]!.totalTokens,120);
 assert.equal(stats.dailyModelUsage.length,7);assert.equal(stats.dailyModelUsage[6]!.models[0]?.totalTokens,120);
 const todayCell=stats.heatmap.weeks.flatMap(w=>w.days).find(cell=>cell&&cell.totalTokens>0);
 assert.ok(todayCell);assert.equal(todayCell.level,4);assert.equal(todayCell.turnCount,1);
 assert.equal(appUsageSnapshot(f.fx.db,'stranger','all','Asia/Shanghai').summary.totalTokens,0);
 assert.equal(appUsageSnapshot(f.fx.db,f.uid,'7d','Bogus/Zone').timeZone,'Asia/Shanghai');
 assert.throws(()=>appUsageSnapshot(f.fx.db,f.uid,'unbounded','Asia/Shanghai'));
});

test('会话查找和整理历史接口拒绝未登录；查找只返回本会话公开消息',async t=>{
 const {registerWorkspaceFeatures}=await import('../src/agent/workspaceFeatures.js');const {default:Fastify}=await import('fastify');const f=await fixture(t),app=Fastify();t.after(()=>app.close());
 registerWorkspaceFeatures(app,f.fx.db,f.fx.supervisor,()=>({userId:f.uid}));
 f.db.prepare("UPDATE messages SET visibility='private' WHERE id=?").run(f.replyId);
 const found=await app.inject({url:`/api/v1/runs/${f.original.runId}/find?q=${encodeURIComponent('原始')}`});assert.equal(found.statusCode,200);assert.equal(found.json().data.matches.length,1);assert.equal(found.json().data.matches[0].id,f.target.id);
 assert.equal((await app.inject({url:`/api/v1/runs/${f.original.runId}/context-history`})).statusCode,200);
 assert.equal((await f.fx.app.inject({url:`/api/v1/runs/${f.original.runId}/context-history`})).statusCode,401);
});

test('快捷键录制拒绝组合冲突、系统保留键和输入法组合事件',async()=>{
 const {shortcutFromEvent,shortcutProblem,defaultBindings}=await import('../web/keyboardShortcuts.js');
 const event={key:'f',ctrlKey:true,metaKey:false,altKey:false,shiftKey:false,isComposing:false};
 assert.equal(shortcutFromEvent(event,{platform:'win32'}),'Mod+F');assert.equal(shortcutFromEvent({...event,isComposing:true},{platform:'win32'}),null);
 assert.match(shortcutProblem(defaultBindings(),'newTask','Mod+F')??'',/冲突/);
 assert.ok(shortcutProblem(defaultBindings(),'find','Mod+L'));assert.equal(shortcutProblem(defaultBindings(),'find','Mod+Shift+F'),null);
});


test('追问与分支恢复用户图片，私有消息不进入正式历史',async t=>{
 const f=await fixture(t),{saveAttachment,attachmentView}=await import('../src/agent/attachments.js');
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPQqLhEU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAPHFyEwoyF0pAAAAAElFTkSuQmCC','base64');
 mkdirSync(join(f.root,'assets'));const image=saveAttachment(f.fx.db,join(f.root,'assets'),f.uid,'sample.png',bytes);
 f.db.prepare('UPDATE messages SET content_json=? WHERE id=?').run(JSON.stringify({text:'原始目标',attachments:[attachmentView(image)]}),f.target.id);
 f.create('请继续解释图片',f.original.conversationId);assert.equal(f.observed.at(-1)!.historyMessages[0]!.images?.[0]?.data,bytes.toString('base64'));
 const branch=cloneConversation(f.fx.db,f.uid,f.original.conversationId,f.replyId,'through');f.create('分支中继续解释图片',branch.conversationId);assert.equal(f.observed.at(-1)!.historyMessages[0]!.images?.[0]?.mimeType,'image/png');
 f.db.prepare("UPDATE messages SET visibility='private' WHERE id=?").run(f.replyId);f.create('公开追问',f.original.conversationId);assert.ok(!f.observed.at(-1)!.historyMessages.some(m=>m.text==='原始答复'));
});


test('验收：队列错误参数返回可识别校验错误，不抛TypeError',async t=>{
 const f=await fixture(t),{enqueueMessage,changeQueueItem}=await import('../src/agent/conversationQueue.js');f.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(f.original.runId);
 assert.throws(()=>enqueueMessage(f.fx.db,f.original.runId,f.uid,null as never),(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code==='VALIDATION_FAILED');
 const item=enqueueMessage(f.fx.db,f.original.runId,f.uid,{text:'original',clientKey:'malformed'});
 assert.throws(()=>changeQueueItem(f.fx.db,f.original.conversationId,item.id,'edit',123 as never),(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code==='VALIDATION_FAILED');
});


test('验收：过大图片补充在持久化前明确拒绝，不生成永远未应用的消息',async t=>{
 const f=await fixture(t),{saveAttachment}=await import('../src/agent/attachments.js');
 const bytes=Buffer.alloc(7*1024*1024);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);const image=saveAttachment(f.fx.db,f.root,f.uid,'large.png',bytes);
 f.fx.supervisor.active.set(f.original.runId,{status:'running',binding:{protocol:'openai-completions',modelId:'gpt-4o'},execChannel:{notify(){throw Error('must not send')}}} as never);
 const before=f.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n;
 assert.throws(()=>f.fx.supervisor.steer(f.original.runId,f.uid,'图片补充','large-steer',[image.id]),(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code==='INPUT_TOO_LARGE');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n,before);
 f.fx.supervisor.active.delete(f.original.runId);
});


test('验收：非视觉模型带图创建或编辑时明确拒绝，不建立空分支',async t=>{
 const f=await fixture(t),{saveAttachment,attachmentView}=await import('../src/agent/attachments.js');const image=saveAttachment(f.fx.db,f.root,f.uid,'sample.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPQqLhEU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAPHFyEwoyF0pAAAAAElFTkSuQmCC','base64'));
 const before=f.db.prepare('SELECT COUNT(*) n FROM conversations').get()!.n;
 assert.throws(()=>f.fx.supervisor.createOrdinaryRun({userId:f.uid,sessionId:f.session,projectId:f.pid,conversationId:null,objective:'非视觉模型看图',modelConfigId:f.config,modelId:'fixture',attachmentIds:[image.id]}),/不支持图片/);
 f.db.prepare('UPDATE messages SET content_json=? WHERE id=?').run(JSON.stringify({text:'原始目标',attachments:[attachmentView(image)]}),f.target.id);
 assert.throws(()=>f.fx.supervisor.forkRun({userId:f.uid,sessionId:f.session,conversationId:f.original.conversationId,cutMessageId:f.target.id,cutMode:'before',objective:'编辑图片目标',modelConfigId:f.config,modelId:'fixture'}),/不支持图片/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversations').get()!.n,before);
});
