import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {buildProductApp} from '../src/app.js';
import {clearLoginFailures} from '../src/auth/routes.js';
import {resolveSession} from '../src/auth/sessions.js';

const password='SyntheticLocal2026!',apiKey='synthetic-account-key-9c3c8d',config={preset:'custom',name:'local',baseUrl:'https://models.example.org/v1',models:[{modelId:'fixture',displayName:'fixture',enabled:true,parameters:{}}]};
async function fixture(t:{after(fn:()=>unknown):unknown}){const dir=mkdtempSync(join(tmpdir(),'prism-local-account-'));const fx=buildProductApp(dir,{serveWeb:false});t.after(async()=>{clearLoginFailures();await fx.app.close();rmSync(dir,{recursive:true,force:true});});return {fx,dir};}
const register=(fx:ReturnType<typeof buildProductApp>,username:string,remember=true)=>fx.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{username,password,confirmation:password,remember}});
function auth(r:{headers:Record<string,unknown>;json():any}){return {cookie:String(r.headers['set-cookie']).split(';')[0]!, 'x-csrf-token':r.json().data.csrfToken as string};}
const login=(fx:ReturnType<typeof buildProductApp>,username:string,remember=true)=>fx.app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username,password,remember}});

test('本机注册无需旧会话，校验输入并自动登录，库中仅存加盐散列',async t=>{
 const {fx,dir}=await fixture(t);assert.equal((await fx.app.inject({url:'/api/v1/auth/status'})).json().data.hasAccounts,false);
 for(const payload of [{username:'local-a',password,confirmation:'different-password'},{username:'x',password,confirmation:password},{username:'local-a',password:'',confirmation:''}])assert.equal((await fx.app.inject({method:'POST',url:'/api/v1/auth/register',payload})).statusCode,400);
 const r=await register(fx,'Local-A');assert.equal(r.statusCode,201,r.body);assert.equal(r.json().data.user.username,'local-a');
 const a=auth(r);assert.equal((await fx.app.inject({url:'/api/v1/auth/me',headers:a})).statusCode,200);assert.equal((await fx.app.inject({url:'/api/v1/auth/status'})).json().data.hasAccounts,true);
 const user=fx.db.db.prepare('SELECT password_hash,password_salt FROM users').get() as {password_hash:string;password_salt:string};assert.equal(user.password_hash.length,128);assert.equal(user.password_salt.length,32);
 assert.equal(readFileSync(join(dir,'workbench.sqlite-wal')).includes(Buffer.from(password)),false);
});

test('并发重名注册只创建一个账号，不覆盖密码或账号；本地注册拒绝外部Origin/Host',async t=>{
 const {fx}=await fixture(t);const results=await Promise.all([register(fx,'same-name'),register(fx,'SAME-NAME')]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[201,409]);assert.equal((fx.db.db.prepare('SELECT count(*) AS n FROM users').get() as {n:number}).n,1);
 for(const headers of [{origin:'https://other.example'},{host:'external.example'}])assert.equal((await fx.app.inject({method:'POST',url:'/api/v1/auth/register',headers,payload:{username:'local-b',password,confirmation:password}})).statusCode,403);
 assert.equal((await login(fx,'same-name')).statusCode,200);
});

test('记住登录30天跨服务重启保留；不勾选使用会话Cookie，旧客户端仍为12小时',async t=>{
 const {fx,dir}=await fixture(t);await register(fx,'remember-user');const yes=await login(fx,'remember-user',true),no=await login(fx,'remember-user',false);
 assert.match(String(yes.headers['set-cookie']),/HttpOnly; SameSite=Strict/);assert.match(String(yes.headers['set-cookie']),/Max-Age=2592000/);assert.doesNotMatch(String(no.headers['set-cookie']),/Max-Age|Expires/);
 const token=auth(yes).cookie.split('=')[1]!;assert.ok(resolveSession(fx.db,token,new Date(Date.now()+29*86400000)));assert.equal(resolveSession(fx.db,token,new Date(Date.now()+31*86400000)),undefined);
 const legacy=await fx.app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'remember-user',password}});const legacySession=resolveSession(fx.db,auth(legacy).cookie.split('=')[1]!);assert.ok(legacySession);assert.ok(Date.parse(legacySession.expiresAt)-Date.now()<=12*3600000);
 await fx.app.close();const restarted=buildProductApp(dir,{serveWeb:false});try{const a=auth(yes);assert.equal((await restarted.app.inject({url:'/api/v1/auth/me',headers:a})).statusCode,200);assert.equal((await restarted.app.inject({method:'POST',url:'/api/v1/auth/logout',headers:a})).statusCode,200);assert.equal((await restarted.app.inject({url:'/api/v1/auth/me',headers:a})).statusCode,401);}finally{await restarted.app.close();}
});

