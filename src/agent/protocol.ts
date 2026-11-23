import { ApiError } from '../../contracts/errors.js';

/**
 * 控制JSON Lines协议（计划v1.6 §3/§6/§7）：
 * - 严格版本化（v:1）；单帧≤8MiB（与模型请求体上限一致，保证>1MiB写入的审批门可达）；
 *   requestId幂等；producerSeq去重；方法allowlist；通道身份覆盖正文身份。
 * - agent通道：runner→监督器（工具提议/模型请求登记/checkpoint提议/事件/心跳/完成提议）。
 * - exec通道：监督器→runner（沙箱命令执行/steer注入/中止）。两个方向、两个通道的方法表互不相交。
 * - 未知method静默拒绝（回错误响应）；伪造通道身份按帧头channel判定，忽略正文中自报的身份。
 */
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export const AGENT_CHANNEL_METHODS = new Set([
    'ready', 'heartbeat', 'log',
    'tool_proposed', 'model_request_proposed', 'context_checkpoint_proposed',
    'emit_event', 'complete_proposed', 'compaction_preflight', 'compact_finished', 'context_checkpoint_applied',
    // run_failed：runner→监督器的模型错误结构化失败请求（requestId回执，防flush丢失）
    'run_failed', 'memory_control',
]);
export const EXEC_CHANNEL_METHODS = new Set([
    'execute_command', 'compact_session', 'steer', 'abort_session', 'shutdown', 'run_subagent',
]);

export interface FrameError {
    code: string;
    message: string;
    /** 结构化且已脱敏的错误上下文；旧帧可省略。 */
    details?: Record<string, unknown>;
}

export interface Frame {
    v: number;
    channel: 'agent' | 'exec';
    method: string;
    requestId?: string;
    /** runner产生的事件序号（emit_event去重） */
    producerSeq?: number;
    ok?: boolean;
    error?: FrameError;
    payload?: unknown;
}

export class ProtocolError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

/** 帧编码：单帧上限校验，超限拒绝发送。 */
export function encodeFrame(frame: Frame): string {
    const line = JSON.stringify(frame);
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
        throw new ProtocolError('FRAME_TOO_LARGE', `控制帧超过${MAX_FRAME_BYTES / 1024}KiB上限`);
    }
    return line + '\n';
}

/** 帧解码：校验版本、通道、方法allowlist；失败抛ProtocolError（调用方记审计并断开）。 */
export function decodeFrame(line: string, expectedChannel: Frame['channel'], direction: 'send' | 'recv'): Frame {
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
        throw new ProtocolError('FRAME_TOO_LARGE', `控制帧超过${MAX_FRAME_BYTES / 1024}KiB上限`);
    }
    let frame: Frame;
    try { frame = JSON.parse(line) as Frame; }
    catch { throw new ProtocolError('PROTOCOL_INVALID', '控制帧不是合法JSON'); }
    if (!frame || typeof frame !== 'object' || frame.v !== PROTOCOL_VERSION) {
        throw new ProtocolError('PROTOCOL_INVALID', `不支持的协议版本: ${String((frame as { v?: unknown })?.v)}`);
    }
    if (frame.channel !== expectedChannel) {
        throw new ProtocolError('CHANNEL_MISMATCH', `控制帧通道不符: ${String(frame.channel)}`);
    }
    const allowed = expectedChannel === 'agent' ? AGENT_CHANNEL_METHODS : EXEC_CHANNEL_METHODS;
    if (typeof frame.method !== 'string' || !allowed.has(frame.method)) {
        throw new ProtocolError('METHOD_DENIED', `通道${expectedChannel}不允许方法: ${String(frame.method)}`);
    }
    // 方向校验：agent通道的req方法必须带requestId（请求方向）；exec通道由监督器发送
    if (expectedChannel === 'agent' && direction === 'recv' && !['ready', 'heartbeat', 'log', 'emit_event'].includes(frame.method) && !frame.requestId) {
        throw new ProtocolError('PROTOCOL_INVALID', '请求帧缺少requestId');
    }
    if (frame.producerSeq !== undefined && (!Number.isInteger(frame.producerSeq) || frame.producerSeq <= 0)) {
        throw new ProtocolError('PROTOCOL_INVALID', 'producerSeq须为正整数');
    }
    return frame;
}

/**
 * 通道端：处理一行输入；requestId→pending响应路由；producerSeq去重回调。
 * 单条1MiB、requestId/body幂等由本类与decodeFrame共同保证。
 */
