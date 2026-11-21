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
