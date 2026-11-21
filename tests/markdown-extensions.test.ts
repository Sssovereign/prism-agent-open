import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessageSingleDollarMath, isLikelySingleDollarMath } from '../web/conversation/mathText.js';
import { parseMarkdown, type MarkdownNode } from '../web/conversation/markdown.js';
import { isMermaidLanguage, isLikelyMermaidCode, shouldRenderMermaidCodeBlock, resolveMermaidAutoRenderDecision } from '../web/conversation/mermaidSupport.js';
import { shouldUseSyntaxHighlighting, normalizeCodeLanguage, createHighlightCoordinator, createRawCodeTokens, type TokenizedCode } from '../web/conversation/shikiSupport.js';
import { clampDiagramScale, zoomDiagramAtPoint, panDiagram, fitDiagramToViewport } from '../web/conversation/diagramViewport.js';

/** 块E1（Markdown 扩展）：单美元归一化、数学定界解析、Mermaid 识别与预算、Shiki 协调器、视口变换。 */

test('mathText: 像数学的 $…$ 保留，价格区间/环境变量等普通文本转义，行内代码与围栏不动', () => {
    // 像数学：保留定界符
    assert.equal(normalizeMessageSingleDollarMath('能量 $E=mc^2$ 守恒'), '能量 $E=mc^2$ 守恒');
    assert.equal(isLikelySingleDollarMath('E=mc^2'), true);
    assert.equal(isLikelySingleDollarMath('\\frac{a}{b}'), true);
    assert.equal(isLikelySingleDollarMath('x'), true);
    // 普通文本误判防护：只转义当前 $ 阻断配对，后续无闭合的 $ 按原文本保留（上游语义）
    assert.equal(normalizeMessageSingleDollarMath('$5 至 $10 之间'), '\\$5 至 $10 之间');
    assert.equal(normalizeMessageSingleDollarMath('$HOME 与 $PATH'), '\\$HOME 与 $PATH');
    // 紧凑价格区间：$5-$10 第二个 $ 不当闭合符
    assert.equal(normalizeMessageSingleDollarMath('花费$5-$10'), '花费\\$5-$10');
    // 行内代码内的 $ 不动
    assert.equal(normalizeMessageSingleDollarMath('价格 `$5` 与 `$10`'), '价格 `$5` 与 `$10`');
    // 围栏内的 $ 不动
    const fenced = '```\n$HOME\n```';
    assert.equal(normalizeMessageSingleDollarMath(fenced), fenced);
    // 成对闭合的普通词不被误留：单 $ 无闭合保持原样
    assert.equal(normalizeMessageSingleDollarMath('只要 $5'), '只要 $5');
});

test('markdown: $…$ 与 $$…$$ 产出 math/math-block 白名单节点，行内代码中的 $ 不受影响', () => {
    const inline = parseMarkdown('能量 $E=mc^2$ 守恒') as MarkdownNode[];
    const flat = JSON.stringify(inline);
    assert.ok(flat.includes('"tag":"math"'), `应含 math 节点：${flat}`);
    assert.ok(flat.includes('E=mc^2'));
    // 阻断 display：$$ 换行块
    const block = parseMarkdown('$$\nc(\\mathbf{r})=\\sigma\n$$') as MarkdownNode[];
    assert.ok(JSON.stringify(block).includes('"tag":"math-block"'), `应含 math-block：${JSON.stringify(block)}`);
    // 单行 $$...$$
    const oneLine = parseMarkdown('$$a+b$$') as MarkdownNode[];
    assert.ok(JSON.stringify(oneLine).includes('"tag":"math-block"'));
    // 行内代码优先：$ 在 code 节点内
    const codeCase = parseMarkdown('变量 `$x^2$` 原样') as MarkdownNode[];
    const codeNode = JSON.stringify(codeCase);
    assert.ok(codeNode.includes('"tag":"code"'), `行内代码应优先：${codeNode}`);
    assert.ok(!codeNode.includes('"tag":"math"'));
    // 转义后的 \$ 由 markdown-it 还原为 $ 文本
    const escaped = parseMarkdown(normalizeMessageSingleDollarMath('$5 至 $10')) as MarkdownNode[];
    assert.ok(JSON.stringify(escaped).includes('$5'), `价格文本应保留：${JSON.stringify(escaped)}`);
    assert.ok(!JSON.stringify(escaped).includes('"tag":"math"'));
    // 无数学文本不受影响
    const plain = parseMarkdown('# 标题\n正文 **加粗**') as MarkdownNode[];
    assert.ok(JSON.stringify(plain).includes('"tag":"h1"'));
    assert.ok(JSON.stringify(plain).includes('"tag":"strong"'));
});

