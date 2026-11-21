import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GrantRow } from '../src/files/picker.js';
import { resolveAgentPath, toolReadFile, toolListDir, toolGrep } from '../src/agent/toolExec.js';

test('本机文件工具：绝对路径、父目录、目录外软链可访问；旧排除和只读标记不充当访问边界', async t => {
 const base=mkdtempSync(join(tmpdir(),'agent-paths-'));
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 const root=join(base,'project'), outside=join(base,'other');
 mkdirSync(root);mkdirSync(outside);
 writeFileSync(join(outside,'外部.txt'),'outside-marker');
 writeFileSync(join(root,'excluded.txt'),'local-marker');
 symlinkSync(outside,join(root,'link'));
 symlinkSync(outside,join(outside,'cycle'));
 const grant:GrantRow={id:'test',project_id:'test',canonical_root:root,access:'read',revision:1,selected_by:'test',revoked_at:null,excludes_json:'["excluded.txt"]',created_at:'',updated_at:'',is_primary:0};
 for(const path of [join(outside,'外部.txt'),'../other/外部.txt','link/外部.txt']){
  assert.ok((await toolReadFile(grant,{path})).content.includes('outside-marker'));
 }
 assert.ok((await toolReadFile(grant,{path:'excluded.txt'})).content.includes('local-marker'));
 assert.ok((await toolListDir(grant,{path:outside})).entries.some(e=>e.name==='外部.txt'));
 assert.ok((await toolListDir(grant,{path:'.'})).entries.some(e=>e.name==='link'&&e.type==='directory'));
 const matches=await toolGrep(grant,{path:'link',pattern:'outside-marker'});
 assert.equal(matches.matches.length,1,'软链环不能无限遍历或重复结果');
 assert.equal((await toolGrep(grant,{path:join(outside,'外部.txt'),pattern:'outside-marker'})).matches.length,1);
 assert.equal(resolveAgentPath(root,'/'),'/','/表示系统根而非项目根');
 assert.throws(()=>resolveAgentPath(root,'bad\0path'));
});
