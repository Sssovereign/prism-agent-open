import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/storage/db.js';
import { migrate,defaultMigrationsDir } from '../src/storage/migrate.js';
import { readConversationWindow } from '../src/agent/conversationProjection.js';
import { registerConversationRoutes } from '../src/agent/conversationRoutes.js';
import Fastify from 'fastify';
function seed(db:Db){migrate(db,defaultMigrationsDir());db.db.exec(`
 INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES ('u','fixture','h','s','{}','t','t');
 INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES ('p','u','fixture','t','t');
 INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES ('c','p','ordinary','fixture','t','t');
 INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES ('pv','c',1,'fixture','t','t');
 `);
 for(let i=1;i<=3;i++)db.db.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES (?,'p','c','pv','ordinary','succeeded','{}',?,?)").run(`r${i}`,`2026-11-12T00:00:0${i}Z`,`2026-11-12T00:00:0${i}Z`);
}
test('complete run window returns >500 events and >200 messages, pages older turns without holes',()=>{
 const db=new Db(':memory:');try{seed(db);db.tx(tx=>{for(let i=1;i<=620;i++){
  tx.prepare("INSERT INTO run_events(run_id,seq,event_id,visibility,type,occurred_at,payload_json) VALUES ('r2',?,?,'public','message.completed','t',?)").run(i,`e${i}`,JSON.stringify({role:'assistant',messageId:`a${i}`,content:`正文${i}`}));
  tx.prepare("INSERT INTO messages(id,conversation_id,run_id,author_type,seq,visibility,state,content_json,created_at,updated_at) VALUES (?,'c','r2','user',?,'public','published',?,'t','t')").run(`m${i}`,i,JSON.stringify({text:`补充${i}`}));
 }});
 const page=readConversationWindow(db,'r3','u',undefined,2);assert.deepEqual(page.runs.map(r=>r.id),['r2','r3']);assert.equal(page.hasOlder,true);assert.equal(page.before,'r2');assert.equal(page.runs[0]?.events.length,620);assert.equal(page.runs[0]?.messages.length,620);assert.equal(page.runs[0]?.throughSeq,620);
 const earlier=readConversationWindow(db,'r3','u',page.before!,2);assert.deepEqual(earlier.runs.map(r=>r.id),['r1']);assert.equal(earlier.hasOlder,false);
 const selected=readConversationWindow(db,'r2','u');assert.ok(!selected.runs.some(r=>r.id==='r3'));
 }finally{db.close();}
});
test('projection enforces owner, visible event/message boundaries and cursor conversation',()=>{
 const db=new Db(':memory:');try{seed(db);for(const visibility of ['public','owner','role_private','audit'])db.db.prepare("INSERT INTO run_events(run_id,seq,event_id,visibility,type,occurred_at,payload_json) VALUES ('r1',?,?,?,?, 't','{}')").run(['public','owner','role_private','audit'].indexOf(visibility)+1,visibility,visibility,'notice');
 db.db.exec("INSERT INTO messages(id,conversation_id,run_id,author_type,seq,visibility,state,content_json,created_at,updated_at) VALUES ('secret','c','r1','agent',1,'private','published','{\"text\":\"secret\"}','t','t')");
 const data=readConversationWindow(db,'r1','u');assert.deepEqual(data.runs[0]?.events.map(e=>e.eventId),['public','owner']);assert.equal(data.runs[0]?.messages.length,0);
 assert.throws(()=>readConversationWindow(db,'r1','outsider'),/无权访问/);assert.throws(()=>readConversationWindow(db,'r1','u','r3'),/游标/);assert.throws(()=>readConversationWindow(db,'r1','u','missing'),/游标/);
 }finally{db.close();}
});
test('independent route uses auth and envelope with input validation (inject only, no listener)',async()=>{
 const db=new Db(':memory:');seed(db);const app=Fastify();let calls=0;registerConversationRoutes(app,{db},()=>{calls++;return {userId:'u'};});
 try{const response=await app.inject({method:'GET',url:'/api/v1/runs/r3/conversation?limit=1'});assert.equal(response.statusCode,200);assert.equal(response.json().data.runs[0].id,'r3');assert.equal(calls,1);for(const limit of ['0','21','NaN','1.5']){const invalid=await app.inject({method:'GET',url:`/api/v1/runs/r3/conversation?limit=${limit}`});assert.notEqual(invalid.statusCode,200);}}
 finally{await app.close();db.close();}
});
