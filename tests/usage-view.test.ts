import test from 'node:test';
import assert from 'node:assert/strict';
import type { UsageSnapshot } from '../contracts/usage.js';
import { adaptUsage, cachePercent, contextPercent, finiteCount, formatDuration, formatExact, formatRate, formatTokens, metric, metricText } from '../web/view-model/usage.js';

function snapshot(): UsageSnapshot {
  const known = () => ({ knownRequests: 2, unknownRequests: 0 });
  return {
    scope: 'conversation', conversationId: 'c',
    activity: { turns: 3, turnsBasis: 'conversation_runs', steps: 2, llmMs: 2000, toolMs: null, averageTtftMs: 200, ttftSamples: 2, llmSamples: 2, toolSamples: 0, unknownLlmCount: 0, unknownToolCount: 1 },
    byKind: [], totals: { requests: 2, unknownCount: 0, inputTokens: 100, uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0, reasoningTokens: 5, totalInputTokens: 1000, totalTokens: 1020, complete: true, coverage: { input: known(), output: known(), cacheRead: known(), cacheWrite: known(), reasoning: known(), totalInput: known() } },
    context: { tokens: 1000, window: 10000, reserveTokens: 1000, source: 'last_request', requestId: 'q', runId: 'r', measuredAt: '2026-11-12T12:00:00Z', isCurrent: false, estimated: false, windowSource: 'request_snapshot' },
    speed: { sessionTokPerMs: .02, lastRequestTokPerMs: .03, lastTurnTokPerMs: .03, samples: 2, decodeTokens: 20, decodeMs: 1000 },
    lastRequest: null, byModel: [], requests: [], requestPage: { hasMore: false, nextBefore: null },
  };
}
test('formatters distinguish missing, invalid and measured zero', () => {
  for (const v of [null, undefined, NaN, Infinity, -1]) { assert.equal(finiteCount(v), null); assert.equal(formatTokens(v), '—'); }
  assert.equal(formatTokens(0), '0'); assert.equal(formatExact(10000), '10,000');
  assert.equal(formatTokens(1000), '1k'); assert.equal(formatTokens(999950), '1M');
  assert.equal(formatTokens(1_200_000), '1.2M');
  assert.equal(formatRate(null), '—'); assert.equal(formatRate(0), '0 tok/s'); assert.equal(formatRate(.1234), '123.4 tok/s');
  assert.equal(formatDuration(null), '—'); assert.equal(formatDuration(0), '0s'); assert.equal(formatDuration(162000), '2m42s');
});
test('availability honors per-field evidence, partial subtotal and real zero', () => {
  assert.equal(metricText(metric(0, { knownRequests: 0, unknownRequests: 2 })), '—');
  assert.equal(metricText(metric(0, { knownRequests: 2, unknownRequests: 0 })), '0');
  assert.equal(metricText(metric(100, { knownRequests: 1, unknownRequests: 1 })), '100+');
  assert.equal(metric(null, { knownRequests: 2, unknownRequests: 0 }).availability, 'unknown');
});
test('cache percent uses complete prompt-side denominator and avoids false full hit', () => {
  const m = (v: number) => metric(v, { knownRequests: 1, unknownRequests: 0 });
  assert.equal(cachePercent(m(90), m(100)), '90'); assert.equal(cachePercent(m(0), m(100)), '0');
  assert.equal(cachePercent(m(99999), m(100000)), '99.9'); assert.equal(cachePercent(m(100), m(100)), '100');
  assert.equal(cachePercent(m(1), m(0)), null); assert.equal(cachePercent(m(101), m(100)), null);
  assert.equal(cachePercent(metric(10, { knownRequests: 1, unknownRequests: 1 }), m(100)), null);
});
test('context keeps zero, unknown and overflow distinct', () => {
  assert.equal(contextPercent(0, 100), 0); assert.equal(contextPercent(null, 100), null);
  assert.equal(contextPercent(50, 0), null); assert.equal(contextPercent(150, 100), 150);
  const s = snapshot(); s.context.tokens = 15000;
  const view = adaptUsage(s); assert.equal(view.context.percent, 150); assert.equal(view.context.ringPercent, 100);
  assert.equal(view.context.requestId, 'q');
});
test('adapter uses durable aggregates, activity and correctly excludes reasoning double count', () => {
  const s = snapshot(), view = adaptUsage(s);
  assert.equal(view.total.value, 1020); assert.equal(view.totalInput.value, 1000); assert.equal(view.input.value, 100);
  assert.equal(view.cacheHit, '90'); assert.equal(view.activity?.turns, 3); assert.equal(view.activity?.steps, 2);
  assert.equal(view.activity?.toolMs, null); assert.equal(view.lastRate, .03); assert.equal(view.sessionRate, .02);
  s.requestPage.hasMore = true; assert.equal(adaptUsage(s).total.value, 1020);
});
test('paired total coverage follows actual missing pairs, not marginal field minimum', () => {
  const s = snapshot(); s.totals.requests = 3; s.totals.unknownCount = 2; s.totals.totalTokens = 400;
  s.totals.coverage.totalInput = { knownRequests: 2, unknownRequests: 1 };
  s.totals.coverage.output = { knownRequests: 2, unknownRequests: 1 };
  const view = adaptUsage(s); assert.equal(view.total.known, 1); assert.equal(view.total.unknown, 2); assert.equal(metricText(view.total), '400+');
});
test('absent/legacy data do not invent evidence or activity', () => {
  const absent = adaptUsage(null); assert.equal(absent.total.value, null); assert.equal(absent.context.percent, null); assert.equal(absent.activity, null); assert.equal(absent.samples, null); assert.equal(absent.requests, null);
  const old = { totals: { requests: 2, unknownCount: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, context: { tokens: null, window: null, reserveTokens: 0 }, speed: { sessionTokPerMs: null, lastTurnTokPerMs: null, samples: 0 } };
  const v = adaptUsage(old); assert.equal(v.input.value, null); assert.equal(v.output.value, null); assert.equal(v.read.value, null); assert.equal(v.cacheHit, null); assert.equal(v.activity, null);
});
test('missing modern cache field is not shown as legacy default zero', () => {
  const s = snapshot(); s.totals.coverage.cacheRead = { knownRequests: 0, unknownRequests: 2 }; s.totals.cacheReadTokens = 0;
  const v = adaptUsage(s); assert.equal(v.read.value, null); assert.equal(v.cacheHit, null);
});

test('legacy gaps keep observed subtotals and latest request cache ratio visible', () => {
 const s=snapshot();s.totals.requests=13;s.totals.unknownCount=6;s.totals.totalTokens=24639;
 for(const key of ['totalInput','output','cacheRead','reasoning'] as const)s.totals.coverage[key]={knownRequests:7,unknownRequests:6};
 s.totals.totalInputTokens=23368;s.totals.outputTokens=1271;s.totals.cacheReadTokens=17408;
 s.totals.cacheWriteTokens=null;s.totals.coverage.cacheWrite={knownRequests:0,unknownRequests:13};
 s.lastRequest={requestId:'latest',runId:'r',provider:'custom',model:'example',kind:'main',status:'completed',inputTokens:null,outputTokens:303,cacheRead:4608,cacheWrite:null,reasoning:0,totalInputTokens:4819,usageSource:'partial',evidence:null,ttftMs:100,firstTextMs:100,latencyMs:1000,startedAt:null,completedAt:null,tokPerMs:null};
 const view=adaptUsage(s);assert.equal(view.cacheHit,null);assert.equal(view.lastCacheHit,'95.6');
 assert.equal(metricText(view.read),'17.4k+');assert.equal(metricText(view.total),'24.6k+');assert.equal(view.write.value,null);
});
