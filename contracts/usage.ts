/** Conversation-scoped DSH projection. Nullable counts mean unknown, never SDK defaults. */
export type UsageSource = 'provider' | 'partial' | 'absent' | 'unknown';
export interface UsageBuckets {
  /** Disjoint input bucket, excludes cache reads/writes. */
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** Subset of output; must not be added to total. */
  reasoning: number | null;
  totalInput: number | null;
}
export interface UsageEvidence {
  version: 1;
  protocol: 'openai-completions' | 'anthropic-messages' | 'legacy';
  rawUsageObserved: boolean;
  fields: string[];
  inputSemantics: 'disjoint' | 'unknown';
}
export interface BucketCoverage { knownRequests: number; unknownRequests: number }
export interface UsageRequest {
  requestId: string; runId: string; provider: string; model: string; kind: string; status: string;
  inputTokens: number | null; outputTokens: number | null; cacheRead: number | null;
  cacheWrite: number | null; reasoning: number | null; totalInputTokens: number | null;
  usageSource: UsageSource; evidence: UsageEvidence | null;
  ttftMs: number | null; firstTextMs: number | null; latencyMs: number | null;
  startedAt: string | null; completedAt: string | null;
  tokPerMs: number | null;
}
export interface ContextMeasurement {
  tokens: number | null; window: number | null; reserveTokens: number;
  source: 'last_request' | 'unavailable';
  requestId: string | null; runId: string | null; measuredAt: string | null;
  /** Provider usage prices the previous submitted prompt, not the current editable context. */
  isCurrent: false;
  estimated: boolean;
  windowSource: 'request_snapshot' | 'run_snapshot' | 'unavailable';
}
export interface UsageRequestPage { hasMore: boolean; nextBefore: string | null }
export interface UsageActivity {
  turns: number; turnsBasis: 'conversation_runs'; steps: number;
  /** Known duration subtotals; coverage counts identify incomplete observations. */
  llmMs: number | null; toolMs: number | null; averageTtftMs: number | null;
  ttftSamples: number; llmSamples: number; toolSamples: number;
  unknownLlmCount: number; unknownToolCount: number;
}
export interface UsageKindSummary {
  kind: 'main' | 'compaction' | 'repair' | 'memory_recall' | 'memory_extraction'; requests: number; unknownCount: number;
  totalInputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
}
export interface UsageSnapshot {
  activity: UsageActivity;
  byKind: UsageKindSummary[];
  scope: 'conversation'; conversationId: string;
  totals: {
    requests: number; unknownCount: number;
    inputTokens: number | null; outputTokens: number | null;
    /** Known subtotals; null means no observed value. Coverage identifies partial totals. */
    cacheReadTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null;
    uncachedInputTokens: number | null; totalInputTokens: number | null; totalTokens: number | null;
    coverage: Record<keyof UsageBuckets, BucketCoverage>;
    complete: boolean;
  };
  context: ContextMeasurement;
  speed: {
    sessionTokPerMs: number | null;
    /** @deprecated Alias of lastRequestTokPerMs, NOT a user turn metric. */
    lastTurnTokPerMs: number | null;
    lastRequestTokPerMs: number | null;
    samples: number; decodeTokens: number; decodeMs: number;
  };
  lastRequest: UsageRequest | null;
  byModel: Array<{ provider: string; model: string; requests: number; unknownCount: number; inputTokens: number | null; outputTokens: number | null }>;
  requests: UsageRequest[];
  requestPage: UsageRequestPage;
}
