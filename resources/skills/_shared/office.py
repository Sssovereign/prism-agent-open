#!/usr/bin/env python3
"""Prism's portable document helpers. Optional libraries are checked, never auto-installed."""
import argparse, importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile, zipfile

MODULES = {'docx':'docx', 'xlsx':'openpyxl', 'pptx':'pptx', 'pdf':'reportlab'}
INSTALL = {'docx':'python-docx', 'xlsx':'openpyxl', 'pptx':'python-pptx', 'pdf':'reportlab'}
def document_font():
    if shutil.which('fc-match'):
        for name in ('Noto Sans CJK SC', 'Hiragino Sans GB', 'PingFang SC', 'Microsoft YaHei', 'WenQuanYi Zen Hei'):
            found=subprocess.check_output(['fc-match','-f','%{family}',name],text=True,timeout=5)
            if name in found: return name
    return 'Microsoft YaHei' if sys.platform=='win32' else 'Noto Sans CJK SC'
def check(fmt):
    ready = importlib.util.find_spec(MODULES[fmt]) is not None
    return {'format':fmt, 'ready':ready, 'package':INSTALL[fmt], 'font':document_font(), 'render':shutil.which('soffice') or shutil.which('libreoffice'), 'pdfRaster':shutil.which('pdftoppm')}
def create(fmt, data, output):
    if pathlib.Path(output).suffix.lower() != '.'+fmt: raise ValueError('输出扩展名必须与format一致')
    if not check(fmt)['ready']: raise ValueError('缺少依赖 '+INSTALL[fmt]+'；请在任务虚拟环境安装后再运行')
    font=data.get('font') or document_font()
    if fmt == 'docx':
        from docx import Document
        from docx.oxml.ns import qn
        d=Document();style=d.styles['Normal'];style.font.name=font;style._element.rPr.rFonts.set(qn('w:eastAsia'),font)
        d.add_heading(data.get('title','文档'),0)
        for text in data.get('paragraphs',[]): d.add_paragraph(str(text))
        for rows in data.get('tables',[]):
            if not rows: continue
            table=d.add_table(rows=0, cols=max(len(r) for r in rows));table.style='Table Grid'
            for row in rows:
                for cell,value in zip(table.add_row().cells,row): cell.text=str(value)
        paragraphs=list(d.paragraphs)+[p for table in d.tables for row in table.rows for cell in row.cells for p in cell.paragraphs]
        for p in paragraphs:
            for run in p.runs:
                run.font.name=font;run._element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'),font)
        d.save(output)
    elif fmt == 'xlsx':
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill
        from openpyxl.utils import get_column_letter
        from openpyxl.workbook.properties import CalcProperties
        w=Workbook();w.remove(w.active)
        for sheet in data.get('sheets',[{'name':'Sheet1','rows':[]}]):
            s=w.create_sheet(sheet.get('name','Sheet'))
            for row in sheet.get('rows',[]): s.append(row)
            for row in s:
                for c in row: c.font=Font(name=font)
            if s.max_row:
                for c in s[1]: c.font=Font(name=font,bold=True,color='FFFFFF');c.fill=PatternFill('solid',fgColor='275DAD')
            s.freeze_panes='A2'
            for col in s.columns:
                s.column_dimensions[get_column_letter(col[0].column)].width=min(48,max(12,max(len(str(c.value or '')) for c in col)+2))
        w.calculation=CalcProperties(fullCalcOnLoad=True);w.save(output)
    elif fmt == 'pptx':
        from pptx import Presentation
        from pptx.util import Inches, Pt
        r=Presentation();r.slide_width=Inches(13.333);r.slide_height=Inches(7.5)
        for item in data.get('slides',[]):
            slide=r.slides.add_slide(r.slide_layouts[1]);slide.shapes.title.text=str(item.get('title',''))
            frame=slide.placeholders[1].text_frame;frame.clear()
            for i,line in enumerate(item.get('bullets',[])):
                p=frame.paragraphs[0] if i==0 else frame.add_paragraph();p.text=str(line);p.font.size=Pt(24)
        if not r.slides: raise ValueError('至少需要一页幻灯片')
        from pptx.oxml.xmlchemy import OxmlElement
        for slide in r.slides:
            for shape in slide.shapes:
                if not shape.has_text_frame: continue
                for p in shape.text_frame.paragraphs:
                    for run in p.runs:
                        run.font.name=font;ea=OxmlElement('a:ea');ea.set('typeface',font);run._r.get_or_add_rPr().append(ea)
        r.save(output)
    else:
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        from xml.sax.saxutils import escape
        pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'));styles=getSampleStyleSheet()
        for s in styles.byName.values(): s.fontName='STSong-Light';s.wordWrap='CJK'
        story=[Paragraph(escape(str(data.get('title','文档'))),styles['Title']),Spacer(1,16)]
        for text in data.get('paragraphs',[]): story.extend([Paragraph(escape(str(text)).replace('\n','<br/>'),styles['BodyText']),Spacer(1,8)])
        SimpleDocTemplate(output).build(story)
    return inspect(output)
