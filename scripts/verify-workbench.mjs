// Isolated manual/API verification server; synthetic account and no persisted API key.
import { buildWorkbench } from '../dist/src/workbench.js';
import { hashPassword } from '../dist/src/auth/passwords.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const dataDir = mkdtempSync(join(tmpdir(), 'prism-verify-data-'));
const readRoot = mkdtempSync(join(tmpdir(), 'prism-verify-read-'));
const writeRoot = mkdtempSync(join(tmpdir(), 'prism-verify-project-'));
const workbench = await buildWorkbench(dataDir);
const p = workbench.product;
const pw = await hashPassword('PrismCheck2026!'), now = new Date().toISOString(), uid=randomUUID();
p.db.db.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)').run(uid,'prism-check',pw.hash,pw.salt,pw.paramsJson,now,now);
for(const [name,root,access] of [['test项目',readRoot,'read'],['隔离项目B',writeRoot,'write']]) {
 const id=randomUUID();
 p.db.db.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(id,uid,name,now,now);
 p.db.db.prepare("INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,excludes_json,created_at,updated_at) VALUES (?,?,?,?,1,?,'[]',?,?)").run(randomUUID(),id,root,access,uid,now,now);
}
const { server } = workbench;
await new Promise(resolve=>server.listen(4393,'127.0.0.1',resolve));
console.log('Verification server ready on 4393; synthetic login prism-check.');
async function stop(){await workbench.close();rmSync(dataDir,{recursive:true,force:true});rmSync(readRoot,{recursive:true,force:true});rmSync(writeRoot,{recursive:true,force:true});}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
