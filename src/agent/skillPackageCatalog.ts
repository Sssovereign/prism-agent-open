import type { SkillCatalogEntry } from '../../contracts/skills.js';

/**
 * 推荐技能包目录（数据层）：形态参考 ZCode 官方市场清单
 * （name/source/description/category/publisher/publisherType/homepage/keywords），
 * 收敛为棱镜可安装的 git/npm 通道；来源在登记前必须人工核验仓库真实存在，
 * 且能被 Pi 包管理安装（SKILL.md 目录、skills/ 仓库或声明 pi.skills 的包）。
 * 目录随代码发布，改动需重启生效；只读端点按账号派生 installed 标记。
 */
export const SKILL_PACKAGE_CATALOG_UPDATED_AT = '2026-11-15';

export const SKILL_PACKAGE_CATALOG: readonly SkillCatalogEntry[] = [
  {
    name: 'Anthropic 官方技能库',
    source: 'https://github.com/anthropics/skills',
    description: 'Anthropic 官方 Agent Skills 仓库：文档处理、测试编写等通用技能集合，按目录自动发现。注意其中 docx/pdf/pptx/xlsx/skill-creator 与内置技能同名，安装后按优先级以包版本为准。',
    category: 'developer-tools',
    keywords: ['文档', '通用技能'],
    publisher: { name: 'Anthropic', url: 'https://www.anthropic.com' },
    publisherType: 'official',
    homepage: 'https://github.com/anthropics/skills',
  },
  {
    name: 'Vercel 官方技能集',
    source: 'https://github.com/vercel-labs/agent-skills',
    description: 'Vercel 官方维护的 Agent 技能合集，覆盖前端工程与部署相关的工作流。',
    category: 'developer-tools',
    keywords: ['前端', '部署'],
    publisher: { name: 'Vercel', url: 'https://vercel.com' },
    publisherType: 'official',
    homepage: 'https://github.com/vercel-labs/agent-skills',
  },
  {
    name: 'Superpowers 技能框架',
    source: 'https://github.com/obra/superpowers',
    description: '社区维护的软件开发方法论技能集：TDD、调试、系统化排查等流程化技能。',
    category: 'developer-tools',
    keywords: ['TDD', '调试', '流程'],
    publisher: { name: 'obra', url: 'https://github.com/obra' },
    publisherType: 'community',
    homepage: 'https://github.com/obra/superpowers',
  },
];
