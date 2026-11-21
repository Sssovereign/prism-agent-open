// 块E2：composer 附件客户端——multipart 上传（手工构造fetch：浏览器自设multipart边界，
// 不能让v1()覆盖Content-Type）、本人原图URL、图片类型判断。
import { currentCsrfToken } from '../api';
import type { Envelope, ApiFailure } from '../api';

export interface ComposerAttachment { id: string; name: string; mime: string; sizeBytes: number }
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function isImageFile(file: File): boolean {
  return ALLOWED_MIMES.includes(file.type);
}

export function attachmentRawUrl(id: string): string {
  return `/api/v1/attachments/${encodeURIComponent(id)}/raw`;
}

export function formatAttachmentSize(sizeBytes: number): string {
  return sizeBytes >= 1024 * 1024 ? `${(sizeBytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

export async function uploadAttachment(file: File,signal?:AbortSignal): Promise<ComposerAttachment> {
  if (!isImageFile(file)) throw new Error('仅支持 PNG/JPEG/GIF/WEBP 图片');
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('图片超过10MiB上限');
  const form = new FormData();
  form.append('file', file, file.name || 'image');
  const headers = new Headers();
  if (currentCsrfToken()) headers.set('X-CSRF-Token', currentCsrfToken()!);
  const response = await fetch('/api/v1/attachments', { method: 'POST', body: form, headers, signal });
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  if (!response.ok) {
    const failure = body as ApiFailure | undefined;
    throw new Error(failure?.error?.message ?? `上传失败（${response.status}）`);
  }
  const data = (body as Envelope<ComposerAttachment>).data;
  if (!data?.id) throw new Error('上传响应不完整');
  return data;
}
