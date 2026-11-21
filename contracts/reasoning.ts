/** Owner-visible plaintext projection only; never a complete or decoded private chain of thought. */
export type ReasoningState = 'streaming' | 'completed' | 'interrupted';
export type ReasoningSource = 'openai.reasoning_content' | 'openai.reasoning' | 'openai.reasoning_text' | 'anthropic.thinking';
export interface ReasoningSnapshot {
  runId: string;
  attemptId: string;
  requestId: string;
  blockId: string;
  /** Monotone per block, independent of the run's persisted event seq. */
  revision: number;
  text: string;
  state: ReasoningState;
  source: ReasoningSource;
  truncated: boolean;
}
/** Defense in depth for history/live projection: construct a fresh allowlisted value. */
export function reasoningSnapshot(value: Record<string, unknown>): ReasoningSnapshot | undefined {
  const {runId,attemptId,requestId,blockId,revision,text,state,source,truncated}=value;
  if (![runId,attemptId,requestId,blockId].every(v=>typeof v==='string'&&v.length>0)
    || typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<1
    || typeof text!=='string'||!text.trim()
    || !['streaming','completed','interrupted'].includes(String(state))
    || !['openai.reasoning_content','openai.reasoning','openai.reasoning_text','anthropic.thinking'].includes(String(source))
    || typeof truncated!=='boolean') return undefined;
  return {runId:runId as string,attemptId:attemptId as string,requestId:requestId as string,blockId:blockId as string,revision,text,state:state as ReasoningState,source:source as ReasoningSource,truncated};
}
