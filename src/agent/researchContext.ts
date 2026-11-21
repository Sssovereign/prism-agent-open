import type { ResearchRecord } from '../../contracts/research.js';

/** Stored originals remain immutable; only the material embedded in a prompt is bounded. */
export function researchContextChars(contextWindow: number | null, maxOutputTokens: number): number {
  // 窗口未知（null＝目录未收录且未手填）时不做窗口推导，只保留绝对上限与协议余量：
  // 资料过量由真实请求的超限报错兜底，不按拍脑袋窗口折算。
  if (contextWindow === null) return 96_000 - 4_000;
  const reserve = Math.min(16_384, Math.floor(contextWindow / 4));
  // Leave room for protocol, tools and the next reply. This is a conservative assembly
  // budget, not a tokenizer; the request registry still checks the actual model request.
  return Math.max(0, Math.min(96_000, Math.floor((contextWindow - maxOutputTokens - reserve) * .5) - 4_000));
}

export function researchRecordPage(record: ResearchRecord, offset = 0, limit = 2_000) {
  const start = Math.min(offset, record.content.length), end = Math.min(record.content.length, start + limit);
  return { ...record, content: record.content.slice(start, end), offset: start,
    nextOffset: end < record.content.length ? end : null, totalChars: record.content.length,
    contentTruncated: start > 0 || end < record.content.length };
}

export function researchPromptRecords(records: ResearchRecord[], budget: number) {
  // Opinions/claims are most useful for synthesis. Their original order is stable within
  // each group; source IDs/hashes and visibility are unchanged by this presentation order.
  // 用户异议最优先：汇总/主持的必答清单需要目录与正文完整在场；超预算时先压后类，异议正文仍优先保留。
  const priority = (record: ResearchRecord) => record.kind === 'objection' ? 0 : record.kind === 'opinion' ? 1 : record.kind === 'host' ? 2 : record.kind === 'source' ? 4 : 3;
  const ordered = [...records].sort((left, right) => priority(left) - priority(right));
  const entries: unknown[] = [];
  let used = 0;
  for (const record of ordered) {
    const metadata = { id: record.id, kind: record.kind, title: record.title.slice(0, 200),
      hash: record.hash, totalChars: record.content.length, sourceTruncated: record.truncated };
    const preview = record.kind === 'source' ? record.content.slice(0, 240) : record.content;
    let entry = { ...metadata, content: preview, contentTruncated: preview.length < record.content.length };
    if (used + JSON.stringify(entry).length > budget) entry = { ...metadata, content: '', contentTruncated: !!record.content.length };
    const size = JSON.stringify(entry).length + 1;
    if (used + size > budget) {
      // 必答ID优先：异议目录条目降级为仅元数据也要保留（分页阅读可取回正文）；其余按预算略过。
      if (record.kind !== 'objection') continue;
    }
    entries.push(entry); used += size;
  }
  return { totalRecords: records.length, indexedRecords: entries.length, records: entries,
    completeIndex: entries.length === records.length,
    note: '这里只装载目录与有限正文；contentTruncated=true须用research_read按offset/limit分段核对。hash是保存的完整原文摘要。目录不全时用research_search query="*"分页列出全部可见记录；offset为UTF-16字符位置。' };
}
