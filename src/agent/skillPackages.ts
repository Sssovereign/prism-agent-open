import { createHash, randomUUID } from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Db } from '../storage/db.js';
import type { SkillPackage } from '../../contracts/skills.js';
import { ApiError } from '../../contracts/errors.js';
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';

export interface InstalledPackage extends SkillPackage { paths: string[] }
const busy = new Set<string>();
function directory(db: Db, userId: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(userId)) throw new Error('Invalid account identifier');
  return join(dirname(db.path), 'skills', userId);
}
export function readSkillPackages(db: Db, userId: string): InstalledPackage[] {
  const file = join(directory(db,userId), 'registry.json');
  if (!existsSync(file)) return [];
  const result: unknown = JSON.parse(readFileSync(file,'utf8'));
  if (!Array.isArray(result) || !result.every(p => p && typeof p.id==='string' && typeof p.source==='string' && Array.isArray(p.paths) && p.paths.every((v:unknown)=>typeof v==='string'))) throw new Error('技能包记录损坏，请从备份恢复。');
  return result as InstalledPackage[];
}
function save(db: Db, userId: string, packages: InstalledPackage[]) {
  const dir=directory(db,userId);mkdirSync(dir,{recursive:true,mode:0o700});
  const temp=join(dir,`registry-${randomUUID()}.tmp`);writeFileSync(temp,JSON.stringify(packages,null,2),{mode:0o600});renameSync(temp,join(dir,'registry.json'));
}
export function normalizeSkillSource(value: unknown): string {
  if (typeof value!=='string' || !value.trim() || value.length>2048 || /[\x00-\x1f]/.test(value)) throw new ApiError('VALIDATION_FAILED','请填写本地绝对路径、Git仓库地址或 npm:包名。');
  let source=value.trim();
  if (source.startsWith('~/')) source=join(homedir(),source.slice(2));
  if (source.startsWith('https://')) {
    const url=new URL(source);
    if (url.username || url.password || url.search || url.hash) throw new ApiError('VALIDATION_FAILED','仓库地址不能携带密码或查询参数。');
    const github=url.hostname==='github.com' ? url.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/.*)?\/?$/) : null;
    if (github && /\/(tree|blob)\//.test(url.pathname)) throw new ApiError('VALIDATION_FAILED','请填写仓库根地址；固定版本使用 git:github.com/作者/仓库@版本。');
    source=`git:${source}`;
  }
  if (!isAbsolute(source) && !source.startsWith('npm:') && !source.startsWith('git:')) throw new ApiError('VALIDATION_FAILED','支持本地绝对路径、HTTPS/Git地址和 npm:包名。');
  if(source.startsWith('git:https://')||source.startsWith('git:http://')){
    const url=new URL(source.slice(4));if(url.username||url.password||url.search||url.hash)throw new ApiError('VALIDATION_FAILED','Git地址不能携带密码或查询参数。');
  }
  if (source.startsWith('git:') && /:\/\/[^/]*@/.test(source)) throw new ApiError('VALIDATION_FAILED','请通过本机Git配置认证，不要在地址中填写密码。');
  return source;
}
async function locked<T>(db: Db,userId:string, action:()=>Promise<T>):Promise<T> {
  const key=resolve(db.path)+':'+userId;if(busy.has(key))throw new ApiError('VALIDATION_FAILED','当前账号正在管理技能包，请稍候。');
  busy.add(key);try{return await action();}finally{busy.delete(key);}
}
export async function installSkillPackage(db: Db,userId:string,value:unknown,updateId?:string,selectedPath?:unknown):Promise<SkillPackage> {
  return locked(db,userId,async()=>{
    const packages=readSkillPackages(db,userId);
    const old=updateId?packages.find(p=>p.id===updateId):undefined;
    if(updateId&&!old)throw new ApiError('NOT_FOUND','技能包不存在');
    if(selectedPath!==undefined&&typeof selectedPath!=='string')throw new ApiError('VALIDATION_FAILED','包内路径必须是文本。');
    const skillPath=old?.skillPath??(typeof selectedPath==='string'?selectedPath.trim().replaceAll('\\','/'):undefined);
    if(skillPath&&(skillPath.length>1024||isAbsolute(skillPath)||skillPath.split('/').some(p=>p==='..'||p==='')||/[\x00-\x1f]/.test(skillPath)))throw new ApiError('VALIDATION_FAILED','包内路径须为相对目录，不可包含..或空路径段。');
    const source=old?.source??normalizeSkillSource(value),id=old?.id??createHash('sha256').update(source+'\n'+(skillPath??'')).digest('hex').slice(0,24);
    if(!updateId&&packages.some(p=>p.id===id))throw new ApiError('VALIDATION_FAILED','该来源已安装，请使用更新。');
    if(!updateId){
      const matching=packages.filter(p=>(p.skillPath??'')===(skillPath??''));
      const settings=SettingsManager.inMemory({packages:matching.map(p=>p.source)});
      const identity=new DefaultPackageManager({cwd:directory(db,userId),agentDir:directory(db,userId),settingsManager:settings});
      identity.addSourceToSettings(source);
      if(settings.getPackages().length<=matching.length)throw new ApiError('VALIDATION_FAILED','同一来源的技能包已安装；请更新或卸载后更换固定版本。');
    }
    const release=join(directory(db,userId),'releases',id,randomUUID());mkdirSync(release,{recursive:true,mode:0o700});
    const result=await new Promise<{skills:Array<{name:string;path:string}>;root?:string}>((done,reject)=>{
      const child=fork(fileURLToPath(new URL('./skillPackageWorker.js',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc'],detached:process.platform!=='win32',env:{...process.env,GIT_TERMINAL_PROMPT:'0',npm_config_update_notifier:'false'}});
      let settled=false;
      const finish=(error?:Error,value?:{skills:Array<{name:string;path:string}>;root?:string})=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else done(value!);};
      const timer=setTimeout(()=>{try{if(process.platform==='win32')child.kill();else if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}finish(new ApiError('VALIDATION_FAILED','技能包安装超时（120秒），原版本保留。'));},120_000);
      child.once('error',e=>finish(e));child.once('exit',code=>{if(!settled)finish(new Error(`技能包安装进程退出：${code}`));});
      child.on('message',(message:any)=>{if(message.ok)finish(undefined,message);else finish(new ApiError('VALIDATION_FAILED',`安装失败：${message.error}`));});
      child.send({source,directory:release,skillPath});
    }).catch(error=>{rmSync(release,{recursive:true,force:true});throw error;});
    let version='local';
    if(result.root){
      try{version=execFileSync('git',['-C',result.root,'rev-parse','HEAD'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).trim();}
      catch{try{version=String(JSON.parse(readFileSync(join(result.root,'package.json'),'utf8')).version??'local');}catch{}}
    }
    const entry:InstalledPackage={id,source,...(skillPath?{skillPath}:{}),installedAt:new Date().toISOString(),version,skills:result.skills.map(s=>s.name),paths:result.skills.map(s=>s.path)};
    // Publish only after Pi has installed and parsed successfully; retain older releases for active runs.
    save(db,userId,[...packages.filter(p=>p.id!==id),entry]);
    const {paths,...dto}=entry;return dto;
  });
}
export async function removeSkillPackage(db: Db,userId:string,id:string):Promise<void> {
  await locked(db,userId,async()=>{
    const packages=readSkillPackages(db,userId);if(!packages.some(p=>p.id===id))throw new ApiError('NOT_FOUND','技能包不存在');
    // Never delete user source directories or releases still referenced by an active task.
    save(db,userId,packages.filter(p=>p.id!==id));
  });
}
