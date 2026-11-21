import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractActivePromptInputTrigger, getPromptInputTriggerSignature,
  filterPromptInputSuggestions, scoreFuzzyMatch,
  replaceActivePromptInputTokenWithMarkdown, removeActivePromptInputToken,
  getActivePromptInputTokenTailLength,
  buildAppSlashCommandSuggestions, buildSkillSuggestions, isAppSlashCommandSuggestion,
  buildFileMentionMarkdown, buildSkillMentionMarkdown, normalizeSlashCommandValue,
  parseSlashSubmission, matchAppSlashCommand,
} from '../web/conversation/promptTriggers.js';

/** 块E3（斜杠命令＋@引用）：触发器识别、模糊打分过滤、token 替换与 mention markdown 构造——逐值移植上游 promptInputTriggers/slashCommandHelpers/mentionMarkdown 纯函数的行为回归。 */

test('extractActivePromptInputTrigger：识别光标前激活触发器', () => {
  assert.deepEqual(extractActivePromptInputTrigger('/com'), { trigger: '/', query: 'com' });
  assert.deepEqual(extractActivePromptInputTrigger('看看 /fi'), { trigger: '/', query: 'fi' });
  assert.deepEqual(extractActivePromptInputTrigger('参考 @REA'), { trigger: '@', query: 'REA' });
  assert.deepEqual(extractActivePromptInputTrigger('用 $code'), { trigger: '$', query: 'code' });
  assert.deepEqual(extractActivePromptInputTrigger('查 #abc'), { trigger: '#', query: 'abc' });
  // 全角 ¥/￥ 归一为 $ 触发语义（不改写用户输入字符）
  assert.deepEqual(extractActivePromptInputTrigger('¥co'), { trigger: '$', query: 'co' });
  assert.deepEqual(extractActivePromptInputTrigger('￥co'), { trigger: '$', query: 'co' });
  // 词中斜杠不是触发器（需行首或空白前缀）
  assert.equal(extractActivePromptInputTrigger('abc/def'), null);
  // query 含空白则不触发
  assert.equal(extractActivePromptInputTrigger('/foo bar'), null);
  // 空串无触发
  assert.equal(extractActivePromptInputTrigger(''), null);
});

test('extractActivePromptInputTrigger：中文紧邻 @ 放宽与邮箱形态拒绝', () => {
  // 汉字紧邻 @ 触发（中文输入通常不在句中插空格）
  assert.deepEqual(extractActivePromptInputTrigger('看这个@foo'), { trigger: '@', query: 'foo' });
  // 中文标点后保持触发
  assert.deepEqual(extractActivePromptInputTrigger('看看，@foo.bar'), { trigger: '@', query: 'foo.bar' });
  // 汉字紧邻 @ 且 query 是域名形态 → 拒绝（避免 `联系邮箱@example.com` 误触发）
  assert.equal(extractActivePromptInputTrigger('联系邮箱@example.com'), null);
  // 空格后的 @foo.bar 不是邮箱形态，保持触发
  assert.deepEqual(extractActivePromptInputTrigger('邮箱 @foo.bar'), { trigger: '@', query: 'foo.bar' });
});

test('getPromptInputTriggerSignature：签名用于 Esc 关闭后同 token 不复弹', () => {
  const t = extractActivePromptInputTrigger('/co');
  assert.equal(getPromptInputTriggerSignature(t), '/:co');
  assert.equal(getPromptInputTriggerSignature(null), null);
});

test('scoreFuzzyMatch：前缀/子串/子序列打分与不可命中', () => {
  assert.equal(scoreFuzzyMatch('compact', ''), 0); // 空 query
  assert.equal(scoreFuzzyMatch('', 'a'), null); // 空文本
  assert.equal(scoreFuzzyMatch('compact', 'comp'), 'compact'.length - 'comp'.length); // 前缀=长度差
  assert.equal(scoreFuzzyMatch('打开设置', '设置'), 100 + 2); // 子串=100+下标
  const subsequence = scoreFuzzyMatch('file', 'fl');
  assert.equal(subsequence, 200 + 1 + (4 - 2)); // 200+gap+(len-query)
  assert.equal(scoreFuzzyMatch('file', 'xz'), null);
  // 大小写不敏感
  assert.equal(scoreFuzzyMatch('Files', 'fi'), 3);
});

