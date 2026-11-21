import type { ModelProtocol } from '../../contracts/v1.js';
import type { ContextMeasurement, UsageBuckets, UsageEvidence, UsageSource } from '../../contracts/usage.js';

export const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const nonempty = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

/** Raw provider evidence only: Pi initializes every usage bucket to zero even with no usage frame. */
export class ProviderMeasurement {
  readonly usage: UsageBuckets = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, totalInput: null };
  readonly evidence: UsageEvidence;
  firstChunkAt: string | null = null;
  firstGenerationDeltaAt: string | null = null;
  firstTextAt: string | null = null;
  firstToolDeltaAt: string | null = null;
  constructor(private readonly protocol: ModelProtocol = 'openai-completions') {
    this.evidence = { version: 1, protocol, rawUsageObserved: false, fields: [], inputSemantics: 'disjoint' };
  }
  observe(data: unknown, at = new Date().toISOString()): void {
    this.firstChunkAt ??= at;
    // Pi 1.5.1 passes the decoded wire chunk/event itself, not {data: event} or
    // a normalized assistant event. Never recursively unwrap arbitrary objects.
    const event = obj(data);
    const anthropic = this.protocol === 'anthropic-messages';
    const choice = obj(Array.isArray(event.choices) ? event.choices[0] : null);
    const delta = anthropic ? obj(event.delta) : obj(choice.delta);
    const block = anthropic && event.type === 'content_block_start' ? obj(event.content_block) : {};
    const text = nonempty(anthropic ? delta.text : delta.content) || (block.type === 'text' && nonempty(block.text));
    const thinking = nonempty(delta.thinking) || nonempty(delta.reasoning_content) || nonempty(delta.reasoning)
      || (block.type === 'thinking' && nonempty(block.thinking));
    const tools = anthropic ? nonempty(delta.partial_json) || (block.type === 'tool_use' && nonempty(block.name)) : Array.isArray(delta.tool_calls) && delta.tool_calls.some(call => {
      const fn = obj(obj(call).function);
      return nonempty(fn.name) || nonempty(fn.arguments);
    });
    if (text || thinking || tools) this.firstGenerationDeltaAt ??= at;
    if (text) this.firstTextAt ??= at;
    if (tools) this.firstToolDeltaAt ??= at;
    // Match the SDK's documented choice.usage compatibility fallback, without
    // consuming its normalized usage (which fills missing buckets with zero).
    const usagePath = anthropic && event.type === 'message_start' ? 'message.usage'
      : !anthropic && !event.usage && choice.usage ? 'choices[0].usage' : 'usage';
    const raw = usagePath === 'message.usage' ? obj(event.message).usage
      : usagePath === 'choices[0].usage' ? choice.usage : event.usage;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
    this.evidence.rawUsageObserved = true;
    const u = obj(raw);
    const set = (key: keyof UsageBuckets, value: unknown, field: string): void => {
      const n = count(value);
      if (n === null) return;
      this.usage[key] = n;
      const path = `${usagePath}.${field}`;
      if (!this.evidence.fields.includes(path)) this.evidence.fields.push(path);
    };
    if (anthropic) {
      set('input', u.input_tokens, 'input_tokens');
      set('output', u.output_tokens, 'output_tokens');
      set('cacheRead', u.cache_read_input_tokens, 'cache_read_input_tokens');
      set('cacheWrite', u.cache_creation_input_tokens, 'cache_creation_input_tokens');
      set('reasoning', obj(u.output_tokens_details).thinking_tokens, 'output_tokens_details.thinking_tokens');
      // Missing cache buckets are unknown; never infer that omitted means zero.
      this.usage.totalInput = this.usage.input !== null && this.usage.cacheRead !== null && this.usage.cacheWrite !== null
        ? this.usage.input + this.usage.cacheRead + this.usage.cacheWrite : null;
    } else {
      set('totalInput', u.prompt_tokens, 'prompt_tokens');
      set('output', u.completion_tokens, 'completion_tokens');
      const details = obj(u.prompt_tokens_details), output = obj(u.completion_tokens_details);
      if (details.cached_tokens != null) set('cacheRead', details.cached_tokens, 'prompt_tokens_details.cached_tokens');
      else if (u.prompt_cache_hit_tokens != null) set('cacheRead', u.prompt_cache_hit_tokens, 'prompt_cache_hit_tokens');
      else set('cacheRead', u.cached_tokens, 'cached_tokens');
      set('cacheWrite', details.cache_write_tokens, 'prompt_tokens_details.cache_write_tokens');
      set('reasoning', output.reasoning_tokens, 'completion_tokens_details.reasoning_tokens');
      const { totalInput, cacheRead, cacheWrite } = this.usage;
      this.usage.input = totalInput !== null && cacheRead !== null && cacheWrite !== null && totalInput >= cacheRead + cacheWrite
        ? totalInput - cacheRead - cacheWrite : null;
    }
  }
  source(completed: boolean): UsageSource {
    if (!this.evidence.rawUsageObserved) return completed ? 'absent' : 'unknown';
    return this.usage.input !== null && this.usage.output !== null && this.usage.cacheRead !== null && this.usage.cacheWrite !== null ? 'provider' : 'partial';
  }
}

export function contextMeasurement(sample: { requestId: string; runId: string; tokens: number | null; at: string | null; window: number | null; reserve: number | null } | null,
  runWindow: number | null, defaultReserve: number): ContextMeasurement {
  const validWindow = (value: number | null | undefined): number | null => count(value) !== null && value! > 0 ? value! : null;
  const requestWindow = validWindow(sample?.window), fallbackWindow = validWindow(runWindow);
  const window = requestWindow ?? fallbackWindow;
  return { tokens: count(sample?.tokens), window,
    reserveTokens: sample?.reserve ?? Math.min(defaultReserve, Math.floor((window ?? defaultReserve * 4) / 4)),
    source: sample?.tokens != null ? 'last_request' : 'unavailable', requestId: sample?.requestId ?? null,
    runId: sample?.runId ?? null, measuredAt: sample?.at ?? null, isCurrent: false, estimated: false,
    windowSource: requestWindow !== null ? 'request_snapshot' : fallbackWindow !== null ? 'run_snapshot' : 'unavailable' };
}
