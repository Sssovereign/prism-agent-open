import type { ResearchRecord, ResearchReport, ResearchSubject, ResearchView } from '../../contracts/research.js';

/** 研究面板的纯视图逻辑：阶段导航、主张回应定位、输入视野分类。node:test 可直接验证。 */

export interface ResearchPhaseLite {
	id: string; label: string; role: string; ordinal: number;
	phaseKey?: string; roundNo?: number; status: string; sealed?: boolean;
	model?: { displayName?: string } | null;
}

/** 阶段导航标签：辩论=正方/反方开题＋第N轮交锋＋主持；评审=陪审员一/二/三＋汇总。文案由调用方按语言传入。 */
export function phaseNavLabel(phase: ResearchPhaseLite, labels: { role: string; opening: string; round: (round: number) => string }): string {
	if (phase.phaseKey?.startsWith('opening')) return `${labels.role} · ${labels.opening}`;
	if ((phase.roundNo ?? 0) > 0) return `${labels.role} · ${labels.round(phase.roundNo!)}`;
	return labels.role;
}

/** 左缘导航轨分组键：开题一对、每个轮次一对；主持与其它阶段按 phaseKey/角色自成组，换组留空档。 */
export function railGroupKey(phase: ResearchPhaseLite): string {
	if (phase.phaseKey?.startsWith('opening')) return 'opening';
	if ((phase.roundNo ?? 0) > 0) return `round:${phase.roundNo}`;
	return phase.phaseKey ?? phase.role;
}

/** 滚动停留判定：锚线（视口顶＋阈值）之上最后一个阶段算当前停留；触底兜底最后一个阶段；无条目返回空串。 */
export function phaseAtScroll(entries: Array<{ id: string; top: number }>, anchorTop: number, atBottom = false): string {
	if (!entries.length) return '';
	if (atBottom) return entries[entries.length - 1]!.id;
	let current = '';
	for (const entry of entries) if (entry.top <= anchorTop) current = entry.id;
	return current;
}

export interface ClaimTarget { phaseId: string | null; roleLabel: string; roundNo: number; claimNo: number; text: string }

/** 已发布主张可以定位到本轮发言或继承记录中的正文。 */
export function claimTargetIndex(records: ResearchRecord[], phaseOf: (phaseTaskId: string) => { label: string; roundNo: number } | null): Map<string, ClaimTarget> {
	const index = new Map<string, ClaimTarget>();
	for (const record of records) {
		const claims = storedClaims(record);
		const phase = record.phaseTaskId ? phaseOf(record.phaseTaskId) : null;
		claims.forEach((claim, i) => {
			index.set(claim.id, { phaseId: phase ? record.phaseTaskId : null, roleLabel: phase?.label ?? record.title, roundNo: phase?.roundNo ?? 0, claimNo: i + 1, text: claim.text });
		});
	}
	return index;
}

export function storedClaims(record: ResearchRecord): Array<{ id: string; text: string; evidence?: Array<{ sourceId: string; quote: string }> }> {
	if (!record.published || !['statement', 'host', 'opinion', 'verdict'].includes(record.kind)) return [];
	try {
		const claims = JSON.parse(record.content)?.claims;
		return Array.isArray(claims) ? claims.filter(c => c && typeof c.id === 'string' && typeof c.text === 'string') : [];
	} catch { return []; }
}

/** Seed a proposal or claim; the previous recommendation and its rationale stay in the source report. */
export function reviewSubjectFor(report: ResearchReport, objective: string, claim?: string): ResearchSubject {
	const candidate = report.decision?.candidates.find(item => item.id === report.disposition?.candidateId)?.text;
	if (!claim && report.subject) return report.subject;
	const content = claim || candidate || objective;
	return { title: (candidate && !claim ? candidate : objective || content).slice(0, 200), content: content.slice(0, 20_000) };
}

/** 发言记录JSON安全取摘要：output.summary优先，回退正文前段。 */
export function speechSummary(output: { summary?: string; text?: string } | null | undefined, fallbackChars = 140): string {
	if (!output) return '';
	const summary = typeof output.summary === 'string' && output.summary.trim() ? output.summary.trim() : '';
	if (summary) return summary;
	const text = typeof output.text === 'string' ? output.text.trim() : '';
	return text.length > fallbackChars ? `${text.slice(0, fallbackChars)}…` : text;
}

/** 程序多数判定：同一判定至少两票才算多数；票型分散返回null（界面显示「无多数意见」）。 */
export function majorityVerdict(tally: Record<string, number> | null | undefined): { key: string; count: number } | null {
	if (!tally) return null;
	let best: { key: string; count: number } | null = null;
	for (const [key, count] of Object.entries(tally)) {
		if (count >= 2 && (!best || count > best.count)) best = { key, count };
	}
	return best;
}

