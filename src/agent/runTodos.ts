import { randomUUID } from 'node:crypto';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';

/**
 * 任务清单（块D）：run 级 todo。todo_write 语义为全量覆写（与上游一致）；
 * 仅任务进行态状态，无文件系统/外部副作用——审批按只读类，不参与 F04 重放。
 */

const MAX_TODOS = 50;
const MAX_CONTENT = 500;
const STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type TodoStatus = (typeof STATUSES)[number];

export interface TodoItem { content: string; status: TodoStatus }

export interface TodoRow { id: string; position: number; content: string; status: TodoStatus }

export function getRunTodos(db: Db, runId: string): TodoRow[] {
    return db.db.prepare('SELECT id, position, content, status FROM run_todos WHERE run_id=? ORDER BY position').all(runId) as unknown as TodoRow[];
}

export function replaceRunTodos(db: Db, runId: string, todos: TodoItem[]): TodoRow[] {
    if (!Array.isArray(todos)) throw new ApiError('VALIDATION_FAILED', 'todos 须为数组');
    if (todos.length > MAX_TODOS) throw new ApiError('VALIDATION_FAILED', `任务清单最多 ${MAX_TODOS} 项`);
    const now = new Date().toISOString();
    return db.tx(tx => {
        tx.prepare('DELETE FROM run_todos WHERE run_id=?').run(runId);
        const insert = tx.prepare('INSERT INTO run_todos(id,run_id,position,content,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
        const rows: TodoRow[] = [];
        todos.forEach((todo, index) => {
            const content = typeof todo?.content === 'string' ? todo.content.trim() : '';
            const status = String(todo?.status ?? 'pending');
            if (!content) throw new ApiError('VALIDATION_FAILED', `第 ${index + 1} 项缺少内容`);
            if (content.length > MAX_CONTENT) throw new ApiError('VALIDATION_FAILED', `第 ${index + 1} 项内容超长（≤${MAX_CONTENT}字符）`);
            if (!STATUSES.includes(status as TodoStatus)) throw new ApiError('VALIDATION_FAILED', `第 ${index + 1} 项状态不合法：${status.slice(0, 20)}`);
            const row: TodoRow = { id: randomUUID(), position: index, content, status: status as TodoStatus };
            insert.run(row.id, runId, row.position, row.content, row.status, now, now);
            rows.push(row);
        });
        return rows;
    });
}
