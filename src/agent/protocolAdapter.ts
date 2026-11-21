import { normalizeContext } from '@earendil-works/pi-ai';
import type { AssistantMessage, AssistantMessageEvent, Message, Tool, ToolCall, Usage, ThinkingContent } from '@earendil-works/pi-ai';
import { ApiError } from '../../contracts/errors.js';

/**
 * 网关协议adapter（计划v1.6 §5）：OpenAI chat-completions请求 ↔ Pi上下文 ↔ OpenAI SSE。
 * worker使用pi-ai的openai-completions streamSimple经此协议与网关往返；文本、工具call
 * id/name/arguments分片、并行工具、finish_reason、usage与结构化错误全部覆盖，
 * 不只实现.text。隐藏reasoning仅在协议私有字段（reasoning_content）内传输，不投影公开文本。
 */

export interface ChatRequestMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: unknown;
    tool_calls?: Array<{ id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
    reasoning_content?: unknown;
    reasoning_details?: unknown;
    tool_call_id?: unknown;
    name?: unknown;
}
export interface ChatRequestBody {
    model?: unknown;
    messages?: unknown;
    tools?: unknown;
    max_tokens?: unknown;
    stream?: unknown;
    temperature?: unknown;
}
export interface ParsedChatRequest {
    model: string;
    systemPrompt: string | undefined;
    messages: Message[];
    tools: Tool[];
    maxTokens: number | undefined;
    stream: boolean;
    temperature: number | undefined;
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function protocolError(message: string): ApiError {
    return new ApiError('PROTOCOL_INVALID', message);
}

function contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (part && typeof part === 'object' && (part as {type?:unknown}).type === 'text' && typeof (part as { text?: unknown }).text === 'string') return (part as { text: string }).text;
            return '';
        }).join('');
    }
    if (content === null || content === undefined) return '';
    throw protocolError('content仅支持文本或文本分片');
}

/** 块E2：图片分块透传。worker侧pi-ai按OpenAI协议发 data URL（data:<mime>;base64,<payload>），
 *  网关解出为pi UserMessage的ImageContent块，由出站serializer按目标协议还原
 *  （OpenAI→image_url，Anthropic→source.base64）。非data URL的图片引用一律拒绝（不代理外链图片）。 */
interface ParsedContent { text: string; images: Array<{ type: 'image'; data: string; mimeType: string }> }

function contentToTextAndImages(content: unknown): ParsedContent {
    if (typeof content === 'string') return { text: content, images: [] };
    if (Array.isArray(content)) {
        const textParts: string[] = [];
        const images: ParsedContent['images'] = [];
        for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            const type = (part as { type?: unknown }).type;
            if (type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
                textParts.push((part as { text: string }).text);
                continue;
            }
            if (type === 'image_url') {
                const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
                const match = typeof url === 'string' ? /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(url) : null;
                if (!match) throw protocolError('仅支持base64 data URL图片（不代理外链图片）');
                const mimeType = match[1]!.toLowerCase();
                if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) throw protocolError('仅支持 PNG/JPEG/GIF/WEBP 图片');
                images.push({ type: 'image', data: match[2]!, mimeType });
                continue;
            }
            // 其他分块类型：维持既有文本语义（忽略），不静默放行未知负载
        }
        return { text: textParts.join(''), images };
    }
    if (content === null || content === undefined) return { text: '', images: [] };
    throw protocolError('content仅支持文本、文本分片或base64图片');
}

