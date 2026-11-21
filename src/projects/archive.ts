import type { FastifyInstance } from 'fastify';
import type { Db } from '../storage/db.js';
import type { AuthExtractor } from './routes.js';
import { ApiError } from '../../contracts/errors.js';
import { ok } from '../http.js';

/** Settings archive deletion removes only the selected conversation's stored history.
 * Project files, shared resources, model configs and other conversations are retained. */
export function deleteArchivedConversation(db: Db, userId: string, id: string): void {
  db.tx(tx => {
    const row = tx.prepare(`SELECT c.archived_at FROM conversations c JOIN projects p ON p.id=c.project_id
      WHERE c.id=? AND p.owner_user_id=?`).get(id, userId) as { archived_at: string | null } | undefined;
    if (!row) throw new ApiError('NOT_FOUND', '对象不存在或无权访问');
    if (!row.archived_at) throw new ApiError('RUN_NOT_ACTIVE', '只能从归档管理中删除已归档的任务');
    const run = 'SELECT id FROM runs WHERE conversation_id=?';
    if (tx.prepare(`SELECT id FROM runs WHERE conversation_id=? AND status NOT IN ('succeeded','failed','cancelled') LIMIT 1`).get(id))
      throw new ApiError('CONVERSATION_BUSY', '任务尚未停止，不能删除记录');
    const attempts = `SELECT a.id FROM attempts a JOIN phase_tasks pt ON pt.id=a.phase_task_id WHERE pt.run_id IN (${run})`;
    if (tx.prepare(`SELECT id FROM worker_instances WHERE attempt_id IN (${attempts}) AND state IN ('starting','running','stopping') LIMIT 1`).get(id))
      throw new ApiError('CONVERSATION_BUSY', '任务正在清理执行进程，请稍后重试');
    if (tx.prepare("SELECT id FROM memory_extractions WHERE conversation_id=? AND state='running' LIMIT 1").get(id))
      throw new ApiError('CONVERSATION_BUSY', '任务正在整理记忆，请完成后再删除');
    const tools = `SELECT id FROM tool_invocations WHERE run_id IN (${run})`;
    const args = `SELECT id FROM arguments WHERE run_id IN (${run})`;
    const evidence = `SELECT id FROM evidence WHERE run_id IN (${run})`;
    // Deferral permits internal graph cycles, while COMMIT still rejects outside references.
    tx.exec('PRAGMA defer_foreign_keys=ON');
    tx.prepare(`DELETE FROM argument_responses WHERE argument_id IN (${args}) OR target_argument_id IN (${args})`).run(id, id);
    tx.prepare(`DELETE FROM argument_evidence WHERE argument_id IN (${args}) OR evidence_id IN (${evidence})`).run(id, id);
    tx.prepare(`DELETE FROM approvals WHERE invocation_id IN (${tools})`).run(id);
    tx.prepare(`DELETE FROM path_leases WHERE invocation_id IN (${tools})`).run(id);
    tx.prepare(`DELETE FROM user_questions WHERE run_id IN (${run})`).run(id);
    tx.prepare('DELETE FROM memory_extractions WHERE conversation_id=?').run(id);
    // 只移除已删除任务的来源回执；项目记忆文件及其他任务的交接保持。
    tx.prepare(`DELETE FROM memory_handoffs WHERE run_id IN (${run})`).run(id);
    for (const table of ['reports','change_records','tool_invocations','publications','artifacts','arguments','evidence','run_events','usage_entries','model_requests','compaction_operations'])
      tx.prepare(`DELETE FROM ${table} WHERE run_id IN (${run})`).run(id);
    for(const table of ['research_records','research_phases','research_views','research_participants','research_runs'])tx.prepare(`DELETE FROM ${table} WHERE run_id IN (${run})`).run(id);
    tx.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
    tx.prepare('DELETE FROM context_checkpoints WHERE conversation_id=?').run(id);
    tx.prepare(`DELETE FROM worker_instances WHERE attempt_id IN (${attempts})`).run(id);
    tx.prepare(`DELETE FROM attempts WHERE phase_task_id IN (SELECT id FROM phase_tasks WHERE run_id IN (${run}))`).run(id);
    tx.prepare(`DELETE FROM phase_tasks WHERE run_id IN (${run})`).run(id);
    tx.prepare(`DELETE FROM agent_bindings WHERE run_id IN (${run})`).run(id);
    tx.prepare('DELETE FROM runs WHERE conversation_id=?').run(id);
    tx.prepare('DELETE FROM problem_versions WHERE conversation_id=?').run(id);
    tx.prepare('DELETE FROM conversations WHERE id=?').run(id);
  });
}

export function registerArchiveRoutes(app: FastifyInstance, db: Db, auth: AuthExtractor): void {
  app.delete<{Params:{id:string};Body:{confirmed:boolean}}>('/api/v1/conversations/:id', { schema:{
    body:{type:'object',required:['confirmed'],additionalProperties:false,properties:{confirmed:{const:true}}},
  } }, async(req,reply)=>{
    try { deleteArchivedConversation(db,auth(req).userId,req.params.id); }
    catch(error) {
      if(error instanceof Error && error.message.includes('FOREIGN KEY'))
        throw new ApiError('CONVERSATION_BUSY','记录仍被其他任务引用，不能删除');
      throw error;
    }
    return ok(req,reply,{deleted:true});
  });
}