test('filterPromptInputSuggestions：打分排序（前缀优于子串优于关键词）＋平序按原索引', () => {
  const items = [
    { id: '1', trigger: '/' as const, value: 'settings', label: '/settings', description: '打开设置', keywords: ['settings', '设置'] },
    { id: '2', trigger: '/' as const, value: 'compact', label: '/compact', description: '压缩上下文', keywords: ['compact', '压缩'] },
    { id: '3', trigger: '/' as const, value: 'session-info', label: '/session-info', description: '会话信息相关', keywords: [] },
  ];
  // query=null → 空数组；空 query → 全量原序
  assert.deepEqual(filterPromptInputSuggestions(items, null), []);
  assert.deepEqual(filterPromptInputSuggestions(items, ''), items);
  // 前缀命中 'se'：settings(value 前缀) 与 session-info(value 前缀)；长度差 6 vs 10 → settings 先
  const se = filterPromptInputSuggestions(items, 'se');
  assert.deepEqual(se.map(s => s.id), ['1', '3']);
  // 子序列命中：'stngs' 只中 settings（compact/session-info 均不含该子序列）
  assert.deepEqual(filterPromptInputSuggestions(items, 'stngs').map(s => s.id), ['1']);
  // 关键词命中（+450 劣于 value 命中）：'设置' 只由 keywords 命中 settings
  assert.deepEqual(filterPromptInputSuggestions(items, '设置').map(s => s.id), ['1']);
  // 无命中过滤掉
  assert.deepEqual(filterPromptInputSuggestions(items, 'zzz'), []);
});

test('replaceActivePromptInputTokenWithMarkdown：token 替换＋尾随空格＋光标位', () => {
  // 基本：'看看 /fi' + '后文' → markdown 插入
  const r1 = replaceActivePromptInputTokenWithMarkdown('看看 /fi', '后文', '[README.md](./README.md)');
  assert.ok(r1);
  assert.equal(r1.text, '看看 [README.md](./README.md) 后文');
  assert.equal(r1.cursorOffset, '看看 '.length + '[README.md](./README.md)'.length + 1);
  // 光标在已完整输入 token 中间：/go|al 只删能对上的 tail 'al'（上游同款算术：
  // 原文 token 后的分隔空格保留＋插入的尾随空格 → 罕见场景出现双空格，逐值对齐不修饰）
  const r2 = replaceActivePromptInputTokenWithMarkdown('/go', 'al 后文', '/goal');
  assert.ok(r2);
  assert.equal(r2.text, '/goal  后文');
  // 裸触发符（query 空）不动光标后正文
  const r3 = replaceActivePromptInputTokenWithMarkdown('前文 /', '后文直接保留', 'x');
  assert.ok(r3);
  assert.equal(r3.text, '前文 x 后文直接保留');
  // 无激活触发器 → null
  assert.equal(replaceActivePromptInputTokenWithMarkdown('普通文本', '', 'x'), null);
});

test('removeActivePromptInputToken：App 命令只移除 token 不插入文本', () => {
  const r1 = removeActivePromptInputToken('/compact', '', 'compact');
  assert.ok(r1);
  assert.equal(r1.text, '');
  assert.equal(r1.cursorOffset, 0);
  // 光标停在 token 中间（/se|ttings）：候选 settings 决定 tail 'ttings' 一并移除
  const r2 = removeActivePromptInputToken('前 /se', 'ttings 后文', 'settings');
  assert.ok(r2);
  assert.equal(r2.text, '前  后文');
  assert.equal(r2.cursorOffset, '前 '.length);
  assert.equal(removeActivePromptInputToken('无触发', '', 'x'), null);
});

test('getActivePromptInputTokenTailLength：裸触发符不吞光标后正文', () => {
  const trigger = extractActivePromptInputTrigger('前文 /');
  assert.ok(trigger);
  assert.equal(getActivePromptInputTokenTailLength(trigger, '后文正文', 'value'), 0);
});

test('buildAppSlashCommandSuggestions：label=/value＋关键词含描述；normalizeSlashCommandValue 去前导斜杠', () => {
  const commands = [{ value: '/compact', description: '压缩当前会话上下文', keywords: ['压缩'], run: () => {} }];
  const suggestions = buildAppSlashCommandSuggestions(commands);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]!.value, 'compact');
  assert.equal(suggestions[0]!.label, '/compact');
  assert.ok(suggestions[0]!.keywords!.includes('压缩'));
  assert.ok(suggestions[0]!.keywords!.includes('压缩当前会话上下文'));
  assert.ok(isAppSlashCommandSuggestion(suggestions[0]!));
  assert.equal(normalizeSlashCommandValue('//init'), 'init');
  // 空值命令被剔除
  assert.equal(buildAppSlashCommandSuggestions([{ value: '///', description: 'x', run: () => {} }]).length, 0);
});

