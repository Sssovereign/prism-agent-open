import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DefaultResourceLoader,SettingsManager,formatSkillsForPrompt} from '@earendil-works/pi-coding-agent';
import {Db} from '../src/storage/db.js';
import {migrate} from '../src/storage/migrate.js';
import {installSkillPackage,removeSkillPackage,readSkillPackages,normalizeSkillSource} from '../src/agent/skillPackages.js';
import {SKILL_PACKAGE_CATALOG,SKILL_PACKAGE_CATALOG_UPDATED_AT} from '../src/agent/skillPackageCatalog.js';
import {getSkillsCatalog,collectEnabledSkillPaths,setSkillEnabled} from '../src/agent/skillCatalog.js';
import {buildProductApp} from '../src/app.js';

function fixture(t:{after(fn:()=>unknown):unknown}){
 const dir=mkdtempSync(join(tmpdir(),'prism-package-test-')),source=join(dir,'source'),db=new Db(join(dir,'data','db.sqlite')),user=randomUUID();migrate(db);mkdirSync(source);
 const originalHome=process.env.HOME;process.env.HOME=join(dir,'home');
 t.after(()=>{if(originalHome===undefined)delete process.env.HOME;else process.env.HOME=originalHome;});
 const now=new Date().toISOString();db.db.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(user,'skills','x','x','{}',now,now);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});return{dir,source,db,user};
}
function skill(root:string,name:string,body='VERSION_ONE',manual=false){
 const path=join(root,name);mkdirSync(path,{recursive:true});writeFileSync(join(path,'SKILL.md'),`---\nname: ${name}\ndescription: synthetic skill for integration verification\n${manual?'disable-model-invocation: true\n':''}---\n${body}\n`);return path;
}

test('Pi package resources: install by account, exact paths, manual-only, disable, update and unregister preserve source and old snapshot',async t=>{
 const {dir,source,db,user}=fixture(t),other=randomUUID();
 writeFileSync(join(source,'package.json'),JSON.stringify({name:'synthetic-pi-skills',version:'1.0.0',pi:{skills:['skills/*/SKILL.md'],extensions:['extension.js']}}));
 writeFileSync(join(source,'extension.js'),`throw new Error('MUST_NOT_EXECUTE_EXTENSION')`);
 const one=skill(join(source,'skills'),'package-demo'),manual=skill(join(source,'skills'),'manual-demo','MANUAL_BODY',true);
 const installed=await installSkillPackage(db,user,source);assert.deepEqual(installed.skills.sort(),['manual-demo','package-demo']);assert.equal(installed.version,'1.0.0');assert.equal(readSkillPackages(db,other).length,0);
 const catalog=getSkillsCatalog(db,user);assert.ok(catalog.skills.some(s=>s.name==='package-demo'&&s.origin==='package'));assert.ok(!getSkillsCatalog(db,other).skills.some(s=>s.name==='package-demo'));
 const oldPath=catalog.skills.find(s=>s.name==='package-demo')!.path;assert.notEqual(oldPath,join(one,'SKILL.md'));
 assert.match(readFileSync(oldPath,'utf8'),/VERSION_ONE/);assert.ok(catalog.skills.find(s=>s.name==='manual-demo')!.disableModelInvocation);
 const loader=new DefaultResourceLoader({cwd:dir,agentDir:join(dir,'loader'),settingsManager:SettingsManager.inMemory({}),noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,additionalSkillPaths:collectEnabledSkillPaths(db,user,dir).map(s=>s.path)});await loader.reload();
 assert.ok(loader.getSkills().skills.some(s=>s.name==='manual-demo'));assert.ok(!formatSkillsForPrompt(loader.getSkills().skills).includes('manual-demo'));
 setSkillEnabled(db,user,'package-demo',false);assert.ok(!collectEnabledSkillPaths(db,user,dir).some(s=>s.name==='package-demo'));
 skill(join(source,'skills'),'package-demo','VERSION_TWO');await installSkillPackage(db,user,undefined,installed.id);
 const after=getSkillsCatalog(db,user).skills.find(s=>s.name==='package-demo')!;assert.equal(after.enabled,false);assert.match(readFileSync(after.path,'utf8'),/VERSION_TWO/);assert.match(readFileSync(oldPath,'utf8'),/VERSION_ONE/);
 await assert.rejects(removeSkillPackage(db,other,installed.id),/不存在/);
 await removeSkillPackage(db,user,installed.id);assert.ok(!getSkillsCatalog(db,user).skills.some(s=>s.name==='package-demo'));assert.ok(existsSync(join(one,'SKILL.md'))&&existsSync(join(manual,'SKILL.md'))&&existsSync(oldPath));
});

