import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import { getSkillsCatalog, setSkillEnabled, collectEnabledSkillPaths } from '../src/agent/skillCatalog.js';
import { hashPassword } from '../src/auth/passwords.js';
import { Db } from '../src/storage/db.js';
import { migrate, defaultMigrationsDir } from '../src/storage/migrate.js';

/** 块C（Skills）：约定目录扫描、严格校验、启停入库、显式装配路径、路由。 */

const USER = '01234567-89ab-4def-8901-234567890abc';

function tempDb(): { db: Db; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'prism-skills-'));
    const db = new Db(join(dir, 'db.sqlite'));
    migrate(db, defaultMigrationsDir());
    db.tx(tx => tx.prepare("INSERT INTO users(id,username,password_hash,password_salt,password_params_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(USER, 'skiller', 'x', 's', '{}', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z'));
    return { db, dir };
}

function makeSkillDir(root: string, name: string, frontmatter: string, body = '按说明执行。'): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
    return dir;
}

test('skillCatalog: 扫描用户级与项目级目录，校验剔除非法条目并记诊断', () => {
    const home = mkdtempSync(join(tmpdir(), 'prism-skills-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'prism-skills-ws-'));
    const { db, dir } = tempDb();
    try {
        mkdirSync(join(home, '.prism', 'skills'), { recursive: true });
        mkdirSync(join(workspace, '.prism', 'skills'), { recursive: true });
        makeSkillDir(join(home, '.prism', 'skills'), 'echo-skill', 'name: echo-skill\ndescription: 原样回显文本');
        makeSkillDir(join(workspace, '.prism', 'skills'), 'ws-analysis', 'name: ws-analysis\ndescription: 项目级分析示例');
        // 非法：名称大写
        makeSkillDir(join(home, '.prism', 'skills'), 'BadName', 'name: BadName\ndescription: x');
        // 非法：description 超长
        makeSkillDir(join(home, '.prism', 'skills'), 'too-long', `name: too-long\ndescription: ${'长'.repeat(1025)}`);

        const originalHome = process.env.HOME;
        process.env.HOME = home;
        try {
            const catalog = getSkillsCatalog(db, USER, workspace);
            const names = catalog.skills.filter(s=>s.scope!=='builtin').map(s => s.name).sort();
            assert.deepEqual(names, ['echo-skill', 'ws-analysis']);
            assert.equal(catalog.skills.find(s => s.name === 'echo-skill')!.scope, 'user');
            assert.equal(catalog.skills.find(s => s.name === 'ws-analysis')!.scope, 'workspace');
            // 默认启用
            assert.ok(catalog.skills.every(s => s.enabled));
            const codes = catalog.diagnostics.map(d => d.code).sort();
            assert.ok(codes.includes('invalid_name'), `诊断应含 invalid_name：${JSON.stringify(codes)}`);
            assert.ok(codes.includes('description_too_long'), `诊断应含 description_too_long：${JSON.stringify(codes)}`);
        } finally {
            if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
        }
    } finally {
        db.close();
        rmSync(home, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
    }
});

test('skillCatalog: 启停入库持久化并驱动显式装配路径', () => {
    const home = mkdtempSync(join(tmpdir(), 'prism-skills-home2-'));
    const workspace = mkdtempSync(join(tmpdir(), 'prism-skills-ws2-'));
    const { db, dir } = tempDb();
    try {
        mkdirSync(join(home, '.prism', 'skills'), { recursive: true });
        makeSkillDir(join(home, '.prism', 'skills'), 'alpha', 'name: alpha\ndescription: A');
        makeSkillDir(join(home, '.prism', 'skills'), 'beta', 'name: beta\ndescription: B\ndisable-model-invocation: true');
        const originalHome = process.env.HOME;
        process.env.HOME = home;
        try {
            setSkillEnabled(db, USER, 'alpha', false);
            // 重开数据库验证持久化
            const catalog = getSkillsCatalog(db, USER, workspace);
            assert.equal(catalog.skills.find(s => s.name === 'alpha')!.enabled, false);
            assert.equal(catalog.skills.find(s => s.name === 'beta')!.enabled, true);
            const paths = collectEnabledSkillPaths(db, USER, workspace);
            assert.deepEqual(paths.filter(p=>p.scope!=='builtin').map(p => p.name), ['beta'], '仅已启用技能进入装配');
            assert.ok(paths[0]!.baseDir.endsWith('beta'));
            // 未知名称也允许入库（目录稍后放置即生效）
            setSkillEnabled(db, USER, 'future-skill', false);
            assert.equal(collectEnabledSkillPaths(db, USER, workspace).filter(p=>p.scope!=='builtin').length, 1);
            assert.throws(() => setSkillEnabled(db, USER, 'BAD NAME', true), /不合法/);
        } finally {
            if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
        }
    } finally {
        db.close();
        rmSync(home, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
    }
});

test('skillRoutes: 未登录401；启停与扫描可经API访问', async () => {
    const home = mkdtempSync(join(tmpdir(), 'prism-skills-home3-'));
    mkdirSync(join(home, '.prism', 'skills'), { recursive: true });
    makeSkillDir(join(home, '.prism', 'skills'), 'route-demo', 'name: route-demo\ndescription: 路由测试');
    const dir = mkdtempSync(join(tmpdir(), 'prism-skills-routes-'));
    try {
        const originalHome = process.env.HOME;
        process.env.HOME = home;
        try {
            const fx = buildProductApp(dir, { serveWeb: false });
            const anon = await fx.app.inject({ method: 'GET', url: '/api/v1/skills' });
            assert.equal(anon.statusCode, 401);
            const record = await hashPassword('correct-horse-battery');
            const uid = randomUUID();
            const now = new Date().toISOString();
            fx.db.tx(tx => tx.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
                .run(uid, 'skilluser', record.hash, record.salt, record.paramsJson, now, now));
            const login = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'skilluser', password: 'correct-horse-battery' } });
            assert.equal(login.statusCode, 200);
            const raw = login.headers['set-cookie'];
            const cookie = (Array.isArray(raw) ? String(raw[0]) : String(raw)).split(';')[0]!;
            const authHeaders = { cookie, 'x-csrf-token': (login.json() as { data: { csrfToken: string } }).data.csrfToken };
            const list = await fx.app.inject({ method: 'GET', url: '/api/v1/skills', headers: { cookie } });
            assert.equal(list.statusCode, 200);
            const catalog = (list.json() as { data: { skills: Array<{ name: string; enabled: boolean; scope: string }> } }).data;
            const demo = catalog.skills.find(s => s.name === 'route-demo');
            assert.ok(demo, '应发现 route-demo');
            assert.equal(demo!.enabled, true);
            assert.equal(demo!.scope, 'user');
            const pid=randomUUID(),workspace=join(dir,'project');mkdirSync(workspace);
            makeSkillDir(join(workspace,'.prism','skills'),'workspace-demo','name: workspace-demo\ndescription: 项目技能');
            fx.db.db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(pid,uid,'skills',now,now);
            fx.db.db.prepare("INSERT INTO workspace_grants(id,project_id,canonical_root,access,selected_by,excludes_json,created_at,updated_at) VALUES (?,?,?,'write',?,'[]',?,?)").run(randomUUID(),pid,workspace,uid,now,now);
            const workspaceList=await fx.app.inject({url:`/api/v1/skills?projectId=${pid}`,headers:{cookie}});assert.equal(workspaceList.statusCode,200);assert.ok(workspaceList.json().data.skills.some((s:{name:string;scope:string})=>s.name==='workspace-demo'&&s.scope==='workspace'));
            const unavailable=await fx.app.inject({url:`/api/v1/skills?projectId=${randomUUID()}`,headers:{cookie}});assert.equal(unavailable.statusCode,404);
            // 停止→再查
            const put = await fx.app.inject({ method: 'PUT', url: '/api/v1/skills/route-demo/enabled', headers: authHeaders, payload: { enabled: false } });
            assert.equal(put.statusCode, 200);
            const list2 = await fx.app.inject({ method: 'GET', url: '/api/v1/skills', headers: { cookie } });
            const demo2 = (list2.json() as { data: { skills: Array<{ name: string; enabled: boolean }> } }).data.skills.find(s => s.name === 'route-demo');
            assert.equal(demo2!.enabled, false);
            // 非布尔 body 拒绝
            const bad = await fx.app.inject({ method: 'PUT', url: '/api/v1/skills/route-demo/enabled', headers: authHeaders, payload: { enabled: 'yes' } });
            assert.equal(bad.statusCode, 400);
            fx.app.close();
        } finally {
            if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
        }
    } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
    }
});


