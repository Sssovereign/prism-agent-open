/** 研究协议契约。0.0.2-beta 落地 v1（辩论/陪审初版）；0.2 计划落地 v2（决策处置与标准评审）。
 * Actor identity is assigned by the coordinator. */
export type ResearchMode = 'debate' | 'jury';
export type ResearchRole = 'pro' | 'con' | 'host' | 'juror' | 'aggregate';
export const RESEARCH_VERDICTS = ['pro', 'con', 'mixed', 'insufficient', 'abstain'] as const;
export type ResearchVerdict = typeof RESEARCH_VERDICTS[number];
/** v2 独立评审票型：通过/有条件通过分别计票；弃权须说明原因。 */
export const RESEARCH_V2_VERDICTS = ['pass', 'conditional_pass', 'fail', 'insufficient', 'abstain'] as const;
export type ResearchV2Verdict = typeof RESEARCH_V2_VERDICTS[number];
/** v2 逐项标准判定。 */
export const CRITERION_STATUSES = ['satisfied', 'unmet', 'insufficient'] as const;
export type CriterionStatus = typeof CRITERION_STATUSES[number];
/** v2 辩论决策处置：采用指向候选并说明硬约束；试验写明范围/成功条件/复评触发；暂缓写明缺失证据/取得方式/重新裁决条件。 */
export const DISPOSITION_KINDS = ['adopt', 'trial', 'defer'] as const;
export type DispositionKind = typeof DISPOSITION_KINDS[number];
export interface ResearchModelChoice { modelConfigId: string; modelId: string }
export interface ResearchSourceInput { title: string; content: string; url?: string }
/** 共同资料文件引用：用户经UI发起，服务端按授权读取文本并切段入库（资料中的指令不构成权限）。 */
export interface ResearchSourceFileInput { grantId: string; relativePath: string }
/** 研究冻结的MCP工具清单条目（发起时用户显式勾选的只读声明工具；执行侧boot与dispatch共用同一份manifest）。 */
export interface ResearchMcpManifestEntry {
  qualifiedName: string; serverId: string; serverName: string; toolName: string;
  description: string; inputSchema: Record<string, unknown>; readOnly: boolean; bindingHash: string;
}
/** 研究能力快照（非私有，存 runs.config_snapshot_json.researchCapabilities）。 */
export interface ResearchCapabilitySnapshot {
  /** 装配版本：2=静态块先扣+1200预览+url元数据；缺省/1=旧run走v1装配（retry行为不变）。 */
  assemblyVersion: number;
  /** 主持/汇总可用 verify_source 核验引证来源。 */
  hostVerify: boolean;
  /** 记忆索引已注入（对应private_json.memoryIndex）。 */
  memory: boolean;
  mcpTools: ResearchMcpManifestEntry[];
  /** 冻结的分析方法摘要（正文在private_json，摘要只含名称/哈希/长度）。 */
  methods: Array<{ name: string; displayName: string; sha256: string; chars: number }>;
  /** 运行时复用普通Agent能力：true=附带普通项目读取工具/已启用技能/项目规则/附加目录/显式附件；
   *  旧run与显式固定v1的run缺省=旧受限视图（重试与受控回归不漂移）。 */
  ordinaryTools?: boolean;
}
/** 研究显式图片附件快照（创建时冻结进 runs.config_snapshot_json.researchAttachments；
 *  只存元数据，运行中经原附件文件读取字节转Pi图片输入，base64不落任何研究表）。 */