test('mermaidSupport: mermaid/mmd 语言直接渲染，纯文本窄首行自识别，预算门禁逐级拦截', () => {
    assert.equal(isMermaidLanguage('mermaid'), true);
    assert.equal(isMermaidLanguage('MMD'), true);
    assert.equal(isMermaidLanguage('ts'), false);
    // 自识别：空语言 + 首行 flowchart
    assert.equal(shouldRenderMermaidCodeBlock('', 'flowchart TD\nA-->B'), true);
    assert.equal(shouldRenderMermaidCodeBlock('text', 'sequenceDiagram\nA->>B: hi'), true);
    // 显式 ts 不误染
    assert.equal(shouldRenderMermaidCodeBlock('ts', 'flowchart TD'), false);
    // 预算：源码超 20000 字符（4000 行同样超行数上限，但源码长度先拦）
    const big = `flowchart TD\n${'A-->B\n'.repeat(4000)}`;
    const decision = resolveMermaidAutoRenderDecision(big);
    assert.equal(decision.shouldRender, false);
    assert.equal(decision.shouldRender ? '' : decision.reason, 'source-too-large');
    // 行数超 600
    const manyLines = `flowchart TD\n${'A-->B\n'.repeat(700)}`.slice(0, 19000);
    const lineDecision = resolveMermaidAutoRenderDecision(manyLines);
    assert.equal(lineDecision.shouldRender, false);
    assert.equal(lineDecision.shouldRender ? '' : lineDecision.reason, 'line-count-too-large');
    // 复杂度分（行+边+节点）超 1500：551 行（≤600）× 每行 3 分（行+边+节点）
    const complex = `flowchart TD\n${'A1[x]-->B2\n'.repeat(550)}`;
    const complexDecision = resolveMermaidAutoRenderDecision(complex);
    assert.equal(complexDecision.shouldRender, false);
    assert.equal(complexDecision.shouldRender ? '' : complexDecision.reason, 'complexity-too-large');
    // 页面隐藏时即使小图也不渲染
    const hidden = resolveMermaidAutoRenderDecision('flowchart TD\nA-->B', { documentVisibilityState: 'hidden' });
    assert.equal(hidden.shouldRender, false);
    assert.equal(hidden.shouldRender ? '' : hidden.reason, 'document-hidden');
    // 正常小图放行
    assert.equal(resolveMermaidAutoRenderDecision('flowchart TD\nA-->B').shouldRender, true);
});

