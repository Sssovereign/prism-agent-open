// 块E2路由：会话图片附件上传与本人读取。上传经multipart流式收数（截断即拒），
// mime以魔数为准；读取仅限附件所有者，他人与不存在同形404。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { ok, fail } from '../http.js';
import { ApiError } from '../../contracts/errors.js';
import type { Db } from '../storage/db.js';
import type { AuthExtractor } from '../projects/routes.js';
import { MAX_ATTACHMENT_BYTES, saveAttachment, rowOf, attachmentView } from './attachments.js';

interface MultipartFile { filename: string; mimetype: string; file: AsyncIterable<unknown> & { truncated?: boolean } }

export function registerAttachmentRoutes(app: FastifyInstance, db: Db, auth: AuthExtractor, dataDir: string): void {
    const reqAuth = (req: FastifyRequest) => auth(req) as { userId: string };

    // —— 上传（multipart，10MiB上限，单文件） ——
    app.post('/api/v1/attachments', async (req, reply) => {
        const { userId } = reqAuth(req);
        const file = await (req as unknown as { file: () => Promise<MultipartFile | undefined> }).file();
        if (!file) return fail(req, reply, 'VALIDATION_FAILED', '缺少上传文件');
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of file.file) {
            total += (chunk as Buffer).byteLength;
            // 超限即停收，避免为超大请求继续缓冲内存
            if (total > MAX_ATTACHMENT_BYTES) {
                (file.file as unknown as { destroy?: () => void }).destroy?.();
                return fail(req, reply, 'INPUT_TOO_LARGE', '图片超过10MiB上限', { status: 413 });
            }
            chunks.push(chunk as Buffer);
        }
        const truncated = file.file.truncated === true;
        if (truncated || total > MAX_ATTACHMENT_BYTES) {
            return fail(req, reply, 'INPUT_TOO_LARGE', '图片超过10MiB上限', { status: 413 });
        }
        try {
            const row = saveAttachment(db, dataDir, userId, file.filename, Buffer.concat(chunks));
            return ok(req, reply, attachmentView(row), 201);
        } catch (error) {
            if (error instanceof ApiError) return fail(req, reply, error.code, error.message, { status: error.code === 'INPUT_TOO_LARGE' ? 413 : 400 });
            throw error;
        }    });

    // —— 元数据（本人） ——
    app.get<{ Params: { id: string } }>('/api/v1/attachments/:id', async (req, reply) => {
        const { userId } = reqAuth(req);
        const row = rowOf(db, req.params.id, userId);
        return ok(req, reply, attachmentView(row));
    });

    // —— 原图（本人；缓存头不可共享，避免代理串用户） ——
    app.get<{ Params: { id: string } }>('/api/v1/attachments/:id/raw', async (req, reply) => {
        const { userId } = reqAuth(req);
        let row;
        try {
            row = rowOf(db, req.params.id, userId);
        } catch {
            return fail(req, reply, 'NOT_FOUND', '对象不存在或无权访问');
        }
        reply.header('content-type', row.mime);
        reply.header('content-length', row.size_bytes);
        reply.header('cache-control', 'private, max-age=86400');
        return reply.send(createReadStream(row.internal_path));
    });
}
