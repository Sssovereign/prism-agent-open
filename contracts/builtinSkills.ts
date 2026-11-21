/** Prism-owned workflows; icons reuse the existing file icon set. */
export const BUILTIN_SKILLS: Record<string,{displayName:string;icon:string}> = {
  'prism-guide': { displayName:'棱镜使用指南',icon:'guide.md' },
  'skill-creator': { displayName:'技能创建器',icon:'skill.md' },
  'project-handoff': { displayName:'项目交接',icon:'project.md' },
  'github-workflow': { displayName:'GitHub',icon:'workflow.git' },
  'pdf': { displayName:'PDF',icon:'document.pdf' },
  'docx': { displayName:'Word 文档',icon:'document.docx' },
  'xlsx': { displayName:'电子表格',icon:'document.xlsx' },
  'pptx': { displayName:'演示文稿',icon:'document.pptx' },
};