def inspect(path):
    p=pathlib.Path(path);fmt=p.suffix.lower().lstrip('.')
    result={'path':str(p.resolve()),'bytes':p.stat().st_size,'format':fmt}
    if fmt in ('docx','xlsx','pptx'):
        from xml.etree import ElementTree
        required={'docx':'word/document.xml','xlsx':'xl/workbook.xml','pptx':'ppt/presentation.xml'}[fmt]
        with zipfile.ZipFile(p) as z:
            bad=z.testzip()
            if bad: raise ValueError('ZIP校验失败 '+bad)
            for name in ('[Content_Types].xml','_rels/.rels',required): ElementTree.fromstring(z.read(name))
            result['parts']=len(z.namelist());result['structuralCheck']='passed'
            if fmt=='pptx': result['slides']=sum(n.startswith('ppt/slides/slide') and n.endswith('.xml') for n in z.namelist())
    elif fmt=='pdf':
        if not p.read_bytes().startswith(b'%PDF-'): raise ValueError('不是PDF文件')
        if shutil.which('pdfinfo'): result['pdfinfo']=subprocess.check_output(['pdfinfo',str(p)],text=True,timeout=30)
    else: raise ValueError('仅支持docx/xlsx/pptx/pdf')
    return result
def main():
    a=argparse.ArgumentParser();a.add_argument('action',choices=['check','create','inspect','render']);a.add_argument('--format',choices=list(MODULES));a.add_argument('--input');a.add_argument('--output');args=a.parse_args()
    if args.action=='check':
        result=check(args.format);print(json.dumps(result,ensure_ascii=False));return 0 if result['ready'] else 2
    if args.action=='create': result=create(args.format,json.loads(pathlib.Path(args.input).read_text()),args.output)
    elif args.action=='inspect': result=inspect(args.input)
    else:
        source=pathlib.Path(args.input).resolve();dest=pathlib.Path(args.output).resolve();dest.mkdir(parents=True,exist_ok=True)
        if source.suffix.lower()=='.pdf':
            tool=shutil.which('pdftoppm')
            if not tool: raise ValueError('缺少pdftoppm，无法渲染预览')
            subprocess.run([tool,'-scale-to','1400','-png',str(source),str(dest/'page')],check=True,timeout=120)
        else:
            tool=shutil.which('soffice') or shutil.which('libreoffice')
            if not tool: raise ValueError('缺少LibreOffice，无法渲染Office预览')
            target=dest/(source.stem+'.pdf')
            if target.exists(): target.unlink()
            with tempfile.TemporaryDirectory(prefix='prism-office-profile-') as profile:
                env=os.environ.copy()
                if sys.platform=='darwin':
                    from xml.sax.saxutils import escape
                    config=pathlib.Path(profile)/'fonts.conf'
                    dirs=['/System/Library/Fonts','/Library/Fonts',str(pathlib.Path.home()/'Library/Fonts')]
                    config.write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig>'+''.join('<dir>'+escape(d)+'</dir>' for d in dirs)+'<cachedir>'+escape(profile+'/font-cache')+'</cachedir></fontconfig>')
                    env['FONTCONFIG_FILE']=str(config)
                subprocess.run([tool,'-env:UserInstallation='+pathlib.Path(profile).as_uri(),'--headless','--convert-to','pdf','--outdir',str(dest),str(source)],check=True,timeout=120,env=env)
            if not target.exists(): raise ValueError('Office转换未生成PDF；请检查工具输出与文件内容')
        result={'outputs':[str(p) for p in dest.iterdir()]}
    print(json.dumps(result,ensure_ascii=False));return 0
if __name__=='__main__':
    try: sys.exit(main())
    except Exception as e: print(json.dumps({'error':str(e)},ensure_ascii=False),file=sys.stderr);sys.exit(1)