export class ChannelEndpoint {
    private buffer = '';
    private pending = new Map<string, { resolve: (frame: Frame) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
    private nextRequestId = 0;
    private closed = false;

    constructor(
        private readonly channel: Frame['channel'],
        private readonly write: (data: string) => void,
        private readonly onFrame: (frame: Frame, respond: (ok: boolean, payload?: unknown, error?: FrameError) => void) => void,
        private readonly onProducerEvent?: (seq: number, frame: Frame) => void,
        private readonly onClosed?: () => void,
    ) {}

    /** 从流中按行分发（输入限长，超限断开）。 */
    feed(chunk: string): void {
        this.buffer += chunk;
        for (;;) {
            const idx = this.buffer.indexOf('\n');
            if (idx === -1) {
                if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES) this.close(new ProtocolError('FRAME_TOO_LARGE', '控制帧超长'));
                return;
            }
            const line = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);
            if (!line.trim()) continue;
            try {
                const frame = decodeFrame(line, this.channel, 'recv');
                if (frame.producerSeq !== undefined && this.onProducerEvent) {
                    // producerSeq去重由监督器侧按DB唯一索引权威判定；这里仅回调
                    this.onProducerEvent(frame.producerSeq, frame);
                    continue;
                }
                if (frame.requestId && frame.ok !== undefined) {
                    // 响应帧：路由到pending
                    const pending = this.pending.get(frame.requestId);
                    if (pending) {
                        this.pending.delete(frame.requestId);
                        clearTimeout(pending.timer);
                        if (frame.ok) pending.resolve(frame);
                        else pending.reject(new ApiError((frame.error?.code as never) ?? 'INTERNAL_ERROR', frame.error?.message ?? '对端拒绝', frame.error?.details));
                    }
                    continue;
                }
                // 请求帧：处理并回响应
                const requestId = frame.requestId ?? `peer-${this.nextRequestId++}`;
                this.onFrame(frame, (ok, payload, error) => {
                    if (this.closed) return;
                    try {
                        this.write(encodeFrame({ v: PROTOCOL_VERSION, channel: this.channel, method: frame.method, requestId, ok, payload, error }));
                    } catch (error) {
                        // Never leave a valid request waiting for a response that cannot be encoded.
                        if(error instanceof ProtocolError&&error.code==='FRAME_TOO_LARGE'){
                            try{this.write(encodeFrame({v:PROTOCOL_VERSION,channel:this.channel,method:frame.method,requestId,ok:false,error:{code:'INPUT_TOO_LARGE',message:'工具响应超过控制通道8MiB上限，请缩小结果或分批读取'}}));}catch{this.close(new Error('CHANNEL_WRITE_FAILED'));}
                        }else this.close(error instanceof Error?error:new Error('CHANNEL_WRITE_FAILED'));
                    }
                });
            }
            catch (error) {
                // 协议违规：拒绝该帧；连续违规由调用方断开
                this.onProtocolViolation?.(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    onProtocolViolation?: (error: Error) => void;

    /** 发送请求并等待响应。 */
    request(method: string, payload: unknown, timeoutMs: number): Promise<Frame> {
        if (this.closed) return Promise.reject(new Error('CHANNEL_CLOSED'));
        const requestId = `r${this.nextRequestId++}`;
        return new Promise<Frame>((resolve, reject) => {
            // timeoutMs=0: user interaction waits until explicit response or channel closure.
            const timer = timeoutMs > 0 ? setTimeout(() => {
                this.pending.delete(requestId);
                reject(new ApiError('MODEL_TIMEOUT', `控制通道请求超时: ${method}`));
            }, timeoutMs) : undefined;
            timer?.unref?.();
            this.pending.set(requestId, { resolve, reject, timer });
            try {
                this.write(encodeFrame({ v: PROTOCOL_VERSION, channel: this.channel, method, requestId, payload }));
            }
            catch (error) {
                this.pending.delete(requestId);
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    notify(method: string, payload: unknown, producerSeq?: number): void {
        if (this.closed) return;
        try {
            this.write(encodeFrame({ v: PROTOCOL_VERSION, channel: this.channel, method, payload, producerSeq }));
        }
        catch { /* 超限帧不入通道（调用方改用文件/分段） */ }
    }

    close(error?: Error): void {
        if (this.closed) return;
        this.closed = true;
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error ?? new Error('CHANNEL_CLOSED'));
        }
        this.pending.clear();
        this.onClosed?.();
    }
}
