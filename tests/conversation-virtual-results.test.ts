import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {Db} from '../src/storage/db.js';
import {migrate,defaultMigrationsDir} from '../src/storage/migrate.js';
import {toolResultPage,toolResultDownload,storedToolResult} from '../src/agent/conversationToolResult.js';
import {registerConversationRoutes} from '../src/agent/conversationRoutes.js';
import {virtualTurnWindow,anchorFor,anchorTop,cacheHeight,measuredHeight,saveReadingAnchor,readReadingAnchor,MAX_MOUNTED_HISTORY} from '../web/conversation/virtualHistory.js';
function fixture(){const db=new Db(':memory:');migrate(db,defaultMigrationsDir());db.db.exec(`
 INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES('u','fixture','h','s','{}','t','t');
 INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES('p','u','fixture','t','t');
 INSERT INTO conversations(id,project_id,mode,title,created_at,updated_at) VALUES('c','p','ordinary','fixture','t','t'),('other','p','ordinary','other','t','t');
 INSERT INTO problem_versions(id,conversation_id,version,objective,created_at,updated_at) VALUES('pv','c',1,'fixture','t','t'),('pv2','other',1,'fixture','t','t');
 INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,config_snapshot_json,created_at,updated_at) VALUES('r','p','c','pv','ordinary','succeeded','{}','t','t'),('other','p','other','pv2','ordinary','succeeded','{}','t','t');
 `);
 // Result reader depends only on invocation/run/project identity; unused execution FKs are synthetic.
 db.db.exec('PRAGMA foreign_keys=OFF');
 const raw=JSON.stringify({stdout:'中😀'.repeat(25000),stderr:'<script>not executed</script>',truncated:true});
 db.db.prepare("INSERT INTO tool_invocations(id,run_id,phase_task_id,attempt_id,call_key,tool_name,tool_version,args_hash,state,result_json,created_at,updated_at) VALUES('tool','r','phase','attempt','call','bash','v1','hash','succeeded',?,'t','t')").run(raw);
 db.db.exec('PRAGMA foreign_keys=ON');return {db,raw};}
test('virtual history bounds mounted turns for 1000 records and never unmounts live tail',()=>{
 const metrics=Array.from({length:1000},(_,i)=>({id:`t${i}`,height:100+i%7*30}));
 for(const top of [0,5000,50000,180000]){const visible=virtualTurnWindow(metrics,top,800,'t999');assert.ok(visible.size<=MAX_MOUNTED_HISTORY+1);assert.ok(visible.has('t999'));}
 assert.ok(!virtualTurnWindow(metrics,0,800,'t999').has('t500'));
});
test('height-cache width isolation and anchor preservation across prepend and remeasurement',()=>{
 cacheHeight('s','b',800,600);assert.equal(measuredHeight('s','b',800),600);assert.equal(measuredHeight('s','b',400),360);
 const old=[{id:'a',height:100},{id:'b',height:600},{id:'c',height:200}],anchor=anchorFor(old,250,false)!;assert.deepEqual(anchor,{id:'b',offset:150,following:false});
 assert.equal(anchorTop([{id:'new',height:300},{id:'a',height:180},...old.slice(1)],anchor),630);
 assert.equal(anchorTop([{id:'other',height:100}],anchor),undefined);
});
test('reading memory is scope-keyed and preserves detached/following intent',()=>{
 saveReadingAnchor('one',{id:'a',offset:77,following:false});saveReadingAnchor('two',{id:'b',offset:0,following:true});assert.deepEqual(readReadingAnchor('one'),{id:'a',offset:77,following:false});assert.equal(readReadingAnchor('two')?.following,true);assert.equal(readReadingAnchor('not-stored'),undefined);
});
test('full stored result is paginated without preview truncation and Unicode boundaries survive',async()=>{
 const {db,raw}=fixture();try{let offset=0,text='',pages=0;for(;;){const page=toolResultPage(db,'r','tool','u',offset);assert.ok([...page.text].length<=16384);assert.equal(page.sourceTruncated,true);text+=page.text;pages++;if(page.nextOffset===null)break;assert.ok(page.nextOffset>offset);offset=page.nextOffset;}assert.ok(pages>3);assert.equal(text,raw);
 const {stream}=toolResultDownload(db,'r','tool','u');let downloaded='';for await(const chunk of stream)downloaded+=chunk;assert.equal(downloaded,raw);
 }finally{db.close();}
});
test('full-result rejects other owner/conversation, non-allowlisted tool, and invalid offsets',()=>{
 const {db}=fixture();try{assert.throws(()=>storedToolResult(db,'r','tool','stranger'),/无权访问/);assert.throws(()=>storedToolResult(db,'other','tool','u'),/无权访问/);for(const offset of [-1,1.5,Infinity,999999])assert.throws(()=>toolResultPage(db,'r','tool','u',offset));assert.throws(()=>toolResultPage(db,'r','tool','u',0,16385));db.db.exec("UPDATE tool_invocations SET tool_name='unknown_external' WHERE id='tool'");assert.throws(()=>storedToolResult(db,'r','tool','u'),/无权访问/);}finally{db.close();}
});
test('full-result route delivers bounded page and safe attachment with source-truncation notice',async()=>{
 const {db,raw}=fixture(),app=Fastify();registerConversationRoutes(app,{db},()=>({userId:'u'}));try{const page=await app.inject('/api/v1/runs/r/conversation/tools/tool/result?limit=100');assert.equal(page.statusCode,200);assert.equal([...page.json().data.text].length,100);assert.equal(page.json().data.sourceTruncated,true);assert.equal(page.headers['cache-control'],'no-store');const download=await app.inject('/api/v1/runs/r/conversation/tools/tool/result/download');assert.equal(download.statusCode,200);assert.equal(download.body,raw);assert.match(String(download.headers['content-disposition']),/^attachment;/);assert.equal(download.headers['content-type'],'application/octet-stream');assert.equal(download.headers['x-content-type-options'],'nosniff');assert.equal(download.headers['x-source-truncated'],'true');}finally{await app.close();db.close();}
});
