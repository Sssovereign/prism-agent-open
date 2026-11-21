import { createHash } from 'node:crypto';
import { statSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../storage/db.js';
import type { GrantRow } from '../files/picker.js';
import type { SteerImage } from './attachments.js';
import { wasFileChangeReverted } from './fileRewind.js';

/**
 * 可信上下文清单（返修F01/F02/F05）：
 * - buildContextManifest：监督器（可信侧）在attempt启动时构建——同会话正式历史（用户目标与
 *   agent自然答复，不含工具原文）、同会话此前Run的已确认checkpoint摘要、项目AGENTS.md规则
 *   （按本机文件权限读取、限长并记录hash）、跨Run产物元数据。runner据此重建会话上下文。
 * - resolveRequestInput：模型请求输入绑定——runner报告inputThroughSeq（其请求体包含到的
 *   会话消息seq上界），可信层只把"seq≤上界的未消费公开用户消息"绑定到该请求；压缩/修复
 *   请求不消费主输入。绑定晚于请求体构造的用户消息保持未消费（门禁不放行），直到真正
 *   进入后续请求——消除"构造后到达却被标记已消费"的竞态（返修F05）。
 * 信任边界说明：inputThroughSeq来自经nonce握手的不可信runner，可信层仅能核对"不超前于
 * 会话实际seq、不落后于目标seq"这类一致性；正文是否真含该消息由body hash链与后续完成
 * 门禁（完成前复查未消费）共同兜底，本模块不做正文级核验（正文对可信层不可见）。
 */

export interface FormalHistoryMessage { role: 'user' | 'assistant'; text: string; at: number; images?: SteerImage[] }

export interface InheritedCheckpoint {
    checkpointId: string;
    summaryText: string;
    tokensAfter: number | null;
    createdAt: string;
    fromRunId: string;
}

export interface ProjectRules {
    path: 'AGENTS.md';
    content: string;
    hash: string;
    truncated: boolean;
    deniedReason?: undefined;
}

export interface ProjectRulesDenied { path: 'AGENTS.md'; content?: undefined; hash?: undefined; truncated?: undefined; deniedReason: string }

export interface ContextManifest {
    objective: string;
    objectiveMessageId: string;
    objectiveSeq: number;
    /** 块E2：目标消息图片附件（首请求随文本下发；文件丢失时静默降级为纯文本） */
    objectiveImages: SteerImage[];
    historyMessages: FormalHistoryMessage[];
    historyTruncated: boolean;
    /** 恢复模式正式历史包含本Run目标与补充，首请求只发继续指令。 */
    isResume: boolean;
    restoredInputThroughSeq: number;
    inheritedCheckpoint: InheritedCheckpoint | null;
    projectRules: ProjectRules | ProjectRulesDenied | null;
    inheritedArtifacts: Array<{ artifactId: string; name: string; hash: string; sizeBytes: number }>;
    revertedFiles: Array<{ path: string; revertedAt: string }>;
    /** F04副作用账本：本Run此前attempt已终结的工具调用（恢复时随清单下发，禁止重复执行已成功副作用） */
    toolLedger: Array<{ tool: string; ok: boolean; summary: string }>;
}

export const PROJECT_RULES_MAX_BYTES = 32 * 1024;

/** 按真实项目目录读取AGENTS.md，遵循宿主文件权限；缺失返回null。 */
export function readProjectRules(grant: GrantRow): ProjectRules | ProjectRulesDenied | null {
    try {
        let targetReal: string;
        try { targetReal = realpathSync(join(grant.canonical_root, 'AGENTS.md')); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
        const st = statSync(targetReal);
        if (!st.isFile()) return { path: 'AGENTS.md', deniedReason: 'RULE_NOT_FILE' };
        const bytes = readFileSync(targetReal);
        const truncated = bytes.byteLength > PROJECT_RULES_MAX_BYTES;
        const text = (truncated ? bytes.subarray(0, PROJECT_RULES_MAX_BYTES) : bytes).toString('utf8');
        if (bytes.includes(0)) return { path: 'AGENTS.md', deniedReason: 'RULE_BINARY' };
        return { path: 'AGENTS.md', content: text, hash: createHash('sha256').update(bytes).digest('hex'), truncated };
    }
    catch (error) {
        const detail = error instanceof Error ? ('code' in error ? String((error as { code?: unknown }).code) : error.message.slice(0, 40)) : 'UNKNOWN';
        return { path: 'AGENTS.md', deniedReason: `RULE_READ_FAILED:${detail}` };
    }
}

/**
 * 构建attempt的上下文清单。checkpointFrom='conversation'继承同会话此前Run的已确认checkpoint
 * （F01跨Run追问）；'run'继承本Run更早attempt的confirmed checkpoint（F04恢复）。
 */
export function buildContextManifest(db: Db, input: {
    runId: string;
    conversationId: string;
    grant: GrantRow;
    checkpointFrom: 'conversation' | 'run';
    /** 兼容既有调用方的checkpoint上限门禁——只继承覆盖到截断点之前的checkpoint（source_seq以消息seq计） */
    maxCheckpointSourceSeq?: number;
}): ContextManifest {
    const run = db.db.prepare('SELECT r.problem_version_id,p.owner_user_id FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=?').get(input.runId) as { problem_version_id: string; owner_user_id: string } | undefined;
    const objectiveRow = run
        ? db.db.prepare('SELECT objective FROM problem_versions WHERE id=?').get(run.problem_version_id) as { objective: string }
        : { objective: '' };
    const objectiveMessage = db.db.prepare(`SELECT id, seq, content_json FROM messages WHERE run_id=? AND author_type='user' AND state='published' ORDER BY seq ASC LIMIT 1`)
        .get(input.runId) as { id: string; seq: number; content_json: string } | undefined;

    // Rehydrate owned images for objectives, follow-ups and independent branches.
    function messageImages(contentJson: string): SteerImage[] {
        const images: SteerImage[] = [];
        try {
            const meta = JSON.parse(contentJson) as { attachments?: Array<{ id?: string }> };
            for (const item of Array.isArray(meta.attachments) ? meta.attachments : []) {
                if (typeof item.id !== 'string') continue;
                const row = db.db.prepare('SELECT internal_path,mime FROM attachments WHERE id=? AND owner_user_id=?').get(item.id,run?.owner_user_id??'') as {internal_path:string;mime:string}|undefined;
                if (!row || !existsSync(row.internal_path)) continue;
                images.push({mimeType:row.mime,data:readFileSync(row.internal_path).toString('base64')});
            }
        } catch { /* Missing historic assets do not prevent reading the remaining conversation. */ }
        return images;
    }
    const objectiveImages = objectiveMessage ? messageImages(objectiveMessage.content_json) : [];

    // 最近历史按seq取尾窗；所有尚未消费的用户输入额外保留，避免窗口截断后被游标误消费。
    // 恢复时连同当前Run目标/补充一起重建；新Run仍由prompt单独加入当前目标。
    const isResume = input.checkpointFrom === 'run';
    const eligible = `conversation_id=? AND (run_id<>? OR ?=1) AND state='published' AND visibility='public' AND author_type IN ('user','agent')`;
    const historyRows = db.db.prepare(`SELECT author_type, content_json, created_at, seq FROM messages
        WHERE ${eligible} AND (id IN (SELECT id FROM messages WHERE ${eligible} ORDER BY seq DESC LIMIT 200)
            OR (author_type='user' AND consumed_cursor_json IS NULL) OR id=?) ORDER BY seq ASC`)
        .all(input.conversationId, input.runId, Number(isResume), input.conversationId, input.runId, Number(isResume), objectiveMessage?.id ?? '') as unknown as
        Array<{ author_type: string; content_json: string; created_at: string; seq: number }>;
    const historyTotal = db.db.prepare(`SELECT COUNT(*) n FROM messages WHERE ${eligible}`)
        .get(input.conversationId, input.runId, Number(isResume)) as { n: number };
    const historyTruncated = historyTotal.n > historyRows.length;
    const restoredInputThroughSeq = historyRows.reduce((seq, m) => m.author_type === 'user' ? Math.max(seq, m.seq) : seq, objectiveMessage?.seq ?? 0);
    const historyMessages: FormalHistoryMessage[] = historyRows
        .map(m => {const images=m.author_type==='user'?messageImages(m.content_json):[];return {
            role: m.author_type === 'user' ? 'user' as const : 'assistant' as const,
            text: String((JSON.parse(m.content_json) as { text?: string }).text ?? ''),
            at: Date.parse(m.created_at),
            ...(images.length ? {images} : {}),
        };})
        .filter(m => m.text || m.images?.length);

    const checkpointRow = (!isResume && input.maxCheckpointSourceSeq !== undefined
        ? db.db.prepare(`SELECT c.id, c.summary_text, c.tokens_after, c.created_at, c.run_id FROM context_checkpoints c
        WHERE c.conversation_id=? AND c.state='confirmed' AND c.run_id<>? AND c.source_seq <= ?
        ORDER BY c.created_at DESC LIMIT 1`).get(input.conversationId, input.runId, input.maxCheckpointSourceSeq)
        : db.db.prepare(`SELECT c.id, c.summary_text, c.tokens_after, c.created_at, c.run_id FROM context_checkpoints c
        WHERE c.conversation_id=? AND c.state='confirmed' AND ${isResume ? 'c.run_id=?' : 'c.run_id<>?'}
        ORDER BY c.created_at DESC LIMIT 1`).get(input.conversationId, input.runId)) as unknown as
        { id: string; summary_text: string; tokens_after: number | null; created_at: string; run_id: string } | undefined;
    const inheritedCheckpoint: InheritedCheckpoint | null = checkpointRow ? {
        checkpointId: checkpointRow.id,
        summaryText: checkpointRow.summary_text,
        tokensAfter: checkpointRow.tokens_after,
        createdAt: checkpointRow.created_at,
        fromRunId: checkpointRow.run_id,
    } : null;

    const artifactRows = db.db.prepare(`SELECT a.id, a.display_name, a.hash, a.size_bytes FROM artifacts a
        JOIN runs r ON r.id=a.run_id WHERE r.conversation_id=? AND r.status='succeeded' AND a.state='verified'
        ORDER BY a.created_at DESC LIMIT 20`).all(input.conversationId) as unknown as Array<{ id: string; display_name: string; hash: string; size_bytes: number }>;

    // F04副作用账本：本Run其他attempt已终结的工具调用（含红脱敏参数摘要）。新attempt尚未产生调用，
    // 全量按时间排序即为"此前attempt"的账本；恢复attempt据此不重复执行已成功副作用。
    const ledgerRows = db.db.prepare(`SELECT tool_name, state, redacted_args_json, error_code, result_json FROM tool_invocations
        WHERE run_id=? AND state IN ('succeeded','failed','denied') ORDER BY created_at ASC LIMIT 100`)
        .all(input.runId) as unknown as Array<{ tool_name: string; state: string; redacted_args_json: string; error_code: string | null; result_json: string | null }>;
    const toolLedger = ledgerRows.map(r => {
        const reverted=wasFileChangeReverted(db,r.result_json);
        return {tool:r.tool_name,ok:r.state==='succeeded'&&!reverted,summary:`${String(r.redacted_args_json??'{}').slice(0,160)}${reverted?' [文件改动已被用户撤销；应重新读取现状]':r.state!=='succeeded'?` [${r.state}${r.error_code?`:${r.error_code}`:''}]`:''}`};
    });
    const revertedFiles = db.db.prepare(`SELECT DISTINCT cr.relative_path AS path,cr.reverted_at AS revertedAt FROM change_records cr JOIN runs r ON r.id=cr.run_id WHERE r.conversation_id=? AND cr.reverted_at IS NOT NULL ORDER BY cr.reverted_at DESC LIMIT 100`).all(input.conversationId) as unknown as Array<{path:string;revertedAt:string}>;

    return {
        objective: objectiveRow.objective,
        objectiveMessageId: objectiveMessage?.id ?? '',
        objectiveSeq: objectiveMessage?.seq ?? 0,
        objectiveImages,
        historyMessages,
        historyTruncated,
        isResume,
        restoredInputThroughSeq,
        inheritedCheckpoint,
        projectRules: readProjectRules(input.grant),
        inheritedArtifacts: artifactRows.map(a => ({ artifactId: a.id, name: a.display_name, hash: a.hash, sizeBytes: a.size_bytes })),
        toolLedger,
        revertedFiles,
    };
}

export interface RequestInputBinding { ids: string[]; sourceSeq: number | null }

/** 校验并解析请求输入绑定（见模块头注释的信任边界说明）。 */
export function resolveRequestInput(db: Db, conversationId: string, kind: import('./modelRequests.js').RequestKind, inputThroughSeq: unknown, objectiveSeq: number): RequestInputBinding {
    // 压缩/修复请求不得消费主请求用户输入（返修F05）
    if (kind !== 'main') return { ids: [], sourceSeq: null };
    const bound = Number(inputThroughSeq);
    if (!Number.isInteger(bound) || bound < 0) throw new Error('REQUEST_INPUT_SEQ_INVALID');
    if (objectiveSeq > 0 && bound < objectiveSeq) throw new Error('REQUEST_INPUT_SEQ_BEFORE_OBJECTIVE');
    const lastRow = db.db.prepare(`SELECT COALESCE(MAX(seq),0) AS lastSeq FROM messages WHERE conversation_id=? AND state='published'`).get(conversationId) as { lastSeq: number };
    if (bound > lastRow.lastSeq) throw new Error('REQUEST_INPUT_SEQ_AHEAD');
    const rows = db.db.prepare(`SELECT id FROM messages
        WHERE conversation_id=? AND author_type='user' AND state='published' AND consumed_cursor_json IS NULL AND seq<=?
        ORDER BY seq ASC LIMIT 200`).all(conversationId, bound) as unknown as Array<{ id: string }>;
    return { ids: rows.map(r => r.id), sourceSeq: bound };
}