test('模型Key加密落盘，账号隔离，退出再登录及重启后可用，接口不返回秘密',async t=>{
 const {fx,dir}=await fixture(t);const a=auth(await register(fx,'local-a')),b=auth(await register(fx,'local-b'));
 const c=(await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers:a,payload:config})).json().data,id=c.id;
 assert.equal((await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${id}/credential`,headers:a,payload:{apiKey}})).statusCode,200);
 const row=fx.db.db.prepare('SELECT * FROM local_model_credentials').get();assert.equal(JSON.stringify(row).includes(apiKey),false);assert.equal(statSync(join(dir,'credential-master.key')).mode&0o777,0o600);assert.equal(readFileSync(join(dir,'workbench.sqlite-wal')).includes(Buffer.from(apiKey)),false);
 assert.deepEqual((await fx.app.inject({url:'/api/v1/model-configs',headers:b})).json().data,[]);assert.equal((await fx.app.inject({method:'DELETE',url:`/api/v1/model-configs/${id}/credential`,headers:b})).statusCode,404);await fx.app.inject({method:'DELETE',url:'/api/v1/model-credentials',headers:b});
 await fx.app.inject({method:'POST',url:'/api/v1/auth/logout',headers:a});const fresh=auth(await login(fx,'local-a'));const list=await fx.app.inject({url:'/api/v1/model-configs',headers:fresh});assert.equal(list.json().data[0].hasCredential,true);assert.equal(list.body.includes(apiKey),false);
 const sid=(fx.db.db.prepare('SELECT id FROM sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1').get((fx.db.db.prepare("SELECT id FROM users WHERE username='local-a'").get() as {id:string}).id) as {id:string}).id;
 assert.equal(fx.supervisor.opts.vault.get(sid,id),apiKey);await fx.app.close();const restarted=buildProductApp(dir,{serveWeb:false});try{assert.equal(restarted.supervisor.opts.vault.get(sid,id),apiKey);assert.equal((await restarted.app.inject({url:'/api/v1/model-configs',headers:fresh})).json().data[0].hasCredential,true);}finally{await restarted.app.close();}
});

test('显式清除跨登录生效，撤销的会话不能取Key；修改端点会删除保存凭据',async t=>{
 const {fx}=await fixture(t);const a=auth(await register(fx,'clear-user')),b=auth(await login(fx,'clear-user'));const c=(await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers:a,payload:config})).json().data;
 await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${c.id}/credential`,headers:a,payload:{apiKey}});
 const sessions=fx.db.db.prepare('SELECT id FROM sessions').all() as {id:string}[];for(const s of sessions)assert.equal(fx.supervisor.opts.vault.get(s.id,c.id),apiKey);
 const controller=new AbortController();fx.supervisor.opts.vault.track(sessions[0]!.id,c.id,controller);assert.equal((await fx.app.inject({method:'DELETE',url:`/api/v1/model-configs/${c.id}/credential`,headers:b})).statusCode,200);assert.equal(controller.signal.aborted,true);for(const s of sessions)assert.equal(fx.supervisor.opts.vault.get(s.id,c.id),undefined);
 await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${c.id}/credential`,headers:b,payload:{apiKey}});assert.equal((await fx.app.inject({method:'POST',url:'/api/v1/auth/logout',headers:a})).statusCode,200);const revoked=(fx.db.db.prepare('SELECT id FROM sessions WHERE revoked_at IS NOT NULL').get() as {id:string}).id;assert.equal(fx.supervisor.opts.vault.get(revoked,c.id),undefined);
 const changed=await fx.app.inject({method:'PATCH',url:`/api/v1/model-configs/${c.id}`,headers:b,payload:{...config,revision:c.revision,baseUrl:'https://other.example.org/v1'}});assert.equal(changed.statusCode,200,changed.body);assert.equal(changed.json().data.hasCredential,false);assert.equal((fx.db.db.prepare('SELECT count(*) AS n FROM local_model_credentials').get() as {n:number}).n,0);
});

test('密文不可挪用于其他接口，主密钥遗失时不自动重建覆盖',async t=>{
 const {fx,dir}=await fixture(t);const a=auth(await register(fx,'crypto-user'));const ids=[];for(let i=0;i<2;i++)ids.push((await fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers:a,payload:config})).json().data.id as string);
 await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${ids[0]}/credential`,headers:a,payload:{apiKey}});fx.db.db.prepare('INSERT INTO local_model_credentials SELECT ?,owner_user_id,nonce,ciphertext,auth_tag,updated_at FROM local_model_credentials WHERE config_id=?').run(ids[1]!,ids[0]!);
 const sid=(fx.db.db.prepare('SELECT id FROM sessions').get() as {id:string}).id;assert.equal(fx.supervisor.opts.vault.get(sid,ids[1]!),undefined);
 unlinkSync(join(dir,'credential-master.key'));assert.equal(fx.supervisor.opts.vault.get(sid,ids[0]!),undefined);const failed=await fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${ids[0]}/credential`,headers:a,payload:{apiKey:'replacement-key'}});assert.equal(failed.statusCode,422);assert.equal((fx.db.db.prepare('SELECT count(*) AS n FROM local_model_credentials').get() as {n:number}).n,2);
});

test('搜索API Key同样随本机账号加密保存、跨重启恢复；换服务和清除全部Key会删除',async t=>{
 const {fx,dir}=await fixture(t);const a=auth(await register(fx,'search-owner')),b=auth(await register(fx,'search-other'));
 await fx.app.inject({method:'PUT',url:'/api/v1/search-settings',headers:a,payload:{provider:'bocha'}});
 assert.equal((await fx.app.inject({method:'PUT',url:'/api/v1/search-settings/credential',headers:a,payload:{apiKey}})).statusCode,200);
 assert.equal((await fx.app.inject({url:'/api/v1/search-settings',headers:a})).json().data.credentialStored,true);assert.equal((await fx.app.inject({url:'/api/v1/search-settings',headers:b})).json().data.credentialStored,false);
 const row=fx.db.db.prepare('SELECT * FROM local_search_credentials').get();assert.equal(JSON.stringify(row).includes(apiKey),false);assert.equal(readFileSync(join(dir,'workbench.sqlite-wal')).includes(Buffer.from(apiKey)),false);
 await fx.app.close();const restarted=buildProductApp(dir,{serveWeb:false});try{
  assert.equal((await restarted.app.inject({url:'/api/v1/search-settings',headers:a})).json().data.credentialStored,true);
  await restarted.app.inject({method:'PUT',url:'/api/v1/search-settings',headers:a,payload:{provider:'tavily'}});assert.equal((await restarted.app.inject({url:'/api/v1/search-settings',headers:a})).json().data.credentialStored,false);
  await restarted.app.inject({method:'PUT',url:'/api/v1/search-settings/credential',headers:a,payload:{apiKey}});await restarted.app.inject({method:'DELETE',url:'/api/v1/model-credentials',headers:a});assert.equal((await restarted.app.inject({url:'/api/v1/search-settings',headers:a})).json().data.credentialStored,false);
 }finally{await restarted.app.close();}
});

test('新密码不要求8位或组合，保留空格与符号，拒绝汉字及空密码；旧账号仍可验证',async t=>{
 const {fx}=await fixture(t);
 const values=['1',' ','!@#','é🙂','x'.repeat(128)];
 for(const [i,value] of values.entries()){
  const username=`free-password-${i}`;
  const created=await fx.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{username,password:value,confirmation:value}});
  assert.equal(created.statusCode,201,created.body);
  const logged=await fx.app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username,password:value}});
  assert.equal(logged.statusCode,200,logged.body);
 }
 clearLoginFailures();
 for(const value of ['中文','a中!',String.fromCodePoint(0x20000)]){
  const response=await fx.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{username:'han-rejected',password:value,confirmation:value}});
  assert.equal(response.statusCode,400);assert.equal(response.json().error.message,'密码不能包含汉字');
 }
 for(const value of ['', 'x'.repeat(129)]) assert.equal((await fx.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{username:'invalid-length',password:value,confirmation:value}})).statusCode,400);
 const {hashPassword}=await import('../src/auth/passwords.js');
 const legacy=await hashPassword('既有汉字密码');const now=new Date().toISOString();
 fx.db.db.prepare("INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES ('legacy-han','legacy-han',?,?,?,0,?,?)").run(legacy.hash,legacy.salt,legacy.paramsJson,now,now);
 assert.equal((await fx.app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'legacy-han',password:'既有汉字密码'}})).statusCode,200);
});
