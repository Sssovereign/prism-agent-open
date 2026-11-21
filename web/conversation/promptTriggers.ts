// 块E3：输入触发器与建议打分——逐值移植 ZCode a9fe401 packages/ui/src/lib/promptInputTriggers.ts
// 与 slashCommandHelpers.ts 的纯函数部分（AppSlashCommand、normalizeSlashCommandValue、
// buildAppSlashCommandSuggestions）及 mentionMarkdown.ts 的 mention markdown 构造。
// 上游承载于 Lexical composer；本项目输入区为 textarea，这里只依赖"光标前后文本"，逻辑不变。

export type PromptInputTrigger = '/' | '@' | '$' | '#';

export interface ActivePromptInputTrigger {
  trigger: PromptInputTrigger;
  query: string;
}

export function getPromptInputTriggerSignature(
  activeTrigger: ActivePromptInputTrigger | null,
): string | null {
  return activeTrigger
    ? `${activeTrigger.trigger}:${activeTrigger.query}`
    : null;
}

export interface PromptInputSuggestionData {
  path?: string;
  relativePath?: string;
  kind?: 'file' | 'directory';
  scope?: 'built-in' | 'workspace' | 'user' | 'plugin';
}

export interface PromptInputSuggestionItem {
  id: string;
  trigger: PromptInputTrigger;
  value: string;
  label: string;
  description: string;
  keywords?: string[];
  data?: PromptInputSuggestionData;
}

/** App 层斜杠命令：面板选中或提交 `/name args` 时执行 UI 行为（不插入 mention、不发送）。 */
export interface AppSlashCommand {
  /** 命令值（不含 `/`），如 "files"。 */
  value: string;
  /** 本地化描述，直接展示在 `/` 面板。 */
  description: string;
  /** 额外搜索关键词；应同时包含中英文别名，保证两种输入习惯都能搜到。 */
  keywords?: readonly string[];
  /** 命令别名（不含 `/`）：面板搜索与提交分发都按别名命中（上游 aliases 进保留名集合的语义）。 */
  aliases?: readonly string[];
  /** 帮助浮层展示的用法，如 "/goal [目标]"；缺省为 "/<value>"。 */
  usage?: string;
  /** 命令执行行为；args 为命令后的参数文本（面板选中时为 undefined）。 */
  run: (args?: string) => void;
}

interface PromptInputReplacement {
  cursorOffset: number;
  text: string;
}

type PromptInputReplacementCandidates = string | readonly string[];

