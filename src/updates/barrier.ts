// 更新应用屏障：切换业务包期间关闭「会创建执行工作」的入口，并给出可解释的忙碌快照。
// 空闲判定同时考虑：内存活跃attempt、持久化未终结run、在途模型请求、排队输入、记忆提炼。
// 等待用户（waiting_approval/waiting_input）属于未终结run——默认不能被自动更新抹掉。
import { ApiError } from '../../contracts/errors.js';
import { defaultDbPath, type Db } from '../storage/db.js';
import type { Supervisor } from '../agent/supervisor.js';
import type { ModelRequestRegistry } from '../agent/modelRequests.js';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const TERMINAL_RUN_STATUSES = "('succeeded','failed','cancelled')";

export interface BusySnapshot {
    idle: boolean;
    activeRuns: { runId: string; status: string }[];
    persistedRuns: { id: string; status: string }[];
    modelRequests: number;
    queuedItems: number;
    memoryExtractions: number;
    pendingWrites: number;
}

export interface SnapshotEvidence {
    files: { file: string; sha256: string; size: number }[];
}

export class UpdateBarrier {
    private pendingWrites = 0;
    private closed = false;
    private applyId: string | null = null;

    constructor(private readonly deps: { db: Db; dataDir: string; supervisor: Supervisor; registry: ModelRequestRegistry }) {}

    /** 关闭入口（进入「准备应用更新」阶段）；重复关闭以最后一次 applyId 为准。 */
    close(applyId: string): void {
        this.applyId = applyId;
        this.closed = true;
    }

    /** 解除入口屏障（更新取消或失败），避免应用永久拒绝新任务。 */
    reopen(): void {
        this.closed = false;
        this.applyId = null;
    }

    isClosed(): boolean { return this.closed; }
    currentApplyId(): string | null { return this.applyId; }

    trackWrite(): () => void {
        this.pendingWrites += 1;
        let released = false;
        return () => { if (!released) { released = true; this.pendingWrites -= 1; } };
    }

    busySnapshot(): BusySnapshot {
        const db = this.deps.db.db;
        const activeRuns = [...this.deps.supervisor.active.values()].map(run => ({ runId: run.runId, status: run.status }));
        const persistedRuns = db.prepare(`SELECT id, status FROM runs WHERE status NOT IN ${TERMINAL_RUN_STATUSES}`).all() as { id: string; status: string }[];
        const modelRequests = (db.prepare("SELECT COUNT(*) AS n FROM model_requests WHERE state IN ('reserved','started')").get() as { n: number }).n;
        const queuedItems = (db.prepare("SELECT COUNT(*) AS n FROM conversation_queue WHERE state='queued'").get() as { n: number }).n;
        const memoryExtractions = (db.prepare("SELECT COUNT(*) AS n FROM memory_extractions WHERE state='running'").get() as { n: number }).n;
        return {
            idle: activeRuns.length === 0 && persistedRuns.length === 0 && modelRequests === 0 && queuedItems === 0 && memoryExtractions === 0 && this.pendingWrites === 0,
            activeRuns, persistedRuns, modelRequests, queuedItems, memoryExtractions, pendingWrites: this.pendingWrites,
        };
    }

    /** 任务创建入口统一门禁：屏障关闭期间拒绝新建执行工作（响应既有任务不受影响——屏障只在空闲时关闭）。 */
    assertEntryOpen(): void {
        if (this.closed) throw new ApiError('UPDATE_PENDING', '正在准备应用更新，已暂停新建任务；更新完成后即可继续');
    }

    /**
     * 空闲屏障内的一致性快照：SQLite VACUUM INTO（独立一致文件）+ 凭据主密钥副本，
     * 供切换失败时成套恢复核对。数据根不变，正式库文件本身不被移动或改写。
     */
    createSnapshot(destDir: string): SnapshotEvidence {
        if (!this.closed || !this.applyId) throw new ApiError('UPDATE_BARRIER_OPEN', '快照必须在更新屏障关闭（空闲确认）后执行');
        if (!this.busySnapshot().idle) throw new ApiError('UPDATE_PENDING', '仍有执行工作，不能生成更新快照');
        const dbFile = defaultDbPath(this.deps.dataDir);
        if (!existsSync(dbFile)) throw new ApiError('UPDATE_SNAPSHOT_FAILED', '主数据库不存在');
        mkdirSync(destDir, { recursive: true, mode: 0o700 });
        const target = join(destDir, 'workbench.sqlite');
        const escaped = target.replaceAll("'", "''");
        this.deps.db.db.exec(`VACUUM INTO '${escaped}'`);
        const files: SnapshotEvidence['files'] = [];
        const record = (file: string) => {
            const size = statSync(file).size;
            files.push({ file: file.slice(destDir.length + 1), sha256: createHash('sha256').update(this.readAll(file)).digest('hex'), size });
        };
        record(target);
        const masterKey = join(this.deps.dataDir, 'credential-master.key');
        if (existsSync(masterKey)) {
            const copy = join(destDir, 'credential-master.key');
            copyFileSync(masterKey, copy);
            record(copy);
        }
        writeFileSync(join(destDir, 'evidence.json'), JSON.stringify({ applyId: this.applyId, createdAt: new Date().toISOString(), files }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        return { files };
    }

    private readAll(file: string): Buffer {
        return readFileSync(file);
    }
}
