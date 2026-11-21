---
name: github-workflow
description: 使用本机Git和GitHub CLI查看仓库、分支、提交、PR、Issue与Actions；用于GitHub协作任务。
license: MIT
---

# GitHub工作流
先检查git status、remote和当前分支；使用`gh --version`与`gh auth status`确认CLI可用及登录情况，不读取或回显令牌。
读取仓库资料、PR、Issue和Actions优先使用gh的结构化JSON输出。需要修改时先弄清目标仓库、对象与用户授权，保留工作区其他改动。
写提交或PR说明前先核对最终差异和实际验证。多行正文写入临时文件并用--body-file传递，避免shell转义破坏内容。
创建/更新PR、发评论或推送依据本次用户请求；不因为技能被选择就自动发布。若未安装gh或未认证，说明具体缺项，不伪造远端结果。
不得用硬重置或强推清理别人的修改；分支冲突按实际变更解决并验证。
