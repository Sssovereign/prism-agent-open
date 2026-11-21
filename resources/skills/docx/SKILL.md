---
name: docx
description: 创建、编辑、检查Word文档（DOCX），包括段落与表格；需要可编辑文档时使用。
license: MIT
---

# Word 文档
先确认需要新建、修改还是阅读文件，以及目标读者、内容和输出路径。修改已有文档时先检查现有结构，保留用户内容。
本技能附带共享工具 `../_shared/office.py`，路径相对于本SKILL.md所在目录。
1. 使用 `python3 ../_shared/office.py check --format docx` 检查依赖。缺失时在任务专用虚拟环境安装提示的Python包，再用该环境的解释器运行；不要擅改系统Python。
2. 新建简单文件可写JSON输入，格式例如：`{"title":"报告","paragraphs":["第一段"],"tables":[[["项目","值"],["状态","完成"]]]}`，再执行 `python3 ../_shared/office.py create --format docx --input 内容.json --output 成品.docx`。复杂排版可使用相应Python库直接编辑。
3. 完成后运行 `python3 ../_shared/office.py inspect --input 成品.docx`。此检查只证明结构可读，不证明排版正确。
4. 需要交付排版文件时执行 `render --input 成品.docx --output 预览目录`，Office依赖LibreOffice，PDF页面依赖pdftoppm。打开预览逐页检查裁切、重叠与可读性，再交付成品。缺少渲染工具时明确未完成视觉检查，不宣称已经验证版式。
保留可编辑源文件。不要把图片预览当作可编辑成品，也不向回复粘贴文件的二进制内容。