export interface InputViewSummary {
	sourceCount: number; speechCount: number; supplementVersion: number; webSearch: boolean;
	categories: Array<{ key: 'sources' | 'speeches' | 'supplements'; titles: string[] }>;
}

/** 输入视野：固定视图的分类摘要；联网搜索状态直接取冻结视图tools是否含web_search。 */
export function inputViewOf(view: ResearchView, records: ResearchRecord[]): InputViewSummary {
	const inView = new Set(view.recordIds);
	const visible = records.filter(r => inView.has(r.id));
	const sources: string[] = [], speeches: string[] = [], supplements: string[] = [];
	for (const record of visible) {
		if (record.kind === 'source') sources.push(record.title);
		else if (record.kind === 'supplement') supplements.push(record.title);
		else if (record.published) speeches.push(record.title);
	}
	return {
		sourceCount: sources.length, speechCount: speeches.length,
		supplementVersion: view.supplementThrough, webSearch: view.tools.includes('web_search'),
		categories: [
			{ key: 'sources' as const, titles: sources },
			{ key: 'speeches' as const, titles: speeches },
			{ key: 'supplements' as const, titles: supplements },
		].filter(c => c.titles.length),
	};
}

/** v2处置按类型应展示的字段（candidateId面板解析为候选文本；basisClaimIds统一渲染为定位按钮，不在此列）。 */
export function dispositionFields(kind: string): string[] {
	if (kind === 'adopt') return ['candidateId', 'hardConstraints'];
	if (kind === 'trial') return ['scope', 'successCriteria', 'reEvalTrigger'];
	if (kind === 'defer') return ['missingEvidence', 'howToObtain', 'reDecisionConditions'];
	return [];
}

/* ---- 决定草稿归一化：折叠摘要与提交共用同一事实源（后端口径：命题≤2000字、候选2—6项、每项≤500字）。 ---- */

export const DECISION_PROPOSITION_MAX = 2000;
export const DECISION_CANDIDATE_MAX = 500;
export const DECISION_CANDIDATES_MIN = 2;
export const DECISION_CANDIDATES_MAX = 6;
/** 分析方法上限（与服务端 RESEARCH_METHOD_MAX 同口径；发起时显式挑字段）。 */
export const RESEARCH_METHOD_MAX = 3;

export interface ResearchDecisionDraft { proposition: string; candidates: Array<{ text: string }> }

export type DecisionIssue =
	| 'proposition-empty'        // 命题与议题都拿不出非空命题
	| 'proposition-too-long'     // 命题（显式或回退自议题）超过2000字
	| 'candidates-insufficient'  // 非空候选不足2项
	| 'candidates-too-many'      // 非空候选超过6项
	| 'candidate-too-long';      // 存在超过500字的候选

export interface DecisionNormalization {
	proposition: string;                 // 提交用命题（trim；显式优先，回退议题）
	propositionFromObjective: boolean;   // 命题是否回退自议题
	candidates: Array<{ text: string }>; // trim 剔空后的候选
	ready: boolean;                      // decisionOn 时能否提交（与后端校验同口径）
	issues: DecisionIssue[];
}

/** 归一化决定草稿：显式命题优先、回退议题；候选 trim 剔空；issues 与后端校验同口径。 */
export function normalizeDecision(decision: ResearchDecisionDraft | null | undefined, objective: string): DecisionNormalization {
	const rawProposition = decision?.proposition?.trim() ?? '';
	const topic = objective?.trim() ?? '';
	const propositionFromObjective = !rawProposition && !!topic;
	// 回退议题不做静默截断：议题超长时命题置空并标记 issue，要求用户显式写一句短命题
	const proposition = rawProposition || (topic.length <= DECISION_PROPOSITION_MAX ? topic : '');
	const candidates = (decision?.candidates ?? [])
		.map(c => ({ text: (c?.text ?? '').trim() }))
		.filter(c => c.text.length > 0);
	const issues: DecisionIssue[] = [];
	const effective = rawProposition || topic;
	if (!effective) issues.push('proposition-empty');
	else if (effective.length > DECISION_PROPOSITION_MAX) issues.push('proposition-too-long');
	if (candidates.length < DECISION_CANDIDATES_MIN) issues.push('candidates-insufficient');
	else if (candidates.length > DECISION_CANDIDATES_MAX) issues.push('candidates-too-many');
	if (candidates.some(c => c.text.length > DECISION_CANDIDATE_MAX)) issues.push('candidate-too-long');
	return { proposition, propositionFromObjective, candidates, ready: issues.length === 0, issues };
}
