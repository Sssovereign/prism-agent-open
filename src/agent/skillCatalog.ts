import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSkillPackages } from './skillPackages.js';
import { BUILTIN_SKILLS } from '../../contracts/builtinSkills.js';
import type { SkillCatalog, SkillEntry } from '../../contracts/skills.js';
import { loadSkills, loadSkillsFromDir, type Skill } from '@earendil-works/pi-coding-agent';
import type { Db } from '../storage/db.js';

/**
 * 技能目录（块C）：约定目录扫描＋严格校验＋启停入库。
 * 默认用户级 ~/.prism/skills＋项目级 <项目根>/.prism/skills；旧目录兼容读取。
 * 装配只取显式路径（additionalSkillPaths，noSkills 保持关闭默认发现），
 * 监督器侧校验后才下发 runner——不开放 Pi 宿主自动发现。
 */

const MAX_SKILLS = 64;
const MAX_DESCRIPTION = 1024;

export interface SkillDiagnostic {
    severity: 'error' | 'warning';
    code: string;
    skillName?: string;
    path?: string;
    message: string;
}

export type ScannedSkill = Omit<SkillEntry,'enabled'>;
export type SkillsCatalog = SkillCatalog;

export function builtinSkillsRoot(): string {
 const source=fileURLToPath(new URL('../../resources/skills/',import.meta.url));
 return existsSync(source)?source:fileURLToPath(new URL('../../../resources/skills/',import.meta.url));
}

function scanDir(dir: string, scope: SkillEntry['scope'], diagnostics: SkillDiagnostic[]): ScannedSkill[] {
    if (!existsSync(dir)) return [];
    const result = loadSkillsFromDir({ dir, source: scope });
    for (const diagnostic of result.diagnostics) {
        diagnostics.push({
            severity: diagnostic.type === 'error' ? 'error' : 'warning',
            code: diagnostic.type === 'collision' ? 'name_collision' : 'load_failed',
            path: diagnostic.path,
            message: diagnostic.message.slice(0, 300),
        });
    }
    const out: ScannedSkill[] = [];
    for (const skill of result.skills) validateAndPush(skill, scope, diagnostics, out);
    return out;
}

function validateAndPush(skill: Skill, scope: SkillEntry['scope'], diagnostics: SkillDiagnostic[], out: ScannedSkill[]): void {
    // 严格校验：名称规范、description ≤1024（超出按错误剔除，不静默截断——装配清单是给模型的事实）
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(skill.name)) {
        diagnostics.push({ severity: 'error', code: 'invalid_name', skillName: skill.name.slice(0, 64), path: skill.filePath, message: '技能名称仅限小写字母数字连字符下划线（≤64字符）' });
        return;
    }
    const description = (skill.description ?? '').trim();
    if (description.length > MAX_DESCRIPTION) {
        diagnostics.push({ severity: 'error', code: 'description_too_long', skillName: skill.name, path: skill.filePath, message: `description 超过 ${MAX_DESCRIPTION} 字符` });
        return;
    }
    if (!description) {
        diagnostics.push({ severity: 'warning', code: 'no_description', skillName: skill.name, path: skill.filePath, message: '缺少 description，模型触发不可靠' });
    }
    out.push({
        name: skill.name,
        description,
        path: skill.filePath,
        baseDir: skill.baseDir,
        scope, origin: scope==='builtin'?'builtin':'directory',
        ...(scope==='builtin'?BUILTIN_SKILLS[skill.name]:{}),
        disableModelInvocation: skill.disableModelInvocation,
    });
}

