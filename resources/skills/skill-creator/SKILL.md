---
name: skill-creator
description: 创建、编辑和验证可复用的Agent Skills技能，生成SKILL.md及必要脚本、参考资料。
license: MIT
---

# 技能创建器
先从用户的具体工作流提取触发条件、输入、产物和必须遵守的约束。只补充能改变Agent决策的领域知识，不重写泛泛的工作准则。
使用小写字母、数字和连字符命名目录和name。SKILL.md以YAML frontmatter开头，含name与非空description（最多1024字符）；description说明何时使用。
正文保持精简；较长资料放references/，稳定重复操作放scripts/，输出模板放assets/，使用相对路径链接。脚本实际执行验证后才交付，不创建空壳资源。
默认在当前项目`.prism/skills/<name>/`创建；需要个人共享时使用`~/.prism/skills/`。不要覆盖同名文件而不核对已有内容。
只允许手动调用时加入`disable-model-invocation: true`。用`/skill:<name>`显式调用仍可用。
第三方技能应保留许可证与来源，检查其工具名称和依赖能否在棱镜使用；不把其他产品专属工具名称直接照抄。
最后核对name/description、资源链接与脚本，说明在技能设置刷新并启用；新任务生效。
