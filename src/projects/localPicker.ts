import { createLocalDirectoryChooser, type DirectoryChooser } from '../files/directoryChooser.js';
import { canonicalDirectory } from '../files/paths.js';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
import type { GrantRow } from '../files/picker.js';
import type { ProjectRow } from './routes.js';

interface Selection {
    id: string; user_id: string; nonce_hash: string; state: string; selected_path: string | null;
    expires_at: string; project_id: string | null; grant_id: string | null;
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** 编辑项目的文件夹条目：grantId=保留现有授权；pickerTicket+nonce=新选票据。access 缺省沿用原值或 write。 */
export interface ReplaceFolderInput { grantId?: string; pickerTicket?: string; nonce?: string; access?: 'read' | 'write' }

/** 路径只来自本机选择器，客户端只持有一次性票据；项目与grant在同一事务内落库。 */
export class LocalProjectPicker {
    private children = new Map<string, AbortController>();
    private closed = false;
    constructor(private readonly db: Db, private readonly chooser: DirectoryChooser = createLocalDirectoryChooser()) {}

    close(): void {
        this.closed = true;
        for (const [id, child] of this.children) {
            try {
                this.db.db.prepare("UPDATE project_directory_pickers SET state='cancelled',selected_path=NULL,updated_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(), id);
            } catch { /* onClose顺序可能先关闭DB；重启后start仍会收拢遗留pending。 */ }
            child.abort();
        }
        this.children.clear();
    }

    get(id: string, userId: string): Selection | undefined {
        const row = this.db.db.prepare('SELECT * FROM project_directory_pickers WHERE id=? AND user_id=?').get(id, userId) as unknown as Selection | undefined;
        if (row && ['pending', 'selected'].includes(row.state) && Date.parse(row.expires_at) <= Date.now()) {
            this.db.db.prepare("UPDATE project_directory_pickers SET state='expired',selected_path=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), id);
            this.children.get(id)?.abort();
            return { ...row, state: 'expired', selected_path: null };
        }
        return row;
    }

    start(userId: string): { id: string; nonce: string; expiresAt: string } {
        if (this.closed) throw new ApiError('POLICY_DENIED', '目录选择已关闭');
        this.chooser.assertAvailable();
        // 重启后原进程的未完成选择不能阻塞新窗口，也不能产生授权。
        const abandoned = this.db.db.prepare("SELECT id FROM project_directory_pickers WHERE user_id=? AND state='pending'").all(userId) as Array<{id:string}>;
        for (const row of abandoned) if (!this.children.has(row.id)) this.db.db.prepare("UPDATE project_directory_pickers SET state='cancelled',selected_path=NULL,updated_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(), row.id);
        const pending = this.db.db.prepare("SELECT id FROM project_directory_pickers WHERE user_id=? AND state='pending' AND expires_at>? LIMIT 1").get(userId, new Date().toISOString());
        if (pending) throw new ApiError('RESOURCE_BUSY', '请先完成或取消当前文件夹选择');
        const id = randomUUID(), nonce = randomBytes(24).toString('hex'), now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 600_000).toISOString();
        this.db.db.prepare("INSERT INTO project_directory_pickers(id,user_id,nonce_hash,state,expires_at,created_at,updated_at) VALUES (?,?,?,'pending',?,?,?)").run(id, userId, hash(nonce), expiresAt, now, now);
        const controller = new AbortController();
        this.children.set(id, controller);
        const finish = (state: string, path: string | null = null): void => {
            this.children.delete(id);
            if (this.closed) return;
            const now = new Date().toISOString();
            this.db.db.prepare("UPDATE project_directory_pickers SET state=?,selected_path=?,updated_at=? WHERE id=? AND state='pending' AND expires_at>?").run(state, path, now, id, now);
            this.db.db.prepare("UPDATE project_directory_pickers SET state='expired',selected_path=NULL,updated_at=? WHERE id=? AND state='pending' AND expires_at<=?").run(now, id, now);
        };
        void this.chooser.choose(id, Date.parse(expiresAt), 'project', controller.signal)
            .then(result => finish(result.state, result.state === 'selected' ? result.path : null), () => finish('failed'));
        return { id, nonce, expiresAt };
    }

    cancel(id: string, userId: string, nonce: string): boolean {
        const row = this.get(id, userId);
        if (!row || row.nonce_hash !== hash(nonce)) return false;
        this.db.db.prepare("UPDATE project_directory_pickers SET state='cancelled',selected_path=NULL,updated_at=? WHERE id=? AND state IN ('pending','selected')").run(new Date().toISOString(), id);
        this.children.get(id)?.abort();
        return true;
    }

    create(userId: string, name: string, folders: Array<{ pickerTicket: string; nonce: string; access: 'read' | 'write' }>): { project: ProjectRow; grant: GrantRow; grants: GrantRow[] } {
        if (!folders.length || folders.length > 10) throw new ApiError('VALIDATION_FAILED', '请提供 1-10 个本地文件夹');
        const rows = folders.map(folder => {
            const row = this.get(folder.pickerTicket, userId);
            if (!row || row.nonce_hash !== hash(folder.nonce)) throw new ApiError('VALIDATION_FAILED', '文件夹选择已失效，请重新选择');
            return { folder, row };
        });
        // 网络重试同一创建请求返回原结果，不重复创建项目或授权。
        const firstClaimed = rows[0]?.row;
        if (firstClaimed?.state === 'claimed' && firstClaimed.project_id && firstClaimed.grant_id) {
            const project = this.db.db.prepare('SELECT * FROM projects WHERE id=? AND owner_user_id=?').get(firstClaimed.project_id, userId) as unknown as ProjectRow | undefined;
            if (project && project.name === name) {
                const grants = this.db.db.prepare('SELECT * FROM workspace_grants WHERE project_id=? AND revoked_at IS NULL ORDER BY created_at ASC, id ASC').all(project.id) as unknown as GrantRow[];
                const grant = grants.find(item => item.is_primary === 1) ?? grants[0];
                if (grant) return { project, grant, grants };
            }
        }
        // 逐票据校验 selected 并规范化路径；同请求内重复路径按一个文件夹处理
        const roots: Array<{ root: string; folder: { access: 'read' | 'write' }; row: Selection }> = [];
        for (const { folder, row } of rows) {
            if (row.state !== 'selected' || !row.selected_path) throw new ApiError('VALIDATION_FAILED', '请先选择有效的本地文件夹');
            let root: string;
            try { root = canonicalDirectory(row.selected_path); } catch { throw new ApiError('VALIDATION_FAILED', '所选文件夹已不可用，请重新选择'); }
            if (!roots.some(item => item.root === root)) roots.push({ root, folder: { access: folder.access }, row });
        }
        const existing = this.db.db.prepare(`SELECT DISTINCT p.id FROM projects p JOIN workspace_grants g ON g.project_id=p.id
            WHERE p.owner_user_id=? AND p.archived_at IS NULL AND g.revoked_at IS NULL AND g.canonical_root IN (${roots.map(() => '?').join(',')}) LIMIT 1`).get(userId, ...roots.map(item => item.root));
        if (existing) throw new ApiError('IDEMPOTENCY_CONFLICT', '所选文件夹已绑定项目，请从侧栏打开已有项目');
        const projectId = randomUUID(), now = new Date().toISOString();
        const grantItems = roots.map(item => ({ ...item, grantId: randomUUID() }));
        this.db.tx(tx => {
            tx.prepare('INSERT INTO projects(id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(projectId, userId, name, now, now);
            grantItems.forEach((item, index) => {
                const claimed = tx.prepare("UPDATE project_directory_pickers SET state='claimed',updated_at=? WHERE id=? AND user_id=? AND state='selected' AND expires_at>?").run(now, item.row.id, userId, now);
                if (claimed.changes !== 1) throw new ApiError('VALIDATION_FAILED', '文件夹选择已失效，请重新选择');
                tx.prepare("INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,excludes_json,created_at,updated_at,is_primary) VALUES (?,?,?,?,1,?,'[]',?,?,?)").run(item.grantId, projectId, item.root, item.folder.access, userId, now, now, index === 0 ? 1 : 0);
                tx.prepare('UPDATE project_directory_pickers SET project_id=?,grant_id=?,selected_path=NULL WHERE id=?').run(projectId, item.grantId, item.row.id);
            });
        });
        const grants = grantItems.map(item => this.db.db.prepare('SELECT * FROM workspace_grants WHERE id=?').get(item.grantId) as unknown as GrantRow);
        return {
            project: this.db.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as unknown as ProjectRow,
            grant: grants[0] as GrantRow, // 主要目录：创建时的首个文件夹
            grants,
        };
    }

    /**
     * 编辑项目：整表替换文件夹绑定（对齐 ZCode ProjectEditor 的 saveProject roots 提交语义）。
     * 旧授权只软撤销不删行——fileRewind/change_records 按 grant_id JOIN，删行会断历史任务回溯；
     * 运行中任务持有启动时的 grant 快照，换绑只影响后续任务。
     */
    replaceRoots(userId: string, projectId: string, folders: ReplaceFolderInput[]): GrantRow[] {
        if (!folders.length || folders.length > 10) throw new ApiError('VALIDATION_FAILED', '请提供 1-10 个本地文件夹');
        const project = this.db.db.prepare('SELECT * FROM projects WHERE id=? AND owner_user_id=?').get(projectId, userId) as unknown as ProjectRow | undefined;
        if (!project) throw new ApiError('NOT_FOUND', '对象不存在或无权访问');
        const now = new Date().toISOString();
        const currentGrants = this.db.db.prepare('SELECT * FROM workspace_grants WHERE project_id=? AND revoked_at IS NULL ORDER BY is_primary DESC, created_at ASC, id ASC').all(projectId) as unknown as GrantRow[];
        // 先解析全部条目再落库：任何一项无效都抛错，事务外的 revoke/claim 不会发生。
        const targets: Array<{ grantId?: string; root?: string; access: 'read' | 'write'; ticket?: Selection }> = [];
        for (const folder of folders) {
            if (folder.grantId) {
                const grant = currentGrants.find(item => item.id === folder.grantId);
                if (!grant) throw new ApiError('VALIDATION_FAILED', '所选文件夹授权已不存在，请刷新后重试');
                if (!targets.some(item => item.grantId === folder.grantId)) targets.push({ grantId: folder.grantId, access: folder.access ?? (grant.access as 'read' | 'write') });
                continue;
            }
            if (!folder.pickerTicket || !folder.nonce) throw new ApiError('VALIDATION_FAILED', '文件夹参数不完整，请重新选择');
            const row = this.get(folder.pickerTicket, userId);
            if (!row || row.nonce_hash !== hash(folder.nonce)) throw new ApiError('VALIDATION_FAILED', '文件夹选择已失效，请重新选择');
            if (row.state !== 'selected' || !row.selected_path) throw new ApiError('VALIDATION_FAILED', '请先选择有效的本地文件夹');
            let root: string;
            try { root = canonicalDirectory(row.selected_path); } catch { throw new ApiError('VALIDATION_FAILED', '所选文件夹已不可用，请重新选择'); }
            // 重选已有路径折叠为保留该授权，避免同路径双行；同请求重复路径按一个文件夹处理。
            const existing = currentGrants.find(item => item.canonical_root === root);
            if (existing) {
                if (!targets.some(item => item.grantId === existing.id)) targets.push({ grantId: existing.id, access: folder.access ?? (existing.access as 'read' | 'write') });
                continue;
            }
            if (!targets.some(item => item.root === root)) targets.push({ root, access: folder.access ?? 'write', ticket: row });
        }
        if (!targets.length) throw new ApiError('VALIDATION_FAILED', '请至少保留一个本地文件夹');
        // 与创建同规则：目标路径不得已被本人其他未归档项目绑定（编辑时排除本项目自身）。
        const roots = [...new Set(targets.map(item => item.grantId ? currentGrants.find(g => g.id === item.grantId)!.canonical_root : item.root!))];
        const conflict = this.db.db.prepare(`SELECT DISTINCT p.id FROM projects p JOIN workspace_grants g ON g.project_id=p.id
            WHERE p.owner_user_id=? AND p.id<>? AND p.archived_at IS NULL AND g.revoked_at IS NULL AND g.canonical_root IN (${roots.map(() => '?').join(',')}) LIMIT 1`).get(userId, projectId, ...roots);
        if (conflict) throw new ApiError('IDEMPOTENCY_CONFLICT', '所选文件夹已绑定项目，请从侧栏打开已有项目');
        const keepIds = targets.filter(item => item.grantId).map(item => item.grantId!);
        const grantIds = targets.map(() => randomUUID());
        this.db.tx(tx => {
            if (keepIds.length) {
                tx.prepare(`UPDATE workspace_grants SET revoked_at=?, updated_at=? WHERE project_id=? AND revoked_at IS NULL AND id NOT IN (${keepIds.map(() => '?').join(',')})`).run(now, now, projectId, ...keepIds);
            } else {
                tx.prepare('UPDATE workspace_grants SET revoked_at=?, updated_at=? WHERE project_id=? AND revoked_at IS NULL').run(now, now, projectId);
            }
            targets.forEach((item, index) => {
                if (item.grantId || !item.ticket) return;
                const claimed = tx.prepare("UPDATE project_directory_pickers SET state='claimed',updated_at=? WHERE id=? AND user_id=? AND state='selected' AND expires_at>?").run(now, item.ticket.id, userId, now);
                if (claimed.changes !== 1) throw new ApiError('VALIDATION_FAILED', '文件夹选择已失效，请重新选择');
                tx.prepare("INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,excludes_json,created_at,updated_at,is_primary) VALUES (?,?,?,?,1,?,'[]',?,?,?)").run(grantIds[index]!, projectId, item.root!, item.access, userId, now, now, index === 0 ? 1 : 0);
                tx.prepare('UPDATE project_directory_pickers SET project_id=?,grant_id=?,selected_path=NULL WHERE id=?').run(projectId, grantIds[index]!, item.ticket.id);
            });
            // 首项为主要目录；保留授权可能从次要变主要，统一按最终顺序重设，撤销行一并归零。
            const primaryId = targets[0]!.grantId ?? grantIds[0]!;
            tx.prepare('UPDATE workspace_grants SET is_primary=CASE WHEN id=? THEN 1 ELSE 0 END WHERE project_id=?').run(primaryId, projectId);
            tx.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now, projectId);
        });
        return this.db.db.prepare('SELECT * FROM workspace_grants WHERE project_id=? AND revoked_at IS NULL ORDER BY is_primary DESC, created_at ASC, id ASC').all(projectId) as unknown as GrantRow[];
    }
}

export function selectionView(row: Selection): { id: string; state: string; directoryName: string | null; expiresAt: string } {
    return { id: row.id, state: row.state, directoryName: row.state === 'selected' && row.selected_path ? basename(row.selected_path) || '本地文件夹' : null, expiresAt: row.expires_at };
}