const ACTIVE_TRIGGER_RE = /(^|\s)([/@$#¥￥])([^\s/@$#¥￥]*)$/;
// 中文输入通常不在句中插入空格；仅放宽 @，避免改变 slash、skill、session 面板的触发边界。
const ACTIVE_MENTION_TRIGGER_RE =
  /(^|[\s\p{Script=Han}\u3000-\u303f\uff00-\uffef])(@)([^\s/@$#¥￥]*)$/u;
// 放宽中文紧邻 @ 后，`联系邮箱@example.com` 会被当成 mention。
// 仅在汉字直接紧邻 @ 时拒绝域名形态（`x.y`）的 query；中文标点后和空格后的 `@foo.bar` 保持触发。
const DOMAIN_LIKE_QUERY_RE = /\S\.\S/;
const HAN_PREFIX_RE = /\p{Script=Han}/u;
const ACTIVE_TRIGGER_TAIL_RE = /^[^\s/@$#¥￥]*/;

function normalizePromptInputTriggerAlias(trigger: string): PromptInputTrigger {
  if (trigger === '¥' || trigger === '￥') {
    // 部分键盘/输入法输入 skill trigger 时会产生 `¥` 或全角 `￥`。
    // 只把触发语义归一为 `$`，不在输入层改写用户实际输入字符。
    return '$';
  }
  return trigger as PromptInputTrigger;
}

/** 供面板打分与测试使用（上游同名内部函数）。 */
export function scoreFuzzyMatch(text: string, query: string): number | null {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedText) {
    return null;
  }
  if (!normalizedQuery) {
    return 0;
  }
  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  let score = 200;
  let searchStart = 0;
  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }
    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }
  return score + (normalizedText.length - normalizedQuery.length);
}

function scorePromptInputSuggestion(
  suggestion: PromptInputSuggestionItem,
  query: string,
): number | null {
  const valueScore = scoreFuzzyMatch(suggestion.value, query);
  const labelScore = scoreFuzzyMatch(suggestion.label, query);
  const descriptionScore = scoreFuzzyMatch(suggestion.description, query);
  const keywordScore = Math.min(
    ...(suggestion.keywords ?? []).map((keyword) => {
      const score = scoreFuzzyMatch(keyword, query);
      return score === null ? Number.POSITIVE_INFINITY : score + 450;
    }),
    Number.POSITIVE_INFINITY,
  );
  const bestScore = Math.min(
    valueScore ?? Number.POSITIVE_INFINITY,
    labelScore !== null ? labelScore + 50 : Number.POSITIVE_INFINITY,
    descriptionScore !== null ? descriptionScore + 250 : Number.POSITIVE_INFINITY,
    keywordScore,
  );
  return Number.isFinite(bestScore) ? bestScore : null;
}

export function extractActivePromptInputTrigger(
  textBeforeCursor: string,
): ActivePromptInputTrigger | null {
  const match =
    ACTIVE_MENTION_TRIGGER_RE.exec(textBeforeCursor) ??
    ACTIVE_TRIGGER_RE.exec(textBeforeCursor);
  if (!match) {
    return null;
  }
  if (HAN_PREFIX_RE.test(match[1] ?? '') && DOMAIN_LIKE_QUERY_RE.test(match[3] ?? '')) {
    return null;
  }
  return {
    trigger: normalizePromptInputTriggerAlias(match[2] ?? ''),
    query: match[3] ?? '',
  };
}

export function getActivePromptInputTokenTailLength(
  activeTrigger: ActivePromptInputTrigger,
  textAfterCursor: string,
  replacementCandidates: PromptInputReplacementCandidates,
): number {
  if (activeTrigger.query.length === 0) {
    // 用户在已有文字前插入裸触发符时，光标后的正文不是当前 token 的补全部分。
    return 0;
  }
  const tailMatch = ACTIVE_TRIGGER_TAIL_RE.exec(textAfterCursor);
  const tailText = tailMatch?.[0] ?? '';
  if (!tailText) {
    return 0;
  }

  const normalizedQuery = activeTrigger.query.toLowerCase();
  const candidates = Array.isArray(replacementCandidates)
    ? replacementCandidates
    : [replacementCandidates];
  let matchedTailLength = 0;
  for (const rawCandidate of candidates) {
    const candidate = rawCandidate.trim().replace(/^[/@$#¥￥]+/, '');
    if (!candidate) {
      continue;
    }
    const normalizedCandidate = candidate.toLowerCase();
    if (!normalizedCandidate.startsWith(normalizedQuery)) {
      continue;
    }
    const expectedTail = candidate.slice(activeTrigger.query.length);
    if (!expectedTail) {
      continue;
    }
    const comparableLength = Math.min(tailText.length, expectedTail.length);
    const typedTail = tailText.slice(0, comparableLength);
    // 只删除“候选值未输入后缀”能对上的那一小段，比如 `/go|al` 里的 `al`。
    if (expectedTail.toLowerCase().startsWith(typedTail.toLowerCase())) {
      matchedTailLength = Math.max(matchedTailLength, comparableLength);
    }
  }
  return matchedTailLength;
}

export function filterPromptInputSuggestions(
  suggestions: PromptInputSuggestionItem[],
  query: string | null,
): PromptInputSuggestionItem[] {
  if (query === null) {
    return [];
  }
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return suggestions;
  }
  return suggestions
    .map((suggestion, index) => {
      const bestScore = scorePromptInputSuggestion(suggestion, normalizedQuery);
      if (bestScore === null) {
        return null;
      }
      return { index, score: bestScore, suggestion };
    })
    .filter((item): item is { index: number; score: number; suggestion: PromptInputSuggestionItem } => item !== null)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      if (left.index !== right.index) {
        return left.index - right.index;
      }
      return left.suggestion.label.localeCompare(right.suggestion.label);
    })
    .map((item) => item.suggestion);
}

export function getBestPromptInputSuggestionIndex(
  suggestions: PromptInputSuggestionItem[],
  query: string | null,
): number {
  const normalizedQuery = query?.trim().toLowerCase() ?? '';
  if (!normalizedQuery) {
    return 0;
  }
  let bestIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  suggestions.forEach((suggestion, index) => {
    const score = scorePromptInputSuggestion(suggestion, normalizedQuery);
    if (score === null) {
      return;
    }
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/** 用任意 markdown 文本（mention/命令 token）替换当前激活的触发 token，结尾补一个空格。 */
export function replaceActivePromptInputTokenWithMarkdown(
  textBeforeCursor: string,
  textAfterCursor: string,
  markdown: string,
): PromptInputReplacement | null {
  const activeTrigger = extractActivePromptInputTrigger(textBeforeCursor);
  if (!activeTrigger) {
    return null;
  }
  const tokenStart = textBeforeCursor.length - activeTrigger.query.length - 1;
  const tailLength = getActivePromptInputTokenTailLength(
    activeTrigger,
    textAfterCursor,
    markdown,
  );
  const prefix = textBeforeCursor.slice(0, tokenStart);
  const suffix = textAfterCursor.slice(tailLength);
  return {
    cursorOffset: prefix.length + markdown.length + 1,
    text: `${prefix}${markdown} ${suffix}`,
  };
}

/** App 命令“选中即执行”：只移除输入中的 `/xxx` token，不插入任何文本。
 *  replacementCandidates 语义同上游 SlashCommandPlugin 的 suggestion.value——
 *  决定光标后多少“未输入后缀”一并移除（如 `/go|al` 的 `al`）。 */
export function removeActivePromptInputToken(
  textBeforeCursor: string,
  textAfterCursor: string,
  replacementCandidates: PromptInputReplacementCandidates,
): PromptInputReplacement | null {
  const activeTrigger = extractActivePromptInputTrigger(textBeforeCursor);
  if (!activeTrigger) {
    return null;
  }
  const tokenStart = textBeforeCursor.length - activeTrigger.query.length - 1;
  const tailLength = getActivePromptInputTokenTailLength(
    activeTrigger,
    textAfterCursor,
    replacementCandidates,
  );
  const prefix = textBeforeCursor.slice(0, tokenStart);
  const suffix = textAfterCursor.slice(tailLength);
  return {
    cursorOffset: prefix.length,
    text: `${prefix}${suffix}`,
  };
}

export function normalizeSlashCommandValue(name: string): string {
  // 远端目录可能直接返回 "/init" 作为命令名；去掉前导斜杠，避免插入后变成 "//init"。
  return name.trim().replace(/^\/+/, '');
}

/** 提交分发解析（上游提交路径同义）：仅当整条输入就是斜杠命令形态 `/name args` 时命中。
 *  name 小写归一并剥多余前导斜杠；普通文本（含句中斜杠）返回 null，走正常发送。 */
export interface ParsedSlashSubmission {
  name: string;
  args: string;
}

const SLASH_SUBMISSION_RE = /^\/+(\S+)(?:\s+([\s\S]*))?$/;

export function parseSlashSubmission(text: string): ParsedSlashSubmission | null {
  const match = SLASH_SUBMISSION_RE.exec(text.trim());
  if (!match?.[1]) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/** 按主名或别名在 App 命令目录中查找；未命中返回 null（该输入按普通任务发送）。 */
export function matchAppSlashCommand(
  commands: readonly AppSlashCommand[],
  name: string,
): AppSlashCommand | null {
  const normalized = normalizeSlashCommandValue(name).toLowerCase();
  if (!normalized) return null;
  return commands.find(command => {
    const value = normalizeSlashCommandValue(command.value).toLowerCase();
    return value === normalized || (command.aliases ?? []).some(alias => normalizeSlashCommandValue(alias).toLowerCase() === normalized);
  }) ?? null;
}

const APP_SLASH_SUGGESTION_ID_PREFIX = 'app-slash:';

export function buildAppSlashCommandSuggestions(
  commands: readonly AppSlashCommand[],
): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.value);
    if (!value) {
      return [];
    }
    return [{
      id: `${APP_SLASH_SUGGESTION_ID_PREFIX}${value}`,
      trigger: '/',
      value,
      label: `/${value}`,
      description: command.description,
      keywords: [...new Set([value, command.description, ...(command.aliases ?? []), ...(command.keywords ?? [])])],
    }];
  });
}

export function isAppSlashCommandSuggestion(suggestion: PromptInputSuggestionItem): boolean {
  return suggestion.id.startsWith(APP_SLASH_SUGGESTION_ID_PREFIX);
}

export interface SkillSuggestionSource {
  name: string;
  description: string;
  path?: string;
  scope?: 'user' | 'workspace' | 'builtin';
  displayName?: string;
  icon?: string;
}

/** 技能建议：label 带 `$` 前缀（上游 buildSkillSuggestions 同形），value 为技能 slug。 */
export function buildSkillSuggestions(
  skills: readonly SkillSuggestionSource[],
): PromptInputSuggestionItem[] {
  return skills.flatMap((skill) => {
    const value = normalizeSlashCommandValue(skill.name);
    if (!value) {
      return [];
    }
    return [{
      id: `skill:${value}`,
      trigger: '$',
      value,
      label: `$${skill.displayName ?? value}`,
      description: skill.description,
      keywords: [...new Set([value, skill.displayName ?? '', skill.description, 'skill', 'skills', '技能'])],
      data: { ...(skill.path ? { path: skill.path } : {}), ...(skill.scope ? { scope: skill.scope==='builtin'?'built-in' as const:skill.scope } : {}) },
    }];
  });
}

// —— mention markdown（上游 mentions/mentionMarkdown.ts 子集）——

function escapeMarkdownLabel(label: string): string {
  return label.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function escapeMarkdownDestination(destination: string): string {
  return destination.replaceAll('\\', '\\\\').replaceAll('>', '\\>');
}

function normalizeMarkdownDestination(destination: string): string {
  if (
    destination.startsWith('/') ||
    destination.startsWith('./') ||
    destination.startsWith('../') ||
    destination.startsWith('#') ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(destination)
  ) {
    return destination;
  }
  // 裸路径统一补 `./` 前缀，成为明确相对路径链接。
  return `./${destination}`;
}

function normalizeFileMentionRelativePath(relativePath: string, kind: 'file' | 'directory'): string {
  const trimmed = relativePath.trim();
  if (kind === 'directory') {
    return `${trimmed.replace(/[\\/]+$/, '')}/`;
  }
  return trimmed;
}

export function buildFileMentionMarkdown(
  relativePath: string,
  label: string,
  kind: 'file' | 'directory' = 'file',
): string {
  const normalized = normalizeFileMentionRelativePath(relativePath, kind);
  return `[${escapeMarkdownLabel(label)}](${escapeMarkdownDestination(normalizeMarkdownDestination(normalized))})`;
}

export function buildSkillMentionMarkdown(label: string, skillPath?: string): string {
  if (!skillPath) {
    return `$${label}`;
  }
  return `[${escapeMarkdownLabel(`$${label}`)}](${escapeMarkdownDestination(normalizeMarkdownDestination(skillPath))})`;
}

// 会话引用：与上游 mentionMarkdown.ts 的 buildSessionMentionMarkdown 同构，destination 固定 `#sess_` 片段。
export function buildSessionMentionMarkdown(sessionId: string, label?: string): string {
  const trimmedLabel = label?.trim();
  if (!trimmedLabel || trimmedLabel === sessionId) {
    return `#${sessionId}`;
  }
  return `[${escapeMarkdownLabel(`#${trimmedLabel}`)}](#${escapeMarkdownDestination(`sess_${sessionId}`)})`;
}