export interface ResearchAttachmentMeta { id: string; mime: string; sizeBytes: number; sha256: string; displayName: string }
/** 研究私有正文（存 research_runs.private_json；不进 runs.config_snapshot_json，fork 不触碰）。 */
export interface ResearchPrivateSnapshot {
  methods: Array<{ name: string; content: string }>;
  memoryIndex: string | null;
}
export interface ResearchClaim {
  key: string; text: string;
  evidence: Array<{ sourceId: string; quote: string }>;
  respondsTo?: string[];
}
/** v2 辩论「需要做决定」配置：创建时冻结候选及其ID；更换命题或候选须另建研究。 */
export interface ResearchCandidate { id: string; text: string }
export interface ResearchDecisionConfig { required: boolean; proposition: string; candidates: ResearchCandidate[] }
/** v2 独立评审被评对象快照。 */
export interface ResearchSubject { title: string; content: string }
export interface ResearchCriterionInput { id?: string; text: string; mustHave: boolean }
export interface ResearchCriterion { id: string; text: string; mustHave: boolean }
export interface ResearchDisposition {
  kind: DispositionKind;
  candidateId?: string; hardConstraints?: string; basisClaimIds?: string[];
  scope?: string; successCriteria?: string; reEvalTrigger?: string;
  missingEvidence?: string; howToObtain?: string; reDecisionConditions?: string;
}
export interface CriterionEvaluation {
  criterionId: string; status: CriterionStatus; reason: string;
  evidence?: Array<{ sourceId: string; quote: string }>;
}
/** 异议目标：运行中/终态异议指向具体已发布主张；整份结论在成功出报告后随复核创建进入新研究。 */
export type ResearchObjectionTarget = { type: 'claim'; claimId: string } | { type: 'conclusion' };
/** v2主持/汇总对用户异议的逐条回应；objectionId为服务端创建的异议研究记录ID。 */
export interface ResearchObjectionResponse { objectionId: string; resolution: 'accepted' | 'rejected' | 'partial' | 'unresolved'; reason: string }
export interface ResearchSubmission {
  text: string;
  /** 发言摘要：v1所有角色可选（≤600字符）；v2主持与汇总须提供非空摘要。 */
  summary?: string;
  claims: ResearchClaim[];
  limitations: string[];
  verdict?: ResearchVerdict | ResearchV2Verdict;
  objections?: Array<{ claimId: string; resolution: 'accepted' | 'rejected' | 'partial' | 'unresolved'; reason: string }>;
  /** v2 辩论主持决策处置。 */
  disposition?: ResearchDisposition;
  /** v2 陪审员逐项标准判定。 */
  criterionEvaluations?: CriterionEvaluation[];
  /** v2 陪审员弃权原因（弃权必填）。 */
  abstainReason?: string;
  /** v2 陪审员有条件通过的待达成条件（须对应标准）。 */
  pendingConditions?: Array<{ criterionId: string; text: string }>;
  /** v2 主持/汇总对用户异议的逐条回应（覆盖视图内全部异议记录）。 */
  objectionResponses?: ResearchObjectionResponse[];
  /** v2 汇总阻断项（带标准ID）。 */
  blockingItems?: Array<{ criterionId: string; reason: string }>;
  /** v2 汇总下一步建议。 */
  nextSteps?: string[];
}
export interface ResearchRecord {
  id: string; kind: string; participantId: string | null; phaseTaskId: string | null;
  title: string; content: string; hash: string; url: string | null; truncated: boolean; published: boolean;
}
export interface ResearchView {
  id: string; participantId: string; phaseTaskId: string; role: ResearchRole;
  recordIds: string[]; hashes: Record<string, string>; tools: string[];
  supplementThrough: number; policyVersion: string;
}
export interface ResearchReport {
  version: 1 | 2; runId: string; mode: ResearchMode; text: string;
  /** 最终摘要：v1来自汇总发言的可选summary（历史报告缺省时使用原正文回退）；v2主持/汇总必填。 */
  summary?: string;
  execution: 'complete' | 'early_summary'; evidenceStatus: 'cited' | 'insufficient';
  sourceCount: number; evidenceCount: number; claimCount: number;
  /** v1为支持/反对等票型；v2为通过/有条件通过等票型，均由程序从锁定意见计算。 */
  tally: Record<string, number> | null;
  limitations: string[]; recordIds: string[];
  /** 以下为 v2 字段（v1 报告缺省）。 */
  majority?: { key: string; count: number } | null;
  disposition?: ResearchDisposition;
  decision?: ResearchDecisionConfig;
  subject?: ResearchSubject;
  criteria?: ResearchCriterion[];
  criterionSummary?: Array<{ id: string; text: string; mustHave: boolean; satisfied: number; unmet: number; insufficient: number }>;
  blockingItems?: Array<{ criterionId: string; reason: string }>;
  nextSteps?: string[];
  /** 用户异议及其逐条回应（两种模式只要有异议就组装；objectionId为记录ID）。 */
  objections?: Array<{ id: string; target: ResearchObjectionTarget; text: string; responses: Array<ResearchObjectionResponse & { responder: string }> }>;
}
