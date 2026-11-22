// 块E2：会话图片附件——上传登记、归属校验、按消息装载为模型可见图片。
// 正文（原始字节）只落 attachments/<id> 文件；库与消息 content_json 仅存元数据。
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../../contracts/errors.js';
import type { Db } from '../storage/db.js';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const ATTACHMENT_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type AttachmentMime = typeof ATTACHMENT_MIMES[number];

export interface AttachmentRow {
    id: string;
    owner_user_id: string;
    mime: AttachmentMime;
    size_bytes: number;
    sha256: string;
    display_name: string;
    internal_path: string;
    created_at: string;
    updated_at: string;
}

/** 魔数嗅探：以内容为准判定 mime，声明类型仅作参考（伪造 .png 文本文件会被拒）。 */
export function sniffImageMime(bytes: Buffer): AttachmentMime | null {
    if (bytes.length < 12) return null;
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    const head = bytes.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
    if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
}

export function attachmentDir(dataDir: string): string {
    const dir = join(dataDir, 'attachments');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

export function saveAttachment(db: Db, dataDir: string, userId: string, displayName: string, bytes: Buffer): AttachmentRow {
    const mime = sniffImageMime(bytes);
    if (!mime) throw new ApiError('VALIDATION_FAILED', '仅支持 PNG/JPEG/GIF/WEBP 图片');
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new ApiError('INPUT_TOO_LARGE', '图片超过10MiB上限');
    const name = displayName.replace(/[\r\n\t\\/:*?"<>|]/g, '_').slice(0, 200) || 'image';
    const id = randomUUID();
    const now = new Date().toISOString();
    const internalPath = join(attachmentDir(dataDir), id);
    writeFileSync(internalPath, bytes, { mode: 0o600 });
    const sha256 = createHashOf(bytes);
    db.db.prepare(`INSERT INTO attachments(id,owner_user_id,mime,size_bytes,sha256,display_name,internal_path,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, userId, mime, bytes.byteLength, sha256, name, internalPath, now, now);
    return rowOf(db, id, userId);
}

export function rowOf(db: Db, id: string, userId: string): AttachmentRow {
    const row = db.db.prepare('SELECT * FROM attachments WHERE id=? AND owner_user_id=?').get(id, userId) as unknown as AttachmentRow | undefined;
    if (!row) throw new ApiError('NOT_FOUND', '附件不存在或无权访问');
    return row;
}

export interface SteerImage { mimeType: string; data: string }

/** 按归属装载附件：任一 id 缺失/非本人即整体拒绝（不静默丢弃）。返回元数据行与模型可见图片。 */
export function loadAttachmentImages(db: Db, userId: string, ids: string[]): { rows: AttachmentRow[]; images: SteerImage[] } {
    const rows: AttachmentRow[] = [];
    const images: SteerImage[] = [];
    for (const id of ids) {
        const row = rowOf(db, id, userId);
        let bytes: Buffer;
        try {
            bytes = readFileSync(row.internal_path);
        } catch {
            throw new ApiError('NOT_FOUND', '附件文件已丢失，请移除后重试');
        }
        rows.push(row);
        images.push({ mimeType: row.mime, data: bytes.toString('base64') });
    }
    return { rows, images };
}

/** 研究显式附件按发起时冻结的元数据装载（每个phase启动时执行）：
 *  重新校验文件存在、归属、字节hash与冻结sha256一致、魔数mime与冻结mime一致、大小一致——
 *  任一不符即明确失败（不使用被修改或丢失的图片，不静默降级为文本），由launch层落为可重试失败。
 *  返回的base64只进入attempt私有bootstrap与进程内存，不落任何库表。 */
export function loadFrozenAttachmentImages(db: Db, userId: string, frozen: Array<{ id: string; mime: string; sizeBytes: number; sha256: string; displayName: string }>): SteerImage[] {
    const images: SteerImage[] = [];
    for (const meta of frozen) {
        const row = rowOf(db, meta.id, userId);
        let bytes: Buffer;
        try {
            bytes = readFileSync(row.internal_path);
        } catch {
            throw new ApiError('NOT_FOUND', `附件文件已丢失：${row.display_name}；请重新发起并移除该图片`);
        }
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (digest !== meta.sha256) {
            throw new ApiError('VALIDATION_FAILED', `附件内容与发起研究时不一致（可能已被修改或替换）：${row.display_name}；请移除该图片后重新上传并发起`);
        }
        const mime = sniffImageMime(bytes);
        if (!mime || mime !== meta.mime) {
            throw new ApiError('VALIDATION_FAILED', `附件类型与发起研究时不一致：${row.display_name}`);
        }
        if (bytes.byteLength !== meta.sizeBytes) {
            throw new ApiError('VALIDATION_FAILED', `附件大小与发起研究时不一致：${row.display_name}`);
        }
        images.push({ mimeType: row.mime, data: bytes.toString('base64') });
    }
    return images;
}

/** 规范化请求中的附件 id 列表：≤10、全为字符串、去空。 */
export function normalizeAttachmentIds(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new ApiError('VALIDATION_FAILED', 'attachmentIds 须为数组');
    if (value.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new ApiError('VALIDATION_FAILED', `每条消息最多携带${MAX_ATTACHMENTS_PER_MESSAGE}张图片`);
    const ids = value.map(v => String(v ?? '').trim()).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new ApiError('VALIDATION_FAILED', '附件重复');
    return ids;
}

export function attachmentView(row: AttachmentRow): { id: string; name: string; mime: string; sizeBytes: number } {
    return { id: row.id, name: row.display_name, mime: row.mime, sizeBytes: row.size_bytes };
}

function createHashOf(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}
