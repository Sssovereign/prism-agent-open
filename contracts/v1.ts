// contract.v1.schema.json 的TS镜像类型（手写，与schema经测试夹具互相钉住；运行时校验以schemas.ts为准）。
// UUID 统一为小写十六进制格式（schema pattern 固定）。
export type Uuid = string;
export type RoleId = 'ordinary' | 'pro' | 'con' | 'host';
export type Mode = 'ordinary' | 'debate' | 'jury';

export interface ResourceRef { resourceId: Uuid; version: number }
export interface GrantRef { grantId: Uuid; revision: number }

export interface RoleBindingInput { role: RoleId; modelConfigId: Uuid; modelId: string; thinkingLevel?: import('./models.js').ThinkingLevel }

/** ordinary：恰1个ordinary角色、无rounds；debate：pro/con/host各1、rounds 1—3（schema oneOf + contains约束）。 */
export interface CreateRunOrdinary {
  conversationId: Uuid; problemVersionId: Uuid; mode: 'ordinary';
  resources: ResourceRef[]; grants: GrantRef[];
  agents: [RoleBindingInput & { role: 'ordinary' }];
  limitsProfile: 'standard-v1';
}
export interface CreateRunDebate {
  conversationId: Uuid; problemVersionId: Uuid; mode: 'debate'; rounds: number;
  resources: ResourceRef[]; grants: GrantRef[];
  agents: [RoleBindingInput & { role: 'pro' }, RoleBindingInput & { role: 'con' }, RoleBindingInput & { role: 'host' }];
  limitsProfile: 'standard-v1';
}
export type CreateRun = CreateRunOrdinary | CreateRunDebate;

/** Runtime validates each requested field against the model capability allowlist. */
export interface ModelParameters { temperature?:number; contextWindow?:number; maxOutputTokens?:number; thinkingMode?:'auto'|'on'|'off'; thinkingLevel?:import('./models.js').ThinkingLevel; advanced?:import('./models.js').ModelAdvancedOptions; }
export interface ModelEntryInput {
  modelId: string; displayName: string;
  enabled: boolean;
  parameters: Record<string, unknown>;
}
export type ModelProtocol = 'openai-completions' | 'anthropic-messages';
export interface ModelConfigInput {
  protocol?: ModelProtocol;
  preset: 'deepseek' | 'glm-cn-coding' | 'glm-cn-standard' | 'glm-global-coding' | 'glm-global-standard' | 'qianfan' | 'kimi' | 'qwen' | 'minimax' | 'xiaomi' | 'hunyuan' | 'volcengine' | 'stepfun' | 'siliconflow' | 'openai' | 'anthropic' | 'xai' | 'openrouter' | 'opencode' | 'custom';
  name: string; baseUrl: string; models: ModelEntryInput[];
  /** 为该接口启用联网搜索（学 ZCode 能力勾选）：勾选时后端按 baseUrl 推导搜索厂商并持久化，运行时优先复用本接口 Key。 */
  searchEnabled?: boolean;
}
export interface CredentialInput { apiKey: string }

export interface SupplementInput {
  clientMessageId: Uuid; content: string; kind: 'supplement';
  resourceRefs?: ResourceRef[];
}
export interface ApprovalDecision { decision: 'approve' | 'reject'; paramsHash: string }

export type RunEventType =
  | 'run.created' | 'run.started' | 'run.phase_changed' | 'run.status_changed'
  | 'agent.started' | 'agent.message_delta' | 'agent.message_committed' | 'agent.failed'
  | 'tool.proposed' | 'tool.started' | 'tool.result'
  | 'approval.requested' | 'approval.decided' | 'approval.expired'
  | 'evidence.published' | 'artifact.created' | 'workspace.changed' | 'publication.conflict'
  | 'usage.recorded' | 'message.accepted' | 'message.consumed'
  | 'run.summarize_requested' | 'run.cancel_requested' | 'run.ended' | 'attempt.reconciled'
  | 'run.retry_scheduled' | 'run.retry_finished';
export type EventVisibility = 'public' | 'private' | 'system';

export interface RunEvent {
  schemaVersion: 'v1';
  eventId: Uuid; runId: Uuid; seq: number; at: string;
  type: RunEventType;
  visibility: EventVisibility;
  phaseTaskId?: Uuid; attemptId?: Uuid;
  payload: Record<string, unknown>;
}

export type ToolResultStatus = 'succeeded' | 'denied' | 'failed' | 'cancelled' | 'unknown';
export interface ToolResult {
  toolCallId: Uuid; status: ToolResultStatus;
  output: Record<string, unknown>;
  resourceRefs?: ResourceRef[]; evidenceIds?: Uuid[]; artifactIds?: Uuid[];
  errorCode?: string | null;
}

export interface TaskDelivery {
  summary: string;
  argumentIds?: Uuid[]; evidenceIds?: Uuid[]; artifactIds?: Uuid[];
  unknowns?: string[];
}
export interface ReportClaim {
  claimKey: string; text: string; stance: 'pro' | 'con' | 'host' | 'neutral';
  evidenceIds?: Uuid[]; respondsToIds?: Uuid[];
}
export interface Report {
  schemaVersion: 'v1';
  problemVersionId: Uuid; scope: string;
  sources: ResourceRef[];
  consensus: string[]; disagreements: string[];
  claims: ReportClaim[];
  risks: string[];
  unknowns: string[];
  partial: boolean; completionReason?: string;
}

export interface ErrorResponse {
  error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  requestId: Uuid;
}
