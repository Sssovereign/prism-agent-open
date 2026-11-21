import { randomUUID } from 'node:crypto';
import { ApiError } from '../../contracts/errors.js';
import { ASK_USER_QUESTION, type UserQuestion, type UserQuestionRequest, type UserQuestionResponse } from '../../contracts/userQuestions.js';
import type { Db } from '../storage/db.js';

export const QUESTION_AUTO_CONTINUE_MS = 300_000;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, max: number): string {
    if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw new ApiError('VALIDATION_FAILED', '问题或选项文本缺失或超长');
    return v.trim();
}
/** The model cannot prefill answers or impersonate an interaction response. */
export function parseUserQuestions(raw: unknown): UserQuestion[] {
    if (!record(raw) || Object.keys(raw).some(k => !['questions','question','header','options','multiSelect'].includes(k))) throw new ApiError('VALIDATION_FAILED', '提问参数只能包含问题，不能预填用户答案');
    const list = Array.isArray(raw.questions) ? raw.questions : typeof raw.question === 'string' ? [raw] : [];
    if (!list.length || list.length > 4) throw new ApiError('VALIDATION_FAILED', '每次须提供1—4个问题');
    const questions = list.map((q): UserQuestion => {
        if (!record(q) || Object.keys(q).some(k => !['question','header','options','multiSelect'].includes(k)) || (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean')) throw new ApiError('VALIDATION_FAILED', '问题格式不正确');
        if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) throw new ApiError('VALIDATION_FAILED', '每个问题须有2—4个选项');
        const options = q.options.map(o => {
            if (!record(o) || Object.keys(o).some(k => !['label','description','preview'].includes(k))) throw new ApiError('VALIDATION_FAILED', '选项格式不正确');
            const label = text(o.label, 120), description = text(o.description, 1000);
            if (/^(other|其他|其它|自定义)$/i.test(label)) throw new ApiError('VALIDATION_FAILED', '自定义回答由界面提供，请勿添加“其他”选项');
            return { label, description, ...(o.preview === undefined ? {} : { preview: text(o.preview, 8000) }) };
        });
        if (new Set(options.map(o => o.label)).size !== options.length) throw new ApiError('VALIDATION_FAILED', '同一问题的选项不能重复');
        return { question: text(q.question, 2000), header: text(q.header, 12), options, multiSelect: q.multiSelect === true };
    });
    if (new Set(questions.map(q => q.question)).size !== questions.length) throw new ApiError('VALIDATION_FAILED', '问题不能重复');
    if (JSON.stringify(questions).length > 40_000) throw new ApiError('INPUT_TOO_LARGE', '问题内容过长');
    return questions;
}
export function parseQuestionAnswers(questions: UserQuestion[], raw: unknown): Record<string, string[]> {
    if (!record(raw)) throw new ApiError('VALIDATION_FAILED', '回答须为按问题文本索引的对象');
    const result: Record<string, string[]> = Object.create(null);
    for (const [key, values] of Object.entries(raw)) {
        const question = questions.find(q => q.question === key);
        if (!question || !Array.isArray(values) || values.some(v => typeof v !== 'string') || values.length > 5) throw new ApiError('VALIDATION_FAILED', '回答包含未知问题或格式不正确');
        const answers = values.map(v => text(v, 4000));
        if (new Set(answers).size !== answers.length || (!question.multiSelect && answers.length > 1)) throw new ApiError('VALIDATION_FAILED', '单选问题只能有一个答案，答案不能重复');
        if (answers.filter(a => !question.options.some(o => o.label === a)).length > 1) throw new ApiError('VALIDATION_FAILED', '每题只能有一段自定义回答');
        if (answers.length) result[key] = answers;
    }
    if (JSON.stringify(result).length > 20_000) throw new ApiError('INPUT_TOO_LARGE', '回答内容过长');
    return result;
}
export function readUserQuestions(db: Db, runId: string): UserQuestionRequest[] {
    const rows = db.db.prepare('SELECT * FROM user_questions WHERE run_id=? ORDER BY created_at,id').all(runId) as unknown as Array<Record<string, string | null>>;
    return rows.map(r => ({ id: r.id!, runId: r.run_id!, invocationId: r.invocation_id!, questions: JSON.parse(r.questions_json!), state: r.state as UserQuestionRequest['state'], answers: JSON.parse(r.answers_json!), createdAt: r.created_at!, resolvedAt: r.resolved_at!, deadlineAt: r.deadline_at!, snoozedAt: r.snoozed_at! }));
}
interface Waiting { runId: string; timer?: ReturnType<typeof setTimeout>; resolve: (result: unknown) => void; reject: (error: Error) => void }
/** Trusted process owns the deadline and the first response wins; page timers never resolve a question. */
export class UserQuestionService {
    private waiting = new Map<string, Waiting>();
    constructor(private db: Db, private emit: (runId: string, type: string, payload: Record<string, unknown>) => void, private now = () => Date.now()) {}
    private owned(runId: string, id: string, userId: string): UserQuestionRequest {
        const owned = this.db.db.prepare('SELECT r.id FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=? AND p.owner_user_id=?').get(runId, userId);
        const q = owned && readUserQuestions(this.db, runId).find(q => q.id === id);
        if (!q) throw new ApiError('NOT_FOUND', '问题不存在或无权访问');
        return q;
    }
    ask(runId: string, invocationId: string, raw: unknown, userId: string): Promise<unknown> {
        // 每轮同时只允许一个待答问题；重复提问在此给出结构化错误，而不是022唯一索引的SqliteError原样上抛。
        if (this.db.db.prepare("SELECT id FROM user_questions WHERE run_id=? AND state='pending' LIMIT 1").get(runId)) throw new ApiError('REQUEST_IN_PROGRESS', '已有问题等待用户回答，请等待其结束后再提问');
        const questions = parseUserQuestions(raw), id = randomUUID(), now = this.now(), createdAt = new Date(now).toISOString();
        const settings = this.db.db.prepare('SELECT settings_json FROM agent_runtime_settings WHERE user_id=?').get(userId) as { settings_json: string } | undefined;
        const auto = !settings || JSON.parse(settings.settings_json).askUserQuestionAutoResolutionEnabled !== false;
        const deadlineAt = auto ? new Date(now + QUESTION_AUTO_CONTINUE_MS).toISOString() : null;
        this.db.db.prepare("INSERT INTO user_questions(id,run_id,invocation_id,questions_json,state,created_at,deadline_at) VALUES (?,?,?,?,'pending',?,?)").run(id, runId, invocationId, JSON.stringify(questions), createdAt, deadlineAt);
        const result = new Promise((resolve, reject) => {
            const wait: Waiting = { runId, resolve, reject };
            this.waiting.set(id, wait);
            if (auto) { wait.timer = setTimeout(() => this.expireDue(), QUESTION_AUTO_CONTINUE_MS); wait.timer.unref?.(); }
        });
        this.emit(runId, 'question.requested', { questionId: id, invocationId, deadlineAt });
        return result;
    }
    respond(runId: string, id: string, userId: string, raw: UserQuestionResponse): { accepted: boolean } {
        const q = this.owned(runId, id, userId);
        if (!record(raw) || Object.keys(raw).some(k => !['action','answers'].includes(k)) || !['answer','skip'].includes(raw.action)) throw new ApiError('VALIDATION_FAILED', '回答操作须为answer或skip');
        const answers = raw.action === 'answer' ? parseQuestionAnswers(q.questions, raw.answers) : {};
        // Even a disconnected browser cannot submit a stale answer after the authoritative deadline.
        this.expireDue();
        if (q.state !== 'pending' || !this.waiting.has(id)) throw new ApiError('WAIT_STATE_CHANGED', '该问题已结束，请查看最新内容');
        return { accepted: this.finish(q, raw.action === 'skip' ? 'skipped' : 'answered', answers) };
    }
    snooze(runId: string, id: string, userId: string): { paused: boolean } {
        const q = this.owned(runId, id, userId);
        this.expireDue();
        if (q.state !== 'pending' || !this.waiting.has(id)) return { paused: false };
        const changed = this.db.db.prepare("UPDATE user_questions SET deadline_at=NULL,snoozed_at=? WHERE id=? AND state='pending' AND deadline_at IS NOT NULL").run(new Date(this.now()).toISOString(), id).changes;
        clearTimeout(this.waiting.get(id)?.timer);
        if (changed) this.emit(runId, 'question.updated', { questionId: id });
        return { paused: true };
    }
    disableAutoResolution(userId: string): void {
        const rows = this.db.db.prepare("SELECT q.id,q.run_id FROM user_questions q JOIN runs r ON r.id=q.run_id JOIN projects p ON p.id=r.project_id WHERE p.owner_user_id=? AND q.state='pending'").all(userId) as unknown as Array<{ id: string; run_id: string }>;
        for (const row of rows) this.snooze(row.run_id, row.id, userId);
    }
    hasPending(runId: string): boolean { return [...this.waiting.values()].some(w => w.runId === runId); }
    expireDue(): void {
        const due = this.db.db.prepare("SELECT id,run_id FROM user_questions WHERE state='pending' AND deadline_at IS NOT NULL AND deadline_at<=?").all(new Date(this.now()).toISOString()) as unknown as Array<{ id: string; run_id: string }>;
        for (const row of due) { const q = readUserQuestions(this.db, row.run_id).find(q => q.id === row.id)!; if (this.waiting.has(q.id)) this.finish(q, 'auto_continued', {}); }
    }
    private finish(q: UserQuestionRequest, state: 'answered' | 'skipped' | 'auto_continued', answers: Record<string, string[]>): boolean {
        const wait = this.waiting.get(q.id);
        if (!wait) return false;
        const now = new Date(this.now()).toISOString();
        const claimed = this.db.db.prepare("UPDATE user_questions SET state=?,answers_json=?,resolved_at=? WHERE id=? AND state='pending'").run(state, JSON.stringify(answers), now, q.id).changes;
        if (!claimed) return false;
        clearTimeout(wait.timer); this.waiting.delete(q.id);
        const modelAnswers = Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, value.join(', ')]));
        wait.resolve({ questions: q.questions, answers: modelAnswers, outcome: state, instruction: '只使用已提供的答案；未回答的问题请自行合理判断，不能虚构用户偏好。跳过或未回答不表示拒绝，也不表示授权其他操作。' });
        this.emit(q.runId, 'question.resolved', { questionId: q.id, invocationId: q.invocationId, state });
        return true;
    }
    cancelRun(runId: string, reason: string): void {
        this.db.db.prepare("UPDATE user_questions SET state='cancelled',resolved_at=? WHERE run_id=? AND state='pending'").run(new Date(this.now()).toISOString(), runId);
        for (const [id, wait] of this.waiting) if (wait.runId === runId) {
            clearTimeout(wait.timer); this.waiting.delete(id); wait.reject(new ApiError('RUN_NOT_ACTIVE', `问题已结束：${reason}`));
            this.emit(runId, 'question.resolved', { questionId: id, state: 'cancelled' });
        }
    }
    recover(): void {
        this.db.db.prepare("UPDATE user_questions SET state='cancelled',resolved_at=? WHERE state='pending'").run(new Date(this.now()).toISOString());
    }
}

export const USER_QUESTION_TOOL = {
    name: ASK_USER_QUESTION,
    description: '仅在缺失信息实质影响下一步、且无法从用户要求、文件或合理默认值确定时向用户提问。1—4题，每题2—4个选项，可单选或多选。推荐选项放第一项并标注（推荐）；界面自动提供自定义回答，不要添加“其他”。用户可跳过；不得替用户回答或用本工具代替操作审批。可用preview提供单选方案的文本预览。',
    parameters: { type: 'object', required: ['questions'], additionalProperties: false, properties: { questions: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', required: ['question','header','options','multiSelect'], additionalProperties: false, properties: {
        question: { type: 'string', minLength: 1, maxLength: 2000 }, header: { type: 'string', minLength: 1, maxLength: 12 }, multiSelect: { type: 'boolean', default: false },
        options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', required: ['label','description'], additionalProperties: false, properties: { label: { type: 'string', maxLength: 120 }, description: { type: 'string', maxLength: 1000 }, preview: { type: 'string', maxLength: 8000 } } } },
    } } } } },
    effect: 'read' as const, highImpact: () => false,
};