test('Direct SKILL.md import uses Pi parser; failed update leaves last good version and manifest untouched',async t=>{
 const {source,db,user}=fixture(t);const direct=skill(source,'direct-demo');const installed=await installSkillPackage(db,user,direct),previous=readSkillPackages(db,user);
 writeFileSync(join(direct,'SKILL.md'),'not a valid skill');await assert.rejects(installSkillPackage(db,user,undefined,installed.id),/未发现有效技能/);assert.deepEqual(readSkillPackages(db,user),previous);assert.match(readFileSync(previous[0]!.paths[0]!,'utf8'),/VERSION_ONE/);
 await assert.rejects(installSkillPackage(db,user,direct),/已安装/);
});

test('Native skills are present without third-party installs; builtins disabled explicitly are absent from Pi resources',async t=>{
 const {dir,db,user}=fixture(t);const catalog=getSkillsCatalog(db,user);assert.equal(catalog.skills.filter(s=>s.scope==='builtin').length,8);assert.ok(!catalog.diagnostics.some(d=>d.severity==='error'));setSkillEnabled(db,user,'pdf',false);
 const loader=new DefaultResourceLoader({cwd:dir,agentDir:join(dir,'loader'),settingsManager:SettingsManager.inMemory({}),noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,additionalSkillPaths:collectEnabledSkillPaths(db,user,dir).map(s=>s.path)});await loader.reload();assert.ok(loader.getSkills().skills.some(s=>s.name==='docx'));assert.ok(!loader.getSkills().skills.some(s=>s.name==='pdf'));
});

test('Skill package API authenticates writes and keeps account installation lists independent',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'prism-package-api-')),source=skill(dir,'route-skill'),fx=buildProductApp(join(dir,'data'),{serveWeb:false});t.after(async()=>{await fx.app.close();rmSync(dir,{recursive:true,force:true});});
 const account=async(name:string)=>{const r=await fx.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{username:name,password:'SyntheticSkill2026!',confirmation:'SyntheticSkill2026!'}});assert.equal(r.statusCode,201);return {cookie:String(r.headers['set-cookie']).split(';')[0]!,csrf:r.json().data.csrfToken};};
 const a=await account('skill-account-a'),b=await account('skill-account-b');const headers={cookie:a.cookie,'x-csrf-token':a.csrf};
 assert.equal((await fx.app.inject({method:'POST',url:'/api/v1/skills/packages',headers:{cookie:a.cookie},payload:{source}})).statusCode,403);
 const r=await fx.app.inject({method:'POST',url:'/api/v1/skills/packages',headers,payload:{source}});assert.equal(r.statusCode,200,r.body);const id=r.json().data.id;
 assert.equal((await fx.app.inject({url:'/api/v1/skills',headers:{cookie:b.cookie}})).json().data.packages.length,0);
 const listed=await fx.app.inject({url:'/api/v1/skills/packages',headers:{cookie:a.cookie}});assert.equal(listed.statusCode,200);assert.equal(listed.json().data.length,1);assert.equal(listed.json().data[0].source,source);
 assert.equal((await fx.app.inject({url:'/api/v1/skills/packages',headers:{cookie:b.cookie}})).json().data.length,0);
 assert.equal((await fx.app.inject({method:'DELETE',url:`/api/v1/skills/packages/${id}`,headers:{cookie:b.cookie,'x-csrf-token':b.csrf}})).statusCode,404);
 assert.equal((await fx.app.inject({method:'DELETE',url:`/api/v1/skills/packages/${id}`,headers})).statusCode,200);
 assert.equal((await fx.app.inject({url:'/api/v1/skills/packages',headers:{cookie:a.cookie}})).json().data.length,0);
});

test('Source forms follow Pi npm/git/local conventions without persisting embedded credentials',()=>{
 assert.equal(normalizeSkillSource('https://github.com/vercel-labs/agent-skills'),'git:https://github.com/vercel-labs/agent-skills');assert.equal(normalizeSkillSource('npm:@example/skills@1.2.3'),'npm:@example/skills@1.2.3');assert.throws(()=>normalizeSkillSource('https://user:secret@github.com/a/b'),/密码/);assert.throws(()=>normalizeSkillSource('https://github.com/a/b/tree/main/skills/demo'),/根地址/);assert.throws(()=>normalizeSkillSource('../somewhere'),/绝对路径/);
});

