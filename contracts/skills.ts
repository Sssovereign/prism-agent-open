export interface SkillPackage {
  id: string;
  source: string;
  skillPath?: string;
  installedAt: string;
  version: string;
  skills: string[];
}

export interface SkillEntry {
  name: string;
  description: string;
  path: string;
  baseDir: string;
  scope: 'user' | 'workspace' | 'builtin';
  origin: 'directory' | 'package' | 'builtin';
  displayName?: string;
  icon?: string;
  packageId?: string;
  source?: string;
  disableModelInvocation: boolean;
  enabled: boolean;
}

export interface SkillDiagnostic { severity: 'error' | 'warning'; code: string; skillName?: string; path?: string; message: string }
export interface SkillCatalog { skills: SkillEntry[]; diagnostics: SkillDiagnostic[]; packages: SkillPackage[] }

export interface SkillCatalogPublisher { name: string; url?: string }

/** 推荐技能包条目：形态参考 ZCode 官方市场清单，来源收敛为棱镜可安装的 git/npm 通道。 */
export interface SkillCatalogEntry {
  name: string;
  /** HTTPS GitHub 仓库地址或 npm: 包名；服务端按 normalizeSkillSource 归一后返回。 */
  source: string;
  description: string;
  category: 'developer-tools' | 'productivity' | 'research' | 'finance';
  keywords?: string[];
  publisher?: SkillCatalogPublisher;
  publisherType: 'official' | 'community';
  /** 来源主页；缺省时前端用 source 本身。 */
  homepage?: string;
}

/** GET /api/v1/skills/packages/catalog 返回体；installed 由服务端按账号安装记录派生。 */
export interface SkillPackageCatalog { updatedAt: string; entries: Array<SkillCatalogEntry & { installed: boolean }> }