test('skillCatalog: 新目录优先、项目覆盖个人、旧目录兼容去重且沿用启停状态',()=>{
 const home=mkdtempSync(join(tmpdir(),'prism-skills-native-')),workspace=mkdtempSync(join(tmpdir(),'prism-skills-native-ws-')),{db,dir}=tempDb(),originalHome=process.env.HOME;
 try{
  process.env.HOME=home;
  for(const [base,namespace,name,description] of [[home,'.zcode','shared','legacy-user'],[home,'.prism','shared','native-user'],[workspace,'.zcode','shared','legacy-project'],[workspace,'.prism','shared','native-project'],[home,'.zcode','legacy-only','legacy'],[home,'.prism','user-native','native']])makeSkillDir(join(base!,namespace!,'skills'),name!,`name: ${name}\ndescription: ${description}`);
  let catalog=getSkillsCatalog(db,USER,workspace);assert.equal(catalog.skills.filter(s=>s.name==='shared').length,1);assert.equal(catalog.skills.find(s=>s.name==='shared')!.description,'native-project');assert.ok(catalog.skills.some(s=>s.name==='legacy-only'));assert.ok(catalog.skills.some(s=>s.name==='user-native'));
  setSkillEnabled(db,USER,'shared',false);assert.ok(!collectEnabledSkillPaths(db,USER,workspace).some(s=>s.name==='shared'));
  const personal=getSkillsCatalog(db,USER);assert.equal(personal.skills.find(s=>s.name==='shared')!.description,'native-user');
 }finally{if(originalHome===undefined)delete process.env.HOME;else process.env.HOME=originalHome;db.close();rmSync(home,{recursive:true,force:true});rmSync(workspace,{recursive:true,force:true});rmSync(dir,{recursive:true,force:true});}
});
