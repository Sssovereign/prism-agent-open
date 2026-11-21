import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {buildProductApp} from '../src/app.js';
import {hashPassword} from '../src/auth/passwords.js';
import {MemoryLifecycle} from '../src/agent/memoryLifecycle.js';
import {memoryRootOf,readMemoryText,toolMemoryWrite,updateMemoryIndex} from '../src/agent/memoryStore.js';
import {selectedMemories} from '../src/agent/memoryPrompts.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(t:{after(fn:()=>unknown):unknown}){
 const dir=mkdtempSync(join(tmpdir(),'memory-lifecycle-')),fx=buildProductApp(dir,{serveWeb:false}),now=new Date().toISOString();const uid=randomUUID(),pid=randomUUID(),conv=randomUUID(),pv=randomUUID(),run=randomUUID();const pw=await hashPassword('MemoryFixture2026!');
 fx.db.db.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)').run(uid,'memory-check',pw.hash,pw.salt,pw.paramsJson,now,now);
 fx.db.db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(pid,uid,'记忆项目',now,now);
 fx.db.db.prepare("INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES (?,?,'ordinary','交接',?,?)").run(conv,pid,now,now);
 fx.db.db.prepare('INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES (?,?,1,?,?,?)').run(pv,conv,'保存交接',now,now);
 fx.db.db.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES (?,?,?,?,'ordinary','running','{}',?,?)").run(run,pid,conv,pv,now,now);
 const login=await fx.app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'memory-check',password:'MemoryFixture2026!'}});assert.equal(login.statusCode,200);const cookie=String(login.headers['set-cookie']).split(';')[0]!,headers={cookie,'x-csrf-token':login.json().data.csrfToken};
 t.after(async()=>{await fx.app.close();rmSync(dir,{recursive:true,force:true});});return {...fx,dir,uid,pid,run,headers};
}
test('handoff pipeline: source hash→memory/index/readback receipt→current/changed/missing',async t=>{
 const f=await fixture(t),service=new MemoryLifecycle(f.db,f.dir);const source='# 项目状态\n已完成A，B未验。';writeFileSync(join(f.dir,'PROJECT_STATE.md'),source);
 const input={source_hash:sha(source),summary:'交接A与B',verified:['A已验证，证据test.log'],unverified:['B未验'],next_steps:['核对B']};
 await assert.rejects(service.saveHandoff(f.pid,f.run,f.dir,{...input,source_hash:sha('stale')}),/变化/);
 const saved=await service.saveHandoff(f.pid,f.run,f.dir,input);assert.equal(saved.sync,'verified');assert.equal(saved.sourceHash,sha(source));
 assert.match((await readMemoryText(memoryRootOf(f.dir,f.pid),'MEMORY.md')).content,/handoff\//);
 const restored=await service.restoreHandoff(f.pid,f.dir);assert.equal(restored.status,'current');assert.match(restored.memory,/B未验/);assert.equal(restored.currentSource,source);
 writeFileSync(join(f.dir,'PROJECT_STATE.md'),'更新状态B已完成');assert.equal((await service.restoreHandoff(f.pid,f.dir)).status,'source_changed');
 rmSync(join(f.dir,'PROJECT_STATE.md'));assert.equal((await service.restoreHandoff(f.pid,f.dir)).status,'source_missing');
});
test('handoff detects edited memory and never treats the stale source binding as current',async t=>{
 const f=await fixture(t),service=new MemoryLifecycle(f.db,f.dir);writeFileSync(join(f.dir,'PROJECT_STATE.md'),'v1');const saved=await service.saveHandoff(f.pid,f.run,f.dir,{source_hash:sha('v1'),summary:'v1',verified:[],unverified:[],next_steps:[]});
 await toolMemoryWrite(memoryRootOf(f.dir,f.pid),{path:saved.path,content:'manually edited',expectedHash:saved.memoryHash});assert.equal((await service.restoreHandoff(f.pid,f.dir)).status,'memory_changed');
});
test('memory browser APIs: account scope, CSRF and conditional edits preserve isolation',async t=>{
 const f=await fixture(t),root=memoryRootOf(f.dir,f.pid);const first=await toolMemoryWrite(root,{path:'note.md',content:'one',expectedHash:null});await updateMemoryIndex(root,'note.md');
 assert.equal((await f.app.inject({url:'/api/v1/memory'})).statusCode,401);
 const catalog=await f.app.inject({url:'/api/v1/memory',headers:f.headers});assert.equal(catalog.statusCode,200);assert.equal(catalog.json().data.projects[0].files[0].filename,'note.md');
 const get=await f.app.inject({url:`/api/v1/projects/${f.pid}/memory/file?path=note.md`,headers:f.headers});assert.equal(get.json().data.content,'one');
 assert.equal((await f.app.inject({method:'PUT',url:`/api/v1/projects/${f.pid}/memory/file`,headers:{cookie:f.headers.cookie},payload:{path:'note.md',content:'two',expectedHash:first.hash}})).statusCode,403);
 assert.equal((await f.app.inject({method:'PUT',url:`/api/v1/projects/${f.pid}/memory/file`,headers:f.headers,payload:{path:'note.md',content:'two',expectedHash:sha('wrong')}})).statusCode,409);
 assert.equal((await f.app.inject({method:'PUT',url:`/api/v1/projects/${f.pid}/memory/file`,headers:f.headers,payload:{path:'note.md',content:'two',expectedHash:first.hash}})).statusCode,200);
 assert.equal((await f.app.inject({url:`/api/v1/projects/${randomUUID()}/memory/file?path=note.md`,headers:f.headers})).statusCode,404);
 assert.equal((await f.app.inject({url:`/api/v1/projects/${f.pid}/memory/file?path=../escape.md`,headers:f.headers})).statusCode,400);
});
test('conservative selector ignores invented paths, invalid output and duplicates, and caps recall',()=>{
 assert.deepEqual(selectedMemories('{"selected_memories":["a.md","../secret.md","a.md"]}',['a.md']),['a.md']);assert.deepEqual(selectedMemories('not json',['a.md']),[]);assert.equal(selectedMemories(JSON.stringify({selected_memories:Array.from({length:9},(_,i)=>`${i}.md`)}),Array.from({length:9},(_,i)=>`${i}.md`)).length,5);
});