test('shikiSupport: 纯文本旁路、别名解析、log 回退、协调器缓存与订阅语义', async () => {
    const ids = new Set(['typescript', 'javascript', 'log']);
    const aliases = new Map<string, string>([['ts', 'typescript'], ['js', 'javascript']]);
    assert.equal(shouldUseSyntaxHighlighting('text', ids, aliases), false);
    assert.equal(shouldUseSyntaxHighlighting('log', ids, aliases), false);
    assert.equal(shouldUseSyntaxHighlighting('ts', ids, aliases), true);
    assert.equal(shouldUseSyntaxHighlighting('rust', ids, aliases), false);
    assert.equal(normalizeCodeLanguage('TS', ids, aliases), 'typescript');
    assert.equal(normalizeCodeLanguage('', ids, aliases), 'log');
    assert.equal(normalizeCodeLanguage('python', ids, aliases), 'log');
    // 原始 tokens：空行数组、逐行包装
    const raw = createRawCodeTokens('a\n\nb');
    assert.equal(raw.tokens.length, 3);
    assert.deepEqual(raw.tokens[1], []);
    // 协调器：未命中返回 null，完成后订阅回调；再次调用同步命中
    let calls = 0;
    const coordinator = createHighlightCoordinator({
        createHighlighter: async () => ({
            getLoadedLanguages: () => ['typescript', 'log'],
            codeToTokens: (code) => { calls += 1; return { tokens: code.split('\n').map(line => [{ color: '#000', content: line }]), fg: '#000' }; },
        }),
    });
    const first = coordinator.highlightCode('const a=1', 'ts', 'github-light', ids, aliases, result => {
        // 微任务通知（缓存命中路径也要走幂等 setter）
        assert.equal(result.tokens[0]![0]!.content, 'const a=1');
    });
    assert.equal(first, null, '未命中应返回 null');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 1);
    const cached = coordinator.highlightCode('const a=1', 'ts', 'github-light', ids, aliases);
    assert.ok(cached, '缓存命中应同步返回');
    await new Promise<void>(resolve => queueMicrotask(() => resolve()));
    assert.equal(calls, 1, '缓存命中不应重复 tokenize');
    // 已知语言但高亮器未装配 → 回退 log 仍走 tokenize
    coordinator.highlightCode('step', 'js', 'github-light', ids, aliases, () => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 2);
});

test('diagramViewport: 缩放锚点数学、夹紧与适应视口', () => {
    assert.equal(clampDiagramScale(0.1), 0.25);
    assert.equal(clampDiagramScale(99), 4);
    assert.equal(clampDiagramScale(Number.NaN), 1);
    // 以点为中心缩放：点下的图坐标保持不动
    const zoomed = zoomDiagramAtPoint({ scale: 1, translateX: 0, translateY: 0 }, { x: 100, y: 50 }, 2);
    assert.equal(zoomed.scale, 2);
    assert.equal(zoomed.translateX, -100);
    assert.equal(zoomed.translateY, -50);
    // 平移
    assert.deepEqual(panDiagram({ scale: 1, translateX: 5, translateY: 6 }, { x: 1, y: -2 }), { scale: 1, translateX: 6, translateY: 4 });
    // 适应：图大于视口时缩到内边界，居中
    const fit = fitDiagramToViewport({ diagramWidth: 400, diagramHeight: 200, viewportWidth: 200, viewportHeight: 400, padding: 0 });
    assert.equal(fit.scale, 0.5);
    assert.equal(fit.translateX, 0);
    assert.equal(fit.translateY, 150);
    // 非法尺寸回退恒等
    assert.deepEqual(fitDiagramToViewport({ diagramWidth: 0, diagramHeight: 0, viewportWidth: 100, viewportHeight: 100 }), { scale: 1, translateX: 0, translateY: 0 });
});

test('markdown: TokenizedCode 类型与 fence 语言透传（data-language 截断规则不变）', async () => {
    const fenced = parseMarkdown('```ts\nconst a=1\n```') as MarkdownNode[];
    const pre = fenced.find(node => node.tag === 'pre');
    const codeNode = pre?.children?.find(node => node.tag === 'code');
    assert.equal(codeNode?.attrs?.['data-language'], 'ts');
    assert.equal((codeNode as { text?: string }).text?.includes('const a=1'), true);
    // 未标注 fence 无 data-language → CodeBlock 走 mermaid 自识别/纯文本路径
    const bare = parseMarkdown('```\nplain\n```') as MarkdownNode[];
    const bareCode = bare.find(node => node.tag === 'pre')?.children?.find(node => node.tag === 'code');
    assert.equal(bareCode?.attrs, undefined);
    const unused: TokenizedCode = { tokens: [], fg: 'inherit', bg: 'transparent' };
    assert.deepEqual(unused.bg, 'transparent');
});