test('Pi upstream Git and npm installers use real local transports; pinned version and package identity are recorded',async t=>{
 const {dir,source,db,user}=fixture(t);
 const {execFileSync}=await import('node:child_process');const {createServer}=await import('node:http');
 const git=(...args:string[])=>execFileSync('git',args,{stdio:'ignore'});
 const work=join(dir,'git-work'),httpRoot=join(dir,'http'),repo=join(httpRoot,'fixtures','skills.git');mkdirSync(work);mkdirSync(join(httpRoot,'fixtures'),{recursive:true});skill(join(work,'skills'),'git-demo');
 git('init',work);git('-C',work,'add','.');git('-C',work,'-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-m','fixture');git('clone','--bare',work,repo);git('-C',repo,'update-server-info');
 const pack=join(dir,'pack'),packageRoot=join(pack,'package');mkdirSync(packageRoot,{recursive:true});skill(join(packageRoot,'skills'),'npm-demo');writeFileSync(join(packageRoot,'package.json'),JSON.stringify({name:'prism-skill-fixture',version:'1.0.0',pi:{skills:['skills/*/SKILL.md']}}));const tgz=join(dir,'fixture.tgz');execFileSync('tar',['-czf',tgz,'-C',pack,'package']);
 let base='';const {resolve,relative}=await import('node:path');const server=createServer((req,res)=>{
  const path=new URL(req.url??'/',base).pathname;
  if(path==='/prism-skill-fixture'){res.setHeader('content-type','application/json');res.end(JSON.stringify({name:'prism-skill-fixture','dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name:'prism-skill-fixture',version:'1.0.0',dist:{tarball:base+'/fixture.tgz'}}}}));return;}
  if(path==='/fixture.tgz'){res.end(readFileSync(tgz));return;}
  const file=resolve(httpRoot,'.'+path);if(relative(httpRoot,file).startsWith('..')||!existsSync(file)){res.statusCode=404;res.end();return;}
  try{res.setHeader('content-type','text/plain');res.end(readFileSync(file));}catch{res.statusCode=404;res.end();}
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const gitPackage=await installSkillPackage(db,user,`git:${base}/fixtures/skills.git`);assert.deepEqual(gitPackage.skills,['git-demo']);assert.match(gitPackage.version,/^[a-f0-9]{40}$/);
 const vars={npm_config_registry:base,npm_config_cache:join(dir,'npm-cache'),npm_config_audit:'false',npm_config_fund:'false'};const previous=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));Object.assign(process.env,vars);
 try{const npmPackage=await installSkillPackage(db,user,'npm:prism-skill-fixture@1.0.0');assert.deepEqual(npmPackage.skills,['npm-demo']);assert.equal(npmPackage.version,'1.0.0');await assert.rejects(installSkillPackage(db,user,'npm:prism-skill-fixture@2.0.0'),/同一来源/);}
 finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
 assert.ok(getSkillsCatalog(db,user).skills.some(s=>s.name==='git-demo'));assert.ok(getSkillsCatalog(db,user).skills.some(s=>s.name==='npm-demo'));assert.ok(existsSync(source));
});

test('Selected package subdirectory supports hidden third-party libraries, excludes unrelated skills and validates paths',async t=>{
 const {source,db,user}=fixture(t);skill(join(source,'skills','.curated'),'chosen-demo');skill(join(source,'skills'),'not-chosen');
 const entry=await installSkillPackage(db,user,source,undefined,'skills/.curated/chosen-demo');assert.deepEqual(entry.skills,['chosen-demo']);assert.equal(entry.skillPath,'skills/.curated/chosen-demo');
 assert.ok(!getSkillsCatalog(db,user).skills.some(s=>s.name==='not-chosen'));await assert.rejects(installSkillPackage(db,user,source,undefined,'../outside'),/相对目录/);
});

test('Package catalog lists verified normalized sources, derives per-account installed state and requires auth',async t=>{
 const {dir,db}=fixture(t),fx=buildProductApp(join(dir,'data'),{serveWeb:false});t.after(async()=>{await fx.app.close();});
 const account=async(name:string)=>{const r=await fx.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{username:name,password:'SyntheticSkill2026!',confirmation:'SyntheticSkill2026!'}});assert.equal(r.statusCode,201);return {id:r.json().data.user.id as string,cookie:String(r.headers['set-cookie']).split(';')[0]!};};
 const a=await account('catalog-reader-a');
 assert.equal((await fx.app.inject({url:'/api/v1/skills/packages/catalog'})).statusCode,401);
 const list=await fx.app.inject({url:'/api/v1/skills/packages/catalog',headers:{cookie:a.cookie}});
 assert.equal(list.statusCode,200,list.body);
 const payload=list.json().data as {updatedAt:string;entries:Array<{name:string;source:string;installed:boolean}>};
 assert.equal(payload.updatedAt,SKILL_PACKAGE_CATALOG_UPDATED_AT);assert.ok(payload.entries.length>=3);
 for(const entry of payload.entries)assert.equal(entry.source,normalizeSkillSource(entry.source),'目录来源返回时必须是归一化形态');
 // installed 按账号安装记录派生：直接写入账号 registry 模拟既有安装，未安装账号保持 false。
 const target=payload.entries[0]!;
 const registryDir=join(dirname(db.path),'skills',a.id);mkdirSync(registryDir,{recursive:true});
 writeFileSync(join(registryDir,'registry.json'),JSON.stringify([{id:'catalog-match',source:target.source,installedAt:new Date().toISOString(),version:'catalog-test',skills:['demo'],paths:['demo/SKILL.md']}]));
 const again=await fx.app.inject({url:'/api/v1/skills/packages/catalog',headers:{cookie:a.cookie}});
 const entries=again.json().data as typeof payload;
 assert.equal(entries.entries.find(e=>e.name===target.name)!.installed,true);
 assert.ok(entries.entries.filter(e=>e.name!==target.name).every(e=>!e.installed));
});