export function getSkillsCatalog(db: Db, userId: string, workspaceRoot?: string): SkillsCatalog {
    const diagnostics: SkillDiagnostic[] = [];
    // Project definitions override personal definitions; the native directory wins within each scope.
    const managed: ScannedSkill[]=[];
    let packages: ReturnType<typeof readSkillPackages>=[];
    try {
      packages=readSkillPackages(db,userId);
      for(const pkg of packages){
        const result=loadSkills({cwd:process.cwd(),agentDir:process.cwd(),includeDefaults:false,skillPaths:pkg.paths});
        for(const d of result.diagnostics)diagnostics.push({severity:d.type==='error'?'error':'warning',code:'package_skill_diagnostic',path:d.path,message:d.message.slice(0,300)});
        const parsed:ScannedSkill[]=[];
        for(const skill of result.skills)validateAndPush(skill,'user',diagnostics,parsed);
        managed.push(...parsed.map(skill=>({...skill,origin:'package' as const,packageId:pkg.id,source:pkg.source})));
      }
    }catch(e){diagnostics.push({severity:'error',code:'package_registry_failed',message:e instanceof Error?e.message:'技能包读取失败'});}
    const candidates = [
        ...(workspaceRoot ? scanDir(join(workspaceRoot, '.prism', 'skills'), 'workspace', diagnostics) : []),
        ...(workspaceRoot ? scanDir(join(workspaceRoot, '.agents', 'skills'), 'workspace', diagnostics) : []),
        ...(workspaceRoot ? scanDir(join(workspaceRoot, '.pi', 'skills'), 'workspace', diagnostics) : []),
        ...(workspaceRoot ? scanDir(join(workspaceRoot, '.zcode', 'skills'), 'workspace', diagnostics) : []),
        ...managed,
        ...scanDir(join(homedir(), '.prism', 'skills'), 'user', diagnostics),
        ...scanDir(join(homedir(), '.agents', 'skills'), 'user', diagnostics),
        ...scanDir(join(homedir(), '.pi', 'agent', 'skills'), 'user', diagnostics),
        ...scanDir(join(homedir(), '.zcode', 'skills'), 'user', diagnostics),
        ...scanDir(builtinSkillsRoot(), 'builtin', diagnostics),
    ];
    const scanned: ScannedSkill[] = [], names = new Set<string>(), paths = new Set<string>();
    for (const skill of candidates) {
        const path = realpathSync(skill.path);
        if (paths.has(path)) continue;
        paths.add(path);
        if (names.has(skill.name)) {
            diagnostics.push({severity:'warning',code:'name_shadowed',skillName:skill.name,path:skill.path,message:'同名技能已使用优先级更高的目录版本'});
            continue;
        }
        names.add(skill.name);scanned.push(skill);
    }
    if (scanned.length > MAX_SKILLS) {
        diagnostics.push({ severity: 'warning', code: 'too_many_skills', message: `技能数量超过上限 ${MAX_SKILLS}，仅装配前 ${MAX_SKILLS} 个` });
    }
    const limited = scanned.slice(0, MAX_SKILLS);
    const stateRows = db.db.prepare('SELECT skill_name, enabled FROM skills_state WHERE user_id=?').all(userId) as Array<{ skill_name: string; enabled: number }>;
    const stateByName = new Map(stateRows.map(row => [row.skill_name, !!row.enabled]));
    return {
        skills: limited.map(skill => ({ ...skill, enabled: stateByName.get(skill.name) ?? true })),
        diagnostics,
        packages:packages.map(({paths,...entry})=>entry),
    };
}

export function setSkillEnabled(db: Db, userId: string, name: string, enabled: boolean): { name: string; enabled: boolean } {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('技能名称不合法');
    const now = new Date().toISOString();
    db.db.prepare(`INSERT INTO skills_state(user_id,skill_name,enabled,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(user_id,skill_name) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`)
        .run(userId, name, enabled ? 1 : 0, now);
    return { name, enabled };
}

/** bootstrap 装配：仅已启用技能的目录（显式路径下发，runner 不做宿主自动发现）。 */
export function collectEnabledSkillPaths(db: Db, userId: string, workspaceRoot: string): Array<{ name: string; path: string; baseDir: string; scope: SkillEntry['scope'] }> {
    return getSkillsCatalog(db, userId, workspaceRoot).skills
        .filter(skill => skill.enabled)
        .map(({ name, path, baseDir, scope }) => ({ name, path, baseDir, scope }));
}
