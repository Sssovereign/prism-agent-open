/**
 * 补丁预览解析（块F1）：按 ZCode patchDiffPreview.ts 语义移植的安全上限。
 * 只提取 hunk 正文行；1200 行/180_000 字符封顶，超出追加截断标记行（展示层
 * 渲染为提示，不冒充完整 diff）；`---/+++` 文件头不进正文（路径由 chip 展示）。
 */

export const MAX_PATCH_DIFF_SAFE_LINE_COUNT = 1200;
export const MAX_PATCH_DIFF_SAFE_CHAR_COUNT = 180_000;
export const MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES = 800;
export const DIFF_TRUNCATED_MARKER_PREFIX = '\\ __PRISM_DIFF_TRUNCATED__:';

const TRUNCATED_MARKER_REGEX = /^\\ __PRISM_DIFF_TRUNCATED__:(\d+)$/;

export function parseTruncatedMarkerOmittedLineCount(line: string): number | null {
    const match = TRUNCATED_MARKER_REGEX.exec(line);
    return match ? Number(match[1]) : null;
}

/** 去掉 unified 行协议 marker（+/-/空格），marker 不当内容显示。 */
export function getPatchPreviewLineContent(line: string): string {
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) return line.slice(1);
    return line;
}

const HUNK_HEADER_PATTERN = /^@@/;

/**
 * 提取补丁的预览行（含 hunk 头之间的正文）；按行数与字符数封顶。
 * 封顶时追加 `\ __PRISM_DIFF_TRUNCATED__:<省略行数>` 协议行。
 */
export function getPlainTextPatchPreviewLines(patch: string): string[] {
    const rawLines = patch.split(/\r?\n/);
    const body: string[] = [];
    let cursor = 0;
    while (cursor < rawLines.length) {
        const line = rawLines[cursor]!;
        cursor++;
        if (!line || line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ')) continue;
        if (HUNK_HEADER_PATTERN.test(line)) continue;
        body.push(line);
    }
    // `\ No newline at end of file` 是协议行：保留（渲染为上下文样式小字）。
    const capped: string[] = [];
    let omitted = 0;
    let charBudget = MAX_PATCH_DIFF_SAFE_CHAR_COUNT;
    for (const line of body) {
        if (capped.length >= MAX_PATCH_DIFF_SAFE_LINE_COUNT || charBudget - line.length < 0) {
            omitted += body.length - capped.length;
            break;
        }
        capped.push(line);
        charBudget -= line.length;
    }
    if (omitted > 0) capped.push(`${DIFF_TRUNCATED_MARKER_PREFIX}${omitted}`);
    return capped;
}

export type LightweightDiffLineKind = 'added' | 'removed' | 'context';
export interface LightweightDiffLineParts { content: string; kind: LightweightDiffLineKind; marker: string; raw: string }

export function getLightweightDiffLineParts(line: string): LightweightDiffLineParts {
    if (line.startsWith('+')) return { content: getPatchPreviewLineContent(line), kind: 'added', marker: '+', raw: line };
    if (line.startsWith('-')) return { content: getPatchPreviewLineContent(line), kind: 'removed', marker: '-', raw: line };
    if (line.startsWith(' ')) return { content: getPatchPreviewLineContent(line), kind: 'context', marker: ' ', raw: line };
    return { content: getPatchPreviewLineContent(line), kind: 'context', marker: '', raw: line };
}

/** 由路径扩展名推断高亮语言（上游 inferCodeLanguage 的窄集，未知返回空走纯文本）。 */
const EXT_LANGUAGE_MAP: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
    json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html', vue: 'vue',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c',
    cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'shell', bash: 'shell', zsh: 'shell',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', sql: 'sql', swift: 'swift', lua: 'lua',
};
export function inferDiffLanguage(path: string): string {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    if (!ext || ext.length > 8 || ext.includes('/')) return '';
    return EXT_LANGUAGE_MAP[ext] ?? '';
}