/** OpenAI消息 → Pi Context；tool角色回查此前assistant的tool_calls名称。 */
export interface PrivateThinkingDecodeHooks {
    /** Trusted gateway resolves attempt-scoped opaque tokens; never trusts worker signatures. */
    decodePrivateThinking?: (details: unknown) => ThinkingContent[];
}
export function parseChatRequest(body: ChatRequestBody, hooks?: PrivateThinkingDecodeHooks): ParsedChatRequest {
    if (!body || typeof body !== 'object') throw protocolError('请求体必须是JSON对象');
    if (typeof body.model !== 'string' || !body.model) throw protocolError('缺少model');
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw protocolError('缺少messages');
    if (body.stream !== undefined && typeof body.stream !== 'boolean') throw protocolError('stream须为布尔');
    if (body.max_tokens !== undefined && (!Number.isFinite(body.max_tokens) || typeof body.max_tokens !== 'number' || body.max_tokens <= 0 || !Number.isInteger(body.max_tokens)))
        throw protocolError('max_tokens须为正整数');

    const messages: Message[] = [];
    let systemPrompt: string | undefined;
    const toolNameById = new Map<string, string>();
    for (const raw of body.messages as ChatRequestMessage[]) {
        if (!raw || typeof raw !== 'object' || typeof raw.role !== 'string') throw protocolError('messages元素缺少role');
        const timestamp = Date.now();
        switch (raw.role) {
            case 'system': {
                const text = contentToText(raw.content);
                systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
                break;
            }
            case 'user': {
                const parsedContent = contentToTextAndImages(raw.content);
                messages.push({ role: 'user', content: parsedContent.images.length
                    ? [...(parsedContent.text ? [{ type: 'text' as const, text: parsedContent.text }] : []), ...parsedContent.images]
                    : parsedContent.text, timestamp });
                break;
            }
            case 'assistant': {
                const content: Array<{ type: 'text'; text: string } | ToolCall | ThinkingContent> = [];
                if(raw.reasoning_details!==undefined) {
                    if(!hooks?.decodePrivateThinking) throw protocolError('私有推理回放不可用');
                    content.push(...hooks.decodePrivateThinking(raw.reasoning_details));
                } else if(raw.reasoning_content!==undefined) {
                    if(typeof raw.reasoning_content!=='string') throw protocolError('reasoning_content须为字符串');
                    if(raw.reasoning_content) content.push({type:'thinking',thinking:raw.reasoning_content,thinkingSignature:'reasoning_content'});
                }
                const text = contentToText(raw.content);
                if (text) content.push({ type: 'text', text });
                if (raw.tool_calls !== undefined) {
                    if (!Array.isArray(raw.tool_calls)) throw protocolError('tool_calls须为数组');
                    for (const call of raw.tool_calls) {
                        if (!call || typeof call !== 'object') throw protocolError('tool_call格式不合法');
                        const id = typeof call.id === 'string' ? call.id : '';
                        const name = typeof call.function?.name === 'string' ? call.function.name : '';
                        if (!id || !name) throw protocolError('tool_call缺少id或function.name');
                        let argsText = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
                        let arguments_: ToolCall['arguments'] = {};
                        let argumentsError: string | undefined;
                        if (argsText) {
                            try {
                                const parsed = JSON.parse(argsText);
                                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
                                arguments_ = parsed as typeof arguments_;
                            } catch {
                                arguments_ = {};
                                argumentsError = argsText;
                            }
                        }
                        content.push({ type: 'toolCall', id, name, arguments: arguments_, ...(argumentsError ? { argumentsError } : {}) });
                        toolNameById.set(id, name);
                    }
                }
                if (content.length === 0) throw protocolError('assistant消息为空');
                messages.push({ role: 'assistant', content, usage: zeroUsage(), stopReason: raw.tool_calls?.length ? 'toolUse' : 'stop', api: 'openai-completions', provider: 'prism-gateway', model: String(body.model), timestamp });
                break;
            }
            case 'tool': {
                const toolCallId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '';
                if (!toolCallId) throw protocolError('tool消息缺少tool_call_id');
                const toolName = toolNameById.get(toolCallId) ?? (typeof raw.name === 'string' ? raw.name : 'unknown_tool');
                messages.push({ role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text: contentToText(raw.content) }], isError: false, timestamp });
                break;
            }
            default:
                throw protocolError(`不支持的role: ${raw.role}`);
        }
    }
    const tools: Tool[] = [];
    if (body.tools !== undefined) {
        if (!Array.isArray(body.tools)) throw protocolError('tools须为数组');
        for (const t of body.tools) {
            const fn = (t as { function?: { name?: unknown; description?: unknown; parameters?: unknown } })?.function;
            if (!fn || typeof fn.name !== 'string' || !fn.name) throw protocolError('tools元素缺少function.name');
            if (fn.parameters !== undefined && (typeof fn.parameters !== 'object' || fn.parameters === null || Array.isArray(fn.parameters)))
                throw protocolError('tools元素parameters须为JSON Schema对象');
            tools.push({ name: fn.name, description: typeof fn.description === 'string' ? fn.description : '', parameters: (fn.parameters ?? { type: 'object', properties: {} }) as unknown as Tool['parameters'] });
        }
    }
    return {
        model: body.model,
        systemPrompt,
        messages,
        tools,
        maxTokens: body.max_tokens as number | undefined,
        stream: body.stream !== false,
        temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    };
}

const ZERO_USAGE_JSON = zeroUsage();

export interface SseEncodeHooks {
    /** Return attempt-scoped opaque replay metadata (OpenAI reasoning_details array). */
    encodePrivateThinking?: (final: AssistantMessage) => unknown;
    /** 终局事件回调（done/error各触发一次）：供计量层旁路取final，不得与编码器竞争同一迭代器 */
    onFinal?: (final: AssistantMessage, sawDone: boolean) => void;
}

