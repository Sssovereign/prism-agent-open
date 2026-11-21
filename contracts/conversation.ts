import type { ReasoningSnapshot } from './reasoning.js';
/** Additive conversation projection contract; independent of the v1 audit schema. */
export interface ConversationEvent { runId?: string; eventId?: string; attemptId?: string | null; seq: number; occurredAt?: string; type: string; payload: Record<string, unknown> }
/** 块E2：用户消息图片附件元数据（正文经 /attachments/:id/raw 按需拉取，不入投影） */
export interface MessageAttachmentMeta { id: string; name: string; mime: string; sizeBytes: number }
export interface ConversationMessage { id: string; runId: string; authorType: string; seq: number; createdAt?: string; clientMessageId?: string | null; content: { text?: string; artifactIds?: string[]; sourceAssistantMessageId?: string; attachments?: MessageAttachmentMeta[] }; applied?: boolean }
export interface ConversationTool { invocationId: string; runId?: string; tool: string; state: string; args?: Record<string, unknown>; error?: string | null; createdAt?: string; durationMs?: number }
export interface ConversationApproval { approvalId: string; invocationId: string; state: string; tool?: string; args?: Record<string, unknown>; expiresAt?: string; review?: { text: string; truncated: boolean; label: string } | null }
export interface ConversationRun { id: string; mode: string; status: string; createdAt: string; endedAt?: string | null; stopReason?: string | null; throughSeq: number; messages: ConversationMessage[]; events: ConversationEvent[]; tools: ConversationTool[]; approvals: ConversationApproval[]; userQuestions?: import('./userQuestions.js').UserQuestionRequest[]; /** D86分叉式重答：被墓碑化的旧答复消息id——投影据此跳过其事件派生行，旧答案不再上屏 */ abandonedMessageIds?: string[] }
/** 阶段④续聊：研究锚点独立于分页窗口返回——普通run打开或刷新后据此重建研究面板。 */
export interface ConversationResearchAnchor { runId: string; mode: string; status: string; objective?: string }
export interface ConversationWindow { conversationId: string; runs: ConversationRun[]; hasOlder: boolean; before: string | null; research?: ConversationResearchAnchor }
export type ToolState = 'running' | 'awaiting_approval' | 'done' | 'failed' | 'deferred' | 'unknown' | 'cancelled';
export interface ConversationTextRow { kind: 'user' | 'assistant'; id: string; text: string; seq: number; createdAt?: string; artifactIds: string[]; attachments?: MessageAttachmentMeta[]; streaming?: boolean; final?: boolean; delivery?: 'accepted' | 'applied'; clientMessageId?: string | null }
export interface ConversationToolRow { kind: 'tool'; id: string; seq: number; invocationId: string; tool: string; state: ToolState; args?: Record<string, unknown>; error?: string; durationMs?: number; approval?: ConversationApproval }
export interface ConversationNoticeRow { kind: 'notice'; id: string; seq: number; text: string }
export interface ConversationReasoningRow extends ReasoningSnapshot { kind: 'reasoning'; id: string; seq: number }
export type ConversationRow = ConversationTextRow | ConversationToolRow | ConversationNoticeRow | ConversationReasoningRow;
export interface WorkSegment { id: string; triggerMessageIds: string[]; rows: ConversationRow[]; history: ConversationRow[]; final?: ConversationTextRow; defaultOpen: boolean }
export interface ConversationTurn { id: string; status: string; stopReason?: string | null; segments: WorkSegment[]; durationMs?: number }
