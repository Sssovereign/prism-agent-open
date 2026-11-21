// Pi installs in a short-lived process so stalled Git/npm operations can be stopped as a group.
import { mkdirSync, existsSync, readdirSync, lstatSync, copyFileSync, realpathSync } from 'node:fs';
import { join, isAbsolute, dirname, relative, sep } from 'node:path';
import { DefaultPackageManager, SettingsManager, loadSkills } from '@earendil-works/pi-coding-agent';

process.once('message', async (input: { source: string; directory: string; skillPath?: string }) => {
  try {
    const cwd = join(input.directory, 'workspace'), agentDir = join(input.directory, 'pi');
    mkdirSync(cwd, { recursive: true }); mkdirSync(agentDir, { recursive: true });
    let source=input.source;
    if(isAbsolute(source)) {
      const original=realpathSync(source),snapshot=join(input.directory,'source');let files=0,bytes=0;
      if(!existsSync(join(original,'SKILL.md'))&&!existsSync(join(original,'skills'))&&!existsSync(join(original,'package.json')))throw new Error('本地目录须包含SKILL.md、skills/或Pi包声明。');
      const copy=(from:string,to:string)=>{mkdirSync(to,{recursive:true});for(const entry of readdirSync(from,{withFileTypes:true})){
        if(['.git','node_modules','.cache','.data'].includes(entry.name))continue;
        const a=join(from,entry.name),b=join(to,entry.name),stat=lstatSync(a);
        if(stat.isSymbolicLink())throw new Error('本地技能包包含符号链接，请改用自包含的普通文件目录。');
        if(stat.isDirectory())copy(a,b);else if(stat.isFile()){
          if(++files>20000||(bytes+=stat.size)>64*1024*1024)throw new Error('本地技能包超过20000文件或64MB限制。');
          copyFileSync(a,b);
        }
      }};
      copy(original,snapshot);source=snapshot;
    }
    const direct = isAbsolute(source) && existsSync(join(source, 'SKILL.md'));
    const settingsManager = SettingsManager.inMemory(direct ? { skills: [join(source, 'SKILL.md')] } : {
      packages: [{ source, extensions: [], prompts: [], themes: [] }],
    });
    const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    if (!direct) await manager.install(source);
    const root=direct?source:manager.getInstalledPath(source,'user');
    if(!root)throw new Error('无法定位安装后的技能包');
    const resources = input.skillPath ? undefined : await manager.resolve(() => Promise.resolve('error'));
    if (resources?.installFailures?.length) throw new Error(resources.installFailures[0]!.message);
    const paths = input.skillPath ? [join(root,input.skillPath)] : resources!.skills.filter(r => r.enabled && (direct || r.metadata.origin === 'package')).map(r => r.path);
    const result = loadSkills({ cwd, agentDir, skillPaths: paths, includeDefaults: false });
    if (!result.skills.length) throw new Error('来源中未发现有效技能；请提供 SKILL.md 目录、skills/ 仓库或声明 pi.skills 的包。');
    if (result.skills.length > 64) throw new Error('单个包最多安装64个技能，请选择更小的技能包。');
    for(const skill of result.skills){const rel=relative(realpathSync(root),realpathSync(skill.filePath));if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('技能入口不能指向包目录以外。');}
    process.send?.({ ok: true, skills: result.skills.map(s => ({ name: s.name, path: s.filePath, baseDir: dirname(s.filePath) })), root });
  } catch (e) { process.send?.({ ok: false, error: e instanceof Error ? e.message.slice(0, 1000) : '安装失败' }); }
  finally { process.disconnect(); }
});