/** Pi事件 → OpenAI chat.completion.chunk SSE；usage按OpenAI字段输出（prompt_tokens含缓存，分桶见details字段）。 */
export function encodeSseFromEvents(events: AsyncIterable<AssistantMessageEvent>, responseId: string, model: string, created: number, hooks?: SseEncodeHooks): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let textStarted = false, thinkingStarted = false;
    const toolCallIndex = new Map<number, number>(); // contentIndex → OpenAI tool index
    let nextToolIndex = 0;
    let chunkIndex = 0;
    const chunk = (delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, unknown>): Uint8Array => {
        const payload: Record<string, unknown> = {
            id: responseId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
        };
        if (usage) payload.usage = usage;
        else payload.usage = null;
        return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
    };
    return new ReadableStream<Uint8Array>({
        async start(controller) {
            controller.enqueue(chunk({ role: 'assistant', content: '' }, null));
            try {
                for await (const event of events) {
                    switch (event.type) {
                        case 'thinking_start':
                            thinkingStarted = true;
                            break;
                        case 'thinking_delta':
                            controller.enqueue(chunk({ reasoning_content: event.delta }, null));
                            break;
                        case 'text_start':
                            textStarted = true;
                            break;
                        case 'text_delta':
                            controller.enqueue(chunk({ content: event.delta }, null));
                            break;
                        case 'toolcall_start': {
                            const index = nextToolIndex++;
                            toolCallIndex.set(event.contentIndex, index);
                            const block = event.partial.content[event.contentIndex];
                            const call = block && block.type === 'toolCall' ? block : undefined;
                            controller.enqueue(chunk({
                                tool_calls: [{ index, id: call?.id ?? `call_${index}`, type: 'function', function: { name: call?.name ?? '', arguments: '' } }],
                            }, null));
                            break;
                        }
                        case 'toolcall_delta': {
                            const index = toolCallIndex.get(event.contentIndex) ?? 0;
                            if (event.delta) controller.enqueue(chunk({ tool_calls: [{ index, function: { arguments: event.delta } }] }, null));
                            break;
                        }
                        case 'done':
                        case 'error': {
                            const final: AssistantMessage = event.type === 'done' ? event.message : event.error;
                            const privateDetails=hooks?.encodePrivateThinking?.(final);
                            if(privateDetails!==undefined) controller.enqueue(chunk({reasoning_details:privateDetails},null));
                            hooks?.onFinal?.(final, event.type === 'done');
                            const finish = final.stopReason === 'toolUse' ? 'tool_calls'
                                : final.stopReason === 'length' ? 'length'
                                : final.stopReason === 'aborted' ? 'stop' : 'stop';
                            const u = final.usage ?? ZERO_USAGE_JSON;
                            const usageJson = {
                                prompt_tokens: u.input + u.cacheRead + u.cacheWrite,
                                completion_tokens: u.output,
                                total_tokens: u.input + u.cacheRead + u.cacheWrite + u.output,
                                prompt_tokens_details: { cached_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite },
                                completion_tokens_details: { reasoning_tokens: typeof u.reasoning === 'number' ? u.reasoning : 0 },
                            };
                            if (event.type === 'error') {
                                // 结构化错误：以finish_reason=stop的空增量+错误对象通知，由网关层在使用前校验。
                                controller.enqueue(chunk({}, 'stop'));
                                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: final.errorMessage ?? 'MODEL_REQUEST_FAILED', type: 'gateway_error', code: 'MODEL_REQUEST_FAILED' } })}\n\n`));
                            }
                            else {
                                controller.enqueue(chunk({}, finish));
                                controller.enqueue(chunk({}, null, usageJson));
                            }
                            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                            break;
                        }
                        default:
                            break; // start/text_end/thinking_end等无对应分片
                    }
                    chunkIndex++;
                }
            }
            catch (error) {
                // 上游中断：以结构化错误结束流，让worker侧按错误处理而不是挂起。
                const message = error instanceof Error ? error.message : 'GATEWAY_STREAM_INTERRUPTED';
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: 'gateway_error', code: 'MODEL_REQUEST_FAILED' } })}\n\n`));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            }
            finally {
                try { controller.close(); } catch { /* already closed */ }
            }
        },
    });
}

/** 快速校验JSON可序列化（防止工具结果等塞入不可序列化对象）。 */
export function assertJsonSerializable(value: unknown): void {
    try { JSON.stringify(value); }
    catch { throw new ApiError('INTERNAL_ERROR', '响应包含不可序列化内容'); }
}
export type { ToolCall };
export { normalizeContext };