test('buildSkillSuggestions：label=$slug＋path/scope 入 data', () => {
  const skills = [{ name: 'code-review', description: '代码评审', path: '/skills/code-review/SKILL.md', scope: 'user' as const }];
  const suggestions = buildSkillSuggestions(skills);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]!.label, '$code-review');
  assert.equal(suggestions[0]!.trigger, '$');
  assert.equal(suggestions[0]!.data?.path, '/skills/code-review/SKILL.md');
  assert.equal(suggestions[0]!.data?.scope, 'user');
});

test('buildFileMentionMarkdown/buildSkillMentionMarkdown：canonical markdown 形态', () => {
  // 裸路径补 ./
  assert.equal(buildFileMentionMarkdown('README.md', 'README.md'), '[README.md](./README.md)');
  // 目录补尾斜杠
  assert.equal(buildFileMentionMarkdown('src/', 'src', 'directory'), '[src](./src/)');
  // 已是 ./ 前缀不重复
  assert.equal(buildFileMentionMarkdown('./a/b.txt', 'b.txt'), '[b.txt](./a/b.txt)');
  // label 转义 []；destination 仅转义 \ 与 >（上游 escapeMarkdownDestination 口径）
  assert.equal(buildFileMentionMarkdown('a[1].md', 'a[1].md'), '[a\\[1\\].md](./a[1].md)');
  // skill：无 path 回退 $slug；有 path 为链接载体
  assert.equal(buildSkillMentionMarkdown('code-review'), '$code-review');
  assert.equal(buildSkillMentionMarkdown('code-review', '/s/SKILL.md'), '[$code-review](/s/SKILL.md)');
});

// —— 提交路径命令分发（块E3扩展：/name args 本地执行，参照上游提交解析与别名保留集语义）——

test('parseSlashSubmission：整条输入为命令形态时解析 name/args', () => {
  assert.deepEqual(parseSlashSubmission('/compact'), { name: 'compact', args: '' });
  assert.deepEqual(parseSlashSubmission('/goal 修复登录 bug'), { name: 'goal', args: '修复登录 bug' });
  // 大小写归一、多余前导斜杠剥除
  assert.deepEqual(parseSlashSubmission('//Plan  先分析'), { name: 'plan', args: '先分析' });
  // 参数可含换行（多行任务文本）
  assert.deepEqual(parseSlashSubmission('/plan 第一步\n第二步'), { name: 'plan', args: '第一步\n第二步' });
  // 前后空白剥除后仍是命令
  assert.deepEqual(parseSlashSubmission('  /new  '), { name: 'new', args: '' });
  // 非命令形态：普通文本、句中斜杠、裸斜杠、无 name
  assert.equal(parseSlashSubmission('普通任务'), null);
  assert.equal(parseSlashSubmission('看看 /etc/hosts 的内容'), null);
  assert.equal(parseSlashSubmission('/'), null);
  assert.equal(parseSlashSubmission('/  args'), null);
  assert.equal(parseSlashSubmission(''), null);
});

test('matchAppSlashCommand：主名/别名命中（大小写与前导斜杠归一），未命中返回 null', () => {
  const commands = [
    { value: 'new', aliases: ['clear'], description: '新任务', run: () => {} },
    { value: 'compact', aliases: ['compress'], description: '压缩', run: () => {} },
  ];
  assert.equal(matchAppSlashCommand(commands, 'new')?.value, 'new');
  assert.equal(matchAppSlashCommand(commands, '/CLEAR')?.value, 'new'); // 别名＋大小写＋前导斜杠
  assert.equal(matchAppSlashCommand(commands, 'compress')?.value, 'compact');
  assert.equal(matchAppSlashCommand(commands, 'files'), null);
  assert.equal(matchAppSlashCommand(commands, ''), null);
});

test('buildAppSlashCommandSuggestions：别名进关键词，搜 clear 命中 /new', () => {
  const suggestions = buildAppSlashCommandSuggestions([{ value: 'new', aliases: ['clear'], description: '开始新任务', run: () => {} }]);
  assert.equal(suggestions.length, 1);
  assert.ok(suggestions[0]!.keywords!.includes('clear'));
  const filtered = filterPromptInputSuggestions(suggestions, 'clear');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.value, 'new');
});
